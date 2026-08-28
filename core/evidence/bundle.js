"use strict";

const fs = require("node:fs");
const path = require("node:path");
const { sha256 } = require("../reproducibility");
const { category } = require("./categories");

const EXPORT_SCHEMA_VERSION = "1.0";
const MIN_EXPORT_CELL = 3;
const MAX_BUNDLE_BYTES = 1_000_000;
const HASH_PATTERN = /^sha256:[0-9a-f]{64}$/;
const DATE_PATTERN = /^\d{4}-\d{2}-\d{2}$/;
const VERSION_PATTERN = /^\d+\.\d+\.\d+(?:[-+][A-Za-z0-9.-]+)?$/;

function canonicalize(value) {
  if (Array.isArray(value)) return value.map(canonicalize);
  if (value && typeof value === "object") {
    const result = {};
    for (const key of Object.keys(value).sort()) result[key] = canonicalize(value[key]);
    return result;
  }
  return value;
}

function payloadDigest(bundleWithoutDigest) {
  return sha256(JSON.stringify(canonicalize(bundleWithoutDigest)));
}

function suppressRows(rows, countKey) {
  const included = [];
  let suppressed = 0;
  for (const row of rows) {
    if (row[countKey] < MIN_EXPORT_CELL) suppressed += row[countKey];
    else included.push(row);
  }
  return { included, suppressed };
}

function copyRouting(row) {
  return {
    role: row.role, host: row.host, model: row.model,
    gate_observations: row.gate_observations,
    pass: row.pass, warn: row.warn, fail: row.fail, escalate: row.escalate,
    cost_observations: row.cost_observations, total_cost_usd: row.total_cost_usd,
    duration_observations: row.duration_observations, total_duration_ms: row.total_duration_ms,
    prompt_observations: row.prompt_observations || 0, total_prompt_bytes: row.total_prompt_bytes || 0,
  };
}

function copyRecovery(row) {
  return {
    stage: row.stage, failure_class: row.failure_class,
    observations: row.observations, runs: row.runs,
  };
}

function copyResolution(row) {
  return {
    stage: row.stage,
    failure_class: row.failure_class,
    schema_fingerprint: row.schema_fingerprint,
    observations: row.observations,
    derivable: row.derivable,
  };
}

function copyRuling(row) {
  return { ruling_class: row.ruling_class, observations: row.observations };
}

function copyStall(row) {
  return { stage: row.stage, stall_class: row.stall_class, observations: row.observations };
}

function copyReadiness(item) {
  return {
    capability: item.capability,
    issue: item.issue,
    status: item.status,
    portfolio_status: item.portfolio_status,
    local_conditions: item.local_conditions.map((condition) => ({
      id: condition.id,
      value: condition.value,
      threshold: condition.threshold,
      met: condition.met,
      reason_code: condition.reason_code,
    })),
    portfolio_reason_code: item.portfolio_reason_code,
  };
}

function createBundle(report, projectRef, opts = {}) {
  if (!HASH_PATTERN.test(projectRef)) throw new Error("invalid evidence project reference");
  const routingResult = suppressRows(report.routing.map(copyRouting), "gate_observations");
  const recoveryResult = suppressRows(report.recovery.map(copyRecovery), "observations");
  const resolutionResult = suppressRows((report.resolutions || []).map(copyResolution), "observations");
  const rulingResult = suppressRows(report.rulings.map(copyRuling), "observations");
  // 42.5: separate population from `rulings` — an auto-applied ruling and a
  // hand-recorded one answer different questions (see the analyzer).
  const recordedRulingResult = suppressRows((report.recorded_rulings || []).map(copyRuling), "observations");
  const stallResult = suppressRows(report.stalls.map(copyStall), "observations");
  const packageVersion = opts.stagecraftVersion || require("../../package.json").version;
  const generatedDate = opts.generatedDate || new Date().toISOString().slice(0, 10);
  const quality = report.quality;
  const payload = {
    schema_version: EXPORT_SCHEMA_VERSION,
    stagecraft_version: packageVersion,
    generated_date: generatedDate,
    project_ref: projectRef,
    scope: {
      project_count: 1,
      run_count: report.scope.run_count,
      complete_run_count: report.scope.complete_run_count,
      repair_run_count: report.scope.repair_run_count,
    },
    quality: {
      log_present: quality.log_present,
      gate_files: quality.gate_files,
      malformed_records: quality.malformed_records,
      oversized_records: quality.oversized_records,
      unreadable_sources: quality.unreadable_sources,
      truncated_sources: quality.truncated_sources,
      symlink_sources: quality.symlink_sources,
      orphan_events: quality.orphan_events,
      cost_coverage_dispatches: report.routing.reduce(
        (sum, row) => sum + row.cost_observations, 0,
      ),
      durable_dispatch_observations: quality.durable_dispatch_observations || 0,
      // 42.5: only when the corpus was actually consulted. Omitted rather than
      // zero-filled otherwise, so "no dispatches outside a run" stays distinct
      // from "this export could not tell" — the same distinction the cache
      // counters keep.
      ...(typeof quality.dispatches_outside_run === "number"
        ? { dispatches_outside_run: quality.dispatches_outside_run }
        : {}),
    },
    routing: routingResult.included,
    recovery: recoveryResult.included,
    resolutions: resolutionResult.included,
    rulings: rulingResult.included,
    ...(recordedRulingResult.included.length > 0
      ? { recorded_rulings: recordedRulingResult.included }
      : {}),
    stalls: stallResult.included,
    readiness: report.readiness.map(copyReadiness),
    suppressed_observations: routingResult.suppressed + recoveryResult.suppressed + resolutionResult.suppressed
      + rulingResult.suppressed + recordedRulingResult.suppressed + stallResult.suppressed,
  };
  const bundle = { ...payload, payload_sha256: payloadDigest(payload) };
  const errors = validateBundle(bundle, { verifyDigest: true });
  if (errors.length > 0) throw new Error(`generated evidence bundle is invalid: ${errors.join("; ")}`);
  return bundle;
}

