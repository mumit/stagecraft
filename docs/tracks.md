# Tracks

A **track** is a named subset of pipeline stages. It tells Stagecraft how much rigor a change requires. The nine tracks reflect over a year of operational tuning on which stages are skippable for which change types, carried over from `claude-dev-team` (plus `loop`, added in phase-29 for minimal-ceremony iteration; `review-only`, added in phase-35 for reviewing code that already exists; and `review-pr`, added in phase-35.2 as the internal track `devteam review-pr` dispatches against).

`loop` is the day-to-day default: the lightest track that still produces a brief, a build, a QA pass, and a review gate. `full` is the **audited** path — every stage, including formal design and adversarial review — chosen when stakes or compliance justify the ceremony, not run by default just because it's the safest-looking option. `review-only` is the one track that never builds anything — it reviews code that already exists (a brownfield repo, an inherited module) rather than shipping new code. `review-pr` is a narrower sibling of `review-only`: a single scoped peer-review of one materialized inbound PR, driven by `devteam review-pr <number|url>` rather than `--track`. The remaining tracks (`nano`, `quick`, `config-only`, `dep-update`, `hotfix`) cover the shapes of change in between. See the ceremony-cost column below, or run `devteam assess --json` for a numeric estimate against your project's routed models.

- [Pick by what you're shipping](#pick-by-what-youre-shipping)
- [What each track runs](#what-each-track-runs)
- [The `loop` track](#the-loop-track)
- [The `review-only` track](#the-review-only-track)
- [The `review-pr` track](#the-review-pr-track)
- [Safety: the stoplist](#safety-the-stoplist)
- [How `devteam next` honors the track](#how-devteam-next-honors-the-track)
- [Conditional dispatch within a track](#conditional-dispatch-within-a-track)
- [When you've picked the wrong track](#when-youve-picked-the-wrong-track)
- [Choosing a track](#choosing-a-track)
- [Prototype mode is not a track](#prototype-mode-is-not-a-track)
- [Track record (`pipeline/track.json`)](#track-record-pipelinetrackjson)
- [Customizing tracks](#customizing-tracks)

You set the active track in `.devteam/config.yml`:

```yaml
pipeline:
  default_track: full
```

Or override per-invocation: `devteam stage build --track quick`.

## Pick by what you're shipping

| Change type | Track | Ceremony cost | Why |
|---|---|---|---|
| Small bounded iteration, no deploy needed yet — **the day-to-day default** | `loop` | Lightest — 4 dispatches | Minimal brief → single-workstream build → qa → scoped peer-review (1 reviewer, 1 approval); no design, no red-team, no sign-off/deploy. See [§ The `loop` track](#the-loop-track) |
| Mechanical change with obvious scope (rename a function, bump padding) | `nano` | Minimal | Build + scoped peer-review (1 reviewer, 1 approval) + qa |
| Bounded feature or fix with clear requirements and no cross-cutting design concerns | `quick` | Light | Skips design, clarification, pre-review, and red-team; PM brief is still required. Good default for most new features that don't touch the stoplist |
| Tweaking config/feature-flag values, no code | `config-only` | Light, conditional security review | Build + pre-review + (security if triggered) + qa + sign-off + deploy |
| Dependency bump or library upgrade | `dep-update` | Light | Build + peer-review + qa + sign-off + deploy |
| Urgent production incident | `hotfix` | Moderate — pre-review and peer-review are mandatory | Build + pre-review + (security if triggered) + peer-review + qa + sign-off + deploy + retro |
| Complex feature, cross-cutting architecture change, or anything needing formal design or adversarial review — the **audited** path for regulated/high-stakes changes | `full` | Heaviest — all 18 stages | Full rigor: requirements → design → build → review → red-team → tests → sign-off → deploy → retro. Choose it when stakes justify the ceremony (Phase 34 — roadmap, not yet built — extends this trail into exportable, regulator-shaped attestations) |
| Reviewing code that already exists — a brownfield repo, an inherited module, a subtree you didn't build with Stagecraft | `review-only` | Light — 3 dispatches, no build | Security-review + red-team + peer-review only; no requirements/design/build/sign-off/deploy. Works on a repo with zero `pipeline/` history. Narrow it with `--scope <path>` (repeatable). See [§ The `review-only` track](#the-review-only-track) |

These are relative sizings, not bills. Run `devteam assess --json` (or watch `devteam run`'s pre-flight output) for the actual per-track estimate — stage-slot count, dispatch-count range, token estimate, and cost range against your project's routed models. Static by default; once the run corpus has ≥5 comparable runs for a track, the estimate switches to an empirical median and says so (`estimate_basis`). See [`core/ceremony-preview.js`](../core/ceremony-preview.js) (phase-29.3).

## What each track runs

<!-- generated: do not hand-edit -->
```
              req des cla 3b  bld 4a  4b  4c  4d  5   qa  6b  6c  6d  6e  7   8   9   
full          ✓   ✓   ✓   ✓   ✓   ✓   ✓⁺  ✓   ✓⁺  ✓   ✓   ✓   ✓   ✓   ✓   ✓   ✓   ✓   
quick         ✓           ✓   ✓                   ✓   ✓   ✓           ✓   ✓   ✓   ✓   
nano                          ✓                   ✓ˢ  ✓                               
config-only                   ✓   ✓   ✓⁺      ✓⁺      ✓                   ✓   ✓       
dep-update                    ✓                   ✓   ✓                   ✓   ✓       
hotfix                        ✓   ✓   ✓⁺  ✓   ✓⁺  ✓   ✓   ✓   ✓       ✓   ✓   ✓   ✓   
loop          ✓               ✓ˢ                  ✓ˢ  ✓                               
review-only                           ✓⁺  ✓       ✓                                   
review-pr                                         ✓ˢ                                  
refactor                      ✓                   ✓   ✓                               

   Legend:
   ✓⁺ = conditional stage — only runs when stage-04a triggers it
       (security-review: security_review_required; migration-safety: migration_safety_required)
   ✓ˢ = scoped to a single workstream — nano and review-pr peer-review (single
       reviewer, required_approvals=1); loop build + peer-review (single config-
       overridable role, default backend). See PEER_REVIEW_SIZING / loopBuildRole
       in core/pipeline/stages.js.
   ✓ᵐ = mechanical script (preflight/stage-04e), not an LLM dispatch.
   3b = executable-spec (Gherkin scenarios from acceptance criteria)
   4a = pre-review (lint + dep review + SCA + trigger heuristics)
   4b = security review (conditional; veto power)
   4c = red-team adversarial review
   4d = migration-safety review (conditional; veto power)
   4e = preflight mechanical checks
   6b = accessibility audit (axe-core / pa11y / lighthouse)
   6c = observability gate (verify brief §9 signals ship)
   6d = verification beyond tests (property-based / mutation / formal; full only)
   6e = performance budget (Lighthouse / bundle / load test)
```
<!-- /generated -->

## The `loop` track

`loop` is the day-to-day default — reach for it before `quick` unless the
change needs a design stage or is heading to deploy. It's the 4-slot
minimal-ceremony track: brief → build → verify → review
(`requirements` → `build` → `qa` → `peer-review`). Note the order — `qa`
(stage-06, "verify") runs **before** `peer-review` (stage-05, "review") on
this track, the reverse of every other track. A full stubbed `loop` run is
exactly 4 dispatches: one PM brief, one build workstream, one QA pass, one
reviewer.

Both `build` and `peer-review` dispatch a single workstream instead of the
usual four-area matrix. The role defaults to `backend`; override it project-wide
via `.devteam/config.yml`:

```yaml
pipeline:
  loop_build_role: frontend   # backend (default) | frontend | platform | qa
```

`loop` has no design, no red-team, and no sign-off/deploy — `devteam run
--track loop` ends at `peer-review`. Promoting a change to a deploy-capable
track is a re-run with `--until` on a bigger track, or a `custom_stages`
config, not a `loop` feature. Stage-01 on `loop` renders a one-screen brief
(`templates/loop-brief-template.md`: intent, AC-N list, affected files)
instead of the full requirements template.

## The `review-only` track

Every other track assumes the intent→code direction: a brief exists, a
design spec exists, the pipeline produced the artifacts each later stage
reads. `review-only` (phase-35, `plans/phase-35-existing-codebase-mode.md`
item 35.1) doesn't — it reviews code that already exists, with no build
ever having run: `security-review` → `red-team` → `peer-review`. Nothing
else. Run it with:

```
devteam run --track review-only --scope src/payments/
```

`--scope <path>` is repeatable and narrows what's reviewed to a subtree
without changing which stages run — it lands in the rendered prompt (a
"Scope: ..." line) and on the gate (`scope: [...]`) for audit. Omit it to
review the whole repo.

This works on a repo with **zero `pipeline/` history** — no `pipeline/brief.md`,
no `design-spec.md`, none of the artifacts `security-review`/`red-team`/
`peer-review` normally read. Their `readFirst` pipeline-artifact dependencies
are all *optional*: at render time, an entry for a file that doesn't exist is
omitted from the prompt entirely rather than rendered as an instruction to
read something that isn't there (the "soft readFirst" half of 35.1 — see
`core/pipeline/stages.js`'s why-comment on `security-review`'s `readFirst`).
`security-review` normally only runs when stage-04a's pre-review heuristic
flags it, but stage-04a never runs on this track — with no prerequisite gate
to read, the orchestrator treats it as unconditional here, so all three
stages always dispatch.

`review-only` has no requirements/design/build/sign-off/deploy — there's
nothing to build and nothing to deploy. Peer-review keeps the standard
4-area matrix (2 approvals) rather than a scoped variant: unlike `nano`/`loop`,
there's no single-workstream build to size the review to, and an arbitrary
existing subtree can span every area.

## The `review-pr` track

`review-pr` (phase-35 item 35.2) backs a single command,
`devteam review-pr <number|url>` — it isn't meant to be picked directly via
`--track`. It's the narrower, PR-shaped sibling of `review-only`: instead of
reviewing an arbitrary existing subtree, it reviews one already-diffed,
already-scoped unit of change — an inbound GitHub PR — so peer-review is
sized like `nano`'s (a single "reviewer" workstream, `required_approvals: 1`)
rather than `review-only`'s four-area matrix.

`devteam review-pr` fetches the PR via `gh` (view + diff), materializes it
into `pipeline/review-input/` (`pr.md` — title/body as the stated intent;
`diff.patch` — the unified diff; `changed-files.md` — the changed-file list),
then dispatches `peer-review` alone against that input: a single reviewer in
panel mode, reviewer-then-critic when `review.mode: adversarial` (see
[§31.3](reference/stages.md)). Output is a normal stage-05 gate plus
`pipeline/code-review/by-*.md` — nothing else runs (no build, no
security-review, no red-team — the PR's own diff already is the change).

Publishing is opt-in: local-only by default, `--post` prints the exact
review-comment payload, requires interactive confirmation (or `--yes` in a
non-interactive context), and refuses outright on a partial or incomplete
review.

## Safety: the stoplist

Lighter tracks (`quick`, `nano`, `config-only`, `dep-update`, `loop`) refuse to run when the change description matches the **stoplist**: a list of phrases that flag changes too consequential for an abbreviated pipeline. The list lives in `core/guards/stoplist.js` and triggers on:

- `auth`, `authentication`, `authorization`, `session handling`
- `cryptography`, `key management`, `secret rotation`
- `pii`, `payments`, `regulated data`
- `schema migration`, `destructive data`
- `feature-flag introduction`, `new external dependency`

A match prints the reason and exits 2:

```
$ devteam stage build --feature "add auth middleware to API"
This change matches the safety stoplist. Re-run with --track full instead.
Reasons:
  - authentication: matched "auth" in: add auth middleware to API

If this is a false positive, re-run with --force to bypass.
Stoplist defined in .devteam/rules/pipeline.md §Stage 0.
(Active track: nano. Stoplist guarded.)
```

`full` and `hotfix` bypass the stoplist by design. `full` runs everything anyway; `hotfix` has mandatory pre-review, peer-review, and tests.

## How `devteam next` honors the track

`next` walks only the active track's stage list. On `nano`, after `build` passes, `next` advances directly to `qa`, skipping design, clarification, pre-review, and peer-review. On `full`, the walk hits all 18 stages in order.

The active track is read from `.devteam/config.yml` (`pipeline.default_track`), with `--track` as an override.

## Conditional dispatch within a track

`stage-04b` (security review) is in the track lists for `full`, `config-only`, and `hotfix`, but whether it actually runs depends on `stage-04a`'s `security_review_required` flag. The Platform engineer sets that flag at Stage 4a, which triggers or skips the security review.

```
$ devteam next
▶️ run-stage — security-review (stage-04b)
   stage not started
```

vs.

```
$ devteam next
▶️ run-stage — peer-review (stage-05)         # security-review was skipped
   multi-role stage not started
```

The skip is silent. Use `devteam summary` for visibility:

```
✅ pre-review        stage-04a  PASS
⏸  security-review   stage-04b  (skipped — condition not met: stage-04a.security_review_required !== true)
```

## When you've picked the wrong track

The `devteam stage <name>` command warns on stderr (but still runs) when you invoke a stage that's not in the active track:

```
[devteam] note: stage "design" is skipped by track "nano". Running anyway;
if this is unintended, change pipeline.default_track in .devteam/config.yml.
```

This is an escape hatch, not a block.

## Choosing a track

`devteam assess` automates this decision: given a change description and a file list it returns a `recommendedTrack`, a `confidence` level (`high | medium | low`), and the reasons. Running `devteam assess` (no flags) writes the result to `pipeline/track.json` so `devteam run` picks it up automatically. Use `devteam assess --confirm` to set `source:"human"` (operator-confirmed). See [Track record (`pipeline/track.json`)](#track-record-pipelinetrackjson) and [`ADR-006`](adr/006-track-inference-under-autonomy.md).

**You don't have to run `devteam assess` yourself first.** If `devteam run` starts with no `--track`, no `pipeline/track.json`, and no `pipeline.custom_stages`, it runs the same `assess()` heuristics inline — at any confidence level, not just "high" — prints the recommendation and reasons before dispatching anything, and writes `pipeline/track.json` itself (`source:"inferred"`) so the decision is still a file you can read, diff, or override with `--track`. This requires a `--feature`/description to assess; a bare `devteam run` with nothing to go on still falls through to `pipeline.default_track`. See [ADR-016](adr/016-assess-by-default.md) (supersedes ADR-006 §1).

Decision tree:

1. **Is this a hotfix for a live incident?** → `hotfix`. Pre-review and peer-review are mandatory; urgency is not a reason to skip them.
2. **Does this touch auth, PII, payments, crypto, migrations, or new external deps?** → `full`. Lighter tracks will block on the stoplist anyway.
3. **Is the change just config or feature-flag values, no code logic?** → `config-only`.
4. **Is the change a dependency bump?** → `dep-update`.
5. **Is the change a mechanical edit (rename, format, copy change)?** → `nano`.
6. **Does the change cross multiple systems, require architectural decisions, or carry significant security surface?** → `full`.
7. **Is the change bounded, low-stakes, and doesn't need to deploy yet (still iterating)?** → `loop`, the day-to-day default. Promote to a deploy-capable track later with `--until` or a `custom_stages` re-run — see [§ The `loop` track](#the-loop-track).
8. **Otherwise** → `quick`. This covers most bounded features and fixes: a new endpoint, a new UI component, added business logic, a non-trivial bug fix. Requirements must be clear and design self-contained. When in doubt between `quick` and `full`, start with `quick`; if Stage 2 design review surfaces cross-cutting concerns, restart on `full`.

> **Note on the config.yml default.** The factory default is `pipeline.default_track: full`, which is conservative and always safe. However, `full` runs red-team adversarial review and formal design on every change, which is wasteful when most attack surfaces don't apply. Evaluate the appropriate track for each brief rather than relying on the config default — in practice, treat `loop` as the day-to-day default and reserve `full` for changes where the audited trail is worth the ceremony.

This decision tree is for the intent→code direction — you're about to *ship*
something. `review-only` isn't a rung on that ladder: reach for it when
there's no new code to ship at all, just an existing subtree (or an entire
brownfield repo) you want reviewed. `devteam assess` does not recommend
`review-only` — pass `--track review-only` explicitly. See
[§ The `review-only` track](#the-review-only-track). `review-pr` isn't
picked from `--track` at all — run `devteam review-pr <number|url>` to
review an inbound PR; see [§ The `review-pr` track](#the-review-pr-track).

## Prototype mode is not a track

Use `devteam prototype` when you are still learning what to build. It creates a
lightweight packet under `pipeline/prototypes/<id>/` with intent, build prompt,
feedback, and promotion handoff files. It does not write gates, advance
`devteam next`, or satisfy sign-off/deploy evidence.

```bash
devteam prototype start "settings flow" --feature "Try a faster account-settings flow"
devteam prototype note settings-flow --feedback "Users missed the save state"
devteam prototype promote settings-flow --track full
```

Promotion is the boundary: once the idea is worth hardening, run the generated
`devteam run --feature-file pipeline/prototypes/<id>/promotion.md --track <t>`
command. Use a normal track for auth, payments, migrations, secrets, customer
data, infrastructure, or anything headed toward production.

## Track record (`pipeline/track.json`)

`devteam assess` writes a per-run inference record to `pipeline/track.json`:

```json
{
  "track": "quick",
  "source": "inferred",
  "confidence": "high",
  "reasons": ["description matches quick-change keywords (minor/small fix)"],
  "assessed_at": "2026-06-15T14:00:00Z",
  "assessed_by": "devteam assess 0.8.0"
}
```

`devteam run` reads this file as part of the track resolution chain:
```
--track  >  pipeline/track.json  >  custom_stages  >  default_track  >  "full"
```

| Field | Meaning |
|---|---|
| `track` | The inferred (or confirmed) track name |
| `source` | `"inferred"` — produced by `devteam assess`; `"human"` — confirmed by `--confirm` |
| `confidence` | `"high"` / `"medium"` / `"low"` — the assess heuristic's certainty |
| `reasons` | Bullet-list of why this track was chosen |
| `assessed_at` | ISO timestamp of the assess run |
| `assessed_by` | The CLI version that wrote the record |

### Writing track.json

```bash
devteam assess                  # writes pipeline/track.json with source:"inferred"
devteam assess --confirm        # writes pipeline/track.json with source:"human"
devteam assess --apply          # writes custom_stages to .devteam/config.yml (project-wide; no track.json)
devteam run --feature "..."     # ADR-016: no track.json yet → assesses inline, writes it with source:"inferred"
devteam run --track quick       # bypasses track.json entirely; always source:"human"
```

### Confidence guard (`autonomy.require_confirmed_track`)

By default `devteam run` warns once on an inferred track but never blocks. Set
`autonomy.require_confirmed_track: true` in `.devteam/config.yml` to enable the guard:

| `source` | `confidence` | Flag off (default) | Flag on |
|---|---|---|---|
| `"human"` | any | proceed silently | proceed silently |
| `"inferred"` | `"high"` | warn once | proceed silently |
| `"inferred"` | `"medium"` or `"low"` | warn once | **`unconfirmed-track` halt** |

The guard is keyed on the explicit config flag — not `CI=true` (which is already
overloaded by the validator and verify runner). CI pipelines opt in by setting the
flag, not by inheriting an ambient environment variable. See [ADR-006](adr/006-track-inference-under-autonomy.md).

Override the halt with `--track <name>` (sets `source:"human"`) or `--force` (bypasses).

## Customizing tracks

Tracks live in `core/pipeline/stages.js` under `STAGES_BY_TRACK`. Add a new track:

```js
const STAGES_BY_TRACK = {
  ...
  // For experiments where you want full rigor but no deploy yet
  "experiment": ["requirements", "design", "build", "peer-review", "qa", "retrospective"],
};
```

Then update `TRACKS` (the validation set) and `config-only`/`dep-update`/`hotfix` to leave the new entry untouched. Tests in `tests/contract.test.js` will fail if any track lists an unknown stage; this is intentional.
