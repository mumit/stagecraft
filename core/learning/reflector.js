// core/learning/reflector.js
//
// Phase 30 item 30.3 — ACE-lite Reflector pass (Zhang et al., "Agentic
// Context Engineering", arXiv:2510.04618): the Reflector distills execution
// feedback (what was tried, what passed/failed) into itemized delta
// proposals; the Curator — here, the existing human `devteam patterns
// promote` flow — decides what actually lands. This module is the Reflector
// half only; nothing here promotes a pattern automatically (see
// plans/phase-30-closed-learning-loop.md's "Out of scope").
//
// Opt-in (learning.reflector: true in .devteam/config.yml). The driver
// (core/driver.js) calls runReflector() once per run, after auto-collection
// (core/patterns.js collect()), only on a clean pipeline-complete. Dispatch
// follows the same routing precedence as any role (routing.roles.reflector →
// routing.default_host) so it can be routed to a cheap model, but it is NOT
// a stage dispatch: there is no descriptor/gate-footer rendering (that would
// tell the model to write a gate, which this explicitly isn't) — the prompt
// is assembled here from the role brief plus inline run context, and the
// headless command is spawned directly (same pattern as core/a11y-fixer.js's
// one-off remediation dispatch).
//
// Fire-and-forget contract: any failure — no adapter, no headlessCommand,
// spawn error, non-zero exit, invalid JSON, or schema-invalid JSON — is
// logged as exactly one run-log event and never throws. The caller (driver)
// still wraps the call in try/catch as defense in depth, but runReflector()
// itself resolves in every case.

"use strict";

const fs = require("node:fs");
const path = require("node:path");
const { spawn } = require("node:child_process");
const { splitCommand } = require("../command-line");
const { resolveHost } = require("../config");
const { loadAdapter } = require("../router");
const { gatesDir } = require("../paths");
const patterns = require("../patterns");
const { validateCandidatesDelta } = require("./validate-candidates-delta");

const ROLE_BRIEF_PATH = path.join(__dirname, "..", "..", "roles", "reflector.md");
const DEFAULT_TIMEOUT_MS = 5 * 60 * 1000; // one-shot advisory call — shorter than a build stage's default

// Budget guards: this is a single embedded-context prompt, not a tool-using
// session, so the run-log/gates excerpts are capped rather than included in
// full (a long-running or heavily-retried run could otherwise blow well past
// prompt-budget discipline for a call that's supposed to be cheap).
const MAX_RUN_LOG_EVENTS = 200;
const MAX_GATE_SUMMARIES = 40;

function readRoleBrief() {
  try {
    return fs.readFileSync(ROLE_BRIEF_PATH, "utf8").trim();
  } catch {
    return "";
  }
}

function readRunLogEvents(root) {
  const file = path.join(root, "run-log.jsonl");
  if (!fs.existsSync(file)) return [];
  const events = [];
  for (const line of fs.readFileSync(file, "utf8").split(/\r?\n/)) {
    if (!line.trim()) continue;
    try {
      const ev = JSON.parse(line);
      if (ev && ev.outcome && ev.outcome !== "heartbeat") events.push(ev);
    } catch {
      // ignore malformed run-log line
    }
  }
  return events.slice(-MAX_RUN_LOG_EVENTS);
}

function readGateSummaries(cwd, changeId) {
  const dir = gatesDir(cwd, changeId);
  let names;
  try {
    names = fs.readdirSync(dir);
  } catch {
    return [];
  }
  const summaries = [];
  for (const name of names.filter((n) => n.endsWith(".json") && !n.includes(".attempt-"))) {
    try {
      const gate = JSON.parse(fs.readFileSync(path.join(dir, name), "utf8"));
      summaries.push({
        file: name,
        stage: gate.stage || null,
        workstream: gate.workstream || null,
        status: gate.status || null,
        blockers: gate.blockers || [],
        warnings: gate.warnings || [],
      });
    } catch {
      // skip unreadable/malformed gate file
    }
    if (summaries.length >= MAX_GATE_SUMMARIES) break;
  }
  return summaries;
}

function buildPrompt({ cwd, pipelineRoot, changeId }) {
  const brief = readRoleBrief();
  const gates = readGateSummaries(cwd, changeId);
  const events = readRunLogEvents(pipelineRoot);
  const promoted = patterns.loadPromoted(cwd).map((p) => ({
    id: p.id,
    tier: p.tier,
    domain: p.domain,
    prompt_text: p.prompt_text,
    stats: p.stats,
  }));

  return [
    brief,
    "",
    "## This run's gates",
    "```json",
    JSON.stringify(gates, null, 2),
    "```",
    "",
    "## This run's log events (run-log.jsonl, heartbeats stripped)",
    "```json",
    JSON.stringify(events, null, 2),
    "```",
    "",
    "## Currently promoted patterns",
    "```json",
    JSON.stringify(promoted, null, 2),
    "```",
    "",
    "Output ONLY the JSON object described in your brief. No prose, no markdown fences, no commentary before or after.",
  ].join("\n");
}

