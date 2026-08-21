"use strict";

const { category, number } = require("./categories");
const { sourceEventRef } = require("./resolutions");

const KNOWN_STATUSES = new Set(["PASS", "WARN", "FAIL", "ESCALATE"]);
const HASH_PATTERN = /^sha256:[0-9a-f]{64}$/;

// 42.5: one run-start is one *invocation*, and every `devteam run --resume`
// emits another. Counting them made a single logical feature change look like
// several runs in the denominator — the conflation the 2026-08-19 Phase 41
// review flagged before using run_count as a readiness measure.
//
// Runs carrying a logical_run_id (the lineage root, written by core/driver.js)
// are grouped by it, so a change driven through two resumes is one run with one
// completion. The id is used only for grouping: it is a local timestamp and
// never reaches the exported bundle, which stays a count.
//
// Backward compatible by construction — a log predating the field has no
// logical_run_id, so each run-start remains its own run exactly as before.
function groupRuns(events) {
  const runs = [];
  const byLogicalId = new Map();
  let current = null;
  let orphanEvents = 0;
  for (const event of events) {
    if (event.outcome === "run-start") {
      const logicalId = typeof event.logical_run_id === "string" && event.logical_run_id
        ? event.logical_run_id
        : null;
      const existing = logicalId ? byLogicalId.get(logicalId) : null;
      if (existing) {
        // A resume of a run we have already seen: continue it rather than
        // opening a second denominator entry for the same change.
        current = existing;
      } else {
        current = { intent: category(event.intent), events: [] };
        runs.push(current);
        if (logicalId) byLogicalId.set(logicalId, current);
      }
    }
    if (!current) {
      orphanEvents += 1;
      continue;
    }
    current.events.push(event);
  }
  return { runs, orphanEvents };
}

function increment(map, key, amount = 1) {
  map.set(key, (map.get(key) || 0) + amount);
}

function rowsFromMap(map, keys, valueKey = "observations") {
  return [...map.entries()].map(([compound, value]) => {
    const parts = compound.split("\0");
    const row = {};
    keys.forEach((key, index) => { row[key] = parts[index]; });
    row[valueKey] = value;
    return row;
  }).sort((a, b) => keys.map((key) => a[key]).join("\0").localeCompare(
    keys.map((key) => b[key]).join("\0"),
  ));
}

function extractRouting(gateRecords) {
  const observationSource = (record) => record.source === "current" ? "current" : record.source_id;
  const direct = new Set();
  for (const record of gateRecords) {
    const gate = record.gate;
    if (gate.workstream && gate.host) {
      direct.add(`${observationSource(record)}\0${category(gate.stage)}\0${category(gate.workstream)}`);
    }
  }

  const groups = new Map();
  for (const record of gateRecords) {
    const gate = record.gate;
    const observations = [];
    if (gate.workstream && gate.host) {
      observations.push(gate);
    } else if (Array.isArray(gate.workstreams)) {
      for (const workstream of gate.workstreams) {
        const directKey = `${observationSource(record)}\0${category(gate.stage)}\0${category(workstream.workstream)}`;
        if (!direct.has(directKey)) observations.push({ ...workstream, stage: gate.stage });
      }
    }
    for (const item of observations) {
      const role = category(item.workstream);
      const host = category(item.host);
      const model = category(item.model || gate.model || "unknown");
      const key = `${role}\0${host}\0${model}`;
      if (!groups.has(key)) {
        groups.set(key, {
          role, host, model, gate_observations: 0, pass: 0, warn: 0, fail: 0,
          escalate: 0, cost_observations: 0, total_cost_usd: 0,
          duration_observations: 0, total_duration_ms: 0,
          prompt_observations: 0, total_prompt_bytes: 0,
        });
      }
      const row = groups.get(key);
      row.gate_observations += 1;
      const status = KNOWN_STATUSES.has(item.status) ? item.status : gate.status;
      if (status === "PASS") row.pass += 1;
      else if (status === "WARN") row.warn += 1;
      else if (status === "FAIL") row.fail += 1;
      else if (status === "ESCALATE") row.escalate += 1;
      const cost = number(item.cost_usd ?? gate.cost_usd);
      if (cost !== null) { row.cost_observations += 1; row.total_cost_usd += cost; }
      const duration = number(item.duration_ms ?? gate.duration_ms);
      if (duration !== null) {
        row.duration_observations += 1;
        row.total_duration_ms += duration;
      }
      const promptBytes = number(item.prompt_bytes ?? gate.prompt_bytes);
      if (promptBytes !== null) {
        row.prompt_observations += 1;
        row.total_prompt_bytes += promptBytes;
      }
    }
  }
  return [...groups.values()].sort((a, b) =>
    `${a.role}\0${a.host}\0${a.model}`.localeCompare(`${b.role}\0${b.host}\0${b.model}`));
}

