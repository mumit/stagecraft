// Tests for `devteam commit` command (Phase 12.2).
//
// These tests use temp directories (devteam-test- prefix) and inject run-state
// directly — they do NOT run git or touch the real repo.

"use strict";

const { describe, it, afterEach } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { makeTargetProject, cleanup } = require("./_helpers");
const REPO_ROOT = path.resolve(__dirname, "..");

// Import the modules under test.
const { STAGE_ARTIFACTS } = require(path.join(REPO_ROOT, "core", "pipeline", "artifacts"));
const { isVolatile: _isVolatile } = (() => {
  // Re-export the internal isVolatile function by loading the module source.
  // We expose it via a thin wrapper to test volatile-path logic.
  return {};
})();

// Load the commit module's internal helpers by requiring the module.
// The module does not export helpers directly, so we test them via the CLI path
// (see integration tests below) and test the artifacts registry directly.

let _dirs = [];
function track(cwd) { _dirs.push(cwd); return cwd; }
afterEach(() => { _dirs.forEach(cleanup); _dirs = []; });

// ── Artifact registry ────────────────────────────────────────────────────────

describe("STAGE_ARTIFACTS registry", () => {
  it("contains an entry for every stage ID in stages.js", () => {
    const { STAGES } = require(path.join(REPO_ROOT, "core", "pipeline", "stages"));
    const stageIds = Object.values(STAGES).map((s) => s.stage);
    for (const id of stageIds) {
      assert.ok(id in STAGE_ARTIFACTS, `Missing entry for ${id}`);
    }
  });

  it("stage-01 artifact is brief.md (not diagnosis.md)", () => {
    assert.deepEqual(STAGE_ARTIFACTS["stage-01"], ["brief.md"]);
  });

  it("stage-03b artifact is spec.feature", () => {
    assert.ok(STAGE_ARTIFACTS["stage-03b"].includes("spec.feature"));
  });

  it("stage-04e is gate-only (empty artifacts)", () => {
    assert.deepEqual(STAGE_ARTIFACTS["stage-04e"], []);
  });

  it("stage-05 lists code-review/ directory", () => {
    assert.ok(STAGE_ARTIFACTS["stage-05"].some((p) => p === "code-review/"));
  });

  it("stage-09 includes lessons-learned.md", () => {
    assert.ok(STAGE_ARTIFACTS["stage-09"].includes("lessons-learned.md"));
  });
});

// ── commit command integration (via module, not subprocess) ──────────────────
//
// We test the file-selection logic by calling the commit command's internal
// logic. Since the command uses process.exit and readline for interactive
// use, we test via --dry-run in a controlled subprocess or by exercising the
// logic at a unit level.
//
// For dry-run + json, we use a subprocess spawned with the CLI.

const { spawnSync } = require("node:child_process");
const REPO_BIN = path.join(REPO_ROOT, "bin", "devteam");

function runCommit(args, cwd) {
  return spawnSync("node", [REPO_BIN, "commit", ...args], {
    cwd,
    encoding: "utf8",
    env: { ...process.env, CI: "true" },
  });
}

// Write a minimal run-state.json for the commit command to read.
function writeRunState(cwd, state) {
  const pDir = path.join(cwd, "pipeline");
  fs.mkdirSync(pDir, { recursive: true });
  fs.writeFileSync(path.join(pDir, "run-state.json"), JSON.stringify(state, null, 2));
}

function writeGate(cwd, stageId, gate = {}) {
  const gDir = path.join(cwd, "pipeline", "gates");
  fs.mkdirSync(gDir, { recursive: true });
  const finalGate = {
    stage: stageId,
    orchestrator: "devteam@test",
    track: "full",
    timestamp: "2026-06-15T00:00:00Z",
    blockers: [],
    warnings: [],
    status: "PASS",
    ...gate,
  };
  fs.writeFileSync(path.join(gDir, `${stageId}.json`), JSON.stringify(finalGate, null, 2));
}

// ── dry-run tests ─────────────────────────────────────────────────────────────

