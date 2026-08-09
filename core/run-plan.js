"use strict";

// Durable, pre-dispatch execution plan (ADR-018).
//
// The driver previously emitted only aggregate counts to run-log.jsonl. That
// was useful telemetry but not an inspectable contract: operators could not see
// which stages, roles, hosts, or models were about to run, and a resumed run
// could silently pick up routing/config drift. This module materializes the
// deterministic portion of that decision as pipeline/run-plan.json.
//
// Conditional stages are deliberately labelled "conditional", not promised as
// included: their upstream gate does not exist at preflight time. Likewise each
// dispatch is a "candidate" until runtime discovery/right-sizing confirms it.

const crypto = require("node:crypto");
const fs = require("node:fs");
const path = require("node:path");
const { resolveRoute } = require("./config");
const { pipelineRoot } = require("./paths");
const { STAGES, rolesForStage } = require("./pipeline/stages");
const { expectedRolesForStage } = require("./pipeline/right-sizing");

const RUN_PLAN_SCHEMA = "stagecraft.run-plan/v1";

function runPlanPath(cwd, changeId) {
  return path.join(pipelineRoot(cwd, changeId), "run-plan.json");
}

function portableRelative(cwd, absolutePath) {
  return path.relative(cwd, absolutePath).replace(/\\/g, "/");
}

function fingerprint(value) {
  return crypto.createHash("sha256").update(JSON.stringify(value)).digest("hex");
}

function stageSelection(name, configSkipStages, rightSizedSkips) {
  if (configSkipStages.has(name)) {
    return {
      disposition: "skipped",
      decision_basis: "configuration",
      reevaluated_at_runtime: false,
      reason: "excluded by pipeline.skip_stages",
    };
  }
  if (Object.prototype.hasOwnProperty.call(rightSizedSkips, name)) {
    return {
      disposition: "skipped",
      decision_basis: "preflight-snapshot",
      reevaluated_at_runtime: true,
      reason: rightSizedSkips[name].reason,
      skip_kind: rightSizedSkips[name].skip_kind,
    };
  }
  const stage = STAGES[name];
  if (stage && stage.conditionalOn) {
    return {
      disposition: "conditional",
      decision_basis: "upstream-gate",
      reevaluated_at_runtime: true,
      reason: "resolved at runtime from an upstream gate",
      condition: stage.conditionalOn,
    };
  }
  return {
    disposition: "included",
    decision_basis: "resolved-track",
    reevaluated_at_runtime: false,
    reason: "selected by the resolved track",
  };
}

