// `devteam restart <stage>` — clears a stage's gates (and optionally
// downstream gates + injected blocker sections) so the pipeline can
// re-run that stage. Tier-4 addition for the "I hit an escalation,
// now how do I redo work cleanly?" flow.

const { describe, it, afterEach } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { spawnSync } = require("node:child_process");
const { BIN, makeTargetProject, seedGate, cleanup } = require("./_helpers");

let _dirs = [];
function track(cwd) { _dirs.push(cwd); return cwd; }
afterEach(() => { _dirs.forEach(cleanup); _dirs = []; });

function run(args, opts = {}) {
  const r = spawnSync("node", [BIN, ...args], {
    cwd: opts.cwd, encoding: "utf8",
  });
  return { status: r.status, stdout: r.stdout || "", stderr: r.stderr || "" };
}

function gatePath(cwd, name) {
  return path.join(cwd, "pipeline", "gates", `${name}.json`);
}

describe("restart: argument handling", () => {
  it("prints usage on no args (exit 2)", () => {
    const cwd = track(makeTargetProject());
    const r = run(["restart"], { cwd });
    assert.equal(r.status, 2);
    assert.match(r.stderr, /Usage: devteam restart/);
  });

  it("rejects unknown stage with a list of valid stages", () => {
    const cwd = track(makeTargetProject());
    const r = run(["restart", "totally-not-a-stage"], { cwd });
    assert.equal(r.status, 2);
    assert.match(r.stderr, /Unknown stage/);
    assert.match(r.stderr, /Known stages:/);
  });

  it("accepts the stage id form (e.g. 'stage-05') as well as the name", () => {
    const cwd = track(makeTargetProject());
    seedGate(cwd, "stage-05.backend", { workstream: "backend", host: "claude-code", status: "PASS" });
    const r = run(["restart", "stage-05"], { cwd });
    assert.equal(r.status, 0);
    assert.match(r.stdout, /Removed/);
  });
});

// Regression: `devteam restart` special-cased id→name resolution locally;
// `devteam stage` (the actual dispatch command) had no equivalent, so
// `devteam stage stage-04 --headless` failed with "Unknown stage" even
// though the semantically identical `devteam restart stage-04` worked.
// resolveStageName/getStage are now the one shared implementation both
// commands (and core/orchestrator.js's runStage) resolve through.
describe("pipeline/stages: resolveStageName + getStage id aliasing", () => {
  const { STAGES, resolveStageName, getStage } = require("../core/pipeline/stages");

  it("resolveStageName is the identity for a friendly name", () => {
    assert.equal(resolveStageName("build"), "build");
  });

  it("resolveStageName maps a gate-id back to its friendly name", () => {
    assert.equal(resolveStageName("stage-04"), "build");
  });

  it("resolveStageName returns null for unknown input", () => {
    assert.equal(resolveStageName("not-a-stage"), null);
  });

  it("getStage accepts the gate-id form and returns the same def as the name", () => {
    assert.equal(getStage("stage-04"), STAGES.build);
    assert.equal(getStage("stage-04"), getStage("build"));
  });

  it("getStage still returns null for unknown input", () => {
    assert.equal(getStage("not-a-stage"), null);
  });
});

