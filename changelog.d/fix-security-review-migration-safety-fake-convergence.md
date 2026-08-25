- **`security-review` (stage-04b) and `migration-safety` (stage-04d) no longer
  self-escalate as "no progress" after a single real attempt.** Neither stage
  had a registered fix-recipe, so a FAIL fell through to `DEFAULT_DIAGNOSE`
  (`clear_gates: []`). With nothing to clear, `next()` never re-dispatched the
  review — but the driver's own fix-and-retry bookkeeping still counted a
  "retry" and archived the same untouched FAIL gate a second time. Two
  archives of one real dispatch then read as byte-identical, and the
  no-progress convergence check escalated as "2 blockers identical across
  attempts 1,2" after exactly one genuine agent call — the review never got a
  chance to see changed code.

  Both stages are veto-power reviews of stage-04 build output, the same shape
  as the already-working `pre-review`/`red-team` recipes: the defect lives in
  a build workstream, not the review itself. They now get the same treatment
  — clear the affected build workstream gate(s) (read from
  `affected_workstreams`, the general FAIL-gate convention in
  `rules/gates-core.md`, with a disk-scan fallback), re-run build with the
  review's blockers as context, merge, then clear and re-run the review. A
  genuine second attempt now happens before any no-progress convergence
  verdict is possible.
