// Tests for ADR-017 (accepted 2026-08-05) / phase-32 item 32.6: stage DAG
// wave execution. Covers the curated `dependsOn` metadata and readFirst trim
// (core/pipeline/stages.js), the wave-aware readiness check (core/orchestrator.js
// nextWave), the wave-member scheduler key (core/scheduler.js), the driver's
// concurrent wave dispatch (core/driver.js), and realized-savings reporting
// (core/performance/critical-path.js).

const { describe, it, afterEach } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { REPO_ROOT, makeTargetProject, seedGate, cleanup } = require("./_helpers");
const { next, nextWave } = require(path.join(REPO_ROOT, "core", "orchestrator"));
const { loadConfig } = require(path.join(REPO_ROOT, "core", "config"));
const { getStage } = require(path.join(REPO_ROOT, "core", "pipeline", "stages"));
const { waveMemberKey } = require(path.join(REPO_ROOT, "core", "scheduler"));
const { run } = require(path.join(REPO_ROOT, "core", "driver"));
const { analyzeEvents, computeWaveSavings, renderMarkdown } = require(path.join(REPO_ROOT, "core", "performance", "critical-path"));

let _dirs = [];
function track(cwd) { _dirs.push(cwd); return cwd; }
afterEach(() => { _dirs.forEach(cleanup); _dirs = []; });

function readRunLog(cwd) {
  return fs.readFileSync(path.join(cwd, "pipeline", "run-log.jsonl"), "utf8")
    .trim()
    .split("\n")
    .filter(Boolean)
    .map((line) => JSON.parse(line));
}

// ─── 1. dependsOn metadata + readFirst trim (core/pipeline/stages.js) ──────

describe("32.6: dependsOn metadata is curated exactly per ADR-017", () => {
  it("red-team depends on build, not its declared-order predecessor pre-review", () => {
    assert.deepEqual(getStage("red-team").dependsOn, ["build"]);
  });

  it("red-team's readFirst no longer references pre-review.md or security-review.md", () => {
    const paths = getStage("red-team").readFirst.map((e) => (typeof e === "string" ? e : e.path));
    assert.ok(!paths.some((p) => p.includes("pre-review.md")));
    assert.ok(!paths.some((p) => p.includes("security-review.md")));
  });

  it("each QA-sweep stage (06b-06e) depends on qa", () => {
    for (const name of ["accessibility-audit", "observability-gate", "verification-beyond-tests", "performance-budget"]) {
      assert.deepEqual(getStage(name).dependsOn, ["qa"], `${name} must depend on qa`);
    }
  });

  it("stages outside the two authorized regions have no dependsOn field", () => {
    for (const name of ["requirements", "design", "build", "pre-review", "security-review", "peer-review", "qa", "sign-off", "deploy"]) {
      assert.ok(!("dependsOn" in getStage(name)), `${name} must not have dependsOn`);
    }
  });
});

// ─── 2. autonomy.max_parallel_stages config validation ─────────────────────

describe("32.6: autonomy.max_parallel_stages config", () => {
  it("defaults to 2 when unset", () => {
    const cwd = track(makeTargetProject());
    assert.equal(loadConfig(cwd).autonomy.max_parallel_stages, 2);
  });

  it("respects a valid override", () => {
    const cwd = track(makeTargetProject({
      config: "routing:\n  default_host: generic\npipeline:\n  default_track: full\nautonomy:\n  max_parallel_stages: 4\n",
    }));
    assert.equal(loadConfig(cwd).autonomy.max_parallel_stages, 4);
  });

  it("falls back to the default on a negative value", () => {
    const cwd = track(makeTargetProject({
      config: "routing:\n  default_host: generic\npipeline:\n  default_track: full\nautonomy:\n  max_parallel_stages: -1\n",
    }));
    assert.equal(loadConfig(cwd).autonomy.max_parallel_stages, 2);
  });

  it("falls back to the default on a non-integer value", () => {
    const cwd = track(makeTargetProject({
      config: "routing:\n  default_host: generic\npipeline:\n  default_track: full\nautonomy:\n  max_parallel_stages: \"lots\"\n",
    }));
    assert.equal(loadConfig(cwd).autonomy.max_parallel_stages, 2);
  });
});

// ─── 3. core/scheduler.js: wave-member key ─────────────────────────────────

