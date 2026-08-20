const { describe, it, afterEach } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { spawnSync } = require("node:child_process");
const { REPO_ROOT, makeTargetProject, seedGate, cleanup } = require("./_helpers");
const { parseReviewFile, reviewerNameFromPath } =
  require(path.join(REPO_ROOT, "core", "hooks", "approval-derivation"));

const HOOK = path.join(REPO_ROOT, "core", "hooks", "approval-derivation.js");

let _dirs = [];
function track(cwd) { _dirs.push(cwd); return cwd; }
afterEach(() => { _dirs.forEach(cleanup); _dirs = []; });

function writeReview(cwd, filename, body) {
  const dir = path.join(cwd, "pipeline", "code-review");
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, filename), body);
  return path.join(dir, filename);
}

function runHook(cwd) {
  const r = spawnSync("node", [HOOK], { cwd, encoding: "utf8" });
  return { status: r.status, stdout: r.stdout || "" };
}

function readGate(cwd, name) {
  const file = path.join(cwd, "pipeline", "gates", `${name}.json`);
  if (!fs.existsSync(file)) return null;
  return JSON.parse(fs.readFileSync(file, "utf8"));
}

describe("approval-derivation: parser", () => {
  it("extracts per-area APPROVED verdicts", () => {
    const cwd = track(makeTargetProject());
    const file = writeReview(cwd, "by-backend.md",
      "## Review of frontend\nLGTM\nREVIEW: APPROVED\n\n## Review of platform\nLGTM\nREVIEW: APPROVED\n");
    const v = parseReviewFile(file);
    assert.equal(v.length, 2);
    assert.deepEqual(v.map((x) => x.area).sort(), ["frontend", "platform"]);
    assert.ok(v.every((x) => x.verdict === "APPROVED"));
  });

  it("extracts CHANGES_REQUESTED", () => {
    const cwd = track(makeTargetProject());
    const file = writeReview(cwd, "by-frontend.md",
      "## Review of backend\nbug\nREVIEW: CHANGES REQUESTED\n");
    const v = parseReviewFile(file);
    assert.equal(v.length, 1);
    assert.equal(v[0].verdict, "CHANGES_REQUESTED");
  });

  it("ignores sections without REVIEW marker", () => {
    const cwd = track(makeTargetProject());
    const file = writeReview(cwd, "by-platform.md",
      "## Review of backend\nLooking at this...\n\n## Review of qa\nfine\nREVIEW: APPROVED\n");
    const v = parseReviewFile(file);
    assert.equal(v.length, 1);
    assert.equal(v[0].area, "qa");
  });

  it("ignores unknown areas", () => {
    const cwd = track(makeTargetProject());
    const file = writeReview(cwd, "by-backend.md",
      "## Review of marketing\nlol\nREVIEW: APPROVED\n");
    const v = parseReviewFile(file);
    assert.equal(v.length, 0);
  });

  it("maps reviewer filename to agent name", () => {
    assert.equal(reviewerNameFromPath("/p/by-backend.md"), "dev-backend");
    assert.equal(reviewerNameFromPath("/p/by-frontend.md"), "dev-frontend");
    assert.equal(reviewerNameFromPath("/p/by-platform.md"), "dev-platform");
    assert.equal(reviewerNameFromPath("/p/by-qa.md"), "dev-qa");
    assert.equal(reviewerNameFromPath("/p/by-documentation.md"), "dev-documentation");
    assert.equal(reviewerNameFromPath("/p/by-security.md"), "security-engineer");
    assert.equal(reviewerNameFromPath("/p/by-principal.md"), "principal");
    assert.equal(reviewerNameFromPath("/p/notamatch.md"), null);
  });
});

