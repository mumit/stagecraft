const { TRANSITION_CONTROLS, transitionResult } = require("./driver-transition");

function retryBudgetTransition({ action, base, attempts, maxRetries }) {
  if (attempts < maxRetries) return null;
  const reason =
    `driver retry budget exhausted for "${action.name}" (${attempts}/${maxRetries}); escalating`;
  return transitionResult(TRANSITION_CONTROLS.HALT, {
    summaryPatch: {
      halted: true,
      halt_action: "resolve-escalation",
      halt_failure_class: "convergence-exhausted",
      halt_reason: reason,
      blockers: action.blockers || [],
    },
    logEvents: [{ ...base, outcome: "convergence-halt" }],
    emittedEvents: [{
      type: "halt",
      ...base,
      action: "resolve-escalation",
      failure_class: "convergence-exhausted",
      reason,
      blockers: action.blockers,
    }],
  });
}

function convergenceTransition({ action, base, kind, evidence, archived }) {
  const evidenceField = kind === "no-progress"
    ? "no_progress_evidence"
    : "no_source_change_evidence";
  const label = kind === "no-progress" ? "no-progress" : "no-source-change";
  const reason = `${label} convergence for "${action.name}": ${evidence}; escalating for a ruling`;
  return transitionResult(TRANSITION_CONTROLS.HALT, {
    summaryPatch: {
      halted: true,
      halt_action: "resolve-escalation",
      halt_failure_class: "convergence-exhausted",
      halt_reason: reason,
      blockers: action.blockers || [],
      [evidenceField]: evidence,
    },
    logEvents: [{
      ...base,
      outcome: "convergence-halt",
      [evidenceField]: evidence,
      archived: archived || null,
    }],
    emittedEvents: [{
      type: "halt",
      ...base,
      action: "resolve-escalation",
      failure_class: "convergence-exhausted",
      reason,
      blockers: action.blockers,
      [evidenceField]: evidence,
    }],
  });
}

function blockedFixTransition({ action, base, archived }) {
  const reason =
    `fix steps for "${action.name}" contain no gate clears — cannot make automated progress; ` +
    `run \`devteam next\` for manual fix steps`;
  return transitionResult(TRANSITION_CONTROLS.HALT, {
    summaryPatch: {
      halted: true,
      halt_action: "fix-and-retry",
      halt_failure_class: "structural-input",
      halt_reason: reason,
      blockers: action.blockers || [],
      fix_steps: action.fix_steps || [],
    },
    logEvents: [{ ...base, outcome: "no-progress-halt", archived: archived || null }],
    emittedEvents: [{
      type: "halt",
      ...base,
      failure_class: "structural-input",
      reason,
      blockers: action.blockers,
      fix_steps: action.fix_steps,
    }],
  });
}

function retryOwnershipTransition({ action, base, archived, ownership }) {
  const targets = ownership.target_paths.join(", ");
  const candidates = ownership.candidate_roles.join(", ") || "none";
  const reason =
    `automatic retry for "${action.name}" targets ${targets}, but no candidate build role ` +
    `can write every target (considered: ${candidates}). Fix the files manually, correct ` +
    `stage-02 file_ownership, or add a narrowly scoped owner before resuming; no host was invoked.`;
  const evidence = {
    target_paths: ownership.target_paths,
    candidate_roles: ownership.candidate_roles,
    compatible_roles: [],
  };
  return transitionResult(TRANSITION_CONTROLS.HALT, {
    summaryPatch: {
      halted: true,
      halt_action: "retry-ownership",
      halt_failure_class: "structural-input",
      halt_reason: reason,
      retry_ownership: evidence,
      blockers: action.blockers || [],
    },
    logEvents: [{
      ...base,
      outcome: "retry-ownership-halt",
      archived: archived || null,
      ...evidence,
    }],
    emittedEvents: [{
      type: "halt",
      ...base,
      action: "retry-ownership",
      failure_class: "structural-input",
      reason,
      retry_ownership: evidence,
    }],
  });
}

function fixRetryTransition({
  action,
  base,
  attempts,
  clearedCount,
  archived,
  target,
  derivable,
  targetedFix,
  fixRetries,
}) {
  const attempt = attempts + 1;
  return transitionResult(TRANSITION_CONTROLS.CONTINUE, {
    statePatch: {
      targetedFix,
      fixRetries: { ...fixRetries, [action.name]: attempt },
    },
    logEvents: [{
      ...base,
      outcome: "fix-retry",
      attempt,
      cleared_gates: clearedCount,
      archived: archived || null,
      target,
      derivable: derivable === true,
    }],
    emittedEvents: [{ type: "fix-retry", ...base, attempt, cleared_gates: clearedCount, target, derivable: derivable === true }],
  });
}

function nonCodeFixTransition({ action, base }) {
  return transitionResult(TRANSITION_CONTROLS.HALT, {
    summaryPatch: {
      halted: true,
      halt_action: action.action,
      halt_failure_class: action.failure_class || null,
      halt_reason: action.reason,
      blockers: action.blockers || [],
      fix_steps: action.fix_steps || [],
    },
    logEvents: [{ ...base, outcome: "halt" }],
    emittedEvents: [{ type: "halt", ...base, blockers: action.blockers, fix_steps: action.fix_steps }],
  });
}

