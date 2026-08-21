- **`observed-total` in the ceremony preview now totals.** The empirical
  estimate summed only `tokens_in + tokens_out`, excluding the cache counters.
  On an agentic host those dominate: a measured `stage-04` dispatch reported 66
  uncached input and 14,866 output against 2,049,649 cache reads and 49,888
  cache writes, so a field named `observed-total` reported 14,932 for 2,114,469
  tokens actually touched — low by a factor of 140. The counters only became
  visible on claude-code once the parser began capturing them, which is why
  this surfaced now. `tokens_breakdown` keeps the uncached and cached halves
  separable, because a large total is not proportionally a large bill — cache
  reads bill well below uncached input, and `cost_usd` remains the authoritative
  money figure.
- **The static estimate's input-floor caveat prints whenever the estimate is
  static**, not only when a dollar figure happens to be resolvable. The no-cost
  case is exactly where a reader has least to go on: a `loop` build dispatch
  touched ~2.1M tokens against a ~21k static prompt estimate, because the host's
  agentic loop re-reads its accumulated context every turn. The wording now says
  so.
