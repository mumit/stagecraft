# ADR 019 — Core-managed isolation for parallel build workstreams

**Status:** Accepted
**Date:** 2026-08-08
**Authors:** Stagecraft maintainers

## Context

`ARCHITECTURE.md` promised an `isolated` mode mapped by each host adapter to a
host-specific primitive. The shipped `pipeline.isolation: bounded` feature did
something different: it separated pipeline artifact trees by feature while all
coding workstreams still edited one checkout.

That shared checkout creates two builder-facing problems:

1. one workstream can observe a sibling's half-written files; and
2. post-hoc write attribution is ambiguous, so the orchestrator has to suppress
   changes covered by any sibling's `allowedWrites` list.

Adapter-owned worktrees also produce inconsistent safety depending on the
selected host and do not give the orchestrator one place to detect or reconcile
overlap.

## Decision

Stagecraft has two independent isolation axes:

- `pipeline.isolation` controls **run artifact placement**: `in-place` or
  `bounded`.
- `pipeline.workstream_isolation` controls **parallel build checkout
  placement**: `shared` (default) or `git-worktree`.

When `workstream_isolation: git-worktree` is enabled for a multi-role stage-04
headless dispatch, the orchestrator:

1. verifies that `--cwd` is a Git repository root;
2. snapshots the current working tree, including tracked changes, untracked
   files, and ignored Stagecraft operational context;
3. creates one detached worktree per planned build role and materializes that
   same snapshot into each;
4. invokes the existing host adapter with the isolated worktree as its cwd;
5. reconciles only that role's `allowedWrites` plus its operational log;
6. attempts a deterministic three-way merge when two roles changed the same
   text file; and
7. refuses unauthorized, escaping-symlink, binary-overlap, deletion-overlap,
   or unresolved text changes, recording the finding on the workstream gate as
   FAIL when a gate exists.

The mode is intentionally limited to parallel build workstreams. Peer-review
fan-out exchanges sibling-produced review artifacts while it runs, so isolating
those workstreams would change the locked gate/file exchange contract rather
than merely protecting code writes. Single-workstream stages get no isolation
benefit and continue in the operator checkout.

The core owns workspace creation and reconciliation. Adapters still own model
invocation, preserving the architectural rule that the core never invokes a
model directly.

## Consequences

- The default remains byte- and behavior-compatible: no worktree is created
  unless the operator explicitly selects `git-worktree`.
- A dirty but valid working tree is supported; builders do not have to commit
  pipeline artifacts merely to obtain isolation.
- Role-local verification runs against that role's complete isolated result.
- Shared-file edits are deterministic: clean three-way merges land, conflicts
  fail visibly, and last-writer-wins is forbidden.
- Setup and snapshot hashing add local I/O. This is the price of stronger
  attribution and should be chosen for parallel builds where collision risk
  outweighs that overhead.
- This is a correctness and attribution boundary, not a hostile-code sandbox.
  Agents still execute with the invoking user's OS permissions; use a
  container/VM for untrusted code.
- Git is required for the opt-in mode. Non-Git projects continue to use
  `shared`.

## Alternatives considered

### Keep shared checkout plus post-hoc audits

Rejected as the only option because concurrent snapshots cannot reliably
attribute writes and one agent can consume another agent's incomplete work.

### Let every adapter implement its own isolation

Rejected because behavior and merge semantics would vary by host, mixed-host
runs would remain inconsistent, and several hosts expose no usable worktree
primitive.

### Require a clean checkout and branch/commit every workstream

Rejected because Stagecraft deliberately supports in-progress pipeline
artifacts and builder workflows with uncommitted context. A byte snapshot is a
more faithful common baseline.

### Isolate every stage and review fan-out

Rejected for this ADR. Upstream and single-role stages have no sibling write
race. Review workstreams intentionally exchange filesystem artifacts and need
a separate contract before they can be isolated safely.
