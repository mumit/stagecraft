// Unit coverage for the slice-4 extraction (core/driver-run-state.js).
//
// The prologue characterization suite proves run()'s observable output is
// unchanged. These tests cover what that suite cannot reach from outside: the
// reconciliation branches a --resume takes against a run-state.json written by
// an older Stagecraft, and the closure property currentTokenUsage depends on.

const { describe, it } = require("node:test");
const assert = require("node:assert/strict");
const os = require("node:os");
const fs = require("node:fs");
const path = require("node:path");
const { initRunState, combineTokenUsage } = require("../core/driver-run-state");

const TS = "2026-08-21T00:00:00.000Z";
const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "runstate-"));

function init(over = {}) {
  return initRunState({
    nowTs: TS, cwd, changeId: "c1",
    effectiveTrack: "loop", trackSource: "human", trackConfidence: null,
    intent: "feature", safetyPolicy: { schema: "s", budget_usd: null, budget_tokens: null },
    opts: {}, ...over,
  });
}

describe("initRunState: a fresh run", () => {
  it("seeds the counters a resumed run depends on", () => {
    const { state } = init();
    assert.equal(state.iterations, 0);
    assert.equal(state.started_at, TS);
    assert.equal(state.logical_run_id, TS);
    assert.equal(state.wave_id_counter, 0);
    assert.equal(state.last_committed_stage_index, null);
    assert.deepEqual(state.retries, {});
    assert.deepEqual(state.fixRetries, {});
    assert.deepEqual(state.stages_advanced, []);
    assert.deepEqual(state.token_run_ids, [TS]);
  });

  it("takes the timestamp from the caller, not the clock", () => {
    // Determinism is the point of passing nowTs in.
    assert.equal(init({ nowTs: "2020-01-01T00:00:00.000Z" }).state.started_at,
      "2020-01-01T00:00:00.000Z");
  });

  it("records the track, its provenance, and the intent", () => {
    const { state } = init({ effectiveTrack: "full", trackSource: "inferred", intent: "repair" });
    assert.equal(state.track, "full");
    assert.equal(state.resolved_track, "full");
    assert.equal(state.track_source, "inferred");
    assert.equal(state.intent, "repair");
  });

  it("joins a custom track for the flat label but keeps the array resolved", () => {
    const { state } = init({ effectiveTrack: ["build", "qa"] });
    assert.equal(state.track, "build,qa");
    assert.deepEqual(state.resolved_track, ["build", "qa"]);
  });

  it("persists the repair symptom for correlation, and omits it otherwise", () => {
    assert.equal(init({ opts: { repair: "login throws" } }).state.repair, "login throws");
    assert.equal("repair" in init().state, false);
  });
});

