# Architecture Decision Records

ADRs capture decisions that shape the system, why they were made, and what alternatives were considered. They are written *when* a decision is made, not retroactively, and not edited after they land (a new ADR supersedes an older one).

## When to write one

Any decision that meets one of:

- Reverses or constrains a previous decision (supersedes another ADR).
- Locks something in `ARCHITECTURE.md`'s "Design decisions (locked)" list.
- Picks one of several plausible alternatives and the reasoning isn't obvious from the code.
- Affects how someone outside this team works with the framework (extension points, file paths, gate shape).

Trivial fixes, refactors that preserve behavior, and incremental polish do not need an ADR.

## File format

`NNNN-short-kebab-title.md`. Numbered sequentially. Front-matter:

```markdown
# ADR NNNN — Title

**Status:** Proposed | Accepted | Superseded by ADR-XXXX
**Date:** YYYY-MM-DD
**Authors:** name(s)

## Context
Why are we deciding this now? What's the situation?

## Decision
What did we decide?

## Consequences
What follows from this — good and bad. What now needs to be true.

## Alternatives considered
What else was on the table and why we didn't pick those.
```

## Index

| ADR | Title | Status |
|---|---|---|
| [001](001-unification-vs-fork.md) | Unification: one core, per-host adapters (vs maintaining two forks) | Accepted |
| [002](002-host-adapter-contract.md) | Host adapter contract: capabilities + install + renderStagePrompt + status + uninstall | Accepted |
| [003](003-bounded-autonomous-execution.md) | Bounded autonomous pipeline execution: typed failure model + authority provenance + consequence-ceilinged driver | Accepted |
| [004](004-role-tool-budgets.md) | Role tool budgets: host-native tool pinning via ROLE_FRONTMATTER, capability-level degradation, MCP vocabulary deferred | Accepted |
| [006](006-track-inference-under-autonomy.md) | Track inference under autonomy: `pipeline/track.json` provenance record, `autonomy.require_confirmed_track` halt, `devteam assess` as separate explicit step | Accepted (§1 superseded by ADR-016) |
| [007](007-liveness-heartbeat.md) | Liveness/heartbeat: stall detector distinct from wall-clock timeout; heartbeat events in `run-log.jsonl` | Accepted |
| [008](008-exit-semantics.md) | Exit semantics: pipeline-complete exit code when `advise` still reports blockers; four options and CI implications | Accepted |
| [009](009-repair-mode.md) | Repair mode: `devteam run --repair` as an intent flag (orthogonal to `--track`); fix-aware artifacts on existing stages, reusing PATCH MODE + the spec→stamp chain | Accepted |
| [010](010-git-integration.md) | Git integration: managed gitignore block via `devteam init`, `devteam commit` as primary git interface, `--auto-commit` on clean halts, `last_committed_stage_index` cursor | Accepted |
| [011](011-authenticated-gate-chain.md) | Authenticated gate chain: optional HMAC-SHA256, explicit signed-only policy, provider-neutral KMS path deferred | Accepted |
| [012](012-explicit-resolution-acceptance.md) | Explicit resolution acceptance: hash-bound human evidence without free-form resolution export | Accepted |
| [013](013-openai-compat-shell-execution.md) | openai-compat shell execution: native bash tool over subprocess wrapper | Accepted |
| [014](014-docker-headless-runner.md) | Docker-based headless runner: local containerized orchestration with mounted-project state | Accepted |
| [015](015-workstream-scheduling.md) | Bounded workstream scheduling: per-host concurrency, queue telemetry, and retry backoff reasons without stage DAG reordering | Accepted |
| [016](016-assess-by-default.md) | Assess-by-default on `devteam run`: inline `assess()` inference at any confidence when no `--track`/`track.json`/`custom_stages`, persisted to `pipeline/track.json` — supersedes ADR-006 §1 | Accepted |
| [017](017-dag-wave-execution.md) | Stage DAG waves: curated `dependsOn[]` metadata (not a mechanical readFirst mirror), wave formation bounded by `autonomy.max_parallel_stages`, chain stays track-order, per-member failure/stall/heartbeat handling | Proposed |

### Deferred

ADR-005 is identified in `plans/phase-4-capability-roadmap.md` §4.4 as
the remaining open question for Phase-3-of-ADR-003 autonomy. It is not yet drafted; the gap
in numbering is intentional, not an accident.

| ADR | Title | Status |
|---|---|---|
| 005 | Standing grants: persistent `--auto-rule`/`--allow-stage`/tool-budget config vs per-invocation grants; authority-binding on the gate chain | Deferred |