describe("32.6: waveMemberKey", () => {
  it("composes host and stage so same-host wave members don't collide in one queue", () => {
    assert.equal(waveMemberKey({ host: "claude-code", stage: "stage-04a" }), "claude-code::stage-04a");
    assert.equal(waveMemberKey({ host: "claude-code", stage: "stage-04c" }), "claude-code::stage-04c");
    assert.notEqual(
      waveMemberKey({ host: "claude-code", stage: "stage-04a" }),
      waveMemberKey({ host: "claude-code", stage: "stage-04c" }),
    );
  });

  it("tolerates a missing host or stage", () => {
    assert.equal(waveMemberKey({}), "unknown::unknown");
  });
});

// ─── 4. core/orchestrator.js: nextWave readiness ────────────────────────────

function passGate(stage, extra = {}) {
  return {
    stage, status: "PASS", orchestrator: "devteam@test", track: "full",
    timestamp: new Date().toISOString(), blockers: [], warnings: [], ...extra,
  };
}

describe("32.6: nextWave() ready-set formation", () => {
  it("a size-1 ready set is byte-identical to next()", () => {
    const cwd = track(makeTargetProject({ config: "routing:\n  default_host: generic\npipeline:\n  default_track: full\n  right_sizing: false\nautonomy:\n  max_parallel_stages: 1\n" }));
    const config = loadConfig(cwd);
    const single = next({ cwd, config });
    const waved = nextWave({ cwd, config });
    assert.equal(waved.actions.length, 1);
    assert.deepEqual(waved.actions[0], single);
  });

  it("{pre-review, red-team} become ready together once build PASSes (ADR-017 region 1)", () => {
    const cwd = track(makeTargetProject({ config: "routing:\n  default_host: generic\npipeline:\n  default_track: full\n  right_sizing: false\n" }));
    for (const s of ["stage-01", "stage-02", "stage-03", "stage-03b", "stage-04"]) {
      seedGate(cwd, s, passGate(s));
    }
    const result = nextWave({ cwd, config: loadConfig(cwd) });
    const names = result.actions.map((a) => a.name).sort();
    assert.deepEqual(names, ["pre-review", "red-team"]);
    assert.ok(result.actions.every((a) => a.action === "run-stage"));
  });

  it("red-team is NOT ready if build hasn't PASSed, even though pre-review is blocked too", () => {
    const cwd = track(makeTargetProject({ config: "routing:\n  default_host: generic\npipeline:\n  default_track: full\n  right_sizing: false\n" }));
    for (const s of ["stage-01", "stage-02", "stage-03", "stage-03b"]) seedGate(cwd, s, passGate(s));
    // build (stage-04) not yet PASSed.
    const result = nextWave({ cwd, config: loadConfig(cwd) });
    assert.equal(result.actions.length, 1);
    assert.equal(result.actions[0].name, "build");
  });

  it("all four QA-sweep stages become ready together once qa PASSes, bounded by max_parallel_stages", () => {
    const cwd = track(makeTargetProject({ config: "routing:\n  default_host: generic\npipeline:\n  default_track: full\n  right_sizing: false\nautonomy:\n  max_parallel_stages: 4\n" }));
    for (const s of ["stage-01", "stage-02", "stage-03", "stage-03b", "stage-04", "stage-04a", "stage-04c", "stage-05", "stage-06"]) {
      seedGate(cwd, s, passGate(s));
    }
    const result = nextWave({ cwd, config: loadConfig(cwd) });
    const names = result.actions.map((a) => a.name).sort();
    assert.deepEqual(names, ["accessibility-audit", "observability-gate", "performance-budget", "verification-beyond-tests"]);
  });

  it("default max_parallel_stages (2) splits the four-stage QA region into a wave of two", () => {
    const cwd = track(makeTargetProject({ config: "routing:\n  default_host: generic\npipeline:\n  default_track: full\n  right_sizing: false\n" }));
    for (const s of ["stage-01", "stage-02", "stage-03", "stage-03b", "stage-04", "stage-04a", "stage-04c", "stage-05", "stage-06"]) {
      seedGate(cwd, s, passGate(s));
    }
    const result = nextWave({ cwd, config: loadConfig(cwd) });
    assert.equal(result.actions.length, 2);
    assert.deepEqual(result.actions.map((a) => a.name), ["accessibility-audit", "observability-gate"]);
  });

  it("a FAILed member does not remove its already-ready sibling from the ready set", () => {
    const cwd = track(makeTargetProject({ config: "routing:\n  default_host: generic\npipeline:\n  default_track: full\n  right_sizing: false\n" }));
    for (const s of ["stage-01", "stage-02", "stage-03", "stage-03b"]) seedGate(cwd, s, passGate(s));
    seedGate(cwd, "stage-04", passGate("stage-04"));
    seedGate(cwd, "stage-04a", { stage: "stage-04a", status: "PASS", orchestrator: "devteam@test", track: "full", timestamp: new Date().toISOString(), blockers: [], warnings: [], security_review_required: false, migration_safety_required: false });
    seedGate(cwd, "stage-04c", { stage: "stage-04c", status: "FAIL", orchestrator: "devteam@test", track: "full", timestamp: new Date().toISOString(), blockers: ["needs another pass"], warnings: [] });
    const result = nextWave({ cwd, config: loadConfig(cwd) });
    assert.equal(result.actions.length, 1);
    assert.equal(result.actions[0].name, "red-team");
    assert.equal(result.actions[0].action, "fix-and-retry");
  });
});

