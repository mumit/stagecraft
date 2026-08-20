# Builder Review — August 2026

Status: **Wave 0 delivered** (2026-08-20). An architecture, implementation, and roadmap
review taken at Phase 42.2, from a builder's perspective: what is costing money, what is
costing quality, and what is blocking the roadmap's own gates.

Like [`experience-review-2026-08.md`](experience-review-2026-08.md), this review is
**measured rather than read**. Every number below came from running the CLI against
throwaway projects on 2026-08-20 — a fresh `git init`, `npm init`, one source file, then
`devteam init --host claude-code`. Where a claim is about code rather than behavior, the
file and line are cited so it can be re-checked.

Findings carry IDs (F1–F8) so they can be referenced from commits and PRs. Five are fixed;
two are deliberately left open because they need a recorded decision rather than a patch.

- [1. Headline](#1-headline)
- [2. Findings](#2-findings)
- [3. Are the tracks reasonable?](#3-are-the-tracks-reasonable)
- [4. Speed, cost, and self-learning](#4-speed-cost-and-self-learning)
- [5. DX and the conversational opening](#5-dx-and-the-conversational-opening)
- [6. Roadmap](#6-roadmap)
- [7. What Wave 0 changed, measured](#7-what-wave-0-changed-measured)

---

## 1. Headline

The architecture is not the problem. The discipline is real and unusually good: 22 ADRs,
dated no-go reviews that refuse to activate features on thin evidence, 3,297 tests in 74
seconds with zero failures, and a codebase that warns when its own cost model cannot price
a model.

Three things were wrong underneath it:

1. **Three shipped features silently cancel each other out** on `build` and `qa`, the two
   most expensive stages (F1 — still open).
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
| F1 | Goal-loop convergence is dead in production, taking framework inlining and retry guidance with it | Critical | **Open** — needs an ADR |
| F2 | The changed-file manifest treats Stagecraft's own install as the user's diff | High | Fixed (#431) |
| F3 | Cost telemetry is structurally impossible, which is what blocks the Phase 41 gates | High | Fixed (#429, #430) |
| F4 | Prompt budget is ~99% process and ~1% project | Medium | Open — Wave 1 |
| F5 | The driver's core loop is a 1,730-line function | Medium | Open — Wave 1 |
| F6 | The factory default contradicts the documentation | Medium | Fixed (#432) |
| F7 | CLI vocabulary drifts across commands | Medium | Fixed (#433) |
| F8 | Track inference promoted every new project to `full` because of the word "authoring" | High | Fixed (#431) |

### F1 — Goal-loop convergence is dead in production (open)

Exactly two stages declare a `goalCondition`: `build` (stage-04) and `qa` (stage-06) — the
two most expensive and most retry-prone stages in the pipeline. Both primary hosts,
`claude-code` and `codex`, declare `goalLoop: true` with `promptCharLimit: 4000`.

When a composed `/goal`-prefixed prompt exceeds that limit,
`shrinkComposedPrompt()` (`core/adapters/render-helpers.js`) runs a three-step fallback:
drop `patchItems` (retry blocker guidance), then drop the inlined framework, then drop the
`/goal` directive itself. In a real project the prompt never fits, so **all three fire on
every build and qa dispatch.**

Measured in the best possible case — clean tree, empty manifest, framework inlining already
off, a one-character feature string, a seven-file project:

```
build (no framework inline, no manifest noise):  4604 chars  [limit 4000]
qa    (no framework inline, no manifest noise):  4538 chars  [limit 4000]

# with defaults, same project:
build, framework inlined, real manifest:        28296 chars
```

Even after both content fallbacks, the prompt is still 15% over the ceiling. There is no
project small enough for `/goal` to survive. The consequences compound:

- Goal-loop convergence (backlog E7, marked shipped in v0.6.0) never engages on either
  primary host.
- [Phase 37](phase-37-interface-and-token-efficiency.md) item 37.2's inlined cacheable
  prefix is discarded on exactly the two stages where its ~22 KB would matter most — the
  agent reverts to reading those files itself, which is the round-trip cost 37.2 existed to
  remove.
- Retry blocker guidance is dropped from every repair dispatch.
- Each dispatch renders the prompt three times to discover this.

The tests encode the inverted assumption: `tests/orchestrator.test.js` asserts the goal
directive *must still reach the child*, and passes only because the fixture project is
small enough to fit. The last-resort path is tested as an edge case; in production it is
the only path.

**Why this is not a patch.** The why-comment at `core/orchestrator.js` already documents
that `--print` mode measures the combined length and cannot separate the goal from the
prompt. The choice is between dropping `/goal` from the headless path entirely (and
deleting the fallback chain) or gating `goalLoop` on a measured prompt size. Either changes
documented behavior on both primary hosts and belongs in an ADR.

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

### F4 — Prompt budget is ~99% process (open)

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
trade: a byte-identical prefix is worth extra bytes if a cache reuses it. But the build
prompt carries the peer-review rubric and the retrospective instructions, and per F1 the
cacheable half is discarded on this exact stage anyway. The one host where Stagecraft
controls cache breakpoints — `openai-compat` — has them `enabled: false` by default.

### F5 — `run()` is a 1,730-line function (open)

`run()` spans `core/driver.js:872–2602`. The audit's P2-2 decomposition extracted the
dispatch, transient, and fix/ruling transitions and explicitly left `run()` owning "lock,
loop, effect, and final persistence" — but that residue is larger than most projects'
entire orchestrators. `driver.js` is 2,604 lines; `orchestrator.js` is 2,754.

This is not causing bugs today; the suite is thorough. It is a velocity tax on exactly the
work Phase 42 has left — resume semantics, retry ownership, and evidence accounting all
live inside that function.

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

**Recommendation.** Keep three visible tracks. Demote the four variants to modifiers on
`loop` (`--deploy`, `--preserve-behavior`, `--no-brief`) — same stage machinery, one name to
learn. This needs an ADR because the stage role/write contract is load-bearing, so it
belongs behind [42.4](phase-42-dogfood-reliability.md), not in front of it.

Also: **fill the gap between 4 and 15 dispatches.** A bounded change that needs to ship
jumps from `loop`'s single workstream to `quick`'s four-area build matrix and four-area
review — a 3.75× step with nothing in between. `loop --deploy` is the missing rung, and it
removes the "promote by re-running on a bigger track" workaround the docs currently
prescribe.

Leave `review-only`, `review-pr`, `config-only`, and `hotfix` alone. These are genuinely
different shapes with different entry conditions, not points on a slider.

---

## 4. Speed, cost, and self-learning

### Where the money goes

Per-dispatch framework overhead dominates on light tracks, not model choice. A `loop` run is
4 dispatches at ~7,000 tokens of scaffolding each — roughly 21,000 tokens before the model
reads a line of project code. F1, F2, and F4 all attack that number, and together they are
worth more than any routing optimization layered on top. **Fix them before tuning model
tiers.**

The second lever is caching, currently half-built: the prefix is byte-stable by design, but
breakpoints are off by default where Stagecraft controls them and discarded entirely on
build and qa where F1 fires. Closing F1 and enabling breakpoints turns an existing
investment into an actual discount.

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

F1 is the expensive one and needs a recorded decision, not a patch. Everything else here is
measurement-driven and should be **re-measured after F1 lands, not assumed**.

1. **F1 — ADR on goal-loop under `--print`.** Decide whether `/goal` survives headless
   dispatch at all. If not, delete the fallback chain and recover framework inlining plus
   retry guidance on build and qa.
2. **F4 — scope inlined rules to the dispatched role.** Stop shipping the review rubric and
   retrospective instructions in build prompts; keep the prefix byte-stable within a role.
3. **Enable cache breakpoints by default** on `openai-compat`, and record cache-hit rates in
   the corpus so 32.1's payoff becomes measurable rather than assumed.
4. **Re-run the ceremony preview** and publish the new per-track token numbers.

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
5. **F5 — continue the P2-2 decomposition.** Extract `run()`'s effect/persistence phase
   behind the transition-object seam already proven three times, one behavior-preserving
   slice per PR.

### Wave 3 — Make the agents senior

Deliberately last: every item is more valuable once dispatches carry a trustworthy cost,
because that is what distinguishes an improvement from a regression.

1. **Cold-start pattern seeding** from `CONTRIBUTING.md`, `AGENTS.md`, existing ADRs, and
   merged-PR review comments — into the existing candidate queue, behind the existing gate.
2. **Bounded auto-promotion** at N recurrences for schema-bound fingerprints, tagged
   `source: auto`, reversible through the quarantine path that already works.
3. **Extend proposal/apply to rulings, retry ownership, and pattern text.**
4. **Run-scoped chat sessions** so the context that understands a halt survives between
   commands.
5. **Re-run the Phase 41 review.** With cost coverage real and a second host in the routing
   table, D5 becomes answerable for the first time.

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
