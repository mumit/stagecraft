"use strict";

const fs = require("node:fs");
const path = require("node:path");
const { sha256 } = require("../reproducibility");
const { readJsonLinesBounded } = require("./readers");
const { category } = require("./categories");

const HASH_PATTERN = /^sha256:[0-9a-f]{64}$/;

function canonicalize(value) {
  if (Array.isArray(value)) return value.map(canonicalize);
  if (value && typeof value === "object") {
    const result = {};
    for (const key of Object.keys(value).sort()) result[key] = canonicalize(value[key]);
    return result;
  }
  return value;
}

function sourceEventRef(event) {
  const payload = {
    outcome: event.outcome,
    ts: typeof event.ts === "string" ? event.ts : null,
    stage: category(event.stage),
    failure_class: category(event.failure_class),
    attempt: Number.isInteger(event.attempt) && event.attempt >= 0 ? event.attempt : null,
    cleared_gates: Number.isInteger(event.cleared_gates) && event.cleared_gates >= 0
      ? event.cleared_gates : null,
    derivable: event.derivable === true,
  };
  return sha256(JSON.stringify(canonicalize(payload)));
}

function schemaFingerprint(stage) {
  if (category(stage) !== stage) return null;
  const file = path.join(__dirname, "..", "gates", "schemas", `${stage}.schema.json`);
  try {
    const stat = fs.lstatSync(file);
    if (!stat.isFile() || stat.isSymbolicLink()) return null;
    return sha256(fs.readFileSync(file));
  } catch {
    return null;
  }
}

// `opts.stage` narrows the search to one stage. Without it this returns the
// newest unaccepted fix/retry, which is right when there is one — but a run
// that retried stage-04 successfully and then escalated at stage-06 leaves the
// newest slot occupied by a retry that never resolved, and assertPassingGate
// correctly refuses it. Before the selector existed there was then no way to
// accept stage-04's genuine, derivable resolution at all: the mechanism was
// blocked by an unrelated later failure. Observed on a real run, and part of
// why accepted-resolution evidence stayed at zero.
function pendingResolution(events, opts = {}) {
  const wantStage = typeof opts.stage === "string" && opts.stage ? category(opts.stage) : null;
  const accepted = new Set(events
    .filter((event) => event.outcome === "resolution-accepted" && HASH_PATTERN.test(event.source_event_sha256))
    .map((event) => event.source_event_sha256));
  for (let index = events.length - 1; index >= 0; index--) {
    const event = events[index];
    if (event.outcome !== "fix-retry") continue;
    const source_event_sha256 = sourceEventRef(event);
    if (accepted.has(source_event_sha256)) continue;
    const stage = category(event.stage);
    if (wantStage && stage !== wantStage) continue;
    const failure_class = category(event.failure_class);
    const schema_fingerprint = schemaFingerprint(stage);
    if (stage === "other" || failure_class === "other" || !schema_fingerprint) continue;
    return {
      source_event_sha256,
      stage,
      failure_class,
      schema_fingerprint,
      derivable: event.derivable === true
        || (Number.isInteger(event.cleared_gates) && event.cleared_gates > 0),
    };
  }
  return null;
}

function assertPassingGate(pipelinePath, stage) {
  const gatesPath = path.join(pipelinePath, "gates");
  let gatesStat;
  try { gatesStat = fs.lstatSync(gatesPath); } catch {
    throw new Error("cannot accept resolution: gates directory is missing");
  }
  if (!gatesStat.isDirectory() || gatesStat.isSymbolicLink()) {
    throw new Error("cannot accept resolution: gates directory must be a regular directory");
  }
  const file = path.join(gatesPath, `${stage}.json`);
  let stat;
  try { stat = fs.lstatSync(file); } catch {
    throw new Error(`cannot accept resolution: current ${stage} gate is missing`);
  }
  if (!stat.isFile() || stat.isSymbolicLink()) {
    throw new Error(`cannot accept resolution: current ${stage} gate must be a regular file`);
  }
  let gate;
  try { gate = JSON.parse(fs.readFileSync(file, "utf8")); } catch {
    throw new Error(`cannot accept resolution: current ${stage} gate is malformed`);
  }
  if (gate.stage !== stage) {
    throw new Error(`cannot accept resolution: current ${stage} gate identity does not match`);
  }
  if (gate.status !== "PASS") {
    throw new Error(`cannot accept resolution: current ${stage} gate must be PASS`);
  }
}

function appendAcceptedResolution(pipelinePath, options = {}) {
  const resolved = path.resolve(pipelinePath);
  let rootStat;
  try { rootStat = fs.lstatSync(resolved); } catch {
    throw new Error("cannot accept resolution: pipeline root is unavailable");
  }
  if (!rootStat.isDirectory() || rootStat.isSymbolicLink()) {
    throw new Error("cannot accept resolution: pipeline root must be a regular directory");
  }
  const lock = path.join(resolved, ".evidence-accept.lock");
  let lockFd;
  try {
    lockFd = fs.openSync(lock, "wx", 0o600);
  } catch (error) {
    if (error.code === "EEXIST") throw new Error("another resolution acceptance is in progress");
    throw error;
  }
  try {
    const logFile = path.join(resolved, "run-log.jsonl");
    const source = readJsonLinesBounded(logFile);
    if (!source.quality.log_present) throw new Error("cannot accept resolution: run log is missing");
    if (source.quality.malformed_records || source.quality.oversized_records
      || source.quality.unreadable_sources || source.quality.truncated_sources
      || source.quality.symlink_sources) {
      throw new Error("cannot accept resolution: run log is incomplete or invalid");
    }
    const pending = pendingResolution(source.records, { stage: options.stage });
    // When the caller did not name a stage, the newest unaccepted retry wins —
    // and that one may be an escalation that never resolved, whose gate
    // assertPassingGate will reject. Say so before throwing, naming the stages
    // that would work, rather than leaving the operator with a dead end.
    const otherStages = () => pendingResolutionStages(source.records)
      .filter((stage) => !pending || stage !== pending.stage);
    if (!pending) {
      const available = pendingResolutionStages(source.records)
        .filter((stage) => !options.stage || stage !== category(options.stage));
      const hint = available.length > 0
        ? ` Unaccepted resolutions exist for: ${available.join(", ")} — select one with --stage.`
        : "";
      throw new Error(
        (options.stage
          ? `no unaccepted fix/retry resolution is available for ${category(options.stage)}`
          : "no unaccepted fix/retry resolution is available") + hint,
      );
    }
    try {
      assertPassingGate(resolved, pending.stage);
    } catch (error) {
      const alternatives = options.stage ? [] : otherStages();
      throw alternatives.length > 0
        ? new Error(`${error.message}. Other stages have unaccepted resolutions: ${alternatives.join(", ")} — select one with --stage.`)
        : error;
    }
    const event = {
      ts: options.now || new Date().toISOString(),
      outcome: "resolution-accepted",
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

// Every stage with an unaccepted fix/retry, newest first. The CLI uses this to
// turn "no unaccepted resolution is available" into an actionable message
// naming the stages an operator could pass to --stage.
function pendingResolutionStages(events) {
  const seen = new Set();
  const stages = [];
  for (let index = events.length - 1; index >= 0; index--) {
    const pending = pendingResolution(events.slice(0, index + 1));
    if (!pending || seen.has(pending.stage)) continue;
    seen.add(pending.stage);
    stages.push(pending.stage);
  }
  return stages;
}

module.exports = {
  HASH_PATTERN,
  sourceEventRef,
  schemaFingerprint,
  pendingResolution,
  pendingResolutionStages,
  appendAcceptedResolution,
};
