# Stagecraft Pipeline Speed Opportunities

**Status:** Analysis background. Actionable follow-up now lives in
[`phase-26-performance-observability-usability.md`](phase-26-performance-observability-usability.md);
no implementation authorized from this file alone.
**Date:** 2026-06-21
**Goal:** reduce wall-clock time from `devteam run` start to a safely deployable change,
without weakening Stagecraft's gate, audit, verification, authority, or multi-host
contracts.

## Executive recommendation

The largest safe gains are not in making Node code faster. Stagecraft's control-plane
work is small compared with model inference, project tests, and human pauses. The best
sequence is:

1. measure the actual critical path and telemetry coverage;
2. select the smallest safe track and suppress irrelevant workstreams automatically;
3. eliminate duplicate verification and run independent test suites concurrently;
4. replace no-judgment LLM work with deterministic code and conditionally skip
   inapplicable audits;
5. execute independent review and post-QA stages as parallel waves;
6. reduce repeated prompt/context loading and route latency-sensitive roles using real
   evidence;
7. use remote workers or persistent sessions only after the local critical path is lean.

The highest structural ceiling is the linear stage model. A worst-case `full` run has 18
LLM-dispatched stages and 25 base workstreams. Workstreams inside one stage already run
concurrently, but stages remain sequential. Converting two independent stage regions into
parallel waves reduces the worst-case full-track model path from 18 serial stage slots to
approximately 13 without removing a gate.

## What “faster” means

Track four distinct measures:

| Measure | Start → finish | Why it matters |
|---|---|---|
| Time to first actionable failure | run start → first blocking result | Shortens feedback loops and wasted downstream work. |
| Time to safe sign-off | run start → all pre-sign-off gates complete | Measures engineering throughput without deploy latency. |
| Time to safe deploy | run start → stage-08 PASS | Primary delivery measure. |
| Time to documentary close | run start → retrospective PASS | Includes learning/audit closure after delivery. |

Optimization must report p50 and p95, not only averages. It must also report first-try
pass rate, retries, cost, token use, and escaped defects; a “faster” path that causes more
retries or weaker outcomes is slower in practice.

## Current critical-path facts

These findings are derived from the current implementation rather than assumptions:

- [`runStageHeadless`](../core/orchestrator.js) invokes all workstreams in a stage through
  `Promise.all`. Build, peer-review, and sign-off are already internally parallel.
- The tracks in [`stages.js`](../core/pipeline/stages.js) contain the following maximum
  stage/workstream counts. Conditional stages may reduce actual dispatches.

| Track | Sequential stage slots | Base workstreams |
|---|---:|---:|
| `full` | 18 | 25 |
| `quick` | 10 | 17 |
| `nano` | 3 | 6 after nano's single-reviewer sizing |
| `config-only` | 7 | 11 |
| `dep-update` | 5 | 12 |
| `hotfix` | 13 | 20 |

- `pipeline.default_track` is `full`. The operator can run `devteam assess`, but track
  assessment is a separate step and full remains the conservative fallback.
- Stage 01 can already suppress irrelevant build/review workstreams through
  `active_roles`; this is useful but depends on the PM gate being accurate.
- Stage 04a and Stage 06 both run orchestrator-stamped tests. Build and QA agents may
  also run tests inside their model sessions. Repair-mode stage 03b can add another test
  execution. The same unchanged tree can therefore be verified repeatedly.
- [`runTestCommands`](../core/verify/runner.js) runs discovered Node, Python, and Go suites
  sequentially. Its wall time is the sum rather than the maximum of independent suites.
- Per-dispatch framework context is already measured in
  [`prompt-budget.md`](../docs/reference/prompt-budget.md): approximately 3,700–6,600
  tokens before project artifacts are read. A full run pays that repeated framework
  loading across many workstreams.
- Duration telemetry exists, but gate reporting is optional and the existing performance
  scorer optimizes first-try pass rate with cost as a tiebreaker, not end-to-end latency.
- The autonomous driver has a fixed 30-second default transient retry delay and waits for
  a dispatch to resolve before classifying it. Stall response remains correctly
  evidence-gated.
- Workstream fan-out is unbounded at the orchestrator layer. A 12-way multi-model review
  can hit provider concurrency/rate limits and become slower through throttling/retries.

## Ranked opportunity matrix

Impact is expected wall-clock leverage after the measurement phase. Estimates are
directional until real-run baselines exist.

