# Phase 29 — Scale-Adaptive Ceremony

Status: **proposed** (from [landscape-review-2026-07.md](landscape-review-2026-07.md) §1, §3.2).
Prompts: [prompts/roadmap-2026-prompts.md](prompts/roadmap-2026-prompts.md) §29.

## Why

The 2026 market's clearest verdict: mandatory heavyweight pipelines lose (BMAD backlash,
Tessl pivot, Agent OS slim-down, "SDD = rebranded BDUF"). What wins is *scale-adaptive*
process — a 4-step loop for small changes, full ceremony only when stakes justify it.
Stagecraft already has 6 tracks and `devteam assess`, but full remains the narrative
default, the smallest general-purpose track (`quick`, 10 stages) is still heavyweight for
a 20-line change, and nothing tells the operator what a track will *cost* before they
commit. The gates are the product; the ceremony is the price. Lower the price.

## Work items

### 29.1 `loop` track: spec → build → verify → review

Add a 4-slot track to `core/pipeline/stages.js` `STAGES_BY_TRACK`: stage-01 (brief,
minimal template), stage-04 (single-workstream build), stage-06 (QA with orchestrator
stamping — the existing stampable stage), stage-05 (single-reviewer). No design stage,
no red-team, no deploy (deploy remains available via `--until`/track upgrade). The brief
template for loop is one screen: intent, ACs, affected files.

Constraints to respect: the consequence ceiling still applies; `verify-chain` must handle
the shorter track (predecessor = nearest earlier existing gate already supports skips);
schemas unchanged — loop reuses existing per-stage schemas.

- Acceptance: `devteam stage requirements --track loop` renders; a full stubbed loop run
  completes in 4 dispatches; consistency checks (stage-count claims in prose) updated.
- Verify: `npm test`, `CI=true DEVTEAM_HEADLESS_COMMAND=cat npm test`, `npx eslint .`,
  `npm run consistency`.

### 29.2 Assess-by-default on `devteam run`

[verify-first] Claim: `devteam run` without `--track` uses the config/default track and
only consults `pipeline/track.json` when present; `devteam assess` is a separate manual
step (ADR-006 provenance: `inferred` vs `human`).

Implement: when `devteam run` starts with no `--track` and no `pipeline/track.json`,
run the assess heuristics inline, print the recommendation + rationale + ceremony
estimate (29.3), and proceed with `source: "inferred"` provenance (the existing
unconfirmed-track guard semantics stay). `--track` always wins and records
`source: "human"`. Non-interactive contexts (CI) behave identically — no new prompt.

- Acceptance: run tests cover: no-track → inferred assess; explicit track → human
  provenance; existing track.json respected.

### 29.3 Ceremony cost preview

Before dispatching, print (and expose via `devteam assess --json`) a per-track estimate:
stage slots, dispatch count, estimated tokens (framework overhead per dispatch is already
tabulated in `docs/reference/prompt-budget.md` — use those numbers plus artifact-size
sampling), and estimated cost range using `core/pricing.js` against the routed models.
When the Phase 28 corpus has ≥5 comparable runs, prefer empirical medians over static
estimates and label the basis (`estimate_basis: "static" | "empirical"`).

- Acceptance: preview renders for all tracks; empirical path covered by a corpus fixture;
  numbers carry an explicit "estimate" label (house honesty rules).

### 29.4 Fold specialty QA into one slot on small tracks

[verify-first] Claim: stages 06b (a11y), 06c (observability), 06d
(verification-beyond-tests), 06e (performance-budget) are separate sequential slots on
tracks that include them, and none are orchestrator-stamped.

Implement: on `quick` (and any track flagged `compact_qa`), render 06b–06e as a single
combined "verification sweep" dispatch (one role, one gate that carries the four
sections), keeping full-track behavior unchanged. This is a track-shape change, not a
schema change: the combined gate is a merged document validated against a new
`stage-06x` schema that embeds the four existing shapes as optional sections.

- Acceptance: quick-track stubbed run makes 1 dispatch where it made 4; full track
  unchanged; validator accepts both shapes; right-sizing skip logic still applies.

### 29.5 Docs: reposition full ceremony as the audited path

Update README/user-guide/tracks.md: `loop` is the default day-to-day path; `full` is the
**audited** path you choose for regulated/high-stakes changes (tie-in to the Phase 34
evidence story). Add a "which track" decision table with the ceremony-cost column.
Preserve the candid tone; do not delete existing caveats.

- Acceptance: `npm run consistency` doc checks pass; docs name the loop track everywhere
  track lists appear (consistency checker will catch stragglers).

## Out of scope

Conversational stage mode (E9 — still gated on user demand), removing any stage from
`full`, auto-upgrading tracks mid-run (escalation already covers "this got bigger than
assessed" by halting).

## Success signal

A one-paragraph feature on the loop track completes in 4 dispatches and single-digit
dollars worst-case, with the same gate/chain/audit artifacts on disk — and `devteam
assess` tells you that before you spend it.
