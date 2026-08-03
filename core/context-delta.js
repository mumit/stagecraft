// core/context-delta.js — per-workstream "what changed in pipeline/context.md
// since your last dispatch" (plans/phase-32-performance-parallelism.md item
// 32.5(b)).
//
// Every dispatched stage's readFirst points the model at the whole of
// pipeline/context.md (core/pipeline/stages.js), but a long-running
// workstream (retries, multi-stage tracks) re-reads the same unchanged
// prose on every dispatch. computeContextDelta() answers, from run-log.jsonl
// history alone, "which devteam:* marker sections were added/removed/
// compacted since THIS workstream's previous dispatch" — so the rendered
// prompt (core/adapters/render-helpers.js#renderContextDelta) can tell the
// model what's new instead of relying on it to notice.
//
// Returns null on a workstream's first-ever dispatch (nothing to diff
// against — the adapter renders no delta section in that case).

"use strict";

const fs = require("node:fs");
const path = require("node:path");
const { pipelineRoot } = require("./paths");

function readRunLogEvents(cwd, changeId) {
  const p = path.join(pipelineRoot(cwd, changeId), "run-log.jsonl");
  let raw;
  try {
    raw = fs.readFileSync(p, "utf8");
  } catch {
    return [];
  }
  const events = [];
  for (const line of raw.split("\n")) {
    if (!line.trim()) continue;
    try {
      events.push(JSON.parse(line));
    } catch {
      // skip a malformed line rather than fail the whole read
    }
  }
  return events;
}

/**
 * @param {object} opts
 * @param {string} opts.cwd
 * @param {string|null} opts.changeId
 * @param {string} opts.workstreamId
 * @returns {null|{added: string[], removed: string[], compacted: string[]}}
 */
function computeContextDelta({ cwd, changeId, workstreamId }) {
  const events = readRunLogEvents(cwd, changeId);

  // Most-recent-first is not guaranteed by append order alone if two entries
  // share a timestamp, but run-log.jsonl is append-only and read in file
  // order, so the last matching entry is always the most recent dispatch.
  const priorDispatches = events.filter(
    (e) => e.type === "workstream-started" && e.workstream_id === workstreamId,
  );
  if (priorDispatches.length === 0) return null;
  const since = priorDispatches[priorDispatches.length - 1].ts;

  const added = new Set();
  const removed = new Set();
  const compacted = new Set();
  for (const e of events) {
    if (e.event !== "context-section-change") continue;
    if (typeof e.ts !== "string" || e.ts <= since) continue;
    if (e.action === "added") added.add(e.section);
    else if (e.action === "removed") removed.add(e.section);
    else if (e.action === "compacted") compacted.add(e.section);
  }

  return { added: [...added], removed: [...removed], compacted: [...compacted] };
}

module.exports = { computeContextDelta };
