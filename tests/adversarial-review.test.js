// Tests for Phase 31.3: review.mode "adversarial" (reviewer + critic pair)
// alongside the default "panel" mode. See plans/phase-31-verification-depth.md §31.3.

const { describe, it, afterEach } = require("node:test");
const assert = require("node:assert/strict");
const path = require("node:path");
const { REPO_ROOT, makeTargetProject, seedGate, cleanup } = require("./_helpers");

const { loadConfig, resolveHost, clearConfigCache } = require(path.join(REPO_ROOT, "core", "config"));
const { getStage, rolesForStage, isAdversarialReviewMode } =
  require(path.join(REPO_ROOT, "core", "pipeline", "stages"));
const { computeDispatchPlan, dispatchWavesFor, mergeWorkstreamGates, next } =
  require(path.join(REPO_ROOT, "core", "orchestrator"));
const {
  parseCriticFile, applyCriticVerdict, applyAdversarialReviewerFile,
} = require(path.join(REPO_ROOT, "core", "hooks", "approval-derivation"));

let _dirs = [];
function track(cwd) { _dirs.push(cwd); return cwd; }
afterEach(() => { _dirs.forEach(cleanup); _dirs = []; clearConfigCache(); });

const ADVERSARIAL_CONFIG = "routing:\n  default_host: generic\nreview:\n  mode: adversarial\npipeline:\n  default_track: full\n";

describe("config: review.mode", () => {
  it("defaults to panel when unset", () => {
    const cwd = track(makeTargetProject());
    assert.equal(loadConfig(cwd).review.mode, "panel");
  });

  it("parses adversarial", () => {
    const cwd = track(makeTargetProject({ config: ADVERSARIAL_CONFIG }));
    assert.equal(loadConfig(cwd).review.mode, "adversarial");
  });

  it("falls back to panel on an invalid value rather than throwing", () => {
    const cwd = track(makeTargetProject({ config: "review:\n  mode: bogus\n" }));
    assert.equal(loadConfig(cwd).review.mode, "panel");
  });
});

describe("config: resolveHost cross-host default for critic", () => {
  it("falls back to default_host when only one host is configured", () => {
    const config = { routing: { default_host: "generic", roles: {}, stages: {} } };
    assert.equal(resolveHost(config, "stage-05", "critic"), "generic");
  });

  it("picks a different host than the reviewer when >=2 hosts are configured", () => {
    const config = { routing: { default_host: "generic", roles: { backend: "codex" }, stages: {} } };
    assert.equal(resolveHost(config, "stage-05", "reviewer"), "generic");
    assert.equal(resolveHost(config, "stage-05", "critic"), "codex");
  });

  it("an explicit routing.roles.critic override always wins", () => {
    const config = { routing: { default_host: "generic", roles: { backend: "codex", critic: "gemini-cli" }, stages: {} } };
    assert.equal(resolveHost(config, "stage-05", "critic"), "gemini-cli");
  });

  it("other roles are unaffected by the critic special-case", () => {
    const config = { routing: { default_host: "generic", roles: { backend: "codex" }, stages: {} } };
    assert.equal(resolveHost(config, "stage-05", "backend"), "codex");
    assert.equal(resolveHost(config, "stage-04c", "red-team"), "generic");
  });
});