| Rank | Opportunity | Expected leverage | Effort | Risk |
|---:|---|---|---|---|
| 1 | Parallel review and audit waves | Very high on `full`/`hotfix` | High | High: stage-order contract/ADR |
| 2 | Verification receipts and test-suite concurrency | High on test-heavy projects | Medium | Medium |
| 3 | Automatic safe track/workstream right-sizing | High across normal feature volume | Medium | Medium |
| 4 | Deterministic and conditional stage execution | High on changes with narrow surfaces | High | Medium–high |
| 5 | Prompt/context slimming and delta handoffs | Medium–high; also reduces cost/overflow | Medium | Medium |
| 6 | Retry narrowing and early failure | Medium–high on imperfect runs | Medium | Medium |
| 7 | Per-host concurrency control | Medium; high with fanout/rate limits | Medium | Low–medium |
| 8 | Latency-aware host/model routing | Medium after evidence accumulates | Medium | Evidence-gated |
| 9 | Up-front authority and unattended operation | Medium in elapsed operator time | Low | Authority-sensitive |
| 10 | Persistent host sessions/provider prompt caching | Medium, host-dependent | High | Context contamination |
| 11 | Cloud runners | Medium locally; high for long/parallel work | High | High: transport/security |
| 12 | Node control-plane micro-optimization | Low | Low | Low |

## Opportunities in detail

### 1. Add critical-path measurement before changing scheduling

Current reports expose stage/workstream duration when gates contain it, but Stagecraft
does not yet provide a trustworthy end-to-end critical-path analysis with missing-data
coverage.

Add a `devteam performance critical-path` report derived primarily from orchestrator
timestamps and run-log events, not model self-report. It should show:

- queue, model, verification, merge, retry-delay, and human-halt time separately;
- stage elapsed time versus sum of workstream compute time;
- the longest workstream in each parallel stage;
- repeated verification commands keyed by workspace digest;
- prompt bytes/tokens when the host exposes them;
- missing telemetry percentage and clock source;
- projected savings for “sum to max” wave/test parallelization.

This is an enabling item, not bureaucracy. Without it, optimization will chase visible
stages rather than the real p95 bottleneck.

**Acceptance signal:** at least five real runs from two projects have ≥90% orchestrator
duration coverage and identify a reproducible top-three critical-path breakdown.

### 2. Right-size the track and workstreams automatically

The fastest stage is one that is proven unnecessary. Existing tracks and `active_roles`
already provide the safe primitives; the opportunity is making them reliable and easy.

- Run deterministic assessment at `devteam run` startup when no explicit/confirmed track
  exists, instead of silently falling back to `full` after only a warning.
- Auto-proceed only for a high-confidence recommendation. Medium/low confidence remains a
  judgment halt when configured, or uses `full`.
- Derive candidate active roles from changed paths, design file ownership, and brief
  scope; require Stage 01 to confirm the derived set rather than invent it from scratch.
- Reassess before build if the design expands scope. A widened scope may move upward to a
  deeper track but never silently downward.
- Surface expected stage/workstream count before dispatch so operators understand the
  time/rigour choice.

Do not make `quick` the unconditional default. Automating the current stoplist and
confidence contract preserves safety while avoiding full-track work for routine changes.

**Potential:** choosing `quick` instead of `full` removes up to eight serial stage slots;
`nano` removes more for genuinely mechanical work.

### 3. Deduplicate verification with content-addressed receipts

Create an orchestrator-owned verification receipt keyed by:

- normalized command and suite ID;
- workspace content digest for relevant source/test files;
- dependency lockfile and runtime/toolchain fingerprints;
- material environment/config inputs;
- Stagecraft verification-runner version.

A later stamp may reuse a successful receipt only when the full key is unchanged. The
gate records the receipt digest, original execution time, and reuse decision. Any source,
test, dependency, command, or environment change invalidates it.

Applications:

- reuse Stage 04a results at Stage 06 when QA wrote only the report/gate;
- force rerun when QA added or modified tests;
- stop build agents from each running an identical full suite—give them targeted checks
  and let the orchestrator own the full receipt;
- reuse lint/license results across adjacent read-only review stages;
- in repair mode, retain distinct red-before and green-after receipts so caching cannot
  erase the reproduction proof.

Receipts must never be accepted from the model. They are minted by the orchestrator and
bound to file bytes.

### 4. Run independent test suites concurrently, with resource controls

Node, Python, and Go test commands currently run in a sequential loop. Add bounded
parallel execution:

```yaml
pipeline:
  verify:
    suite_concurrency: 2
    exclusive_suites: [browser-e2e]
```

