// Ceremony cost preview (plans/phase-29-scale-adaptive-ceremony.md item 29.3).
//
// Answers "what will running this track cost?" BEFORE any dispatch happens,
// so the operator can weigh ceremony against stakes (§Why in the phase-29
// plan: "the gates are the product; the ceremony is the price").
//
// Two estimate sources, always labelled via `estimate_basis` (house honesty
// rules — every number here is an estimate, never presented as a fact):
//
//   "empirical" — .devteam/corpus/dispatches.jsonl (28.5) has >= MIN_EMPIRICAL_RUNS
//                 completed runs of this exact track. Use median observed
//                 tokens/cost across those runs — real history beats a model.
//   "static"    — otherwise. Tokens come from the same per-dispatch framework
//                 overhead numbers scripts/prompt-budget.js generates into
//                 docs/reference/prompt-budget.md (read via its
//                 computeStageStats() machine source, not the rendered doc),
//                 plus the byte size of any pipeline/ artifacts already on
//                 disk that the stage's readFirst would load (prompt-budget.js
//                 itself excludes these as "project-dependent, unknown at
//                 analysis time" — that's exactly the gap sampled here).
//
// Cost requires a model. Explicit routing model pins are authoritative for a
// future dispatch; when a route does not pin one, the static path falls back
// to the most recently observed model for that (role, host) pair. When neither
// source resolves to a priced model, cost is never invented.
//
// Dispatch count and tokens are both reported as {min, max} ranges: `min`
// excludes stages that are conditional at runtime (stage-04b security-review,
// stage-04d migration-safety — see core/pipeline/stages.js conditionalOn),
// `max` includes them since the static track shape lists them unconditionally.

"use strict";

const fs = require("node:fs");
const path = require("node:path");

const { STAGES, orderedStageNamesForTrack, rolesForStage } = require("./pipeline/stages");
const { resolveRoute } = require("./config");
const { readCorpus } = require("./corpus");
const { pricingFor } = require("./pricing");
const { computeStageStats } = require("../scripts/prompt-budget");

const MIN_EMPIRICAL_RUNS = 5;
const PRIMARY_ASSURANCE_TRACKS = ["loop", "quick", "full"];

function tokEst(bytes) {
  return Math.ceil(bytes / 4);
}

