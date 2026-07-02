# Phase 26 — Performance, Observability, and Run Usability

Status: proposed under parent issue
[#312](https://github.com/telus-labs/stagecraft/issues/312).

Stagecraft is intentionally conservative: it validates gates, audits writes,
stamps evidence, retries boundedly, and preserves human consequence ceilings.
That safety is valuable, but today long runs can feel opaque. Operators often
see only sparse messages such as "dispatching" and "dispatched" while the real
work is spread across host invocations, transcript logs, verification commands,
merge decisions, retries, stampers, and `run-log.jsonl`.

Phase 26 treats speed and visibility as the same product problem: first make
the critical path observable, then remove or parallelize the work that is proven
to dominate it.

## Current Findings

These findings come from reading the current driver, orchestrator, logging,
status, verification, and observability code.

- `runStageHeadless()` already executes workstreams inside a stage with
  `Promise.all`, so build, peer-review, sign-off, and review fanout are
  stage-local parallel.
- The stage list itself remains serial. `devteam run` asks `next()` for one
  action at a time and dispatches or merges that action before the next loop.
- The autonomous driver records `heartbeat`, `dispatch-observation`,
  `dispatched`, retry, halt, merge, auto-rule, and stall events in
  `pipeline/run-log.jsonl`, but ordinary line output only surfaces a small
  subset.
- `devteam run --watch` exists, but it is intentionally minimal: current stage,
  dispatch elapsed, log-growth rate, heartbeat age, and stall status.
- `devteam status` reads `run-state.json` and the tail of `run-log.jsonl`, but
  it does not yet show active workstreams, log paths, queue/backoff state,
  verification substeps, or the last gate written.
- `devteam log --follow` watches gate/artifact mtimes. It does not present the
  run-log transition stream, so it misses in-flight dispatch progress and retry
  detail until files land.
- OpenTelemetry spans exist for stage planning, prompt rendering, adapter
  invocation, `next()`, and merge. Tracing is opt-in and useful for backend
  users, but not a default operator UX.
- Stage 04a and Stage 06 both run orchestrator-stamped verification. Build and
  QA agents may also run tests inside their host sessions. The same unchanged
  tree can therefore be tested repeatedly.
- Polyglot verification discovers Node, Python, and Go suites but currently runs
  suites sequentially. This is safe and deterministic, but test-heavy projects
  pay the sum of suite durations.
- The transient retry delay defaults to 30 seconds regardless of provider error
  class. That is safe, but it can be pure idle time for immediate structural
  failures.
- Prompt framework context is measured in `docs/reference/prompt-budget.md`,
  but there is no live latency/cost report that ties prompt size to p50/p95
  workstream time.
- `scripts/performance.js` aggregates historical per-role/host outcomes from
  gates. It is useful for routing analysis, but it is not an end-to-end
  critical-path profiler for a single run.

## Non-Goals

- Do not weaken gate validation, authenticated gate chains, write audit,
  stoplist, required-capability checks, or consequence ceilings.
- Do not trust model-written "tests passed" claims in place of orchestrator
  verification.
- Do not auto-select a lighter track at medium or low confidence.
- Do not actively kill stalled host processes until real `stall-detected` data
  supports a calibrated ADR-007 Tier 2 policy.
- Do not introduce DAG scheduling without an ADR for dependency metadata,
  invalidation, restart, and ready-set semantics.
- Do not share mutable model sessions across roles or projects by default.

## Tracking Issues

Parent:

- [#312 — Phase 26: performance, observability, and run usability overhaul](https://github.com/telus-labs/stagecraft/issues/312)

Child issues:

- [#313 — Performance: critical-path telemetry and coverage report](https://github.com/telus-labs/stagecraft/issues/313)
- [#314 — Observability UX: rich live run narrative, status, and logs](https://github.com/telus-labs/stagecraft/issues/314)
- [#315 — Verification speed: suite concurrency and content-addressed receipts](https://github.com/telus-labs/stagecraft/issues/315)
- [#316 — Performance: automatic safe track/workstream right-sizing and deterministic skips](https://github.com/telus-labs/stagecraft/issues/316)
- [#317 — Performance: DAG waves, per-host concurrency, and smarter retry/backoff](https://github.com/telus-labs/stagecraft/issues/317)
- [#318 — Performance: prompt slimming, latency-aware routing, and capacity strategy](https://github.com/telus-labs/stagecraft/issues/318)

## Phase 26.1 — Critical-Path Telemetry

Tracking issue: [#313](https://github.com/telus-labs/stagecraft/issues/313).

Deliverables:

- enrich run-log events with enough orchestrator-owned timestamps to reconstruct
  stage, workstream, queue, invoke, stamp, merge, retry-delay, and halt time
- add a critical-path report, either as `devteam performance critical-path` or
  an equivalent first-class command
- compute wall-clock critical path versus sum of parallel workstream compute
- report telemetry coverage and missing-duration reasons
- detect repeated verification commands and estimate savings from concurrency
  or receipt reuse

Acceptance:

- human and JSON outputs are available
- report works from orchestrator timestamps rather than model self-report alone
- tests cover multi-workstream stages, retries, merge, missing telemetry,
  bounded isolation, and no-run states
- docs define p50/p95 collection across real projects

Implementation notes:

- keep privacy posture consistent with Phase 17: aggregate categories and numeric
  timing are fine; prompt text, transcript excerpts, blockers, feature text, and
  repository identity are not
- preserve existing `dispatch-observation` allowlist for evidence export; if new
  fields are needed, review the export/analyzer path before writing them
- record queue time even before a scheduler exists so later per-host concurrency
  work has a baseline

## Phase 26.2 — Rich Live Operator UX

Tracking issue: [#314](https://github.com/telus-labs/stagecraft/issues/314).

Deliverables:

- richer line output for `devteam run`: stage start, workstream start/finish,
  host, elapsed time, gate path, log path, retry/backoff, current verification
  step, and merge result
- enhanced `devteam run --watch`: active workstreams, last gate, latest log
  growth, queue/backoff state, transcript pointers, and stall status
- `devteam status --verbose` and/or richer `devteam log` views over run-log
  transition events, not only gate/artifact mtimes
- a docs section explaining when to use `--watch`, `devteam status`,
  `devteam log --follow`, the web UI, `DEVTEAM_VERBOSE`,
  `DEVTEAM_HEADLESS_TEE`, and OpenTelemetry

Acceptance:

- `--json` output remains clean
- redirected output remains line-oriented and ANSI-free
- TTY watch mode has deterministic tests with fake timers/streams
- one command can answer: "what is Stagecraft doing right now?"

Implementation notes:

- prefer enriching existing `onEvent` payloads over tailing transcript files from
  the CLI layer
- keep progress samples out of durable evidence export unless they are explicitly
  allowlisted
- link every active workstream to its transcript path when one exists

## Phase 26.3 — Verification Efficiency

Tracking issue: [#315](https://github.com/telus-labs/stagecraft/issues/315).

Deliverables:

- bounded concurrent execution for independent Node, Python, and Go suites
- resource groups for exclusive suites such as browser, database, or port-bound
  tests
- deterministic output ordering even when suites run concurrently
- content-addressed verification receipts keyed by command, relevant file
  digests, dependency lockfiles, runtime/toolchain fingerprints, material
  environment/config, and Stagecraft verifier version
- receipt reuse only when the full key is unchanged

Acceptance:

- stale receipts are rejected after source, test, dependency, command, config, or
  environment changes
- repair red-before/green-after proof remains distinct and cannot be erased by
  caching
- failure aggregation remains pessimistic
- verifier stdout/stderr memory remains bounded

Implementation notes:

- start with concurrency because it is simpler to reason about than caching
- make receipt provenance gate-visible without allowing model-authored receipts
- keep a global opt-out for projects with fragile test isolation

## Phase 26.4 — Right-Sizing and Deterministic Skips

Tracking issue: [#316](https://github.com/telus-labs/stagecraft/issues/316).

Deliverables:

- integrate high-confidence assessment at run start when the operator has not
  chosen a track
- derive candidate active workstreams from changed paths, design file ownership,
  brief/design scope, and existing `active_roles`
- make Stage 01 confirm derived active roles instead of inventing them from
  scratch where possible
- add conservative deterministic applicability triggers for accessibility,
  performance, observability, verification-beyond-tests, clarification, and
  executable-spec fast paths
- show the expected stage/workstream count before dispatch

Acceptance:

- medium/low confidence never auto-selects a lighter track
- every deterministic skip writes an auditable reason naming trigger inputs
- seeded relevant changes always activate the required stages
- operators can force stages back on

Implementation notes:

- treat this as "prove unnecessary" rather than "assume unnecessary"
- never skip security, migration, accessibility, performance, or observability
  based only on model prose
- right-sizing should improve time-to-first-failure, not hide failures until late

## Phase 26.5 — Scheduling, Queueing, and Retry Policy

Tracking issue: [#317](https://github.com/telus-labs/stagecraft/issues/317).

Deliverables:

- ADR for DAG dependency metadata and ready-set semantics
- evaluate post-pre-review and post-QA parallel waves without changing gate IDs
- per-host/profile concurrency limits with queue-time telemetry
- provider/error-aware retry/backoff policy
- immediate operator notification when one sibling fails while independent
  siblings continue

Acceptance:

- stable stage IDs and gate files remain unchanged
- restart and invalidation clear dependent gates correctly
- parallel failure does not lose useful sibling results
- queue time appears in critical-path reporting
- consequence ceilings remain stage-level decisions

Implementation notes:

- `Promise.all` is not always fastest; unbounded fanout can increase throttles
  and transient retries
- scheduling should optimize completion time, not instantaneous concurrency
- active stall termination remains out of scope until evidence supports it

## Phase 26.6 — Prompt, Routing, and Capacity Strategy

Tracking issue: [#318](https://github.com/telus-labs/stagecraft/issues/318).

Deliverables:

- split role briefs into compact always-loaded contracts and task-specific
  detail where safe
- generate stage/role packets with only applicable rules and artifact pointers
- pass changed-file manifests and digests so agents can read on demand
- evaluate provider prompt caching and persistent-session risks
- extend routing recommendations with p50/p95 duration and retry-adjusted
  completion time
- decide when cloud/remote runners improve the critical path after local cleanup

Acceptance:

- prompt reductions are evaluated against first-try pass rate and blocker recall
- routing recommendations never trade away quality outside explicit policy
- remote-capacity decisions include queue wait, bundle/download time, credential
  boundaries, and result-application latency
- mutable shared sessions across roles/projects remain rejected by default

Implementation notes:

- prompt slimming is a quality-sensitive change; measure outcomes before
  celebrating token savings
- latency-aware routing depends on the telemetry coverage from Phase 26.1
- cloud runners should not be used to accelerate unnecessary duplicate work

## Recommended Sequence

1. Implement Phase 26.1 and Phase 26.2 together as the visibility foundation.
2. Collect at least five real runs across two projects and publish p50/p95
   baselines for time-to-first-failure, safe sign-off, safe deploy, and
   documentary close.
3. Implement verification concurrency before receipts.
4. Add deterministic right-sizing only after visibility can prove what was
   skipped and why.
5. Draft the DAG/concurrency ADR before touching stage scheduling.
6. Attempt prompt/routing/capacity improvements only after the critical-path
   report identifies them as material.

## First PR When Resuming

Start with a narrow observability slice:

- add explicit `dispatch-started` and per-workstream `workstream-started` /
  `workstream-finished` events to the driver callback stream
- include gate path, log path, host, role, elapsed time, exit code, timed-out
  status, skipped status, and write-violation count
- teach `devteam run` line output and `--watch` to show those events
- do not alter scheduling or retry behavior

This gives operators immediate relief and creates the data needed for the
performance work that follows.

## Definition of Success

On at least two real projects:

- operators can tell what a live run is doing from one command
- critical-path reports have at least 90% orchestrator-owned duration coverage
- p50 time to safe deploy improves by at least 30% on eligible runs
- p95 time improves by at least 20% without increased transient retries or
  timeouts
- first-try pass rate is unchanged or better
- seeded security, migration, accessibility, observability, and performance
  cases still activate their required stages
- no stale verification receipt is accepted
- cost and tokens per successful pipeline are lower or equal