// Models sometimes wrap JSON in a markdown fence despite instructions not
// to. Strip one, defensively, before parsing — anything else non-JSON still
// fails JSON.parse and is discarded whole below.
function stripFences(text) {
  const trimmed = String(text || "").trim();
  const fenced = trimmed.match(/^```(?:json)?\s*([\s\S]*?)\s*```$/);
  return fenced ? fenced[1].trim() : trimmed;
}

function dispatch(cmdString, cwd, prompt, timeoutMs) {
  return new Promise((resolve) => {
    let bin, args;
    try {
      ({ bin, args } = splitCommand(cmdString, "headlessCommand"));
    } catch (err) {
      resolve({ ok: false, reason: `invalid headlessCommand "${cmdString}": ${err.message}` });
      return;
    }

    let child;
    try {
      child = spawn(bin, args, { cwd, stdio: ["pipe", "pipe", "ignore"] });
    } catch (err) {
      resolve({ ok: false, reason: `failed to spawn "${bin}": ${err.message}` });
      return;
    }

    let stdout = "";
    let settled = false;
    const finish = (result) => {
      if (settled) return;
      settled = true;
      if (timer) clearTimeout(timer);
      resolve(result);
    };

    const timer = timeoutMs > 0 ? setTimeout(() => {
      try { child.kill("SIGTERM"); } catch { /* already gone */ }
      finish({ ok: false, reason: "reflector dispatch timed out" });
    }, timeoutMs) : null;
    if (timer) timer.unref();

    child.stdout.on("data", (chunk) => { stdout += chunk; });
    child.on("error", (err) => finish({ ok: false, reason: `failed to spawn "${bin}": ${err.message}` }));
    child.stdin.on("error", () => { /* swallow EPIPE when child exits early */ });
    child.stdin.write(prompt);
    child.stdin.end();
    child.on("close", (exitCode) => {
      if (exitCode !== 0) {
        finish({ ok: false, reason: `reflector dispatch exited ${exitCode}` });
        return;
      }
      finish({ ok: true, stdout });
    });
  });
}

// opts:
//   cwd, changeId, pipelineRoot, config — same shapes as core/driver.js's run()
//   logEvent(entry)  — appends one run-log.jsonl event (default: no-op)
//   timeoutMs        — override DEFAULT_TIMEOUT_MS (tests)
//
// Never throws. Returns a result object describing what happened; callers
// that don't care can ignore the return value entirely.
async function runReflector(opts = {}) {
  const { cwd, changeId = null, pipelineRoot: root, config } = opts;
  const log = typeof opts.logEvent === "function" ? opts.logEvent : () => {};

  let hostName, adapter;
  try {
    hostName = resolveHost(config, undefined, "reflector");
    adapter = loadAdapter(hostName);
  } catch (err) {
    log({ outcome: "reflector-dispatch-failed", reason: err.message });
    return { ok: false, reason: err.message };
  }

  if (!adapter.capabilities || !adapter.capabilities.headless) {
    const reason = `host "${hostName}" does not support headless (capabilities.headless is false)`;
    log({ outcome: "reflector-dispatch-failed", reason });
    return { ok: false, reason };
  }

  const cmdString = process.env.DEVTEAM_HEADLESS_COMMAND || adapter.capabilities.headlessCommand;
  if (!cmdString) {
    const reason = `host "${hostName}" declares no headlessCommand`;
    log({ outcome: "reflector-dispatch-failed", reason });
    return { ok: false, reason };
  }

  const prompt = buildPrompt({ cwd, pipelineRoot: root, changeId });
  const timeoutMs = typeof opts.timeoutMs === "number" ? opts.timeoutMs : DEFAULT_TIMEOUT_MS;
  const dispatched = await dispatch(cmdString, cwd, prompt, timeoutMs);
  if (!dispatched.ok) {
    log({ outcome: "reflector-dispatch-failed", reason: dispatched.reason });
    return dispatched;
  }

  let payload;
  try {
    payload = JSON.parse(stripFences(dispatched.stdout));
  } catch (err) {
    log({ outcome: "reflector-output-malformed", reason: `invalid JSON: ${err.message}` });
    return { ok: false, reason: `invalid JSON: ${err.message}` };
  }

  const { ok: valid, errors } = validateCandidatesDelta(payload);
  if (!valid) {
    log({ outcome: "reflector-output-malformed", reason: errors.join("; ") });
    return { ok: false, reason: errors.join("; ") };
  }

  const ingested = patterns.ingestReflectorCandidates({ cwd, candidates: payload.new_candidates });
  log({
    outcome: "reflector-proposal",
    new_candidates_proposed: payload.new_candidates.length,
    new_candidates_added: ingested.added,
    // counter_adjustments / dedup_merges are advisory-only (no auto-apply —
    // see the module header and plans/phase-30-closed-learning-loop.md's
    // "Out of scope"): recorded here for audit/visibility, actioned (if at
    // all) by an operator through the existing promote/retire/demote flow.
    counter_adjustments: payload.counter_adjustments,
    dedup_merges: payload.dedup_merges,
  });
  return { ok: true, added: ingested.added };
}

module.exports = { runReflector, buildPrompt, stripFences };
