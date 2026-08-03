# Stagecraft — Architecture

Stagecraft is a model-agnostic pipeline for running an AI dev team (PM → Principal → Build → Review → QA → Deploy → Retro) inside any AI coding tool or runtime (Claude Code, Codex, Gemini CLI, Omnigent, OpenAI-compatible APIs, plain terminal). The CLI binary is `devteam`; the project is Stagecraft.

This work was previously split across two repos (`claude-dev-team`, `codex-dev-team`) sharing ~90% of their code and diverging slowly. This project replaces both with a single core and per-host adapters.

## Table of contents

- [Design model](#design-model)
- [Proposed directory layout](#proposed-directory-layout)
- [Design decisions (locked)](#design-decisions-locked)
- [Routing config](#routing-config)
- [Open design decisions](#open-design-decisions)
- [Migration from the existing forks](#migration-from-the-existing-forks)

## Design model

```
┌─────────────────────────────────────────────────────────────────┐
│  User (inside Claude Code, Codex, Omnigent, or a terminal)      │
└─────────────────────────────────────────────────────────────────┘
                              │
                              │  invokes via host-native surface
                              │  (slash command / skill / prompt / plain CLI)
                              ▼
┌─────────────────────────────────────────────────────────────────┐
│  Host adapter(s)                               hosts/<host>/    │
│  - one or more installed per project                            │
│  - core dispatches to one adapter per stage via routing config  │
│  - each declares capabilities (hooks, subagents, worktrees…)    │
│  - installs surface into target project                         │
│  - renders shared role briefs into host-expected paths          │
└─────────────────────────────────────────────────────────────────┘
                              │
                              ▼
┌─────────────────────────────────────────────────────────────────┐
│  Core (model-agnostic spine)                   core/            │
│  - stage definitions, track logic                               │
│  - gate JSON schemas + validator                                │
│  - allowed-writes / stoplist / security guards                  │
│  - pipeline state, "what's next" decision                       │
│  - emits stage prompts; never talks to a model itself           │
└─────────────────────────────────────────────────────────────────┘
                              │
                              ▼
┌─────────────────────────────────────────────────────────────────┐
│  Stage prompt (markdown)                                        │
│  - role brief, objective, files to read, allowed writes,        │
│    expected gate JSON shape                                     │
└─────────────────────────────────────────────────────────────────┘
                              │
                              │  consumed by the LLM inside the host
                              ▼
┌─────────────────────────────────────────────────────────────────┐
│  Model produces:                                                │
│  - the artifact (brief.md, design-spec.md, code, ...)           │
│  - a gate JSON conforming to core/gates/schemas/stage-NN.json   │
└─────────────────────────────────────────────────────────────────┘
                              │
                              ▼
                  core validates, advances, or escalates
```

**The core never calls a model.** It emits prompts and validates JSON. Model-agnosticism follows directly: only the invocation surface is host-specific.

## Proposed directory layout

```
stagecraft/
├── README.md
├── ARCHITECTURE.md                  ← this file
├── VERSION
├── package.json
├── bin/
│   └── devteam                      ← CLI entrypoint (host-agnostic)
│
├── core/                            ← the spine; no host code lives here
│   ├── orchestrator.js              ← stage runner, track logic, "next"
│   ├── pipeline/
│   │   ├── stages.js                ← shared STAGES table
│   │   └── tracks.js                ← full / quick / nano / hotfix / ...
│   ├── gates/
│   │   ├── validator.js
│   │   └── schemas/stage-*.json
│   ├── guards/
│   │   ├── stoplist.js
│   │   ├── allowed-writes.js
│   │   └── security-heuristic.js
│   ├── adapters/                    ← host-adapter contract lives here
│   │   ├── host-adapter.md          ← the interface (see file)
│   │   └── base-adapter.js          ← optional shared helpers
│   └── deploy/                      ← deploy adapter docs (markdown the LLM reads)
│       ├── docker-compose.md
│       ├── kubernetes.md
│       ├── terraform.md
│       └── custom.md
│
├── roles/                           ← SINGLE SOURCE OF TRUTH for role briefs
│   ├── pm.md
│   ├── principal.md
│   ├── backend.md
│   ├── frontend.md
│   ├── platform.md
│   ├── qa.md
│   ├── security.md
│   └── reviewer.md
│
├── templates/                       ← shared artifact templates
│   ├── brief-template.md
│   ├── design-spec-template.md
│   └── ...
│
├── hosts/                           ← per-host adapters
│   ├── claude-code/
│   │   ├── adapter.js
│   │   ├── capabilities.json        ← hooks: true, subagents: true, ...
│   │   └── install/                 ← files laid down at `init`
│   │       ├── commands/            ← .claude/commands/*.md
│   │       ├── agents/              ← .claude/agents/*.md
│   │       └── hooks/               ← .claude/hooks/*
│   ├── codex/
│   │   ├── adapter.js
│   │   ├── capabilities.json
│   │   └── install/
│   │       ├── prompts/             ← .codex/prompts/roles/*
│   │       └── skills/              ← .codex/skills/*
│   ├── omnigent/
│   │   ├── adapter.js
│   │   └── capabilities.json        ← installs .omnigent/stagecraft/agent/config.yaml
│   ├── openai-compat/
│   │   ├── adapter.js
│   │   ├── capabilities.json
│   │   └── tools.js                 ← HTTP-native tool loop
│   ├── acp/                         ← Agent Client Protocol client — any ACP agent
│   │   ├── adapter.js               ← session lifecycle, logging, gate resolution
│   │   ├── jsonrpc.js                ← newline-delimited JSON-RPC 2.0 over stdio
│   │   ├── permissions.js           ← allowed-writes + stoplist → request_permission
│   │   └── capabilities.json        ← acpProtocolVersion: 1; allowed_writes/stoplist: tool-call-time
│   └── generic/                     ← plain CLI, no in-host integration
│       ├── adapter.js
│       └── capabilities.json
│
├── scripts/                         ← helper scripts (not part of the core)
│   ├── budget.js                    ← out-of-band budget tracking
│   ├── consistency.js               ← cross-artifact lint (185 checks)
│   ├── dashboard.js                 ← gate-pass-rate aggregation
│   ├── pr-pack.js / pr-publish.js   ← GitHub PR integration
│   ├── release.js                   ← pre-release checks + notes extraction
│   └── visualize.js                 ← stage-graph rendering
└── tests/
```

(`devteam init` is implemented in `bin/devteam`, not a standalone script. There is no `parity-check` — Stagecraft is a single core, not parallel forks.)

Changes from the two existing repos:

- `templates/`, deploy adapters, `core/guards/`, `core/gates/`, and the orchestrator's STAGES table move to `core/` and are deduplicated. These were already nearly identical between the forks.
- Role briefs (previously duplicated in `.claude/skills/*` and `.codex/skills/*` and diverging) consolidate under `roles/`. Host adapters render them into the host's expected path at `devteam init` time.
- `.claude/commands/*.md` and `.codex/prompts/roles/*` become host-specific install payloads, not part of the core.

## Design decisions (locked)

1. **Layered, not either-or.** The CLI is the spine; host skills/commands are thin invocation wrappers around it. Both layers exist.
2. **The core never spawns a model.** It emits stage prompts and validates gate JSON. Hosts decide how the model consumes the prompt.
3. **Gate JSON is the stable contract.** Versioned, validated, host-agnostic. Identity fields: `stage`, `workstream` (per-workstream only), `orchestrator`, `host` (per-workstream only), `status`. Multi-role stages produce per-workstream gates that the orchestrator merges into a stage-level gate with a `workstreams: []` array. No host-specific fields in the schema — those go in the adapter. Stage-level `chain` metadata may include the provider-neutral HMAC fields defined by [ADR-011](docs/adr/011-authenticated-gate-chain.md); secrets and KMS-provider details never enter the gate schema.
4. **Role briefs have one source.** `roles/*.md`. Adapters render them into host-expected paths. Per-host overlay files allowed only when measurably needed.
5. **Capability negotiation.** Each adapter declares `capabilities.json`; the orchestrator branches on it (e.g. no hooks → poll for the gate file). For multi-host runs, capabilities are evaluated per the adapter dispatched for *that* workstream. `capabilities.enforces` declares where the host enforces each core rule (`tool-call-time` blocks the violation at write; `post-hoc-audit` lets the gate validator catch it; `prompt-only` is advisory). The orchestrator skips post-hoc audits the host already enforces and runs them otherwise.
6. **Two isolation modes.** `in-place` and `isolated`. Each adapter maps these to host primitives (Claude Code worktree, Codex `app_worktree`/`cloud`, plain checkout).
7. **Two invocation modes.** `user-driven` (CLI prints prompt, user invokes inside host — works everywhere) and `cli-driven` (orchestrator `exec`s the host CLI — better automation, more coupling). Start with `user-driven`; add `cli-driven` per host as it earns its keep.
8. **Out of scope at this layer:** auth, per-call cost limits, model routing inside a host. Budget *tracking* lives in `scripts/budget.js` as an out-of-band tool (`npm run budget`); budget *enforcement at the API level* belongs to the host.
9. **Per-workstream host selection (role-based with stage override).** A single pipeline run can dispatch different stages — and different roles within the same stage — to different hosts. Routing keyed off role by default; per-stage override for the edge cases. Default routing for a single-host install is "all roles → that host". Stages with multiple roles (stage-04 build, peer-review fan-out) decompose into one **workstream dispatch** per role; each writes its own workstream gate, which the orchestrator merges into the stage gate. The gate JSON contract lets stage N's output flow to stage N+1 regardless of who produced it.
10. **Multi-host install.** `devteam init --host claude,codex` installs both adapters' surfaces side-by-side. `routing` config decides which adapter handles which stage at runtime. Single-host is the same code path with a list of length 1.
11. **Runtime is Node.** Matches the two existing forks; lets us reuse `*-team.js`, `gate-validator.js`, `stoplist.js`, etc. without rewriting. Revisit if/when "casually installable static binary" becomes a real requirement.
12. **Bounded autonomous execution ([ADR-003](docs/adr/003-bounded-autonomous-execution.md)).** The pipeline may be driven by a deterministic code loop (`devteam run`, `core/driver.js`) built on a typed failure model. Non-pass outcomes are classified by *required response*: the **gate-time** classes (`state-corruption`, `judgment-gate`, `external-blocked`, `code-defect`, plus `convergence-exhausted`) are carried as `failure_class` on `next()` action objects; the **dispatch-time** classes (`transient`, `structural-input`) are derived by the driver (`classifyDispatch`) from the `runHeadless` return, since only it holds that signal — a no-gate dispatch is retried with backoff, then halts as structural. Autonomy is bounded by a **consequence ceiling**: the driver never advances into stage-07 sign-off / stage-08 deploy without an explicit human grant (`--allow-stage`). Escalations halt for a human by default; an opt-in, CLI-only, allowlist-only `--auto-rule <classes>` lets the driver auto-apply Principal rulings whose `[class:]` is granted — never a typed `PRINCIPAL-CANNOT-DECIDE` (authority/information/value), the ceiling, or `convergence-exhausted` — recording authority provenance to `run-log.jsonl`. The driver introduces run-scoped state the stateless-within-a-run model otherwise avoids — `pipeline/run.lock`, `run-state.json`, `run-log.jsonl`. This refines decision #8: the driver *may gate dispatch* on tracked cost (a pre-dispatch `--budget-usd` check), while API-level budget enforcement still belongs to the host. The human role shifts from mechanical sequencer to authority grantor. Built in phases (failure model → driver skeleton → autonomous fix-and-retry → recipe factory); only the failure model is foundational and unconditional.

### Routing config

Lives in the target project at `.devteam/config.yml`:

```yaml
routing:
  default_host: claude-code         # used when no role/stage match
  roles:                            # role-based, the common case
    pm: claude-code
    principal: claude-code
    backend: codex
    qa: claude-code
  stages:                           # per-stage override, takes precedence
    stage-08: claude-code           # deploy always on claude-code regardless of role
  review_fanout:                    # opt-in: stage-05 (peer-review) runs in
    - claude-code                   # parallel across all listed hosts. Each
    - codex                         # area × host pair is a separate workstream
    - gemini-cli                    # (12 workstreams for 4 areas × 3 hosts).
                                    # Aggregate is pessimistic (any FAIL wins).
                                    # Default: [] (no fanout).
```

Resolution order, highest to lowest: `routing.stages.<stage>` → `routing.roles.<role>` → `routing.default_host`. Unresolvable routes halt the orchestrator with an error.

For multi-role stages, resolution runs per role. In stage-04 (`roles: [backend, frontend, platform, qa]`), each role resolves independently: `backend` might land on `codex` while `frontend` lands on `claude-code`. If all roles in a stage resolve to the same host and that host has `subagents: true`, the orchestrator may consolidate them into a single host invocation; otherwise each workstream is a separate dispatch.

## Open design decisions

- **Where the orchestrator runs.** Currently: the user's machine. Running stages on a CI runner or cloud worker for long-running roles is an open question. The answer determines whether stage state is local-only or networked.

## Migration from the existing forks

Each step below is independently shippable:

1. Land `core/` by deduplicating from `claude-dev-team` (templates, schemas, guards, deploy adapters, validator).
2. Extract role briefs from both forks → diff → reconcile → `roles/*.md`.
3. Port the orchestrator (`claude-team.js` → `core/orchestrator.js`), removing `.claude/`-specific paths.
4. Build `hosts/claude-code/` adapter; render `roles/` → `.claude/skills/`, ship slash commands as install payload. Verify end-to-end on a sample repo.
5. Build `hosts/codex/` adapter the same way. Run parity check against the same sample repo.
6. Add `hosts/generic/` (no-host CLI mode) — proves the core is genuinely host-agnostic.
7. Deprecate the two forks; archive with a pointer to this repo.