function extractDurableRouting(events) {
  const groups = new Map();
  for (const event of events) {
    if (event.outcome !== "dispatch-observation") continue;
    const role = category(event.role);
    const host = category(event.host);
    const model = category(event.model || "unknown");
    const key = `${role}\0${host}\0${model}`;
    if (!groups.has(key)) {
      groups.set(key, {
        role, host, model, gate_observations: 0, pass: 0, warn: 0, fail: 0,
        escalate: 0, cost_observations: 0, total_cost_usd: 0,
        duration_observations: 0, total_duration_ms: 0,
        prompt_observations: 0, total_prompt_bytes: 0,
      });
    }
    const row = groups.get(key);
    row.gate_observations += 1;
    const status = KNOWN_STATUSES.has(event.status) ? event.status : null;
    if (status === "PASS") row.pass += 1;
    else if (status === "WARN") row.warn += 1;
    else if (status === "FAIL") row.fail += 1;
    else if (status === "ESCALATE") row.escalate += 1;
    const cost = number(event.cost_usd);
    if (cost !== null) { row.cost_observations += 1; row.total_cost_usd += cost; }
    const duration = number(event.duration_ms);
    if (duration !== null) {
      row.duration_observations += 1;
      row.total_duration_ms += duration;
    }
    const promptBytes = number(event.prompt_bytes);
    if (promptBytes !== null) {
      row.prompt_observations += 1;
      row.total_prompt_bytes += promptBytes;
    }
  }
  return [...groups.values()].sort((a, b) =>
    `${a.role}\0${a.host}\0${a.model}`.localeCompare(`${b.role}\0${b.host}\0${b.model}`));
}

function extractResolutions(events) {
  const groups = new Map();
  const seenSources = new Set();
  const validSources = new Map();
  for (const event of events) {
    if (event.outcome !== "fix-retry") continue;
    const stage = category(event.stage);
    const failure_class = category(event.failure_class);
    if (stage === "other" || failure_class === "other") continue;
    validSources.set(sourceEventRef(event), {
      stage,
      failure_class,
      derivable: event.derivable === true
        || (Number.isInteger(event.cleared_gates) && event.cleared_gates > 0),
    });
  }
  for (const event of events) {
    if (event.outcome !== "resolution-accepted") continue;
    if (!HASH_PATTERN.test(event.source_event_sha256)
      || !HASH_PATTERN.test(event.schema_fingerprint)
      || seenSources.has(event.source_event_sha256)) continue;
    const source = validSources.get(event.source_event_sha256);
    if (!source || category(event.stage) !== source.stage
      || category(event.failure_class) !== source.failure_class
      || event.derivable !== source.derivable) continue;
    seenSources.add(event.source_event_sha256);
    const stage = category(event.stage);
    const failure_class = category(event.failure_class);
    const schema_fingerprint = event.schema_fingerprint;
    const key = `${stage}\0${failure_class}\0${schema_fingerprint}`;
    if (!groups.has(key)) {
      groups.set(key, {
        stage, failure_class, schema_fingerprint, observations: 0, derivable: 0,
      });
    }
    const row = groups.get(key);
    row.observations += 1;
    if (event.derivable === true) row.derivable += 1;
  }
  return [...groups.values()].sort((a, b) =>
    `${a.stage}\0${a.failure_class}\0${a.schema_fingerprint}`.localeCompare(
      `${b.stage}\0${b.failure_class}\0${b.schema_fingerprint}`,
    ));
}

