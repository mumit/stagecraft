- **Dispatches made outside a run are now excluded explicitly rather than
  silently (Phase 42.5).** `devteam stage --headless` — the direct-remediation
  path — records a run-corpus entry with no `run_id` and writes no run-log
  event, so the run-log-derived `durable_dispatch_observations` count
  structurally could not see it. A reviewer weighing D5's "≥5 durable dispatches
  per (role, host) pair" had no way to tell a complete count from a partial one.
  `devteam evidence status` and exported bundles now carry
  `quality.dispatches_outside_run`, sourced from the corpus, so the gap is
  stated: "12 this evidence path can see, plus 3 it cannot". *Honest scope
  note:* this reports the exclusion, it does not fold those dispatches into the
  durable count — they carry no run-log provenance, and quietly merging the two
  populations would be the opposite of the fix. The key is omitted rather than
  zero-filled when the corpus was not consulted, keeping "none outside a run"
  distinct from "this export could not tell", and it uses the same optional-key
  validation pattern as `durable_dispatch_observations`, so a bundle exported
  before this change validates unchanged.
