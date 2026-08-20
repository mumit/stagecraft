# Phase 41.1 Evidence Review — 2026-08-19

**Verdict: NO-GO.** The two-project minimum and durable-history minimum are
met, but none of the four evidence-gated runtime capabilities has enough
evidence to activate. Keep GitHub issues #142–#145 open and keep Phase 41.2–41.4
unimplemented.

## Corpus and query

Two independent, non-fixture repositories were initialized with the dogfood
profile and exported through the consent-bound aggregate path:

```bash
devteam evidence export --cwd <project-a> --out <bundle-a> --consent --json
devteam evidence export --cwd <project-b> --out <bundle-b> --consent --json
devteam evidence status --bundle <bundle-a> --bundle <bundle-b> --json
```

The review used the two resulting schema-version `1.0` bundles without raw
logs, prompts, responses, repository paths, or source content. The export
suppressed 17 observations under the privacy boundary.

## Denominators and data quality

| Measure | Observed |
|---|---:|
| Independent projects | 2 |
| Aggregate run records | 10 |
| Complete runs | 1 |
| Repair runs | 3 |
| Durable dispatch observations | 12 |
| Malformed / oversized / unreadable records | 0 / 0 / 0 |
| Orphan events | 2 |
| Dispatches with cost coverage | 0 |

`run_count` is not treated as a count of independent feature changes in this
review. One real `loop` change required multiple stop/resume and direct-stage
remediation commands, and the aggregate counted more than one run record for
that logical change. The evidence implementation needs an explicit
logical-run/resumption audit before future readiness logic uses this number as
a denominator. The two orphan events came from intentionally interrupted
dispatches during safe recovery from an uncapped or known-misrouted retry; they
are retained as quality signals, not discarded.

## Gate results

### D5 adaptive routing — NO-GO

- `projects`: 2 / 2 — met.
- `projects-with-durable-dispatch-history`: 2 / 2 — met.
- `projects-with-host-comparison`: 0 / 2 — not met.
- `projects-with-cost-telemetry`: 0 / 2 — not met.

Both projects routed through Codex, whose adapter supplied complete observed
token telemetry but no trustworthy USD cost. There is no comparative route,
no per-project quality/cost denominator, and therefore no factual basis for a
shadow routing recommendation. More same-host Codex runs do not close this
gate.

### H3 deterministic recipe candidates — NO-GO

- `projects`: 2 / 2 — met.
- `projects-with-fix-retry-runs`: 0 / 2 — not met.
- `recurring-failure-projects`: 0 / 2 — not met.
- `accepted-resolution-projects`: 0 / 2 — not met.
- `accepted-recurring-resolution-observations`: 0 / 3 — not met.
- `derivable-accepted-resolutions-percent`: 0% / 80% — not met.

The Attune run produced honest QA/review failures and recoveries, but no
hash-bound accepted resolution was recorded. Manual edits or a later PASS do
not imply acceptance under ADR-012. No recipe candidate may be generated.

### ADR-005 standing grants — NO-GO

- repair runs: 3 / 10 — not met.
- consequence-ceiling events: 0 / 1 — not met.
- granted ruling events: 0 / 1 — not met.

### ADR-007 Tier 2 active stall response — NO-GO

- stall events: 0 / 1 — not met.
- calibrated threshold: absent.

No active termination policy can be calibrated from zero real stalls.

## Counterexamples and builder findings

The second project was useful because it found control-plane defects without
opening any learning gate:

1. The stoplist matched the negated documentation phrase "migration is not
   planned" and required `--force` on every resume.
2. A resumed run warned that its original token cap was absent unless the
   operator restated it. The unsafe dispatch was interrupted before changes.
3. A documentation-only `loop` build routed to the backend workstream, whose
   write set excluded every required document.
4. Automatic recovery routed QA and peer-review documentation defects back to
   the same incompatible backend workstream.
5. Direct stage remediation defaulted to the configured `full` track instead
   of the active run's `loop` track unless `--track loop` was restated.
6. QA and peer review earned their cost: they found two stale documents missed
   by earlier repository searches. The final product diff was limited to five
   documents and passed 2,434 project tests plus six bounded acceptance checks.
7. Dogfood bootstrap files initially appeared in the product diff and had to
   be moved to checkout-local excludes before peer review.

These are evidence for reliability and DX fixes, not evidence for adaptive
routing, learned recipes, standing grants, or active stall termination.

## Collection needed for the next review

1. Route comparable roles through at least two predeclared hosts in each
   project, with at least five durable dispatches per candidate pair and
   observed or explicitly estimated cost coverage.
2. Complete at least five autonomous fix/retry runs in each project. For any
   recurring schema-bound failure, use `devteam evidence accept-resolution`
   only after a human verifies the bounded result.
3. Exercise consequence ceilings naturally; do not manufacture approvals.
4. Retain naturally occurring stalls and calibrate from their observed false
   positive/negative cost before considering Tier 2.
5. Re-export fresh bundles and repeat the exact query above. Do not merge
   historical and fresh bundles from the same project identity as independent
   projects.

## Decision

Phase 41.1 is complete as a dated no-go review. Phase 41 remains evidence-gated.
The next implementation phase is the independently justified dogfood
reliability work in [`phase-42-dogfood-reliability.md`](phase-42-dogfood-reliability.md).
It must not weaken Phase 41 thresholds or turn telemetry into self-modifying
source.
