"use strict";

// Run-end side effects (audit P2-2 decomposition, continued).
//
// Everything here happens after the loop has finished, the run state is saved,
// and the lock is released. Four passes, all sharing one contract: they are
// fire-and-forget. A failure is logged and swallowed, never thrown, because
// none of them may turn an otherwise-clean run into a failed one — and none of
// them touches `summary`, so the caller's return value is decided before this
// runs.
//
// Extracted from run() unchanged. The conditions, ordering, log outcomes, and
// swallow-and-log behavior are identical to the inline version; this is a
// seam, not a redesign. `run()` retains lock, loop, and final persistence
// ownership exactly as the P2-2 decomposition left it.

const fs = require("node:fs");
const path = require("node:path");

/**
 * @param {object}   ctx
 * @param {string}   ctx.cwd
 * @param {string?}  ctx.changeId
 * @param {object}   ctx.summary           decided before this runs; never mutated here
 * @param {object}   ctx.config
 * @param {boolean}  ctx.gateOnDisk        this run left at least one gate behind
 * @param {Function} ctx.logEvent          (entry) => void, already bound to cwd/changeId
 * @param {string}   ctx.pipelineRoot      resolved pipeline root for this change
 * @param {Function} ctx.collectPatterns   injectable for deterministic tests
 * @param {Function} ctx.runReflector
 * @param {Function} ctx.ingestMemory
 */
async function runEndEffects(ctx) {
  const {
    cwd, changeId, summary, config, gateOnDisk, logEvent, pipelineRoot,
    collectPatterns, runReflector, ingestMemory,
  } = ctx;

  // Phase 30 item 30.1: pattern auto-collection — closes the loop that
  // previously required a manual `devteam patterns collect`. Runs on a clean
  // completion, and on any halt where this run's gates directory holds at
  // least one gate (a halt before any stage ever wrote a gate, e.g.
  // --repair/--feature mutual exclusion or a pre-flight stoplist match, has
  // nothing to collect).
  if (summary.completed || (summary.halted && gateOnDisk)) {
    try {
      collectPatterns({ cwd, pipelineRoot });
    } catch (err) {
      logEvent({ outcome: "pattern-collect-failed", error: String((err && err.message) || err) });
    }
  }

  // Phase 30 item 30.3: opt-in run-end Reflector dispatch. Only on a clean
  // completion (not on halts — a halted run's evidence is incomplete) and only
  // when learning.reflector: true. runReflector() already never throws (see
  // core/learning/reflector.js); the try/catch is defense in depth so a future
  // defect there still cannot take down the run summary.
  if (summary.completed && config.learning.reflector === true) {
    try {
      await runReflector({ cwd, changeId, pipelineRoot, config, logEvent });
    } catch (err) {
      logEvent({ outcome: "reflector-dispatch-failed", reason: String((err && err.message) || err) });
    }
  }

  // Phase 30 item 30.4: auto-ingest at pipeline-complete — the write side of
  // the closed loop (the read side is memory retrieval into stage prompts,
  // core/orchestrator.js resolvePriorKnowledgeOpts()). Gated on
  // .devteam/memory/ already existing — the same "opted in once, stays wired
  // up" condition as the read side — so a project that has never run
  // `devteam memory ingest` sees zero behavior change (no embedder load, no
  // model download attempt) and reuses memory.inject as the single off switch
  // for both sides. Also covers an explicitly selected local provider whose
  // separately installed transformer dependency is absent.
  if (summary.completed && config.memory.inject !== false
    && fs.existsSync(path.join(cwd, ".devteam", "memory"))) {
    try {
      const result = await ingestMemory({ cwd });
      logEvent({ outcome: "memory-ingest", artifacts: result.artifacts, chunks: result.chunks });
    } catch (err) {
      logEvent({ outcome: "memory-ingest-failed", error: String((err && err.message) || err) });
    }
  }

  // Phase-33 item 33.1: resolution-linker pass. Runs whenever this run wrote at
  // least one gate (same condition as pattern auto-collection above) regardless
  // of completed/halted — a fix-retry can clear a previously-captured eval case
  // within the same run that later halts on something unrelated.
  if (gateOnDisk && config.evals.capture !== false) {
    try {
      const { linkResolutions } = require("./evals/capture");
      const result = linkResolutions(cwd, { changeId });
      if (result.linked > 0) logEvent({ outcome: "evals-resolution-linked", linked: result.linked });
    } catch (err) {
      logEvent({ outcome: "evals-resolution-link-failed", error: String((err && err.message) || err) });
    }
  }
}

module.exports = { runEndEffects };