// ─── 5. core/driver.js: concurrent wave dispatch ───────────────────────────

function seedThroughBuild(cwd) {
  for (const s of ["stage-01", "stage-02", "stage-03", "stage-03b", "stage-04"]) {
    seedGate(cwd, s, passGate(s));
  }
}

describe("32.6: driver dispatches a real wave", () => {
  it("dispatches pre-review and red-team concurrently, writing both gates, in one iteration", async () => {
    const cwd = track(makeTargetProject({ config: "routing:\n  default_host: generic\npipeline:\n  default_track: full\n  right_sizing: false\n" }));
    seedThroughBuild(cwd);
    const dispatchedNames = [];
    await run({
      cwd,
      track: "full",
      budgetUsd: 10,
      maxIterations: 1,
      runStageHeadless: async (name) => {
        dispatchedNames.push(name);
        const stageDef = getStage(name);
        fs.writeFileSync(
          path.join(cwd, "pipeline", "gates", `${stageDef.stage}.json`),
          JSON.stringify(passGate(stageDef.stage), null, 2),
        );
        return [{ role: stageDef.roles[0], gatePath: `pipeline/gates/${stageDef.stage}.json`, exitCode: 0, durationMs: 5 }];
      },
    });

    assert.deepEqual(dispatchedNames.sort(), ["pre-review", "red-team"]);
    const preReview = JSON.parse(fs.readFileSync(path.join(cwd, "pipeline", "gates", "stage-04a.json"), "utf8"));
    const redTeam = JSON.parse(fs.readFileSync(path.join(cwd, "pipeline", "gates", "stage-04c.json"), "utf8"));
    assert.equal(preReview.status, "PASS");
    assert.equal(redTeam.status, "PASS");

    const state = JSON.parse(fs.readFileSync(path.join(cwd, "pipeline", "run-state.json"), "utf8"));
    assert.equal(state.iterations, 1, "one wave must consume exactly one iteration, not one per member");
  });

  it("stamps one shared, monotonic wave_id across both members' dispatch events", async () => {
    const cwd = track(makeTargetProject({ config: "routing:\n  default_host: generic\npipeline:\n  default_track: full\n  right_sizing: false\n" }));
    seedThroughBuild(cwd);
    await run({
      cwd,
      track: "full",
      budgetUsd: 10,
      maxIterations: 1,
      runStageHeadless: async (name) => {
        const stageDef = getStage(name);
        fs.writeFileSync(path.join(cwd, "pipeline", "gates", `${stageDef.stage}.json`), JSON.stringify(passGate(stageDef.stage), null, 2));
        return [{ role: stageDef.roles[0], gatePath: "x", exitCode: 0, durationMs: 5 }];
      },
    });
    const events = readRunLog(cwd);
    const dispatchStarted = events.filter((e) => e.outcome === "dispatch-started" && (e.name === "pre-review" || e.name === "red-team"));
    assert.equal(dispatchStarted.length, 2);
    assert.ok(dispatchStarted.every((e) => typeof e.wave_id === "number"));
    assert.equal(dispatchStarted[0].wave_id, dispatchStarted[1].wave_id, "both members must share one wave_id");
    const waveFormed = events.find((e) => e.outcome === "wave-formed");
    assert.ok(waveFormed, "a wave-formed event must be logged");
    assert.equal(waveFormed.wave_id, dispatchStarted[0].wave_id);
  });

  it("a wave of one carries no wave_id at all (byte-identical to pre-017 dispatch)", async () => {
    const cwd = track(makeTargetProject({ config: "routing:\n  default_host: generic\npipeline:\n  default_track: full\n  right_sizing: false\nautonomy:\n  max_parallel_stages: 1\n" }));
    seedThroughBuild(cwd);
    await run({
      cwd,
      track: "full",
      budgetUsd: 10,
      maxIterations: 1,
      runStageHeadless: async (name) => {
        const stageDef = getStage(name);
        fs.writeFileSync(path.join(cwd, "pipeline", "gates", `${stageDef.stage}.json`), JSON.stringify(passGate(stageDef.stage), null, 2));
        return [{ role: stageDef.roles[0], gatePath: "x", exitCode: 0, durationMs: 5 }];
      },
    });
    const events = readRunLog(cwd);
    const dispatchStarted = events.find((e) => e.outcome === "dispatch-started");
    assert.ok(dispatchStarted);
    assert.ok(!("wave_id" in dispatchStarted), "a size-1 wave must not stamp wave_id at all");
    assert.ok(!events.some((e) => e.outcome === "wave-formed"), "no wave-formed event on a size-1 wave");
  });

  it("one member FAILing does not corrupt or touch the passing sibling's gate", async () => {
    const cwd = track(makeTargetProject({ config: "routing:\n  default_host: generic\npipeline:\n  default_track: full\n  right_sizing: false\n" }));
    seedThroughBuild(cwd);
    await run({
      cwd,
      track: "full",
      budgetUsd: 10,
      maxIterations: 1,
      runStageHeadless: async (name) => {
        const stageDef = getStage(name);
        const gate = name === "red-team"
          ? { stage: stageDef.stage, status: "FAIL", orchestrator: "devteam@test", track: "full", timestamp: new Date().toISOString(), blockers: ["missing scenario coverage"], warnings: [] }
          : passGate(stageDef.stage);
        fs.writeFileSync(path.join(cwd, "pipeline", "gates", `${stageDef.stage}.json`), JSON.stringify(gate, null, 2));
        return [{ role: stageDef.roles[0], gatePath: "x", exitCode: 0, durationMs: 5 }];
      },
    });
    const preReview = JSON.parse(fs.readFileSync(path.join(cwd, "pipeline", "gates", "stage-04a.json"), "utf8"));
    const redTeam = JSON.parse(fs.readFileSync(path.join(cwd, "pipeline", "gates", "stage-04c.json"), "utf8"));
    assert.equal(preReview.status, "PASS", "pre-review's PASS must survive its sibling's FAIL");
    assert.equal(redTeam.status, "FAIL");
  });

  // Once a wave member FAILs, the very next wave-formation call routes it
  // through the pre-017 single-action fix-and-retry path unchanged
  // (deliberately not batched — see this session's DEVIATIONS note); already
  // proven at the orchestrator level by "a FAILed member does not remove its
  // already-ready sibling from the ready set" above. What that pre-existing
  // path then does with the FAIL (its recipe may clear other stages' gates
  // too) is unrelated to 32.6 and already covered by the existing
  // fix-and-retry test suite (tests/next.test.js et al.).

  it("verify-chain still passes on a track that dispatched a real wave", async () => {
    const cwd = track(makeTargetProject({ config: "routing:\n  default_host: generic\npipeline:\n  default_track: full\n  right_sizing: false\n" }));
    seedThroughBuild(cwd);
    await run({
      cwd,
      track: "full",
      budgetUsd: 10,
      maxIterations: 1,
      runStageHeadless: async (name) => {
        const stageDef = getStage(name);
        fs.writeFileSync(path.join(cwd, "pipeline", "gates", `${stageDef.stage}.json`), JSON.stringify(passGate(stageDef.stage), null, 2));
        return [{ role: stageDef.roles[0], gatePath: "x", exitCode: 0, durationMs: 5 }];
      },
    });
    const { stampAll, verifyChain } = require(path.join(REPO_ROOT, "core", "gates", "chain"));
    stampAll(path.join(cwd, "pipeline", "gates"), "full");
    const result = verifyChain(path.join(cwd, "pipeline", "gates"), "full");
    assert.equal(result.ok, true, `verify-chain must pass on a waved run: ${JSON.stringify(result.errors || result.mismatches || result)}`);
  });
});