describe("commit --dry-run: nothing to commit", () => {
  it("exits 0 and prints 'nothing to commit' when no stages advanced", () => {
    const cwd = track(makeTargetProject());
    writeRunState(cwd, { stages_advanced: [], last_committed_stage_index: null, intent: "feature" });
    const r = runCommit(["--dry-run"], cwd);
    assert.equal(r.status, 0);
    assert.match(r.stdout, /nothing to commit/);
  });

  it("exits 0 and prints 'nothing to commit' when cursor is at end", () => {
    const cwd = track(makeTargetProject());
    writeRunState(cwd, {
      stages_advanced: ["stage-01"],
      last_committed_stage_index: 0,
      intent: "feature",
    });
    writeGate(cwd, "stage-01");
    const r = runCommit(["--dry-run"], cwd);
    assert.equal(r.status, 0);
    assert.match(r.stdout, /nothing to commit/);
  });
});

describe("commit --dry-run --json: file selection", () => {
  it("stages gate file + brief.md for stage-01 PASS when cursor is null", () => {
    const cwd = track(makeTargetProject());
    writeRunState(cwd, {
      stages_advanced: ["stage-01"],
      last_committed_stage_index: null,
      intent: "feature",
    });
    writeGate(cwd, "stage-01");
    // Create the artifact file
    const pDir = path.join(cwd, "pipeline");
    fs.writeFileSync(path.join(pDir, "brief.md"), "# Brief\n");
    fs.writeFileSync(path.join(pDir, "run-plan.json"), "{}\n");

    const r = runCommit(["--dry-run", "--json"], cwd);
    assert.equal(r.status, 0);
    const out = JSON.parse(r.stdout);
    assert.equal(out.dry_run, true);
    assert.ok(out.files.some((f) => f.includes("stage-01.json")), "gate file missing");
    assert.ok(out.files.some((f) => f.includes("brief.md")), "brief.md missing");
    assert.ok(out.files.some((f) => f.includes("run-plan.json")), "durable run plan missing");
  });

  it("uses diagnosis.md instead of brief.md in repair mode", () => {
    const cwd = track(makeTargetProject());
    writeRunState(cwd, {
      stages_advanced: ["stage-01"],
      last_committed_stage_index: null,
      intent: "repair",
    });
    writeGate(cwd, "stage-01");
    const pDir = path.join(cwd, "pipeline");
    fs.writeFileSync(path.join(pDir, "diagnosis.md"), "# Diagnosis\n");
    fs.writeFileSync(path.join(pDir, "brief.md"), "# Brief\n");

    const r = runCommit(["--dry-run", "--json"], cwd);
    assert.equal(r.status, 0);
    const out = JSON.parse(r.stdout);
    assert.ok(out.files.some((f) => f.includes("diagnosis.md")), "diagnosis.md missing");
    assert.ok(!out.files.some((f) => f.endsWith("brief.md")), "brief.md should not appear in repair mode");
  });

  it("skips gate file when gate status is FAIL", () => {
    const cwd = track(makeTargetProject());
    writeRunState(cwd, {
      stages_advanced: ["stage-01"],
      last_committed_stage_index: null,
      intent: "feature",
    });
    writeGate(cwd, "stage-01", { status: "FAIL" });
    const pDir = path.join(cwd, "pipeline");
    fs.writeFileSync(path.join(pDir, "brief.md"), "# Brief\n");

    const r = runCommit(["--dry-run", "--json"], cwd);
    assert.equal(r.status, 0);
    const out = JSON.parse(r.stdout);
    assert.ok(!out.files.some((f) => f.includes("stage-01.json")), "FAIL gate should not be staged");
  });

  it("skips artifact file that does not exist on disk", () => {
    const cwd = track(makeTargetProject());
    writeRunState(cwd, {
      stages_advanced: ["stage-01"],
      last_committed_stage_index: null,
      intent: "feature",
    });
    writeGate(cwd, "stage-01");
    // Do NOT create brief.md

    const r = runCommit(["--dry-run", "--json"], cwd);
    assert.equal(r.status, 0);
    const out = JSON.parse(r.stdout);
    assert.ok(!out.files.some((f) => f.includes("brief.md")), "absent brief.md should not appear");
    // Gate file should still be there
    assert.ok(out.files.some((f) => f.includes("stage-01.json")));
  });

  it("respects cursor: only stages uncollected stages", () => {
    const cwd = track(makeTargetProject());
    // stage-01 already committed (cursor=0), only stage-02 is uncollected
    writeRunState(cwd, {
      stages_advanced: ["stage-01", "stage-02"],
      last_committed_stage_index: 0,
      intent: "feature",
    });
    writeGate(cwd, "stage-01");
    writeGate(cwd, "stage-02");
    const pDir = path.join(cwd, "pipeline");
    fs.writeFileSync(path.join(pDir, "brief.md"), "# Brief\n");
    fs.writeFileSync(path.join(pDir, "design-spec.md"), "# Design\n");

    const r = runCommit(["--dry-run", "--json"], cwd);
    assert.equal(r.status, 0);
    const out = JSON.parse(r.stdout);
    // Should only have stage-02's files, not stage-01's
    assert.ok(!out.files.some((f) => f.includes("stage-01.json")), "stage-01 should not be re-staged");
    assert.ok(!out.files.some((f) => f.includes("brief.md")), "brief.md should not be re-staged");
    assert.ok(out.files.some((f) => f.includes("stage-02.json")), "stage-02 gate missing");
    assert.ok(out.files.some((f) => f.includes("design-spec.md")), "design-spec.md missing");
  });

  it("--all ignores cursor and stages everything", () => {
    const cwd = track(makeTargetProject());
    // Cursor at end (everything already committed), but --all forces re-stage
    writeRunState(cwd, {
      stages_advanced: ["stage-01", "stage-02"],
      last_committed_stage_index: 1,
      intent: "feature",
    });
    writeGate(cwd, "stage-01");
    writeGate(cwd, "stage-02");
    const pDir = path.join(cwd, "pipeline");
    fs.writeFileSync(path.join(pDir, "brief.md"), "# Brief\n");
    fs.writeFileSync(path.join(pDir, "design-spec.md"), "# Design\n");

    const r = runCommit(["--dry-run", "--json", "--all"], cwd);
    assert.equal(r.status, 0);
    const out = JSON.parse(r.stdout);
    assert.ok(out.files.some((f) => f.includes("stage-01.json")), "stage-01 gate missing with --all");
    assert.ok(out.files.some((f) => f.includes("brief.md")), "brief.md missing with --all");
    assert.ok(out.files.some((f) => f.includes("stage-02.json")), "stage-02 gate missing with --all");
  });

  it("excludes volatile files even if somehow in artifact list", () => {
    const cwd = track(makeTargetProject());
    writeRunState(cwd, {
      stages_advanced: ["stage-01"],
      last_committed_stage_index: null,
      intent: "feature",
    });
    writeGate(cwd, "stage-01");
    // Create run-state.json as a non-volatile file to confirm it's excluded
    // (pipeline/run-state.json is in the volatile list)
    const pDir = path.join(cwd, "pipeline");
    fs.writeFileSync(path.join(pDir, "run-state.json"), "{}");

    const r = runCommit(["--dry-run", "--json"], cwd);
    assert.equal(r.status, 0);
    const out = JSON.parse(r.stdout);
    // run-state.json should NOT be staged (it's volatile)
    assert.ok(!out.files.some((f) => f.includes("run-state.json")), "run-state.json should be excluded");
  });

  it("includes WARN-status gate file", () => {
    const cwd = track(makeTargetProject());
    writeRunState(cwd, {
      stages_advanced: ["stage-01"],
      last_committed_stage_index: null,
      intent: "feature",
    });
    writeGate(cwd, "stage-01", { status: "WARN" });
    const pDir = path.join(cwd, "pipeline");
    fs.writeFileSync(path.join(pDir, "brief.md"), "# Brief\n");

    const r = runCommit(["--dry-run", "--json"], cwd);
    assert.equal(r.status, 0);
    const out = JSON.parse(r.stdout);
    assert.ok(out.files.some((f) => f.includes("stage-01.json")), "WARN gate should be staged");
  });

  it("handles stage-04 pr-*.md glob artifacts", () => {
    const cwd = track(makeTargetProject());
    writeRunState(cwd, {
      stages_advanced: ["stage-04"],
      last_committed_stage_index: null,
      intent: "feature",
    });
    writeGate(cwd, "stage-04");
    const pDir = path.join(cwd, "pipeline");
    fs.writeFileSync(path.join(pDir, "build-plan.md"), "# Build\n");
    fs.writeFileSync(path.join(pDir, "pr-backend.md"), "# PR\n");

    const r = runCommit(["--dry-run", "--json"], cwd);
    assert.equal(r.status, 0);
    const out = JSON.parse(r.stdout);
    assert.ok(out.files.some((f) => f.includes("build-plan.md")));
    assert.ok(out.files.some((f) => f.includes("pr-backend.md")));
  });

  it("handles stage-05 code-review/ directory artifact", () => {
    const cwd = track(makeTargetProject());
    writeRunState(cwd, {
      stages_advanced: ["stage-05"],
      last_committed_stage_index: null,
      intent: "feature",
    });
    writeGate(cwd, "stage-05");
    const reviewDir = path.join(cwd, "pipeline", "code-review");
    fs.mkdirSync(reviewDir, { recursive: true });
    fs.writeFileSync(path.join(reviewDir, "by-reviewer.md"), "# Review\n");

    const r = runCommit(["--dry-run", "--json"], cwd);
    assert.equal(r.status, 0);
    const out = JSON.parse(r.stdout);
    assert.ok(out.files.some((f) => f.includes("by-reviewer.md")));
  });

  it("commit message includes stage range in subject", () => {
    const cwd = track(makeTargetProject());
    writeRunState(cwd, {
      stages_advanced: ["stage-01", "stage-02"],
      last_committed_stage_index: null,
      intent: "feature",
    });
    writeGate(cwd, "stage-01");
    writeGate(cwd, "stage-02");
    const pDir = path.join(cwd, "pipeline");
    fs.writeFileSync(path.join(pDir, "brief.md"), "# Brief\n");

    const r = runCommit(["--dry-run", "--json"], cwd);
    assert.equal(r.status, 0);
    const out = JSON.parse(r.stdout);
    assert.match(out.message, /pipeline: stages 01/);
    assert.match(out.message, /PASS/);
  });

  it("repair mode generates pipeline(repair) prefix in message", () => {
    const cwd = track(makeTargetProject());
    writeRunState(cwd, {
      stages_advanced: ["stage-01"],
      last_committed_stage_index: null,
      intent: "repair",
    });
    writeGate(cwd, "stage-01");

    const r = runCommit(["--dry-run", "--json"], cwd);
    assert.equal(r.status, 0);
    const out = JSON.parse(r.stdout);
    assert.match(out.message, /pipeline\(repair\)/);
  });

  it("--message overrides generated message", () => {
    const cwd = track(makeTargetProject());
    writeRunState(cwd, {
      stages_advanced: ["stage-01"],
      last_committed_stage_index: null,
      intent: "feature",
    });
    writeGate(cwd, "stage-01");
    const pDir = path.join(cwd, "pipeline");
    fs.writeFileSync(path.join(pDir, "brief.md"), "# Brief\n");

    const r = runCommit(["--dry-run", "--json", "--message", "custom: my message"], cwd);
    assert.equal(r.status, 0);
    const out = JSON.parse(r.stdout);
    assert.match(out.message, /custom: my message/);
  });
});

