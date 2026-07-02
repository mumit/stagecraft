## Performance

- Added `devteam performance critical-path`, a run-log based report for dispatch wall time, merge time, retry delay, workstream compute, parallel savings, telemetry coverage, and repeated verification-command candidates.
- Persisted `dispatch-started`, `merge-started`, `merge-finished`, and retry `delay_ms` events so critical-path reports do not depend on model-authored claims.
