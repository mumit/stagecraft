- **`devteam chat` can see how the run ended.** Three fields of the grounded
  snapshot's `run` block — `run_id`, `status`, and `halted` — read keys that
  nothing in the codebase has ever written to `run-state.json`, so they were
  `null` on every project, on every run, since the feature shipped. A user
  asking the conversational coordinator "why did the run stop?" got a snapshot
  that could not tell a halted run from a running one, alongside
  `unavailable: []` telling the model nothing was missing.
  The driver now persists how a run ended next to the cost and token totals it
  already records: `completed`, `halted`, `halt_action`, `halt_reason`. Those
  last two previously existed only on the in-memory summary, so they reached the
  operator's terminal and nothing else.
  A run that ends by **throwing** is recorded too (`failed`, `failure_reason`) —
  an unroutable host or an unreadable gate ends a run as surely as a halt, and
  left nothing on disk saying so. The error still propagates unchanged; it is
  recorded on the way out, not handled.
  `run_id` now reports the invocation (`started_at`) and `logical_run_id` the
  lineage root a `--resume` carries forward (42.5). `status` is one of
  `completed`, `halted`, `failed`, `in-progress`, or `null`.
  *Honest scope note:* snapshot `schema_version` goes to `"2"`. A `run-state.json`
  written before this change cannot say how its run ended, so it reports
  `unavailable: ["run-outcome"]` rather than an unqualified `halted: false` —
  the prompt instructs the model to call out missing evidence, and silence there
  would read as "it did not halt" instead of "nobody recorded whether it did".
