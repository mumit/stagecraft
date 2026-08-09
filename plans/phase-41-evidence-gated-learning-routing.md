# Phase 41 — Evidence-Gated Learning & Routing

Status: **blocked on real-project evidence** (2026-08-08). Planning is approved; activation
and implementation are not. Phase 39 makes the decision measurable.

## Why

Stagecraft already has bounded project patterns, outcome counters, explicit promotion,
dispatch evidence, and routing proposals. The dangerous shortcut would be to call those
features “self-learning” and let a small or synthetic corpus rewrite routes or executable
recipes. This phase opens only after repeated outcomes across independent real projects.

## Entry gates

### Adaptive routing (D5)

- at least 5 durable dispatches for each candidate `(role, host)` pair;
- coverage across at least 2 real user projects;
- provider-observed or explicitly labelled estimated cost;
- accepted outcome and retry/escalation data for the compared routes;
- no material regression hidden by an aggregate (report per-project denominators).

### Deterministic recipe candidates (H3)

- at least 2 real projects with at least 5 autonomous fix/retry runs each;
- the same schema-bound failure class explicitly accepted at least 3 times across both;
- at least 80% of the accepted resolutions mechanically derivable as a bounded recipe;
- no secrets, free-form transcript, or repository content required to identify the class.

Synthetic fixtures, repository tests, and repeated runs of one toy project do not count.

## Planned work after the gates open

### 41.1 Evidence review and ADR update

Publish the exact corpus query, denominators, exclusions, uncertainty, and counterexamples.
Update the relevant ADR before changing runtime behavior. If either gate fails, close the
review with a dated no-go decision and continue collecting data.

### 41.2 Shadow recommendations

Run route and recipe recommendations in shadow mode. Record what would have happened,
without changing the selected host, fix steps, or gate result. Compare against actual
accepted outcomes for a defined evaluation window.

### 41.3 Approval-bound recipe promotion

Generate schema-bound candidate recipes into the existing controlled promotion path.
Candidates are inspectable, versioned, reversible, scoped by failure signature, and never
execute arbitrary model-authored shell. Human approval remains required until a later ADR
has substantially stronger evidence.

### 41.4 Bounded adaptive routing

Allow only predeclared role/host alternatives within budget, capability, assurance, and
trust-profile constraints. Provide an override and rollback; record provenance in the run
plan and evidence corpus.

## Explicit non-goal: self-modifying Stagecraft

Phase 41 does not edit `stages.js`, role briefs, rules, gates, or source code from telemetry.
G9 remains parked. Learning produces data and controlled proposals; deterministic code and
policy remain reviewable source changes.

## Exit signal

Shadow recommendations demonstrate a predeclared improvement without violating quality,
cost, privacy, capability, or trust constraints; promotion and rollback are auditable; and
the evidence review is reproducible from consented, privacy-bounded aggregates.

