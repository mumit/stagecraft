# Phase 17 — Durable Evidence Instrumentation

**Status:** Item 17.1 complete (PR #254); operational collection in progress.
**Roadmap item:** Audit P3-1 follow-through / GitHub #143 evidence acquisition.
**Purpose:** make normal autonomous runs produce the durable, privacy-bounded dispatch
history that Phase 16 can assess and export.

---

## 1. Why this phase exists

Phase 16 made evidence safe to inspect and share, but it correctly reported D5's
`durable-dispatch-history` condition as unavailable. Current and archived gates are
snapshots: successful gates can be replaced, merged, or pruned, so they cannot prove
how many dispatches occurred over time.

Phase 17 closes that instrumentation gap without enabling adaptive routing. The
autonomous driver records one allowlisted `dispatch-observation` event for every
non-skipped workstream dispatch. `devteam evidence status` prefers those durable events
for routing aggregates and uses gate snapshots only as a legacy display fallback.

### Scope: the autonomous driver only

"The autonomous driver" is the whole scope, and it is deliberate. `devteam stage`
dispatches to the same host with the same role, model and cost, and writes both a gate
and a corpus row — but it emits **no** `dispatch-observation`, so it contributes nothing
to routing readiness.

The reason is what the ≥5-per-(role, host) threshold assumes. A stage invocation is
ad-hoc by design: `--workstream`, a `--track` override, `--patch`, `--from`,
`--skip-completed`, and it can be re-run against unchanged code as often as you like.
Five repeats of one peer-review are five samples of a single input, not five independent
observations of how a host performs on a role. Counting them would inflate the
denominator with correlated data — and would make the gate openable with a shell loop,
which is precisely what an evidence gate exists to prevent.

Corpus rows carry a `run_id` when they came from a run and none when they did not, which
is the exact discriminator. `devteam evidence status` reports the uncounted total
("Dispatches not counted: N recorded via `devteam stage`") so the exclusion is visible
at the moment someone is collecting, rather than discovered afterwards.

---

## 2. Event contract

Each `dispatch-observation` in `pipeline/run-log.jsonl` may contain only:

| Field | Source | Purpose |
|---|---|---|
| `outcome` | constant | identifies the typed event |
| `stage` | driver action | groups observations by pipeline stage |
| `role` | dispatch plan | identifies the workstream role |
| `host` | resolved adapter | supports host comparison |
| `model` | written gate or `unknown` | supports model attribution |
| `status` | written gate or `NO_GATE` | records the observed gate outcome |
| `gate_written` | driver observation | distinguishes gate-producing dispatches |
| `timed_out` | adapter result | distinguishes timeout outcomes |
| `cost_usd` | written gate, optional | supports cost coverage and comparison |
| `duration_ms` | gate or adapter result, optional | supports latency comparison |

The event never copies blockers, warnings, reasons, prompts, responses, paths,
transcripts, feature text, credentials, or repository identity. The driver applies the
Phase 16 category validator and secret scan before writing category values; evidence
analysis applies the same boundary again before any category reaches an export bundle.

---

## 3. Compatibility and counting rules

- The v1 export schema does not change. Its `routing` rows already contain the exact
  aggregates needed for durable dispatch history.
- If at least one durable dispatch event exists, routing readiness and exported routing
  rows use durable events only. Gate snapshots are not mixed in, avoiding double-counts.
- If no durable event exists, local status still displays current/archive gate routing
  as a legacy snapshot, but the durable-history readiness condition remains unmet.
- Skipped workstreams are not dispatches and produce no observation.
- A no-gate attempt is retained with `status: NO_GATE`; it contributes to dispatch
  volume and duration but not PASS/WARN/FAIL/ESCALATE counts.
- Evidence starts accumulating after this phase lands. Stagecraft does not manufacture
  historical observations from old gates.

---

## 4. Work items

### 17.1 — Durable per-workstream dispatch observations

- Record the allowlisted event after each headless dispatch settles.
- Prefer durable observations in the evidence analyzer.
- Keep legacy gate snapshots visible without treating them as history.
- Open D5's local `durable-dispatch-history` condition only when real events exist.
- Add driver, analyzer, privacy-boundary, and backward-compatibility tests.

### 17.2 — Real-project collection and review (operational, not code)

- Run Stagecraft normally on at least two independent user projects.
- Retain each project's ignored `pipeline/run-log.jsonl` and gates.
- Periodically run `devteam evidence status --json` and inspect quality counters.
- Export only with operator consent, then run portfolio status across the bundles.
- Review #143 only after each compared role/host pair has at least five durable
  observations in each of two projects and cost coverage is non-zero.

### 17.3 — Remaining signals

- H3's explicit accepted-resolution signal is implemented in Phase 18 under ADR-012;
  real-project collection and review remain outstanding.
- ADR-007 Tier 2 still needs observed stalls before a threshold can be calibrated.
- Standing grants still need real repair runs, consequence-ceiling halts, and granted
  ruling events. Existing driver events already collect those facts.

---

## 5. Acceptance criteria

1. Every non-skipped autonomous workstream dispatch creates exactly one durable event.
2. The event contains no free-form gate text and malformed gates degrade to `NO_GATE`.
3. Durable history is never combined with legacy snapshots in one routing aggregate.
4. Legacy projects remain readable but cannot satisfy durable-history readiness.
5. Export schema 1.0 and its privacy controls remain unchanged.
6. Full tests, lint, consistency, and changelog guard pass.

---

## 6. Capability posture after Phase 17

Phase 17 makes D5 evidence collectible; it does not make D5 ready. GitHub #143 remains
open until the documented multi-project volume and cost thresholds are met and reviewed.
Issues #142, #144, and #145 remain independently evidence-gated.
