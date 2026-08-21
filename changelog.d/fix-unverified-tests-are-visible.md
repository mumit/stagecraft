- **A verification that did not run now says so on the gate (Phase 42.4).** When
  no test or lint command could be discovered, the orchestrator recorded
  `_orchestrator_stamped.runs.test = { skipped: … }` and left the model's claim
  untouched — so a stage-06 gate in a project with no tests at all could read
  `status: PASS`, `tests_passed: 12`, `tests_failed: 0` with no blocker and no
  warning, and every downstream consumer (sign-off, deploy, peer review, the
  evidence bundle) saw a clean pass. The skip is now also recorded as a
  `warnings[]` entry on the gate itself: `test unverified by orchestrator: no
  test command configured or discovered`. *Honest scope note:* non-blocking, and
  the model's assertion is left standing rather than overwritten — the
  orchestrator is reporting an absence of evidence, not manufacturing a verdict.
  This is the shape C3 already used to close the same hole for
  `license_check_passed`. Applies to the test and lint skips at stage-04a,
  stage-04, and stage-06; stage-03b's repair-mode `reproduction_pre_build`
  snapshot is deliberately unchanged, since its absence is expected and it
  validates no model claim. Re-stamping a gate does not duplicate the warning.
