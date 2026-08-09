# ADR-020: Execution trust profiles and contained workstreams

**Status:** Accepted (2026-08-08)

## Context

Stagecraft has three different boundaries that were easy to conflate:

1. artifact isolation (`pipeline.isolation`) chooses where durable pipeline state lives;
2. Git workstream isolation (ADR-019) gives concurrent roles disposable working copies and
   validates what is reconciled;
3. operating-system containment controls what the invoked process can access.

The first two do not stop a same-user CLI agent reading credentials, using the network, or
consuming host resources. The Docker headless runner in ADR-014 packages an entire run and
mounts the project read-write; it is not this boundary.

## Decision

Every run has a fingerprinted execution trust profile:

- `trusted` is the existing path. Gate policy and write audit still apply, but Stagecraft
  explicitly reports that the process is not OS-sandboxed.
- `contained` runs every workstream from an ADR-019 disposable Git worktree and wraps the
  adapter-owned command in a Docker runtime. The container is non-root, read-only except
  for the disposable worktree and bounded tmpfs, drops capabilities, enables
  no-new-privileges, limits CPU/memory/processes/time, denies network by default, and
  receives only explicitly allowlisted environment names. Reconciliation remains the
  allowlisted, conflict-aware ADR-019 path.
- `remote` is reserved for a later transport-backed worker. Selecting it fails until that
  contract exists.

`contained` requires an explicitly configured image containing the routed host CLI. It
fails if Docker or the image policy is unavailable and never falls back to `trusted`.
Commercial CLI agents generally require API egress; an operator may explicitly choose
Docker `bridge` networking, but Stagecraft reports that broader policy rather than calling
it network-isolated.

The core still never invokes a model. It asks the adapter to invoke; the shared adapter
process helper applies the selected provider boundary around that adapter-owned command.

## Consequences

- The run plan can be reviewed before dispatch and resume rejects profile/policy drift.
- Secrets are passed by explicit environment name at runtime; values, image names, and
  registry details are omitted from durable plans and logs. A hash of the image reference
  binds resume to that choice without disclosing it.
- A contained image is an operator-supplied runtime dependency. The first-party runner
  image does not pretend to contain every third-party host CLI.
- Docker Desktop adds a VM boundary on macOS/Windows; Linux uses the Docker daemon's native
  container boundary. Neither makes an explicitly network-enabled agent harmless.
