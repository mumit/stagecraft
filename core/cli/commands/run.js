"use strict";

const fs   = require("node:fs");
const path = require("node:path");
const { generateHelp } = require(path.join(__dirname, "..", "flags"));
const { applyFeatureFile } = require(path.join(__dirname, "..", "feature-file"));

// Version of the `devteam run --json` summary schema. Bump on breaking changes.
// 1.1: adds advisory_blockers_count + advisory_breakdown (ADR-008 Phase 11.2).
// 1.2: adds stages_advanced + last_committed_stage_index to run-state.json (Phase 12.2).
const RUN_SCHEMA_VERSION = "1.2";

// Phase 12.3: halt codes that constitute a "clean halt" for --auto-commit.
// ceiling/until/budget are design-time stops; all other halts signal something
// that needs a human and should not trigger an unattended commit.
const AUTO_COMMIT_HALTS = new Set(["ceiling", "until", "budget"]);

function appendRunLog(logPath, entry) {
  try {
    fs.appendFileSync(logPath, JSON.stringify({ ts: new Date().toISOString(), ...entry }) + "\n");
  } catch { /* logging must never break the run */ }
}

function msLabel(ms) {
  return Number.isFinite(ms) ? `${ms} ms` : "? ms";
}

function pathSuffix(event) {
  const parts = [];
  if (event.gate_path) parts.push(`gate: ${event.gate_path}`);
  if (event.log_path) parts.push(`log: ${event.log_path}`);
  return parts.length > 0 ? ` (${parts.join(", ")})` : "";
}

function workstreamLabel(event) {
  const role = event.role || event.workstream_id || "workstream";
  return event.host ? `${role} → ${event.host}` : role;
}

const name = "run";

const flags = {
  cwd:               { type: "string",  description: "Target project directory" },
  feature:           { type: "string",  description: "Feature description" },
  "feature-file":    { type: "string",  description: "Read feature description from a UTF-8 text file" },
  repair:            { type: "string",  description: "Bug symptom for repair mode (exclusive with --feature; ADR-009)" },
  "repair-at":       { type: "string",  description: "Skip diagnosis: seed affected-files from file:line location(s) (comma-separated; ADR-009 Phase 2)" },
  track:             { type: "string",  description: "Override the pipeline track" },
  until:             { type: "string",  description: "Stop before this stage" },
  "max-iterations":  { type: "number",  description: "Iteration cap" },
  "budget-usd":      { type: "number",  description: "Cost cap in USD" },
  "timeout-ms":      { type: "number",  description: "Per-dispatch timeout (ms)" },
  "retry-delay-ms":  { type: "number",  description: "Backoff delay between transient retries (ms)" },
  "auto-rule":       { type: "list", split: true, description: "Auto-apply Principal rulings of these classes (comma-separated)" },
  "allow-stage":     { type: "list", split: true, description: "Grant consequence-ceiling approval for this stage (repeatable, comma-separated)" },
  resume:            { type: "boolean", description: "Resume an interrupted run" },
  force:             { type: "boolean", description: "Force-unlock a stale run.lock" },
  json:              { type: "boolean", description: "JSON summary on stdout" },
  // ADR-008: opt-in advisory-blocker exit code. Bare flag uses QA_BLOCKER+A11Y_FIX
  // threshold; =all also includes PEER_REVIEW_RISK. Default (no flag) exits 0.
  "fail-on-advisory": { type: "toggle", description: "Exit 3 if advisory blockers remain after pipeline-complete (=all adds PEER_REVIEW_RISK to threshold)" },
  "auto-commit":     { type: "boolean", description: "Automatically commit pipeline artifacts after a clean halt (ceiling, --until, budget)" },
  watch:             { type: "boolean", description: "Render rolling liveness status on an interactive terminal" },
  help:              { type: "boolean", description: "Show this help" },
};

