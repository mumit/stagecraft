"use strict";

const fs = require("node:fs");
const path = require("node:path");
const crypto = require("node:crypto");
const { readCorpus } = require("../corpus");
const { analyzeEvents, durationLabel, readJsonLines } = require("./critical-path");
const { pipelineRoot } = require("../paths");

const SCHEMA_VERSION = "performance-calibration.v1";
const FIT_VALUES = new Set(["too-light", "right", "too-heavy"]);
const REASON_VALUES = new Set([
  "security-missed", "migration-missed", "wrong-workstreams", "too-many-stages",
  "cost", "latency", "other",
]);

function percentile(values, fraction) {
  const sorted = values.filter(Number.isFinite).sort((a, b) => a - b);
  if (sorted.length === 0) return null;
  return sorted[Math.max(0, Math.ceil(sorted.length * fraction) - 1)];
}

function distribution(values) {
  const usable = values.filter(Number.isFinite);
  return { samples: usable.length, p50: percentile(usable, 0.5), p95: percentile(usable, 0.95) };
}

function splitRuns(events) {
  const runs = [];
  let current = null;
  for (const event of events) {
    if (event.outcome === "run-start") {
      if (current && current.length > 0) runs.push(current);
      current = [event];
    } else if (current) {
      current.push(event);
    }
  }
  if (current && current.length > 0) runs.push(current);
  return runs;
}

function feedbackPath(cwd, changeId = null) {
  return path.join(cwd, ".devteam", "performance", changeId || "in-place", "track-feedback.jsonl");
}

function recordTrackFeedback(cwd, { fit, reason = "other", track = null, trackSource = null, riskClass = null, changeId = null } = {}) {
  if (!FIT_VALUES.has(fit)) throw new Error(`invalid fit "${fit}" (expected too-light, right, or too-heavy)`);
  if (!REASON_VALUES.has(reason)) throw new Error(`invalid reason "${reason}"`);
  const record = { ts: new Date().toISOString(), fit, reason, track, track_source: trackSource, risk_class: riskClass };
  const target = feedbackPath(cwd, changeId);
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.appendFileSync(target, `${JSON.stringify(record)}\n`, "utf8");
  return record;
}

function readFeedback(cwd, changeId = null) {
  return readJsonLines(feedbackPath(cwd, changeId)).events.filter((row) => FIT_VALUES.has(row.fit));
}

function outcomeRate(records) {
  if (records.length === 0) return null;
  return records.filter((r) => r.gate_status === "PASS" || r.gate_status === "WARN").length / records.length;
}

function groupCounts(values) {
  const counts = {};
  for (const value of values) counts[value || "(unknown)"] = (counts[value || "(unknown)"] || 0) + 1;
  return counts;
}

function privateProjectRef(project) {
  return `project-${crypto.createHash("sha256").update(project).digest("hex").slice(0, 12)}`;
}

function sum(values) {
  return values.filter(Number.isFinite).reduce((total, value) => total + value, 0);
}

function runCostRows(records) {
  const grouped = new Map();
  for (const record of records) {
    if (!record.run_id) continue;
    const key = `${record._project}:${record.run_id}`;
    if (!grouped.has(key)) grouped.set(key, []);
    grouped.get(key).push(record);
  }
  return [...grouped.values()].map((rows) => {
    const priced = rows.filter((row) => Number.isFinite(row.cost_usd));
    return {
      successful: rows.length > 0 && rows.every((row) => row.gate_status === "PASS" || row.gate_status === "WARN"),
      cost_usd: priced.length === rows.length ? sum(priced.map((row) => row.cost_usd)) : null,
    };
  });
}