function median(values) {
  if (values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0 ? (sorted[mid - 1] + sorted[mid]) / 2 : sorted[mid];
}

// readFirst entries under pipeline/ are excluded from prompt-budget.js's
// framework-byte total (they're project/runtime-dependent). Sample their
// real on-disk size here, when present, as the estimate's "high" bound.
function pipelineReadFirstPaths(stageDef) {
  const out = [];
  for (const item of stageDef.readFirst || []) {
    if (typeof item === "string" && item.startsWith("pipeline/")) out.push(item);
    else if (item && typeof item === "object" && typeof item.path === "string" && item.path.startsWith("pipeline/")) {
      out.push(item.path);
    }
  }
  return out;
}

function sampleArtifactBytes(cwd, stageDef) {
  let total = 0;
  for (const rel of pipelineReadFirstPaths(stageDef)) {
    try {
      total += fs.statSync(path.join(cwd, rel)).size;
    } catch { /* artifact doesn't exist yet — contributes 0, not a fabricated guess */ }
  }
  return total;
}

// Most recent model_observed for a (role, host) pair, or null when the
// corpus has no such observation. This is a lookup against ANY history for
// the pair — distinct from the >= MIN_EMPIRICAL_RUNS same-track threshold
// that promotes the whole estimate to estimate_basis: "empirical".
function mostRecentModelObserved(records, role, host) {
  let best = null;
  for (const r of records) {
    if (r.role === role && r.host === host && r.model_observed) {
      if (!best || String(r.ts || "") > String(best.ts || "")) best = r;
    }
  }
  return best ? best.model_observed : null;
}

function resolveDispatchModel(records, config, stage, role, host) {
  const route = resolveRoute(config, stage, role);
  if (route.hostName === host && route.model) {
    return { model: route.model, source: "configured" };
  }
  const observed = mostRecentModelObserved(records, role, host);
  return observed
    ? { model: observed, source: "observed" }
    : { model: null, source: null };
}

function dispatchBytesForRole(stageStats, stageDef, role) {
  const dispatchRole = stageDef.subagent || role;
  const found = stageStats.dispatches.find((d) => d.role === dispatchRole);
  return found ? found.dispatchBytes : stageStats.frameworkBytes;
}

// Static per-track estimate. `track` may be a named track or (G6) a custom
// stage-name array; `stageNames`, when given, overrides the stage list
// entirely (e.g. driver.js passing an already right-sized `included` list so
// the pre-flight preview matches what will actually run more closely than
// the nominal track shape would).
function computeStaticEstimate(cwd, track, config, opts = {}) {
  const stageNames = opts.stageNames || orderedStageNamesForTrack(track);
  const stageStatsByName = new Map(computeStageStats().map((s) => [s.stageName, s]));
  const corpusRecords = readCorpus(cwd);
  const fanoutHosts = Array.isArray(config && config.routing && config.routing.review_fanout)
    ? config.routing.review_fanout
    : [];

  let dispatchMin = 0;
  let dispatchMax = 0;
  let tokensLow = 0;
  let tokensHigh = 0;
  let costLow = 0;
  let costHigh = 0;
  let allModelsKnown = true;
  const unresolved = new Set();
  const modelSources = { configured: 0, observed: 0, unresolved: 0 };
  const conditionalStages = [];
  const perStage = [];

  for (const stageName of stageNames) {
    const stageDef = STAGES[stageName];
    if (!stageDef || !Array.isArray(stageDef.roles) || stageDef.roles.length === 0) continue; // mechanical, no dispatch
    const stats = stageStatsByName.get(stageName);
    if (!stats) continue;

    const isConditional = !!stageDef.conditionalOn;
    if (isConditional) conditionalStages.push(stageDef.stage);

    const areas = rolesForStage(stageDef, track, config);
    const isPeerReviewFanout = stageDef.stage === "stage-05" && fanoutHosts.length > 0;
    const artifactBytes = sampleArtifactBytes(cwd, stageDef);
    const artifactTokens = tokEst(artifactBytes);

    let stageDispatches = 0;
    let stageTokensLow = 0;
    let stageTokensHigh = 0;
    const perArea = [];

    for (const area of areas) {
      const baseTokens = tokEst(dispatchBytesForRole(stats, stageDef, area));
      const route = resolveRoute(config, stageDef.stage, area);
      const hosts = isPeerReviewFanout ? fanoutHosts : [route.hostName];

      for (const host of hosts) {
        stageDispatches += 1;
        stageTokensLow += baseTokens;
        stageTokensHigh += baseTokens + artifactTokens;

        const resolvedModel = resolveDispatchModel(corpusRecords, config, stageDef.stage, area, host);
        const { model } = resolvedModel;
        modelSources[resolvedModel.source || "unresolved"] += 1;
        const pricing = model ? pricingFor(model) : null;
        if (pricing) {
          costLow += (baseTokens / 1_000_000) * pricing.input;
          costHigh += ((baseTokens + artifactTokens) / 1_000_000) * pricing.input;
        } else {
          allModelsKnown = false;
          unresolved.add(`${area}@${host}`);
        }
        perArea.push({ role: area, host, model: model || null, model_source: resolvedModel.source });
      }
    }

    dispatchMax += stageDispatches;
    if (!isConditional) dispatchMin += stageDispatches;
    tokensLow += stageTokensLow;
    tokensHigh += stageTokensHigh;
    perStage.push({
      stage: stageDef.stage,
      name: stageName,
      conditional: isConditional,
      dispatch_count: stageDispatches,
      tokens: { low: stageTokensLow, high: stageTokensHigh },
      roles: perArea,
    });
  }

  return {
    track: Array.isArray(track) ? "custom" : track,
    estimate_basis: "static",
    stage_slots: perStage.length,
    conditional_stages: conditionalStages,
    dispatch_count: { min: dispatchMin, max: dispatchMax },
    tokens: { low: tokensLow, high: tokensHigh },
    tokens_scope: "estimated-input",
    cost_usd: allModelsKnown && dispatchMax > 0 ? { low: costLow, high: costHigh } : null,
    cost_scope: "input-only-floor",
    model_sources: modelSources,
    unresolved_models: allModelsKnown ? [] : [...unresolved].sort(),
    per_stage: perStage,
  };
}

// Empirical per-track estimate from the phase-28 corpus. Requires
// MIN_EMPIRICAL_RUNS distinct completed runs (by run_id) whose track matches.
// Returns null when there isn't enough history — caller falls back to static.
function computeEmpiricalEstimate(cwd, track) {
  if (Array.isArray(track)) return null; // custom stage arrays have no stable "track" label to match in the corpus
  const records = readCorpus(cwd).filter((r) => r.track === track);
  const byRun = new Map();
  for (const r of records) {
    if (!r.run_id) continue;
    if (!byRun.has(r.run_id)) byRun.set(r.run_id, []);
    byRun.get(r.run_id).push(r);
  }
  const runIds = [...byRun.keys()];
  if (runIds.length < MIN_EMPIRICAL_RUNS) return null;

  const perRun = runIds.map((id) => {
    const recs = byRun.get(id);
    const tokensTotal = recs.reduce((s, r) => s + (r.tokens_in || 0) + (r.tokens_out || 0), 0);
    const costs = recs.map((r) => r.cost_usd);
    const costTotal = costs.every((c) => typeof c === "number")
      ? costs.reduce((s, c) => s + c, 0)
      : null;
    return { dispatchCount: recs.length, tokensTotal, costTotal };
  });

  const dispatchMedian = Math.round(median(perRun.map((r) => r.dispatchCount)));
  const tokensMedian = median(perRun.map((r) => r.tokensTotal));
  const costSamples = perRun.map((r) => r.costTotal).filter((c) => c !== null);
  const costMedian = costSamples.length > 0 ? median(costSamples) : null;

  return {
    track,
    estimate_basis: "empirical",
    sample_size: runIds.length,
    stage_slots: orderedStageNamesForTrack(track).length,
    conditional_stages: orderedStageNamesForTrack(track)
      .filter((n) => STAGES[n] && STAGES[n].conditionalOn)
      .map((n) => STAGES[n].stage),
    dispatch_count: { min: dispatchMedian, max: dispatchMedian },
    tokens: { low: tokensMedian, high: tokensMedian },
    tokens_scope: "observed-total",
    cost_usd: costMedian !== null ? { low: costMedian, high: costMedian } : null,
    cost_scope: "observed-total",
    unresolved_models: costMedian !== null ? [] : ["insufficient cost data in corpus for this track's runs"],
  };
}

// Preview entry point. `opts.stageNames` (static path only) overrides the
// nominal track stage list — see computeStaticEstimate.
function ceremonyPreview(cwd, track, config, opts = {}) {
  const empirical = computeEmpiricalEstimate(cwd, track);
  if (empirical) return empirical;
  return computeStaticEstimate(cwd, track, config, opts);
}

function assuranceOptions(cwd, config, recommendedTrack) {
  return PRIMARY_ASSURANCE_TRACKS.map((track) => ({
    ...ceremonyPreview(cwd, track, config),
    recommended: track === recommendedTrack,
  }));
}

function formatUsdRange(range) {
  const { formatUsd } = require("./pricing");
  if (!range) return "— (unknown model)";
  return range.low === range.high ? formatUsd(range.low) : `${formatUsd(range.low)}–${formatUsd(range.high)}`;
}

function formatCostRange(preview) {
  const range = formatUsdRange(preview.cost_usd);
  return preview.cost_scope === "input-only-floor" && preview.cost_usd
    ? `${range} input floor`
    : range;
}

function formatTokenRange(range) {
  const fmt = (n) => n.toLocaleString("en-US");
  return range.low === range.high ? fmt(range.low) : `${fmt(range.low)}–${fmt(range.high)}`;
}

// Render a compact multi-line text summary shared by `devteam assess` and
// `devteam run` pre-flight output.
function renderCeremonyPreviewText(preview) {
  const lines = [];
  const dispatch = preview.dispatch_count.min === preview.dispatch_count.max
    ? String(preview.dispatch_count.max)
    : `${preview.dispatch_count.min}–${preview.dispatch_count.max}`;
  lines.push(
    `Ceremony estimate (${preview.estimate_basis}): ${preview.stage_slots} stage slot(s), ` +
    `${dispatch} dispatch(es), ~${formatTokenRange(preview.tokens)} tokens, ` +
    `${formatCostRange(preview)}`,
  );
  if (preview.conditional_stages.length > 0) {
    lines.push(`  conditional (may not fire): ${preview.conditional_stages.join(", ")}`);
  }
  if (preview.unresolved_models.length > 0) {
    lines.push(`  cost omitted — unknown model for: ${preview.unresolved_models.join(", ")}`);
  }
  if (preview.cost_scope === "input-only-floor" && preview.cost_usd) {
    lines.push("  output generation is excluded until observed; use --budget-usd and/or --budget-tokens as runtime halt thresholds");
  }
  lines.push(`  (${preview.estimate_basis === "empirical" ? `median of ${preview.sample_size} prior run(s)` : "estimate — framework overhead + on-disk artifact sampling"}, never a bill)`);
  return lines;
}

function renderAssuranceOptionsText(options) {
  const lines = ["Primary assurance options (specialist tracks remain available):"];
  for (const option of options) {
    const dispatch = option.dispatch_count.min === option.dispatch_count.max
      ? String(option.dispatch_count.max)
      : `${option.dispatch_count.min}–${option.dispatch_count.max}`;
    const marker = option.recommended ? "  ← recommended" : "";
    lines.push(
      `  ${option.track.padEnd(5)} ${String(option.stage_slots).padStart(2)} stage slot(s), ` +
      `${dispatch.padStart(5)} dispatch(es), ~${formatTokenRange(option.tokens)} tokens, ` +
      `${formatCostRange(option)}${marker}`,
    );
  }
  return lines;
}

module.exports = {
  MIN_EMPIRICAL_RUNS,
  PRIMARY_ASSURANCE_TRACKS,
  ceremonyPreview,
  assuranceOptions,
  computeStaticEstimate,
  computeEmpiricalEstimate,
  mostRecentModelObserved,
  resolveDispatchModel,
  sampleArtifactBytes,
  renderCeremonyPreviewText,
  renderAssuranceOptionsText,
};
