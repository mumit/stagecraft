# Stagecraft Consolidation & Roadmap Plans

Phase plans produced from the 2026-06-10 full-framework review and subsequent audits. Each phase is a set of
PR-sized work items with file/line anchors, acceptance criteria, and verification commands,
written to be executed one item at a time.

**Current state (2026-08-04):** phases 1–20, 22, 24, 27, 28, 29, 30, 31, 33, 34, and 35 are
complete. Phase 32 is mostly complete with two open items. Phase 36 is written and ready to
run, starting with a report-only spike. Phases 21, 25, and 26 are
proposed and not authorized for implementation. See
[What is not delivered yet](#what-is-not-delivered-yet) for the full list of open work.
Real-project evidence collection remains the priority that unblocks the capability gates
listed under [Evidence reviews](#evidence-reviews).

| Phase | Plan | Prompts | Theme | Status |
|---|---|---|---|---|
| 1 | [phase-1-trust-consolidation.md](phase-1-trust-consolidation.md) | [prompts](prompts/ALL-PROMPTS.md) | Safety gaps in the autonomous path + verified CLI bugs | ✅ complete (PRs #63–#69) |
| 2 | [phase-2-consistency-and-docs.md](phase-2-consistency-and-docs.md) | [prompts](prompts/ALL-PROMPTS.md) | Make prose/code drift mechanically impossible; release | ✅ complete (PRs #71 · #72 · #75 · #76 · v0.6.0) |
| 3 | [phase-3-structural-debt.md](phase-3-structural-debt.md) | [prompts](prompts/ALL-PROMPTS.md) | bin/devteam split, fix-steps registry, dependency & portability decisions | ✅ complete (PRs #79–#89) |
| 4 | [phase-4-capability-roadmap.md](phase-4-capability-roadmap.md) | [prompts](prompts/ALL-PROMPTS.md) | Resume planned capability work (G10, convergence, G3, H3 pre-work) | ✅ complete (PRs #90–#97) |
| Docs | [documentation-plan.md](documentation-plan.md) | [prompts](prompts/ALL-PROMPTS.md) | Documentation system: audience paths, generated reference, token budgets | ✅ complete (PRs #99 · #102 · #103 · #104 · #105 · #107) |
| 5 | [phase-5-state-integrity.md](phase-5-state-integrity.md) | [prompts](prompts/ALL-PROMPTS.md) | State lifecycle: derived gate invalidation, archive ownership, interactive ceiling, B9 fence | ✅ complete (PRs #114–#117) |
| 6 | [phase-6-promise-integrity.md](phase-6-promise-integrity.md) | [prompts](prompts/ALL-PROMPTS.md) | Make shipped claims true: G10 prompt-only path, pm budget, C3 runner, recipe de-overfit | ✅ complete (PRs #118–#121 · #124) |
| 7 | [phase-7-test-harness.md](phase-7-test-harness.md) | [prompts](prompts/ALL-PROMPTS.md) | Kill the repo-state test class structurally; CI signal quality | ✅ complete (PRs #122 · #125) |
| 8 | [phase-8-release-and-sync.md](phase-8-release-and-sync.md) | [prompts](prompts/ALL-PROMPTS.md) | v0.7.0 with honest attribution; semantic runbook sync; D5 token work | ✅ complete (PRs #123 · #126 · v0.7.0) |
| 9 | [phase-9-evidence-gated-capabilities.md](phase-9-evidence-gated-capabilities.md) | [prompts](prompts/ALL-PROMPTS.md) | ADR-007 heartbeat, H3 ground-truth, ADR-008, adaptive-routing evidence | ✅ complete (PRs #128 · #129 · #131 · #133) — ADR-005 deferred |
| 10 | [phase-10-repair-mode.md](phase-10-repair-mode.md) | [prompts](prompts/ALL-PROMPTS.md) | `devteam run --repair` bug-fix intent (ADR-009): PATCH-MODE-scoped build, diagnosis stage, failing-first reproduction | ✅ complete (PRs #140 · #141 · #146 · #147) |
| 11 | [phase-11-autonomy-polish.md](phase-11-autonomy-polish.md) | [prompts](prompts/ALL-PROMPTS.md) | Autonomy polish (ADR-006/007/008): track provenance, liveness heartbeat (observe-first), advise-aware exit semantics | ✅ complete — 11.1 ✅ liveness heartbeat (ADR-007 Tier 1) · 11.2 ✅ advise-aware exit (ADR-008) · 11.3 ✅ track provenance (ADR-006) |
| 12 | [phase-12-git-workflow-automation.md](phase-12-git-workflow-automation.md) | [prompts](prompts/ALL-PROMPTS.md) | Git workflow automation (ADR-010): managed gitignore, `devteam commit`, `--auto-commit`, git-workflow.md restructure | ✅ complete — 12.1 ✅ managed gitignore (PR #154) · 12.2 ✅ `devteam commit` (PR #155) · 12.3 ✅ `--auto-commit` (PR #156) · 12.4 ✅ docs restructure (PR #157) |
| 13 | [phase-13-deploy-adapters.md](phase-13-deploy-adapters.md) | [prompts](prompts/ALL-PROMPTS.md) | Deploy adapters: GCP Cloud Run and Gizmos (Cloudflare Workers) for stage-08 | ✅ complete — 13.1 ✅ cloud-run (PR #160) · 13.2 ✅ gizmos (feat/deploy-gizmos) |
| 14 | [phase-14-dogfooding-support.md](phase-14-dogfooding-support.md) | [prompts](prompts/ALL-PROMPTS.md) | Dogfooding support: `devteam init --profile dogfood`, doctor checks, preflight staged-artifact guard, budget warning, guide | ✅ complete — 14.1 ✅ `--profile dogfood` (PR #163) · 14.2 ✅ doctor dogfood checks (PR #164) · 14.3 ✅ preflight artifact guard (PR #165) · 14.4 ✅ budget warning (PR #166) · 14.5 ✅ dogfooding guide |
| 15 | [phase-15-adapter-conventions.md](phase-15-adapter-conventions.md) | [prompts](prompts/ALL-PROMPTS.md) | Adapter-aware stage context: inject deploy target constraints into `pipeline/context.md` so `--feature` can be pure intent; `devteam init --adapter`; fix `gizmos whoami` bug | ✅ complete — pre-work ✅ `--adapter` flag (PR #173) · 15.1 ✅ gizmos auth fix (PR #176) · 15.2 ✅ conventions injection (feat/adapter-conventions) |
| 16 | [phase-16-evidence-readiness-and-export.md](phase-16-evidence-readiness-and-export.md) | — | Privacy-safe evidence readiness and explicit aggregate export (audit P3-1) | ✅ complete — 16.1 privacy review · 16.2 local status · 16.3 export and portfolio analysis |
| 17 | [phase-17-durable-evidence-instrumentation.md](phase-17-durable-evidence-instrumentation.md) | — | Durable privacy-bounded dispatch evidence and real-project collection | ✅ 17.1 complete (PR #254); collection in progress |
| 18 | [phase-18-accepted-resolution-evidence.md](phase-18-accepted-resolution-evidence.md) | — | Explicit hash-bound human acceptance evidence for H3 | ✅ 18.1 complete (PR #262); collection in progress |
| 19 | [phase-19-polyglot-verification.md](phase-19-polyglot-verification.md) | — | B7 deterministic Node, pytest, and Go suite aggregation | ✅ complete (PR #264) |
| 20 | [phase-20-run-watch.md](phase-20-run-watch.md) | — | ADR-007 foreground terminal liveness UX | ✅ complete (PR #268) |
| 21 | [phase-21-cloud-runner-adapter.md](phase-21-cloud-runner-adapter.md) | — | A3 remote workstream execution through a transport-backed host adapter | 📝 proposed for review |
| 22 | [phase-22-docker-headless-runner.md](phase-22-docker-headless-runner.md) | — | Docker-based unattended local runner for long headless pipelines | ✅ complete — ADR-014 + `hosts/docker/` |
| 24 | [phase-24-omnigent-runtime.md](phase-24-omnigent-runtime.md) | — | Omnigent as a host runtime with policy/session bridge and experimental director prototype | ✅ complete (PRs #298–#304) |
| 25 | [phase-25-omnigent-director-hardening.md](phase-25-omnigent-director-hardening.md) | — | Harden the Omnigent director prototype through dogfood, partial resume design, session evidence, policy conformance, and topology decisions | 📝 proposed and parked (#305) |
| 26 | [phase-26-performance-observability-usability.md](phase-26-performance-observability-usability.md) | — | Performance, live-run observability, and operator usability overhaul | 📝 proposed (#312) |
| 27 | [phase-27-pattern-learning.md](phase-27-pattern-learning.md) | — | D12 project-local pattern learning: `devteam patterns`, sanitized candidate collection, explicit promotion, bounded prompt injection | ✅ complete (PRs #333 plan · #334 implementation); the learning loop was closed later by phase 30 |
| 28 | [phase-28-ground-truth-telemetry.md](phase-28-ground-truth-telemetry.md) | [prompts](prompts/roadmap-2026-prompts.md) | Token/cost telemetry at the adapter layer, sanitized run corpus, Antigravity host continuity | ✅ complete — 28.1 claude-code usage · 28.2 openai-compat usage · 28.3 codex usage + labelled estimates · 28.4 budget on observed cost · 28.5 run corpus + `devteam corpus stats` · 28.6 Antigravity adapter |
| 29 | [phase-29-scale-adaptive-ceremony.md](phase-29-scale-adaptive-ceremony.md) | [prompts](prompts/roadmap-2026-prompts.md) | `loop` track, assess-by-default, ceremony cost preview, compact QA fold | ✅ complete — 29.1 `loop` track · 29.2 assess-by-default (ADR-016) · 29.3 ceremony cost preview · 29.4 compact QA fold (`stage-06x`) · 29.5 docs repositioning |
| 30 | [phase-30-closed-learning-loop.md](phase-30-closed-learning-loop.md) | [prompts](prompts/roadmap-2026-prompts.md) | Auto-collect patterns, outcome-feedback counters, memory injection, reflector pass, SKILL.md export | ✅ complete — 30.1 auto-collect at run end · 30.2 injected/recurrence counters + demotion · 30.3 reflector pass · 30.4 memory retrieval into prompts · 30.5 SKILL.md export |
| 31 | [phase-31-verification-depth.md](phase-31-verification-depth.md) | [prompts](prompts/roadmap-2026-prompts.md) | Per-role stamping, mechanical red-team floor, adversarial review pair, mutation gate, quorum verification | ✅ complete — 31.1 per-role stamping · 31.2 mechanical red-team floor · 31.3 adversarial reviewer+critic · 31.4 mutation smoke gate · 31.5 stage-05 quorum re-derivation |
| 32 | [phase-32-performance-parallelism.md](phase-32-performance-parallelism.md) | [prompts](prompts/roadmap-2026-prompts.md) | Cache-first prompts, stage DAG waves (ADR-017), model-tier routing, best-of-N, context diet | ⚠️ mostly complete — 32.1 ✅ cache-first prompts (PR #360) · 32.2 ⏸ ADR-017 drafted only, status Proposed, wave execution not built · 32.3 ✅ model-tier routing (PR #362) · 32.4 ⏸ deferred (no host adapter exposes worktree-isolated dispatch; the item's own precondition can't be met yet) · 32.5 ✅ context.md diet (PR #363) |
| 33 | [phase-33-eval-flywheel.md](phase-33-eval-flywheel.md) | [prompts](prompts/roadmap-2026-prompts.md) | Failed-gate eval capture, `devteam evals run`, prompt-pack versioning, offline prompt optimization | ✅ complete — 33.1 eval capture · 33.2 `devteam evals run` · 33.3 `prompt_pack_version` · 33.4 `scripts/prompt-optimize.js` |
| 34 | [phase-34-interop-auditable-sdlc.md](phase-34-interop-auditable-sdlc.md) | [prompts](prompts/roadmap-2026-prompts.md) | ACP host adapter, in-toto attestation export, compliance mapping, gemini-cli plugin retirement | ✅ complete — 34.1 ACP adapter (PR #368) · 34.2 attestation export (PR #369) · 34.3 compliance mapping (PR #370) · 34.4 gemini-cli → plugin package |
| 35 | [phase-35-existing-codebase-mode.md](phase-35-existing-codebase-mode.md) | [prompts](prompts/roadmap-2026-prompts.md) | Review-only track + artifact-tolerant readFirst, `devteam review-pr`, stage-06d stamping, findings report, refactor track | ✅ complete — 35.1 review-only track (PR #373) · 35.2 `devteam review-pr` (PR #375) · 35.3 stage-06d stamping (PR #376) · 35.4 findings report (PR #377) · 35.5 refactor track (PR #378) |
| 36 | [phase-36-external-review-mode.md](phase-36-external-review-mode.md) | [prompts](prompts/roadmap-2026-prompts.md) | External review mode (ACP-first): two-root permissions with enforced read-only, framework paths across roots, review workspace, `devteam review <path>`, standalone `review-pr` | 📝 proposed (2026-08-04) — start with the 36.0 spike |

**Executing with Sonnet:** every work item has an exact paste-ready prompt. Phases 1–4
and the documentation phase use [prompts/ALL-PROMPTS.md](prompts/ALL-PROMPTS.md); phases
28–35 use [prompts/roadmap-2026-prompts.md](prompts/roadmap-2026-prompts.md). Paste the
file's §0 PREAMBLE plus the item prompt into a fresh Sonnet session — one item per
session per branch.

---

## What is not delivered yet

Everything below is either written-but-unbuilt or deliberately parked. Verified against
`git log` on 2026-08-04, not inferred from status chips.

| Work | Where | Why it is open |
|---|---|---|
| **32.2 stage DAG waves** | [phase-32](phase-32-performance-parallelism.md) · [ADR-017](../docs/adr/017-dag-wave-execution.md) | ADR-017 is written but its status is **Proposed**, so wave execution was never built. This is the largest remaining wall-clock win (~18 sequential stage slots → ~13). Needs the ADR accepted first. |
| **32.4 gate-verified best-of-N** | [phase-32](phase-32-performance-parallelism.md) | Deferred: the item requires a host adapter that exposes worktree-isolated dispatch, and none does today. Its own precondition cannot be met, so it was not attempted. |
| **Phase 36 — external review mode** | [phase-36](phase-36-external-review-mode.md) | Written 2026-08-04, not started. Seven items making review work without installing Stagecraft into the reviewed repo, built on ACP's negotiated session cwd. 36.0 is a report-only spike whose answer decides how 36.2 is built — run it first. |
| **Phase 21 — cloud-runner adapter (A3)** | [phase-21](phase-21-cloud-runner-adapter.md) | Proposed for review, never authorized. `hosts/cloud-runner-github/` is an empty placeholder. |
| **Phase 25 — Omnigent director hardening** | [phase-25](phase-25-omnigent-director-hardening.md) | Proposed and parked ([#305](https://github.com/telus-labs/stagecraft/issues/305)). |
| **Phase 26 — performance/observability overhaul** | [phase-26](phase-26-performance-observability-usability.md) | Proposed ([#312](https://github.com/telus-labs/stagecraft/issues/312)). Partly overtaken by phases 28 and 32, which delivered telemetry, the run corpus, and cache-first prompts. Worth re-scoping rather than running as written. |

Capability gates that stay shut for lack of real-project data — not for lack of code —
are listed under [Evidence reviews](#evidence-reviews). Phase 28 removed the telemetry
blocker those gates cited, so the remaining requirement is dispatch volume across real
projects.

---

## Evidence reviews

Read-and-report analyses produced during the roadmap — no code changed in these sessions.
They document why certain capability gates remain shut and what would open them.

| File | Phase item | PR | Verdict |
|---|---|---|---|
| [phase-4-ground-truth.md](phase-4-ground-truth.md) | 4.0 — convergence vs. spec | — | Implementation matched spec; no gaps at Phase 4 entry |
| [h3-ground-truth.md](h3-ground-truth.md) | 9.2a — H3 recipe factory corpus | #129 | Gate stays shut: zero run-logs, zero gate archives; re-escalate after ≥2 real projects with ≥5 autonomous runs each |
| [adaptive-routing-evidence.md](adaptive-routing-evidence.md) | 9.4 — D5 adaptive routing | #133 | Gate stays shut: max 4 dispatches per role (sms-opt-in fixture only); re-escalate after ≥5 dispatches per (role, host) pair across ≥2 real user projects with cost telemetry |
| [acp-read-scope.md](acp-read-scope.md) | 36.0 — ACP read-scope spike | — | Real agent confirms unsandboxed absolute-path reads outside session cwd; recommendation: absolute paths (no permission-layer change needed) for 36.2 |

## Strategic analyses

| File | Topic | Status |
|---|---|---|
| [pipeline-speed-opportunities.md](pipeline-speed-opportunities.md) | End-to-end pipeline critical path and safe acceleration roadmap | Proposed; no implementation authorized — items #1/#5/#10 superseded by phase-32 |
| [landscape-review-2026-07.md](landscape-review-2026-07.md) | Full competitive review vs the mid-2026 coding-agent landscape; strategy ("the auditable agent SDLC that learns") and the phase 28–34 roadmap | Proposed; no implementation authorized |

---

## How to run these with Sonnet (historical reference)

All phases are complete. These notes are preserved for re-use if new phases are planned.

- **One work item per session/PR.** Each item is scoped to be independently mergeable.
  Paste the item (plus the "Conventions" section below) as the task. Do not batch items.
- **Every item has a Verify block.** The change is not done until those commands pass.
  `npm test` and `npx eslint .` must be green after every item (the suite is fully offline).
- **Line numbers are anchors, not gospel.** They were verified against commit `212c710`
  (2026-06-10). If the file has moved, search for the quoted code, don't edit blind.
- **Items marked `[verify-first]`** contain a claim from review agents that was not
  independently re-verified. The first step of those items is to confirm the claim;
  if it doesn't hold, stop and report instead of "fixing" working code.
- **Follow repo conventions**: comments explain *why* with backlog/ADR IDs
  (see existing style in core/driver.js:9-23), tests use per-test `mkdtempSync`
  tempdirs with the `devteam-test-` guard (see tests/_helpers.js), commits use
  conventional-commit format, and CHANGELOG entries go under `[Unreleased]`
  (until Phase 2 item 2.4 lands fragments).

## Conventions (paste along with each work item)

- Repo: Node.js CLI, no test framework — bare `node --test tests/*.test.js`.
- Run `npm test` and `npx eslint .` before declaring done.
- Source of truth for stages/gates is `core/pipeline/stages.js`; prose must match code, never the reverse, unless the item says otherwise.
- Never weaken an existing test to make a change pass. If a test encodes the old behavior the item intentionally changes, update the test and say so in the PR description.
- Update `docs/FEATURES.md` / relevant runbook only when the item says to; doc sweeps are Phase 2's job.
