# Testing

**Current state:** `npm test` runs the full suite offline with no external services. Wall-clock duration depends heavily on platform and available CPU; use the TAP summary from your own run rather than a checked-in timing claim. CI runs the full suite on Ubuntu with Node 22 / 24 and a native Windows portability smoke on Node 22. Exact counts remain in `npm test` output because they drift as coverage grows.

## Running the suite

```bash
npm test                                     # all tests
node --test tests/orchestrator.test.js       # one file
node --test --test-name-pattern='ESCALATE'   # one pattern across the suite
```

Coverage report (experimental):

```bash
node --experimental-test-coverage --test tests/*.test.js
```

## Target-project test discovery

This repository's suite remains Node-only. When Stagecraft verifies a target project,
however, pre-review and QA run every conservatively detected suite:

| Project signal | Command |
|---|---|
| `package.json` with `scripts.test` | `npm test` |
| `pytest.ini`, pytest config in `pyproject.toml`/`setup.cfg`, or conventional Python tests under `test/` or `tests/` | `python3 -m pytest` (`py -m pytest` on Windows) |
| `go.mod` | `go test ./...` |

Discovery is bounded and does not follow symlinks. Suites run with bounded
concurrency (`pipeline.verify.test_concurrency`, default 2, max 8) and all are
attempted; the orchestrator stamps per-suite commands, exit codes, durations, resource
groups, and output-truncation flags, then fails the gate if any suite fails. A non-empty
`pipeline.verify.test_command` is an exclusive override for projects with another
runner or monorepo command. Set it to `null` to disable automatic test execution.
Set `test_concurrency: 1` to serialize fragile suites. For configured suite lists,
`resource_group` prevents browser, database, or port-bound suites that share a resource
from overlapping while unrelated suites still run in parallel:

```yaml
pipeline:
  verify:
    test_concurrency: 3
    test_suites:
      - id: unit
        command: "npm test"
      - id: browser
        command: "npm run test:browser"
        resource_group: browser
```