describe("initRunState: reconciling a resumed state", () => {
  it("mints a new run id and links back to the prior one", () => {
    const resumedState = { started_at: "2026-08-20T00:00:00.000Z", iterations: 4 };
    const { state } = init({ resumedState, opts: { resume: true } });
    assert.equal(state.prior_run_id, "2026-08-20T00:00:00.000Z");
    assert.equal(state.started_at, TS);
    assert.equal(state.iterations, 4, "the resumed counters survive");
  });

  it("carries the logical run id forward instead of minting a new lineage", () => {
    // 42.5: this is what stops one logical change counting as three runs.
    const resumedState = { started_at: "2026-08-20T00:00:00.000Z", logical_run_id: "ROOT" };
    assert.equal(init({ resumedState, opts: { resume: true } }).state.logical_run_id, "ROOT");
  });

  it("accumulates a run id per resume without duplicating one", () => {
    const resumedState = { started_at: "A", token_run_ids: ["A"] };
    const { state } = init({ resumedState, opts: { resume: true } });
    assert.deepEqual(state.token_run_ids, ["A", TS]);
    const again = initRunState({
      resumedState: state, nowTs: TS, cwd, changeId: "c1", effectiveTrack: "loop",
      trackSource: "human", trackConfidence: null, intent: "feature",
      safetyPolicy: {}, opts: { resume: true },
    });
    assert.deepEqual(again.state.token_run_ids, ["A", TS], "TS is already present");
  });

  it("backfills counters a state written by an older version never had", () => {
    // A --resume must not crash on an old run-state.json, and must not reset a
    // counter it does recognize.
    const { state } = init({
      resumedState: { started_at: TS, wave_id_counter: 9, token_dispatches_expected: 3 },
      opts: { resume: true },
    });
    assert.equal(state.wave_id_counter, 9, "a recognized counter is preserved");
    assert.equal(state.token_dispatches_expected, 3);
    assert.deepEqual(state.skipped_stages, []);
    assert.deepEqual(state.autoRule, {});
    assert.deepEqual(state.transient, {});
    assert.equal(state.targetedFix, null);
    assert.deepEqual(state.stages_advanced, []);
  });

  it("does not overwrite a resumed track with this invocation's arguments", () => {
    const { state } = init({
      resumedState: { started_at: TS, resolved_track: "full", track_source: "human" },
      effectiveTrack: "loop", trackSource: "config", opts: { resume: true },
    });
    assert.equal(state.resolved_track, "full");
    assert.equal(state.track_source, "human");
  });

  it("always adopts this invocation's safety policy", () => {
    // Caps are per-invocation; a resumed run must honor the caps just passed.
    const policy = { schema: "s", budget_usd: 5, budget_tokens: null };
    const { state } = init({
      resumedState: { started_at: TS, safety_policy: { budget_usd: 999 } },
      safetyPolicy: policy, opts: { resume: true },
    });
    assert.deepEqual(state.safety_policy, policy);
  });

  it("resets active_workstreams so a resume does not inherit a dead wave", () => {
    const { state } = init({
      resumedState: { started_at: TS, active_workstreams: { "stage-04": ["backend"] } },
      opts: { resume: true },
    });
    assert.deepEqual(state.active_workstreams, {});
  });
});

describe("initRunState: currentTokenUsage", () => {
  it("reads through to later mutations rather than a startup snapshot", () => {
    // token_dispatches_expected is incremented per wave, 1,500 lines away. If
    // this closed over a copy, every budget check after the first wave would
    // read a stale expectation and under-report missing coverage.
    const { state, currentTokenUsage } = init();
    assert.equal(currentTokenUsage().missing, 0);
    state.token_dispatches_expected += 2;
    assert.equal(currentTokenUsage().missing, 2, "the closure sees the increment");
  });

  it("reports no coverage rather than zero usage for an empty run", () => {
    const { currentTokenUsage } = init();
    const usage = currentTokenUsage();
    assert.equal(usage.total, 0);
    assert.equal(usage.basis, null, "null basis means unmeasured, not free");
    assert.equal(usage.coverage_complete, false);
  });
});

describe("combineTokenUsage", () => {
  it("sums parts and reports a mixed basis when sources disagree", () => {
    const r = combineTokenUsage(
      { input: 10, output: 5, observations: 1, missing: 0, basis: "observed" },
      { input: 1, output: 2, observations: 1, missing: 1, basis: "estimated" },
    );
    assert.equal(r.input, 11);
    assert.equal(r.output, 7);
    assert.equal(r.total, 18);
    assert.equal(r.basis, "mixed");
    assert.equal(r.coverage_complete, false, "a missing row is incomplete coverage");
  });

  it("ignores absent parts and untrustworthy figures", () => {
    const r = combineTokenUsage(null, undefined, { input: -1, output: "5", basis: "observed" });
    assert.equal(r.input, 0);
    assert.equal(r.output, 0);
  });

  it("is complete only when something was observed and nothing was missing", () => {
    assert.equal(combineTokenUsage({ observations: 2, missing: 0, basis: "observed" })
      .coverage_complete, true);
    assert.equal(combineTokenUsage({ observations: 0, missing: 0, basis: null })
      .coverage_complete, false);
  });
});
