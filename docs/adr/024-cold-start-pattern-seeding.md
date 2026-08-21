# ADR 024 — Seed pattern candidates from a project's own written conventions

**Status:** Accepted
**Date:** 2026-08-21
**Authors:** Stagecraft maintainers

## Context

Pattern learning ([`docs/pattern-learning.md`](../pattern-learning.md)) is more
complete than most teams build: sanitized observations, typed fingerprints,
human promotion, injection budgets, recurrence counters, automatic quarantine,
SKILL.md export, and an opt-in Reflector pass.

It has one structural property that limits it: **it only learns from pain.**
Every gate-derived observation begins as a blocker, a warning, or a follow-up.
So a project's first run has an empty pattern store, and the Project Knowledge
Pack an agent reads carries only static discovery — on a fresh JavaScript
project, three lines of stack trivia.

Meanwhile the repository usually has its conventions written down already.
`CONTRIBUTING.md` and `AGENTS.md` are exactly what a senior engineer absorbs in
week one, and they exist as text before Stagecraft ever runs. Today nothing
reads them, so an agent rediscovers those rules by failing a gate — which is
the loop the builder review flagged: *agents relearn the basics from reviews
every time.*

## Decision

`devteam patterns seed` reads the project's own convention documents and lands
what they already mandate as **candidates**, in the same review queue
gate-derived candidates use.

1. **Sources are a short explicit list**, not a `docs/` crawl: `AGENTS.md`,
   `CONTRIBUTING.md`, `CLAUDE.md`, `docs/project-conventions.md`,
   `docs/CONVENTIONS.md`. The goal is high-signal house rules, not everything
   the repository has written down.
2. **Only normative statements are extracted.** A sentence without *must*,
   *never*, *always*, *prefer*, *avoid*, *require* or similar is documentation,
   not a convention. Headings, tables, and fenced code are skipped, and
   wrapped prose is rejoined so fragments are never emitted.
3. **Candidates only.** Nothing is promoted, and nothing reaches a prompt,
   without the existing human `devteam patterns promote`.
4. **A seeded candidate proposes the project's own sentence** as its
   `proposed_prompt_text`, with `proposed_from` naming the source document. The
   per-domain templates that serve gate-derived candidates cannot express a
   specific house rule.
5. **Everything is bounded and scanned.** At most 40 statements, 24–240
   characters each, secret-scanned before storage at the same bar
   `patterns promote` applies to operator-authored text.

The observation store stays prose-free exactly as before. The seeded sentence
lives in its own `seeded.json`, keyed by `pattern_key`, and surfaces on the
candidate an operator reviews.

## Consequences

**A new project starts with its own documented rules in the review queue**
instead of an empty store, and the operator decides in one pass which are worth
injecting. That is the difference between an agent that knows the house style
on day one and one that learns it from a failed gate on day three.

**Seeded prose enters the candidate layer.** This is the substantive change.
`pending-review.json` was already permitted to hold richer local examples, and
promotion has always been where text becomes prompt-eligible — but it is worth
naming plainly: text from a repository document now reaches a store that
previously held only typed, derived fields. It is local, gitignored,
secret-scanned, bounded, and inert until promoted.

**A verbose handbook cannot flood the queue.** The 40-statement cap holds
regardless of how much a project has written, and the existing injection budget
(3 blocker / 2 warning / 1 positive) still governs what reaches a prompt.

**Seeded candidates enter as `nudge`.** They are project preference, not
evidence of a defect, and the tier ordering already treats nudges as the
lowest-priority injection class.

**A wrong rule is as promotable as a right one.** Seeding proposes what a
document *says*; it cannot tell whether the document is current. The human
promotion step is what filters that, exactly as it does for gate-derived
candidates, and quarantine remains the backstop if a promoted rule proves
unhelpful.

## Alternatives considered

**Inject convention documents into every prompt directly.** Rejected. That is
the phase-37.2 inlining trade applied to unbounded text, with no review step, no
relevance selection, and no way to retire a rule that stopped being true.

**Have a model summarize the conventions into patterns.** Rejected for the
first slice. It would produce better-shaped prompt text, but it makes seeding a
dispatch with a cost, and it puts model prose rather than the project's own
sentence in front of the reviewer. The Reflector already occupies the
model-proposes-candidates role, opt-in and after a clean run.

**Auto-promote seeded candidates.** Rejected. A documented rule is evidence of
intent, not evidence the rule is current or that agents get it wrong. Promotion
stays the human step it is for every other candidate source.

**Crawl all of `docs/`.** Rejected. Precision matters more than recall here:
40 mediocre candidates cost more reviewer attention than they save.
