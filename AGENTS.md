# AGENTS.md

Host-neutral context for any LLM working on the **Stagecraft** codebase itself. (The CLI binary is `devteam`; the project is Stagecraft.) If you are using Stagecraft to drive *another* project's pipeline, read [`README.md`](README.md) instead.

## Start here (in order)

1. [`CONTRIBUTING.md`](CONTRIBUTING.md) — setup, recipes for common changes, conventions, and the doc-update checklist.
2. [`ARCHITECTURE.md`](ARCHITECTURE.md) — 15 locked design decisions. Do not break these casually.
3. [`core/adapters/host-adapter.md`](core/adapters/host-adapter.md) — the contract every adapter must satisfy.
4. [`docs/walkthroughs/stage-04-split-host.md`](docs/walkthroughs/stage-04-split-host.md) — stress-test trace that locked the multi-workstream dispatch contract. Read before touching dispatch logic.

## Test and lint commands

```bash
npm test                                              # full offline test suite
npm run consistency                                   # cross-artifact drift check
npx eslint .                                          # linter
CI=true DEVTEAM_HEADLESS_COMMAND=cat npm test         # full CI run (no host CLI needed)
```

`DEVTEAM_HEADLESS_COMMAND=cat` stubs the host CLI for headless tests without `claude` or `codex` installed.

## Where things live

| Concern | Path |
|---|---|
| Stage definitions, tracks, role assignments | `core/pipeline/stages.js` |
| Routing config loader | `core/config.js` |
| Adapter discovery + per-(stage, role) resolution | `core/router.js` |
| Dispatch logic (runStage / next / merge) | `core/orchestrator.js` |
| Gate validator + per-stage schemas | `core/gates/` |
| Guards (stoplist, security-heuristic, write-audit) | `core/guards/` |
| Role briefs (single source of truth) | `roles/*.md` |
| Rules docs | `rules/*.md` |
| Task skills | `skills/*/SKILL.md` |
| Per-host adapters | `hosts/<name>/{adapter.js, capabilities.json, install/}` |
| CLI entry point | `bin/devteam` |

## Load-bearing contracts (do not break without an ADR)

Gate identity fields, stage definition shape, stages-by-track table, adapter export contract, `capabilities.json` enforces map, routing precedence, workstream gate filename, and the invariant that the core never invokes a model. Full details: [`ARCHITECTURE.md`](ARCHITECTURE.md) · [`core/gates/schemas/gate.schema.json`](core/gates/schemas/gate.schema.json) · [`core/adapters/host-adapter.md`](core/adapters/host-adapter.md) · [`rules/gates-core.md`](rules/gates-core.md).

Every contract change needs: (a) the code change, (b) updated docs in the relevant rules file, ARCHITECTURE.md, or host-adapter.md, (c) a test in lockstep.

## Key conventions

- **No `agent` field.** Use `workstream` and `host` (workstream gates) or `orchestrator` (stage-level gates).
- **`node:` prefix on built-in imports.** `require("node:fs")`, not `require("fs")`.
- **stdout for primary output; stderr for everything else.** Ensures `devteam stage ... > prompt.md` captures a clean prompt. Validator and hooks are exit-code-driven and write to stdout (consumed by the hook log).
- **Idempotent installs.** Every adapter's `install()` must be safe to re-run; second call returns `written: 0, skipped: N`.
- **Single source of truth.** `roles/` · `rules/` · `skills/` are canonical; adapters render host-specific copies at install time. Never edit installed copies in a target project.

## Adding things

| You want to… | Where |
|---|---|
| Add a stage | [`CONTRIBUTING.md` § Recipe 2](CONTRIBUTING.md#recipe-2--adding-a-stage) |
| Add a role | [`CONTRIBUTING.md` § Recipe 3](CONTRIBUTING.md#recipe-3--adding-a-role) |
| Add a host adapter | [`CONTRIBUTING.md` § Recipe 1](CONTRIBUTING.md#recipe-1--adding-a-host-adapter) |
| Add a skill | [`CONTRIBUTING.md` § Recipe 4](CONTRIBUTING.md#recipe-4--adding-a-skill) |
| Add a CLI subcommand | `bin/devteam` (parseFlags + cmd function + switch case + help text) |
| Add a track | `STAGES_BY_TRACK` in `core/pipeline/stages.js` |

## Backlog and tests

Open backlog: [`docs/BACKLOG.md`](docs/BACKLOG.md). Test strategy, tier layout, and inventory: [`docs/TESTING.md`](docs/TESTING.md).
