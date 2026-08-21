"use strict";

const fs = require("node:fs");
const path = require("node:path");
const { StringDecoder } = require("node:string_decoder");

const DEFAULT_MAX_LOG_BYTES = 10_000_000;
const DEFAULT_MAX_LINE_BYTES = 256_000;
const DEFAULT_MAX_GATE_BYTES = 1_000_000;
const DEFAULT_MAX_GATE_FILES = 10_000;
const READ_CHUNK_BYTES = 64 * 1024;

function emptyQuality() {
  return {
    log_present: false,
    gate_files: 0,
    malformed_records: 0,
    oversized_records: 0,
    unreadable_sources: 0,
    truncated_sources: 0,
    symlink_sources: 0,
  };
}

function mergeQuality(target, source) {
  for (const [key, value] of Object.entries(source)) {
    if (typeof value === "boolean") target[key] = target[key] || value;
    else target[key] = (target[key] || 0) + value;
  }
  return target;
}

function parseLine(line, records, quality) {
  if (!line.trim()) return;
  if (Buffer.byteLength(line, "utf8") > quality.max_line_bytes) {
    quality.oversized_records += 1;
    return;
  }
  try {
    const value = JSON.parse(line);
    if (!value || typeof value !== "object" || Array.isArray(value)) {
      quality.malformed_records += 1;
      return;
    }
    records.push(value);
  } catch {
    quality.malformed_records += 1;
  }
}

function readJsonLinesBounded(file, opts = {}) {
  const maxBytes = opts.maxBytes ?? DEFAULT_MAX_LOG_BYTES;
  const maxLineBytes = opts.maxLineBytes ?? DEFAULT_MAX_LINE_BYTES;
  const records = [];
  const quality = {
    log_present: false,
    malformed_records: 0,
    oversized_records: 0,
    unreadable_sources: 0,
    truncated_sources: 0,
    symlink_sources: 0,
    max_line_bytes: maxLineBytes,
  };

  let stat;
  try {
    stat = fs.lstatSync(file);
  } catch (error) {
    if (error.code !== "ENOENT") quality.unreadable_sources += 1;
    delete quality.max_line_bytes;
    return { records, quality };
  }
  quality.log_present = true;
  if (stat.isSymbolicLink()) {
    quality.symlink_sources += 1;
    delete quality.max_line_bytes;
    return { records, quality };
  }
  if (!stat.isFile()) {
    quality.unreadable_sources += 1;
    delete quality.max_line_bytes;
    return { records, quality };
  }

  let fd;
  try {
    fd = fs.openSync(file, "r");
    const limit = Math.min(stat.size, maxBytes);
    const buffer = Buffer.allocUnsafe(Math.min(READ_CHUNK_BYTES, Math.max(limit, 1)));
    let bytesReadTotal = 0;
    let pending = "";
    let discardingOversizedLine = false;
    const decoder = new StringDecoder("utf8");
    while (bytesReadTotal < limit) {
      const toRead = Math.min(buffer.length, limit - bytesReadTotal);
      const bytesRead = fs.readSync(fd, buffer, 0, toRead, bytesReadTotal);
      if (bytesRead === 0) break;
      bytesReadTotal += bytesRead;
      let chunk = decoder.write(buffer.subarray(0, bytesRead));
      if (discardingOversizedLine) {
        const newline = chunk.indexOf("\n");
        if (newline === -1) continue;
        chunk = chunk.slice(newline + 1);
        discardingOversizedLine = false;
      }
      pending += chunk;
      const lines = pending.split("\n");
      pending = lines.pop();
      for (const line of lines) parseLine(line, records, quality);
      if (Buffer.byteLength(pending, "utf8") > maxLineBytes) {
        quality.oversized_records += 1;
        pending = "";
        discardingOversizedLine = true;
      }
    }
    if (stat.size > maxBytes) quality.truncated_sources += 1;
    else {
      pending += decoder.end();
      if (pending && !discardingOversizedLine) parseLine(pending, records, quality);
    }
  } catch {
    quality.unreadable_sources += 1;
  } finally {
    if (fd !== undefined) fs.closeSync(fd);
  }
  delete quality.max_line_bytes;
  return { records, quality };
}

function gateCandidates(gatesPath, maxFiles) {
  const candidates = [];
  const quality = { unreadable_sources: 0, symlink_sources: 0 };
  for (const [dir, source] of [[gatesPath, "current"], [path.join(gatesPath, "archive"), "archive"]]) {
    let stat;
    try { stat = fs.lstatSync(dir); } catch (error) {
      if (error.code !== "ENOENT") quality.unreadable_sources += 1;
      continue;
    }
    if (stat.isSymbolicLink()) {
      quality.symlink_sources += 1;
      continue;
    }
    if (!stat.isDirectory()) {
      quality.unreadable_sources += 1;
      continue;
    }
    let names;
    try { names = fs.readdirSync(dir).sort(); } catch {
      quality.unreadable_sources += 1;
      continue;
    }
    for (const name of names) {
      if (!name.endsWith(".json")) continue;
      candidates.push({ file: path.join(dir, name), source });
      if (candidates.length > maxFiles) {
        return { candidates: candidates.slice(0, maxFiles), truncated: true, quality };
      }
    }
  }
  return { candidates, truncated: false, quality };
}