- Default conservatively based on CPU/memory availability or to `1` until enabled.
- Keep output deterministic by collecting per-suite streams and rendering in suite order.
- Allow suites that contend for ports, databases, browsers, or global fixtures to declare
  exclusivity/resource groups.
- Preserve per-suite timeout and cancellation; aggregate failure remains pessimistic.

For three independent suites of similar duration, the theoretical verification wall time
moves from their sum toward their maximum. This is often a larger win than any model-side
change.

### 5. Replace no-judgment LLM work with deterministic code

Several stages combine mechanical checks with judgment. Run the mechanical portion first
and dispatch a model only when interpretation or remediation is needed.

- **Clarification:** mechanically scan the brief/design for unresolved question markers,
  missing decisions, and schema gaps. Produce a PASS skip record when no question exists;
  dispatch PM only when there is something to resolve.
- **Executable spec:** generate the AC scaffold before dispatch. If the mapping is complete
  and unambiguous, let deterministic verification mint the gate; dispatch PM only for
  ambiguous criteria or drift.
- **Pre-review:** lint, tests, license scan, git hygiene, trigger detection, and imports are
  code-owned checks. Dispatch Platform only for dependency-risk judgment, conflicting
  evidence, or a generated failure summary.
- **Accessibility/performance:** run configured tools first. Dispatch QA only to interpret
  violations, missing coverage, or unavailable tooling.
- **Sign-off preparation:** mechanically assemble the runbook skeleton and gate summary;
  PM/Platform review the delta rather than generating boilerplate.

Every deterministic skip must leave an explicit, validator-owned audit record naming the
rule and inputs. Absence of an LLM dispatch must never look like an omitted gate.

### 6. Make expensive audits conditionally applicable

Some agents already spend a full dispatch deciding that their audit has no relevant
surface. Move that decision into conservative, testable triggers:

- accessibility only for UI/component/template/style changes or explicit accessibility
  acceptance criteria;
- performance only when a configured budget exists or changes affect runtime/bundle/query
  paths;
- observability only when the brief/design promises signals or changes production
  behavior/integrations;
- migration safety already follows this pattern;
- verification-beyond-tests only when critical invariants/candidates exist, while `full`
  retains a deterministic candidate-inventory record.

False negatives are the primary risk. Triggers should combine changed paths, brief/design
fields, and explicit operator policy, with `force_stages` as an override. New trigger
classes require fixtures and an escape hatch; they must not rely only on keyword matching.

### 7. Introduce DAG-backed parallel stage waves

The ordered-stage table is load-bearing, so this requires an ADR and compatibility plan.
Keep stable stage IDs and gate files, but add dependency metadata and schedule ready nodes
as waves.

Candidate wave after Stage 04a:

```text
pre-review ─┬─ security-review (conditional) ─┐
            ├─ red-team ───────────────────────┼─ peer-review
            └─ migration-safety (conditional) ┘
```

Candidate wave after Stage 06:

```text
qa ─┬─ accessibility-audit ───────┐
    ├─ observability-gate ─────────┤
    ├─ verification-beyond-tests ──┼─ sign-off
    └─ performance-budget ─────────┘
```

Current red-team input lists security-review, so its true dependency must be decided. The
preferred speed shape is for red-team, security, and migration to inspect the same
post-pre-review snapshot independently, then let peer-review consume all results. If
security findings are intentionally inputs to red-team, keep that edge and accept less
parallelism.

Requirements:

- `next()` remains deterministic and returns a ready set without changing gate identity;
- writes in a wave are disjoint or serialized through existing marker/gate ownership;
- failure in one node prevents dependents but does not discard useful sibling results;
- restart/invalidation clears every transitive dependent gate;
- consequence ceilings remain attached to stages, not wave boundaries;
- `ORDERED_STAGE_NAMES` remains a presentation/topological order for compatibility.

Worst-case full-track serial slots fall from 18 to roughly 13 if both waves are fully
independent. Actual savings equal the sum of sibling durations minus the slowest sibling,
which the critical-path report should calculate before implementation.

### 8. Slim prompts and pass delta-focused context

Framework context alone costs roughly 3.7k–6.6k estimated tokens per dispatch, excluding
project artifacts. Reduce both inference latency and context-overflow retries:

- split role briefs into a compact always-loaded contract plus task-specific sections;
- compile a stage/role packet containing only applicable rules rather than directing every
  dispatch to broad shared prose;
- replace broad `pipeline/pr-*.md` reads with the active workstream files where possible;
- pass changed-file/diff manifests and artifact digests so agents can read on demand;
- auto-compact regenerated marker sections in `pipeline/context.md` between stages while
  preserving human-authored context;
