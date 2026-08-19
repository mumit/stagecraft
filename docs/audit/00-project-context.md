# 00 — Project context

## Summary

Stagecraft is a model-agnostic AI software-delivery orchestrator. Its CLI binary is
`devteam`; the core renders stage prompts, validates JSON gates, routes workstreams to
host adapters, and advances or halts an on-disk pipeline. It does not call a model API
directly unless routed through an adapter. Claude Code, Codex, Gemini CLI, Omnigent,
the generic terminal adapter, and an OpenAI-compatible API adapter provide the
model-facing execution surfaces.

This is the **third full Stagecraft self-audit**, started 2026-06-18. The prior audit
(2026-06-03, v0.4.0, post-derive-approvals) is archived at
`docs/audit-archive/2026-06-03-v0.4.0-post-derive-approvals/`. Since that audit the
repository has moved from 254 to 554 tracked files, from 49 to 104 test files, from 17
to 18 ordered pipeline stages, and from v0.4.0 to v0.9.0.

## Languages and frameworks

| Surface | Version / form | Where |
|---|---|---|
| JavaScript | CommonJS, Node.js >=22 | `bin/`, `core/`, `hosts/`, `scripts/`, `tests/` |
| Markdown | Host-neutral rules, roles, skills, plans, runbooks | `docs/`, `plans/`, `roles/`, `rules/`, `skills/`, `templates/` |
| JSON / JSON Schema | Gate contracts and host capabilities | `core/gates/schemas/`, `hosts/*/capabilities.json` |
| YAML | Project config and GitHub Actions | `.devteam/config.yml` in targets, `.github/workflows/` |
| HTML/CSS/browser JS | Read-only pipeline dashboard | `core/ui/static/` |

There is no application framework, transpiler, bundler, ORM, or third-party test
framework. The project deliberately uses Node built-ins and `node:test`.

## Build and dependency manager

- Package manager: npm; `package-lock.json` is committed.
- Build step: none. The CLI runs directly from source.
- Runtime dependencies: `js-yaml` and six OpenTelemetry packages.
- Builtin memory retrieval has no dependency; `@huggingface/transformers` can be installed separately for the opt-in `local` provider.
- Development dependencies: ESLint, `@eslint/js`, and `eslint-plugin-security`.
- Package version: `0.11.0`; package remains `private: true`.

## Commands

```sh
npm ci                                               # reproducible install
npm test                                             # full node:test suite
CI=true DEVTEAM_HEADLESS_COMMAND=cat npm test        # CI-equivalent host stub
npm run consistency                                  # cross-artifact drift checks
npm run lint                                         # ESLint + security subset
npm run docs:generate                                # generated reference tables
./bin/devteam help                                   # CLI smoke test
```

Useful operational commands include `devteam stage`, `next`, `run`, `summary`,
`status`, `commit`, `restart`, `replay`, `reproduce`, `verify-chain`, `doctor`,
`assess`, `standards discover`, `memory`, and `ui`.

## Delivery and external execution

Stagecraft is a developer CLI rather than a hosted service. It is installed from the
repository or via npm linking today. GitHub Actions runs lint, tests, informational
coverage, consistency checks, CLI/init/doctor smoke tests, onboarding smoke, and the
per-PR changelog-fragment guard on Node 20, 22, and 24.

Deployment *instructions* for target projects support Docker Compose, Kubernetes,
Terraform, GCP Cloud Run, Gizmos/Cloudflare Workers, and custom scripts. Those tools
are invoked by the routed platform agent; Stagecraft core does not embed cloud SDKs.

## Governing conventions

Documented, load-bearing conventions:

- Gate identity, stage shape, track membership, adapter exports, routing precedence,
  and workstream gate filenames are locked contracts.
- No `agent` field. Use `workstream` + `host` or stage-level `orchestrator`.
- Core is model-neutral; host-specific invocation belongs in adapters.
- Built-in imports use `node:` prefixes.
- stdout is primary output; stderr is framing, diagnostics, and progress.
- `roles/`, `rules/`, and `skills/` are canonical; adapters render installed copies.
- Installs are idempotent.
- Public/code behavior changes in guarded directories require `changelog.d` fragments.
- Derivable reference tables are generated and checked by `npm run consistency`.
- Phase 1/2 audit findings require direct `verified_by` evidence before promotion.

Dominant but less formally centralized patterns:

- CLI subcommands are lazy-loaded from `core/cli/commands/<name>.js`.
- Commands export `{ name, flags, run }` and use shared flag parsing/help generation.
- Tests are flat `tests/*.test.js`, use `node:test`, and create isolated temp targets.
- Errors at CLI boundaries become a concise stderr message and non-zero exit code.

## Repository size

Measured from tracked files on 2026-06-30:

| Surface | Count / size |
|---|---:|
| Tracked files | 554 |
| JavaScript files | 239 |
| JavaScript lines | 61,916 |
| `core/` files | 143 |
| `core/` JavaScript lines | 24,780 |
| Test files | 104 |
| Documentation markdown files | 96 |
| Role briefs | 12 |
| Rules files | 29 |
| Skills | 20 |
| Stage definitions | 18 ordered pipeline stages |
| Tracks | 6 |
| First-party hosts | 6 |
| CLI command modules | 34 |

This is a single-package application, not a monorepo. Host directories are adapters,
not independently versioned packages. External adapters can be discovered from
`@devteam/host-*` npm packages installed in a target project.

## Major directories

| Directory | Responsibility |
|---|---|
| `bin/` | Executable entry point |
| `core/` | Model-neutral orchestration, state, gates, guards, verification, UI |
| `hosts/` | First-party adapter implementations and install payloads |
| `roles/`, `rules/`, `skills/` | Canonical model-facing behavior |
| `templates/` | Generated artifact and audit templates |
| `tests/` | Unit, integration, CLI, contract, and end-to-end tests |
| `scripts/` | Analytics, release, consistency, docs generation, PR tooling |
| `docs/` | Operator, evaluator, contributor, reference, runbook, ADR, audit docs |
| `plans/` | Completed phase plans and evidence reviews |
| `examples/` | Checked-in example pipeline fixture |

## Surprises and audit questions

- Velocity is exceptional: 550 commits have landed since the prior audit, including
  fifteen completed roadmap phases and many dogfooding fixes.
- `core/driver.js` is now 1,500+ lines and `core/orchestrator.js` 1,200+ lines; both
  remain structured, but their growth deserves targeted quality analysis.
- The active GitHub backlog is intentionally evidence-gated (D5, H3, ADR-005,
  ADR-007 Tier 2), while `docs/BACKLOG.md` still contains several open rows whose
  implementation appears to have landed. Phase 3 must reconcile those surfaces.
- Native Windows compatibility work landed in several independent PRs; Phase 1/2
  should verify whether documentation and the backlog now describe the actual state.
- The project has strong tests and CI, but the suite size and runtime need fresh
  measurement rather than inherited counts.

## Project-specific extensions

No `docs/audit-extensions.md` file is present.
