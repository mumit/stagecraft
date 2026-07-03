"use strict";

const fs = require("node:fs");
const path = require("node:path");
const { gatesDir: getGatesDir, pipelineRoot } = require("../paths");

const SCHEMA_VERSION = "critical-path.v1";

function parseTs(value) {
  const ms = Date.parse(value || "");
  return Number.isFinite(ms) ? ms : null;
}

function durationLabel(ms) {
  if (ms == null) return "—";
  if (ms < 1000) return `${Math.round(ms)}ms`;
  if (ms < 60_000) return `${(ms / 1000).toFixed(1)}s`;
  return `${(ms / 60_000).toFixed(1)}m`;
}

function readJsonLines(filePath) {
  let content;
  try { content = fs.readFileSync(filePath, "utf8"); } catch { return { events: [], missing: true }; }
  const events = [];
  for (const line of content.split(/\r?\n/)) {
    if (!line.trim()) continue;
    try { events.push(JSON.parse(line)); } catch { /* ignore malformed log lines */ }
  }
  return { events, missing: false };
}

function dispatchKey(event) {
  return `${event.iteration || "?"}:${event.stage || "?"}:${event.name || event.stage || "?"}`;
}

function ensureDispatch(map, event) {
  const key = dispatchKey(event);
  if (!map.has(key)) {
    map.set(key, {
      iteration: event.iteration || null,
      stage: event.stage || null,
      name: event.name || event.stage || null,
      action: event.action || null,
      started_at: null,
      finished_at: null,
      duration_ms: null,
      queue_ms: null,
      workstreams_expected: null,
      workstreams: [],
      missing_duration_reasons: [],
    });
  }
  const rec = map.get(key);
  if (!rec.action && event.action) rec.action = event.action;
  return rec;
}

