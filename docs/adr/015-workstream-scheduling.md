# ADR-015: Bounded Workstream Scheduling

Status: Accepted

Date: 2026-07-03

## Context

Phase 26 issue #317 asks for faster runs through safe scheduling, queue telemetry,
and provider-aware retry/backoff. Stagecraft already dispatches independent
workstreams inside a single stage in parallel, but all ready workstreams were
started at once. That can overload a local host or provider profile, and it left
operators unable to distinguish model time from queue wait.

Changing stage order into DAG waves is a larger contract decision: restart,
invalidation, consequence ceilings, and gate-chain semantics all depend on the
stable ordered stage list. That remains future work.

## Decision

This ADR authorizes bounded scheduling only inside an already-ready stage.
Stage IDs, gate filenames, `devteam next` ordering, restart behavior, and
consequence ceilings remain unchanged.

- `routing.host_concurrency` may cap concurrent workstreams per host, with an
  optional `default` limit.
- The scheduler preserves result order and never drops sibling results after a
  sibling fails.
- `run-log.jsonl` records `workstream-queued`, `workstream-started`, and
  `workstream-finished` with queue timing fields.
- `devteam performance critical-path` reports queue wait separately from
  dispatch wall time and workstream compute.
- Transient no-gate retries record `retry_reason` and `backoff_class`; immediate
  non-timeout failures use short backoff while timeouts keep the full delay.

## Consequences

Operators can limit local/provider pressure without weakening validation or
changing pipeline order. Queue wait becomes visible in the critical-path report.
The next DAG-wave phase must add dependency metadata and invalidation rules in a
separate ADR before stages are reordered or overlapped.
