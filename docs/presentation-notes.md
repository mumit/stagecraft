# Presentation speaker notes

Speaker notes for a 30-60 minute talk on Stagecraft. 13 slides. Each section has the slide content and what to say.

Adjust depth to your audience and how much demo time you take. Timing table at the bottom.

---

## Slide 1: Title

```
        Stagecraft

        An AI dev pipeline. Multi-host, gate-enforced, on disk.

        <your name>
        <date>
```

**Speaker notes.**

Open with the frustration that motivates the project:

> "Most AI coding tools give you a chat log. You're three hours in, you don't have a brief, a design, or tests. Just a transcript. Stagecraft is a side project that asks what happens if you run an AI coding tool through an actual software dev process instead."

Keep it short. The demo is more interesting than the intro.

**Transition.** Let me name the problem before showing the answer.

---

## Slide 2: The problem

```
  When an AI coding tool runs unsupervised on non-trivial work:

  * Context drifts.            The model forgets your architecture mid-session.
  * Scope drifts.              "Quick fix" turns into 600 changed lines.
  * Review is unstructured.    Approvals live in chat, not on disk.
  * Tests follow the code.     Acceptance criteria, if any, are an afterthought.
  * There is no audit trail.   Six months later, you can't reconstruct what shipped.

  None of these are model problems. They're orchestration problems.
```

**Speaker notes.**

Read the bullets briefly. Land on the last line:

> "None of these are model problems. Claude is fine. Codex is fine. Gemini is fine. The gap is between the model and the codebase. We've built structure for human teams (PRs, code review, CI, design docs, runbooks). We have very little of it for AI work."

**Transition.** Here's the shape of an answer in one diagram.

---

## Slide 3: Before and after

