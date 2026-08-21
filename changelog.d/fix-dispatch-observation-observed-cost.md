- **Evidence now reports the cost and model the orchestrator observed.** Both
  routing readers recorded the *model-asserted* `gate.cost_usd` and `gate.model`
  rather than the orchestrator's own `_orchestrator_observed` / `model_requested`
  fields, so a dispatch whose cost the orchestrator had actually observed still
  contributed `cost_obs: 0` and `model=unknown` to D5's denominator. The
  [2026-08-21 Phase 41 re-review](plans/phase-41-evidence-review-2026-08-21.md)
  found this still blocking the gate after the gate-level telemetry (#429, #430)
  was working — a fresh run's corpus carried $1.88 while the evidence path
  reported nothing. A gate carrying cost only in `_orchestrator_observed` and a
  model only in `model_requested` now reports `model=claude-opus-5`,
  `cost_obs=1`, `$0.53`.
- **The precedence lives in one place: `core/gates/observed.js`.** Three readers
  wanted the same answer and two had drifted — `core/driver.js`'s run cost total
  was correct, while its dispatch-observation writer and
  `core/evidence/analyzer.js`'s gate-snapshot fallback were not. This is the same
  drift the framework-owned path list produced before it was centralized in
  `core/paths.js`, so it is centralized the same way, with a drift-guarding test
  suite. *Honest scope note:* observation only — no historical record changes,
  because a model id and cost that were never captured cannot be reconstructed.
  Durable dispatch-observation events additionally carry `cost_basis`
  (`observed` / `derived` / `asserted`) in the local run log; the exported bundle
  still carries the number, not the basis, so no bundle schema changes.