function analyzeEvents(events, opts = {}) {
  const parsed = events
    .map((event, index) => ({ event, index, ms: parseTs(event.ts) }))
    .filter((item) => item.ms !== null)
    .sort((a, b) => a.ms - b.ms || a.index - b.index);

  const dispatches = new Map();
  const activeWorkstreams = new Map();
  const retryDelays = [];
  const merges = [];
  const activeMerges = new Map();
  const missingDurationReasons = new Map();
  const addMissing = (reason) => {
    missingDurationReasons.set(reason, (missingDurationReasons.get(reason) || 0) + 1);
  };

  let runStart = null;
  let terminal = null;
  for (const { event, ms } of parsed) {
    if (event.outcome === "run-start" && runStart === null) runStart = ms;
    if (event.outcome === "complete" || /halt$/.test(event.outcome || "") || event.outcome === "halt") {
      terminal = ms;
    }

    if (event.outcome === "dispatch-started") {
      const rec = ensureDispatch(dispatches, event);
      rec.started_at = ms;
      rec.queue_ms = typeof event.queue_ms === "number" ? event.queue_ms : 0;
      continue;
    }

    if (event.outcome === "workstream-started") {
      const rec = ensureDispatch(dispatches, event);
      if (rec.started_at === null || ms < rec.started_at) rec.started_at = ms;
      const key = `${dispatchKey(event)}:${event.workstream_id || event.role || "workstream"}`;
      activeWorkstreams.set(key, { event, ms });
      continue;
    }

    if (event.outcome === "workstream-finished") {
      const rec = ensureDispatch(dispatches, event);
      const key = `${dispatchKey(event)}:${event.workstream_id || event.role || "workstream"}`;
      const start = activeWorkstreams.get(key);
      const durationMs = typeof event.duration_ms === "number"
        ? event.duration_ms
        : start ? ms - start.ms : null;
      if (durationMs === null) addMissing("workstream-finished without duration or matching start");
      rec.workstreams.push({
        workstream_id: event.workstream_id || null,
        role: event.role || null,
        host: event.host || null,
        duration_ms: durationMs,
        queue_ms: typeof event.queue_ms === "number" ? event.queue_ms : 0,
        queue_limit: typeof event.queue_limit === "number" ? event.queue_limit : null,
        exit_code: event.exit_code ?? null,
        timed_out: Boolean(event.timed_out),
        skipped: Boolean(event.skipped),
        gate_path: event.gate_path || null,
        log_path: event.log_path || null,
      });
      if (rec.finished_at === null || ms > rec.finished_at) rec.finished_at = ms;
      activeWorkstreams.delete(key);
      continue;
    }

    if (event.outcome === "dispatched") {
      const rec = ensureDispatch(dispatches, event);
      rec.finished_at = ms;
      rec.duration_ms = typeof event.duration_ms === "number" ? event.duration_ms : rec.duration_ms;
      rec.queue_ms = typeof event.queue_ms === "number" ? event.queue_ms : rec.queue_ms;
      rec.workstreams_expected = typeof event.workstreams === "number" ? event.workstreams : rec.workstreams_expected;
      continue;
    }

    if (event.outcome === "transient-retry") {
      const delayMs = typeof event.delay_ms === "number" ? event.delay_ms : null;
      retryDelays.push({
        iteration: event.iteration || null,
        stage: event.stage || null,
        name: event.name || event.stage || null,
        delay_ms: delayMs,
      });
      if (delayMs === null) addMissing("transient-retry without delay_ms");
      continue;
    }

    if (event.outcome === "merge-started") {
      activeMerges.set(dispatchKey(event), { event, ms });
      continue;
    }

    if (event.outcome === "merge-finished") {
      const started = activeMerges.get(dispatchKey(event));
      const durationMs = typeof event.duration_ms === "number"
        ? event.duration_ms
        : started ? ms - started.ms : null;
      merges.push({
        iteration: event.iteration || null,
        stage: event.stage || null,
        name: event.name || event.stage || null,
        outcome: event.merged ? "merged" : "merge-failed",
        duration_ms: durationMs,
      });
      if (durationMs === null) addMissing("merge-finished without duration or matching start");
      activeMerges.delete(dispatchKey(event));
      continue;
    }

    if (event.outcome === "merged" || event.outcome === "merge-failed") {
      if (merges.some((merge) => merge.iteration === (event.iteration || null) && merge.stage === (event.stage || null))) {
        continue;
      }
      merges.push({
        iteration: event.iteration || null,
        stage: event.stage || null,
        name: event.name || event.stage || null,
        outcome: event.outcome,
        duration_ms: null,
      });
      addMissing("merge duration not yet recorded");
    }
  }

  const rows = [...dispatches.values()].sort((a, b) => (a.iteration || 0) - (b.iteration || 0));
  for (const rec of rows) {
    if (rec.duration_ms === null && rec.started_at !== null && rec.finished_at !== null) {
      rec.duration_ms = rec.finished_at - rec.started_at;
    }
    if (rec.duration_ms === null) {
      rec.missing_duration_reasons.push("dispatch missing start or finish timestamp");
      addMissing("dispatch missing start or finish timestamp");
    }
    if (rec.queue_ms === null) {
      const queueSum = rec.workstreams.reduce((total, ws) => total + (typeof ws.queue_ms === "number" ? ws.queue_ms : 0), 0);
      rec.queue_ms = queueSum;
      if (queueSum === 0) rec.missing_duration_reasons.push("queue_ms inferred as 0 before scheduler exists");
    }
    const sum = rec.workstreams.reduce((total, ws) => total + (typeof ws.duration_ms === "number" ? ws.duration_ms : 0), 0);
    const withDuration = rec.workstreams.filter((ws) => typeof ws.duration_ms === "number").length;
    rec.workstream_compute_ms = rec.workstreams.length > 0 ? sum : null;
    rec.parallel_savings_ms = rec.duration_ms !== null && rec.workstream_compute_ms !== null
      ? Math.max(0, rec.workstream_compute_ms - rec.duration_ms)
      : null;
    rec.workstream_duration_coverage = rec.workstreams.length > 0
      ? withDuration / rec.workstreams.length
      : null;
  }

  const dispatchDurationCoverage = rows.length === 0 ? null
    : rows.filter((row) => typeof row.duration_ms === "number").length / rows.length;
  const workstreams = rows.flatMap((row) => row.workstreams);
  const workstreamDurationCoverage = workstreams.length === 0 ? null
    : workstreams.filter((ws) => typeof ws.duration_ms === "number").length / workstreams.length;
  const dispatchWallMs = rows.reduce((total, row) => total + (row.duration_ms || 0), 0);
  const retryDelayMs = retryDelays.reduce((total, row) => total + (row.delay_ms || 0), 0);
  const mergeWallMs = merges.reduce((total, row) => total + (row.duration_ms || 0), 0);
  const workstreamComputeMs = rows.reduce((total, row) => total + (row.workstream_compute_ms || 0), 0);
  const parallelSavingsMs = rows.reduce((total, row) => total + (row.parallel_savings_ms || 0), 0);
  const queueWaitMs = rows.reduce((total, row) => total + (row.queue_ms || 0), 0);

  const report = {
    schema_version: SCHEMA_VERSION,
    generated_at: opts.generatedAt || new Date().toISOString(),
    source: opts.source || null,
    status: parsed.length === 0 ? "no-run" : "ok",
    total_run_ms: runStart !== null && terminal !== null ? terminal - runStart : null,
    reported_critical_path_ms: rows.length > 0 || merges.length > 0 ? dispatchWallMs + mergeWallMs + retryDelayMs : null,
    dispatch_wall_ms: rows.length > 0 ? dispatchWallMs : null,
    merge_wall_ms: merges.length > 0 ? mergeWallMs : null,
    workstream_compute_ms: workstreams.length > 0 ? workstreamComputeMs : null,
    parallel_savings_ms: rows.length > 0 ? parallelSavingsMs : null,
    retry_delay_ms: retryDelayMs,
    queue_wait_ms: queueWaitMs,
    telemetry_coverage: {
      dispatch_duration: dispatchDurationCoverage,
      workstream_duration: workstreamDurationCoverage,
    },
    missing_duration_reasons: [...missingDurationReasons.entries()].map(([reason, count]) => ({ reason, count })),
    dispatches: rows,
    retry_delays: retryDelays,
    merges,
    verification_reuse_candidates: opts.verificationReuseCandidates || [],
  };

  if (report.status === "no-run") {
    report.missing_duration_reasons.push({ reason: "run-log.jsonl not found or empty", count: 1 });
  }
  return report;
}

