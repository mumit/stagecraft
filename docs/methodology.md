# Methodology

Stagecraft enforces **ATDD with phase-gate progression, an adversarial red-team, and multi-role peer review**. Every feature traces from an acceptance criterion through a Gherkin scenario to a named test, and cannot advance to the next phase until the current gate passes. The red-team role is structurally separate from the build roles and runs by default. Peer review runs across four area reviewers, optionally across multiple model families, on every change.

- [1. Acceptance-test-driven development](#1-acceptance-test-driven-development)
- [2. Phase-gate progression](#2-phase-gate-progression)
- [3. Review layers](#3-review-layers)
- [4. Four coding principles](#4-four-coding-principles)
- [How it fits together](#how-it-fits-together)

---

## 1. Acceptance-test-driven development

The PM role writes numbered acceptance criteria (`AC-1`, `AC-2`, …) in `pipeline/brief.md` at Stage 1. Stage 3b translates each `AC-N` line into one Gherkin scenario tagged `@AC-N` in `pipeline/spec.feature`. Stage 6 (QA) verifies that every scenario has a corresponding test. The gate at each stage carries the mapping; `devteam spec verify` detects drift at any time.

This gives the pipeline a closed loop:

```
AC-N in brief.md
  → @AC-N scenario in spec.feature   (Stage 3b)
  → test tagged @AC-N                (Stage 4: build)
  → scenario verified ✓              (Stage 6: QA)
```

If a criterion has no scenario, Stage 3b's gate fails. If a scenario has no test, QA's gate fails. Neither can be skipped without a `FAIL` or `ESCALATE` halting the pipeline.

The `full` and `quick` tracks run this loop. `nano` and `hotfix` skip requirements and spec stages; acceptance criteria are assumed known. QA still verifies whatever tests exist.

See [`docs/spec-authoring.md`](spec-authoring.md) for the authoring procedure and [`docs/concepts.md`](concepts.md) → *Executable spec* for the stage mechanics.

---

## 2. Phase-gate progression

Every stage writes a machine-readable gate to `pipeline/gates/`. The orchestrator reads the gate before dispatching the next stage. A `FAIL` gate stops forward progress; an `ESCALATE` gate halts the entire pipeline until a human resolves it.

The methodology is enforced by the pipeline, not by convention. The `stage-02.json` gate must be present and `PASS` before Stage 3 runs; there is no way to skip design review by omission. Merging requires sign-off gates from both PM and Platform roles.

Two stages hold veto power that peer-review approvals cannot override:

- **Security review** (Stage 4b, conditional): fires when pre-review flags sensitive paths. A `FAIL` from security blocks sign-off regardless of peer-review outcome.
- **Migration safety** (Stage 4d, conditional): fires on data-layer diffs. An empty rollback plan, an untested rollback on a breaking change, or a missing backfill strategy auto-vetoes. The migrations role must re-review after any fix.

See [`docs/concepts.md`](concepts.md) → *Gate* and [`docs/migration-safety.md`](migration-safety.md) for the veto criteria.

---

## 3. Review layers

The pipeline runs two distinct review layers between build and sign-off. They have different roles, different methods, and different success criteria. Conflating them produces false confidence.

**Adversarial review — Red-team (Stage 4c).** Runs after build, before peer-review. The red-team role is structurally separate from build roles and exists to find the strongest objections to the change. It walks 10 attack surfaces (input boundaries, state machines, sequence assumptions, integrations, auth edges, resource exhaustion, failure modes, abuse cases, downstream effects, observability gaps) and produces concrete reproducers. Items listed under `must_address_before_peer_review` block Stage 5 until addressed. Always-on for `full` and `hotfix` tracks. Route to a different host than the build agents: adversarial signal depends on a reviewer with different training data than the builder.

**Peer review (Stage 5).** Default `review.mode: panel` — four area-specific reviewers (`reviewer-backend`, `reviewer-frontend`, `reviewer-platform`, `reviewer-qa`) each produce an independent review against the four coding principles. With `routing.review_fanout` configured, Stage 5 duplicates across N hosts (multi-model peer review) and aggregates pessimistically: any FAIL anywhere blocks the stage. Patterns that survive all reviewers are promoted to `pipeline/lessons-learned.md` at retrospective; the Principal then decides whether to encode them as pipeline rules.

The two layers serve different purposes. Stage 4c hunts for attacks the author didn't consider, using the 10-surface walkthrough. Stage 5's panel mode checks for principles the author didn't apply, using the standard reviewer rubric — that diversity is execution-diversity (different model families), not method-diversity.

**Peer review, adversarial mode (Stage 5, opt-in via `review.mode: adversarial`).** 2026 evidence on review panels (cited in `plans/phase-31-verification-depth.md` §31.3) found they underperform, and are collusion-prone relative to, an adversarial reviewer/critic pair. Adversarial mode replaces the four-area matrix with two sequential workstreams: a single reviewer covers every applicable area, then a critic — dispatched only after the reviewer's gate lands — attacks the review itself: missed findings, unsupported approvals, "what would make this approval wrong?", with file:line evidence required for every challenge (`roles/critic.md`). The merged Stage 5 gate PASSes only when the reviewer approves AND the critic's `challenges_resolved` is true — an unresolved challenge blocks merge regardless of the reviewer's own verdict. With ≥2 hosts configured, the critic defaults to a different host than the reviewer (`routing.roles.critic` overrides) — the same collusion counter-measure as Stage 4c's host-diversity convention. The default stays `panel`; this phase does not change it (needs real-run evidence first, per Phase 28's run corpus).

See [`docs/red-team.md`](red-team.md) for the attack-surface methodology and [`docs/user-guide.md`](user-guide.md) → *Multi-model peer review* for fanout configuration.

---

## 4. Four coding principles

Every agent in the build phase follows four behavioural rules:

| Principle | Rule |
|---|---|
| **Think Before Coding** | Surface assumptions and ambiguities in `pipeline/context.md` before the first edit. A `QUESTION:` line means "implementing the conservative interpretation while I wait." |
| **Simplicity First** | Minimum code that satisfies the spec. No speculative features, premature abstractions, or half-implementations. |
| **Surgical Changes** | Touch only what the spec calls for. Every changed hunk traces to a line in `brief.md`, `design-spec.md`, or a `PM-ANSWER:` in `context.md`. |
| **Goal-Driven Execution** | Every build task starts with a plan in `pipeline/pr-{area}.md` mapping each step to a concrete, observable verification. |

Reviewers apply the same rules in reverse: missing traceability, overcomplication, or an unverifiable step are blockers, not suggestions.

Full detail: [`rules/coding-principles.md`](../rules/coding-principles.md).

---

## How it fits together

```
Requirements (Stage 1)   AC-N criteria established
      ↓
Design (Stage 2)         Architecture locked before any code
      ↓
Executable spec (Stage 3b) Gherkin scenarios, 1:1 with AC-N
      ↓
Build (Stage 4)          Four workstreams; four coding principles enforced
      ↓
Red-team (Stage 4c)      Adversarial attack; blockers stop peer-review
      ↓
Peer-review (Stage 5)    Independent multi-role (optionally multi-model) review
      ↓
QA (Stage 6)             Verifies every AC-N scenario has a passing test
      ↓
Sign-off → Deploy → Retro
```

The gate at each arrow is a `PASS/WARN/FAIL/ESCALATE` record on disk. The pipeline is fully reconstructable and auditable from the gate files alone.
