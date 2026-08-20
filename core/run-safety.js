"use strict";

const crypto = require("node:crypto");
const fs = require("node:fs");
const path = require("node:path");
const { pipelineRoot } = require("./paths");
const { stoplistPolicyFingerprint } = require("./guards/stoplist");

const RUN_SAFETY_SCHEMA = "stagecraft.run-safety/v1";
const STOPLIST_BYPASS_SCHEMA = "stagecraft.stoplist-bypass/v1";

function fingerprint(value) {
  return crypto.createHash("sha256").update(JSON.stringify(value)).digest("hex");
}

function cap(value) {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function policyFromState(state) {
  const policy = state && state.safety_policy;
  if (!policy || policy.schema !== RUN_SAFETY_SCHEMA) return null;
  return {
    schema: RUN_SAFETY_SCHEMA,
    budget_usd: cap(policy.budget_usd),
    budget_tokens: cap(policy.budget_tokens),
    stoplist_bypass: policy.stoplist_bypass || null,
  };
}

function resumeConflict(name, previous, requested) {
  const shown = (value) => value === null ? "uncapped" : String(value);
  const error = new Error(
    `${name} conflicts with the original run (${shown(previous)} -> ${shown(requested)}). `
    + "A resume cannot change its effective safety policy; start a fresh run instead.",
  );
  error.code = "ERUNPOLICYDRIFT";
  throw error;
}

function resolveEffectiveSafetyPolicy({ resume = false, state = null, budgetUsd, budgetTokens } = {}) {
  const requestedUsd = cap(budgetUsd);
  const requestedTokens = cap(budgetTokens);
  const stored = resume ? policyFromState(state) : null;

  if (stored) {
    if (budgetUsd !== undefined && requestedUsd !== stored.budget_usd) {
      resumeConflict("--budget-usd", stored.budget_usd, requestedUsd);
    }
    if (budgetTokens !== undefined && requestedTokens !== stored.budget_tokens) {
      resumeConflict("--budget-tokens", stored.budget_tokens, requestedTokens);
    }
    return { policy: stored, migrated: false };
  }

  return {
    policy: {
      schema: RUN_SAFETY_SCHEMA,
      budget_usd: requestedUsd,
      budget_tokens: requestedTokens,
      stoplist_bypass: null,
    },
    migrated: Boolean(resume && state),
  };
}

function assertResumeTrack(state, explicitTrack) {
  if (!state || explicitTrack === undefined || explicitTrack === null || explicitTrack === "") return;
  const previous = state.resolved_track || state.track;
  if (previous === undefined || previous === null) return;
  const same = JSON.stringify(previous) === JSON.stringify(explicitTrack);
  if (same) return;
  const error = new Error(
    `--track conflicts with the original run (${JSON.stringify(previous)} -> ${JSON.stringify(explicitTrack)}). `
    + "A resume cannot change its effective safety policy; start a fresh run instead.",
  );
  error.code = "ERUNPOLICYDRIFT";
  throw error;
}

function briefFingerprint(cwd, changeId = null) {
  const file = path.join(pipelineRoot(cwd, changeId), "brief.md");
  try {
    if (!fs.existsSync(file)) return null;
    return fingerprint(fs.readFileSync(file, "utf8"));
  } catch {
    return null;
  }
}

function stoplistContext({ cwd, changeId = null, description = "", policyFingerprint } = {}) {
  return {
    description_fingerprint: description ? fingerprint(description) : null,
    brief_fingerprint: briefFingerprint(cwd, changeId),
    policy_fingerprint: policyFingerprint || stoplistPolicyFingerprint(),
  };
}

function stoplistBypassStatus(bypass, context) {
  if (!bypass || bypass.schema !== STOPLIST_BYPASS_SCHEMA) {
    return { valid: false, reason: "missing" };
  }
  if (bypass.policy_fingerprint !== context.policy_fingerprint) {
    return { valid: false, reason: "policy-changed" };
  }
  if (bypass.brief_fingerprint !== context.brief_fingerprint) {
    return { valid: false, reason: "brief-changed" };
  }
  if (bypass.description_fingerprint !== context.description_fingerprint) {
    return { valid: false, reason: "feature-changed" };
  }
  return { valid: true, reason: null };
}

function authorizeStoplistBypass(context, previous = null, authorizedAt = new Date().toISOString()) {
  const stable = {
    schema: STOPLIST_BYPASS_SCHEMA,
    description_fingerprint: context.description_fingerprint
      || (previous && previous.description_fingerprint)
      || null,
    brief_fingerprint: context.brief_fingerprint,
    policy_fingerprint: context.policy_fingerprint,
  };
  return {
    ...stable,
    fingerprint: fingerprint(stable),
    authority: "operator:--force",
    authorized_at: authorizedAt,
  };
}

function readRunSafety(cwd, changeId = null) {
  const file = path.join(pipelineRoot(cwd, changeId), "run-state.json");
  try {
    const state = JSON.parse(fs.readFileSync(file, "utf8"));
    return { file, state, policy: policyFromState(state) };
  } catch {
    return { file, state: null, policy: null };
  }
}

function persistRunSafety(cwd, changeId, state, policy) {
  const file = path.join(pipelineRoot(cwd, changeId), "run-state.json");
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const temporary = path.join(path.dirname(file), `.${path.basename(file)}.${process.pid}.tmp`);
  const updated = { ...state, safety_policy: policy };
  try {
    fs.writeFileSync(temporary, JSON.stringify(updated, null, 2) + "\n", "utf8");
    fs.renameSync(temporary, file);
  } finally {
    try { fs.unlinkSync(temporary); } catch { /* rename succeeded */ }
  }
  return updated;
}

module.exports = {
  RUN_SAFETY_SCHEMA,
  STOPLIST_BYPASS_SCHEMA,
  resolveEffectiveSafetyPolicy,
  assertResumeTrack,
  stoplistContext,
  stoplistBypassStatus,
  authorizeStoplistBypass,
  readRunSafety,
  persistRunSafety,
};
