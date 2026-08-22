- **`nonNegativeNumber` has one home (`core/numbers.js`).** `core/driver.js`,
  `core/corpus.js`, and `core/gates/observed.js` each carried a byte-identical
  private copy of the predicate that decides whether a telemetry figure from a
  model or a host CLI can be trusted.
  *Honest scope note:* the three copies had **not** drifted, so this is a
  cleanup, not a bug report — no behavior changes. It is filed because it is the
  same shape as two defects this codebase already shipped: three readers of
  framework-owned paths that disagreed (#431) and two readers of observed
  cost/model precedence that disagreed (#450). Both were found only after they
  had returned wrong answers in production evidence. The rule this predicate
  encodes — absent telemetry is `null`, never `0`, so a budget reports no
  coverage instead of silently understating spend — is now stated once and
  covered by tests.
