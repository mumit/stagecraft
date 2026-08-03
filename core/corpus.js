// Run corpus — one sanitized JSONL record per headless dispatch.
// (plans/phase-28-ground-truth-telemetry.md item 28.5)
//
// The substrate for D5 (adaptive routing) and H3 (recipe factory): both are
// evidence-gated pending real dispatch history (docs/BACKLOG.md). Every
// headless dispatch through core/orchestrator.js runStageHeadless appends
// one line to .devteam/corpus/dispatches.jsonl (project-local, gitignored —
// see core/gitignore.js CANONICAL_BLOCK; corpus upload/sharing is out of
// scope, see phase-28 plan "Out of scope").
//
// Writes are fire-and-forget (appendDispatchRecord never throws): an
// unwritable corpus directory logs one warning and never fails the run —
// same contract as core/observability.js tracing and core/patterns.js
// collection.
//
// Trust boundary (rule 10, core/verify/stamp.js pattern): tokens_in/out,
// cost_usd, and model_observed prefer the gate's `_orchestrator_observed`
// block (orchestrator-parsed CLI/API output) over the model-asserted
// top-level fields, and `cost_basis` records which one won — "observed" or
// "model-asserted". `retry_of` is sourced from the model-written
// `retry_number` (there is no orchestrator-tracked per-dispatch retry-chain
// id today); it is therefore a claim, not an observation.

const fs = require("node:fs");
const path = require("node:path");
const { scanContent } = require("./hooks/secret-scan");

const FRAMEWORK_VERSION = (() => {
  try { return require("../package.json").version; } catch { return "0.0.0"; }
})();

const CORPUS_RELATIVE_DIR = path.join(".devteam", "corpus");
const CORPUS_FILE_NAME = "dispatches.jsonl";

// Every field the plan specifies, in order. Missing values are recorded as
// null, never omitted — downstream consumers (devteam corpus stats,
// scripts/routing-suggest.js) can rely on a stable shape.
const RECORD_FIELDS = [
  "ts", "run_id", "stage", "role", "host", "model_observed", "model_requested",
  "track", "prompt_hash", "prompt_bytes", "tokens_in", "tokens_out", "cost_usd",
  "cost_basis", "duration_ms", "queue_ms", "gate_status", "blockers",
  "retry_of", "framework_version",
];

function corpusDir(cwd) {
  return path.join(cwd, CORPUS_RELATIVE_DIR);
}

function corpusPath(cwd) {
  return path.join(corpusDir(cwd), CORPUS_FILE_NAME);
}

function nonNegativeNumber(value) {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : null;
}

// Reuses the secret-scan sanitizer core/patterns.js collection uses
// (core/hooks/secret-scan.js scanContent) rather than re-implementing
// detection. scanContent only returns redacted snippets/line numbers, not
// exact match offsets, so a finding redacts the whole blocker string —
// safer than attempting a partial in-place replacement and missing a
// secret that spans a boundary scanContent didn't report precisely.
function sanitizeBlockerText(text) {
  const str = typeof text === "string" ? text
    : text === null || text === undefined ? ""
    : JSON.stringify(text);
  if (!str) return str;
  const findings = scanContent(str);
  if (findings.length === 0) return str;
  const names = [...new Set(findings.map((f) => f.name))];
  return `[REDACTED: secret-like content removed (${names.join(", ")})]`;
}

function sanitizeBlockers(blockers) {
  if (!Array.isArray(blockers) || blockers.length === 0) return null;
  return blockers.map(sanitizeBlockerText);
}

function normalizeRecord(fields) {
  const record = {};
  for (const key of RECORD_FIELDS) {
    if (key === "framework_version") { record[key] = FRAMEWORK_VERSION; continue; }
    if (key === "blockers") { record[key] = sanitizeBlockers(fields.blockers); continue; }
    const value = fields[key];
    record[key] = value === undefined ? null : value;
  }
  return record;
}

/**
 * Append one sanitized dispatch record to .devteam/corpus/dispatches.jsonl.
 * Fire-and-forget: never throws. An unwritable corpus directory (missing
 * project, permissions, disk full) logs exactly one warning to stderr and
 * returns { ok: false } — callers must not treat this as a dispatch failure.
 */
