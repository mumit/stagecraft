# Features

Stagecraft is an orchestrator that runs your AI coding tool through a structured software development pipeline. It is not a model. It renders prompts, reads the artifacts and gate files the AI writes back, and decides what to run next. State lives on disk, not in a chat log. This document covers every shipped feature, organized by area. For planned work, see [BACKLOG.md](./BACKLOG.md).

- [Supported hosts](#supported-hosts)
- [Pipeline stages](#pipeline-stages)
- [Safety and auditability](#safety-and-auditability)
- [Observability and learning](#observability-and-learning)
- [Developer tools](#developer-tools)
- [Integrations](#integrations)
- [Advanced AI capabilities](#advanced-ai-capabilities)

---

## Supported hosts

Stagecraft is model-agnostic. It runs on whichever AI runtime you already have — Claude Code, Codex, Gemini CLI, Omnigent, any other tool that can accept a prompt and write files — or an OpenAI-compatible Chat Completions endpoint through the HTTP-native host.

Six adapters ship: `claude-code` (primary, with hooks and slash commands), `codex`, `gemini-cli`, `omnigent`, `generic`, and `openai-compat`. Each declares its capabilities — headless support, hooks, subagents, enforcement levels — in `hosts/<host>/capabilities.json`.

See **[`docs/reference/hosts.md`](reference/hosts.md)** for the full capability and enforcement matrix across all six hosts.

---

## Pipeline stages

The pipeline is 18 stages from requirements to retrospective. Every stage renders a prompt, the AI writes an artifact and a JSON gate file, and `devteam next` reads the gate to decide what runs next. State lives on disk — you can stop at any point and pick up exactly where you left off.

### A structured SDLC in the right order

The pipeline is 18 stages from requirements to retrospective, grouped into five phases (Planning, Build, Peer Review, Verification, Delivery). Conditional stages (security-review, migration-safety) only run when a prior gate field triggers them; the mechanical preflight (stage-04e) is auto-run before peer-review, not dispatched to an LLM.

See **[`docs/reference/stages.md`](reference/stages.md)** for the full stage table: ID, roles, conditionalOn, gate files, artifacts, and templates, grouped by phase.

### Tracks — right-size the pipeline to the change

Six tracks control which stages run. `full` runs all 18 stages; lighter tracks skip phases not relevant to the change type. See **[`docs/tracks.md`](tracks.md)** for the per-track stage matrix.

Pick at `devteam stage requirements --feature "..." --track full`.

For longer briefs, use `--feature-file <path>` with `devteam stage` or `devteam run` to read the feature description from a UTF-8 text file instead of squeezing it into a shell argument.

### Parallel workstreams within a stage

Build and peer-review can run parallel workstreams — frontend, backend, and infra simultaneously — within a single stage. Each workstream writes its own gate; they merge into one stage-level gate.

### License compatibility gate — dependency licenses checked at pre-review

`stage-04a` (pre-review) runs a license check on all installed packages as part of Platform's pre-review pass.

- Gate carries `license_check_passed` (bool) and `license_findings[]` (per-package `{ package, license, policy: allowed|warned|denied, note? }`)
- Default policy: MIT/Apache-2.0/BSD-*/ISC/CC0/Unlicense → allowed; UNLICENSED/SSPL/BUSL → warned; GPL-*/AGPL-*/LGPL-* → denied
- Override with `license.extra_allowed: ["LicenseId"]` in `.devteam/config.yml` to whitelist additional licenses for your project
- Denied licenses cause `license_check_passed: false` and fail the pre-review gate

### Performance budget gate — Lighthouse, bundle size, load tests

New `stage-06e`, role `qa`. Runs after stage-06d on `full`; after stage-06c on `quick`/`hotfix`. Not included in nano/config-only/dep-update.

- Checks Lighthouse Web Vitals, bundle size delta, and load-test throughput (k6 / autocannon) against configured budgets in `performance.budget.json` or `.devteam/config.yml` defaults
- Gate carries `budget_exceeded`, `checks_performed[]`, and `skipped_reason` (for changes with no performance-relevant surface)
- `budget_exceeded: true` → FAIL; `skipped_reason` populated → PASS with a note
- **Requires shell capability** — `assertCapabilities()` refuses at dispatch if the routed host doesn't declare `enforces.shell: true`

See `skills/performance-budget/SKILL.md` for the 7-step procedure and `templates/performance-report-template.md`.

### Accessibility audit — WCAG findings in the gate

Runs automatically after QA on `full`, `quick`, and `hotfix` tracks.

- Gate records WCAG finding counts by severity: critical / serious / moderate / minor
- Records `audit_method` (axe-core, pa11y, Lighthouse) and `components_audited`

### Polyglot QA — verify every detected test suite

Orchestrator stamping at pre-review and QA discovers and runs all applicable project
test suites: `npm test` when `package.json` has `scripts.test`, pytest when pytest
configuration or conventional Python test files are present, and `go test ./...` when
`go.mod` is present. Independent suites run with bounded concurrency while stamped
results stay in stable order; `pipeline.verify.test_concurrency: 1` serializes fragile
projects, and configured `resource_group` values keep shared browser/database/port-bound
suites exclusive. Every suite must pass. The gate's
`_orchestrator_stamped.runs.test.suites` records each command, exit code, duration,
resource group, output-truncation flags, and verification receipt provenance. Successful
orchestrator-run commands mint content-addressed receipts keyed by command, suite,
purpose, workspace bytes, verify config, material env/toolchain data, and Stagecraft
version; later stamps reuse them only when the full key matches. One failing language
adds a named blocker without preventing the remaining suites from running. Set
`pipeline.verify.test_command` for an exclusive custom command, `null` to disable test
discovery, or `pipeline.verify.receipts: false` to force fresh execution. See
[Testing](TESTING.md#target-project-test-discovery).

### Observability gate — confirm metrics, logs, and traces are wired

Platform role verifies that observability signals are actually in place before sign-off.

- Gate carries `required`, `verified`, and `gap` arrays for metrics, logs, and traces
- Records the `verification_method` used
- Warns when the verification method is too weak to be trusted
- Tracks: `full`, `hotfix`

### Documentation gate — PM must confirm doc coverage at sign-off

At Stage 7 (PM sign-off), the PM classifies whether the change touches a **user-visible surface** — a CLI flag, config key, API endpoint, or user-visible behaviour change — and must confirm that the appropriate documentation has been updated.

- `docs_surface_affected` (bool) records the classification; `docs_updated` (bool) records whether the required update was completed; `docs_skipped_reason` (string) records the waiver rationale for internal-only changes
- `docs_updated: false` with `docs_surface_affected: true` is a gate **blocker** — the PM cannot sign off until docs are updated
- Internal refactors, tests, and infrastructure changes require only a one-line skip reason; no doc update is mandated
- Auto-fold from Stage 6 checks the git changed-file set; if user-visible source/CLI/config paths changed and no docs/changelog path changed, auto-fold is blocked and the PM is invoked to resolve it

The pattern mirrors `runbook_referenced` (Stage 8): the gate cannot PASS without an explicit answer.

### Migration safety — untested rollbacks halt the pipeline

Fires conditionally when the heuristic detects data-layer changes (migration files, schema files, DDL fragments like `ALTER TABLE`).

- Walks six questions per migration: what it does, breaking or not, backfill required, dual-write required, rollback plan, rollback tested
- **Has veto power**: an empty rollback plan, an untested rollback on a breaking change, or a missing backfill strategy each auto-veto and halt the pipeline — regardless of who approved the change

See [`docs/migration-safety.md`](migration-safety.md) for the veto criteria, gate fields, and routing guidance.

### Pluggable deploy adapters — pick the right deploy primitive per project

Stage 8 (deploy) is adapter-driven. Projects declare their deploy target in `.devteam/config.yml`; `dev-platform` reads the adapter's markdown and follows it step by step.

```yaml
deploy:
  adapter: cloud-run          # or: gizmos, docker-compose, kubernetes, terraform, custom
  environment: production
  smoke_test_path: /healthz
```

Six adapters ship:

| Adapter | Suits |
|---|---|
| `docker-compose` (default) | Local dev, demo, single-host deploy |
| `kubernetes` | K8s clusters via `kubectl` / Helm |
| `terraform` | IaC-managed infra on any cloud |
| `cloud-run` *(Phase 13.1)* | GCP Cloud Run via Artifact Registry + `gcloud` |
| `gizmos` *(Phase 13.2)* | Gizmos platform (Cloudflare Workers, `gizmos.run`) |
| `custom` | Project-specific script (escape hatch) |

Every adapter follows the same contract: read the PM sign-off gate, build and deploy, run smoke tests, estimate the recurring cost delta, write `pipeline/gates/stage-08.json` with `deploy_completed`, `smoke_tests_passed`, `rollback_executed`, `cost_delta_estimated`, `cost_delta_multiplier`, and `cost_gate_override`, and reference `pipeline/runbook.md` for recovery. A 10x-or-greater cost increase must FAIL unless explicit human approval is recorded in `cost_gate_override_reason`. On failure: write a `FAIL` gate with a blocker, never auto-rollback.

The `cloud-run` adapter builds a Docker image, pushes to GCP Artifact Registry, deploys a new Cloud Run revision, smoke-tests the live URL via `curl`, and records the active revision name for rollback. The `gizmos` adapter pushes source code to the Gizmos platform (Cloudflare Workers, `gizmos.run`) via `gizmos push` — no Docker image required. Precondition checks include `wrangler.toml` existence, `app`/`name` field match, runbook `§Rollback` presence, and `GIZMOS_API_KEY` env var. Platform constraints (TS/JS or Python only, no persistent filesystem, stateless `fetch()` handler) are documented in `core/deploy/gizmos.md §Platform constraints`.

#### Adapter conventions — platform constraints injected into `pipeline/context.md` (Phase 15.2)

When `deploy.adapter` is set, Stagecraft automatically writes a deploy-target context block into `pipeline/context.md` before stages 01 (requirements), 02 (design), and 03 (build) dispatch — via both `devteam run` and `devteam stage`. This means `--feature` strings can express pure intent ("URL shortener with KV storage") rather than repeating stack details already implied by the adapter config.

The block is written by `seedDeployContext()` in `core/driver.js`, is idempotent (a second call replaces rather than duplicates the block), and is scoped between `<!-- devteam:deploy-target:begin -->` / `<!-- devteam:deploy-target:end -->` markers. Two adapters have companion conventions files:

- `core/deploy/gizmos.conventions.md` — language/runtime, required file structure (`src/index.ts`, `wrangler.toml`), no-build-step rule, `git ls-files` tracking requirement, secrets model (Gizmos Hub UI only), and health check requirements (`GET /` and `GET /healthz`)
- `core/deploy/cloud-run.conventions.md` — runtime (any Docker-supported language), required `Dockerfile`, `PORT` env var, state/persistence model (Cloud SQL/Spanner/GCS/Memorystore), and health check requirement (`GET /healthz`)

Additional adapters can add a `core/deploy/<adapter>.conventions.md` file to participate in auto-injection.

To clear all `<!-- devteam:*:begin/end -->` sections from `pipeline/context.md` at once (the deploy-target block plus any run-blocker, red-team-blocker, or advise sections), run `devteam compact`. The sections are re-seeded on the next run when still needed.

See [`core/deploy/README.md`](../core/deploy/README.md) for the full adapter contract and instructions for writing project-specific adapters.

---

## Safety and auditability

Two categories of guarantee: things Stagecraft prevents from happening, and things it always records so any AI decision can be explained and replayed.

### Filesystem-level `allowedWrites` enforcement — cross-workstream writes caught on all hosts

Each build workstream's prompt declares `allowedWrites`, which is the set of paths that workstream is permitted to touch. Enforcement method depends on the host:

- **claude-code**: blocks unauthorized writes at tool-call time via its `PreToolUse Write|Edit` hook. The write never reaches disk.
- **codex and gemini-cli**: run a post-hoc git-status diff after the workstream exits. Any file outside `allowedWrites` is captured in `writeViolations[]` and the orchestrator patches the gate to `FAIL` with violations listed in `blockers[]`.

The `generic` adapter declares `prompt-only` enforcement: violations are discouraged but not technically blocked.

`writeViolations[]` appears in the orchestrator's result when violations are found; it is merged into the gate `blockers[]` so `devteam next` reports `fix-and-retry`.

### Role tool budgets — per-role tool-surface restriction

Each role has a declared tool budget — the list of tools it may use during its workstream. The host-neutral budget is declared in `core/roles.js` and propagated through the dispatch descriptor so every host can apply it. Claude Code's `ROLE_FRONTMATTER` adds host-specific rendering metadata such as model and permission mode.

Enforcement method depends on the host:

- **claude-code** (`enforces.tool_budget: "native"`): the subagent `tools:` YAML line limits the tool surface at the tool-call boundary. The model cannot call undeclared tools; no prompt instruction needed.
- **codex, gemini-cli, generic** (`enforces.tool_budget: "prompt-only"`): the tool budget is injected as an advisory section in the stage prompt. The model is told which tools to prefer and which to avoid; violations are not technically blocked.

At dispatch time, the orchestrator warns (not blocks) when a budget-carrying role is routed to a prompt-only host, so operators can see the enforcement gap in `devteam plan` output. Gate files carry a `dispatched_tool_budget` field (orchestrator-stamped for headless runs; auto-injected by the validator for user-driven runs) recording what the role was *permitted* to do — extending the audit trail beyond *what it wrote*.

Current budgets by role (higher-trust roles get broader surfaces):

| Role | Tools |
|---|---|
| pm | Read, Write, Glob |
| reviewer | Read, Write, Glob, Grep |
| principal | Read, Write, Glob, Grep, Bash |
| backend / frontend / platform / qa | Read, Write, Edit, Glob, Grep, Bash |
| auditor / red-team / migrations / verifier | Read, Glob, Grep, Bash, Write |

### Capability-required permissions — stages declare what they need; adapters declare what they have

Four stages require shell execution to do their work: pre-review (stage-04a), qa (stage-06), verification-beyond-tests (stage-06d), and deploy (stage-08), plus the new performance-budget (stage-06e). Each declares `requiredCapabilities: { shell: true }` in `stages.js`.

At dispatch time, `assertCapabilities()` in the orchestrator checks that the routed host's adapter declares the required capabilities. If not, the orchestrator throws a named error before invoking the host. This prevents silent failures where a stage appears to run but skips all shell-dependent checks because the host can't execute them.

All three primary adapters (claude-code, codex, gemini-cli) declare `enforces.shell: true`. The generic adapter does not; use `routing.stages` overrides in `.devteam/config.yml` to route shell-requiring stages to a capable host.

### Bounded workspace isolation — separate artifact trees per feature

When multiple features are in flight, enable bounded workspace mode so their pipeline artifacts stay separate:

```yaml
pipeline:
  isolation: bounded
```

With `isolation: bounded`, artifacts (gates, logs, context files) land under `pipeline/changes/<changeId>/` instead of the global `pipeline/`. The `changeId` is derived by slugifying the `--feature` value. `devteam next` and `devteam summary` can distinguish in-flight features; `devteam validate` reads `DEVTEAM_CHANGE_ID` from the environment to validate gates in the bounded directory. Default is `in-place`, which has no impact on existing setups.

### Secret scanning — blocks credentials from reaching the repo

Wired into claude-code's `PreToolUse Write|Edit` hook. Runs before every file write.

- Built-in patterns for AWS, GitHub, Anthropic, OpenAI, Google, Slack, Stripe, private keys, JWTs, and postgres URLs
- Path allowlist for `.env.example`, `docs/`, `examples/`, and test files
- Magic-comment override (`devteam-allow-secret:`) for confirmed false positives

### Audit trail — replay any AI decision and see what drifted

Gates optionally record the full reproducibility fingerprint for any stage: `model_version`, `temperature`, `seed`, `max_tokens`, `system_prompt_hash`, and `tools_hash`.

- `devteam reproduce <stage-id>` reads a gate, classifies replay readiness (full / partial / incomplete), prints recorded fields, and re-renders the current prompt to surface hash drift
- Designed to satisfy SOC 2 and EU AI Act audit requirements: the gate JSON is a complete record of how an AI decision was made

See [`docs/reproducibility.md`](reproducibility.md) for the gate fields, replay readiness classification, and drift-detection details.

### Tamper-evident gate chain — the audit record can't be quietly rewritten (C6)

Recording *what* decided a stage is only half the audit story; the record also has to be **tamper-evident**. Each stage-level gate carries `chain.prev_hash` — a canonical-JSON SHA-256 of its predecessor stage gate — so the gates form a linear chain (`stage-01 → … → stage-09`).

- Mutating any earlier gate changes its hash, so every gate downstream of it no longer matches what it recorded. `devteam verify-chain` recomputes the chain, **locates the break**, and exits non-zero (CI-usable).
- The hash covers the predecessor's full content including its own `chain` field, so the chain is transitive — re-stamping a tampered middle gate just moves the break downstream.
- Stamped automatically by the orchestrator (`mergeWorkstreamGates` for multi-role stages, `runStageHeadless` for single-role); `devteam stamp-chain` re-stamps after a deliberate earlier-stage re-run.
- Set `DEVTEAM_SIGNING_SECRET` to add an HMAC-SHA256 over each complete gate and its chain metadata. `devteam verify-chain --require-signed` (or `pipeline.require_signed_gates: true`) rejects unsigned gates, invalid MACs, and signatures that cannot be checked because the secret is unavailable.
- HMAC prevents an actor without the shared secret from rewriting and re-stamping history. Protecting the secret in CI and limiting who can invoke trusted stamping are part of the deployment security boundary; asymmetric KMS signing remains a separate extension.
- Makes the autonomous driver's authority records (which `--auto-rule` decision resolved which escalation) part of a tamper-evident trail — the EU AI Act / SOC 2 "who decided this, and was the record altered?" guarantee.

---

## Observability and learning

The pipeline records enough data to identify which model performs best for each role on your specific codebase, without manual analysis.

### Evidence readiness — measure before opening capability gates

`devteam evidence status` performs a read-only, bounded aggregation of local run logs
and gates for the #142–#145 capability thresholds. Explicit repeated `--bundle` inputs
add digest-validated, de-duplicated portfolio analysis. `devteam evidence export`
requires a new destination and `--consent`, writes only suppressed typed aggregates,
and never transmits them. After a human reviews a successful fix/retry,
`devteam evidence accept-resolution --yes` records one hash-bound, privacy-bounded
acceptance for H3 readiness; it never stores resolution text or learns a recipe. See
[Evidence Readiness](evidence.md).

### Cost and token tracking — know what each stage costs

Gates record `tokens_in`, `tokens_out`, `cost_usd`, `model`, and `duration_ms` per stage and per workstream.

- `npm run dashboard:cost` (or `scripts/dashboard.js --view cost`) rolls up by host, role, or stage
- Pricing table covers Claude, GPT, and Gemini families with exact and prefix-match lookup
- Workstream-level detail preserved in `workstreams[]` so host/role attribution is correct

See [`docs/cost.md`](cost.md) for the pricing table, dashboard flags, and budget workflow.

### OpenTelemetry tracing — every workstream emits spans

Standard OTel spans for every workstream, compatible with any collector. See `docs/observability.md` for the span schema and collector configuration.

### Gate-pass-rate dashboards — spot where the pipeline struggles

`npm run dashboard` aggregates `pipeline/gates/` across one or more projects.

- Groups by stage, host, role, and status; markdown report with ASCII bar chart or `--json` for tooling
- `--from p1,p2,...` for multi-project rollups; `--since YYYY-MM-DD` for time windows

### Per-role per-model performance scores — measure what actually works

`npm run performance` (or `scripts/performance.js`) computes, for each (role, host) pair:

- Dispatch count, first-try pass rate, mean retries to pass
- Total cost, mean cost, cost per pass, mean duration
- Pairwise comparisons when two or more hosts serve the same role

### Adaptive routing — let your own data reconfigure the pipeline

`npm run routing:suggest` reads performance scores, compares them against the current `.devteam/config.yml`, and proposes role-level host swaps.

- Minimum dispatch threshold (5 by default) and minimum pass-rate delta (10pp) prevent noisy suggestions
- `--apply` rewrites the config after a confirmation prompt; `--yes` skips the prompt for CI

### Project memory — the pipeline remembers what it has seen

Per-project semantic memory under `.devteam/memory/`. Uses a local embedder (`Xenova/bge-small-en-v1.5`, ~33 MB, lazy download) with a git-friendly JSON backend.

- Indexes briefs, design specs, ADRs, retros, lessons, runbooks, and audit reports
- `devteam memory ingest`, `query`, `stats`, `clear`, `reindex`

See [`docs/memory.md`](memory.md) for embedder options, the `.gitignore` note, and the opt-out marker.

### Org-shared lessons-learned — knowledge that travels across projects

Lifts ADRs and lessons from any project into a shared store at `~/.stagecraft/memory/` (overridable via `STAGECRAFT_ORG_MEMORY_DIR`).

- `devteam memory promote` copies current-project records into the org store
- `devteam memory query --org` searches across all contributing projects; results name their source project
- Idempotent — re-promoting the same record doesn't duplicate it
- Foundation for architecture continuity (see Advanced AI capabilities)

---

## Developer tools

### Core commands — the everyday loop

**`devteam prototype <start|build|note|promote>`** — pre-SDLC prototype mode
for fast learning before a change deserves delivery gates.

- `start` creates `pipeline/prototypes/<id>/` with `intent.md`,
  `build-prompt.md`, `feedback.md`, `promotion.md`, and `prototype.json`
- `build` runs the prompt through a headless host in the packet-local
  `workspace/` by default; `--apply-to-project` is the explicit escape hatch
  for prototype changes that should touch the project root
- `note` appends demo or stakeholder feedback to the packet
- `promote` writes the hardening command for a normal Stagecraft track, for
  example `devteam run --feature-file pipeline/prototypes/<id>/promotion.md --track full`
- Prototype packets are intentionally not gate evidence; they are committable
  learning records that make the later full/quick/hotfix run better informed

**Docker headless runner** — `hosts/docker/` packages the normal `devteam` CLI
into a non-root container for unattended local orchestration.

- Build with `docker build -f hosts/docker/Dockerfile -t stagecraft-runner .`
- Run against a mounted project, for example
  `docker run --rm -v "$PWD:/workspace" stagecraft-runner run --cwd /workspace`
- Keeps `.devteam/`, `pipeline/`, gates, logs, and run-state files on the
  mounted project volume
- Reports active or stale `pipeline/run.lock` files with resume/force guidance;
  explicit stale-lock removal requires `STAGECRAFT_RUNNER_CLEAR_STALE_LOCK=1`
- Credentials enter only at runtime through env vars, env files, Docker secrets,
  or a supervisor's secret manager
- The base image is host-neutral; `openai-compat` is the no-extra-CLI path, and
  teams can layer CLI/runtime hosts such as Claude Code, Codex, Gemini CLI, or
  Omnigent in derived images

**`devteam assess [--description "..."] [--json] [--apply] [--confirm] [files...]`** — rule-based track recommendation before starting a run.

- Analyzes description keywords and file/content heuristics (security patterns, migration files, config-only paths) to recommend a track
- Priority order: hotfix keywords → dep-update → config-only → nano → quick → full (default)
- Heuristic overrides: migration-safety-required bumps lighter tracks to full; security-required bumps nano to quick
- **Default (no flags):** writes `pipeline/track.json` with the inferred track and `source: "inferred"` — per-run provenance record read by `devteam run`
- **`--confirm`:** writes `pipeline/track.json` with `source: "human"` — use after verifying the recommendation; silences the unconfirmed-track guard in `devteam run`
- **`--apply`:** writes `pipeline.custom_stages` to `.devteam/config.yml` (project-wide setting) so `devteam next`/`devteam summary`/`devteam stage` use the custom track; orthogonal to `pipeline/track.json` behavior
- `--json` emits structured output including recommended track, rationale, and which heuristics fired

**`devteam standards discover [--cwd <dir>] [--json] [--dry-run] [--force]`** — static analysis of a project's conventions.

- Scans the project file system and writes `docs/project-conventions.md` with seven detected properties: tech stack (JS/TS/Python/Go/Rust), module system (ESM/CJS/mixed), file layout (top-level dirs + source subdirs), naming style (kebab/PascalCase/camelCase/snake_case plurality), tooling (TypeScript/ESLint/Prettier/Biome/Husky/EditorConfig), test configuration (framework, co-location, pattern), and most-used imports (top 10 by frequency, skipping builtins)
- `--dry-run` prints without writing; `--json` emits the structured discovery result; `--force` overwrites an existing file
- Pure static analysis — no external processes, no network, no AI. Reads manifests, source files, and config files only
- Add `docs/project-conventions.md` to your AGENTS.md or readFirst lists to inject discovered conventions into agent prompts

**`devteam commit [--all] [--dry-run] [--message <msg>] [--json]`** — stage exactly the right pipeline artifacts and commit. (Phase 12.2, ADR-010)

- Reads `pipeline/run-state.json` and determines which stages have not yet been committed (via an idempotency cursor, `last_committed_stage_index`)
- Stages the gate file for each completed stage (PASS or WARN) plus the stage's named output files (brief.md, design-spec.md, spec.feature, code-review/, test-report.md, etc.) — never `git add -A`
- Volatile runtime files (`run-state.json`, `run.lock`, `run-log.jsonl`, logs/, gates/archive/, etc.) are excluded unconditionally, even if they somehow appear in an artifact slot
- Generates a commit message: `"pipeline: stages NN–NN PASS"` (or `"pipeline(repair): ..."` for repair runs) with a `Co-Authored-By: Stagecraft` trailer
- Prompts `y/n/e` before committing; `--dry-run` prints the file list without prompting; `--all` ignores the cursor and re-stages everything; `--message` overrides the generated subject
- Calling it twice is safe: the second call prints "nothing to commit"
- Limitation: supports in-place pipeline mode only (changeId=null); bounded-workspace (B9) support is a Phase 12.3+ follow-on

**`devteam init`** — set up a project for the first time.

- Writes `.devteam/config.yml`, lays down role briefs, rules, skills, and the `/devteam` slash command for the chosen host
- Writes (or updates) a managed `# BEGIN stagecraft` / `# END stagecraft` block in `.gitignore` listing all volatile Stagecraft runtime files — run once and your `.gitignore` is machine-maintained; re-running updates an outdated block
- `--host claude-code | codex | gemini-cli | generic`
- **`--adapter <name>`** (Phase 15 pre-work, PR #173) — sets `deploy.adapter` in `.devteam/config.yml` and writes adapter-specific config hints (`gizmos`, `cloud-run`, `docker-compose`, `kubernetes`, `terraform`, `custom`). Combined with Phase 15.2, this means `devteam init --adapter gizmos` immediately enables automatic conventions injection into `pipeline/context.md` for all subsequent runs.
- **`--profile dogfood`** (Phase 14.1) — when dogfooding Stagecraft against its own source tree, adds four safeguards: a supplemental `# BEGIN stagecraft-dogfood` gitignore block covering generated pipeline documents (`brief.md`, `context.md`, `spec.feature`, `runbook.md`, `test-report.md`, `code-review/`), a pre-commit hook that blocks accidental commits to `core/`, `bin/devteam`, `pipeline/stages/`, `roles/`, or `rules/`, a `pipeline/stages/deploy.md` entry in `.git/info/exclude`, and a `profile: dogfood` marker in `.devteam/config.yml`. All writes are idempotent.

**`devteam doctor`** — verify everything is wired up before you start.

- Checks the Stagecraft install, each declared host CLI is reachable, and roles/rules/skills are correctly laid down
- Prints a green/red checklist; fix what's red before running a stage
- Reports local embedding availability as informational (`ℹ`) — absence is not a failure; run `npm install @huggingface/transformers` to enable `devteam memory` with the default local embedder
- Runs natively on Windows; the Node 22 Windows CI smoke covers CLI startup, initialization, diagnostics, quoted host commands, PATHEXT-aware executable discovery, and timeout termination. WSL2 remains available for POSIX-oriented host CLIs and project toolchains
- **Dogfood mode section** (Phase 14.2) — when `.devteam/config.yml` contains `profile: dogfood`, a "Dogfood mode" section appears after the Adapters section with six checks: pre-commit infrastructure guard present, hook executable, `# BEGIN stagecraft-dogfood` block in `.gitignore`, `pipeline/stages/deploy.md` in `.git/info/exclude`, no `npm publish` script (⚠ warn), and a budget-usd reminder (ℹ info). Absent when the profile is not set.

**`devteam next [--json] [--skip-advise]`** — find out what to do next.

- Reads the last gate in `pipeline/gates/`, interprets its status, and tells you what to run or what to fix
- The main command in the interactive loop
- Every non-pass action carries a **`failure_class`** so you know *how* to respond: `code-defect` (change code, re-run), `state-corruption` (gate unreadable — repair it, don't re-run), `external-blocked` (a human/external action is required), `judgment-gate` (escalation — make a ruling), `convergence-exhausted` (retry budget spent → escalate). Surfaces a typed `PRINCIPAL-CANNOT-DECIDE` question directly when one is written
- `--json` adds a `schema_version` for programmatic callers (the autonomous driver)

**`devteam advise [--apply <decisions>] [--json]`** — triage deferred findings.

- Advisory panel for `noted_for_followup[]` items across all completed gate files
- Classifies each item: `QA_BLOCKER` (missing AC coverage in spec.feature), `PEER_REVIEW_RISK` (high-severity, no AC ref), `QA_NOISE` (timing/flakiness keywords), `INFO`
- Generates ranked options (scaffold, defer, amend, nothing, known-flaky, wontfix) per item
- `--apply AC-11=A,AC-10=B:PROJ-123,AC-12=A` encodes stage manager decisions into `pipeline/context.md` as advisory markers
- Downstream stages respect the markers: QA skips coverage checks for `DEFERRED:` items, retries `KNOWN-FLAKY:` tests once; peer-review notes `BRIEF-AMEND-NEEDED:` entries
- Idempotent: re-running `--apply` replaces the advisory section without duplicating entries
- See [`rules/advise.md`](../rules/advise.md) and [`docs/runbooks/fix-and-retry.md` § Case 11](runbooks/fix-and-retry.md#case-11-advise-workflow--triage-follow-up-items-before-downstream-stages)

**`devteam preflight`** — run pre-peer-review mechanical checks standalone.

- Runs git hygiene (committed-but-ignored files), import path validation, and deferred-items risk check
- **Staged pipeline artifact guard** (Phase 14.3) — blocks a PR if any file from the pipeline artifact list (`pipeline/brief.md`, `pipeline/gates/`, `pipeline/code-review/`, etc.) appears in the git index; applies to all projects, not just dogfood mode. Run `git restore --staged <files>` to clear the blocker.
- Auto-invoked by `devteam stage peer-review`; use standalone for early feedback
- Writes `pipeline/gates/stage-04e.json`; see [Case 10](runbooks/fix-and-retry.md#case-10-preflight-stage-04e-fail--committed-ignored-files-or-broken-import-path) for fix steps

**Headless mode** — run a stage end-to-end without touching the chat.

- `devteam stage <name> --feature "..." --headless` spawns the host CLI, pipes the rendered prompt to its stdin, waits for the gate, and exits
- Combine with `devteam next` to chain stages in a script

**`devteam run [--feature "..."] [--repair "<symptom>"] [--repair-at <file>:<line>] [--track <t>] [--until <s>] [--budget-usd X] [--timeout-ms N] [--retry-delay-ms N] [--auto-rule <classes>] [--allow-stage <s>] [--max-iterations N] [--resume] [--force] [--json] [--auto-commit] [--watch]`** — drive the whole pipeline unattended. See the **Autonomous pipeline execution** section under Advanced AI capabilities (and [`docs/runbooks/autonomous-run.md`](runbooks/autonomous-run.md)) for the full behavior.

- Loops `next → dispatch → merge` to completion; auto-fixes `code-defect` failures and retries transient dispatch blips
- Halts cleanly for a human at the consequence ceiling, on un-granted escalations, a budget cap, or a structural failure
- Writes `pipeline/run.lock`, `run-state.json`, and an audit-trail `run-log.jsonl`
- **`--repair "<symptom>"`** — bug-fix intent mode (ADR-009). Orthogonal to `--track`; defaults to hotfix depth. Auth/payments/migration symptoms auto-upgrade to full via the stoplist. Mutually exclusive with `--feature`. Automatically routes through a **diagnosis stage** (see below) before build; the diagnosed `affected_files` list activates the structural scope gate. The build runs in **PATCH MODE** (`renderPatchBlock` injects a `⚠️ PATCH MODE — targeted fix only` block so the AI scopes its changes to the diagnosed files). Run-state records `intent: "repair"` and `repair: "<symptom>"`; every run-log event carries the intent tag.
- **`--repair-at <file>:<line>`** — escape hatch for when you already know the defect location. Comma-separated `file:line` pairs (e.g. `src/auth.js:42,src/session.js:18`) seed the affected-files list directly, write a synthetic PASS stage-01 gate, and skip the LLM diagnosis dispatch entirely. Combine with `--repair` to bypass the diagnosis stage while retaining PATCH MODE scoping and the scope gate.
- **Budget cap warning (Phase 14.4)** — when `devteam run` starts without `--budget-usd`, a two-line advisory is written to stderr before the first dispatch: `[devteam run] Warning: no --budget-usd cap set. The run will not halt on spend.` / `Use --budget-usd <amount> to prevent runaway cost.` Does not affect pipeline behavior or exit codes.

**Dogfooding guide — Phase 14.5. Phase 14 complete.** [`docs/guides/dogfooding.md`](guides/dogfooding.md) covers the complete workflow for running Stagecraft against its own source tree: prerequisites, one-time setup with `devteam init --host claude-code --profile dogfood`, per-feature workflow (branch → `devteam run --budget-usd` → review → commit → clean up), recommended budget table by pipeline depth, explanation of the pre-commit infrastructure guard, failure-mode table, and expected `devteam doctor` output for the "Dogfood mode" section.

### Repair mode diagnosis stage — stage-01 produces a DIAGNOSIS in repair mode (ADR-009 Phase 2)

When `devteam run --repair` is used, stage-01 (requirements) switches its artifact from a feature brief to a **DIAGNOSIS** document. Same stage, same gate file path, fix-aware output — no new stages, no parallel pipeline.

- **Diagnosis document** (`pipeline/diagnosis.md`): root cause with specific `file:line` references, proposed fix, every file the fix must touch (`affected_files`), and a regression criterion the executable-spec stage can translate into a runnable test.
- **Judgment gate**: the diagnosis gate is always ESCALATE-shaped — it requires explicit human approval or `--auto-rule diagnosis-approved` before the build proceeds. This prevents the AI from autonomously proceeding on an incorrect root-cause assessment.
  - Interactive mode: the gate lands as an ESCALATE; `devteam next` shows the judgment question before you proceed.
  - Autonomous mode: `--auto-rule diagnosis-approved` grants the driver permission to auto-rule the diagnosis; the Principal issues a `PRINCIPAL-RULING: ... [class: diagnosis-approved]` line and the run continues.
- **Scope gate activation**: once stage-01 PASSes (after approval), the driver reads `affected_files` from the diagnosis gate and stores it in run-state. The structural scope gate — which was wired in Phase 1 but inert without a list — now FAILs any build that writes files outside the diagnosed set.
- **`--repair-at` escape hatch**: when the defect location is already known, pass `--repair-at src/auth.js:42` to seed `affected_files` directly and skip the LLM diagnosis dispatch. A synthetic PASS stage-01 gate is written so `next()` advances past requirements immediately.

### Repair mode reproduction stage — stage-03b in repair mode (ADR-009 Phase 3)

When `devteam run --repair` is used, stage-03b (executable-spec) is injected into the stage order immediately before build — even on hotfix depth, which previously skipped it. The stage author writes a **failing-first regression scenario** for the reported bug: a Gherkin Scenario that exercises the defect so the regression test is RED before the fix and GREEN after.

- **Tri-state `reproduced` gate field**: set by the agent; verified by the orchestrator stamp.
  - `true` — bug reproduced; a runnable failing test was written.
  - `false` — could not reproduce the defect at all.
  - `"unverifiable: <reason>"` — an automated test is impossible (external API, nondeterminism, data dependency). Stamp emits a loud `WARN reproduction-unverifiable` and continues without blocking.
- **Stamp verification (not agent-asserted)**:
  - `stampStage03b` captures the pre-build test baseline (`reproduction_pre_build` audit record). If unverifiable, the baseline is skipped; the WARN is embedded in the gate.
  - `stampStage04a` finalizes `reproduced` on the stage-03b gate after the post-build test run: `red_before_confirmed` (pre-build failed) + `green_after_confirmed` (post-build passed) confirm the regression test actually turned green. Written to `reproduction_verification` in the stage-03b `_orchestrator_stamped.runs`.
- **No double-inject on full track**: stage-03b is already in the full track order; the driver filters it out before re-injecting it at the correct position (immediately before build).
- **`--repair-at` still includes it**: the escape hatch skips diagnosis but not the reproduction stage.

### Repair mode vocabulary and operator runbook (ADR-009 Phase 4)

The authoritative term map lives in [docs/conventions.md](conventions.md#repair-mode-vocabulary-adr-009-decision8): it distinguishes `--repair` (intent), `hotfix` (track depth), `fix-and-retry` / `fix_steps` (internal self-correction machinery), and PATCH MODE (build-scoping mechanism). The runbook at [docs/runbooks/repair-flow.md](runbooks/repair-flow.md) covers the three operator decision points: diagnosis gate approval (interactive or `--auto-rule diagnosis-approved`), scope-gate FAIL recovery, and tri-state reproduction handling.

### Inspection and power tools

**`devteam validate`** — confirm gate files haven't been edited by hand.

- Validates all gates in `pipeline/gates/` against their JSON schemas
- Used in CI; fails if any gate is invalid

**Web UI** — a live dashboard of your pipeline as it runs.

- `devteam ui --open` starts a local server at `http://127.0.0.1:3737/`
- Stage rows show PASS / WARN / FAIL / ESCALATE status; updates live via SSE as gate files land
- Click a row for gate detail and raw JSON; click a role chip to read its brief inline
- Zero build step, zero new production dependencies; loopback-only by default
- Model-authored gate values are rendered as text, not executable markup; responses
  carry a restrictive Content Security Policy and related browser hardening headers

**`devteam replay <stage-id>`** — re-run a past stage and see what changed.

- Re-runs a recorded stage with current config, writes the new gate to `pipeline/gates/replay/`
- Diffs the result against the original: status, blockers, cost/tokens/duration, reproducibility fields
- `--dry-run` shows the plan and prompt-hash drift without invoking the host
- **Crash-safe:** the original gate is snapshotted to `pipeline/gates/.replay-backup/` before dispatch and restored from disk on any exit — a crash mid-run no longer silently replaces the original; leftover backups from a prior crash are detected and reported on next invocation

**Codebase audit** — a full read-only analysis of any project.

- `/audit` in Claude Code runs four phases: Bootstrap → Health Assessment → Deep Analysis → Roadmap
- Produces 11 output files in `docs/audit/`; resume-aware via `docs/audit/status.json`
- `/audit-quick` runs phases 1–2 only for a faster assessment

### Generated reference documentation

Machine-derived docs stay in sync with the codebase by construction — a CI advisory fires when committed output diverges from a fresh generation.

**`npm run docs:generate`** regenerates three reference files:

- **[`docs/reference/stages.md`](reference/stages.md)** — full stage table (ID, roles, conditionalOn, gate files, artifacts, grouped by phase). Source of truth: `core/pipeline/stages.js`.
- **[`docs/reference/hosts.md`](reference/hosts.md)** — capability and enforcement matrix across all four adapters. Source of truth: `hosts/*/capabilities.json`.
- **[`docs/reference/cli.md`](reference/cli.md)** — full CLI reference per command: synopsis, flag table (name, type, description), and registry order. Source of truth: the per-command flag schemas in `core/cli/commands/`.

**`npm run prompt:budget`** regenerates:

- **[`docs/reference/prompt-budget.md`](reference/prompt-budget.md)** — per-stage framework context size in bytes and estimated tokens (bytes ÷ 4), plus the top-5 heaviest files per stage. Used to track readFirst weight over time; a CI advisory fires when any stage grows >10% from its committed baseline.

**`npm run consistency`** — cross-artifact consistency checker. Catches prose-vs-code drift across stage names, track lists, command surface, referenced-file existence, file-size ceilings, schema vocabulary, runtime/platform support claims, and EXAMPLE.md freshness. Runs in CI; advisory-only checks print without failing the build; hard checks exit non-zero. Audit and historical archives are excluded from current-fact vocabulary checks.

---

## Integrations

Surface pipeline state in the tools your team already uses. The integration approach is to validate and publish gates produced locally, rather than running the pipeline itself in CI. LLM pipelines are expensive and human-in-the-loop by design.

### GitHub PR integration — pipeline state as PR checks

`scripts/pr-publish.js` posts pipeline state via the `gh` CLI. Two modes:

- `body` — replaces the PR description with a formatted pipeline summary
- `checks` — posts each gate as a GitHub check run: PASS → success, WARN → neutral, FAIL/ESCALATE → failure

Auto-detects repo and PR from the current branch. `--dry-run` previews without API calls.

### GitHub Actions workflow — validate gates on every PR

`devteam ci install` drops a reusable workflow into `.github/workflows/`.

- On PR: validates `pipeline/gates/` against schemas, posts each gate as a check run, runs `devteam reproduce` as an advisory drift check
- Skips cleanly when the PR doesn't touch `pipeline/`
- `devteam ci show` previews the template before installing

See [`docs/ci.md`](ci.md) for the full workflow template and environment variable reference.

---

## Advanced AI capabilities

These capabilities perform work that static tooling cannot replicate. They depend on the pipeline being AI-native.

### Autonomous pipeline execution (`devteam run`) — drives the pipeline to completion

A deterministic code loop around `devteam next` that advances the pipeline unattended and **halts cleanly the moment a human is genuinely needed**. The loop itself is code; the only LLMs are the workstream agents it dispatches (and, at escalation, the Principal). The human shifts from *mechanical sequencer* to *authority grantor*. Built on a **typed failure model** ([ADR-003](adr/003-bounded-autonomous-execution.md)).

- **Auto-fixes machine-diagnosable failures.** On a `code-defect` it clears the failing gate, writes the blockers into `pipeline/context.md` as cross-stage context, and re-dispatches — bounded by `autonomy.max_retries` (default 2). Transient dispatch failures (no gate written) back off and retry; structural ones (clean exit, no output) halt.
- **Progress-based convergence.** Before each fix-and-retry the driver archives the failing gate to `pipeline/gates/archive/<stage>.attempt-N.json`. If normalized blocker fingerprints are identical across two consecutive archived attempts the breaker trips immediately — spends no more retries on a stuck stage and surfaces what didn't change (`"blocker 'X' identical across attempts 1,2"`) so the escalation context is actionable. The count ceiling (`max_retries`) remains as a backstop for the first retry.
- **Consequence ceiling.** Never advances *into* `sign-off` (stage-07) or `deploy` (stage-08) — irreversible/outward-facing stages — without an explicit `--allow-stage` grant.
- **Bounded autonomous escalation resolution.** By default every escalation halts for a human (the Principal isn't even dispatched). Opt in with `--auto-rule <classes>` — a **CLI-only, allowlist-only** grant of bounded ruling categories (e.g. `formatting-only`, `doc-only`). The driver then auto-applies a Principal ruling whose `[class:]` is granted, and **never** crosses the hard stops: a typed `PRINCIPAL-CANNOT-DECIDE` (missing authority / information / value), the consequence ceiling, or `convergence-exhausted`. A given escalation is auto-ruled at most once.
- **Safety rails.** An exclusive `pipeline/run.lock`, resumable `run-state.json` (`--resume`), a pre-dispatch `--budget-usd` cap, a per-stage `--timeout-ms`, and a `--max-iterations` guard.
- **`--auto-commit` — unattended commit after a clean halt (Phase 12.3, ADR-010).** When passed, the driver automatically commits pipeline artifacts after a clean halt (`ceiling`, `--until`, `budget`) using the same algorithm as `devteam commit` — no interactive prompt. Non-clean halts (`fix-and-retry`, `resolve-escalation`, `structural-input`, etc.) never trigger auto-commit. On commit failure the run's exit code is unchanged; a warning is emitted to stderr and `auto-commit-failed` is logged to `run-log.jsonl`. Nothing to commit → `auto-commit-skipped` logged and the halt proceeds normally.
- **Run plan preview (Phase 26 / #316).** Before dispatch, non-JSON `devteam run` prints the effective track/custom plan, included/total stage count, configured skip count, conditional-stage count, and base workstream count. The same typed `run-plan` event is written to `run-log.jsonl` so tools can answer "how big is this run?" without parsing terminal prose.
- **Audit trail.** Every transition — including each auto-fix, deterministic skip, and auto-ruling with its `grant_class` and authority — is appended to `pipeline/run-log.jsonl`. Autonomous dispatches also append a privacy-bounded `dispatch-observation` per non-skipped workstream (stage, role, host, model, status, gate-written/timeout flags, and optional numeric cost/duration), giving `devteam evidence` durable routing history without copying free-form gate text. Explicit accepted-resolution events bind a human decision to a successful retry using only typed categories and hashes.
- **Liveness heartbeat + observe-only stall detection (ADR-007 Tier 1).** A `heartbeat` event is emitted to `run-log.jsonl` (and via `onEvent`) at the start of every driver loop iteration, bounding the last-event age. Alongside each dispatch a fire-and-forget stall probe watches for silent hangs: it emits `stall-detected` (`stall_class: "observed"`) when neither the workstream log (`pipeline/logs/`) grew ≥ 512 bytes nor any gate updated within 5 minutes — the dispatch is never killed (observe-only; no `Promise.race`). Config: `autonomy.stall_threshold_ms` and `autonomy.stall_min_growth_bytes` in `.devteam/config.yml`. Query a snapshot with `devteam status --verbose`, or use `devteam run --watch` for rolling stage, active/last workstreams, gate/log pointers, dispatch-time, log-growth, heartbeat-age, and stall status. Watch mode redraws only on an interactive terminal and preserves line-oriented output when redirected; redirected line progress still includes per-workstream start/finish lines.
- **Critical-path report (Phase 26 / #313).** `devteam performance critical-path` reads `run-log.jsonl` plus orchestrator-stamped gates and reports dispatch wall time, merge time, retry delay, summed workstream compute, estimated parallel savings, telemetry coverage, and repeated verification-command candidates. JSON output is available for p50/p95 baselines across real projects.
- **Advisory sweep on completion + `--fail-on-advisory` (ADR-008).** After `pipeline-complete` the driver runs an in-process advisory sweep (reusing `core/advise.js`: `QA_BLOCKER` / `PEER_REVIEW_RISK` / `A11Y_FIX`), adds `advisory_blockers_count` and `advisory_breakdown` to the `--json` summary, and prints a loud stderr line when blockers remain. Default exit is unchanged; opt in to exit **3** with `--fail-on-advisory` (QA_BLOCKER + A11Y_FIX threshold; `=all` adds PEER_REVIEW_RISK).
- Exit codes: `0` complete or a clean configured stop (`--until` / ceiling); `1` needs attention; `2` lock held; `3` `--fail-on-advisory` and blocker-class items remain.

See [`docs/runbooks/autonomous-run.md`](runbooks/autonomous-run.md) for the launch guide, halt reasons, and honest limitations.

### `/goal` injection — convergent headless stages loop until their objective is met

For `build` (stage-04) and `qa` (stage-06) stages, hosts that declare `capabilities.goalLoop: true` (claude-code and codex) automatically receive `/goal "<condition>"` prepended to the headless prompt. The condition is a workstream-specific exit criterion from `stages.js`; the host loops internally until its stated objective is met rather than running a fixed number of turns.

- Automatically active when: stage has a `goalCondition`, host declares `goalLoop: true`, and workstream runs headless
- Gemini CLI, Omnigent, openai-compat, and the generic adapter do not declare `goalLoop: true` — unaffected; receive the prompt unchanged
- Interactive (non-headless) runs are also unaffected

### Multi-model peer review — diversity as a correctness strategy

When `routing.review_fanout` is configured, Stage 5 (peer-review) duplicates each of the four area reviews across the listed hosts in parallel. 4 areas × 3 hosts = 12 parallel reviews; merge is pessimistic (any FAIL blocks the stage).

- Different training data produces different blind spots. The diversity comes from model family, not from changing the rubric.
- Each reviewer applies the same four-principles rubric; the cross-model signal is the value of fanout.
- This is execution-diversity, not method-diversity. For adversarial method, see the Red-team stage below.

### Closed-loop acceptance criteria → spec → tests — drift caught structurally

The PM writes numbered acceptance criteria (`AC-N`) in `pipeline/brief.md`. The chain is enforced end-to-end:

1. Stage-03b (executable-spec) translates each `AC-N` into one Gherkin scenario in `pipeline/spec.feature`, tagged `@AC-N`
2. Stage-06 (QA) maps each scenario 1:1 to a test
3. `devteam spec verify` checks all three are still in sync

Catches orphan ACs, orphan scenarios, duplicate AC numbers, and unknown AC refs in tests. `devteam spec generate` scaffolds the `.feature` file from the brief.

See [`docs/spec-authoring.md`](spec-authoring.md) for how to write AC-N criteria, scaffold the spec file, and interpret drift reports.

### Cross-artifact consistency analysis — catch incoherence the gate chain misses

Each gate can pass while the artifacts it governs silently diverge. `devteam consistency analyze` detects that class of bug in one pass.

- Walks the full artifact chain: `pipeline/brief.md` → `pipeline/spec.feature` → `pipeline/pr-*.md` → red-team gate → test-report → gate fields
- **Three drift classes checked**: AC-to-scenario (orphan acceptance criteria, orphan Gherkin scenarios), scenario-to-test (uncovered scenarios, unmapped test references), red-team-to-build (findings referencing files not touched by any workstream PR)
- Exit 0 = clean; exit 1 = drift found — safe to use in CI gates
- `--json` flag for structured output; fix recommendations printed per drift item when running interactively
- Builds on `devteam spec verify` (G2's AC↔spec↔test drift check) and extends it to the full artifact chain

Use `devteam consistency analyze` after every merge to catch cross-artifact drift before it reaches peer-review.

### Red-team stage — adversarial review before peer-review

A dedicated `red-team` role runs between build and peer-review on `full` and `hotfix` tracks. It is explicitly routed to a different host than the build agents.

- Walks 10 attack surfaces: input boundaries, state, sequence, integrations, auth edges, resource exhaustion, failure modes mid-operation, abuse cases, downstream effects, observability gaps
- Produces concrete reproducers, not observations; triage by severity × likelihood × scope
- `must_address_before_peer_review[]` in the gate blocks stage-05 until cleared

See [`docs/red-team.md`](red-team.md) for the 10 attack surfaces, gate fields, and how it differs from the conditional security review (stage 4b).

### Verification beyond tests — structural verification after QA

Full-track-only stage that runs after QA passes. The `verifier` role applies three methods to the changed code:

- **Property-based testing** (fast-check / hypothesis / proptest) — generates edge cases the author didn't think of; catches entire classes of bugs
- **Mutation testing** (Stryker / mutmut / mull) — introduces deliberate bugs and checks whether the test suite catches them
- **Formal verification** (TLA+ / Alloy / Lean) — optional, for functions where correctness is non-negotiable

A surviving mutant on a critical path, a property counterexample, or a formal counterexample populates `blocking_findings[]` and fails the stage. Skipped methods require a stated reason — "didn't have time" is not accepted.

See [`docs/verification-beyond-tests.md`](verification-beyond-tests.md) for candidate identification, gate fields, and skip-reason policy.

### Production feedback contract — close the brief→production SLO loop (G3)

After deploy, the operator copies `templates/production-feedback-template.md` to `pipeline/production-feedback.md` and fills in production signals — SLO/metric deltas vs. the brief's targets, incidents since deploy, adoption signals. No automated ingestion; the file is the integration point (Jira/Datadog automation can write it without framework changes).

- Stage 9 (retrospective) reads the file when present and adds a `## Production Deltas` section to `pipeline/retrospective.md`, recording which brief SLOs were met or missed and whether any incident suggests a promotable lesson
- Gate field `production_feedback_reviewed` records `true` (reviewed) / `false` (present but skipped) / `"absent"` (not present this run)
- `devteam next` on a completed pipeline mentions the file once as an optional follow-up when absent — not a nag, not a blocker
- Effort-1 by design: no automation, no new commands, no integrations. The file is the contract; automation plugs in later at the write side with no framework changes

See `docs/conventions.md` for the full file convention and `templates/production-feedback-template.md` for the scaffold.

### Architecture continuity — binding architectural decisions across projects

Prior architectural decisions become binding commitments across every future project in the org.

- `devteam architecture lookup "<topic>"` queries the org ADR store before a design stage
- The Principal role brief requires either honoring prior ADRs (cited in "Prior commitments considered") or explicitly superseding them with a new ADR carrying a `Supersedes:` field and rationale
- Silent disagreement with a prior ADR is forbidden by the role brief — it doesn't just fail a lint check, it's a role-level constraint
- Design gate records `adrs_consulted` and `adrs_superseded` for the audit trail

---

> All features above trace back to entries in [BACKLOG.md](./BACKLOG.md) where applicable.
