# Phase 38 — Execution Trust Profiles & Contained Workstreams

Status: **approved for execution** (2026-08-08).

## Why

Stagecraft currently has two useful but incomplete safety boundaries: gate/write policy in
the core, and Git worktree isolation for parallel workstreams. Neither is an operating
system sandbox. A CLI agent can still read credentials, use the network, consume unbounded
resources, or escape a workspace through a symlink. The Docker headless runner packages an
unattended run, but deliberately mounts the project read-write and is not a hostile-code
boundary.

This phase makes that distinction explicit and adds a contained local execution path. It
does not claim that every host is sandboxed, and it does not weaken the invariant that the
core never invokes a model.

## Dependencies

- The run plan and execution fingerprint from Phase 37 follow-through (PR #407).
- Core-managed Git workstream isolation (PR #410). Until that PR lands, implementation may
  be stacked on its branch but must not be described as independently mergeable.
- ADR-014 remains the contract for unattended packaging; this phase adds a separate
  security-boundary decision rather than redefining that runner retroactively.

## Work items

### 38.1 Trust-profile contract and threat-model ADR

Add an ADR defining three profiles:

- `trusted`: existing local execution, with policy/write audit but no OS sandbox claim;
- `contained`: disposable per-workstream runtime, read-only source snapshot, explicit output
  reconciliation, network denied by default, scoped environment, and resource limits;
- `remote`: a transport capability reserved for a later phase, not an alias for contained.

Materialize the selected profile and its provenance in `pipeline/run-plan.json`; bind it to
the execution fingerprint. Configuration must fail closed when a requested profile is not
supported by the resolved host/runner. Document the difference between artifact isolation,
Git workstream isolation, and OS containment.

### 38.2 Containment-provider contract

Define a narrow provider interface around host invocation. The adapter still owns model
invocation; the provider owns process/container creation, mounts, environment, network, and
limits. Capability discovery must report supported trust profiles so planning can reject an
impossible route before dispatch.

The provider contract must carry an allowlisted environment rather than inheriting the
parent process wholesale. Secrets are opt-in by name and never serialized into run plans,
logs, evidence, or prompts.

### 38.3 Disposable local contained workstream

Implement a Docker-backed provider for one isolated workstream:

- immutable project snapshot as the input;
- a writable scratch/output area as the only mutation surface;
- non-root user, dropped capabilities, no-new-privileges, default-deny network;
- CPU, memory, process-count, and wall-clock limits;
- explicit, content-addressed output reconciliation back into the Git worktree;
- teardown on success, failure, signal, or timeout.

Reconciliation must reject absolute paths, `..`, symlink traversal, device files, and writes
outside the declared output set. Conflicts remain visible and recoverable; Stagecraft must
not silently choose a winner.

### 38.4 Policy, CLI, and operator UX

Add configuration and CLI selection with an honest preview in `assess`, `run`, and the run
plan. Diagnostics must say which control is enforced, unsupported, or intentionally absent.
If Docker (or another configured contained provider) is unavailable, `contained` refuses to
run; it never degrades to `trusted` without a new explicit user choice.

### 38.5 Adversarial verification

Add offline structural/unit coverage plus opt-in runtime integration tests for:

- parent-path and symlink escape attempts;
- ambient credential and environment leakage;
- denied network access;
- CPU/memory/process and timeout enforcement;
- output manifest tampering and reconciliation conflicts;
- cleanup after cancellation and provider failure;
- unsupported-profile fail-closed behavior.

Record platform limitations. Windows/macOS Docker Desktop isolation is a VM-backed runtime,
not native process sandboxing; trusted mode remains explicitly unsandboxed.

## Out of scope

Cloud workers, remote secret brokers, Kubernetes, transparent sandboxing for every existing
host, and automatic promotion from `trusted` to `contained`. Those need different trust and
operational decisions.

## Acceptance

A developer can inspect a run plan and know the exact trust boundary before dispatch. A
requested contained run either executes one workstream inside the declared boundary and
reconciles only validated outputs, or fails closed with an actionable diagnostic. No code or
documentation calls the existing trusted CLI path an OS sandbox.

