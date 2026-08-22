"use strict";

// Slice 4 of the P2-2 run() decomposition -- see core/driver-safety.js,
// core/driver-runend.js, and core/driver-stage-order.js for the earlier slices.
//
// run-state.json is the record a --resume reads to pick a run back up, so
// everything here answers one question: what does the run carry across
// invocations, and how is it reconciled when the state on disk predates a field
// this version expects?
//
// The token-accounting helpers moved with it deliberately. token_usage_baseline,
// token_run_ids, and token_dispatches_expected are run-state fields; the three
// functions exist to populate and read them. Splitting the fields from the
// arithmetic that maintains them is what lets the two drift.
//
// The returned `state` is the same mutable object run() carries through the
// loop -- it is initialized here, not owned here. `currentTokenUsage` closes
// over it, so it observes every later mutation (token_dispatches_expected is
// incremented per wave) rather than a snapshot taken at startup.

const fs = require("node:fs");
const path = require("node:path");
const { gatesDir: getGatesDir } = require("./paths");
const { readCorpus } = require("./corpus");
const { nonNegativeNumber } = require("./numbers");

function gatesDir(cwd, changeId) { return getGatesDir(cwd, changeId); }

// --budget-tokens is a runtime halt threshold, so it has to count what a
// dispatch actually consumed. On an agentic host the uncached input is a
// rounding error: a measured `loop` run reported 92 uncached input and 20,355
// output against 1,269,278 cache reads and 94,602 cache writes, so counting
// only in+out made the cap read ~67x low and never bind. That is the same
// shape as the stale pricing table making --budget-usd inert, and it is the
// same correction ceremony-preview's `observed-total` already took.
//
// `cached` stays separable from `input`/`output` so the summary can say what
// the number is made of — cache reads bill well below uncached input, and
// --budget-usd remains the control to budget money against.
function tokenEntryForGate(gate) {
  const observed = gate && gate._orchestrator_observed;
  const input = nonNegativeNumber(observed && observed.tokens_in);
  const output = nonNegativeNumber(observed && observed.tokens_out);
  const cached = (nonNegativeNumber(observed && observed.cached_tokens) || 0)
    + (nonNegativeNumber(observed && observed.cache_creation_tokens) || 0);
  if (input !== null && output !== null) {
    return { input, output, cached, basis: "observed" };
  }
  const estimatedInput = observed && observed.tokens_estimated === true
    ? nonNegativeNumber(observed.tokens_in_estimate)
    : null;
  if (estimatedInput !== null) {
    return { input: estimatedInput, output: 0, cached: 0, basis: "estimated" };
  }
  return null;
}

// Subscription-backed hosts such as Codex can report tokens without reporting
// billable USD. Sum orchestrator-owned usage as a provider-neutral budget floor.
// For multi-role stages, workstream gates are authoritative because the merged
// gate does not roll up `_orchestrator_observed`; never count both surfaces.
function tokenUsageDetail(cwd, changeId) {
  const mergedGateRe = /^(stage-\d{2}[a-z]?)\.json$/;
  const wsGateRe = /^(stage-\d{2}[a-z]?)\.[^.]+\.json$/;
  const groups = new Map();
  let files = [];
  try { files = fs.readdirSync(gatesDir(cwd, changeId)); } catch {
    return { total: 0, input: 0, output: 0, basis: null, observations: 0, missing: 0, coverage_complete: false };
  }

  for (const file of files) {
    const merged = file.match(mergedGateRe);
    const workstream = file.match(wsGateRe);
    const prefix = merged?.[1] || workstream?.[1];
    if (!prefix) continue;
    try {
      const gate = JSON.parse(fs.readFileSync(path.join(gatesDir(cwd, changeId), file), "utf8"));
      if (!groups.has(prefix)) groups.set(prefix, { merged: null, workstreams: [] });
      if (workstream) groups.get(prefix).workstreams.push(gate);
      else groups.get(prefix).merged = gate;
    } catch { /* unreadable gates contribute no trusted usage */ }
  }

  let input = 0;
  let output = 0;
  let cached = 0;
  let observations = 0;
  let missing = 0;
  let sawObserved = false;
  let sawEstimated = false;
  for (const group of groups.values()) {
    const selected = group.workstreams.length > 0
      ? group.workstreams
      : (group.merged ? [group.merged] : []);
    for (const gate of selected) {
      const entry = tokenEntryForGate(gate);
      if (!entry) {
        missing++;
        continue;
      }
      input += entry.input;
      output += entry.output;
      cached += entry.cached || 0;
      observations++;
      if (entry.basis === "observed") sawObserved = true;
      else sawEstimated = true;
    }
  }
  const basis = sawObserved && sawEstimated ? "mixed"
    : sawObserved ? "observed"
      : sawEstimated ? "estimated"
        : null;
  return {
    total: input + output + cached,
    input,
    output,
    cached,
    basis,
    observations,
    missing,
    coverage_complete: observations > 0 && missing === 0,
  };
}

