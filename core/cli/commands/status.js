"use strict";

// ADR-007 §5: read-only liveness status command. Reads run-state.json and
// the tail of run-log.jsonl; reports status/current_stage/last_action/
// iterations/cost_usd/cost_basis/last_heartbeat_age_ms/last_event_age_ms/stall_detected.
// No process interaction — purely a file reader. Live rendering is owned by
// `devteam run --watch`, which consumes the driver's callback stream.

const fs = require("node:fs");
const path = require("node:path");
const { generateHelp } = require(path.join(__dirname, "..", "flags"));

const name = "status";

const flags = {
  cwd:     { type: "string",  description: "Target project directory" },
  feature: { type: "string",  description: "Feature description for bounded isolation lookup" },
  json:    { type: "boolean", description: "JSON output" },
  verbose: { type: "boolean", description: "Show active and last workstream details" },
  help:    { type: "boolean", description: "Show this help" },
};

// Scan run-log.jsonl backward for the last line matching a predicate.
// Returns the parsed object or null. Reads at most maxLines from the end.
function lastMatchingEvent(logPath, predicate, maxLines = 500) {
  let content;
  try { content = fs.readFileSync(logPath, "utf8"); } catch { return null; }
  const lines = content.trimEnd().split("\n");
  for (let i = lines.length - 1; i >= Math.max(0, lines.length - maxLines); i--) {
    try {
      const obj = JSON.parse(lines[i]);
      if (predicate(obj)) return obj;
    } catch { /* skip malformed lines */ }
  }
  return null;
}

// Determine the run status from run-state.json and the last log event.
function computeStatus(runState, lastEvent) {
  if (!runState) return "no-run";
  const lastOutcome = lastEvent && lastEvent.outcome;
  if (lastOutcome === "complete") return "completed";
  if (lastOutcome && lastOutcome.includes("halt")) return "halted";
  // Lock removed on exit; if no lock file exists and we have a terminal event → halted/done.
  // Approximate: treat any state that has iterations > 0 and no explicit complete as "running"
  // when no obvious halt outcome was logged.
  if (lastOutcome === "halt" || lastOutcome === "convergence-halt" || lastOutcome === "ceiling-halt" ||
      lastOutcome === "budget-halt" || lastOutcome === "until-halt" || lastOutcome === "structural-halt" ||
      lastOutcome === "no-progress-halt" || lastOutcome === "max-iterations-halt" ||
      lastOutcome === "stoplist-halt") {
    return "halted";
  }
  return "running";
}

function ageStr(ms) {
  if (ms == null) return "—";
  if (ms < 1000) return `${ms}ms`;
  if (ms < 60000) return `${Math.round(ms / 1000)}s`;
  return `${Math.round(ms / 60000)}m${Math.round((ms % 60000) / 1000)}s`;
}

function workstreamText(ws) {
  if (!ws) return "—";
  const role = ws.role || ws.workstream_id || "workstream";
  return ws.host ? `${role}@${ws.host}` : role;
}

