# EXAMPLE — One pipeline run, end to end

Walks one feature ("Add SMS notification opt-in to user settings") through the full Stagecraft pipeline.

If you read one doc to learn Stagecraft, read this one.

> **Freshness:** verified at v0.11.0. Two kinds of output appear below, and they
> have different provenance:
>
> - **Live v0.11 dogfood evidence** — re-captured 2026-08-09 with the real CLI and
>   Codex in a dedicated Stagecraft clone. The repair outcome and observed failure
>   modes are recorded immediately below.
> - **SMS walkthrough output** — `devteam init`, `devteam next`, dispatch lines,
>   gate JSON, and file counts were originally captured at v0.9.0. They remain an
>   illustrative walkthrough of the artifact and gate shapes; exact counts and
>   incidental output can change between releases.
> - **Model-written content** — the brief text, design spec, review comments, and the
>   wall-clock timings of real model calls. Carried over from the original v0.7.0 run
>   against live Claude Code. The prose is what that model wrote then, not a synthetic
>   v0.11 transcript.
>
> Timings shown for model dispatches are from that original run and vary widely by model
> and feature size — read them as order-of-magnitude, not benchmarks.
> `npm run consistency` warns when this stamp is more than one minor behind the current version.

## v0.11 live dogfood capture

The v0.11 release was exercised against Stagecraft's own repository from a dedicated
clone, with Codex as the headless host. The repair request was deliberately small:
make the documented `devteam --version` invocation work from outside a target project.

```bash
devteam init --host codex --profile dogfood
devteam run --repair "Running devteam --version returns Unknown command; add a canonical version flag backed by package.json and lock it with tests and generated docs" \
  --budget-usd 25 --timeout-ms 1200000
```

The run diagnosed the missing global-token branch correctly, expanded the affected-file
list when it found three stale documentation provenance claims, and produced an executable
regression criterion. It also exposed three orchestration defects that a fixture-only test
would not have found:

1. A ten-file CLI repair initially fanned out to four build roles. Each role tried to run
   the full suite in one shared checkout, producing redundant 7–19 minute workstreams and
   `EMFILE` watcher exhaustion. A Principal ruling narrowed the repair to `active_roles:
   ["backend"]`.
2. After that narrowing, the runtime workstream id became bare `stage-04`, but the static
   backend write contract authorized only `stage-04.backend.json`. The required gate was
   rejected by the post-hoc write audit. v0.11 now always authorizes the exact dynamically
   dispatched gate path.
3. The workstream verifier appended nonexistent `src/backend/` and `src/tests/` targets to
   ESLint even though the repair touched Stagecraft framework files. v0.11 now retains
   existing role-owned lint paths and falls back to the project's canonical lint command
   when none exists.

The final orchestrator-owned verification was clean:

```text
stage-04: PASS
lint: npm run lint (exit 0; canonical fallback recorded)
test: npm test (exit 0; 3,217+ passing, 0 failing, 2 skipped across captures)
consistency: 402 checks passed
resolution: stage-04/code-defect accepted (derivable)
```

This capture is intentionally candid: the first run did not glide through. It paid for
several redundant model turns and revealed that full-suite execution belongs to the
orchestrator verification layer, not every coding role. That evidence is now both a set of
regression tests and input to the Phase 41 calibration gate; it is not counted as a second
independent project.

## Setup

Initialize a target project. We're using a temp dir; in real life this is your project root.

```bash
TARGET=$(mktemp -d)
devteam init --host claude-code --cwd "$TARGET"
```

```
Initializing devteam in: /tmp/example-target
Host(s): claude-code
  ✓ wrote .devteam/config.yml
  ✓ created pipeline/
  ✓ created pipeline/gates/
  ✓ created .devteam/templates/
  ✓ wrote AGENTS.md (stub — edit with project context)

Installing host adapter: claude-code
  written: 68, skipped: 0

Installing deploy adapter: local (default)
  ✓ wrote   .devteam/adapters/local.md
  ✓ wrote .gitignore (stagecraft block)

Next: edit .devteam/config.yml if you need custom routing, then `devteam stage requirements --feature "..."`.
```

72 files landed:
- 14 role subagents in `.claude/agents/` — the 12 original roles plus `critic` (adversarial review, 31.3) and `reflector` (run-end learning, 30.3)
- 3 slash commands in `.claude/commands/` (`devteam`, `audit`, `audit-quick`)
- 30 rules docs in `.devteam/rules/` — 10 top-level plus one per stage
- 20 task skills in `.claude/skills/`
- 1 `.devteam/config.yml`, 1 `settings.local.json` wiring the hooks
- 1 `.devteam/adapters/local.md` (the default deploy adapter)
- an `AGENTS.md` stub and a managed `.gitignore` block

