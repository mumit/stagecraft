- **Token-derived cost for hosts that report usage but no dollars.** codex's
  `exec --json` stream carries token counts and neither a model id nor a cost,
  so `_orchestrator_observed.cost_usd` stayed `null`, `--budget-usd` enforced
  nothing on that host, and every cost denominator read zero — one of the two
  reasons the 2026-08-19 Phase 41 review recorded
  `projects-with-cost-telemetry: 0/2`. `patchGateForObservedUsage` now derives a
  figure from the observed tokens and `core/pricing.js`, priced by the
  host-reported model when there is one and otherwise by the routing-resolved
  pin (already passed to the CLI as `--model` since phase-32 item 32.3).
  `devteam run`'s budget check and cost total include it, and `cost_basis`
  gains a `derived` value. *Honest scope note:* the derived figure is written
  to `cost_usd_derived` with the pricing id in `cost_model` — never to
  `cost_usd`. A product of observed tokens and a table Stagecraft maintains is
  a weaker evidence class than a cost the host itself reported, and the two are
  kept separable so `cost_basis` cannot present a mixed total as single-source.
  With no model id, or no pricing entry for it, both fields stay absent and the
  existing D7 unpriced-model warning is still the only signal — nothing is
  fabricated.
