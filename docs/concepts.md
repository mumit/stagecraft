# Concepts

Six primitives make up Stagecraft. Every other doc assumes you know these terms.

- [How they compose](#how-they-compose)
- [Rules of thumb](#rules-of-thumb)
- [Secondary vocabulary](#secondary-vocabulary)
- [Tracks at a glance](#tracks-at-a-glance)
- [Files at a glance](#files-at-a-glance)
- [Two distinct workflows](#two-distinct-workflows)
- [What you can stop reading now](#what-you-can-stop-reading-now)

| Concept | Lives in | Set by | What it is |
|---|---|---|---|
| **Stage** | `core/pipeline/stages.js` | The framework | A numbered phase of work (e.g. `stage-01` requirements, `stage-04` build, `stage-09` retrospective). 18 stages total (including sub-stages 3b, 4a/4b/4c/4d/4e, 6b/6c/6d). |
| **Role** | `roles/<role>.md` | The framework + your customizations | A named seat at the team — `pm`, `principal`, `backend`, `frontend`, `platform`, `qa`, `reviewer`, `security`. A role's brief is the source of truth for what it does, reads, and writes. |
| **Workstream** | derived at dispatch time | The orchestrator | One dispatch of a stage to one role. Single-role stages have one workstream; multi-role stages (build, peer-review) have several. **The workstream is the unit of gate identity.** Stage 5 (peer-review) is a special case — see the §stage-05 vocabulary callout below. |
| **Host** | `hosts/<host>/` (first-party) or a `@devteam/host-<name>` plugin package | You choose at `devteam init` | The AI tool that actually runs the model: `claude-code`, `codex`, `antigravity`, or `generic` (no host) ship first-party; `gemini-cli` is a plugin (`packages/host-gemini-cli/`, phase 34.4 — deprecated upstream). |
| **Gate** | `pipeline/gates/<stage>*.json` | The model writes it; the validator enforces it | A JSON record of one workstream's (or stage's) outcome. **The stable contract between stages.** Required fields: `stage`, `status`, `orchestrator`, `track`, `timestamp`, `blockers`, `warnings`. |
| **Track** | `core/pipeline/stages.js` | Your `.devteam/config.yml` (`pipeline.default_track`) | Which stages run for this kind of change. Ten tracks: `full`, `quick`, `nano`, `config-only`, `dep-update`, `hotfix`, `loop`, `review-only`, `review-pr`, `refactor`. Tracks shape *which* stages run; never *what* a stage does. |

The rest of this page builds on these six concepts.

---

## How they compose

A typical `full`-track run touches every primitive:

1. You type **`devteam stage requirements --feature "Add SMS opt-in"`**.
2. The orchestrator decomposes **stage-01** into **one workstream** (single-role) for **role: pm**, looks up the **host** for that workstream in `.devteam/config.yml` (default `claude-code`), and asks the host adapter to render a prompt.
3. The model writes `pipeline/brief.md` (the artifact) and `pipeline/gates/stage-01.json` (the **gate**) with `status: "PASS"`.
4. You run **`devteam next`**. It reads the gate, sees PASS, and reports `▶️ run-stage — design (stage-02)`.
5. Two stages later you hit **stage-04 build**: 4 workstreams (backend / frontend / platform / qa), each potentially dispatched to a different host depending on routing. Each writes its own per-workstream gate (`pipeline/gates/stage-04.backend.json` etc.). `devteam merge build` aggregates them into the stage gate.
6. The **track** you picked (`full`) is what put all 18 stages on the menu. Picking `nano` would skip everything except build + a scoped peer-review (1 reviewer) + qa.

The whole pipeline is reconstructable from `pipeline/gates/`. The orchestrator never holds state outside of those files.

### stage-05 vocabulary callout

At Stage 5 (peer-review), the merged `stage-05.json` gate's `workstreams[]` array means something different from every other multi-role stage. The distinction is a common source of confusion for new stage managers.

At **Stage 4 (build)**, `workstreams[]` are the four **implementers**. Each entry's `status` is the verdict that implementer wrote about *their own* gate (PASS = they finished their slice cleanly, FAIL = they ran into a problem).

At **Stage 5 (peer-review)**, `workstreams[]` are the four **areas of code being reviewed**. Each entry's `status` is the *aggregate verdict on that area's code*, derived from how many non-area reviewers approved it. The corresponding per-area gate (`pipeline/gates/stage-05.<area>.json`) holds the actual `approvals[]` list, `required_approvals` count, and `changes_requested[]` array. The merged gate is just an aggregate; the source of truth is per-area.

| Concept | At Stage 4 | At Stage 5 |
|---|---|---|
| `workstreams[3].workstream: "qa"` | "qa wrote this gate" | "this gate is about the qa *area* of code (`src/tests/`)" |
| `workstreams[3].status: "FAIL"` | "qa ran into a problem" | "the qa area didn't accumulate enough approvals from non-qa reviewers" |
| Per-workstream gate | written by the implementer | written by the `approval-derivation` hook from review-file markers |
| To fix a FAIL | the implementer re-runs | add a `## Review of <area>` section to a non-area reviewer's file |

A practical consequence: a Stage 5 FAIL with no `BLOCKER:` content anywhere and no `REVIEW: CHANGES REQUESTED` markers usually means a missing area review (quorum miss), not a code defect. See [`runbooks/fix-and-retry.md`](runbooks/fix-and-retry.md) §Case 5 for the operational playbook.

## Rules of thumb

- **Adding a new specialist seat at the team?** Add a **role** under `roles/<name>.md`.
- **Adding a new phase of work?** Add a **stage** to `core/pipeline/stages.js`, with a matching schema under `core/gates/schemas/`.
- **Plugging in a new AI tool?** Add a **host adapter** under `hosts/<name>/`, or install one as `@devteam/host-<name>`. The contract is in `core/adapters/host-adapter.md`.
- **Routing a specific role to a specific host?** Edit `routing` in `.devteam/config.yml` (`stages > roles > default_host` — most specific wins).
- **Want a subset of stages for a particular change size?** Pick a **track**, or define a new one in `STAGES_BY_TRACK`.
- **Need to record a non-standard outcome?** Add a field to the stage's schema. The validator enforces required fields; everything else is free-form.

---

## Secondary vocabulary

These come up frequently but build on the primitives above:

### Status & state

- **Gate status** — `PASS`, `WARN`, `FAIL`, or `ESCALATE`. WARN is PASS-with-warnings (non-blocking). ESCALATE halts the pipeline; FAIL retries up to a limit then escalates.
- **Merge** — the orchestrator's post-step on multi-role stages: read all per-workstream gates, aggregate into a stage-level gate. Aggregate status follows `ESCALATE > FAIL > WARN > PASS` (pessimistic).
- **Artifact** — the markdown deliverable a stage produces (`pipeline/brief.md` for stage-01, `pipeline/design-spec.md` for stage-02, …). Distinct from the gate.

### Routing & dispatch

- **Adapter** — the per-host module under `hosts/<host>/`. Implements install, renderStagePrompt, status, uninstall, and (optionally) invoke. The orchestrator never knows host-specific details; the adapter is the only layer that does.
- **Capability** — a flag in `hosts/<host>/capabilities.json` declaring what the host supports: `hooks`, `subagents`, `slashCommands`, `worktrees`, `headless`, plus an `enforces` map saying where each core rule is enforced (`tool-call-time`, `post-hoc-audit`, `prompt-only`). `enforces.tool_budget: "native"` means the host enforces the role's declared tool list at the tool-call boundary (claude-code subagent `tools:` line); `"prompt-only"` means the budget is injected as an advisory prompt instruction only.
- **Tool budget** — the host-neutral per-role set of permitted tools, stored in `core/roles.js`. The orchestrator resolves it before host routing and carries it as `descriptor.toolBudget` through the dispatch pipeline; adapters enforce or render it according to their capabilities. Claude Code's `ROLE_FRONTMATTER` contains only host-specific subagent metadata. The budget is stamped on workstream gates as `dispatched_tool_budget` for audit legibility alongside the existing `tools_hash` (C4 reproducibility).
- **Subagent** — the host-native agent the workstream is dispatched to. Usually `subagent = role` (the backend workstream → the `dev-backend` subagent). Stages can override this (peer-review's `subagent: "reviewer"` sends all four area workstreams to the same reviewer subagent).
- **Stage descriptor** — what the orchestrator hands to an adapter to render a prompt: stage id, role, workstream id, objective, files-to-read, allowed-writes, artifact path, template name, gate skeleton.

### Guards & hooks

- **Stoplist** — phrases (`auth`, `payments`, `migrations`, …) that block lighter tracks from running. Forces serious changes onto `full` or `hotfix`. Bypass with `--force`.
- **Security heuristic** — file-path patterns (`src/backend/auth*`, `*secret*`, `*crypto*`, …) that, when matched, set `security_review_required: true` in pre-review's gate. That value triggers the conditional `stage-04b` security review.
- **Hook** — a Claude Code event handler (`Stop`, `SubagentStop`, `PostToolUse`, `PreToolUse`) wired to a core script. `Stop` runs the validator; `PostToolUse Write|Edit` runs approval-derivation; `PreToolUse Write|Edit` runs secret-scan.
- **Conditional stage** — a stage that only runs when a prerequisite gate's field has a specific value. Declared via `conditionalOn: { stage, field, equals }` in the stage definition. Currently used by security-review (`stage-04b`).

### Special mechanisms

- **Approval-derivation** — Stage 5's mechanism. Reviewers write per-area `REVIEW: APPROVED` / `REVIEW: CHANGES REQUESTED` markers in `pipeline/code-review/by-<reviewer>.md`; a Claude Code `PostToolUse Write|Edit` hook parses them and upserts the per-area workstream gates. The hook fires only on agent-driven writes inside an active host session — shell or editor edits to review files bypass it. Use `devteam derive-approvals [<file>]` to re-run the hook from the shell after hand-editing a review file. You never write Stage 5 gates by hand directly.
- **Auto-fold (Stage 7)** — when Stage 6 reports `all_acceptance_criteria_met: true` AND a 1:1 criterion-to-test mapping, the orchestrator authors Stage 7 sign-off directly with `auto_from_stage_06: true`. No human action.
- **Retrospective synthesis (Stage 9)** — Principal harvests `PATTERN:` lines from Stage 5 reviews, reconciles with `pipeline/lessons-learned.md`, promotes ≤2 rules per retro, retires stale ones via the auto-age-out rule.
- **Multi-model peer review** — opt-in fanout (`routing.review_fanout: [host, host, host]` in config). Stage-05's 4 area workstreams duplicate across N hosts, producing 4×N parallel reviews; pessimistic merge applies across all of them. Reviewers all run the same four-principles rubric. The cross-model signal (different training data, different blind spots) is what the fanout buys. For method diversity (a different role applying a different methodology), see stage-04c red-team.
- **Red team (stage-04c)** — adversarial-by-design role between build (Stage 4) and peer review (Stage 5). Always-on for `full` + `hotfix` tracks. Walks 10 attack surfaces (input boundaries, state, sequence, integrations, auth edges, resource exhaustion, failure modes, abuse cases, downstream effects, observability gaps) and produces concrete reproducers. `must_address_before_peer_review` items block Stage 5 until the implementer addresses them. Distinct from security-engineer (narrower remit, conditional, has veto) and reviewer (general code review). Diversity matters — route to a different host than the build agents. See `skills/red-team/SKILL.md` for methodology.
- **Executable spec (stage-03b)** — closed-loop AC → Scenario → test bridge. PM translates every numbered `AC-N` line in `pipeline/brief.md` into one Gherkin scenario in `pipeline/spec.feature`, tagged `@AC-N`. The gate carries the full `criteria_to_scenario_mapping` array; `devteam spec verify` cross-checks brief.md ↔ spec.feature ↔ test-report.md and exits non-zero on drift (orphan ACs, orphan scenarios, duplicate IDs, unknown AC refs in tests). Runs on `full` + `quick` (tracks with a `requirements` stage to derive ACs from). Skipped on `hotfix`/`nano`/`config-only`/`dep-update`. See `skills/spec-authoring/SKILL.md` for the authoring procedure.
- **Migration safety (stage-04d)** — conditional safety review for data-layer diffs. Fires when stage-04a's heuristic flags schema files, migration directories, or DDL fragments. Walks six questions (what does it do? breaking? backfill required? dual-write required? rollback plan? rollback tested?) and writes a gate covering each. **Has veto power**: an empty rollback plan, an untested rollback on a breaking change, or a missing backfill strategy on a backfill-required migration each auto-veto. Peer-review approvals CANNOT override a veto — the migrations role must personally re-review the fix. See `skills/migration-safety/SKILL.md` for methodology and the auto-veto criteria.
- **Verification beyond tests (stage-06d)** — full-track-only stage that runs AFTER stage-06 (qa) PASS. New `verifier` role applies property-based testing (fast-check / hypothesis / proptest), mutation testing (stryker / mutmut / mull), and/or formal verification (TLA+ / Alloy / Lean) to the changed code. Read-only on production code; writes property tests under `src/tests/property/` and formal specs under `pipeline/formal/`. Gate carries `methods_attempted[]`, `methods_skipped[{method, reason}]`, per-method stats, and `blocking_findings[]` (a counterexample to a stated invariant, a surviving mutant on a critical path, or a formal counterexample to a safety property). Non-empty `blocking_findings` halts sign-off; the implementer addresses, then the stage re-runs. The role brief prohibits fabricating results: if a tool isn't installed, the method is `attempted_but_blocked` with the install hint, not a fabricated score. Since phase-35 item 35.3, `methods_attempted[]` is no longer trusted on the verifier's say-so: `core/verify/stamp.js#stampStage06d` re-runs each claimed method (reusing the 31.4 mutation runner, detecting property-test tooling, checking formal-tool exit codes) and downgrades a claim with no executable evidence to `attempted_but_blocked:<method>`. See `skills/verification-beyond-tests/SKILL.md` for the five-phase procedure and the property-shape vocabulary (round-trip / idempotence / commutativity / monotonicity / invariant preservation / oracle).
- **Persistent memory** — `devteam memory ingest|query` builds a per-project semantic index of briefs, design specs, ADRs, retros, and lessons. Local embedder by default; offline after first download.

---

## Tracks at a glance

Ten tracks control which stages run: `full`, `quick`, `nano`, `config-only`, `dep-update`, `hotfix`, `loop`, `review-only`, `review-pr`, `refactor`. Each is a subset of the full 18-stage pipeline tuned to a change size and risk level. `full` runs everything; `nano` runs just build + a scoped peer-review + qa; `loop` is the smallest build-shaped track — one build workstream + qa + one reviewer, no design or deploy; `review-only` runs no build at all — security-review + red-team + peer-review of code that already exists; `review-pr` is the internal single-stage track `devteam review-pr` dispatches against — a scoped peer-review of one materialized PR, not meant to be picked directly via `--track`; `refactor` is `nano`'s build/peer-review/qa shape with the bar shifted to behavior preservation — a characterization brief before any structural change, no new acceptance criteria, and the 31.4 mutation smoke gate on by default (phase-35 item 35.5).

For the complete per-track stage matrix see **[`docs/tracks.md`](tracks.md)**; for each stage's roles and gate files see **[`docs/reference/stages.md`](reference/stages.md)**.

## Files at a glance

| Path | What lives there |
|---|---|
| `roles/<role>.md` | Single source of truth for what each role does, reads, writes. |
| `rules/<topic>.md` | Pipeline rules — `gates-core.md` (universal gate contract), `pipeline.md`, `escalation.md`, `retrospective.md`, per-stage `stage-NN.md`, etc. |
| `skills/<skill>/SKILL.md` | Task helpers — `implement`, `review-rubric`, `security-checklist`, `accessibility-audit`, `observability-verification`. |
| `templates/<artifact>-template.md` | Artifact templates (brief, design-spec, runbook, retrospective, etc.). See also: per-template *annotation guides* (the "why each section matters" docs) at `docs/brief-template.md`, `docs/design-spec-template.md`, `docs/runbook-template.md` — but **only for the three load-bearing artifacts a human actually reads end-to-end**. The other 9 templates (build, clarification, pr-summary, pre-review, retrospective, review, test-report, adr, audit/) are agent-facing and don't have separate annotation guides; the role brief that produces each template carries the context. This asymmetry is deliberate — annotating every template would produce ~500 lines of mostly-redundant content nobody reads. |
| `hosts/<host>/` | Per-host adapter: `adapter.js`, `capabilities.json`, `install/` payload. |
| `.devteam/config.yml` (in target project) | Routing config + pipeline defaults for that project. |
| `pipeline/gates/<stage>.json` | The merged stage gate. |
| `pipeline/gates/<stage>.<workstream>.json` | A per-workstream gate for a multi-role stage. |
| `pipeline/context.md` | Append-only running notes across stages. |
| `.devteam/memory/` (in target project) | Semantic memory store (opt-in; built by `devteam memory ingest`). |

## Two distinct workflows

Stagecraft does two different kinds of work, with different vocabularies:

1. **Pipeline** — *building* features through 18 staged production steps. The vocabulary above (stage, role, workstream, host, gate, track) applies. Outputs go in `pipeline/`.
2. **Audit** — *analyzing* an existing codebase, read-only, to produce a prioritized improvement roadmap. Different vocabulary (phases, findings, severity, themes, batches). Outputs go in `docs/audit/`.

The pipeline produces new code. The audit produces analysis of code that exists. Don't confuse them. The same role briefs are NOT used — the auditor role exists separately from the pipeline roles.

When the user says "audit the codebase" → `/audit` or `/audit-quick` (see [`user-guide.md` §Auditing a codebase](user-guide.md#auditing-a-codebase)).
When the user says "build feature X" → `devteam stage requirements --feature "X"` (see [`EXAMPLE.md`](../EXAMPLE.md)).

## What you can stop reading now

If you can describe what a **workstream**, **gate**, and **track** are, you have enough to use the pipeline. If you know `/audit` produces a `docs/audit/10-roadmap.md` you can act on, you have enough to use the audit. Everything else is detail that surfaces when you need it. Follow the cross-references as they come up.
