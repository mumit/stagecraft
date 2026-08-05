# Stagecraft

**Stagecraft is an orchestrator that runs your AI coding tool through a structured 18-stage pipeline.** PM writes the brief. Principal designs. Specialists build their areas. Reviewers critique. QA tests. Each stage produces an artifact and a machine-readable gate. The next stage cannot start until the gate passes. The full run is on disk: auditable, resumable, not buried in a chat log.

Works across **Claude Code**, **Codex CLI**, **Gemini CLI**, **Omnigent**, an **OpenAI-compatible API host**, and a **generic** no-host mode. One project, one config, one or more hosts. Different roles can run on different models — Claude for design, Codex for backend, Gemini for QA, Omnigent for meta-harness execution, Claude for review. The gate JSON is the contract.

```bash
devteam init --host claude-code        # one-time install in your project
devteam stage requirements --feature "Add SMS notification opt-in"
# or: devteam stage requirements --feature-file ./feature-brief.md
# (model writes brief + gate; hooks validate)
devteam next                           # → "▶️ run-stage design (stage-02)"
# … 16 more stages, then "🎉 pipeline-complete"
```

> The CLI binary is `devteam`. Stagecraft is the project; `devteam` is what you type.

## Table of contents

- [First 30 minutes](#first-30-minutes)
- [Documentation map](#documentation-map)
- [Why "Stagecraft"?](#why-stagecraft)
- [What this gives you](#what-this-gives-you)
- [Prerequisites](#prerequisites)
- [Quick start](#quick-start)
- [Which track?](#which-track)
- [What `devteam init` installs](#what-devteam-init-installs)
- [CLI reference](#cli-reference)
- [Auditing an existing codebase](#auditing-an-existing-codebase)
- [Architecture in one diagram](#architecture-in-one-diagram)
- [Repository layout](#repository-layout)
- [Design decisions](#design-decisions)
- [What's deferred](#whats-deferred)
- [Why this exists](#why-this-exists)
- [License](#license)

## First 30 minutes

If you're evaluating Stagecraft, this is the fastest path to a working answer:

1. **(5 min) Install the framework.** `git clone <this-repo> && cd stagecraft && npm install && npm link`. Verify with `devteam --help`.
2. **(2 min) Initialize a throwaway target project.** `mkdir /tmp/scratch && cd /tmp/scratch && devteam init --host claude-code`. Then `devteam doctor` should be all green.
3. **(3 min) Read [EXAMPLE.md](EXAMPLE.md).** One feature traced through all 18 stages with real CLI captures. Tells you what each stage actually does.
4. **(15 min) Run one full pipeline yourself.** The simplest path: run each stage with `--headless` and let the orchestrator drive Claude Code directly.
   ```bash
   devteam stage requirements --feature "a one-paragraph feature you understand" --headless
   devteam next   # tells you the next command to run
   ```
   Walk forward through design, build, peer-review, qa, sign-off. For deploy, pick a deploy adapter in `.devteam/config.yml` (`cloud-run`, `gizmos`, `kubernetes`, `terraform`, `docker-compose`, or `custom`) — or write the gate by hand to skip the deploy step: `echo '{"stage":"stage-08","status":"PASS","track":"full","timestamp":"'$(date -u +%FT%TZ)'","blockers":[],"warnings":[]}' > pipeline/gates/stage-08.json`.
5. **(5 min) Inspect the audit trail.** `ls pipeline/gates/` — every stage's outcome on disk. `cat pipeline/brief.md`, `pipeline/design-spec.md`, `pipeline/code-review/by-*.md`. The pipeline is reconstructable from these files alone.

If after 30 minutes you can see how this would help your team, run a 2-week pilot ([adoption-guide.md](docs/adoption-guide.md) has the script). If you can't, it may not be the right tool for your team.

Step 4 above deliberately walks the full 18-stage track so you see every kind of stage in one sitting. Day to day, most teams drive the lighter `loop` track instead — see [Which track?](#which-track).

## Documentation map

Four reader paths. Every doc belongs to exactly one. ([docs/README.md](docs/README.md) is the docs-only index.)

### Evaluator — should we adopt?

Goal: decision-ready in 30 minutes.

| Step | Doc | Purpose |
|---|---|---|
| 1 | [EXAMPLE.md](EXAMPLE.md) | One feature traced through all 18 stages — the fastest reality check |
| 2 | [docs/comparative-analysis.md](docs/comparative-analysis.md) | Stagecraft's Claude/Codex lineage and its position among delivery, specification, methodology, context, and agent-runtime systems |
| 3 | [docs/adoption-guide.md](docs/adoption-guide.md) | Pilot script, common objections, and success criteria for the 2-week trial |

Evaluating further (long-form): [docs/presentation-notes.md](docs/presentation-notes.md) · [docs/walkthroughs/soc2-evidence-collector.md](docs/walkthroughs/soc2-evidence-collector.md) · [docs/walkthroughs/stage-04-split-host.md](docs/walkthroughs/stage-04-split-host.md) · [docs/compliance.md](docs/compliance.md) — control mapping for auditors: which pipeline artifact and command backs each control family

### Operator — I run pipelines daily

| Step | Doc | Purpose |
|---|---|---|
| 1 | [docs/user-guide.md](docs/user-guide.md) | Daily-use reference: running stages, multi-host setups, headless mode |
| 2 | [docs/tracks.md](docs/tracks.md) | Which of the seven tracks to pick for a given change — and what each one costs |
| 3 | [docs/conventions.md](docs/conventions.md) | Pipeline markers operators read and write (`QUESTION:`, `BLOCKER:`, magic comments) |
| 4 | [docs/runbooks/README.md](docs/runbooks/README.md) | Troubleshooting index: symptom → runbook section |
| 5 | [docs/cost.md](docs/cost.md) | Cost tracking, pricing table, and budget workflow |

Reference: [docs/faq.md](docs/faq.md) · [docs/git-workflow.md](docs/git-workflow.md) · [docs/ci.md](docs/ci.md) · [hosts/docker/README.md](hosts/docker/README.md) · [docs/omnigent-runtime.md](docs/omnigent-runtime.md) · [docs/memory.md](docs/memory.md) · [docs/observability.md](docs/observability.md) · [docs/reproducibility.md](docs/reproducibility.md) · [docs/runbooks/escalation.md](docs/runbooks/escalation.md) · [docs/runbooks/fix-and-retry.md](docs/runbooks/fix-and-retry.md) · [docs/runbooks/open-followups.md](docs/runbooks/open-followups.md) · [docs/runbooks/deploy-failure.md](docs/runbooks/deploy-failure.md) · [docs/runbooks/autonomous-run.md](docs/runbooks/autonomous-run.md) · [docs/runbook-template.md](docs/runbook-template.md)

### Contributor — I change Stagecraft

| Step | Doc | Purpose |
|---|---|---|
| 1 | [CONTRIBUTING.md](CONTRIBUTING.md) | Recipes for adding a host, role, stage, or skill |
| 2 | [ARCHITECTURE.md](ARCHITECTURE.md) | 12 locked design decisions — read when you want to know *why* |
| 3 | [docs/TESTING.md](docs/TESTING.md) | Test structure and guidance |
| 4 | [core/adapters/host-adapter.md](core/adapters/host-adapter.md) | The host-adapter contract (~150 lines) |
| 5 | [docs/adr/README.md](docs/adr/README.md) | Architecture decision records |

Reference: [docs/concepts.md](docs/concepts.md) · [docs/methodology.md](docs/methodology.md) · [docs/FEATURES.md](docs/FEATURES.md) · [docs/BACKLOG.md](docs/BACKLOG.md) · [docs/autonomous-execution-design.md](docs/autonomous-execution-design.md) · [docs/spec-authoring.md](docs/spec-authoring.md) · [docs/migration-safety.md](docs/migration-safety.md) · [docs/red-team.md](docs/red-team.md) · [docs/verification-beyond-tests.md](docs/verification-beyond-tests.md) · [docs/brief-template.md](docs/brief-template.md) · [docs/design-spec-template.md](docs/design-spec-template.md) · [docs/GAP-ANALYSIS.md](docs/GAP-ANALYSIS.md)

### Model — never reads docs/

Nothing under `docs/` is load-bearing for a pipeline run. Models read [AGENTS.md](AGENTS.md) · [rules/](rules/) · [roles/](roles/) · [skills/](skills/) only.

## Why "Stagecraft"?

The pipeline is a staged production. PM writes the brief. Principal directs the architecture. Specialist developers each build their part. Reviewers critique. QA tests. Deploy is the curtain. Each stage has its cast, its script (the rules under `rules/`), and its gate that decides whether the show moves on. Multi-model peer review is the panel of critics; the red-team is the adversary in the wings. The discipline of coordinating specialized roles in a sequenced production is **stagecraft**.

The vocabulary extends naturally: a *run* is one pipeline invocation, *dress rehearsal* is pre-review (Stage 4a), *curtain call* is the retrospective (Stage 9), and *notes* are peer-review comments. The metaphor is structural, not decorative.

## What this gives you

A coordinated team of role-specific subagents running a structured software-development pipeline end-to-end:

- **18-stage gated pipeline** — requirements (PM) → design (Principal) → build (specialist workstreams) → peer-review (Reviewer × 4) → QA → deploy → retrospective. Each stage writes a machine-readable gate; the next stage cannot start until the gate passes.
- **7 tracks** — `loop`, `quick`, `nano`, `config-only`, `dep-update`, `hotfix`, `full`. `loop` is the day-to-day default for bounded iteration; `full` is the **audited** path chosen when stakes or compliance justify the ceremony. `devteam assess` infers the right track from description keywords and file heuristics, and prints a ceremony-cost estimate (`devteam assess --json`) before you commit to one.
- **Prototype packets** — `devteam prototype` gives exploratory work a pre-SDLC lane: intent, build prompt, feedback notes, and an explicit promotion handoff into a normal track when the idea is ready to harden.
- **Docker runner** — `hosts/docker/` packages `devteam` into a non-root container for unattended headless runs against a mounted project, with conservative lock reporting and runtime-only credentials.
- **Per-workstream gate JSON** — every stage writes a gate to `pipeline/gates/`. Validator enforces shape; orchestrator merges multi-role stage gates.
- **Multi-host routing** — `.devteam/config.yml` picks which host runs which role. Claude for design, Codex for backend, Gemini for QA, Omnigent for meta-harness execution — the gate JSON is the stable contract.
- **Bounded autonomous driver** — `devteam run` loops `next → dispatch → merge` until `pipeline-complete`; `devteam stage <name> --headless` drives a single stage non-interactively.

Full feature catalogue: **[docs/FEATURES.md](docs/FEATURES.md)**.

## Prerequisites

**Platform:** macOS, Linux, and native Windows are supported. CI exercises the core Windows portability surface on Node 22: CLI startup, initialization, diagnostics, quoted host commands, executable discovery, and timeout termination. WSL2 remains a supported option when a host CLI or project toolchain expects a POSIX shell.

- Node.js ≥ 20
- At least one of: **Claude Code** (`claude --version` works), **Codex CLI** (`codex --version` works), **Antigravity CLI** (`agy --version` works — the supported successor to Gemini CLI, which stopped serving free/Pro/Ultra requests 2026-06-18), **Gemini CLI** (`gemini --version` works, deprecated upstream — `npm install @devteam/host-gemini-cli` first; see `devteam doctor`), **Omnigent** (`omnigent --version` works), any **ACP** agent ([agentclientprotocol.com](https://agentclientprotocol.com) — no default binary; set the launch command via `routing.roles.<role>: acp:<command>` or `hosts.acp.command`), an OpenAI-compatible API key for `openai-compat`, or just a terminal (generic adapter — prompts rendered for manual use, no automation)
- Git (recommended for version-controlling artifacts; the pipeline itself does not require it)

## Quick start

```bash
# 1. Get the framework (one time, anywhere)
git clone <this-repo> && cd stagecraft && npm install && npm link

# 2. In your target project — install the host adapter surface
cd ~/projects/my-app
devteam init --host claude-code         # or: codex / antigravity / omnigent / openai-compat / acp / claude-code,codex
                                         # gemini-cli is a plugin (34.4): npm install @devteam/host-gemini-cli first

# 3. Verify
devteam doctor                           # should be all green
```

Then drive the pipeline. There are two ways to run a stage:

### Path A — `--headless` (single terminal, start here)

The orchestrator drives the host runtime for you (`claude --print`, `codex exec --sandbox workspace-write`, `agy --print`, `gemini`, `omnigent run ...`, or any ACP agent command). One command per stage; model output is captured in `pipeline/logs/<workstreamId>.log` by default. Best for first runs, CI, and scripted use.

This walkthrough runs `loop` — the day-to-day default track (4 dispatches: brief → build → verify → review, no design/red-team/deploy):

```bash
devteam stage requirements --feature "Add SMS notification opt-in" --track loop --headless
# [devteam] dispatching pm → claude-code (headless)
# (model output is captured in pipeline/logs/stage-01.log)
#   ✓ pm (claude-code): exit 0, 23000ms → pipeline/gates/stage-01.json

cat pipeline/brief.md                    # the artifact the model wrote
cat pipeline/gates/stage-01.json          # the gate JSON

devteam next                              # → "▶️ run-stage build (stage-04)"
devteam stage build --headless            # next stage
# … keep going until "🎉 pipeline-complete" (4 dispatches total)
```

One terminal. One command per stage. The gate file appears when the model is done. `devteam next` tells you the next command. Drop `--track loop` to fall through to the configured `default_track` (factory default `full`), or pass `--track full` yourself when the change touches auth, payments, PII, migrations, or otherwise needs the **audited** path — see [Which track?](#which-track).

### Path B — Interactive in Claude Code (two windows)

Use this when you want to watch the subagent work, observe file edits, or intervene mid-stage. The slash command `/devteam` is installed by `devteam init`.

```bash
# Terminal 1 (your project dir):
devteam stage requirements --feature "Add SMS notification opt-in"
#   → prints a prompt with an onboarding preamble explaining what to do with it
```

In **Terminal 2** (or a separate window), inside Claude Code at the same project root:

```
/devteam stage requirements --feature "Add SMS notification opt-in"
```

Claude Code recognizes the slash command, dispatches the `pm` subagent. You see Claude write `pipeline/brief.md`, then write `pipeline/gates/stage-01.json`. The `Stop` hook fires and validates:

```
[gate-validator] ✅ GATE PASS — stage-01/pm (claude-code)
```

Back in Terminal 1:

```bash
devteam next                              # → "▶️ run-stage design (stage-02)"
```

Repeat for each stage.

### Which path should I pick?

| | Path A: `--headless` | Path B: interactive in Claude Code |
|---|---|---|
| Terminal windows | 1 | 2 (terminal + Claude Code) |
| You see the agent's work | streamed text in your terminal | full Claude Code UI |
| Best for | first runs, CI, scripted use, multi-host fanout | watching agents work, mid-stage intervention, debugging a stage |
| Auth | `claude --version` must work | Claude Code app/CLI logged in |
| Speed | usually faster (no UI overhead) | usually slower (UI overhead, human pauses) |

**Recommendation for first-timers:** Path A. One terminal, one command per stage, results on disk. Switch to Path B when you want to observe a specific stage in detail.

For a complete walked-through example with the actual output you'll see at each step, read **[EXAMPLE.md](EXAMPLE.md)**.

## Which track?

`loop` is the day-to-day default: 4 dispatches, no design/red-team/deploy. `full` is the **audited** path — every stage, including formal design and adversarial review — chosen when stakes or compliance justify the ceremony, not the default just because it feels safest. The remaining tracks (`nano`, `quick`, `config-only`, `dep-update`, `hotfix`) cover the shapes in between:

| Change type | Track | Ceremony cost |
|---|---|---|
| Small bounded iteration, no deploy needed yet | `loop` | Lightest — 4 dispatches |
| Mechanical change with obvious scope | `nano` | Minimal |
| Bounded feature or fix, no cross-cutting design concerns | `quick` | Light |
| Config/feature-flag values, no code | `config-only` | Light, conditional security review |
| Dependency bump or library upgrade | `dep-update` | Light |
| Urgent production incident | `hotfix` | Moderate — pre-review and peer-review mandatory |
| Complex/cross-cutting, regulated or high-stakes | `full` | Heaviest — all 18 stages, audited |

These are relative sizings, not bills — run `devteam assess --json` for the actual stage-slot count, dispatch range, token estimate, and cost range against your project's routed models (static estimate, or an empirical median once the run corpus has ≥5 comparable runs). The `full` track's gate trail can be exported as a signed, in-toto-shaped attestation bundle with `devteam evidence export --attestation` (see [docs/compliance.md](docs/compliance.md)). Full decision tree and the generated stage-by-track matrix: [docs/tracks.md](docs/tracks.md).

## What `devteam init` installs

For `--host claude-code` in a target project:

| Path | Contents |
|---|---|
| `.devteam/config.yml` | Routing config — which host handles which role/stage |
| `.devteam/rules/*.md` | Pipeline, gate, escalation, retrospective rules (10 top-level docs + per-stage `stage-NN.md` files) |
| `.claude/agents/*.md` | Role subagents with Claude Code YAML frontmatter (12) |
| `.claude/skills/*/SKILL.md` | Task helpers — implement, review-rubric, security-checklist, etc. (13) |
| `.claude/commands/devteam.md` | Slash command wrapper |
| `.claude/settings.local.json` | Hooks: validator on `Stop`/`SubagentStop`; approval-derivation on `PostToolUse`; secret-scan on `PreToolUse` |
| `pipeline/gates/` | Empty workspace dir for gate files |

For `--host codex`, `--host antigravity`, or `--host gemini-cli` (plugin package — `npm install @devteam/host-gemini-cli`): similar but rendered into the host's markdown prompt/skill directories, with no hooks or slash commands. For `--host omnigent`: rendered into `.omnigent/stagecraft/roles/`, `.omnigent/stagecraft/skills/`, plus a default `.omnigent/stagecraft/agent/config.yaml` bundle. For `--host openai-compat`: rendered into `.openai-compat/prompts/roles/` and `.openai-compat/skills/`. For `--host acp`: rendered into `.acp/stagecraft/roles/` and `.acp/stagecraft/skills/`; no hooks or slash commands, but allowed-writes and the dangerous-command stoplist are enforced at ACP's `session/request_permission` call time (see [docs/user-guide.md § Using ACP](docs/user-guide.md#using-acp-agent-client-protocol)). **`acp` is the recommended host for reviewing code you do not own** (`devteam review`/`devteam review-pr`, [docs/external-review.md](docs/external-review.md)) — it is the only host whose tool-call-time enforcement can mechanically prevent writes into the reviewed repo; every other host's fallback is weaker than a simple post-hoc audit in review mode.

For multi-host (`--host claude-code,codex` or `--host claude-code,omnigent`): both surfaces installed side-by-side; the routing config decides who handles what at runtime.

## CLI reference

| Command | What it does |
|---|---|
| `devteam init --host <name>[,<name>...] [--profile dogfood]` | Install host adapter(s) into the current project; write `.devteam/config.yml`; write (or update) the managed `.gitignore` block of volatile Stagecraft files. Add `--profile dogfood` to also install the four dogfooding safeguards (supplemental gitignore block, pre-commit infrastructure guard, `.git/info/exclude` entry, and `profile: dogfood` config marker). |
| `devteam stage <name> [--feature "..." \| --feature-file <path>] [--headless]` | Render (and optionally execute) a stage prompt; `--feature-file` reads a UTF-8 feature brief from disk; `--headless` drives the host CLI automatically |
| `devteam next [--json] [--skip-advise]` | Report the next action the pipeline needs (run-stage, continue-stage, merge, fix-and-retry, resolve-escalation, pipeline-complete). Non-pass actions carry a `failure_class` (code-defect / state-corruption / external-blocked / judgment-gate / convergence-exhausted) telling you how to respond, and a `fix-and-retry` carries structured `clear_gates` (repo-relative gate paths to clear before re-running) the autonomous driver consumes directly; `--json` adds a `schema_version`. Emits a ⚠ advisory notice when unresolved follow-up items may block downstream stages. |
| `devteam run [--feature "..." \| --feature-file <path>] [--repair "<symptom>"] [--repair-at <file>:<line>] [--track <t>] [--until <s>] [--budget-usd X] [--timeout-ms N] [--retry-delay-ms N] [--auto-rule <classes>] [--allow-stage <s>] [--max-iterations N] [--resume] [--force] [--json] [--fail-on-advisory[=all]] [--auto-commit] [--watch]` | **Bounded autonomous driver** (ADR-003 / H2). Loops `next → dispatch → merge` until `pipeline-complete`. **Auto-fixes `code-defect` failures** (clears the failing gate, propagates blockers to `context.md`, re-dispatches — bounded by `autonomy.max_retries`) and **retries transient dispatch failures** with backoff. With `--auto-rule <classes>` it also **auto-resolves escalations whose Principal-ruling class is in the allowlist** — never a cannot-decide, the consequence ceiling, or `convergence-exhausted`. Halts for a human otherwise (un-granted escalation, the ceiling — grant with `--allow-stage`, a budget cap, or a structural dispatch failure). **`--feature-file <path>`** is equivalent to `--feature` with the file's UTF-8 contents and is mutually exclusive with `--feature`. **`--repair "<symptom>"`** selects bug-fix intent mode (ADR-009): stage-01 produces a **DIAGNOSIS** (root cause, proposed fix, `affected_files`, regression criterion) instead of a feature brief; the diagnosis is a judgment gate requiring `--auto-rule diagnosis-approved` or a human ruling before build; stage-03b (executable-spec) is injected immediately before build — even on hotfix depth — where the agent writes a failing-first regression scenario and sets a tri-state `reproduced` field (`true` / `false` / `"unverifiable: <reason>"`), which the orchestrator stamp verifies red→green (not agent-asserted); the build runs in PATCH MODE scoped to the diagnosed files; a structural scope gate FAILs builds that write outside the diagnosed `affected_files` set. **`--repair-at <file>:<line>`** skips the LLM diagnosis and seeds the affected-files list directly from known defect locations (the reproduction stage is still included). Both repair flags are mutually exclusive with `--feature` and `--feature-file`. **`--auto-commit`** automatically commits pipeline artifacts after a clean halt (`ceiling`, `--until`, `budget`) using the same algorithm as `devteam commit` — no interactive prompt; commit failure emits a warning but does not change the halt exit code (Phase 12.3, ADR-010). Writes `pipeline/run.lock`, `run-state.json`, `run-log.jsonl`. Emits a `heartbeat` event at the start of each iteration; a fire-and-forget stall probe emits `stall-detected` when the workstream log and gates go quiet for 5 min (observe-only — ADR-007 Tier 1; dispatch is never killed). Line progress and `--watch` surface active workstreams, last workstream, and gate/log pointers. Exit: 0 complete/clean-stop, 1 needs-attention, 2 locked, 3 `--fail-on-advisory` advisory blockers remain. See [docs/runbooks/autonomous-run.md](docs/runbooks/autonomous-run.md). |
| `devteam prototype <start\|build\|note\|promote> [id-or-title] [--feature "..."] [--feedback "..."] [--host <h>] [--apply-to-project] [--track <t>] [--json]` | **Pre-SDLC prototype mode.** `start` creates `pipeline/prototypes/<id>/` with `intent.md`, `build-prompt.md`, `feedback.md`, `promotion.md`, and `prototype.json`. `build` runs the generated prompt through a headless host in `pipeline/prototypes/<id>/workspace/` by default; `--apply-to-project` deliberately lets the build touch the project root. `note` appends demo/stakeholder feedback. `promote` updates the handoff with `devteam run --feature-file pipeline/prototypes/<id>/promotion.md --track <t>`. Prototype packets are learning records, not gate evidence, and cannot satisfy sign-off/deploy. |
| `devteam commit [--all] [--dry-run] [--message <msg>] [--json]` | **Stage exactly the right pipeline artifacts and commit** (Phase 12.2, ADR-010). Reads `pipeline/run-state.json`, determines which stages have not yet been committed (idempotency cursor), stages gate files (PASS/WARN only) + named artifacts per stage, excludes volatile runtime files, generates a `"pipeline: stages NN–NN PASS"` commit message, and prompts `y/n/e` before committing. `--all` ignores the cursor; `--dry-run` prints without committing; calling it twice is a no-op. |
| `devteam compact [--dry-run] [--json]` | Strip all devteam-managed marker sections (`<!-- devteam:*:begin/end -->`) from `pipeline/context.md` in one shot. Sections (run-blockers, red-team-blockers, deploy-target, advise, etc.) are regenerated by devteam on the next run when still needed, so removal is always safe. Use to prune `context.md` after a long pipeline run or before switching to `isolation: bounded`. `--dry-run` lists what would be removed without modifying the file. |
| `devteam status [--feature "..."] [--json] [--verbose]` | **Liveness report** (ADR-007 Tier 1). Reads `run-state.json` + tail of `run-log.jsonl`; reports `status` / `current_stage` / `last_action` / `iterations` / `cost_usd` / `last_heartbeat_age_ms` / `last_event_age_ms` / `stall_detected` / active workstreams / last workstream. Read-only; no `--watch`. |
| `devteam performance critical-path [--feature "..."] [--json]` | **Critical-path report** (Phase 26 / #313). Reconstructs dispatch wall time, merge time, retry delay, workstream compute, parallel savings, telemetry coverage, and repeated verification-command candidates from `run-log.jsonl` plus orchestrator-stamped gates. |
| `devteam patterns <collect\|list\|review\|promote\|retire\|stats> [--feature "..."] [--json]` | **Project-local pattern learning** (Phase 27 / #332). Collects sanitized blockers, warnings, follow-ups, archived auto-retry failures, and retry outcomes into `.devteam/patterns/`; promoted patterns are injected as a bounded `Known Project Patterns` section in future stage prompts. Promotion is explicit, local, and advisory. |
| `devteam advise [--apply <decisions>] [--json]` | Show advisory panel for `noted_for_followup[]` items across all completed gates; classify risk (QA_BLOCKER, PEER_REVIEW_RISK, QA_NOISE); apply operator decisions to `pipeline/context.md`. Apply format: `--apply AC-11=A,AC-10=B:PROJ-123,AC-12=A`. Actions: scaffold, defer, amend, nothing, known-flaky, wontfix. See [rules/advise.md](rules/advise.md). |
| `devteam restart <stage> [--cascade] [--keep-context] [--dry-run]` | Clear a stage's gate(s) so the pipeline can re-run it. With `--cascade`, also clears every stage that comes after. Use after FAIL/ESCALATE. See [docs/runbooks/escalation.md](docs/runbooks/escalation.md). |
| `devteam ruling --topic "..." [--context <paths>] [--target-gate <gate>] [--headless]` | Dispatch the Principal subagent for an ad-hoc ruling outside the normal stage flow. Writes a `PRINCIPAL-RULING:` line to `pipeline/context.md`; no gate is touched. |
| `devteam merge <stage>` | Aggregate per-workstream gate files into a single merged stage gate (required after multi-role stages) |
| `devteam derive-approvals [<file>] [--cwd <dir>] [--json]` | Re-run the `approval-derivation` hook on `pipeline/code-review/by-*.md` and update the per-area `stage-05.<area>.json` gates. Use after hand-editing a review file outside an active Claude Code session — the hook only fires on agent saves; shell/editor saves bypass it. Follow with `devteam merge peer-review` to rebuild the merged gate. See [docs/runbooks/fix-and-retry.md § Case 5](docs/runbooks/fix-and-retry.md#case-5-peer-review-stage-5-fail-with-no-objections--quorum-miss). |
| `devteam validate` | Run the gate validator manually against the current gate directory |
| `devteam verify-chain [--track <t>] [--require-signed] [--json]` | **C6 authenticated gate chain.** Verify predecessor hashes and any HMACs created with `DEVTEAM_SIGNING_SECRET`; reports located breaks, invalid MACs, unsigned gates, and signatures that could not be checked. `--require-signed` (or `pipeline.require_signed_gates: true`) makes unsigned/unverifiable history fail. Exit 0 intact, 1 failed — CI-usable. |
| `devteam stamp-chain [--track <t>]` | (Re)stamp the gate chain on every stage gate in order. When `DEVTEAM_SIGNING_SECRET` is set, each complete gate is authenticated with HMAC-SHA256. Use after a deliberate earlier-stage re-run or to stamp gates written interactively. |
| `devteam verify <stage-id> [--json]` | Orchestrator-stamped verification. For stage-04a (lint+tests) and stage-06 (tests + AC mapping), runs the configured commands and stamps the gate with what was actually observed. stage-04c (red-team) runs a mechanical floor instead — dependency audit, secret-scan over the changeset, semgrep (only if already configured), and a lockfile delta — merging into `findings_count`/`must_address_before_peer_review` (Phase 31.2). Flips status to FAIL if the orchestrator's truth disagrees with the model's claim. |
| `devteam summary` | One-screen view of all stages: pass/warn/fail/escalate/pending per stage and workstream |
| `devteam log [--follow] [--json]` | Chronological event timeline: every gate + every artifact write, mtime-sorted, with per-stage key fields. `--follow` polls at 1s for live tailing. Works in headless and user-driven modes. |
| `devteam report [--out <file>] [--no-open] [--json]` | **Post-run HTML report.** Writes a self-contained `pipeline/report.html` (auto-opened) with status badge, progress bar, per-stage timing and dispatch counts, blocker log, and all pipeline documents embedded inline (brief, spec, design, code reviews, ADRs, test report, etc.). Status correctly classifies COMPLETED / HALTED (with halt type) / INCOMPLETE. Header shows wall-clock time, model compute time, retry and stall counts. `--json` prints the raw collected data. |
| `devteam stages` | List all stages and their stage IDs |
| `devteam hosts` | List available host adapters |
| `devteam doctor` | Check that the install is healthy: hooks wired, agent files present, host CLIs on PATH. When `profile: dogfood` is set, adds a "Dogfood mode" section with six checks (pre-commit guard, hook executable, gitignore dogfood block, `.git/info/exclude` deploy.md entry, no npm publish script, budget-usd reminder). |
| `devteam reproduce <stage-id> [--json]` | Read a past gate and report replay readiness — which reproducibility fields are recorded, what's missing, whether the current prompt's hash matches what the gate captured. |
| `devteam replay <stage-id> [--dry-run] [--json]` | Re-run a recorded stage against the current config; diff the result across status, blockers, cost, tokens, duration, reproducibility fields. New gate goes to `pipeline/gates/replay/`. |
| `devteam ci install [--ci github-actions] [--out <dir>] [--force]` | Drop a CI workflow template into the target project's `.github/workflows/`. The workflow validates gates and posts each as a GitHub check run on PRs. Does NOT run the LLM pipeline in CI by design. |
| `devteam corpus stats [--json]` | **Run corpus** (28.5). One sanitized JSONL record per headless dispatch in `.devteam/corpus/dispatches.jsonl` — stage, role, host, model, observed tokens/cost, duration, gate status, sanitized blockers. Reports total dispatches, per-stage pass rates, and per-(role, host) counts. Writes are fire-and-forget and never fail a run. |
| `devteam evals <run\|compare\|gc> [--stub \| --headless-host <h>] [--pack <A> --pack <B>] [--json]` | **Eval flywheel** (33.1–33.3). Failed gates and stamp overrides are captured as replayable cases under `.devteam/evals/`. `run --stub` re-renders each case against the current prompt surface for free (structural checks, CI-usable); `--headless-host` replays against a real model. `compare --pack` reports per-stage pass-rate deltas between two `prompt_pack_version` values. `gc` prunes unreferenced blobs. |
| `devteam evidence <status\|export\|verify-attestation> [--attestation] [--sign]` | **Evidence and attestation** (Phases 16–18, 34.2). Privacy-bounded readiness and export; `export --attestation` turns the verified gate chain into an in-toto-shaped bundle (per-field model-asserted vs orchestrator-observed provenance, model versions, human acceptance records), optionally signed via `cosign` when present. `verify-attestation` re-checks a bundle offline. See [docs/compliance.md](docs/compliance.md). |
| `devteam memory <ingest\|query\|stats\|promote\|clear> [--org]` | Persistent project memory: ingest briefs/ADRs/lessons; query by similarity. `--org` targets the cross-project shared store at `~/.stagecraft/memory/`. Since 30.4, top matches are also injected automatically into stage prompts as a bounded `Prior Project Knowledge` section. |
| `devteam architecture lookup "<topic>"` | Friendlier wrapper around `memory query --org --kind adr`. Surfaces prior ADRs at design time so architecture decisions don't silently re-litigate. |
| `devteam ui` | Open the web dashboard (live gate view, cost, performance charts) |
| `devteam spec generate` | Scaffold `pipeline/spec.feature` from AC-N criteria in `pipeline/brief.md` |
| `devteam spec verify` | Check `pipeline/spec.feature` for drift against the brief |
| `devteam consistency analyze [--strict] [--json]` | Cross-artifact drift check across the full pipeline chain — brief → spec → `pr-*.md ## Verify` → red-team `must_address` → test-report → gate field reality. Generalizes `devteam spec verify` to every intermediate artifact + the gate-vs-reality dimension. Exits non-zero on any drift. |
| `devteam assess [--description "..."] [--json] [--apply] [--confirm] [files...]` | G6 / ADR-006 — rule-based track recommendation for a proposed change. Analyzes description keywords and file/content heuristics (security patterns, migration files, config-only paths) and returns the recommended track with rationale. Default writes `pipeline/track.json` (`source: "inferred"`) as the per-run provenance record read by `devteam run`. `--confirm` sets `source: "human"` (silences the unconfirmed-track guard). `--apply` writes `pipeline.custom_stages` to `.devteam/config.yml` (project-wide setting). |
| `devteam standards discover [--cwd <dir>] [--json] [--dry-run] [--force]` | B10 — scan the current project and produce `docs/project-conventions.md` with detected tech stack, module system, file layout, naming conventions, tooling, test configuration, and most-used import sources. `--dry-run` prints without writing; `--json` emits the structured discovery result. Add the output file to your AGENTS.md or readFirst lists to inject discovered conventions into agent prompts. |

See `devteam help` for the up-to-date list with flags.

## Auditing an existing codebase

The pipeline builds features. The **audit** workflow analyzes an existing codebase and produces a prioritized improvement roadmap under `docs/audit/00–10`, plus a `status.json` for resume. It is read-only by design: it writes findings, never source code. The `implement` skill consumes `docs/audit/10-roadmap.md` to pick the next change.

Inside Claude Code:

```
/audit              # full audit: Phases 0-3, ~30-60 min, 11 output files
/audit-quick        # Phases 0-1 only: ~5-15 min, 6 output files
```

The slash commands are claude-code-only; on other hosts the `auditor` role and `audit` skill ship with every `devteam init` and you dispatch them as a normal role-plus-skill prompt.

For auditing a feature *built with* Stagecraft (where the pipeline left a rich on-disk trail), the audit splits into **four modes** — code / process / consistency / threat — each answering a different question with a different tool. See [`docs/user-guide.md` § Auditing a feature built with Stagecraft](docs/user-guide.md#auditing-a-feature-built-with-stagecraft--the-four-modes).

Full operational guidance: [`docs/user-guide.md` § Auditing a codebase](docs/user-guide.md#auditing-a-codebase). Phase definitions: [`skills/audit/SKILL.md`](skills/audit/SKILL.md).

## Architecture in one diagram

```
User in any AI tool (Claude Code, Codex, Omnigent, terminal)
         │
         │  /devteam slash command, or `devteam` CLI
         ▼
Host adapter (hosts/<host>/adapter.js)
  - declares capabilities (hooks, subagents, …)
  - renders stage prompt for this host
  - installs surface into the target project
         │
         ▼
Core (model-agnostic spine, never invokes a model)
  - stage definitions + tracks       (core/pipeline/stages.js)
  - gate schemas + validator         (core/gates/)
  - guards: stoplist, security-heuristic
  - routing + orchestrator           (core/router.js, core/orchestrator.js)
         │
         ▼
Stage prompt rendered for the LLM
         │
         │  consumed by the model inside the host
         ▼
Model produces:
  - the artifact (brief, design-spec, code, test report, …)
  - a gate JSON conforming to core/gates/schemas/stage-NN.schema.json
         │
         ▼
Core validates, advances, escalates, or halts.
```

Full design notes: [ARCHITECTURE.md](ARCHITECTURE.md). Host-adapter contract: [core/adapters/host-adapter.md](core/adapters/host-adapter.md).

## Repository layout

```
stagecraft/
├── ARCHITECTURE.md             ← design model + locked decisions
├── README.md                   ← you are here
├── LICENSE                     ← MIT
├── package.json
├── bin/devteam                 ← CLI entrypoint
├── core/                       ← model-agnostic spine
│   ├── adapters/               ← host-adapter contract + shared helpers
│   ├── config.js               ← .devteam/config.yml loader + routing
│   ├── gates/                  ← validator + per-stage schemas
│   ├── guards/                 ← stoplist, security/migration heuristics
│   ├── hooks/                  ← approval-derivation, secret-scan
│   ├── memory/                 ← persistent project memory (embed/store/index)
│   ├── spec/                   ← Gherkin generator + drift verifier
│   ├── ui/                     ← dashboard web server
│   ├── orchestrator.js         ← runStage, mergeWorkstreamGates, next
│   ├── pipeline/stages.js      ← STAGES table + STAGES_BY_TRACK
│   └── router.js               ← per-(stage, role) host resolution
├── roles/                      ← single source of truth for role briefs (12)
├── rules/                      ← pipeline rules docs (10 top-level + 9 per-stage)
├── skills/                     ← task-oriented helpers (13)
├── templates/                  ← artifact templates (15)
├── hosts/                      ← per-host adapters (first-party, ship by default)
│   ├── claude-code/
│   ├── codex/
│   ├── antigravity/
│   ├── omnigent/
│   ├── openai-compat/
│   ├── acp/                    ← any Agent Client Protocol agent as a host
│   └── generic/
├── packages/                   ← first-party-maintained plugin packages (A4)
│   └── host-gemini-cli/        ← deprecated upstream; npm install @devteam/host-gemini-cli (34.4)
└── docs/                       ← guides, walkthroughs, BACKLOG
```

## Design decisions

12 locked decisions are documented in [ARCHITECTURE.md](ARCHITECTURE.md). The big ones:

1. **The core never spawns a model.** It emits prompts and validates JSON.
2. **Gate JSON is the stable contract.** Identity fields: `stage`, `workstream`, `orchestrator`, `host`, `status`. Anything host-specific stays in the adapter.
3. **Role briefs have one source.** `roles/*.md`. Adapters render into host-expected paths at install time.
4. **Per-workstream host selection.** A single pipeline can route different roles to different hosts; the orchestrator merges across them via the gate contract.
5. **Multi-host install is the default code path.** Single-host is just a list of length 1.
6. **Capability negotiation.** Each adapter declares hooks, subagents, slashCommands, worktrees, headless, and where it enforces each core rule.

## What's deferred

- Programmatic `invoke()` testing requires `claude` / `codex` on PATH (the contract works with stubs).
- See [docs/BACKLOG.md](docs/BACKLOG.md) for the prioritized list of next ideas — bucketed by reach, depth, quality, observability, DX, integrations, and innovation bets.

## Why this exists

`claude-dev-team` and `codex-dev-team` ran the same pipeline with the same templates, schemas, and ~80% of scripts, but as separate forks that were slowly diverging. This project unifies them into a single core with thin per-host adapters. The stress-test that locked the design is in [docs/walkthroughs/stage-04-split-host.md](docs/walkthroughs/stage-04-split-host.md): one feature traced end-to-end through a mixed-host pipeline.

## License

[MIT](LICENSE). © 2026 Mumit Khan.