function readGatesBounded(gatesPath, opts = {}) {
  const maxFiles = opts.maxFiles ?? DEFAULT_MAX_GATE_FILES;
  const maxGateBytes = opts.maxGateBytes ?? DEFAULT_MAX_GATE_BYTES;
  const records = [];
  const quality = emptyQuality();
  const { candidates, truncated, quality: candidateQuality } = gateCandidates(gatesPath, maxFiles);
  mergeQuality(quality, candidateQuality);
  if (truncated) quality.truncated_sources += 1;

  for (const candidate of candidates) {
    let stat;
    try { stat = fs.lstatSync(candidate.file); } catch {
      quality.unreadable_sources += 1;
      continue;
    }
    if (stat.isSymbolicLink()) {
      quality.symlink_sources += 1;
      continue;
    }
    if (!stat.isFile()) {
      quality.unreadable_sources += 1;
      continue;
    }
    quality.gate_files += 1;
    if (stat.size > maxGateBytes) {
      quality.oversized_records += 1;
      continue;
    }
    try {
      const gate = JSON.parse(fs.readFileSync(candidate.file, "utf8"));
      if (!gate || typeof gate !== "object" || Array.isArray(gate)) {
        quality.malformed_records += 1;
        continue;
      }
      records.push({ gate, source: candidate.source, source_id: path.basename(candidate.file) });
    } catch {
      quality.malformed_records += 1;
    }
  }
  return { records, quality };
}

function readEvidenceSources(pipelinePath, opts = {}) {
  try {
    const rootStat = fs.lstatSync(pipelinePath);
    if (rootStat.isSymbolicLink()) {
      return { events: [], gates: [], quality: { ...emptyQuality(), symlink_sources: 1 } };
    }
    if (!rootStat.isDirectory()) {
      return { events: [], gates: [], quality: { ...emptyQuality(), unreadable_sources: 1 } };
    }
  } catch (error) {
    if (error.code === "ENOENT") return { events: [], gates: [], quality: emptyQuality() };
    return { events: [], gates: [], quality: { ...emptyQuality(), unreadable_sources: 1 } };
  }
  const log = readJsonLinesBounded(path.join(pipelinePath, "run-log.jsonl"), opts.log);
  const gates = readGatesBounded(path.join(pipelinePath, "gates"), opts.gates);
  const quality = emptyQuality();
  mergeQuality(quality, log.quality);
  mergeQuality(quality, gates.quality);
  return { events: log.records, gates: gates.records, quality };
}

// 42.5: dispatches made outside a run. `devteam stage --headless` records a
// corpus entry with run_id null (core/orchestrator.js passes opts.runId, which
// only the driver sets) and writes no run-log event, so run-log-derived
// evidence cannot count it. Reuses the corpus reader rather than parsing the
// file again — it already tolerates a partial trailing write.
function countDispatchesOutsideRun(cwd) {
  if (!cwd) return null;
  try {
    const { readCorpus } = require("../corpus");
    return readCorpus(cwd).filter((record) => !record || !record.run_id).length;
  } catch {
    return null; // absent or unreadable corpus is "not consulted", not zero
  }
}

// Signals that a project already produced evidence before this moment. Used to
// catch a minted-too-late identity: the id is what ties a project's bundles
// together across checkouts, and `getOrCreateIdentity` silently mints a fresh
// one whenever the file is absent. A clone, a cleaned `.devteam/`, or a restore
// done one command too late therefore yields a *different* project_ref with no
// indication anything went wrong — and bundles exported under it read as a
// second, independent project, inflating every `N / 2` readiness threshold.
//
// Cheap by construction: existence and length checks only, no parsing.
function priorEvidenceSummary(cwd, changeId = null) {
  const summary = { dispatches: 0, gates: 0, run_log: false, any: false };
  if (!cwd) return summary;
  try {
    const { pipelineRoot } = require("../paths");
    const root = pipelineRoot(cwd, changeId);
    try {
      const raw = fs.readFileSync(path.join(root, "run-log.jsonl"), "utf8");
      summary.run_log = raw.trim().length > 0;
    } catch { /* absent */ }
    try {
      summary.gates = fs.readdirSync(path.join(root, "gates"))
        .filter((name) => name.endsWith(".json") && !name.includes(".attempt-")).length;
    } catch { /* absent */ }
  } catch { /* unresolvable pipeline root */ }
  try {
    const { readCorpus } = require("../corpus");
    summary.dispatches = readCorpus(cwd).length;
  } catch { /* absent or unreadable */ }
  summary.any = summary.dispatches > 0 || summary.gates > 0 || summary.run_log;
  return summary;
}

module.exports = {
  countDispatchesOutsideRun,
  priorEvidenceSummary,
  DEFAULT_MAX_LOG_BYTES,
  DEFAULT_MAX_LINE_BYTES,
  DEFAULT_MAX_GATE_BYTES,
  DEFAULT_MAX_GATE_FILES,
  readJsonLinesBounded,
  readGatesBounded,
  readEvidenceSources,
};
