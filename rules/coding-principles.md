# Coding Principles

Four behavioural rules every agent follows when writing, editing, or reviewing
code in this pipeline. Adapted from [Karpathy's LLM coding observations](https://x.com/karpathy/status/2015883857489522876)
and bound to our pipeline artefacts (`pipeline/brief.md`, `pipeline/design-spec.md`,
`pipeline/context.md`).

**Tradeoff:** these rules bias toward caution over speed. For a one-line typo
fix or obvious follow-up, use judgement — not every change needs the full rigour.
For anything the pipeline actually routes through Stage 4, apply all four.

---

## 1. Think Before Coding

**Don't assume. Don't hide confusion. Surface tradeoffs.**

Before your first `Write` or `Edit` in any build task:

- Append an `## Assumptions` section to `pipeline/context.md` listing the
  non-obvious choices you're making (e.g. "assuming pagination is offset-based,
  not cursor", "assuming errors return 4xx JSON, not a redirect").
- If multiple interpretations of the spec are plausible, write a
  `QUESTION:` line to `pipeline/context.md` and implement the **conservative**
  interpretation while you wait. Do not silently pick.
- If you believe the spec is wrong, overcomplex, or contradicts an ADR, push
  back: write a `CONCERN:` line to `pipeline/context.md` with a one-sentence
  alternative. The orchestrator will route it to the Principal.

Reviewers apply the same rule: if you can't tell which interpretation the
author chose, that's a BLOCKER, not a SUGGESTION.

**No `pipeline/design-spec.md` for this track?** Lean tracks (`quick`,
`nano`, `loop`, `config-only`, `dep-update`) skip Stage 2 design entirely —
its absence there is expected, not a defect. Treat `pipeline/brief.md`'s
acceptance criteria as the authoritative implementation contract instead,
note the fallback as an `## Assumptions` entry, and proceed. Do not refuse
or escalate solely because `pipeline/design-spec.md` is missing.

## 2. Simplicity First

**Minimum code that satisfies the spec. Nothing speculative.**

- No features, flags, or config beyond what `pipeline/brief.md` or
  `pipeline/design-spec.md` calls for.
- No abstractions for single-use code. Three similar lines is better than a
  premature helper.
- No error handling for scenarios that can't happen at this boundary (trust
  internal code; validate at system edges only).
- No `TODO` stubs or half-implementations. Ship the cut you can defend.

**Self-check before writing `gate-04-{area}.json`:** would a senior engineer
say this PR is overcomplicated for what the spec demands? If yes, cut it
before handing to review.

**Reviewer rubric row:** "Is anything here *bigger* than the spec needs?"
Flag overcomplication as a BLOCKER when it adds abstractions, config
surfaces, or branches with no caller.

## 3. Surgical Changes

**Touch only what you must. Clean up only your own mess.**

When editing:

- Don't "improve" adjacent code, comments, or formatting.
- Don't refactor things that aren't broken or called out in the spec.
- Match existing style in the file even if you'd prefer a different style.
- If you notice unrelated dead code or a latent bug: mention it in the PR
  description under `## Out of Scope — Noticed`. Do **not** fix it in this PR.

Orphan cleanup scope:

- Remove imports/vars/functions that **your** changes made unused.
- Do **not** remove pre-existing dead code.

**The tracing test:** every changed hunk should trace directly to a line in
`pipeline/brief.md`, `pipeline/design-spec.md`, or a `PM-ANSWER:` in
`pipeline/context.md`. If a reviewer asks "why did you touch this?" and the
answer is "while I was in there", that hunk is a BLOCKER.

**Area boundary:** `dev-backend` edits `src/backend/`, `dev-frontend` edits
`src/frontend/`, `dev-platform` edits `src/infra/`. Cross-boundary edits
require a `CONCERN:` line in `pipeline/context.md` first.

## 4. Goal-Driven Execution

**Define success criteria. Loop until verified.**

Every build task starts with a short plan at the top of
`pipeline/pr-{area}.md` in this shape:

```
## Plan
1. [Step]          → verify: [concrete check]
2. [Step]          → verify: [concrete check]
3. [Step]          → verify: [concrete check]
```

Each `verify` must be something observable (a test name, a curl command, a
`docker compose ps` row, an acceptance-criterion id from the brief). "Make it
work" or "tests pass" is not a verification.

Map every acceptance criterion in `pipeline/brief.md` to at least one step.
If a criterion has no corresponding step, you haven't planned the feature —
stop and add it.

Reviewers check the plan against the diff: does the diff deliver what the
plan promised? Missing or unverifiable steps are BLOCKERS.

---

## Precedence

If these principles conflict with something in `pipeline/brief.md`,
`pipeline/design-spec.md`, or a binding Principal ruling, the spec wins —
but raise the conflict as a `CONCERN:` in `pipeline/context.md` so it is
visible at retro time.
