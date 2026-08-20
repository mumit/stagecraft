const { classifyDispatch } = require("./gates/classify");
const { TRANSITION_CONTROLS, transitionResult } = require("./driver-transition");

function dispatchGuardTransition({
  action,
  base,
  consequenceCeiling,
  allowStages,
  order,
  untilIndex,
  until,
  budgetUsd,
  spent,
  budgetTokens,
  tokensUsed,
  tokenBasis,
}) {
  if (consequenceCeiling.has(action.name) && !allowStages.has(action.name)) {
    return transitionResult(TRANSITION_CONTROLS.HALT, {
      summaryPatch: {
        halted: true,
        halt_action: "ceiling",
        halt_reason: `consequence ceiling: "${action.name}" requires an explicit human grant (--allow-stage ${action.name})`,
      },
      logEvents: [{ ...base, outcome: "ceiling-halt" }],
      emittedEvents: [{ type: "ceiling", ...base }],
    });
  }

  if (untilIndex >= 0 && order.indexOf(action.name) > untilIndex) {
    return transitionResult(TRANSITION_CONTROLS.HALT, {
      summaryPatch: {
        halted: true,
        halt_action: "until",
        halt_reason: `reached --until boundary "${until}"`,
      },
      logEvents: [{ ...base, outcome: "until-halt" }],
      emittedEvents: [{ type: "until", ...base }],
    });
  }

  if (budgetUsd != null && spent >= budgetUsd) {
    return transitionResult(TRANSITION_CONTROLS.HALT, {
      summaryPatch: {
        halted: true,
        halt_action: "budget",
        halt_reason: `budget cap reached: $${spent.toFixed(2)} ≥ $${budgetUsd.toFixed(2)}`,
      },
      logEvents: [{ ...base, outcome: "budget-halt", cost_usd: spent }],
      emittedEvents: [{ type: "budget", budget_kind: "usd", ...base, cost_usd: spent }],
    });
  }

  if (budgetTokens != null && tokensUsed >= budgetTokens) {
    return transitionResult(TRANSITION_CONTROLS.HALT, {
      summaryPatch: {
        halted: true,
        halt_action: "budget",
        halt_reason: `token budget cap reached: ${tokensUsed} ≥ ${budgetTokens}`,
      },
      logEvents: [{
        ...base,
        outcome: "token-budget-halt",
        tokens_used: tokensUsed,
        token_basis: tokenBasis,
      }],
      emittedEvents: [{
        type: "budget",
        budget_kind: "tokens",
        ...base,
        tokens_used: tokensUsed,
        token_basis: tokenBasis,
      }],
    });
  }

  return null;
}

function normalizeDispatchResults(runResult) {
  const results = Array.isArray(runResult) ? runResult : (runResult.results || []);
  const nonSkipped = results.filter((result) => !result.skipped);
  const queueWaitMs = results.reduce((total, result) => {
    const value = result.queueMs ?? result.queue_ms;
    return total + (typeof value === "number" && Number.isFinite(value) ? value : 0);
  }, 0);
  return {
    results,
    timedOut: results.some((result) => result.timedOut),
    wroteGate: nonSkipped.every((result) => result.gatePath),
    stubGate: nonSkipped.some((result) => result.stubGate),
    exitCode: nonSkipped.length > 0 && nonSkipped.every((result) => result.exitCode === 0) ? 0 : 1,
    queueWaitMs,
  };
}

function transientDelayPlan({ retryDelayMs, timedOut, stubGate, exitCode }) {
  const base = typeof retryDelayMs === "number" && Number.isFinite(retryDelayMs)
    ? Math.max(0, retryDelayMs)
    : 30000;
  if (base === 0) return { delayMs: 0, retryReason: "disabled", backoffClass: "none" };
  if (timedOut) return { delayMs: base, retryReason: "timeout", backoffClass: "full" };
  if (stubGate) {
    return { delayMs: Math.min(base, 5000), retryReason: "stub-gate", backoffClass: "short" };
  }
  if (exitCode !== 0) {
    return { delayMs: Math.min(base, 5000), retryReason: "nonzero-exit-no-gate", backoffClass: "short" };
  }
  return { delayMs: base, retryReason: "unknown-no-gate", backoffClass: "full" };
}