function appendDispatchRecord(cwd, fields) {
  try {
    const record = normalizeRecord(fields || {});
    fs.mkdirSync(corpusDir(cwd), { recursive: true });
    fs.appendFileSync(corpusPath(cwd), `${JSON.stringify(record)}\n`, "utf8");
    return { ok: true, record };
  } catch (err) {
    process.stderr.write(`[devteam] corpus: could not write dispatch record: ${err && err.message}\n`);
    return { ok: false, error: err && err.message };
  }
}

// Per-dispatch cost/token provenance: prefer the orchestrator-observed
// figures (gate._orchestrator_observed, written by
// core/orchestrator.js patchGateForObservedUsage) over the model-asserted
// top-level gate fields. Mirrors core/driver.js costEntryForGate — kept
// as a small local copy rather than a cross-require to avoid a
// driver.js -> orchestrator.js -> corpus.js -> driver.js cycle.
function observedOrAssertedCost(gate) {
  const observed = gate && gate._orchestrator_observed;
  const observedCost = nonNegativeNumber(observed && observed.cost_usd);
  if (observedCost !== null) return { cost_usd: observedCost, cost_basis: "observed" };
  const assertedCost = nonNegativeNumber(gate && gate.cost_usd);
  if (assertedCost !== null) return { cost_usd: assertedCost, cost_basis: "model-asserted" };
  return { cost_usd: null, cost_basis: null };
}

// Token provenance is independent of cost provenance: codex, for example,
// observes tokens_in/out natively but never reports a dollar cost (see
// core/adapters/codex-exec-json.js), so gating tokens on cost_basis would
// wrongly null out a real observation. Prefer the observed count per field.
function observedOrAssertedTokens(gate) {
  const observed = gate && gate._orchestrator_observed;
  const observedIn = nonNegativeNumber(observed && observed.tokens_in);
  const observedOut = nonNegativeNumber(observed && observed.tokens_out);
  return {
    tokens_in: observedIn !== null ? observedIn : nonNegativeNumber(gate && gate.tokens_in),
    tokens_out: observedOut !== null ? observedOut : nonNegativeNumber(gate && gate.tokens_out),
  };
}