function collectVerificationReuseCandidates(cwd, changeId = null) {
  const dir = getGatesDir(cwd, changeId);
  let files;
  try { files = fs.readdirSync(dir).filter((name) => name.endsWith(".json")); } catch { return []; }
  const groups = new Map();
  for (const file of files) {
    let gate;
    try { gate = JSON.parse(fs.readFileSync(path.join(dir, file), "utf8")); } catch { continue; }
    const runs = gate && gate._orchestrator_stamped && gate._orchestrator_stamped.runs;
    if (!runs || typeof runs !== "object") continue;
    for (const [runId, run] of Object.entries(runs)) {
      const entries = [];
      if (run && typeof run.command === "string") {
        entries.push({ command: run.command, duration_ms: run.duration_ms });
      }
      if (run && Array.isArray(run.suites)) {
        for (const suite of run.suites) {
          if (suite && typeof suite.command === "string") {
            entries.push({ command: suite.command, duration_ms: suite.duration_ms });
          }
        }
      }
      for (const entry of entries) {
        if (!groups.has(entry.command)) groups.set(entry.command, []);
        groups.get(entry.command).push({
          stage: gate.stage || null,
          gate: file,
          run: runId,
          duration_ms: typeof entry.duration_ms === "number" ? entry.duration_ms : null,
        });
      }
    }
  }
  return [...groups.entries()]
    .filter(([, runs]) => runs.length > 1)
    .map(([command, runs]) => {
      const durations = runs.map((run) => run.duration_ms).filter((value) => typeof value === "number");
      const total = durations.reduce((sum, value) => sum + value, 0);
      const max = durations.length > 0 ? Math.max(...durations) : null;
      return {
        command,
        occurrences: runs.length,
        observed_duration_ms: durations.length > 0 ? total : null,
        estimated_reuse_savings_ms: max === null ? null : Math.max(0, total - max),
        runs,
      };
    })
    .sort((a, b) => b.occurrences - a.occurrences || a.command.localeCompare(b.command));
}

