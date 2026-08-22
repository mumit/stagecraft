- **`run()`'s run-state initialization moves to `core/driver-run-state.js`.**
  Slice 4 of the P2-2 decomposition. `initRunState()` answers one question —
  what does a run carry across invocations, and how is that reconciled when the
  `run-state.json` on disk predates a field this version expects? `run()` drops
  from 1,703 to 1,652 lines and `core/driver.js` from 2,623 to 2,396.
  The token-accounting helpers (`tokenUsageDetail`, `combineTokenUsage`,
  `tokenUsageForRunIds`, `tokenEntryForGate`) move with it: `token_usage_baseline`,
  `token_run_ids`, and `token_dispatches_expected` are run-state fields and those
  functions exist to populate and read them. `tokenUsageDetail` is re-exported
  from `core/driver.js`, so its public API is unchanged.
  `nowTs` is now passed in rather than read from the clock inside, which makes
  the initializer deterministic to test.
  *Honest scope note:* behavior-preserving, and verified as such rather than
  asserted — the prologue characterization suite passes unchanged, and six
  mutations of the reconciliation logic each fail at least one suite.
- **The prologue characterization suite covers resume reconciliation.** It did
  not before: all six mutations above — resetting the logical run lineage on
  every resume, dropping the `prior_run_id` back-link, resetting the wave
  counter, overwriting a resumed track, inheriting a dead wave's workstreams,
  duplicating a run id — passed the end-to-end suite untouched, because it only
  ever compared plan fingerprints across a resume. It now asserts the identity
  fields a resumed run's accounting and evidence grouping depend on, which
  catches two of the six directly; the rest are covered by 17 new unit tests.