```
  BEFORE                                       AFTER (Stagecraft)
  ────────────────────────────────             ──────────────────────────────────────
  one chat log per feature                     18 staged artifacts + gates per feature
  approvals in messages                        approvals in pipeline/gates/stage-05.json
  scope = "what the agent did"                 scope = pipeline/brief.md, version-controlled
  review = "looks good"                        review = REVIEW: APPROVED / CHANGES REQUESTED
  tests written if remembered                  tests gated: 1:1 criterion-to-test mapping
  one model end-to-end                         different model per role, by config
  audit = scrollback search                    audit = `cat pipeline/gates/*.json`
```

**Speaker notes.**

Walk the rows. Spend a bit more time on three:

1. **Different model per role, by config.** "Claude is good at design. Codex is fast at backend. You can route different roles to different models in the same run. The contract between them is JSON, not a model API."

2. **Approvals in stage-05.json.** Pull up a real gate JSON for a few seconds. Point at the `workstreams: [{ role, host, status, ... }]` array.

3. **1:1 criterion-to-test mapping.** "Stage 6's gate requires `all_acceptance_criteria_met: true` and a 1:1 mapping. The validator rejects gates that claim PASS without it."

**Transition.** Here's what one of those gates actually looks like.

---

## Slide 4: What a gate looks like

```json
{
  "stage": "stage-04",
  "status": "PASS",
  "orchestrator": "devteam@0.4.0",
  "track": "full",
  "timestamp": "2026-05-28T14:32:11Z",
  "blockers": [],
  "warnings": [],
  "workstreams": [
    { "workstream": "backend",  "host": "codex",       "status": "PASS" },
    { "workstream": "frontend", "host": "claude-code", "status": "PASS" },
    { "workstream": "platform", "host": "claude-code", "status": "WARN", "warnings": ["runbook references stale endpoint"] },
    { "workstream": "qa",       "host": "claude-code", "status": "PASS" }
  ]
}
```

**Speaker notes.**

Don't read the JSON. Point at three regions:

> "Top: every gate carries the same identity. stage, status, orchestrator version, track, timestamp. Audit a deploy six months from now and you know which version of the framework produced the artifact."

> "Middle: blockers and warnings. If status is FAIL, blockers tell you what's wrong. The validator enforces that a FAIL gate must have at least one blocker."

> "Bottom: workstreams. Build is a multi-role stage with four workstreams. Backend ran on Codex, the others on Claude Code. Each wrote its own gate; the orchestrator merged them. Aggregate status is pessimistic: any FAIL gives merged FAIL, any WARN gives merged WARN, only all-PASS gives PASS."

> "The orchestrator never stores state outside these files. The pipeline is reconstructable from `pipeline/gates/` alone."

**Transition.** Here's the whole pipeline.

---

## Slide 5: The 18-stage pipeline

```
  full track:

  01.  requirements        PM writes brief.md (numbered acceptance criteria)
  02.  design              Principal writes design-spec.md + ADRs
  03.  clarification       PM resolves open questions
  03b. executable-spec     PM translates AC-N into Gherkin scenarios
  04.  build               Backend | Frontend | Platform | QA (4 workstreams)
  04a. pre-review          Platform runs lint / tests / dep review / security heuristic
  04b. security            (conditional) Security reviews flagged paths. Veto.
  04c. red-team            Adversarial review. Always-on for full + hotfix.
  04d. migration-safety    (conditional) Data-layer changes. Veto.
  05.  peer-review         Reviewer × 4 areas (auto-derived from REVIEW: markers)
  06.  qa                  QA runs tests; 1:1 criterion-to-test mapping required
  06b. accessibility       QA audits WCAG (axe-core / pa11y / lighthouse)
  06c. observability       Platform verifies brief signals are emitted
  06d. verification        Property-based / mutation / formal verification
  06e. performance-budget  Lighthouse / k6 budget gate (conditional on UI/load changes)
  07.  sign-off            PM + Platform; auto-fold from stage-06 if criteria met
  08.  deploy              Platform follows core/deploy/<adapter>.md
  09.  retrospective       Principal harvests lessons; promotes to lessons-learned.md
```

**Speaker notes.**

Don't explain every stage. Cover three properties of the whole:

1. **Some stages are multi-role.** Build has 4 workstreams. Peer-review has 4. These produce per-workstream gates that get merged.

2. **Some stages are conditional.** Security (4b) fires on the security heuristic. Migration-safety (4d) fires on data-layer diffs. Either can set `veto: true` which halts the pipeline regardless of peer-review approval.

3. **Some stages auto-complete.** Stage 7 (PM sign-off) auto-folds if Stage 6 reports `all_acceptance_criteria_met: true` and a 1:1 mapping. No human action.

> "The pipeline isn't a single linear thing. It's a graph with merges, conditionals, and short-circuits. The orchestrator's job is to walk it. Your job is to make decisions at the gates."

**Transition.** Let's talk about those decisions.

---

## Slide 6: Your three moments of control

```
  As a human in the loop, you decide at three places:

  1. AT THE START          You pick the track and write one paragraph.
                           `devteam stage requirements --feature "..."`

  2. AT EVERY GATE         You read the gate. PASS → next. FAIL → fix. ESCALATE → decide.
                           `devteam next`

  3. AT ESCALATIONS        When the pipeline halts, you make the call.
                           Resolve the gate or stop the pipeline.

  Everything else is the framework's job, not yours.
```

**Speaker notes.**

> "Active engagement on a full pipeline run is usually 5 to 10 minutes of decisions over a 30 to 60 minute wall-clock. You don't write boilerplate, shuffle files between agents, track who reviewed what, or compute aggregate status. You decide what to build, whether each gate is good enough, and what to do when the pipeline halts."

**Transition.** Here's the technical contract that makes multi-host work.

---

## Slide 7: Model-agnostic by design

```
   You in any AI tool (Claude Code, Codex, Gemini CLI, plain terminal)
            │
            ▼
   Host adapter (hosts/<host>/adapter.js)
     * declares capabilities (hooks, subagents, headless, ...)
     * renders stage prompt
     * installs surface into your project
            │
            ▼
   Core (model-agnostic spine, never invokes a model)
     * 18 stages, 9 tracks
     * gate schemas + validator
     * routing + orchestrator
            │
            ▼
   Stage prompt rendered for THIS host
            │
            ▼  ← model produces:
   * the artifact (brief, design, code, ...)
   * a gate JSON conforming to the stage's schema
            │
            ▼
   Core validates, advances, escalates, or halts.
```

**Speaker notes.**

> "Read this top to bottom. The core never invokes a model. That's a hard rule. The orchestrator emits prompts and validates JSON. Everything model-specific lives in the host adapter."

> "Adding a new host (Cursor, Aider, Cline) is implementing five methods against a 150-line contract. Not a fork, not a rewrite. A directory under `hosts/`."

> "Inside one run, you can mix hosts. The routing config says 'backend on Codex, frontend on Claude, QA on Gemini, review back on Claude.' Each workstream writes its own gate; the orchestrator merges across hosts through the same JSON contract."

**Transition.** Here's how that routing looks in config.

---

## Slide 8: Routing in 12 lines of YAML

```yaml
# .devteam/config.yml

routing:
  default_host: claude-code        # default for any workstream
  roles:
    backend: codex                  # backend → Codex
    qa: gemini-cli                  # QA → Gemini
  stages:
    stage-08: claude-code           # deploy always on claude-code
  review_fanout: []                 # optional N×M peer review across hosts

pipeline:
  default_track: full
```

**Speaker notes.**

> "Precedence: stages > roles > default_host. Most specific wins. The deploy override on stage-08 says 'no matter who the role is, run deploy on Claude Code', which you want if your runbook has Claude-specific instructions."

> "`review_fanout` is the multi-model peer-review option. Set it to a list of three hosts and Stage 5 duplicates across all of them. Four areas times three hosts gives twelve parallel reviews. Different models tend to flag different things. Method diversity — a separate role applying a different methodology — is what stage-04c red-team is for; this is the execution-diversity counterpart."

> "Default is empty. You don't pay the 3× cost unless you ask for it."

**Transition.** Day one.

---

## Slide 9: Install and first run

```bash
# 1. Install the framework (one time, anywhere)
git clone <repo> /path/to/stagecraft && cd $_ && npm install && npm link

# 2. Initialize your target project
cd ~/projects/my-app
devteam init --host claude-code

# Lays down:
#   .devteam/config.yml          ← routing + track defaults
#   .devteam/rules/*.md          ← pipeline rules (10 docs)
#   .claude/agents/*.md          ← 12 role subagents
#   .claude/skills/*/SKILL.md    ← 13 task helpers
#   .claude/commands/            ← /devteam, /audit, /audit-quick
#   .claude/settings.local.json  ← Stop / SubagentStop / PostToolUse / PreToolUse hooks
#   pipeline/gates/              ← empty workspace

