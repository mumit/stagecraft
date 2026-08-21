"use strict";

// Effective safety policy for a run: the caps that bind it, and the operator
// warnings that go with resolving them (audit's P2-2 decomposition, slice 2).
//
// One concern, split into two halves on purpose. `resolveRunSafety` is pure —
// it takes the run's inputs and returns the policy plus the warnings that
// *should* be emitted, deciding nothing about how. `emitSafetyWarnings` does
// the stderr writing. That split is what makes the policy testable without
// capturing process output, and it keeps the decision of *what* to warn about
// separate from *where* it goes.
//
// The policy the caller receives is the run's starting policy, not its final
// one: `run()` still reassigns it when a stoplist bypass is authorized
// mid-prologue (ADR-018 binds a bypass to a hashed feature/brief/stoplist), so
// ownership of that mutation deliberately stays in the driver.

const { resolveEffectiveSafetyPolicy } = require("./run-safety");

const LEGACY_STATE_WARNING =
  "[devteam run] Warning: legacy run-state had no persisted safety policy; "
  + "cap flags on this resume are now authoritative and omitted caps are explicitly uncapped.\n";

const NO_CAP_WARNING =
  "[devteam run] Warning: no usage cap set. The run will not halt on spend or tokens.\n" +
  "              Use --budget-usd <amount> and/or --budget-tokens <count>.\n";

/**
 * @param {object}  input
 * @param {boolean} [input.resume]
 * @param {object}  [input.state]        run-state.json when resuming
 * @param {number}  [input.budgetUsd]
 * @param {number}  [input.budgetTokens]
 * @returns {{ policy: object, budgetUsd: number|null, budgetTokens: number|null, warnings: string[] }}
 */
function resolveRunSafety(input = {}) {
  const resolved = resolveEffectiveSafetyPolicy({
    resume: input.resume,
    state: input.state,
    budgetUsd: input.budgetUsd,
    budgetTokens: input.budgetTokens,
  });
  const policy = resolved.policy;
  const budgetUsd = policy.budget_usd;
  const budgetTokens = policy.budget_tokens;
  const warnings = [];
  // A resumed run whose state predates persisted safety policy: say plainly
  // that omitted caps mean uncapped, rather than letting a resume silently
  // inherit nothing.
  if (resolved.migrated) warnings.push(LEGACY_STATE_WARNING);
  // An uncapped run is legal and sometimes intended, so this warns rather than
  // blocking — but it must not be silent, because an uncapped autonomous run is
  // the single most expensive way to be surprised.
  if (budgetUsd === null && budgetTokens === null) warnings.push(NO_CAP_WARNING);
  return { policy, budgetUsd, budgetTokens, warnings };
}

function emitSafetyWarnings(warnings, write = (text) => process.stderr.write(text)) {
  for (const warning of warnings || []) write(warning);
}

module.exports = { resolveRunSafety, emitSafetyWarnings, LEGACY_STATE_WARNING, NO_CAP_WARNING };
