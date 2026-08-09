# 01 — Architecture

## Architectural shape

Stagecraft remains a **model-neutral spine with host adapters**. The durable contract is
the on-disk gate: a host/model writes an artifact and gate JSON; core validates the
gate and makes the next deterministic scheduling decision.

```text
User / automation
  -> bin/devteam
  -> core/cli/commands/<command>.js
  -> config + router + orchestrator/driver
  -> host adapter renders/invokes a workstream
  -> model writes artifact + pipeline/gates/*.json
  -> validator / merge / next
  -> advance, retry, escalate, halt, or complete
```

The autonomous path adds a bounded loop around the same primitives:

```text
devteam run
  -> driver.run()
  -> orchestrator.next()
  -> runStageHeadless() / mergeWorkstreamGates()
  -> classify dispatch and gate outcome
  -> bounded retry / targeted fix / ruling / consequence ceiling
  -> run-state.json + run-log.jsonl
```

## Component inventory

| Component | Entry points | Purpose and dependencies |
|---|---|---|
| CLI registry | `bin/devteam`, `core/cli/flags.js` | Lazy-loads 34 command modules; translates argv to structured flags |
| Stage model | `core/pipeline/stages.js` | Canonical stage definitions, tracks, role assignments, artifacts and gate skeletons |
| Configuration | `core/config.js`, `core/paths.js` | Loads `.devteam/config.yml`, resolves isolation/change paths and routing defaults |
| Routing | `core/router.js` | Resolves first-party or `@devteam/host-*` adapters with stage > role > default precedence |
| Orchestrator | `core/orchestrator.js` | Plans dispatch, renders descriptors, invokes workstreams, merges gates, computes `next()` |
| Autonomous driver | `core/driver.js` | Locks/resumes runs, loops next/dispatch/merge, budgets retries/cost, handles targeted fixes and rulings |
| Gate system | `core/gates/`, schemas | Loads, validates, archives, chains, classifies, backs up, and detects convergence |
| Mechanical verification | `core/verify/`, `core/preflight.js` | Runs configured lint/test/license checks and stamps model claims with observed evidence |
| Guards | `core/guards/`, `core/hooks/` | Stoplist, migration/security heuristics, write audit, secret scan, approval derivation |
| Host adapters | `hosts/*/adapter.js`, `core/adapters/` | Install host surfaces, render prompts, invoke host CLIs, enforce declared capabilities |
| Escalation | `core/escalation.js` | Principal ruling and deterministic ruling-application flow |
| Memory | `core/memory/` | Chunk, embed, store, query, and promote project/org records |
| Specification | `core/spec/` | Gherkin generation and AC/spec/test drift analysis |
| Learning/analytics | `core/advise.js`, `scripts/dashboard.js`, `scripts/performance.js`, `scripts/routing-suggest.js` | Aggregate gates into advice, cost, pass-rate, and routing evidence |
| UI/logging | `core/ui/`, `core/log/journal.js` | Loopback dashboard, SSE updates, and chronological pipeline journal |
| Standards discovery | `core/standards/discover.js`, `core/stage-shopping/assess.js` | Infer project conventions and pipeline track |
| Deployment guidance | `core/deploy/*.md` | Host-neutral procedures consumed by the platform role |

## Dependency graph

The highest fan-in production modules are:

| Module | Internal importers | Architectural role |
|---|---:|---|
| `core/pipeline/stages.js` | 18 | Canonical stage/track registry |
| `core/config.js` | 17 | Project configuration and routing defaults |
| `core/orchestrator.js` | 13 | Shared dispatch/next API |
| `core/paths.js` | 12 | Bounded/in-place path ownership |
| `core/router.js` | 7 | Adapter discovery and resolution |
| `core/gates/load-gate.js` | 7 | Shared gate reads |
| `core/adapters/headless.js` | 6 | Cross-host headless execution |

The scan found no multi-file circular dependency in `core/`. Two apparent self-cycles
were parser artifacts from modules requiring their own optional package name/path and
are not runtime module cycles.

The fan-in distribution is healthy: canonical registries have high fan-in, while leaf
features remain narrow. `core/orchestrator.js` and `core/driver.js` are high-churn and
large, but their responsibilities remain distinct: orchestration is a mostly stateless
pipeline engine; the driver owns run-scoped autonomous state.

## External integrations

| Integration | Used by | Boundary quality |
|---|---|---|
| Claude Code / Codex / Gemini CLI / Omnigent | Host adapters via child processes | Isolated behind adapter contract and shared headless runner or adapter-specific invoke path |
| External `@devteam/host-*` package | Router discovery | Same adapter contract as first-party hosts |
| OpenTelemetry OTLP | `core/observability.js` | Optional; no-op without endpoint; standard environment variables |
| Hugging Face Transformers | `core/memory/embed.js` | Optional dependency; local provider with deterministic test stub |
| Git | commit, preflight, write audit, consistency | Child-process boundary; failures generally surfaced or conservatively degraded |
| GitHub Actions | CI templates and repo workflows | Declarative integration, least-privilege test workflow |
| Cloud/deploy CLIs | Platform-role instructions | Not linked into core; invoked by the model/host under deploy contracts |

