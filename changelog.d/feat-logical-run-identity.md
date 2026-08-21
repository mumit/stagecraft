- **`run_count` counts logical runs, not invocations (Phase 42.5).** `run_id` is
  the invocation timestamp and every `devteam run --resume` mints a new one, so
  evidence counted one run per `run-start` event — a single feature change
  driven through two resumes appeared three times in the denominator that
  readiness logic divides by. This is the conflation the
  [2026-08-19 Phase 41 review](plans/phase-41-evidence-review-2026-08.md) flagged
  when it declined to treat its 10 run records as 10 feature changes. The driver
  now sets a `logical_run_id` — the lineage root, preserved across resumes in
  `run-state.json` — and emits it on every `run-start`; the analyzer groups by
  it, so three invocations of one change report `run_count: 1` with one
  completion. *Honest scope note:* the id is local. `pipeline/run-log.jsonl` is
  gitignored operational state, the exported bundle gains no field and stays a
  count, and the privacy boundary (timestamps are never copied) is unchanged. A
  run log written before this field counts exactly as it did before, one run per
  `run-start`, so no historical bundle changes meaning. Two of 42.5's four
  acceptance criteria remain open: durable counting of every dispatch including
  direct remediation, and a typed CLI path for recording manual Principal
  rulings.
