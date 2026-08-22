- **`run()`'s run-plan construction moves to `core/driver-plan.js`.** Slice 5 of
  the P2-2 decomposition, and the one #462 was written to make safe.
  `resolvePlanInputs()` answers "what will this run actually dispatch, and what
  should that cost?" — right-sizing skips, active-role candidates, expected
  workstreams, ceremony preview. `materializeRunPlan()` turns that into the
  fingerprinted ADR-018 contract on disk and announces it. The two are one job
  that `run()` had separated by ~80 lines of unrelated setup.
  `run()` drops from 1,652 to 1,609 lines; `core/driver.js` from 2,396 to 2,348.
  Neither the drift reconciliation nor the plan schema changes — `persistRunPlan`
  stays in `core/run-plan.js`, and it still throws rather than returning a
  verdict, so the caller's lock-releasing `finally` continues to cover a
  rejection.
- **The characterization suite now pins stage dispositions by value, not by
  identity.** Its stage-disposition test asserted only that
  `included + skipped_by_config + skipped_by_right_sizing == total`, which holds
  just as well when right-sizing produces nothing at all (18 included, 0
  skipped) — so deleting right-sizing entirely passed it. It now pins the five
  stages preflight drops from `full` by name, the expected-workstream count
  against the right-sized list rather than the raw track shape, and that the
  ceremony preview covers exactly the stages that will dispatch.
  *Honest scope note:* two of eight mutations still pass, and both are no-ops on
  the test fixture rather than gaps — a bare project discovers no active roles
  and never makes `ceremonyPreview` throw, so discarding discovery and making
  the advisory preview fatal change nothing there. Covering them needs a fixture
  with real source files, which is a separate piece of work.
