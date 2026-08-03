// core/context-log.js — run-log.jsonl events for pipeline/context.md marker
// section writes/strips (phase-32-performance-parallelism.md item 32.5).
//
// [verify-first] confirmed no existing event recorded a devteam:* marker
// section write/strip — run-log.jsonl only carried run/dispatch/gate/halt
// events (core/driver.js's logEvent). 32.5(b)'s per-workstream delta section
// needs to know which sections changed and when, so this module gives every
// marker writer (core/gates/validator.js, core/driver.js) a shared,
// best-effort way to record that fact independently of driver.js's in-memory
// logEvent (validator.js runs as its own subprocess with no access to it).
//
// Fire-and-forget contract: a logging failure must never block the marker
// write that triggered it (same contract as driver.js's own logEvent).

"use strict";

const fs = require("node:fs");
const path = require("node:path");
const { pipelineRoot } = require("./paths");

/**
 * Append a context-section-change event to run-log.jsonl.
 * @param {string} cwd
 * @param {string|null} changeId
 * @param {object} entry
 * @param {"added"|"removed"|"compacted"} entry.action
 * @param {string} entry.section  devteam:<section> marker name (without the "devteam:" prefix)
 * @param {string} [entry.stage]
 */
function logContextSectionEvent(cwd, changeId, entry) {
  try {
    const p = path.join(pipelineRoot(cwd, changeId), "run-log.jsonl");
    fs.mkdirSync(path.dirname(p), { recursive: true });
    const line = JSON.stringify({
      ts: new Date().toISOString(),
      event: "context-section-change",
      action: entry.action,
      section: entry.section,
      stage: entry.stage || null,
    });
    fs.appendFileSync(p, line + "\n", "utf8");
  } catch {
    // best-effort — must never block the caller
  }
}

module.exports = { logContextSectionEvent };