function exactKeys(value, expected, label, errors) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    errors.push(`${label} must be an object`);
    return false;
  }
  const actual = Object.keys(value).sort();
  const wanted = [...expected].sort();
  if (actual.length !== wanted.length || actual.some((key, index) => key !== wanted[index])) {
    errors.push(`${label} has unexpected or missing properties`);
    return false;
  }
  return true;
}

function validCount(value) { return Number.isInteger(value) && value >= 0; }
function validNumber(value) { return typeof value === "number" && Number.isFinite(value) && value >= 0; }
function validCategory(value) { return typeof value === "string" && category(value) === value; }
function validDate(value) {
  if (!DATE_PATTERN.test(value)) return false;
  const parsed = new Date(`${value}T00:00:00Z`);
  return !Number.isNaN(parsed.getTime()) && parsed.toISOString().slice(0, 10) === value;
}

function validateNumbers(object, keys, label, errors, integer = true) {
  for (const key of keys) {
    if (!(integer ? validCount(object[key]) : validNumber(object[key]))) {
      errors.push(`${label}.${key} must be a non-negative ${integer ? "integer" : "number"}`);
    }
  }
}

function validateRows(rows, spec, label, errors) {
  if (!Array.isArray(rows)) { errors.push(`${label} must be an array`); return; }
  rows.forEach((row, index) => {
    const rowLabel = `${label}[${index}]`;
    // Optional counts are permitted but not demanded, so a row written before
    // the field existed still validates and a row carrying it is still checked.
    const present = (spec.optionalCounts || []).filter(
      (key) => Object.prototype.hasOwnProperty.call(row, key));
    if (!exactKeys(row, [...spec.categories, ...spec.counts, ...present, ...(spec.numbers || [])], rowLabel, errors)) return;
    for (const key of spec.categories) if (!validCategory(row[key])) errors.push(`${rowLabel}.${key} is invalid`);
    validateNumbers(row, [...spec.counts, ...present], rowLabel, errors);
    validateNumbers(row, spec.numbers || [], rowLabel, errors, false);
  });
}