describe("approval-derivation: gate upsert (end-to-end)", () => {
  it("creates a new gate with contract F identity fields", () => {
    const cwd = track(makeTargetProject());
    writeReview(cwd, "by-backend.md", "## Review of frontend\nLGTM\nREVIEW: APPROVED\n");
    runHook(cwd);
    const g = readGate(cwd, "stage-05.frontend");
    assert.ok(g, "gate not written");
    assert.equal(g.stage, "stage-05");
    assert.equal(g.workstream, "frontend");
    assert.equal(g.host, "claude-code");
    assert.match(g.orchestrator, /^devteam@/);
    assert.equal(g.approvals.length, 1);
    assert.equal(g.approvals[0], "dev-backend");
  });

  it("PASS only when approvals >= required AND no changes_requested", () => {
    const cwd = track(makeTargetProject());
    writeReview(cwd, "by-backend.md", "## Review of frontend\nA\nREVIEW: APPROVED\n");
    writeReview(cwd, "by-platform.md", "## Review of frontend\nB\nREVIEW: APPROVED\n");
    runHook(cwd);
    const g = readGate(cwd, "stage-05.frontend");
    assert.equal(g.status, "PASS");
    assert.equal(g.approvals.length, 2);
  });

  it("CHANGES_REQUESTED removes prior approval from same reviewer", () => {
    const cwd = track(makeTargetProject());
    writeReview(cwd, "by-backend.md", "## Review of frontend\nA\nREVIEW: APPROVED\n");
    runHook(cwd);
    const g1 = readGate(cwd, "stage-05.frontend");
    assert.deepEqual(g1.approvals, ["dev-backend"]);
    // Now change the same review to CHANGES_REQUESTED
    writeReview(cwd, "by-backend.md", "## Review of frontend\nWait\nREVIEW: CHANGES REQUESTED\n");
    runHook(cwd);
    const g2 = readGate(cwd, "stage-05.frontend");
    assert.equal(g2.approvals.length, 0, "prior approval should be removed");
    assert.equal(g2.changes_requested.length, 1);
    assert.equal(g2.status, "FAIL");
  });

  it("dedupes approval from the same reviewer on re-run", () => {
    const cwd = track(makeTargetProject());
    writeReview(cwd, "by-backend.md", "## Review of frontend\nA\nREVIEW: APPROVED\n");
    runHook(cwd);
    runHook(cwd); // same review file, run hook again
    const g = readGate(cwd, "stage-05.frontend");
    assert.equal(g.approvals.length, 1);
  });

  it("preserves host on fanout gate across subsequent updates", () => {
    // Bug: every re-run of the hook re-stamped gate.host = HOST
    // ("claude-code"), clobbering the fanout target the gate was created
    // with. Subsequent peer-review attribution silently misrouted to
    // claude-code regardless of which host actually ran the review.
    const cwd = track(makeTargetProject());
    // Create the fanout gate (filename is a known-host name, so the hook
    // takes the fanout path and writes stage-05.frontend.codex.json).
    writeReview(cwd, "by-codex.md", "## Review of frontend\nLGTM\nREVIEW: APPROVED\n");
    runHook(cwd);
    const g1 = readGate(cwd, "stage-05.frontend.codex");
    assert.ok(g1, "fanout gate not written");
    assert.equal(g1.host, "codex");

    // Update the gate — same reviewer flips to CHANGES_REQUESTED. The
    // line 209 branch (existing gate read) fires; host must NOT be
    // clobbered.
    writeReview(cwd, "by-codex.md", "## Review of frontend\nwait\nREVIEW: CHANGES REQUESTED\n");
    runHook(cwd);
    const g2 = readGate(cwd, "stage-05.frontend.codex");
    assert.equal(g2.host, "codex", "host clobbered to claude-code on update — regression");
    assert.equal(g2.changes_requested.length, 1);
  });

  it("backfills host on a legacy gate that omits the field", () => {
    // Re-stamp behavior for legacy gates: if the existing gate predates
    // the host-field requirement, the hook should add it on next update
    // (using the inferred host, or HOST as final fallback) rather than
    // leaving the field absent and failing validation.
    const cwd = track(makeTargetProject());
    fs.mkdirSync(path.join(cwd, "pipeline", "gates"), { recursive: true });
    fs.writeFileSync(
      path.join(cwd, "pipeline", "gates", "stage-05.frontend.json"),
      JSON.stringify({
        stage: "stage-05",
        workstream: "frontend",
        // host: omitted on purpose
        orchestrator: "devteam@old",
        track: "full",
        status: "FAIL",
        timestamp: "2026-01-01T00:00:00Z",
        blockers: [],
        warnings: [],
        area: "frontend",
        approvals: [],
        changes_requested: [],
        required_approvals: 2,
      }, null, 2),
    );
    writeReview(cwd, "by-backend.md", "## Review of frontend\nLGTM\nREVIEW: APPROVED\n");
    runHook(cwd);
    const g = readGate(cwd, "stage-05.frontend");
    assert.equal(g.host, "claude-code", "legacy gate should be backfilled with HOST");
  });

  it("creates nano gates with required_approvals=1 and review_shape=single", () => {
    const cwd = track(makeTargetProject({
      config: "routing:\n  default_host: generic\npipeline:\n  default_track: nano\n",
    }));
    writeReview(cwd, "by-backend.md", "## Review of backend\nLGTM\nREVIEW: APPROVED\n");
    runHook(cwd);
    const g = readGate(cwd, "stage-05.backend");
    assert.ok(g, "gate not written");
    assert.equal(g.required_approvals, 1, "nano needs 1 approval, not 2");
    assert.equal(g.review_shape, "single");
    assert.equal(g.track, "nano");
    assert.equal(g.status, "PASS", "1 approval should be enough on nano");
  });

  it("non-nano tracks keep required_approvals=2 and review_shape=matrix", () => {
    const cwd = track(makeTargetProject()); // default: routing.default_host=generic, track=full
    writeReview(cwd, "by-backend.md", "## Review of frontend\nLGTM\nREVIEW: APPROVED\n");
    runHook(cwd);
    const g = readGate(cwd, "stage-05.frontend");
    assert.equal(g.required_approvals, 2);
    assert.equal(g.review_shape, "matrix");
    assert.equal(g.status, "FAIL", "1 approval is not enough on full");
  });

  it("uses an approved Stage 1 loop track for documentation review when config defaults to full", () => {
    const cwd = track(makeTargetProject());
    seedGate(cwd, "stage-01", {
      stage: "stage-01",
      status: "PASS",
      track: "loop",
      active_roles: ["documentation"],
      affected_files: ["docs/guide.md"],
      acceptance_criteria_count: 1,
      out_of_scope_items: [],
      required_sections_complete: true,
    });
    writeReview(cwd, "by-documentation.md", "## Review of documentation\nLGTM\nREVIEW: APPROVED\n");
    runHook(cwd);
    const gate = readGate(cwd, "stage-05.documentation");
    assert.ok(gate, "documentation gate not written");
    assert.equal(gate.track, "loop");
    assert.equal(gate.required_approvals, 1);
    assert.equal(gate.status, "PASS");
  });
});