// `devteam run` — bounded autonomous driver (ADR-003 / H2 Phase 1 PR-A).
// Advances the pipeline unattended on the happy path; halts cleanly at the
// first thing needing a human (a FAIL, an escalation, the consequence ceiling,
// a budget cap, or a dispatch that wrote no gate). It does NOT auto-fix or
// auto-rule yet — that is PR-B / Phase 2.
function run(positional, _flags) {
  if (_flags.help) { console.log(generateHelp("devteam run [options]", flags)); process.exit(0); }
  applyFeatureFile(_flags, "run");
  // ADR-009: --repair and --feature are mutually exclusive intents.
  if (_flags.repair && _flags.feature) {
    console.error("devteam run: --repair and --feature are mutually exclusive — a run is either a bug fix or a feature, not both");
    process.exit(1);
  }
  if (_flags.watch && _flags.json) {
    console.error("devteam run: --watch and --json are mutually exclusive");
    process.exit(2);
  }
  const cwd = _flags.cwd || process.cwd();
  const { run: runDriver } = require(path.join(__dirname, "..", "..", "driver"));
  const jsonMode = Boolean(_flags.json);
  const { createWatchRenderer } = require(path.join(__dirname, "..", "watch-renderer"));
  const watch = createWatchRenderer({ stream: process.stderr });
  const watchMode = Boolean(_flags.watch && watch.active);
  if (_flags.watch && !watch.active) {
    process.stderr.write("[devteam run] --watch requires an interactive terminal; using line progress output\n");
  }
  if (watchMode) {
    watch.start();
    process.once("exit", watch.finish);
  }

  const onEvent = (ev) => {
    if (jsonMode) return; // keep stdout clean for the JSON summary
    if (watchMode) {
      watch.handle(ev);
      return;
    }
    const tag = ev.failure_class ? `  [${ev.failure_class}]` : "";
    switch (ev.type) {
      case "dispatch":     process.stderr.write(`▶️  ${ev.name} (${ev.stage}) — dispatching…\n`); break;
      case "workstream-started":
        process.stderr.write(`   ↳ ${workstreamLabel(ev)} started${pathSuffix(ev)}\n`);
        break;
      case "workstream-finished": {
        const outcome = ev.skipped ? "skipped"
          : ev.timed_out ? "timed out"
          : ev.exit_code == null ? "finished"
          : `exit ${ev.exit_code}`;
        process.stderr.write(`   ↳ ${workstreamLabel(ev)} ${outcome} in ${msLabel(ev.duration_ms)}${pathSuffix(ev)}\n`);
        break;
      }
      case "dispatched":   process.stderr.write(`   ✓ ${ev.name} dispatched (${ev.duration_ms} ms${ev.timed_out ? ", TIMED OUT" : ""})\n`); break;
      case "merge":        process.stderr.write(`🔀 merge ${ev.name}\n`); break;
      case "complete":     process.stderr.write(`🎉 pipeline-complete\n`); break;
      case "halt":         process.stderr.write(`⏸  halt — ${ev.action}${tag}: ${ev.reason}\n`); break;
      case "ceiling":      process.stderr.write(`🛑 consequence ceiling — "${ev.name}" needs a human grant (re-run with --allow-stage ${ev.name})\n`); break;
      case "budget":       process.stderr.write(`💰 budget cap reached — halting before "${ev.name}"\n`); break;
      case "until":        process.stderr.write(`⏹  reached --until boundary\n`); break;
      case "auto-rule-dispatch": process.stderr.write(`⚖  ${ev.name} — escalation; dispatching Principal for a ruling…\n`); break;
      case "auto-ruled":   process.stderr.write(`⚖  ${ev.name} — auto-ruled [class: ${ev.grant_class}] under ${ev.authority}: ${ev.ruling}\n`); break;
      case "cannot-decide": process.stderr.write(`✋ ${ev.name} — Principal cannot decide (${ev.reason_class}); halting: ${ev.question}\n`); break;
      case "fix-retry":    process.stderr.write(`🔧 ${ev.name} — auto-fix attempt ${ev.attempt} (cleared ${ev.cleared_gates} gate(s), blockers → context.md)\n`); break;
      case "transient-retry": process.stderr.write(`↻  ${ev.name} — transient dispatch failure; retrying after ${ev.delay_ms} ms (attempt ${ev.attempt})\n`); break;
      case "structural":   process.stderr.write(`⚠  "${ev.name}" dispatched but wrote no gate and isn't transient — halting (structural-input)\n`); break;
      case "merge-failed": process.stderr.write(`❌ merge failed for "${ev.name}": ${ev.reason}\n`); break;
      default: break;
    }
  };

  runDriver({
    cwd,
    feature: _flags.feature || "",
    repair: _flags.repair || null,
    repairAt: _flags.repairAt || null,
    track: _flags.track,
    until: _flags.until,
    maxIterations: Number.isFinite(_flags.maxIterations) ? _flags.maxIterations : undefined,
    budgetUsd: Number.isFinite(_flags.budgetUsd) ? _flags.budgetUsd : undefined,
    timeoutMs: Number.isFinite(_flags.timeoutMs) ? _flags.timeoutMs : undefined,
    retryDelayMs: Number.isFinite(_flags.retryDelayMs) ? _flags.retryDelayMs : undefined,
    autoRule: _flags.autoRule || [],
    allowStages: _flags.allowStage || [],
    resume: Boolean(_flags.resume),
    force: Boolean(_flags.force),
    onEvent,
  }).then((summary) => {
    watch.finish();
    if (jsonMode) {
      console.log(JSON.stringify({ schema_version: RUN_SCHEMA_VERSION, ...summary }, null, 2));
    } else {
      const status = summary.completed ? "complete" : `halted (${summary.halt_action})`;
      process.stderr.write(
        `\n[devteam run] ${status} — ${summary.iterations} iteration(s), ` +
        `$${summary.cost_usd.toFixed(2)} spent, ${summary.stages_advanced.length} stage(s) advanced\n`,
      );
      if (summary.halted && summary.halt_reason) process.stderr.write(`  reason: ${summary.halt_reason}\n`);
      if (summary.halt_action === "fix-and-retry" || summary.halt_action === "resolve-escalation") {
        process.stderr.write(`  → run \`devteam next\` for the fix steps / escalation details\n`);
      }
    }
    // ADR-008: loud advisory line when blockers remain after a successful run.
    if (summary.completed && (summary.advisory_blockers_count || 0) > 0) {
      process.stderr.write(
        `pipeline complete — ${summary.advisory_blockers_count} advisory blocker(s) remain; run \`devteam advise\` to review\n`,
      );
    }
    // Exit 0 when the pipeline finished or stopped at a boundary the operator
    // configured (--until) or a gate they must approve (consequence ceiling).
    // Exit 1 for halts that signal something needs fixing. Exit 2 = lock error.
    // Exit 3 = pipeline complete but --fail-on-advisory threshold exceeded.
    const cleanStop = summary.completed
      || summary.halt_action === "until"
      || summary.halt_action === "ceiling";
    // ADR-008: --fail-on-advisory opt-in. Only fires on a cleanStop to preserve
    // the exit-1 contract for halts. Threshold: QA_BLOCKER+A11Y_FIX (default)
    // or all three blocker classes (=all).
    if (cleanStop && _flags.failOnAdvisory && (summary.advisory_blockers_count || 0) > 0) {
      const bd = summary.advisory_breakdown || {};
      const isAll = _flags.failOnAdvisory === "all";
      const count = (bd.QA_BLOCKER || 0) + (bd.A11Y_FIX || 0)
        + (isAll ? (bd.PEER_REVIEW_RISK || 0) : 0);
      if (count > 0) process.exit(3);
    }
    // Phase 12.3: auto-commit on clean halts. Uses the same algorithm as
    // `devteam commit` (no interactive prompt; unattended). A commit failure
    // logs auto-commit-failed and emits a loud stderr warning but does NOT
    // change the halt's exit code — the pipeline result is independent of git.
    if (_flags.autoCommit && AUTO_COMMIT_HALTS.has(summary.halt_action)) {
      const runLogFilePath = path.join(cwd, "pipeline", "run-log.jsonl");
      const { runCommit } = require(path.join(__dirname, "commit"));
      const acResult = runCommit(cwd);
      if (acResult.reason === "nothing-to-commit") {
        appendRunLog(runLogFilePath, { event: "auto-commit-skipped", reason: "nothing-to-commit" });
      } else if (acResult.committed) {
        process.stderr.write(`[auto-commit] committed ${acResult.files.length} file(s):\n`);
        for (const f of acResult.files) process.stderr.write(`  ${f}\n`);
        appendRunLog(runLogFilePath, {
          event: "auto-commit",
          staged_files: acResult.files,
          commit_hash: acResult.commitHash,
          at: new Date().toISOString(),
        });
      } else {
        process.stderr.write(`[auto-commit] WARNING: commit failed — ${acResult.reason}\n`);
        appendRunLog(runLogFilePath, { event: "auto-commit-failed", reason: acResult.reason });
      }
    }
    process.exit(cleanStop ? 0 : 1);
  }).catch((err) => {
    watch.finish();
    console.error(`devteam run: ${err.message}`);
    process.exit(err.code === "ELOCKED" ? 2 : 1);
  });
}

module.exports = { name, flags, run };
