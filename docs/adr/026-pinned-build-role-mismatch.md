# ADR 026 — A pinned build role that does not match the change is reported, not silently used

**Status:** Accepted
**Date:** 2026-08-22
**Authors:** Stagecraft maintainers

## Context

Three tracks pin their build stage to a single role rather than deriving it from
the change: `loop` since 29.1 (`loopBuildRole(config)`, default `backend`,
overridable via `pipeline.loop_build_role`), and `nano` and `refactor` since
[ADR-025](025-scope-build-not-just-review.md), which derives their build role
from `PEER_REVIEW_SIZING`.

That pin is what makes those tracks cheap and predictable: exactly one build
workstream, whatever the change looks like. It is also blind. `loopBuildRole`
and `PEER_REVIEW_SIZING` are both static — neither consults what actually
changed — so a change in an area the pinned role does not own is built and
reviewed by the wrong specialist.

Measured on a repository with one frontend file dirty:

| Track | Discovered roles | Build dispatches |
|---|---|---|
| `loop` | `["frontend"]` | **`["backend"]`** |
| `nano` | `["frontend"]` | **`["backend"]`** |
| `refactor` | `["frontend"]` | **`["backend"]`** |
| `quick` | `["frontend"]` | `["frontend"]` |
| `full` | `["frontend"]` | `["frontend"]` |

The unpinned tracks route the work to the specialist who owns it. The pinned
ones hand a frontend change to an agent loaded with `roles/backend.md` — a
different brief, different conventions, and a different `allowedWrites` surface
— and then have that same backend role review it. The reviewed area matches the
built area, as ADR-025 requires, but neither matches the change.

**ADR-025 widened this.** Before it, one track was affected; after it, three
are. That is a real cost of that decision and it was not named there.

Until [#472] the situation was worse than invisible: the run plan reported
`build -> []` for exactly this case, because the plan preview filtered the
pinned role out while the runtime kept it. The plan now shows `["backend"]`
against a discovered `["frontend"]`, which is what made this decidable — the
mismatch is legible in the contract rather than inferable from source.

## Decision

**Report the mismatch; do not silently proceed, and do not change the pin.**

This follows [ADR-006](006-track-confidence.md)'s existing shape for a
preflight condition the operator may legitimately intend:

1. **Default: warn once.** stderr, plus a `build-role-mismatch` event in
   `run-log.jsonl` and through `onEvent`, naming the pinned role, the discovered
   roles, and the two ways to fix it.
2. **`autonomy.require_matching_build_role: true`: halt** before the first
   dispatch, with `halt_action: "build-role-mismatch"`.
3. **`--force` bypasses**, and the bypass is logged.

A mismatch is defined narrowly, so the warning means something when it fires:
the track's build resolves to exactly **one** role, discovery found at least one
**build workstream** role (`backend`, `frontend`, `platform`, `qa` — the
`documentation` role is excluded, it has its own scoping path), and the pinned
role is not among them. A clean tree discovers nothing and never warns, which
matters because that is the ordinary state at preflight for a new feature.

The fix the message points at is one of two things the operator already has:
set `pipeline.loop_build_role` to the area they are working in, or choose a
track that derives its build matrix from the change.

## Consequences

**The cheap tracks stay cheap.** No dispatch count changes. `loop` is still 4
workstreams and `nano` still 3; this ADR adds a check, not a workstream.

**A silent wrong-brief dispatch becomes a loud one.** The failure this prevents
is not a crash — it is a frontend change built by an agent reading backend
conventions, which produces work that passes its gates and is wrong in ways the
gates do not measure.

**Warning by default is a deliberate under-reaction.** Halting would be more
protective and would also break every existing project that runs `loop` against
a frontend change today, without warning them first. The escalation flag exists
so a project that wants the stricter behavior can opt in, exactly as
`require_confirmed_track` does. If evidence later shows operators routinely
ignore the warning, flipping the default is a one-line change and a new ADR.

**`loop_build_role` becomes more visible.** The knob has existed since 29.1 and
is barely mentioned; the warning names it at the moment it is relevant.

## Alternatives considered

**Derive the pinned role from the change.** Rejected here, and it is the obvious
alternative. It would route correctly with no operator action — but `loop`'s
contract is "exactly one build workstream, predictably", and deriving the role
from discovery means a change touching two areas either dispatches two (breaking
the cost guarantee) or picks one arbitrarily (the same wrong-brief problem, now
non-deterministic). Worth revisiting as its own ADR with dispatch-count evidence
from real runs; it should not ride along with a warning.

**Halt by default.** Rejected as a breaking change to shipped behavior, not on
principle. The flag makes it available now and the default can move later.

**Warn only for `loop`.** Rejected. `nano` and `refactor` acquired the same pin
in ADR-025 and have the same exposure; scoping the warning to the oldest of the
three would be arbitrary.

**Report it only in the run plan.** Rejected as insufficient. #472 already puts
the mismatch in `run-plan.json`, and that is what made this ADR possible — but a
field in a JSON file nobody is required to read is not a report. The operator
running a pipeline sees stderr.
