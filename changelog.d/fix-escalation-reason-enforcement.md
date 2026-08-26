- **`status: ESCALATE` gates without an `escalation_reason` are now rejected
  at write time, and `devteam next`/`devteam ruling` fall back sensibly when
  an older gate lacks one.** A real headless run had a review role
  self-escalate directly (per `rules/gates-core.md`'s "same failure twice =
  escalate, don't retry" guidance) without setting `escalation_reason`.
  Nothing caught it: `core/gates/validator.js` had no check for the field,
  so the gate passed with `status=ESCALATE` and no reason, and
  `core/orchestrator.js`'s resolve-escalation branch read
  `gate.escalation_reason` straight off the gate — with it empty, `devteam
  next`/`devteam run` could only report the generic fallback "escalation
  required; pipeline halted", giving a human nothing to rule on even though
  the gate's own `blockers`/`previous_failure_reason` fields fully explained
  it.

  The validator now exits 1 when `status` is `ESCALATE` but
  `escalation_reason` is missing or empty, documented in
  `rules/gates-core.md`. Since that check can't retroactively fix a gate
  already on disk (an older run, a host that skips the hook, hand-edited
  state), `core/orchestrator.js` and `devteam ruling`'s auto-derived topic
  now share a new `escalationReasonFor(gate)` helper that falls back to the
  gate's `blockers`/`previous_failure_reason` before resorting to the bare
  generic message.