function run(positional, _flags) {
  if (_flags.help) { console.log(generateHelp("devteam status [options]", flags)); process.exit(0); }
  const cwd = _flags.cwd || process.cwd();
  const { requireProjectContext } = require(path.join(__dirname, "..", "project-guard"));
  requireProjectContext(cwd, _flags, "status");

  const { loadConfig } = require(path.join(__dirname, "..", "..", "config"));
  const { runStatePath, runLogPath } = require(path.join(__dirname, "..", "..", "driver"));

  let config;
  try { config = loadConfig(cwd); } catch { config = {}; }

  const { changeIdFromFeature } = require(path.join(__dirname, "..", "..", "config"));
  const isolation = config.pipeline && config.pipeline.isolation;
  const changeId = (isolation === "bounded" && (_flags.feature || ""))
    ? changeIdFromFeature(_flags.feature || "")
    : null;

  const statePath = runStatePath(cwd, changeId);
  const logPath = runLogPath(cwd, changeId);

  let runState = null;
  try { runState = JSON.parse(fs.readFileSync(statePath, "utf8")); } catch { /* no-run */ }

  const now = Date.now();

  // Last event (any) for last_event_age_ms.
  const lastEvent = lastMatchingEvent(logPath, () => true);
  const lastEventTs = lastEvent && lastEvent.ts ? Date.parse(lastEvent.ts) : null;
  const lastEventAgeMs = lastEventTs != null ? now - lastEventTs : null;

  // Last heartbeat event for last_heartbeat_age_ms.
  const lastHeartbeat = lastMatchingEvent(logPath, (e) => e.outcome === "heartbeat");
  const lastHeartbeatTs = lastHeartbeat && lastHeartbeat.ts ? Date.parse(lastHeartbeat.ts) : null;
  const lastHeartbeatAgeMs = lastHeartbeatTs != null ? now - lastHeartbeatTs : null;

  // stall_detected: true if the most recent dispatch-relevant event is stall-detected.
  const lastDispatchEvent = lastMatchingEvent(logPath,
    (e) => ["stall-detected", "dispatched", "transient-retry"].includes(e.outcome));
  const stallDetected = Boolean(lastDispatchEvent && lastDispatchEvent.outcome === "stall-detected");

  const status = computeStatus(runState, lastEvent);
  const costUsd = runState ? (runState.cost_usd || null) : null;
  // Phase-28 item 28.4: "observed" / "model-asserted" / "mixed", written once
  // per run onto run-state.json by core/driver.js. null before any dispatch
  // has recorded a cost, or for a run predating this field.
  const costBasis = runState ? (runState.cost_basis || null) : null;
  const tokensUsed = runState ? runState.tokens_used : null;
  const tokenBasis = runState ? (runState.token_basis || null) : null;
  const activeWorkstreams = runState && runState.active_workstreams
    ? Object.values(runState.active_workstreams)
    : [];

  const output = {
    status,
    current_stage: runState ? (runState.current_stage || null) : null,
    last_action: runState ? (runState.last_action || null) : null,
    iterations: runState ? (runState.iterations || 0) : 0,
    cost_usd: typeof costUsd === "number" ? costUsd : null,
    cost_basis: costBasis,
    tokens_used: typeof tokensUsed === "number" ? tokensUsed : null,
    token_basis: tokenBasis,
    token_coverage_complete: runState ? runState.token_coverage_complete === true : false,
    last_heartbeat_age_ms: lastHeartbeatAgeMs,
    last_event_age_ms: lastEventAgeMs,
    stall_detected: stallDetected,
    active_workstreams: activeWorkstreams,
    last_workstream: runState ? (runState.last_workstream || null) : null,
  };

  if (_flags.json) {
    console.log(JSON.stringify(output, null, 2));
    return;
  }

  process.stdout.write(`devteam status\n`);
  process.stdout.write(`  status:           ${output.status}\n`);
  process.stdout.write(`  current_stage:    ${output.current_stage || "—"}\n`);
  process.stdout.write(`  last_action:      ${output.last_action || "—"}\n`);
  process.stdout.write(`  iterations:       ${output.iterations}\n`);
  process.stdout.write(`  cost_usd:         ${output.cost_usd != null ? `$${output.cost_usd.toFixed(4)}` : "—"}\n`);
  process.stdout.write(`  cost_basis:       ${output.cost_basis || "—"}\n`);
  process.stdout.write(`  tokens_used:      ${output.tokens_used != null ? output.tokens_used.toLocaleString("en-US") : "—"}\n`);
  process.stdout.write(`  token_basis:      ${output.token_basis || "—"}\n`);
  process.stdout.write(`  token_coverage:   ${output.token_coverage_complete ? "complete" : "partial/unavailable"}\n`);
  process.stdout.write(`  active_streams:   ${output.active_workstreams.length}\n`);
  process.stdout.write(`  heartbeat_age:    ${ageStr(output.last_heartbeat_age_ms)}\n`);
  process.stdout.write(`  last_event_age:   ${ageStr(output.last_event_age_ms)}\n`);
  process.stdout.write(`  stall_detected:   ${output.stall_detected ? "yes" : "no"}\n`);
  if (_flags.verbose) {
    process.stdout.write(`  active_workstreams:\n`);
    if (output.active_workstreams.length === 0) {
      process.stdout.write(`    —\n`);
    } else {
      const now = Date.now();
      for (const ws of output.active_workstreams) {
        const started = ws.started_at ? Date.parse(ws.started_at) : null;
        const elapsed = started ? ageStr(now - started) : "—";
        process.stdout.write(`    - ${workstreamText(ws)} (${ws.workstream_id || "—"}, ${elapsed})\n`);
        if (ws.prompt_bytes != null) process.stdout.write(`      prompt: ${ws.prompt_bytes} bytes, manifest files: ${ws.context_manifest_files ?? 0}\n`);
        if (ws.log_path) process.stdout.write(`      log:  ${ws.log_path}\n`);
        if (ws.gate_path) process.stdout.write(`      gate: ${ws.gate_path}\n`);
      }
    }
    process.stdout.write(`  last_workstream:\n`);
    if (!output.last_workstream) {
      process.stdout.write(`    —\n`);
    } else {
      const ws = output.last_workstream;
      const outcome = ws.skipped ? "skipped"
        : ws.timed_out ? "timed out"
        : ws.exit_code == null ? "finished"
        : `exit ${ws.exit_code}`;
      process.stdout.write(`    ${workstreamText(ws)} (${ws.workstream_id || "—"}, ${outcome})\n`);
      if (ws.duration_ms != null) process.stdout.write(`      duration: ${ws.duration_ms}ms\n`);
      if (ws.prompt_bytes != null) process.stdout.write(`      prompt:   ${ws.prompt_bytes} bytes, manifest files: ${ws.context_manifest_files ?? 0}\n`);
      if (ws.log_path) process.stdout.write(`      log:      ${ws.log_path}\n`);
      if (ws.gate_path) process.stdout.write(`      gate:     ${ws.gate_path}\n`);
    }
  }
}

module.exports = { name, flags, run };