function analyzeProject(cwd, { changeId = null, generatedAt } = {}) {
  const logPath = path.join(pipelineRoot(cwd, changeId), "run-log.jsonl");
  const { events, missing } = readJsonLines(logPath);
  const verificationReuseCandidates = collectVerificationReuseCandidates(cwd, changeId);
  const report = analyzeEvents(events, {
    generatedAt,
    source: path.relative(cwd, logPath).replace(/\\/g, "/"),
    verificationReuseCandidates,
  });
  if (missing) report.status = "no-run";
  return report;
}

function renderMarkdown(report) {
  const out = [];
  out.push("# devteam performance — critical path");
  out.push("");
  out.push(`Generated: ${report.generated_at}`);
  if (report.source) out.push(`Source: \`${report.source}\``);
  out.push("");

  if (report.status === "no-run") {
    out.push("_No run-log events found. Run `devteam run` first, or pass `--feature` for a bounded run._");
    return out.join("\n") + "\n";
  }

  out.push("## Summary");
  out.push("");
  out.push(`- Total run wall time: ${durationLabel(report.total_run_ms)}`);
  out.push(`- Reported critical path: ${durationLabel(report.reported_critical_path_ms)}`);
  out.push(`- Dispatch wall time: ${durationLabel(report.dispatch_wall_ms)}`);
  out.push(`- Merge wall time: ${durationLabel(report.merge_wall_ms)}`);
  out.push(`- Parallel workstream compute: ${durationLabel(report.workstream_compute_ms)}`);
  out.push(`- Estimated parallel savings: ${durationLabel(report.parallel_savings_ms)}`);
  out.push(`- Queue wait time: ${durationLabel(report.queue_wait_ms)}`);
  out.push(`- Retry delay time: ${durationLabel(report.retry_delay_ms)}`);
  out.push("");

  out.push("## Dispatches");
  out.push("");
  out.push("| Iteration | Stage | Action | Wall | Queue | Workstreams | Workstream compute | Parallel savings | Coverage |");
  out.push("|---:|---|---|---:|---:|---:|---:|---:|---:|");
  for (const row of report.dispatches) {
    const coverage = row.workstream_duration_coverage === null ? "—" : `${Math.round(row.workstream_duration_coverage * 100)}%`;
    out.push(`| ${row.iteration ?? "—"} | ${row.name || row.stage || "—"} | ${row.action || "—"} | ${durationLabel(row.duration_ms)} | ${durationLabel(row.queue_ms)} | ${row.workstreams.length} | ${durationLabel(row.workstream_compute_ms)} | ${durationLabel(row.parallel_savings_ms)} | ${coverage} |`);
  }
  out.push("");

  if (report.verification_reuse_candidates.length > 0) {
    out.push("## Verification Reuse Candidates");
    out.push("");
    out.push("| Command | Occurrences | Observed duration | Estimated reuse savings |");
    out.push("|---|---:|---:|---:|");
    for (const row of report.verification_reuse_candidates) {
      out.push(`| \`${row.command}\` | ${row.occurrences} | ${durationLabel(row.observed_duration_ms)} | ${durationLabel(row.estimated_reuse_savings_ms)} |`);
    }
    out.push("");
  }

  out.push("## Telemetry Coverage");
  out.push("");
  const dc = report.telemetry_coverage.dispatch_duration;
  const wc = report.telemetry_coverage.workstream_duration;
  out.push(`- Dispatch duration coverage: ${dc === null ? "—" : `${Math.round(dc * 100)}%`}`);
  out.push(`- Workstream duration coverage: ${wc === null ? "—" : `${Math.round(wc * 100)}%`}`);
  if (report.missing_duration_reasons.length > 0) {
    out.push("- Missing or inferred telemetry:");
    for (const item of report.missing_duration_reasons) {
      out.push(`  - ${item.reason} (${item.count})`);
    }
  }

  return out.join("\n") + "\n";
}

module.exports = {
  SCHEMA_VERSION,
  analyzeEvents,
  analyzeProject,
  collectVerificationReuseCandidates,
  durationLabel,
  readJsonLines,
  renderMarkdown,
};
