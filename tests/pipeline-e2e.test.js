// End-to-end orchestrator state-machine test. Walks the pipeline from
// init → next → stage → write gate → next → ... → pipeline-complete
// against a real tempdir for both the smallest track (nano) and the
// largest (full).
//
// Every other test in the suite seeds gates directly. This test walks
// `next()` repeatedly and writes synthetic-but-shaped gates the way an
// agent would, exercising the transitions between stages — including
// the multi-role merge path, conditional-stage skips, and the Stage 7
// auto-fold.
//
// Audit Tier-2: this closes the gap "no regression in next()'s
// stage-transition logic would be caught by the existing unit suite,
// because every test seeds gates rather than walking from empty."

const { describe, it, afterEach } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { spawnSync } = require("node:child_process");
const { REPO_ROOT, BIN, makeTargetProject, cleanup } = require("./_helpers");
const { next, mergeWorkstreamGates } = require(path.join(REPO_ROOT, "core", "orchestrator"));
const { getStage } = require(path.join(REPO_ROOT, "core", "pipeline", "stages"));

let _dirs = [];
function track(cwd) { _dirs.push(cwd); return cwd; }
afterEach(() => { _dirs.forEach(cleanup); _dirs = []; });

// Stage-specific gate fields the validator (or auto-fold) checks. The
// happy path PASS shape is enough — extra fields are tolerated.
const STAGE_GATE_EXTRAS = {
  "stage-04a": {
    lint_passed: true,
    tests_passed: true,
    dependency_review_passed: true,
    security_review_required: false,
    migration_safety_required: false,
  },
  "stage-06": {
    all_acceptance_criteria_met: true,
    criterion_to_test_mapping_is_one_to_one: true,
    tests_total: 2, tests_passed: 2, tests_failed: 0, failing_tests: [],
  },
};

function passGate(stageId, extra = {}) {
  return {
    stage: stageId,
    status: "PASS",
    orchestrator: "devteam@e2e-test",
    host: "generic",
    track: "full", // overridden per call
    timestamp: new Date().toISOString(),
    blockers: [],
    warnings: [],
    ...(STAGE_GATE_EXTRAS[stageId] || {}),
    ...extra,
  };
}

function writeGate(cwd, name, gate) {
  const dir = path.join(cwd, "pipeline", "gates");
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, `${name}.json`), JSON.stringify(gate, null, 2));
}

// Synthesize a stage's gate(s) the way an agent would. For single-role
// stages, write the bare gate. For multi-role stages, write per-role
// workstream gates (the merge step happens separately, driven by next).
function writeStageGates(cwd, stageName, opts = {}) {
  const stageDef = getStage(stageName);
  const trackName = opts.track || "full";
  if (!stageDef) throw new Error(`unknown stage ${stageName}`);
  // Use the same per-track role resolution the orchestrator uses, so
  // nano peer-review writes one gate (not four).
  const { rolesForStage } = require(path.join(REPO_ROOT, "core", "pipeline", "stages"));
  const roles = rolesForStage(stageDef, trackName);
  if (roles.length === 1) {
    writeGate(cwd, stageDef.stage, { ...passGate(stageDef.stage, opts.extra || {}), workstream: roles[0], track: trackName });
  } else {
    for (const role of roles) {
      writeGate(cwd, `${stageDef.stage}.${role}`, {
        ...passGate(stageDef.stage, opts.extra || {}),
        workstream: role,
        track: trackName,
      });
    }
  }
}

// Drive next() repeatedly until pipeline-complete, writing gates in
// response to each action. Returns the sequence of (action, stage)
// observations so the test can assert the walk.
function walkPipeline(cwd, opts = {}) {
  const trackName = opts.track || "full";
  const trace = [];
  const MAX_ITERS = 100;

  for (let i = 0; i < MAX_ITERS; i++) {
    const r = next({ cwd });
    trace.push({ action: r.action, name: r.name, reason: r.reason });

    if (r.action === "pipeline-complete") return trace;
    if (r.action === "fix-and-retry") {
      throw new Error(`unexpected fix-and-retry at ${r.name}: ${r.blockers?.join("; ") || r.reason}`);
    }
    if (r.action === "resolve-escalation") {
      throw new Error(`unexpected resolve-escalation at ${r.name}: ${r.reason}`);
    }
    if (r.action === "run-stage") {
      writeStageGates(cwd, r.name, { track: trackName });
      continue;
    }
    if (r.action === "continue-stage") {
      writeStageGates(cwd, r.name, { track: trackName });
      continue;
    }
    if (r.action === "merge") {
      const m = mergeWorkstreamGates(r.name, { cwd, track: trackName });
      assert.equal(m.merged, true, `merge of ${r.name} failed: ${m.reason}`);
      continue;
    }
    // fold-sign-off: orchestrator verified clean AC→test mapping; we write the
    // gate and loop (mirrors driver behavior). (item 1.2, phase-1-trust)
    if (r.action === "fold-sign-off") {
      fs.mkdirSync(path.dirname(r.gate_path), { recursive: true });
      fs.writeFileSync(r.gate_path, JSON.stringify(r.gate_content, null, 2) + "\n", "utf8");
      continue;
    }
    throw new Error(`unknown action ${r.action} at ${r.name}`);
  }
  throw new Error(`pipeline did not complete in ${MAX_ITERS} iterations`);
}