describe("restart: gate-file removal", () => {
  it("removes the named stage's merged + per-workstream gates", () => {
    const cwd = track(makeTargetProject());
    seedGate(cwd, "stage-04", { stage: "stage-04", status: "PASS" });
    seedGate(cwd, "stage-04.backend", { workstream: "backend", host: "claude-code", status: "PASS" });
    seedGate(cwd, "stage-04.frontend", { workstream: "frontend", host: "claude-code", status: "PASS" });
    seedGate(cwd, "stage-04.platform", { workstream: "platform", host: "claude-code", status: "PASS" });
    seedGate(cwd, "stage-04.qa", { workstream: "qa", host: "claude-code", status: "PASS" });

    const r = run(["restart", "build"], { cwd });
    assert.equal(r.status, 0);

    for (const name of ["stage-04", "stage-04.backend", "stage-04.frontend", "stage-04.platform", "stage-04.qa"]) {
      assert.ok(!fs.existsSync(gatePath(cwd, name)), `${name}.json should be removed`);
    }
  });

  it("does NOT remove gates for unrelated stages", () => {
    const cwd = track(makeTargetProject());
    seedGate(cwd, "stage-01", { workstream: "pm", host: "claude-code", status: "PASS" });
    seedGate(cwd, "stage-02", { workstream: "principal", host: "claude-code", status: "PASS" });
    seedGate(cwd, "stage-04", { stage: "stage-04", status: "FAIL", blockers: ["bug"] });
    seedGate(cwd, "stage-04.backend", { workstream: "backend", host: "claude-code", status: "FAIL" });

    run(["restart", "build"], { cwd });

    assert.ok(fs.existsSync(gatePath(cwd, "stage-01")), "earlier stage gate must survive");
    assert.ok(fs.existsSync(gatePath(cwd, "stage-02")), "earlier stage gate must survive");
    assert.ok(!fs.existsSync(gatePath(cwd, "stage-04")));
    assert.ok(!fs.existsSync(gatePath(cwd, "stage-04.backend")));
  });

  it("succeeds even when the stage has no gates yet (idempotent)", () => {
    const cwd = track(makeTargetProject());
    const r = run(["restart", "qa"], { cwd });
    assert.equal(r.status, 0);
    assert.match(r.stdout, /Nothing to clear/);
  });
});

describe("restart: --cascade", () => {
  it("clears the named stage AND every later stage in the active track", () => {
    const cwd = track(makeTargetProject());
    // Seed gates for stages 04 / 05 / 06 / 07 / 08 / 09 (a few that come after build on full).
    for (const s of ["stage-04", "stage-05", "stage-06", "stage-07", "stage-08", "stage-09"]) {
      seedGate(cwd, s, { stage: s, status: "PASS" });
    }
    // Also keep an earlier stage to verify cascade doesn't go backwards.
    seedGate(cwd, "stage-02", { workstream: "principal", host: "claude-code", status: "PASS" });

    const r = run(["restart", "build", "--cascade"], { cwd });
    assert.equal(r.status, 0);

    assert.ok(fs.existsSync(gatePath(cwd, "stage-02")), "earlier stage must survive cascade");
    for (const s of ["stage-04", "stage-05", "stage-06", "stage-07", "stage-08", "stage-09"]) {
      assert.ok(!fs.existsSync(gatePath(cwd, s)), `${s}.json must be removed by cascade`);
    }
  });

  it("without --cascade, leaves later stages untouched", () => {
    const cwd = track(makeTargetProject());
    seedGate(cwd, "stage-04", { stage: "stage-04", status: "PASS" });
    seedGate(cwd, "stage-05", { stage: "stage-05", status: "PASS" });
    seedGate(cwd, "stage-06", { stage: "stage-06", status: "PASS" });

    run(["restart", "build"], { cwd });

    assert.ok(!fs.existsSync(gatePath(cwd, "stage-04")));
    assert.ok(fs.existsSync(gatePath(cwd, "stage-05")), "no cascade → stage-05 must survive");
    assert.ok(fs.existsSync(gatePath(cwd, "stage-06")), "no cascade → stage-06 must survive");
  });
});

