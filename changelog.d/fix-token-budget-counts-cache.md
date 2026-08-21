- **`--budget-tokens` now counts cache reads and writes.** The run's token total
  summed only `tokens_in + tokens_out`, which on an agentic host is a rounding
  error: a measured `loop` run reported 52 uncached input and 11,293 output
  against 1,363,880 cache tokens, so the counter read **121× low** and the cap
  could not bind — the same shape as a stale pricing table making
  `--budget-usd` inert. `tokenEntryForGate` now includes
  `cached_tokens` and `cache_creation_tokens`, so `tokens_used` reports what a
  dispatch actually consumed and a `--budget-tokens` cap halts when it should.
  The run summary and `run-state.json` gain `tokens_cached` alongside the
  existing `tokens_in` / `tokens_out`, keeping the parts separable: cache reads
  bill well below uncached input, so a large total is not a proportionally
  large bill, and `--budget-usd` remains the control for money. *Honest scope
  note:* this is a **behavioral change to a safety control** — a run with an
  existing `--budget-tokens` value will now halt far earlier than before,
  because before it effectively never halted. It also removes a drift the
  ceremony preview's `observed-total` fix introduced, where the estimate counted
  cache and the live budget did not. Gates without cache counters (older hosts,
  older runs) contribute zero rather than NaN and are unaffected.