describe("stages: rolesForStage / isAdversarialReviewMode", () => {
  const stageDef = getStage("peer-review");

  it("panel mode (or no config) keeps the four-area matrix", () => {
    assert.deepEqual(rolesForStage(stageDef, "full", { review: { mode: "panel" } }), ["backend", "frontend", "platform", "qa"]);
    assert.deepEqual(rolesForStage(stageDef, "full"), ["backend", "frontend", "platform", "qa"]);
  });

  it("adversarial mode returns exactly [reviewer, critic]", () => {
    assert.deepEqual(rolesForStage(stageDef, "full", { review: { mode: "adversarial" } }), ["reviewer", "critic"]);
    assert.deepEqual(rolesForStage(stageDef, "hotfix", { review: { mode: "adversarial" } }), ["reviewer", "critic"]);
  });

  it("loop track's single-workstream scoping wins over adversarial mode", () => {
    assert.deepEqual(rolesForStage(stageDef, "loop", { review: { mode: "adversarial" } }), ["backend"]);
  });

  it("isAdversarialReviewMode is false for missing/panel config", () => {
    assert.equal(isAdversarialReviewMode(null), false);
    assert.equal(isAdversarialReviewMode({ review: { mode: "panel" } }), false);
    assert.equal(isAdversarialReviewMode({ review: { mode: "adversarial" } }), true);
  });
});

describe("orchestrator: computeDispatchPlan (adversarial)", () => {
  const stageDef = getStage("peer-review");

  it("produces exactly two workstreams: reviewer then critic", () => {
    const plan = computeDispatchPlan(stageDef, { review: { mode: "adversarial" }, routing: { review_fanout: [] } }, "full", {});
    assert.deepEqual(plan.map((p) => p.role), ["reviewer", "critic"]);
    assert.deepEqual(plan.map((p) => p.workstreamId), ["stage-05.reviewer", "stage-05.critic"]);
    assert.deepEqual(plan.map((p) => p.gateFile), ["stage-05.reviewer.json", "stage-05.critic.json"]);
    assert.ok(plan.every((p) => p.fanout === false));
  });

  it("adversarial mode wins over review_fanout when both are configured", () => {
    const plan = computeDispatchPlan(
      stageDef,
      { review: { mode: "adversarial" }, routing: { review_fanout: ["claude-code", "codex"] } },
      "full",
      {},
    );
    assert.equal(plan.length, 2, "adversarial mode must not be multiplied by review_fanout");
  });

  it("panel mode (default) is unchanged: four areas, no reviewer/critic roles", () => {
    const plan = computeDispatchPlan(stageDef, { routing: { review_fanout: [] } }, "full", {});
    assert.deepEqual(plan.map((p) => p.role), ["backend", "frontend", "platform", "qa"]);
  });
});

describe("orchestrator: dispatchWavesFor", () => {
  it("splits adversarial stage-05 into a reviewer wave then a critic wave", () => {
    const plan = {
      stage: "stage-05",
      workstreams: [
        { role: "reviewer", host: "generic" },
        { role: "critic", host: "codex" },
      ],
    };
    const waves = dispatchWavesFor(plan, { review: { mode: "adversarial" } });
    assert.equal(waves.length, 2);
    assert.deepEqual(waves[0].map((w) => w.role), ["reviewer"]);
    assert.deepEqual(waves[1].map((w) => w.role), ["critic"]);
  });

  it("returns a single wave with the whole plan for panel-mode stage-05", () => {
    const plan = {
      stage: "stage-05",
      workstreams: [{ role: "backend" }, { role: "frontend" }, { role: "platform" }, { role: "qa" }],
    };
    const waves = dispatchWavesFor(plan, { review: { mode: "panel" } });
    assert.equal(waves.length, 1);
    assert.equal(waves[0], plan.workstreams);
  });

  it("returns a single wave for every non-stage-05 stage regardless of review.mode", () => {
    const plan = { stage: "stage-04", workstreams: [{ role: "backend" }, { role: "frontend" }] };
    const waves = dispatchWavesFor(plan, { review: { mode: "adversarial" } });
    assert.equal(waves.length, 1);
    assert.equal(waves[0], plan.workstreams);
  });
});