function buildRunPlan({
  changeId = null,
  order,
  track,
  trackSource,
  trackConfidence,
  intent,
  config,
  rightSizedSkips = {},
  candidateActiveRoles = [],
  expectedWorkstreams,
  ceremonyPreview = null,
  assessInline = null,
  runId,
  generatedAt = new Date().toISOString(),
}) {
  const configSkipStages = new Set((config.pipeline && config.pipeline.skip_stages) || []);
  const trackLabel = Array.isArray(track) ? "custom" : track;

  const stages = order.map((name, index) => {
    const stage = STAGES[name];
    const selection = stageSelection(name, configSkipStages, rightSizedSkips);
    const configuredRoles = stage ? rolesForStage(stage, track, config) : [];
    const configuredRoutes = stage ? configuredRoles.map((role) => {
      const route = resolveRoute(config, stage.stage, role);
      return { role, host: route.hostName, model: route.model || null };
    }) : [];
    const candidateRoles = selection.disposition === "skipped" || !stage
      ? []
      : expectedRolesForStage(stage, track, { activeRoles: candidateActiveRoles, config });
    const dispatches = candidateRoles.map((role) => {
      const route = configuredRoutes.find((candidate) => candidate.role === role);
      return {
        role,
        host: route.host,
        model: route.model,
        status: "candidate",
      };
    });
    return {
      index,
      name,
      stage: stage ? stage.stage : null,
      ...selection,
      configured_roles: configuredRoles,
      configured_routes: configuredRoutes,
      dispatches,
    };
  });

  const included = stages.filter((stage) => stage.disposition !== "skipped");
  const skippedByConfig = stages.filter((stage) =>
    stage.disposition === "skipped" && stage.reason === "excluded by pipeline.skip_stages");
  const skippedByRightSizing = stages.filter((stage) =>
    stage.disposition === "skipped" && stage.skip_kind && stage.skip_kind.startsWith("right-sizing."));
  const baseWorkstreams = included.reduce((sum, stage) => sum + stage.configured_roles.length, 0);
  const candidateWorkstreams = included.reduce((sum, stage) => sum + stage.dispatches.length, 0);

  const execution = {
    track: trackLabel,
    custom_track: Array.isArray(track) ? track : null,
    track_source: trackSource,
    track_confidence: trackConfidence,
    intent,
    change_id: changeId,
    stages,
    candidate_active_roles: candidateActiveRoles,
    ceremony_preview: ceremonyPreview,
  };
  // Bind resume to stable execution controls, not observations that naturally
  // evolve as earlier stages write code. Candidate active roles, preflight
  // right-sizing skips, and ceremony estimates are snapshots; stage readiness
  // re-evaluates them at runtime. Configured stage exclusion, conditional
  // contracts, configured roles, and every configured route are stable.
  const fingerprintedExecution = {
    track: trackLabel,
    custom_track: Array.isArray(track) ? track : null,
    track_source: trackSource,
    track_confidence: trackConfidence,
    intent,
    change_id: changeId,
    stages: stages.map((plannedStage) => {
      const {
        name,
        stage: stageId,
        configured_roles: configuredRoles,
        configured_routes: configuredRoutes,
      } = plannedStage;
      const stageDef = STAGES[name];
      return {
        name,
        stage: stageId,
        disposition: configSkipStages.has(name)
          ? "skipped"
          : (stageDef && stageDef.conditionalOn ? "conditional" : "included"),
        condition: stageDef && stageDef.conditionalOn ? stageDef.conditionalOn : null,
        configured_roles: configuredRoles,
        routes: configuredRoutes,
      };
    }),
  };

  return {
    schema: RUN_PLAN_SCHEMA,
    generated_at: generatedAt,
    run_id: runId,
    plan_fingerprint: fingerprint(fingerprintedExecution),
    ...execution,
    planning_semantics: {
      configured_selection: "fingerprinted and resume-bound",
      right_sizing: "preflight snapshot; reevaluated when the stage becomes ready",
      conditional_stages: "resolved from upstream gates at runtime",
      candidate_routes: "resolved configuration; runtime discovery may narrow candidates",
    },
    assess_inline: assessInline,
    stages_total: stages.length,
    stages_included: included.length,
    stages_skipped_by_config: skippedByConfig.length,
    stages_skipped_by_right_sizing: skippedByRightSizing.length,
    base_workstreams: baseWorkstreams,
    expected_workstreams: expectedWorkstreams ?? candidateWorkstreams,
    conditional_stages: included.filter((stage) => stage.disposition === "conditional").length,
    skipped_stage_names: skippedByConfig.map((stage) => stage.name),
    right_sized_stage_names: skippedByRightSizing.map((stage) => stage.name),
  };
}

function persistRunPlan(cwd, changeId, plan, { resume = false } = {}) {
  const target = runPlanPath(cwd, changeId);
  if (resume && fs.existsSync(target)) {
    const existing = JSON.parse(fs.readFileSync(target, "utf8"));
    if (existing.plan_fingerprint !== plan.plan_fingerprint) {
      const error = new Error(
        `run plan changed since the original run (${existing.plan_fingerprint || "unknown"} -> ${plan.plan_fingerprint}). ` +
        "Restart without --resume after reviewing pipeline/run-plan.json.",
      );
      error.code = "ERUNPLANDRIFT";
      throw error;
    }
    return { plan: existing, path: target, reused: true };
  }

  fs.mkdirSync(path.dirname(target), { recursive: true });
  const temporary = path.join(path.dirname(target), `.${path.basename(target)}.${process.pid}.tmp`);
  try {
    fs.writeFileSync(temporary, JSON.stringify(plan, null, 2) + "\n", "utf8");
    fs.renameSync(temporary, target);
  } finally {
    try { fs.unlinkSync(temporary); } catch { /* rename succeeded, or cleanup is best-effort */ }
  }
  return { plan, path: target, reused: false };
}

module.exports = {
  RUN_PLAN_SCHEMA,
  buildRunPlan,
  persistRunPlan,
  runPlanPath,
  portableRelative,
};