// ── Schema migration test ────────────────────────────────────────────────────

describe("commit: schema migration for old run-state.json", () => {
  it("treats missing stages_advanced as empty list (nothing to commit)", () => {
    const cwd = track(makeTargetProject());
    // Simulate an old run-state.json without stages_advanced
    writeRunState(cwd, { intent: "feature", track: "full", iterations: 3 });

    const r = runCommit(["--dry-run"], cwd);
    assert.equal(r.status, 0);
    assert.match(r.stdout, /nothing to commit/);
  });

  it("treats missing last_committed_stage_index as null (all stages uncollected)", () => {
    const cwd = track(makeTargetProject());
    // Old run-state without last_committed_stage_index
    writeRunState(cwd, { stages_advanced: ["stage-01"], intent: "feature" });
    writeGate(cwd, "stage-01");
    const pDir = path.join(cwd, "pipeline");
    fs.writeFileSync(path.join(pDir, "brief.md"), "# Brief\n");

    const r = runCommit(["--dry-run", "--json"], cwd);
    assert.equal(r.status, 0);
    const out = JSON.parse(r.stdout);
    // Should find files (cursor treated as null → all uncollected)
    assert.ok(out.files.length > 0, "expected files to stage with null cursor");
  });
});

// ── CLI registration ──────────────────────────────────────────────────────────

