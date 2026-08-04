# Adoption guide

For team leads deciding whether to introduce Stagecraft to their team. This is not a how-to (see [`user-guide.md`](user-guide.md)) but a guide to whether adoption makes sense and how to land it.

If you're an individual engineer evaluating the tool, start with the [README's First 30 minutes](../README.md#first-30-minutes). This page addresses the question of team-wide adoption.

- [When this is the right tool](#when-this-is-the-right-tool)
- [What you get](#what-you-get)
- [What it costs](#what-it-costs)
- [How to pilot](#how-to-pilot)
- [How to land it broadly (post-pilot)](#how-to-land-it-broadly-post-pilot)
- [Common objections and responses](#common-objections-and-responses)
- [What success looks like](#what-success-looks-like)
- [When to walk away](#when-to-walk-away)
- [Where to start](#where-to-start)

## When this is the right tool

You're a good fit if **most** of these are true:

- **Your team uses an AI coding tool for non-trivial work.** Features, refactors, migrations: not just one-off completions. If you use Claude / Codex / Gemini only for autocomplete-style inline suggestions, the orchestration overhead does not pay off.

- **You want a record of what an AI did and why.** Who approved. What was reviewed. What tests covered which acceptance criterion. Auditable on disk, not buried in a chat log. This is the value that compounds over months.

- **You routinely have changes that touch multiple areas** (backend + frontend + infra) and want a structured handoff between them. Single-area changes can absolutely use Stagecraft, but the multi-workstream design earns its keep on cross-cutting work.

- **You have engineers reviewing AI output, not blind-merging.** And you want their reviews structured (per-area, with verdicts the system tracks). Stagecraft formalizes review; if review is already a real practice on your team, this fits cleanly.

- **Compliance or regulatory pressure means you need to show *how* a change was developed**, not just *what* changed. This is what the `full` track is for: the **audited** path, chosen when stakes justify the ceremony, producing an audit trail by construction — brief, design, code, reviews, red-team, tests, deploy log, and retrospective, all version-controlled. (Roadmap: Phase 34 aims to extend this into exportable, regulator-shaped attestations — not yet built.)

- **Multiple AI tools live on your team.** Some folks prefer Claude Code, others Codex, some Gemini CLI. Stagecraft is one pipeline that meets them where they are. If you've standardized on one tool and don't see that changing, you can still benefit, but the multi-host story is less of a draw.

You're a poor fit if **any** of these are true:

- **The team is one or two people doing exploratory work** and a pipeline would slow you down. The friction-to-value ratio inverts at small scale.

- **You're using AI mostly for inline completions or quick fixes.** The orchestration overhead is wrong-sized for that work. Use `nano` track for one-line fixes if needed, but the pipeline is not the right tool for that class of change.

- **You don't have a strong distinction between "the work" and "verification of the work."** Stagecraft's value is in gates between roles; if your team works in undifferentiated flow, the gates are friction without payoff.

- **Your codebase is unstructured enough that "files this role can write" is unanswerable.** The per-role `allowedWrites` story assumes there's *some* notion of "backend code" vs "frontend code." If your codebase is a single grab-bag, you'll have to think about that before adopting.

- **Your team treats AI output as a fait accompli** ("Claude said do it, so we do it"). Stagecraft assumes humans-in-the-loop at gates. If your culture is "ship whatever the AI produces," the gates feel like obstruction.

## What you get

After adoption (typically 2–4 weeks in):

- **A consistent pipeline every change runs through** (modulo track choice). New team members onboard to the pipeline, not to one person's idiosyncratic workflow. Review feedback is encoded in role briefs and gate schemas rather than repeated verbally.

- **Audit trail per change.** Brief, design spec, code, reviews, test report, deploy log, retrospective. All on disk, all version-controlled, all queryable. When an incident surfaces months later, the rationale behind the change is recoverable.

- **Pre-merge guardrails.** Stoplist blocks dangerous changes from running on lighter tracks. Security review fires conditionally when the diff touches auth / PII / crypto / etc. Allowed-writes enforcement (on hosts that support it) prevents agents from editing files they shouldn't. Secret scanner blocks credentials in code at write time.

- **Multi-host flexibility.** Same pipeline, different models per role. Run all on one host by default, or route different roles to different models (PM on Opus, backend on Codex, QA on Haiku) to optimize cost and quality.

- **Retrospective learning.** Lessons flow into `pipeline/lessons-learned.md`, get reinforced when patterns recur, age out if unused. Patterns from peer review get promoted by the Principal at Stage 9. Future runs benefit from past ones in a structured way.

- **Adversarial peer review (opt-in).** Run Stage 5 across multiple hosts. Different models catch different bugs. Cost is N× peer-review time and money; benefit is real bug catches that any single model misses.

## What it costs

Real costs to budget for:

- **One-time setup per project: ~5 minutes** (`devteam init`). Then ~15–30 minutes to skim the rules docs and adjust `.devteam/config.yml`. The config decisions you'll make: default track, routing per role, deploy adapter, optional review-fanout list.

- **Per-stage overhead: ~30 seconds of orchestration time** (CLI invocations, gate validation, hook execution). Negligible vs the LLM's wall-clock (which is typically minutes per stage on real work).

- **Learning curve: ~2 hours** for an experienced engineer to understand the pipeline, gates, hooks, tracks. Less if they've used `claude-dev-team` or `codex-dev-team` (Stagecraft's predecessors). Plan for a 30-minute team walkthrough using the [presentation deck](presentation-notes.md).

- **Discipline:** the pipeline is opt-in per change. Engineers will sometimes skip it for quick changes. `nano`, `loop`, and `quick` tracks exist for that purpose — `loop` in particular is the day-to-day default, right-sized for bounded iteration. Consistent bypassing on non-trivial work eliminates the value. This is a culture question, not a tool question.

- **LLM compliance is not guaranteed.** Role briefs are instructions, not enforcement (except where hooks enforce: allowedWrites on Claude Code, secret scanning, gate validation). You will occasionally need to correct an agent that drifted outside its scope. This is less common as role briefs mature and more common in the first weeks.

- **Multi-host costs.** If you opt into multi-host or review fanout, you're paying for N× LLM calls at peer-review time. Review fanout is the single largest cost driver when enabled. Most teams run single-host for steady state and turn on fanout for high-risk changes.

## How to pilot

A 2-week pilot answers most adoption questions at low cost.

### Week 1: setup and shadow run

1. **Pick a pilot project.** Active development, multiple contributors, a couple of features in flight. Avoid greenfield projects (the pipeline's value compounds with team size and change history). Avoid projects mid-release crunch: adoption requires a stable baseline.

2. **Install in the pilot project.** `devteam init --host claude-code` (or your team's host of choice). Verify with `devteam doctor` — should be all green.

3. **Adjust the config.** Routing, default track, deploy adapter. ~15 minutes. Make these decisions explicit so the team isn't relitigating them per change.

4. **Seed project context.** Before the first pipeline run, write the project's static facts into `pipeline/context.md`. This is a one-time step, not per-feature — it covers things all agents should know for every run:

   - **Architecture** — service boundaries, data flow, the key invariants the system maintains
   - **Platform / runtime** — where it deploys (Cloud Run, ECS, Cloudflare Workers), the Node/Python/Go version, any IaC tooling
   - **Locked-in technology choices** — specific env var names, non-default API endpoints, authentication schemes, libraries that are non-negotiable
   - **Compliance / security constraints** — PII handling rules, regulated data boundaries, required encryption standards
   - **Integration points** — internal services, third-party APIs, message queues; include base URLs and auth mechanisms
   - **Team conventions** — naming patterns, test framework, code style constraints the PM or Principal can't infer from the code

   Write this content **above** any `<!-- devteam: -->` marker blocks in the file. Content inside those markers is managed by Stagecraft and will be overwritten on each pipeline run. Anything outside the markers is yours and is preserved.

   A well-seeded context.md for a payments service might start:

   ```markdown
   ## Project context

   **Service:** `payments-api` — Node 20, deployed to Cloud Run (us-central1), backed by Cloud Spanner.
   **Auth:** Internal services use service-account JWT (header: `Authorization: Bearer <token>`). External clients use OAuth 2.0 PKCE via the internal IdP at `https://auth.internal`.
   **Env vars:** `SPANNER_INSTANCE`, `SPANNER_DATABASE`, `PUBSUB_TOPIC` — all injected by Cloud Run; do not hardcode.
   **Constraints:** No PII in logs. All monetary amounts in minor units (integer cents). Idempotency keys required on all write endpoints.
   **Test framework:** Vitest. Integration tests in `tests/integration/` hit a real Spanner emulator — no mocks for database operations.
   ```

   Project context is distinct from per-run binding constraints (a specific API endpoint a single feature must use). For per-run constraints, see [Preserving implementation constraints through the PM layer](faq.md#my---feature-string-specified-implementation-details-env-var-names-a-specific-api-endpoint-but-the-pm-rewrote-them-how-do-i-preserve-them) in the FAQ.

5. **Skim the role briefs.** `roles/*.md`. Each is the source of truth for what that role does, reads, and writes. Adjust ROLE_FRONTMATTER in the host adapter if your team has different model preferences per role.

6. **Run one full pipeline on a small real feature.** It does not need to ship. Note friction points: stages that felt mechanical, gates that fired false-positively, agent behaviors that needed correction. These notes drive Week 2 customization.

### Week 2: real use

7. **Use Stagecraft for every new feature for one week.** Run it even when it feels heavy. Bypassed runs produce no signal. Track:
   - **Time-to-merge before vs after.** Often increases by 10–30% in week one (overhead) and decreases by 20–40% by month two (audit trail prevents re-work).
   - **Number of bugs caught at peer-review or security-review** that would have shipped otherwise. This is the single biggest "is it earning its keep" metric.
   - **Number of times the pipeline blocked something valid** (false-positive stoplist matches, over-strict gate validation). High numbers mean you need to customize.
   - **Engineer sentiment per stage:** one-line "this stage was useful" / "this stage was friction" per stage. Use these for week-3 customization decisions.

8. **Decision.** At end of week 2:
   - **Adopt:** the value showed up. Roll out to the team. Do not roll out before you have evidence; adoption driven by assumption rather than observation rarely holds.
   - **Adapt:** the value is there but the defaults are not right. Identify what to customize (stoplist, role briefs, tracks, routing) before broader rollout.
   - **Drop:** the overhead did not pay off. That is a valid outcome. Recognizing it at week 2 is better than at month 6.

## How to land it broadly (post-pilot)

If you adopt:

1. **Land the install in CI.** Add `devteam init --host <name>` to your project bootstrap script. New devs get the pipeline automatically. `devteam init --force` is idempotent, so running it on every CI bootstrap is safe.

2. **Document the team's track choices.** Make it explicit in your contributing docs: "Use `nano` for typo fixes, `loop` for day-to-day bounded iteration, `quick` for single-area changes needing a brief, `full` (the audited path) for cross-area, regulated, or high-stakes features, `hotfix` for production incidents." Without a written policy, track selection devolves to everyone picking `full` by default, which then becomes everyone picking `nano` because `full` is too heavy — `loop` exists precisely to break that pendulum with a right-sized day-to-day default.

3. **Set up GitHub Actions to validate gates.** A simple PR check: if `pipeline/gates/` exists, validator must pass. Catches missing / malformed gates before merge. The `scripts/pr-publish.js` tool can push gate status as GitHub check runs on the PR head commit (PASS → success, FAIL → failure).

4. **Assign a pipeline champion.** One engineer owns the question of whether the pipeline is working: surfacing friction, landing customizations, running internal training. Without an owner, customizations stall and friction accumulates. Rotate the role quarterly to distribute the load.

5. **Run retrospectives on the pipeline itself.** Monthly: what stages are friction? What's underused? What's our gate-pass-rate? (Use `scripts/dashboard.js` to get per-stage / per-host / per-role pass rates.) These retros are where the pipeline evolves to match your team's actual work.

6. **Wire up observability if you have an OTel collector.** Set `OTEL_EXPORTER_OTLP_ENDPOINT` in your team's standard env. Pipeline spans show up in your existing trace tooling. Useful for debugging stuck pipelines and spotting model latency outliers.

## Common objections and responses

### "We don't want another layer between us and the LLM."

The framework adds ~30 seconds of orchestration per stage. It is not a layer between you and the LLM; it is a layer that tells the LLM what role to play and validates what it produced. The LLM call itself is unchanged.

What changes: the LLM gets a focused prompt with explicit scope, a defined artifact path, and a gate schema to produce. That structure is what makes output predictable and reviewable.

The relevant question is whether the structure produces better output for non-trivial work or just adds ceremony. The pilot is how you find out.

### "Our team is too small for this much process."

Pick a lighter track. `nano` is 3 stages (build + scoped peer-review with 1 reviewer + qa). `loop` is 4 dispatches (brief → build → verify → review) and is the day-to-day default for bounded iteration. `quick` is 9. The pipeline is opt-in; `full` — the audited path — is not required for every change. The track system exists to scale the process to the change.

That said, there is an honest answer. If your team is 1–2 people doing fast-moving exploratory work, Stagecraft is probably the wrong shape. It pays off with multiple people, multiple changes in flight, and a non-trivial codebase. Below that scale, the structure exceeds the need.

### "We already do code review; we don't need Stage 5."

You are already doing it informally. Stage 5 structures it: per-area sections, explicit verdicts (`REVIEW: APPROVED` / `CHANGES REQUESTED`), automatic gate derivation from the markers.

If your team is small enough that informal review works (1–2 people), skip Stage 5 by picking `nano` or `dep-update`. For teams larger than 3, structured review pays off through the audit trail alone: six months later, the question "did anyone actually review this?" has a definitive answer.

The other benefit, often overlooked: multi-model peer review. With `review_fanout` configured, Stage 5 runs across 2–3 different models. Different models catch different bugs. This is not replicable with human review alone, and the cost is wall-clock time and LLM dollars rather than engineering time. For method diversity (a different methodology, not just a different model), that is what stage-04c red-team is for.

### "What if the framework changes break our installed projects?"

The framework version is in `package.json#version`. Re-running `devteam init --force` re-renders the install with the new version. If the new framework changes a role brief in a way that conflicts with project-specific customization, that customization is overwritten.

Mitigations:
- **Customize in the framework**, not in target copies. See `CONTRIBUTING.md` for the correct location for each type of change. This is the most important habit to establish.
- **Version-control the target's `.claude/agents/`** so you can diff after re-install. If you customized something accidentally, you can recover the diff.
- **Pin a framework version** for stability. The framework has tagged releases; you can `git checkout v0.2.0` in your framework dir if you're not ready for newer changes.
- **Fork Stagecraft** if you have substantial team-specific customizations. The framework is MIT; forking is fine, expected, and easier than fighting upstream.

### "We use [other AI tool] that isn't supported."

Adding a host adapter is a self-contained task. See `CONTRIBUTING.md` recipe 1. Implement five methods (`install`, `renderStagePrompt`, `status`, `uninstall`, optional `invoke`) against the contract in `core/adapters/host-adapter.md`. The Gemini CLI adapter (`packages/host-gemini-cli/` — a plugin package since phase 34.4, see that directory's README.md) is a suitable template for IDE-embedded tools; the Codex adapter (`hosts/codex/`) works for prompt-based tools without hooks.

Typical effort: ~200 lines of JavaScript, half a day for someone familiar with the target tool. The `generic` adapter exists as a minimal case (zero in-host integration) to demonstrate the contract is genuinely host-neutral.

### "We don't trust LLM output enough to put it in our codebase."

Any team using Claude Code or Codex is already trusting LLM output. Stagecraft adds structure to how that trust is applied: peer review by other agents or humans, test gates, security gates, sign-off gates. The pipeline does not make the model better; it makes the model's output more reviewable.

If your team is not ready to trust LLM output at all, this tool will not change that. The appropriate use case at that point is AI-assisted autocomplete, not orchestration.

### "What about cost? Multi-model peer review sounds expensive."

The default config is one host per pipeline. Multi-host is opt-in. Review fanout is opt-in on top of that. Neither is enabled by default; you turn them on per project as needed.

Even with multi-host, the cost profile is often favorable: models like Codex and Haiku are 5–10x cheaper than Opus. Routing the bulk of work to cheaper models while reserving Opus for Principal and Security roles is typically a cost reduction, not an increase. The largest cost driver is review fanout (3x peer-review cost across three hosts). Reserve it for high-risk changes and disable it by default.

Cost telemetry per stage is built in (`npm run dashboard:cost`). Adaptive routing reads that telemetry and suggests config changes (`npm run routing:suggest`).

### "What if we want to bypass the pipeline?"

You can. Run `devteam stage <name> --force` to bypass the stoplist. Hand-write a gate JSON with `status: "PASS"` to skip a stage that did not run. The orchestrator does not lock you out; it surfaces friction points and lets you proceed when you choose to.

The pipeline only earns its keep if you use it. A team bypassing 80% of the time is paying setup costs for no value. Track your bypass rate (grep for `--force` invocations or hand-written gates) and treat a high rate as a signal that either the defaults need customization or the tool is wrong for your team.

### "How do we onboard new engineers?"

Three artifacts, in order:
1. **`EXAMPLE.md`**: one full pipeline traced end-to-end. New hire reads this in 15 minutes.
2. **`docs/concepts.md`**: six primitives in a table. Glance before the example, refer back later.
3. **A 30-minute walkthrough** using [`docs/presentation-notes.md`](presentation-notes.md). Run it as part of new-hire onboarding.

For a deeper example, [`docs/walkthroughs/soc2-evidence-collector.md`](walkthroughs/soc2-evidence-collector.md) builds a SOC 2 evidence collector CLI through all 18 stages, including conditional stages (security review, migration safety), multi-model peer review, and property-based testing.

After that, the first real change they ship goes through the pipeline with a buddy. By their third pipeline run, they're independent.

## What success looks like

After 1 month:

- New features routinely go through the pipeline without friction. The pipeline is infrastructure, not a debate.
- The audit trail has been used at least once: to explain a decision to a stakeholder, debug an incident, or onboard a new engineer.
- The team has customized 1–3 things (stoplist additions, a role brief, a custom track, routing) to fit their context.
- Engineer sentiment per stage is mostly positive; the friction points are known and either accepted or scheduled to fix.
- Gate pass-rates across stages are less than 100%, meaning the gates are catching real issues, not rubber-stamping.

After 6 months:

- The pipeline is your team's standard way of working. Bypassing it for a feature is a deliberate choice with a reason, not a default.
- `pipeline/lessons-learned.md` has 20–50 promoted lessons that are actively shaping new work. Unused lessons have aged out.
- You've contributed back to the framework (a stage, a track, an adapter, a role brief, a docs fix).
- You've identified at least one bug class that the pipeline catches systematically (security regressions, missing tests, missing observability) that previously slipped through.

After 12 months:

- A new engineer can join the team and ship their first feature through the pipeline with minimal guidance. The pipeline and audit trail carry what previously required verbal mentoring.
- The framework version is pinned or you have forked it. You have a considered position on upstream changes.
- Pipeline retrospectives are routine. The system is stable, the defaults work, and the customizations are settled.

## When to walk away

Six months in and:

- **Engineers consistently bypass the pipeline** despite training. The value is not landing for them, regardless of theoretical merit.
- **The audit trail is unused.** Nobody refers to past briefs, designs, or reviews. The audit value is not real for your team.
- **Gate pass-rates are above 95% across the board.** The gates are not catching anything; they are rubber-stamping. Either tighten them or accept that the framework is not earning its keep.
- **Lessons-learned is empty or stale.** The retrospective stage is not producing actionable insights. The pipeline runs but does not improve over time.

These are signs the pipeline is not earning its overhead. Drop it, or scope it down (e.g., use only `nano` on routine changes; skip the pipeline entirely for certain change classes). Do not continue paying overhead for value that is not materializing.

The framework being right for some teams does not mean it is right for yours. Walking away is a legitimate outcome.

## Where to start

1. **Read [`README.md`](../README.md)** for the elevator pitch and First 30 minutes path.
2. **Read [`EXAMPLE.md`](../EXAMPLE.md)** for what one run actually looks like.
3. **Run `devteam init` in a throwaway project** and walk through one full pipeline yourself. Half an hour.

If after that hour you can see how it would help your team, run the 2-week pilot. If not, do not adopt it. It is not a tool that benefits every team, and a forced adoption costs more than skipping it.