function condition(id, value, threshold, met, reasonCode = null) {
  return { id, value, threshold, met, reason_code: met ? null : reasonCode };
}

function readinessSummary({ runs, routing, recovery, resolutions, rulings, stalls }) {
  const fixRetryRuns = runs.filter((run) => run.events.some((e) => e.outcome === "fix-retry")).length;
  const repairRuns = runs.filter((run) => run.intent === "repair").length;
  const maxRecoveryRuns = recovery.reduce((max, row) => Math.max(max, row.runs), 0);
  const costCoverage = routing.reduce((sum, row) => sum + row.cost_observations, 0);
  const roleHosts = new Map();
  for (const row of routing) {
    if (!roleHosts.has(row.role)) roleHosts.set(row.role, new Map());
    const hosts = roleHosts.get(row.role);
    hosts.set(row.host, (hosts.get(row.host) || 0) + row.gate_observations);
  }
  const comparableRoles = [...roleHosts.values()].filter((hosts) =>
    [...hosts.values()].filter((count) => count >= 5).length >= 2).length;
  const durableDispatches = routing.reduce((sum, row) => sum + row.gate_observations, 0);
  const ceilingEvents = runs.reduce((sum, run) =>
    sum + run.events.filter((e) => e.outcome === "ceiling-halt").length, 0);
  const rulingEvents = rulings.reduce((sum, row) => sum + row.observations, 0);
  const stallEvents = stalls.reduce((sum, row) => sum + row.observations, 0);
  const acceptedResolutions = resolutions.reduce((sum, row) => sum + row.observations, 0);
  const derivableResolutions = resolutions.reduce((sum, row) => sum + row.derivable, 0);
  const derivablePercent = acceptedResolutions === 0
    ? 0 : Math.round((derivableResolutions / acceptedResolutions) * 100);

  return [
    {
      capability: "h3-recipe-suggestions",
      issue: 142,
      status: "not-ready",
      portfolio_status: "not-assessable",
      local_conditions: [
        condition("fix-retry-runs", fixRetryRuns, 5, fixRetryRuns >= 5, "insufficient-fix-retry-runs"),
        condition("recurring-failure-runs", maxRecoveryRuns, 3, maxRecoveryRuns >= 3, "insufficient-recurrence"),
        condition("accepted-resolution-signal", acceptedResolutions, 1, acceptedResolutions >= 1, "no-accepted-resolutions"),
        condition("derivable-accepted-resolutions-percent", derivablePercent, 80, acceptedResolutions > 0 && derivablePercent >= 80, "insufficient-derivable-resolutions"),
      ],
      portfolio_reason_code: "multiple-project-bundles-required",
    },
    {
      capability: "d5-continuous-routing",
      issue: 143,
      status: "not-ready",
      portfolio_status: "not-assessable",
      local_conditions: [
        condition("comparable-roles", comparableRoles, 1, comparableRoles >= 1, "insufficient-host-comparison"),
        condition("cost-covered-observations", costCoverage, 1, costCoverage >= 1, "cost-telemetry-unavailable"),
        condition("durable-dispatch-history", durableDispatches, 1, durableDispatches >= 1, "durable-dispatch-history-unavailable"),
      ],
      portfolio_reason_code: "multiple-project-bundles-required",
    },
    {
      capability: "standing-grants",
      issue: 144,
      status: "not-ready",
      portfolio_status: "not-assessable",
      local_conditions: [
        condition("repair-runs", repairRuns, 10, repairRuns >= 10, "insufficient-repair-runs"),
        condition("consequence-ceiling-events", ceilingEvents, 1, ceilingEvents >= 1, "no-consequence-ceiling-evidence"),
        condition("granted-ruling-events", rulingEvents, 1, rulingEvents >= 1, "no-granted-ruling-evidence"),
      ],
      portfolio_reason_code: "multiple-project-bundles-required",
    },
    {
      capability: "active-stall-response",
      issue: 145,
      status: "not-ready",
      portfolio_status: "not-assessable",
      local_conditions: [
        condition("stall-events", stallEvents, 1, stallEvents >= 1, "no-stall-evidence"),
        condition("calibrated-threshold", 0, 1, false, "stall-threshold-not-defined"),
      ],
      portfolio_reason_code: "multiple-project-bundles-required",
    },
  ];
}

