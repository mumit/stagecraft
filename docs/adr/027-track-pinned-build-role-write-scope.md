# ADR 027 — A track-pinned build role also gets the PM-approved affected-file list

**Status:** Accepted
**Date:** 2026-08-25
**Authors:** Stagecraft maintainers

## Context

`core/pipeline/stages.js`'s stage-04 `roleWrites` is a static, monorepo-shaped
contract: `backend` may write `src/backend/`, `frontend` writes `src/frontend/`,
and so on. That convention is an assumption about layout, not something derived
from the project. A project whose source lives at the repo root — `src/server.js`,
`src/cli.js`, `public/index.html` — has no path under any role's declared prefix,
even when Stage 1 named those exact files in `affected_files` and a PM-approved
gate passed.

For `loop`, `nano`, and `refactor` this is worse than for `quick`/`full`, because
[ADR-026](026-pinned-build-role-mismatch.md) already established that those three
tracks pin stage-04 to exactly one role — `loopBuildRole(config)` or
`scopedBuildRole(track)` — regardless of what the change touches. There is no
sibling dispatch to fall back to and no per-change role selection to get right;
the pinned role is the only build authority stage-04 will ever grant for that
feature. When the change's real paths fall outside that role's static prefixes,
the workstream cannot write its own approved work, the post-hoc write-audit
guard rejects it, and the run halts at `resolve-escalation`.

Two things kept this invisible until now:

1. **Host enforcement varies.** `roleWrites` is declared `tool-call-time` for
   claude-code but, per the existing comment in `stages.js`, claude-code's actual
   hooks are broader than the declared list and have never actually blocked the
   write. codex, openai-compat, and omnigent enforce it as a real `post-hoc-audit`
   diff. A project dogfooded primarily on claude-code never sees the rejection;
   the same brief run against a strictly-enforcing host halts on the first build
   dispatch.
2. **Stagecraft's own repo isn't laid out per its own convention either** (no
   `.devteam/` at the root, and its own dogfood project-context notes confirm
   `core/`, `hosts/`, `bin/` don't match `src/backend/`). The gap doesn't surface
   in the tool's own development loop for the same host-enforcement reason.

Once halted, the Principal-ruling escalation path did not converge either: its
existing remedies (gate correction, redispatch the same role, stage re-run, gate
advance to WARN) all reproduce the identical rejection when the ruling redispatches
the same role with the same static write scope, because none of them can change
what that role is authorized to write. The ruling cycled without a way to state
the actual defect: an approved scope the role's static prefixes don't cover.

[ADR-022](022-exact-file-documentation-workstream.md) solved the equivalent
problem for the `documentation` role by carrying Stage 1's exact,
validated `affected_files` list onto the descriptor as additional write
authority. This ADR generalizes that same contract to the track-pinned build
role — and only that role, not any build role a single dispatch happens to
narrow down to.

## Decision

**A track-pinned build role's `allowedWrites` additively includes the current
PASS Stage 1 gate's `affected_files`, normalized the same way documentation
scope already is.** This is implemented once, in `isTrackPinnedBuildRole()`
(`core/pipeline/stages.js`), and consumed at both places write scope is
computed:

- `core/orchestrator.js`'s `buildDescriptor()` — the normal dispatch path.
- `core/retry-ownership.js`'s `resolveRetryOwnership()` — retry/fix routing,
  which has its own copy of the write-compatibility check and would otherwise
  reject a retry into the very path the widened dispatch could write.

`isTrackPinnedBuildRole(stageDef, track, config, role)` is true only for the
two branches that structurally pin stage-04 to one role with no sibling
dispatch ever running for the same feature: `loop` (`role ===
loopBuildRole(config)`) and `nano`/`refactor` (`role === scopedBuildRole(track)`).
It is deliberately **not** `rolesInStage.length === 1` — `quick` and `full` can
also resolve to a single active role for a given dispatch, but that is
right-sizing narrowing a dirty-tree snapshot, not a structural guarantee; a
different role can legitimately run in a separate dispatch for the same
change. Granting the whole brief's `affected_files` there would leak write
authority across roles that never agreed to share it. **`quick`, `full`, and
`dep-update` are explicitly out of scope for this ADR and remain exposed** to
a mismatch between their static `roleWrites` and an unconventional layout,
same as before.

The widened paths are normalized by `normalizeApprovedFiles()`
(`core/pipeline/affected-files.js`) — the same directory/glob/absolute-path/
traversal rejection as `normalizeAffectedFile`, reused rather than
reimplemented. Unlike the documentation scope, an invalid entry is dropped
rather than invalidating the whole grant: this is an *addition* to the role's
static `roleWrites`, never the sole write authority, so one bad entry
shouldn't take down the role's baseline scope.

The granted paths are surfaced the same way documentation's are: merged into
the descriptor's `approvedAffectedFiles` field (rendered as a distinct
"Approved affected files (exact scope contract)" section by
`renderApprovedAffectedFiles`), not silently folded into `allowedWrites` with
no trace. An operator or reviewer reading the dispatch prompt can see exactly
which paths came from the static contract and which came from Stage 1's
approval.