describe("restart: pipeline/context.md handling", () => {
  function seedContext(cwd, content) {
    fs.mkdirSync(path.join(cwd, "pipeline"), { recursive: true });
    fs.writeFileSync(path.join(cwd, "pipeline", "context.md"), content);
  }

  it("strips red-team-blockers section when restarting stage-04c", () => {
    const cwd = track(makeTargetProject());
    seedContext(cwd,
      "<!-- devteam:red-team-blockers:begin -->\n" +
      "## IMMEDIATE: Red-Team Blockers — Fix Before Peer Review\n\n" +
      "- R-1 [high/likely]: a finding\n\n" +
      "<!-- devteam:red-team-blockers:end -->\n\n" +
      "# Context\n\nSurvives.\n");
    seedGate(cwd, "stage-04c", { stage: "stage-04c", status: "FAIL", blockers: ["x"] });

    run(["restart", "red-team"], { cwd });

    const ctx = fs.readFileSync(path.join(cwd, "pipeline", "context.md"), "utf8");
    assert.doesNotMatch(ctx, /red-team-blockers/);
    assert.match(ctx, /# Context/);
    assert.match(ctx, /Survives/);
  });

  it("strips qa-build-blockers section when restarting build (which owns stage-04.qa)", () => {
    const cwd = track(makeTargetProject());
    seedContext(cwd,
      "<!-- devteam:qa-build-blockers:begin -->\n" +
      "QA bug list\n" +
      "<!-- devteam:qa-build-blockers:end -->\n\n" +
      "# Context\n");
    seedGate(cwd, "stage-04.qa", { workstream: "qa", host: "claude-code", status: "FAIL" });

    run(["restart", "build"], { cwd });

    const ctx = fs.readFileSync(path.join(cwd, "pipeline", "context.md"), "utf8");
    assert.doesNotMatch(ctx, /qa-build-blockers/);
  });

  it("--keep-context preserves injected sections", () => {
    const cwd = track(makeTargetProject());
    seedContext(cwd,
      "<!-- devteam:red-team-blockers:begin -->\nfindings\n<!-- devteam:red-team-blockers:end -->\n\n# Context\n");
    seedGate(cwd, "stage-04c", { stage: "stage-04c", status: "FAIL" });

    run(["restart", "red-team", "--keep-context"], { cwd });

    const ctx = fs.readFileSync(path.join(cwd, "pipeline", "context.md"), "utf8");
    assert.match(ctx, /red-team-blockers/, "--keep-context must NOT strip");
  });

  it("does not strip sections owned by unrelated stages", () => {
    const cwd = track(makeTargetProject());
    seedContext(cwd,
      "<!-- devteam:qa-build-blockers:begin -->\nQA bug\n<!-- devteam:qa-build-blockers:end -->\n\n" +
      "<!-- devteam:red-team-blockers:begin -->\nRT bug\n<!-- devteam:red-team-blockers:end -->\n\n" +
      "# Context\n");
    seedGate(cwd, "stage-04c", { stage: "stage-04c", status: "FAIL" });

    run(["restart", "red-team"], { cwd });

    const ctx = fs.readFileSync(path.join(cwd, "pipeline", "context.md"), "utf8");
    assert.doesNotMatch(ctx, /red-team-blockers/, "red-team section stripped");
    assert.match(ctx, /qa-build-blockers/, "qa section is unrelated — must survive");
  });
});

describe("restart: --dry-run", () => {
  it("prints what would happen, deletes nothing", () => {
    const cwd = track(makeTargetProject());
    seedGate(cwd, "stage-04", { stage: "stage-04", status: "PASS" });
    seedGate(cwd, "stage-04.backend", { workstream: "backend", host: "claude-code", status: "PASS" });

    const r = run(["restart", "build", "--dry-run"], { cwd });
    assert.equal(r.status, 0);
    assert.match(r.stdout, /Would restart/);
    assert.match(r.stdout, /Would delete/);
    assert.match(r.stdout, /stage-04\.json/);
    assert.match(r.stdout, /stage-04\.backend\.json/);
    assert.match(r.stdout, /Re-run without --dry-run/);

    // Files must still exist
    assert.ok(fs.existsSync(gatePath(cwd, "stage-04")), "dry-run must NOT delete");
    assert.ok(fs.existsSync(gatePath(cwd, "stage-04.backend")), "dry-run must NOT delete");
  });
});

describe("restart: archive cleanup", () => {
  function archivePath(cwd, stageId, attempt) {
    return path.join(cwd, "pipeline", "gates", "archive", `${stageId}.attempt-${attempt}.json`);
  }
  function seedArchive(cwd, stageId, attempt, gate = {}) {
    const dir = path.join(cwd, "pipeline", "gates", "archive");
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(archivePath(cwd, stageId, attempt), JSON.stringify({ stage: stageId, blockers: [], ...gate }, null, 2));
  }

  it("removes archive files for the restarted stage", () => {
    const cwd = track(makeTargetProject());
    seedGate(cwd, "stage-04", { stage: "stage-04", status: "FAIL", blockers: ["lint"] });
    seedArchive(cwd, "stage-04", 1, { blockers: ["original blocker"] });
    seedArchive(cwd, "stage-04", 2, { blockers: ["lint"] });

    const r = run(["restart", "build"], { cwd });
    assert.equal(r.status, 0);

    assert.ok(!fs.existsSync(archivePath(cwd, "stage-04", 1)), "attempt-1 archive must be removed");
    assert.ok(!fs.existsSync(archivePath(cwd, "stage-04", 2)), "attempt-2 archive must be removed");
  });

  it("does NOT remove archives for unrelated stages", () => {
    const cwd = track(makeTargetProject());
    seedGate(cwd, "stage-04", { stage: "stage-04", status: "FAIL" });
    seedArchive(cwd, "stage-04", 1, { blockers: ["build blocker"] });
    seedArchive(cwd, "stage-06b", 1, { blockers: ["a11y violation"] });

    run(["restart", "build"], { cwd });

    assert.ok(!fs.existsSync(archivePath(cwd, "stage-04", 1)), "build archive removed");
    assert.ok(fs.existsSync(archivePath(cwd, "stage-06b", 1)), "stage-06b archive must survive");
  });

  it("succeeds cleanly when no archives exist (idempotent)", () => {
    const cwd = track(makeTargetProject());
    seedGate(cwd, "stage-04", { stage: "stage-04", status: "PASS" });
    const r = run(["restart", "build"], { cwd });
    assert.equal(r.status, 0);
    // No crash, just removes the gate file
    assert.ok(!fs.existsSync(gatePath(cwd, "stage-04")));
  });

  it("--cascade also removes archives for all downstream stages", () => {
    const cwd = track(makeTargetProject());
    seedGate(cwd, "stage-04", { stage: "stage-04", status: "PASS" });
    seedGate(cwd, "stage-05", { stage: "stage-05", status: "PASS" });
    seedArchive(cwd, "stage-04", 1, { blockers: ["build"] });
    seedArchive(cwd, "stage-05", 1, { blockers: ["peer-review"] });

    const r = run(["restart", "build", "--cascade"], { cwd });
    assert.equal(r.status, 0);

    assert.ok(!fs.existsSync(archivePath(cwd, "stage-04", 1)), "build archive removed by cascade");
    assert.ok(!fs.existsSync(archivePath(cwd, "stage-05", 1)), "peer-review archive removed by cascade");
  });

  it("--dry-run lists archives that would be removed without deleting them", () => {
    const cwd = track(makeTargetProject());
    seedGate(cwd, "stage-04", { stage: "stage-04", status: "FAIL" });
    seedArchive(cwd, "stage-04", 1, { blockers: ["blocker"] });

    const r = run(["restart", "build", "--dry-run"], { cwd });
    assert.equal(r.status, 0);
    assert.match(r.stdout, /attempt-1\.json/, "dry-run must list archive file");
    assert.ok(fs.existsSync(archivePath(cwd, "stage-04", 1)), "dry-run must NOT delete archive");
  });
});

describe("restart: stage artifact deletion", () => {
  function artifactPath(cwd, rel) {
    return path.join(cwd, "pipeline", rel);
  }
  function seedArtifact(cwd, rel, content = "# artifact\n") {
    const full = artifactPath(cwd, rel);
    fs.mkdirSync(path.dirname(full), { recursive: true });
    fs.writeFileSync(full, content);
  }

  it("deletes spec.feature when restarting executable-spec", () => {
    const cwd = track(makeTargetProject());
    seedGate(cwd, "stage-03b", { stage: "stage-03b", status: "PASS" });
    seedArtifact(cwd, "spec.feature");

    const r = run(["restart", "executable-spec"], { cwd });
    assert.equal(r.status, 0);
    assert.ok(!fs.existsSync(artifactPath(cwd, "spec.feature")), "spec.feature must be removed");
  });

  it("deletes spec.feature when cascading from requirements", () => {
    const cwd = track(makeTargetProject());
    seedGate(cwd, "stage-01", { status: "PASS" });
    seedGate(cwd, "stage-03b", { stage: "stage-03b", status: "PASS" });
    seedArtifact(cwd, "brief.md");
    seedArtifact(cwd, "spec.feature");

    const r = run(["restart", "requirements", "--cascade"], { cwd });
    assert.equal(r.status, 0);
    assert.ok(!fs.existsSync(artifactPath(cwd, "brief.md")), "brief.md removed by cascade");
    assert.ok(!fs.existsSync(artifactPath(cwd, "spec.feature")), "spec.feature removed by cascade");
  });

  it("does not delete spec.feature when restarting an unrelated earlier stage", () => {
    const cwd = track(makeTargetProject());
    seedGate(cwd, "stage-01", { status: "PASS" });
    seedArtifact(cwd, "spec.feature");

    run(["restart", "requirements"], { cwd });

    assert.ok(fs.existsSync(artifactPath(cwd, "spec.feature")), "spec.feature must survive restart of requirements");
  });

  it("deletes glob-matched artifacts (pr-*.md) when restarting build", () => {
    const cwd = track(makeTargetProject());
    seedGate(cwd, "stage-04", { stage: "stage-04", status: "PASS" });
    seedArtifact(cwd, "pr-backend.md");
    seedArtifact(cwd, "pr-frontend.md");
    seedArtifact(cwd, "build-plan.md");

    const r = run(["restart", "build"], { cwd });
    assert.equal(r.status, 0);
    assert.ok(!fs.existsSync(artifactPath(cwd, "pr-backend.md")), "pr-backend.md removed");
    assert.ok(!fs.existsSync(artifactPath(cwd, "pr-frontend.md")), "pr-frontend.md removed");
    assert.ok(!fs.existsSync(artifactPath(cwd, "build-plan.md")), "build-plan.md removed");
  });

  it("deletes directory artifacts (code-review/) when restarting peer-review", () => {
    const cwd = track(makeTargetProject());
    seedGate(cwd, "stage-05", { stage: "stage-05", status: "PASS" });
    seedArtifact(cwd, "code-review/by-alice.md");
    seedArtifact(cwd, "code-review/by-bob.md");

    const r = run(["restart", "peer-review"], { cwd });
    assert.equal(r.status, 0);
    assert.ok(!fs.existsSync(artifactPath(cwd, "code-review/by-alice.md")), "by-alice.md removed");
    assert.ok(!fs.existsSync(artifactPath(cwd, "code-review/by-bob.md")), "by-bob.md removed");
  });

  it("--dry-run lists artifact files without deleting them", () => {
    const cwd = track(makeTargetProject());
    seedGate(cwd, "stage-03b", { stage: "stage-03b", status: "PASS" });
    seedArtifact(cwd, "spec.feature");

    const r = run(["restart", "executable-spec", "--dry-run"], { cwd });
    assert.equal(r.status, 0);
    assert.match(r.stdout, /spec\.feature/, "dry-run must list spec.feature");
    assert.ok(fs.existsSync(artifactPath(cwd, "spec.feature")), "dry-run must NOT delete spec.feature");
  });

  it("succeeds cleanly when artifact files do not exist (idempotent)", () => {
    const cwd = track(makeTargetProject());
    seedGate(cwd, "stage-03b", { stage: "stage-03b", status: "PASS" });

    const r = run(["restart", "executable-spec"], { cwd });
    assert.equal(r.status, 0);
  });
});

describe("restart: brief.md clearing", () => {
  function briefPath(cwd) {
    return path.join(cwd, "pipeline", "brief.md");
  }
  function seedBrief(cwd) {
    fs.mkdirSync(path.join(cwd, "pipeline"), { recursive: true });
    fs.writeFileSync(briefPath(cwd), "# Brief\n\nOld feature.\n");
  }

  it("deletes pipeline/brief.md when restarting requirements", () => {
    const cwd = track(makeTargetProject());
    seedGate(cwd, "stage-01", { status: "PASS" });
    seedBrief(cwd);

    const r = run(["restart", "requirements"], { cwd });
    assert.equal(r.status, 0);
    assert.ok(!fs.existsSync(briefPath(cwd)), "brief.md must be removed when requirements is restarted");
  });

  it("deletes pipeline/brief.md when cascading from requirements", () => {
    const cwd = track(makeTargetProject());
    seedGate(cwd, "stage-01", { status: "PASS" });
    seedGate(cwd, "stage-02", { status: "PASS" });
    seedBrief(cwd);

    const r = run(["restart", "requirements", "--cascade"], { cwd });
    assert.equal(r.status, 0);
    assert.ok(!fs.existsSync(briefPath(cwd)), "brief.md must be removed by cascade from requirements");
    assert.ok(!fs.existsSync(gatePath(cwd, "stage-01")), "stage-01 gate also removed");
    assert.ok(!fs.existsSync(gatePath(cwd, "stage-02")), "stage-02 gate also removed by cascade");
  });

  it("does NOT delete brief.md when restarting a later stage", () => {
    const cwd = track(makeTargetProject());
    seedGate(cwd, "stage-04", { stage: "stage-04", status: "FAIL" });
    seedBrief(cwd);

    run(["restart", "build"], { cwd });

    assert.ok(fs.existsSync(briefPath(cwd)), "brief.md must survive restart of a non-requirements stage");
  });

  it("--dry-run lists brief.md deletion without acting", () => {
    const cwd = track(makeTargetProject());
    seedGate(cwd, "stage-01", { status: "PASS" });
    seedBrief(cwd);

    const r = run(["restart", "requirements", "--dry-run"], { cwd });
    assert.equal(r.status, 0);
    assert.match(r.stdout, /brief\.md/, "dry-run must mention brief.md");
    assert.ok(fs.existsSync(briefPath(cwd)), "dry-run must NOT delete brief.md");
  });

  it("succeeds cleanly when brief.md does not exist (idempotent)", () => {
    const cwd = track(makeTargetProject());
    seedGate(cwd, "stage-01", { status: "PASS" });

    const r = run(["restart", "requirements"], { cwd });
    assert.equal(r.status, 0);
  });
});

describe("restart: fixRetries reset", () => {
  function runStatePath(cwd) {
    return path.join(cwd, "pipeline", "run-state.json");
  }

  it("clears fixRetries for the named stage in run-state.json", () => {
    const cwd = track(makeTargetProject());
    seedGate(cwd, "stage-04c", { stage: "stage-04c", status: "FAIL" });
    fs.writeFileSync(runStatePath(cwd),
      JSON.stringify({ fixRetries: { "red-team": 2, "build": 1 } }, null, 2));

    const r = run(["restart", "red-team"], { cwd });
    assert.equal(r.status, 0);

    const rs = JSON.parse(fs.readFileSync(runStatePath(cwd), "utf8"));
    assert.equal(rs.fixRetries["red-team"], undefined,
      "red-team retry budget must be cleared after restart");
    assert.equal(rs.fixRetries["build"], 1,
      "unrelated stage retry budget must be preserved");
  });

  it("--cascade clears fixRetries for all cascaded stages", () => {
    const cwd = track(makeTargetProject());
    seedGate(cwd, "stage-04", { stage: "stage-04", status: "FAIL" });
    seedGate(cwd, "stage-04c", { stage: "stage-04c", status: "FAIL" });
    fs.writeFileSync(runStatePath(cwd),
      JSON.stringify({ fixRetries: { "build": 2, "red-team": 2 } }, null, 2));

    const r = run(["restart", "build", "--cascade"], { cwd });
    assert.equal(r.status, 0);

    const rs = JSON.parse(fs.readFileSync(runStatePath(cwd), "utf8"));
    assert.equal(rs.fixRetries["build"], undefined, "build retry budget cleared by cascade");
    assert.equal(rs.fixRetries["red-team"], undefined, "red-team retry budget cleared by cascade");
  });
});