function analyzeProjects(projects, opts = {}) {
  const projectRows = [];
  const allRecords = [];
  const allRuns = [];
  const allFeedback = [];
  const resolutions = [];
  const repairRunsByProject = new Map();
  const trackSources = [];
  for (const cwd of projects) {
    const project = path.resolve(cwd);
    const records = readCorpus(project).map((record) => ({ ...record, _project: project }));
    const logPath = path.join(pipelineRoot(project, opts.changeId || null), "run-log.jsonl");
    const events = readJsonLines(logPath).events;
    const eventRuns = splitRuns(events);
    const runs = eventRuns.map((runEvents) => analyzeEvents(runEvents, {
      generatedAt: opts.generatedAt, source: path.relative(project, logPath).replace(/\\/g, "/"),
    }));
    repairRunsByProject.set(project, eventRuns.filter((runEvents) =>
      runEvents.some((event) => event.outcome === "fix-retry")).length);
    trackSources.push(...events
      .filter((event) => event.outcome === "run-plan" && typeof event.track_source === "string")
      .map((event) => event.track_source));
    const feedback = readFeedback(project, opts.changeId || null);
    for (const event of events) {
      if (event.outcome === "resolution-accepted") resolutions.push({ ...event, _project: project });
    }
    allRecords.push(...records);
    allRuns.push(...runs);
    allFeedback.push(...feedback);
    projectRows.push({ project_ref: privateProjectRef(project), dispatches: records.length, runs: runs.length, feedback: feedback.length });
  }

  const costs = allRecords.map((r) => r.cost_usd).filter(Number.isFinite);
  const observedCosts = allRecords.filter((r) => r.cost_basis === "observed" && Number.isFinite(r.cost_usd));
  const successful = allRecords.filter((r) => r.gate_status === "PASS" || r.gate_status === "WARN");
  const successfulCosts = successful.map((r) => r.cost_usd).filter(Number.isFinite);
  const runCosts = runCostRows(allRecords);
  const successfulRunCosts = runCosts.filter((row) => row.successful && Number.isFinite(row.cost_usd));
  const totalCost = costs.reduce((sum, value) => sum + value, 0);
  const cacheEligible = allRecords.filter((r) => Number.isFinite(r.cached_tokens));
  const cacheHits = cacheEligible.filter((r) => r.cached_tokens > 0);
  const cacheCreation = allRecords.filter((r) => Number.isFinite(r.cache_creation_tokens));
  const cacheCreationTotal = cacheCreation.reduce((sum, r) => sum + r.cache_creation_tokens, 0);
  const knowledgeEligible = allRecords.filter((r) => Number.isFinite(r.knowledge_items) || Number.isFinite(r.prior_knowledge_items));
  const withKnowledge = knowledgeEligible.filter((r) => (r.knowledge_items || 0) + (r.prior_knowledge_items || 0) > 0);
  const withoutKnowledge = knowledgeEligible.filter((r) => (r.knowledge_items || 0) + (r.prior_knowledge_items || 0) === 0);

  const routes = new Map();
  for (const record of allRecords) {
    const key = `${record.role || "(unknown)"}@${record.host || "(unknown)"}`;
    if (!routes.has(key)) routes.set(key, { role: record.role, host: record.host, dispatches: 0, projects: new Set() });
    const route = routes.get(key);
    route.dispatches += 1;
    route.projects.add(record._project);
  }
  const routeRows = [...routes.values()].map((row) => ({
    role: row.role,
    host: row.host,
    dispatches: row.dispatches,
    projects: row.projects.size,
    phase41_ready: row.dispatches >= 5 && row.projects.size >= 2,
  }));

  const resolutionGroups = new Map();
  for (const row of resolutions) {
    const key = `${row.failure_class || "(unknown)"}:${row.schema_fingerprint || "(unknown)"}`;
    if (!resolutionGroups.has(key)) resolutionGroups.set(key, { observations: 0, derivable: 0, projects: new Set() });
    const group = resolutionGroups.get(key);
    group.observations += 1;
    if (row.derivable === true) group.derivable += 1;
    group.projects.add(row._project);
  }
  const h3Candidate = [...resolutionGroups.values()].some((group) =>
    group.projects.size >= 2
    && [...group.projects].every((project) => (repairRunsByProject.get(project) || 0) >= 5)
    && group.observations >= 3
    && group.derivable / group.observations >= 0.8);

  const report = {
    schema_version: SCHEMA_VERSION,
    generated_at: opts.generatedAt || new Date().toISOString(),
    status: allRuns.length >= 2 ? "calibrating" : "insufficient-data",
    sample_size: {
      projects: projectRows.length,
      runs: allRuns.length,
      dispatches: allRecords.length,
      accepted_resolutions: resolutions.length,
    },
    projects: projectRows,
    latency_ms: {
      critical_path: distribution(allRuns.map((run) => run.reported_critical_path_ms)),
      total_run: distribution(allRuns.map((run) => run.total_run_ms)),
      invoke: distribution(allRecords.map((r) => r.duration_ms)),
      queue: distribution(allRecords.map((r) => r.queue_ms)),
      retry_delay: distribution(allRuns.map((run) => run.retry_delay_ms)),
      merge: distribution(allRuns.map((run) => run.merge_wall_ms)),
    },
    time_categories_ms: {
      queue: distribution(allRuns.map((run) => run.queue_wait_ms)),
      invocation: distribution(allRuns.map((run) => run.dispatch_wall_ms)),
      verification: distribution(allRuns.map((run) => run.category_duration_ms?.verification)),
      reconciliation: distribution(allRuns.map((run) => run.category_duration_ms?.reconciliation)),
      retry_backoff: distribution(allRuns.map((run) => run.retry_delay_ms)),
      merge: distribution(allRuns.map((run) => run.merge_wall_ms)),
      blocker: distribution(allRuns.map((run) => run.category_duration_ms?.blocker)),
    },
    cost: {
      samples: costs.length,
      observed_samples: observedCosts.length,
      basis: groupCounts(allRecords.filter((r) => Number.isFinite(r.cost_usd)).map((r) => r.cost_basis)),
      total_usd: costs.length > 0 ? totalCost : null,
      per_successful_dispatch_usd: successfulCosts.length > 0
        ? successfulCosts.reduce((sum, value) => sum + value, 0) / successfulCosts.length
        : null,
      successful_run_samples: successfulRunCosts.length,
      per_successful_run_usd: successfulRunCosts.length > 0
        ? sum(successfulRunCosts.map((row) => row.cost_usd)) / successfulRunCosts.length
        : null,
      per_accepted_resolution_usd: resolutions.length > 0 && costs.length > 0 ? totalCost / resolutions.length : null,
    },
    cache: {
      samples: cacheEligible.length,
      hits: cacheHits.length,
      hit_rate: cacheEligible.length > 0 ? cacheHits.length / cacheEligible.length : null,
      cached_tokens: cacheHits.reduce((sum, r) => sum + r.cached_tokens, 0),
      // A prefix that is written to cache every dispatch and read back rarely
      // is not paying for itself — cache writes cost more than plain input.
      // Reads-per-write is the ratio that says whether phase-32.1's byte-stable
      // prefix is actually being reused or just re-created.
      cache_creation_tokens: cacheCreation.reduce((sum, r) => sum + r.cache_creation_tokens, 0),
      read_per_write: cacheCreationTotal > 0
        ? cacheHits.reduce((sum, r) => sum + r.cached_tokens, 0) / cacheCreationTotal
        : null,
    },
    knowledge_selection: {
      samples: knowledgeEligible.length,
      selected_dispatches: withKnowledge.length,
      unselected_dispatches: withoutKnowledge.length,
      selected_outcome_rate: outcomeRate(withKnowledge),
      unselected_outcome_rate: outcomeRate(withoutKnowledge),
      item_usage_coverage: 0,
      interpretation: "correlation only; selection does not prove causal usefulness",
    },
    track_fit: {
      samples: allFeedback.length,
      fit: groupCounts(allFeedback.map((row) => row.fit)),
      reasons: groupCounts(allFeedback.map((row) => row.reason)),
      plan_sources: groupCounts(trackSources),
      human_override_rate: trackSources.length > 0
        ? trackSources.filter((source) => source === "human").length / trackSources.length
        : null,
      false_negative_proxy: allFeedback.filter((row) => row.fit === "too-light").length,
      false_positive_proxy: allFeedback.filter((row) => row.fit === "too-heavy").length,
      by_risk_class: groupCounts(allFeedback.map((row) => row.risk_class)),
    },
    data_quality: {
      event_runs_with_duration: allRuns.filter((run) => Number.isFinite(run.total_run_ms)).length,
      dispatch_cost_coverage: allRecords.length > 0 ? costs.length / allRecords.length : null,
      provider_observed_cost_coverage: costs.length > 0 ? observedCosts.length / costs.length : null,
      cache_telemetry_coverage: allRecords.length > 0 ? cacheEligible.length / allRecords.length : null,
      knowledge_selection_coverage: allRecords.length > 0 ? knowledgeEligible.length / allRecords.length : null,
    },
    phase41: {
      routing_ready: routeRows.length > 0 && routeRows.every((row) => row.phase41_ready),
      routes: routeRows,
      h3_candidate_ready: h3Candidate,
      synthetic_data_counts: false,
    },
  };
  return report;
}