function combineTokenUsage(...details) {
  let input = 0;
  let output = 0;
  let cached = 0;
  let observations = 0;
  let missing = 0;
  let sawObserved = false;
  let sawEstimated = false;
  for (const detail of details.filter(Boolean)) {
    input += nonNegativeNumber(detail.input) || 0;
    output += nonNegativeNumber(detail.output) || 0;
    cached += nonNegativeNumber(detail.cached) || 0;
    observations += nonNegativeNumber(detail.observations) || 0;
    missing += nonNegativeNumber(detail.missing) || 0;
    if (detail.basis === "observed" || detail.basis === "mixed") sawObserved = true;
    if (detail.basis === "estimated" || detail.basis === "mixed") sawEstimated = true;
  }
  const basis = sawObserved && sawEstimated ? "mixed"
    : sawObserved ? "observed"
      : sawEstimated ? "estimated"
        : null;
  return {
    total: input + output + cached,
    input,
    output,
    cached,
    basis,
    observations,
    missing,
    coverage_complete: observations > 0 && missing === 0,
  };
}

// The run corpus is append-only, so unlike live gates it retains every retry.
// Only orchestrator-observed or explicitly estimated rows are budget-eligible;
// older/model-asserted rows remain useful analytics but count as missing here.
function tokenUsageForRunIds(cwd, runIds, expectedDispatches = 0) {
  const selected = new Set((runIds || []).filter(Boolean));
  let input = 0;
  let output = 0;
  let observations = 0;
  let missing = 0;
  let sawObserved = false;
  let sawEstimated = false;
  let matchedDispatches = 0;
  for (const row of readCorpus(cwd)) {
    if (!selected.has(row.run_id)) continue;
    matchedDispatches++;
    if (row.token_basis !== "observed" && row.token_basis !== "estimated") {
      missing++;
      continue;
    }
    const rowInput = nonNegativeNumber(row.tokens_in);
    const rowOutput = nonNegativeNumber(row.tokens_out);
    if (rowInput === null || rowOutput === null) {
      missing++;
      continue;
    }
    input += rowInput;
    output += rowOutput;
    observations++;
    if (row.token_basis === "observed") sawObserved = true;
    else sawEstimated = true;
  }
  missing += Math.max(0, expectedDispatches - matchedDispatches);
  return combineTokenUsage({
    input,
    output,
    observations,
    missing,
    basis: sawObserved && sawEstimated ? "mixed"
      : sawObserved ? "observed"
        : sawEstimated ? "estimated"
          : null,
  });
}

