- **Pricing table refreshed against current provider rates (2026-08-20).**
  `core/pricing.js` was last updated in May and had no entry for any current
  frontier model, so `pricingFor()` returned `null` for every routed model, the
  D7 unpriced-model warning fired on every dispatch, and `--budget-usd`
  enforced nothing. Added the Claude 5 family (Fable 5, Mythos 5, Opus 5,
  Sonnet 5) plus Opus 4.8, the GPT-5.5/5.6 tiers and GPT-4.1/o3, and the Gemini
  3.x Flash tiers. Corrected several stale rates that were materially wrong,
  not just missing: Opus 4.7/4.6 were listed at $15/$75 against an actual
  $5/$25, GPT-5 at $10/$30 against $1.25/$10, Gemini 2.5 Flash at
  $0.075/$0.30 against $0.30/$2.50, and Haiku 4.5 at $0.80/$4.00 against
  $1.00/$5.00.
- **Model-id prefix matching now requires a name boundary.** `pricingFor()`
  fell back to a bare `startsWith()`, so `gpt-5.6-sol` matched the `gpt-5`
  entry and was priced at a quarter of its real input rate. The remainder must
  now begin with `-`, which keeps dated snapshots
  (`claude-opus-4-7-2025-05` → `claude-opus-4-7`) resolving while an unlisted
  sibling returns `null` and raises the honest unpriced-model warning instead
  of a silently low number. *Honest scope note:* list price only — introductory
  and promotional rates are recorded as comments and never encoded, because an
  expired promo under-reports every downstream cost and budget check.
