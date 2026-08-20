# ADR 003 — Bounded autonomous pipeline execution

**Status:** Accepted
**Date:** 2026-06-09
**Authors:** Mumit Khan

## Context

Today a human stage manager drives every pipeline transition: read `devteam next`,
type the indicated command, repeat. `next()` already returns one of six actions
(`run-stage`, `continue-stage`, `merge`, `fix-and-retry`, `resolve-escalation`,
`pipeline-complete`; `core/orchestrator.js:1046–1099`), so the pipeline is already a
state machine. The question is whether — and how — to add a driver that advances it
autonomously.

Three facts shape the decision:

1. **`FAIL` is monolithic.** `next()` collapses every non-passing, non-escalating
   outcome into `fix-and-retry`. A grep for `transient | failureClass | retryable`
   across `core/` and `bin/` returns zero hits. A corrupt gate and a failing test
   both yield `fix-and-retry` (`orchestrator.js:1068` vs `:1085`); the former offers
   `cat <gate> # repair` — a human diagnostic, not an executable fix. A naive driver
   cannot tell these apart.

2. **There is a real infinite-loop hole.** Structural-input failures (context
   overflow, host crash) write no gate (`headless.js:191`). `next()` then sees "stage
   not started" and returns `run-stage` (`:1029`). The progress-based circuit breaker
   (`retry_number`/`this_attempt_differs_by`, `gate.schema.json:80–83`,
   `validator.js:343`) lives *inside* the gate, so with no gate it never fires, and
   `next()` has no breaker of its own. A scripted loop would re-dispatch forever,
   re-paying tokens.

3. **Autonomy is in tension with the thesis.** Stagecraft's position is "the unit is
   the team, not the model," and `ESCALATE` exists because some decisions exceed an
   agent's authority. A loop that never escalates removes a safety mechanism rather
   than solving the problem.

A separate review (companion design doc) established that the discriminating signals
for a typed failure model **already exist** in `runHeadless`'s return, gate
validation, and `computeFixSteps` — assembled by nothing today — and that the value
of a typed failure model is independent of autonomy: it improves the human-driven
product on its own.

## Decision

Stagecraft will support **bounded autonomous execution**, built in three layers and
shipped in that order, with a fourth optional layer:

1. **Typed failure model (foundational).** Classify every non-pass outcome by
   *required response* into five classes — `transient`, `structural-input`,
   `code-defect`, `judgment-gate`, `external-blocked` — and carry a `failure_class`
   on `next()` action objects. No new gate fields, no schema migration; it assembles
   signals that already exist. Ships first because it fixes a current defect for the
   human-driven product and closes the infinite-loop hole.

2. **Typed escalation + authority provenance (safety).** Define the Principal's
   "cannot decide" boundary as three typed cases — missing **authority**, missing
   **information**, irreducible **value** tradeoff — and record *which authority was
   exercised under whose grant* on each advance past a judgment gate, chained under
   C6 (tamper-evident gate chain).

3. **Bounded autonomous driver `devteam run` (capstone).** A deterministic code loop
   (LLMs only at workstream dispatch and escalation) with a **consequence ceiling**:
   it may advance autonomously up to — but not into — the irreversible/outward-facing
   stages **stage-07 sign-off** and **stage-08 deploy**
   (`core/pipeline/stages.js:363,381`), which always require an explicit human grant.
   Structured retry targets are also consequence-bounded: before clearing gates or
   invoking a host, the driver compares every target path with each candidate build
   role's existing `roleWrites`. It prefers a compatible `stage-02.file_ownership`
   owner, then stable stage order. If no single candidate owns every target, it halts
   as `retry-ownership` / `structural-input` and records only paths plus role names.
   Unstructured blockers retain the existing retry path because there is no path claim
   to prove; the convergence ceilings still bound those attempts.

