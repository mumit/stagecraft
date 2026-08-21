# Phase 41.1 Evidence Re-Review — 2026-08-21

**Verdict: NO-GO, and for different reasons than the first review.** All four
evidence-gated capabilities stay shut. Keep GitHub issues #142–#145 open and
keep Phase 41.2–41.4 unimplemented.

The [2026-08-19 review](phase-41-evidence-review-2026-08.md) attributed the
zero cost coverage to insufficient collection. That was wrong, and the fixes
since then confirm it: cost telemetry was structurally impossible, not merely
sparse. It is now *partially* possible — and this re-review identifies the one
remaining defect that still blocks it.

No code was changed in this session.

## Corpus and query

Unlike the first review, this one had **one** real project available, not two:

```bash
devteam evidence status --cwd <project-a> --json
```

The second project from the 2026-08-19 review is not present on this machine.
Scratch projects created while developing the fixes were deliberately excluded —
the plan is explicit that test fixtures do not count, and counting them would
manufacture exactly the denominator the first review refused to trust.

| Measure | 2026-08-19 | 2026-08-21 |
|---|---:|---:|
| Independent projects | 2 | **1** |
| Aggregate run records | 10 | 3 |
| Repair runs | 3 | 3 |
| Durable dispatch observations | 12 | 7 |
| Dispatches outside a run | *(not measured)* | **13** |
| Dispatches with cost coverage | 0 | **0** |
| Malformed / oversized / unreadable | 0 / 0 / 0 | 0 / 0 / 0 |
| Orphan events | 2 | 1 |

Two of those rows are new information rather than movement.

**`run_count` now counts logical runs.** Three, not one per invocation. The
first review flagged that it could not tell invocations from feature changes;
that is fixed, so this denominator means something it did not before.

**13 dispatches were previously invisible.** The corpus holds 20 records; only
7 carry run-log provenance. The first review's "12 durable dispatch
observations" therefore described roughly a third of the dispatches that
actually happened. Direct `devteam stage --headless` remediation writes a
corpus record and no run-log event, and that gap is now declared rather than
silent.

## The cost-coverage blocker has moved

The gate-level fixes work. On a fresh `loop` run today, the run corpus carries
real cost:

```
records: 5
with a cost figure : 4/5
total cost         : $1.88
```

But the evidence path still reports nothing:

```
backend@claude-code  model=unknown  n=2  cost_obs=0  $0.00
pm@claude-code       model=unknown  n=1  cost_obs=0  $0.00
qa@claude-code       model=unknown  n=1  cost_obs=0  $0.00
```

**Cause.** `extractDurableRouting` reads run-log `dispatch-observation` events,
and `dispatchObservation` (`core/driver.js`) records the *model-asserted*
fields:

```js
model: evidenceCategory(gate && gate.model || "unknown"),
const cost = nonNegativeNumber(gate && gate.cost_usd);
```

`costEntryForGate`, defined immediately above it in the same file, already has
the correct precedence — host-reported, then token-derived, then
model-asserted — and is not used here. So a dispatch whose cost the
orchestrator observed still contributes `cost_obs: 0` to D5's denominator.

This is the same class of defect the first review's cost finding was: the data
exists, and the consumer reads the wrong field.

**Historical records cannot be backfilled.** The dogfooding corpus spans
2026-08-09 to 2026-08-19 and carries 0/20 model ids and 0/20 costs, because it
was recorded before the adapters captured them. Those runs stay uncostable
whatever is fixed now.

## Gate results

### D5 adaptive routing — NO-GO

- `projects`: 1 / 2 — **not met** (was 2/2; the second project is unavailable here).
- `projects-with-durable-dispatch-history`: 1 / 2 — not met.
- `projects-with-host-comparison`: 0 / 2 — not met. All 20 records are `codex`.
- `projects-with-cost-telemetry`: 0 / 2 — not met, now for the reason above.

Three independent blockers, only one of which is a code defect.

### H3 deterministic recipe candidates — NO-GO

- `projects`: 1 / 2 — not met.
- `accepted-resolution-projects`: 1 — one hash-bound accepted resolution now
  exists (`stage-04` / `code-defect`, derivable), where the first review found
  none. Real movement, on one project.
- `accepted-recurring-resolution-observations`: 1 / 3 — not met.

### ADR-005 standing grants — NO-GO

- repair runs: 3 / 10 — not met.
- granted ruling events: 1 — one `diagnosis-approved` auto-applied ruling.
- `recorded_rulings`: 0 — the typed path for manually applied rulings now
  exists and has not been used yet. Operators who ruled by hand during the
  first review's window have no way to record those retroactively.

### ADR-007 Tier 2 active stall response — NO-GO

- stall events: 0 / 1 — not met, unchanged. No stall has occurred naturally.

## What would change the answer

1. **Route `dispatchObservation` through `costEntryForGate`** and record the
   observed or routing-requested model rather than the model-asserted one. Small
   and mechanical; it is the only code defect this re-review found, and without
   it fresh dispatches keep contributing `cost_obs: 0`.
2. **Collect on a second real project.** One project cannot satisfy any
   `projects: N / 2` condition, and no fix changes that.
3. **Route comparable roles through two hosts.** Every record is `codex`. Note
   `codex` reported a usage limit through 2026-08-26 during this session, so a
   comparison needs either that quota restored or a third host configured.
4. **Re-export and repeat.** Fresh bundles only; do not merge historical and
   fresh bundles from the same project identity as independent projects.

## Decision

Phase 41 remains evidence-gated. The first review's central claim — that more
collection would open D5 — is superseded: collection was never the binding
constraint on cost coverage, and one instrumentation defect still stands between
the corpus and the evidence path. Fix that, then collect; not the other way
round.
