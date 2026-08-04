# Pipeline Artefact Templates

Markdown (and one Gherkin) scaffolds that agents copy into `pipeline/` (and a
couple into the project root) when first creating an artefact. Templates are
intentionally thin — they hold the structure the rules expect, not the
content. Field semantics live in `.devteam/rules/pipeline.md` and the
per-stage schemas under `../core/gates/schemas/`.

## How templates are used

- An agent copies the template to its destination on first creation, then
  fills in the body. Subsequent edits go directly to the destination, not
  the template.
- The orchestrator knows the mapping template ↔ destination via the
  `template`/`artifact` fields on each stage in `core/pipeline/stages.js`
  (the single source of truth — see `tests/contract.test.js`'s "every stage's
  trackOverrides template exists in templates/" and "stage skeletons satisfy
  schema required fields" checks).
- Bootstrap copies the entire `templates/` directory into target projects.
  Local edits to a template in a target project are preserved across
  re-bootstrap only if `.local.*` semantics apply — they do **not**, so
  customise via project-specific instructions in `AGENTS.md` rather than
  by forking templates.

## The templates

| File | Stage | Authoring agent | Destination | Purpose |
|---|---|---|---|---|
| `brief-template.md` | 1 | `pm` | `pipeline/brief.md` | Feature requirements: problem, user stories, acceptance criteria, out-of-scope, open questions, optional risk sections per track. |
| `loop-brief-template.md` | 1 (`loop` track) | `pm` | `pipeline/brief.md` | One-screen brief for the `loop` track (phase-29 item 29.1) — intent, numbered ACs, affected files; no user stories/risk sections. |
| `diagnosis-template.md` | 1 (`--repair` intent) | `pm` | `pipeline/diagnosis.md` | Root cause, proposed fix, affected files, regression criterion — replaces the feature brief when `intent: "repair"` (ADR-009 Phase 2). |
| `design-spec-template.md` | 2 | `principal` | `pipeline/design-spec.md` | Architecture-level design with requirements trace, components, interfaces, data model, risks, ADR links. |
| `adr-template.md` | 2 (or any time) | `principal` | `pipeline/adr/NNNN-title.md` | One Architecture Decision Record per binding ruling: status, context, decision, consequences, alternatives. Not wired to a `template:` field — authored ad hoc. |
| `clarification-template.md` | 3 | `pm` | `pipeline/clarification-log.md` | Open questions table with owners and answers. Mirrors the `QUESTION:` / `PM-ANSWER:` lines in `pipeline/context.md`. |
| `spec-template.feature` | 3b | `pm` | `pipeline/spec.feature` | Gherkin scenarios (one per AC-N, tagged `@AC-N`) bridging `brief.md`'s acceptance criteria to QA's tests (G2). |
| `build-template.md` | 4 | dev agents | `pipeline/build-plan.md` | Workstream-level plan: which area owns what, status per file/test/check. |
| `characterization-template.md` | 4 (`refactor` track) | dev agents | `pipeline/build-plan.md` | Same destination as `build-template.md`, but the "Current Behavior (Characterization)" section comes first — captured *before* any structural change lands (phase-35 item 35.5). |
| `pr-summary-template.md` | 4 | dev agents | `pipeline/pr-<area>.md` | Per-area PR summary with the four-step Plan from `coding-principles.md`. |
| `pre-review-template.md` | 4a | `platform` | `pipeline/pre-review.md` | Lint, type-check, dependency/license review, SCA results table; preconditions for Stage 5. |
| `review-template.md` | 4b, 5 | `security` / reviewers | `pipeline/security-review.md`, `pipeline/code-review/by-<reviewer>.md` | Per-area sections ending in `REVIEW: APPROVED` or `REVIEW: CHANGES REQUESTED`. The approval-derivation hook reads only the markers; everything else is human-readable context. |
| `red-team-report-template.md` | 4c | `red-team` | `pipeline/red-team-report.md` | Attack-surface walk, concrete reproducers, severity × likelihood × scope triage. |
| `migration-safety-template.md` | 4d | `migrations` | `pipeline/migration-safety.md` | Schema diff, backfill plan, dual-write strategy, rollback plan for data-layer changes. |
| `test-report-template.md` | 6, 6b, 6c | `qa` / `platform` | `pipeline/test-report.md`, `pipeline/accessibility-report.md`, `pipeline/observability-report.md` | Shared scaffold: suite summary and criterion-to-test mapping (stage 6, gates the Stage 7 auto-fold); WCAG findings (6b); metrics/logs/traces verification (6c). |
| `verification-sweep-template.md` | 6x (`quick`, compact-QA fold) | `qa` | `pipeline/verification-sweep-report.md` | Combined report when a compact-ceremony track folds two-plus of accessibility/observability/verification-beyond-tests/performance into one dispatch (phase-29 item 29.4). |
| `verification-report-template.md` | 6d | `verifier` | `pipeline/verification-report.md` | Property-based / mutation / formal verification methods attempted, per-method stats, blocking findings. |
| `performance-report-template.md` | 6e | `qa` | `pipeline/performance-report.md` | Lighthouse/bundle-size/load-test results against the configured performance budget. |
| `runbook-template.md` | 7→8 | platform / project owner | `pipeline/runbook.md` | Rollback procedure and health signals. Required for Stage 8 PASS — gate-validator escalates if missing. |
| `retrospective-template.md` | 9 | every agent + `principal` (synthesis) | `pipeline/retrospective.md` | Per-agent contribution sections plus a synthesis block. Promoted lessons land in the persistent `pipeline/lessons-learned.md`. |
| `production-feedback-template.md` | post-9 (operator) | stage manager | `pipeline/production-feedback.md` | Operator-curated production signals: SLO/metric deltas vs. the brief's targets, incidents since deploy, adoption signals. Optional — stage-09 reads it when present. Not wired to a `template:` field — copied manually. |

## Editing or adding templates

If you change a template's structure, also update:

1. The agent prompt(s) that author the artefact (under `roles/`).
2. The corresponding rule in `.devteam/rules/`.
3. The relevant schema under `../core/gates/schemas/` if the change adds a
   required field that ends up in a gate.
4. `tests/contract.test.js` if the template name or stage mapping changes.

If you add a new template, wire it into the relevant stage's `template:`
field in `core/pipeline/stages.js` (or a `trackOverrides.<track>.template`
for a track-specific variant) — `tests/contract.test.js`'s "every stage's
trackOverrides template exists in templates/" check catches a stage pointing
at a template that doesn't exist, and `npm run consistency` catches the
reverse: a stage referencing a schema/rule file that's gone missing.
