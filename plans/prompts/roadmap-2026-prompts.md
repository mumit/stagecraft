# Stagecraft Execution Prompts — Phases 28–37 (2026-H2 Roadmap)

Companion to [landscape-review-2026-07.md](../landscape-review-2026-07.md),
[experience-review-2026-08.md](../experience-review-2026-08.md), and the
phase plans `plans/phase-28-*` … `plans/phase-37-*`. Same execution model as
[ALL-PROMPTS.md](ALL-PROMPTS.md): paste the **PREAMBLE** (§0) plus one item prompt into a
fresh Claude (Sonnet) session at the repo root. One item = one session = one branch = one PR.

Status legend: ✅ executed and merged · 🔲 ready to run · ⏸ blocked (see dependency).

| Phase | Theme | Items | Status |
|---|---|---|---|
| 28 | Ground truth: telemetry, corpus, host continuity | 28.1–28.6 | ✅ complete |
| 29 | Scale-adaptive ceremony | 29.1–29.5 | ✅ complete (29.2 landed ADR-016) |
| 30 | Closed learning loop | 30.1–30.5 | ✅ complete |
| 31 | Verification depth | 31.1–31.5 | ✅ complete |
| 32 | Performance & parallelism | 32.1–32.5 | ⚠️ 32.1 ✅ · 32.2 ⏸ ADR-017 drafted only (status Proposed), wave execution not built · 32.3 ✅ · 32.4 ⏸ deferred, no host adapter exposes worktree-isolation capability · 32.5 ✅ |
| 33 | Eval flywheel & prompt optimization | 33.1–33.4 | ✅ complete |
| 34 | Interop & auditable SDLC | 34.1–34.4 | ✅ complete |
| 35 | Existing-codebase mode | 35.1–35.5 | ✅ complete |
| 36 | External review mode (ACP-first) | 36.0–36.6 | ✅ complete |
| 37 | Interface & token efficiency | 37.1–37.6 | 🔲 ready — **adds no capability by design** |

