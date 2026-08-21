// Characterization of `run()`'s prologue — the ~300 lines between entry and the
// first dispatch that pin config, resolve the track, derive the changeId, wire
// injectable dependencies, build the safety policy, and materialize the run
// plan and run state.
//
// These tests exist to make the remaining F5 decomposition slices provably
// safe. They assert *what the prologue produces*, not how, so an extraction
// that preserves behavior passes unchanged and one that does not fails loudly.
//
// `--plan-only` is the harness: it runs the entire prologue and halts before
// the first dispatch, so the observable output is exactly the prologue's.
//
// plan_fingerprint is the strongest assertion available. It is deterministic
// for identical inputs and path-independent (verified across two temp
// directories), and it covers the resolved track, stage dispositions, routing
// candidates, execution trust, and the safety policy at once. Any prologue
// change that alters what a run would execute moves it.

const { describe, it, afterEach } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { makeTargetProject, cleanup, runCLI } = require("./_helpers");

let _dirs = [];
function track(cwd) { _dirs.push(cwd); return cwd; }
afterEach(() => { _dirs.forEach(cleanup); _dirs = []; });

const CONFIG = "routing:\n  default_host: generic\npipeline:\n  default_track: loop\n";

function planOnly(args = [], config = CONFIG) {
  const cwd = track(makeTargetProject({ config }));
  const r = runCLI(["run", "--feature", "add a subtract helper", "--plan-only", ...args], { cwd });
  const read = (rel) => {
    try { return JSON.parse(fs.readFileSync(path.join(cwd, "pipeline", rel), "utf8")); } catch { return null; }
  };
  const events = (() => {
    try {
      return fs.readFileSync(path.join(cwd, "pipeline", "run-log.jsonl"), "utf8")
        .trim().split("\n").filter(Boolean).map((l) => JSON.parse(l));
    } catch { return []; }
  })();
  return { cwd, result: r, plan: read("run-plan.json"), state: read("run-state.json"), events };
}

describe("run prologue: it halts having produced the execution contract", () => {
  it("writes a plan, a state, and a run-start event, and dispatches nothing", () => {
    const { result, plan, state, events } = planOnly();
    // Exit 0: --plan-only is a boundary the operator configured, which is the
    // documented rule for a clean stop in core/cli/commands/run.js.
    assert.equal(result.status, 0);
    assert.equal(events.filter((e) => e.outcome === "plan-only-halt").length, 1);
    assert.ok(plan, "run-plan.json must exist");
    assert.ok(state, "run-state.json must exist");
    assert.equal(events.filter((e) => e.outcome === "run-start").length, 1);
    assert.equal(events.some((e) => e.outcome === "dispatch-observation"), false,
      "plan-only must not dispatch");
  });
});

describe("run prologue: track resolution", () => {
  it("assesses inline rather than taking the configured default", () => {
    // ADR-016: given --feature and no --track, the prologue assesses instead of
    // reading pipeline.default_track. It lands on loop here, which happens to
    // match the configured default -- but by inference, at low confidence.
    const { plan } = planOnly();
    assert.equal(plan.track, "loop");
    assert.equal(plan.track_source, "inferred");
    assert.equal(plan.track_confidence, "low");
    assert.ok(plan.assess_inline.reasons.length > 0);
  });

  it("prefers an explicit --track and marks it human", () => {
    const { plan } = planOnly(["--track", "full"]);
    assert.equal(plan.track, "full");
    assert.equal(plan.track_source, "human");
  });

  it("resolves custom_stages as a custom track", () => {
    const { plan } = planOnly([], "routing:\n  default_host: generic\npipeline:\n  custom_stages: [\"build\", \"qa\"]\n");
    assert.equal(plan.track, "custom");
    assert.equal(plan.track_source, "config");
    assert.deepEqual(plan.custom_track, ["build", "qa"]); // the list, not a flag
    assert.deepEqual(plan.stages.map((s) => s.name), ["build", "qa"]);
  });

  function repairPlan(symptom) {
    const cwd = track(makeTargetProject({ config: CONFIG }));
    runCLI(["run", "--repair", symptom, "--plan-only"], { cwd });
    return JSON.parse(fs.readFileSync(path.join(cwd, "pipeline", "run-plan.json"), "utf8"));
  }

  it("--repair selects hotfix depth and records repair intent", () => {
    const plan = repairPlan("typo in the footer copy");
    assert.equal(plan.intent, "repair");
    assert.equal(plan.track, "hotfix");
    assert.equal(plan.track_source, "human");
  });

  it("--repair upgrades to full when the symptom hits the stoplist", () => {
    // ADR-009 Decision.1: hotfix bypasses STOPLIST_TRACKS by design, so an
    // auth/payments/migration symptom is re-checked and forced to full.
    const plan = repairPlan("login throws on empty password");
    assert.equal(plan.intent, "repair");
    assert.equal(plan.track, "full");
  });
});