# 3. Verify
devteam doctor                    # → ✅ everything looks good

# 4. Run
devteam stage requirements --feature "Add SMS notification opt-in"
```

**Speaker notes.**

> "Install takes about two minutes. `devteam init --force` re-renders the install with the latest framework version. That's how you upgrade."

> "The framework lives separately from your project. One git clone can drive any number of target projects. Customize in the framework, not in the targets, so upgrades survive."

> "Install footprint: templates, role briefs, rules, a small hooks config. No binaries, no services, no background processes. Hooks fire only when Claude Code is running."

**Transition.** One stage in action.

---

## Slide 10: A stage in action

```
$ devteam stage build --feature "Add SMS opt-in"

═══════════════════════════════════════════════════════════════════════
  Stage stage-04 (build) — 4 workstreams to dispatch
═══════════════════════════════════════════════════════════════════════

  The block(s) below are prompts to feed to your model.
  devteam does NOT call a model. It renders the prompt and validates
  the gate JSON the model writes back.

  ...
═══════════════════════════════════════════════════════════════════════

────────  workstream: backend  (host: codex)  ────────
[prompt addressed to the codex backend role]

────────  workstream: frontend  (host: claude-code)  ────────
[prompt addressed to the claude-code frontend subagent]

[... two more workstreams ...]

