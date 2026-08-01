// Hand-written validator for core/gates/schemas/learning/candidates-delta.schema.json.
//
// Mirrors this repo's existing convention (core/gates/validator.js) of
// validating JSON by hand rather than depending on a JSON Schema library —
// there is no ajv (or similar) dependency in package.json. Keeping the
// validator here, separate from core/gates/validator.js, matches the
// schema's own note: this is not a stage gate, so it isn't read by the
// gate validator's pipeline/gates/ sweep.

"use strict";

const TIERS = new Set(["blocker", "warning", "nudge", "positive"]);
const COUNTER_FIELDS = new Set(["injected", "recurrence_after_injection", "noise_reports"]);

function isNonEmptyString(value) {
  return typeof value === "string" && value.trim().length > 0;
}

function validateNewCandidate(item, idx, errors) {
  if (!item || typeof item !== "object" || Array.isArray(item)) {
    errors.push(`new_candidates[${idx}] must be an object`);
    return;
  }
  if (!TIERS.has(item.tier)) errors.push(`new_candidates[${idx}].tier must be one of ${[...TIERS].join(", ")}`);
  if (!isNonEmptyString(item.signal)) errors.push(`new_candidates[${idx}].signal must be a non-empty string`);
  if (!isNonEmptyString(item.summary)) errors.push(`new_candidates[${idx}].summary must be a non-empty string`);
  if (item.workstream !== undefined && typeof item.workstream !== "string") {
    errors.push(`new_candidates[${idx}].workstream must be a string`);
  }
  if (item.stage !== undefined && typeof item.stage !== "string") {
    errors.push(`new_candidates[${idx}].stage must be a string`);
  }
}

function validateCounterAdjustment(item, idx, errors) {
  if (!item || typeof item !== "object" || Array.isArray(item)) {
    errors.push(`counter_adjustments[${idx}] must be an object`);
    return;
  }
  if (!isNonEmptyString(item.pattern_id)) errors.push(`counter_adjustments[${idx}].pattern_id must be a non-empty string`);
  if (!COUNTER_FIELDS.has(item.field)) errors.push(`counter_adjustments[${idx}].field must be one of ${[...COUNTER_FIELDS].join(", ")}`);
  if (!Number.isInteger(item.delta)) errors.push(`counter_adjustments[${idx}].delta must be an integer`);
  if (!isNonEmptyString(item.reason)) errors.push(`counter_adjustments[${idx}].reason must be a non-empty string`);
}

function validateDedupMerge(item, idx, errors) {
  if (!item || typeof item !== "object" || Array.isArray(item)) {
    errors.push(`dedup_merges[${idx}] must be an object`);
    return;
  }
  if (!isNonEmptyString(item.keep_id)) errors.push(`dedup_merges[${idx}].keep_id must be a non-empty string`);
  if (
    !Array.isArray(item.merge_ids) ||
    item.merge_ids.length === 0 ||
    !item.merge_ids.every(isNonEmptyString)
  ) {
    errors.push(`dedup_merges[${idx}].merge_ids must be a non-empty array of non-empty strings`);
  }
  if (!isNonEmptyString(item.reason)) errors.push(`dedup_merges[${idx}].reason must be a non-empty string`);
}

// Returns { ok, errors }. `errors` is always an array (empty when ok).
// Never throws — a caller feeding it arbitrary parsed JSON (including
// non-objects) gets a normal invalid result, not an exception.
function validateCandidatesDelta(payload) {
  const errors = [];
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) {
    return { ok: false, errors: ["payload must be a JSON object"] };
  }
  if (payload.schema_version !== "1.0") errors.push('schema_version must be "1.0"');
  for (const field of ["new_candidates", "counter_adjustments", "dedup_merges"]) {
    if (!Array.isArray(payload[field])) errors.push(`${field} must be an array`);
  }
  if (errors.length > 0) return { ok: false, errors };

  payload.new_candidates.forEach((item, idx) => validateNewCandidate(item, idx, errors));
  payload.counter_adjustments.forEach((item, idx) => validateCounterAdjustment(item, idx, errors));
  payload.dedup_merges.forEach((item, idx) => validateDedupMerge(item, idx, errors));

  return { ok: errors.length === 0, errors };
}

module.exports = { validateCandidatesDelta, TIERS, COUNTER_FIELDS };
