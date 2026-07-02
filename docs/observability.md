# Observability

Stagecraft emits [OpenTelemetry](https://opentelemetry.io) spans for every pipeline operation. Any OTLP/HTTP-compatible backend works: Jaeger, Tempo, Honeycomb, Datadog, New Relic, and others.

- [Quick start](#quick-start)
- [Local Jaeger in 30 seconds](#local-jaeger-in-30-seconds)
- [Environment variables](#environment-variables)
- [What gets traced](#what-gets-traced)
- [What's NOT traced (yet)](#whats-not-traced-yet)
- [Pipeline log JSON](#pipeline-log-json)
- [Next roadmap](#next-roadmap)
- [Backend-specific cookbooks](#backend-specific-cookbooks)
- [Testing your instrumentation](#testing-your-instrumentation)
- [Cost / overhead](#cost--overhead)

## Quick start

Tracing is **opt-in**. With no environment variables set, the orchestrator uses OTel's no-op tracer with zero runtime overhead.

To enable tracing, set the standard OTel endpoint:

```bash
export OTEL_EXPORTER_OTLP_ENDPOINT=http://localhost:4318
devteam stage build
```

The OTLP HTTP exporter ships spans to that endpoint.

## Local Jaeger in 30 seconds

```bash
docker run --rm -d --name jaeger \
  -p 16686:16686 \
  -p 4318:4318 \
  jaegertracing/all-in-one:latest

export OTEL_EXPORTER_OTLP_ENDPOINT=http://localhost:4318
devteam stage requirements --feature "test"
# → open http://localhost:16686, search service "devteam"
```

## Environment variables

All standard [OTel env vars](https://opentelemetry.io/docs/specs/otel/configuration/sdk-environment-variables/) work. The ones you'll typically set:

| Variable | Default | Purpose |
|---|---|---|
| `OTEL_EXPORTER_OTLP_ENDPOINT` | (unset → no tracing) | Where to ship spans. e.g. `http://localhost:4318` for local Jaeger, `https://api.honeycomb.io` for Honeycomb. |
| `OTEL_EXPORTER_OTLP_TRACES_ENDPOINT` | (unset) | Trace-specific override of the above. |
| `OTEL_EXPORTER_OTLP_HEADERS` | (unset) | Auth headers, e.g. `x-honeycomb-team=YOUR_KEY` |
| `OTEL_SERVICE_NAME` | `devteam` | Service name shown in your tracing UI. |
| `OTEL_RESOURCE_ATTRIBUTES` | (unset) | Comma-separated `k=v` pairs, e.g. `deployment.environment=staging,team=infra` |
| `DEVTEAM_OTEL_DISABLE` | `0` | Force-disable even if the endpoint is set. Useful in tests. |

## What gets traced

The orchestrator emits spans for every significant operation. A `devteam stage build` run for a multi-role stage produces:

```
pipeline.stage                   stage="stage-04" track="full" workstream_count=4
├── pipeline.workstream          role="backend" workstream.id="stage-04.backend"
│   └── adapter.renderStagePrompt   host="codex"
├── pipeline.workstream          role="frontend" workstream.id="stage-04.frontend"
│   └── adapter.renderStagePrompt   host="claude-code"
├── pipeline.workstream          role="platform" workstream.id="stage-04.platform"
│   └── adapter.renderStagePrompt   host="claude-code"
└── pipeline.workstream          role="qa" workstream.id="stage-04.qa"
    └── adapter.renderStagePrompt   host="claude-code"
```

Other spans:

| Span name | When | Key attributes |
|---|---|---|
| `pipeline.stage` | Every `devteam stage <name>` | `devteam.stage`, `devteam.stage.name`, `devteam.track`, `devteam.workstream_count`, `devteam.feature` |
| `pipeline.stage.headless` | Every `devteam stage <name> --headless` | Same as above + per-workstream `adapter.invoke` children |
| `pipeline.workstream` | Each role within a multi-role stage (or once for single-role) | `devteam.workstream.role`, `devteam.host`, `devteam.workstream.id` |
| `adapter.renderStagePrompt` | When the orchestrator asks an adapter to render the prompt | `devteam.host`, `devteam.workstream.role` |
| `adapter.invoke` | Headless host-CLI invocation | `devteam.host`, `devteam.workstream.role`, `devteam.invoke.exit_code`, `devteam.invoke.duration_ms`, `devteam.invoke.gate_written` |
| `pipeline.merge` | `devteam merge <stage>` | `devteam.stage`, `devteam.merge.result` (`merged` or `missing`), `devteam.merge.status`, `devteam.merge.blockers_count`, `devteam.merge.warnings_count` |
| `pipeline.next` | `devteam next` | `devteam.track`, `devteam.next.action`, `devteam.next.stage`, `devteam.next.name` |

Exceptions are captured automatically. If anything throws, the span gets `status=ERROR` and the exception is recorded as a span event.

## What's NOT traced (yet)

- **The validator** (`core/gates/validator.js`) — runs as a short-lived child process and calls `process.exit()` on every branch. Tracing it cleanly requires a refactor. The orchestrator traces validate calls it makes itself via the `pipeline.next` and `pipeline.merge` spans.
- **The approval-derivation hook** — same situation; spawned by Claude Code's PostToolUse hook, exits immediately.
- **LLM calls themselves** — Stagecraft does not make these. The host (Claude Code, Codex) does, and their tracing surface is their own. Stagecraft observes what they wrote to gate files.

These spans are consumed by the shipped analytics tools — see `scripts/dashboard.js` (`--view cost`, `--view performance`) and `scripts/routing-suggest.js`.

## Pipeline log JSON

`devteam log --json` emits newline-delimited JSON (NDJSON): one event object per line, ordered by event mtime. This is intended for lightweight dashboards and shell pipelines that do not need full OpenTelemetry ingestion.

Every event has these fields:

| Field | Type | Description |
|---|---|---|
| `ts` | string | Event mtime as an ISO-8601 timestamp. |
| `kind` | string | Event type: `gate` or `artifact`. |
| `path` | string | Project-relative path with `/` separators. |

Gate events add:

| Field | Type | Description |
|---|---|---|
| `stage` | string | Gate `stage` field, for example `stage-04`. |
| `workstream` | string or null | Gate `workstream` field when present. Stage-level merged gates may omit it. |
| `status` | string | Gate status such as `PASS`, `WARN`, `FAIL`, or `ESCALATE`. |

Artifact events add:

| Field | Type | Description |
|---|---|---|
| `owner` | string or null | Inferred owner role, when known. |
| `artifactKind` | string | Artifact category, for example `brief`, `pr`, `review`, or `adr`. |

Example:

```json
{"ts":"2026-06-02T10:00:00.000Z","kind":"gate","path":"pipeline/gates/stage-01.json","stage":"stage-01","workstream":"pm","status":"PASS"}
{"ts":"2026-06-02T10:01:00.000Z","kind":"artifact","path":"pipeline/brief.md","owner":"pm","artifactKind":"brief"}
```

When `--follow` is combined with `--json`, newly discovered events use the same object shape. Consumers should parse line-by-line and ignore unknown future fields.

## Next roadmap

OpenTelemetry is useful when a tracing backend is configured, but it is not the
whole operator experience. The Phase 26 plan tracks a broader run-visibility and
performance effort:

- [#312](https://github.com/telus-labs/stagecraft/issues/312) — parent performance,
  observability, and run-usability overhaul
- [#313](https://github.com/telus-labs/stagecraft/issues/313) — critical-path
  telemetry and coverage report
- [#314](https://github.com/telus-labs/stagecraft/issues/314) — rich live run
  narrative, status, and logs. The first slice is implemented: `devteam run`
  emits per-workstream start/finish lines, `run-log.jsonl` records
  `workstream-started` / `workstream-finished`, `run-state.json` tracks
  `active_workstreams` and `last_workstream`, `devteam run --watch` shows active
  workstreams and artifact pointers, and `devteam status --verbose` exposes the
  same state for post-hoc inspection.

The next gap is timing depth: queue/invoke/stamp/merge/retry breakdowns and
critical-path reporting so performance work can be measured before scheduling
changes land.

## Backend-specific cookbooks

### Honeycomb

```bash
export OTEL_EXPORTER_OTLP_ENDPOINT=https://api.honeycomb.io
export OTEL_EXPORTER_OTLP_HEADERS=x-honeycomb-team=YOUR_API_KEY
export OTEL_SERVICE_NAME=devteam-${USER}
devteam stage build
# → Honeycomb dataset "devteam-${USER}"
```

### Datadog (via the agent)

Run the Datadog Agent locally with OTLP enabled, then:

```bash
export OTEL_EXPORTER_OTLP_ENDPOINT=http://localhost:4318
export OTEL_SERVICE_NAME=devteam
export OTEL_RESOURCE_ATTRIBUTES=deployment.environment=staging
devteam stage build
```

### Console exporter (for debugging the trace itself)

The current SDK setup ships to OTLP only. For raw stdout output, override at the SDK level. This is outside the framework's default configuration but easily customizable in `core/observability.js`.

## Testing your instrumentation

`tests/observability.test.js` exercises the orchestrator span tree with an `InMemorySpanExporter`. To add a new instrumented operation:

1. Wrap the operation in `withSpan("name", attrs, () => ...)` from `core/observability.js`.
2. Add an assertion in `tests/observability.test.js` that runs the operation through a test tracer provider and verifies the expected span name + attributes.
3. Document the new span in this file's "What gets traced" table.

## Cost / overhead

When unconfigured, tracing uses OTel's no-op tracer: a single function call that returns immediately. Overhead is negligible.

When configured, span creation and attribute attachment are on the hot path. Because `pipeline.stage` wraps CLI commands that take seconds to minutes, the OTel overhead is in the microsecond range. Negligible.

The OTLP HTTP exporter buffers spans and flushes on a background timer and on process exit. The framework wires `beforeExit`, `SIGINT`, and `SIGTERM` handlers to call `sdk.shutdown()`, but sub-second runs can still lose the tail of a trace. Normal orchestrator usage is long-lived enough that this rarely matters.
