# Phase 25 — Omnigent Director Hardening

Status: proposed and parked for later implementation under parent issue
[#305](https://github.com/telus-labs/stagecraft/issues/305).

Phase 24 made Omnigent a first-party Stagecraft host runtime and added an
explicit experimental director prototype. Phase 25 is the follow-through that
decides whether that prototype can become a routinely usable execution mode.

## Goal

Harden `devteam stage --headless --experimental-omnigent-director` through real
dogfooding, clearer diagnostics, resumable session design, and policy
conformance work while preserving Stagecraft's existing contracts:
per-workstream gates, host-neutral schemas, post-run validation, write audit,
merge behavior, bounded autonomy, and deterministic `devteam next`.

## Non-Goals

- Do not make director mode the default.
- Do not add Omnigent-specific fields to gate JSON.
- Do not introduce a director gate consumed by Stagecraft.
- Do not move stage planning, retries, merge logic, or `next()` decisions into
  Omnigent.
- Do not claim tool-call-time policy enforcement until the Omnigent policy
  surface has conformance evidence.

## Tracking Issues

Parent:

- [#305 — Phase 25: harden Omnigent director integration](https://github.com/telus-labs/stagecraft/issues/305)

Child issues:

- [#306 — Omnigent director: dogfood and harden child-gate handling](https://github.com/telus-labs/stagecraft/issues/306)
- [#307 — Omnigent director: design partial resume semantics](https://github.com/telus-labs/stagecraft/issues/307)
- [#308 — Omnigent policy bridge: conformance and stable contract](https://github.com/telus-labs/stagecraft/issues/308)
- [#309 — Omnigent director: session supervision and evidence correlation](https://github.com/telus-labs/stagecraft/issues/309)
- [#310 — Omnigent remote execution: server and sandbox topology decision](https://github.com/telus-labs/stagecraft/issues/310)

## Phase 25.1 — Director Dogfood and Child-Gate Diagnostics

Tracking issue: [#306](https://github.com/telus-labs/stagecraft/issues/306).

Deliverables:

- run director mode against at least one real multi-workstream target project
- verify child gate paths for both in-place and bounded isolation
- improve result diagnostics when a director run writes only some expected child
  gates
- document operator recovery steps for partial director output

Acceptance:

- missing child gates are reported by role and workstream id
- bounded child gate paths are tested
- default non-director fan-out behavior remains unchanged

## Phase 25.2 — Partial Resume Semantics

Tracking issue: [#307](https://github.com/telus-labs/stagecraft/issues/307).

Deliverables:

- define what the director receives for completed workstreams: gate JSON,
  artifact pointers, summaries, or no context
- support `--experimental-omnigent-director --skip-completed` only after the
  prompt and overwrite semantics are explicit
- prevent completed child gates from being silently rewritten

Acceptance:

- all-complete, some-complete, and none-complete cases are covered by tests
- partial resume remains compatible with ordinary `devteam merge` and
  `devteam next`
- docs describe the recovery workflow

## Phase 25.3 — Session Supervision and Evidence Correlation

Tracking issue: [#309](https://github.com/telus-labs/stagecraft/issues/309).

Deliverables:

- decide whether director mode should prefer `session`, `resume`, or
  `no-session` for common operator workflows
- capture director-level session/conversation evidence in adapter-private
  sidecars
- correlate director session evidence with child workstream logs without adding
  gate schema fields

Acceptance:

- session ids remain outside gate JSON
- sidecars omit raw prompts, transcript excerpts, and policy lines
- docs explain reproducibility tradeoffs for persistent sessions

## Phase 25.4 — Policy Conformance Contract

Tracking issue: [#308](https://github.com/telus-labs/stagecraft/issues/308).

Deliverables:

- compare Stagecraft's policy JSON shape against current Omnigent behavior
- identify stable contract fields versus advisory hints
- add tests or fixtures for supported policy verdict parsing and fallback
  behavior

Acceptance:

- docs distinguish enforced, requested, and post-hoc-audited guarantees
- unsupported policy fields fail loudly or degrade explicitly
- Stagecraft write audit remains the enforcement backstop

## Phase 25.5 — Remote Server and Sandbox Topology Decision

Tracking issue: [#310](https://github.com/telus-labs/stagecraft/issues/310).

Deliverables:

- document local, server-backed, and managed-sandbox Omnigent execution
  topologies
- decide whether remote Omnigent execution remains in `hosts/omnigent` or moves
  behind a broader cloud-runner transport
- define credential and artifact-sync boundaries

Acceptance:

- an ADR or plan section records the topology boundary
- supported topologies have example config
- unsupported topologies fail or degrade clearly
- secrets and remote transcript content stay out of gate JSON

## Suggested First PR When Resuming

Start with Phase 25.1. It has the best risk/reward ratio: dogfood the existing
prototype, fix bounded child-gate paths if needed, and improve operator-facing
failure attribution before expanding semantics with partial resume or persistent
sessions.
