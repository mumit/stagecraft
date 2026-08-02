# docs/

Navigation index for the `docs/` directory. Nothing here is load-bearing for a pipeline run — models read `AGENTS.md`, `rules/`, `roles/`, and `skills/` only.

## Evaluator — should we adopt?

- [comparative-analysis.md](comparative-analysis.md) — Stagecraft's Claude/Codex lineage and its position across delivery control, spec systems, methodologies, context systems, and agent runtimes including Omnigent
- [adoption-guide.md](adoption-guide.md) — pilot script, common objections, success criteria for the 2-week trial
- [presentation-notes.md](presentation-notes.md) — slide deck + speaker notes for pitching to a team or stakeholder
- [walkthroughs/soc2-evidence-collector.md](walkthroughs/soc2-evidence-collector.md) — end-to-end showcase: building a SOC 2 evidence collector through the full 18-stage pipeline
- [walkthroughs/stage-04-split-host.md](walkthroughs/stage-04-split-host.md) — multi-host contract stress-test trace

## Operator — I run pipelines daily

- [user-guide.md](user-guide.md) — daily-use reference: running stages, multi-host setups, headless mode
- [user-guide.md § Prototype first, harden later](user-guide.md#prototype-first-harden-later) — short prototype-mode tutorial using a token cost estimator example
- [tracks.md](tracks.md) — which of the seven tracks to pick for a given change, plus why prototype mode is a pre-SDLC workflow rather than a track
- [conventions.md](conventions.md) — pipeline markers operators read and write (`QUESTION:`, `BLOCKER:`, magic comments)
- [runbooks/README.md](runbooks/README.md) — troubleshooting index: symptom → runbook section
- [cost.md](cost.md) — cost tracking, pricing table, and budget workflow
- [faq.md](faq.md) — operational questions and common gotchas
- [git-workflow.md](git-workflow.md) — branch setup and PR timing for a Stagecraft pipeline run
- [ci.md](ci.md) — GitHub Actions workflow template and environment variables
- [reference/environment-variables.md](reference/environment-variables.md) — all environment variables Stagecraft reads, grouped by subsystem
- [memory.md](memory.md) — persistent project memory: embedder options and shared store
- [pattern-learning.md](pattern-learning.md) — project-local `devteam patterns` loop for turning reviewed blockers, warnings, follow-ups, auto-retry failures, and positive examples into bounded coding-agent guidance
- [observability.md](observability.md) — OpenTelemetry span schema and collector setup
- [capacity-strategy.md](capacity-strategy.md) — latency-aware routing, remote capacity, prompt caching, and persistent-session policy
- [evidence.md](evidence.md) — offline readiness, explicit resolution acceptance, and privacy-safe export
- [reproducibility.md](reproducibility.md) — gate fingerprint fields, replay readiness, drift detection
- [omnigent-runtime.md](omnigent-runtime.md) — Omnigent as a Stagecraft host runtime: adapter boundary, shipped slice, experimental director mode, and Phase 25 hardening pointer
- [runbooks/escalation.md](runbooks/escalation.md) — what to read and decide when `devteam next` says `resolve-escalation`
- [runbooks/fix-and-retry.md](runbooks/fix-and-retry.md) — fix-and-retry halt: red-team, QA, pre-review, peer-review (11 cases)
- [runbooks/open-followups.md](runbooks/open-followups.md) — extract ticket stubs from `open_followups[]` after a run
- [runbooks/deploy-failure.md](runbooks/deploy-failure.md) — Stage 8 failure: classify, diagnose, rollback, retry
- [runbooks/autonomous-run.md](runbooks/autonomous-run.md) — `devteam run`: bounded autonomous driver reference
- [../hosts/docker/README.md](../hosts/docker/README.md) — Docker-based headless runner for unattended local orchestration
- [runbooks/repair-flow.md](runbooks/repair-flow.md) — `devteam run --repair`: diagnosis gate approval, scope-gate FAIL recovery, tri-state reproduction
- [runbook-template.md](runbook-template.md) — template and guide for writing new runbooks

## Contributor — I change Stagecraft

- [guides/dogfooding.md](guides/dogfooding.md) — running Stagecraft against its own source tree: one-time setup, per-feature workflow, budget guidance
- [concepts.md](concepts.md) — six pipeline primitives (stage, role, workstream, host, gate, track) in one table
- [methodology.md](methodology.md) — ATDD loop, phase-gate progression, adversarial layer, four coding principles
- [FEATURES.md](FEATURES.md) — every shipped feature organized by area
- [BACKLOG.md](BACKLOG.md) — prioritized open ideas by bucket
- [TESTING.md](TESTING.md) — test structure and guidance
- [adr/README.md](adr/README.md) — architecture decision records index
- [adr/011-authenticated-gate-chain.md](adr/011-authenticated-gate-chain.md) — HMAC gate authentication, strict policy, and trust boundaries
- [adr/012-explicit-resolution-acceptance.md](adr/012-explicit-resolution-acceptance.md) — hash-bound human acceptance evidence for H3
- [adr/013-openai-compat-shell-execution.md](adr/013-openai-compat-shell-execution.md) — openai-compat shell execution: native bash tool, first-class host status
- [adr/014-docker-headless-runner.md](adr/014-docker-headless-runner.md) — Docker runner trust boundary and packaging decision
- [adr/015-workstream-scheduling.md](adr/015-workstream-scheduling.md) — per-host workstream concurrency, queue telemetry, and retry backoff reasons
- [adr/016-assess-by-default.md](adr/016-assess-by-default.md) — inline `assess()` inference on `devteam run` at any confidence, persisted to `pipeline/track.json`; supersedes ADR-006 §1
- [adr/017-dag-wave-execution.md](adr/017-dag-wave-execution.md) — curated `dependsOn[]` metadata, wave formation bounded by `autonomy.max_parallel_stages`, chain stays track-order (Proposed, pending review)
- [autonomous-execution-design.md](autonomous-execution-design.md) — design notes for the bounded autonomous driver (companion to ADR-003)
- [openai-compat-design.md](openai-compat-design.md) — options analysis and design notes for the openai-compat host adapter (companion to ADR-013)
- [../plans/phase-24-omnigent-runtime.md](../plans/phase-24-omnigent-runtime.md) — completed phased plan for Omnigent runtime integration
- [../plans/phase-25-omnigent-director-hardening.md](../plans/phase-25-omnigent-director-hardening.md) — proposed and parked plan for hardening the Omnigent director prototype
- [../plans/phase-26-performance-observability-usability.md](../plans/phase-26-performance-observability-usability.md) — proposed plan for critical-path telemetry, live run UX, verification speed, scheduling, and context/routing improvements
- [../plans/phase-27-pattern-learning.md](../plans/phase-27-pattern-learning.md) — proposed plan for project-local pattern learning from blockers, warnings, auto-retry outcomes, and positive examples
- [spec-authoring.md](spec-authoring.md) — writing AC-N criteria and scaffolding the spec file
- [migration-safety.md](migration-safety.md) — veto criteria, gate fields, and the migration heuristic
- [red-team.md](red-team.md) — 10 attack surfaces, gate fields, routing, and how it differs from security review
- [verification-beyond-tests.md](verification-beyond-tests.md) — property-based, mutation, and formal verification: candidates and skip policy
- [brief-template.md](brief-template.md) — section-by-section guide to filling out `pipeline/brief.md`
- [design-spec-template.md](design-spec-template.md) — section-by-section guide to filling out `pipeline/design-spec.md`
- [GAP-ANALYSIS.md](GAP-ANALYSIS.md) — archived gap analysis (redirect); active gaps tracked in BACKLOG.md

## Model — never reads docs/

Models read `AGENTS.md` + `rules/` + `roles/` + `skills/` only. Nothing in this directory is loaded during a pipeline run.
