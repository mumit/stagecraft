# Backlog

A living list of work beyond the initial migration, organized into seven buckets. Each item carries a rough impact (1–5) and effort (1–5) score.

**How to read the scores.** Impact 5 = changes what users can do, not just how. Effort 5 = multi-week, touches several components, needs experimentation. Priority is not strictly impact÷effort — high-impact items are often worth doing even when expensive — but the ratio is a useful first filter.

- [Shipped](#shipped)
- [A. Reach — more hosts, more deployment targets](#a-reach--more-hosts-more-deployment-targets)
- [B. Pipeline depth — more/richer stages](#b-pipeline-depth--morericher-stages)
- [C. Quality & safety — enforcement, sandboxing, scanning](#c-quality--safety--enforcement-sandboxing-scanning)
- [D. Observability & learning — telemetry, metrics, persistent learning](#d-observability--learning--telemetry-metrics-persistent-learning)
- [E. Developer experience](#e-developer-experience)
- [F. Integrations — where the team plugs in](#f-integrations--where-the-team-plugs-in)
- [G. Innovation bets — speculative, future-oriented](#g-innovation-bets--speculative-future-oriented)
- [Priority queue](#priority-queue-2026-06-19--phase-19-closeout)
- [Staying ahead of the curve — bets](#staying-ahead-of-the-curve--bets)

**Cross-references.** Items tagged `[cmp-E-N]` were added or refined on 2026-06-03 after the comparative analysis against six adjacent AI-dev frameworks ([`comparative-analysis.md`](comparative-analysis.md)). Items tagged `[hist-N]` came from `audit-archive/HISTORY.md` § Between-cycle observations. Where multiple sources converge on the same idea, that's recorded inline.

## Shipped

Completed backlog items are preserved here so the active backlog tables stay scannable.

| Bucket | # | Item | I | E | Shipped |
|---|---|---|---|---|---|
| A | A1 | Gemini CLI adapter | 4 | 2 | v0.2.0 · [CHANGELOG](../CHANGELOG.md#020--2026-05-27) |
| A | A4 | Pluggable adapter discovery | 3 | 2 | landed · [CHANGELOG](../CHANGELOG.md#unreleased) |
| A | A6 | Native Windows validation and support | 2 | 2 | landed · Node 22 `windows-latest` portability smoke |
| B | B1 | Accessibility audit stage | 4 | 2 | v0.2.0 · [CHANGELOG](../CHANGELOG.md#020--2026-05-27) |
| B | B2 | Performance budget stage | 4 | 3 | v0.6.0 · [CHANGELOG](../CHANGELOG.md#060--2026-06-11) |
| B | B3 | Deploy cost gate | 4 | 2 | landed in PR #221 · [CHANGELOG](../CHANGELOG.md#unreleased) |
| B | B4 | Observability gate | 4 | 2 | v0.2.0 · [CHANGELOG](../CHANGELOG.md#020--2026-05-27) |
| B | B5 | Migration safety stage | 5 | 3 | v0.4.0 · [CHANGELOG](../CHANGELOG.md#040--2026-05-28) |
| B | B6 | Documentation gate | 3 | 2 | landed in PR #225 · [CHANGELOG](../CHANGELOG.md#unreleased) |
| B | B7 | Multi-language QA | 4 | 4 | Unreleased · Phase 19 · PR #264 |
| B | B8 | Cross-artifact consistency analyze `[cmp-E-1]` | 4 | 2 | v0.6.0 · [CHANGELOG](../CHANGELOG.md#060--2026-06-11) |
| B | B9 | Bounded workspace deltas `[cmp-E-2]` | 4 | 3 | v0.6.0 · [CHANGELOG](../CHANGELOG.md#060--2026-06-11) |
| B | B10 | Discover Standards preprocessing `[cmp-E-5]` | 3 | 3 | v0.6.0 · [CHANGELOG](../CHANGELOG.md#060--2026-06-11) |
| C | C1 | Filesystem-level `allowedWrites` enforcement | 4 | 4 | v0.6.0 · [CHANGELOG](../CHANGELOG.md#060--2026-06-11) |
| C | C2 | Secret scanning hook | 4 | 1 | v0.2.0 · [CHANGELOG](../CHANGELOG.md#020--2026-05-27) |
| C | C3 | License compatibility gate | 3 | 1 | v0.6.0 · [CHANGELOG](../CHANGELOG.md#060--2026-06-11) |
| C | C4 | Reproducible runs (recording half) | 4 | 4 | v0.4.0 · [CHANGELOG](../CHANGELOG.md#040--2026-05-28) |
| C | C5 | Capability-required permissions | 3 | 2 | v0.6.0 · [CHANGELOG](../CHANGELOG.md#060--2026-06-11) |
| C | C6 | Tamper-evident gate chain | 3 | 3 | v0.6.0 · [CHANGELOG](../CHANGELOG.md#060--2026-06-11) |
| C | C7 | `eslint-plugin-security` `[hist-a]` | 3 | 1 | v0.6.0 · [CHANGELOG](../CHANGELOG.md#060--2026-06-11) |
| C | C8 | CHANGELOG-per-PR fragments `[hist-b]` | 3 | 2 | v0.6.0 · [CHANGELOG](../CHANGELOG.md#060--2026-06-11) |
| D | D1 | OpenTelemetry tracing per stage | 5 | 3 | v0.2.0 · [CHANGELOG](../CHANGELOG.md#020--2026-05-27) |
| D | D2 | Gate-pass-rate dashboards | 4 | 2 | v0.2.0 · [CHANGELOG](../CHANGELOG.md#020--2026-05-27) |
| D | D3 | Lessons-learned across projects (org-shared) | 5 | 4 | v0.3.0 · [CHANGELOG](../CHANGELOG.md#030--2026-05-29) |
| D | D4 | Per-role per-model performance scores | 5 | 3 | v0.3.0 + Phase 26 latency metrics ([#318](https://github.com/telus-labs/stagecraft/issues/318)) · [CHANGELOG](../CHANGELOG.md#030--2026-05-29) |
| D | D5 | Adaptive routing | 5 | 3 | v0.3.0 + Phase 26 p50/p95/retry-adjusted routing evidence ([#318](https://github.com/telus-labs/stagecraft/issues/318)) · [CHANGELOG](../CHANGELOG.md#030--2026-05-29) |
| D | D6 | Cost telemetry | 4 | 2 | v0.3.0 · [CHANGELOG](../CHANGELOG.md#030--2026-05-29) |
| D | D7 | Persistent project memory (embeddings index) | 5 | 4 | v0.2.0 · [CHANGELOG](../CHANGELOG.md#020--2026-05-27) |
| D | D13 | Provider-neutral observed token budget | 4 | 4 | Unreleased · [CHANGELOG](../CHANGELOG.md#unreleased) |
| E | E1 | `devteam status` rich CLI output | 3 | 1 | v0.1.0 as `devteam summary`; Phase 11.1-11.3 updates · [CHANGELOG](../CHANGELOG.md#unreleased) |
| E | E2 | Web UI for pipeline runs | 4 | 4 | v0.2.0 · [CHANGELOG](../CHANGELOG.md#020--2026-05-27) |
| E | E4 | Live streaming output | 3 | 2 | landed in shared headless invoke helper · [CHANGELOG](../CHANGELOG.md#unreleased) |
| E | E5 | Pre-flight check (`devteam doctor`) | 3 | 1 | v0.1.0 plus Phase 14.2-14.3 updates · [CHANGELOG](../CHANGELOG.md#010--2026-05-26) |
| E | E6 | `devteam replay <stage-id>` | 3 | 3 | v0.4.0 · [CHANGELOG](../CHANGELOG.md#040--2026-05-28) |
| E | E7 | `/goal` integration for convergence-shaped stages | 3 | 2 | v0.6.0 · [CHANGELOG](../CHANGELOG.md#060--2026-06-11) |
| E | E8 | Codebase audit feature | 5 | 3 | v0.3.0 · [CHANGELOG](../CHANGELOG.md#030--2026-05-29) |
| E | E10 | Autonomous run watch mode | 3 | 1 | PR #268 · Phase 20 |
| E | E11 | Prototype mode | 4 | 2 | Unreleased · pre-SDLC packet for fast learning, optional host-run builds, feedback, and explicit promotion into a normal delivery track. See [Phase 23 plan](../plans/phase-23-prototype-mode.md). |
| F | F1 | GitHub PR integration | 4 | 3 | v0.2.0 · [CHANGELOG](../CHANGELOG.md#020--2026-05-27) |
| F | F4 | CI runner integration | 4 | 3 | v0.4.0 (GitHub Actions only) · [CHANGELOG](../CHANGELOG.md#040--2026-05-28) |
| G | G1 | Multi-model peer review |  |  | v0.2.0 · [CHANGELOG](../CHANGELOG.md#020--2026-05-27) |
| G | G2 | Closed-loop acceptance criteria → exec spec → tests |  |  | v0.4.0 · [CHANGELOG](../CHANGELOG.md#040--2026-05-28) |
| G | G3 | Production feedback loop |  |  | landed · [CHANGELOG](../CHANGELOG.md#unreleased) |
| G | G4 | Red-team role between build and peer-review |  |  | v0.3.0 · [CHANGELOG](../CHANGELOG.md#030--2026-05-29) |
| G | G6 | Stage shopping (AI-inferred tracks) |  |  | v0.6.0 · [CHANGELOG](../CHANGELOG.md#060--2026-06-11) |
| G | G7 | Verification beyond tests |  |  | v0.4.0 · [CHANGELOG](../CHANGELOG.md#040--2026-05-28) |
| G | G8 | Long-context architecture continuity |  |  | v0.3.0 · [CHANGELOG](../CHANGELOG.md#030--2026-05-29) |
| G | G10 | Role tool budgets |  |  | landed · [CHANGELOG](../CHANGELOG.md#unreleased) |
| G | G11 | `devteam run --repair` — bug-fix intent mode (ADR-009) |  |  | complete (Phase 10) · [CHANGELOG](../CHANGELOG.md#unreleased) |

---

## A. Reach — more hosts, more deployment targets

| # | Idea | I | E | Notes |
|---|---|---|---|---|
| A2 | **Cursor / Windsurf / Aider / Cline adapters** | 3 | 3 | One per IDE-embedded agent. Each is an adapter, mostly install-payload work. |
| A3 | **Cloud-runner adapter** (e.g. AWS Lambda + Bedrock, Replit Agent) | 4 | 4 | Host adapter that runs one workstream on a remote worker, not the user's laptop. Sequence after Phase 38 defines the trust/provider contract and Phase 39 measures local bottlenecks; then re-scope the older [Phase 21 proposal](../plans/phase-21-cloud-runner-adapter.md) instead of building its stale design verbatim. |
| A5 | **API-direct adapter** (no host CLI; talks to Anthropic / OpenAI / Google APIs directly) | 3 | 3 | For users who don't want to install claude-code or codex but still want orchestration. Lighter dependency footprint. |
| A7 | ~~**Docker-based headless runner** ([#282](https://github.com/telus-labs/stagecraft/issues/282))~~ | 4 | 2 | ✅ Unreleased · `hosts/docker/` packages Stagecraft into a non-root Docker runner for unattended local orchestration against a mounted project, with runtime-only credentials and conservative lock handling. |
| A8 | ~~**Omnigent runtime adapter follow-through** ([#291](https://github.com/telus-labs/stagecraft/issues/291))~~ | 4 | 4 | ✅ Unreleased · Phase 24 ships the `omnigent` host adapter, launch config ([#292](https://github.com/telus-labs/stagecraft/issues/292)), prompt transport ([#293](https://github.com/telus-labs/stagecraft/issues/293)), policy bridge ([#294](https://github.com/telus-labs/stagecraft/issues/294)), session evidence ([#295](https://github.com/telus-labs/stagecraft/issues/295)), and experimental director prototype ([#296](https://github.com/telus-labs/stagecraft/issues/296)). Next-phase hardening is parked in [Phase 25](../plans/phase-25-omnigent-director-hardening.md) / [#305](https://github.com/telus-labs/stagecraft/issues/305). |
| A9 | **Omnigent director hardening** ([#305](https://github.com/telus-labs/stagecraft/issues/305)) | 4 | 3 | Proposed and parked. Dogfood director mode, improve child-gate diagnostics ([#306](https://github.com/telus-labs/stagecraft/issues/306)), design partial resume ([#307](https://github.com/telus-labs/stagecraft/issues/307)), correlate session evidence ([#309](https://github.com/telus-labs/stagecraft/issues/309)), stabilize policy conformance ([#308](https://github.com/telus-labs/stagecraft/issues/308)), and decide remote sandbox topology ([#310](https://github.com/telus-labs/stagecraft/issues/310)). |
| A10 | **Real registry publish for first-party-maintained plugins** | 2 | 3 | Phase 34.4 moved `gemini-cli` from a first-party host to `packages/host-gemini-cli/`, the first real consumer of the A4 pluggable-adapter mechanism — but the package isn't published anywhere, and its `adapter.js` reaches Stagecraft's core via relative paths that only resolve inside a Stagecraft checkout (see `packages/host-gemini-cli/README.md`'s honest scope note). A genuinely standalone install needs (a) Stagecraft itself publishable as a non-private package so a plugin can `require("stagecraft/core/...")` as a real dependency instead of a filesystem-relative neighbor, and (b) an actual registry/org decision for `@devteam/*` packages. |

## B. Pipeline depth — more/richer stages

No open items. B7 moved to [Shipped](#shipped) in Phase 19.

## C. Quality & safety — enforcement, sandboxing, scanning

| # | Idea | I | E | Notes |
|---|---|---|---|---|
| C1 | ~~Filesystem-level `allowedWrites` enforcement~~ | 4 | 4 | ✅ v0.6.0 · [CHANGELOG](../CHANGELOG.md#060--2026-06-11) |
| C2 | ~~Secret scanning hook~~ | 4 | 1 | ✅ v0.2.0 · [CHANGELOG](../CHANGELOG.md#020--2026-05-27) |
| C3 | ~~License compatibility gate~~ | 3 | 1 | ✅ v0.6.0 · [CHANGELOG](../CHANGELOG.md#060--2026-06-11) |
| C4 | ~~Reproducible runs (recording half)~~ | 4 | 4 | ✅ v0.4.0 · [CHANGELOG](../CHANGELOG.md#040--2026-05-28) |
| C5 | ~~Capability-required permissions~~ | 3 | 2 | ✅ v0.6.0 · [CHANGELOG](../CHANGELOG.md#060--2026-06-11) |
| C6 | ~~Tamper-evident gate chain~~ | 3 | 3 | ✅ v0.6.0 · [CHANGELOG](../CHANGELOG.md#060--2026-06-11) |
| C7 | ~~`eslint-plugin-security`~~ `[hist-a]` | 3 | 1 | ✅ v0.6.0 · [CHANGELOG](../CHANGELOG.md#060--2026-06-11) |
| C8 | ~~CHANGELOG-per-PR fragments~~ `[hist-b]` | 3 | 2 | ✅ v0.6.0 · [CHANGELOG](../CHANGELOG.md#060--2026-06-11) |
| C9 | ~~**Verify-before-promoting enforcement in audit skill** `[hist-c]`~~ | 3 | 2 | ✅ Unreleased · Phase 1/2 audit findings now require `verified_by` evidence, templates expose verification slots, and structural tests lock the contract. |
| C10 | ~~**Execution trust profiles and contained workstreams**~~ | 5 | 5 | ✅ Unreleased · [Phase 38](../plans/phase-38-execution-trust-profiles.md), PR #413. Distinguishes trusted, contained, and remote execution; adds a fail-closed disposable local container path with scoped environment, default-deny network, resource limits, and validated output reconciliation. Git worktrees alone are not an OS sandbox. |

## D. Observability & learning — telemetry, metrics, persistent learning

| # | Idea | I | E | Notes |
|---|---|---|---|---|
| D5 | **D5 maturation — continuous adaptive routing** | 5 | 3 | Evidence-gated in [Phase 41](../plans/phase-41-evidence-gated-learning-routing.md). Phase 39 improves calibration, but activation still requires ≥5 durable dispatches per candidate `(role, host)` pair across ≥2 real projects, accepted outcomes, and labelled cost. The first runtime step is shadow recommendation, not automatic rerouting. |
| D8 | ~~**Cross-run performance calibration**~~ ([#312](https://github.com/telus-labs/stagecraft/issues/312), [#313](https://github.com/telus-labs/stagecraft/issues/313)) | 5 | 3 | ✅ Unreleased · [Phase 39](../plans/phase-39-evidence-performance-calibration.md), PR #414. Cross-run p50/p95, queue/invoke/verification/reconciliation/cache breakdown, cost per accepted change, track-fit feedback, and the two-project protocol are shipped; real-project collection continues. |
| D9 | **Verification efficiency: concurrency and receipts** ([#315](https://github.com/telus-labs/stagecraft/issues/315)) | 4 | 4 | ✅ Unreleased · Independent suites now run with bounded concurrency and resource groups, and successful orchestrator-run verification commands mint content-addressed receipts that are reused only when command, suite, purpose, workspace bytes, config, env/toolchain, and verifier version match. |
| D10 | **Safe track/workstream right-sizing** ([#316](https://github.com/telus-labs/stagecraft/issues/316)) | 4 | 4 | ✅ Core selection and feedback shipped · ADR-018 makes `loop` the reachable assessed default, promotes concrete security/migration risk, materializes stage/route decisions in `pipeline/run-plan.json`, and binds resume to its execution fingerprint. [Phase 39](../plans/phase-39-evidence-performance-calibration.md) added override and fit feedback; runtime active-workstream selection remains evidence-gated. |
| D11 | **Per-host workstream scheduling and retry backoff** ([#317](https://github.com/telus-labs/stagecraft/issues/317)) | 4 | 3 | ✅ Unreleased · `routing.host_concurrency` caps already-ready workstreams per host, run logs record queue wait, critical-path reports surface queue time, and transient retry events include reason/backoff class. Stage-level DAG waves: [ADR-017](adr/017-dag-wave-execution.md) accepted 2026-08-05 and implemented the same day as [phase-32](../plans/phase-32-performance-parallelism.md) item 32.6 (PR #401) — `dependsOn` metadata on the two curated regions, wave-aware `nextWave()`, concurrent driver dispatch, `wave_id` in `run-log.jsonl`, and realized-savings reporting in `devteam performance critical-path`. |
| D12 | ~~Pattern learning for agent growth~~ ([#332](https://github.com/telus-labs/stagecraft/issues/332)) | 5 | 4 | ✅ shipped — [Phase 27](../plans/phase-27-pattern-learning.md) added `devteam patterns`; [Phase 30](../plans/phase-30-closed-learning-loop.md) closed collection and feedback; the [Project Knowledge Pack](project-knowledge.md) now combines reviewed patterns with repository facts and retrieved history, and quarantines recurrence-heavy guidance until revision. Distinct from H3: advisory prevention before coding, not deterministic recipe creation. |

## E. Developer experience

| # | Idea | I | E | Notes |
|---|---|---|---|---|
| E3 | **VS Code extension** | 3 | 3 | Sidebar with stage status, "run next stage" button, gate viewer. |
| E9a | ~~**Read-only conversational coordinator**~~ `[cmp-E-4]` | 3 | 2 | ✅ Unreleased · PR #411 provides grounded project Q&A through captured output with tools disabled. It is intentionally read-only. |
| E9b | ~~**Approval-bound artifact refinement**~~ `[cmp-E-4]` | 4 | 3 | ✅ Unreleased · [Phase 40](../plans/phase-40-conversational-artifact-refinement.md), PR #415. Requirements/design conversation produces an exact proposal and invalidation preview; a separate explicit command applies or rejects it. No arbitrary shell or automatic writes. |
| E11 | **Prototype mode** | 4 | 2 | `devteam prototype` creates a lightweight pre-SDLC packet, can run the build prompt in a packet workspace, captures feedback, and records explicit discard/iterate/promote decisions. It is deliberately not a production gate track; promotion hands off into `devteam run --feature-file ... --track <t>`. |
| E12 | ~~**Rich live run UX**~~ ([#314](https://github.com/telus-labs/stagecraft/issues/314)) | 4 | 2 | ✅ Unreleased · `devteam run`, `--watch`, `status --verbose`, and Phase 39.5's durable `devteam log --timeline` expose active work, verification, retry, queue, reconciliation, and blocker state without a parallel UI store. |
| E13 | **Two-project dogfood reliability follow-through** | 5 | 3 | [Phase 42](../plans/phase-42-dogfood-reliability.md). P0: preserve caps/track/stoplist rulings across resume, reject role/path-incompatible retries before dispatch, and design exact-file documentation ownership. P1: project-layout-aware QA and logical-run evidence semantics. P2: checkout-local dogfood bootstrap isolation. This work is supported by the [2026-08-19 Phase 41 no-go review](../plans/phase-41-evidence-review-2026-08.md) and does not activate learning. |

## F. Integrations — where the team plugs in

| # | Idea | I | E | Notes |
|---|---|---|---|---|
| F2 | **Jira/Linear ticket integration** | 3 | 2 | `devteam stage requirements --ticket FOO-123` pulls the ticket as the feature brief input. Gates link back to the ticket. |
| F3 | **Slack/Discord notifications** | 3 | 1 | Pipeline events (stage start, fail, escalate) post to a channel. Triggers for human checkpoints. |
| F5 | **Pre-commit hook integration** | 3 | 1 | Optional pre-commit hook that runs the relevant track for the change (nano if config-only, full if otherwise). |

## G. Innovation bets — speculative, future-oriented

These don't fit neatly in impact/effort because their value depends on how the field evolves. They are the items that would most meaningfully differentiate this tool.

### G5. Multi-modal stages
Design specs include architecture diagrams (images). Stage 2 (design) and Stage 5 (review) accept image inputs. Principal can output a system diagram, not just prose. Visual reasoning is no longer a separate workflow.

### G9. Self-modifying pipeline

Parked. Phase 41 may produce bounded routing and recipe proposals after its evidence gates,
but it explicitly does not edit `stages.js`, roles, rules, gates, or source code. Reconsider
G9 only after multiple independent teams produce enough longitudinal evidence to define a
safe, reversible policy.

---

## Priority queue (2026-06-19 — Phase 19 closeout)

The full evidence, effort/risk ratings, dependencies, and PR sequence now live in the
[current audit backlog](audit/09-backlog.md) and [roadmap](audit/10-roadmap.md).

### Immediate and near-term

No ungated implementation item remains from the audit's immediate and targeted
improvement batches. Phase 16 completed privacy-safe readiness/export, Phase 17 made
dispatch evidence durable, Phase 18 added explicit accepted-resolution evidence for
H3, Phase 19 shipped polyglot verification in PR #264, and Phase 20 implements the
separable `devteam run --watch` operator UX without enabling active stall response. The
next capability horizon is real collection followed by review, not calendar-driven
activation. Phase 40 shipped approval-bound requirements/design refinement in PR #415;
unbounded conversational repository editing remains out of scope.

Completed from this audit cycle: dashboard HTML safety and lifecycle (PR #235),
native Windows CI evidence, support wording, and A6 promotion (PR #236), and bounded
durable transcript streaming (PR #237). Current-truth reconciliation removed the
remaining P1-3 ownership, vocabulary, comment, count, link, and provider drift.
Stable-fact consistency now locks schema vocabulary, Node/platform support, and the
absence of volatile test totals while leaving audit history untouched (audit P2-3).
The autonomous driver decomposition is complete: characterization, dispatch/transient,
and fix/ruling/merge transitions landed as three behavior-preserving slices while
`run()` retained lock, loop, effect, and final-persistence ownership (audit P2-2).

### Evidence-gated next horizon

- **P3-1 — evidence readiness and export.** Phase 16 implements the approved privacy
  model, read-only local readiness, consented aggregate export, identity lifecycle,
  strict bundle validation, and explicit multi-project analysis. See
  [`plans/phase-16-evidence-readiness-and-export.md`](../plans/phase-16-evidence-readiness-and-export.md).
  Phase 17 adds allowlisted per-workstream dispatch events so D5 evidence accumulates
  during normal autonomous runs without reconstructing history from gate snapshots.
  See [`plans/phase-17-durable-evidence-instrumentation.md`](../plans/phase-17-durable-evidence-instrumentation.md).
  Phase 18 adds explicit, hash-bound human acceptance for successful fix/retry
  resolutions so H3's derivability threshold can be measured without exporting recipe
  text. See [`plans/phase-18-accepted-resolution-evidence.md`](../plans/phase-18-accepted-resolution-evidence.md).
  This makes the gates below measurable; it does not open them.

- **D5 maturation — continuous adaptive routing.** Today D5 proposes role-level swaps; the mature form re-routes the *next* run based on the prior run's outcomes automatically. **Evidence baseline (2026-06-14, `plans/adaptive-routing-evidence.md`):** zero real-run telemetry at review time. Phase 17 starts durable collection from real autonomous dispatches; it does not backfill old gates. Gate stays shut pending ≥5 durable dispatches per (role, host) pair across ≥2 real user projects and cost telemetry. ADR-007 Tier 1 (liveness heartbeat + observe-only stall probe) implemented in Phase 11.1; ADR-008 (advisory sweep + `--fail-on-advisory`) implemented in Phase 11.2; ADR-007 Tier 2 remains evidence-gated.
- **H3 — Recipe factory (escalation→recipe learning)** (Phase 3 of [ADR-003](adr/003-bounded-autonomous-execution.md) · [design](autonomous-execution-design.md)). Persist resolved escalations as semantically-indexed fix-recipes via the existing `core/memory/` embedding store (D7); `computeFixSteps` consults it on a FAIL signature before escalating, so recurring *derivable* failures resolve deterministically. **Evidence review done (2026-06-14, `plans/h3-ground-truth.md`):** zero real run logs/archives and no recurring unresolved class. Phase 18 makes explicit acceptance measurable under ADR-012. Gate stays shut pending ≥2 real projects each with ≥5 autonomous fix/retry runs, the same schema-bound failure accepted ≥3 times across both projects, and ≥80% derivability. Tracked by GitHub #142.
- **ADR-005 standing grants.** Keep deferred until at least 10 repair runs across 2+
  projects and consequence-ceiling halt data establish which grants operators routinely
  approve. Tracked by GitHub #144.
- **ADR-007 Tier 2 active stall response.** Keep deferred until real
  `stall-detected` events calibrate frequency and threshold. Tracked by GitHub #145.

### Consciously deprioritized

Five items that the comparative analysis or shifted context argues against investing in now:

- **E3 — VS Code extension.** Stagecraft sits above the IDE, not inside it. Building an editor extension works against that positioning, and IDE-native tooling is a crowded category.
- **A2 — Cursor/Windsurf/Aider/Cline adapters.** Supporting 30+ AI agents is a maintenance treadmill. Land **A4 — Pluggable adapter discovery** first and let the long tail be community-built.
- **F2 / F3 / F5 — Jira / Slack / pre-commit integration.** None changes what Stagecraft can do. Accept community PRs but don't invest core time.
- **G9 — Self-modifying pipeline.** Premature. Wait until multiple teams use the platform in different configurations before optimizing for any one signal.

---

## Staying ahead of the curve — bets

Six positioning bets about where software development is heading.

### 1. Models keep getting smarter, cheaper, faster.
Design the contract assuming 10× capability in 2 years. The schema (gate JSON), the contract (per-workstream gates merged to stage), and the routing layer should outlive the specific models we route to today.

### 2. Diversity beats monoculture.
Single-model agentic systems are giving way to multi-model coordinated systems. For non-trivial tasks, the stronger outcome usually involves 2–3 different model families. The routing layer is already built for this; the next step is making diversity structurally load-bearing (G1 multi-model peer review, D4/D5 adaptive routing).

### 3. Evals are the rate-limit.
The pipeline produces structured gate JSON so evals can be built on top. Every refinement should make the gate richer and more measurable. D1/D2/D4 are all expressions of this bet.

### 4. Memory and persistence are the next frontier.
Today's pipeline is mostly stateless within a run; each new run starts fresh. Sustained coordination across projects, with continuous learning, requires the work in D3/D7/G8.

### 5. Tool depth beats raw intelligence.
An agent with a deep, well-composed tool stack outperforms one that only writes text. Role briefs are the place to encode tool budgets per role (G10). Skills are early steps; tool negotiation is the mature form.

### 6. Compliance and auditability are coming, fast.
EU AI Act, US executive orders, SOC 2 controls: all require reproducible runs, audit trails, and documented decision provenance. C4 (reproducible runs), C6 (tamper-evident gate chain), and D1 (tracing) address this directly.

### The unit is the team, not the model.
A coordinated team of specialized agents — each with a role, a tool budget, a gate contract, and shared memory — outperforms a single model. The model is a substrate. The team is the product.