4. **Recipe factory (optional upside bet).** Persist resolved escalations as
   semantically-indexed fix-recipes via the existing `core/memory/` store, so
   recurring *derivable* failures resolve deterministically. Gated on Layers 1–3 and
   on evidence of recurring-failure volume.

The human stage manager's role shifts from **mechanical sequencer** to **authority
grantor**. Full detail, signal-to-class mapping, and the phased roadmap are in
[`docs/autonomous-execution-design.md`](../autonomous-execution-design.md).

## Consequences

**Positive:**

- The typed failure model (Layer 1) improves the human-driven product immediately and
  closes a real cost-leak (the infinite loop), independent of whether the driver ever
  ships.
- The consequence ceiling keeps the feature on-thesis: the human is concentrated at
  the decisions that need them, not removed.
- Authority provenance makes an autonomous merge accountable — a prerequisite for
  letting the driver touch anything consequential, and it extends C6 rather than
  duplicating it.
- `next()` stays a pure, testable function of disk state; the one stateful concern
  (retry/backoff/budget counting) is confined to the driver.

**Negative / costs:**

- New persistent state the architecture deliberately avoided: `run-state.json`, a
  pipeline lock file, `run-log.jsonl`. "Stateless within a run" stops being strictly
  true for driver-managed runs.
- Transient vs. structural-input is genuinely fuzzy from a bare non-zero exit; v1 uses
  a repetition heuristic (one wasted retry worst case) until host adapters can report
  typed exits.
- Autonomy at machine speed amplifies cost; the driver is correctness-critical on the
  `--budget-usd` pre-dispatch check, which today does not exist (cost is only summed
  retrospectively, `orchestrator.js:385`).
- The recipe factory caches judgments that can go stale as code drifts; it needs decay
  + drift-triggered re-escalation or it amplifies stale judgment.

**What now needs to be true:**

- Layer 1 ships before any driver work; the driver branches on `failure_class`, never
  on the bare `FAIL` string.
- `devteam run` never advances into stage-07/08 without an explicit human grant,
  regardless of Principal confidence.
- A structured retry never widens a role's write surface or falls through to a broad
  dispatch when no candidate role owns every target path.
- Every autonomous advance past a judgment gate writes an authority record.
- Peer-review fanout uses whole-stage retry (correct-but-wasteful) until a
  gate-versioning scheme makes targeted fanout retry consistent.

## Alternatives considered

1. **Do nothing — keep the human-driven stage manager.** Rejected as the *only* path,
   but its premise (human authority at consequential decisions) is preserved by the
   consequence ceiling. The mechanical sequencing it forces on humans is the waste
   being removed.

2. **Build `devteam run` directly on the current `FAIL` model.** Rejected: the
   infinite-loop hole and the corrupt-gate/failing-test conflation make a driver built
   on bare `FAIL` incorrect, not merely crude. The taxonomy is a prerequisite, not a
   polish.

3. **Full autonomy through deploy (no ceiling).** Rejected: erodes the safety model
   that differentiates Stagecraft from a bare agentic loop, and creates an
   unaccountable path to irreversible, outward-facing actions.

4. **Claude Code `/loop` or Codex `--full-auto` as the outer driver.** Viable for
   cheap prototyping, rejected for production: non-deterministic command selection,
   observed hallucinated `devteam` subcommands, and a billed meta-LLM on top of every
   stage dispatch. Stagecraft's moat is the structured gate contract and audit trail,
   not the loop — a code driver keeps the loop deterministic and free.

5. **External orchestrator (LangGraph/CrewAI/OpenClaw) with Stagecraft as a tool
   library.** Rejected as over-engineering for a single pipeline; revisit only if
   Stagecraft becomes one pipeline among many in an existing agent framework.

6. **Recipe factory as a top-tier item now.** Rejected: it depends on accumulated
   failure-resolution data we do not yet have, the same "premature" reasoning that
   deprioritized G9 (self-modifying pipeline). Sequenced last and gated on real
   volume.
