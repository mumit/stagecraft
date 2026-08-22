"use strict";

// Slice 5 of the P2-2 run() decomposition -- see core/driver-safety.js,
// core/driver-runend.js, core/driver-stage-order.js, and
// core/driver-run-state.js for the earlier slices.
//
// The run plan (ADR-018): what goes into it, and how it reaches disk.
//
// These are two steps of one job, separated in run() by ~80 lines of unrelated
// setup. resolvePlanInputs answers "what will this run actually dispatch, and
// what should that cost?"; materializeRunPlan turns that answer into the
// durable, fingerprinted contract an operator can inspect before any model is
// called -- and, on a resume, reconciles it against the plan already on disk.
//
// The reconciliation itself stays in core/run-plan.js. It is the one branch
// here whose failure mode is silent -- a drift check that stops firing does not
// throw, it runs a different pipeline than the one that was approved -- so it
// is pinned end-to-end by the resume tests in
// tests/run-prologue-characterization.test.js.

const {
  candidateActiveRoles,
  deterministicSkipsForOrder,
  expectedWorkstreamCount,
} = require("./pipeline/right-sizing");
const { ceremonyPreview } = require("./ceremony-preview");
const { buildRunPlan, persistRunPlan, portableRelative } = require("./run-plan");

// resolvePlanInputs -- the preflight estimate the plan is built from.
//
// `assessedActiveRoles` is whatever pipeline/track.json recorded, used only as
// a fallback: live discovery wins whenever it finds anything, because the
// assessment is a snapshot from before the working tree reached its current
// state.
//
// Returns { activeRoleCandidates, rightSizedSkips, expectedWorkstreams, ceremony }.
// The discovered-roles object and the included-stage list are deliberately not
// returned; both are steps in computing the four values above, and run() never
// read them again.
function resolvePlanInputs({ order, effectiveTrack, config, cwd, changeId, assessedActiveRoles }) {
  const rightSizingOff = config.pipeline.right_sizing === false;

  const discoveredActiveRoles = rightSizingOff
    ? { roles: [], trigger_inputs: {} }
    : candidateActiveRoles(cwd);
  const activeRoleCandidates = discoveredActiveRoles.roles.length > 0 || !Array.isArray(assessedActiveRoles)
    ? discoveredActiveRoles
    : {
        roles: assessedActiveRoles,
        trigger_inputs: {
          ...discoveredActiveRoles.trigger_inputs,
          source: "pipeline/track.json assessment",
        },
      };

  const rightSizedSkips = rightSizingOff
    ? {}
    : deterministicSkipsForOrder(order, cwd, { changeId });
  const configSkips = (config.pipeline && config.pipeline.skip_stages) || [];
  const expectedWorkstreams = expectedWorkstreamCount(order, effectiveTrack, {
    skipped: [...configSkips, ...Object.keys(rightSizedSkips)],
    activeRoles: activeRoleCandidates.roles,
    config,
  });

  // 29.3: ceremony cost preview for the pre-flight run-plan event. Scoped to
  // the same right-sized stage list used by the materialized plan (not the
  // raw track shape) so the estimate matches what will actually dispatch.
  // Advisory only -- a preview failure must never block a run.
  const includedStageNames = order.filter((name) =>
    !configSkips.includes(name)
    && !Object.prototype.hasOwnProperty.call(rightSizedSkips, name));
  let ceremony = null;
  try {
    ceremony = ceremonyPreview(cwd, effectiveTrack, config, { stageNames: includedStageNames });
  } catch { /* preview is advisory — the run proceeds without it */ }

  return { activeRoleCandidates, rightSizedSkips, expectedWorkstreams, ceremony };
}

// materializeRunPlan -- build the plan, reconcile-or-write it, announce it.
//
// ADR-018: make the exact deterministic preflight decision inspectable before
// any model dispatch. A resume reuses the original file only when its execution
// fingerprint still matches; routing/stage drift is a hard error instead of
// silently changing the run under an existing state. persistRunPlan throws
// (ERUNPLANDRIFT / ERUNPOLICYDRIFT) rather than returning a verdict, so the
// caller's lock-releasing `finally` covers a rejection.
//
// Returns { planPath } -- the portable relative path, which the --plan-only
// halt reports. The plan object itself is not returned: run() logged it and
// never read it back.
function materializeRunPlan({
  cwd, changeId, order, track, trackSource, trackConfidence, intent, config,
  rightSizedSkips, activeRoleCandidates, expectedWorkstreams, ceremony,
  assessInline, runId, trustProfile, safetyPolicy, until, resume,
  logEvent, onEvent,
}) {
  const proposed = buildRunPlan({
    changeId,
    order,
    track,
    trackSource,
    trackConfidence,
    intent,
    config,
    rightSizedSkips,
    candidateActiveRoles: activeRoleCandidates.roles,
    expectedWorkstreams,
    ceremonyPreview: ceremony,
    assessInline: assessInline || null,
    runId,
    trustProfile,
    safetyPolicy,
    until: until || null,
  });
  const persisted = persistRunPlan(cwd, changeId, proposed, { resume });
  const planPath = portableRelative(cwd, persisted.path);
  const announcement = {
    plan_path: planPath,
    plan_reused: persisted.reused,
    ...persisted.plan,
  };
  logEvent({ outcome: "run-plan", ...announcement });
  onEvent({ type: "run-plan", ...announcement });
  return { planPath };
}

module.exports = { resolvePlanInputs, materializeRunPlan };