────────  end of stage-04 (4 workstreams)  ────────
```

**Speaker notes.**

> "The framework renders prompts. You feed them to your model. Three options: paste into Claude Code, use the `/devteam` slash command that init laid down, or add `--headless` and the framework pipes them to `claude --print` and `codex exec --sandbox workspace-write` for you."

> "Each workstream writes its own gate JSON when it finishes. The Claude Code hook validates each one as it's written. After all four land, `devteam merge build` aggregates. Then `devteam next` tells you what's next."

If demoing live, pause here and run the command. If slides-only, show a screenshot.

**Transition.** Once gates start landing, you want a way to see the state.

---

## Slide 11: The web UI

```
  $ devteam ui --open

  [Screenshot: stage list with per-workstream status icons,
   colored bars, click-to-open gate detail, live updates via SSE.]
```

**Speaker notes.**

> "Local web UI. Single-page, vanilla HTML, no build step, no external services. Loopback only by default. The bind guard refuses non-loopback unless you explicitly set an env var."

> "Every stage as a row. Multi-role stages expand to show per-workstream status. Click a row, get the gate JSON, blockers, warnings, workstreams table. The UI watches `pipeline/gates/` via `fs.watch` and pushes updates over Server-Sent Events. Run a stage in one terminal, watch rows light up in the browser."

**Transition.** The value of a pipeline is mostly in what it catches. Let me show you what catches things.

---

## Slide 12: Safety, observability, learning

```
  WHAT CATCHES BUGS BEFORE MERGE
  ──────────────────────────────────────────────────────────────────
  Per-role allowedWrites           backend can't edit src/frontend/*.
                                    Claude Code PreToolUse hook enforces.

  Stoplist                          lighter tracks refuse `auth`, `payments`,
                                    `migrations`, ... without --force.

  Secret scanning                   blocks Write/Edit on AWS / GitHub /
                                    Anthropic / OpenAI / Slack / Stripe creds.

  Security review (conditional)     fires when pre-review flags sensitive paths.
                                    Has veto.

  Red team (always-on full+hotfix)  10 attack surfaces. Concrete reproducers.
                                    Findings block peer-review.

  Migration safety (conditional)    schema changes need a tested rollback.
                                    Has veto.

  Verification beyond tests         property-based / mutation / formal. Full track.
                                    Counterexamples block sign-off.

  Adversarial peer review (opt-in)  fanout across multiple hosts.

  Accessibility audit               0 critical, 0 serious WCAG violations.

  Observability gate                brief signals must be verified in shipped code.

  Spec drift                        AC-N in brief ↔ @AC-N in spec.feature ↔
                                    test row. `devteam spec verify` catches drift.

  OBSERVABILITY OF THE PIPELINE ITSELF
  ──────────────────────────────────────────────────────────────────
  OpenTelemetry tracing             opt-in via OTEL_EXPORTER_OTLP_ENDPOINT.

  Gate-pass-rate dashboards         npm run dashboard. Per-stage / per-host /
                                    per-role pass rates. Time-windowed.

  Cost telemetry                    tokens, $, duration per workstream.
                                    Roll up by host / role / stage.

  LEARNING (uses your own data)
  ──────────────────────────────────────────────────────────────────
  Routing suggestions               first-try pass rate × cost per (role, host)
                                    pair. `npm run routing:suggest` proposes swaps.

  Project + org memory              semantic index of briefs, designs, ADRs.
                                    Architect queries prior ADRs before designing.

  Reproducibility + replay          gates record model + temp + seed + prompt hash.
                                    `devteam replay <stage>` re-runs and diffs.
```

**Speaker notes.**

Don't read every row. Pick three to land:

> "Stoplist. Phrases like `auth`, `payments`, `migrations`, `pii` block the lighter tracks. You cannot run `nano` on a change that mentions `add auth middleware`. The framework refuses. You'd have to pass `--force`. Serious changes get serious process."

> "Veto stages. Security and migration-safety both have veto power. A migration without a tested rollback halts the pipeline regardless of any other approval. Peer-review consensus cannot override."

> "Routing learns from your data. The framework records cost and first-try pass rate per (role, host) pair. `npm run routing:suggest` reads that history, compares it against your config, and proposes swaps. It's honest about insufficient data; minimum dispatch threshold by default."

**Transition.** Wrapping up.

---

## Slide 13: Getting started

```
   1. Install:        git clone <repo>; cd $_; npm install && npm link
   2. Try:            cd /tmp/scratch; devteam init --host claude-code
   3. Read:           EXAMPLE.md (one full pipeline run, end to end)
   4. Pilot:          two-week pilot script in docs/adoption-guide.md
   5. Adopt:          land devteam init in your project bootstrap

   Docs:              README.md → docs/concepts.md → docs/user-guide.md
   Source:            <repo URL>
   Issues / PRs:      <repo URL>/issues

   Add a new host:    CONTRIBUTING.md recipe 1 (~200 lines, half a day).