function rulingPreflightTransition({ action, base, grantCount, hardStop, alreadyTried }) {
  if (grantCount > 0 && !hardStop && !alreadyTried) return null;
  const reason = hardStop
    ? `escalation requires a human (auto-rule never crosses ${action.failure_class === "convergence-exhausted" ? "convergence-exhausted" : "the consequence ceiling"})`
    : alreadyTried
      ? `auto-rule already attempted once for "${action.name}" and it re-escalated; halting for a human`
      : action.reason;
  return transitionResult(TRANSITION_CONTROLS.HALT, {
    summaryPatch: {
      halted: true,
      halt_action: "resolve-escalation",
      halt_failure_class: action.failure_class || "judgment-gate",
      halt_reason: reason,
    },
    logEvents: [{ ...base, outcome: "halt" }],
    emittedEvents: [{ type: "halt", ...base }],
  });
}

function rulingOutcomeTransition({ base, rulingResult, latest, grantSet }) {
  if (!latest || (rulingResult && rulingResult.exitCode !== 0)) {
    return transitionResult(TRANSITION_CONTROLS.HALT, {
      summaryPatch: {
        halted: true,
        halt_action: "resolve-escalation",
        halt_failure_class: "judgment-gate",
        halt_reason: "Principal produced no ruling; halting for a human",
      },
      logEvents: [{ ...base, outcome: "auto-rule-no-output" }],
      emittedEvents: [{ type: "halt", ...base }],
    });
  }

  if (latest.type === "cannot-decide") {
    const reason = `Principal cannot decide (${latest.reason_class}): ${latest.question}`;
    return transitionResult(TRANSITION_CONTROLS.HALT, {
      summaryPatch: {
        halted: true,
        halt_action: "resolve-escalation",
        halt_failure_class: "cannot-decide",
        cannot_decide: { reason_class: latest.reason_class, question: latest.question },
        halt_reason: reason,
      },
      logEvents: [{ ...base, outcome: "cannot-decide", reason_class: latest.reason_class }],
      emittedEvents: [{
        type: "cannot-decide",
        ...base,
        reason_class: latest.reason_class,
        question: latest.question,
      }],
    });
  }

  if (!grantSet.has(latest.class)) {
    return transitionResult(TRANSITION_CONTROLS.HALT, {
      summaryPatch: {
        halted: true,
        halt_action: "resolve-escalation",
        halt_failure_class: "judgment-gate",
        halt_reason: `ruling class "${latest.class}" is not in the --auto-rule grant; halting for a human`,
      },
      logEvents: [{ ...base, outcome: "auto-rule-ungranted", ruling_class: latest.class }],
      emittedEvents: [{ type: "halt", ...base, ruling_class: latest.class }],
    });
  }

  return null;
}

function rulingAppliedTransition({ base, applyResult, latest }) {
  if (applyResult && applyResult.exitCode !== 0) {
    return transitionResult(TRANSITION_CONTROLS.HALT, {
      summaryPatch: {
        halted: true,
        halt_action: "resolve-escalation",
        halt_reason: `escalation applicator failed (exit ${applyResult.exitCode}); halting`,
      },
      logEvents: [{ ...base, outcome: "auto-rule-apply-failed" }],
      emittedEvents: [{ type: "halt", ...base }],
    });
  }

  const authority = `auto-rule:${latest.class}`;
  return transitionResult(TRANSITION_CONTROLS.CONTINUE, {
    logEvents: [{
      ...base,
      outcome: "auto-ruled",
      grant_class: latest.class,
      ruling: latest.decision,
      authority,
    }],
    emittedEvents: [{
      type: "auto-ruled",
      ...base,
      grant_class: latest.class,
      ruling: latest.decision,
      authority,
    }],
    details: { authority },
  });
}

function rulingDispatchVerificationTransition({ base, latest, buildGateUpdated }) {
  const rulingMentionsBuild = /dispatch\s+(backend|frontend|platform|qa)\s+build\s+workstream/i
    .test(latest.decision || "");
  if (!rulingMentionsBuild) return null;
  if (buildGateUpdated) {
    return transitionResult(TRANSITION_CONTROLS.CONTINUE, {
      details: { resetAutoRule: true },
    });
  }

  const reason = "escalation applicator did not dispatch a build workstream as the ruling required — no build gate was updated; halting for human review";
  return transitionResult(TRANSITION_CONTROLS.HALT, {
    summaryPatch: {
      halted: true,
      halt_action: "resolve-escalation",
      halt_failure_class: "applicator-did-not-dispatch-build",
      halt_reason: reason,
    },
    logEvents: [{ ...base, outcome: "applicator-did-not-dispatch-build" }],
    emittedEvents: [{ type: "halt", ...base }],
  });
}

function mergeTransition({ base, mergeResult }) {
  const logEntry = {
    ...base,
    outcome: mergeResult.merged ? "merged" : "merge-failed",
    reason: mergeResult.reason || null,
  };
  if (mergeResult.merged) {
    return transitionResult(TRANSITION_CONTROLS.CONTINUE, { logEvents: [logEntry] });
  }
  return transitionResult(TRANSITION_CONTROLS.HALT, {
    summaryPatch: {
      halted: true,
      halt_action: "merge-failed",
      halt_reason: mergeResult.reason || "merge failed",
    },
    logEvents: [logEntry],
    emittedEvents: [{ type: "merge-failed", ...base, reason: mergeResult.reason }],
  });
}

module.exports = {
  retryBudgetTransition,
  convergenceTransition,
  blockedFixTransition,
  retryOwnershipTransition,
  fixRetryTransition,
  nonCodeFixTransition,
  rulingPreflightTransition,
  rulingOutcomeTransition,
  rulingAppliedTransition,
  rulingDispatchVerificationTransition,
  mergeTransition,
};
