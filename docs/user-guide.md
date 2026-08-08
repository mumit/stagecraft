# User guide

How to use Stagecraft day to day. Companion to:

- [`README.md`](../README.md) — what it is + the First 30 minutes path.
- [`EXAMPLE.md`](../EXAMPLE.md) — one full pipeline traced end to end.
- [`docs/concepts.md`](concepts.md) — the six primitives in a table.
- [`docs/tracks.md`](tracks.md) — which track to pick for which kind of change.

If you've never used Stagecraft before, read EXAMPLE first. This page is a reference for active use.

- [The shape of one run](#the-shape-of-one-run)
- [Your three moments of control](#your-three-moments-of-control)
- [Install + first run](#install--first-run)
- [Daily loop](#daily-loop)
- [Prototype first, harden later](#prototype-first-harden-later)
- [Running each stage](#running-each-stage)
- [Multi-host setups](#multi-host-setups)
- [Headless mode](#headless-mode)
- [Docker runner](#docker-runner)
- [The web UI](#the-web-ui)
- [Persistent memory](#persistent-memory)
- [Pattern learning](#pattern-learning)
- [Observability (OpenTelemetry)](#observability-opentelemetry)
- [Multi-model peer review](#multi-model-peer-review)
- [Auditing a codebase](#auditing-a-codebase)
- [When things go wrong](#when-things-go-wrong)
- [Customizing for your project](#customizing-for-your-project)
- [Upgrading](#upgrading)
- [What's not covered here](#whats-not-covered-here)

---

## The shape of one run

One pipeline run looks like this:

```
   you                                                          you
    │                                                            │
    │  "Add SMS opt-in"                                          │  reviews, decides, signs off
    ▼                                                            │
  devteam stage requirements ──► host ──► model writes brief.md  │
                                          + gate stage-01.json   │
                                                  │              │
                                                  ▼              │
                                            devteam next ────────┘
                                                  │
                                                  ▼
  devteam stage design ──► host ──► model writes design-spec.md
                                     + gate stage-02.json
                                              │
                                              ▼
                                       devteam next
                                              │
                                              ▼
   (loop for 16 more stages on the full track)

  Multi-role stages (build, peer-review) decompose into per-workstream
  dispatches that each write their own gate. devteam merge <stage>
  aggregates them.

  Conditional stages (security-review) fire only when a prior gate's
  field has a specific value.
```

This diagram walks the `full` track's 18 stages to show every kind of step. Day-to-day iteration typically runs the lighter `loop` track instead — brief → build → verify → review, 4 dispatches, no design/red-team/deploy. See [`docs/tracks.md`](tracks.md#pick-by-what-youre-shipping) for when to reach for which.

You initiate and review each cycle; the framework handles bookkeeping: which stage is next, what to dispatch, where the gate goes, whether it's valid, and whether the pipeline can advance.

## Your three moments of control

Three points define how you interact with the pipeline:

1. **At the start.** You pick the track and write the feature brief in one paragraph. Everything downstream flows from this.
   ```bash
   devteam stage requirements --feature "Add SMS notification opt-in to user settings" --track loop
   ```
   `--track loop` is shown here because it's the day-to-day default for bounded iteration; reach for `--track full` instead when the change is regulated or high-stakes enough to need the audited path (design + red-team + sign-off). Omit `--track` to fall through to `pipeline.default_track` or an inferred assessment — see [`docs/tracks.md`](tracks.md).

2. **At every gate.** You read the gate (or skim `devteam next`'s summary) and decide: advance, fix and retry, or stop.
   ```bash
   devteam next                  # what's next?
   devteam summary               # one-screen view of everything
   devteam ui --open             # web UI with live updates
   ```

3. **At escalations.** When the pipeline halts (`status: ESCALATE` or `veto: true`), you make a binding call. Resolve the gate to PASS or stop the pipeline.

Which subagent to invoke, which file to write, what schema the gate has, and how to aggregate workstreams are all handled by the framework.

---

## Install + first run

```bash
# 1. Get the framework (one time, anywhere)
git clone <repo> /path/to/stagecraft
cd /path/to/stagecraft
npm install

# 2. Make the CLI available globally (optional, recommended)
npm link

# 3. In your target project
cd ~/projects/my-app
devteam init --host claude-code        # or codex / antigravity / omnigent / openai-compat / acp
                                        # gemini-cli is a plugin (34.4): npm install @devteam/host-gemini-cli first
```

`devteam init` lays down:

```
my-app/
├── .devteam/
│   ├── config.yml              ← routing + track defaults
│   └── rules/                  ← 10 top-level rule docs + per-stage stage-NN.md files
├── .claude/                    ← (or .codex/, .gemini/, .omnigent/, depending on host)
│   ├── agents/                 ← 12 role subagents
│   ├── skills/                 ← 13 task helpers (implement, review-rubric, …)
│   ├── commands/               ← /devteam, /audit, /audit-quick (claude-code only)
│   └── settings.local.json     ← Stop / SubagentStop / PostToolUse / PreToolUse hooks (portable — safe to commit)
└── pipeline/
    └── gates/                  ← empty; gates land here as stages run
```

Verify with:

```bash
devteam doctor
```

A green result confirms the framework, adapter install, and (if applicable) the host CLI on PATH are all wired. Read `.devteam/config.yml` to view or edit the routing.

## Daily loop

(This section is about the habitual `next` → `stage` cycle, not the `loop` track — see [`docs/tracks.md`](tracks.md) for the track of that name.)

Most pipeline work uses two commands:

```bash
devteam next            # "what's next?"
devteam stage <name>    # "run that stage"
```

A third command becomes relevant after any stage that produces deferred findings:

```bash
devteam advise          # "triage the noted_for_followup items"
```

## Prototype first, harden later

Use `devteam prototype` when the work is still exploratory: a UI sketch, product
workflow, technical feasibility test, or internal demo that needs fast feedback
before it deserves the full SDLC treatment.

Prototype mode creates a packet under `pipeline/prototypes/<id>/`:

- `intent.md` — what you are trying to learn.
- `build-prompt.md` — a fast-build prompt for a coding agent or human pair.
- `feedback.md` — notes from demos and review.
- `promotion.md` — the handoff into a normal Stagecraft track.
- `prototype.json` — metadata for tooling.

Start the packet, build the prototype from its generated prompt, record
feedback, then promote when the shape settles:

```bash
devteam prototype start "settings flow" --feature "Try a faster account-settings flow"
devteam prototype build settings-flow --host openai-compat
devteam prototype note settings-flow --feedback "Users missed the save state"
devteam prototype promote settings-flow --track full
```

`prototype build` is deliberately separate from `start`. Stagecraft writes the
intent and build prompt first; you explicitly choose when to let a headless host
act on it. By default the host runs inside
`pipeline/prototypes/<id>/workspace/`, so throwaway files stay with the packet.
Use `--apply-to-project` only when you intentionally want the prototype build to
touch the project root. The normal gated pipeline starts only after promotion.

`promote` appends the hardening command to `promotion.md`:

```bash
devteam run --feature-file pipeline/prototypes/settings-flow/promotion.md --track full
```

Prototype packets are not gates and do not satisfy sign-off, deploy, or CI
evidence. They are intentionally committable learning records: Stagecraft's
managed `.gitignore` excludes volatile runtime files, but not
`pipeline/prototypes/`. If the prototype touches auth, payments, migrations,
secrets, customer data, infrastructure, or anything production-bound, promote it
to a normal track before broader use.

### Tutorial: prototype a token cost estimator

This short walkthrough uses prototype mode to explore a small internal tool:
a token cost estimator for Gemini, OpenAI, and Anthropic models. The prototype
has one simple UI: paste a block of text, estimate token count, then show
approximate input cost across a few hard-coded model prices.

Start the packet:

```bash
devteam prototype start "token cost estimator" --feature "Prototype a browser UI where a user pastes a block of text and sees an approximate token count plus estimated input cost for selected Gemini, OpenAI, and Anthropic models. Use hard-coded model prices in the prototype; accuracy is directional, not billing-grade."
```

Open `pipeline/prototypes/token-cost-estimator/build-prompt.md` and add the
concrete prototype shape before running the build:

```markdown
Build a single-page prototype for estimating LLM input cost.

UI:
- A large textarea labelled "Text to estimate".
- A small summary row showing estimated tokens and character count.
- A comparison table with provider, model, USD per 1M input tokens, and estimated cost.
- Recalculate live as the text changes.

Prototype assumptions:
- Keep all pricing values hard-coded in the frontend.
- Use a simple estimate of 1 token per 4 characters.
- Include at least these example rows:
  - Gemini 1.5 Flash: $0.075 / 1M input tokens
  - Gemini 1.5 Pro: $1.25 / 1M input tokens
  - GPT-4o mini: $0.15 / 1M input tokens
  - GPT-4o: $5.00 / 1M input tokens
  - Claude 3 Haiku: $0.25 / 1M input tokens
  - Claude 3.5 Sonnet: $3.00 / 1M input tokens

Learning goal:
- Can users quickly compare rough cost across providers before choosing a model?
- Is the UI understandable enough without real tokenizer integration?
```

Now let Stagecraft run the prototype build through a headless host. The safest
default keeps generated files in the packet-local workspace:

```bash
devteam prototype build token-cost-estimator --host openai-compat
```

The build output lands under
`pipeline/prototypes/token-cost-estimator/workspace/` and the transcript lands
under `pipeline/logs/prototype.token-cost-estimator.log`. If you want the agent
to modify the real application tree, pass `--apply-to-project`:

```bash
devteam prototype build token-cost-estimator --host codex --apply-to-project
```

That flag is intentionally loud: the build is still not gate evidence, but it
can now touch normal project files. For a small browser UI, ask the agent to
either create a static HTML file you can open directly or add an npm script such
as `npm run dev`. Then demo the running prototype and record what you learned:

```bash
devteam prototype note token-cost-estimator --feedback "The textarea plus comparison table was enough for a first demo. Users asked for output-token cost and a disclaimer that the estimate is not provider billing data."
```

Before promoting, edit
`pipeline/prototypes/token-cost-estimator/promotion.md` so it captures what
should become production work. For this example, useful acceptance criteria
would include replacing hard-coded prices with a maintained pricing source,
adding output-token estimates, naming the tokenizer approximation clearly, and
covering empty, short, and long text inputs.

When the prototype is worth hardening, promote it into a normal track:

```bash
devteam prototype promote token-cost-estimator --track quick
```

Stagecraft appends the command to `promotion.md`:

```bash
devteam run --feature-file pipeline/prototypes/token-cost-estimator/promotion.md --track quick
```

That handoff is the point where the cost estimator stops being a throwaway
learning artifact and starts receiving normal Stagecraft gates, tests, review,
and sign-off.

### Prototype mode with openai-compat

`devteam prototype build --host openai-compat` uses the same HTTP-native host as
normal Stagecraft workstreams. By default, its `write_file` tool is allowed to
write only inside the prototype packet, including `workspace/`. Passing
`--apply-to-project` expands the allowed write scope to the project root for
that prototype build only. Neither mode writes normal gates or satisfies
sign-off/deploy.

### Follow-up item triage

After the red-team (Stage 4c), any build workstream (Stage 4), or peer-review (Stage 5) writes `noted_for_followup[]` items to its gate, `devteam next` emits a warning:

```
⚠  2 unresolved follow-up items may block downstream stages — run `devteam advise` for options
▶️  run-stage  pre-review (stage-04a)
```

The warning is advisory — it never blocks `next`. But unaddressed `QA_BLOCKER` items will cause QA to fail on the exact AC they reference, and unaddressed `A11Y_FIX` items mean the accessibility gate is still FAIL.

Run `devteam advise` for the full panel:

```bash
devteam advise

# If a stage gate is currently FAIL, advise shows that first:
#   ❌ Active pipeline blocker: fix-and-retry — red-team (stage-04c)
#      Run `devteam next` for the full fix steps.
#
# Follow-up items in completed stage gates:
#
#   AC-11 — Docker live-path testing  [stage-04.qa]
#     Risk: QA BLOCKER — no @AC-11 scenario in spec.feature
#     Options:
#       [A] scaffold  — prints the command to run; writes SCAFFOLD-PENDING (you run it)  ← recommended
#       [B] defer     — mark DEFERRED in pipeline/context.md (--apply AC-11=B:PROJ-XYZ)
#       [C] amend     — flag for PM to remove AC-11 from the brief
#       [D] nothing   — advance; QA will block
```

Option letters (A/B/C/D) are **per-item** — the same letter means different actions for different
risk classifications. Always read the panel to confirm what each letter does before running `--apply`.

**`--apply` syntax:** `<id>=<letter>[:<ticket>]`, comma-separated for multiple items.

- **`<id>`** — the item identifier shown at the start of each panel block (e.g. `AC-11`, `R-01`, `F-04`). It comes from `noted_for_followup[].id` in the stage gate.
- **`<letter>`** — the option letter (A/B/C/D) as shown in the panel for that item.
- **`:<ticket>`** — optional ticket reference, only meaningful for `defer`. Becomes `DEFERRED: … — ticket PROJ-XYZ` in `pipeline/context.md`. Omit it and `PLACEHOLDER` is written instead.

Apply your decisions:

```bash
devteam advise --apply AC-11=A,AC-10=B:PROJ-99,AC-12=A
# ✓ AC-11 — SCAFFOLD-PENDING written; run the printed command to add the test stub
# ✓ AC-10 — DEFERRED: AC-10 — ticket PROJ-99 written to context.md
# ✓ AC-12 — NOTED: stage manager: no action

# When everything is resolved:
#   All noted_for_followup items addressed.
```

Decisions are written into the `<!-- devteam:advise -->` section of `pipeline/context.md`. Downstream stages respect them: QA skips coverage checks for `DEFERRED:` items; QA retries `KNOWN-FLAKY:` tests once before failing; peer-review notes `BRIEF-AMEND-NEEDED:` entries in reviewer briefs.

**When to run it:** after red-team PASS and before QA augmentation or peer-review. You can also run it any time you notice a `⚠` line from `devteam next`.

See [`rules/advise.md`](../rules/advise.md) for the full option vocabulary and [`docs/runbooks/fix-and-retry.md` § Case 11](runbooks/fix-and-retry.md#case-11-advise-workflow--triage-follow-up-items-before-downstream-stages) for worked examples.

### What is a gate?

A **gate** is a JSON file the model writes to `pipeline/gates/` at the end of each stage. It's the contract between stages: the orchestrator reads it to decide whether the pipeline can advance, and the validator checks it for correctness. Required fields on every gate:

```json
{
  "stage": "stage-01",
  "workstream": "pm",
  "status": "PASS",
  "track": "full",
  "timestamp": "2026-05-01T12:00:00Z",
  "orchestrator": "devteam@0.4.0",
  "host": "claude-code",
  "blockers": [],
  "warnings": []
}
```

`orchestrator` and `host` are auto-injected by the validator; the model does not need to write them. Stage-specific fields (like `acceptance_criteria_count` or `security_approved`) are documented in each stage's schema under `core/gates/schemas/`.

**Gate statuses:**
- **PASS** — stage complete; pipeline advances.
- **WARN** — stage complete with concerns; pipeline advances but the warning is preserved in the merged gate.
- **FAIL** — stage did not meet its criteria; `devteam next` returns `fix-and-retry`. The `blockers[]` array explains what must be fixed. Re-run the stage; the new gate overwrites the old one.
- **ESCALATE** — a human decision is required before the pipeline can advance (e.g. the model isn't confident enough to PASS or FAIL; the change scope grew; a security finding is ambiguous). The pipeline halts until you resolve it. See [`devteam next` says `resolve-escalation`](#devteam-next-says-resolve-escalation).

You can hand-edit a gate file if the model got something wrong. Keep the required fields and write valid JSON; the validator will report what's missing.

### `devteam next` actions explained

After every stage's gate is written, `devteam next` inspects `pipeline/gates/` and returns one of:

| Action | Meaning | What to do |
|---|---|---|
| `run-stage` | Stage not started | `devteam stage <name> [--headless]` |
| `continue-stage` | Multi-role stage partly done — some workstreams still pending | Run the remaining role's workstream |
| `merge` | All workstreams of a multi-role stage done, no merged gate yet | `devteam merge <stage>` |
| `fix-and-retry` | Merged gate (or single-role gate) has `status: FAIL` | Address the blockers, re-run the stage |
| `resolve-escalation` | Gate has `status: ESCALATE`, or a stage exhausted its retry budget | Read `escalation_reason`, make the call, rewrite the gate |
| `pipeline-complete` | All stages in the track have PASS or WARN | Done |

Non-pass actions also carry a **`failure_class`** (shown as a `[tag]` in the output, and a field under `--json`) that tells you *how* to respond:

| `failure_class` | Action | What it means |
|---|---|---|
| `code-defect` | `fix-and-retry` | Change code, re-run the stage (the common case). |
| `state-corruption` | `fix-and-retry` | The gate file is unreadable — **repair the JSON, don't re-run**. |
| `external-blocked` | `fix-and-retry` | A human/external action is required (e.g. a sign-off). |
| `judgment-gate` | `resolve-escalation` | A gate wrote `status: ESCALATE`; make a ruling. |
| `convergence-exhausted` | `resolve-escalation` | Retry budget (`autonomy.max_retries`, default 2) spent — escalated automatically. |

`devteam next --json` also includes a `schema_version` for programmatic callers. See [`rules/gates-core.md` § Failure classification](../rules/gates-core.md#failure-classification).

For a snapshot of where the pipeline is right now:

```bash
devteam summary
```

Example output:

```
Pipeline state — track: full
──────────────────────────────────────────────────
✅ requirements      stage-01  PASS
✅ design            stage-02  PASS
✅ clarification     stage-03  PASS
⏳ build             stage-04  PARTIAL
    ✅ backend       (codex)            PASS
    ⚠️  frontend      (claude-code)      WARN
    pending workstreams: platform, qa
○  pre-review        stage-04a  PENDING
…
```

For a live view, use `devteam ui --open`. See [the web UI](#the-web-ui).

### Following pipeline progress

Three options for tracking pipeline progress, suited to different workflows:

**1. `devteam log`.** Reads every gate and artifact file from `pipeline/`, sorts by mtime, and prints one line per event with key fields per stage:

```bash
$ devteam log
13:42:11  ✓  stage-01              PASS      3 AC, 0 Q
13:42:30  📝  pipeline/brief.md     120 lines  (pm)
13:43:00  ✓  stage-02              PASS      2 ADRs consulted
13:43:05  📝  pipeline/design-spec.md  250 lines  (principal)
13:48:21  ✓  stage-04              PASS      4/4 workstreams
13:50:02  ✓  stage-04a             PASS      lint ✓, tests ✓, deps ✓
13:50:15  ✗  stage-04c             FAIL      2 findings, 1 must-fix, 1 blocker
```

Add `--follow` to tail the directory at 1-second poll; new events stream in as gates land and artifacts get written. Add `--json` for one NDJSON event per line if you're piping to another tool. Works identically in headless and user-driven modes (it reads on-disk state, not the agent's transcript).

**2. `pipeline/logs/*.log` — per-stage transcripts (headless only).** When you run `devteam stage X --headless`, the host CLI's stdout/stderr streams directly to `pipeline/logs/<workstreamId>.log` without accumulating the transcript in memory. By default the terminal stays quiet so prompts and diffs do not flood `devteam run`; set `DEVTEAM_HEADLESS_TEE=1` or `DEVTEAM_VERBOSE=1` to mirror the transcript live. You can `tail -f pipeline/logs/stage-04.backend.log` during a run; after completion the file contains everything the agent printed, with a header (start time, command) and trailer (end time, exit code) flushed before the command resolves. Disable with `DEVTEAM_NO_LOG=1`. Does not apply to user-driven mode because the transcript lives in your AI tool's session, not in devteam's process.

**3. `devteam ui --open`.** The same data as `devteam log` rendered as a tree, updated via Server-Sent Events when gates change. Suited for two-monitor setups or when a browser view is preferred. See [the web UI](#the-web-ui).

**4. `devteam report`.** Post-run HTML report for reviewing a completed (or halted) run after the fact. Run it once the pipeline is done; it opens `pipeline/report.html` in your browser automatically. The report shows:
- **Status badge** — COMPLETED, HALTED (with halt type such as "iteration ceiling"), or INCOMPLETE
- **Progress bar** — color-coded stage pills; click any pill to jump to that stage's detail
- **Header stats** — wall-clock time, total model compute time, retry count, stall count, cost
- **Pipeline tab** — per-stage timing and dispatch counts (from `run-log.jsonl`), linked documents, blockers, workstream breakdown
- **Documents tab** — all pipeline artifacts (brief, spec, design, code reviews, ADRs, test report, etc.) embedded inline with a sidebar navigator
- **Clickable chips** — AC count and scenario count link directly into `brief.md` and `spec.feature`

Unlike `devteam log` and `devteam ui`, `report` is a **point-in-time snapshot** — it reads whatever is on disk at the moment you run it and writes a standalone HTML file that works offline and can be shared.

**`devteam report --findings`** (Phase 35 item 35.4) switches to a different, fixing-oriented view: one severity-ordered table collected across *every* review artifact present — security-review (stage-04b), red-team including the 31.2 mechanical floor (stage-04c), peer-review and critic (stage-05 / stage-05.critic), the 31.4 mutation smoke gate (stage-06), verification-beyond-tests (stage-06d), and `docs/audit/*.md` once the audit workflow has run. Each row carries severity, `file:line`, what's wrong, a suggested mitigation (when the source stated one), rough effort, and — the important column — **provenance**: `orchestrator-observed` (traces to code the orchestrator itself ran: the mechanical red-team floor, a mutation gate execution, a confirmed stage-06d stamp, an approval-derivation-hook-derived peer-review mismatch) versus `model-asserted` (a reviewer's judgment, even when well-evidenced in prose). No findings across every source scanned renders an honest empty state, never a broken table. Written to `pipeline/findings-report.html` by default; `--json` prints the raw data (schema: `core/report/schemas/findings-report.schema.json`).

The three real-time options are complementary. A common pattern: `devteam log --follow` in one terminal pane while running the pipeline in another, then `devteam report` once it finishes.

### Answering an open question between stages

Stages 1 (requirements) and 2 (design) sometimes produce questions only a human can answer. They appear as `QUESTION:` lines in both `pipeline/brief.md` (in the *Open Questions* section) and `pipeline/context.md`. The pipeline halts at Stage 3 (clarification) until each one is answered, or by default dispatches the PM agent to answer them.

To answer questions yourself rather than invoking PM:

**Where:** `pipeline/context.md`, directly below the `QUESTION:` line. Do not edit `brief.md`. The brief stays as the original intent; `context.md` is where answers and decisions accumulate across the run.

**Format:** A `PM-ANSWER:` line on the line below. Multi-line answers are fine; readers consume everything until the next blank line or marker.

Before:

```markdown
## Open Questions

QUESTION: Should the SMS opt-in default to on or off for existing users? @PM
QUESTION: Do we need a separate consent timestamp column, or is updated_at sufficient? @PM
```

After:

```markdown
## Open Questions

QUESTION: Should the SMS opt-in default to on or off for existing users? @PM
PM-ANSWER: Off. Existing users must explicitly opt in; we treat absence of consent as no.

QUESTION: Do we need a separate consent timestamp column, or is updated_at sufficient? @PM
PM-ANSWER: Separate column `sms_optin_at` (nullable timestamptz). updated_at changes on any row update; we need to know when consent was specifically granted for audit/compliance.
```

Save the file and run `devteam next`. Stage 3's `grep QUESTION: not followed by PM-ANSWER:` check passes; the pipeline advances to design without invoking PM.

**If your answer changes the brief itself** (e.g. adds an acceptance criterion), add a `## Brief Changes` section to `pipeline/context.md` rather than editing `brief.md`. Agents at every later stage read both files, keeping the audit trail intact.

For the full vocabulary of markers like `QUESTION:` / `PM-ANSWER:` / `CONCERN:` / `BLOCKER:` etc., see [`docs/conventions.md`](conventions.md).

## Running each stage

The CLI renders a prompt for the routed host. Run it by invoking the named subagent in your AI tool, via a slash command or natural language.

```bash
devteam stage requirements --feature "Add SMS notification opt-in"
# For longer briefs:
devteam stage requirements --feature-file ./feature-brief.md
```

In user-driven mode (the default), the output includes a preamble explaining what to do with the prompt and a postamble pointing at the next action:

```
═══════════════════════════════════════════════════════════════════════
  Stage stage-01 (requirements) — 1 workstream to dispatch
═══════════════════════════════════════════════════════════════════════

  The block(s) below are prompts to feed to your model. devteam does
  NOT call a model — it renders the prompt and validates the gate JSON
  the model writes back.

  To run this stage, pick one:
    1. Inside Claude Code: paste the prompt, OR type
         /devteam stage requirements --feature "Add SMS notification opt-in"
    2. Headless from terminal:
         devteam stage requirements --feature "Add SMS notification opt-in" --headless

  When done, each workstream writes pipeline/gates/stage-01*.json.
  Then run `devteam next` to see what to do next.
═══════════════════════════════════════════════════════════════════════

────────  workstream: pm  (host: claude-code)  ────────

[the actual prompt for the model]
```

Inside Claude Code: paste the prompt, or type `/devteam stage requirements --feature "..."`. The PM subagent reads its brief (`.claude/agents/pm.md`), produces `pipeline/brief.md` and the stage-01 gate.

For multi-role stages (`build`, `peer-review`, `sign-off`), one CLI invocation produces multiple prompts, one per role. Each prompt points at its own subagent. You can run them in parallel (claude-code's `subagents: true` capability) or sequentially.

After all per-role workstreams of a multi-role stage have written their gates:

```bash
devteam merge build
# → Merged → /…/pipeline/gates/stage-04.json (status: PASS)
```

`devteam next` will tell you when a merge is needed.

### Conditional stages

Some stages only run when a preceding stage's gate sets a specific flag. The orchestrator checks these automatically; `devteam next` silently skips a conditional stage whose condition is not met. See **[`docs/reference/stages.md`](reference/stages.md)** §Phase 2 for the full `conditionalOn` column (currently: stage-04b security-review and stage-04d migration-safety both gate on stage-04a fields).

All other stages run unconditionally on their track. If you want to verify whether a conditional stage will run for your current diff, inspect the pre-review (stage-04a) gate after it's written.

### Per-stage details

- **Stage 1 — Requirements (PM).** PM writes `pipeline/brief.md` from `templates/brief-template.md`. Gate carries `acceptance_criteria_count`, `out_of_scope_items`, `required_sections_complete`.

- **Stage 2 — Design (Principal).** Principal writes `pipeline/design-spec.md` and any ADRs under `pipeline/adr/`. Gate carries `arch_approved`, `pm_approved`, `adr_count`.

- **Stage 3 — Clarification (PM).** Resolves any open questions from design before build starts. Skipped on `quick` and `nano` tracks.

- **Stage 3b — Executable spec (PM, G2).** Runs on `full` + `quick` after clarification. PM translates each numbered `AC-N` in `pipeline/brief.md` into one Gherkin scenario in `pipeline/spec.feature`, tagged `@AC-N`. Use `devteam spec generate` to scaffold the file from the brief (one tagged Scenario per AC with TODO Given/When/Then placeholders) and `devteam spec verify` to drift-check brief.md ↔ spec.feature ↔ test-report.md. Gate carries `criteria_count`, `scenarios_count`, the full `criteria_to_scenario_mapping` array, `all_criteria_mapped`, and `drift`. PASS requires `drift: false` AND `all_criteria_mapped: true`. The .feature file becomes the canonical contract that QA's tests must map to in stage-06.

- **Stage 4 — Build (4 workstreams).** Backend / Frontend / Platform / QA each write to their owned source dir and produce a PR summary. Each workstream sees a narrower `allowedWrites` (backend cannot write `src/frontend/`). Per-workstream gates land at `pipeline/gates/stage-04.<role>.json`; `devteam merge build` aggregates. **Enforcement varies by host**: claude-code blocks unauthorized writes at tool-call time via its `PreToolUse` hook; codex, antigravity, and gemini-cli run a post-hoc git-status diff after the workstream exits. Any file outside `allowedWrites` is captured in `writeViolations[]` and the gate is patched to `FAIL` with violations in `blockers[]`; narrow runtime caches such as Python `__pycache__/*.pyc` are ignored as interpreter byproducts.

- **Stage 4a — Pre-review (Platform).** Lint, type-check, dep review, license check, security heuristic. Gate carries `lint_passed`, `tests_passed`, `dependency_review_passed`, `license_check_passed`, `license_findings[]`, `security_review_required`. `license_findings[]` contains per-package entries `{ package, license, policy }` where policy is `allowed`, `warned`, or `denied`. Default policy: MIT/Apache-2.0/BSD-*/ISC/CC0/Unlicense → allowed; UNLICENSED/SSPL/BUSL → warned; GPL-*/AGPL-*/LGPL-* → denied. Override with `license.extra_allowed: ["LicenseId"]` in `.devteam/config.yml`. The `security_review_required` flag conditionally triggers Stage 4b.

- **Stage 4b — Security review (Security, conditional).** Runs only when `stage-04a.security_review_required` is `true`. Gate carries `security_approved`, `veto`, `triggering_conditions`. **A `veto: true` halts the pipeline regardless of any subsequent approvals.**

- **Stage 4c — Red team (Red Team, always-on for full + hotfix).** Adversarial-by-design review of the build. Walks 10 attack surfaces (input boundaries / state / sequence / integrations / auth edges / resource exhaustion / failure modes / abuse cases / downstream effects / observability gaps) and produces concrete reproducers. Triages each by severity × likelihood × scope. Gate carries `surfaces_walked`, `findings_count`, `severity_breakdown`, `must_address_before_peer_review`, `noted_for_followup`. Non-empty `must_address_before_peer_review` → FAIL; implementer addresses, re-runs build, red-team re-runs, eventually PASS. **Route red-team to a different host than your build agents** (`routing.roles.red-team` in `.devteam/config.yml`). Adversarial review is most valuable when the reviewer has different blind spots than the builder. Distinct from Stage 4b (narrower remit, conditional, veto) and Stage 5 (general code review).

- **Stage 4d — Migration safety (Migrations role, conditional, has veto).** Runs only when `stage-04a.migration_safety_required` is `true`. The pre-review heuristic in `core/guards/migration-heuristic.js` fires on schema files, migration directories, or files containing DDL fragments (ALTER/CREATE/DROP TABLE). Reviewer answers six questions about the migration: what it does, breaking-change classification, backfill strategy (when required), dual-write strategy (when required), rollback plan, and whether the rollback was tested. Gate carries those plus `migration_files`, `migration_approved`, `veto`. **Veto criteria (auto-set when met)**: empty `rollback_plan`, untested rollback on a `breaking_change`, missing `backfill_strategy` when `backfill_required`. Peer-review approvals cannot override a veto; the migrations role must personally re-review the fix. Route to a different host than the build agents.

- **Stage 5 — Peer review (4 area workstreams via reviewer subagent).** All 4 workstreams (one per area being reviewed) dispatch to the *same* reviewer subagent. Reviewers write per-area sections in `pipeline/code-review/by-<reviewer>.md`. The PostToolUse hook (`approval-derivation.js`) parses `REVIEW: APPROVED` / `REVIEW: CHANGES REQUESTED` markers and upserts the per-area gates. Do not write the gates manually; let the hook do it.

- **Stage 6 — Tests (QA).** QA runs the test suite, writes `pipeline/test-report.md`. Gate carries `all_acceptance_criteria_met`, `tests_total/passed/failed`, `criterion_to_test_mapping_is_one_to_one`. The last flag enables Stage 7 auto-fold.

- **Stage 6b — Accessibility audit (QA).** WCAG audit on UI changes via axe-core / pa11y / Lighthouse / manual. Gate carries `audit_method`, `wcag_level`, `violations` (critical / serious / moderate / minor), `components_audited`. PASS requires 0 critical AND 0 serious. Skip with `audit_skipped_reason` for backend-only changes.

- **Stage 6c — Observability gate (Platform).** Verifies that every metric / log / trace promised by brief §9 is actually emitted in the shipped code. Gate carries `metrics` / `logs` / `traces` each with `{required[], verified[], gap[]}`. PASS requires every `gap` empty. Weak verification methods (`code-grep` only) PASS with WARN; the gold standard is `runtime-probe`.

- **Stage 6d — Verification beyond tests (Verifier, full-only, G7).** Runs after stage-06 (qa) PASS. The `verifier` role applies property-based testing (fast-check / hypothesis / proptest), mutation testing (stryker / mutmut / mull), and/or formal verification (TLA+ / Alloy / Lean) to the changed code. Read-only on production code; writes property tests under `src/tests/property/` and formal specs under `pipeline/formal/`. Gate carries `methods_attempted[]`, `methods_skipped[{method, reason}]`, `candidates_inventoried`, per-method stats (`property_based` / `mutation` / `formal`), `findings_count`, `blocking_findings[]`. A surviving mutant on a critical path, a property counterexample to a stated invariant, or a formal counterexample to a safety property → FAIL. Tooling not installed → method is `attempted_but_blocked:<method>` (recorded, surfaces a warning). Track inclusion: `full` only; other tracks rely on stage-06 example tests as their verification floor. See `skills/verification-beyond-tests/SKILL.md` for the five-phase procedure and `roles/verifier.md` for the role contract.

- **Stage 6e — Performance budget (QA, full/quick/hotfix).** Runs after Stage 6d on `full`; after Stage 6c on `quick`/`hotfix`. QA role checks Lighthouse Web Vitals, bundle size delta, and load-test throughput (k6 / autocannon) against configured budgets in `performance.budget.json` or `.devteam/config.yml` defaults. Gate carries `budget_exceeded` (bool), `checks_performed[]` (list of checks that ran), and `skipped_reason` (populated for documentation-only, dep-update, or config-only changes with no performance-relevant surface). `budget_exceeded: true` → FAIL. **Requires shell capability**: the routed host must declare `enforces.shell: true`; if not, `assertCapabilities()` refuses at dispatch time with a clear error (see [Troubleshooting](#host-lacks-required-capability)). See `skills/performance-budget/SKILL.md` for the 7-step procedure.

- **Stage 7 — Sign-off (PM + Platform).** PM signs off on QA results; Platform prepares `pipeline/runbook.md`. **Auto-fold:** if Stage 6 reports `all_acceptance_criteria_met: true` AND `criterion_to_test_mapping_is_one_to_one: true`, the orchestrator writes Stage 7's gate automatically with `auto_from_stage_06: true`. Stage 7 does not need to be run manually. If QA proved every criterion was met with a 1:1 test, sign-off is automatic. If Stage 7 already has a gate after Stage 6 completes, auto-fold triggered.

- **Stage 8 — Deploy (Platform, adapter-driven).** Platform reads `.devteam/config.yml`'s `deploy.adapter` setting, follows `core/deploy/<adapter>.md`, and estimates the recurring deploy cost delta before deployment. If no adapter is configured, Stagecraft defaults to `local`: no external deploy is performed, local/in-place verification is recorded, and the gate marks `adapter_result.external_deploy: false`. If Stage 7 records `deploy_requested: false`, the orchestrator writes the local/no-external-deploy Stage 8 gate and deploy log directly instead of dispatching a deploy agent or escalating for a human deployment choice. Gate carries `deploy_completed`, `smoke_tests_passed`, `rollback_executed`, `cost_delta_estimated`, `cost_delta_multiplier`, and `cost_gate_override`. A PASS/WARN gate is invalid unless cost was estimated; `cost_delta_multiplier >= 10` must FAIL unless `cost_gate_override: true` and `cost_gate_override_reason` cite explicit human approval. **Do not auto-rollback on FAIL.** The runbook names the rollback procedure; a human decides whether to roll back or investigate.

- **Stage 9 — Retrospective (Principal).** Principal harvests `PATTERN:` lines from Stage 5 reviews, promotes ≤2 rules into `pipeline/lessons-learned.md`, ages out rules that haven't been reinforced in 10 runs.

## Multi-host setups

### What "host" means

A *host* controls how Stagecraft delivers work to a model. Four built-in hosts are CLI/runtime based: Claude Code (`claude`), Codex CLI (`codex`), Antigravity CLI (`agy`), and Omnigent (`omnigent`). Stagecraft renders a stage prompt and lets that runtime manage model invocation, tool permissions, and output capture. The `openai-compat` host is HTTP-native: it calls any OpenAI-compatible Chat Completions API directly, no CLI required. The `generic` host only renders prompts for manual use. `acp` speaks [Agent Client Protocol](https://agentclientprotocol.com) to any ACP-compliant agent.

**Gemini CLI is deprecated and retired to a plugin package.** Gemini CLI stopped serving free/Pro/Ultra requests 2026-06-18; Google's supported successor is Antigravity CLI. After one release with the doctor warning live, phase 34.4 moved the adapter out of `hosts/` into the `@devteam/host-gemini-cli` plugin package (`packages/host-gemini-cli/`) per the A4 pluggable-adapter mechanism — `devteam init --host gemini-cli` now requires `npm install @devteam/host-gemini-cli` first (the CLI tells you this if you forget). `devteam doctor` still warns whenever routing resolves any role or stage to `gemini-cli`, plugin installed or not. Migrate at your own pace with `devteam init --host antigravity` in existing projects, or start new projects with `--host antigravity` directly — the two hosts share the same install shape (markdown role prompts, no hooks/slash commands/native subagents, post-hoc write audit) so migration is a routing change, not a re-install.

**Host and model are two different things.** For CLI/runtime hosts, which model runs is configured inside the host (e.g., Claude Code's `.claude/agents/<role>.md` has a `model:` field; Codex, Antigravity, Gemini, and Omnigent use their own settings). For `openai-compat`, the model is set per-role in `.devteam/config.yml` under `hosts.openai-compat.models`. Phase-32 item 32.3 adds a third, host-neutral option: pin a model directly in `routing.roles`/`routing.stages` (see [Pinning a model in routing config](#pinning-a-model-in-routing-config) below) — it works the same way across every headless host and takes precedence over the per-host mechanisms just described.

When optimizing cost or comparing model quality, you can route different roles to different models. For CLI/runtime hosts, edit the host's native configuration. For openai-compat, edit the config — see [Using openai-compat](#using-openai-compat-openai-compatible-apis). Multiple hosts are only needed when mixing runtimes (e.g. Claude Code for some roles, Codex or Omnigent for others).

### Why use multiple hosts?

**Cost.** Opus-class models cost roughly 5× more per token than Sonnet. Multi-host lets you route expensive models only to the roles that warrant it (typically Principal, Security, and Red-team) and cheaper models for implementation work. Net cost on a full pipeline run typically drops 30–50%.

**Model diversity.** Different models have different blind spots. Routing specific roles to specific models captures independent opinions without manual effort. The formalized version, where every code-review area runs on all configured hosts in parallel, is [multi-model peer review](#multi-model-peer-review). Neither is automatic: red-team routes to `default_host` unless you add a `roles: red-team:` override, and multi-model peer review requires setting `review_fanout`.

**Tool fit.** Claude Code is strong on design, complex review, and reasoning about architecture. Codex CLI is fast at backend implementation. Gemini CLI was inexpensive for pattern-matching tasks like QA but is deprecated upstream (see above) — Antigravity CLI is its supported successor and the adapter is a like-for-like swap (same install shape, same enforcement level). Omnigent is useful when you want Stagecraft to dispatch through a meta-harness that can wrap multiple agent runtimes. Use the right tool for the job.

### Setting up multiple hosts

Install both adapters in one command:

```bash
devteam init --host claude-code,codex
```

What this does, in sequence, for each host:
- Lays down its role prompt files (`.claude/agents/` for claude-code, `.codex/prompts/roles/` for codex, `.omnigent/stagecraft/roles/` for omnigent)
- Installs slash commands, hooks, rules, and skills where the host supports them
- Skips files already written by an earlier host in the list (rules in `.devteam/rules/` are shared between hosts and only written once)

The config file (`.devteam/config.yml`) is written once, with the first host as the default:

```yaml
routing:
  default_host: claude-code
```

**Installing both hosts does not automatically split work between them.** Until you edit the config, every stage routes to `default_host` (in this case, claude-code). Codex's installed files sit on disk unused. The pipeline behaves identically to `devteam init --host claude-code` until you add `roles:` or `stages:` overrides.

### Configuring routing

Edit `.devteam/config.yml` to override the default for specific roles or stages:

```yaml
routing:
  default_host: claude-code        # fallback for anything not matched below

  roles:
    backend: codex                 # backend workstream → Codex CLI
    frontend: codex
    platform: codex
    qa: codex
    # principal, security, pm, red-team, migrations → claude-code (inherits default)

  stages:
    stage-08: claude-code          # deploy always on claude-code, regardless of role
```

Routing precedence: **`stages` → `roles` → `default_host`**. The stage-level override is useful when a specific host is required for a stage regardless of which role is dispatched, for example always running deploy on the host whose agent has deployment credentials.

When a stage with multiple workstreams runs, each workstream is independently routed. `devteam stage build` (four workstreams: backend, frontend, platform, QA) with the config above routes all four to Codex. `devteam stage design` (Principal role) routes to Claude Code. The gate merge is host-agnostic. The orchestrator reads JSON files, and the merged gate's `workstreams[]` array records `"host"` per row so you can see which CLI handled what.

Use `npm run performance` and `npm run routing:suggest` after several real runs to compare hosts by first-try pass rate, cost per pass, p50/p95 duration, and retry-adjusted completion time. Recommendations remain quality-first: latency only breaks ties after first-try quality and cost. `npm run routing:suggest` also reports a per-tier cost-delta table (below) once a role has been dispatched under ≥2 distinct (host, model) pairs. Stage prompts include a compact changed-file manifest with paths, byte sizes, and SHA-256 digests; agents should read file bodies on demand for their workstream instead of relying on preloaded changed-file contents. See [`docs/capacity-strategy.md`](capacity-strategy.md) before moving work to remote capacity or enabling provider prompt caches.

### Pinning a model in routing config

`routing.roles.<role>` and `routing.stages.<stage>` accept either the plain host-name string shown above, or `{host, model}` to also pin a specific model for that role/stage — the pre-32.3 string form keeps working unchanged; this is additive:

```yaml
routing:
  default_host: claude-code
  roles:
    qa:
      host: claude-code
      model: claude-haiku-4-5-20251001   # mechanical stage — cheap model is fine
    principal:
      host: claude-code
      model: opus                        # design/architecture — frontier model
```

The pinned model reaches the dispatch the same way on every headless host: `claude`, `codex`, `gemini`, and `agy` all accept an identical `--model <value>` CLI flag, and `openai-compat` puts it in the API request body (taking precedence over that host's own `hosts.openai-compat.models`). Omnigent's `hosts.omnigent.model` is likewise overridden when a routing-pinned model is present. Whichever model was requested is recorded as `model_requested` on the dispatch's gate — distinct from the model-asserted `model` field and from `_orchestrator_observed.model_observed` (phase-28 telemetry: what the host actually reported serving). Absent a pin, every adapter falls back to exactly what it did before 32.3 — a host with no model configured anywhere still runs on its own default.

**Model tiers + escalate-on-retry.** `routing.tiers` declares an ordered, cheapest-first model ladder per host; `routing.escalate_on_retry: true` (default `false`) bumps a pinned model one tier up that ladder when a fix-and-retry re-dispatches a stage:

```yaml
routing:
  escalate_on_retry: true
  tiers:
    claude-code: [claude-haiku-4-5-20251001, sonnet, opus]
    codex: [gpt-5-mini, gpt-5]
```

A retried dispatch whose route pinned `claude-haiku-4-5-20251001` on `claude-code` gets `sonnet` instead; a second retry does not escalate further (escalation is a single one-tier bump, not cumulative per attempt). The bump is recorded as `_orchestrator_escalated: {from_model, to_model, reason: "escalate_on_retry", at}` on the gate — orchestrator-owned provenance, same discipline as `_orchestrator_observed`/`_orchestrator_stamped`. Nothing escalates when a role has no pinned model, when the current model isn't on the host's ladder, or when it's already at the top tier.

**Preset: "frontier plans, cheap executes."** Not a changed default — copy this block into `.devteam/config.yml` to opt in. Design/reasoning-heavy roles get the frontier model; mechanical stages (lint-fix follow-ups, docs, retro) get the cheap tier; escalation covers the case where the cheap tier gets stuck:

```yaml
routing:
  default_host: claude-code
  escalate_on_retry: true
  tiers:
    claude-code: [claude-haiku-4-5-20251001, sonnet, opus]
  roles:
    principal:
      host: claude-code
      model: opus            # design/architecture sign-off
    security:
      host: claude-code
      model: opus
    red-team:
      host: claude-code
      model: opus
    reviewer:
      host: claude-code
      model: opus
    qa:
      host: claude-code
      model: claude-haiku-4-5-20251001   # mechanical — cheap tier, escalates on retry
    backend:
      host: claude-code
      model: sonnet
    frontend:
      host: claude-code
      model: sonnet
    platform:
      host: claude-code
      model: sonnet
```

See [`docs/cost.md`](cost.md) for the corpus-driven cost-delta reporting this preset is meant to be validated against before you commit to it project-wide.

`scripts/routing-suggest.js` groups its host-swap recommendations by role as before (host-level, unchanged), but now also loads `.devteam/corpus/dispatches.jsonl` rows keyed by `(role, host, model)` to report per-tier cost deltas — see `npm run routing:suggest`'s output for a worked example once you have real dispatch history.

### Choosing models within a single host

Prefer `routing.roles`/`routing.stages`' `{host, model}` form (above) — it's host-neutral, shows up on the gate as `model_requested`, and works identically whether you're on one host or several. The per-host mechanisms below still work and are what `devteam init` writes by default; they're documented here for existing projects and for cases the routing form doesn't reach (e.g. Claude Code's own internal Task-tool subagent delegation, which is a separate mechanism from the per-dispatch CLI invocation routing controls).

If you're using only Claude Code and want different models per role, you don't need multi-host at all. The installed agent files already have model tiers set:

```yaml
# .claude/agents/principal.md  (written by devteam init)
---
name: principal
model: opus          # claude-opus — architecture rulings, design sign-off
---
```

```yaml
# .claude/agents/dev-backend.md
---
name: dev-backend
model: sonnet        # claude-sonnet — implementation
---
```

To change a model for a specific role, edit that agent file directly. Re-running `devteam init --host claude-code --force` regenerates all agent files from the framework defaults, so keep custom model overrides in mind if you re-init.

For Codex, Gemini, and Omnigent, model selection is handled in those tools' own configuration files, outside Stagecraft. For openai-compat, model selection is per-role in `.devteam/config.yml` under `hosts.openai-compat.models` — see [Using openai-compat](#using-openai-compat-openai-compatible-apis).

### Common configurations

**Cost-optimized: Opus for reasoning, Codex for implementation**

This is the most common split. Claude Code runs the roles that require sustained reasoning (Principal, Security, Red-team, PM). Codex runs the high-volume implementation and QA workstreams.

```yaml
routing:
  default_host: claude-code     # principal, security, pm, red-team, migrations
  roles:
    backend: codex
    frontend: codex
    platform: codex
    qa: codex
```

**Locked deploy: implementation on one host, deploy always on another**

Useful when your deploy host needs specific credentials or tool permissions that other workstreams shouldn't have.

```yaml
routing:
  default_host: codex
  stages:
    stage-08: claude-code       # deploy on claude-code; everything else on codex
```

**Adversarial peer review: run every review area on multiple models simultaneously**

`review_fanout` defaults to an empty list. Stage 5 runs as a single-host review on `default_host` unless you opt in:

```yaml
routing:
  default_host: claude-code
  review_fanout: [claude-code, codex, gemini-cli]
```

With three hosts and four review areas, Stage 5 produces 12 parallel workstreams. Any FAIL from any model on any area blocks the stage. See [Multi-model peer review](#multi-model-peer-review) for the full picture.

**Adversarial peer review: reviewer/critic pair instead of the four-area panel**

`review_fanout` above multiplies the *same* panel across hosts. `review.mode: adversarial` is a different mechanism entirely — it replaces the four-area matrix with exactly two sequential workstreams:

```yaml
review:
  mode: adversarial   # default: panel
routing:
  roles:
    critic: gemini-cli  # optional — auto-picks a different host from reviewer when ≥2 are configured
```

A single reviewer covers every applicable area in one pass (`pipeline/code-review/by-reviewer.md`), then a critic — dispatched only after the reviewer's gate lands — attacks the review itself in `pipeline/code-review/by-critic.md`: missed findings, unsupported approvals, "what would make this approval wrong?", with file:line evidence required for every challenge. The merged Stage 5 gate PASSes only when the reviewer approves AND the critic's `challenges_resolved` is `true`. The two modes are mutually exclusive per run — combining `review_fanout` with `review.mode: adversarial` is not supported; adversarial mode wins. Default stays `panel`; this is opt-in.

### Using Omnigent

`omnigent` is Stagecraft's adapter for the [Omnigent](https://github.com/omnigent-ai/omnigent) meta-harness. Stagecraft still owns routing, gates, write audits, retries, and `devteam next`; Omnigent owns the runtime that consumes one workstream prompt.

```bash
devteam init --host omnigent
devteam stage requirements --feature "Add SMS notification opt-in" --headless
```

What this installs:
- `.omnigent/stagecraft/agent/config.yaml` — the default Omnigent agent bundle config
- `.omnigent/stagecraft/roles/` — role prompts in markdown format
- `.omnigent/stagecraft/skills/` — Stagecraft skills in markdown format
- `.devteam/rules/` and `.devteam/templates/` — shared Stagecraft rules and templates

Current posture is intentionally conservative: no hooks, no Stagecraft-managed subagent fan-out, no slash commands, and no worktree mapping. Allowed writes are audited after the process exits, while stoplist and tool budget constraints are prompt-only. See [Omnigent runtime adapter](omnigent-runtime.md) for the Phase 24 design and follow-up issues.

Choose an Omnigent launch profile in `.devteam/config.yml` without rewriting the installed agent bundle:

```yaml
routing:
  default_host: omnigent

hosts:
  omnigent:
    harness: codex
    model: gpt-5-codex
    session_mode: no-session
    prompt_transport: argument
    policy_mode: off
```

For a server-backed topology, add `server_url` and use `session_mode: session`:

```yaml
hosts:
  omnigent:
    agent_spec_path: .omnigent/stagecraft/agent
    harness: claude-sdk
    model: claude-sonnet-4
    server_url: https://omnigent.internal.example
    session_mode: session
    prompt_transport: stdin
    policy_mode: file
    extra_args:
      - --profile
      - delivery-team
```

`prompt_transport` defaults to `argument`, which uses Omnigent's current `--prompt <prompt>` one-shot path. Use `stdin` when the selected Omnigent runtime supports stdin one-shot prompts, or `prompt-file` only with Omnigent CLIs that expose `--prompt-file`. `policy_mode: file` passes a temporary Omnigent policy file containing allowed writes, shell/network requirements, and the role tool budget; Stagecraft still runs post-hoc write audit and gate validation after Omnigent exits. `DEVTEAM_HEADLESS_COMMAND` still overrides this block for one-off recovery or experiments.

If Omnigent prints a session or conversation identifier, Stagecraft writes an adapter-private sidecar at `pipeline/logs/<workstreamId>.omnigent.json`. The sidecar keeps IDs and policy verdict counts only; prompts, transcript excerpts, and raw policy lines are not copied into that metadata file, and gate JSON schemas remain host-neutral.

For all-Omnigent multi-workstream stages, an experimental director prototype can
dispatch the whole planned stage to one Omnigent session:

```bash
devteam stage build --headless --experimental-omnigent-director
```

This mode is intentionally narrow: every planned workstream must route to
`omnigent`, `--headless` is required, and `--skip-completed` is not supported.
The director receives the normal child workstream prompts and must write the
normal child gates, such as `pipeline/gates/stage-04.backend.json` and
`pipeline/gates/stage-04.qa.json`. Stagecraft does not consume a director gate;
missing or malformed child gates block the stage exactly like ordinary fan-out.

### Using openai-compat (OpenAI-compatible APIs)

`openai-compat` is Stagecraft's HTTP-native host adapter. Instead of spawning a CLI subprocess, it calls any provider that exposes an OpenAI-compatible Chat Completions API. That includes OpenAI, OpenRouter, Fireworks AI, Fuel iX, DeepSeek-compatible endpoints, Moonshot-compatible endpoints, and internal API gateways that expose `/v1/chat/completions`. No CLI to install.

#### Setup

```bash
devteam init --host openai-compat
```

What this installs:
- `.openai-compat/prompts/roles/` — role prompts in markdown format
- `.openai-compat/skills/` — Stagecraft skills in markdown format
- `.devteam/rules/` — shared pipeline and gate rules
- `.devteam/templates/` — shared artifact templates

No `.claude/` agents, no hooks, no slash commands are installed.

#### Configuration

Add a `hosts` block to `.devteam/config.yml`:

```yaml
routing:
  default_host: openai-compat

hosts:
  openai-compat:
    base_url: https://api.openai.com/v1       # or any compatible provider base URL
    api_key_env: OPENAI_API_KEY               # names the env var that holds the key
    models:
      default:    gpt-4.1                     # fallback for unmapped roles
      principal:  gpt-4.1
      security:   gpt-4.1
      red-team:   gpt-4.1
      migrations: gpt-4.1
      pm:         gpt-4.1
      backend:    gpt-4.1-mini
      frontend:   gpt-4.1-mini
      platform:   gpt-4.1-mini
      reviewer:   gpt-4.1-mini
      qa:         gpt-4.1-mini
      verifier:   gpt-4.1
```

The `api_key_env` field names the *env var that holds the key*, not the key itself — so the config file is safe to commit:

```bash
# .env (not committed)
OPENAI_API_KEY=sk-...
```

Provider-specific example:

```yaml
hosts:
  openai-compat:
    base_url: https://api.fireworks.ai/inference/v1
    api_key_env: FIREWORKS_API_KEY
    models:
      default: accounts/fireworks/models/qwen3-coder-480b-a35b-instruct
```

#### Prompt caching (phase 32.1) and inlined framework content (phase 37.2)

Every stage prompt is assembled in a stable four-layer order — framework
preamble/rules, role brief, learned context, then the volatile per-dispatch
tail — so the first three layers are byte-identical across every dispatch in
a run that shares the same role. OpenAI-style endpoints get automatic prefix
caching from that ordering alone, no config needed.

By default (`prompts.inline_framework: true`), layers 1-2 carry the actual
content of `AGENTS.md`, `.devteam/rules/*.md`, and the role brief — not just
their paths — so the ~22 KB the model used to re-read itself via tool calls
every dispatch sits in that byte-identical, cacheable position instead. A
short "Source files" note keeps the paths visible in a transcript. Set it to
`false` to revert to the pre-37.2 behaviour (the model reads the files
itself):

```yaml
prompts:
  inline_framework: false  # default: true
```

Turn it off for a host with no prefix caching and a small context window,
where re-reading a handful of small files each dispatch is cheaper than
carrying ~22 KB of framework text on every request.

For Anthropic-compatible endpoints reached through this adapter (a proxy
that accepts `cache_control` on message content blocks), opt in explicitly:

```yaml
hosts:
  openai-compat:
    caching:
      enabled: true
```

When enabled, `invoke()` sends the prompt as separate content blocks with
`cache_control: {type: "ephemeral"}` after the framework, role-brief, and
learned-context layers (never on the volatile tail, since it changes on
every dispatch and would never hit cache). `cached_tokens`, when the API
reports it under `usage.prompt_tokens_details`, is recorded on the gate so
`scripts/dashboard.js --view cost` can show cache-hit economics. Off by
default — only enable it against an endpoint that actually understands
`cache_control`; a plain OpenAI-compatible endpoint will typically just
ignore the extra field, but some strict implementations may reject it.

The normal `devteam stage --headless` and `devteam run` paths pre-render the
prompt in the orchestrator. The adapter preserves the four content blocks
when that pre-rendered text is byte-identical to its layered rendering. If a
host-specific orchestration step transforms the text, the adapter sends the
transformed prompt as a plain string instead of dropping the transformation
to force cache markers.

#### Environment variables

| Variable | Purpose | Default |
|---|---|---|
| `OPENAI_COMPAT_BASE_URL` | Base URL when `base_url` is not in config | `https://openrouter.ai/api/v1` (backward-compatible fallback; prefer explicit `base_url`) |
| `OPENAI_COMPAT_API_KEY` | API key when `api_key_env` is not in config | *(required)* |
| `OPENAI_COMPAT_MODEL` | Model when no per-role mapping and no `models.default` | *(required if no per-role mapping)* |

Resolution order: `.devteam/config.yml` → environment variables. When `api_key_env` is set in config, only that env var is read for the key; `OPENAI_COMPAT_API_KEY` is the fallback when `api_key_env` is absent from config.

See [`docs/reference/environment-variables.md`](reference/environment-variables.md) for the full list of env vars Stagecraft reads, including `DEVTEAM_VERBOSE` and OTel tracing vars.

#### Headless and auto-detection

`openai-compat` is HTTP-native — it has no CLI to spawn. When the configured `default_host` declares `httpNative: true` (which openai-compat does), `devteam stage <name>` **auto-enables headless mode without needing `--headless`**:

```
[devteam] openai-compat is HTTP-native — running headlessly
```

Passing `--headless` explicitly is also accepted and has the same effect. This auto-detection applies only when `default_host` is an httpNative adapter; routing a single role to openai-compat via `roles:` while keeping a CLI adapter as `default_host` still requires `--headless`.

#### Limitations

| Capability | Status |
|---|---|
| Headless invocation | ✓ auto-enabled (no CLI needed) |
| Shell (`bash` tool) | ✓ for roles that include `Bash` in their `toolBudget` |
| File I/O (`write_file`, `read_file`, `list_files`) | ✓ |
| Allowed-writes enforcement | Post-hoc git-diff audit (same as codex/gemini-cli) |
| Tool budget enforcement | Prompt-only — model is instructed via prompt; no API-level blocking |
| Hooks (`PreToolUse`, `PostToolUse`, `Stop`) | ✗ |
| Subagents | ✗ |
| Slash commands | ✗ |
| Worktrees | ✗ — stage-04 parallel workstreams run without git-worktree isolation |
| Goal loop | ✗ — replaced by a 40-iteration tool-call loop per dispatch |
| Per-role model selection | ✓ via `hosts.openai-compat.models.<role>` in config |

**Security posture.** The `bash` tool runs direct, allowlisted project commands only. It parses the command string into argv and rejects shell syntax such as pipes, redirects, background jobs, command substitution, env-prefix assignments, path-qualified executables, and non-allowlisted command names. Allowlisted commands still run with the same OS permissions as the invoking process, so run Stagecraft inside your normal project sandbox when that boundary matters.

**max_tokens cap.** The default is 32 768 tokens per API call. If the model hits this limit mid-tool-call, its arguments may be truncated (malformed JSON). The adapter emits a `warn: max_tokens hit` warning and the tool-call loop attempts recovery. Very long artifact writes are the most common trigger; if you see the warning repeatedly, raise `DEFAULT_MAX_TOKENS` in `hosts/openai-compat/invoke.js`.

**Function-calling reliability and context length.** Some models route function calls through their chat template (an internal token-based format) rather than the OpenAI `tool_calls` JSON structure. These models work well at short context but can regress at long context — emitting raw internal markup (e.g. `<|tool_call_argument_begin|>` or `functions.func_name:idx` ID prefixes) in the response `content` field instead of populating `tool_calls`. When this happens, the adapter receives an empty `tool_calls` array, no tool is executed, no gate is written, and the orchestrator halts with `structural-input`.

Signs of this failure mode in the run log:
- Tool call markup visible in the model's text output rather than in `[devteam] openai-compat: tool` lines
- `structural-input` halt with a "no gate" message immediately after a stage that read many files
- Subsequent retry succeeds (because context resets between dispatches)

Mitigation: keep `pipeline/context.md` concise; route long-context stages (build, verification) to a model with verified native `tool_calls` support such as DeepSeek V3/V4 or Qwen2.5-Coder. The auto-fix retry cycle normally recovers after one or two attempts.

#### Model recommendations by role tier

| Role tier | Example model ID | Example provider | Notes |
|---|---|---|---|
| Reasoning (principal, security, red-team, migrations, pm) | `gpt-4.1`, `deepseek/deepseek-v4-pro` | OpenAI, OpenRouter, DeepSeek-compatible gateway | Prefer reliable native `tool_calls` |
| Implementation (backend, frontend, platform, reviewer) | `gpt-4.1-mini`, `moonshotai/kimi-k2.7-code` | OpenAI, OpenRouter, Moonshot-compatible gateway | ⚠ see note below for Kimi |
| Test authoring (qa) | `gpt-4.1-mini`, `qwen/qwen3.6-27b` | OpenAI, OpenRouter, Fireworks AI | |
| Verification (verifier) | `gpt-4.1`, `xiaomimimo/mimo-v2.5-pro` | OpenAI, OpenRouter, Fuel iX/internal gateway | |

Any model that supports OpenAI function-calling and has sufficient context window (≥ 100 k tokens recommended for build stages) works.

**⚠ Kimi K2.7-Code note.** Kimi K2 models use an internal `functions.func_name:idx` tool-call ID format. Some providers normalize this before inference; others expose the raw chat-template behavior. At long context — typically after a stage with many `read_file` calls — the model can revert to its internal format, emitting tool calls as text content rather than via `tool_calls`. The effect is `finish_reason: stop` with no tool execution and no gate, followed by an orchestrator `structural-input` halt. The auto-fix retry usually recovers since context resets on each dispatch. For stages known to be context-heavy (`backend`, `verifier`), consider substituting a provider/model combination with verified native `tool_calls`, such as OpenAI GPT models, DeepSeek V3/V4, or Qwen Coder variants. This is a [documented upstream issue](https://blog.vllm.ai/2025/10/28/Kimi-K2-Accuracy.html) tracked by the vLLM and Moonshot teams.

#### Resuming after an escalation

The command to clear a gate and restart a stage is `devteam restart <stage>`, not `devteam run --restart`:

```bash
devteam restart build && devteam run
```

### Using ACP (Agent Client Protocol)

`acp` is Stagecraft's client-side adapter for the [Agent Client Protocol](https://agentclientprotocol.com) (Zed, JetBrains, Google, GitHub, 25+ agents — protocol version 1, pinned in `hosts/acp/capabilities.json`'s `acpProtocolVersion`). Any agent that speaks ACP as a server becomes a Stagecraft host with zero adapter code — the whole point of the protocol is that Stagecraft doesn't need to hand-write a `hosts/<agent>/adapter.js` for each one.

```bash
devteam init --host acp
```

Installs:

- `.acp/stagecraft/roles/` — role prompts in markdown format
- `.acp/stagecraft/skills/` — Stagecraft skills in markdown format

There is no single default ACP binary the way there is for `claude`/`codex`/`gemini` — you tell Stagecraft which agent command to run. Highest precedence first:

1. `DEVTEAM_HEADLESS_COMMAND` (universal override; same env var every other headless host respects)
2. The routing value itself, using the `acp:<agent-command>` form — the launch command travels with the route, since different roles may reasonably use different ACP agents:
   ```yaml
   routing:
     default_host: claude-code
     roles:
       backend: "acp:claude-agent-acp"
       qa: "acp:my-other-acp-agent --experimental"
   ```
3. `hosts.acp.command` in `.devteam/config.yml` — a project-wide default when you route to `acp` without an inline command:
   ```yaml
   routing:
     default_host: acp
   hosts:
     acp:
       command: claude-agent-acp
   ```
4. `hosts/acp/capabilities.json`'s `headlessCommand` — a runnable reference default (`npx -y @agentclientprotocol/claude-agent-acp`, the official ACP bridge for Claude Code); install and configure your own agent for anything else.

**Enforcement is call-time, not post-hoc.** Every ACP tool call is a `session/request_permission` round-trip *before* it executes, so the adapter checks the dispatch's real `allowedWrites` list and a claude-code-parity dangerous-command stoplist (`rm -rf`, `git push --force`/`-f`) on every call and denies in real time — the first non-claude-code host with tool-call-time enforcement (every other CLI host here is post-hoc-audit or prompt-only). See `hosts/acp/permissions.js` for the exact rules.

**Two-root review mode.** `hosts/acp/permissions.js`'s `evaluateToolCall` supports a `codeRoot`/`stateRoot`/`mode` form in addition to the single-root shape above: with `mode: "review"`, any `edit`/`delete`/`move` resolving inside `codeRoot` is denied outright (read-only, regardless of `allowedWrites`), writes under `stateRoot` are still checked against `allowedWrites`, and `execute` calls become deny-by-default with a read-only allowlist (`rg`, `grep`, `git log`/`diff`/`show`/`status`, `ls`, `cat`, `find`, `wc`, parsed to argv — never substring-matched — with any redirection or shell metacharacter denied outright; extend the plain-binary set via `hosts.acp.review.exec_allowlist` in `.devteam/config.yml`). This is the mechanical primitive `devteam review`/`devteam review-pr` (phase-36, [docs/external-review.md](external-review.md)) dispatch through when `--host acp` — every run outside that path still gets the single-root behavior above, byte-identical.

**Current posture:** no hooks, no Stagecraft-managed subagent fan-out, no slash commands, and no worktree mapping — same conservative stance as Omnigent/openai-compat. `telemetry: "estimated"` — ACP has no standardized usage field, so cost falls back to the promptBytes/4 estimate every non-native host uses.

### Multi-host in headless mode

Headless mode (`--headless`) works normally in multi-host setups. Each workstream spawns its own host process or native adapter invocation; they run concurrently within a stage. Every host you route work to must support headless (`claude-code`, `codex`, `antigravity`, `gemini-cli`, `omnigent`, `acp`, and `openai-compat` do; `generic` does not). In an unattended pipeline loop, mixed-host stages produce gates through the same contract and advance the pipeline normally.

### When single-host is the right call

- **Your team only has one CLI installed.** Multi-host requires authenticating each CLI separately. If everyone uses Claude Code, there's no upside.
- **Debugging costs.** When a multi-host stage fails, the first question is "which model caused this?" That's an extra diagnostic step. Single-host failures are easier to attribute.
- **Spend visibility.** Two CLIs mean two billing accounts. Per-stage cost attribution across hosts requires correlating two dashboards.

Default to single-host. Add a second host when you have a specific cost, diversity, or tool-fit reason that justifies the extra setup.

## Headless mode

When you want the orchestrator to drive the host CLI directly:

```bash
devteam stage build --headless
```

For each workstream, the orchestrator spawns the host's headless command (`claude --print` for claude-code, `codex exec --sandbox workspace-write` for codex, `agy --print` for antigravity, `gemini` for gemini-cli, `omnigent run .omnigent/stagecraft/agent --no-session --prompt <prompt>` for omnigent), or calls an HTTP-native adapter such as `openai-compat`, and waits for exit. Summary line per workstream:

```
[devteam] dispatching backend → codex (headless)
  ✓ backend (codex): exit 0, 73000ms → pipeline/gates/stage-04.backend.json
```

Exits 0 only if every workstream both exit-0'd and wrote its gate. Exits 1 otherwise.

Hosts must declare `capabilities.headless: true` for `--headless` to work. The generic adapter doesn't support headless; trying to use it that way gives a pre-flight refusal:

```
devteam: host "generic" cannot drive workstream "pm" headlessly
(capabilities.headless is false). Either install a different host
for this role or run interactively (omit --headless).
```

### Headless vs user-driven — when to pick which

- **User-driven (default).** Best for: first runs, debugging a stage, anything where you want to see what the model is doing. Most onboarding flows live here.
- **Headless.** Best for: CI pipelines, scripted runs, regression testing, batch processing. The prompt goes to the host CLI's stdin; the model runs unattended; you get the gate back.

You can mix: `devteam stage requirements` user-driven, then `devteam stage build --headless` once you trust the build stage to run unattended.

### Running the full pipeline unattended

The supported way is **`devteam run`** — the bounded autonomous driver. It advances the pipeline to completion, **auto-fixes** machine-diagnosable failures (`code-defect`), retries transient dispatch blips, and halts cleanly the moment a human is genuinely needed:

```bash
devteam run                       # drive the configured track to completion
devteam run --watch               # rolling liveness status on an interactive terminal
devteam run --until peer-review   # stop after a specific stage
devteam run --budget-usd 10       # stop before a dispatch once spend ≥ $10
devteam run --allow-stage sign-off --allow-stage deploy   # grant the consequence ceiling
devteam run --auto-rule formatting-only,doc-only          # auto-resolve bounded escalation classes
devteam status --verbose                                  # inspect active/last workstream details
devteam performance critical-path                         # inspect where run time went
```

It never advances into `sign-off`/`deploy` without `--allow-stage`, and by default halts on every escalation (the Principal isn't dispatched unless you pass `--auto-rule`). It writes `pipeline/run.lock`, a resumable `run-state.json` (`--resume`), and an audit-trail `run-log.jsonl`. At startup, non-JSON runs print the effective track, stage count, configured skips, conditional-stage count, and base workstream count; `run-log.jsonl` records the same data as `run-plan`. During dispatch, line progress now reports each workstream start/finish with its host plus gate/log pointers; configured per-host limits record `workstream-queued` and `queue_ms` so queue wait is visible in `devteam performance critical-path`. `--watch` redraws a rolling liveness block only on a TTY and includes active workstreams, the last settled workstream, transcript, and gate pointers. Redirected output remains line-oriented and ANSI-free. See [`docs/runbooks/autonomous-run.md`](runbooks/autonomous-run.md) for the full launch guide, halt reasons, and limitations.

```yaml
routing:
  default_host: codex
  host_concurrency:
    default: 2
    codex: 1        # keep local Codex workstreams serialized
    claude-code: 3  # allow more remote/native fanout
```

**Iteration budget.** Each call to `devteam next` — one examine-and-act cycle, regardless of what it does — counts as one iteration. The default cap is **100** (`--max-iterations N` to override). Hitting the cap halts with `halt_action: "max-iterations"`. For most pipelines this is invisible: a clean full-track run is roughly 20–25 iterations. Where it matters is the fix-and-retry loop: when a stage FAILs with a `code-defect`, the driver clears its gates, injects the blockers into `context.md`, and re-dispatches — each such cycle consumes approximately 3 iterations (dispatch → fix dispatch → merge). A stage that exhausts its entire per-stage retry budget (default 2 retries, configurable via `autonomy.max_retries` in `.devteam/config.yml`) before escalating costs ~6–9 iterations on its own. Lower `--max-iterations` in CI to bound spend; raise it (or increase `max_retries`) only when you want the driver to attempt more self-correction before escalating.

### Running in repair mode (`--repair`)

For bug fixes — when existing behavior is wrong, not when new capability is needed — use
`--repair` instead of `--feature`:

```bash
devteam run --repair "symptom description"
# e.g.: devteam run --repair "JSON.parse fails on markdown-fenced responses; output silently defaults to 'skip'"
```

`--repair` activates fix-aware behavior across three stages:

1. **Diagnosis** — Stage-01 produces a `pipeline/diagnosis.md` (root cause, proposed fix,
   affected-files list) instead of a feature brief. The gate lands as ESCALATE until you
   approve it with `devteam next`, or pass `--auto-rule diagnosis-approved` to handle it
   autonomously.
2. **Scoped build** — The build agent sees a `⚠️ PATCH MODE` block and is constrained to the
   diagnosed files. Any write outside that set causes a `scope-gate` halt.
3. **Failing-first regression test** — Stage-03b runs even on hotfix depth and writes a test
   that is RED before the fix and GREEN after.

```bash
devteam run --repair "symptom"                         # hotfix depth (default), diagnosis first
devteam run --repair "symptom" --track full            # full pipeline with repair intent
devteam run --repair "symptom" --auto-rule diagnosis-approved  # autonomous diagnosis approval
devteam run --repair "symptom" --repair-at src/auth.js:42     # skip diagnosis; seed file:line
```

`--repair` and `--feature` are mutually exclusive. For the full operator runbook (diagnosis gate approval, scope-gate FAIL recovery, tri-state `reproduced` field), see [`docs/runbooks/repair-flow.md`](runbooks/repair-flow.md).

**Under the hood** — `devteam run` is a code loop around `devteam next --json`. If you want to build your own (e.g. custom dispatch, a different halt policy), the primitive is the same:

```bash
while true; do
  read -r action name < <(devteam next --json | jq -r '[.action, .name // ""] | @tsv')
  case "$action" in
    run-stage)         devteam stage "$name" --headless ;;
    merge)             devteam merge "$name" ;;
    pipeline-complete) echo "Pipeline complete"; break ;;
    *)                 echo "Needs human: $action${name:+ ($name)}"; break ;;
  esac
done
```

`devteam next --json` returns `action: "fix-and-retry"` on FAIL and `action: "resolve-escalation"` on ESCALATE (each with a `failure_class`); both fall through to the `*)` branch here. `devteam run` is the production version of this loop with retries, the consequence ceiling, budget caps, locking, and an audit trail built in.

### Scoped re-runs after red-team FAIL (--patch)

When red-team FAILs, running a full build re-run risks touching unrelated code and introducing new findings. `--patch` scopes build agents to only the items in the failed stage's `must_address_before_peer_review` list:

```bash
devteam stage build --patch --from red-team --headless
```

The flag reads `pipeline/gates/stage-04c.json`, extracts the blockers, and injects a **PATCH MODE** section at the top of the prompt (before the objective) so agents see exactly what to fix and are instructed not to touch anything else.

`--from` defaults to `red-team` and accepts any stage name. The gate for that stage must already exist in `pipeline/gates/`.

When red-team writes a FAIL gate, the validator automatically writes the blockers into `pipeline/context.md` (between `<!-- devteam:red-team-blockers:begin -->` markers) so they persist across re-runs. `--patch` reads from the gate itself and is additive: you get both the `context.md` signal and the explicit prompt scope.

After the patch build, continue the usual chain:

```bash
devteam stage pre-review --headless
devteam stage security-review --headless   # if still required
devteam stage red-team --headless          # verifies fixes
```

For the complete procedure with a worked example (including the portable gate-clear command to re-run only the affected workstream, what happens to non-target workstreams, the `noted_for_followup` question, and the equivalent flow for QA/pre-review/peer-review FAIL), see **[`docs/runbooks/fix-and-retry.md`](runbooks/fix-and-retry.md)**.

### Fixing QA failures within build

When QA's workstream gate within Stage 4 is FAIL, the bugs belong to the other build roles (typically backend or platform). The validator automatically writes the QA blockers into `pipeline/context.md` (between `<!-- devteam:qa-build-blockers -->` markers) so implementation agents see them on the next re-run.

Use `--workstream` to target only the affected roles — no gate deletion needed:

```bash
devteam stage build --patch --from stage-04.qa --workstream backend --workstream platform --workstream qa --headless
devteam merge build
devteam next
```

`--patch --from stage-04.qa` reads the QA gate's `blockers[]` and injects a **PATCH MODE** section at the top of each dispatched prompt, telling agents to fix only the listed items. `--workstream` dispatches only the named roles; frontend's gate (which passed) is left untouched.

The agents see: the QA blockers already in `context.md` (written by the validator when QA's gate was first validated), plus the explicit PATCH MODE list in the prompt. Both signals reinforce the same fix targets.

**Manual alternative.** If you need to direct the bugs more explicitly than the auto-injected blockers allow, edit `pipeline/context.md` before re-running to add role-specific instructions:

```markdown
## QA findings — build re-run required

**dev-backend** must fix:
- `express.static` points to `public/` which doesn't exist; frontend is at `src/frontend/`

**dev-platform** must fix:
- Dockerfile CMD references `src/server.js`; server is at `src/backend/server.js`
```

Then re-run as above. The manual additions and the auto-injected blocker block coexist in `context.md`.

### Headless timeout

The default headless timeout is 10 minutes per workstream. Slow stages (red-team, verification-beyond-tests) can exceed this. Pass `--timeout-ms` to override:

```bash
devteam stage red-team --headless --timeout-ms 1800000   # 30 min
devteam stage red-team --headless --timeout-ms 0          # no cap
```

The timeout is per workstream, not per stage. A multi-role stage with three parallel workstreams gets 3 × N ms total wall-clock.

### Stubbing for tests

Set `DEVTEAM_HEADLESS_COMMAND=cat` to bypass the real host CLI:

```bash
DEVTEAM_HEADLESS_COMMAND=cat devteam stage requirements --headless
```

`cat` just echoes the prompt; the gate won't be written, so the run exits 1. Useful for verifying the spawn + pipe machinery without `claude` / `codex` installed.

## Docker runner

Use the Docker runner when you want `devteam run` to continue without relying on
your interactive shell or laptop session. It runs the normal local orchestrator
inside one container and keeps all durable project state on the mounted project
directory.

Build the image from the Stagecraft repository:

```bash
docker build -f hosts/docker/Dockerfile -t stagecraft-runner:local .
```

Run it from the target project:

```bash
docker run --rm \
  --user "$(id -u):$(id -g)" \
  -v "$PWD:/workspace" \
  --env-file .devteam/docker.env \
  stagecraft-runner:local run --cwd /workspace --watch
```

The `devteam` prefix is optional:

```bash
docker run --rm -v "$PWD:/workspace" stagecraft-runner:local devteam status --cwd /workspace
```

The base image does not bake in provider credentials or a specific CLI host. Use
`openai-compat` for the simplest no-extra-CLI setup, or layer Claude Code, Codex
CLI, Antigravity CLI, or private tools in a derived image if your team has a
non-interactive auth flow.

On startup the entrypoint reports an existing `pipeline/run.lock` and prints
safe resume/force guidance. It does not silently delete locks. If you have
confirmed a lock is stale and want the wrapper to remove it before delegating,
set `STAGECRAFT_RUNNER_CLEAR_STALE_LOCK=1`.

See [`hosts/docker/README.md`](../hosts/docker/README.md) for UID/GID build
args, secret handling, resource limits, and troubleshooting.

## The web UI

```bash
devteam ui --open
```

Boots a local HTTP server (default `http://127.0.0.1:3737/`) and opens it in your browser. The UI shows:

- **Top bar:** active track, configured hosts.
- **Stage rows:** one per stage in the active track. Status icon + color. Multi-role stages expand to show per-workstream rows.
- **Click a row:** opens the gate detail panel (identity fields, blockers, warnings, workstreams table, raw JSON).
- **Click a role chip:** opens that role's brief inline.

Live updates: the UI watches `pipeline/gates/` via `fs.watch` and pushes changes over Server-Sent Events. Run a stage in another terminal; rows light up in the browser as gates land. No refresh needed.

### Flags

```bash
devteam ui                        # 127.0.0.1:3737, no browser
devteam ui --port 8080            # different port
devteam ui --open                 # auto-open browser
devteam ui --cwd /path/to/proj    # view another project's pipeline
```

### Security

Loopback bind only by default. If you need to expose the UI on your LAN, note the UI has no auth and anyone who can connect can see all pipeline state:

```bash
STAGECRAFT_UI_ALLOW_REMOTE=1 devteam ui --port 8080
```

A loud warning prints on startup. Don't use this in any context where untrusted users can reach the port.

## Persistent memory

Stagecraft indexes pipeline artifacts (briefs, design specs, ADRs, retros, lessons) into a per-project semantic memory:

```bash
devteam memory ingest                                 # index everything under pipeline/
devteam memory query "user notification opt-in"        # semantic search
devteam memory query "schema migrations" --kind design-spec
devteam memory stats                                   # what's indexed
devteam memory clear                                   # wipe
devteam memory reindex                                 # re-embed (after embedder change)
```

The local-default embedder (`Xenova/bge-small-en-v1.5` via `@huggingface/transformers`) is ~33MB, lazy-downloaded to `~/.cache/huggingface/`, and runs entirely offline after the first ingest. JSON-backed storage under `.devteam/memory/` is git-friendly, but `.devteam/memory/` is excluded by the managed `.gitignore` block that `devteam init` writes — so it is ignored by default. If you have a deliberate sharing strategy (the store contains plaintext copies of brief / design content), remove that entry from the block.

Opt out per artifact by including the marker `stagecraft-no-memory` anywhere in the file (a comment line works). Stagecraft skips that artifact at ingest.

For the full reference: [`docs/memory.md`](memory.md).

## Pattern learning

Use `devteam patterns` when the same review finding keeps coming back across
features. It is different from `devteam memory`: memory retrieves project facts;
patterns inject compact prevention guidance into future coding-agent prompts.

`devteam run` collects patterns automatically at the end of every run — on a clean
completion, and on any halt that left a gate on disk — so the normal loop is just
review and promotion:

```bash
devteam patterns review
devteam patterns promote <candidate-id> --text "When adding a user-visible HTTP endpoint, update README.md or docs/reference/* in the same implementation pass."
devteam patterns stats
```

`devteam patterns collect` still exists for manual runs and backfilling pipeline
directories from before this ran automatically. Either way, collection reads local
pipeline state and stores sanitized observations under `.devteam/patterns/`: blockers,
warnings, `noted_for_followup[]`, archived auto-retry failures, and retry outcomes. It
does not store raw prompts, transcripts, full source snippets, repository remotes, or
raw blocker text. Promoted guidance is the only text shown to agents. A pattern that
has been retired stays retired — collection drops any candidate matching a retired
pattern's identity instead of re-surfacing it from the same observations.

The taxonomy is intentionally small:

| Tier | Use it for | Prompt behavior |
|---|---|---|
| `blocker` | A defect that failed a gate or forced retry. | Strong prevention candidate after review. |
| `warning` | A likely issue or senior-engineering concern. | Coaching only; promote when recurrent or clearly valuable. |
| `nudge` | Local style, architecture, or team preference. | Inject narrowly and only when relevant. |
| `positive` | A practice that helped a clean first pass. | Reinforce sparingly so the prompt is not all warnings. |

After promotion, Stagecraft selects only relevant patterns by stage, workstream,
language, framework, and feature hints, then renders them in a bounded `Known
Project Patterns` section. The section is advisory: stage instructions, allowed
writes, gate schemas, and stoplists still win.

Retire stale or noisy guidance:

```bash
devteam patterns retire <pattern-id> --reason "covered by preflight check"
```

Every promoted pattern also tracks how it's doing in practice: `stats.injected`
increments on each real dispatch (headless run or the prompt printed for a human to
paste into a host — never a preview like `devteam reproduce`), and
`stats.recurrence_after_injection` increments when the same blocker shows up again in
a later dispatch of that stage despite the injected guidance. `devteam patterns
review` flags a pattern as a demotion candidate once recurrence reaches
`patterns.demotion_recurrence_threshold` in `.devteam/config.yml` (default `3`) — a
flag only, never automatic. If a pattern keeps recurring, send it back to candidate
rather than deleting its history outright:

```bash
devteam patterns demote <pattern-id> --reason "recurring despite injection — needs a better prompt or a real gate"
```

Demotion is reversible: `devteam patterns promote <pattern-id>` restores it, keeping
the demotion audit trail (who, when, why, and the counters at the time).

For the full reference, including storage shape, edge cases, auto-retry semantics,
and graduation to deterministic gates, see [`docs/pattern-learning.md`](pattern-learning.md).

## Observability (OpenTelemetry)

Stagecraft emits OTel spans for every pipeline operation. Opt in via the standard env var:

```bash
export OTEL_EXPORTER_OTLP_ENDPOINT=http://localhost:4318
devteam stage build
# spans now ship via OTLP/HTTP to your collector
```

Spans emitted: `pipeline.stage`, `pipeline.workstream`, `pipeline.stage.headless`, `pipeline.merge`, `pipeline.next`, `adapter.renderStagePrompt`, `adapter.invoke`. Attributes include stage, workstream id, role, host, and status.

Works with Jaeger, Tempo, Honeycomb, Datadog Agent, and anything else that speaks OTLP/HTTP. For setup cookbooks, see [`docs/observability.md`](observability.md).

Tracing is no-op (zero overhead) when no endpoint is configured. To force-disable even when an endpoint is set (useful in tests that import core modules): `DEVTEAM_OTEL_DISABLE=1`.

## Multi-model peer review

Stage 5 (peer-review) can run across multiple hosts simultaneously. Each area gets reviewed by every configured host; the merged gate is pessimistic. All reviewers apply the same four-principles rubric. The cross-model signal comes from training-data diversity, not from giving different reviewers different methods. For method diversity (a different role applying a different methodology), see Stage 4c red-team.

```yaml
# .devteam/config.yml
routing:
  default_host: claude-code
  review_fanout: [claude-code, codex, gemini-cli]
```

With three hosts and four review areas, you get 4×3 = 12 parallel reviews. The approval-derivation hook recognizes host-based filenames (`pipeline/code-review/by-<host>.md`) and writes gates to a three-segment path (`pipeline/gates/stage-05.<area>.<host>.json`). The merge reads all expected fanout gates and aggregates pessimistically: any FAIL on any area from any model produces a merged FAIL.

Default is empty (off). Opt in via config. The cost is N× peer-review time and N× LLM cost. The benefit is model diversity: a bug one model rationalizes, another may flag.

## Auditing a codebase

The audit feature is separate from the 18-stage pipeline. Pipeline stages build features; the audit analyzes an existing codebase and produces a prioritized improvement roadmap. It is read-only by design.

### When to use it

- **Onboarding to a new project.** `/audit-quick` in ~10 minutes produces a project-context doc, architecture map, and git-history picture.
- **Before a refactor.** Full `/audit` produces a roadmap of what to fix in what order. The `implement` skill consumes `docs/audit/10-roadmap.md` directly.
- **Before a security review.** Phase 2.1 specifically catches secrets hygiene, injection risks, auth gaps, dependency CVEs.
- **Periodic health check.** Re-running `/audit` quarterly or after major changes shows what got fixed and what new findings have accumulated.

### How to invoke it

Inside Claude Code (after `devteam init --host claude-code`):

```
/audit                  # full audit, Phases 0-3, ~30-60 minutes, 11 output files
/audit-quick            # Phases 0-1 only, ~5-15 minutes, 6 output files
/audit src/backend/     # scope to a subtree
/audit --resume         # continue from the last completed phase (uses docs/audit/status.json)
```

On Codex / Antigravity / Gemini CLI / Omnigent / generic / openai-compat hosts, invoke the `auditor` role with the `audit` skill:

```
You are the auditor. Read .codex/skills/audit/SKILL.md and run a full audit.
```

Output lands under `docs/audit/` in your project. Eleven files (00 through 10) plus `status.json`.

### Phases

- **Phase 0 — Bootstrap.** What this project is, architecture map, git history.
- **Phase 1 — Health assessment.** Convention compliance, test health, documentation gaps.
- **Phase 2 — Deep analysis.** Security, performance & reliability, code quality.
- **Phase 3 — Roadmap.** Prioritized backlog (P0/P1/P2/P3/Parked) + sequenced batches.

`/audit` includes human checkpoints between each phase so you can correct course before the deep analysis runs. `/audit-quick` skips Phases 2 and 3; run `/audit --resume` later to complete them.

### Extending an audit

Drop `docs/audit-extensions.md` in your project to add project-specific checks. The audit reads it at the start of each phase and appends extension findings to the relevant phase's output file under a `## Project-Specific` heading. Example use cases: PCI / HIPAA / SOC 2 compliance checks, team-specific naming conventions, custom security policies.

### What the output actually looks like

Stagecraft was first audited with this feature against its own codebase on **2026-05-28** as a dogfood run. The 11 phase output files (plus `status.json`) are preserved under [`docs/audit-archive/2026-05-28-v0.4.0-initial-dogfood/`](audit-archive/2026-05-28-v0.4.0-initial-dogfood/) in this repo (a newer audit may exist at `docs/audit/`; see [`docs/audit-archive/HISTORY.md`](audit-archive/HISTORY.md) for the index). Highlights from the first audit:

- **[`00-project-context.md`](audit-archive/2026-05-28-v0.4.0-initial-dogfood/00-project-context.md)** — what Stagecraft is, ~150 lines.
- **[`01-architecture.md`](audit-archive/2026-05-28-v0.4.0-initial-dogfood/01-architecture.md)** — component inventory, dependency graph, data flow, configuration surface. ~330 lines, the longest output.
- **[`06-security.md`](audit-archive/2026-05-28-v0.4.0-initial-dogfood/06-security.md)** — security findings. Includes a real "verify before promoting" lesson: a Finding S5 was initially promoted to "medium severity / needs fix" based on the route signature, then **retracted** when a live curl exploit attempt returned HTTP 404. The verification and retraction are preserved in the file. This is the discipline the audit skill now codifies (see `skills/audit/SKILL.md` § Process discipline).
- **[`10-roadmap.md`](audit-archive/2026-05-28-v0.4.0-initial-dogfood/10-roadmap.md)** — sequenced batches with effort estimates. The self-audit identified 0 P0 items, 5 P1 quick wins, 5 P2 targeted items, 1 P3 strategic item.

Every finding in those files cites file paths and line numbers; severity / effort / confidence ratings are concrete; the verification trace for retracted findings is preserved. That is the standard the skill demands of the output, and Stagecraft's own audit met it.

### What the audit does NOT do

- It does not modify source code. Findings live in `docs/audit/`; fixing them is the `implement` skill or a `devteam stage` invocation.
- It does not audit Stagecraft itself unless you explicitly ask. The audit targets the project Stagecraft was installed into.
- It does not skip phases without a documented reason in `status.json`.

### Auditing a feature built with Stagecraft — the four modes

When the feature you're auditing was built with Stagecraft, the audit trail is unusually rich: `pipeline/brief.md` (intent), `pipeline/design-spec.md` + `pipeline/adr/` (design rationale), `pipeline/gates/*.json` (every decision), `pipeline/code-review/by-*.md` (review evidence), `pipeline/red-team-report.md` (adversarial findings), `pipeline/spec.feature` + `pipeline/test-report.md` (AC ↔ test mapping), `pipeline/retrospective.md` (lessons). Audits of externally-built features must reverse-engineer this material from chat logs or version history. For a Stagecraft-built feature, the files are already there. This affects which audit modes are most valuable.

The `/audit` slash command covers only one of four useful audit modes:

| Mode | What it asks | Tool / approach |
|---|---|---|
| **Code audit** | "Is the code itself clean, secure, performant, well-documented?" | `/audit` or `/audit-quick` (claude-code) — see "How to invoke it" above. On other hosts, dispatch the `auditor` role with the `audit` skill. Output: `docs/audit/00–10`. |
| **Process audit** | "Did the pipeline that produced this feature hold up? Any rubber-stamping, skipped reviews, normalized warnings, deferred items that never got tracked?" | Read `pipeline/` skeptically; cross-check with `devteam summary`, `devteam verify stage-04a`, `devteam verify stage-06`. No CLI verdict; this is a manual read. |
| **Consistency audit** | "Does the implementation still match the brief / design / spec? Has anything drifted since ship?" | `devteam spec verify --strict` (brief.md ↔ spec.feature ↔ test-report.md), `devteam reproduce <stage-id>` (gate fingerprint check), `devteam replay <stage-id>` (re-run with current config + diff). |
| **Threat audit** | "Are the threat assumptions from when this was built still valid? New endpoints, new IAM policies, new dependencies?" | `devteam stage red-team --headless` against the current code. Anything new, or anything that was `noted_for_followup` and still isn't fixed, surfaces. Follow with `devteam advise` to triage any new deferred findings. |

Choose based on what you need to know:

- **Code quality** → Code audit (`/audit`). Works the same for Stagecraft-built and externally-built features.
- **Process compliance** → Process audit. Most useful for catching pipeline drift, which code-quality scans cannot detect.
- **Brief/spec/implementation alignment** → Consistency audit. `devteam spec verify` is a single command; it catches the common case of code changing without updating the brief.
- **Ongoing threat exposure** → Threat audit. Most valuable for features that have been in production as the surrounding environment has changed.

#### Process-audit checklist (mode 2)

The process audit is unique to Stagecraft-built features and has no CLI tool. It is a structured manual review. Walk these five questions:

- **Did every gate genuinely pass, or did anything get rubber-stamped?** Read each `pipeline/gates/stage-NN.json` and the corresponding artifact. A PASS with a sparse `## Verify` section in `pipeline/pr-*.md` is a yellow flag. Stage 4 (build, per-role during dispatch + a merged full-suite check after merge — Phase 31.1), Stage 4a, Stage 4c (red-team's mechanical floor — Phase 31.2), Stage 5 (peer-review's merged gate re-derives approval state from `pipeline/code-review/by-*.md` — Phase 31.5, panel mode only), and Stage 6 are orchestrator-stamped — look for `_orchestrator_stamped` on the workstream and merged gates. Run `devteam verify stage-04a`, `devteam verify stage-04c`, and `devteam verify stage-06` to re-stamp those on demand (stage-04 and stage-05 re-stamping is only automatic on `devteam run`, not yet available as an on-demand `devteam verify stage-04`/`stage-05`); if the current code still passes, the recorded PASS was real.
- **Are the warnings still defensible?** `jq '.warnings[]' pipeline/gates/*.json` lists every warning that survived to PASS. SUGGESTION-flavored warnings are fine; CONCERN-flavored ones that never got resolved to a ticket are technical debt that's been quietly normalized.
- **Did red-team's `noted_for_followup` items get tracked anywhere?** `jq '.noted_for_followup' pipeline/gates/stage-04c.json`. Each entry has a `track_for` field saying where it should land (ticket, ADR amendment, runbook note). If `devteam advise` was run during the pipeline, check `pipeline/context.md` for the advisory section — each item's decision is recorded there (`DEFERRED:`, `NOTED:`, `KNOWN-FLAKY:`, etc.). If nothing exists, the deferral was theoretical.
- **Did peer review actually exercise the matrix?** `grep -c "^## Review of " pipeline/code-review/by-*.md` should hit each non-self area at least twice (matrix) or once (scoped/nano). If a `by-<reviewer>.md` has only one section, that reviewer's coverage was thin.
- **Did the retrospective land anything?** `pipeline/retrospective.md` should cite specific incidents from the run. A generic "tests pass and we shipped" retro means the team didn't reflect.

A full process audit takes ~30 minutes on a `full`-track feature. Process drift is invisible to code-quality scans, making this the highest-leverage audit for catching it.

#### Cross-host notes

- **`/audit` and `/audit-quick`** are claude-code-only (slash commands are a claude-code UX surface). On other hosts, dispatch the `auditor` role with the `audit` skill. See § How to invoke it above for the exact prompt.
- **The `auditor` is also registered as a Claude Code subagent** (`hosts/claude-code/adapter.js`), so you can dispatch to it via `Task`. Other hosts do not have an equivalent subagent registration; invoke the role-plus-skill as a single prompt.
- **Modes 2, 3, 4 are host-agnostic.** They run against files on disk (`pipeline/`, `docs/`, source) and use `devteam` CLI subcommands that don't dispatch to any model. You can do them with no LLM at all, just `jq` and a careful reader.

## When things go wrong

### "Host lacks required capability"

```
devteam: stage "pre-review" requires capability "shell" but host "generic" does not declare it.
```

Stages that need to run shell commands (pre-review, qa, verification-beyond-tests, deploy, performance-budget) declare `requiredCapabilities: { shell: true }`. If the host routed to that stage doesn't declare shell support, `assertCapabilities()` refuses at dispatch time with this error. Resolution:

- Switch to a shell-capable host for that stage: add `stages: pre-review: claude-code` (or `codex`, `antigravity`, or `gemini-cli`) to `routing:` in `.devteam/config.yml`.
- Or skip the stage entirely with `pipeline.skip_stages: [pre-review]` if it's not relevant to your workflow.

### "Unknown stage" or "No adapter found"

You typo'd a stage or host name. Use `devteam stages` and `devteam hosts` to see what's known.

### `devteam next` says `fix-and-retry`

A stage gate has `status: FAIL`. The blockers are listed in `devteam next`'s output. Address them, re-run the stage, let the new gate overwrite the old one.

If you re-run the same stage more than once without resolution, the model should increment `retry_number` and fill `this_attempt_differs_by` with a non-empty string describing what changed. The validator enforces this: a gate with `retry_number >= 1` and an empty or missing `this_attempt_differs_by` is rejected. This prevents silent retry loops where the model writes the same failing gate again.

If retrying several times yields no progress, write a gate with `status: ESCALATE` to signal that a human decision is needed.

For the full procedure (what to read, how to scope the re-run with `--patch` and `--skip-completed`, and per-stage specifics for red-team, QA-in-build, pre-review, and peer-review), see **[`docs/runbooks/fix-and-retry.md`](runbooks/fix-and-retry.md)**.

### `devteam next` says `resolve-escalation`

A stage gate has `status: ESCALATE`. Use escalation when:
- The model can't determine PASS or FAIL without human input (e.g. an ambiguous security finding)
- The change scope has grown beyond what the brief covers and a human must decide whether to re-scope or proceed
- A veto-capable stage (security review, migration safety) found a concern that needs human judgement

The pipeline cannot advance until you resolve it. Read the gate's `escalation_reason` and `decision_needed`, make the call, then either rewrite the gate to `PASS`/`WARN`/`FAIL` or use `devteam restart <stage>` to clear it and re-run the originating stage.

For the full procedure (what to read in what order, how to invoke the Principal role for a binding ruling, how to encode must-fix vs defer decisions, common gotchas), see **[`docs/runbooks/escalation.md`](runbooks/escalation.md)**.

### Ad-hoc Principal rulings (`devteam ruling`)

Some decisions need the Principal's judgment but do not warrant re-running a whole stage, for example:

- A reviewer's `ESCALATE-to-Principal:` marker in `pipeline/code-review/by-<reviewer>.md` calls out an architectural question (e.g. "this approach contradicts ADR-0003; Principal should rule").
- An ADR-vs-implementation drift surfaces mid-pipeline ("the ADR says round to 6 decimal places; the code rounds to 8 — which is right?").
- A consistency-audit finding (`devteam reproduce`) shows the system-prompt hash drifted and you need a Principal call on whether to re-baseline or replay.

`devteam ruling` dispatches the Principal subagent for a focused ruling. The result lands as a `PRINCIPAL-RULING:` line in `pipeline/context.md` under a `## Principal Rulings` section. No gate is written; the ruling is an artifact, not a status change. After reading the ruling, use `devteam restart <stage>` (must-fix path) or hand-edit the escalating gate (defer path) to act on it.

```bash
devteam ruling --topic "ADR-0003 round(x,6) vs implementation round(x,8)" \
               --context pipeline/adr/0003-cost-rounding.md,pipeline/code-review/by-qa.md \
               --target-gate pipeline/gates/stage-05.json \
               --headless
```

Flags:

- **`--topic "..."`** (required) — short description of what to rule on.
- **`--context paths`** — comma-separated files Principal should read (the reviewer's file, the ADR, the failing test report, etc.).
- **`--target-gate path`** — the escalating gate. Principal will read its `escalation_reason` and `decision_needed`.
- **`--headless`** — pipe the prompt through the Principal-routed host's headless command. Without it, the prompt prints to stdout for manual paste (user-driven mode).

Routing: `devteam ruling` resolves the Principal's host from `routing.roles.principal` if set in `.devteam/config.yml`, else `routing.default_host`. Refuses cleanly when the routed host doesn't support `--headless` (e.g., `generic`).

For when to use `ruling` vs `devteam stage`, vs hand-editing gates, vs `devteam restart`, see [`docs/runbooks/escalation.md`](runbooks/escalation.md).

### Stoplist blocked my change

```
This change matches the safety stoplist. Re-run with --track full instead.
Reasons:
  - authentication: matched "auth" in: add auth middleware
```

You ran a lighter track (`quick`, `nano`, `config-only`, `dep-update`, `loop`) and the change description matched a stoplist phrase. Two options:

- **Recommended:** switch to `full` or `hotfix`. The change is consequential enough to warrant the rigor.
- **If false positive:** re-run with `--force` to bypass. Use sparingly.

### `devteam doctor` reports critical failures

Walk down the list. The most common causes:

- `.devteam/config.yml exists` ✗ → run `devteam init --host <name>`
- `host "X" install` ✗ → re-run `devteam init --host X` to re-render the install
- `node_modules/js-yaml present` ✗ → run `npm install` in the framework dir
- `claude on PATH` ✗ → install Claude Code, or use `--host generic` instead

### Stage gate written but `next` doesn't advance

Run `devteam validate` to see what the validator thinks of your gate. Common causes:

- Missing required field (`orchestrator`, `status`, etc.) → validator exits 1 with the field listed.
- `status: "FAIL"` or `"ESCALATE"` → validator exits 2 or 3; `next` reports `fix-and-retry` or `resolve-escalation`.
- Bypassed escalation: an older gate has `status: ESCALATE` that is still unresolved → validator exits 3 with `BYPASSED ESCALATION`.

### Hooks didn't fire (Claude Code)

The hooks are wired via `.claude/settings.local.json`. Verify:

```bash
cat .claude/settings.local.json | jq .hooks
```

If the file is missing or doesn't have the expected blocks (Stop, SubagentStop, PostToolUse, PreToolUse), re-run `devteam init --host claude-code --force` to overwrite.

**`.gitignore` note:** `settings.local.json` hook commands use `devteam hook <name>` and are fully portable — they resolve via the installed `devteam` binary at runtime, not via a path baked in at init time. The file is safe to commit or omit from `.gitignore`. If you have an older project whose `settings.local.json` contains absolute paths (e.g. `node "/abs/path/core/gates/validator.js"`), re-run `devteam init --host claude-code --force` to regenerate it with the portable form.

### A multi-role stage workstream is stuck

`devteam next` says `continue-stage` with the same role listed in `remaining` over and over. Either:

- The user / subagent hasn't actually run that role's workstream yet. Invoke the relevant subagent.
- The workstream wrote its gate to the wrong filename. Expected: `pipeline/gates/<stage>.<role>.json` (dot separator). Check for stray `.<role>-` (hyphen) or absent `.json` extension.

### Secret scanner blocked my write

```
[secret-scan] BLOCKED — found AWS access key in src/lib/aws-client.js
  Suggestion: remove the literal, read from process.env, or .env (gitignored)
```

The PreToolUse hook caught a credential pattern. Three options:

- **Recommended:** remove the literal, source from env.
- **False positive on a test fixture:** add the marker `devteam-allow-secret: <reason>` on the line above. The hook respects this magic comment.
- **The file lives in a known-safe path** (e.g. `.env.example`, `docs/`, `examples/`, tests): the path allowlist should already cover this. If not, add to `DEVTEAM_SECRET_SCAN_ALLOW` env var.

### Memory commands say "embedder not installed"

```
@huggingface/transformers not installed.
```

Run `npm install` in the Stagecraft framework directory. If you're on CI or in a constrained environment, set `DEVTEAM_EMBEDDING_PROVIDER=stub` to bypass the local model (stub vectors are useless for real retrieval but unblock tests).

### UI won't start — `EADDRINUSE`

Another process is holding the port (likely a previous `devteam ui` invocation you forgot to close). Either kill the old process or pass `--port <something-else>`.

## Customizing for your project

### Routing

Edit `.devteam/config.yml`. Routing precedence is `stages > roles > default_host`.

### Track

Edit `pipeline.default_track` in `.devteam/config.yml`. See [`docs/tracks.md`](tracks.md) for what each track skips.

### Skipping specific stages

If a stage is consistently slow, not relevant to your project type, or you want to defer it, add it to `pipeline.skip_stages` in `.devteam/config.yml`:

```yaml
pipeline:
  default_track: full
  skip_stages:
    - red-team
```

Skipped stages are silently passed over by `devteam next` and shown as `skipped (pipeline.skip_stages)` in `devteam summary`. During `devteam run`, each configured, conditional, or deterministic right-sized skip is recorded once in `pipeline/run-log.jsonl` as `skip-stage` with the trigger inputs that caused the skip. No gate file is required. The configured skip applies to all runs in the project. Use `--track` for per-run exclusions instead.

To temporarily override either `skip_stages` or a conditional skip, list the stage under `pipeline.force_stages`:

```yaml
pipeline:
  skip_stages:
    - red-team
  force_stages:
    - red-team
```

Note that `skip_stages` and `force_stages` accept stage names (e.g. `red-team`, `verification-beyond-tests`), not stage IDs (e.g. `stage-04c`). Run `devteam stages` to see valid names.

Deterministic right-sizing is enabled by default. It skips stages only when the orchestrator can prove no trigger exists from changed files or brief/design context, such as no UI signal for `accessibility-audit` or no observability signal for `observability-gate`. Disable it globally with:

```yaml
pipeline:
  right_sizing: false
```

### Verification commands

Without configuration, orchestrator verification runs every detected Node, pytest, and
Go test suite. Use an exclusive command when the project has a different runner or a
single monorepo entry point:

```yaml
pipeline:
  verify:
    lint_command: "npm run lint"
    test_command: "make test"  # replaces automatic Node/pytest/Go discovery
    test_concurrency: 2        # use 1 for fragile suites; maximum is 8
    receipts: true             # set false to force fresh execution every stamp
```

Set either value to `null` to disable that check explicitly. See
[`docs/TESTING.md`](TESTING.md#target-project-test-discovery) for discovery signals and
the stamped aggregate result.

Successful orchestrator-run verification commands mint content-addressed receipts under
the active pipeline root. A later stamp reuses a receipt only when the command, suite,
verification purpose, workspace bytes, verify config, material env/toolchain data, and
Stagecraft verifier version all match. Failed results are never reused; uncertain
receipt lookup falls back to rerunning.

For multiple custom suites without a single monorepo command, omit `test_command` and
use `test_suites`. Suites sharing a `resource_group` never overlap, while unrelated
suites can still run up to `test_concurrency`:

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

### Controlling token cost

Three factors you control drive most of the token cost per stage:

**1. `pipeline/context.md` size.** This file is in the `readFirst` list for almost every stage. Every question, answer, and concern you append accumulates. On a long project it can exceed 200 lines and add thousands of tokens across a full run. Run `devteam compact` to strip all machine-written marker sections at once, then prune any remaining human-authored stale content before starting a new feature. `pipeline.context_budget_bytes` (default 8 KB) gives you automatic *partial* relief in between manual compacts: once a resolved section (right-sizing, deploy-target, red-team-blockers, qa-build-blockers) pushes the file over budget, it's compacted in place to a one-line digest pointing at the full text under `pipeline/context-archive/` — see the FAQ's [context.md growth entry](faq.md#pipelinecontextmd-keeps-growing--is-that-a-problem) for what is and isn't covered. Every rendered prompt also gets a "Context changes since your last dispatch" section so a retried workstream can see what changed without re-reading the whole file.

What to keep vs. cut:

| Content | Action |
|---|---|
| Binding constraints (env vars, API endpoints, auth conventions) | **Keep always** |
| Active `<!-- devteam:run-blockers -->` injection | **Keep** until resolved |
| Stage-04 assumption blocks | **Cut** once build is done — code is the source of truth now |
| Resolved ruling text | **Compress to one line** |
| Gate outcome summaries | **One-liner** if useful for regression context; cut the rest |
| Answered `QUESTION:` / `PM-ANSWER:` pairs | **Cut** |

Note: track restarts don't reset `context.md`. Running `--track quick` on top of a completed full-track run reads the same file in full. Run `devteam compact` then prune any remaining human-authored stale content before starting a new feature, or switch to `isolation: bounded` (see below) so each feature gets its own context.

**2. Role routing.** Opus costs ~5× more per token than Sonnet, and Sonnet costs more than Haiku. Route expensive models to roles that require sustained reasoning (Principal and Security); use cheaper models for build workstreams. Use `npm run routing:suggest` to compare first-try pass rate, cost per pass, p95 duration, and retry-adjusted completion time before changing defaults. See [Multi-host setups](#multi-host-setups).

**3. Stage selection.** Stages like `verification-beyond-tests` and `red-team` spawn long-running Opus agents. Use `skip_stages` or `--track quick` to skip them on incremental changes where the risk profile is low.

```yaml
# .devteam/config.yml
pipeline:
  skip_stages:
    - verification-beyond-tests  # skip on UI-only changes
```

### Bounded workspace isolation

Enable bounded workspace mode when:

- **Multiple features are in flight simultaneously** and you need their gates and logs to stay separate, or
- **You're doing sequential feature development** on the same project and don't want stage-04 assumptions, rulings, and blocker injections from one feature to accumulate into the next feature's context.

```yaml
pipeline:
  isolation: bounded
```

With `isolation: bounded`, every run's artifacts (gates, logs, context files) land under `pipeline/changes/<changeId>/` instead of the global `pipeline/`. The `changeId` is derived by slugifying the `--feature` value passed to `devteam stage requirements`. Different features share the same working directory but write to distinct subdirectories, so `devteam next` and `devteam summary` can distinguish them.

The base `pipeline/context.md` still exists and should hold only permanent, project-wide facts (binding constraints, runtime conventions). Each change's `pipeline/changes/<slug>/context.md` starts from those static facts and accumulates only that feature's decisions.

Default is `in-place` (global `pipeline/`). Zero impact on existing setups unless you explicitly set `isolation: bounded`. For projects that started `in-place` and want to switch: prune `pipeline/context.md` to just the permanent static layer first, then flip the flag. Existing gates in `pipeline/gates/` are left untouched.

### `/goal` injection for convergent stages

Hosts that declare `goalLoop: true` (claude-code and codex) automatically receive a `/goal "<condition>"` prepended to the prompt when running headless for build (stage-04) and qa (stage-06) stages. The condition is a workstream-specific exit criterion so the host can loop internally until its objective is met rather than running a fixed number of turns.

This is automatic with no config required. It fires when:
- The stage has a `goalCondition` in `stages.js` (currently build and qa)
- The routed host declares `capabilities.goalLoop: true`
- The workstream runs headless (`--headless`)

Antigravity, Gemini CLI, Omnigent, openai-compat, and the generic adapter do not declare `goalLoop: true` and are unaffected. Interactive (non-headless) runs also skip the `/goal` prepend.

### Stoplist

`core/guards/stoplist.js` has the patterns. Adding project-specific stoplist phrases is not yet a first-class config option (flagged in the BACKLOG). For now, edit the file directly. Changes survive `devteam init` because the file lives in the framework, not in the target project.

### Adding a project-specific role / stage / skill

See [`CONTRIBUTING.md`](../CONTRIBUTING.md) recipes 2–4. These changes go in the framework repo, not the target project.

### Custom deploy adapter

Add `core/deploy/<your-adapter>.md` with the procedure. Reference it from `.devteam/config.yml`:

```yaml
deploy:
  adapter: my-adapter
```

The Platform role at Stage 8 reads `.devteam/config.yml`'s `deploy.adapter` and follows your adapter's procedure.

## Upgrading

Stagecraft versions are tracked in `package.json#version`. Upgrade by pulling the latest framework and re-running init in each target project:

```bash
cd /path/to/stagecraft
git pull && npm install

cd ~/projects/my-app
devteam init --host claude-code --force   # re-render install with new versions
```

The `--force` flag overwrites the installed files. `.devteam/config.yml` is preserved by default. Omit `--force` to update only agents, rules, and skills while keeping your config; include it to regenerate the config as well.

Custom edits to the target's installed files (`.claude/agents/`, `.devteam/rules/`, etc.) are lost on re-install. This is intentional. **Customize in the framework**, not in target copies. See `CONTRIBUTING.md` for the right place to put each kind of change.

## What's not covered here

- [Dogfooding guide](guides/dogfooding.md) — running Stagecraft against its own source tree.
- The host-adapter contract — [`core/adapters/host-adapter.md`](../core/adapters/host-adapter.md).
- 11 locked design decisions — [`ARCHITECTURE.md`](../ARCHITECTURE.md).
- Backlog of next ideas — [`docs/BACKLOG.md`](BACKLOG.md).
- Test strategy and what's covered — [`docs/TESTING.md`](TESTING.md).
- A stress-test of the multi-workstream contract — [`docs/walkthroughs/stage-04-split-host.md`](walkthroughs/stage-04-split-host.md).
- A full 18-stage showcase (SOC 2 evidence collector) — [`docs/walkthroughs/soc2-evidence-collector.md`](walkthroughs/soc2-evidence-collector.md).
- The pitch deck — [`docs/presentation-notes.md`](presentation-notes.md).
- Adoption case + objections — [`docs/adoption-guide.md`](adoption-guide.md).
- Common operational questions — [`docs/faq.md`](faq.md).