**Principal ruling gains a named remedy for the residual case.** When the
widening above still isn't enough — a file was discovered mid-build outside
the approved list, or the halt is on an out-of-scope track — redispatching the
same role changes nothing. `renderPrincipalRulingPrompt` and
`renderEscalationApplicatorPrompt` now name a **scope gap** ruling: expand
Stage 1's `affected_files` via `devteam restart requirements --cascade` and
re-approve, rather than cycling through remedies that all assume the role is
wrong or the gate is malformed when neither is true.

## Consequences

**No new required configuration for the common case.** A project whose layout
already matches the static convention sees no behavior change: `affected_files`
is a subset of the static prefixes, so nothing new gets appended.
`loop`/`nano`/`refactor` still dispatch exactly one build workstream — this ADR
widens what that workstream may write, not how many run.

**The fix targets the actual defect, not a host.** The failure was never
openai-compat-specific; it enforces `allowedWrites` correctly and reported the
real gap. This ADR fixes the gap so a genuinely enforcing host stops rejecting
approved work, rather than papering over it by loosening enforcement.

**Isolation for `quick`/`full` is unchanged.** No sibling-role write leak is
introduced there because the gate (`isTrackPinnedBuildRole`) never fires for
them. They remain exposed to the original layout-mismatch class of failure,
named explicitly rather than silently — the same trade ADR-026 made for the
build-role-*identity* mismatch, extended here to the write-*scope* mismatch.

**Principal ruling stops cycling on this failure class**, but only when the
Principal (or operator reading its ruling) correctly identifies it as a scope
gap rather than misdiagnosing it as a wrong-role or malformed-gate problem —
the new remedy is a documented option, not an automatic detection.

**Retry routing and first-pass dispatch agree.** Without the
`retry-ownership.js` mirror, a first dispatch would succeed under the widened
scope, but a subsequent QA-driven retry targeting the same approved path would
be misrouted or rejected — an inconsistent "works once, fails on retry" defect.
Both call sites read the same `loadBuildScope()`.

## Alternatives considered

**Derive `roleWrites` from actual project structure instead of a hardcoded
convention.** The more complete fix, and worth a future ADR with real-project
evidence — but it's a bigger surface (affects every track, every role, and the
static-contract-as-documentation property the current scheme has), not
something to fold into an urgent unblock.

**Widen the static `roleWrites` prefixes themselves (e.g. add repo root).**
Rejected: that widens every project's build role forever, including ones where
the convention is intentional and correct. The Stage 1 gate is per-change and
already went through PM approval; reusing that trust boundary is strictly
narrower.

**Apply the widening whenever stage-04 resolves to a single active role,
regardless of track.** This was the first draft of this ADR and was rejected
on review: it conflates `loop`/`nano`/`refactor`'s structural single-build-role
guarantee with `quick`/`full`'s per-dispatch narrowing, and would let a role
that only looks alone *this dispatch* inherit write authority a sibling role
in another dispatch never agreed to share.

**Auto-detect and correct the scope gap without a Principal ruling.** Rejected
for now: inferring which paths should be approved from a rejected write is the
same "guess a convention" problem this ADR moves away from. A human- or
Principal-reviewed `affected_files` expansion keeps the approval boundary
explicit, consistent with ADR-022's existing requirement that scope expansion
is a recorded decision, not an inferred one.
