# Experience Review — August 2026

Status: **proposed** (2026-08-04). A developer-experience, productivity, and token-cost
review taken after phases 28–36 landed (61 commits since
[landscape-review-2026-07.md](landscape-review-2026-07.md)).

Unlike the July review, this one is **measured rather than read**. Every number below came
from running the CLI against throwaway projects on 2026-08-04, not from documentation. Where
a first estimate turned out wrong, the corrected measurement is shown — see §3.1.

Companion plan: [phase-37](phase-37-interface-and-token-efficiency.md).

---

## 1. What nine phases actually delivered

| Dimension | July 2026 | August 2026 |
|---|---|---|
| Tests passing | 2,307 | **2,969** |
| Consistency checks | 347 (+1 advisory) | **375, zero advisories** |
| Command modules | 34 | **44** |
| Tracks | 6 | **10** |
| Stamped stages (orchestrator-verified) | 3 of 18 | **5** (03b, 04a, 04c, 06, 06d) |
| Cost telemetry | none — model self-reported | orchestrator-observed on claude-code + openai-compat |
| Learning loop | open (memory never injected, counters inert) | **closed** (auto-collect, live counters, memory injection, SKILL.md export) |
| Review of code Stagecraft didn't build | not possible | `review-only` / `review-pr` / `refactor` tracks + external mode |
| Smallest sensible path | `quick` (10 slots) | **`loop` (4 dispatches, measured)** |

That is a lot of real capability. The verification story, the learning loop, and external
review are all genuinely built, not documented-only. **The problem this review identifies is
not capability. It is that the interface did not grow with it.**

## 2. Developer experience

### 2.1 The headline problem: the surface outgrew the interface

Measured:

- **44 command modules**, **244 flags** (counted from the structured flag specs), **10 tracks**
- **`devteam --help` is 343 lines** — roughly nine terminal screens
- **`devteam help <command>` does not exist.** Verified by diffing: `help run`, `help review`,
  `help stage`, and `help next` all print the *same* 343 lines. There is no way to ask about
  one command.
- **103 documentation files, 1.4 MB** under `docs/`; README is 402 lines

So the only way to learn any single command is to scroll a nine-screen wall or open the docs
site. For a tool whose most-used command (`devteam run`) has **21 flags**, that is the single
biggest drag on the experience.

**The fix is unusually cheap**, which is why it leads the phase-37 plan: the flag specs are
already structured, e.g. in `core/cli/commands/run.js`:

```js
"budget-usd": { type: "number", description: "Cost cap in USD" },
```

Every flag already carries a type and a description. Per-command help can be *generated*
from data that exists today — no new content to write.

### 2.2 What is genuinely good

Worth protecting, because it is better than most tools in this category:

- **Time to first value is excellent.** `devteam init` completes in **0.07 s** and lays down
  72 files.
- **Error messages, where they exist, are specific and actionable.** Unknown track prints the
  full valid set. And the phase-36 host-honesty message is the best text in the CLI:

  > `⚠️ --host claude-code cannot mechanically prevent writes to <path>. Only "acp" enforces
  > read-only review at tool-call time (hosts/acp/permissions.js's two-root evaluator); with
  > --host claude-code, enforcement degrades to a post-hoc audit … Pass
  > --allow-unenforced-writes to proceed anyway.`

  It names the limitation, the mechanism, the file that implements it, and the exact escape
  hatch. That is the standard the rest of the CLI should be held to.
- **`devteam next` as a single "what now" affordance** is the right idea and mostly works.

### 2.3 A real bug: confident wrong guidance outside a project

`devteam next` run in `/tmp` — not a Stagecraft project at all — prints:

```
▶️ run-stage — requirements (stage-01)
   stage not started
   → devteam stage requirements
```

There is no project-initialisation check in `core/cli/commands/next.js`. Meanwhile
`review-pr` *does* check and refuses politely. So the same framework both guards and fails
to guard the same condition, and the unguarded path is the command new users are told to
run most. A user who runs `devteam next` in the wrong directory is told to start a pipeline
there.

### 2.4 Ceremony reduction worked — verify claims empirically

I initially computed loop-track cost from the `roles` array in the stages table and got
**10 dispatches**, which would have meant phase 29 largely failed. Rendering the stages
instead gave the truth:

| Track | Dispatches (measured) |
|---|---|
| `loop` | **4** |
| `full` | **25** |

Right-sizing prunes `build` and `peer-review` from four workstreams to one on a clean tree.
Phase 29 delivered what it promised. Recording the wrong first estimate here deliberately:
the stages table is not a reliable predictor of dispatch count, so any future cost estimate
must render, not read.

## 3. Token efficiency — the biggest remaining win

### 3.1 What a dispatch actually costs

From `docs/reference/prompt-budget.md`, regenerated and current:

- **Framework constant: 12,485 bytes per dispatch**, every dispatch, every role
- Role briefs: 2,400 B (platform) to 14,528 B (principal)
- Per-dispatch total: **14,885–27,013 bytes ≈ 3,722–6,754 tokens** before a single line of
  project code or artifact is read

That constant is essentially unchanged from July's 12,437 B. **Phase 32.1 reordered the
prompt for cacheability but did not reduce its size** — which would be fine if the caching
worked. It largely does not.

### 3.2 The cache prefix is 268 bytes

32.1's promise was that sections 1–2 (framework preamble, role brief) are byte-identical
across dispatches, making them cacheable. I tested it directly: rendered two dispatches of
the *same role* (`pm` at stage-01 and stage-03) and compared.

