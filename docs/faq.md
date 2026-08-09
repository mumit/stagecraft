# FAQ

**How this FAQ is maintained:** entries answer operational questions only.
Facts are linked, not restated, from their canonical home (FEATURES.md, BACKLOG.md, concepts.md).
Entries that restate feature state — what Stagecraft does, what's planned — are deleted rather than kept in sync.

Common questions about Stagecraft, grouped by topic.

If you can't find what you need: check [`docs/user-guide.md`](user-guide.md)'s "When things go wrong" section, [`docs/concepts.md`](concepts.md) for vocabulary, or open an issue.

- [Setup & install](#setup--install)
- [Using the pipeline](#using-the-pipeline)
- [Multi-host routing](#multi-host-routing)
- [Comparing to other tools](#comparing-to-other-tools)
- [Customization](#customization)
- [Operational](#operational)
- [Roadmap](#roadmap)
- [Stuck pipelines and recovery](#stuck-pipelines-and-recovery)
- [Running offline / in CI](#running-offline--in-ci)
- [Auditing past runs](#auditing-past-runs)
- [Multi-host specifics](#multi-host-specifics)
- [Memory and learning](#memory-and-learning)
- [Operational gotchas](#operational-gotchas)
- [Auditing a codebase](#auditing-a-codebase)
- [Comparing to /goal and similar features](#comparing-to-goal-and-similar-features)

## Setup & install

### What's the difference between a role, a stage, and a host?

Three distinct concepts that appear together everywhere:

- **Role** — a job function performed by an AI agent: PM, Principal, Backend, Security, Red-team, etc. Each role has a brief in `roles/<name>.md` that defines its responsibilities and constraints.
- **Stage** — a pipeline step with a defined objective, artifact, and gate: requirements, design, build, peer-review, etc. Each stage dispatches one or more roles to do the work.
- **Host** — how Stagecraft delivers work to a model. Runtime-based hosts include Claude Code (`claude`), Codex CLI (`codex`), Gemini CLI (`gemini`), and Omnigent (`omnigent`). `openai-compat` is HTTP-native — it calls any OpenAI-compatible Chat Completions endpoint directly without a CLI. `generic` renders prompts for manual use.

A stage assigns roles; routing assigns those roles to hosts; the hosts invoke models. The gate JSON is what all three produce in common.

### Do I need Claude Code or Codex CLI installed to use this?

No, not strictly. Two paths work without a dedicated model CLI:

- **`openai-compat`** routes directly to any OpenAI-compatible Chat Completions API endpoint (OpenAI, OpenRouter, Fireworks AI, Fuel iX, provider-hosted open-weight models, or internal gateways) via HTTP — no CLI, full headless support, bash tool included. This is the recommended no-install option when you have an API key for a hosted model. See [Using openai-compat](user-guide.md#using-openai-compat-openai-compatible-apis) in the user guide for setup.
- **`generic`** renders prompts to stdout for manual paste into any LLM or workflow. What you give up: no slash commands, no hooks, no headless invocation.

Most people will want at least one real host installed.

### Where does the framework live vs the target project?

Two distinct places:

- **The framework** (this repo, `stagecraft/`) is installed once, anywhere. Contains the orchestrator, schemas, role briefs, host adapters.
- **The target project** is your application repo. `devteam init` lays down `.devteam/config.yml`, host-specific install payloads (`.claude/agents/...`), and `pipeline/gates/`.

You can drive many target projects from one framework install. Updating the framework (`git pull`) updates every target on its next `devteam init --force`.

### Does this run on Windows?

Yes. Stagecraft supports native Windows, macOS, and Linux. A Node 22 Windows CI smoke exercises CLI startup, `init`, `doctor`, quoted host commands, PATHEXT-aware executable discovery, and timeout termination. You can still use [WSL2](https://learn.microsoft.com/en-us/windows/wsl/install) when a host CLI or your project's own toolchain expects a POSIX shell.

### Can I run this without Node?

No. The CLI, orchestrator, validator, and hooks are all Node. The host CLIs (`claude`, `codex`) can be whatever they're written in; the framework just calls them.

## Using the pipeline

### I am just prototyping. Do I need the full pipeline?

No. Use `devteam prototype` when you need a fast learning loop rather than
delivery evidence:

```bash
devteam prototype start "settings flow" --feature "Try a faster account-settings flow"
devteam prototype build settings-flow --host openai-compat
devteam prototype note settings-flow --feedback "Users missed the save state"
devteam prototype promote settings-flow --track full
```

Prototype packets live under `pipeline/prototypes/<id>/` and contain intent,
build prompt, packet-local workspace, feedback, promotion handoff, and metadata
files. They are not gate evidence and do not satisfy sign-off or deploy.
`prototype build` runs in `pipeline/prototypes/<id>/workspace/` by default; use
`--apply-to-project` only when you intentionally want throwaway prototype code
to touch the project root. When the idea settles, promote the packet into a
normal track with the generated `devteam run --feature-file ... --track <t>`
command.

### What if I want to skip a stage?

If a stage isn't appropriate for your change, pick a track that doesn't include it. See [`docs/tracks.md`](tracks.md) — `nano` skips most stages, `quick` skips design + clarification + pre-review, etc.

If you want to skip a stage that *is* in your active track, configure `pipeline.skip_stages` for an explicit, audited skip or choose/customize a track that omits it. Never hand-author a `PASS` gate to bypass work: PASS is evidence produced and validated by the stage, not a manual sequencing marker.

### Do I have to use all 18 stages?

No. The track system exists precisely to let you opt out of stages per change. The full track has all 18; nano has 3 (build + a scoped peer-review with 1 reviewer + qa). Pick whatever matches the change's risk profile.

### How do I know which track to use for my change?

Use the highest-risk read that applies:

| Change type | Track |
|---|---|
| Small bounded iteration with no deploy yet | `loop` |
| 1-line mechanical or docs-only change | `nano` |
| Dependency bump | `dep-update` |
| Self-contained behavior-preserving refactor | `refactor` |
| Bounded feature/fix moving toward sign-off and deploy | `quick` |
| Urgent production incident | `hotfix` |
| Feature touching multiple services or adding new external dependencies | `full` |
| Feature with auth, PII, schema migration, or security implications | `full` + run security review regardless of pre-review flag |

When in doubt for ordinary iterative work, start with `loop`; use `full` when risk, security, cross-cutting architecture, or auditability is the uncertainty. The stoplist blocks known consequential subjects from lighter tracks, and `devteam assess` promotes security-triggered `loop`/`nano`/`quick` work to `full`.

### My `--feature` string specified implementation details (env var names, a specific API endpoint) but the PM rewrote them. How do I preserve them?

The PM agent treats `--feature` as product intent — its job is to convert it into a product brief (problem statement, user stories, acceptance criteria). In doing so, it applies its training knowledge about standard patterns. Specific implementation choices like non-default env var names, alternative API endpoints, or explicit "NOT X" constraints may be normalised away or dropped, because the PM reads them as how-to details rather than what-must-be-true requirements.

**Before running — two options:**

**1. Phrase constraints as observable behaviours in `--feature`**

The PM preserves what it can write as a testable AC. Phrasing a constraint as an observable behaviour rather than an implementation decision makes it stick:

| Drops out | Survives |
|---|---|
| `"use ANTHROPIC_AUTH_TOKEN"` | `"auth header MUST be Authorization: Bearer \${ANTHROPIC_AUTH_TOKEN} — x-api-key is explicitly excluded"` |
| `"call the Chat Completions API"` | `"MUST POST to \${ANTHROPIC_BASE_URL}/v1/chat/completions — not /v1/messages"` |
| `"read model from env"` | `"model name MUST be read from ANTHROPIC_MODEL at runtime; do not hardcode"` |

The key is that `x-api-key is explicitly excluded` and `not /v1/messages` make the constraint testable. The PM can write "AC: the outgoing request uses Authorization: Bearer, never x-api-key" directly from that phrasing.

**2. Seed `pipeline/context.md` with a binding constraints block before running**

All agents — PM, Principal, backend, QA — read `pipeline/context.md` on every dispatch. Write non-negotiable implementation decisions there *before* `devteam run`. **Place the block above any `<!-- devteam: -->` marker lines** — content inside those markers is managed by Stagecraft and will be overwritten on each run; anything above the first marker is yours and is preserved.

```markdown
## Binding implementation constraints

**Anthropic integration:** Use the OpenAI-compatible Chat Completions endpoint
via our internal proxy — not the native Anthropic Messages API.
Three env vars configure it:
- `ANTHROPIC_BASE_URL` — proxy base URL
- `ANTHROPIC_AUTH_TOKEN` — Bearer token; header is `Authorization: Bearer <token>`, NOT `x-api-key`
- `ANTHROPIC_MODEL` — model name, read at runtime; do not hardcode

Call: `POST ${ANTHROPIC_BASE_URL}/v1/chat/completions`. Do not use
`https://api.anthropic.com/v1/messages` or the `anthropic-version` header.
```

Even if the PM softens the wording in the brief, design and build agents see this block and apply it. Use both approaches together for maximum reliability: AC-phrased language in `--feature` so the brief captures it, and context.md so design can't contradict it.

**After the build has already run with the wrong implementation:**

Add the binding constraints block to `pipeline/context.md` above any `<!-- devteam: -->` markers (so the build agent reads it when it re-runs), then open a blocker on the backend build gate:

1. Open `pipeline/gates/stage-04.backend.json`. Set `"status": "FAIL"`. Add the issue to `must_address_before_peer_review` and set `affected_workstreams: ["backend"]`:

```json
{
  "id": "FIX-01",
  "assigned_to": "backend",
  "severity": "high",
  "file": "src/lib/claude.ts",
  "scenario": "Uses native Messages API (POST /v1/messages, x-api-key header). Must switch to Chat Completions endpoint via proxy: POST ${ANTHROPIC_BASE_URL}/v1/chat/completions with Authorization: Bearer ${ANTHROPIC_AUTH_TOKEN}. Model from ANTHROPIC_MODEL. No changes to endpoint interface or rate-limiting."
}
```

2. Run `devteam run`. The orchestrator detects the FAIL gate and re-dispatches the backend workstream. The build agent reads both the gate blocker (what to fix) and `pipeline/context.md` (the binding constraint explaining why), applies the fix, and re-writes the gate.

The blocker description can stay at intent level — you don't need to spell out every header name if you've already put the technical detail in context.md.

For static project-wide context (architecture, platform, team conventions) that should apply to every pipeline run — not just a single feature — see [Seed project context](adoption-guide.md#seed-project-context) in the adoption guide.

### How do I fix a bug instead of adding a feature?

Use `devteam run --repair "<symptom>"` rather than `--feature`:

```bash
devteam run --repair "User authentication silently fails when the session token is expired — no error is surfaced to the caller"
```

`--repair` switches stage-01 from writing a feature brief to writing a **diagnosis** (root cause + `affected_files` list). The diagnosis gate always lands as ESCALATE — you approve it with `devteam next` or pass `--auto-rule diagnosis-approved` for autonomous approval. After approval, the build runs in PATCH MODE constrained to the diagnosed files (any write outside that set fails with `scope-gate`), and stage-03b runs a failing-first regression test even on hotfix depth.

```bash
devteam run --repair "symptom"                         # hotfix depth (default), diagnosis first
devteam run --repair "symptom" --repair-at src/auth.js:42     # skip diagnosis; you already know the location
devteam run --repair "symptom" --auto-rule diagnosis-approved  # approve diagnosis autonomously
```

`--repair` and `--feature` are mutually exclusive. Use `--feature` when the behavior was never correct (missing capability vs. regression). For the operator runbook, see [`docs/runbooks/repair-flow.md`](runbooks/repair-flow.md).

### Can I run multiple features through the pipeline simultaneously?

Partially. Each feature lives in its own `pipeline/` directory — you can run the pipeline in parallel across different directories by running `devteam` commands from separate project directories (use `--cwd <dir>` or `cd` into the target). What you can't do is run two features through the *same* pipeline directory simultaneously; gate files would overwrite each other.

In practice: one target project, one feature at a time, one `pipeline/` directory. If your team is running multiple features, either use separate clone directories per feature or wait until one pipeline is complete before starting the next.

### Should gate JSON files be committed to git?

Yes — strongly recommended. Gate files in `pipeline/gates/` are the audit trail of your pipeline run. Committing them means:

- `git log pipeline/` is a full history of every stage, every retry, every escalation.
- A CI system (or a teammate) can verify stage completion without re-running anything.
- If a compliance audit asks "prove this feature went through security review," you have an immutable record.

Add `pipeline/memory/` to `.gitignore` (memory store, large blobs) but commit `pipeline/gates/`, `pipeline/brief.md`, `pipeline/design-spec.md`, and the rest of the artifacts.

### Can I author the gate JSON by hand instead of via the LLM?

Yes. The orchestrator doesn't care how the gate file got written — it only validates the JSON and advances based on `status`. For trivial stages or when an agent fails, hand-writing the gate is fine. See `rules/gates-core.md` for the required-fields shape.

### What is a workstream? When do I have multiple?

A **workstream** is one role's work within a stage. Single-role stages (requirements, design, clarification) have one workstream. Multi-role stages (build, peer-review, sign-off) have one workstream per role — each writes its own gate file at `pipeline/gates/<stage>.<role>.json`. `devteam merge <stage>` aggregates them into a single merged gate once all workstreams are done.

You don't usually need to think about workstreams directly — `devteam next` tells you when to run more workstreams (`continue-stage`) and when to merge (`merge`).

### What if my LLM doesn't write the gate?

`devteam next` will keep reporting `run-stage` (or `continue-stage` for partial multi-role). Either re-invoke the agent with a clearer instruction, or hand-write the gate (see above). The orchestrator only knows what's on disk.

### How do I answer an open question myself instead of invoking PM?

Stages 1–2 sometimes produce `QUESTION: <text> @PM` lines in `pipeline/brief.md` and `pipeline/context.md`. Stage 3 (clarification) halts until each one has a `PM-ANSWER:` line beneath it. To answer yourself rather than dispatching the PM agent: open `pipeline/context.md` (not brief.md), write `PM-ANSWER: <text>` directly below each `QUESTION:`, save. `devteam next` advances. Full example + the "what if the answer changes the brief itself" escape hatch in [`docs/user-guide.md` § Answering an open question between stages](user-guide.md#answering-an-open-question-between-stages). For the full marker vocabulary (`QUESTION:`/`PM-ANSWER:`/`CONCERN:`/`BLOCKER:` etc.), see [`docs/conventions.md`](conventions.md).

### What goes in a gate and what fields are required?

Every gate must have: `stage`, `workstream`, `status` (PASS/WARN/FAIL/ESCALATE), `track`, `timestamp` (ISO-8601), `blockers` (array), `warnings` (array). The `orchestrator` and `host` fields are auto-injected by the validator — the model doesn't write them.

Stage-specific fields (like `acceptance_criteria_count`, `security_approved`, `veto`) are documented in each stage's schema under `core/gates/schemas/stage-NN.schema.json`. If the model writes extra fields the schema doesn't define, the validator accepts them as passthrough — it only rejects missing required fields or invalid status values.

If you write a gate by hand, the minimum to advance the pipeline is:
```json
{
  "stage": "stage-02", "workstream": "principal", "status": "PASS",
  "track": "full", "timestamp": "2026-05-01T12:00:00Z",
  "blockers": [], "warnings": []
}
```

### What if the model writes a gate with wrong or missing fields?

The validator (run by Claude Code's Stop hook, or manually via `devteam validate`) exits with code 1 and lists the missing fields. The model output is logged; the gate file may or may not exist depending on where it failed.

Fix options in order of preference:
1. Re-run the stage — the model will usually write a correct gate on a second attempt.
2. Hand-edit the gate file — add the missing fields and set correct values.
3. Delete the gate file — `devteam next` will report `run-stage` again on the next invocation.

The orchestrator cannot advance past a stage with a malformed gate.

### How do hooks know which gate to validate?

Claude Code hooks fire on Stop / SubagentStop / PostToolUse events. The Stop hook runs `core/gates/validator.js`, which scans `pipeline/gates/` for the most-recently-modified gate and validates that one. If you wrote multiple gates in one session, the validator looks at the latest.

### Why is `devteam next` saying "continue-stage" with one role pending, but I already wrote that role's gate?

Check the filename. Multi-role workstream gates use a dot separator: `pipeline/gates/stage-04.backend.json` (not `stage-04-backend.json` or `stage-04/backend.json`). And ensure `.json` extension.

## Multi-host routing

### Can I use two hosts in the same pipeline run?

Yes — that's a first-class feature. Install both adapters (`devteam init --host claude-code,codex` or `devteam init --host claude-code,omnigent`) and edit `.devteam/config.yml`:

```yaml
routing:
  default_host: claude-code
  roles:
    backend: codex
```

`devteam stage build` will produce 4 prompts; backend's points at Codex's role prompt path, the rest point at Claude Code subagents. Each writes its own workstream gate; the orchestrator merges at the contract boundary.

### Which adapter handles the merge?

The orchestrator. The merge is host-agnostic — it just reads JSON files. The `host` field on each workstream gate is preserved in the merged `workstreams[]` array so the merged gate tells you which workstream came from which host.

### Can I add Cursor / Aider / Cline / Windsurf as a host?

Yes. Gemini CLI is already shipped as a plugin package (`packages/host-gemini-cli/` — `npm install @devteam/host-gemini-cli`; deprecated upstream, see `devteam doctor`). For others, implement `hosts/<your-host>/adapter.js` per the contract in `core/adapters/host-adapter.md` — see [`CONTRIBUTING.md`](../CONTRIBUTING.md) recipe 1, or ship it as a `@devteam/host-<name>` plugin package the same way (see `packages/host-gemini-cli/README.md`) if it's not meant to be first-party-maintained. Adding a host is intentionally a small, self-contained task. The codex/gemini-cli adapters are the closest templates for IDE-embedded tools.

### Does the routing config support different model versions of the same host?

Not directly for CLI-based hosts. The routing key is the host name (`claude-code`, `codex`). To use different models per role within those hosts, configure that in the host itself (e.g., Claude Code's `.claude/agents/<name>.md` has a `model:` field; Codex prompts can be wrapped with model selection). The framework's routing layer routes to *hosts*, not *models within a host* — see [`docs/BACKLOG.md`](BACKLOG.md) G2 / D5 for the planned "adaptive routing" work.

For `openai-compat`, per-role model selection is a first-class config feature — see below.

### Can I use open-weight models like DeepSeek, Kimi, or Qwen with Stagecraft?

Yes — via the `openai-compat` host adapter. It routes roles to any provider that exposes an OpenAI-compatible Chat Completions endpoint, including OpenAI, OpenRouter, Fireworks AI, Fuel iX, hosted open-weight providers, and internal gateways. Unlike CLI-based hosts, per-role model selection is configured directly in `.devteam/config.yml`:

```yaml
routing:
  default_host: openai-compat

hosts:
  openai-compat:
    base_url: https://api.openai.com/v1
    api_key_env: OPENAI_API_KEY
    models:
      default:   gpt-4.1-mini
      principal: gpt-4.1        # reasoning-heavy roles
      security:  gpt-4.1
      red-team:  gpt-4.1
      backend:   gpt-4.1-mini   # implementation roles
      qa:        gpt-4.1-mini   # test authoring
      verifier:  gpt-4.1        # verification
```

Swap `base_url`, `api_key_env`, and model IDs for your provider. See [Using openai-compat](user-guide.md#using-openai-compat-openai-compatible-apis) for the full config schema, env vars, limitations, and model recommendations.

### Does prototype mode work with openai-compat?

Yes. `devteam prototype start`, `note`, and `promote` are local filesystem
tooling. `devteam prototype build` can use `openai-compat` as its headless host:

```bash
devteam prototype build settings-flow --host openai-compat
```

By default, the build runs from `pipeline/prototypes/<id>/workspace/` and
openai-compat's post-hoc write audit only allows that packet directory. Passing
`--apply-to-project` deliberately expands the prototype write scope to the
project root, but the output is still not gate evidence.

### Which roles should get expensive models (Opus) vs. cheaper ones?

General heuristic: assign expensive models where reasoning depth or consequence of error is highest.

**Opus-class (reasoning-heavy, high-consequence):**
- `principal` — architecture rulings, design sign-off, ADR authorship
- `security` — veto power; a miss here can be catastrophic
- `red-team` — adversarial review quality scales sharply with model capability
- `migrations` — veto power; broken migrations can destroy data

**Sonnet-class (capable, fast, affordable):**
- `backend`, `frontend`, `platform`, `qa` — implementation and test work
- `pm` — brief-writing and spec authorship

**Haiku or equivalent (pattern-matching, low-stakes):**
- QA on repeat test suites once patterns are established
- Accessibility audit on stable UI patterns

These are starting points. `npm run routing:suggest` can propose swaps based on your actual first-try pass rates and cost per role.

### In a multi-host setup, can I retry just one failed workstream without re-running the others?

Yes. The orchestrator tracks workstreams individually. `devteam next` will report `continue-stage` with the specific role(s) still pending. Re-run only the failing workstream — the passing workstreams' gate files already exist on disk and won't be overwritten unless you explicitly run that role again.

## Comparing to other tools

### How does this compare to LangGraph / AutoGen / CrewAI?

Different problem space. Those are agent-framework libraries: you write Python and they coordinate LLM calls. Stagecraft is a pipeline scaffold for AI coding tools (Claude Code, Codex, Gemini CLI). It installs role prompts and orchestrates which one runs when, but model invocation happens inside the coding tool, not via a framework SDK. If your team already uses Claude Code or Codex, Stagecraft integrates with that; if you're building a custom agent app, those frameworks are the right choice.

### How does this compare to Aider's `/architect` mode or Cursor's composer?

Those are single-session multi-agent modes within one tool. Stagecraft is a structured pipeline with persistent gates, conditional dispatch, multi-host routing, and a stop/resume model that survives across sessions. The trade-off: more setup, more discipline, more durable for non-trivial features. Use Aider's architect mode for quick interactive sessions; use Stagecraft when you need auditability and stage gates.

### Our CI/CD already validates code — does Stagecraft replace that or layer on top?

Layer on top. Stagecraft is not a CI/CD system. It doesn't replace:
- Lint, type-check, compile, unit test suites (run these inside Stage 4b build as always)
- Branch protection, PR review, merge policies (Stagecraft produces gate JSON; your team still merges)
- Deployment pipelines (Stagecraft writes a runbook at Stage 8; your CD system executes it)

What Stagecraft adds is the structured AI-authored *artifacts* (brief, design spec, test plan, runbook, retro) and the *gate contract* between them. The actual mechanical verification (does the code compile, do tests pass) still runs in your existing CI. Stage 4b's build agents are expected to run `npm test`, `cargo check`, etc., and include the result in the gate; they don't replace those tools.

Stagecraft is the project management and code-quality reasoning layer; your CI is the mechanical verification layer.

### How is this different from claude-dev-team or codex-dev-team?

Stagecraft unifies them into one core. See [ADR 001](adr/001-unification-vs-fork.md) for the full reasoning. Key differences:

- One framework, four host adapters (claude-code, codex, gemini-cli, generic). No more parity drift between forks.
- Per-workstream routing: a single pipeline can dispatch different roles to different hosts.
- Contract F: gate identity uses `orchestrator` + `host` + `workstream`. The legacy `agent` field is gone.
- WARN status for non-blocking warnings.
- Conditional stages (security review fires only when pre-review flags it).
- Per-role `allowedWrites` filtering in multi-role stages.
- 1 200+ automated tests vs the forks' 20-26.

## Customization

### Can I add a project-specific role / stage / skill?

Yes. See [`CONTRIBUTING.md`](../CONTRIBUTING.md) for the recipes. The cleanest approach is to fork Stagecraft and add your custom roles in your fork's `roles/` — that way your changes survive framework updates.

### Can I disable the stoplist?

You can bypass per-invocation with `--force`. To disable globally, you'd need to edit `STOPLIST_GUARDED_TRACKS` in `bin/devteam` or remove the patterns from `core/guards/stoplist.js`. The BACKLOG flags "configurable stoplist via `.devteam/config.yml`" as a follow-up.

### Can I use a different deploy adapter (e.g. AWS CDK, Pulumi)?

Yes. Add `core/deploy/<your-adapter>.md` with the procedure, then reference it in `.devteam/config.yml`:

```yaml
deploy:
  adapter: my-adapter
```

The Platform role at Stage 8 reads the config and follows your adapter's procedure.

## Operational

### `pipeline/context.md` keeps growing — is that a problem?

Yes once it exceeds ~150–200 lines. The file is in the `readFirst` list for nearly every stage, so every dispatch reads it whole. A 300-line context.md adds thousands of tokens per stage across a full run.

**What accumulates:** stage-04 assumption blocks, ruling text, blocker injections, gate outcome summaries. Most of this is valuable during its originating run, but stale once the pipeline is past it.

**What to prune vs. keep:**

| Content | Action |
|---|---|
| Binding constraints (env vars, API endpoints, auth conventions) | **Keep always** — agents at every stage need these |
| Active `<!-- devteam:run-blockers -->` injection | **Keep** until resolved; `devteam restart <stage>` clears it |
| Stage-04 assumption blocks (workstream notes) | **Cut after build is done** — code is now the source of truth |
| Ruling text from resolved escalations | **Compress to one line** — "Deploy B1/B2 false positives resolved 2026-06-18" |
| Gate outcome summaries (PASS, BF-NN fixes) | **Keep a one-liner** if the detail matters for regressions; cut the rest |
| Old `QUESTION:` / `PM-ANSWER:` pairs that are answered | **Cut** — the answer is reflected in the brief or the code |

**Track restarts don't reset it.** Running `--track quick` or `--track nano` on top of a completed full-track run reads the same `pipeline/context.md` in full. There's no automatic cleanup on track switch. Run `devteam compact` to strip all machine-written marker sections at once, then prune any remaining human-authored stale content manually before starting a new feature.

**Structural fix for sequential feature development:** switch to `isolation: bounded` in `.devteam/config.yml`. Each `devteam run --feature "..."` then gets its own `pipeline/changes/<slug>/context.md` — a fresh context per feature. The base `pipeline/context.md` becomes the permanent static layer (binding constraints only). See [Bounded workspace isolation](#bounded-workspace-isolation).

**Automatic partial relief (32.5):** every marker-section write is checked against `pipeline.context_budget_bytes` (default 8 KB). Over budget, the oldest RESOLVED machine-written section — currently `right-sizing`, `deploy-target`, `red-team-blockers`, and `qa-build-blockers`, each resolved once its owning stage gate is PASS/WARN — compacts in place to a one-line digest pointing at the full text archived under `pipeline/context-archive/`. This is partial, not a substitute for `devteam compact`: `run-blockers`, human-authored prose, and any other section aren't auto-compacted and can still push you over budget. Separately, every rendered stage prompt now includes a "Context changes since your last dispatch" section listing only the marker sections added/removed/compacted since that workstream's own previous dispatch (derived from `run-log.jsonl`), so a retried workstream isn't left guessing what changed since it last read the file — though it still receives the whole file via `readFirst`, this is a hint, not a substitute for reading it.

### When do I write `status: ESCALATE` vs `status: FAIL`?

**FAIL** means "this stage's criteria weren't met — fix the code/artifact and retry." The model writes FAIL when it can identify specific things that must be changed. `blockers[]` lists them. The human's job is to fix those things and re-run.

**ESCALATE** means "a human must make a decision before this pipeline can continue." Use escalation when:
- The model can't determine whether something should PASS or FAIL without human judgement (e.g. an ambiguous security finding that could be acceptable or unacceptable depending on business context)
- The scope of the change has grown beyond the brief and a human must decide whether to re-scope or proceed
- A veto-eligible finding requires a policy decision (not just a code fix)
- After several FAIL+retry cycles without progress — the failure pattern itself may need human analysis

The pipeline halts on ESCALATE. `devteam next` returns `resolve-escalation` and nothing advances until you rewrite the gate.

### What goes in `escalation_reason` and `decision_needed`?

Both are free-text strings:
- `escalation_reason` — factual summary of why escalation was written. What did the model observe? What was ambiguous or out of scope?
- `decision_needed` — what the human must decide. Phrased as a question or a choice. E.g. "Accept this permission scope as minimal-viable, or require a redesign?"

Neither field has a schema constraint beyond being a non-empty string. The goal is that a human reading `devteam next`'s output can understand the situation and make a call without re-reading the full stage output.

### When does Stage 4b (security review) actually run? What about Stage 4d (migration safety)?

Both are conditional on Stage 4a (pre-review) gate fields:

- **Stage 4b (security review)** runs only when `stage-04a.security_review_required: true`. Pre-review sets this when it detects patterns related to auth, cryptography, PII handling, secrets management, IAC changes, or new/upgraded external dependencies with elevated permissions.
- **Stage 4d (migration safety)** runs only when `stage-04a.migration_safety_required: true`. Pre-review sets this when the diff touches schema files, migration directories, or files containing DDL fragments (ALTER/CREATE/DROP TABLE).

If pre-review didn't set these flags, `devteam next` skips the conditional stages silently. To check whether they'll run for your current diff, look at the pre-review gate after it's written:

```bash
cat pipeline/gates/stage-04a.json | jq '{security_review_required, migration_safety_required}'
```

### How does retry tracking work? What is `retry_number`?

Gates can carry a `retry_number` field (integer ≥ 1) indicating this is a re-attempt. If `retry_number >= 1`, the validator requires a non-empty `this_attempt_differs_by` field — a string describing what changed between this attempt and the previous one. This prevents silent retry loops where the model just writes the same failing gate again.

The framework does **not** automatically increment `retry_number` — the model is expected to write it. If you're hand-editing a gate for a re-run, include both fields:

```json
{
  "retry_number": 1,
  "this_attempt_differs_by": "Fixed the SQL injection risk in user_search(); added parameterized query"
}
```

The framework also does **not** auto-escalate after N retries. If you've retried several times without progress, write the gate with `status: ESCALATE` manually. This is a deliberate decision: auto-escalation would require the framework to define "N retries is too many," which varies by stage and context.

### What are `noted_for_followup` items and how do I handle them?

Some stages — red-team (Stage 4c), build QA (Stage 4), and peer-review (Stage 5) — write `noted_for_followup[]` to their gate for findings that are real but non-blocking. They're explicitly deferred by the agent. Left unaddressed, they frequently surface as peer-review CHANGES_REQUESTED or QA blockers.

Use `devteam advise` to triage them:

```bash
devteam advise                               # view all unresolved items with risk classification
devteam advise --apply AC-11=B:PROJ-99,RT-01=A   # classify each
```

Options per item:
- **`=A` (scaffold)** on a `QA_BLOCKER` — dispatch QA to add a `@wip` test stub; prints the command to run
- **`=B:TICKET` (defer)** — writes `DEFERRED: AC-N — ticket PROJ-99` to `pipeline/context.md`; QA skips coverage check for that AC
- **`=C` (amend)** — writes `BRIEF-AMEND-NEEDED:` for PM to scope-down the AC before peer-review
- **`=D` (nothing)** — records `NOTED:` and moves on; QA will block if the AC is unmet
- **`=B` (known-flaky)** on a `QA_NOISE` item — writes `KNOWN-FLAKY:`; QA retries once before counting a failure

Run `devteam advise` after red-team PASS and before QA augmentation or peer-review. See [fix-and-retry.md § Case 11](runbooks/fix-and-retry.md#case-11-advise-workflow--triage-follow-up-items-before-downstream-stages) for the full workflow.

### When should I run `devteam advise` relative to other stages?

**Recommended timing:** after red-team PASS and before QA augmentation or peer-review dispatch.

```
Red-team → PASS
  ↓
devteam advise --apply ...    ← your call; encode decisions in context.md
  ↓
QA augmentation (if needed)
  ↓
devteam stage peer-review     ← reviewers see your decisions in context.md
```

You can also run `devteam advise` any time `devteam next` emits a ⚠ line. If you're in CI and don't want the advisory warning, pass `--skip-advise` to `devteam next`.

After peer-review, you can advise again on any `noted_for_followup` items peer-review itself produced. There is no penalty for running it multiple times — the advisory section in `context.md` is replaced atomically on each `--apply` call.

### What's the rough cost of a full 18-stage pipeline run?

Highly variable — depends on feature complexity, model tier, and how many retries occur. Very rough benchmarks on a medium-complexity feature (1-2 weeks of engineering work):

| Configuration | Approximate cost per full run |
|---|---|
| All Opus | $3–8 |
| Opus for reasoning roles, Sonnet for build | $0.80–2 |
| Sonnet throughout | $0.30–0.80 |

The most expensive stages are build (4 workstreams), peer-review (4 workstreams), and any retries on those. Red-team on Opus adds $0.20–0.50. `npm run dashboard:cost` shows the actual breakdown from your gate files once the run completes.

### What happens if a Stage 4b security veto fires?

The pipeline halts at Stage 4b — `devteam next` reports `resolve-escalation`. A veto cannot be overridden by peer-review approvals. The Security role must personally re-review the fix and flip `veto: false` in the gate before the pipeline can advance.

### What if Stage 5 reviewers can't agree?

After two review rounds with persistent CHANGES_REQUESTED, the gate's `escalated_to_principal` should flip to `true` (this is part of the approval-derivation hook's logic). The Principal then makes a binding ruling and either flips the gate to PASS or the team negotiates the change.

### Stage 5 is FAIL but no reviewer objected — where's the failure coming from?

A **quorum miss**, not an objection. The merged `stage-05.json` aggregates four per-area gates (`stage-05.backend.json`, `…frontend.json`, `…platform.json`, `…qa.json`); each area gate needs `approvals.length >= required_approvals` to PASS. If one area received fewer area-reviews than required — even with every review file that *was* written being APPROVED — that area's gate is FAIL, and the merge lifts the FAIL into the merged gate's `workstreams[]` entry for that area.

Key vocabulary trip: at Stage 5, `workstreams[]` are **areas of code being reviewed**, not reviewers. A FAIL on `workstreams[].workstream: "qa"` means "the qa *area* didn't reach quorum," not "the qa reviewer objected." See [`concepts.md` §stage-05 vocabulary callout](concepts.md#stage-05-vocabulary-callout).

**Before reading any gate as authoritative, sync it:**

```bash
# Always run this first — per-area gates may be stale if review files were written
# in a prior session or without the hook active.
devteam derive-approvals
```

Then diagnose:

```bash
cat pipeline/gates/stage-05.<area>.json \
  | jq '{status, approvals, required_approvals, changes_requested, failure_reason, action_required}'
# If changes_requested is [] and approvals.length < required_approvals → quorum miss.
# failure_reason will be "INSUFFICIENT_APPROVALS".
# action_required will list eligible reviewers and the exact steps to resolve.
```

You may also see `WARN: self-review skipped` in the hook's stderr output. This is
expected and non-blocking — it means a reviewer's file contained a `## Review of <area>`
section for their own workstream, which the hook skips (self-reviews don't count toward
quorum). If the area is still under-approved after the warning, you need a different
reviewer to cover it.

Resolve by having an eligible reviewer (see `rules/stage-05.md` matrix table for who
covers which areas) append a `## Review of <area>` section to their
`pipeline/code-review/by-<role>.md` file, then running `devteam derive-approvals`
(no-arg form processes all review files), then `devteam merge peer-review`. The
`devteam derive-approvals` step is needed because the `approval-derivation` hook fires
only when an agent writes a file inside an active Claude Code session — shell or editor
saves bypass it. Full operational sequence — including the override-to-WARN escape hatch
and its caveats — is in [`docs/runbooks/fix-and-retry.md` §Case 5](runbooks/fix-and-retry.md#case-5-peer-review-stage-05-fail-with-no-objections--quorum-miss).

### How do I roll back a deploy?

The role brief explicitly prohibits auto-rollback. The runbook (`pipeline/runbook.md`) names the rollback procedure and a human decides whether to roll back or investigate. The deploy gate records `rollback_executed: false` by default; PASS requires this to be false.

### Where do I see the cumulative cost of a pipeline run?

Two complementary surfaces:

- `npm run dashboard:cost` rolls up `tokens_in / tokens_out / cost_usd / duration_ms` from every gate in `pipeline/gates/`. Group by host / role / stage.
- `npm run budget` against a per-project budget config alerts when a run exceeds a configured ceiling.

Both read fields that gates already record (the C4 reproducibility set). Host-level dashboards (Anthropic / OpenAI billing) remain the source of truth for actual invoiced cost.

## Roadmap

### What's planned next?

See [`docs/BACKLOG.md`](BACKLOG.md). The BACKLOG is the authoritative source; any item list here goes stale faster than the file does.

## Stuck pipelines and recovery

### What if I run `devteam stage X` but nothing happens?

Check in order:

1. **Is the stage gated on a prior stage?** `devteam next` will report `run-stage <N>` — if that's a different stage than you tried to run, earlier stages are incomplete. Run them first.
2. **Is the `--feature` flag matching your pipeline directory?** If you initialized with a specific feature name, the same name must be passed on every invocation. Without it, the orchestrator may be looking at a different pipeline path.
3. **Is the host CLI installed?** `devteam doctor` will flag a missing adapter. If the adapter install script wasn't run (or failed silently), the host can't be dispatched.
4. **Is the host CLI authenticated?** The adapter shells out to `claude`/`codex`/`gemini` — if the CLI exits immediately without output, it's usually an auth error. Run the CLI directly with a test prompt to confirm.
5. **Is the gate file already there?** If a gate file exists for that stage, `devteam stage X` with no `--force` flag produces no output (the stage is already done). Delete the gate file to re-run.

### A workstream is stuck — the LLM stopped responding or got confused

Two recovery options:

- **Re-invoke the subagent** with a clearer instruction. The most common cause is the model lost context mid-task or misread the prompt. Re-running the stage is safe — the orchestrator overwrites the workstream's previous (incomplete) gate when a new one is written.
- **Hand-write the gate.** If the model produced the artifact but not the gate, you can write the gate JSON yourself. See `rules/gates-core.md` for the universal fields and the per-stage `rules/stage-NN.md` for extra fields. The orchestrator doesn't care how the gate got there.

If neither works: write the gate with `status: "ESCALATE"`, fill `escalation_reason` with what happened, and run `devteam next` — it'll route you to `resolve-escalation` and the pipeline halts cleanly until you decide.

### QA found implementation bugs during the build stage — how do I get the right agents to fix them?

QA's workstream gate will have `status: FAIL` with the bugs in `blockers[]`. When the validator runs, it automatically writes those blockers into `pipeline/context.md` (between `<!-- devteam:qa-build-blockers -->` markers) so implementation agents see them on the next re-run.

Use `--workstream` to target only the affected roles — no gate deletion needed:

```bash
devteam stage build --patch --from stage-04.qa --workstream backend --workstream platform --workstream qa --headless
devteam merge build
```

`--patch --from stage-04.qa` reads the QA gate's `blockers[]` and injects a PATCH MODE block into each dispatched prompt. `--workstream` dispatches only the named roles; frontend's gate is left untouched.

See [Fixing QA failures within build](user-guide.md#fixing-qa-failures-within-build) in the user guide for the full workflow including manual `context.md` editing when you need more explicit role assignments.

### A multi-role stage has one workstream stuck and the others are done — what do I do?

`devteam next` will report `continue-stage` with the specific role still pending. You have three options:

1. **Re-run only that workstream.** Invoke the agent for the stuck role specifically — the other workstream gate files already exist and won't be touched. This is the preferred path when the failure is transient (auth error, context overflow, rate limit).
2. **Hand-write the workstream gate.** If the role's *artifact* is done (the code was written) but the gate wasn't, write the gate manually with the required fields. Once all workstream gates exist, `devteam merge <stage>` can aggregate them.
3. **Write the stuck workstream's gate as ESCALATE.** If the workstream genuinely failed and can't be retried without a decision, write `status: ESCALATE` for that workstream. The merge will produce a merged ESCALATE and the pipeline halts — which is the correct outcome.

The pattern to avoid: deleting other workstreams' gates to "reset" the stage. Those gates represent completed work; deleting them means re-running all workstreams from scratch.

### The pipeline is in a state I can't reason about

Three diagnostic commands:

```bash
devteam summary           # one-screen view of every stage's status
devteam validate          # what the validator thinks of the most recent gate
ls -la pipeline/gates/    # the ground truth — gate files in order of mtime
```

The pipeline state is **only** the JSON files in `pipeline/gates/`. There's no hidden state, no database, no in-memory cache. If you can read the gate files, you can reason about the pipeline. Worst case: delete the gate files for stages you want to re-run and start over.

### Red-team failed — what do I re-run?

Red-team FAIL means `must_address_before_peer_review` is non-empty. When the gate is written, the validator automatically injects the blockers into `pipeline/context.md` so the next build re-run sees them. Use `--patch` to also scope the build agents explicitly to those items:

```bash
devteam stage build --patch --from red-team --headless
devteam stage pre-review --headless
devteam stage security-review --headless   # if still required by pre-review
devteam stage red-team --headless          # verifies the fixes
```

`--patch` reads the blockers from `pipeline/gates/stage-04c.json` and injects a PATCH MODE section into the prompt — agents are told to fix only the named items and leave everything else alone. This reduces the risk of a full build re-run introducing new findings.

`devteam next` returns `fix-and-retry` when red-team fails — it won't walk you through the build re-run automatically, because it can't distinguish code fixes from documentation fixes. The re-run sequence is always manual.

For **documentation-only findings** (e.g. "this permission isn't explained in the IAM policy comments"), you can re-run red-team directly without rebuilding.

If a finding requires a design decision before the build agents can act (e.g. "the permission set is fundamentally too broad — what's the minimum viable scope?"), add a note to `pipeline/context.md` before re-running build. That file is read first by every stage and is the intended channel for human direction between stages.

Use `--workstream <role>` to re-run only the affected build role — no manual gate deletion needed:

```bash
devteam stage build --workstream backend --patch --from red-team --headless
devteam merge build
devteam stage red-team --headless
```

For the complete operational sequence — including what to do with `noted_for_followup` items and the equivalent flow for QA / pre-review / peer-review FAIL — see **[`docs/runbooks/fix-and-retry.md`](runbooks/fix-and-retry.md)**.

### Can red-team miss a finding on the first pass and catch it on a later run?

Yes, and this is expected. Red-team is an LLM agent, not a static analyser — it walks a checklist of attack surfaces (input validation, state boundaries, sequence ordering, resource exhaustion, abuse cases, etc.) but does not guarantee complete coverage in a single pass. Different runs explore the surface differently.

What this means in practice:

- **First run PASS → second run finds a must-fix.** This happens. A code change in between (even a small one like a Dockerfile fix) can draw the agent's attention to a surface it walked more shallowly the first time. It is not a pipeline bug — it is the probabilistic nature of LLM-driven review.
- **PASS does not mean "no vulnerabilities."** It means no findings rose to `must-fix` in that pass. Adversarial coverage scales with model capability and how much of the attack surface the agent happened to inspect deeply on that run.
- **Iterative runs compound coverage.** Each fix-and-retry cycle re-exposes the agent to the full codebase with fresh context. Findings from earlier runs stay in `context.md` (via the validator's injection) so the agent builds on prior work.

For high-assurance work on the `full` track, verification-beyond-tests (stage-06d) adds property-based and mutation testing after QA to catch correctness failures that red-team typically misses.

### Can I roll back to an earlier stage?

Yes. Two ways:

- **Re-run an earlier stage.** Writing a new gate file for an earlier stage doesn't roll back the later ones — they still exist on disk. But `devteam next` only cares about the most recent gate per stage, so re-running a stage with `--feature "..."` and producing a new gate effectively "rewinds" that stage.
- **Restart later stages.** If you want to truly start over from stage-04, run `devteam restart build --cascade`. The orchestrator will then see those stages as pending.

`devteam replay <stage-id>` re-runs a recorded stage with the current config and diffs the new gate against the original — useful for verifying that a fix actually changed the outcome. `devteam restart <stage>` clears a stage's gate files so it can be re-run fresh.

## Running offline / in CI

### Can the full 18-stage pipeline run automatically in CI, or is it meant to be human-driven?

Both modes are valid and serve different needs:

**Human-driven** (the default): a human triggers each stage, reviews outputs, and decides whether to advance. Most teams use this for non-trivial features — stage outputs warrant a human read before committing to the next stage.

**Fully automated**: use `devteam run`, the bounded autonomous driver:
```bash
devteam run --track nano --budget-usd 10 --json
```

The driver handles `next → dispatch → merge`, retries transient dispatch
failures, auto-fixes code-defect failures within its retry budget, and halts
for human decisions. In practice, fully automated runs work best on `nano` or
`quick` tracks for low-risk changes. Full-track automation needs a conscious
policy for escalations, budgets, sign-off, and deploy.

A common hybrid: automate stages 1–3 (brief, design, clarification) and 4 (build + pre-review), then require a human for peer review (stage 5) and sign-off (stage 6).

For long unattended runs on a worker machine, use the Docker runner so the
process is not tied to an interactive shell:

```bash
docker run --rm \
  -v "$PWD:/workspace" \
  --env-file .devteam/docker.env \
  stagecraft-runner:local run --cwd /workspace
```

### We're a monorepo — can the pipeline scope to a sub-tree?

Yes, with a configuration-level convention. Set `context.scope` in `.devteam/config.yml`:

```yaml
context:
  scope: packages/payments-service   # relative to repo root
```

The agents are prompted to limit their analysis to that sub-tree. Gate files land in `pipeline/gates/` relative to whichever directory you run `devteam` from (use `--cwd` to target a different root). Run separate `devteam` invocations from separate directories to isolate pipelines per package.

`allowedWrites` is always the role contract, but enforcement depends on the host. For parallel headless build roles in a Git repository, `pipeline.workstream_isolation: git-worktree` adds a host-neutral reconciliation boundary: unauthorized results are not copied into the operator checkout and the workstream gate fails. This is not an OS sandbox; use a container or VM when running untrusted code. See [ADR-018](adr/018-isolated-build-workstreams.md).

### Can I run Stagecraft fully offline?

Mostly yes. The framework itself is offline (Node, no network calls). The model invocation is whatever the host CLI does — `claude --print` and `codex exec --sandbox workspace-write` need network; `generic` host doesn't run a model at all.

The memory system's default embedder (`Xenova/bge-small-en-v1.5`) downloads ~33MB on first use, then runs offline. If your CI doesn't have network access, set `DEVTEAM_EMBEDDING_PROVIDER=stub` to skip embedding entirely.

OpenTelemetry is no-op when `OTEL_EXPORTER_OTLP_ENDPOINT` is unset — no network attempts.

### How do I run Stagecraft in CI?

Add `devteam init --host <name>` to your project bootstrap script and use `--headless` for stage invocations:

```yaml
# .github/workflows/pipeline.yml
- run: npm ci
- run: devteam init --host claude-code
- run: devteam stage build --feature "${{ github.event.pull_request.title }}" --headless
- run: devteam next --json | jq .action
```

Set the host CLI's auth via the standard env (`ANTHROPIC_API_KEY`, `OPENAI_API_KEY`, etc.) in your CI secrets. For openai-compat, set the env var named by `api_key_env` in your config (for example `OPENAI_API_KEY`, `FIREWORKS_API_KEY`, `FUELIX_API_KEY`, or `OPENROUTER_API_KEY`). The orchestrator never handles tokens — it just shells out to `claude` / `codex` / `gemini`, or calls the configured OpenAI-compatible API directly for openai-compat.

`scripts/pr-publish.js` (run via `npm run pr-publish`) posts gate status as GitHub check runs on the PR head commit. PASS → success, WARN → neutral, FAIL/ESCALATE → failure.

### Should I use the Docker runner in CI?

Use it for adjacent autonomous jobs, not for the shipped PR-check workflow. The
CI template installed by `devteam ci install` validates and publishes existing
gates; it does not run model work. If your team wants a scheduled `nano` run,
a dependency-update bot lane, or a long audit job, the Docker runner gives that
job a repeatable non-root environment:

```bash
docker build -f hosts/docker/Dockerfile -t stagecraft-runner:ci .
docker run --rm \
  -v "$PWD:/workspace" \
  --env-file .devteam/docker.env \
  stagecraft-runner:ci run --cwd /workspace --budget-usd 10
```

Keep credentials in CI secrets, env files generated by the job, Docker secrets,
or the runner's secret manager. Do not bake provider keys into the image. The
container writes normal `pipeline/` artifacts to the mounted workspace, so the
same validation and PR-publish checks can read them afterward.

### What about running on a remote worker / cloud function?

Use the Docker runner first when a single worker machine is enough. It runs the
local orchestrator in one container against a mounted workspace and leaves all
durable state in `pipeline/`. For multi-hour audits, run that container on a
larger host or under your scheduler, then commit or publish the resulting
pipeline artifacts.

BACKLOG A3 covers a fuller cloud-runner adapter that ships stage execution to a
remote worker pool. That is separate from the Docker runner: Docker packages
one local/unattended run; a cloud-runner would add remote dispatch semantics.

## Auditing past runs

### If I need to prove a feature went through all 18 gates, what do I show an auditor?

Three things, all in git if you committed `pipeline/`:

1. **The gate files** — `pipeline/gates/stage-01.json` through `stage-09.json` (for a full-track run). Each gate records `status`, `orchestrator` (framework version), `host` (model CLI), and `timestamp`. An auditor can see that every stage was completed, by which host, at what time.
2. **The artifacts** — `pipeline/brief.md`, `pipeline/design-spec.md`, `pipeline/test-report.md`, `pipeline/runbook.md`, `pipeline/retrospective.md`. The audit trail isn't just the gates; it's the documents each stage produced.
3. **`devteam reproduce <stage>`** — prints a reproducibility report for any gate: model version, prompt hash, seed, temperature. If the auditor needs to verify what the model was actually asked, `system_prompt_hash` in the gate ties back to a specific prompt version.

If you also ship OTel traces to a collector, span IDs in the gate files connect to detailed execution traces. See `docs/user-guide.md#observability` for the OTel setup.

### Can I replay a gate exactly if models are updated?

Only if the model supports the replay contract. The gate records `model_version` (exact version string, not just `claude-opus-4`), `seed`, `temperature`, `max_tokens`, and `system_prompt_hash`. To replay:

1. Invoke the model with the same `model_version`.
2. Use the same `seed` and `temperature`.
3. Confirm the system prompt hashes to the same `system_prompt_hash`.

In practice: determinism is not guaranteed by any major model provider, even with identical seed/temperature. `devteam reproduce <stage>` reports **replay readiness** (`full` / `partial` / `incomplete`) and lists what's missing — it doesn't actually re-run the stage. The audit value is "we can show what the model was asked"; not "we can prove the output would be byte-identical."

If a model version is retired (e.g. an older Claude snapshot is no longer available), the replay contract is broken for that gate — the reproducibility fields are still useful for audit, but you can't re-run it on the same model.

### How do I see every change a feature went through?

`pipeline/gates/` is the audit trail. After a full-track run:

```bash
ls -la pipeline/gates/
# stage-01.json  through  stage-09.json
# plus per-workstream gates for multi-role stages

cat pipeline/gates/stage-01.json | jq    # the brief gate
cat pipeline/brief.md                     # the artifact
cat pipeline/design-spec.md
cat pipeline/code-review/by-*.md          # all reviewer comments
cat pipeline/test-report.md
cat pipeline/runbook.md
cat pipeline/retrospective.md
```

If you commit `pipeline/` to git (recommended), `git log pipeline/` is a complete history of every change every feature went through.

### How do I get pass rates across past runs?

`scripts/dashboard.js` (alias `npm run dashboard`) aggregates `pipeline/gates/` and produces per-stage / per-host / per-role / per-status pass-rate reports. Flags:

```bash
npm run dashboard                              # current project
npm run dashboard -- --from proj1,proj2,proj3  # multi-project rollup
npm run dashboard -- --since 2026-03-01         # time-windowed
npm run dashboard -- --json                     # machine-readable
```

Useful for monthly pipeline retrospectives: which stages are flakiest, which model performs best at which role, and whether pass rates are trending up or down.

### Can I see who approved what?

For Stage 5 peer-review specifically: yes. The reviewer files (`pipeline/code-review/by-<reviewer>.md`) carry one section per area being reviewed, with explicit `REVIEW: APPROVED` / `REVIEW: CHANGES REQUESTED` markers. The merged stage-05 gate's `workstreams[]` array shows who approved what area and which host they came from (for fanout configurations).

For other gates: the `host` field on workstream gates tells you which model produced it, and the `orchestrator` field tells you which framework version validated it. Beyond that, attribution is whatever your git log shows.

## Multi-host specifics

### What if Claude says PASS and Codex says FAIL in fanout review?

Pessimistic merge. Any FAIL anywhere → merged FAIL. Any WARN → merged WARN. Only all-PASS gives merged PASS. The intent is to err on the side of "if any model has concerns, surface them" — which is the whole point of fanout.

The blockers list in the merged gate concatenates blockers from all FAILing workstreams, prefixed with the host that produced them. So you can see exactly which model flagged what.

### Do hosts share context between workstreams?

No. Each workstream is a fresh dispatch with its own prompt. The shared state is the files on disk (`pipeline/brief.md`, `pipeline/design-spec.md`, prior gates, etc.). One workstream's output becomes another workstream's input through the file system, not through model state.

This is by design. Cross-workstream context-sharing would tie workstreams to specific hosts (which model can share state with which other model?) and break the model-agnostic story. The gate JSON + artifact files are the contract.

### What if my OTel collector goes down mid-pipeline?

Tracing fails gracefully. The OTLP exporter logs a connection error to stderr and continues; pipeline execution is unaffected. Spans for that period are lost. The pipeline itself doesn't depend on observability working.

If you'd rather not see the error messages: unset `OTEL_EXPORTER_OTLP_ENDPOINT` to disable tracing entirely, or set `DEVTEAM_OTEL_DISABLE=1` for a hard disable.

### Can I use a different model within Claude Code itself?

Yes. Edit `.claude/agents/<name>.md`'s frontmatter — the `model:` field lets you pin a specific model per subagent. Stagecraft's routing layer routes to *hosts*, not *models within a host*; for finer-grained model selection, configure that inside the host.

The Claude Code adapter sets reasonable defaults in `hosts/claude-code/adapter.js` (Principal → Opus, dev-* → Sonnet, QA → Haiku, etc.) — adjust as you see fit.

## Memory and learning

### Does the memory system need to be set up before the first pipeline?

No. The memory system is additive — the pipeline runs fine with no memory store, no embedder, and no prior ingestion. What you give up: the retrospective synthesis at Stage 9 won't have historical patterns to draw on, and agents won't have prior lessons-learned injected into their context.

For a first run: skip it entirely. The pipeline produces its own `pipeline/lessons-learned.md` at Stage 9, which becomes the seed for future runs. After your first complete run, `devteam memory ingest pipeline/` gives Stage 9 of your second run access to Stage 9 of your first.

### How often should I re-ingest memory?

Re-ingest after each complete pipeline run — specifically, after Stage 9 writes a new `pipeline/retrospective.md` and updates `pipeline/lessons-learned.md`:

```bash
devteam memory ingest pipeline/lessons-learned.md
devteam memory ingest pipeline/retrospective.md
```

You don't need to re-ingest the whole project every time — only ingest new or changed artifacts. Re-ingesting an artifact that's already in the store replaces its chunks (no duplicates).

Also re-ingest after major changes to `pipeline/context.md`, your architecture docs, or any reference material the agents use. The memory system's value compounds over time — a project on its tenth feature will have richer lessons than one on its first.

### How does the memory system handle outdated information?

It doesn't — that's intentional. The memory store is append-only by design; re-running `devteam memory ingest` on an updated artifact replaces that artifact's chunks (no duplicates), but historical chunks from previous projects or older versions of the same artifact stay if you indexed them.

If you want to clean stale memory: `devteam memory clear` (wipes everything), then re-ingest current artifacts. There's no per-chunk pruning today (BACKLOG D3 candidate).

### Can memory leak sensitive content?

Potentially yes. The memory store contains plaintext copies of every chunk it indexes — briefs, design specs, retros — which may include sensitive material. **Add `.devteam/memory/` to your `.gitignore`** unless you have a deliberate sharing strategy. The default behavior is per-project memory only; cross-project import (BACKLOG D3) will be opt-in.

For per-artifact opt-out: include `stagecraft-no-memory` anywhere in the file (a comment line works). Stagecraft skips that artifact at ingest.

### What happens to lessons-learned that aren't reinforced?

They age out automatically. Each lesson in `pipeline/lessons-learned.md` carries a `**Reinforced:** N (last: YYYY-MM-DD)` line. The Stage 9 retrospective synthesis bumps the count when a similar pattern recurs. Lessons that haven't been reinforced in 10 runs are aged out by the auto-prune rule — they get retired with a note about why.

This prevents lessons-learned from becoming a wall of accumulated wisdom that nobody reads. The 10-run threshold is in `rules/retrospective.md`; tune for your team if needed.

### How is proposed pattern learning different from memory?

`devteam memory` is a retrieval system: it indexes selected artifacts so later stages can
draw on project context. Proposed `devteam patterns` would be a reviewed coaching loop:
Stagecraft would collect sanitized blockers, warnings, auto-retry outcomes, and positive
examples, then inject only promoted, relevant, budgeted guidance into future coding-agent
prompts. Pattern learning is designed to mirror engineering growth — fewer repeated
mistakes and better judgment — without turning every warning into a permanent rule.

See [`docs/pattern-learning.md`](pattern-learning.md) and
[`plans/phase-27-pattern-learning.md`](../plans/phase-27-pattern-learning.md).

## Operational gotchas

### Why doesn't my headless run work even though `claude --version` is fine?

`claude --version` only verifies the CLI is installed — it doesn't test auth or model access. For headless execution, the CLI needs:

1. **Auth that works non-interactively.** `ANTHROPIC_API_KEY` must be set, not just the interactive session auth. Test: `echo "hello" | claude --print` — if it prints output without prompting for login, auth is working.
2. **Correct model access.** If you're requesting Opus and your key only has Sonnet access, the CLI exits with an error. The error may be silent if the adapter doesn't propagate stderr. Run the Claude adapter invocation manually to see stderr: `claude --print --model <model> < /dev/null`.
3. **No interactive session conflict.** If Claude Code is open in a terminal with an active session, some CLI modes conflict. Close the interactive session and retry.
4. **Adapter install up to date.** `devteam doctor --verbose` shows whether the Stop hook is wired and the subagent files are in place. Re-run `devteam init --host claude-code --force` if any are missing.

### My hooks are firing but nothing happens

Check the hook output. Claude Code writes hook output to its own log; `devteam validate` runs the validator directly and prints to stdout. If a hook is silently no-op'ing, the most common causes:

- The hook script wasn't installed — re-run `devteam init --host claude-code --force`.
- The hook is firing on a different event than you think. `cat .claude/settings.local.json | jq .hooks` to see the wiring.
- The gate file isn't where the hook expects. Validator scans `pipeline/gates/` — if you're writing gates elsewhere (e.g. `pipeline/gates/stage-04/backend.json` instead of `stage-04.backend.json`), the validator won't find them.

### `devteam doctor` says everything's green but stages fail

Doctor verifies install integrity — the right files in the right places. It doesn't verify the host CLI actually works for your project. Check:

- Does the host CLI run interactively? `claude` should drop you into a session.
- Are credentials set? `claude --version` works without auth; `claude --print "test"` needs auth.
- Is your project's source tree something the host can read? Permissions matter.

### A gate has the right shape but the validator rejects it

Run `devteam validate` for the exact error. Common causes:

- The gate has a field with the wrong type (e.g. `status: 1` instead of `"PASS"`).
- The `status` value is outside the allowed set (`PASS`, `WARN`, `FAIL`, `ESCALATE`).
- The gate has a `retry_number >= 1` but no `this_attempt_differs_by` field — the retry-integrity check.
- An older gate in `pipeline/gates/` has `status: ESCALATE` that's unresolved — bypassed-escalation halts the pipeline regardless of which gate you just wrote.

### A markdown host shows ENOENT errors for `.devteam/templates/` — is something broken?

It usually means the target project was initialized with an older Stagecraft install. Re-run `devteam init --host <host> --force` with the same host (`codex`, `gemini-cli`, or `openai-compat`) so `.devteam/templates/` is populated alongside `.devteam/rules/`, role prompts, and skills. `devteam doctor` will report missing installed templates.

### The model in an openai-compat stage used `sed -i 'expr' file` and it failed on macOS — why?

macOS ships BSD `sed`, which requires an explicit empty-string backup extension: `sed -i '' 'expr' file`. GNU `sed` (Linux) accepts `sed -i 'expr' file` without the suffix — which is what most models write by default. To prevent the issue, add a note to your `pipeline/context.md` binding-constraints section before running the pipeline:

```markdown
## Binding implementation constraints

macOS environment: use BSD `sed` syntax — `sed -i '' 'expr' file`, not `sed -i 'expr' file`.
```

### A stage halted with `structural-input` but the model seemed to be working — what happened?

The most likely cause is a function-calling regression at long context. Some model/provider combinations use an internal chat-template format for tool calls instead of returning native OpenAI `tool_calls` JSON. At short context they may produce correct `tool_calls`; at long context — after a stage has read many files and accumulated a large conversation — they can revert to their internal format and emit the tool call as plain text content instead. The adapter receives an empty `tool_calls` array, executes nothing, writes no gate, and the orchestrator correctly halts.

**How to confirm:** look for lines like `` `functions.write_file:17 <|tool_call_argument_begin|> {"path": ...}` `` in the model's text output (visible in the [devteam] log). That prefix (`functions.name:idx`) is the internal Kimi tool-call ID format leaking into content.

**Recovery:** the auto-fix retry cycle normally recovers on its own — context resets between dispatches, so the next attempt starts short. If retries keep failing:
1. Check whether `pipeline/context.md` has grown very large; trim any long verbatim sections.
2. For `backend` or `verifier` roles, swap the configured model/provider pair to one you have verified emits native `tool_calls` at long context, such as OpenAI GPT models, DeepSeek V3/V4, or Qwen Coder variants on a compatible provider.

This class of issue is provider- and model-template-specific. Kimi K2 has [a documented upstream example](https://blog.vllm.ai/2025/10/28/Kimi-K2-Accuracy.html) where third-party serving infrastructure may expose raw tool-call template behavior.

### Does openai-compat need `--headless` on every `devteam stage` invocation?

No. When the configured `default_host` is `openai-compat` (which declares `httpNative: true`), `devteam stage <name>` auto-enables headless mode and prints:

```
[devteam] openai-compat is HTTP-native — running headlessly
```

Passing `--headless` explicitly is also accepted. This auto-detection fires only when `default_host` is httpNative; if you're routing a single role to openai-compat via `routing.roles` while keeping a CLI adapter as `default_host`, `--headless` is still required for the CLI-based stages.

### Can I set per-role timeouts?

Not natively in the framework today (BACKLOG E-series). The framework shells out to the host CLI and waits for it to exit — it inherits whatever timeout the host CLI imposes.

Workarounds:
- **Claude Code**: no built-in timeout flag; the `max_turns` subagent frontmatter field limits the number of agent turns, which indirectly limits wall-clock time on bounded tasks.
- **Codex**: Stagecraft's `--timeout-ms <milliseconds>` caps each workstream's wall-clock time around `codex exec --sandbox workspace-write`.
- **Generic host**: wrap the host invocation in `timeout <seconds> <command>` in your shell script.

For CI, you likely want pipeline-level timeouts (fail the job if a stage hasn't produced a gate in N minutes) rather than per-role timeouts. A simple wrapper:
```bash
timeout 600 devteam stage build --headless || { echo "Build stage timed out"; exit 1; }
```

### Can I disable OTel for specific stages?

Not at the stage level — the OTel instrumentation wraps the entire orchestrator invocation. To skip tracing for a specific run, unset the exporter endpoint for that invocation:

```bash
OTEL_EXPORTER_OTLP_ENDPOINT="" devteam stage build --headless
```

If you want permanent per-stage OTel control, it would require patching `core/telemetry/tracer.js` to read a stage-level skip list from config. That's not in BACKLOG yet — file an issue if it's blocking you.

### What if the stoplist is blocking a legitimate change?

The stoplist exists to prevent the orchestrator from writing to sensitive paths (root config, lock files, framework code) — it's a safety rail, not a policy. If it's blocking a path that should be writable for your project, two options:

1. **Per-invocation bypass**: `devteam stage build --force`. The `--force` flag skips stoplist checking for that invocation only. Use this for one-off cases.
2. **Permanent config exception**: add the path pattern to `.devteam/config.yml` under `stoplist.exceptions`. This is project-level, not framework-level — it won't affect other projects:
```yaml
stoplist:
  exceptions:
    - "infra/terraform/**"   # our IaC managed by the Platform role
```

Don't blanket-disable the stoplist (`STOPLIST_GUARDED_TRACKS: []` in `bin/devteam`) unless you understand what it's protecting. The most common paths on the list are there because real incidents put them there.

### How big can a gate file be?

The validator caps gates at 1 MB. Real gates are typically <1 KB. If you're hitting the cap, something has gone wrong — usually a huge `blockers` array or a stringified test output that should have been a separate artifact.

## Auditing a codebase

### How do I audit a codebase?

In Claude Code: `/audit` (full) or `/audit-quick` (Phases 0-1 only). On other hosts, invoke the `auditor` role with the `audit` skill (installed at `.codex/skills/audit/` or `.gemini/skills/audit/` after `devteam init`). See [`docs/user-guide.md`](user-guide.md#auditing-a-codebase) for the full reference.

The audit is read-only. It writes findings to `docs/audit/00-project-context.md` through `docs/audit/10-roadmap.md`. It never modifies source code.

### What's the difference between the audit and the pipeline?

The **pipeline** (`devteam stage <name>`) *builds* features through 18 staged production steps with gate JSON between them. Audits are NOT pipeline stages.

The **audit** (`/audit` or `/audit-quick`) *analyzes* an existing codebase and produces a prioritized improvement roadmap. Read-only.

You'd run the pipeline when you want to ship something. You'd run the audit when you want to understand what's there.

### Can I run an audit on Stagecraft itself?

You can but you usually shouldn't — the audit feature is designed to be invoked from within a target project, against that project's code. If you point it at the Stagecraft framework, you'll get an audit of the framework's own code (which is interesting but not what most users want).

If you genuinely want to audit Stagecraft (e.g. you're contributing): `cd` into the framework and run the audit there. The output lands at `docs/audit/` in the framework repo. Add it to `.gitignore` so audits don't pollute the framework's git history unless you want them to.

### How long does an audit take?

- `/audit-quick` (Phases 0-1): ~5-15 minutes on a medium codebase.
- `/audit` (Phases 0-3): ~30-60 minutes. Longer for large codebases; deep analysis (security, performance, code quality) does the heavy lifting.

Wall-clock varies by codebase size and how many findings each phase produces. The human checkpoints between phases (after 0, 1, 2) add whatever review time you take.

### What if the audit interrupts mid-run?

The audit writes `docs/audit/status.json` after each phase completes. Run `/audit --resume` to continue from the last completed phase. Phase outputs already on disk aren't re-written.

### Can the audit be re-run as a periodic health check?

Yes. Re-running `/audit` against a project that has previous audit outputs overwrites them with fresh findings. There's no automatic diff between runs (BACKLOG candidate); you'd compare by reading both versions or by version-controlling `docs/audit/` and using `git diff`.

Recommended cadence: re-audit quarterly, after major refactors, after major dependency upgrades, before a release that touches sensitive paths.

### What if I want to add project-specific checks?

Create `docs/audit-extensions.md` in your project. Per phase, describe the project-specific checks to run. The audit reads this file at the start of each phase and appends results under a `## Project-Specific` heading in the relevant phase output file.

Use cases: PCI / HIPAA / SOC 2 compliance checks, team-specific naming conventions, custom security policies, internal patterns you want to track.

## Comparing to /goal and similar features

### Should I use Stagecraft or Claude Code's `/goal` command?

Both, for different purposes. `/goal` is a continuation primitive: set a session-level condition and the host loops until it holds. Stagecraft is a decomposition primitive: one feature decomposes into 18 stages with defined artifacts and gates.

They compose: for `build` (stage-04) and `qa` (stage-06), hosts that declare `capabilities.goalLoop: true` (claude-code and codex) automatically receive a `/goal "<condition>"` prepended to the headless prompt — the host loops internally until the stated condition holds, then the gate is written. Setting one manually before other stages works fine.

### Where does Stagecraft fit relative to Codex's autonomous task mode?

Codex's autonomous mode is one model running until a task is done. Stagecraft is a structured pipeline across roles, with artifacts and gates between them. If your task fits in one model's context and you trust it to converge, use Codex's autonomous mode. If your task needs structure across stages, multiple roles, or auditability, use Stagecraft.

You can also run Stagecraft with Codex as the host. The `codex` adapter dispatches each workstream as a separate `codex exec --sandbox workspace-write` invocation. Codex still operates autonomously per workstream; Stagecraft provides the cross-workstream structure.