- generate bounded handoff summaries, but retain links/digests to full artifacts so a
  model can inspect evidence when needed;
- use provider prompt caching when the host exposes a verifiable cache boundary.

Measure quality and retry rate alongside tokens. Compact context that makes agents reread
or miss requirements is a regression.

### 9. Narrow retries and surface failures earlier

Stagecraft already supports targeted fix dispatch and `--skip-completed`. Extend the same
precision:

- map each blocker to an owning workstream using design `file_ownership` and structured
  provenance, not text heuristics;
- redispatch only invalidated workstreams and reviewers whose inputs changed;
- retain unaffected parallel-wave gates when their input digests remain valid;
- emit deterministic failures before model dispatch for missing tools, invalid config,
  oversized context, unavailable auth, and impossible capabilities;
- allow independent workstreams to finish, but notify the operator immediately when a
  sibling fails instead of waiting silently for the slowest sibling;
- make transient backoff provider/error aware rather than always paying 30 seconds.

Do not add aggressive stall termination before ADR-007's evidence gate opens. A progress
notification and a kill/retry policy are different decisions.

### 10. Add per-host concurrency and rate-limit scheduling

`Promise.all` is optimal only when every provider accepts the full burst. Add a lightweight
host scheduler with:

- configurable maximum concurrent invocations per host/profile;
- separate limits for expensive review fanout;
- `Retry-After`/rate-limit-aware queueing where adapters expose it;
- fair scheduling across workstreams;
- queue-time telemetry;
- no global serialization across independent hosts.

The objective is minimum completion time, not maximum instantaneous concurrency. This
also makes a cloud-runner adapter useful without allowing it to flood a worker pool.

### 11. Route for latency as well as quality and cost

The performance data already records mean duration, but routing suggestions prioritize
first-try pass rate and use cost only as a tiebreaker. When real evidence thresholds are
met, add an explicit policy:

```yaml
routing_policy:
  objective: balanced       # quality | latency | cost | balanced
  max_pass_rate_regression_pp: 0
  latency_weight: 0.3
```

Use p50/p95 duration, first-try pass rate, retry-adjusted completion time, and cost per
successful pass. Never choose a faster host by accepting a quality regression outside
policy. Continuous application remains gated under D5; a read-only latency recommendation
can be evaluated earlier.

### 12. Reduce operator idle time without weakening authority

Existing controls already support faster unattended progress:

- grant `--allow-stage sign-off --allow-stage deploy` at launch only when the operator has
  deliberately pre-authorized those consequences;
- use `--auto-rule` only for reviewed, bounded ruling classes;
- use `--until` to stop at the desired review boundary instead of babysitting earlier
  stages;
- use `--watch` for visibility without polling manually;
- persist an operator-approved run profile so safe CLI options are not repeatedly typed,
  but do not implement standing authority until ADR-005's evidence threshold is met.

This reduces calendar time and handoff latency, not compute time. It must remain visibly
separate from model autonomy.

### 13. Persistent sessions and provider-side prompt caching

Every workstream currently starts a headless host invocation. Reusing a process/session
could remove startup and repeated-prefix costs, especially for sequential stages assigned
to the same role/host.

Risks are substantial: stale context, cross-workstream leakage, unbounded history,
non-reproducible prompts, and unclear timeout/cancellation semantics. Start with
provider-supported immutable prompt caching or a process pool that still creates a fresh
logical session. Do not reuse conversational state across roles by default.

### 14. Remote execution and elastic capacity

The proposed [Phase 21 cloud-runner plan](phase-21-cloud-runner-adapter.md) helps when
local CPU, network stability, or provider concurrency is the bottleneck. It enables
long-running audits and parallel workers but adds bundle, queue, download, and result
application latency.

Remote execution should follow local critical-path cleanup. Otherwise it merely runs
duplicate tests and unnecessary stages on more expensive infrastructure. Evaluate it
using queue wait plus execution time, not execution time alone.

### 15. Move non-delivery closure off the deploy critical path

Retrospective is valuable, but a deployed change and a fully closed learning record are
different milestones. Consider emitting `pipeline-deployed` after Stage 08 and scheduling
Stage 09 immediately as required closure work. The pipeline becomes `pipeline-complete`
only after Stage 09 still passes.

This does not reduce time to documentary close, but it makes time to safe deploy honest
and prevents downstream systems from waiting for prose that does not affect deployment.
If lessons are required before the next run, enforce that dependency at the next run's
start.

### 16. Keep control-plane optimization proportional

