# ADR 010 — Git integration: managed gitignore, `devteam commit`, and `--auto-commit`

**Status:** Accepted
**Date:** 2026-06-15
**Authors:** Mumit Khan

## Context

Stagecraft builds systems but has no opinion about how those systems' build artifacts enter
version control. The operator is left with two undocumented problems:

**Problem 1 — Volatile pipeline files pollute the repo (or aren't ignored consistently).**
The current `docs/git-workflow.md` lists only `pipeline/logs/` and `pipeline/gates/replay/`
as gitignore candidates. The volatile state set is larger: `run.lock`, `run-state.json`,
`run-log.jsonl`, `gates/archive/`, `dispatches/`, `memory/`, and their `pipeline/changes/*/`
equivalents. Operators who follow the documented list have a partial gitignore and
accidentally commit machine-journal files on the first `git add .`.

**Problem 2 — There is no guide for what to commit in autonomous mode.**
`docs/git-workflow.md` covers the interactive (non-autonomous) case only: it tells the
operator to commit after specific stage groups and lists what files those groups write.
When `devteam run` drives the pipeline autonomously, the operator faces a harder question
at each halt: which files does this halt represent? The driver advances multiple stages
between operator checkpoints; there is no mechanical answer to "what changed since my last
commit?" and no coupling between the driver's progression and the operator's commit rhythm.

**Problem 3 — The current doc is the sole source of truth, and it is already drifting.**
`git-workflow.md` was written for the Phase 1 stage set. Since then the pipeline has grown
(stage-03b, stage-04e / preflight, repair-mode diagnosis), the driver gained a run-state
cursor (`run-state.json`), and the gate archive was formalised. The doc has not kept pace.
Making the human document the authoritative list of what to commit and what to ignore is
unsustainable.

### Why decide now

Phase 12 can be scoped to remove all three friction points in one coherent pass. The
prerequisites — `devteam run`, `run-state.json`, gate files as stable artifacts, the PASS/
WARN gate format — all exist. The repair-mode experience (ADR-009, Phase 10) surfaced the
`affected_files` / `diagnosis.md` pattern that `devteam commit` can generalise: "the files
this run was about" is knowable from the gate record, not from operator memory.

## Decision

**Five binding decisions:**

### 1. `devteam init` owns the `.gitignore` block

`devteam init --host <list>` appends a **machine-managed, delimited block** to `.gitignore`
in the project root. The block is idempotent: re-running `devteam init --force` replaces
the block, it does not add a second one. Any manual edits inside the block are overwritten;
edits outside the block are preserved.

The canonical block:

```
# BEGIN stagecraft — managed by devteam init; do not edit manually
pipeline/run.lock
pipeline/run-state.json
pipeline/run-log.jsonl
pipeline/logs/
pipeline/gates/archive/
pipeline/gates/replay/
pipeline/dispatches/
pipeline/memory/
pipeline/lint-output.txt
pipeline/pre-review-output.txt
pipeline/changed-files.txt
pipeline/changes/*/run.lock
pipeline/changes/*/run-state.json
pipeline/changes/*/run-log.jsonl
pipeline/changes/*/logs/
pipeline/changes/*/gates/archive/
pipeline/changes/*/gates/replay/
pipeline/changes/*/dispatches/
pipeline/changes/*/memory/
pipeline/changes/*/lint-output.txt
pipeline/changes/*/pre-review-output.txt
pipeline/changes/*/changed-files.txt
.devteam/memory/
.devteam/patterns/
.devteam/knowledge/
.devteam/worktrees/
.devteam/evidence-project-id
.devteam/corpus/
.devteam/evals/
# END stagecraft
```

This removes Problem 1 structurally. Operators on older projects run `devteam init --force`
once; new projects get the correct gitignore at init time. The block is the single source
of truth for what Stagecraft treats as volatile; docs reference it rather than duplicating
it.

### 2. `devteam commit` is the primary git interface

A new `devteam commit` command reads `run-state.json` and produces a commit of exactly the
files this run advanced, staged by name (never `git add -A`):

- **What it stages:** gate files that reached PASS or WARN since the last committed stage,
  plus named artifacts produced by those stages (e.g. `pipeline/brief.md`,
  `pipeline/diagnosis.md`, `pipeline/code-review/`, `pipeline/spec.feature`). It does not
  stage volatile state (lock, run-state, run-log, archive, dispatches) or anything excluded
  by the gitignore block.
- **Message generation:** the commit message is derived from which stage gates are being
  committed (e.g. "pipeline: advance stages 01–03 (PASS)" or "pipeline(repair): diagnosis
  + build PASS"). Co-Authored-By is added automatically. The operator sees the proposed
  message and staged files and confirms before the commit executes.
- **Idempotency:** a `last_committed_stage_index` cursor in `run-state.json` (schema bump)
  tracks what has already been committed. Running `devteam commit` twice is safe; the
  second call stages nothing.
- **Incremental commits during a run:** calling `devteam commit` at each driver halt
  produces fine-grained commits. Calling it once at pipeline-complete produces one batch
  commit. Both are valid — the cursor makes them composable.

`devteam commit` does not push, does not open PRs, and does not create branches. Those
decisions remain with the operator.

### 3. `run-log.jsonl` is gitignored by default

`run-log.jsonl` is a machine journal (one line per driver loop event, including heartbeats,
retry details, and stall probes). It is useful for debugging a *running* pipeline and for
post-mortems, but it is not a human artifact and its inclusion in VCS produces large,
noisy commits that make `git log --oneline` unreadable.

**Default:** gitignored (included in the `# BEGIN stagecraft` block above).

**Opt-in:** `devteam.git.commit_run_log: true` in `.devteam/config.yml` opts the run-log
into the staged set for regulated pipelines that need the full audit trail in VCS.

`run-state.json` is similarly a machine cursor; it is also gitignored by default. Gate
files (the human-readable PASS/WARN/FAIL/ESCALATE records) remain committed artifacts.

### 4. `last_committed_stage_index` lives in `run-state.json`

The cursor that makes `devteam commit` idempotent is a new field in `run-state.json`:

```json
{
  "last_committed_stage_index": 3,
  ...
}
```

`devteam commit` writes this field after a successful commit. The driver reads it at resume
time (the `--resume` path already reads `run-state.json`). This is a schema bump — bump
`RUN_SCHEMA_VERSION` and add a migration that initialises the field to `null` (never
committed) on older state files.

The field is `null` if `devteam commit` has never been called for this run, or if the
run was started before Phase 12.1 shipped.

### 5. `--auto-commit` fires only on clean halts; never on failure halts

`devteam run --auto-commit` is an opt-in flag that calls `devteam commit` automatically
after every **clean halt** (ceiling halt, `--until` boundary, budget cap) — the halts where
the driver stopped by design, not because something broke.

**Never fires on:**
- `fix-and-retry` halt (`code-defect` class failures the driver is self-correcting)
- `resolve-escalation` halts (human judgment required)
- `structural-input` / `merge-failed` / `max-iterations` halts
- `convergence-exhausted` (no progress)

The rationale: committing after a failure halt is committing a state that is known to be
wrong. The operator must understand what failed before committing anything. A clean halt
means "the pipeline ran correctly to this point"; that is a well-defined commit.

`--auto-commit` logs an `auto-commit` event to `run-log.jsonl` with the staged file list
and commit hash, and propagates the commit failure (if any) as a non-fatal warning — the
run itself still halted cleanly.

## Consequences

- **The gitignore block is authoritative.** Any file in the block is volatile; any file not
  in it is safe to commit. Docs no longer maintain a shadow list. Teams that have already
  committed `run-state.json` or `run-log.jsonl` get a one-time noise commit to remove them;
  this is preferable to the current state where those files accumulate indefinitely.
- **`devteam commit` must know the artifact map per stage.** The file-selection algorithm
  requires a stage → artifact registry (what files does each stage write that are worth
  committing?). This is new machinery. An incomplete registry means `devteam commit` stages
  a subset of the right files; the operator can supplement with `git add` by name. The
  registry is the Phase 12.2 deliverable; doc-only stages (12.1) do not depend on it.
- **`run-log.jsonl` gitignored by default breaks the post-mortem workflow for teams that
  relied on `git log` to read old run logs.** Operators who need the audit trail in VCS
  opt in with `devteam.git.commit_run_log: true`. This is a documented breaking change.
- **`last_committed_stage_index` schema bump is backwards-compatible at runtime** (the
  driver reads `null` from old state files and treats it as "nothing committed") but
  `devteam commit` cannot safely reconstruct the "what was committed" set for a run that
  completed before Phase 12.1. For runs-in-progress at upgrade time, running `devteam commit`
  once with `--all` stages the full current gate set.
- **`--auto-commit` is additive** — operators who don't opt in see no behavior change.
  The flag is CLI-only and per-run (not persisted to config) in Phase 12.3; a config key
  can be added later once the default behavior is validated.
- **`devteam commit` does not open branches or PRs.** That keeps the command's scope tight.
  The question "should `devteam run` auto-push and open a PR on pipeline-complete?" is real
  and is the natural Phase 13 question; it is explicitly not decided here.
- **`devteam commit` does not resolve the "when" question for repair-mode runs.** Repair
  runs have a natural commit cadence (commit after diagnosis approval, commit after
  failing-first test, commit after build + scope gate PASS) that `devteam commit` supports
  but does not enforce. The repair-flow runbook gets a "when to commit" section in Phase
  12.4.

## Alternatives considered

- **Document the full volatile-file list instead of automating gitignore.**
  Rejected: the list already drifted once (Phase 9 added `archive/`, Phase 10 added
  `diagnosis.md`, Phase 11 added heartbeat events to `run-log.jsonl`). A managed block that
  `devteam init` owns is immune to drift by construction.

- **`git add .` / `git add -A` in `devteam commit`, filtered by gitignore.**
  Rejected: `git add .` stages new untracked files that may include secrets (`.env`,
  credentials) or in-progress work the operator has not reviewed. Staging by name from the
  stage artifact registry is the only approach that is safe to automate.

- **Auto-commit on every stage completion (not just halt).**
  Rejected: stage-granular commits produce a noisy history when the pipeline is working
  well. The natural commit granularity is stage-group (setup, build, review, verification)
  or run (if the pipeline completed uninterrupted). The halt-based commit cadence matches
  where the operator is already looking.

- **A `devteam push` command as the primary interface.**
  Rejected: push is an irreversible, shared-state operation (it affects other people). A
  commit command is local and reversible; operators add push and PR creation via their
  existing workflow. Composable is safer.

- **Committing `run-state.json` (the cursor) so other machines can resume.**
  Considered but not decided here: the cross-machine resume case (operator A runs stages
  01–06, operator B resumes from 07) is a real use case but requires protocol decisions
  (race conditions, lock semantics across machines) that are not in scope for Phase 12. The
  cursor being gitignored does not foreclose this; it just means cross-machine resume
  requires a `--resume-from <index>` flag rather than reading the committed state.

- **`run-log.jsonl` committed by default, with a gitignore opt-out.**
  Rejected: the audience for run-log is operators debugging live or recent runs, not code
  reviewers reading history. The file is large (hundreds of JSON lines for a full run), it
  resets every run (so history would be a series of complete logs, not a diff of events),
  and its content is machine-readable rather than human-readable. Gitignored by default is
  the right call; regulated teams opt in.

---

*This ADR is the in-repo decision record for git integration. Accepted 2026-06-15. Execution
plan: [`plans/phase-12-git-workflow-automation.md`](../../plans/phase-12-git-workflow-automation.md),
tracking issue: telus-labs/stagecraft#153.*