describe("e2e: nano track walks init → ... → pipeline-complete", () => {
  it("walks build → peer-review → qa with real gate IO", () => {
    const cwd = track(makeTargetProject({
      config: "routing:\n  default_host: generic\npipeline:\n  default_track: nano\n",
    }));

    const trace = walkPipeline(cwd, { track: "nano" });
    const stageNames = trace.filter((t) => t.action !== "pipeline-complete").map((t) => t.name);

    // Every stage in the nano track should appear in the trace at least
    // once. (May appear twice: "run-stage" then "merge" for multi-role
    // stages; on nano, peer-review is single-role so no merge.)
    assert.ok(stageNames.includes("build"), "build not in trace");
    assert.ok(stageNames.includes("peer-review"), "peer-review not in trace");
    assert.ok(stageNames.includes("qa"), "qa not in trace");

    // Build is multi-role on nano → expect a merge after run-stage
    const buildActions = trace.filter((t) => t.name === "build").map((t) => t.action);
    assert.ok(buildActions.includes("merge"), `build should require merge; got actions: ${buildActions.join(",")}`);

    // Peer-review on nano is scoped to one workstream → no merge needed
    const peerActions = trace.filter((t) => t.name === "peer-review").map((t) => t.action);
    assert.ok(!peerActions.includes("merge"), `nano peer-review should NOT require merge; got: ${peerActions.join(",")}`);

    // Final action is pipeline-complete
    assert.equal(trace[trace.length - 1].action, "pipeline-complete");
  });

  it("leaves a complete audit trail on disk", () => {
    const cwd = track(makeTargetProject({
      config: "routing:\n  default_host: generic\npipeline:\n  default_track: nano\n",
    }));
    walkPipeline(cwd, { track: "nano" });

    // The audit trail: every stage's merged gate file present and PASS.
    for (const stageId of ["stage-04", "stage-05", "stage-06"]) {
      const p = path.join(cwd, "pipeline", "gates", `${stageId}.json`);
      assert.ok(fs.existsSync(p), `missing audit trail: ${stageId}.json`);
      const g = JSON.parse(fs.readFileSync(p, "utf8"));
      assert.equal(g.status, "PASS", `${stageId}.json must be PASS for nano to complete`);
    }
  });
});

describe("e2e: loop track — exactly 4 dispatches to pipeline-complete (29.1)", () => {
  it("walks requirements -> build -> qa -> peer-review with no merges", () => {
    const cwd = track(makeTargetProject({
      config: "routing:\n  default_host: generic\npipeline:\n  default_track: loop\n",
    }));

    const trace = walkPipeline(cwd, { track: "loop" });
    const stageActions = trace.filter((t) => t.action !== "pipeline-complete");

    // Exactly 4 dispatches: one action per stage, no merge (single-role
    // build/peer-review on this track — see loopBuildRole in stages.js).
    assert.equal(stageActions.length, 4, `expected exactly 4 dispatches, got: ${JSON.stringify(stageActions)}`);
    assert.deepEqual(
      stageActions.map((t) => t.name),
      ["requirements", "build", "qa", "peer-review"],
    );
    assert.ok(stageActions.every((t) => t.action === "run-stage"), `every dispatch should be run-stage (no merges); got: ${JSON.stringify(stageActions.map((t) => t.action))}`);
    assert.equal(trace[trace.length - 1].action, "pipeline-complete");
  });

  it("leaves a complete audit trail — one merged gate per stage, all PASS", () => {
    const cwd = track(makeTargetProject({
      config: "routing:\n  default_host: generic\npipeline:\n  default_track: loop\n",
    }));
    walkPipeline(cwd, { track: "loop" });

    for (const stageId of ["stage-01", "stage-04", "stage-06", "stage-05"]) {
      const p = path.join(cwd, "pipeline", "gates", `${stageId}.json`);
      assert.ok(fs.existsSync(p), `missing audit trail: ${stageId}.json`);
      const g = JSON.parse(fs.readFileSync(p, "utf8"));
      assert.equal(g.status, "PASS", `${stageId}.json must be PASS for loop to complete`);
    }
    // Build/peer-review must NOT have written per-workstream files — the
    // dynamic single-role dispatch writes straight to the merged gate name.
    for (const stageId of ["stage-04", "stage-05"]) {
      for (const role of ["backend", "frontend", "platform", "qa"]) {
        const p = path.join(cwd, "pipeline", "gates", `${stageId}.${role}.json`);
        assert.ok(!fs.existsSync(p), `unexpected per-workstream gate on loop: ${stageId}.${role}.json`);
      }
    }
  });

  it("build and peer-review both dispatch the backend workstream by default", () => {
    const cwd = track(makeTargetProject({
      config: "routing:\n  default_host: generic\npipeline:\n  default_track: loop\n",
    }));
    walkPipeline(cwd, { track: "loop" });
    const build = JSON.parse(fs.readFileSync(path.join(cwd, "pipeline", "gates", "stage-04.json"), "utf8"));
    const review = JSON.parse(fs.readFileSync(path.join(cwd, "pipeline", "gates", "stage-05.json"), "utf8"));
    assert.equal(build.workstream, "backend");
    assert.equal(review.workstream, "backend");
  });
});