describe("approval-derivation: parseCriticFile", () => {
  it("parses a resolved and an unresolved challenge with file:line evidence", () => {
    const content = [
      "## Challenge CR-01",
      "FILE: src/backend/auth.js:42",
      "CLAIM: missing permission check",
      "DISPOSITION: UNRESOLVED",
      "",
      "## Challenge CR-02",
      "FILE: src/frontend/x.js:10",
      "CLAIM: already covered by changes requested",
      "DISPOSITION: RESOLVED",
    ].join("\n");
    const tmp = require("node:fs").mkdtempSync(require("node:path").join(require("node:os").tmpdir(), "devteam-test-critic-"));
    const file = require("node:path").join(tmp, "by-critic.md");
    require("node:fs").writeFileSync(file, content);
    const challenges = parseCriticFile(file);
    require("node:fs").rmSync(tmp, { recursive: true, force: true });
    assert.equal(challenges.length, 2);
    assert.deepEqual(challenges.map((c) => c.id), ["CR-01", "CR-02"]);
    assert.equal(challenges[0].disposition, "unresolved");
    assert.equal(challenges[0].file, "src/backend/auth.js");
    assert.equal(challenges[0].line, 42);
    assert.equal(challenges[1].disposition, "resolved");
  });

  it("forces disposition to unresolved when file:line evidence is missing", () => {
    const content = [
      "## Challenge CR-01",
      "CLAIM: no evidence provided",
      "DISPOSITION: RESOLVED",
    ].join("\n");
    const tmp = require("node:fs").mkdtempSync(require("node:path").join(require("node:os").tmpdir(), "devteam-test-critic-"));
    const file = require("node:path").join(tmp, "by-critic.md");
    require("node:fs").writeFileSync(file, content);
    const challenges = parseCriticFile(file);
    require("node:fs").rmSync(tmp, { recursive: true, force: true });
    assert.equal(challenges.length, 1);
    assert.equal(challenges[0].disposition, "unresolved");
    assert.equal(challenges[0].evidence_missing, true);
  });

  it("returns an empty array when the critic found nothing to challenge", () => {
    const tmp = require("node:fs").mkdtempSync(require("node:path").join(require("node:os").tmpdir(), "devteam-test-critic-"));
    const file = require("node:path").join(tmp, "by-critic.md");
    require("node:fs").writeFileSync(file, "# Critic Review\n\nI checked every approval and found no challenges.\n");
    const challenges = parseCriticFile(file);
    require("node:fs").rmSync(tmp, { recursive: true, force: true });
    assert.deepEqual(challenges, []);
  });
});

