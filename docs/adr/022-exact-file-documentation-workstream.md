# ADR 022 — Exact-file documentation build ownership

**Status:** Accepted
**Date:** 2026-08-19
**Authors:** Stagecraft maintainers

## Context

Stagecraft's build matrix has code and test owners, but no first-class owner
for contributor-facing documentation. A documentation blocker therefore fell
back to a coding role whose `roleWrites` excluded the file, spent a host turn,
and failed its write audit. Adding `docs/` to backend would avoid that immediate
failure by weakening ownership for every future run.

The loop brief already asks the PM to list affected files, but Stage 1 does not
carry that list into its gate. Build, QA, peer review, and retry routing
therefore have no shared machine-readable statement of the approved docs-only
surface.

## Decision

`documentation` is an optional Stage 4 and panel Stage 5 workstream. It is not
a fifth default member of either matrix. Stagecraft selects it only when a PASS
Stage 1 gate:

1. sets `active_roles` to exactly `["documentation"]`; and
2. supplies a non-empty `affected_files` array of canonical, repo-relative,
   exact documentation paths.

Directories, globs, absolute paths, parent traversal, duplicates, pipeline
state, and non-documentation paths are invalid. The documentation builder's
effective `allowedWrites` is those exact paths plus its own PR summary,
context, build-plan, and gate artifacts. The static stage definition contains
only those pipeline outputs; it never gains a `docs/` wildcard.

The approved list is carried on the host-neutral `StageDescriptor` and rendered
into the build, QA, and peer-review prompts. Retry ownership uses the same
resolver, so an approved file can return to the documentation workstream while
a newly discovered file halts as `retry-ownership`.

`devteam assess` recommends `loop`, not `nano`, for a known docs-only file set.
That one-screen requirements turn is the approval boundary that materializes
the exact paths before the build. The normal four-workstream matrices and
non-documentation loop behavior remain unchanged.

Scope expansion requires a new recorded decision: update the brief and Stage 1
gate through the normal restart/ruling path, then resume. An operator cannot
turn an unapproved directory or glob into write authority with
`--workstream documentation` alone.

## Consequences

- Documentation-only work has a real builder and reviewer without granting a
  coding role broad documentation access.
- The exact approved surface is visible and consistent across implementation,
  verification, review, isolated-worktree reconciliation, and retries.
- Docs-only changes pay for one short requirements turn. This is deliberate
  approval ceremony, not a general reason to make `nano` heavier.
- Mixed code-and-documentation changes keep the existing code workstreams for
  now. Supporting a simultaneous documentation workstream would need a separate
  overlap, quorum, and scope-expansion design.
- CLI agents remain subject to their declared enforcement level; exact paths
  improve the contract but do not create an OS sandbox.

## Alternatives considered

### Add `docs/` to backend or platform

Rejected because it permanently widens an unrelated role and makes a future
agent free to edit every document when only one file was approved.

### Make documentation a fifth default workstream

Rejected because most changes do not touch docs. It would add cost and review
ceremony to every run, including the four-dispatch loop contract.

### Parse the Markdown brief at dispatch time

Rejected because prose headings and bullets are not a stable machine contract.
The gate carries the exact list, while the brief remains its human-readable
source.

### Infer scope from `git status`

Rejected because changed files describe the checkout, not the PM-approved
future write set, and cannot authorize a new document that does not exist yet.
