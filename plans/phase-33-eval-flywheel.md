# Phase 33 — Eval Flywheel & Prompt Optimization

Status: **complete** (2026-08-03) — 33.1/33.2/33.3/33.4 shipped
(from [landscape-review-2026-07.md](landscape-review-2026-07.md) §3.6;
makes BACKLOG bet #3 concrete — eval coverage is what limits how fast this project can
safely change its own prompts).
Depends on: Phase 28 (corpus), Phase 30 (learning loop) recommended first.
Prompts: [prompts/roadmap-2026-prompts.md](prompts/roadmap-2026-prompts.md) §33.

| Item | Status |
|---|---|
| 33.1 Failed gates become eval cases | ✅ complete — `core/evals/capture.js`, `.devteam/evals/cases/` + `blobs/`, run-end resolution-linker, `devteam evals gc` |
| 33.2 `devteam evals run` — the replay harness | ✅ complete — `core/evals/run.js`, `devteam evals run [--stub \| --headless-host <h>]`, CI job over `tests/fixtures/evals/` |
| 33.3 Prompt-pack versioning | ✅ complete — `core/prompt-pack.js`, `core/evals/compare.js`, `devteam evals compare --pack <A> --pack <B>` |
| 33.4 GEPA-style offline prompt optimization | ✅ complete — `scripts/prompt-optimize.js` (out-of-band, not a `devteam` command) |

## Why

CI's "model" is `cat`: 2,307 tests prove the control plane and zero tests prove agent
behavior. Every prompt/role/pattern change ships evidence-free. Meanwhile the flywheel
pattern is settled practice in 2026 — production failure → replayable case → regression
suite → nothing ships that re-breaks it — and Stagecraft's failed gates are *already*
structured failure records. Downstream, GEPA-style reflective prompt evolution (ICLR
2026 oral; ~13% over MIPROv2 at 35× fewer rollouts) needs exactly two things per case:
a scalar outcome and textual feedback. Gate status and blocker text are those two
things. No competing framework produces this data, so it is the hardest capability here
for anyone else to copy.

## Work items

### 33.1 Failed gates become eval cases

On any gate FAIL/ESCALATE (and on stamp overrides — model said PASS, orchestrator said
FAIL, the most valuable class), capture a replayable case under `.devteam/evals/cases/`:
the rendered prompt (or its reproducibility hash + inputs to re-render), the readFirst
artifact snapshots (content-addressed, deduped), the failing gate, and the eventual
resolution (which retry/fix cleared it — linked via run-log). Sanitize through the
secret-scan path. Opt-out flag for proprietary-source projects
(`evals.capture: false`). Cases are local by default, exportable via the Phase 16
evidence privacy machinery.

- Acceptance: a stubbed FAIL produces a complete case directory; stamp-override capture
  works; disabled flag captures nothing; secrets never land in a case.
- Verify: `npm test`, `CI=true DEVTEAM_HEADLESS_COMMAND=cat npm test`, `npx eslint .`,
  `npm run consistency`.

### 33.2 `devteam evals run` — the replay harness

Replay captured cases against the *current* framework (current role briefs, rules,
patterns, prompt layout): re-render the prompt from the case's inputs, dispatch to a
configured host (or `--stub` for structural checks: does the prompt still render, do the
injected patterns/knowledge sections appear, is the budget respected), validate the
resulting gate, and score: resolved-class cases should PASS, regression = a previously
resolved case failing again. Output: pass/fail table + JSONL for CI. `--headless-host`
selects the model host; cost preview before a real-model sweep (29.3 machinery).
Structural mode (`--stub`) is free and becomes a CI job on this repo's own fixture
corpus.

- Acceptance: stub mode runs the fixture corpus in CI; real mode replays a case
  end-to-end against a scripted DEVTEAM_HEADLESS_COMMAND; regression detection fires on
  a seeded re-break.

### 33.3 Prompt-pack versioning

Give the prompt surface (role briefs, rules, templates, injection sections) a single
version stamp: `prompt_pack_version` derived from a content hash of `roles/ + rules/ +
templates/` (the consistency script already hashes prompt budgets — extend it), recorded
on every gate and corpus row (28.5). `devteam evals run --compare <versionA> <versionB>`
filters corpus outcomes by pack version so "did the new principal brief help?" is a
query, not a feeling. This is C4 reproducibility's missing consumer.

- Acceptance: version changes when any role brief changes; gates/corpus carry it;
  compare mode reports per-stage pass-rate deltas between packs.

### 33.4 GEPA-style offline prompt optimization (experimental, human-gated)

`scripts/prompt-optimize.js` (out-of-band, like `scripts/budget.js` — deliberately not a
`devteam` command yet): given the corpus + eval cases for one target (a single role
brief or stage-prompt section), run a reflective optimization loop — sample failures,
have a frontier model diagnose in natural language, propose a revised brief, score
against `devteam evals run --stub` + a bounded real-model eval subset, keep a small
Pareto set of candidates. Output: a proposed diff + evidence table (pass-rate before/
after on the eval subset, token delta). **Never auto-applies** — the human reviews the
diff like any PR, and 33.3 versioning tracks the outcome in production. Budget-capped
(`--budget-usd` mandatory).

- Acceptance: end-to-end on a fixture corpus with a scripted model produces a diff +
  evidence table; refuses to run without a budget cap; no file outside the target brief
  is proposed for change.
- VERIFY-FIRST finding: every host adapter renders a role brief or rule file as a path
  pointer, never inlined content (`core/adapters/markdown-host.js`,
  `hosts/claude-code/adapter.js`) — so a candidate's content never changes the rendered
  dispatch prompt, only what a real host reads from disk. "Within prompt budget" is
  therefore checked via `scripts/prompt-budget.js`'s byte accounting (which the
  candidate's size DOES change), not the rendered-prompt structural check (which is
  content-invariant for this reason and is run once as a sanity floor). The candidate's
  real behavioral effect is measured only by the bounded real-model subset, where it is
  patched into a scratch project a live host CLI actually reads.

## Out of scope

Auto-applying optimized prompts (evidence first — this phase *creates* the evidence
mechanism), SWE-bench-style public benchmarking (private per-repo evals dodge
contamination; the 2026 reward-hacking findings justify this), optimizing gate schemas
themselves.

## Success signal

This repo's CI runs structural evals on every PR; a real project accumulates cases from
its own failures; and the first prompt-pack change justified by an evals-compare table
lands — at which point Stagecraft's prompts are empirically maintained, which no
competing framework can claim.
