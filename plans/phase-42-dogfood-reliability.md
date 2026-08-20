# Phase 42 — Dogfood Reliability and Recovery Fit

**Status:** in progress from two-project dogfood evidence (2026-08-19); 42.1–42.2
implemented and unreleased.

**Goal:** remove the control-plane friction observed while completing a real
`loop` change, without activating any Phase 41 learning capability or weakening
an enforcement boundary.

The evidence and no-go decision are in
[`phase-41-evidence-review-2026-08.md`](phase-41-evidence-review-2026-08.md).
Implement one item per PR. Items 42.1–42.3 are the reliability-critical path;
the remaining items can follow independently.

## 42.1 Resume preserves the effective safety policy (P0)

**Status:** ✅ implemented (unreleased). The effective caps and scoped bypass
are persisted and plan-bound; resume conflicts fail before dispatch, legacy
state migrates explicitly, and direct stages inherit the materialized track.

Persist and fingerprint the effective token/USD caps and an audited stoplist
bypass for the logical run. `--resume` must inherit those values when omitted,
reject conflicting explicit values, and never silently become uncapped. A
stoplist bypass applies only to the same frozen feature/brief fingerprint and
must not require ceremony on every unchanged resume. Direct remediation stages
inherit the active run track unless the operator explicitly overrides it.

**Acceptance:**

- a capped run resumed without cap flags remains capped at the original limit;
- a conflicting cap or track fails before dispatch with the old/new values;
- an accepted stoplist bypass does not reopen for the same unchanged run;
- changing the feature, brief fingerprint, or stoplist policy invalidates it;
- tests cover crash/resume, direct-stage remediation, and old-state migration.

## 42.2 Retry routing proves role/path compatibility (P0)

**Status:** ✅ implemented (unreleased). Structured retry paths and requested
artifacts are checked against the actual candidate build roles' existing
`roleWrites` before gate clearing. A compatible owner is selected by declared
file ownership then stable stage order; no compatible owner halts before host
invocation with privacy-bounded ownership evidence.

Before an automatic fix dispatch, compare the failing paths and requested
artifact with the candidate workstream's allowed writes. Never dispatch a role
that cannot own the retry. Halt with a typed, actionable reason when no existing
role is compatible; do not spend an agent turn rediscovering the mismatch.

**Acceptance:**

- a QA failure in `docs/` is not assigned to a `src/backend/`-only retry;
- a compatible owner is selected deterministically when one exists;
- an incompatible retry halts before host invocation and records the candidate
  roles considered without recording source content;
- no role gains a broader write surface as a side effect.

## 42.3 Documentation-capable build ownership (P0/P1 design)

Design the smallest first-class path for documentation-only changes. Preferred
direction: bind an exact, brief-approved affected-file set into a documentation
workstream rather than adding all of `docs/` to backend. Decide through an ADR
because the stage role/write contract is load-bearing.

**Acceptance:**

- `assess` and `loop` can select a documentation-capable build for a docs-only
  change;
- writes are limited to exact approved files plus the workstream's pipeline
  artifacts;
- a newly discovered contributor-facing document expands scope only through a
  recorded ruling/retry, not an implicit wildcard;
- build, QA, and peer review share the same affected-file contract.

## 42.4 Project-layout-aware QA and verification (P1)

Stop assuming `src/tests/`, `src/backend/`, or a Gherkin file exists. Use the
standards/project-knowledge discovery already present in core, and make
track-specific verification obligations explicit. `devteam spec verify` must
distinguish "stage not in this track" from real drift.

**Acceptance:**

- a Python project with `tests/` receives the correct QA read/write scope;
- a loop track without executable-spec reports `not-applicable`, not drift;
- full/quick tracks retain the current G2 failure behavior when the stage is
  required;
- no missing test root is interpreted as a passing test suite.

## 42.5 Logical run and remediation evidence semantics (P1)

Audit how fresh invocations, resumes, direct stages, interruptions, and retries
map to evidence `run_count`, durable dispatches, rulings, and orphan events.
Introduce a privacy-safe logical-run identifier if the current schema cannot
answer the question without conflating invocations and feature changes.

**Acceptance:**

- one logical feature run with several resumes has one documented denominator;
- every host dispatch, including direct remediation, is either durably counted
  or explicitly excluded with a reason;
- manual Principal rulings are not inferred from prose, but the CLI offers a
  supported typed path to record them;
- bundle schema evolution is backward-compatible and duplicate-safe.

## 42.6 Dogfood bootstrap isolation (P2)

Offer an explicit checkout-local dogfood installation mode or documented
split-commit workflow so framework infrastructure does not contaminate the
product change under review. Preserve reproducibility: local-only mode must be
reported as local and must not pretend another clone is initialized.

**Acceptance:**

- peer review sees only the product diff by default in local dogfood mode;
- `doctor` distinguishes committed from checkout-local initialization;
- evidence/pipeline state remains ignored without repeatedly mutating the
  repository's tracked `.gitignore`;
- the existing committed-install workflow remains available.

## Explicit non-goals

- No Phase 41 route or recipe activation.
- No automatic broadening of allowed writes.
- No inference of accepted resolutions from PASS gates or prose.
- No fabricated cost estimates, stalls, ceilings, or cross-host evidence.
- No self-modifying rules, roles, stage definitions, or source.

## Verification

Each item requires its targeted contract tests, `npm test`,
`npm run consistency`, and `npx eslint .`. Any change to stage shape,
allowed-write ownership, run-plan fingerprinting, or evidence schema needs the
corresponding ADR/doc update and a lockstep regression test.