`AGENTS.md` is a stub on purpose — fill it in with your project's conventions, because every stage prompt tells the model to read it first.

Check what to do next:

```
$ devteam next --cwd "$TARGET"
▶️ run-stage — requirements (stage-01)
   stage not started
   → devteam stage requirements
```

---

## Your first stage, step by step

Stagecraft is an orchestrator, not a model. **`devteam stage <name>` renders a prompt for your AI tool.** Then it's on you (or `--headless` mode) to feed that prompt to the model. The model writes an artifact + a gate JSON file. The Stagecraft validator reads the gate and either advances the pipeline or halts it.

There are **two ways** to feed the prompt to a model. Both produce the same gate file at the end. Pick whichever fits how you want to work.

### Path A — `--headless` (recommended for first-timers)

One terminal. One command. Watch the model's output stream in your terminal. The gate file appears when the model finishes.

#### What you type

```bash
devteam stage requirements --feature "Add SMS notification opt-in to user settings" --headless
```

#### What you see — step by step

**Step 1.** Stagecraft logs that it's dispatching the workstream:

```
[devteam] dispatching pm → claude-code (headless)
```

**Step 2.** The orchestrator spawns `claude --print --output-format stream-json --verbose` and pipes the rendered stage prompt to it via stdin. The JSON stream is how the orchestrator reads real token counts and cost (28.1); the human-readable text is teed to `pipeline/logs/<workstream>.log` so transcripts stay readable. Claude's output streams to your terminal as the model works. You'll see:
- Claude acknowledging the prompt and reading its `pm` subagent brief.
- Claude reading the brief template (`templates/brief-template.md`).
- Claude writing `pipeline/brief.md` section by section.
- Claude writing the gate JSON (`pipeline/gates/stage-01.json`).

This takes ~20–40 seconds for a small brief on a current Claude model.

**Step 3.** When Claude finishes, Stagecraft reports a one-line summary:

```
  ✓ pm (claude-code): exit 0, 23154ms → pipeline/gates/stage-01.json
```

`exit 0` = model finished cleanly. `→ pipeline/gates/stage-01.json` = the gate file got written. If you see `(no gate written)` instead, the model didn't write the gate (re-run the stage, or hand-write the gate).

#### What's on disk now

```bash
$ ls pipeline/
brief.md           gates/

$ cat pipeline/brief.md
# Feature Brief

## Problem
Customers currently can't disable marketing SMS without contacting support…
[full brief]

$ cat pipeline/gates/stage-01.json
{
  "stage": "stage-01",
  "workstream": "pm",
  "host": "claude-code",
  "orchestrator": "devteam@0.9.0",
  "status": "PASS",
  "track": "full",
  "timestamp": "2026-08-03T14:32:11Z",
  "blockers": [],
  "warnings": [],
  "acceptance_criteria_count": 5,
  "out_of_scope_items": [...],
  "required_sections_complete": true,
  "dispatched_tool_budget": ["Read", "Write", "Glob"],
  "prompt_pack_version": "00bd1d34ff67",
  "chain": {
    "prev_stage": null,
    "prev_hash": null,
    "algo": "sha256-canonical-json"
  },
  "_orchestrator_observed": {
    "tokens_in": 14203,
    "tokens_out": 1875,
    "cost_usd": 0.0461,
    "model_observed": "claude-sonnet-5",
    "source": "claude-code:stream-json",
    "at": "2026-08-03T14:32:11Z"
  }
}
```

The model writes the top block. **Everything from `dispatched_tool_budget` down is added by the orchestrator, not the model** — that split is the whole point of the gate contract:

- `dispatched_tool_budget` — the tools this workstream was actually granted.
- `prompt_pack_version` — content hash of `roles/ + rules/ + templates/`, so you can later ask "did that role-brief edit change outcomes?" (33.3).
- `chain` — hash link to the predecessor gate, making the trail tamper-evident (`devteam verify-chain`).
- `_orchestrator_observed` — token counts and cost parsed from the host CLI's own output. Before v0.8 the only cost number in a gate was whatever the model claimed about itself; now `--budget-usd` counts this instead (28.1–28.4). On a host that reports no usage you get `tokens_estimated: true` and a labelled estimate rather than a confident wrong number.

#### What you do next