describe("approval-derivation: applyCriticVerdict / applyAdversarialReviewerFile", () => {
  function writeFile(cwd, name, content) {
    const fs = require("node:fs");
    const dir = require("node:path").join(cwd, "pipeline", "code-review");
    fs.mkdirSync(dir, { recursive: true });
    const file = require("node:path").join(dir, name);
    fs.writeFileSync(file, content);
    return file;
  }

  it("an unresolved challenge produces a FAIL critic gate with challenges_resolved: false", () => {
    const cwd = track(makeTargetProject());
    const file = writeFile(cwd, "by-critic.md", [
      "## Challenge CR-01",
      "FILE: src/backend/auth.js:42",
      "CLAIM: missing permission check",
      "DISPOSITION: UNRESOLVED",
    ].join("\n"));
    const gatesDir = require("node:path").join(cwd, "pipeline", "gates");
    applyCriticVerdict(file, { reviewer: "critic", gatesDir });
    const gate = JSON.parse(require("node:fs").readFileSync(require("node:path").join(gatesDir, "stage-05.critic.json"), "utf8"));
    assert.equal(gate.status, "FAIL");
    assert.equal(gate.challenges_resolved, false);
    assert.equal(gate.challenges.length, 1);
  });

  it("all-resolved challenges produce a PASS critic gate", () => {
    const cwd = track(makeTargetProject());
    const file = writeFile(cwd, "by-critic.md", [
      "## Challenge CR-01",
      "FILE: src/backend/auth.js:42",
      "CLAIM: already fixed",
      "DISPOSITION: RESOLVED",
    ].join("\n"));
    const gatesDir = require("node:path").join(cwd, "pipeline", "gates");
    applyCriticVerdict(file, { reviewer: "critic", gatesDir });
    const gate = JSON.parse(require("node:fs").readFileSync(require("node:path").join(gatesDir, "stage-05.critic.json"), "utf8"));
    assert.equal(gate.status, "PASS");
    assert.equal(gate.challenges_resolved, true);
  });

  it("zero challenges is a legitimate PASS", () => {
    const cwd = track(makeTargetProject());
    const file = writeFile(cwd, "by-critic.md", "# Critic Review\n\nNo challenges.\n");
    const gatesDir = require("node:path").join(cwd, "pipeline", "gates");
    applyCriticVerdict(file, { reviewer: "critic", gatesDir });
    const gate = JSON.parse(require("node:fs").readFileSync(require("node:path").join(gatesDir, "stage-05.critic.json"), "utf8"));
    assert.equal(gate.status, "PASS");
    assert.equal(gate.challenges_resolved, true);
    assert.deepEqual(gate.challenges, []);
  });

  it("reviewer approving every reviewed area produces one combined PASS gate", () => {
    const cwd = track(makeTargetProject());
    const file = writeFile(cwd, "by-reviewer.md", [
      "## Review of backend",
      "Looks fine.",
      "REVIEW: APPROVED",
      "",
      "## Review of frontend",
      "Looks fine too.",
      "REVIEW: APPROVED",
    ].join("\n"));
    const gatesDir = require("node:path").join(cwd, "pipeline", "gates");
    applyAdversarialReviewerFile(file, { reviewer: "reviewer", gatesDir });
    const gate = JSON.parse(require("node:fs").readFileSync(require("node:path").join(gatesDir, "stage-05.reviewer.json"), "utf8"));
    assert.equal(gate.status, "PASS");
    assert.deepEqual(gate.areas_reviewed, ["backend", "frontend"]);
    assert.deepEqual(gate.approved_areas, ["backend", "frontend"]);
  });

  it("a single changes-requested area fails the whole combined reviewer gate", () => {
    const cwd = track(makeTargetProject());
    const file = writeFile(cwd, "by-reviewer.md", [
      "## Review of backend",
      "REVIEW: APPROVED",
      "",
      "## Review of frontend",
      "BLOCKER: missing null check",
      "REVIEW: CHANGES REQUESTED",
    ].join("\n"));
    const gatesDir = require("node:path").join(cwd, "pipeline", "gates");
    applyAdversarialReviewerFile(file, { reviewer: "reviewer", gatesDir });
    const gate = JSON.parse(require("node:fs").readFileSync(require("node:path").join(gatesDir, "stage-05.reviewer.json"), "utf8"));
    assert.equal(gate.status, "FAIL");
    assert.equal(gate.changes_requested.length, 1);
    assert.equal(gate.changes_requested[0].area, "frontend");
  });
});

