- **`devteam evidence record-ruling` — a typed path for a Principal ruling a
  human applied (Phase 42.5, completes the item).** `--auto-rule` already writes
  a durable `auto-ruled` event, so rulings the driver applied under a standing
  grant are evidence. A ruling the operator made themselves left no typed trace,
  and the plan explicitly forbids inferring one from prose — which is part of
  why the [2026-08-19 Phase 41 review](plans/phase-41-evidence-review-2026-08.md)
  recorded `granted ruling events: 0 / 1` against ADR-005. Record it instead:
  `devteam evidence record-ruling --class doc-only --yes`.
  The record binds to a real observed `judgment-gate` halt, the same safeguard
  ADR-012 gives resolution acceptance, so ruling evidence cannot be minted for an
  escalation that never happened and the same escalation cannot be recorded
  twice. Only the normalized class is stored; the halt's free-form reason is not.
- **Recorded rulings are reported as a separate population.** ADR-005 asks which
  grants operators routinely approve: an auto-applied ruling is evidence a
  standing grant already exists, while a hand-recorded one is evidence about what
  a human chose, so merging them would answer a different question than the gate
  poses. `devteam evidence status` and exported bundles gain a
  `recorded_rulings` section alongside `rulings`. *Honest scope note:* the
  section is optional and omitted when empty, uses the same optional-key
  validation pattern as `resolutions`, and applies the same k-anonymity
  suppression floor as every other exported section — so a bundle exported
  before this change validates unchanged, and the new section is not a way
  around the export boundary.