describe("e2e: full track walks all 17 stages end-to-end", () => {
  it("walks the full track through every stage, including multi-role merges", () => {
    const cwd = track(makeTargetProject({
      config: "routing:\n  default_host: generic\npipeline:\n  default_track: full\n  right_sizing: false\n",
    }));
    // Seed brief.md + test-report.md. If Stage 7 auto-fold is enabled
    // on this branch (PR #9 merged), these inputs let it fire; if not,
    // the walk falls through to multi-role sign-off and still completes.
    // Either path is a successful end-to-end.
    fs.mkdirSync(path.join(cwd, "pipeline"), { recursive: true });
    fs.writeFileSync(
      path.join(cwd, "pipeline", "brief.md"),
      "# Brief\n## Acceptance Criteria\n- AC-1: feature does X.\n- AC-2: feature does Y.\n",
    );
    fs.writeFileSync(
      path.join(cwd, "pipeline", "test-report.md"),
      "# Test Report\n\n## AC Coverage\n| AC | Test |\n|---|---|\n| AC-1 | unit/x.test.ts |\n| AC-2 | unit/y.test.ts |\n",
    );

    const trace = walkPipeline(cwd, { track: "full" });
    const seen = new Set(trace.map((t) => t.name).filter(Boolean));

    // Every full-track stage that runs unconditionally should appear in
    // the trace. Conditional stages (security-review, migration-safety)
    // are skipped because the trigger flags on stage-04a are false.
    // Sign-off may appear or be auto-folded depending on whether the
    // auto-fold feature is present on this branch — but sign-off's
    // resulting gate file must exist either way (asserted below).
    const requiredStages = [
      "requirements", "design", "clarification", "executable-spec",
      "build", "pre-review", "red-team",
      "peer-review", "qa", "accessibility-audit",
      "observability-gate", "verification-beyond-tests",
      "deploy", "retrospective",
    ];
    for (const s of requiredStages) {
      assert.ok(seen.has(s), `expected ${s} in trace; got: ${[...seen].join(", ")}`);
    }

    // The audit trail must be complete on disk regardless of which path
    // sign-off took. stage-07.json must exist; it carries either the
    // auto-fold's auto_from_stage_06 field or the merged result of a
    // PM+Platform sign-off — both are valid end-states.
    const stage07Path = path.join(cwd, "pipeline", "gates", "stage-07.json");
    assert.ok(fs.existsSync(stage07Path), "stage-07.json missing from audit trail");
    const stage07 = JSON.parse(fs.readFileSync(stage07Path, "utf8"));
    assert.equal(stage07.status, "PASS");

    // Final action: pipeline-complete
    assert.equal(trace[trace.length - 1].action, "pipeline-complete");
  });
});

describe("e2e: init → next → ... via CLI subprocess", () => {
  // Lightest CLI-level smoke. Exercises `bin/devteam init`, the file
  // layout it produces, and a couple of `devteam next` cycles end-to-end.
  it("init lays down the expected files; next reports the first stage", () => {
    const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "devteam-test-e2e-cli-"));
    _dirs.push(cwd);

    const init = spawnSync("node", [BIN, "init", "--host", "generic"], { cwd, encoding: "utf8" });
    assert.equal(init.status, 0, `init failed: ${init.stderr}`);

    // Init artefacts present.
    assert.ok(fs.existsSync(path.join(cwd, ".devteam", "config.yml")), ".devteam/config.yml not written");
    assert.ok(fs.existsSync(path.join(cwd, "pipeline", "gates")), "pipeline/gates not created");

    // `devteam next` should report run-stage requirements (full track is the default).
    const n = spawnSync("node", [BIN, "next", "--json"], { cwd, encoding: "utf8" });
    assert.equal(n.status, 0, `next exited ${n.status}: ${n.stderr}`);
    const out = JSON.parse(n.stdout);
    assert.equal(out.action, "run-stage");
    assert.equal(out.name, "requirements");
  });
});