```

**Speaker notes.**

> "If you want to try it: install in a throwaway directory, read EXAMPLE.md, run one pipeline. Half an hour."

> "If you want to think about it: the adoption guide is honest about when this is the wrong tool. Small teams doing exploratory work, AI-for-completions only, no notion of role-owned code regions: all bad fits."

> "PRs welcome. The framework is MIT. The backlog has prioritized next ideas. Pick something."

Pause for questions.

---

## Q&A primers

Common questions and short answers.

**Q: How does this compare to LangGraph / CrewAI / AutoGen?**
> Different problem space. Those are agent-framework libraries; you write Python and they coordinate LLM calls. Stagecraft is a pipeline scaffold for AI coding tools. Model invocation happens inside Claude / Codex / Gemini / Omnigent, or through the `openai-compat` HTTP adapter. If your team already lives in those tools, Stagecraft meets you there.

**Q: What if my LLM doesn't follow the rules?**
> Role briefs are instructions, not enforcement, except where hooks enforce. The Claude Code hooks enforce `allowedWrites` at tool-call time: if backend tries to write `src/frontend/*`, the write is rejected. For things that aren't hook-enforceable, the gate validator catches them post-hoc. A FAIL gate halts the pipeline.

**Q: Cost. Adversarial review sounds expensive.**
> Default config is one host per pipeline. Fanout is opt-in. You usually want to route the bulk of work to cheaper models and reserve expensive ones for Principal and Security. The routing-suggest command uses real data from your runs to recommend swaps.

**Q: What if the framework changes break our installed projects?**
> Framework version is in `package.json`. `devteam init --force` re-renders the install. Risk: framework changes a role brief in a way that conflicts with project-specific customization, and you lose the customization. Mitigation: customize in the framework, not in target copies.

**Q: Can I add Cursor / Aider / Cline / Windsurf?**
> Yes. Each is a host adapter, ~200 lines. Implement 5 methods against the contract in `core/adapters/host-adapter.md`. CONTRIBUTING.md has the recipe. The Gemini CLI adapter is a good template for IDE-embedded tools.

**Q: Is "reproducible LLM run" actually a thing?**
> Partially. The gate records `model_version`, `temperature`, `seed`, `max_tokens`, `system_prompt_hash`, `tools_hash`. That's enough for an audit trail (what produced this artifact) and for drift detection (would the same prompt render today). It is not enough for bit-for-bit reproduction; LLM determinism doesn't fully exist yet. The docs are explicit about this.

---

## Timing reference

| Section | Slides | Minimum | Comfortable | With demo |
|---|---|---|---|---|
| Hook + problem | 1, 2 | 3 min | 5 min | 5 min |
| Before/after + gate JSON | 3, 4 | 5 min | 7 min | 8 min |
| Pipeline + control | 5, 6 | 5 min | 7 min | 7 min |
| Multi-host | 7, 8 | 5 min | 7 min | 10 min |
| Install + first run | 9 | 2 min | 4 min | 6 min |
| Stage in action | 10 | 3 min | 5 min | 10 min |
| UI + safety | 11, 12 | 4 min | 6 min | 8 min |
| Close + Q&A | 13 | 3 min | 5 min | 5 min |
| **Total (no Q&A)** | | **30 min** | **46 min** | **59 min** |

For 30 minutes: skip slides 8 and 11. Trim slide 12 to one bullet per category.
For 60 minutes plus Q&A: budget 45 min of talk, 15 min of questions.
For 90 minutes: do the slides, then live-run the EXAMPLE.md walkthrough.

## What to bring

* Laptop with `devteam` installed and a target project ready.
* A real gate JSON file open in an editor for Slide 4.
* The web UI loaded at `devteam ui --open` for Slide 11.