describe("adversarial stubbed flow: mergeWorkstreamGates + next()", () => {
  function seedAdversarial(cwd, { reviewerStatus = "PASS", challengesResolved = true } = {}) {
    seedGate(cwd, "stage-05.reviewer", {
      stage: "stage-05", workstream: "reviewer", mode: "adversarial", status: reviewerStatus,
      areas_reviewed: ["backend"], approved_areas: reviewerStatus === "PASS" ? ["backend"] : [],
      changes_requested: [],
    });
    seedGate(cwd, "stage-05.critic", {
      stage: "stage-05", workstream: "critic", mode: "adversarial",
      status: challengesResolved ? "PASS" : "FAIL",
      challenges: challengesResolved ? [] : [{ id: "CR-01", disposition: "unresolved" }],
      challenges_resolved: challengesResolved,
    });
  }

  it("reviewer PASS + unresolved challenge blocks the merged gate", () => {
    const cwd = track(makeTargetProject({ config: ADVERSARIAL_CONFIG }));
    seedAdversarial(cwd, { challengesResolved: false });
    const m = mergeWorkstreamGates("peer-review", { cwd, track: "full" });
    assert.equal(m.merged, true, m.reason);
    assert.equal(m.gate.status, "FAIL");
    assert.equal(m.gate.challenges_resolved, false);
  });

  it("reviewer PASS + resolved challenges passes the merged gate", () => {
    const cwd = track(makeTargetProject({ config: ADVERSARIAL_CONFIG }));
    seedAdversarial(cwd, { challengesResolved: true });
    const m = mergeWorkstreamGates("peer-review", { cwd, track: "full" });
    assert.equal(m.merged, true, m.reason);
    assert.equal(m.gate.status, "PASS");
    assert.equal(m.gate.challenges_resolved, true);
  });

  it("reviewer FAIL still blocks even when the critic has no challenges", () => {
    const cwd = track(makeTargetProject({ config: ADVERSARIAL_CONFIG }));
    seedAdversarial(cwd, { reviewerStatus: "FAIL", challengesResolved: true });
    const m = mergeWorkstreamGates("peer-review", { cwd, track: "full" });
    assert.equal(m.merged, true, m.reason);
    assert.equal(m.gate.status, "FAIL");
  });

  // G6 custom stage array: isolate next()'s stage-05 bookkeeping from the
  // earlier stages (requirements/design/...) that "full" would also require
  // gates for — this test is only about the reviewer/critic completion check.
  const PEER_REVIEW_ONLY_TRACK = ["build", "peer-review"];

  it("next() recognizes both adversarial gates as complete and returns merge", () => {
    const cwd = track(makeTargetProject({ config: ADVERSARIAL_CONFIG }));
    seedGate(cwd, "stage-04", { stage: "stage-04" });
    seedAdversarial(cwd, { challengesResolved: true });
    const r = next({ cwd, track: PEER_REVIEW_ONLY_TRACK });
    assert.equal(r.action, "merge");
    assert.equal(r.name, "peer-review");
  });

  it("next() dispatches only the reviewer while the critic gate is absent", () => {
    const cwd = track(makeTargetProject({ config: ADVERSARIAL_CONFIG }));
    seedGate(cwd, "stage-04", { stage: "stage-04" });
    seedGate(cwd, "stage-05.reviewer", { stage: "stage-05", workstream: "reviewer", mode: "adversarial", status: "PASS" });
    const r = next({ cwd, track: PEER_REVIEW_ONLY_TRACK });
    assert.equal(r.action, "continue-stage");
    assert.deepEqual(r.completed, ["reviewer"]);
    assert.deepEqual(r.remaining, ["critic"]);
  });
});

describe("regression: panel mode is untouched by the adversarial changes", () => {
  it("computeDispatchPlan for panel mode still produces the four-area matrix", () => {
    const stageDef = getStage("peer-review");
    const plan = computeDispatchPlan(stageDef, { routing: { review_fanout: [] } }, "full", {});
    assert.deepEqual(plan.map((p) => p.role), ["backend", "frontend", "platform", "qa"]);
    assert.deepEqual(plan.map((p) => p.workstreamId), [
      "stage-05.backend", "stage-05.frontend", "stage-05.platform", "stage-05.qa",
    ]);
  });

  it("panel-mode stubbed merge is unaffected (no challenges fields on the merged gate)", () => {
    const cwd = track(makeTargetProject());
    for (const role of ["backend", "frontend", "platform", "qa"]) {
      seedGate(cwd, `stage-05.${role}`, {
        stage: "stage-05", workstream: role, status: "PASS",
        review_shape: "matrix", required_approvals: 2, approvals: ["a", "b"], changes_requested: [], escalated_to_principal: false,
      });
    }
    const m = mergeWorkstreamGates("peer-review", { cwd, track: "full" });
    assert.equal(m.merged, true, m.reason);
    assert.equal(m.gate.status, "PASS");
    assert.equal(m.gate.challenges, undefined);
    assert.equal(m.gate.challenges_resolved, undefined);
  });
});