function dispatchOutcomeTransition({
  action,
  base,
  transient,
  maxTransientRetries,
  retryDelayMs,
  retryReason,
  backoffClass,
  wroteGate,
  exitCode,
  timedOut,
  stubGate,
}) {
  const dispatchClass = classifyDispatch(
    { wroteGate, exitCode, timedOut, stubGate },
    { transientRetries: transient[action.name] || 0, maxTransientRetries },
  );

  if (dispatchClass === "ok") {
    return transitionResult(TRANSITION_CONTROLS.CONTINUE, {
      statePatch: { transient: { ...transient, [action.name]: 0 } },
      details: { dispatchClass },
    });
  }

  if (dispatchClass === "transient") {
    const attempt = (transient[action.name] || 0) + 1;
    return transitionResult(TRANSITION_CONTROLS.CONTINUE, {
      statePatch: { transient: { ...transient, [action.name]: attempt } },
      logEvents: [{
        ...base,
        outcome: "transient-retry",
        attempt,
        delay_ms: retryDelayMs,
        retry_reason: retryReason || null,
        backoff_class: backoffClass || null,
        stub_gate: stubGate || undefined,
      }],
      emittedEvents: [{
        type: "transient-retry",
        ...base,
        attempt,
        delay_ms: retryDelayMs,
        retry_reason: retryReason || null,
        backoff_class: backoffClass || null,
      }],
      details: { dispatchClass, retry: true, removeStubGate: stubGate, delayMs: retryDelayMs, retryReason, backoffClass },
    });
  }

  return transitionResult(TRANSITION_CONTROLS.HALT, {
    summaryPatch: {
      halted: true,
      halt_action: "structural-input",
      halt_failure_class: "structural-input",
      halt_reason:
        `dispatch of "${action.name}" produced no gate and is not transient ` +
        `(clean exit with no output, or repeated failure) — input is structurally unworkable`,
    },
    logEvents: [{ ...base, outcome: "structural-halt" }],
    emittedEvents: [{ type: "structural", ...base }],
    details: { dispatchClass },
  });
}

function targetedFixNoChangeTransition({ action, base, evidence, workstream }) {
  const reason =
    `targeted fix for "${action.name}" returned without modifying blocker file(s): ` +
    `${evidence}; escalating for a ruling`;
  return transitionResult(TRANSITION_CONTROLS.HALT, {
    summaryPatch: {
      halted: true,
      halt_action: "resolve-escalation",
      halt_failure_class: "convergence-exhausted",
      halt_reason: reason,
      blockers: [],
      no_source_change_evidence: evidence,
    },
    logEvents: [{
      ...base,
      outcome: "targeted-fix-no-source-change",
      no_source_change_evidence: evidence,
      workstream,
    }],
    emittedEvents: [{
      type: "halt",
      ...base,
      action: "resolve-escalation",
      failure_class: "convergence-exhausted",
      reason,
      no_source_change_evidence: evidence,
      workstream,
    }],
  });
}

function scopeGateTransition({ base, outOfScope }) {
  if (outOfScope.length === 0) return null;
  const reason =
    `repair scope gate: build touched files outside the diagnosed affected-files set: ${outOfScope.join(", ")}`;
  return transitionResult(TRANSITION_CONTROLS.HALT, {
    summaryPatch: {
      halted: true,
      halt_action: "scope-gate",
      halt_failure_class: "scope-gate",
      halt_reason: reason,
      out_of_scope: outOfScope,
    },
    logEvents: [{ ...base, outcome: "scope-gate-fail", out_of_scope: outOfScope }],
    emittedEvents: [{ type: "halt", ...base, action: "scope-gate", reason, out_of_scope: outOfScope }],
  });
}

module.exports = {
  dispatchGuardTransition,
  normalizeDispatchResults,
  transientDelayPlan,
  dispatchOutcomeTransition,
  targetedFixNoChangeTransition,
  scopeGateTransition,
};