Successful orchestrator-run verification commands also mint content-addressed receipts
under the active pipeline root (`pipeline/verification-receipts/` in in-place mode, or
the bounded change's equivalent). Receipt reuse requires an exact key match across the
normalized command, suite id, verification purpose, workspace file digests, verify
config, material environment/toolchain inputs, and Stagecraft verifier version. Failed
results are never reused, and uncertain lookup falls back to execution. Set
`pipeline.verify.receipts: false` for projects whose tests depend on external state.

## Test file inventory

| File | What it covers |
|---|---|
| `contract.test.js` | Cross-artifact consistency — every stage in `stages.js` has a matching schema, every role has a matching brief, every schema's fields align with `rules/gates-core.md` and per-stage `rules/stage-NN.md`. |
| `gate-validator.test.js` | Validator exit codes (PASS=0, FAIL=2, ESCALATE=3, malformed=1), bypassed-escalation detection, retry-protocol enforcement, malformed reinforced-lines surfacing. |
| `orchestrator.test.js` | `runStage` decomposition, changed-file manifest prompt facts, `buildDescriptor` with `roleWrites` + `subagent` overrides, `mergeWorkstreamGates` aggregation (ESCALATE > FAIL > WARN > PASS), `summary` rendering. |
| `next.test.js` | All `next()` scenarios: empty, run-stage, continue-stage, merge, fix-and-retry, resolve-escalation, pipeline-complete, conditional skip, track filter, `--json`. |
| `right-sizing.test.js` | High-confidence auto-track guardrails, path-derived active-role candidates, deterministic applicability skips, and `force_stages` override behavior. |
| `router.test.js` | Resolution precedence (`stages > roles > default_host`), missing-adapter error path, multi-host install. |
| `config.test.js` | YAML loader: missing → defaults, bad YAML → clear error, routing fields parsed; `writeConfigIfAbsent` idempotency. |
| `adapter-contract.test.js` | Every adapter under `hosts/` exports the required surface (`capabilities`, `install`, `renderStagePrompt`, `status`, `uninstall`) and parses `capabilities.json`. |
| `install-roundtrip.test.js` | Per-adapter install → status (ok) → uninstall → status (missing). Install idempotency. |
| `approval-derivation.test.js` | Stage 5 PostToolUse hook: section + `REVIEW:` marker → verdict, upserts gate, PASS only with approvals ≥ required AND no changes_requested. Lock acquisition under contention. |
| `stoplist.test.js` | Phrase matching across the guarded tracks; bypass requires explicit flag. |
| `security-heuristic.test.js` | Stage 4b trigger paths fire on sensitive files; safe paths don't false-positive. |
| `tracks.test.js` | `orderedStageNamesForTrack(track)` returns the right list per track; unknown → throws; nano excludes most stages; full has all 18. |
| `schemas.test.js` | Each `stage-NN.schema.json` is a valid JSON Schema 2020-12; example gates in `rules/stage-NN.md` validate against their declared schema. |
| `cli.test.js` | `bin/devteam` exit codes for known/unknown commands; `--json` outputs valid JSON; `--cwd` honored uniformly. |
| `observability.test.js` | OpenTelemetry spans emitted at every instrumented call site, with expected attributes, via `InMemorySpanExporter`. |
| `context-manifest.test.js` | Changed-file manifest collection: Git porcelain parsing, process-path exclusions, byte/digest facts, no content leakage, manifest caps. |
| `secret-scan.test.js` | PreToolUse hook: pattern detection, false-positive guards, magic-comment override, path allowlist, end-to-end stdin parsing, snippet redaction. |
| `evidence-status.test.js` | Bounded evidence readers, aggregate-only readiness analysis, prompt-byte routing aggregates, malformed/oversized input handling, bounded isolation, and read-only CLI behavior. |
| `evidence-export.test.js` | Pseudonymous identity lifecycle, consent and exclusive writes, strict bundle validation/digests, prompt-byte aggregate export, sparse-cell suppression, hostile-value exclusion, symlink refusal, portfolio de-duplication, and cross-project readiness. |
| `fanout.test.js` | `computeDispatchPlan` correctness with/without fanout; end-to-end `runStage` producing N×M workstream prompts; `mergeWorkstreamGates` aggregation across all fanout gates. |
| `dashboard.test.js` | Gate→row expansion (merged stage gates split into workstream rows); per-host / per-role attribution; multi-project rollup; time-window filter; ASCII chart + JSON output. |
| `performance.test.js` | `scripts/performance.js`: workstream expansion, per-(role, host) aggregation, first-try pass rate, cost/pass, p50/p95 duration, retry-adjusted completion, Markdown/JSON output. |
| `routing-suggest.test.js` | `scripts/routing-suggest.js`: recommendation thresholds, quality-first scoring, cost and latency tiebreakers, YAML patch rendering. |
| `render-helpers.test.js` | Shared prompt rendering helpers: allowed-write captions, changed-file manifest section, gate footer, cost telemetry hint, system-prompt hashing. |
| `pr-publish.test.js` | Gate→check-run translation: PASS→success / WARN→neutral / FAIL+ESCALATE→failure; blockers + warnings + workstreams in summary; auto-detect repo + PR; `--dry-run`. |
| `ui.test.js` | Pure helpers, route correctness, path-traversal rejection, SSE plumbing. |
| `memory.test.js` | Ingest, query, stats, clear, reindex; chunker by level-2 heading; `stagecraft-no-memory` opt-out; embedder mismatch warning; stub embedder for offline CI. |
| `budget.test.js` | `scripts/budget.js`: `parseBudgetMd` round-trip; config parsing; init/update/check sequence; contract-F gate on escalation. |
| `release.test.js` | `scripts/release.js notes` extraction: `[Unreleased]` default, middle section, last section (no trailing header to anchor to), missing-version error, blank-line preservation, trailing `---` stripping. |
| `headless.test.js` | `core/adapters/headless.js`: command resolution, env override, missing-command rejection, exit-code propagation, spawn-ENOENT message, gatePath detection, EPIPE swallowing, whitespace-split. |
| `run.test.js` | `devteam run` driver: happy-path loop, workstream lifecycle/prompt-byte telemetry, auto-fix `code-defect` retry, transient dispatch retry with backoff, `--auto-rule` escalation resolution, consequence-ceiling halt, `--until` boundary stop. |
| `scheduler.test.js` | Per-host workstream scheduler: host/default limits, stable result ordering, queue-depth and queue-time behavior. |
| `classify.test.js` | `classifyDispatch` failure-class derivation: `code-defect`, `judgment-gate`, `state-corruption`, `external-blocked`, `transient`, `structural-input`. |
| `escalation.test.js` | Escalation-handling end-to-end: `devteam ruling` dispatch, `fix-escalation` encoding, auto-rule grant/deny, `PRINCIPAL-CANNOT-DECIDE` halt. |
| `chain.test.js` | Multi-stage fix-and-retry chains: blocker propagation across stage boundaries, retry ceiling, convergence-exhausted promotion to escalation. |
| `archive.test.js` | Gate archiving (`pipeline/gates/archive/<stage>.attempt-N.json`): snapshot-before-clear, diff fields, replay-compatible format. |
| `consistency-meta.test.js` | `scripts/consistency.js` exits 0 against the live repo; fixture-tree tests cover every prose-vs-code class, including schema vocabulary and support state, with violation detection, clean exits, baseline suppression, and archive exclusions. |

## Conventions

**Fixtures.** `tests/_helpers.js` exports `makeTargetProject(opts)` and `seedGate(cwd, name, gate)`. Use these instead of inlining tempdir setup.

**Offline.** Tests never touch a network. `DEVTEAM_EMBEDDING_PROVIDER=stub` is the default in `tests/memory.test.js`; `DEVTEAM_HEADLESS_COMMAND=true|false|node` is used to stub host CLIs.

**Subprocess vs in-process.** Modules that `process.exit()` on every branch (the gate validator, the budget script) get tested via `spawnSync`. Pure-logic exports get tested in-process.

**No LLM evals.** Whether a model produces good code at a given stage is not in scope here. That's a different test suite that hasn't been built.

## CI

`.github/workflows/test.yml` runs on every push and PR against `main`:

- Node 22 and 24 (matrix; `fail-fast: false`)
- `npm ci` → `npm test` → `npm run consistency` → `./bin/devteam help` → `./bin/devteam init && ./bin/devteam doctor`
- Windows Node 22 smoke: command parsing, PATHEXT probing, timeout termination,
  quoted executable dispatch, CLI help, fresh init, and doctor

Node 20 was dropped after it reached EOL in 2026. The matrix now tests the minimum
supported Maintenance LTS (22) and Active LTS (24). Lint, consistency, and informational
coverage run once on Node 22; both versions still run the complete offline test suite and
CLI smoke checks.

## What's NOT tested (deliberately out of scope)

- **LLM outputs.** Anything that depends on calling Anthropic / OpenAI / Google APIs. CI must run with zero external dependencies.
- **Real `claude --print` / `codex exec --sandbox workspace-write` / `gemini`.** Hosts may not be installed on the CI runner; the tests stub via `DEVTEAM_HEADLESS_COMMAND`.
- **Subagent quality.** Whether the `implement` skill produces good code is an eval question, not a unit-test question.
- **Doc prose.** No tests grep prose for wording; brittle.

## Open gaps (tier-3 candidates)

These are nice-to-haves not currently in the suite. If you hit a bug in one of these areas, add the test:

- **`tests/conditionalOn.test.js`** — verifies stage-04b security review fires when the heuristic matches, skips when it doesn't. Currently exercised only indirectly via `next.test.js`.
- **`tests/multi-host.test.js`** — end-to-end with two adapters: install both, run a build with split routing, merge, verify per-workstream gates carry the right host field. The pieces are covered by `router.test.js` + `fanout.test.js` + `install-roundtrip.test.js`, but no single test threads the whole flow.
- **`tests/stage-numbering.test.js`** — grep-based assertion that every role brief's mentioned stage matches a real stage name in `stages.js`. The contract test catches most of this; an explicit numbering check would catch off-by-one bugs at the prose layer.
- **`tests/concurrency.test.js`** — approval-derivation lock under contention (spawn N processes writing to the same area). The lock is exercised by `approval-derivation.test.js` but not under real concurrency.

## Historical notes

The original strategy doc (pre-v0.1.0) framed tier 1 / tier 2 / tier 3 as work to come. Tier 1 and 2 are done. The remaining gaps above are the surviving tier-3 items.