function money(value) {
  return value === null ? "—" : `$${value.toFixed(4)}`;
}

function renderMarkdown(report) {
  const out = ["# devteam performance — calibration", "", `Status: **${report.status}**`, ""];
  const n = report.sample_size;
  out.push(`Samples: ${n.projects} project(s), ${n.runs} run(s), ${n.dispatches} dispatch(es), ${n.accepted_resolutions} accepted resolution(s).`);
  out.push("");
  out.push("| Measure | n | p50 | p95 |", "|---|---:|---:|---:|");
  for (const [name, row] of Object.entries(report.latency_ms)) {
    out.push(`| ${name.replace(/_/g, " ")} | ${row.samples} | ${durationLabel(row.p50)} | ${durationLabel(row.p95)} |`);
  }
  out.push("", "## Cost", "");
  out.push(`- Total: ${money(report.cost.total_usd)} (${report.cost.observed_samples}/${report.cost.samples} provider-observed samples)`);
  out.push(`- Per successful dispatch: ${money(report.cost.per_successful_dispatch_usd)}`);
  out.push(`- Per successful run: ${money(report.cost.per_successful_run_usd)} (${report.cost.successful_run_samples} fully priced run(s))`);
  out.push(`- Per accepted resolution: ${money(report.cost.per_accepted_resolution_usd)}`);
  out.push("", "## Cache and knowledge", "");
  out.push(`- Cache hit rate: ${report.cache.hit_rate === null ? "—" : `${(report.cache.hit_rate * 100).toFixed(1)}%`} (${report.cache.hits}/${report.cache.samples})`);
  out.push(`- Knowledge-selected outcome rate: ${report.knowledge_selection.selected_outcome_rate === null ? "—" : `${(report.knowledge_selection.selected_outcome_rate * 100).toFixed(1)}%`} (${report.knowledge_selection.interpretation})`);
  out.push("", "## Phase 41 gates", "");
  out.push(`- Adaptive routing: ${report.phase41.routing_ready ? "READY FOR EVIDENCE REVIEW" : "BLOCKED"}`);
  out.push(`- Recipe candidates: ${report.phase41.h3_candidate_ready ? "READY FOR EVIDENCE REVIEW" : "BLOCKED"}`);
  return out.join("\n") + "\n";
}

module.exports = {
  FIT_VALUES,
  REASON_VALUES,
  SCHEMA_VERSION,
  analyzeProjects,
  distribution,
  percentile,
  recordTrackFeedback,
  renderMarkdown,
  splitRuns,
};
