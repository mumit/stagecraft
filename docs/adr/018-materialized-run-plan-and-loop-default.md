# ADR 018 — Materialized run plan and `loop` as the assessed default

**Status:** Accepted
**Date:** 2026-08-08
**Authors:** Mumit Khan (design), implemented with Codex

## Context

Stagecraft describes `loop` as its day-to-day, minimal-ceremony track, but the
assessment engine never recommended it. An unclassified feature returned `full`
with low confidence, so the documented default was unreachable through the
normal `devteam run --feature ...` path introduced by ADR-016. Users either paid
for all 18 stage slots or had to know enough about Stagecraft to override the
decision manually.

The driver's existing `run-plan` event also exposed only aggregate counts. It
did not persist the ordered stage decision, skip reasons, or candidate routing.
That made three builder questions unnecessarily hard to answer before spending
tokens: what will run, which host/model will run it, and whether a resumed run
is still executing the plan that was originally reviewed.

Safety cannot be recovered merely by making the default heavier. Stagecraft
already has explicit stoplist, migration, security, confidence, budget, and
consequence-ceiling controls. The plan should expose those decisions and the
light default should promote on concrete risk signals.

## Decision

### 1. `assess()` falls back to `loop` for ordinary, unclassified work

The existing precedence remains:

1. explicit `--track`;
2. repair-mode choice;
3. `pipeline/track.json`;
4. `pipeline.custom_stages`;
5. inline assessment when a description exists;
6. configured `pipeline.default_track` for a bare run with no assessment input.

Within assessment, specialized hotfix, dependency, config-only, nano, and quick
signals still win. Explicit iteration language selects `loop` at medium
confidence; otherwise unclassified work selects `loop` at low confidence. The
factory `pipeline.default_track: full` is unchanged for a bare `devteam run`
that provides no feature or description.

`loop` remains guarded by the existing stoplist and confidence policy. Migration
evidence promotes light tracks to `full`. Security evidence now promotes
`loop`, `nano`, and `quick` to `full`; none of those tracks contains the
security-review stage, and a larger generic peer-review panel is not an
equivalent control. The specialized `dep-update` exception remains because
package manifests routinely trigger the security path heuristic, while
`config-only` and `hotfix` already contain security-review.

### 2. Every autonomous run materializes `pipeline/run-plan.json` before dispatch

The versioned `stagecraft.run-plan/v1` artifact contains:

- track, source, confidence, intent, and bounded change id;
- ordered stages with their preflight `included`, `skipped`, or `conditional` disposition;
- deterministic skip reasons and configured roles;
- candidate workstream roles plus resolved host/model routes;
- track-sized base and right-sized expected workstream counts;
- advisory ceremony preview; and
- separate SHA-256 execution and safety-bound plan fingerprints.

The safety policy records the effective dollar/token caps and only a hashed,
audited stoplist-bypass record—never the feature or brief contents. The overall
plan fingerprint binds that policy to the execution fingerprint.

The file is written atomically before the first model dispatch. It is an
inspectable execution contract, not gate evidence: a plan says what Stagecraft
intends to ask for, not that the work passed. `devteam run --plan-only` stops
immediately after that write, so the contract can be read before the run it
governs begins; because it halts after the same build/persist path a real run
uses, the previewed plan is the plan that would execute rather than a parallel
estimate that could drift from it. The halt leaves the ordinary
interrupted-before-first-dispatch state, so `devteam run --resume` executes the
reviewed plan unchanged. Conditional stages stay labelled
conditional until their upstream gate exists, and routes stay labelled
candidate until runtime discovery confirms the workstream. Right-sized skips
are explicitly marked as preflight snapshots and reevaluated when their stage
becomes ready, because earlier build stages can legitimately change their
evidence. Configured stage selection is stable and resume-bound.

### 3. Resume is execution- and safety-bound

A fresh run may replace an older plan in the same pipeline root. `--resume`
instead reads the original artifact and proceeds only when the newly computed
execution fingerprint matches. Configured stage selection, role, host, model,
provenance, or other stable execution drift raises `ERUNPLANDRIFT` and leaves the original plan
unchanged. The operator reviews the changed conditions and starts a fresh run
without `--resume`.

Generated timestamps, run ids, and the advisory ceremony estimate do not affect
the fingerprint. Empirical cost data may improve between invocations without
changing what executes.

Omitted cap flags inherit the original values. Explicit cap or track values
that conflict with the original run fail before dispatch with both values;
resuming cannot raise, lower, add, or remove a cap. A pre-safety run state is
migrated from the explicit cap flags supplied on its first post-upgrade resume,
with a warning when that leaves it uncapped.

`--force` authorizes a stoplist bypass only for a SHA-256 binding of the current
feature input (when supplied), active brief, and stoplist policy. The ruling is
stored in `run-state.json`, bound into `run-plan.json`, and recorded in
`run-log.jsonl`. An unchanged resume or direct remediation stage reuses it;
changing any bound input invalidates it before dispatch. Direct stage commands
also resolve their track from the active run plan before falling back to project
configuration.

## Consequences

- Generic feature work now reaches the documented four-dispatch `loop` path;
  `full` is an explicit audited/risk-driven choice rather than the consequence
  of failing to match a keyword.
- The preflight estimate uses track-aware roles, fixing the prior overcount for
  `loop` build and review stages.
- Builders and tooling can inspect stage, host, and model choices without
  reconstructing configuration or parsing terminal prose.
- Resume becomes safer but stricter: editing routing or stage configuration
  mid-run requires a fresh run rather than silently changing execution.
- Resume no longer loses caps or asks for the same unchanged stoplist ruling;
  intentional policy changes require a fresh run or a newly scoped `--force`.
- The plan can disclose configured provider/model identifiers. It contains no
  prompts, credentials, free-form gate content, or model output, but projects
  should apply their normal repository confidentiality policy before committing
  it.
- Low-confidence inference still warns, and teams may set
  `autonomy.require_confirmed_track: true` to require confirmation. This ADR
  reduces ceremony; it does not weaken the existing authority boundary.

## Alternatives considered

1. **Change the factory `default_track` from `full` to `loop`.** Rejected: a bare
   run has no feature signal to assess, and silently changing existing project
   behavior is less defensible than making feature-driven assessment coherent.
2. **Keep `full` as the assessment fallback and document `loop` as opt-in.**
   Rejected: it preserves the implementation/documentation contradiction and
   makes cost reduction depend on prior framework expertise.
3. **Emit richer telemetry but no file.** Rejected: an append-only log is useful
   after the fact but is a poor preflight review surface and cannot bind resume.
4. **Freeze the entire JSON document byte-for-byte on resume.** Rejected: cost
   estimates are advisory and improve as the empirical corpus grows; only the
   execution decision needs immutability.