```
prompt size:          1,838 B and 1,864 B
shared prefix:        268 B  (15.2% of the prompt)
diverges at:          "...agents/pm.md`) for this workstream.\n\n# Stage stage-01 — requirements"
```

**Only 268 bytes are cacheable.** The reason is structural, not a bug in 32.1: the framework
and role brief are **not in the prompt at all**. The prompt lists them as paths:

```
## Framework (read first — every stage, every role)
- AGENTS.md
- .devteam/rules/pipeline.md
- .devteam/rules/gates-core.md

Use the **pm** subagent (`.claude/agents/pm.md`) for this workstream.
```

The model then reads ~22 KB itself via tool calls. Those bytes enter the conversation as
tool results, *after* the prompt, in whatever order the model chooses — and every dispatch is
a brand-new session (`claude --print` per workstream). So:

- Provider prefix caching can only ever cache the 268-byte header.
- The 22 KB is paid at **full price on every dispatch**, forever.
- Each dispatch also spends 4+ sequential file-read round-trips before starting work.

At measured rates, a `full` run pays roughly **25 × 22 KB ≈ 550 KB ≈ 137k tokens** of pure
framework re-reading, with effectively no cache benefit. Even `loop` pays about **19k tokens**
of overhead to review a small change.

### 3.3 The fix, and why it is strictly better

**Inline the framework and role brief into the prompt prefix**, in the stable order 32.1
already established. Then:

- The prefix becomes ~22 KB that is **byte-identical across every dispatch of the same
  role**, so provider prefix caching applies at roughly 90% off on reads.
- The 4+ sequential reads per dispatch disappear — a latency win independent of cost.
- No information is lost: the model was instructed to read exactly these bytes anyway.

This is not a tradeoff between size and cost. It moves bytes the model already consumes from
an uncacheable position to a cacheable one. The costs to manage are real but bounded: the
prompt-budget consistency check fails on >10% growth and must be deliberately re-baselined,
and `openai-compat` needs its `cache_control` breakpoints placed after the inlined block
(32.1 already has the mechanism). Hosts without prefix caching pay the same total as today,
just earlier.

Phase 36.2 already had to solve the adjacent problem — resolving framework paths when the
state root differs from the code root — and `plans/acp-read-scope.md` concluded absolute
paths work. Inlining supersedes that concern for the cache case rather than conflicting with
it.

### 3.4 Stages are still sequential

`docs/adr/017-dag-wave-execution.md` remains **Status: Proposed**, so 32.2 was never built.
`full` still pays 18 sequential stage slots where the project's own analysis says waves
would cut the worst case to ~13. This is the last unclaimed performance item and it is now
the only one requiring an architectural decision rather than code.

## 4. Total experience, end to end

Walking the journey a new user actually takes:

| Stage of the journey | State |
|---|---|
| Install and initialise | **Strong** — 0.07 s, one command |
| Understand what to run | **Weak** — 343-line help, no per-command help, 44 commands, 10 tracks |
| First small change | **Good** — `loop` is 4 dispatches, assess picks the track |
| Know what it will cost | **Good** — `devteam assess` previews ceremony; empirical once the corpus fills |
| Trust the result | **Strong** — 5 stamped stages, chain, attestation, adversarial review |
| Diagnose a failure | **Mixed** — typed failure classes and runbooks are good; the information is spread across `status`, `log`, `report`, `summary`, `advise`, `performance`, `corpus`, `evals` |
| Improve over time | **Strong and rare** — patterns auto-collect, counters live, memory injects, SKILL.md exports |
| Review someone else's code | **Strong and novel** — enforced read-only external review |
| Cost per unit of work | **Weak** — ~22 KB uncacheable per dispatch |

The shape is clear: **the parts that are about capability are strong; the parts that are
about a human holding the tool are weak.** Nine phases optimised the former.

## 5. Positioning, one month on

The July market analysis has not been re-researched and its conclusions still stand, so this
is a short update rather than a fresh survey.

What changed in Stagecraft's favour is that two of the three things July flagged as
defensible are now built rather than planned:

- **Gate evidence as a compliance artifact** — `devteam evidence export --attestation` ships.
- **Runs that improve later runs** — the learning loop is closed end to end.
- **Enforced read-only external review** is a third, and it is the one no competitor in the
  July survey had in any form. CodeRabbit, Greptile, and Bugbot review PRs; none can prove
  mechanically that the reviewing agent never wrote to the repo, because none sits on a
  protocol that gates every tool call. That claim now goes in a signed bundle.

The risk is also unchanged and now sharper: **adoption is gated by the interface, not the
capability.** The July review warned that ceremony cost kills adoption; phase 29 fixed
ceremony. The 2026 successor to that risk is *conceptual* cost — 44 commands and 244 flags
are their own kind of tax, and a reviewer comparing tools in an afternoon will bounce off a
343-line help screen long before they reach the attestation bundle that makes this project
special.

## 6. Recommendations

Ranked by value per unit of effort. Detail in
[phase-37](phase-37-interface-and-token-efficiency.md).

1. **Generated per-command help** (37.1) — the flag specs already carry types and
   descriptions; this is mechanical. Biggest experience win available, near-zero risk.
2. **Inline framework + role brief into the cacheable prefix** (37.2) — turns ~22 KB of
   per-dispatch full-price reading into a cached prefix and removes 4+ round-trips.
3. **Project-context guard** (37.3) — stop `devteam next` from confidently advising in
   directories that are not projects.
4. **Task-grouped top-level help** (37.4) — one screen of "start here / daily / verify /
   learn / audit", full reference behind a flag and in generated docs. No command renames.
5. **Documentation consolidation** (37.5) — 103 files and 1.4 MB need one obvious front door
   and an explicit archive.
6. **Decide ADR-017** (37.6) — accept and build waves, or reject and record why, so the last
   performance item stops sitting in limbo.

What **not** to do: add capability. The next phase should add none. Every item above either
removes surface, generates what already exists, or moves bytes to a cheaper place.
