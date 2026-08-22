# Builder Review — August 2026

Status: **Wave 0 delivered** (2026-08-20); **F5 decomposition and the `devteam chat` audit
delivered** (2026-08-22). An architecture, implementation, and roadmap review taken at Phase
42.2, from a builder's perspective: what is costing money, what is costing quality, and what
is blocking the roadmap's own gates.

Kept current as the work lands — see [§8](#8-what-shipped-after-wave-0) for everything
merged since, and what running the code found that reading it had not.

Like [`experience-review-2026-08.md`](experience-review-2026-08.md), this review is
**measured rather than read**. Every number below came from running the CLI against
throwaway projects on 2026-08-20 — a fresh `git init`, `npm init`, one source file, then
`devteam init --host claude-code`. Where a claim is about code rather than behavior, the
file and line are cited so it can be re-checked.

Findings carry IDs (F1–F8) so they can be referenced from commits and PRs. Seven are fixed,
one was closed by measurement rather than built.

- [1. Headline](#1-headline)
- [2. Findings](#2-findings)
- [3. Are the tracks reasonable?](#3-are-the-tracks-reasonable)
- [4. Speed, cost, and self-learning](#4-speed-cost-and-self-learning)
- [5. DX and the conversational opening](#5-dx-and-the-conversational-opening)
- [6. Roadmap](#6-roadmap)
- [7. What Wave 0 changed, measured](#7-what-wave-0-changed-measured)
- [8. What shipped after Wave 0](#8-what-shipped-after-wave-0)

---

## 1. Headline

The architecture is not the problem. The discipline is real and unusually good: 22 ADRs,
dated no-go reviews that refuse to activate features on thin evidence, 3,297 tests in 74
seconds with zero failures, and a codebase that warns when its own cost model cannot price
a model.

Three things were wrong underneath it:

1. **Three shipped features silently cancel each other out** on `build` and `qa`, the two
   most expensive stages (F1 — fixed, [ADR-023](../docs/adr/023-goal-condition-in-prompt-body.md)).
2. **A stale 30-line lookup table**, not insufficient dogfooding, is what held the Phase 41
   evidence gates shut (F3 — fixed).
3. **Stagecraft's own installed files were being read as the operator's diff** by three
   different subsystems, which in one of them multiplied the cost of every new project's
   first run by ~5× (F2/F8 — fixed).

### The finding that changes the roadmap

The [2026-08-19 Phase 41 review](phase-41-evidence-review-2026-08.md) declared D5 adaptive
routing NO-GO on `projects-with-cost-telemetry: 0/2` and concluded that more collection was
needed. That conclusion was wrong in a specific way: **neither host could report a cost.**

```
$ node -e 'console.log(require("./core/pricing").pricingFor("claude-opus-5"))'
null
```

`core/pricing.js` was last refreshed in May and had no entry for any model released since.
Independently, `core/adapters/codex-exec-json.js` sets both `costUsd` and `model` to `null`
by design — correct at the adapter boundary, but nothing downstream filled the gap. Both
projects in that review routed through Codex. A third and fourth project would have
returned `0/2` again.

This is roughly a day of work and it is the prerequisite for the entire evidence-gated half
of the roadmap.

---

## 2. Findings

| ID | Finding | Severity | Status |
|---|---|---|---|
| F1 | `build`/`qa` discard the inlined framework and retry guidance on every dispatch to fit a `/goal` directive that only sometimes survives | Critical | Fixed (#435, [ADR-023](../docs/adr/023-goal-condition-in-prompt-body.md) accepted) |
| F2 | The changed-file manifest treats Stagecraft's own install as the user's diff | High | Fixed (#431) |
| F3 | Cost telemetry is structurally impossible, which is what blocks the Phase 41 gates | High | Fixed (#429, #430) |
| F4 | Prompt budget is ~99% process and ~1% project | Medium | **Closed — not worth doing**; see §4 |
| F5 | The driver's core loop is a 1,730-line function | Medium | Fixed — prologue fully extracted (#445, #456, #459, #461, #463) |
| F6 | The factory default contradicts the documentation | Medium | Fixed (#432) |
| F7 | CLI vocabulary drifts across commands | Medium | Fixed (#433) |
| F8 | Track inference promoted every new project to `full` because of the word "authoring" | High | Fixed (#431) |

### F1 — `build` and `qa` lose their framework to a `/goal` directive (fixed, #435)

Exactly two stages declare a `goalCondition`: `build` (stage-04) and `qa` (stage-06) — the
two most expensive and most retry-prone stages in the pipeline. Both primary hosts,
`claude-code` and `codex`, declare `goalLoop: true` with `promptCharLimit: 4000`.

When a composed `/goal`-prefixed prompt exceeds that limit,
`shrinkComposedPrompt()` (`core/adapters/render-helpers.js`) runs a three-step fallback:
drop `patchItems` (retry blocker guidance), then drop the inlined framework, then drop the
`/goal` directive itself. In a real project the prompt never fits, so **all three fire on
every build and qa dispatch.**

Measured on the actual dispatch path, with `DEVTEAM_HEADLESS_COMMAND=cat` so the log holds
the exact bytes the host CLI would have received:

| Dirty files | Bytes sent | Inlined framework | `/goal` survives |
|---:|---:|:---:|:---:|
| 3 | 3,848 | ✗ dropped | ✓ |
| 12 | 4,742 | ✗ dropped | ✗ |
| 30 | 6,758 | ✗ dropped | ✗ |

A with-framework prompt is roughly 21 KB, so step one never suffices and **step two always
runs: the inlined framework is discarded on every build and qa dispatch.** Whether the
directive then survives depends on how many files happen to be dirty — at 3 changed files it
fits, at 12 it does not. The same change, committed or not, converges or does not.

> **Correction (2026-08-20).** This section originally claimed the `/goal` directive is
> *always* dropped and the condition therefore reaches no model at all. That was measured on
> the preview path (`devteam stage`), not the dispatch path, and it is wrong: the directive
> survives on a sufficiently clean tree. The unconditional cost is the discarded framework,
> not the discarded directive. See [ADR-023](../docs/adr/023-goal-condition-in-prompt-body.md).

The cost of the trade:

- [Phase 37](phase-37-interface-and-token-efficiency.md) item 37.2's inlined cacheable
  prefix — the ~22 KB that exists so the model stops re-reading those files through tool
  calls — is thrown away on the two stages where it matters most.
- `patchItems`, the blocker guidance a fix-and-retry depends on, is dropped first.
- Each dispatch renders the prompt three times to discover this.
- `codex` declares `goalLoop: true` but `codex exec` has no slash-command layer at all, so
  it pays the whole cost for a directive it cannot act on.

**Why this is not a patch.** The why-comment at `core/orchestrator.js` already documents
that `--print` mode measures the combined length and cannot separate the goal from the
prompt. Trading ~18 KB of framework context for a 4,000-char directive would be a defensible
thing to decide — but it was never decided, and it only sometimes buys the directive.
Resolved by [ADR-023](../docs/adr/023-goal-condition-in-prompt-body.md): the condition moves
into the prompt body, the fallback chain is removed, and every host receives it.

### F2 — Framework install read as the operator's diff (fixed, #431)

`core/context-manifest.js` ignored `.git/`, `.devteam/`, `.codex/`, `.codex-tmp/`,
`.devteam-tmp/` and `pipeline/` — but not `.claude/`. Since `devteam init --host
claude-code` writes 68 files into `.claude/` and the managed `.gitignore` block does not
cover them, every dispatch until the operator committed them carried the framework's own
install as changed files.

Measured on a fresh init with one source file:

```
manifest entries:            39
of which .claude/ framework:  37
section weight:            5353 bytes
```

The SHA-256 digests make it worse: 64 hex characters per entry that a model cannot act on,
having nothing to compare them against.

This is the Phase 41 review's finding #7 ("dogfood bootstrap files appeared in the product
diff"), but it is not a dogfooding artifact — it reproduces in any freshly initialized
claude-code project.

**The root cause was worse than one missing prefix.** Three readers each carried their own
copy of the list — the manifest, `isRightSizingInputPath`/`listProjectFiles` in
`core/pipeline/right-sizing.js`, and the file list `devteam assess` scores — and all three
had drifted identically. The fix puts one predicate in `core/paths.js`
(`FRAMEWORK_OWNED_PREFIXES` / `isFrameworkOwnedPath`), matching on a full path segment so a
project's own `.claude-notes/` or `src/agents/` is never swallowed. A drift-guard test reads
every `hosts/*/capabilities.json` and fails when a declared `skillsDir` or `rolePromptsDir`
root is missing.

### F3 — Cost telemetry structurally impossible (fixed, #429 + #430)

Two independent holes made a USD figure unreachable on the hosts actually in use:

- `core/pricing.js` had no entry for any current frontier model. Lookups returned `null`,
  so `computeCostUsd()` returned `null`, so `--budget-usd` degraded to the D7
  unpriced-model warning and enforced nothing.
- The Codex adapter reports neither a model id nor a cost, so even a current table could
  not price a Codex dispatch.

The refresh also corrected four rates that were **wrong rather than merely missing**:
Opus 4.7/4.6 listed at $15/$75 against an actual $5/$25; GPT-5 at $10/$30 against
$1.25/$10; Gemini 2.5 Flash at $0.075/$0.30 against $0.30/$2.50; Haiku 4.5 at $0.80/$4.00
against $1.00/$5.00.

The wider table exposed a latent hazard: the prefix fallback used a bare `startsWith()`, so
`gpt-5.6-sol` matched the `gpt-5` entry at a quarter of its real input rate. Matching now
requires a `-` boundary, so an unlisted sibling returns `null` and raises the honest warning
instead of a silently low price.

`model_requested` was already on the gate from [phase-32](phase-32-performance-parallelism.md)
item 32.3, so #430 derives a cost from observed tokens × the table when a host reports none.
**The derived figure is written to `cost_usd_derived`, never `cost_usd`** — a product of
observed tokens and a table we maintain is a weaker evidence class than a figure the host
reported, and collapsing them would launder an estimate into an observation. `cost_basis`
gains a `derived` value; any mixture reports `mixed`.

### F4 — Prompt budget is ~99% process (closed by measurement)

A build prompt for a one-function change was 28,296 bytes. The Project Knowledge Pack — the
part carrying anything specific to *this* repository — was about 250 of them.

```
5353  Changed-file manifest        (37/39 entries were framework — see F2)
2883  On a Build Task
1726  Pipeline Rules — Index
1255  Failure classification
1234  Gate to write
1216  Tamper-evident chain
 855  On a Code Review Task       ← not this stage
 850  Rubric (review)             ← not this stage
 782  On a Retrospective Task     ← not this stage
 268  Project Knowledge Pack      ← the only project-specific part
```

Some of this is the deliberate [phase-32](phase-32-performance-parallelism.md) item 32.1
trade: a byte-identical prefix is worth extra bytes if a cache reuses it.

> **Closed by measurement (2026-08-21).** The proposed fix — scope the inlined rules to the
> dispatched role — is not worth doing, and would probably make things worse. A real
> stage-04 dispatch on claude-code touched **2,114,469 tokens**: 66 uncached input, 14,866
> output, 2,049,649 cache reads, 49,888 cache writes. The entire rendered prompt is ~5,400
> tokens — **0.26%** of that. Trimming the ~2.9 KB of cross-stage rules saves roughly 0.03%
> of a dispatch while fragmenting the shared prefix across roles: on a `loop` run, four
> dispatches to four different roles, that trades three potential prefix hits for none. The
> cost is the agentic loop re-reading its accumulated context every turn, not the prompt.
> See §4.

### F5 — `run()` is a 1,730-line function (fixed: prologue extracted)

`run()` spanned `core/driver.js:872–2602`. The audit's P2-2 decomposition extracted the
dispatch, transient, and fix/ruling transitions and explicitly left `run()` owning "lock,
loop, effect, and final persistence" — but that residue was larger than most projects'
entire orchestrators.

Five slices later the whole prologue — everything between entry and the first dispatch —
lives in named modules:

| Slice | Module | What it owns | PR |
|---|---|---|---|
| 1 | `core/driver-runend.js` | run-end side effects | #445 |
| 2 | `core/driver-safety.js` | cap resolution and its warnings | #456 |
| 3 | `core/driver-stage-order.js` | ADR-009 stage order, `--until` validation | #459 |
| 4 | `core/driver-run-state.js` | run state and its token accounting | #461 |
| 5 | `core/driver-plan.js` | plan inputs and materialization | #463 |

`run()` is **1,629 lines**, down from 1,780; `core/driver.js` is 2,367, down from 2,604.

**What actually made this safe was not the extraction discipline — it was measurement.**
Two characterization suites landed *before* the slices they protected (#457, #462), using
`--plan-only` as a harness because it runs the entire prologue and halts before the first
dispatch. Then every slice was mutation-tested: perturb the extracted logic, confirm a test
fails.

That found four things a passing suite had not:

- **A test that constrained a relationship but never a value.** The stage-disposition
  assertion checked `included + skipped_by_config + skipped_by_right_sizing == total`, which
  holds just as well when right-sizing produces nothing at all. Deleting right-sizing passed
  it. Three mutations escaped through that one gap (#463).
- **A fixture too bare to exercise the code.** The shared test project has no source files,
  so right-sizing and active-role discovery answer `[]` whatever they do. `makeRealisticProject`
  fixed that; a project with a frontend keeps 15 of 18 stages where a bare one keeps 13 (#466).
- **A whole path the suite never touched.** Six mutations of resume reconciliation — resetting
  the run lineage, dropping the `prior_run_id` link, inheriting a dead wave — all passed,
  because the suite only ever compared plan fingerprints across a resume (#461).
- **Real defects in the code being extracted**, described in [§8](#8-what-shipped-after-wave-0).

**Not done:** the dispatch loop itself, which is most of the remaining 1,629 lines. It needs
a different harness — it is stateful, mutates `state` and `summary` throughout, and has no
equivalent of `--plan-only` as an observation point. That harness should be designed
deliberately rather than approached with more cutting.

### F6 — Factory default contradicted the docs (fixed, #432)

`devteam init` wrote `pipeline.default_track: full`, while
[ADR-016](../docs/adr/016-assess-by-default.md)/[ADR-018](../docs/adr/018-materialized-run-plan-and-loop-default.md)
already inferred `loop` and [`docs/tracks.md`](../docs/tracks.md) told operators to pick
`loop`. Measured on the same trivial change:

```
loop    4 slots,      4 dispatches,  ~20,899 tokens   ← recommended
quick   8 slots,     15 dispatches,  ~77,497 tokens
full   18 slots,  23–25 dispatches, ~130,722 tokens   ← factory default
```

**One value deliberately did not change.** A config file that names no `default_track` still
resolves to `full`. Choosing a default for a new project and silently reducing rigor for an
existing one that never chose are different decisions.

### F7 — CLI vocabulary drift (fixed, #433)

`run` and `stage` take `--feature`; `assess` took `--description` and exited 2 on the
spelling the quickstart teaches. Separately, there was no way to inspect
`pipeline/run-plan.json` — described by ADR-018 as "an inspectable execution contract" —
without committing to the run it governs. `run --plan-only` now halts immediately after the
plan is built, fingerprinted, and persisted; because it stops after the same build/persist
path a real run uses, the previewed plan *is* the plan that would execute, and
`devteam run --resume` executes it byte-for-byte.

### F8 — Track inference promoted every new project to `full` (fixed, #431)

This one was not in the original review — it surfaced while fixing F2, and it is the most
expensive defect of the set. The same missing path filter fed Stagecraft's own installed
files into `assess`'s security heuristic, which matches `/auth/i` as a bare substring:

```
Recommended track: full  (confidence: high ✓)
Reasons:
  • no specialized track indicators found; defaulting to the day-to-day loop
  • security review required: 9 file(s) match security patterns
  • track bumped from "loop" to "full": security review required

# the files doing it:
  .claude/skills/qa-test-authoring/SKILL.md   → matched /auth/i
  .claude/skills/spec-authoring/SKILL.md      → matched /auth/i
```

So the first run in every freshly initialized project paid `full` — 20–22 dispatches,
~115,000 tokens — instead of `loop`'s 4, and reported that a security review was required
for files Stagecraft had written itself moments earlier. Roughly a 5× cost multiplier,
triggered by a substring inside the word "authoring".

**Deliberately not fixed:** the substring matching itself. "author", "authentic", and
`authorized_keys` all trip `/auth/i`, but narrowing a security trigger is a safety-relevant
change that deserves its own ADR rather than a quiet edit inside a path-filter PR. The
heuristic is untouched — `src/auth/session.js` and a changed `package.json` still promote
to `full`.

---

## 3. Are the tracks reasonable?

The three-way framing is right, and [`docs/tracks.md`](../docs/tracks.md) already says the
right thing: `loop`, `quick`, and `full` are the assurance axis; the rest are shape-selected
profiles. Real evidence supports keeping the ceremony — the Phase 41 review recorded that QA
and peer review caught two stale documents earlier searches had missed. **Do not cut
stages.**

The problem is the surface, not the pipeline. There are ten track names, and four are
variants of a single three-stage shape:

Measured dispatches, which is what actually costs money — stage count is not:

| Track | Documented as | build | peer-review | total |
|---|---|---:|---:|---:|
| `loop` | "Lightest" | **1** | **1** | **4** |
| `nano` | "Minimal" | 4 | 1 | 6 |
| `refactor` | "Minimal" | 4 | 1 | 6 |
| `dep-update` | "Light" | 4 | 4 | 12 |
| `quick` | "Light" | 4 | 4 | 15 |

| Track | Stage list | Actually differs by |
|---|---|---|
| `nano` | build → peer-review → qa | — (the base shape) |
| `refactor` | build → peer-review → qa | Identical list. Characterization objective, behavior-preserved QA bar, mutation gate on. |
| `dep-update` | build → peer-review → qa → sign-off → deploy | Adds the delivery pair. |
| `loop` | requirements → build → qa → peer-review | Adds a brief; verify before review. |

Those four names cost a 250-line explainer, a nine-branch decision tree, and a recurring
"which track?" decision that `assess` then makes for the operator anyway. Underneath, the
difference is three orthogonal modifiers: *does it need a brief*, *does it deploy*, and *is
behavior meant to be preserved*.

> **Measurement note (2026-08-22).** These counts depend on what is dirty at preflight.
> `expectedRolesForStage()` returns *every* role when active-role discovery finds nothing,
> and discovery reads `gitChangedFiles()`. A run plan is materialized before any stage
> dispatches, so on a new feature the tree is clean, discovery returns `[]`, and every track
> falls through to the four-area matrix — which is the row above and the scenario `nano` is
> normally started in. Against a tree that *already* has one area dirty, the same tracks
> measure `nano` 2 and `loop` 3.
>
> An earlier revision of this note claimed the table "does not survive a real repository"
> and recommended against ADR-025. That was measured on the dirty-tree case and generalized
> from it; the table is correct for the case it describes. ADR-025 is accepted and
> implemented — see its Measurement note.

**Recommendation (implemented).** Keep three visible tracks, and **scope the build, not
just the review.** `PEER_REVIEW_SIZING` gives `nano`, `refactor`, and `review-pr` a single reviewer,
but nothing scopes build except `loop`'s `loopBuildRole`. So `nano` runs a four-area build
matrix and then has one reviewer look at all of it — the funnel narrows where the cost has
already been spent. Pairing the two takes `nano` and `refactor` from 6 dispatches to 3.
[ADR-025](../docs/adr/025-scope-build-not-just-review.md) has the measurements, the
assurance tradeoff this accepts, and why `dep-update` is deliberately left alone.

~~Demote the four variants to modifiers on `loop`.~~ **Rejected by ADR-025**: it deprecates
track names living in user config files and `pipeline/track.json` records for a
surface-area win, and the ceremony reduction comes from the scoping change, not the
renaming. The renaming can be evaluated separately on its own merits.

Leave `review-only`, `review-pr`, `config-only`, and `hotfix` alone. These are genuinely
different shapes with different entry conditions, not points on a slider.

---

## 4. Speed, cost, and self-learning

### Where the money goes — measured

This section originally argued that per-dispatch framework overhead dominates on light
tracks. **That was wrong, and the correction is the most useful number in this review.**

Two real `build` dispatches on claude-code 2.1.207 — same project, same feature, run back
to back:

| | dispatch 1 | dispatch 2 |
|---|---:|---:|
| Uncached input | 48 | 66 |
| Output | 15,020 | 14,866 |
| Cache write | 51,789 | 49,888 |
| Cache read | 1,526,680 | 2,049,649 |
| **Total touched** | **1,593,537** | **2,114,469** |
| Cost | $1.00 | $1.14 |

The rendered prompt was 21,408 bytes — about 5,400 tokens, or **0.26%** of one dispatch.
The other 99.7% is the host's own agentic loop: every turn re-reads the accumulated
conversation, which is what the cache-read column is. **Prompt-shaving is therefore not a
cost lever at all.** What costs money is how many turns the agent takes, and the things that
move that are track choice, scope, and `--budget-usd`.

Three consequences worth stating plainly:

- **A `loop` run costs roughly $4, not cents.** Four dispatches at ~$1 each. `full`, at
  20–25 dispatches, is $20–30. The ceremony preview's `~21,334 tokens` is an accurate count
  of prompt bytes and a ~94×-low proxy for a run.
- **Caching is working hard** — 29–41× reads per write — but *within* a dispatch, across
  agentic turns. Cache writes stayed near 50K on both dispatches, so there is no evidence of
  cross-dispatch prefix reuse; phase-32.1's byte-stable prefix is not producing the saving
  its design assumed. It matters little, because within-dispatch reuse dwarfs it either way.
- **This is why F4 is closed.** Optimizing the prompt optimizes 0.26% of the bill.

### Why agents don't act like seniors

The learning machinery is more complete than most teams ever build: sanitized observations,
typed fingerprints, human promotion, injection budgets, recurrence counters, automatic
quarantine at three recurrences, SKILL.md export, and an opt-in Reflector pass modeled on
ACE. The design anticipated the failure modes — prompt bloat, stale lessons, overfitting to
one reviewer — and answered each. See [`docs/pattern-learning.md`](../docs/pattern-learning.md).

Two structural properties keep it from producing a senior on day one:

- **It only learns from pain.** Every gate-derived observation starts as a blocker, a
  warning, or a follow-up. A brand-new project's knowledge pack is three lines of trivia —
  language, package manager, test command. There is no path from "this repo has ten years of
  conventions written down" to "the agent knows them" short of failing a gate first.
- **Promotion is O(human).** Nothing enters a prompt without `devteam patterns promote`.
  That was right while the loop was unproven, but quarantine now exists as a working safety
  valve, which weakens the argument for gating every promotion.

**Cold-start seeding.** `devteam standards discover` scans 50 files for stack facts. It does
not read the repository's own written conventions — `CONTRIBUTING.md`, `AGENTS.md`, existing
ADRs, review comments on merged PRs, the shape of the existing test suite. Those are exactly
what a senior engineer absorbs in week one, and they exist as text before Stagecraft ever
runs. A one-time `devteam patterns seed` proposing candidates from them — into the same
review queue, behind the same promotion gate and secret scanning — turns day-one knowledge
from three lines into something worth injecting.

**Bounded auto-promotion.** Promote automatically at N recurrences when the fingerprint is
schema-bound and unambiguous, record `source: auto`, and let the existing quarantine path
demote it. Keep the human gate for anything judgment-shaped. This is listed in
`docs/pattern-learning.md`'s own open decisions; the safety valve that made it risky has
since shipped.

Both stay inside the evidence boundary: seeding proposes candidates rather than injecting
them, and auto-promotion records provenance and stays reversible. Neither lets telemetry
rewrite rules, roles, or source — the line Phase 42's non-goals draw.

---

## 5. DX and the conversational opening

[Phase 37](phase-37-interface-and-token-efficiency.md) clearly worked. Per-command help,
grouped command listing, and a real quickstart are all present, and the install is instant.
The dev loop is genuinely fast — 3,297 tests in 74 seconds, consistency in 0.4s, lint in
2.2s. Better than most projects this size.

What was left is smaller and mostly above: the `--description` stumble (F7), the missing
plan preview (F7), the `full` default (F6), and 71 files landing in the operator's repo with
`.claude/` outside the managed ignore block (F2).

### Is there an opening for a conversational agent?

Yes — but not the one usually meant, and the right half is already built.
[`devteam chat`](../docs/conversational-coordinator.md) is grounded, read-only, and
mechanically prevented from acting. [Phase 40](phase-40-conversational-artifact-refinement.md)
then added the pattern that matters: a conversational turn produces a *typed proposal* with
an exact diff and an invalidation preview, and a separate explicit command applies it. **That
split is the correct architecture and should not be relaxed.**

The opening is that Phase 40 applied it to two artifacts — requirements and design — and
stopped. The places an operator actually gets stuck are typed decision points with the same
shape:

| Where you get stuck | Today | Proposal/apply version |
|---|---|---|
| `judgment-gate` | Read the gate, write a ruling by hand | Chat drafts the ruling with its `[class:]`; operator applies or rejects |
| `retry-ownership` | Halt names the incompatible roles; operator reconciles manually | Chat proposes the owner or scope change, bounded by existing `roleWrites` |
| `patterns review` | Read candidates, hand-write `prompt_text` | Chat drafts prevention text from the observations; promotion stays explicit |
| track choice | `assess` heuristics, low confidence on generic descriptions | Chat explains the tradeoff against this repo and proposes a track record |

Each is a bounded schema, each keeps the model advisory, and each removes a place where the
human is transcribing rather than judging. The core still never spawns a model, and nothing
gains an execution path.

One smaller thing: chat holds eight turns in process memory and starts fresh every
invocation. For an operator working a halted run across several commands, the session that
understands the halt evaporates between questions. A run-scoped, on-disk session — bounded
and redacted the way the snapshot already is — would fix it without changing the authority
model.

> **Corrected by measurement (2026-08-22).** The paragraph above was written from reading
> the code, and the audit in [§8](#8-what-shipped-after-wave-0) found the priority inverted.
> The architecture is as sound as claimed — ids are validated against traversal, apply and
> reject are status-guarded, history is bounded three ways, the artifact write is a
> transaction with rollback. But three of the snapshot's `run` fields were reading keys
> **nothing had ever written**, so the coordinator could not tell a halted run from a
> running one while answering "why did this stop?". Session persistence is worth less than
> making the current turn tell the truth, and that is now fixed. Re-rank accordingly.

---

## 6. Roadmap

Sequenced by what unblocks what.

### Wave 0 — Unblock the evidence gates ✅ delivered

Five independent PRs, each one commit with tests, docs, and (where guarded paths are
touched) a changelog fragment.

| PR | Fixes |
|---|---|
| [#429](https://github.com/telus-labs/stagecraft/pull/429) | F3a — pricing table refresh + boundary-safe prefix match |
| [#430](https://github.com/telus-labs/stagecraft/pull/430) | F3b — derived cost for hosts that report tokens but no dollars |
| [#431](https://github.com/telus-labs/stagecraft/pull/431) | F2 + F8 — one shared framework-owned-path predicate |
| [#432](https://github.com/telus-labs/stagecraft/pull/432) | F6 — `loop` as the written default track |
| [#433](https://github.com/telus-labs/stagecraft/pull/433) | F7 — `assess --feature`, `run --plan-only` |

### Wave 1 — Fix the dispatch economics

Wave 1 is complete. Its lasting result is not a saving but a correction: measurement showed
that two of its four items were optimizing the wrong 0.26% of a dispatch.

1. ✅ **F1 — ADR on goal-loop under `--print`.**
   [ADR-023](../docs/adr/023-goal-condition-in-prompt-body.md) /
   [#435](https://github.com/telus-labs/stagecraft/pull/435). The condition moved into the
   prompt body, the fallback chain is gone, and `build`/`qa` keep their inlined framework
   and retry guidance.
2. ⛔ **F4 — scope inlined rules to the dispatched role. Closed, not built.** The whole
   rendered prompt is 0.26% of a dispatch; scoping it per role would fragment the shared
   prefix for no measurable gain. See §4.
3. ✅ **Record cache-hit rates in the corpus**
   ([#436](https://github.com/telus-labs/stagecraft/pull/436)) — the measurement that closed
   F4. **Enabling `openai-compat` breakpoints by default remains open**, and should be
   decided against that host's own numbers rather than claude-code's.
4. ✅ **Re-run the ceremony preview.** The static numbers barely moved (~2%), because they
   count prompt bytes — which is exactly §4's point. Separately, the preview's
   `observed-total` was found to exclude the cache counters and under-report by ~140×; that
   is corrected.

### Wave 2 — Finish Phase 42, then reduce ceremony

1. **42.3 — documentation-capable build ownership.** ✅ Shipped in
   [#428](https://github.com/telus-labs/stagecraft/pull/428) / [ADR-022](../docs/adr/022-exact-file-documentation-workstream.md),
   taking the exact-approved-file-set direction rather than the wildcard that would have
   undone 42.2.
2. **42.4 — project-layout-aware QA.** Pairs naturally with cold-start seeding; both are
   "read what the repo actually is" work.
3. **Track consolidation** — `nano`/`refactor`/`dep-update` become `loop` plus modifiers,
   and `loop --deploy` fills the 4-to-15 dispatch gap. Shares an ADR review with 42.4.
4. **42.5 / 42.6** — logical-run evidence semantics and dogfood bootstrap isolation. Note
   that #431 removes much of 42.6's motivation on its own.
5. ~~**F5 — continue the P2-2 decomposition.**~~ **Done 2026-08-22** for the prologue —
   five slices, #445/#456/#459/#461/#463. The dispatch loop remains and needs a harness
   designed first; see F5 above.

### Wave 3 — Make the agents senior

Deliberately last: every item is more valuable once dispatches carry a trustworthy cost,
because that is what distinguishes an improvement from a regression.

1. **Cold-start pattern seeding** from `CONTRIBUTING.md`, `AGENTS.md`, existing ADRs, and
   merged-PR review comments — into the existing candidate queue, behind the existing gate.
2. **Bounded auto-promotion** at N recurrences for schema-bound fingerprints, tagged
   `source: auto`, reversible through the quarantine path that already works.
3. **Extend proposal/apply to rulings, retry ownership, and pattern text.**
4. **Run-scoped chat sessions** so the context that understands a halt survives between
   commands. Demoted after the §8 audit: the per-turn snapshot was the real gap, and it is
   fixed. This is now a convenience, not a correctness item.
5. ~~**Re-run the Phase 41 review.**~~ **Done 2026-08-21** —
   [`phase-41-evidence-review-2026-08-21.md`](phase-41-evidence-review-2026-08-21.md).
   Still NO-GO, and it found that F3's fix is incomplete: the gate-level cost telemetry
   works (a fresh run's corpus carries $1.88 across 4/5 dispatches), but
   `dispatchObservation` records the *model-asserted* cost and model rather than the
   observed ones, so the evidence path still reports `cost_obs: 0`. `costEntryForGate` is
   defined immediately above it with the right precedence and is not used. That one fix,
   plus a second project and a second host, is what the gate now waits on.

---

## 7. What Wave 0 changed, measured

Same project, same command, before and after the five PRs:

| Measure | Before | After |
|---|---|---|
| Manifest entries (fresh init) | 39 (37 framework) | 2 (0 framework) |
| Build prompt | 28,296 B | 23,224 B |
| Files reaching `assess` | 75 | 4 |
| Inferred track for a one-function change | `full` (18 stages) | `loop` (4 stages) |
| Planned dispatches | 20–22 | 4 |
| `pricingFor("claude-opus-5")` | `null` | `$5 / $25` per Mtok |
| `--budget-usd` on codex | inert | binds via derived cost |

```
$ devteam run --feature "add a subtract function to src/index.js" --plan-only
[devteam run] plan: loop track, 4/4 stages, 4 base workstreams
[devteam run] halted (plan-only) — 0 iteration(s), 0 stage(s) advanced
  reason: plan materialized at pipeline/run-plan.json; no stage dispatched
```

Suite after all five: 3,297 passing, 408 consistency checks, lint clean.

**What this does not claim.** None of it is evidence that the pipeline produces better
software — only that it now costs what it was designed to cost and can report what it
spent. Whether the D5 and H3 gates open is a question for the next evidence review, run
against real collection rather than against these numbers.

---

## 8. What shipped after Wave 0

Eleven PRs merged 2026-08-21 to 2026-08-22, in two arcs: finishing F5's decomposition, and
auditing `devteam chat` — the one shipped command that had no test file of its own.

| PR | What | Kind |
|---|---|---|
| [#456](https://github.com/telus-labs/stagecraft/pull/456) | `core/driver-safety.js` — cap resolution | refactor |
| [#457](https://github.com/telus-labs/stagecraft/pull/457) | 19 prologue characterization tests | test |
| [#458](https://github.com/telus-labs/stagecraft/pull/458) | `--until` honesty; `--plan-only` exits 0 | fix |
| [#459](https://github.com/telus-labs/stagecraft/pull/459) | `core/driver-stage-order.js` | refactor |
| [#460](https://github.com/telus-labs/stagecraft/pull/460) | one home for `nonNegativeNumber` | refactor |
| [#461](https://github.com/telus-labs/stagecraft/pull/461) | `core/driver-run-state.js` | refactor |
| [#462](https://github.com/telus-labs/stagecraft/pull/462) | 6 resume-drift characterization tests | test |
| [#463](https://github.com/telus-labs/stagecraft/pull/463) | `core/driver-plan.js` | refactor |
| [#464](https://github.com/telus-labs/stagecraft/pull/464) | chat can see how the run ended | fix |
| [#465](https://github.com/telus-labs/stagecraft/pull/465) | recover an interrupted proposal apply | fix |
| [#466](https://github.com/telus-labs/stagecraft/pull/466) | a test fixture with real files | test |
| [#467](https://github.com/telus-labs/stagecraft/pull/467) | `/status` says why the run stopped | fix |

Suite: **3,518 passing** in 79 seconds, 411 consistency checks, lint clean — up from 3,297.

### Four defects, all found by running the code

Every one was invisible to reading, and each was found by exercising a surface rather than
reasoning about it.

**`--until` silently ran the whole track.** Dispatch reads `untilIndex < 0` as "no limit",
and `order.indexOf()` returns `-1` for any stage the resolved track does not contain. So
`--until buidl`, or a stage borrowed from another track, did not stop the run early — it
removed the boundary entirely and ran through to `deploy`, without a warning. The run plan
never recorded the boundary either, so ADR-018's "inspectable execution contract" reported
all 13 stages of `full` as included with `--until build` set (#458).

**Three chat snapshot fields were structurally dead.** `run_id`, `status`, and `halted` read
keys nothing in the codebase has ever written to `run-state.json`. A user asking "why did the
run stop?" got `halted: null` and `unavailable: []` — nothing missing, said the snapshot,
while the prompt instructed the model to call out missing evidence. `halt_reason` was set by
all thirteen halt paths but only on the in-memory summary, so it reached the terminal and
nothing else. A run that ended by *throwing* left no record anywhere at all (#464).

**An interrupted proposal apply cost the operator both the proposal and a gate.** Apply moves
invalidated gates into `pipeline/proposals/.apply-<id>/`, rewrites the artifact, then removes
the directory. Its rollback deliberately preserves that directory rather than risk losing the
gates — but nothing put them back, and the damage compounded: the next apply saw a smaller
gate set, marked the proposal **permanently stale**, and reported "its invalidation set
changed" while the gate sat in a dotted directory nothing mentions (#465).

**`/status` contradicted itself.** It labelled `next().reason` as "why", so a failed run
printed `run: failed; stage requirements` directly above `why: stage not started` (#467).

### What this says about the test suite

The suite is large and it is not the same thing as coverage. Mutation testing every extracted
module — perturb the logic, confirm a test fails — found gaps a green run never would:

- an assertion that pinned a **relationship between numbers but never the numbers**, through
  which three mutations escaped
- a **fixture too bare to exercise the code**: no source files, so right-sizing and role
  discovery return `[]` regardless of whether they work
- an entire **untested path** — resume reconciliation — where six mutations all passed

Two of these were in characterization tests *I had written two PRs earlier*. Writing the test
first is necessary and not sufficient; the test also has to be shown to fail.

### The pattern worth keeping

Nine times across this work, measurement overturned something reasoned from the code — the
121× `--budget-tokens` error, `/goal`'s real behavior, the 3.75× track gap that was not one,
cost coverage that was `0/2` because neither host could report, `--repair`'s stoplist
escalation, `--plan-only`'s exit code, the legacy-plan fingerprint fallback, right-sizing's
deliberate absence from the execution fingerprint, and every defect above.

The corrections are left inline throughout this document rather than edited away, because
the pattern is the finding: **on this codebase, reading is a hypothesis and running is
evidence.**
