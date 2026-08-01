# ADR 016 — Assess-by-default on `devteam run`

**Status:** Accepted
**Date:** 2026-07-31
**Authors:** Mumit Khan (design), drafted with Claude Sonnet 5

## Context

`plans/landscape-review-2026-07.md` §3.2 names scale-adaptive ceremony as adoption-critical:
mandatory heavyweight pipelines are losing across the market (BMAD backlash, Tessl pivot,
Agent OS slim-down), and Stagecraft's own `devteam assess` — the mechanism that would pick
a cheaper track for a small change — is a **separate, manual step** that most invocations
of `devteam run` never call. [ADR-006](006-track-inference-under-autonomy.md) made that
separation deliberate: Decision §1 states "`devteam run` MUST NOT infer a track by calling
`assess` internally," reasoning that internal inference is opaque — no file records it, no
operator reviewed it.

Two things have changed since ADR-006 shipped (Phase 11.3, 2026-06-15):

1. **The opacity objection has a cheaper fix than a ban.** ADR-006 conflated "inference
   happens inside `devteam run`" with "inference is invisible." Those are separable: the
   driver can run the same heuristic `devteam assess` runs and still write the exact same
   `pipeline/track.json` record `devteam assess` would have written — auditable, diffable,
   overridable — without requiring the operator to have run a second command first.
2. **A narrower, undocumented version of this already shipped.** `plans/pipeline-speed-opportunities`-adjacent
   work (`changelog.d/right-sizing.md`, commit `b193428`) added a `highConfidenceTrack()`
   call inside `resolveTrack` that silently downgrades the track when `assess()` returns
   **"high" confidence** and the result differs from `default_track` — with no ADR
   amendment and no `pipeline/track.json` write. In practice, ADR-006 Decision §1 was
   already breached in a narrow, high-confidence-only, silent way before this ADR. This
   ADR replaces that undocumented exception with a documented, audited one that covers
   every confidence level, not just "high."

Verified today (`core/driver.js:resolveTrack`, `core/cli/commands/run.js`,
`core/cli/commands/assess.js`, `core/stage-shopping/assess.js`): the `assess()` heuristic
is already a standalone, side-effect-free module (`core/stage-shopping/assess.js`) — it
does not need extraction to be called from the driver. The precedence chain from ADR-006
§2 (`--track > pipeline/track.json > custom_stages > default_track > "full"`) and the
`checkTrackConfidence` guard from ADR-006 §3/4 are unchanged and continue to key off
`{source, confidence}` regardless of which code path produced them.

## Decision

### 1. `devteam run` MAY now infer a track by calling `assess` internally — but MUST persist the result as the same auditable file `devteam assess` would have written

This reverses ADR-006 Decision §1's "MUST NOT," but keeps its underlying requirement (an
inferred track must be a file, not a silent side effect) intact. Concretely, in
`resolveTrack(opts, config, cwd)`:

- If `--track` is given → `source: "human"` (unchanged).
- If `--repair` is given → `"hotfix"`, `source: "human"` (unchanged).
- If `pipeline/track.json` exists → its `track`/`source`/`confidence` win (unchanged —
  this is still the highest-precedence non-human path, so a prior `devteam assess` run,
  or a hand-edited file, is never silently re-assessed or overwritten).
- If `config.pipeline.custom_stages` is set → `source: "config"` (unchanged — a
  project-wide track choice is a decision a team already made; per-run inference does not
  second-guess it).
- **New:** otherwise, if `config.pipeline.right_sizing !== false` and there is a
  feature/description to assess, call `assess(description, changedFiles)` and return its
  result with `source: "inferred"` **at whatever confidence level `assess()` returns** —
  not gated to "high" as the pre-29.2 `highConfidenceTrack` downgrade path was.
- Otherwise (no signal to assess — no feature/description at all) → `config.pipeline.default_track`
  (unchanged final fallback).

`run()` then writes `pipeline/track.json` itself when this new path fired, in the identical
shape `core/cli/commands/assess.js` writes (`track`, `source: "inferred"`, `confidence`,
`reasons`, `assessed_at`, `assessed_by`) — `assessed_by` is tagged
`"devteam run <version> (assess-inline, ADR-016)"` so an auditor can distinguish it from a
human-run `devteam assess`. This is a per-run record, same as ADR-006 always intended; it
is simply now written by `run` instead of requiring a prior `assess` invocation.

### 2. The existing confidence guard governs the result unchanged

ADR-006 §3/4's `checkTrackConfidence` warn/halt matrix reads only `{source, confidence}` —
it has no idea whether those came from a hand-run `devteam assess`, an operator-edited
file, or this new inline path, and it does not need to. Medium/low confidence still only
warns by default and halts under `autonomy.require_confirmed_track` in exactly the cases
ADR-006 specified. **No changes to the guard were needed or made** — this is the reason
ADR-006's file-based design (rather than, say, an in-memory flag) made this reversal cheap.

### 3. The `right_sizing` config flag is the opt-out, not a new flag

`config.pipeline.right_sizing: false` already meant "disable automatic track/skip
inference" (it also gates the deterministic stage-skip and candidate-active-role
mechanisms in `core/pipeline/right-sizing.js`, which this ADR does not touch). Assess-inline
folds under the same flag rather than adding a second knob — one place to turn off all
run-time inference.