Config caching, synchronous small-file reads, gate merge, schema validation, and CLI
startup are unlikely to dominate a pipeline containing model calls and test suites.
Profile before changing them. Reasonable low-risk cleanup includes:

- avoid rescanning unchanged gate directories within one driver iteration;
- parse config once per run and invalidate deliberately;
- use incremental hashes for large write-audit snapshots;
- avoid capturing unbounded verifier stdout/stderr in memory;
- batch filesystem metadata reads when very large repositories prove it necessary.

Treat these as reliability improvements unless measurement shows meaningful wall time.

## Recommended implementation roadmap

### Phase S0 — Baseline and operator-only gains

1. Add the critical-path report and telemetry coverage score.
2. Collect at least five runs across two projects.
3. Document use of `assess`, explicit tracks, active roles, up-front grants, and `--until`.
4. Record baseline p50/p95 time-to-failure, sign-off, deploy, and close.

**Gate:** do not claim a speed improvement without comparative real-run data.

### Phase S1 — Verification efficiency

1. Add bounded polyglot suite concurrency with resource groups.
2. Add content-addressed verification receipts.
3. Teach agents to run targeted workstream checks; retain orchestrator-owned full checks.
4. Bound verifier output memory while preserving durable logs.

**Gate:** identical failure detection and stamp truth on cached/non-cached paths.

### Phase S2 — Right-sizing and deterministic skips

1. Integrate high-confidence assessment at run start.
2. Derive and confirm active workstreams.
3. Mechanize clarification/spec/pre-review fast paths.
4. Add conservative applicability triggers for a11y, performance, observability, and
   advanced verification.

**Gate:** seeded relevant changes always activate their required stages; every skip is
auditable and overrideable.

### Phase S3 — DAG scheduler

1. Write an ADR for dependency metadata and ready-set semantics.
2. Implement the post-pre-review wave.
3. Implement the post-QA wave.
4. Prove restart, invalidation, merging, and consequence ceilings under parallel failure.

**Gate:** no gate-identity/schema change and no lost sibling result under failure.

### Phase S4 — Context, routing, and capacity

1. Slim the heaviest role/stage packets with quality evals.
2. Add per-host concurrency controls.
3. Evaluate latency-aware routing after evidence thresholds.
4. Pilot cloud runners and provider prompt caching.

**Gate:** lower p95 completion time with unchanged or improved first-try pass rate.

## Experiments to run first

| Experiment | Control | Treatment | Decision criterion |
|---|---|---|---|
| Track right-sizing | full | assessed track | ≥25% lower p50 deploy time; no stoplist escape or quality regression |
| Test concurrency | suites serial | concurrency 2 | lower p95 verification time; no flaky/port-contention increase |
| Verification receipt | always rerun | digest-bound reuse | saved full-suite runs with zero stale acceptance |
| Audit wave simulation | sum recorded durations | max sibling duration | projected ≥15% full-track critical-path reduction |
| Prompt slimming | current packet | compact packet | ≥20% fewer input tokens; equal first-try pass and blocker recall |
| Host concurrency | unbounded burst | per-host cap | fewer throttles/retries and lower stage p95 |

Use replayed fixtures for determinism checks, but use real project runs for latency claims.
Model/provider variance requires paired runs where practical.

## Guardrails: speedups Stagecraft should reject

- Removing gate validation, authenticated-chain checks, write audits, or stoplist checks.
- Trusting a model's “tests passed” assertion instead of an orchestrator stamp.
- Skipping security/migration work solely because a model says it is irrelevant.
- Reusing verification after source, tests, dependencies, commands, or environment changed.
- Auto-selecting a lighter track at medium/low confidence.
- Unlimited parallel fanout that increases provider throttling or local resource failure.
- Sharing mutable model sessions across roles or projects.
- Active stall kill/retry before the existing evidence gate opens.
- Crossing sign-off/deploy consequence ceilings implicitly.
- Reporting “pipeline complete” before required retrospective/learning closure.

## Definition of success

After implementation, Stagecraft should demonstrate on at least two real projects:

- ≥30% lower p50 time to safe deploy on eligible `full`/`quick` runs;
- ≥20% lower p95 time without an increase in timeout/transient-retry rate;
- unchanged or better first-try gate pass rate;
- no reduction in required-stage activation for seeded security, migration,
  accessibility, observability, or performance cases;
- zero stale verification-receipt acceptances;
- lower or equal tokens and cost per successful pipeline;
- complete gate, authority, and audit history equivalent to the current contract.

The targets are hypotheses, not promises. Phase S0 establishes whether they are realistic
and which opportunity should move first.
