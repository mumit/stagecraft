"use strict";

// Typed record of a Principal ruling a human made and applied by hand.
//
// Phase 42.5: `--auto-rule` writes an `auto-ruled` event, so rulings the driver
// applied under a standing grant are durable evidence. A ruling the operator
// made themselves left no typed trace at all — the 2026-08-19 Phase 41 review
// recorded `granted ruling events: 0 / 1` for ADR-005 partly for that reason.
// Inferring one from prose in a gate or a commit message is exactly what the
// plan forbids, so this is the supported alternative: an explicit command.
//
// Modelled on ADR-012's `appendAcceptedResolution` (core/evidence/resolutions.js)
// and sharing its central safeguard: the record binds to a real observed halt.
// A human cannot mint ruling evidence for an escalation that never happened.

const fs = require("node:fs");
const path = require("node:path");
const { sha256 } = require("../reproducibility");
const { readJsonLinesBounded } = require("./readers");
const { category } = require("./categories");

const HASH_PATTERN = /^sha256:[0-9a-f]{64}$/;
// The class a human types is free-form by nature; `category()` collapses
// anything outside the allowed shape to "other" rather than storing raw text.
const MAX_CLASS_LENGTH = 64;

function canonicalize(value) {
  if (Array.isArray(value)) return value.map(canonicalize);
  if (value && typeof value === "object") {
    const result = {};
    for (const key of Object.keys(value).sort()) result[key] = canonicalize(value[key]);
    return result;
  }
  return value;
}

// Identity of the halt this ruling answers. Deliberately excludes `reason`
// and `blockers`: those are free-form model or operator prose, and the
// evidence boundary keeps prose out of anything durable.
function haltEventRef(event) {
  return sha256(JSON.stringify(canonicalize({
    outcome: event.outcome,
    ts: typeof event.ts === "string" ? event.ts : null,
    stage: category(event.stage),
    failure_class: category(event.failure_class),
    iteration: Number.isInteger(event.iteration) && event.iteration >= 0 ? event.iteration : null,
  })));
}

// The most recent judgment-gate halt with no ruling recorded against it.
// Mirrors pendingResolution: newest first, skipping anything already answered.
function pendingRuling(events) {
  const recorded = new Set(events
    .filter((event) => event.outcome === "ruling-recorded" && HASH_PATTERN.test(event.halt_event_sha256))
    .map((event) => event.halt_event_sha256));
  for (let index = events.length - 1; index >= 0; index--) {
    const event = events[index];
    if (event.outcome !== "halt") continue;
    if (category(event.failure_class) !== "judgment-gate") continue;
    const halt_event_sha256 = haltEventRef(event);
    if (recorded.has(halt_event_sha256)) continue;
    const stage = category(event.stage);
    if (stage === "other") continue;
    return { halt_event_sha256, stage };
  }
  return null;
}

function normalizeClass(rulingClass) {
  if (typeof rulingClass !== "string") return null;
  const trimmed = rulingClass.trim().toLowerCase();
  if (!trimmed || trimmed.length > MAX_CLASS_LENGTH) return null;
  return trimmed;
}

function appendRecordedRuling(pipelinePath, options = {}) {
  const rulingClass = normalizeClass(options.rulingClass);
  if (!rulingClass) {
    throw new Error("a ruling class is required (lowercase-kebab, e.g. formatting-only)");
  }
  const resolved = path.resolve(pipelinePath);
  let rootStat;
  try { rootStat = fs.lstatSync(resolved); } catch {
    throw new Error("cannot record ruling: pipeline root is unavailable");
  }
  if (!rootStat.isDirectory() || rootStat.isSymbolicLink()) {
    throw new Error("cannot record ruling: pipeline root must be a regular directory");
  }
  const lock = path.join(resolved, ".evidence-ruling.lock");
  let lockFd;
  try {
    lockFd = fs.openSync(lock, "wx", 0o600);
  } catch (error) {
    if (error.code === "EEXIST") throw new Error("another ruling record is in progress");
    throw error;
  }
  try {
    const logFile = path.join(resolved, "run-log.jsonl");
    const source = readJsonLinesBounded(logFile);
    if (!source.quality.log_present) throw new Error("cannot record ruling: run log is missing");
    if (source.quality.malformed_records || source.quality.oversized_records
      || source.quality.unreadable_sources || source.quality.truncated_sources
      || source.quality.symlink_sources) {
      throw new Error("cannot record ruling: run log is incomplete or invalid");
    }
    const pending = pendingRuling(source.records);
    if (!pending) throw new Error("no unrecorded judgment-gate escalation is available");
    const event = {
      ts: options.now || new Date().toISOString(),
      outcome: "ruling-recorded",
      ruling_class: category(rulingClass),
      ...pending,
    };
    const fd = fs.openSync(logFile, "a");
    try {
      fs.writeFileSync(fd, `${JSON.stringify(event)}\n`, "utf8");
      fs.fsyncSync(fd);
    } finally {
      fs.closeSync(fd);
    }
    return event;
  } finally {
    try { fs.closeSync(lockFd); } catch { /* already closed */ }
    try { fs.unlinkSync(lock); } catch { /* best-effort cleanup */ }
  }
}

module.exports = { HASH_PATTERN, haltEventRef, pendingRuling, appendRecordedRuling };
