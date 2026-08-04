# Landscape Review & Strategic Roadmap — July 2026

Status: **largely delivered** (updated 2026-08-03). Phases 28–31, 33, and 34 shipped;
phase 32 has two open items; phase 35 is written and not started. Per-phase detail is in
§5; open work is tracked in [README.md](README.md#what-is-not-delivered-yet). The market
analysis below is a July 2026 snapshot and has not been re-researched since.

Produced 2026-07-31 from four research streams: an internals deep-dive of this repo
(code-verified, tests run), and three web-research surveys covering (a) coding harnesses,
(b) spec-driven / multi-agent SDLC frameworks, and (c) agent learning & performance
engineering. Sources are cited inline.
Companion phase plans: [phase-28](phase-28-ground-truth-telemetry.md) ·
[phase-29](phase-29-scale-adaptive-ceremony.md) · [phase-30](phase-30-closed-learning-loop.md) ·
[phase-31](phase-31-verification-depth.md) · [phase-32](phase-32-performance-parallelism.md) ·
[phase-33](phase-33-eval-flywheel.md) · [phase-34](phase-34-interop-auditable-sdlc.md) ·
[phase-35](phase-35-existing-codebase-mode.md).
Execution prompts: [prompts/roadmap-2026-prompts.md](prompts/roadmap-2026-prompts.md).

---

## 1. Where the market moved (mid-2025 → mid-2026)

### Now standard across the field (no longer sets anyone apart)

- **Subagents, hooks, MCP, skills/AGENTS.md, headless/CI mode** — every major harness ships all of them. Codex CLI now has native subagents and is feature-comparable to Claude Code; Claude Code shipped experimental Agent Teams ("Swarms").
- **Background/cloud execution with persistence** — Claude Code on the web (+`/teleport`), Codex Cloud + the Codex app as a multi-agent manager, Devin VMs + Agent Command Center, Cursor 3 (up to 8 parallel agents, cloud agents, K8s operator), Copilot coding agent, Jules GA (April 2026).
- **Parallel agents in isolated worktrees/containers** with a fleet dashboard and "needs input" queue — Claude Code agent view, Antigravity Mission Control, GitHub Agent HQ, Devin Command Center.
- **Multi-host at the spec layer** — GitHub Spec Kit (~111k stars) integrates 30+ agents; ccpm ships as a portable Agent Skill across Claude Code/Codex/Cursor/Amp/Factory. "Works across hosts" no longer distinguishes Stagecraft on its own.
- **Some form of harness-run self-review** — Codex "Guardian" (dedicated `codex-auto-review` model gating sensitive ops), Copilot self-review + security scanning, Cursor Bugbot/Autofix, Devin's confidence-scored plans, Amp's Oracle.

### What died or pivoted (the ceremony backlash is real)

- **Tessl** never GA'd its spec-as-source framework; pivoted (Jan 2026) to a skills package manager. **vibe-kanban** (Bloop) shut down April 2026; **Terragon** shut down January 2026. **AutoGen** entered maintenance mode. **MetaGPT/ChatDev** are academic legacy.
- **BMAD-Method** (~49k stars) — the closest philosophical relative to Stagecraft — has the loudest documented backlash: token burn on "Full Flow", a head-to-head where BMAD took ~6 days and ~$200 for work others finished in 1–2 days, and a "Structural Gaps and Contradictions of V6" issue. Its own v6 pivot was **scale-adaptive planning**.
- **Agent OS v3** deliberately stopped owning the spec workflow and defers to host-native plan modes.
- Practitioner sentiment (HN thread on the Fowler/Böckeler SDD series, "SDD = rebranded BDUF") consistently attacks: markdown review fatigue, ceremony inflation on small fixes, 10–15× time and multi-hundred-dollar token bills, agents falsely claiming stage completion, waterfall rigidity.

**Lesson:** heavyweight persona pipelines are losing; **scale-adaptive process + verification artifacts** are winning. The counter-current that favors Stagecraft: as fleets grew, *review became the bottleneck*, and "independent review gates are the highest-return token spend" is now a mainstream position. Zenflow (Zencoder, Dec 2025) commercialized exactly Stagecraft's thesis — structured Plan>Implement>Test>Review with **cross-model verification** — as a closed desktop app.

### New structural facts Stagecraft must react to

1. **Gemini CLI is being sunset for Antigravity CLI** — free/Pro/Ultra requests stopped 2026-06-18. `hosts/gemini-cli/` targets a dying binary. Skills/hooks/subagents carry over as Antigravity plugins.
2. **Agent Client Protocol (ACP)** — created by Zed, now adopted by JetBrains, Google, GitHub, 25+ agents; OpenHands Agent Canvas drives Claude Code / Codex / Gemini CLI / OpenHands interchangeably via ACP. ACP standardizes precisely the boundary `hosts/*/adapter.js` hand-maintains: permissions, file edits, terminal, streaming progress. One ACP adapter ≈ many hosts.
3. **Agent Skills (SKILL.md)** became an open standard (Anthropic, Dec 2025) adopted by Copilot, Cursor, Codex, Gemini CLI — 280k+ published skills. It is the portable container for exactly the knowledge Stagecraft's pattern learning produces.
4. **Anthropic Managed Agents** (public beta 2026-04-08) ships rubric-based outcome grading — first-party machine-readable acceptance criteria. The gate idea is being validated upstream.
5. **The learning research matured**: ACE (agentic context engineering: Generator/Reflector/Curator, +10.6% agent benchmarks, label-free), GEPA (ICLR 2026 oral: reflective prompt evolution from execution traces, ~13% over MIPROv2 at 35× fewer rollouts), and test-time scaling (gate-verified best-of-N: Opus 4.5 70.9%→77.6% SWE-bench Verified). All three consume exactly the signal Stagecraft already emits: **machine-readable gate outcomes with textual failure feedback**.
6. **Multi-agent evidence turned nuanced**: orchestrator + isolated parallel workers on *independent* tasks wins; consensus review panels underperform — a minimal **adversarial reviewer–critic pair** beats both panels and added agent count; reviewer collusion is a measured failure mode (34.9–75.9% backdoor pass rates under incentives).

## 2. How Stagecraft stacks

### Genuinely strong (code-verified)

- **The gate contract is the strongest asset in the category.** 20 schemas, fail-closed validator, canonical-JSON hash chain with optional HMAC (`verify-chain` CI exit codes), write-audit that flips gates to FAIL, secret scan, consistency checker (31 repo invariants). Nobody else ships an orchestrator-enforced, host-portable, tamper-evident stage-gate contract. Nearest analogues (Antigravity Artifacts, Spec Kit `/speckit.analyze`, Kiro) are single-vendor or document-level.
- **The bounded driver is real engineering**: 9-action decision surface, convergence breakers beyond retry counts (no-progress and no-source-change detection), consequence ceiling, provenance-recorded auto-ruling, liveness heartbeat + stall probe, lock/resume state.
- **Control-plane test hygiene is best-in-class**: 2,307 passing tests / 452 suites in ~72s, ~0.93:1 test-to-source ratio, 4-way CI matrix, README-executing onboarding smoke.
- **Honest self-knowledge**: four evidence-gated capability stops, candid backlog, self-auditing docs. The repo already knows most of what this review says.

### The claim-vs-reality gaps (from the internals deep-dive)

> **This table describes the codebase as of 2026-07-31 and is kept as the record of why
> phases 28–34 were written. Most of these gaps are now closed** — telemetry and cost
> (28.1–28.4), the run corpus (28.5), memory injection and pattern feedback (30.2/30.4),
> stamping breadth (31.1–31.5), prompt caching and context size (32.1/32.5), and evals
> (33.x). Still open: stage-level parallelism (32.2) and stage-06d stamping (35.3). Do
> not read the rows below as current state.

| Claim | Reality (as of 2026-07-31) |
|---|---|
| Parallel workstreams | Within a stage only. **Stages are strictly sequential** — the driver is a single-action loop. Their own analysis: waves would cut the full track from 18 serial slots to ~13 (`pipeline-speed-opportunities.md`, unimplemented). |
| Orchestrator-stamped verification | **3 of 18 stages** (03b, 04a, 06), **single-workstream dispatches only**. Build (stage-04) and peer-review (stage-05) are never stamped. Red-team is 100% prompt-level — a model reporting `findings_count: 0` is believed. |
| Memory subsystem | Works as a standalone CLI (674 lines, local BGE embeddings, O(N) cosine, ~1k-chunk ceiling) but is **never injected into prompts**. Two consumers, both CLI commands. The RAG loop is not closed. |
| Pattern learning | Injection is automatic and tested; **collection and promotion are manual; the outcome-feedback counters (`injected`, `recurrence_after_injection`, `noise_reports`) are initialized and never incremented.** Every decay/demotion mechanism in the design doc is inert. |
| Cost tracking / `--budget-usd` | **No adapter emits token counts.** claude-code headless doesn't request JSON output; openai-compat has the `usage` object in hand and discards it. Budget enforcement sums the model's self-reported spend. |
| Adaptive routing | Offline suggest script, evidence-gated on **zero real-run telemetry**. |
| Context management | Files + regex-stripped marker sections. No summarization, no compaction, **no prompt caching anywhere** — despite 3,710–6,626 tokens of framework overhead per dispatch and 90%-off cache reads being standard economics. |
| Multi-host enforcement | Execution parity is real; **enforcement parity is claude-code-only** (tool-call-time stoplist/write-guard/budgets). All other hosts degrade to post-hoc audit + advisory prose. |
| Eval / agent-behavior testing | **None.** CI's "model" is `cat`. Zero real-run corpus; four capability gates blocked on it by written policy. |

### Positioning vs named competitors

| Competitor | Their edge | Stagecraft's edge |
|---|---|---|
| GitHub Spec Kit (~111k★) | Adoption, 30+ hosts, lightweight | Runtime enforcement — Spec Kit's verification is document-level; `/speckit.verify` is still a discussion thread |
| Amazon Kiro | IDE-native SDD, AWS distribution | Host-agnostic; Kiro is single-vendor; Kiro inflates small fixes (documented complaint) |
| BMAD-Method | Conversational shaping, community | Mechanical gates vs prose handoffs; but BMAD's backlash is a warning about Stagecraft's own ceremony |
| Zenflow | Commercial polish, cross-model verify | Open, auditable, CLI/CI-native, gate contract as data |
| GitHub Agent HQ | Platform gravity, agent marketplace | Staged SDLC with evidence; Agent HQ is PR-centric fan-out |
| OpenHands (ACP) | Open multi-harness runtime | SDLC structure + gates; OpenHands has no pipeline semantics |
| Ruflo (claude-flow) | Swarm topologies, mindshare | Verifiability; Ruflo's claims are vendor-reported, no gate contract |

**Bottom line:** no single product replicates *structured SDLC + machine-readable enforced gates + multi-host*. But each element alone is now contested, and the combination only compounds if the gates are (a) cheap enough to tolerate (scale-adaptive, cached, parallel), (b) trustworthy beyond 3 stages, and (c) feeding a learning loop nobody else can feed — because nobody else has the gate signal.

## 3. What's missing / needs redesign

Ranked by (strategic value × urgency):

1. **Ground truth telemetry (missing, blocking everything).** Token/cost capture at the adapter layer; a sanitized per-dispatch run corpus. This single gap keeps four evidence-gated capabilities (D5, H3, ADR-005, ADR-007 Tier 2) permanently shut and makes `--budget-usd` a fiction. It is also the substrate for ACE/GEPA/evals. **Highest-leverage, lowest-glamour item on this list.**
2. **Scale-adaptive ceremony (adoption-critical redesign).** The market's verdict on mandatory heavyweight pipelines is in. Stagecraft needs a genuinely small default path (a 4-slot loop track), auto-assessment as the default, and a printed ceremony cost estimate — so full ceremony is a *choice justified by stakes*, not a tax.
3. **The closed learning loop (the "agents that learn" bet — differentiating).** Wire what exists: auto-collect patterns at run end, increment the feedback counters, retrieve memory into prompts, add an ACE-style reflector pass. Serialize promoted patterns to SKILL.md for host-native portability. Stagecraft is *two weeks of plumbing away* from being the only orchestrator whose runs measurably improve subsequent runs.
4. **Verification depth (differentiating).** Extend stamping to multi-workstream stages and more of the 18; make red-team partially mechanical (run `npm audit`/semgrep/secret-scan orchestrator-side); replace the 4-way review panel default with an adversarial reviewer–critic pair (evidence says panels underperform and collude); optional mutation-score gate.
5. **Performance (redesign of prompt assembly + stage scheduling).** Cache-first prompt prefix ordering (stable framework preamble → role brief → learned context → volatile tail) with provider cache control; stage DAG waves (18 → ~13 slots); per-stage model-tier routing ("frontier plans, cheap executes" — Cursor-validated economics); opt-in gate-verified best-of-N for high-retry stages.
6. **Eval flywheel (hardest for others to copy).** Every failed gate auto-captured as a replayable eval case; `devteam evals` harness; then GEPA-style offline stage-prompt optimization gated on those evals. Gates provide both the scalar metric and the textual feedback GEPA needs.
7. **Host continuity & interop (urgent maintenance, plus a hedge).** Antigravity CLI adapter (Gemini CLI is being retired upstream); an ACP adapter as the universal host; evidence-bundle export aligned with in-toto/SLSA attestations for the compliance story (EU CRA deadlines are pushing enterprises this way, and no competitor has claimed the space).

### What does NOT need a rebuild

The core contract (stages table, gate schemas, validator, chain), the driver's failure model, the adapter factoring (`makeMarkdownHostAdapter`), and the test harness are sound. This roadmap is additive plumbing plus two genuine redesigns (prompt assembly, stage scheduling). Resist rewriting the spine.

## 4. Strategy: the two-sentence position

> **Stagecraft is the auditable agent SDLC that learns.** Gates are evidence — signed, exportable, regulator-shaped; and because every run emits structured outcomes, every run makes the next one better — across any host.

Neither half is owned by anyone today. Regulation is pushing enterprises toward the first half (EU CRA; GitLab reports 92% of organizations have AI-code governance gaps). The second half is enabled by research (ACE/GEPA/test-time scaling) that specifically requires the signal only Stagecraft's gate contract produces.

Explicitly **not** pursuing (reaffirmed): becoming an IDE, session UIs, sandbox fleets, first-party adapters for every agent (ACP instead), self-modifying rules without evals.

## 5. Roadmap at a glance

Delivery status added 2026-08-03. This review was written 2026-07-31; phases 28–31, 33,
and 34 shipped within three days of it, so the table below is a record of what was
proposed *and* what happened.

| Phase | Theme | Depends on | Size | Delivered? |
|---|---|---|---|---|
| [28](phase-28-ground-truth-telemetry.md) | Ground truth: token/cost telemetry, run corpus, Antigravity continuity | — | M | ✅ all 6 items |
| [29](phase-29-scale-adaptive-ceremony.md) | Scale-adaptive ceremony: loop track, assess-by-default, ceremony cost preview | — | M | ✅ all 5 items |
| [30](phase-30-closed-learning-loop.md) | Closed learning loop: auto-collect, outcome feedback, memory injection, reflector, SKILL.md export | 28 (corpus) | L | ✅ all 5 items |
| [31](phase-31-verification-depth.md) | Verification depth: per-role stamping, mechanical red-team, adversarial review pair, mutation gate | — | L | ✅ all 5 items |
| [32](phase-32-performance-parallelism.md) | Performance: cache-first prompts, stage DAG waves, model-tier routing, best-of-N | 28 (telemetry) | L | ⚠️ 32.1/32.3/32.5 shipped; **32.2 blocked on ADR-017**, **32.4 deferred** |
| [33](phase-33-eval-flywheel.md) | Eval flywheel: failed-gate evals, `devteam evals`, GEPA-style prompt optimization | 28, 30 | L | ✅ all 4 items |
| [34](phase-34-interop-auditable-sdlc.md) | Interop & compliance: ACP host, attestation export, control mapping | — | M | ✅ all 4 items |
| [35](phase-35-existing-codebase-mode.md) | Existing-codebase mode: review-only track, `devteam review-pr`, 06d stamping, findings report, refactor track | 31.4 | M | 🔲 written, not started |

Sequencing as originally proposed: **28 and 29 first** (28 unblocks everything downstream; 29 addresses the adoption risk). 30 and 31 next in either order. 32 after telemetry proves where time goes. 33 once corpus + learning loop exist. 34 opportunistic (28.6 covers the urgent Antigravity piece). This is roughly what happened, except 32 was run before 33/34 and left two items open.

Remaining work: accept ADR-017 and build stage waves (32.2), revisit 32.4 if a host adapter ever exposes worktree-isolated dispatch, then phase 35. Open items are tracked in [README.md](README.md#what-is-not-delivered-yet).

Success metrics (per phase details): orchestrator-observed cost on 100% of headless dispatches; median small-change run ≤ 5 stage slots and ≤ $2; pattern recurrence-after-injection measurably declining; ≥ 8 of 18 stages with mechanical verification; full-track wall clock −30%; a regression eval corpus that grows from real failures.

## 6. Sources

Landscape: [Spec Kit](https://github.github.com/spec-kit/) · [Fowler/Böckeler SDD tools](https://www.martinfowler.com/articles/exploring-gen-ai/sdd-3-tools.html) · [Kiro](https://byteiota.com/aws-kiro-replaces-amazon-q-developer-spec-driven-ide/) · [Tessl pivot](https://tessl.io/blog/how-tessls-products-pioneer-spec-driven-development/) · [BMAD v6 gaps](https://github.com/bmad-code-org/BMAD-METHOD/issues/2003) · [Zenflow](https://siliconangle.com/2025/12/16/zencoders-zenflow-gets-llms-verify-others-work-accelerate-ai-code-automation/) · [Agent HQ](https://github.blog/ai-and-ml/github-copilot/whats-new-with-github-copilot-coding-agent/) · [Gemini CLI → Antigravity](https://developers.googleblog.com/an-important-update-transitioning-gemini-cli-to-antigravity-cli/) · [ACP](https://zed.dev/acp) · [OpenHands ACP](https://www.openhands.dev/blog/use-any-coding-agent-in-openhands-with-acp) · [Managed Agents](https://claude.com/blog/claude-managed-agents).
Learning/perf: [ACE](https://arxiv.org/abs/2510.04618) · [GEPA](https://arxiv.org/pdf/2507.19457) · [Test-time scaling for agentic coding](https://arxiv.org/abs/2604.16529) · [Multi-agent value rethink](https://arxiv.org/html/2601.12307v1) · [Adversarial Review](https://openreview.net/forum?id=fOHvpLs6zp) · [Reviewer collusion](https://openreview.net/forum?id=CdZaamCf5Y) · [Mem0](https://mem0.ai/research-3) · [Claude Code auto memory](https://claudefa.st/blog/guide/mechanics/auto-memory) · [Skills as institutional knowledge](https://arxiv.org/html/2603.14805v1) · [Anthropic caching pricing](https://www.finout.io/blog/anthropic-api-pricing) · [Worktree parallelism](https://www.augmentcode.com/guides/git-worktrees-parallel-ai-agent-execution) · [Eval flywheel](https://www.arthur.ai/column/regression-test-datasets-ai-agents-production-failures).
Internals: this repo — `core/driver.js`, `core/orchestrator.js`, `core/verify/stamp.js`, `core/patterns.js`, `core/memory/`, `core/pricing.js`, `plans/pipeline-speed-opportunities.md`, `plans/adaptive-routing-evidence.md`, `plans/h3-ground-truth.md`, `docs/BACKLOG.md`, `docs/comparative-analysis.md`.
