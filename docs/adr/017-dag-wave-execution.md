# ADR 017 — Stage DAG waves: `dependsOn` metadata + wave execution semantics

**Status:** Proposed
**Date:** 2026-08-02
**Authors:** Mumit Khan (design), drafted with Claude Sonnet 5

## Context

`plans/phase-32-performance-parallelism.md` §32.2 names stage-level DAG waves as the
largest single wall-clock win in the 2026-07 speed analysis: a full-track run pays 18
sequential stage slots today, and waving two already-known-independent stage groups cuts
the worst case to ~13. `plans/landscape-review-2026-07.md` §3.5 names this build-speed work
adoption-critical for the same reason ADR-015 was: faster runs mean faster iterations of
the learning loop this repo is built around.

ADR-015 (Bounded Workstream Scheduling, 2026-07-03) deliberately stopped short of this:

> "Changing stage order into DAG waves is a larger contract decision: restart,
> invalidation, consequence ceilings, and gate-chain semantics all depend on the stable
> ordered stage list. That remains future work... The next DAG-wave phase must add
> dependency metadata and invalidation rules in a separate ADR before stages are reordered
> or overlapped."

This is that ADR. `docs/BACKLOG.md` D11 records the same deferral. `core/pipeline/stages.js`
is unchanged since ADR-015 in the respects that matter here: `next()`
(`core/orchestrator.js:1343`) walks a single ordered `stageList` and returns exactly one
ready action; `core/gates/chain.js`'s `predecessorGate()` walks the same declared
`orderedStageNamesForTrack()` list to decide each stage's chain predecessor; ADR-007's
stall probe races exactly one dispatch Promise per call, keyed by one `workstreamId`; and
`autonomy.max_parallel_stages` does not exist in `core/config.js` today.

### A numbering note, and why this file is 017 not 016

