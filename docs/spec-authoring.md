# Spec authoring — closed-loop criteria → spec → tests

Stage 3b (executable-spec) and the `devteam spec` commands. The pipeline enforces an unbroken chain from feature acceptance criteria (`AC-N`) or repair regression criteria (`RC-N`) to Gherkin scenarios and test rows.

- [The chain](#the-chain)
- [Writing acceptance criteria](#writing-acceptance-criteria)
- [Repair-mode regression criteria](#repair-mode-regression-criteria)
- [Scaffolding the spec file](#scaffolding-the-spec-file)
- [Stage 03b gate](#stage-03b-gate)
- [Checking for drift](#checking-for-drift)
- [QA gate requirement](#qa-gate-requirement)
- [References](#references)

---

## The chain

```
pipeline/brief.md          AC-1, AC-2, AC-3  (PM writes at requirements stage)
        │
        ▼  stage-03b (executable-spec)
pipeline/spec.feature      @AC-1 Scenario: ...
                           @AC-2 Scenario: ...
                           @AC-3 Scenario: ...
        │
        ▼  stage-06 (QA)
pipeline/test-report.md    test row → @AC-1
                           test row → @AC-2
                           test row → @AC-3
```

Each acceptance criterion must map to exactly one Gherkin scenario. Each scenario must map to exactly one test row. The pipeline enforces both constraints.

Repair runs use the same chain with `pipeline/diagnosis.md` as the criteria source and `RC-N` identifiers. A diagnosis with one unnumbered `## Regression Criterion` is treated as `RC-1`; its sole `@regression` scenario is mapped to that criterion automatically. Numbered `RC-N` tags remain available when a repair needs multiple regression criteria.

---

## Writing acceptance criteria

In `pipeline/brief.md`, the PM writes numbered acceptance criteria in this format:

```markdown
## Acceptance criteria

AC-1: Given a user with SMS opted in, when they complete checkout, they receive a confirmation SMS within 30 seconds.
AC-2: Given a user with SMS opted out, when they complete checkout, no SMS is sent.
AC-3: Given an invalid phone number, when opt-in is attempted, the form shows an inline error and does not submit.
```

Rules:
- Use `AC-N` (capital AC, hyphen, integer, no padding). Numbers start at 1.
- Each criterion must be testable — it describes an observable outcome.
- Out-of-scope items go in a separate `## Out of scope` section, not as criteria.

---

## Scaffolding the spec file

After requirements, scaffold the `.feature` file from the brief:

```bash
devteam spec generate
```

This reads `pipeline/brief.md`, extracts `AC-N` lines, and writes `pipeline/spec.feature` with one tagged Scenario per criterion:

```gherkin
Feature: SMS notification opt-in

  @AC-1
  Scenario: confirmation SMS sent on checkout with opt-in
    Given TODO
    When TODO
    Then TODO

  @AC-2
  Scenario: no SMS sent on checkout with opt-out
    Given TODO
    ...
```

The PM fills in the Given/When/Then steps at the executable-spec stage. The `TODO` placeholders make incomplete scenarios easy to spot.

## Repair-mode regression criteria

Repair mode writes `pipeline/diagnosis.md` instead of a feature brief. The preferred explicit form is:

```markdown
## Regression Criteria

RC-1: Given the original failure, when the fix is applied, then the command succeeds.
```

Tag the corresponding scenario `@RC-1`. For the common single-defect form, the diagnosis may instead contain one `## Regression Criterion` section and the scenario may carry only `@regression`; `devteam spec verify` assigns both to `RC-1`. `devteam spec generate` remains feature-only because repair scenarios must reproduce the diagnosed defect rather than use a generic scaffold.

---

## Stage 03b gate

The executable-spec stage gate (`stage-03b.json`) carries:

| Field | Type | Notes |
|---|---|---|
| `criteria_count` | number | AC count from `pipeline/brief.md` |
| `scenarios_count` | number | Scenario count in `pipeline/spec.feature` |
| `criteria_to_scenario_mapping` | object[] | One entry per AC: `{ac, scenario_title, tag}` |
| `all_criteria_mapped` | boolean | Whether every AC has a scenario |
| `drift` | boolean | Whether brief and spec are out of sync |

**PASS requires** `drift: false` AND `all_criteria_mapped: true`.

---

## Checking for drift

At any point in the pipeline:

```bash
devteam spec verify
```

This compares the criteria source (`pipeline/brief.md` for features or `pipeline/diagnosis.md` for repairs), `pipeline/spec.feature`, and `pipeline/test-report.md`, and reports:

- **Orphan criteria** — in the brief or diagnosis but missing from spec.feature
- **Orphan scenarios** — in spec.feature with no corresponding criterion in the source
- **Duplicate criterion numbers** — an `AC-N` or `RC-N` appears more than once
- **Unknown criterion refs in tests** — the test report references an ID that doesn't exist in the source
- **Untested scenarios** — scenario in spec.feature with no test row

Run `devteam spec verify` before the QA stage to catch drift early.

---

## QA gate requirement

The stage-06 (QA) gate must include `criterion_to_test_mapping_is_one_to_one: true` for PASS. QA is responsible for writing tests that map 1:1 to the scenarios in `pipeline/spec.feature`. The gate validator rejects a PASS gate that claims `all_acceptance_criteria_met: true` without the 1:1 mapping flag.

---

## References

- Stage: `core/gates/schemas/stage-03b.schema.json`
- Commands: `devteam spec generate`, `devteam spec verify`
- Related: [docs/FEATURES.md](FEATURES.md) § Advanced AI capabilities — Closed-loop AC → spec → tests
- Related: [docs/user-guide.md](user-guide.md) § Per-stage details — Stage 3b