describe("run prologue: stage dispositions", () => {
  it("counts included, skipped, and conditional stages for the resolved track", () => {
    const { plan } = planOnly(["--track", "full"]);
    assert.equal(plan.stages_total, plan.stages.length);
    assert.ok(plan.stages_included > 0);
    assert.equal(typeof plan.conditional_stages, "number"); // a count, not a list
    assert.equal(plan.stages_included + plan.stages_skipped_by_config
      + plan.stages_skipped_by_right_sizing, plan.stages_total);
  });

  it("records the --until boundary and what it puts out of reach", () => {
    const withUntil = planOnly(["--track", "full", "--until", "build", "--budget-usd", "5"]).plan;
    const without = planOnly(["--track", "full", "--budget-usd", "5"]).plan;
    assert.equal(withUntil.until, "build");
    assert.equal(without.until, null);
    assert.equal(without.stages_after_until, 0);
    assert.ok(withUntil.stages_after_until > 0,
      "the plan must say how many included stages the boundary puts out of reach");
    // stages_included keeps its meaning: what the track executes, boundary or
    // not. The boundary is reported alongside it, not folded into it.
    assert.equal(withUntil.stages_included, without.stages_included);
  });

  it("keeps --until out of both fingerprints so a resume is not drift", () => {
    // "run --until build, review, run --resume" must not report policy drift.
    const withUntil = planOnly(["--track", "full", "--until", "build", "--budget-usd", "5"]).plan;
    const without = planOnly(["--track", "full", "--budget-usd", "5"]).plan;
    assert.equal(withUntil.plan_fingerprint, without.plan_fingerprint);
    assert.equal(withUntil.execution_fingerprint, without.execution_fingerprint);
  });

  it("rejects an --until that names no stage in the track", () => {
    // untilIndex < 0 reads as "no boundary" in dispatch, so silently accepting
    // this ran the whole track -- deploy included.
    const { result } = planOnly(["--track", "full", "--until", "nonsense-stage"]);
    assert.equal(result.status, 1);
    assert.match(result.stderr, /--until nonsense-stage is not a stage in the 'full' track/);
    assert.match(result.stderr, /Stages, in order: /);
  });

  it("rejects an --until naming a stage from a different track", () => {
    const { result } = planOnly(["--track", "loop", "--until", "red-team"]);
    assert.equal(result.status, 1);
    assert.match(result.stderr, /not a stage in the 'loop' track/);
  });

  it("records configured skips", () => {
    const { plan } = planOnly(["--track", "full"],
      "routing:\n  default_host: generic\npipeline:\n  default_track: full\n  skip_stages: [red-team]\n");
    assert.ok(plan.skipped_stage_names.includes("red-team"));
    assert.ok(plan.stages_skipped_by_config >= 1);
  });
});