// initRunState -- build (or reconcile) the run state for this invocation.
//
// `nowTs` is passed in rather than read from the clock here so a caller can
// make the result deterministic; run() passes nowIso().
//
// Every field below is written defensively against a resumed state that
// predates it. A --resume must not crash on a run-state.json written by an
// older Stagecraft, and must not silently reset a counter it does not
// recognize -- either would corrupt an in-progress run's accounting.
function initRunState({
  resumedState = null,
  nowTs,
  cwd,
  changeId,
  effectiveTrack,
  trackSource,
  trackConfidence,
  intent,
  safetyPolicy,
  opts = {},
}) {
  const state = resumedState || {
    track: Array.isArray(effectiveTrack) ? effectiveTrack.join(",") : effectiveTrack,
    resolved_track: effectiveTrack,
    track_source: trackSource,
    track_confidence: trackConfidence,
    intent,                                      // ADR-009 §Decision.7
    ...(opts.repair ? { repair: opts.repair } : {}), // symptom string persisted for correlation
    iterations: 0,
    retries: {},
    started_at: nowTs,
    // Phase 12.2: commit-cursor fields for `devteam commit`.
    stages_advanced: [],              // stage IDs advanced in pipeline order
    last_committed_stage_index: null, // index of last committed stage in stages_advanced
  };
  // Correlation id (ADR-009 §Decision.7): on resume, record the prior run's identity
  // so a re-classified re-run is linkable to its predecessor in the run log.
  if (opts.resume && state.started_at && state.started_at !== nowTs) {
    state.prior_run_id = state.started_at;
    state.started_at = nowTs;
  }
  // 42.5: run_id is the invocation (state.started_at), and every --resume mints
  // a new one. Evidence counted one "run" per run-start event, so a single
  // logical feature change driven through two resumes was three runs in the
  // denominator — which is what the 2026-08-19 Phase 41 review hit when it
  // recorded 10 run records for far fewer real changes.
  //
  // The lineage root is the stable identity: set once, then carried forward by
  // run-state.json across every resume. Local only — run-log.jsonl is
  // gitignored operational state, and this value never enters an exported
  // bundle. The evidence layer uses it to *group*, and emits a count.
  state.logical_run_id = state.logical_run_id || state.started_at;
  // PR-B counters (resilient to a resumed state that predates them).
  state.fixRetries = state.fixRetries || {};      // code-defect re-dispatches per stage
  state.safety_policy = safetyPolicy;
  state.resolved_track = state.resolved_track || effectiveTrack;
  state.track_source = state.track_source || trackSource;
  state.track_confidence = state.track_confidence || trackConfidence;
  state.autoRule = state.autoRule || {};          // auto-rule attempts per stage
  state.transient = state.transient || {};        // no-gate transient retries per stage
  state.srcFingerprints = state.srcFingerprints || {}; // content hashes for no-source-change detection
  state.targetedFix = state.targetedFix || null;  // one-shot fix-and-retry dispatch hint
  state.skipped_stages = Array.isArray(state.skipped_stages) ? state.skipped_stages : [];
  state.active_workstreams = {};
  state.last_workstream = state.last_workstream || null;
  // ADR-017 (32.6): monotonic per-run counter, persisted like the other PR-B
  // counters above so it survives `devteam run --resume` instead of
  // restarting at 1 and colliding with wave_ids already in run-log.jsonl.
  state.wave_id_counter = Number.isInteger(state.wave_id_counter) ? state.wave_id_counter : 0;
  // Token budgets are cumulative across retries and resumes. Live gates only
  // retain the latest attempt, so freeze their trusted usage as the baseline
  // and add every dispatch from the append-only corpus for this run lineage.
  if (!state.token_usage_baseline || typeof state.token_usage_baseline !== "object") {
    state.token_usage_baseline = tokenUsageDetail(cwd, changeId);
  }
  if (!Array.isArray(state.token_run_ids)) state.token_run_ids = [];
  if (!state.token_run_ids.includes(state.started_at)) state.token_run_ids.push(state.started_at);
  state.token_dispatches_expected = Number.isInteger(state.token_dispatches_expected)
    ? state.token_dispatches_expected
    : 0;
  // Phase 12.2: commit-cursor fields (resilient to resumed pre-12.2 states).
  if (!Array.isArray(state.stages_advanced)) state.stages_advanced = [];
  if (!("last_committed_stage_index" in state)) state.last_committed_stage_index = null;

  const currentTokenUsage = () => combineTokenUsage(
    state.token_usage_baseline,
    tokenUsageForRunIds(cwd, state.token_run_ids, state.token_dispatches_expected),
  );

  return { state, currentTokenUsage };
}

module.exports = {
  initRunState,
  tokenUsageDetail,
  combineTokenUsage,
  tokenUsageForRunIds,
};