The original phase-32 prompt (and this item's own precondition check, as first drafted)
named this **ADR-016**. Phase 29.2 has since landed ADR-016 as "Assess-by-default on
`devteam run`" (`docs/adr/016-assess-by-default.md`, Accepted). Commit `6f2777d`
("fix ADR-017 collision") already caught this and renumbered the plan item and the
canonical prompt (`plans/prompts/roadmap-2026-prompts.md` §32.2) to ADR-017, with an
explicit warning: *"ADR-016 is 'Assess-by-default' from 29.2 — do NOT treat its existence
as this precondition being met."* This session was launched from a stale copy of the
prompt (`prompts/prompt-phase-32.2.txt`, still reading ADR-016) — per this repo's own rule
that the plan file is authoritative over a prompt file, and per the roadmap prompt file's
explicit warning, the precondition check ran against `docs/adr/017-*.md`, which does not
exist. This ADR is therefore the deliverable for that failed precondition, filed under the
corrected number.

### A design conflict the "derive `dependsOn` from `readFirst`" instruction surfaces

The item's own guidance — derive `dependsOn[]` "from `readFirst`/artifact-flow analysis" —
does not mechanically produce the item's own proposed wave-1 region. Verified against
`core/pipeline/stages.js`:

- `red-team` (`stage-04c`) `readFirst` today is: `[..., "pipeline/context.md",
  "pipeline/brief.md", "pipeline/design-spec.md", "pipeline/pr-*.md",
  "pipeline/pre-review.md", "pipeline/security-review.md"]` — it lists
  `pipeline/pre-review.md` (stage-04a's own artifact) and `pipeline/security-review.md`
  (stage-04b's artifact) as files the model is told to read.
- `pre-review` (`stage-04a`) is the item's proposed wave-1 partner for `red-team`.

Read literally, "`dependsOn` derived from `readFirst`" means `stage-04c` already declares
a dependency on `stage-04a` (and conditionally `stage-04b`) via its existing prompt content
— the exact opposite of the parallel-safe pairing the plan proposes. This is not a new bug:
it is the same class of gap `plans/phase-35-existing-codebase-mode.md` names as
"artifact-tolerant readFirst" — today's `readFirst` rendering (`core/adapters/render-
helpers.js`) is a flat instruction list with no existence check, so a sequential pipeline
never has to ask whether a listed file exists yet. Waving `{04a ∥ 04c}` is the first place
in this codebase where that assumption becomes load-bearing: at wave-dispatch time,
`pipeline/pre-review.md` may not exist yet (stage-04a is still running), and
`pipeline/security-review.md` may never exist on a run where the security-review trigger
doesn't fire. `stage-06b`/`06c`/`06d`/`06e`, by contrast, verify clean — none references
another's artifact; each reads `pipeline/test-report.md` (stage-06/qa) and `stage-06d`
additionally reads `pipeline/red-team-report.md` (stage-04c) — both already earlier in
track order and unaffected by this wave.

## Decision

### 1. `dependsOn` is a curated allow-list, not a mechanical readFirst mirror

Adding `dependsOn: [...]` to a STAGES-table entry means: *this stage's actual prerequisite
is the named stage(s), not the full linear prefix of stages before it in declared order.*
A stage with no `dependsOn` field keeps today's behavior exactly as-is — implicitly gated
on its immediate declared-order predecessor (and any existing `conditionalOn`), unchanged.

Mechanical readFirst-vs-artifact matching produces *candidates*, not the final list — each
candidate must be confirmed as a true hard prerequisite (content the stage's objective
cannot proceed without) rather than supplementary context. For the two target regions:

- **`{stage-04a ∥ stage-04c}`**: valid only once `stage-04c`'s `readFirst` drops
  `pipeline/pre-review.md` and `pipeline/security-review.md`. Red-team's objective —
  "adversarial review of what was just built" — needs the brief, design spec, and build
  output (`pipeline/pr-*.md`); it does not need pre-review's lint/dependency findings or
  a security approval note to enumerate attack scenarios against the diff. This trim is
  part of the 32.2 implementation PR, not a follow-up — the wave is not safe to ship
  without it. `dependsOn` for `stage-04c` becomes `["build"]` (explicit — breaks it out of
  the implicit chain); `stage-04a` needs no `dependsOn` entry (its implicit predecessor is
  already `build`, which is exactly the dependency it should have).
- **`{stage-06b ∥ stage-06c ∥ stage-06d ∥ stage-06e}`**: each gets `dependsOn: ["qa"]`
  (`stage-06d` transitively also needs `red-team`, but that stage is always earlier in
  every track that includes both and does not need restating). No readFirst changes
  needed — already verified clean above.
- The folded `stage-06x` (29.4 `compact_qa` tracks) is single-member; no wave and no
  `dependsOn` entry applies to it.

Everywhere else, `dependsOn` stays absent. This is deliberately narrow: the mechanism only
lifts the implicit total-order constraint where a human (or an agent under review) has
confirmed the lift is safe, not wherever a mechanical scan finds no readFirst overlap.

### 2. Wave formation: readiness-based, capped, deterministic

The driver's readiness check (today's `next()` logic in `core/orchestrator.js`) is reused
per-candidate, not reimplemented. Once per driver iteration, before dispatch: compute the
ready set — every not-yet-PASS/WARN stage whose gating condition holds, where a stage with
explicit `dependsOn` is ready when *every named dependency* holds a PASS/WARN gate
(regardless of its position in declared order), and a stage without `dependsOn` is ready
under exactly today's rule (immediate predecessor PASS/WARN, `conditionalOn` satisfied).
From the ready set, take up to `autonomy.max_parallel_stages` (default **2**) stages, in
declared STAGES-table order, as the wave. Members not selected because the cap was hit wait
for the next wave/iteration — never dropped, never reordered for cost or host-affinity
reasons; determinism over optimization.

A stage with no `dependsOn` sitting *between* two wave members in declared order (e.g.
`security-review`/stage-04b, between `pre-review`/04a and `red-team`/04c) is simply not
part of that wave — it becomes ready on a later iteration once its own (unchanged) implicit
predecessor gate exists, which by then it does. This is why `stage-04b`/`04d` need no
`dependsOn` entry and no special-casing: giving `04c` an explicit, narrower dependency is
what lets it run early without disturbing `04b`/`04d`'s existing conditional-gating logic.

A wave with exactly one ready member (every stage outside the two carved-out regions,
always) behaves identically to today: one dispatch, no behavior change. Waves are additive
to single-stage dispatch, not a replacement for it.

Concurrent execution of a wave's members reuses `core/scheduler.js`'s
`mapByHostConcurrency` — extending its keying (member keyed by `(host, stage)` rather than
assuming one workstream per host call) rather than adding a second concurrency
implementation, per the item's explicit instruction. `autonomy.max_parallel_stages` caps
the wave as a whole; `routing.host_concurrency` (ADR-015) continues to cap concurrent
workstreams *within* a member exactly as today — the two caps compose, they do not replace
each other.

### 3. Gate chain stays track-order; waves change execution time only

`core/gates/chain.js`'s `predecessorGate()` is untouched. It records order-of-record from
`orderedStageNamesForTrack()`, not execution order, and has no notion of "wave" — a stage
dispatched concurrently with its declared chain-predecessor still stamps its `chain` field
against that predecessor's gate content once both exist, identically to how it would if the
predecessor had merely finished slightly earlier in a sequential run. `verifyChain` needs no
changes: the invariant it checks (predecessor hash matches recorded content) does not care
when either gate was written, only that the hash matches now.

### 4. `run-log.jsonl` gains `wave_id`

An integer, monotonic per run, assigned once per formed wave (not once per dispatch — every
event for a wave's N members shares the same `wave_id`). This lets `devteam performance
critical-path` compute *realized* parallel savings: wave wall time is
`max(member durations)`, not `sum(member durations)` as sequential accounting already
reports. A wave of one continues to report identically to today (max of one value = that
value = today's number).

### 5. `--max-iterations` accounting: one wave = one iteration

`state.iterations` increments once per wave regardless of member count, matching the item's
explicit instruction. This keeps the ceiling a bound on *driver decision cycles*, matching
its original intent (ADR-003), rather than on raw dispatch count — a full-track run that
took 18 iterations sequentially drops toward the ~13 the speed analysis names, with the two
2-member waves each folding two iterations into one.

### 6. Failure-in-wave handling: per-member, not per-wave

Existing failure classes (transient/structural, `fix-and-retry`, escalation) apply to each
wave member independently. One member FAILing does not touch a sibling's already-recorded
PASS/WARN gate — this generalizes ADR-015's "never drop sibling results after a sibling
fails," proven for workstream-level concurrency, to wave-level concurrency directly.
"Halts the wave" means the driver does not advance past this wave (does not begin forming
the *next* wave) until every current member reaches a terminal PASS/WARN or an unresolved
halt — it does not mean killing or invalidating a sibling that already passed.
`fix-and-retry` clears only the failing member's gate and re-dispatches only that member;
the retry pass is a wave of size one, which per §2 is identical to today's single-stage
dispatch. `next()`'s wave-aware variant may return more than one `fix-and-retry` action in
the same call when multiple members fail simultaneously; the driver dispatches each,
still bounded by `max_parallel_stages`, using the existing per-stage `retry_number` /
`autonomy.max_retries` counters unchanged (no new counters needed).

### 7. Heartbeat / stall-probe / lock semantics hold per wave member

[verify-first] **Claim checked:** ADR-007 §3 describes the dispatch-progress probe as
racing exactly one dispatch — *"When the driver commits to a `run-stage` or
`continue-stage` dispatch, it races two Promises: `Promise.race([_runStageHeadless(...),
stallProbe(workstreamId, cwd, changeId, stallOpts)])`"* — keyed by a single `workstreamId`,
polling that workstream's own log file growth and gate mtime. **Confirmed**: this is
inherently per-workstream already (the probe's two progress signals — log-file growth,
gate-file mtime — are both scoped to one stage's own files), so generalizing to N concurrent
members is additive, not a redesign: one `stallProbe` instance and one `Promise.race` per
wave member, each keyed by that member's own `workstreamId`/log path/gate path. No shared
clock or pooled probe across members — a fast member finishing must not reset or mask a
genuinely stalled sibling's clock, which a naive shared-probe implementation would risk.
Heartbeat emission (ADR-007 §2, once per driver iteration) needs no change beyond noting
`wave_id` and the set of in-flight stage names, since it already fires once per iteration
and a wave is one iteration (§5). The single exclusive `pipeline/run.lock` is unaffected —
a wave still executes entirely under the run's one lock, the same trust boundary ADR-015
already established for concurrent per-host workstreams; wave members are concurrent
children of one locked run, not separate locks.

### 8. `autonomy.max_parallel_stages`: new config field, default 2

Schema and validation mirror `autonomy.max_retries` (non-negative integer; falls back to
the default on invalid input). `max_parallel_stages: 1` is the escape hatch: every wave
degrades to a single-member wave (identical to today's dispatch), so a team gets the new
gate-chain/run-log/critical-path plumbing without ever running two dispatches at once,
without touching `dependsOn` or track structure.

## Consequences

**Positive:**

- Full-track wall clock drops toward the ~13-slot figure the speed analysis names, with
  zero change to gate-chain semantics, restart behavior, or consequence ceilings —
  ADR-015's boundary ("stage order, gate filenames, restart behavior... do not change")
  holds for wave-level concurrency exactly as it did for workstream-level concurrency.
- Reuses ADR-015's scheduler, failure vocabulary, and non-drop-sibling-results principle;
  reuses ADR-007's stall-probe design without redesigning it. No new failure classes, no
  new concurrency primitive.
- `max_parallel_stages: 1` gives an opt-out with no structural change, matching this
  repo's pattern of a config-flag escape hatch for every new automatic-parallelism feature
  (`routing.host_concurrency`, `right_sizing`).
- Composes with 32.1 (cache-first prompts): a wave's members now share the same cacheable
  layer-1/2 prefix as any other dispatch, so concurrency does not cost extra prompt-cache
  misses.

**Negative / costs:**

- **The `stage-04c` readFirst trim is a real, model-visible prompt change**, not an
  invisible refactor — it must be called out explicitly in the implementation PR's
  changelog entry, not buried inside "added `dependsOn`."
- **Two readiness-check code paths risk drifting** if wave-formation reimplements "is this
  stage ready" instead of calling the existing per-stage check. The implementation must
  make the wave-aware `next()` variant a thin wrapper that calls the existing single-stage
  readiness logic once per ready-set candidate, not a parallel reimplementation.
- **N concurrent stall probes means N concurrent `fs.stat` polling loops**, bounded by
  `max_parallel_stages` (so bounded, but not free) — acceptable at the proposed default of
  2, revisit if `max_parallel_stages` is raised materially beyond the two known regions.
- **`wave_id` is a new consumer contract.** `devteam performance critical-path` and any
  external `run-log.jsonl` tooling that assumes one event = one stage-in-isolation must be
  updated to group by `wave_id` for wall-clock (not cost) reporting.
- **This ADR authorizes exactly two regions.** Extending waves to any other stage pair
  requires the same readFirst-vs-`dependsOn` curation pass this ADR performed for these
  two — it is not a mechanism a future PR can apply mechanically without re-doing that
  check (see Alternative 1).

**What now needs to be true:**

- `core/pipeline/stages.js`: `dependsOn: ["build"]` on `red-team`; `dependsOn: ["qa"]` on
  each of `accessibility-audit`, `observability-gate`, `verification-beyond-tests`,
  `performance-budget`; `red-team`'s `readFirst` drops `pipeline/pre-review.md` and
  `pipeline/security-review.md` in the same PR.
- `core/orchestrator.js`: a wave-aware variant of `next()` that returns the full ready set
  (bounded by `max_parallel_stages`) by calling the existing single-stage readiness check
  per candidate, not a reimplementation.
- `core/scheduler.js`: `mapByHostConcurrency`'s keying extended for wave-member × host
  double-keying (or a thin wrapper) — no fork, no second scheduler.
- `core/driver.js`: one `Promise.race([dispatch, stallProbe])` pair per wave member;
  `wave_id` assigned once per formed wave and attached to every member event;
  `state.iterations` incremented once per wave; `fix-and-retry` targets individual failing
  members without touching passing siblings' gates.
- `core/config.js`: `autonomy.max_parallel_stages`, default `2`, validated like
  `max_retries`.
- `devteam performance critical-path`: realized-savings computation
  (`sum(member durations) - max(member durations)`) grouped by `wave_id`.
- Docs: `docs/adr/README.md` index row for ADR-017; `docs/runbooks/autonomous-run.md` gains
  a wave section; `.devteam/config.yml` schema docs gain `autonomy.max_parallel_stages`;
  `run-log.jsonl` schema reference gains `wave_id`.

## Alternatives considered

1. **Derive `dependsOn` mechanically from `readFirst` with no curation pass.** Rejected:
   demonstrated above to not even produce this ADR's own proposed wave-1 region —
   `stage-04c`'s current `readFirst` implies a dependency on `stage-04a` that would either
   defeat the parallel grouping (if honored) or leave a documented-but-broken prompt (if
   ignored). A curated, human/agent-reviewed allow-list is the only option that ships
   region 1 at all.
2. **Fork a second, wave-specific scheduler instead of extending `core/scheduler.js`.**
   Rejected per the item's explicit "extend keying, don't fork" instruction, and because it
   would create two independent answers to "how many things can run at once" (host-level,
   wave-level) that could disagree with each other.
3. **One shared stall-probe clock across all wave members instead of one probe per
   member.** Rejected: violates ADR-007's per-workstream file-growth model; pooling naively
   risks a fast member resetting the clock for a genuinely stalled sibling, masking exactly
   the condition ADR-007 exists to detect.
4. **Collapse a wave to one `run-log.jsonl` event covering all N members**, instead of
   per-member events sharing a `wave_id`. Rejected: existing consumers (critical-path
   report, `devteam status`, heartbeat/stall tooling) all key off per-stage/per-workstream
   events; collapsing would require rewriting those consumers and lose per-member failure
   granularity that §6 depends on.
5. **Fail-fast: one wave-member FAIL immediately halts/discards its siblings.** Rejected:
   ADR-015 already established "never drop sibling results after a sibling fails" for
   workstream-level concurrency, and the item text specifies `fix-and-retry` clears only
   the failing member. Discarding an already-passing sibling's work has no correctness
   benefit — gate-chain semantics (§3) don't care about wave membership.
6. **Count each wave member as its own iteration against `--max-iterations`** (unchanged
   accounting). Rejected: explicitly contradicted by the item text ("a wave = 1 iteration")
   and would silently double the effective iteration cost of exactly the runs this ADR is
   meant to speed up, undermining the ceiling's purpose as a bound on driver decision
   cycles rather than raw dispatch count.

## Questions for a human reviewer to rule on

1. **Is `max_parallel_stages: 2` the right default**, or should it default to the exact
   size of the larger target region (4, for `{06b, 06c, 06d, 06e}`) so that region is never
   artificially split across two waves? The conservative default of 2 means the QA region
   ships as two waves of two rather than one wave of four on its first iteration — this ADR
   proposes 2 per the item text; a reviewer with corpus data on host/provider load under
   4-way concurrency should confirm or override.
2. **Scope of the `stage-04c` readFirst trim.** This ADR scopes the trim narrowly (drop the
   two artifacts that create the dependency conflict) rather than pursuing the broader
   "artifact-tolerant readFirst" fix `plans/phase-35-existing-codebase-mode.md` proposes.
   Should 32.2's implementation instead adopt existence-tolerant rendering everywhere (a
   bigger, more general change) rather than a targeted removal for one stage? This ADR
   recommends the narrow fix now (unblocks 32.2 without taking on 35's scope) and defers
   the general fix to Phase 35, but flags this as a judgment call.
3. **Should other stage pairs be considered for a future wave region**, or does this ADR's
   authorization stay strictly scoped to the two named regions until a future ADR amendment
   performs the same curation pass for any additional pairing? This ADR intends the latter
   (see Consequences, "this ADR authorizes exactly two regions") but a reviewer may want
   that constraint stated even more explicitly in code (e.g., a comment on `dependsOn`
   itself, not just this ADR).
