# Git workflow for a Stagecraft pipeline run

This guide covers the end-to-end git practice for a feature built with Stagecraft: two operator modes, which pipeline artifacts belong in git, how to use `devteam commit`, when pipeline halts are the right commit signal, repair-mode commit timing, and when to open the PR.

---

- [Overview](#overview)
- [What to commit vs. ignore](#what-to-commit-vs-ignore)
- [Interactive mode](#interactive-mode)
- [Autonomous mode](#autonomous-mode)
- [Repair mode](#repair-mode)
- [PR timing](#pr-timing)
- [CI integration](#ci-integration)
- [See also](#see-also)

---

## Overview

Stagecraft supports two operator modes:

- **Interactive mode** — the operator invokes `devteam stage <name>` or `devteam next` to advance the pipeline one step at a time. Commit timing is fully under operator control.
- **Autonomous mode** — `devteam run` drives the pipeline from the current cursor to a halt condition. Commits can be triggered automatically with `--auto-commit`.

**What Stagecraft tracks:** the `pipeline/` directory is a mix of committed artifacts (gate files, design specs, test reports) and volatile run state (lock files, logs, replay archives). The volatile state is excluded by the managed `.gitignore` block written by `devteam init`; everything else belongs in git.

**What lives in git:** gate files (`pipeline/gates/`), design artifacts (`pipeline/brief.md`, `pipeline/design-spec.md`, etc.), and any source code produced by build stages (`src/`). Together these form the audit trail that CI validates and reviewers inspect.

**Branch setup:** before running any `devteam` command, create a feature branch from main:

```bash
git checkout main && git pull
git checkout -b feature/my-feature-name
```

One branch per pipeline run. All pipeline artifacts and source code go on this branch.

---

## What to commit vs. ignore

Gate files are the human artifact — they record every stage decision, approval, and PASS/WARN/FAIL outcome. Volatile run state (lock files, logs, dispatches, memory, replay archives) is ephemeral and must not be committed.

Run `devteam init --host <x>` once to write the managed `.gitignore` block. The block is the canonical list of volatile Stagecraft files; do not duplicate it in prose. To update the block after a Stagecraft upgrade, re-run `devteam init --host <x>` (without `--force` — it replaces an outdated block automatically).

**What to include and exclude:**

| Path | Commit? | Reason |
|------|---------|--------|
| `pipeline/brief.md` | ✓ | Source of truth |
| `pipeline/design-spec.md` | ✓ | Design record |
| `pipeline/adr/` | ✓ | Architectural decisions |
| `pipeline/context.md` | ✓ | Decision + assumption log |
| `pipeline/spec.feature` | ✓ | Executable specification |
| `pipeline/clarification-log.md` | ✓ | PM resolutions |
| `pipeline/gates/` | ✓ | What CI reads; validator reads |
| `pipeline/pr-*.md` | ✓ | Per-workstream build record |
| `pipeline/code-review/` | ✓ | Peer-review audit trail |
| `pipeline/red-team-report.md` | ✓ | Red-team evidence |
| `pipeline/security-review.md` | ✓ | Security finding record |
| `pipeline/test-report.md` | ✓ | Stage 6 evidence |
| `pipeline/runbook.md` | ✓ | Deploy runbook (Stage 8) |
| `pipeline/observability-report.md` | ✓ | Stage 6c evidence |
| `pipeline/retrospective.md` | ✓ | Lessons |
| `pipeline/logs/` | ✗ | Ephemeral; in managed `.gitignore` |
| `pipeline/run.lock` | ✗ | Ephemeral; in managed `.gitignore` |
| `pipeline/run-state.json` | ✗ | Ephemeral; in managed `.gitignore` |
| `pipeline/gates/replay/` | ✗ | `devteam replay` output; ephemeral |
| `pipeline/pre-review-output.txt` | ✗ | Ephemeral tool output; in managed `.gitignore` |
| `pipeline/lint-output.txt` | ✗ | Ephemeral tool output; in managed `.gitignore` |
| `pipeline/changed-files.txt` | ✗ | Ephemeral security-heuristic input; in managed `.gitignore` |

`devteam commit` stages gate files and per-stage artifacts for all PASS/WARN stages. Two notable exceptions: `pipeline/context.md` and `pipeline/adr/` are not in the artifact registry and must be staged manually. Run `devteam compact` before staging `context.md` to strip machine-managed marker sections. Application source files (`src/`) must also be staged explicitly.

---

## Interactive mode

Interactive mode is the default: the operator drives each stage and commits at natural checkpoints after a group of stages passes cleanly.

**Primary interface: `devteam commit`**

`devteam commit` stages exactly the right pipeline artifacts for completed stages — gate files plus per-stage artifacts (brief, spec, test report, etc.) — and generates a conventional commit message. It tracks a cursor so repeated calls are idempotent.

```bash
# After stage-01 and stage-02 pass:
devteam commit
# Prompts: "pipeline: stages stage-01–stage-02 PASS [2 stages]" — y/n/e?
```

For build stages that also produce source code, stage the source explicitly before running `devteam commit`:

```bash
git add src/
devteam commit   # handles pipeline/gates/ and pipeline artifacts
```

**`--dry-run` before committing:** run `devteam commit --dry-run` to see the exact file list without committing.

**Recommended commit points:**

| Commit | Stage group | What `devteam commit` stages | Also stage manually |
|--------|------------|------------------------------|---------------------|
| After Stage 1 (requirements) | stage-01 | gate file, `pipeline/brief.md` | `pipeline/context.md` (run `devteam compact` first) |
| After Stage 2 (design) | stage-02 | gate file, `pipeline/design-spec.md` | `pipeline/adr/` |
| After Stage 3 + 3b | stage-03, stage-03b | gate files, `pipeline/spec.feature`, `pipeline/clarification-log.md` | — |
| After Stage 4 build chain | stage-04, 04a, 04b, 04c | gate files, `pipeline/pr-*.md`, `pipeline/red-team-report.md`, `pipeline/security-review.md` | `src/` |
| After Stage 5 (peer-review) | stage-05 | gate files, `pipeline/code-review/` | `src/` (if fixes) |
| After Stage 6 (QA) | stage-06, 06c | gate files, `pipeline/test-report.md`, `pipeline/observability-report.md` | — |
| After Stages 7 + 8 (sign-off + deploy) | stage-07, stage-08 | gate files, `pipeline/runbook.md`, `pipeline/deploy-log.md` | — |
| After Stage 9 (retrospective) | stage-09 | gate files, `pipeline/retrospective.md` | — |

Stages 3 and 7 are short; bundle them with their neighbors unless the design session produced substantial ADRs.

Do not commit every `devteam stage X` invocation. Interim failed states (FAIL gates you deleted and re-ran) should not appear in history.

**Stage 04: parallel build and git worktrees**

Stagecraft can manage isolated worktrees for the parallel build automatically:

```yaml
pipeline:
  workstream_isolation: git-worktree
```

The default is `shared`: all four build roles edit one checkout. The opt-in mode snapshots the current dirty/untracked-aware baseline, gives each role a detached worktree, and reconciles authorized results back into the current branch. Clean text overlap is three-way merged; unresolved overlap fails the affected workstream instead of taking the last writer.

**When you do need worktrees:**

| Scenario | Why worktrees help |
|---|---|
| Mixed-host pipelines where writes need reliable attribution | e.g. Codex backend + Claude Code frontend cannot observe one another's partial files |
| Workstreams write to shared root files (rare) | e.g., both backend and platform update `package.json` with conflicting changes |
| Role boundaries are important | Unauthorized paths are refused during reconciliation even on prompt-only hosts |

Stagecraft removes its temporary worktrees after reconciliation; no per-role
branches or manual merge commits are created. Use manual branches only for
separate-machine workflows, which remain outside the local orchestrator's
scope. See [ADR-019](adr/019-isolated-build-workstreams.md).

**What the final branch history looks like:**

```
feature/my-feature-name
  ├── stage-01: requirements PASS
  ├── stage-02: design PASS — 6 ADRs (Node LTS, AWS SDK v3, hash normalization, …)
  ├── stage-03: clarification + executable-spec PASS
  ├── stage-04: build + pre-review + red-team + QA augment PASS
  │     ← source code lands here
  ├── stage-05: peer-review PASS (iam guard + commander exit patched)
  │     ← any fix-and-retry code changes bundled here
  ├── stage-06: QA + observability PASS
  ├── stage-07/08: sign-off + deploy PASS
  └── stage-09: retrospective PASS
```

Each commit contains both the pipeline artifacts produced by that stage group and any source changes that stage required (peer-review fixes, etc.). Checking out any commit yields a consistent snapshot: the gate that passed is alongside the code that passed it.

---

## Autonomous mode

`devteam run` drives the pipeline from the current cursor to a halt condition. Pipeline halts are natural commit triggers — each clean halt means a coherent group of stages completed successfully.

**Halt types and commit signal:**

| `halt_action` | Meaning | Commit? |
|--------------|---------|---------|
| `ceiling` | Pipeline reached the consequence ceiling (approval required to proceed) | ✓ Clean halt — commit |
| `until` | `--until` boundary stage reached | ✓ Clean halt — commit |
| `budget` | Cost or iteration budget exhausted | ✓ Clean halt — commit |
| `fix-and-retry` | A stage FAIL triggered a patch build; operator action needed | ✗ Do not commit partial state |
| `resolve-escalation` | An ESCALATE gate requires a Principal ruling | ✗ Pipeline incomplete |
| `structural-input` | Driver needs operator input to continue | ✗ Pipeline incomplete |
| `merge-failed` | Workstream gate merge failed | ✗ Pipeline incomplete |
| `max-iterations` | Iteration cap hit without pipeline completion | ✗ Operator should inspect before committing |
| `convergence-exhausted` | Fix-and-retry exhausted its retry budget | ✗ Pipeline in error state |
| `scope-gate` | Build touched files outside `affected_files` (repair mode) | ✗ Scope violation; do not commit |
| `unconfirmed-track` | Track inference needs operator confirmation | ✗ Pipeline incomplete |
| `stoplist` | Stoplist guard fired | ✗ Investigate before committing |

**Using `devteam commit` after a clean halt:**

```bash
devteam run --feature "my feature" --until stage-04
# … pipeline runs to stage-04 …
# halt_action: until

devteam commit
# Stages gate files and artifacts for completed stages; prompts for confirmation
```

**`--auto-commit` opt-in:**

Pass `--auto-commit` to commit automatically after a clean halt (`ceiling`, `until`, `budget`) without manual intervention:

```bash
devteam run --feature "my feature" --auto-commit --until stage-06
```

The committed file list is printed to stderr before the commit so the operator can see what happened. The run exits with its normal halt exit code regardless of commit outcome.

If there is nothing to commit (the cursor is already at the last advanced stage), `--auto-commit` skips silently and logs `auto-commit-skipped`. A commit failure logs `auto-commit-failed` and emits a loud warning to stderr, but does not change the halt's exit code.

`--auto-commit` never fires on non-clean halts (`fix-and-retry`, `resolve-escalation`, etc.).

---

## Repair mode

In a `--repair` run the pipeline produces `pipeline/diagnosis.md` instead of `pipeline/brief.md` at stage-01. Three natural commit points exist:

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

`devteam commit` stages gate files and pipeline artifacts automatically. The source files that constitute the fix must be staged explicitly by the operator — Stagecraft does not own application source files.

For full repair-mode runbook detail, see [`docs/runbooks/repair-flow.md`](runbooks/repair-flow.md).

---

## PR timing

**Recommended: open as draft after the Stage 4 build chain; mark ready-for-review after Stage 5.**

```bash
# After Stage 4 build chain (stages 4 + 4a + 4b + 4c + QA augment) all pass:
git push -u origin feature/my-feature-name
gh pr create --draft \
  --title "feat: my-feature-name" \
  --body "Stagecraft pipeline in progress. Stage 4 build chain PASS; peer-review running."

# After Stage 5 (peer-review) passes:
gh pr ready   # convert draft → ready for review
```

This gives two benefits:
1. CI validates and publishes gate check runs throughout the rest of the pipeline (stages 5–9), visible in the PR's status bar.
2. The draft state signals to teammates that the work is not yet ready for merge.

**Alternative: open after all stages pass.** Simpler, but CI visibility during the pipeline is lost. Acceptable for small teams running the pipeline end-to-end in one session.

Do not open the PR before Stage 4. There is no code for reviewers to look at, and CI would post FAIL gates that reflect pipeline-in-progress, not real blockers.

**Merging into main:**

After all stages pass and the PR is approved:

```bash
# Squash-merge is fine — the feature branch's commit history is the audit
# trail, and pipeline/gates/ in the squash commit is the permanent record.
git merge --squash feature/my-feature-name
git commit -m "feat: my-feature-name — full pipeline PASS (stages 1–9)"

# Or keep the per-stage history:
git merge --no-ff feature/my-feature-name
```

**Squash-merge** produces a clean main history: one commit per feature, gate files at the final passing state. The full per-stage commit history lives on the feature branch for as long as it is retained.

**No-ff merge** preserves every stage commit in main. Use this if your team audits via `git log` and wants stage-by-stage progression in the main branch history.

Delete the feature branch after merge:

```bash
git push origin --delete feature/my-feature-name
git branch -d feature/my-feature-name
```

---

## CI integration

Once the PR is open, every commit to the branch triggers Stagecraft's CI workflow (if `devteam ci install` was run in your project). It validates every gate in `pipeline/gates/` and posts each as a GitHub check run:

```
✓ stage-01 requirements    PASS
✓ stage-02 design          PASS
✓ stage-04 build           PASS (4 workstreams)
✓ stage-04a pre-review     PASS
⚠ stage-04c red-team       WARN (2 noted-for-followup)
✓ stage-05 peer-review     PASS
...
```

**Do not commit FAIL gates.** A committed FAIL gate shows as a failing check run in the PR. If you have cleared and re-run a stage, commit only after the re-run gate is PASS or WARN.

See [`docs/ci.md`](ci.md) for the full CI workflow setup.

---

## See also

- [`docs/ci.md`](ci.md) — CI workflow setup, gate check runs, permissions
- [`docs/tracks.md`](tracks.md) — which track to pick (affects which stages run)
- [`docs/runbooks/repair-flow.md`](runbooks/repair-flow.md) — repair mode runbook: diagnosis gate, scope-gate recovery, reproduction
- [`docs/runbooks/fix-and-retry.md`](runbooks/fix-and-retry.md) — when a stage fails: scoped patch builds, gate clearing, QA augmentation
- [`rules/stage-04.md`](../rules/stage-04.md) — Stage 4 parallel build and worktree contract
