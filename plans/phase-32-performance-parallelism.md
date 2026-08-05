# Phase 32 — Performance & Parallelism

Status: **mostly complete** (2026-08-05) — 32.1, 32.3, 32.5 shipped; 32.2 (ADR-017) accepted,
implementation scope moved to 32.6; 32.4 deferred.
From [landscape-review-2026-07.md](landscape-review-2026-07.md) §3.5;
supersedes the analysis-only [pipeline-speed-opportunities.md](pipeline-speed-opportunities.md)
items #1, #5, #10.
Depends on: Phase 28 (telemetry proves where time/money go; corpus feeds routing evidence).
Prompts: [prompts/roadmap-2026-prompts.md](prompts/roadmap-2026-prompts.md) §32.

| Item | Status |
|---|---|
| 32.1 Cache-first prompt assembly | ✅ complete (PR #360) |
| 32.2 Stage DAG waves (ADR) | ✅ complete — [ADR-017](../docs/adr/017-dag-wave-execution.md) **Accepted** 2026-08-05, scoped to exactly two curated regions (`{04a ∥ 04c}`, `{06b ∥ 06c ∥ 06d ∥ 06e}`), `autonomy.max_parallel_stages` default 2; wave-execution code is out of scope for this item and tracked as 32.6 |
| 32.3 Model-tier routing | ✅ complete (PR #362) |
| 32.4 Gate-verified best-of-N | ⏸ deferred — no host adapter (`hosts/*/adapter.js`) declares worktree-isolation capability, so the item's own precondition ("hosts with `worktrees: true`") can't be satisfied; nothing to build against yet |
| 32.5 context.md diet | ✅ complete (PR #363) |
| 32.6 Stage DAG wave execution (implementation) | 🆕 not started — concrete scope below, authorized by accepted ADR-017 |

## Why

A full-track run pays 18 sequential stage slots, 3,710–6,626 tokens of framework overhead
per dispatch with zero prompt caching, on a single model tier. The 2026 economics are
stark: cache reads are 90% off on both Anthropic and OpenAI; worktree parallelism measures
2.3–3.9×; frontier-plans/cheap-executes routing measures 40–70% cost cuts; and their own
speed analysis says waves alone cut the worst case from 18 slots to ~13. Build faster =
iterate the learning loop faster.

## Work items

### 32.1 Cache-first prompt assembly

Restructure rendered prompts into a stable-prefix layout, in this order: (1) framework
preamble + rules (constant per version), (2) role brief (constant per role), (3) learned
context — Known Project Patterns + Prior Project Knowledge (changes per run, not per
stage), (4) volatile tail — stage objective, readFirst, changed-file manifest, gate shape
(changes per dispatch). Byte-stable sections 1–2 across every dispatch in a run make the
prefix cacheable by providers and CLIs automatically.

For `openai-compat` against Anthropic-compatible endpoints, emit `cache_control`
breakpoints after sections 1, 2, 3 when the config enables it; OpenAI-style endpoints get
prefix caching for free from the ordering. Record `cached_tokens` (28.2) so the report
can show cache hit economics. Add a prompt-layout regression test asserting sections 1–2
are byte-identical across two different stages of the same run.

- Acceptance: layout test passes; prompt-budget doc regenerated; measured
  `cached_tokens > 0` on a stubbed cache-aware endpoint fixture.
- Verify: `npm test`, `CI=true DEVTEAM_HEADLESS_COMMAND=cat npm test`, `npx eslint .`,
  `npm run consistency`.

### 32.2 Stage DAG waves (ADR required) — ✅ complete, decided 2026-08-05

Write ADR-017: stage dependency metadata (`dependsOn: []` on the STAGES table, derived
initially from `readFirst`/artifact-flow analysis) and wave execution semantics — the
driver dispatches all ready stages whose dependencies hold PASS/WARN gates, bounded by
`autonomy.max_parallel_stages` (default 2). First wave targets, per the existing speed
analysis: {04a lint/tests ∥ 04c red-team} and {06b ∥ 06c ∥ 06d ∥ 06e} (or the 29.4
folded slot ∥ 06). Gate chain: predecessor remains *track order*, unchanged — the chain
records order-of-record, waves change execution time only. `run-log.jsonl` gains
`wave_id`; `devteam performance critical-path` reports realized (not estimated)
parallel savings. Failure in any wave member halts the wave per existing failure classes;
`fix-and-retry` clears only the failing member.

- Acceptance: stubbed full-track run makes ≤13 sequential slots; single-stage semantics
  (locks, heartbeat, stall probe) hold per wave member; chain verification still passes;
  `--max-iterations` accounting documented (a wave = 1 iteration).

**Resolved 2026-08-05** ([phase-37](phase-37-interface-and-token-efficiency.md) item 37.6):
[ADR-017](../docs/adr/017-dag-wave-execution.md) is **Accepted**, scoped to exactly the two
curated regions named above (`{04a ∥ 04c}` requires trimming `stage-04c`'s `readFirst`
first; `{06b, 06c, 06d, 06e}` needs no `readFirst` changes) with
`autonomy.max_parallel_stages` defaulting to 2, not the region size (4) — see the ADR's
Resolution section for why. The acceptance criteria above (≤13 slots, per-member
single-stage semantics, chain verification, iteration accounting) are unmet until 32.6
ships; they now have a terminal design to build against instead of an open ADR.

### 32.6 Stage DAG wave execution (implementation of accepted ADR-017)

Follow-up to 32.2, added 2026-08-05 per [ADR-017](../docs/adr/017-dag-wave-execution.md)'s
Resolution. Build exactly what the accepted ADR authorizes — no more:

- `core/pipeline/stages.js`: `dependsOn: ["build"]` on `red-team` (stage-04c);
  `dependsOn: ["qa"]` on each of `accessibility-audit`, `observability-gate`,
  `verification-beyond-tests`, `performance-budget` (stage-06b/06c/06d/06e); trim
  `stage-04c`'s `readFirst` to drop `pipeline/pre-review.md` and
  `pipeline/security-review.md` in the same PR (this is a model-visible prompt change —
  call it out in the changelog entry, not buried inside "added `dependsOn`," per the ADR's
  Consequences section). Add a code comment on the `dependsOn` field stating that adding a
  new wave region requires its own readFirst-vs-`dependsOn` curation pass (ADR-017
  Resolution §3), not a mechanical extension.
- `core/orchestrator.js`: a wave-aware variant of `next()` that returns the full ready set
  (bounded by `autonomy.max_parallel_stages`) as a thin wrapper calling the existing
  single-stage readiness check per candidate — not a parallel reimplementation.
- `core/scheduler.js`: extend `mapByHostConcurrency`'s keying for wave-member × host
  double-keying; no second scheduler.
- `core/driver.js`: one `Promise.race([dispatch, stallProbe])` pair per wave member;
  `wave_id` (monotonic per run) assigned once per formed wave and attached to every member
  event; `state.iterations` incremented once per wave, not per member; `fix-and-retry`
  targets only the failing member, never touching a passing sibling's gate.
- `core/config.js`: `autonomy.max_parallel_stages`, default `2`, validated like
  `max_retries` (non-negative integer, falls back to default on invalid input).
- `devteam performance critical-path`: realized-savings computation
  (`sum(member durations) - max(member durations)`) grouped by `wave_id`.
- Docs: `docs/runbooks/autonomous-run.md` gains a wave section; `.devteam/config.yml`
  schema docs gain `autonomy.max_parallel_stages`; `run-log.jsonl` schema reference gains
  `wave_id`.

- Acceptance: stubbed full-track run makes ≤13 sequential slots; single-stage semantics
  (locks, heartbeat, stall probe) hold per wave member; chain verification still passes;
  `--max-iterations` accounting documented and tested (a wave = 1 iteration); a wave of one
  member behaves identically to today's dispatch (regression-tested).

### 32.3 Model-tier routing

Extend routing config with per-role/per-stage `model:` (adapters already accept model
overrides in several paths — unify): `routing.roles.qa: {host: claude-code, model:
claude-haiku-4-5-20251001}`. Ship a documented `tiers` preset: frontier for
design/principal/red-team/reviewer, mid for build, small for mechanical stages (lint-fix
follow-ups, docs, retro). Escalation-on-failure: a `fix-and-retry` of a small-model
dispatch may bump one tier (config `routing.escalate_on_retry: true`), recorded in the
gate. `scripts/routing-suggest.js` gains a cost column from the corpus so suggestions
become "(role,host,model)" not just "(role,host)".

- Acceptance: routed model reaches the adapter command line / API body on all headless
  hosts; retry escalation recorded; suggest report shows per-tier cost deltas.

### 32.4 Gate-verified best-of-N (opt-in, worktree-isolated)

`devteam stage <name> --best-of N` (and config per stage): N parallel attempts in
isolated worktrees (hosts with `worktrees: true`; refuse otherwise), each producing a
candidate gate; the orchestrator stamps each candidate (Phase 31 machinery) and selects
the winner — first PASS, tie-broken by fewest blockers then lowest cost. Loser worktrees
are archived to `pipeline/attempts/` (prompt+gate only, not full trees). This
operationalizes the test-time-scaling result (verified best-of-N: +7pp-class gains)
using gates as the verifier. Default N=1 everywhere; recommend for stages whose corpus
retry rate exceeds a threshold (`devteam performance critical-path` names candidates).

- Acceptance: stubbed best-of-3 with one passing candidate selects it and archives
  losers; all-fail behaves like today's single FAIL (one fix-and-retry cycle, not N);
  cost accounting sums all attempts honestly.

### 32.5 context.md diet: rolling digest + delta handoffs

[verify-first] Claim: `pipeline/context.md` grows via append-and-strip marker sections,
every stage rereads the whole file, and the FAQ concedes "a 300-line context.md adds
thousands of tokens per stage."

Implement: (a) a size budget (default 8 kB) enforced at validator write time — when
exceeded, oldest resolved marker sections auto-compact (the `devteam compact` logic,
scoped) into a one-line digest with a pointer to the archived full text under
`pipeline/context-archive/`; (b) stage prompts include a "changed since your last
dispatch" delta section (which marker sections were added/removed since the workstream's
previous dispatch, from run-log) so models stop re-reading unchanged context.

- Acceptance: seeded oversize context compacts deterministically with archive
  round-trip; delta section correct across a retry sequence; `devteam compact` still
  works for full manual strips.

## Out of scope

Persistent host sessions across stages (speed item #10's second half — needs per-host
session semantics work), speculative execution of not-yet-ready stages, cloud runner
(A3/Phase 21), replacing the scheduler (per-host concurrency caps already exist and
compose with waves).

## Success signal

On the corpus: full-track wall clock down ≥30% (waves + parallel QA), per-dispatch paid
input tokens down ≥50% on cache-supporting hosts, and a documented tier preset that cuts
run cost materially with no gate pass-rate regression (now measurable, thanks to 28).