The code comments still mention unimplemented OpenAI/Cohere embedding providers as
“planned for v0.3”; this is a documentation/clarity candidate for Phase 1 rather than
an architectural dependency.

## Primary data flows

### User-driven stage

1. CLI command resolves config, track, change ID, and stage definition.
2. Router selects an adapter per `(stage, role)`.
3. Orchestrator builds a host-neutral descriptor with read-first files, write budget,
   artifact target, gate skeleton, tool budget, and optional patch context.
4. Adapter renders a host-specific prompt or invokes its headless CLI.
5. Workstream writes an artifact and gate under `pipeline/` or bounded change root.
6. Validator injects/verifies metadata and enforces stage-specific mechanical rules.
7. Multi-workstream gates merge; `next()` determines the next action.

### Autonomous run

1. Driver acquires `run.lock`, resolves track/intent, and restores or initializes state.
2. Each iteration logs a heartbeat and asks `next()` for an action.
3. Dispatch/merge/fold actions run in-process; retries are classified and bounded.
4. Code defects may clear named gates, route to a file-owning workstream, and require
   an actual blocker-file content change before accepting a targeted retry.
5. Escalations require grants and never cross cannot-decide, convergence, or the
   consequence ceiling automatically.
6. Every transition is appended to `run-log.jsonl`; resumable state is persisted.

### Gate validation and evidence

1. Gate JSON is size-limited and parsed.
2. Base identity plus stage schema are checked.
3. Mechanical policy checks can override model assertions: docs sign-off, deploy cost,
   license/test/lint evidence, red-team blocker propagation, chain verification.
4. PASS/WARN gates can advance; FAIL/ESCALATE produce structured remediation paths.

### Installation

1. `devteam init` writes config and managed gitignore content.
2. Each selected adapter installs host-native commands/agents plus rendered copies of
   canonical roles, rules, and skills.
3. Re-running install skips unchanged files and reports written/skipped counts.

## Configuration surface

Primary project config is `.devteam/config.yml`:

- `routing.default_host`, `routing.roles`, `routing.stages`, `review_fanout`
- `pipeline.default_track`, artifact `isolation`, `workstream_isolation`, `skip_stages`, `verify`, `custom_stages`
- `autonomy.max_retries`, `require_confirmed_track`, and driver options
- `deploy.adapter` plus adapter-specific values

Important environment variables:

- Host/runtime: `DEVTEAM_HEADLESS_COMMAND`, `DEVTEAM_NO_LOG`, `DEVTEAM_LOG_HISTORY`
- Isolation/hooks: `DEVTEAM_CHANGE_ID`, `DEVTEAM_REVIEW_DIR`, `DEVTEAM_GATES_DIR`
- Memory: `DEVTEAM_EMBEDDING_PROVIDER`, `DEVTEAM_EMBEDDING_MODEL`,
  `STAGECRAFT_ORG_MEMORY_DIR`
- Observability: standard `OTEL_*`, plus `DEVTEAM_OTEL_DISABLE`
- Validation/logging: `CI`, `LOG_FORMAT`
- UI: `PORT`, `STAGECRAFT_UI_ALLOW_REMOTE`
- Security hook extension: `DEVTEAM_SECRET_SCAN_ALLOW`

Secrets for deploy hosts remain external to Stagecraft (`GIZMOS_API_KEY`, cloud CLI
credentials). They are referenced by deploy instructions rather than loaded by core.

## Architectural strengths to preserve

1. **Gate JSON is the contract.** Models, hosts, and core can evolve independently.
2. **Core remains model-neutral.** No provider SDK or model invocation leaked inward.
3. **Single sources of truth are increasingly mechanical.** Generated docs and
   consistency checks reduce transcription drift.
4. **Boundaries are testable.** Adapter, gate, routing, stage, and CLI contracts have
   dedicated tests rather than relying only on end-to-end behavior.
5. **Autonomy is bounded and auditable.** Retry, ruling, budget, scope, write, and
   consequence policies are explicit code paths with on-disk evidence.
6. **Optional integrations degrade cleanly.** OTel and embeddings are opt-in; tests can
   remain offline.

## Architecture questions for later phases

- Are the large driver/orchestrator functions still locally comprehensible and fully
  covered, or has velocity created hidden coupling around retry and state transitions?
- Does config documentation enumerate fields that the driver consumes outside
  `core/config.js` defaults?
- Are all outward-facing child processes using structured argv, timeout discipline,
  and portable termination after the Windows work?
- Are “planned” provider/error strings stale enough to confuse users or tests?

## Project-specific extensions

No `docs/audit-extensions.md` file is present.