function validateReadiness(rows, errors) {
  if (!Array.isArray(rows)) { errors.push("readiness must be an array"); return; }
  const statuses = new Set(["not-ready", "threshold-met-review-required"]);
  const portfolioStatuses = new Set(["not-assessable", "not-ready", "threshold-met-review-required"]);
  rows.forEach((row, index) => {
    const label = `readiness[${index}]`;
    const keys = ["capability", "issue", "status", "portfolio_status", "local_conditions", "portfolio_reason_code"];
    if (!exactKeys(row, keys, label, errors)) return;
    if (!validCategory(row.capability)) errors.push(`${label}.capability is invalid`);
    if (!Number.isInteger(row.issue) || row.issue < 1) errors.push(`${label}.issue is invalid`);
    if (!statuses.has(row.status)) errors.push(`${label}.status is invalid`);
    if (!portfolioStatuses.has(row.portfolio_status)) errors.push(`${label}.portfolio_status is invalid`);
    if (row.portfolio_reason_code !== null && !validCategory(row.portfolio_reason_code)) {
      errors.push(`${label}.portfolio_reason_code is invalid`);
    }
    if (!Array.isArray(row.local_conditions)) {
      errors.push(`${label}.local_conditions must be an array`);
      return;
    }
    row.local_conditions.forEach((condition, conditionIndex) => {
      const conditionLabel = `${label}.local_conditions[${conditionIndex}]`;
      if (!exactKeys(condition, ["id", "value", "threshold", "met", "reason_code"], conditionLabel, errors)) return;
      if (!validCategory(condition.id)) errors.push(`${conditionLabel}.id is invalid`);
      if (!validNumber(condition.value)) errors.push(`${conditionLabel}.value is invalid`);
      if (!validNumber(condition.threshold)) errors.push(`${conditionLabel}.threshold is invalid`);
      if (typeof condition.met !== "boolean") errors.push(`${conditionLabel}.met must be boolean`);
      if (condition.reason_code !== null && !validCategory(condition.reason_code)) {
        errors.push(`${conditionLabel}.reason_code is invalid`);
      }
    });
  });
}

function validateBundle(bundle, opts = {}) {
  const errors = [];
  const topKeys = [
    "schema_version", "stagecraft_version", "generated_date", "project_ref", "scope",
    "quality", "routing", "recovery", "rulings", "stalls", "readiness",
    "suppressed_observations", "payload_sha256",
  ];
  if (Object.prototype.hasOwnProperty.call(bundle, "resolutions")) topKeys.push("resolutions");
  // Same optional-section pattern: a bundle exported before 42.5 carries no
  // recorded_rulings and must keep validating unchanged.
  if (Object.prototype.hasOwnProperty.call(bundle, "recorded_rulings")) topKeys.push("recorded_rulings");
  if (!exactKeys(bundle, topKeys, "bundle", errors)) return errors;
  if (bundle.schema_version !== EXPORT_SCHEMA_VERSION) errors.push("unsupported schema_version");
  if (!VERSION_PATTERN.test(bundle.stagecraft_version)) errors.push("stagecraft_version is invalid");
  if (!validDate(bundle.generated_date)) errors.push("generated_date is invalid");
  if (!HASH_PATTERN.test(bundle.project_ref)) errors.push("project_ref is invalid");
  if (!HASH_PATTERN.test(bundle.payload_sha256)) errors.push("payload_sha256 is invalid");

  if (exactKeys(bundle.scope, ["project_count", "run_count", "complete_run_count", "repair_run_count"], "scope", errors)) {
    if (bundle.scope.project_count !== 1) errors.push("scope.project_count must be 1");
    validateNumbers(bundle.scope, ["run_count", "complete_run_count", "repair_run_count"], "scope", errors);
  }
  const qualityKeys = [
    "log_present", "gate_files", "malformed_records", "oversized_records",
    "unreadable_sources", "truncated_sources", "symlink_sources", "orphan_events",
    "cost_coverage_dispatches",
  ];
  if (Object.prototype.hasOwnProperty.call(bundle.quality, "durable_dispatch_observations")) {
    qualityKeys.push("durable_dispatch_observations");
  }
  // Same optional-key pattern: a bundle exported before 42.5 has no
  // dispatches_outside_run and must keep validating unchanged.
  if (Object.prototype.hasOwnProperty.call(bundle.quality, "dispatches_outside_run")) {
    qualityKeys.push("dispatches_outside_run");
  }
  if (exactKeys(bundle.quality, qualityKeys, "quality", errors)) {
    if (typeof bundle.quality.log_present !== "boolean") errors.push("quality.log_present must be boolean");
    validateNumbers(bundle.quality, qualityKeys.filter((key) => key !== "log_present"), "quality", errors);
  }
  validateRows(bundle.routing, {
    categories: ["role", "host", "model"],
    counts: ["gate_observations", "pass", "warn", "fail", "escalate", "cost_observations", "duration_observations", "prompt_observations"],
    // Added after the first bundles shipped, so it is accepted when present and
    // never required: a bundle exported before it existed must keep validating.
    optionalCounts: ["independent_observations"],
    numbers: ["total_cost_usd", "total_duration_ms", "total_prompt_bytes"],
  }, "routing", errors);
  validateRows(bundle.recovery, {
    categories: ["stage", "failure_class"], counts: ["observations", "runs"],
  }, "recovery", errors);
  if (Object.prototype.hasOwnProperty.call(bundle, "resolutions")) {
    validateRows(bundle.resolutions, {
      categories: ["stage", "failure_class", "schema_fingerprint"],
      counts: ["observations", "derivable"],
    }, "resolutions", errors);
    for (const [index, row] of bundle.resolutions.entries()) {
      if (!HASH_PATTERN.test(row.schema_fingerprint)) {
        errors.push(`resolutions[${index}].schema_fingerprint is invalid`);
      }
      if (validCount(row.derivable) && validCount(row.observations) && row.derivable > row.observations) {
        errors.push(`resolutions[${index}].derivable exceeds observations`);
      }
    }
  }
  validateRows(bundle.rulings, {
    categories: ["ruling_class"], counts: ["observations"],
  }, "rulings", errors);
  if (Object.prototype.hasOwnProperty.call(bundle, "recorded_rulings")) {
    validateRows(bundle.recorded_rulings, {
      categories: ["ruling_class"], counts: ["observations"],
    }, "recorded_rulings", errors);
  }
  validateRows(bundle.stalls, {
    categories: ["stage", "stall_class"], counts: ["observations"],
  }, "stalls", errors);
  validateReadiness(bundle.readiness, errors);
  if (!validCount(bundle.suppressed_observations)) errors.push("suppressed_observations is invalid");
  if (opts.verifyDigest && HASH_PATTERN.test(bundle.payload_sha256)) {
    const { payload_sha256: _ignored, ...payload } = bundle;
    if (payloadDigest(payload) !== bundle.payload_sha256) errors.push("payload digest mismatch");
  }
  return errors;
}

