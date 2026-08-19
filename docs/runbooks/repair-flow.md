# Runbook: Repair mode (`devteam run --repair`)

Reference for running and troubleshooting `devteam run --repair "<symptom>"`. Covers the three
operator decision points: the diagnosis gate, scope-gate FAIL recovery, and tri-state reproduction.

For vocabulary (what `--repair`, `hotfix`, and `fix-and-retry` each mean and why they differ),
see [`docs/conventions.md` § Repair-mode vocabulary](../conventions.md#repair-mode-vocabulary-adr-009-decision8).

For the full decision record, see [ADR-009](../adr/009-repair-mode.md).

---

- [The diagnosis gate — what you're looking at](#the-diagnosis-gate--what-youre-looking-at)
- [Scope-gate FAIL recovery](#scope-gate-fail-recovery)
- [Tri-state reproduction (`reproduced` field)](#tri-state-reproduction-reproduced-field)
- [Verify the repair trace](#verify-the-repair-trace)

---

## The diagnosis gate — what you're looking at

When `devteam run --repair` is used, stage-01 (requirements) produces a **DIAGNOSIS** document
instead of a feature brief. The gate always lands as an ESCALATE: it cannot proceed without
explicit human approval or `--auto-rule diagnosis-approved`.

### What to read

1. `pipeline/gates/stage-01.json` — check the `status` field (should be `ESCALATE`) and
   `decision_needed` (should read something like "Approve diagnosis before build proceeds").
2. `pipeline/diagnosis.md` — the diagnosis document itself:
   - **Root cause** with specific `file:line` references.
   - **Proposed fix** — the minimal change the build stage will attempt.
   - **`affected_files`** — the exhaustive list of files the fix must touch. This activates
     the structural scope gate in the build stage.
   - **Regression criterion** — phrased so the executable-spec stage (stage-03b) can write
     a failing-first runnable test.

### How to approve in interactive mode

Read the diagnosis. If the root cause and affected-files list look correct:

```
devteam next
```

`devteam next` will show the judgment question. Answer it; the run advances to build.

### How to approve in autonomous mode

Pass `--auto-rule diagnosis-approved` when launching the run:

```
devteam run --repair "symptom" --auto-rule diagnosis-approved
```

The driver dispatches the Principal to issue a `PRINCIPAL-RULING: ... [class: diagnosis-approved]`
line and continues autonomously. A given escalation is auto-ruled at most once.

### Skip diagnosis when you already know the defect location

If you know the exact file and line (e.g. from a stack trace), use the escape hatch:

```
devteam run --repair "symptom" --repair-at src/auth.js:42
```

`--repair-at` seeds the affected-files list directly, writes a synthetic PASS stage-01 gate,
and skips the LLM diagnosis dispatch. The reproduction stage (stage-03b) still runs.

### The knowledge-gate limit

For complex bugs (race conditions, environment-specific failures) the diagnosis may be
speculative, and a human can approve it only if they understand the code well enough to judge
it — exactly when they needed the tool least. Stage-03b's red→green reproduction is the
mitigation: if the fix actually resolves the defect, the failing test turns green regardless
of whether the root-cause explanation was perfectly accurate.

---

## Scope-gate FAIL recovery

After the diagnosis gate passes, the build stage runs in PATCH MODE constrained to the
`affected_files` list. If the build agent writes files outside that list, the run halts with
`halt_action: "scope-gate"` before the gate is written.

```
devteam run → … → scope-gate FAIL
```

### Why it fires

The structural scope gate enforces ADR-009 §Decision.3: minimality is mechanical, not a
reviewer opinion. A build that touches a file not in `affected_files` is a gate FAIL by diff.

### How to recover

**Option A — Amend the diagnosis scope.** If the build genuinely needed an additional file, the
diagnosis was incomplete. Edit `pipeline/diagnosis.md` to add the file to `affected_files`, then
re-run the diagnosis gate approval and restart the build:

```
# After editing pipeline/diagnosis.md:
devteam stage requirements --repair "symptom"   # re-runs diagnosis stage
devteam next                                    # proceed through approval → build
```

The amendment is a recorded justification that peer review scrutinizes — it is a default to
push against, not a cage.

**Option B — Use `--repair-at` with the corrected file list.** If you know all the files
needed upfront, seed them directly:

```
devteam run --repair "symptom" --repair-at src/auth.js:42,src/session.js:18
```

### Scope gate is inert without a diagnosis

When `--repair-at` is not used and the diagnosis gate has not yet passed (i.e., no
`affected_files` list in `run-state.json`), the scope gate is wired but inert. It only
activates once `affected_files` is known. This is the Phase 1 / Phase 2 sequencing from
ADR-009 §Decision.6.

---

## Tri-state reproduction (`reproduced` field)

Stage-03b (executable-spec) writes a failing-first Gherkin Scenario in repair mode. The
stamp layer verifies it by running the test suite before and after the fix. The gate field
`reproduced` reports the outcome in three states:

| Value | Meaning |
|---|---|
| `true` | Bug reproduced; a runnable failing test was written and the stamp confirmed red→green. |
| `false` | Could not reproduce the defect at all — test was green before the fix. |
| `"unverifiable: <reason>"` | An automated test is impossible (external API, nondeterminism, data dependency). |

### When `reproduced: "unverifiable: <reason>"`

The stamp emits a loud `WARN reproduction-unverifiable` into `gate.warnings` and continues
without blocking. The run does **not** silently pass — the warning is visible in `devteam next`
output and in `pipeline/run-log.jsonl`.

Accepted skip reasons (by the project's "skip loudly" convention):

- External API calls or vendor services that cannot be mocked reliably.
- Timing-sensitive or nondeterministic failures that cannot be expressed as a deterministic test.
- Data-state bugs requiring specific production data that cannot be replicated in the test environment.

"Didn't have time" is not an accepted reason — it becomes a `false` (could not reproduce),
not `"unverifiable"`.

### Convention: consistent with license and production-feedback gates

The tri-state is the same pattern used by:
- License gate: `license_check_passed: true | false | "unverified-by-orchestrator"`
- Production feedback: `production_feedback_reviewed: true | false | "absent"`

It must **never** silently pass. A silent pass would hide that the fix was unverified.

### Reproduction stage on hotfix depth

The `hotfix` track previously skipped stage-03b. In repair mode, stage-03b is injected
immediately before the build stage even on hotfix depth — repair intent pulls it into the active
stage list. This gives hotfix-depth repair runs the reproduction discipline they otherwise lack.

## Verify the repair trace

Run this after QA writes `pipeline/test-report.md`:

```bash
devteam spec verify --strict
```

For repair pipelines the verifier reads regression criteria from `pipeline/diagnosis.md` because
there is no feature brief. Explicit `RC-N` definitions map to `@RC-N` scenarios and `RC-N` test
rows. For the common single-defect diagnosis, one unnumbered `## Regression Criterion` section
and one `@regression` scenario map implicitly to `RC-1`. A non-zero exit means the diagnosis,
scenario, or test report has drifted.

---

## When to commit in repair mode

Three natural commit points exist in a `--repair` run:

**1. After diagnosis gate approval** (stage-01 ESCALATE + operator approval):

```bash
devteam commit
# Stages: pipeline/gates/stage-01.json, pipeline/diagnosis.md
```

**2. After failing-first test stage** (stage-03b PASS):

```bash
devteam commit
# Stages: pipeline/gates/stage-03b.json, pipeline/spec.feature
```

**3. After build + scope gate PASS** (stage-04 PASS):

```bash
git add src/path/to/fixed-file.js   # operator stages the fix itself
devteam commit                        # stages pipeline/gates/stage-04*.json and build artifacts
```

`devteam commit` stages gate files and pipeline artifacts automatically. The source files that
constitute the fix — the application code changed by the build agent — must be staged explicitly
by the operator. Stagecraft does not own application source files; only pipeline artifacts.

For the full git workflow context, see [`docs/git-workflow.md` § Repair mode](../git-workflow.md#repair-mode).