describe("commit: CLI registration", () => {
  it("devteam commit --help exits 0", () => {
    const { spawnSync: sp } = require("node:child_process");
    const r = sp("node", [REPO_BIN, "commit", "--help"], { encoding: "utf8" });
    assert.equal(r.status, 0);
    assert.match(r.stdout, /--dry-run/);
    assert.match(r.stdout, /--all/);
  });

  it("devteam help includes commit", () => {
    const { spawnSync: sp } = require("node:child_process");
    const r = sp("node", [REPO_BIN, "help"], { encoding: "utf8" });
    assert.equal(r.status, 0);
    assert.match(r.stdout, /commit/);
  });
});

// ── Driver: stages_advanced in run-state.json ─────────────────────────────────

describe("driver: stages_advanced written to run-state.json", () => {
  const { run: runDriver } = require(path.join(REPO_ROOT, "core", "driver"));
  const { makeTargetProject: mtp, seedGate } = require("./_helpers");

  it("initialises stages_advanced as empty array in fresh run-state", async () => {
    const cwd = track(mtp());
    // Seed all stages as PASS so the pipeline completes immediately
    const { orderedStageNamesForTrack, getStage } = require(path.join(REPO_ROOT, "core", "pipeline", "stages"));
    for (const n of orderedStageNamesForTrack("full")) {
      const def = getStage(n);
      seedGate(cwd, def.stage, { status: "PASS" });
    }
    const s = await runDriver({ cwd });
    // Driver should have written run-state.json
    const statePath = path.join(cwd, "pipeline", "run-state.json");
    assert.ok(fs.existsSync(statePath), "run-state.json should exist");
    const state = JSON.parse(fs.readFileSync(statePath, "utf8"));
    assert.ok(Array.isArray(state.stages_advanced), "stages_advanced should be an array");
    assert.equal(typeof state.last_committed_stage_index, "object", "last_committed_stage_index should be null initially");
    assert.equal(state.last_committed_stage_index, null);
    // On a full-track complete run with injected next, stages_advanced might be empty
    // (the seeded gates skip dispatching). Just verify the field exists and is an array.
    void s;
  });

  it("populates stages_advanced when stages are dispatched", async () => {
    const cwd = track(mtp());
    // Use injected next/runStageHeadless to simulate a single stage dispatch
    let callCount = 0;
    function fakeNext() {
      callCount++;
      if (callCount === 1) {
        return { action: "run-stage", stage: "stage-01", name: "requirements", roles: ["pm"] };
      }
      return { action: "pipeline-complete", reason: "done" };
    }
    function fakeRun() {
      return [{ gatePath: "pipeline/gates/stage-01.json", exitCode: 0 }];
    }
    // Provide a fake gate so that next() on the second call sees PASS
    seedGate(cwd, "stage-01", { status: "PASS" });

    await runDriver({ cwd, next: fakeNext, runStageHeadless: fakeRun, mergeWorkstreamGates: () => ({ merged: true }) });

    const statePath = path.join(cwd, "pipeline", "run-state.json");
    const state = JSON.parse(fs.readFileSync(statePath, "utf8"));
    assert.ok(Array.isArray(state.stages_advanced));
    assert.ok(state.stages_advanced.includes("stage-01"), `expected stage-01 in stages_advanced, got: ${JSON.stringify(state.stages_advanced)}`);
    assert.equal(state.last_committed_stage_index, null, "cursor should be null until devteam commit is called");
  });
});
