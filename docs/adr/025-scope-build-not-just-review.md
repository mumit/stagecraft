# ADR 025 — Ceremony belongs on the build matrix, not only the review matrix

**Status:** Accepted (2026-08-22)
**Date:** 2026-08-21
**Authors:** Stagecraft maintainers

## Context

[`docs/tracks.md`](../tracks.md) presents `loop`, `quick`, and `full` as the
assurance axis and the rest as shape-selected specialist profiles. That framing
is right. But the measured cost of those profiles does not match how they are
described.

Measured on a throwaway project with `devteam assess`, dispatches per track:

| Track | Documented as | build | peer-review | total dispatches |
|---|---|---:|---:|---:|
| `loop` | "Lightest" | **1** | **1** | **4** |
| `nano` | "Minimal" | 4 | 1 | 6 |
| `refactor` | "Minimal" | 4 | 1 | 6 |
| `dep-update` | "Light" | 4 | 4 | 12 |
| `quick` | "Light" | 4 | 4 | 15 |
| `full` | "Heaviest" | 4 | 4 | 23–25 |

Two things follow.

**`nano` costs 50% more than `loop`.** The track offered for "a mechanical
change with obvious scope (rename a function, bump padding)" dispatches more
than the day-to-day default. `nano` has three stages to `loop`'s four, and is
still more expensive, because stage count is not what drives cost — workstream
count is.

**The scoping is applied asymmetrically.** `PEER_REVIEW_SIZING` scopes
*peer-review* for `nano`, `refactor`, and `review-pr` to a single reviewer.
Nothing scopes *build*: only `loop` does that, through `loopBuildRole(config)`.
So `nano` runs a four-area build matrix and then has one reviewer look at all
of it — the narrow end of the funnel is at review, where the cost already
happened, rather than at build, where it is incurred.

`dep-update` scopes neither. A dependency version bump dispatches four build
workstreams and a four-area peer review requiring two approvals.

### Correcting an earlier claim

[`plans/builder-review-2026-08.md`](../../plans/builder-review-2026-08.md) §3
argued there was a missing rung between `loop` (4 dispatches) and `quick` (15),
"a 3.75× step with nothing in between". That is wrong: `nano` (6) and
`dep-update` (12) both sit in that range. The real problem is not a gap in the
cost ladder — it is that the cheap track is cheap for a reason the other light
tracks do not share.

## Measurement note (2026-08-22): the counts depend on what is dirty

An earlier revision of this file claimed the table above "does not survive a
real repository" and recommended against accepting. **That claim was wrong, and
it was wrong because it measured the wrong scenario.** The correction is kept
here rather than deleted, because the mechanism it uncovered is worth
understanding before anyone re-measures these numbers.

`expectedRolesForStage()` in `core/pipeline/right-sizing.js` reads:

```js
if (active.size === 0) return roles;          // no discovery → every role
return roles.filter((role) => ... active.has(role) ...);
```

`activeRoles` comes from `candidateActiveRoles()`, which reads
`gitChangedFiles()`. So the build matrix a plan reports depends on **what is
dirty at preflight**, and there are three distinct scenarios:

| Scenario | `loop` | `nano` | When it happens |
|---|---:|---:|---|
| clean tree | 4 | **6** | `devteam run --feature` on a new change — the tree is clean because nothing has been written yet |
| one area dirty | 3 | 2 | resuming, or running against work already in progress |
| four areas dirty | 4 | 6 | a cross-cutting change |

The earlier correction measured row 2 and generalized from it. But **row 1 is the
scenario this ADR is about**: a run plan is materialized at preflight, before any
stage dispatches, so on a new feature the working tree is clean, discovery
returns `[]`, and every track falls through to the full four-area matrix. That is
the ordinary way a `nano` change starts, and there `nano` genuinely does cost 50%
more than `loop`.

The original table was measured correctly for the case it describes. Rows 2 and 3
are added above so the number is never re-derived from the wrong starting state.

## Decision

**Accepted:** extend single-workstream build scoping to the specialist tracks
whose change shape already justifies a single reviewer.

Concretely: a track that declares a scoped `PEER_REVIEW_SIZING` should scope its
build the same way, from the same resolved role. If one reviewer is the right
amount of scrutiny for a mechanical rename, four build workstreams are not the
right amount of implementation surface for it.

That means `nano` and `refactor` go from 6 dispatches to 3. `dep-update`, which
scopes neither today, is a separate question — see Open questions.

The mechanism already exists. `loopBuildRole(config)` resolves the single role
`loop` builds and reviews with, and `rolesForStage()` already derives loop's
review sizing from it so the reviewed area always matches the built one. This
generalizes that pairing rather than adding a new concept.

**No track is renamed, merged, or removed.** An earlier draft of this review
proposed collapsing `nano`, `refactor`, and `dep-update` into `loop` plus
modifiers. That is rejected below: it deprecates names that appear in users'
`.devteam/config.yml` and in `assess` output, for a surface-area win, while this
change delivers the ceremony reduction on its own.

## Consequences

**A mechanical change costs what its name implies.** `nano` at 3 dispatches is
cheaper than `loop`, which matches the documented ordering for the first time.

**Implementation surface is genuinely small.** Only 11 places in `core/` branch
on `nano`, `refactor`, or `dep-update` by name, and the sizing tables are two
adjacent structures in `core/pipeline/stages.js`.

**This reduces review coverage, and that is the real cost.** Today a `nano`
change gets four independent build agents; afterwards it gets one. For a
rename that is the point. For a "mechanical" change that turns out not to be,
it is less scrutiny than before — and the operator's protection is that
`assess` chose the track from the change shape, and the stoplist still refuses
`nano` for anything consequential. This is a deliberate assurance reduction on
a track whose whole premise is that the change is trivial, not a free win.

**`refactor` keeps its mutation gate.** The behavior-preservation checks in
`core/verify/mutation.js` are independent of workstream count, so scoping the
build does not weaken what makes `refactor` a refactor.

## Open questions

**`dep-update`.** A version bump touching a lockfile plausibly needs breadth —
a dependency can break any area. Scoping its build to one role may be wrong even
though its cost is the most surprising in the table. This ADR does not propose
changing it; it flags it as the one case where the cost is high *and* the
justification is real.

**Which role.** `loopBuildRole` defaults to `backend` and is config-overridable.
A frontend-only rename scoped to `backend` builds the wrong area. `loop` has
this problem today and answers it with configuration; a generalization may want
`assess`'s file-shape signal to pick the role instead.

## Alternatives considered

**Collapse `nano`/`refactor`/`dep-update` into `loop` plus modifiers**
(`--preserve-behavior`, `--deploy`). Rejected for now. It is a smaller surface —
three names and a 250-line explainer become one name and three flags — but it
deprecates track names that live in user config files and in `pipeline/track.json`
records, requires a migration path for both, and changes `assess`'s output
vocabulary. The ceremony win comes from the scoping change above, not from the
renaming, so the renaming can be evaluated separately on its own merits.

**Leave it and document the real numbers.** Rejected. `docs/tracks.md` calling
`nano` "Minimal" while it costs more than `loop` is the kind of prose/behavior
drift `npm run consistency` exists to prevent; documenting the surprise is worse
than removing it.

**Scope build by changed-file area instead of by track.** Rejected as a bigger
idea worth its own ADR: right-sizing already infers active roles from stage-01's
`active_roles`/`out_of_scope_items`, so a general "build only the areas this
change touches" policy would subsume this one — but it depends on a brief
existing, and `nano` has no requirements stage.