// ─── 6. Legacy opts.next stub compatibility ────────────────────────────────

describe("32.6: legacy opts.next stub still drives the driver unchanged", () => {
  it("a bare opts.next single-action stub (no opts.nextWave) is wrapped into a size-1 wave", async () => {
    const cwd = track(makeTargetProject());
    const s = await run({ cwd, next: () => ({ action: "pipeline-complete", reason: "done" }) });
    assert.equal(s.completed, true);
  });
});

// ─── 7. core/performance/critical-path.js: realized wave savings ──────────

describe("32.6: critical-path realized wave savings", () => {
  function dispatchEvents({ name, stage, waveId, durationMs, iteration = 1 }) {
    return [
      { ts: "2026-08-05T00:00:00.000Z", outcome: "dispatch-started", iteration, stage, name, action: "run-stage", wave_id: waveId, queue_ms: 0 },
      { ts: new Date(new Date("2026-08-05T00:00:00.000Z").getTime() + durationMs).toISOString(), outcome: "dispatched", iteration, stage, name, action: "run-stage", wave_id: waveId, duration_ms: durationMs, workstreams: 1, timed_out: false, no_gate: false, queue_ms: 0 },
    ];
  }

  it("computes sum(member durations) - max(member durations) for a real wave", () => {
    const events = [
      ...dispatchEvents({ name: "pre-review", stage: "stage-04a", waveId: 1, durationMs: 1000 }),
      ...dispatchEvents({ name: "red-team", stage: "stage-04c", waveId: 1, durationMs: 1500 }),
    ];
    const report = analyzeEvents(events);
    assert.equal(report.waves.length, 1);
    assert.equal(report.waves[0].wave_id, 1);
    assert.equal(report.waves[0].sum_member_duration_ms, 2500);
    assert.equal(report.waves[0].wall_ms, 1500);
    assert.equal(report.waves[0].realized_savings_ms, 1000);
    assert.equal(report.wave_realized_savings_ms, 1000);
  });

  it("reports no waves for a run-log with no wave_id at all (pre-017 or size-1 dispatch)", () => {
    const events = dispatchEvents({ name: "build", stage: "stage-04", waveId: null, durationMs: 2000 });
    const report = analyzeEvents(events);
    assert.deepEqual(report.waves, []);
    assert.equal(report.wave_realized_savings_ms, 0);
  });

  it("groups multiple waves independently by wave_id", () => {
    const events = [
      ...dispatchEvents({ name: "pre-review", stage: "stage-04a", waveId: 1, durationMs: 1000 }),
      ...dispatchEvents({ name: "red-team", stage: "stage-04c", waveId: 1, durationMs: 1200 }),
      ...dispatchEvents({ name: "accessibility-audit", stage: "stage-06b", waveId: 2, durationMs: 800, iteration: 2 }),
      ...dispatchEvents({ name: "observability-gate", stage: "stage-06c", waveId: 2, durationMs: 600, iteration: 2 }),
    ];
    const report = analyzeEvents(events);
    assert.equal(report.waves.length, 2);
    // wave 1: sum 2200, wall 1200, savings 1000. wave 2: sum 1400, wall 800, savings 600.
    assert.equal(report.waves.find((w) => w.wave_id === 1).realized_savings_ms, 1000);
    assert.equal(report.waves.find((w) => w.wave_id === 2).realized_savings_ms, 600);
    assert.equal(report.wave_realized_savings_ms, 1600);
  });

  it("markdown report includes a Waves section naming the members", () => {
    const events = [
      ...dispatchEvents({ name: "pre-review", stage: "stage-04a", waveId: 1, durationMs: 1000 }),
      ...dispatchEvents({ name: "red-team", stage: "stage-04c", waveId: 1, durationMs: 1500 }),
    ];
    const report = analyzeEvents(events, { generatedAt: "2026-08-05T00:00:00.000Z" });
    const markdown = renderMarkdown(report);
    assert.ok(markdown.includes("## Waves (ADR-017)"));
    assert.ok(markdown.includes("pre-review"));
    assert.ok(markdown.includes("red-team"));
    assert.ok(markdown.includes("Wave realized parallel savings"));
  });

  it("computeWaveSavings is exported and usable directly", () => {
    const rows = [
      { wave_id: 5, stage: "stage-06b", name: "accessibility-audit", duration_ms: 400 },
      { wave_id: 5, stage: "stage-06c", name: "observability-gate", duration_ms: 900 },
    ];
    const { waves, waveRealizedSavingsMs } = computeWaveSavings(rows);
    assert.equal(waves.length, 1);
    assert.equal(waveRealizedSavingsMs, 400);
  });
});
