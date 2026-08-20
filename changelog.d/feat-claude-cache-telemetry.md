- **Claude Code cache telemetry is now observed.** `core/performance/calibration.js`
  has computed a prompt-cache hit rate from
  `_orchestrator_observed.cached_tokens` since phase 39, but the claude-code
  stream-json parser read only `input_tokens`/`output_tokens`/`total_cost_usd`
  — so the host carrying the largest inlined prefix contributed zero samples to
  it. The parser now captures `cache_read_input_tokens` and
  `cache_creation_input_tokens` (field names verified against claude-code
  2.1.207's own result message), the orchestrator records them on the gate as
  `cached_tokens` / `cache_creation_tokens`, and the corpus and calibration
  report carry them through. `devteam performance` gains
  `cache.cache_creation_tokens` and `cache.read_per_write` — a prefix written to
  cache on every dispatch and rarely read back is not paying for itself, and
  cache writes cost more than plain input. This is what makes phase-32.1's
  byte-stable prompt prefix measurable rather than assumed. *Honest scope note:*
  observation only — no caching behavior changes, and no breakpoints are
  enabled. Both counters are omitted rather than zero-filled when a host does
  not report them, so an older CLI stays distinguishable from a genuine cache
  miss (a reported `0` is recorded as `0`).