describe("run prologue: safety policy", () => {
  it("carries explicit caps into the plan and the state", () => {
    const { plan, state } = planOnly(["--budget-usd", "5", "--budget-tokens", "500000"]);
    assert.equal(plan.safety_policy.budget_usd, 5);
    assert.equal(plan.safety_policy.budget_tokens, 500000);
    assert.equal(state.safety_policy.budget_usd, 5);
  });

  it("records an uncapped run as explicitly uncapped, and warns", () => {
    const { plan, result } = planOnly();
    assert.equal(plan.safety_policy.budget_usd, null);
    assert.equal(plan.safety_policy.budget_tokens, null);
    assert.match(result.stderr, /no usage cap set/);
  });

  it("does not warn when either cap is set", () => {
    assert.doesNotMatch(planOnly(["--budget-usd", "5"]).result.stderr, /no usage cap set/);
    assert.doesNotMatch(planOnly(["--budget-tokens", "1000"]).result.stderr, /no usage cap set/);
  });
});

describe("run prologue: run state initialization", () => {
  it("seeds the counters a resumed run depends on", () => {
    const { state } = planOnly(["--budget-usd", "5"]);
    assert.equal(state.iterations, 0);
    assert.deepEqual(state.retries, {});
    assert.deepEqual(state.fixRetries, {});
    assert.deepEqual(state.stages_advanced, []);
    assert.equal(state.last_committed_stage_index, null);
    assert.equal(state.wave_id_counter, 0);
    assert.ok(Array.isArray(state.token_run_ids) && state.token_run_ids.length === 1);
  });

  it("sets a logical run id equal to the first invocation's start", () => {
    const { state } = planOnly(["--budget-usd", "5"]);
    assert.equal(state.logical_run_id, state.started_at);
  });

  it("agrees with the plan on track and intent", () => {
    const { plan, state } = planOnly(["--track", "quick", "--budget-usd", "5"]);
    assert.equal(state.track, plan.track);
    assert.equal(state.resolved_track, plan.track);
    assert.equal(state.intent, plan.intent);
    assert.equal(state.track_source, plan.track_source);
  });
});

describe("run prologue: the plan fingerprint is the contract", () => {
  // Deterministic and path-independent, so it can be pinned by value. It covers
  // track, stage dispositions, routing candidates, execution trust, and the
  // safety policy together — which makes it the single most sensitive
  // regression detector for the decomposition work still to come.
  it("is stable across identical runs in different directories", () => {
    const a = planOnly(["--budget-usd", "5"]).plan;
    const b = planOnly(["--budget-usd", "5"]).plan;
    assert.equal(a.plan_fingerprint, b.plan_fingerprint);
    assert.equal(a.execution_fingerprint, b.execution_fingerprint);
  });

  it("moves when the safety policy changes, and not the execution fingerprint", () => {
    // Caps belong to the plan, not to the execution identity — resume checks
    // depend on that separation.
    const a = planOnly(["--budget-usd", "5"]).plan;
    const b = planOnly(["--budget-usd", "9"]).plan;
    assert.notEqual(a.plan_fingerprint, b.plan_fingerprint);
    assert.equal(a.execution_fingerprint, b.execution_fingerprint);
  });

  it("moves when the track changes", () => {
    const a = planOnly(["--track", "loop", "--budget-usd", "5"]).plan;
    const b = planOnly(["--track", "quick", "--budget-usd", "5"]).plan;
    assert.notEqual(a.plan_fingerprint, b.plan_fingerprint);
    assert.notEqual(a.execution_fingerprint, b.execution_fingerprint);
  });
});

describe("run prologue: --plan-only leaves a resumable state", () => {
  it("produces a plan a resume continues unchanged", () => {
    // The reason --plan-only is a trustworthy preview: it stops after the same
    // build-and-persist path a real run uses, so what you reviewed is what runs.
    const cwd = track(makeTargetProject({ config: CONFIG }));
    runCLI(["run", "--feature", "add a subtract helper", "--budget-usd", "5", "--plan-only"], { cwd });
    const before = fs.readFileSync(path.join(cwd, "pipeline", "run-plan.json"), "utf8");
    runCLI(["run", "--resume", "--plan-only"], { cwd });
    const after = fs.readFileSync(path.join(cwd, "pipeline", "run-plan.json"), "utf8");
    assert.equal(JSON.parse(before).plan_fingerprint, JSON.parse(after).plan_fingerprint);
  });
});