function readBundle(file) {
  let stat;
  try { stat = fs.lstatSync(file); } catch (error) {
    throw new Error(`cannot read evidence bundle: ${error.message}`);
  }
  if (stat.isSymbolicLink() || !stat.isFile()) {
    throw new Error("evidence bundle must be a regular, non-symlink file");
  }
  if (stat.size > MAX_BUNDLE_BYTES) throw new Error(`evidence bundle exceeds ${MAX_BUNDLE_BYTES} bytes`);
  let bundle;
  try { bundle = JSON.parse(fs.readFileSync(file, "utf8")); } catch (error) {
    throw new Error(`evidence bundle is malformed: ${error.message}`);
  }
  const errors = validateBundle(bundle, { verifyDigest: true });
  if (errors.length > 0) throw new Error(`invalid evidence bundle: ${errors.join("; ")}`);
  return bundle;
}

function writeBundle(file, bundle) {
  const errors = validateBundle(bundle, { verifyDigest: true });
  if (errors.length > 0) throw new Error(`refusing to write invalid evidence bundle: ${errors.join("; ")}`);
  const resolved = path.resolve(file);
  const parent = path.dirname(resolved);
  let parentStat;
  try { parentStat = fs.lstatSync(parent); } catch (error) {
    throw new Error(`export destination parent is unavailable: ${error.message}`);
  }
  if (parentStat.isSymbolicLink() || !parentStat.isDirectory()) {
    throw new Error("export destination parent must be a regular, non-symlink directory");
  }
  let fd;
  try {
    fd = fs.openSync(resolved, "wx", 0o600);
    fs.writeFileSync(fd, `${JSON.stringify(bundle, null, 2)}\n`, "utf8");
    fs.fsyncSync(fd);
    fs.closeSync(fd);
    fd = undefined;
    try { fs.chmodSync(resolved, 0o600); } catch { /* Windows permissions are advisory */ }
  } catch (error) {
    if (fd !== undefined) {
      try { fs.closeSync(fd); } catch { /* already closed */ }
      try { fs.unlinkSync(resolved); } catch { /* no partial file */ }
    }
    if (error.code === "EEXIST") throw new Error("export destination already exists; choose a new file");
    throw error;
  }
  return resolved;
}

function assertExportDestination(file) {
  const resolved = path.resolve(file);
  const parent = path.dirname(resolved);
  let parentStat;
  try { parentStat = fs.lstatSync(parent); } catch (error) {
    throw new Error(`export destination parent is unavailable: ${error.message}`);
  }
  if (parentStat.isSymbolicLink() || !parentStat.isDirectory()) {
    throw new Error("export destination parent must be a regular, non-symlink directory");
  }
  try {
    fs.lstatSync(resolved);
    throw new Error("export destination already exists; choose a new file");
  } catch (error) {
    if (error.code !== "ENOENT") throw error;
  }
  return resolved;
}

module.exports = {
  EXPORT_SCHEMA_VERSION,
  MIN_EXPORT_CELL,
  MAX_BUNDLE_BYTES,
  canonicalize,
  payloadDigest,
  createBundle,
  validateBundle,
  readBundle,
  assertExportDestination,
  writeBundle,
};
