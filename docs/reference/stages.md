<!-- generated: do not hand-edit -->
<!-- To regenerate: npm run docs:generate (source: core/pipeline/stages.js) -->

# Stage Reference

Derived from `core/pipeline/stages.js`. 18 stages total (including all sub-stages).
Run `npm run docs:generate` to regenerate after editing stages.js.

**Conditional stages** only run when a specific field in a prior stage's gate is set.
**Mechanical stages** (roles: none) are auto-run by the orchestrator, not dispatched to an LLM.

**Gate file conventions:** workstream gates use a dot separator (`stage-NN.role.json`),
not a dash (`stage-NN-role.json`). See `core/hooks/approval-derivation.js` for the spec.

### Phase 1 — Planning

| Stage ID  | Name            | Roles     | Conditional on | Gate file(s)   | Artifact                      | Template                  |
| --------- | --------------- | --------- | -------------- | -------------- | ----------------------------- | ------------------------- |
| stage-01  | requirements    | pm        | —              | stage-01.json  | pipeline/brief.md             | brief-template.md         |
| stage-02  | design          | principal | —              | stage-02.json  | pipeline/design-spec.md       | design-spec-template.md   |
| stage-03  | clarification   | pm        | —              | stage-03.json  | pipeline/clarification-log.md | clarification-template.md |
| stage-03b | executable-spec | pm        | —              | stage-03b.json | pipeline/spec.feature         | spec-template.feature     |

### Phase 2 — Build

| Stage ID  | Name             | Roles                                                    | Conditional on                             | Gate file(s)                                                                                            | Artifact                     | Template                     |
| --------- | ---------------- | -------------------------------------------------------- | ------------------------------------------ | ------------------------------------------------------------------------------------------------------- | ---------------------------- | ---------------------------- |
| stage-04  | build            | backend, frontend, platform, qa; optional: documentation | —                                          | stage-04.json (merged); stage-04.{backend, frontend, platform, qa, documentation}.json (per-workstream) | pipeline/build-plan.md       | build-template.md            |
| stage-04a | pre-review       | platform                                                 | —                                          | stage-04a.json                                                                                          | pipeline/pre-review.md       | pre-review-template.md       |
| stage-04b | security-review  | security                                                 | stage-04a.security_review_required = true  | stage-04b.json                                                                                          | pipeline/security-review.md  | review-template.md           |
| stage-04c | red-team         | red-team                                                 | —                                          | stage-04c.json                                                                                          | pipeline/red-team-report.md  | red-team-report-template.md  |
| stage-04d | migration-safety | migrations                                               | stage-04a.migration_safety_required = true | stage-04d.json                                                                                          | pipeline/migration-safety.md | migration-safety-template.md |
| stage-04e | preflight        | *(mechanical — no dispatch)*                             | —                                          | stage-04e.json                                                                                          | —                            | —                            |

### Phase 3 — Peer Review

| Stage ID | Name        | Roles                                                                               | Conditional on | Gate file(s)                                                                                      | Artifact                              | Template           |
| -------- | ----------- | ----------------------------------------------------------------------------------- | -------------- | ------------------------------------------------------------------------------------------------- | ------------------------------------- | ------------------ |
| stage-05 | peer-review | backend, frontend, platform, qa; optional: documentation *(dispatched as reviewer)* | —              | stage-05.json (merged); stage-05.{backend, frontend, platform, qa, documentation}.json (per-area) | pipeline/code-review/by-<reviewer>.md | review-template.md |

### Phase 4 — Verification

| Stage ID  | Name                      | Roles    | Conditional on | Gate file(s)   | Artifact                         | Template                        |
| --------- | ------------------------- | -------- | -------------- | -------------- | -------------------------------- | ------------------------------- |
| stage-06  | qa                        | qa       | —              | stage-06.json  | pipeline/test-report.md          | test-report-template.md         |
| stage-06b | accessibility-audit       | qa       | —              | stage-06b.json | pipeline/accessibility-report.md | test-report-template.md         |
| stage-06c | observability-gate        | platform | —              | stage-06c.json | pipeline/observability-report.md | test-report-template.md         |
| stage-06d | verification-beyond-tests | verifier | —              | stage-06d.json | pipeline/verification-report.md  | verification-report-template.md |
| stage-06e | performance-budget        | qa       | —              | stage-06e.json | pipeline/performance-report.md   | performance-report-template.md  |

### Phase 5 — Delivery

| Stage ID | Name          | Roles        | Conditional on | Gate file(s)                                                          | Artifact                  | Template                  |
| -------- | ------------- | ------------ | -------------- | --------------------------------------------------------------------- | ------------------------- | ------------------------- |
| stage-07 | sign-off      | pm, platform | —              | stage-07.json (merged); stage-07.{pm, platform}.json (per-workstream) | pipeline/runbook.md       | runbook-template.md       |
| stage-08 | deploy        | platform     | —              | stage-08.json                                                         | pipeline/deploy-log.md    | pr-summary-template.md    |
| stage-09 | retrospective | principal    | —              | stage-09.json                                                         | pipeline/retrospective.md | retrospective-template.md |

<!-- /generated -->