Only two items from phases 28–35 remain open: **32.2** (needs ADR-017 accepted first —
it is written but still Proposed) and **32.4** (deferred; no host adapter exposes
worktree-isolated dispatch, so the item's own precondition cannot be met). Phase 36 is
ready, but 36.0 is a report-only spike whose answer decides how 36.2 is built — run it
first and do not implement in the same session. Items within a phase are independently
mergeable unless the item says otherwise.

**Verify before running an item.** Implementation sessions do not update this table, so
it can lag: `git log --no-merges --oneline --reverse a8e071a..main` lists what has
actually landed, and [../README.md](../README.md#what-is-not-delivered-yet) tracks open
work.

---

## 0. PREAMBLE (paste first, verbatim, before every item prompt)

```
You are implementing exactly one pre-approved work item in the Stagecraft repository
(current directory). Stagecraft is a Node.js CLI (`devteam`) that orchestrates AI coding
tools through a gated, tracked pipeline. The work item is specified below and in a plan
file under plans/ — the plan file is the authoritative spec; read its referenced section
in full before touching any code. Also skim plans/landscape-review-2026-07.md §3 for the
strategic intent behind this phase.

Hard rules:
1. SCOPE: implement only this item. If you notice other problems, list them under
   "Out-of-scope findings" in your final report. Do not fix them.
2. PRECONDITIONS: if the item lists a PRECONDITION CHECK, run it first and STOP with a
   report if any check fails.
3. VERIFY-FIRST: any step marked [verify-first] is a claim that must be confirmed by
   reading the code before editing. If the claim does not hold, STOP all work on that
   step and report what you actually found. Do not "fix" code that already works.
4. LINE NUMBERS and file references in plan files are anchors verified 2026-07-31.
   Always locate the quoted code by searching; never edit by line number alone.
5. TESTS: run `npm test`, `CI=true DEVTEAM_HEADLESS_COMMAND=cat npm test` (mirrors
   GitHub Actions exactly), `npx eslint .`, and `npm run consistency` before and after.
   All green when you finish. Never weaken, skip, or delete an existing test to make
   your change pass; if a test legitimately encodes OLD behavior this item changes,
   update it and call that out explicitly.
6. NEW BEHAVIOR NEEDS A TEST: the change must be covered by at least one test that
   fails without it. Telemetry/learning writes must additionally have a test proving
   they NEVER fail the run when they error (fire-and-forget contract).
7. TEST HYGIENE: tests that spawn subprocesses must explicitly control every env var
   the code under test reads (especially CI). Tests must never read or write repo-root
   state — per-test mkdtempSync tempdirs with the devteam-test- guard
   (tests/_helpers.js). Never point test cwd at the real repo. Meta-tests must never
   assert exact state of the live repo tree — use fixture trees.
8. SOURCE OF TRUTH: core/pipeline/stages.js is canonical for stages/gates/tracks.
   Prose follows code, never the reverse — EXCEPT if prose describes BETTER behavior
   than code implements: flag it, don't silently align.
9. CONVENTIONS: comments explain *why* and cite plan/ADR/backlog IDs (house style:
   core/driver.js header). Match surrounding code style. Preserve the project's candid
   tone in prose; never delete a limitation or caveat while moving content. New
   model-visible prompt text must respect existing prompt-budget discipline
   (docs/reference/prompt-budget.md; consistency fails on >10% growth — if you must
   exceed it, say so and stop).
10. TRUST BOUNDARY: anything the model writes (gates, artifacts, self-reported cost)
    is a claim; anything the orchestrator observes (exit codes, parsed CLI/API output,
    command results) is truth. New fields must record which side produced them —
    follow the `_orchestrator_stamped` / `_orchestrator_observed` pattern in
    core/verify/stamp.js. Never let a model-asserted value overwrite an observed one.
11. GIT: create the branch named in the item (from main unless stated otherwise).
    Commit with a conventional-commit message ending:
    Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>
    Do NOT push, do NOT open a PR, do NOT merge, do NOT switch branches at the end.
12. CHANGELOG: add a fragment file under changelog.d/ matching existing style, with an
    "Honest scope note" line if limitations remain.
13. STOP CONDITIONS — stop and report rather than improvise if: a [verify-first] claim
    fails; the change requires editing more than ~3 existing tests beyond any the item
    authorizes; you need to modify a file the item doesn't mention and can't justify in
    one sentence; npm test fails for reasons unrelated to your change.

Final report format (this is your last message — it is the deliverable):
- WHAT CHANGED: file list with one line each.
- EVIDENCE: the exact verification commands run and their results (paste test counts).
- TESTS ADDED/UPDATED: names and what each proves; pre-existing tests touched + why.
- VERIFY-FIRST RESULTS: each claim → confirmed / not-confirmed + what you found.
- DEVIATIONS from the plan item, if any, with justification.
- OUT-OF-SCOPE FINDINGS, if any.
- The commit hash(es).
```

---

## Phase 28 — Ground Truth 🔲

### 28.1 claude-code observed usage 🔲

```
TASK: Implement plans/phase-28-ground-truth-telemetry.md item 28.1 — orchestrator-observed
token/cost telemetry for the claude-code headless path.
Branch: feat/claude-code-usage-telemetry

[verify-first] The claude-code headless invocation (see hosts/claude-code/ and
core/adapters/headless.js) uses `--print` with no `--output-format`, so usage metadata
is discarded. Confirm by reading how headlessCommand is built and how runHeadless
consumes stdout.

Implement: request stream-json output from the claude CLI (check `claude --help` for the
current flag set — likely `--output-format stream-json --verbose`), parse the stream for
the final result message's usage (input_tokens, output_tokens, total_cost_usd, model),
and return them on the runHeadless result. The ORCHESTRATOR writes tokens_in/tokens_out/
cost_usd/model_observed into the workstream gate under `_orchestrator_observed` (mirror
the `_orchestrator_stamped` pattern in core/verify/stamp.js — preserve model-asserted
fields, observed wins for any consumer). Text content of the stream must still be teed
to pipeline/logs/<workstreamId>.log so transcripts stay readable.

Degradation contract: if the output is not parseable JSON (older CLI, plain text), keep
today's behavior and set telemetry:"unavailable" on the result. A telemetry failure must
NEVER fail a dispatch — add the test proving it.

Tests: stream-json fixture via DEVTEAM_HEADLESS_COMMAND pointing at a script that emits
a realistic stream; plain-text fixture for degradation; gate contains observed fields;
log file still contains the transcript text.
Do not touch other adapters (28.2/28.3 cover them).
```

### 28.2 openai-compat usage accumulation 🔲

```
TASK: Implement plans/phase-28-ground-truth-telemetry.md item 28.2 — record API `usage`
across the openai-compat tool loop.
Branch: feat/openai-compat-usage

[verify-first] hosts/openai-compat/invoke.js receives `usage` on each chat-completion
response and never reads it. Confirm by reading invoke.js end to end.

Implement: accumulate prompt_tokens / completion_tokens (and
prompt_tokens_details.cached_tokens when present) across ALL iterations of the loop;
return totals on the invoke result; the orchestrator writes `_orchestrator_observed`
(same shape as 28.1 — if 28.1 hasn't merged, create the shared writer in
core/orchestrator.js and note it). Compute cost_usd via core/pricing.js computeCostUsd;
unknown model → cost_usd null, never a guess.

Tests: extend the existing openai-compat stub-server suite (tests/openai-compat-*.test.js)
with a multi-turn tool-loop case asserting summed usage including cached_tokens, and an
absent-usage case degrading to telemetry:"unavailable".
```

### 28.3 codex + gemini/antigravity usage-or-estimate 🔲

```
TASK: Implement plans/phase-28-ground-truth-telemetry.md item 28.3 — usage capture where
the host CLI reports it, labelled estimates otherwise.
Branch: feat/host-usage-estimates

Investigate (and record findings in the PR-ready report): does `codex exec` offer JSON
output with usage? Does the gemini/antigravity binary? Implement native capture where
available (same `_orchestrator_observed` contract as 28.1/28.2). Where unavailable,
record {tokens_estimated: true, tokens_in_estimate} using a promptBytes/4 heuristic —
the flag is mandatory so downstream consumers (routing-suggest, corpus, report) can
filter estimated rows; never mix estimated and observed without it.

Add `telemetry: "native" | "estimated"` to each host's capabilities.json and update
tests/adapter-contract.test.js to require the field on all adapters (claude-code and
openai-compat = native once 28.1/28.2 land; set honestly per adapter today otherwise).

Tests: per-adapter fixtures for the paths you implement; contract test update; the
estimate heuristic unit-tested.
```

### 28.4 Budget enforcement on observed cost 🔲

```
TASK: Implement plans/phase-28-ground-truth-telemetry.md item 28.4 — `--budget-usd`
prefers orchestrator-observed cost.
Branch: feat/budget-observed-cost

[verify-first] driver.totalCostUsd() (core/driver.js) sums gate.cost_usd, which is
model-written. Confirm, and map every consumer of that total (budget check, status,
report).

Implement: totalCostUsd prefers `_orchestrator_observed.cost_usd` per gate, falling back
to model-asserted cost_usd; the run records cost_basis ("observed" / "model-asserted" /
"mixed") once per run in run-state.json with a single run-log warning when any asserted
values are included. `devteam status` and `devteam report` display the basis. Do not
change halt semantics or the pre-dispatch check logic (ADR-003 refinement of decision #8
stands).

Tests: mixed-gate fixture (observed + asserted) sums correctly and reports "mixed";
pure-observed reports "observed"; report/status render the basis.
```

### 28.5 Run corpus 🔲

```
TASK: Implement plans/phase-28-ground-truth-telemetry.md item 28.5 — one sanitized JSONL
record per headless dispatch, plus `devteam corpus stats`.
Branch: feat/run-corpus

After every headless dispatch completes (success or failure), append one line to
.devteam/corpus/dispatches.jsonl: {ts, run_id, stage, role, host, model_observed, track,
prompt_hash, prompt_bytes, tokens_in, tokens_out, cost_usd, cost_basis, duration_ms,
queue_ms, gate_status, blockers (sanitized via the same secret-scan path
core/patterns.js collection uses), retry_of, framework_version}. Fields missing from a
given dispatch are null, never omitted. Corpus writes are fire-and-forget: an
unwritable corpus directory logs one warning and never fails the run (test this).

Add .devteam/corpus/ to the managed gitignore block (see ADR-010 / devteam init
managed block code). New command `devteam corpus stats [--json]`: total dispatches,
per-stage pass rates, per-(role,host) dispatch counts — worded to answer the D5/H3
evidence-gate questions in docs/BACKLOG.md directly. Wire scripts/routing-suggest.js to
accept the corpus as an additional data source alongside gate archives.

Tests: stubbed multi-stage run produces one line per dispatch with correct fields;
planted secret in a blocker never reaches disk; stats aggregates a fixture corpus;
unwritable-dir case. Update docs/observability.md with a short corpus section.
```

### 28.6 Antigravity host adapter 🔲

```
TASK: Implement plans/phase-28-ground-truth-telemetry.md item 28.6 — Antigravity CLI
host continuity (Gemini CLI is being sunset; it stopped serving free/Pro/Ultra requests
2026-06-18).
Branch: feat/host-antigravity

Add hosts/antigravity/ as a thin shell over makeMarkdownHostAdapter (follow
hosts/gemini-cli/adapter.js and hosts/codex/adapter.js as the pattern — expect ~40
lines + capabilities.json + install payload dirs). Research the antigravity CLI's
actual binary name, headless invocation flags, and skills/prompt directory layout from
its public docs before writing the capabilities — record what you found and its source
in the report. Declare capabilities honestly (headless only if verified; worktrees/
goalLoop false unless documented).

devteam doctor: when routing resolves any role/stage to gemini-cli, warn that the host
is deprecated upstream and suggest `--host antigravity` (pattern: existing doctor
host-CLI-on-PATH checks). Do NOT remove or break gemini-cli (retirement is 34.4).
Update: docs/user-guide.md multi-host section, README host lists, and every place the
consistency checker requires host enumeration (run `npm run consistency` to find them).

Tests: adapter-contract coverage for the new adapter; init roundtrip on a tmpdir;
doctor warning fixture.
```

---

## Phase 29 — Scale-Adaptive Ceremony 🔲

### 29.1 `loop` track 🔲

```
TASK: Implement plans/phase-29-scale-adaptive-ceremony.md item 29.1 — a 4-slot `loop`
track: brief → build → verify → review.
Branch: feat/track-loop

In core/pipeline/stages.js STAGES_BY_TRACK add `loop`: stage-01 (minimal brief),
stage-04 (single-workstream build — decide and document which single role, default
backend, config-overridable), stage-06 (QA — already orchestrator-stampable), stage-05
(single-reviewer). Reuse existing stage definitions and schemas unchanged. Add a
one-screen loop brief template under templates/ (intent, AC-N list, affected files) and
route stage-01 to it on this track only.

Constraints: consequence ceiling untouched (loop has no sign-off/deploy — `devteam run
--track loop` ends at review; document that promotion to deploy = re-run with --until on
a bigger track or a config'd custom_stages). verify-chain must pass on the short track
(nearest-earlier-gate predecessor logic should already handle it — add the test).
Update docs/tracks.md and every stage-count claim the consistency checker flags.

Tests: full stubbed loop run = exactly 4 dispatches to pipeline-complete; chain verify
green; track selection plumbing (assess keywords NOT in scope — 29.2).
```

### 29.2 Assess-by-default 🔲

```
TASK: Implement plans/phase-29-scale-adaptive-ceremony.md item 29.2 — `devteam run`
with no track runs assess inline and proceeds with inferred provenance.
Branch: feat/assess-by-default

[verify-first] Trace what `devteam run` does today when neither --track nor
pipeline/track.json exists (core/driver.js + core/cli/commands/run.js + ADR-006
provenance in devteam assess). Confirm the assess heuristics live in a callable module
(not just the CLI command) — if not, extract without behavior change first.

Implement: no-track + no-track.json → run assess heuristics inline, print
recommendation + rationale (+ ceremony preview once 29.3 lands — if it hasn't, print
slots/dispatch counts only and leave a TODO citing 29.3), write pipeline/track.json
with source:"inferred", proceed. Explicit --track wins and records source:"human".
No interactive prompt anywhere (CI-identical behavior). The existing unconfirmed-track
guard semantics must be preserved exactly — read its tests first.

Tests: the three paths (no-track infers; --track is human; existing track.json
respected), plus assess-inline output snapshot.
```

### 29.3 Ceremony cost preview 🔲

```
TASK: Implement plans/phase-29-scale-adaptive-ceremony.md item 29.3 — per-track ceremony
cost preview in assess and pre-run output.
Branch: feat/ceremony-preview

Static basis: per-dispatch framework overhead numbers are generated into
docs/reference/prompt-budget.md — find the generator (scripts/consistency.js prompt-
budget sync references it) and read the machine source it uses rather than parsing the
doc. Estimate per track: stage slots, dispatch count (respect track shape + fanout
config), token range (framework overhead + sampled sizes of existing pipeline/ artifacts
when present), cost range via core/pricing.js against currently-routed models (unknown
model → show tokens only, never invent dollars).

Empirical basis: when .devteam/corpus/dispatches.jsonl (28.5) has ≥5 runs of the same
track, use median observed tokens/cost instead and label estimate_basis:"empirical" vs
"static". Surface in `devteam assess` (text + --json) and at the top of `devteam run`
pre-flight output. Every number is labelled an estimate (house honesty rules).

Tests: static estimates for two tracks from a fixture project; empirical path from a
fixture corpus; unknown-model path shows tokens without dollars.
PRECONDITION CHECK: 28.5 merged (corpus exists) — if not, implement static-only and mark
the empirical branch with a guarded TODO citing 28.5; say so in the report.
```

### 29.4 Fold specialty QA on small tracks 🔲

```
TASK: Implement plans/phase-29-scale-adaptive-ceremony.md item 29.4 — render 06b/06c/06d/06e
as one combined verification-sweep dispatch on compact tracks.
Branch: feat/compact-qa-fold

[verify-first] Confirm which tracks include stages 06b (a11y), 06c (observability),
06d (verification-beyond-tests), 06e (performance-budget) in STAGES_BY_TRACK, and that
each is currently a separate sequential dispatch with its own gate schema.

Implement: a track-level `compact_qa: true` flag (set it on `quick`). When set, the
orchestrator plans ONE workstream for a new stage-06x ("verification sweep") in place of
the four; its gate schema embeds the four existing shapes as optional sections (new
schema file core/gates/schemas/stage-06x.schema.json; validator must accept both the
folded and unfolded forms depending on track). Full track unchanged — byte-identical
prompts (add the regression test). Right-sizing skip logic must still be able to skip
the folded slot. devteam next / merge / summary must handle 06x like any stage.

Tests: quick-track stubbed run makes 1 dispatch where it made 4; full-track prompt
byte-comparison; validator both-shapes; consistency stage/schema enumeration checks
updated (the checker WILL flag the new stage — follow what it says).
```

### 29.5 Docs: loop as default, full as audited path 🔲

```
TASK: Implement plans/phase-29-scale-adaptive-ceremony.md item 29.5 — reposition docs.
Branch: docs/scale-adaptive-positioning

PRECONDITION CHECK: 29.1 merged (loop track exists). Update README.md (Quick start
shows loop first; "which track" decision table with ceremony-cost column referencing
29.3 output), docs/tracks.md, docs/user-guide.md, docs/adoption-guide.md: loop is the
day-to-day default; full is the AUDITED path chosen when stakes/compliance justify it
(forward-reference the Phase 34 evidence story in one sentence, marked as roadmap).
Preserve every existing caveat and the candid tone; this is a repositioning, not a
marketing pass. Run `npm run consistency` — the doc drift checks are the acceptance
gate here. No code changes.
```

---

## Phase 30 — Closed Learning Loop 🔲

### 30.1 Auto-collect + retirement suppression 🔲

```
TASK: Implement plans/phase-30-closed-learning-loop.md item 30.1 — patterns collect at
run end, retired keys suppressed at collection.
Branch: feat/patterns-autocollect

[verify-first] (a) core/patterns.js collect() has zero callers outside
core/cli/commands/patterns.js; (b) collection does not consult retired patterns, so a
retired pattern_key can re-enter candidates from the same observations. Confirm both.

Implement: core/driver.js calls collect() on pipeline-complete AND on any halt where ≥1
gate was written this run — fire-and-forget (try/catch → one run-log event
`pattern-collect-failed`, never affects exit code; test this contract). collect() loads
retired.json and drops candidates whose identity hash matches a retired pattern,
counting them in the collect summary as suppressed. `devteam patterns collect` CLI
unchanged for manual/backfill.

Tests: stubbed run with a FAIL→retry ends with candidates on disk, no manual step;
retired-key suppression; collect-throws-run-unaffected.
```

### 30.2 Outcome-feedback counters 🔲

```
TASK: Implement plans/phase-30-closed-learning-loop.md item 30.2 — wire the inert
injected/recurrence/noise counters and the demotion flow from docs/pattern-learning.md.
Branch: feat/patterns-feedback

[verify-first] stats.injected, recurrence_after_injection, noise_reports in
core/patterns.js are initialized at promotion and never incremented anywhere
(grep the repo). docs/pattern-learning.md specifies decay/demotion driven by them.

Implement: (a) orchestrator increments stats.injected for each pattern included by
selectForDescriptor() at DISPATCH time (headless execute or prompt print — not at
preview/render-only paths; find and enumerate the call sites in your report);
(b) collect() (30.1 shape) detects recurrence: a gate blocker mapping to a pattern_key
that was injected into that same stage's dispatch this run → increment
recurrence_after_injection; (c) `devteam patterns review` shows both counters and flags
recurrence ≥ 3 (configurable) as demotion candidates; (d) `devteam patterns demote <id>`
moves promoted → candidate with an audit line (who: operator, when, counters at time).
NO automatic demotion/retirement — explicit operator action only, per the design doc's
open question.

Tests: inject-once-per-dispatch (a preview must NOT increment); seeded recurrence
scenario flags; demote round-trip preserves history; counter persistence across
collect/promote cycles.
```

### 30.3 Reflector pass (ACE-lite) 🔲

```
TASK: Implement plans/phase-30-closed-learning-loop.md item 30.3 — opt-in run-end
Reflector dispatch that proposes itemized pattern deltas.
Branch: feat/reflector-pass

Config: learning.reflector: false by default. When true, after pipeline-complete the
driver dispatches ONE extra headless call: new role roles/reflector.md (~1 page: read
run-log.jsonl, the run's gates, and .devteam/patterns/promoted; output ONLY JSON
matching the new candidates-delta schema — new candidates incl. positive tier,
counter-adjustment suggestions, dedup-merge proposals). Route it like any role
(routing.roles.reflector), so it can go to a cheap model. Validate output against a new
JSON schema (core/gates/schemas/ naming conventions apply — but this is NOT a stage
gate; put it under a learning/ schema path and say why in a comment). Malformed output
→ discard WHOLE response, log one event, run unaffected. Valid proposals land in the
existing candidates store tagged source:"reflector" — promotion remains the existing
explicit human flow (the Curator is the human; cite ACE arXiv 2510.04618 in the role
brief header comment).

Tests: scripted reflector output → candidates with source tag; malformed output
discarded whole; disabled → byte-identical behavior; prompt-budget check for the new
role brief.
```

### 30.4 Memory retrieval into prompts 🔲

```
TASK: Implement plans/phase-30-closed-learning-loop.md item 30.4 — close the RAG loop:
retrieval into stage prompts, auto-ingest at run end.
Branch: feat/memory-injection

[verify-first] core/memory/ is consumed only by core/cli/commands/{memory,architecture}.js;
buildDescriptor() (core/orchestrator.js) has no memory hook; docs/memory.md says the
explicit interface is manual ingest. Confirm all three.

Implement: when .devteam/memory/ exists and memory.inject !== false, buildDescriptor()
queries top-k=3 (config memory.inject_top_k) against feature/brief text, applies a
similarity floor (config, default per store scoring semantics — read
core/memory/store.js first), and renders "## Prior Project Knowledge" (≤1,200 bytes,
kind+source attribution per entry) — mirror renderKnownPatterns() in
core/adapters/render-helpers.js exactly for budget/ordering discipline. Stage-02
descriptors additionally query the org store kind:adr (making `devteam architecture
lookup` automatic; note it in docs/memory.md). Driver auto-ingests at pipeline-complete
(existing ARTIFACT_KINDS; fire-and-forget). Optional-dep-absent (@huggingface/
transformers) → one warning, no section, no failure.

Tests: seeded store → section present within budget, correct attributions; no store →
byte-identical prompts; ingest-at-complete; embedder-absent degradation; budget
truncation order deterministic.
```

### 30.5 SKILL.md export 🔲

```
TASK: Implement plans/phase-30-closed-learning-loop.md item 30.5 — serialize promoted
patterns to the Agent Skills (SKILL.md) open standard.
Branch: feat/patterns-skill-export

`devteam patterns export --skill [--out <dir>]`: generate a directory containing
SKILL.md (YAML frontmatter: name, description; body: per-domain sections rendering each
promoted pattern's prompt text with its rationale). Follow the published SKILL.md spec —
research the current frontmatter requirements and record your source. Header comment in
the generated file: "Generated by devteam patterns export; regenerate to update; do not
hand-edit." Idempotent: re-export over an existing dir rewrites deterministically.
Secret-scan the rendered output before writing (reuse the promotion-time scan path).
`devteam init`: when promoted patterns exist and the host has a skills directory
(claude-code .claude/skills/, codex .codex/skills/ — read each adapter's install
payload), offer the export path in the init summary output (no auto-install without the
existing init overwrite rules).

Tests: export fixture → spec-shaped file; idempotency (two exports byte-identical);
secret-scan blocks a poisoned pattern; init summary mentions it only when patterns exist.
```

---

## Phase 31 — Verification Depth 🔲

### 31.1 Per-role stamping 🔲

```
TASK: Implement plans/phase-31-verification-depth.md item 31.1 — extend orchestrator
stamping to multi-workstream stages.
Branch: feat/per-role-stamping

[verify-first] core/orchestrator.js gates stamping behind
`STAMPABLE_STAGES.has(stage) && plan.workstreams.length === 1` with a comment that
multi-role stamping is out of scope. Confirm, and read core/verify/stamp.js +
core/verify/receipts.js fully first.

Implement: two stamp scopes. Workstream-scoped checks (lint over the workstream's
allowedWrites surface) stamp each workstream gate as it completes. Workspace-global
checks (full test suite) run once after merge and stamp the MERGED stage gate.
Verification receipts must dedupe identical commands across workstreams (4 builds ≠ 4
full suite runs — assert this in a test via receipt-hit counting). Preserve the
existing single-workstream behavior byte-for-byte. Extend, don't fork, stamp.js.

Tests: 4-workstream stage-04 stubbed run → per-role stamps + merged stamp; false
tests_passed claim overridden on the merged gate; receipts prevent duplicate suite
runs; single-workstream regression suite untouched and green.
```

### 31.2 Mechanical red-team floor 🔲

```
TASK: Implement plans/phase-31-verification-depth.md item 31.2 — stage-04c gets an
orchestrator-run mechanical floor.
Branch: feat/redteam-mechanical-floor

Post-dispatch for stage-04c, the orchestrator runs (recording each as ran/skipped+why):
(a) dependency audit — npm audit --json or the polyglot equivalent via the existing
suite-detection in core/verify/ [verify-first: confirm what polyglot detection exists
from Phase 19 / PR #264 before assuming]; network-unavailable → skipped:"offline",
NEVER treated as pass; (b) the existing secret-scan over the changed-file set (reuse
core/hooks/secret-scan.js as a library); (c) semgrep ONLY if a semgrep config exists in
the project and the binary is on PATH — never install anything; (d) new-dependencies
diff (lockfile delta since previous gate) listed on the gate.

Merge mechanical findings into the stage-04c gate: findings_count :=
max(model_reported, mechanical); any mechanical HIGH severity appends to
must_address_before_peer_review (the existing injectRedTeamBlockers consequence
plumbing in core/gates/validator.js then carries it — do not duplicate that plumbing).
Add stage-04c to the stampable set with a multi-tool stamp block recording per-tool
{ran, skipped, reason, findings}.

Tests: seeded vulnerable fixture flips model-PASS to FAIL; offline skip recorded
honestly; semgrep absent → skipped; model findings_count 0 + mechanical 2 → 2.
```

### 31.3 Adversarial review pair 🔲

```
TASK: Implement plans/phase-31-verification-depth.md item 31.3 — reviewer+critic
adversarial mode for stage-05, cross-host by default when possible.
Branch: feat/adversarial-review

Config review.mode: "panel" (default, byte-identical to today — regression-test it) |
"adversarial". Adversarial plans TWO workstreams: reviewer (existing reviewer role) and
critic (new roles/critic.md, ~1 page: attack the REVIEW — missed findings, unsupported
approvals, answer "what would make this approval wrong?"; require file:line evidence for
every challenge). Critic runs AFTER reviewer completes (sequential within the stage —
[verify-first: confirm the scheduler supports ordered workstreams within a stage or
plan them as two orchestrator steps; report which you found]). Critic gate fields:
challenges[] with per-challenge disposition, challenges_resolved boolean. Stage-05
merged gate passes only when reviewer approves AND challenges_resolved. Routing: when
≥2 hosts configured, default critic to a different host than reviewer (config
override allowed) — cite the collusion evidence (plan file §31.3) in a why-comment.
Reuse approval-derivation parsing for both files (by-reviewer.md, by-critic.md naming —
follow existing by-*.md conventions).

Tests: adversarial stubbed flow (approve + unresolved challenge blocks; resolved
passes); host-splitting resolution; panel-mode regression (prompt+plan byte-identical);
schema + consistency updates for the new gate shape.
```

### 31.4 Mutation smoke gate 🔲

```
TASK: Implement plans/phase-31-verification-depth.md item 31.4 — opt-in, time-boxed,
changed-files-only mutation testing at stage-06 stamping.
Branch: feat/mutation-gate

Config pipeline.verify.mutation: {enabled:false, threshold:0.7, threshold_hard:false,
timeout_ms, paths}. When enabled during stage-06 stamping: detect a supported runner
(Stryker via project devDependency, mutmut via project venv/PATH — NEVER install),
run against the changed-file set only (intersect with paths config), time-boxed via the
existing process-kill machinery (core/process-kill.js), parse the score, stamp
mutation_score + runner + scope on the gate. Below threshold → WARN (advisory; must
surface in devteam advise classification [verify-first: read core/advise.js
classification rules first]); FAIL only when threshold_hard. Absent runner → recorded
skip. Document in docs/verification-beyond-tests.md (it already discusses mutation
testing as prompt-level guidance — mark which part is now mechanical).

Tests: fixture project with a surviving-mutant gap scores below threshold → WARN;
threshold_hard → FAIL; timeout kills cleanly; no-runner skip; disabled = today.
```

### 31.5 Stage-05 quorum verification 🔲

```
TASK: Implement plans/phase-31-verification-depth.md item 31.5 — orchestrator re-derives
approval state from review files on every host.
Branch: feat/review-quorum-stamp

[verify-first] Approval state comes from the claude-code PostToolUse hook
(core/hooks/approval-derivation.js) or model-written gates on other hosts; `devteam
derive-approvals` exists because non-hook saves bypass derivation. Confirm by reading
the hook, the command, and the stage-05 merge path.

Implement: after stage-05 merge, the orchestrator calls the approval-derivation parser
DIRECTLY (as a library — do not reimplement the REVIEW:/CHANGES REQUESTED grammar) over
pipeline/code-review/by-*.md and compares derived state to each workstream gate. A gate
claiming approval whose file says otherwise (or has no parseable verdict) → merged gate
flips to FAIL with a field-level {workstream, gate_said, file_said} record in the stamp
block. This must run on ALL hosts (it's post-hoc, host-independent).

Tests: seeded mismatch caught on a non-claude-code host fixture; agreeing states leave
the merge untouched; unparseable file handled as its own mismatch class.
```

---

## Phase 32 — Performance & Parallelism

### 32.1 Cache-first prompt assembly ✅ (PR #360)

```
TASK: Implement plans/phase-32-performance-parallelism.md item 32.1 — stable-prefix
prompt layout + provider cache breakpoints.
Branch: feat/cache-first-prompts

[verify-first] Map today's rendered-prompt section order by reading
core/adapters/render-helpers.js and one adapter's renderStagePrompt end to end; confirm
whether volatile content (changed-file manifest, stage objective) currently precedes
constant content (role brief, rules) anywhere.

Implement the four-layer order everywhere prompts are assembled: (1) framework
preamble/rules [constant per version] → (2) role brief [constant per role] → (3)
learned context: Known Project Patterns + Prior Project Knowledge [constant per run] →
(4) volatile tail: stage objective, readFirst, manifest, gate shape. Add the regression
test: two different stages, same run, same role config → sections 1–2 byte-identical
prefixes. For openai-compat against Anthropic-style endpoints add optional
cache_control breakpoints after layers 1/2/3 (config caching.enabled); OpenAI-style
prefix caching needs only the ordering. Record cached_tokens when the API reports it
(28.2 field). Regenerate the prompt-budget reference (find its generator; consistency
will fail until you do).

CAUTION: reordering changes every rendered prompt — expect prompt-snapshot tests to
need updates; that is authorized here, enumerate each in the report. Gate JSON shapes
must not change.

Tests: prefix-stability test; cache_control emission fixture; budget doc regenerated;
full suite green.
```

### 32.2 Stage DAG waves ⏸ (ADR-017 drafted, status Proposed — not Accepted; wave execution not built, PR #361 was ADR-only)

```
TASK: Implement plans/phase-32-performance-parallelism.md item 32.2 — ADR-017 stage
dependency metadata + wave execution in the driver.
Branch: feat/stage-waves
PRECONDITION CHECK: docs/adr/017-*.md exists, is titled for stage-wave scheduling, and
has status Accepted. (ADR-016 is "Assess-by-default" from 29.2 — do NOT treat its
existence as this precondition being met.) If not: write ONLY
the ADR (following docs/adr/ house format, covering: dependsOn derivation from
readFirst/artifact flow, wave semantics, chain stays track-order, failure-in-wave
handling, --max-iterations accounting where one wave = one iteration, max_parallel_stages
default 2) and STOP for human review. Do not implement in the same session as the ADR.

If the ADR is Accepted: add dependsOn[] to the STAGES table for the two safe regions
only ({04a ∥ 04c} and {06b ∥ 06c ∥ 06d ∥ 06e} — or the folded 06x from 29.4 if merged);
driver collects all ready actions whose dependencies hold PASS/WARN gates and executes
up to autonomy.max_parallel_stages concurrently via the existing scheduler
(core/scheduler.js — extend keying, don't fork). run-log events gain wave_id; heartbeat/
stall-probe/lock semantics hold per wave member ([verify-first] read how the stall probe
watches "the workstream log" and generalize). fix-and-retry clears only the failing
member. devteam performance critical-path reports realized parallel savings.

Tests: full-track stubbed run ≤13 sequential slots; one wave-member FAIL halts per
failure class without corrupting siblings' gates; chain verify green; wave accounting
in run-log.
```

### 32.3 Model-tier routing ✅ (PR #362)

```
TASK: Implement plans/phase-32-performance-parallelism.md item 32.3 — per-role/per-stage
model selection in routing config + escalate-on-retry.
Branch: feat/model-tier-routing

[verify-first] Inventory how each headless adapter currently receives a model (env,
flag, config — e.g. openai-compat per-role model mapping exists; claude-code/codex may
use CLI flags or default). Report the inventory, then unify: routing.roles.<role> and
routing.stages.<stage> accept either "host" (string, today's form — MUST keep working)
or {host, model}. resolveRoute returns both; each adapter maps model → its native
mechanism (claude --model, codex --model / -c model=, API body model) and records
model_requested on the dispatch (model_observed from 28.x tells you what actually
served it). Config routing.escalate_on_retry: false — when true, a fix-and-retry of a
dispatch whose route carried a model bumps one tier up a documented tier table
(config routing.tiers, shipped example in docs), recorded on the new gate. Ship the
"frontier plans / cheap executes" preset as a documented config block in
docs/user-guide.md + docs/cost.md, NOT as a changed default. Extend
scripts/routing-suggest.js grouping to (role, host, model) using corpus rows.

Tests: back-compat string form; object form reaches each adapter's command/body;
escalate-on-retry records provenance; suggest groups by model.
```

### 32.4 Gate-verified best-of-N ⏸ deferred — no host adapter declares `worktrees: true`, so this item's own precondition can't be met (attempted 2026-08-01, no ADR/code/branch resulted)

```
TASK: Implement plans/phase-32-performance-parallelism.md item 32.4 — opt-in parallel
attempts in worktrees, gate picks the winner.
Branch: feat/best-of-n

`devteam stage <name> --best-of N` (and pipeline.best_of.<stage>: N config): only for
single-workstream stages on hosts with worktrees:true capability (refuse loudly
otherwise). Dispatch N attempts concurrently (existing scheduler + host worktree
mapping — [verify-first] read how isolation modes map to host primitives in the
adapters and ADR/architecture notes before building). Each attempt writes its gate to
an attempt-scoped path; the orchestrator stamps each (31.1 machinery if merged; else
existing single-workstream stamping), then selects: first PASS by completion order →
tie-break fewest blockers → lowest observed cost. Winner's gate + artifacts land in
the canonical paths; losers archive to pipeline/attempts/<stage>/<n>/ (gate + prompt
hash + log pointer, NOT full worktrees — clean those up). All-fail → single canonical
FAIL (one fix-and-retry cycle, not N). Cost accounting sums every attempt
(cost_basis/observed rules from 28.4). run-log records attempt fan-out.

Tests: stubbed best-of-3, one pass → selection + archive + worktree cleanup; all-fail
collapse; cost summation; non-worktree host refusal; N=1 ≡ today.
```

### 32.5 context.md diet ✅ (PR #363)

```
TASK: Implement plans/phase-32-performance-parallelism.md item 32.5 — context budget with
auto-compaction + per-workstream delta sections.
Branch: feat/context-diet

[verify-first] pipeline/context.md grows via devteam:* marker sections written by the
validator/driver and stripped on resolution; devteam compact regex-strips them all;
every stage prompt includes/points at the whole file. Confirm by reading
core/gates/validator.js marker functions + core/cli/commands/compact.js.

Implement: (a) pipeline.context_budget_bytes (default 8192) checked whenever a marker
section is written — over budget → oldest RESOLVED sections compact to one-line digests
with pointers into pipeline/context-archive/<ts>-<section>.md (deterministic naming;
archive is append-only). Unresolved/active sections are never auto-compacted. (b) each
rendered prompt gains a "Context changes since your last dispatch" delta: marker
sections added/removed since this workstream's previous dispatch, derived from
run-log.jsonl events ([verify-first] confirm section writes are already logged as
events; if not, add the event first as its own commit). (c) devteam compact unchanged
for manual full strips.

Tests: seeded oversize context compacts deterministically with archive round-trip;
active sections survive; delta correct across a retry sequence; prompts under budget.
```

---

## Phase 33 — Eval Flywheel

### 33.1 Failed gates → eval cases 🔲

```
TASK: Implement plans/phase-33-eval-flywheel.md item 33.1 — capture replayable eval
cases from FAIL/ESCALATE gates and stamp overrides.
Branch: feat/eval-capture

On gate FAIL/ESCALATE and on every stamp override (status_overridden in stamp blocks —
the model-lied class, capture these ALWAYS when capture is on), write
.devteam/evals/cases/<ts>-<stage>-<hash>/: case.json (stage, role, host, track,
prompt_hash + reproducibility fields from the gate per C4, gate snapshot, run/framework
versions), inputs/ (content-addressed snapshots of the readFirst artifact set, deduped
into .devteam/evals/blobs/ by sha256), and — appended LATER when the failure resolves —
resolution.json (which retry cleared it, linked via run-log; implement as a
resolution-linker pass at run end). Config evals.capture (default true), sanitization
via the secret-scan path, fire-and-forget contract (test). Blob GC: `devteam evals gc`
removes unreferenced blobs. Managed-gitignore the evals dir.

Tests: stubbed FAIL → complete case; stamp-override capture; resolution linking after a
successful retry; dedup (two cases, same artifact → one blob); disabled → nothing;
planted secret excluded.
```

### 33.2 `devteam evals run` 🔲

```
TASK: Implement plans/phase-33-eval-flywheel.md item 33.2 — the replay harness.
Branch: feat/evals-run
PRECONDITION CHECK: 33.1 merged (case format exists).

`devteam evals run [--stub | --headless-host <h>] [--filter <stage|id>] [--json]`:
for each case, re-render the stage prompt from the case's captured inputs against the
CURRENT framework (current roles/rules/patterns/layout — the point is detecting
framework regressions). --stub mode (default): structural scoring only — prompt
renders, injected sections present, budgets respected, prompt_hash drift vs the case
reported; free, no model. --headless-host mode: dispatch for real (existing headless
machinery, DEVTEAM_HEADLESS_COMMAND respected for tests), validate the produced gate;
a case whose original failure was RESOLVED must PASS now — failing = regression, exit
1. Print the 29.3-style cost preview before any real-model sweep and require
--budget-usd for it. Output: table + JSONL. Add a CI job to this repo running --stub
over a small checked-in fixture corpus (tests/fixtures/evals/).

Tests: stub scoring on fixture corpus; real-mode via scripted headless command;
regression detection on a seeded re-break; budget refusal.
```

### 33.3 Prompt-pack versioning ⏸ (after 28.5)

```
TASK: Implement plans/phase-33-eval-flywheel.md item 33.3 — content-hash version for the
prompt surface, recorded everywhere, comparable.
Branch: feat/prompt-pack-version
PRECONDITION CHECK: 28.5 merged (corpus carries the field).

prompt_pack_version = short content hash over roles/ + rules/ + templates/ (stable file
ordering; [verify-first] the consistency script already hashes prompt-budget inputs —
reuse its walker if suitable, report either way). Record it: on every gate (validator
additionalProperties check — extend schemas' shared identity fields per ADR-011
conventions), every corpus row, every eval case. `devteam evals compare --pack <A> --pack
<B> [--json]`: per-stage pass-rate deltas between pack versions from the corpus, with
dispatch counts (refuse comparison below a minimum-n, default 5 per cell, honesty
rules). Document in docs/reproducibility.md as C4's consumer.

Tests: version changes iff prompt-surface content changes; propagation to gate/corpus/
case; compare on fixture corpus; minimum-n refusal.
```

### 33.4 Offline prompt optimization (experimental) ⏸ (after 33.1–33.3)

```
TASK: Implement plans/phase-33-eval-flywheel.md item 33.4 — GEPA-style reflective
optimizer as an out-of-band script.
Branch: feat/prompt-optimize
PRECONDITION CHECK: 33.1, 33.2, 33.3 merged.

scripts/prompt-optimize.js (out-of-band like scripts/budget.js — NOT a devteam command;
header comment explains why, citing the plan): inputs --target <roles/x.md|rules/y.md>
(exactly one file), --budget-usd (MANDATORY, hard-refuse without), --model, corpus +
eval cases filtered to stages exercising the target. Loop (bounded iterations, default
4): sample failing/regressed cases → one frontier-model call diagnosing failures in
natural language and proposing a revised target file → score the candidate via
`devteam evals run --stub` (must stay structurally valid + within prompt budget) and a
bounded real-model subset (respect the budget) → keep a Pareto set (pass-rate vs token
size), never a single greedy winner (cite GEPA arXiv 2507.19457 in the header).
Output: proposed unified diff + evidence table (before/after pass rates on the eval
subset, token delta, spend) to stdout and a report file under .devteam/evals/optimize/.
NEVER writes to the target file itself. Only the target file may appear in the diff.

Tests: end-to-end with scripted model + fixture corpus → diff + evidence table; budget
refusal; diff-scope guard (proposal touching another file is rejected); iteration bound.
```

---

## Phase 34 — Interop & Auditable SDLC

### 34.1 ACP host adapter 🔲

```
TASK: Implement plans/phase-34-interop-auditable-sdlc.md item 34.1 — an Agent Client
Protocol client adapter: any ACP agent becomes a Stagecraft host.
Branch: feat/host-acp

Research the current ACP spec (agentclientprotocol.com / Zed docs) first; record
version + source in the report and pin the protocol version in capabilities.json.
hosts/acp/: adapter speaking ACP as client over stdio to a configured agent command
(routing target form "acp:<command>" — extend config parsing with back-compat tests).
Dispatch = initialize session → send rendered stage prompt → stream agent
progress/tool events into pipeline/logs/<workstreamId>.log → resolve when the session
ends and the gate file exists (existing poll fallback applies). Map enforcement to ACP
permissions: stoplist and allowed-writes violations DENY at permission-request time —
declare enforces: tool-call-time for those rules in capabilities (this is the first
non-claude-code host with call-time enforcement; note it in the capabilities comment).
No network in tests: scripted stub ACP agent (Node script speaking the wire protocol
over stdio) under tests/fixtures/.

Tests: adapter-contract structural pass; end-to-end stage via stub agent; stoplisted
write denied at call time; malformed-protocol handling (timeout + structural dispatch
failure class).
```

### 34.2 Attestation export 🔲

```
TASK: Implement plans/phase-34-interop-auditable-sdlc.md item 34.2 — gate chain →
in-toto-shaped signed evidence bundle.
Branch: feat/attestation-export

[verify-first] Read core/evidence/ (identity, bundle, resolutions — Phases 16–18) and
core/gates/chain.js before designing; this item PRODUCTIZES that machinery, it must not
fork it.

`devteam evidence export --attestation [--out <file>] [--sign]`: run verify-chain
first (refuse on a broken chain unless --allow-unverified, which stamps the bundle
accordingly); emit an in-toto-Statement-shaped JSON: subject = produced commit(s) (from
run-state/git), predicateType = a stagecraft-namespaced URI with a version, predicate =
per-stage entries {gate status, per-field provenance (model-asserted vs
orchestrator-observed/stamped), prompt_pack_version (33.3 if present), C4
reproducibility fields, chain hashes/HMAC presence, ADR-012 human-acceptance records as
their own entries}. Check the predicate schema into core/evidence/schemas/ and validate
on emit. --sign shells to cosign sign-blob when on PATH (never bundled; absent →
clear error). Counterpart `devteam evidence verify-attestation <bundle>`: offline
re-check of internal hashes + schema. Document in docs/evidence.md.

Tests: fixture pipeline → schema-valid bundle; tamper → verify fails; broken chain
refusal; resolutions appear; sign path via a stubbed cosign on PATH.
```

### 34.3 Compliance control mapping 🔲

```
TASK: Implement plans/phase-34-interop-auditable-sdlc.md item 34.3 — docs/compliance.md.
Branch: docs/compliance-mapping

Write docs/compliance.md: a table mapping control families → the pipeline artifact +
the exact command that verifies it. Rows per the plan §34.3: change approval (stage-07
+ ADR-012 acceptance), segregation of duties (per-role dispatch provenance; reviewer ≠
author hosts when adversarial mode splits them), testing evidence (stamped 04a/06 +
receipts), security review (04c incl. the 31.2 mechanical floor if merged — otherwise
describe today's honestly as model-asserted), deployment control (consequence ceiling +
--allow-stage), tamper evidence (verify-chain / 34.2 attestation if merged). EVERY row
must name a real file path and a runnable command — no aspirational rows; where the
capability is roadmap, omit it or mark it "planned (phase-NN)" explicitly. Scope
banner: "evidence your auditors can map, not certified compliance." Add to
docs/README.md index + the README documentation map (Evaluator path). No code. `npm run
consistency` green is the acceptance gate.
```

### 34.4 gemini-cli to plugin status ⏸ (one release after 28.6)

```
TASK: Implement plans/phase-34-interop-auditable-sdlc.md item 34.4 — move gemini-cli
out of first-party hosts via the A4 plugin mechanism.
Branch: feat/gemini-plugin-retirement
PRECONDITION CHECK: 28.6 (antigravity host) merged AND at least one release has shipped
with the doctor deprecation warning (check CHANGELOG.md releases since). If not, STOP.

[verify-first] Read the A4 plugin-host mechanism (core/router.js @devteam/host-<name>
resolution + any plugin docs) and confirm a local-package layout a project can install.
Create packages/host-gemini-cli/ (or the repo's chosen plugin layout — if none exists
for first-party-maintained plugins, propose the smallest one in the ADR-comment style)
containing the moved adapter + its tests; remove hosts/gemini-cli/ from the first-party
enumeration; `devteam init --host gemini-cli` errors with the exact install
instruction for the plugin package. Update every host list (README, docs, consistency
checker enumerations — the checker will find them). Contract tests run against the
plugin from its new location.

Tests: init error message; plugin-path resolution round-trip in a tmpdir project;
consistency green; no orphaned gemini references (grep sweep in the report).
```

---

## Phase 35 — Existing-Codebase Mode 🔲

### 35.1 `review-only` track + artifact-tolerant readFirst 🔲

```
TASK: Implement plans/phase-35-existing-codebase-mode.md item 35.1 — a review-only track
plus optional readFirst entries, so review stages work on repos with no pipeline history.
Branch: feat/review-only-track

[verify-first] Confirm three claims before editing: (a) core/cli/commands/stage.js has no
predecessor-gate check (only the peer-review auto-preflight, bypassable with
--skip-preflight); (b) the readFirst arrays for security-review, red-team, peer-review and
verification-beyond-tests reference pipeline artifacts that will not exist on a brownfield
repo (read them from core/pipeline/stages.js); (c) gate schemas for those stages carry
AC-linked required fields.

Implement both halves — neither is useful alone:

1. SOFT readFirst. Add an optional-entry form to the STAGES table (either
   {path, optional:true} entries or a parallel readIfPresent array — pick ONE, and say why
   in a why-comment). At render time an absent optional path is OMITTED from the prompt
   entirely, never rendered as "read this file" for a file that isn't there. Required
   entries (AGENTS.md, the rules docs) keep today's behavior. Add the regression test that
   full-track prompts are byte-identical after this change.
2. THE TRACK. Add review-only to STAGES_BY_TRACK: ["security-review","red-team",
   "peer-review"]. Add --scope <path> (repeatable) threading into the rendered prompt and
   onto the gate. Make AC-referencing gate fields null-permitted when track is
   review-only — a schema conditional, NOT a new schema; follow the 29.4 stage-06x
   precedent for how track shape drives validation.

Tests: `devteam run --track review-only` completes on a fixture repo containing NO
pipeline/ directory; assert no rendered prompt mentions a nonexistent path; full-track
prompt byte-comparison; verify-chain passes on the 3-stage track; --scope reaches prompt
and gate.
```

### 35.2 `devteam review-pr <number|url>` 🔲

```
TASK: Implement plans/phase-35-existing-codebase-mode.md item 35.2 — review an inbound
GitHub PR with the existing reviewer/critic machinery.
Branch: feat/review-pr

[verify-first] Find the existing `gh` shell-out precedent (scripts/pr-publish.js is the
likely one) and reuse its auth handling and error messages rather than inventing a second
pattern. Report what you found.

Implement `devteam review-pr <number|url> [--post] [--yes] [--json]`:
materialize the PR into pipeline/review-input/ (unified diff, changed-file list, PR
title/body as the stated intent — the closest thing to a brief a PR provides), then
dispatch stage-05 against that input: reviewer alone in panel mode, reviewer then critic
when review.mode is adversarial (31.3). Output is a normal stage-05 gate plus
pipeline/code-review/by-*.md. Reuse 35.1's soft-readFirst so no brief/spec is required
(if 35.1 has not merged, STOP and report — this item depends on it).

PUBLISHING IS OPT-IN AND GATED. Default: local only, nothing sent anywhere. --post
publishes findings as PR review comments and MUST (a) print the exact payload and require
interactive confirmation, (b) refuse in a non-interactive context unless --yes is ALSO
passed, (c) refuse outright if the review did not complete or any gate is FAIL-to-render.
Posting to a PR is public and hard to undo, so the confirmation has to actually stop the
command — not a prompt that defaults to yes. Never post on a partial review.

Tests: a scripted `gh` stub on PATH drives an end-to-end review of a fixture PR producing
a valid stage-05 gate; adversarial mode adds the critic; --post without confirmation posts
nothing (assert the stub received no create-review call); missing `gh` gives an actionable
error; partial review never posts.
```

### 35.3 Mechanical stamping for stage-06d 🔲

```
TASK: Implement plans/phase-35-existing-codebase-mode.md item 35.3 — orchestrator-verified
evidence that 06d's methods actually ran.
Branch: feat/stamp-06d

[verify-first] STAMPABLE_STAGES in core/verify/stamp.js is {stage-03b, stage-04a,
stage-04c, stage-06} — 06d is absent, so methods_attempted[] is model-asserted. Confirm,
and read the 31.4 mutation runner path before adding anything.

Add stage-06d to the stampable set and verify per method:
- property_based: detect the runner from the project manifest (fast-check / hypothesis /
  proptest — NEVER install), execute the property tests at the configured path, stamp
  executed-property count and pass/fail.
- mutation: REUSE the 31.4 runner rather than adding a second implementation; stamp
  mutation_score with scope.
- formal: presence-and-exit-code only (TLA+/Alloy/Lean output is too varied to parse) —
  stamp {tool, ran, exit_code}; unparseable output is attempted_but_blocked, NEVER success.

methods_attempted[] becomes orchestrator-derived. A method the model claims but for which
no executable evidence exists is downgraded to attempted_but_blocked:<method> with the
model's original claim preserved in the stamp block. Existing FAIL rules (surviving mutant
on a critical path, property counterexample, formal counterexample) are unchanged — what
changes is that the orchestrator decides whether the method ran at all.

Tests: fixture with a real property counterexample FAILs on orchestrator evidence; a model
claiming property_based with zero executed properties is downgraded; absent toolchain
records a skip; enumerate every existing 06d test you update and why (this intentionally
changes asserted behavior).
```

### 35.4 Findings report with mitigations 🔲

```
TASK: Implement plans/phase-35-existing-codebase-mode.md item 35.4 — a severity-ordered
findings report aimed at fixing things.
Branch: feat/findings-report

`devteam report --findings [--out <file>] [--json]`: collect findings from every review
artifact present — security-review, red-team (including the 31.2 mechanical floor),
peer-review and critic files, 06d, the 31.4 mutation gate, and docs/audit/*.md when the
audit workflow has run — and render ONE ranked table: severity, file:line, what's wrong,
suggested mitigation, rough effort, and provenance.

Provenance is the important column: label each finding orchestrator-observed vs
model-asserted using the existing _orchestrator_stamped / _orchestrator_observed
distinction, so a reader can tell which findings are machine-confirmed. Do not invent a
new provenance mechanism. Reuse core/report/ collection + render-html patterns for a
self-contained offline file.

Tests: fixture pipeline with findings from three different sources yields one ranked report
with correct provenance labels; the no-findings case renders an honest empty state rather
than a broken table; --json shape validated against a checked-in schema.
```

### 35.5 `refactor` track 🔲

```
TASK: Implement plans/phase-35-existing-codebase-mode.md item 35.5 — a behavior-preservation
track for refactors.
Branch: feat/track-refactor

Add refactor to STAGES_BY_TRACK: ["build","peer-review","qa"], with two differences from
nano (which has the same stage list — read nano first and say how you keep them distinct):
(1) stage-01 is skipped but the build prompt is a CHARACTERIZATION brief — capture current
behavior before changing structure; (2) QA's bar is behavior-preserved: the existing suite
must pass unchanged AND the 31.4 mutation gate is enabled by DEFAULT on this track only
(a refactor that survives mutation testing is one that preserved behavior). AC-mapping
gate fields are null-permitted as in 35.1 (depends on 35.1 — STOP if it hasn't merged).

Tests: --track refactor runs on a fixture; a behavior-CHANGING edit fails the
preserved-behavior bar; mutation defaults on for refactor and stays off elsewhere;
nano behavior unchanged.
```

---

## Phase 36 — External Review Mode (ACP-first) 🔲

Run **36.0 first** — it is report-only and the rest of the phase branches on its answer.

### 36.0 Spike: ACP read scope outside the session cwd 🔲 [report-only]

```
TASK: Execute plans/phase-36-external-review-mode.md item 36.0. This is a REPORT-ONLY
spike. Write NO production code. Do not implement 36.2 in this session.
Branch: spike/acp-read-scope

Question to answer: can a stage prompt point an ACP agent at framework files by ABSOLUTE
path outside its session cwd, or does the agent sandbox reads to that directory?

Why it matters: Stagecraft declares `fs: { readTextFile: false, writeTextFile: false }` at
initialize (hosts/acp/adapter.js:310), so the agent uses its own filesystem access. Item
36.2 renders framework paths (rules, role briefs, templates) as absolute paths into a
separate state directory — which only works if the agent will read them.

Method:
1. Read hosts/acp/adapter.js end to end first (344 lines) and confirm how session/new
   receives cwd (:163-165, :313) and what clientCapabilities are declared (:310).
2. Create two temp dirs: A (session cwd, containing a trivial repo) and B (outside A,
   containing a file with a known sentinel string).
3. Launch the real agent from hosts/acp/capabilities.json headlessCommand
   (`npx -y @agentclientprotocol/claude-agent-acp`) with session cwd = A, and a prompt
   instructing it to read B's absolute path and echo the sentinel. Network + a model are
   required; if credentials or network are unavailable, STOP and report that rather than
   simulating the result with the existing stub agent — a stub proves nothing here.
4. Record exactly what happened: read succeeded / refused / asked permission via
   session/request_permission / returned nothing.
5. Repeat with B symlinked inside A, and note any difference.

Deliverable: create plans/acp-read-scope.md in the house style of the other evidence
reviews (see plans/h3-ground-truth.md and plans/adaptive-routing-evidence.md for tone and
shape): agent name + version tested, date, exact observed behaviour per case, and a
one-line RECOMMENDATION for 36.2 — either "absolute paths" (preferred, free) or "inline
framework content" (fallback: costs tokens per dispatch and must be reconciled with the
32.1 cache-first prefix layout, so note that cost). Append a link to it from
plans/phase-36-external-review-mode.md item 36.0 and from the plans/README.md evidence
reviews table.

Report honestly if the answer is "it depends" or if you could not run a real agent. A
wrong answer here sends 36.2 down the expensive path unnecessarily.
```

### 36.1 Two-root permissions + real read-only mode 🔲

```
TASK: Implement plans/phase-36-external-review-mode.md item 36.1 — give the ACP permission
evaluator separate code and state roots, plus a review mode that mechanically prevents
writes to the code being reviewed.
Branch: feat/acp-two-root-permissions

[verify-first] Confirm in hosts/acp/permissions.js: evaluateToolCall (:84) takes a single
`cwd`; relativeToProject (:61-66) returns null for paths outside it; findWriteViolation
(:68-80) treats null as a violation; WRITE_KINDS (:36) is {edit, delete, move} ONLY. And
in hosts/acp/adapter.js:256, handlePermissionRequest is passed `processCwd`. Report each.

Implement: evaluateToolCall accepts { codeRoot, stateRoot, mode } instead of one cwd
(migrate the adapter.js call site in the same commit; do NOT leave two code paths).
- mode "normal": byte-identical behaviour to today, single root. Existing permission tests
  must pass UNTOUCHED — if you find yourself editing one, stop and report.
- mode "review": a write (edit/delete/move) resolving inside codeRoot is DENIED with a
  reason naming read-only mode; writes under stateRoot are checked against allowedWrites
  relativised to stateRoot; paths outside both roots stay denied.

THE EXECUTE GAP — this is the substance of the item, not an afterthought. WRITE_KINDS
covers only edit/delete/move, so a `kind: "execute"` shell call can mutate the subject
(`sed -i`, `git checkout`, a build script) and today would sail through. Review genuinely
needs shell for rg/grep/git log. So in review mode, `execute` is DENY-BY-DEFAULT with a
read-only allowlist: rg, grep, git log|diff|show|status, ls, cat, find, wc, plus a config
extension point (hosts.acp.review.exec_allowlist). Parse to argv — never substring-match a
command string — and deny any redirection or shell metacharacter (> >> | ; & $( `). Deny
reasons quote the command. In normal mode `execute` handling is unchanged.

If the allowlist turns out to make real reviews impractical, say so in your report rather
than widening it silently. An advertised read-only guarantee that leaks writes is worse
than no guarantee.

Tests: write into codeRoot denied in review mode and allowed in normal mode with the SAME
descriptor; write under stateRoot matching allowedWrites allowed; `rg foo` allowed and
`sed -i` denied in review mode; `sed -i` still allowed in normal mode; `rg foo > out.txt`
denied (redirection); existing hosts/acp permission tests untouched and green.
```

### 36.2 Framework-path resolution across roots ⏸ (needs 36.0)

```
TASK: Implement plans/phase-36-external-review-mode.md item 36.2 — make framework files
resolvable when the state root and code root differ.
Branch: feat/external-framework-paths
PRECONDITION CHECK: plans/acp-read-scope.md exists from 36.0 and carries a RECOMMENDATION.
If it does not, STOP — running this item without that answer risks building the expensive
path (inlining) when absolute paths would have worked, or vice versa. Follow its
recommendation; if you disagree with it, report rather than diverge.

Stage prompts name AGENTS.md, .devteam/rules/*.md, role briefs and templates as RELATIVE
paths (33.4's verify-first finding: adapters render path pointers, never inlined content).
Against an external subject those resolve into the subject, where they do not exist.

Implement: extend phase 35.1's readFirst entry form ({path, optional: true}) with a root
marker — {path, root: "framework" | "subject", optional}. Default "subject" so nothing
changes for in-place runs. Mark rules, role briefs, and templates as "framework".

LEAVE AGENTS.md AS "subject" ON PURPOSE: the subject repo's own AGENTS.md is exactly what a
reviewer should read, and the framework's copy is an init stub. Put that reasoning in a
why-comment so a later reader does not "fix" it.

When stateRoot !== codeRoot, framework entries render per 36.0's recommendation (absolute
paths into stateRoot, or inlined content). When the roots are equal, rendered prompts must
be BYTE-IDENTICAL to today — add that regression test explicitly.

Tests: differing-roots render has every framework path absolute and resolvable, and no
framework path pointing into the subject; equal-roots byte-identical; the 32.1 cache-prefix
stability test still passes (if inlining, show what it does to prompt-budget numbers and
regenerate docs/reference/prompt-budget.md).
```

### 36.3 Review workspace + orchestrator plumbing ⏸ (needs 36.1, 36.2)

```
TASK: Implement plans/phase-36-external-review-mode.md item 36.3 — the review workspace and
the dispatch plumbing that keeps state out of the subject.
Branch: feat/review-workspace
PRECONDITION CHECK: 36.1 and 36.2 merged. Without 36.1 the subject is not protected; without
36.2 the prompts do not resolve.

[verify-first] core/cli/commands/prototype.js:321-323 already sets ctx.processCwd to a
separate workspace while ctx.cwd stays the project, and core/adapters/headless.js:232 plus
hosts/omnigent/adapter.js:468 honour ctx.processCwd. Confirm, and follow that precedent
rather than inventing a second mechanism.

Implement the workspace: ~/.stagecraft/reviews/<slug>/ where slug = subject basename + a
short hash of its absolute path (collision-safe, stable across runs); --workspace <path>
overrides. Contains .devteam/ (config, patterns, corpus, evals), pipeline/ (gates,
artifacts, logs), and the ACP role/skill dirs named in hosts/acp/capabilities.json. Write
subject.json recording the subject's absolute path, git remote, and THE COMMIT SHA
REVIEWED — 34.2's attestation should be able to name what was reviewed, not what was
produced.

Orchestrator: ctx.processCwd = subject, ctx.cwd = workspace, review mode on for the
permission evaluator.

THE TEST THAT MATTERS: snapshot the subject tree (file list + content hashes, including
.gitignore and AGENTS.md) before and after a stubbed review run and assert it is completely
unchanged. That test is the phase's core promise — write it first.

Tests: the snapshot test above; a stubbed review-only run puts every gate, log, and artifact
under the workspace; subject.json records path/remote/SHA; `devteam verify-chain --cwd
<workspace>` passes on the resulting chain.
```

### 36.4 `devteam review <path>` ⏸ (needs 36.3)

```
TASK: Implement plans/phase-36-external-review-mode.md item 36.4 — the zero-install entry
point.
Branch: feat/devteam-review
PRECONDITION CHECK: 36.3 merged.

`devteam review <path> [--scope <p>]... [--track review-only] [--host acp] [--workspace
<path>] [--json] [--open]` plus `devteam review --list`.

No init, no config, nothing written to the subject. Resolve or create the workspace (36.3),
dispatch the track, then run 35.4's findings report and print its path.

HOST HONESTY — do not skip this. `acp` is the only host that can mechanically prevent
writes to the subject (36.1). When --host names anything else, print a one-line warning
that writes to the subject are NOT prevented and enforcement degrades to post-hoc audit,
and refuse to proceed without an explicit acknowledgement flag. Never print a read-only
claim a host cannot keep. Pick the ack flag name to match existing house conventions
(look at how other commands gate risky behaviour) and say which you chose.

`--list` shows workspaces with subject path, last run date, and last status.

Tests: end-to-end against a fixture repo with the scripted ACP stub agent produces a
findings report and a byte-identical subject tree; non-ACP host warns and refuses without
the ack flag, proceeds with it; --list renders including the empty case; --json validated
against a checked-in schema.
```

### 36.5 `review-pr` without an initialised project ⏸ (needs 36.3)

```
TASK: Implement plans/phase-36-external-review-mode.md item 36.5 — review an inbound PR from
anywhere, with no checkout and no initialised project.
Branch: feat/review-pr-standalone
PRECONDITION CHECK: 36.3 merged.

[verify-first] core/cli/commands/review-pr.js:227 refuses when <cwd>/.devteam/config.yml is
absent. Confirm, and read how 35.2 materialises the PR into pipeline/review-input/.

Implement: accept a PR number or URL; materialise into the 36.3 workspace rather than the
subject; drop the initialised-project precondition when a workspace is in play (keep it
when running in-place so existing behaviour is unchanged). No clone in the common case —
the diff IS the subject, so codeRoot may be absent; when it is, every write target is under
stateRoot and review mode is trivially satisfied (assert that, don't just assume it).

KEEP 35.2'S PUBLISHING SAFETY EXACTLY AS SHIPPED: --post opt-in, the confirmation must
actually stop the command, non-interactive requires the explicit yes flag, nothing posted on
a partial or failed review. Do not relax any of it while moving the state root. Re-run those
tests and confirm they still pass.

Tests: `devteam review-pr <url>` succeeds from a directory that is neither a Stagecraft
project nor the repo, using a scripted `gh` stub; state lands in the workspace; in-place
behaviour unchanged; every 35.2 publishing-safety test still green.
```

### 36.6 Docs: external review guide 🔲

```
TASK: Implement plans/phase-36-external-review-mode.md item 36.6.
Branch: docs/external-review
PRECONDITION CHECK: at least 36.1, 36.3, and 36.4 merged — do not document unbuilt behaviour.

Write docs/external-review.md: the two entry points (`devteam review`, `devteam review-pr`),
a per-host enforcement table, the workspace layout, where evidence lands, and the honest
limits — the execute allowlist from 36.1, and that non-ACP hosts cannot guarantee
read-only. Every enforcement claim must name the file that implements it (house rule from
34.3).

Cross-link from docs/compliance.md: a review workspace is where an auditor's evidence
bundle belongs, since it names the reviewed commit and never mutates the audited repo.
Update the README host table to note acp as the recommended host for reviewing code you do
not own. Add the new doc to docs/README.md's index.

No code. `npm run consistency` green is the acceptance gate.
```

---

## Phase 37 — Interface & Token Efficiency 🔲

Measured findings behind these items are in
[../experience-review-2026-08.md](../experience-review-2026-08.md). **This phase adds no new
capability** — every item removes surface, generates something from data that already exists,
or moves bytes to a cheaper place. If an item tempts you toward a new feature, that is a
signal you have left its scope.

### 37.1 Generated per-command help 🔲

```
TASK: Implement plans/phase-37-interface-and-token-efficiency.md item 37.1 — real
per-command help, generated from the flag specs that already exist.
Branch: feat/per-command-help

[verify-first] Confirm both claims before writing code:
(a) `devteam help <cmd>` ignores its argument — run `node bin/devteam help run > /tmp/a`
    and `node bin/devteam help review > /tmp/b` and diff them; they are currently identical
    (343 lines each).
(b) Flag specs are structured with type + description — see the "budget-usd" entry in
    core/cli/commands/run.js. Report how the specs are declared and how uniform they are
    across all 44 command modules.

Implement `devteam help <command>` and `devteam <command> --help` to print ONLY that
command's help, GENERATED from the flag specs: synopsis line, usage, then each flag with
type and description. Do NOT hand-write per-command prose — if a description is missing or
poor, fix the spec, so there stays exactly one source of truth. `devteam help` with no
argument keeps its current behaviour.

Unknown command: print the command list plus a did-you-mean suggestion using nearest match
by edit distance (small helper, no new dependency).

Tests: `help run` and `run --help` produce identical command-scoped output under 60 lines
containing all 21 of run's flags with types; output for two different commands differs
(the regression this item exists to fix); unknown command suggests a near match; and a test
that every flag in every command module has a non-empty description — expect that test to
fail first and fix the specs it flags, listing them in your report.
```

### 37.2 Inline framework + role brief into the cacheable prefix 🔲

```
TASK: Implement plans/phase-37-interface-and-token-efficiency.md item 37.2 — make the
per-dispatch framework bytes cacheable instead of re-read at full price every dispatch.
Branch: feat/inline-framework-prefix

Read the plan item in full first, and §3 of plans/experience-review-2026-08.md for the
measurements. In short: the prompt names framework files as paths, the model reads ~22 KB
itself via tool calls in a fresh session per dispatch, and the measured shared prefix across
two dispatches of the same role is only 268 bytes (15% of the prompt). So nothing meaningful
is cacheable and the 22 KB is paid every time.

[verify-first] Reproduce the 268-byte measurement before changing anything: render two
dispatches of the SAME role (pm at stage-01 and stage-03) with `devteam stage`, extract each
workstream prompt block, and compute the shared prefix length. Report the number you get. If
it differs materially from 268, stop and report rather than proceeding on a stale premise.

Implement: include the content of the framework set (AGENTS.md, .devteam/rules/pipeline.md,
.devteam/rules/gates-core.md) and the role brief INLINE, in the stable order 32.1
established, ahead of everything stage-specific — so the whole block is byte-identical across
every dispatch of the same role in a run. Put openai-compat's cache_control breakpoint
immediately after the inlined block (32.1 already has the mechanism). Keep a short list of
the source paths as a note so a human reading a transcript can still locate them.

Config `prompts.inline_framework`, default true, with the old path-pointer behaviour behind
false — a host without prefix caching may prefer it, and phase 36's external-review
absolute-path mechanism (plans/acp-read-scope.md) must keep working in both settings.

MEASURE, DO NOT ASSUME. Report before/after: prompt size, shared-prefix length between two
same-role dispatches, and the number of file-read round-trips per dispatch. The
prompt-budget consistency check fails on >10% growth — re-baseline it deliberately in this
commit and say so in the report. Do NOT suppress or weaken the check.

Tests: shared-prefix length between two same-role dispatches covers the full inlined block
(assert on length, not a substring); a stubbed cache-aware endpoint reports cached_tokens > 0
on the second dispatch; with inline_framework:false rendering is byte-identical to today;
external-review mode resolves framework content in both settings;
docs/reference/prompt-budget.md regenerated.
```

### 37.3 Project-context guard 🔲

```
TASK: Implement plans/phase-37-interface-and-token-efficiency.md item 37.3 — stop read-only
commands from inventing a pipeline in directories that are not Stagecraft projects.
Branch: fix/project-context-guard

[verify-first] Confirm the bug: `cd /tmp && node <repo>/bin/devteam next` prints
"▶️ run-stage — requirements (stage-01)" as though a pipeline were waiting there, because
core/cli/commands/next.js has no initialisation check. Contrast
core/cli/commands/review-pr.js, which checks for .devteam/config.yml and refuses with an
explanation — reuse that refusal shape and wording style rather than inventing a new one.

Implement ONE shared guard (single helper, not copied per command) used by the read-only
reporting commands: at minimum next, summary, status, log, validate. It detects "not a
Stagecraft project", exits non-zero, and says what is missing plus the fix
(`devteam init --host <name>`). `--json` callers get a structured error, never a silent
zero-state.

Do NOT guard commands that legitimately run outside a project: init, review, review-pr with
a workspace, hosts, stages, help, doctor. Enumerate the guarded/unguarded split in a
why-comment explaining the principle, and add a test asserting both lists so the split
cannot drift silently as commands are added.

Tests: next/summary/status in a non-project temp dir exit non-zero with an actionable
message; `devteam review <path>` and `devteam init` from a non-project dir still work;
--json returns a structured error; the guarded/unguarded list test.
```

### 37.4 Task-grouped top-level help 🔲

```
TASK: Implement plans/phase-37-interface-and-token-efficiency.md item 37.4 — collapse
`devteam --help` from 343 lines to one screen, grouped by what the user is trying to do.
Branch: feat/grouped-help
PRECONDITION CHECK: 37.1 merged (per-command help exists), because this item moves the
detailed flag reference out of the default view and users need somewhere to go.

Default `devteam --help` becomes ≤ 45 lines: task groups with one line per command. Suggested
grouping (yours to refine): Start here (init, doctor, assess) · Daily (run, stage, next,
commit) · Review (review, review-pr, report --findings) · Verify (verify, verify-chain,
validate, consistency) · Learn (patterns, memory, evals, corpus) · Audit (evidence, report,
log, summary, performance).

The full current output moves behind `devteam --help --all` — same content, nothing lost —
and remains in generated docs/reference/cli.md.

NO command renames and NO removals. This is presentation only; existing scripts and muscle
memory must keep working. If you find yourself wanting to rename something for tidiness,
record it under out-of-scope findings instead.

Tests: default help ≤ 45 lines; a test that enumerates core/cli/commands/*.js and asserts
every command appears exactly once across the groups (so a future command cannot be added
without being grouped — this is the check that keeps the screen honest); `--help --all`
prints the full reference; generated CLI reference byte-unchanged.
```

### 37.5 Documentation front door and archive 🔲

```
TASK: Implement plans/phase-37-interface-and-token-efficiency.md item 37.5 — give 103 doc
files and 1.4 MB one obvious entry point, and make sprawl mechanically visible.
Branch: docs/front-door

DELETE NOTHING. Moves and indexes only; this project's docs carry deliberate caveats and
history that must survive.

Three parts: (1) one front door — a docs/START-HERE.md, or a tightened README section —
naming the FIVE documents a new user actually needs, no more; (2) move superseded and
historical material under docs/historical/ (already exists) with an index, leaving a pointer
where anything externally linked used to live; (3) add a consistency check that every
docs/**.md is reachable from at least one index, so the sprawl cannot silently regrow.

Expect the new check to fail on existing unreferenced files. List every file it flags in your
report and index them rather than deleting — if something genuinely looks obsolete, say so
and leave it in place for a human to decide.

Acceptance: front door names ≤ 5 entry docs; new consistency check passes with every doc
reachable; no deletions; `npm run consistency` green.
```

### 37.6 Decide ADR-017 (stage waves) 🔲 [decision, not implementation]

```
TASK: Implement plans/phase-37-interface-and-token-efficiency.md item 37.6 — resolve
ADR-017's status. This is a DECISION item: do not implement wave execution in this session.
Branch: docs/adr-017-decision

docs/adr/017-dag-wave-execution.md has been Status: Proposed since 2026-08-02, so phase 32
item 32.2 was never built and `full` still pays 18 sequential stage slots against an
analysis (plans/pipeline-speed-opportunities.md) saying ~13 is reachable.

Read ADR-017 in full, plus ADR-015 (workstream scheduling, whose deferral created this), plus
plans/phase-32-performance-parallelism.md §32.2. Then resolve it one way and make every
document agree:

- ACCEPTING: set the status and date, record the decision and any scope reduction (for
  example waving only the two already-known-independent groups rather than a general DAG),
  and add a follow-up work item with concrete scope to plans/phase-32-*.md. Implementation is
  a separate session.
- REJECTING: set Status: Rejected with a dated rationale, and update
  plans/phase-32-performance-parallelism.md plus the "What is not delivered yet" table in
  plans/README.md so 32.2 stops appearing as pending work.

Either outcome is a success for this item. What is not acceptable is leaving it Proposed. If
the honest answer is "cannot decide without data", say which data, and record that as the
decision with the measurement that would settle it.

Acceptance: ADR-017 has a terminal status with a dated rationale; phase-32 and plans/README
agree with it; if accepted, a scoped follow-up item exists. No wave-execution code.
```

---

## Post-merge follow-ups (not items — reminders)

- After 28.x lands: re-run the D5 / H3 evidence reviews (plans/adaptive-routing-evidence.md,
  plans/h3-ground-truth.md) once ≥2 real projects have corpus data — the gates were
  blocked on exactly this telemetry.
- After 31.x lands: refresh docs/comparative-analysis.md §"mechanically overrules model
  claims" with the new stampable-stage count.
- After 33.2 lands: add the stub-eval CI job to .github/workflows/test.yml (separate
  small PR; workflow edits are deliberately excluded from the items above).
```
