# Phase 40 — Approval-Bound Conversational Artifact Refinement

Status: **complete; merged in PR #415** (2026-08-08).

## Why

The read-only coordinator (PR #411) makes project state easier to understand without giving
a chat session tools or write access. The next useful step is not a general shell agent. It
is a bounded refinement loop for the two upstream artifacts where dialogue adds the most
value: requirements and design.

The safety boundary is proposal first, deterministic apply second. A model may propose an
artifact change; only an explicit local approval mutates project state.

## Dependencies

- Grounded, read-only coordinator and adapter capture mode from PR #411.
- Existing gate invalidation, artifact hashing, audit log, and project-context guard.

## Work items

### 40.1 Refinement session contract

Add requirements/design refinement sessions grounded in current artifacts, run plan,
relevant gates, and a bounded knowledge pack. Sessions use captured output with host tools
disabled. The host returns a versioned proposal envelope, not shell commands or direct file
writes.

### 40.2 Scratch proposal and exact preview

Store each proposal under a project-local, auditable proposal area with:

- artifact identity and base content hash;
- normalized replacement or constrained patch;
- exact unified diff;
- affected gates and deterministic invalidation preview;
- model/host provenance and bounded event counters;
- expiry/status (`pending`, `applied`, `rejected`, `stale`).

Reject path traversal, unknown artifacts, oversized output, malformed patches, and edits
outside the requirements/design allowlist.

### 40.3 Explicit approve/apply/reject workflow

Provide commands to inspect, apply, or reject a proposal. Apply rechecks the base hash and
the preview before one atomic write; a stale proposal never rebases itself. Rejection records
only a bounded reason code unless the user explicitly adds a note. No mutation occurs during
the conversational command itself.

### 40.4 Deterministic downstream invalidation

Applying a requirements or design proposal must use the existing invalidation mechanism and
show exactly which gates/artifacts become stale. Proposal metadata is append-only audit
evidence; it does not replace gate truth or create a parallel pipeline state machine.

### 40.5 Privacy and UX verification

Record allowlisted counters (turn count, proposal size, accepted/rejected/stale, affected
gate count, latency, usage/cost where available), never transcripts or hidden reasoning.
Test no-tool invocation, prompt-injected command text, stale hashes, concurrent edits,
atomic-write failure, invalidation, redaction, and terminal/non-interactive UX.

## Out of scope

Arbitrary repository editing, arbitrary shell execution, direct gate approval by a model,
automatic proposal apply, transcript telemetry, and a self-modifying stage/role/rule system.

## Acceptance

A developer can discuss a requirements or design artifact, receive an exact inspectable
diff and invalidation preview, then explicitly apply or reject it. Chat remains unable to
execute tools or mutate the repository, and stale/concurrent proposals fail safely.