function loadGateSafe(gatePath) {
  if (!gatePath) return null;
  try {
    const raw = fs.readFileSync(gatePath, "utf8");
    const parsed = JSON.parse(raw);
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

/**
 * Record one headless dispatch. Reads the dispatch's gate file (if any) to
 * derive gate_status/blockers/model_observed/tokens/cost_usd/cost_basis,
 * merges in the caller-supplied dispatch-level fields, and appends via
 * appendDispatchRecord (fire-and-forget — see its docstring).
 */
function recordDispatch(cwd, opts = {}) {
  const gate = loadGateSafe(opts.gatePath);
  const { cost_usd, cost_basis } = observedOrAssertedCost(gate);
  const { tokens_in, tokens_out } = observedOrAssertedTokens(gate);
  const modelObserved = (gate && gate._orchestrator_observed && gate._orchestrator_observed.model_observed) || null;
  // 32.3: what routing asked for (orchestrator-set at dispatch time), as
  // opposed to modelObserved (what the host actually reported serving).
  const modelRequested = (gate && typeof gate.model_requested === "string") ? gate.model_requested : null;
  const gateStatus = (gate && typeof gate.status === "string") ? gate.status : null;
  const retryOf = (gate && typeof gate.retry_number === "number") ? gate.retry_number : null;
  const track = Array.isArray(opts.track) ? opts.track.join(",") : (opts.track || null);

  return appendDispatchRecord(cwd, {
    ts: new Date().toISOString(),
    run_id: opts.runId || null,
    stage: opts.stage || null,
    role: opts.role || null,
    host: opts.host || null,
    model_observed: modelObserved,
    model_requested: modelRequested,
    track,
    prompt_hash: opts.promptHash || null,
    prompt_bytes: nonNegativeNumber(opts.promptBytes),
    tokens_in,
    tokens_out,
    cost_usd,
    cost_basis,
    duration_ms: nonNegativeNumber(opts.durationMs),
    queue_ms: nonNegativeNumber(opts.queueMs),
    gate_status: gateStatus,
    blockers: gate && gate.blockers,
    retry_of: retryOf,
  });
}

/** Read and parse .devteam/corpus/dispatches.jsonl. Malformed lines are skipped. */
function readCorpus(cwd) {
  let raw;
  try {
    raw = fs.readFileSync(corpusPath(cwd), "utf8");
  } catch {
    return [];
  }
  const records = [];
  for (const line of raw.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    try {
      records.push(JSON.parse(trimmed));
    } catch { /* skip malformed line — a partial write must not break stats */ }
  }
  return records;
}

// Aggregate the corpus into exactly the shape D5/H3 evidence questions
// (docs/BACKLOG.md) ask for: total dispatches, per-stage pass rates, and
// per-(role, host) dispatch counts (D5's "≥5 dispatches per (role, host)
// pair" threshold, evaluated within this project only — cross-project
// aggregation is out of scope, see phase-28 plan).
function computeStats(cwd) {
  const records = readCorpus(cwd);

  const perStage = new Map();
  const perRoleHost = new Map();

  for (const r of records) {
    const stage = r.stage || "(unknown)";
    if (!perStage.has(stage)) {
      perStage.set(stage, { stage, total: 0, pass: 0, warn: 0, fail: 0, escalate: 0, no_gate: 0 });
    }
    const stageRec = perStage.get(stage);
    stageRec.total += 1;
    if (r.gate_status === "PASS") stageRec.pass += 1;
    else if (r.gate_status === "WARN") stageRec.warn += 1;
    else if (r.gate_status === "FAIL") stageRec.fail += 1;
    else if (r.gate_status === "ESCALATE") stageRec.escalate += 1;
    else stageRec.no_gate += 1;

    const role = r.role || "(unknown)";
    const host = r.host || "(unknown)";
    const key = `${role}@${host}`;
    if (!perRoleHost.has(key)) perRoleHost.set(key, { role, host, dispatches: 0 });
    perRoleHost.get(key).dispatches += 1;
  }

  const MIN_DISPATCHES_D5 = 5;
  const stages = [...perStage.values()]
    .map((s) => ({ ...s, pass_rate: s.total > 0 ? ((s.pass + s.warn) / s.total) * 100 : 0 }))
    .sort((a, b) => a.stage.localeCompare(b.stage));
  const roleHost = [...perRoleHost.values()]
    .map((rh) => ({ ...rh, meets_d5_threshold: rh.dispatches >= MIN_DISPATCHES_D5 }))
    .sort((a, b) => b.dispatches - a.dispatches);

  return {
    total_dispatches: records.length,
    stages,
    role_host: roleHost,
    d5_min_dispatches: MIN_DISPATCHES_D5,
  };
}

// Convert corpus records into the per-workstream shape
// scripts/performance.js aggregatePerformance/expandToWorkstreams already
// expects ({ workstream, host, status, cost_usd, duration_ms, model,
// timestamp, stage }), so scripts/routing-suggest.js can merge corpus
// history alongside pipeline/gates/ archives without a parallel aggregator.
function corpusRecordsToWorkstreams(records) {
  return records
    .filter((r) => r && r.role && r.host)
    .map((r) => ({
      workstream: r.role,
      host: r.host,
      status: r.gate_status || undefined,
      cost_usd: typeof r.cost_usd === "number" ? r.cost_usd : undefined,
      duration_ms: typeof r.duration_ms === "number" ? r.duration_ms : undefined,
      // 32.3: prefer the observed model (what actually served the dispatch);
      // fall back to what routing requested so hosts with no native usage
      // telemetry (gemini-cli, generic, omnigent) still contribute a model
      // to per-(role,host,model) aggregation instead of "(unspecified)".
      model: r.model_observed || r.model_requested || undefined,
      stage: r.stage || undefined,
      timestamp: r.ts || undefined,
    }));
}

module.exports = {
  CORPUS_RELATIVE_DIR,
  CORPUS_FILE_NAME,
  FRAMEWORK_VERSION,
  RECORD_FIELDS,
  corpusDir,
  corpusPath,
  sanitizeBlockerText,
  sanitizeBlockers,
  appendDispatchRecord,
  recordDispatch,
  readCorpus,
  computeStats,
  corpusRecordsToWorkstreams,
};