### 4. `devteam run` prints the recommendation and rationale before any dispatch

Non-interactively, on stderr (identical in CI and interactive use — no prompt, no
TTY-dependent branching): the recommended track, its confidence, the `assess()` reasons,
and (since [29.3](../../plans/phase-29-scale-adaptive-ceremony.md)) the ceremony cost
preview — stage slots, dispatch count, token range, and cost range (`core/ceremony-preview.js`)
— printed right after the plan line for every run, inferred or explicit `--track` alike.
`--json` mode does not print this (stdout stays reserved for the machine-readable summary,
unchanged contract); the `pipeline/track.json` file is the durable record regardless of
output mode.

## Consequences

**Positive:**

- **Most `devteam run` invocations now get a track recommendation for free**, without a
  separate `devteam assess` step — directly addresses the Phase 29 "ceremony is a tax"
  finding for the common case (`--feature` given, no `--track`).
- **The undocumented `highConfidenceTrack` exception is retired.** One documented,
  audited inference path replaces one documented gate (custom_stages/track.json/human) plus
  one undocumented, confidence-gated exception. Net reduction in surprising behavior.
- **Zero changes to the confidence guard, the precedence chain above the new step, or the
  `pipeline/track.json` schema.** The blast radius is exactly `resolveTrack`'s final
  fallback branch and one new CLI print.

**Negative / costs:**

- **A description-only signal is a weaker basis than `devteam assess`'s typical usage**,
  which often runs against a real changed-files list after some work has already happened.
  At run-start, no files have changed yet, so the inline assessment leans more heavily on
  the feature-text keyword patterns than the file-pattern heuristics. This is the same
  tradeoff ADR-006 itself accepted for `devteam assess` run early in a change's life; it is
  not new here, but the base rate of "inferred" runs goes up.
- **Every confidence level can now select a track automatically**, not just "high" as the
  narrower pre-29.2 path allowed. A medium/low-confidence inferred track proceeds by
  default (warn-only) unless `autonomy.require_confirmed_track` is set — teams that want a
  harder floor must opt into that flag; it is not new to this ADR (ADR-006 already shipped
  it) but the population of runs it can now stop grows.
- **No feature/description given → no assessment.** A bare `devteam run` with no
  `--feature`, no `--repair`, no `pipeline/track.json`, and no `custom_stages` still falls
  through to `config.pipeline.default_track` exactly as before ADR-016 — there is no
  meaningful signal to assess in that case, and forcing an assessment off an empty string
  (or an empty changed-files list, which is the common case for a fresh run with nothing
  yet built) would produce a low-confidence "full" recommendation on every single run,
  which is not useful and would have broken most of the existing driver test suite's
  no-feature invocations. This is a deliberate scope boundary, not an oversight — see
  "What now needs to be true" below and the honest-scope note in the corresponding
  changelog entry.

**What now needs to be true:**

- `core/driver.js:resolveTrack` calls `assess()` directly (not `highConfidenceTrack`) when
  the new path fires, at any confidence, and `run()` persists the result to
  `pipeline/track.json`.
- `core/cli/commands/run.js` renders the recommendation + rationale + slot/dispatch-count
  block on the `run-plan` event when `track_source === "inferred"` and the result came
  from this run (not a pre-existing `pipeline/track.json`).
- `docs/tracks.md` documents that `devteam run` (not only `devteam assess`) can write
  `pipeline/track.json`.
- `changelog.d/` records the behavior change and supersedes the "high-confidence auto-track
  selection" line from the right-sizing changelog entry that this ADR replaces.

## Alternatives considered

1. **Keep the "high confidence only" restriction from the pre-29.2 `highConfidenceTrack`
   path.** Simpler diff, smaller behavior change. Rejected: it leaves the common
   medium-confidence case (most real feature descriptions — "add a small settings toggle,"
   "quick fix for the login bug") on the `default_track` fallback, which is exactly the
   "full ceremony as the default" tax Phase 29 is trying to remove. The confidence guard
   already exists to make medium/low-confidence inference safe; not using it here for the
   common case wastes the machinery ADR-006 built.

2. **Add a new config flag (`pipeline.assess_by_default`) instead of reusing
   `right_sizing`.** More explicit, but introduces a second on/off switch for what is, from
   an operator's perspective, the same question ("should devteam infer things about my run
   automatically?"). Rejected for now; revisit if a team wants independent control (e.g.,
   keep deterministic stage-skipping but disable track inference) — no evidence of that
   need yet.

3. **Print the recommendation but do not write `pipeline/track.json`.** Keeps `run()`
   read-only with respect to that file. Rejected: without the write, a resumed or re-invoked
   run in the same working tree would re-assess from scratch every time (and could recompute
   a different track if `assess()`'s heuristics or the changed-files list shifted mid-change),
   and there would be no artifact for a human to later confirm (`devteam assess --confirm`)
   or override by hand-editing. Writing the file is what makes the per-run decision a
   "one-shot decision at run-start" (ADR-006 Fact 2), consistent with the rest of the design.

4. **Fully retire the ADR-006 Decision §1 prohibition and delete the addendum note instead
   of cross-linking.** Rejected per house convention (`docs/adr/README.md`): ADRs are not
   edited to erase a decision's history; a reversal supersedes via a new ADR and a dated
   addendum, so a future reader can see both what was decided and why it changed.