```bash
$ devteam next
▶️ run-stage — design (stage-02)
   stage not started
   → devteam stage design
```

Stagecraft read the stage-01 gate, saw `status: "PASS"`, and reports the next action. Run it:

```bash
$ devteam stage design --feature "Add SMS notification opt-in" --headless
```

…and the loop continues. Each stage takes one command. You can step away while the model works (each `--headless` stage is `await`-able).

### Path B — Interactive in Claude Code (two windows)

Useful when you want to *see* what the subagent is doing — watch the file edits, the model's reasoning, intervene mid-stage if needed.

#### What you do — step by step

**Step 1.** In **Terminal 1** (your project directory), render the stage prompt:

```bash
$ devteam stage requirements --feature "Add SMS notification opt-in to user settings"
```

#### What you see

A boxed onboarding preamble at the top, then the actual stage prompt:

```
═══════════════════════════════════════════════════════════════════════
  Stage stage-01 (requirements) — 1 workstream to dispatch
═══════════════════════════════════════════════════════════════════════

  The block(s) below are prompts to feed to your model. devteam does
  NOT call a model — it renders the prompt and validates the gate JSON
  the model writes back.

  To run this stage, pick one:
    1. Inside Claude Code: paste the prompt, OR type
         /devteam stage requirements --feature "Add SMS notification opt-in..."
    2. Headless from terminal:
         devteam stage requirements --feature "..." --headless

  When done, each workstream writes pipeline/gates/stage-01*.json.
  Then run `devteam next` to see what to do next.
═══════════════════════════════════════════════════════════════════════

────────  workstream: pm  (host: claude-code)  ────────
# Stage stage-01 — requirements
Workstream: stage-01 (role: pm, host: claude-code)
...
[the actual prompt for the model]
```

**Step 2.** Open **Claude Code** (the CLI or the desktop app) at the same project root.

If you're using the CLI from a second terminal pane:

```bash
$ cd /tmp/example-target           # same directory you ran devteam init in
$ claude
```

If you're using the desktop app: open the app, point it at the same project root.

**Step 3.** In Claude Code's prompt, type the slash command (Stagecraft installed it at `.claude/commands/devteam.md`):

```
/devteam stage requirements --feature "Add SMS notification opt-in to user settings"
```

#### What you see in Claude Code

Claude Code recognizes `/devteam` as a slash command, reads `.claude/commands/devteam.md`, dispatches the PM subagent. You'll see Claude:

1. Acknowledge the slash command and read the `pm` subagent brief (`.claude/agents/pm.md`).
2. Read the brief template (`templates/brief-template.md`).
3. Write `pipeline/brief.md` section by section (you'll see the `Write` tool calls).
4. Write `pipeline/gates/stage-01.json` (another `Write` tool call).
5. The `Stop` hook fires (Stagecraft installed it at `.claude/settings.local.json`):

```
[gate-validator] ✅ GATE PASS — stage-01/pm (claude-code)
```

That last line confirms the validator ran on the gate and it passed. If the gate had failed (`FAIL` or `ESCALATE`), you'd see those statuses and the hook would exit non-zero.

#### What you do next

Switch back to **Terminal 1**:

```bash
$ devteam next
▶️ run-stage — design (stage-02)
   stage not started
   → devteam stage design
```

Same as Path A from here. The pipeline state lives in `pipeline/gates/`; both paths populate it identically.

For the next stage, you can switch paths if you want — run `--headless` for stages you trust, switch to interactive Claude Code for stages you want to watch.

### Alternative inside Claude Code: paste the prompt directly

Don't want to use the slash command? Copy everything between the `────────  workstream: pm` divider and the next divider (or end of stage marker), paste it into Claude Code. Claude will recognize the prompt structure and run the PM subagent. The slash command does the same thing — it's just a shortcut.

### What if I run `devteam stage` in a directory that isn't initialized?

Stagecraft warns you before printing the prompt:

```
⚠️  /path/to/your/dir
   does not look like an initialised Stagecraft target project (no .devteam/config.yml).
   The prompt below will reference role briefs / rules / templates that don't exist yet.
   Run this first to lay them down:
     devteam init --host claude-code --cwd "/path/to/your/dir"
```

The prompt still prints (in case you want to read it), but feeding it to a model in an un-init'd directory won't work — the prompt references files (`.claude/agents/pm.md`, `.devteam/rules/`, `templates/`) that don't exist.

### What if Claude doesn't write the gate file?

`devteam next` will keep reporting `run-stage` (or `continue-stage` for multi-role stages with partial completion). Three options:

1. **Re-run the stage.** Most common cause is the model lost context or skipped the gate step. Re-running overwrites cleanly.
2. **Hand-write the gate.** Look at `rules/gates-core.md` for the universal required fields and the per-stage `rules/stage-NN.md` for extra fields. Write a JSON file at the expected path. Stagecraft doesn't care how the gate got there.
3. **Escalate.** Write the gate with `status: "ESCALATE"` and a reason in `escalation_reason`. Stagecraft halts cleanly and surfaces the situation.

---

## What each stage does (reference)

The walkthrough above showed the user-facing flow for stage-01. The rest of this document is reference: what each stage's prompt actually contains, what artifact gets written, what's in the gate JSON. Skim or chase the specific stage you care about.

## Stage 1 — PM writes the brief

```bash
devteam stage requirements --cwd "$TARGET" --feature "Add SMS notification opt-in to user settings"
```

The CLI emits a prompt aimed at Claude Code:

```
────────  workstream: pm  (host: claude-code)  ────────

# Stage stage-01 — requirements
Workstream: stage-01 (role: pm, host: claude-code)
Track: full
Feature: Add SMS notification opt-in to user settings

Use the **pm** subagent (`.claude/agents/pm.md`) for this workstream.

## Objective
Turn the feature request into requirements, acceptance criteria, and scope boundaries.

## Read first
- AGENTS.md
- .devteam/rules/pipeline.md
- .devteam/rules/gates-core.md
- pipeline/context.md

## Allowed writes (enforced by Claude Code hooks at tool-call time)
- pipeline/brief.md
- pipeline/gates/stage-01.json
- pipeline/context.md

## Artifact
Produce `pipeline/brief.md` using `templates/brief-template.md`.

## Gate to write
Write to `pipeline/gates/stage-01.json`. You provide:
```json
{
  "stage": "stage-01",
  "workstream": "pm",
  "status": "PASS|WARN|FAIL|ESCALATE",
  ...
  "acceptance_criteria_count": 0,
  "out_of_scope_items": [],
  "required_sections_complete": false
}
```
The orchestrator adds `"orchestrator": "devteam@0.9.0"` and `"host": "claude-code"` at validation time.
```

Inside Claude Code, the PM subagent reads the brief template, drafts `pipeline/brief.md`, and writes the gate. The Stop hook fires the validator. PASS:

```
[gate-validator] ✅ GATE PASS — stage-01/pm (claude-code)
```

`devteam next` advances:

```
$ devteam next --cwd "$TARGET"
▶️ run-stage — design (stage-02)
   stage not started
   → devteam stage design
```

## Stages 2 and 3 — Design and clarification

Same shape: Principal drafts `pipeline/design-spec.md` and any ADRs; PM resolves any clarification questions. Each writes its gate; the validator hook accepts each; `next` walks forward.

```
$ devteam next --cwd "$TARGET"
▶️ run-stage — build (stage-04)
   multi-role stage not started
   → devteam stage build
```

## Stage 4 — Build (multi-role: 4 workstreams)

This is where the multi-workstream contract pays off. `stage-04` has four roles: `backend, frontend, platform, qa`. The orchestrator decomposes into one prompt per role.

```bash
devteam stage build --cwd "$TARGET" --feature "Add SMS notification opt-in"
```

Four sections come out, each pointing at a different subagent. Excerpt of the backend workstream:

```
────────  workstream: backend  (host: claude-code)  ────────

# Stage stage-04 — build
Workstream: stage-04.backend (role: backend, host: claude-code)
Track: full
Feature: Add SMS notification opt-in

Use the **dev-backend** subagent (`.claude/agents/dev-backend.md`) for this workstream.

## Allowed writes (enforced by Claude Code hooks at tool-call time)
- src/backend/
- src/tests/
- pipeline/pr-backend.md
- pipeline/build-plan.md
- pipeline/gates/stage-04.backend.json
- pipeline/context.md

## Gate to write
Write to `pipeline/gates/stage-04.backend.json`.
```

Note the per-role `allowedWrites` — backend can write `src/backend/` and `src/tests/` but **not** `src/frontend/`. Frontend's workstream gets the symmetric narrow set. The Claude Code hooks enforce this at tool-call time, not just in the prompt.

Each dev workstream produces:
- A PR summary (`pipeline/pr-<role>.md`)
- Their own workstream gate at `pipeline/gates/stage-04.<role>.json`

After all four workstreams finish, `devteam next` reports:

```
$ devteam next --cwd "$TARGET"
🔀 merge — build (stage-04)
   all workstreams complete; merge to produce stage gate
   → devteam merge build
```

`devteam merge build` aggregates them:

```
$ devteam merge build --cwd "$TARGET"
Merged → /tmp/.../pipeline/gates/stage-04.json (status: PASS)
```

The merged stage gate carries the contributing workstreams:

```json
{
  "stage": "stage-04",
  "status": "PASS",
  "orchestrator": "devteam@0.9.0",
  "track": "full",
  "timestamp": "2026-08-03T20:00:00Z",
  "blockers": [],
  "warnings": [],
  "workstreams": [
    { "workstream": "backend",  "host": "claude-code", "status": "PASS" },
    { "workstream": "frontend", "host": "claude-code", "status": "PASS" },
    { "workstream": "platform", "host": "claude-code", "status": "PASS" },
    { "workstream": "qa",       "host": "claude-code", "status": "PASS" }
  ]
}
```

Aggregate status follows `ESCALATE > FAIL > WARN > PASS`. If any workstream had FAILed, the stage gate would be FAIL.

## Stage 4a — Pre-review (Platform)

Platform runs lint, tests, dependency review, and the security-trigger heuristic. The gate carries `security_review_required: true | false`.

```json
{
  "stage": "stage-04a",
  "workstream": "platform",
  "host": "claude-code",
  ...
  "lint_passed": true,
  "tests_passed": true,
  "dependency_review_passed": true,
  "security_review_required": true
}
```

For an SMS opt-in feature that touches auth and PII paths, the heuristic fires. `next` routes to the conditional security review:

```
$ devteam next --cwd "$TARGET"
▶️ run-stage — security-review (stage-04b)
   stage not started
   → devteam stage security-review
```

(If the heuristic had not fired — `security_review_required: false` — `next` would silently skip stage-04b and advance to peer-review.)

## Stage 4b — Conditional security review

Conditional dispatch via the `conditionalOn: { stage: "stage-04a", field: "security_review_required", equals: true }` declaration on the stage.

The security subagent reviews; gate carries `security_approved` and `veto` flags. `veto: true` halts the pipeline regardless of any subsequent stage's approvals.

## Stage 5 — Peer review (4 area workstreams, derived from review files)

Peer-review has the same multi-workstream shape as build, but the **workstreams are areas being reviewed** (backend / frontend / platform / qa). All four dispatch to the same `reviewer` subagent (via `subagent: "reviewer"` on the stage).

Reviewers write per-area sections in their review files. The PostToolUse hook (`approval-derivation.js`) fires on every save, parses the file, and upserts the per-area workstream gates.

Two things changed here since v0.7 and both are worth knowing:

- **The orchestrator re-derives approvals after the merge, on every host** (31.5). The hook above only runs inside Claude Code, so a gate written by any other host used to be taken at its word. Now a workstream gate claiming approval whose review file actually says `CHANGES REQUESTED` flips the merged gate to FAIL, with the disagreement recorded.
- **There is an alternative to the four-area panel.** Setting `review.mode: adversarial` replaces it with one reviewer followed by a `critic` whose job is to attack the review — missed findings, unsupported approvals — and the stage passes only when the reviewer approves *and* the critic's challenges are resolved (31.3). When two or more hosts are configured, reviewer and critic default to different hosts. The panel below is still the default; this walkthrough shows it.

```bash
# Reviewer A writes pipeline/code-review/by-backend.md:
```

```markdown
# Review by backend

## Review of frontend
Form layout looks good, ARIA labels present, error states clear.
REVIEW: APPROVED

## Review of platform
Deploy steps documented in runbook.
REVIEW: APPROVED
```

```bash
# Reviewer B writes pipeline/code-review/by-frontend.md:
```

```markdown
# Review by frontend

## Review of backend
API surface clean. Validation symmetrical with the frontend.
REVIEW: APPROVED

## Review of platform
Smoke-test runbook references the wrong endpoint.
REVIEW: CHANGES REQUESTED
BLOCKER: pipeline/runbook.md §Smoke test mentions /api/sms but endpoint is /api/v2/sms
```

The hook runs on each write and reports:

```
[approval-derivation] dev-backend → APPROVED on frontend (approvals: 1/2, status: FAIL)
[approval-derivation] dev-backend → APPROVED on platform (approvals: 1/2, status: FAIL)
[approval-derivation] dev-frontend → APPROVED on backend (approvals: 1/2, status: FAIL)
[approval-derivation] dev-frontend → CHANGES_REQUESTED on platform (approvals: 1/2, status: FAIL)
```

Three area gates exist (`stage-05.frontend.json`, `stage-05.platform.json`, `stage-05.backend.json`); the qa area has no review yet, and the platform area has a blocker. `next` reflects state:

```
$ devteam next --cwd "$TARGET"
⏳ continue-stage — peer-review (stage-05)
   3/4 workstreams complete
   completed: frontend, platform, backend
   remaining: qa
   → devteam stage peer-review  # roles still pending: qa
```

After a fourth reviewer covers qa and the platform blocker is addressed (a second reviewer flips it from CHANGES_REQUESTED to APPROVED, bumping each area to 2/2 approvals), the area gates all PASS. `devteam merge peer-review` produces the stage-05 gate.

## Stages 6, 7, 8, 9 — Tests, sign-off, deploy, retrospective

Same shape as the others; nothing structurally new.

- **Stage 6 (QA)** writes `pipeline/test-report.md` and a gate carrying `all_acceptance_criteria_met` and the 1:1 criterion-to-test mapping.
- **Stage 7 (PM + Platform)** is the sign-off stage. The orchestrator can auto-fold this gate when Stage 6 reports `all_acceptance_criteria_met: true` AND a 1:1 mapping — see `rules/stage-07.md` §Gate.
- **Stage 8 (Platform)** runs the deploy adapter. The adapter (`core/deploy/<name>.md`) names the deploy procedure; gate carries `deploy_adapter`, `smoke_test_passed`, `runbook_referenced`. Do **not** auto-rollback on FAIL — the runbook names the rollback and a human decides.
- **Stage 9 (Principal)** synthesizes the retrospective. Harvests `PATTERN:` lines from Stage 5 reviews; promotes ≤2 rules into `pipeline/lessons-learned.md`; auto-ages out rules that haven't been reinforced in 10 runs.

When all stages PASS:

```
$ devteam next --cwd "$TARGET"
🎉 pipeline-complete
   all stages PASS or WARN (track: full)
```

## What the gates look like, end-to-end

After a successful full-track run, `pipeline/gates/` contains:

```
pipeline/gates/
├── stage-01.json              # PM brief
├── stage-02.json              # Principal design
├── stage-03.json              # PM clarification
├── stage-03b.json             # executable spec (Gherkin)
├── stage-04.json              # merged build (4 workstreams)
├── stage-04.backend.json
├── stage-04.frontend.json
├── stage-04.platform.json
├── stage-04.qa.json
├── stage-04a.json             # Platform pre-review (lint + tests, orchestrator-verified)
├── stage-04b.json             # (only if security_review_required)
├── stage-04c.json             # red-team (model pass + mechanical floor)
├── stage-04d.json             # migration safety
├── stage-05.json              # merged peer-review (4 area workstreams)
├── stage-05.backend.json
├── stage-05.frontend.json
├── stage-05.platform.json
├── stage-05.qa.json
├── stage-06.json              # QA test report (orchestrator-verified)
├── stage-06b.json             # accessibility audit
├── stage-06c.json             # observability gate
├── stage-06d.json             # verification beyond tests (PBT / mutation / formal)
├── stage-06e.json             # performance budget
├── stage-07.json              # sign-off
├── stage-08.json              # deploy
└── stage-09.json              # retrospective
```

That is all 18 stages of the `full` track. Shorter tracks write a subset — `quick` folds the four specialty QA stages (`06b`/`06c`/`06d`/`06e`) into a single `stage-06x` verification sweep (29.4), and `loop` writes only four gates.

Every gate carries the contract F identity fields. Every multi-role stage has a workstream gate per area plus the merged stage gate. The whole pipeline is auditable from these files alone — the orchestrator never holds state outside of them.

**Which of these the orchestrator actually verifies, rather than believing:** `stage-03b`, `stage-04a`, `stage-04c`, and `stage-06` are re-checked by running the real commands and are overwritten when the model's claim disagrees (31.1–31.2). `stage-04` build workstreams are stamped per role plus once on the merge. The rest — including `stage-06d` — are schema-shaped model self-report today; `stage-06d` stamping is planned as phase 35 item 35.3. `devteam verify-chain` checks the hash links across all of them.

## What this example didn't show

- **Multi-host routing.** This example installed only `claude-code`. To run backend on Codex and the rest on Claude Code, install both (`devteam init --host claude-code,codex`) and edit `.devteam/config.yml`:
  ```yaml
  routing:
    default_host: claude-code
    roles:
      backend: codex
  ```
  Then `devteam stage build` produces 4 prompts, with the backend workstream pointing at `.codex/prompts/roles/backend.md` and the rest pointing at `.claude/agents/dev-*.md`.

- **Headless invocation.** `devteam stage build --headless` would drive each workstream's host CLI non-interactively (`claude --print --output-format stream-json` for claude-code workstreams, `codex exec` for codex). Per-workstream exit codes + gate paths get reported in the summary.

- **The `loop` track — and it is now the recommended default for everyday changes.** This doc walks `full` because it shows every stage, but `full` is the *audited* path you choose when the stakes justify it. Most changes should run `loop`: four slots (requirements → build → qa → peer-review), same gate and chain artifacts on disk, a fraction of the cost. `devteam run` with no `--track` now assesses the change and picks a track for you (29.2). See [docs/tracks.md](docs/tracks.md).

- **Track shortcuts.** `devteam init` defaults `pipeline.default_track: full`. For a config-only change, edit that to `config-only` and `devteam next` walks a different stage list.

- **FAIL / ESCALATE branches.** A FAIL gate gives `❌ fix-and-retry` with blockers listed; an ESCALATE gate gives `🚨 resolve-escalation` with the reason. Both halt `next` until the situation is resolved.

## A second example: hotfix track

The example above ran the `full` track — every stage, in order. Real teams pick lighter tracks for smaller changes. Let's walk through a `hotfix` for an outage to show what a different track feels like.

**Scenario:** Production is alerting. The Stripe webhook handler is returning 500s. You've identified the root cause (a null-check missing after a recent dependency bump), and you need to ship a fix in <30 minutes.

The `hotfix` track skips the front-of-pipeline work — requirements / design / clarification — because you already know what's broken. It keeps every downstream safety stage (build → pre-review → security-review → peer-review → qa → accessibility-audit → observability-gate → sign-off → deploy → retrospective). That's 10 stages, but most run fast.

### Configure the track

```bash
# Edit .devteam/config.yml — change default_track to hotfix, OR pass it inline:
devteam stage build --feature "Fix Stripe webhook 500 — add null check on event.data.object" --track hotfix
```

The CLI's preamble identifies the track:

```
═══════════════════════════════════════════════════════════════════════
  Stage stage-04 (build) — 4 workstreams to dispatch
═══════════════════════════════════════════════════════════════════════
  ... track: hotfix ...
```

### Stage 4 — Build, fast path

Only backend is actually touched. The other three workstreams (frontend, platform, qa) run anyway because Stage 4 is a 4-role stage by structure — they each produce a one-line PR summary and a PASS gate explaining they're not in scope. Total wall-clock: ~3 minutes if you're running headless across all four.

The backend workstream adds the null-check, writes the test, and produces:

```json
// pipeline/gates/stage-04.backend.json
{
  "stage": "stage-04",
  "workstream": "backend",
  "host": "claude-code",
  "status": "PASS",
  "track": "hotfix",
  "blockers": [],
  "warnings": [],
  "files_changed": ["src/backend/webhooks/stripe.ts", "src/backend/webhooks/stripe.test.ts"]
}
```

After all four workstreams: `devteam merge build` → stage-04 gate, all-PASS.

### Stage 4a — Pre-review

Platform runs lint, tests, dep review, and the security heuristic against the diff. The diff touches `src/backend/webhooks/stripe.ts` — that path includes "stripe" but isn't on the explicit security trigger list. Lint passes; tests pass; security heuristic returns `security_review_required: false`.

```json
// pipeline/gates/stage-04a.json
{
  "stage": "stage-04a",
  "status": "PASS",
  "lint_passed": true,
  "tests_passed": true,
  "dependency_review_passed": true,
  "security_review_required": false
}
```

`devteam next` skips stage-04b (security review fires only when the prior gate's `security_review_required: true`) and advances to stage-05.

### Stage 5 — Peer review, single-host

For a hotfix, you probably don't want multi-model fanout — the cost-benefit tilts toward "ship fast." A single reviewer across all 4 areas is fine.

Reviewer writes `pipeline/code-review/by-senior.md`:

```markdown
# Review by senior

## Review of backend
Null check is correct. Test covers the regression. The fix is the smallest possible change.
REVIEW: APPROVED

## Review of frontend
Not in scope for this hotfix.
REVIEW: APPROVED

## Review of platform
Not in scope for this hotfix.
REVIEW: APPROVED

## Review of qa
Not in scope for this hotfix.
REVIEW: APPROVED
```

The PostToolUse hook fires four times, upserting four area gates. With 1 reviewer and a `required_approvals: 1` policy, each area's gate flips to PASS immediately.

### Stages 6, 6b, 6c — Tests, accessibility, observability

- **Stage 6 (QA):** the new test passes; the regression test specifically covers the null-data webhook payload. Gate carries `tests_total: <N+1>`, `tests_passed: <N+1>`, `all_acceptance_criteria_met: true`.

- **Stage 6b (accessibility):** backend-only change → `audit_skipped_reason: "backend-only change, no UI affected"`. Gate writes PASS with the skip reason.

- **Stage 6c (observability):** the brief said the webhook should emit `webhook.stripe.received` and `webhook.stripe.error` metrics. Platform greps the code: both are emitted (the existing emitters were untouched by the fix). Gate writes:

```json
{
  "stage": "stage-06c",
  "status": "PASS",
  "metrics": {
    "required": ["webhook.stripe.received", "webhook.stripe.error"],
    "verified": ["webhook.stripe.received", "webhook.stripe.error"],
    "gap": []
  },
  "verification_method": "code-grep"
}
```

### Stage 7 — Auto-fold sign-off

Stage 6 reported `all_acceptance_criteria_met: true` AND a 1:1 criterion-to-test mapping (the "fix the null case" criterion maps to one specific test). The orchestrator auto-folds Stage 7 — no human action — writing:

```json
{
  "stage": "stage-07",
  "status": "PASS",
  "auto_from_stage_06": true,
  "pm_signoff": "auto",
  "platform_signoff": "auto"
}
```

`devteam next` advances directly to stage-08.

### Stage 8 — Deploy

Platform follows `core/deploy/<adapter>.md` (whatever your team's deploy adapter is — Kubernetes, Terraform, custom). The gate carries `deploy_adapter`, `smoke_test_passed`, `runbook_referenced`. Stripe webhooks start returning 200s again; the alert clears.

```json
{
  "stage": "stage-08",
  "status": "PASS",
  "deploy_adapter": "kubernetes",
  "smoke_test_passed": true,
  "rollback_executed": false
}
```

### Stage 9 — Retrospective

Even hotfixes get a retro. Principal harvests `PATTERN:` lines from Stage 5 reviews (none in this case — single reviewer, straightforward fix), considers what to add to `pipeline/lessons-learned.md`. Likely outcome: add a lesson like `**Lesson:** dependency bumps that touch webhook handlers warrant an extra null-check pass before merge.`

Total wall-clock: ~25 minutes if running mostly user-driven, ~10 minutes if running mostly headless. The audit trail is complete: you can show stakeholders (or your incident review board) exactly what was changed, who approved it, what tests cover it, and how it was deployed.

### What this example demonstrates

- **Tracks scale the process to the change size.** Full track for cross-area features. Hotfix for production incidents. Quick for single-area work. Nano for typos.
- **Auto-fold prevents busy-work.** Stage 7 sign-off is automatic when Stage 6 reports complete acceptance criteria with a 1:1 test mapping. You don't sign off on what the system already proved.
- **Conditional stages keep the safety net light.** Security review fires only when pre-review's heuristic flags it. Accessibility audit can be explicitly skipped for backend-only changes (with a reason).
- **Even hotfixes produce a complete audit trail.** No corner-cutting on the record, just on the front-of-pipeline planning work that doesn't apply to "fix this specific bug now."

## Where to go next

- [`README.md`](README.md) — CLI surface, install layout, First 30 minutes path.
- [`docs/concepts.md`](docs/concepts.md) — vocabulary in one table.
- [`docs/user-guide.md`](docs/user-guide.md) — long-form daily-use reference.
- [`docs/tracks.md`](docs/tracks.md) — which track to pick for which kind of change.
- [`docs/adoption-guide.md`](docs/adoption-guide.md) — for team leads deciding whether to adopt.
- [`docs/presentation-notes.md`](docs/presentation-notes.md) — slide deck + speaker notes for pitching this to stakeholders.
- [`ARCHITECTURE.md`](ARCHITECTURE.md) — design model + the 11 locked decisions.
- [`CONTRIBUTING.md`](CONTRIBUTING.md) — extension recipes (adapter, stage, role, skill).
- [`docs/walkthroughs/stage-04-split-host.md`](docs/walkthroughs/stage-04-split-host.md) — the stress-test trace that locked the multi-workstream contract.