function analyzeEvidence({ events = [], gates = [], quality = {}, dispatchesOutsideRun = null }) {
  const { runs, orphanEvents } = groupRuns(events);
  const recoveryMap = new Map();
  const recoveryRuns = new Map();
  const rulingMap = new Map();
  const recordedRulingMap = new Map();
  const stallMap = new Map();

  runs.forEach((run, runIndex) => {
    for (const event of run.events) {
      if (["fix-retry", "convergence-halt", "no-progress-halt"].includes(event.outcome)) {
        const key = `${category(event.stage)}\0${category(event.failure_class)}`;
        increment(recoveryMap, key);
        if (!recoveryRuns.has(key)) recoveryRuns.set(key, new Set());
        recoveryRuns.get(key).add(runIndex);
      }
      if (event.outcome === "auto-ruled") {
        increment(rulingMap, category(event.grant_class));
      }
      // 42.5: kept in a separate population from auto-ruled on purpose. An
      // auto-applied ruling is evidence a standing grant already exists; a
      // hand-recorded one is evidence about what a human chose. ADR-005 asks
      // which grants operators routinely approve, so merging the two would
      // answer a different question than the one the gate poses.
      if (event.outcome === "ruling-recorded") {
        increment(recordedRulingMap, category(event.ruling_class));
      }
      if (event.outcome === "stall-detected") {
        increment(stallMap, `${category(event.stage)}\0${category(event.stall_class)}`);
      }
    }
  });

  const recovery = rowsFromMap(recoveryMap, ["stage", "failure_class"]);
  for (const row of recovery) {
    row.runs = recoveryRuns.get(`${row.stage}\0${row.failure_class}`).size;
  }
  const rulings = rowsFromMap(rulingMap, ["ruling_class"]);
  const recordedRulings = rowsFromMap(recordedRulingMap, ["ruling_class"]);
  const stalls = rowsFromMap(stallMap, ["stage", "stall_class"]);
  const resolutions = extractResolutions(events);
  const durableRouting = extractDurableRouting(events);
  const durableDispatchObservations = durableRouting.reduce(
    (sum, row) => sum + row.gate_observations, 0,
  );
  const routing = durableRouting.length > 0 ? durableRouting : extractRouting(gates);
  const completedRuns = runs.filter((run) => run.events.some((e) => e.outcome === "complete")).length;
  const normalizedQuality = {
    log_present: false,
    gate_files: 0,
    malformed_records: 0,
    oversized_records: 0,
    unreadable_sources: 0,
    truncated_sources: 0,
    symlink_sources: 0,
    ...quality,
    durable_dispatch_observations: durableDispatchObservations,
    orphan_events: orphanEvents,
    // 42.5: a dispatch made outside a run — `devteam stage --headless` used for
    // direct remediation — writes a corpus record but no run-log event, so the
    // durable count above structurally cannot see it. Reporting the number
    // makes the exclusion explicit instead of silent: a reviewer weighing a D5
    // threshold can tell "12 dispatches" from "12 that this evidence path can
    // see, plus 3 it cannot". Null when the corpus was not consulted.
    ...(dispatchesOutsideRun !== null ? { dispatches_outside_run: dispatchesOutsideRun } : {}),
  };

  return {
    schema_version: "1.0",
    mode: "project",
    scope: {
      project_count: 1,
      run_count: runs.length,
      complete_run_count: completedRuns,
      repair_run_count: runs.filter((run) => run.intent === "repair").length,
    },
    quality: normalizedQuality,
    routing,
    recovery,
    resolutions,
    rulings,
    recorded_rulings: recordedRulings,
    stalls,
    readiness: readinessSummary({
      runs,
      routing: durableRouting,
      recovery,
      resolutions,
      rulings,
      stalls,
    }),
  };
}

module.exports = {
  analyzeEvidence,
  category,
  groupRuns,
  extractRouting,
  extractDurableRouting,
  extractResolutions,
};
