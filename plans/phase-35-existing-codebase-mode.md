# Phase 35 — Existing-Codebase Mode

Status: **proposed** (from the 2026-08-02 capability review of Stagecraft against
existing/brownfield codebases; extends
[landscape-review-2026-07.md](landscape-review-2026-07.md) §3.4).
Prompts: [prompts/roadmap-2026-prompts.md](prompts/roadmap-2026-prompts.md) §35.

| Item | Status |
|---|---|
| 35.1 `review-only` track + artifact-tolerant readFirst | not started |
| 35.2 `devteam review-pr` | not started |
| 35.3 mechanical stamping for stage-06d | ✅ complete — `methods_attempted[]` is orchestrator-derived (see `core/verify/stamp.js#stampStage06d`) |
| 35.4 findings report with mitigations | not started |
| 35.5 `refactor` track | not started |

## Why

Everything in phases 28–34 assumes the intent→code direction: a brief exists, a design
spec exists, the pipeline produced the artifacts each stage reads. But three of the most
valuable things Stagecraft can do need none of that — reviewing code that already
exists, reviewing an inbound PR, and hardening existing modules with property-based or
formal verification. Today those paths work by accident rather than by design:

- **Review stages run standalone but read artifacts that don't exist.** `devteam stage
  <name>` has no predecessor-gate check ([verified] `core/cli/commands/stage.js` gates
  only on the peer-review auto-preflight, bypassable with `--skip-preflight`), so
  `devteam stage security-review` works on any repo. But `red-team`'s `readFirst` wants
  `pipeline/brief.md`, `pipeline/design-spec.md`, `pipeline/pre-review.md`,
  `pipeline/security-review.md`, and `verification-beyond-tests` additionally wants
  `spec.feature`, `test-report.md`, `red-team-report.md`. On a brownfield repo the model
  is instructed to read files that aren't there, and gates carry AC-linked fields with
  no ACs to link. It degrades instead of failing, which makes the resulting gate evidence
  look stronger than it is — the one failure mode this project exists to prevent.
- **There is no inbound PR review.** `scripts/pr-pack.js` and `pr-publish.js` push
  pipeline state *to* a PR (description + gate check runs); `skills/pre-pr-review`
  reviews *your own current branch*. Nothing fetches an arbitrary PR and reviews it.
  Market context from the July review: as fleets grew, review became the bottleneck and
  independent review gates became the highest-return token spend. This is also the one
  adjacent space with entrenched competition (CodeRabbit, Greptile, Bugbot) — none of
  which offer an adversarial reviewer→critic pair backed by signed gate evidence.
- **Stage-06d is still unverified.** `STAMPABLE_STAGES` is `{03b, 04a, 04c, 06}`
  [verified]. Phase 31 deliberately deferred 06d, so "we ran properties / mutation /
  formal methods" remains a model claim — the cheapest possible sentence for a model to
  fabricate, in the stage whose entire value is verification depth.

## Work items

### 35.1 `review-only` track + artifact-tolerant readFirst

Two changes, one item, because neither is useful alone.

**Soft readFirst.** Introduce an optional-entry form in the STAGES table (e.g.
`readFirst` entries may be `{path, optional: true}` or a parallel `readIfPresent` array —
pick one and document why). At render time, absent optional paths are **omitted from the
prompt entirely** rather than rendered as instructions to read a missing file. Existing
required entries keep today's behavior byte-for-byte on full-track runs (regression-test
this). Mark the pipeline-artifact dependencies of `security-review`, `red-team`,
`peer-review`, and `verification-beyond-tests` optional; `AGENTS.md` and the rules docs
stay required.

**The track.** Add `review-only` to `STAGES_BY_TRACK`: `["security-review", "red-team",
"peer-review"]` — read-only review of code that already exists, no build, no deploy, no
sign-off. Add `--scope <path>` (repeatable) so review targets a subtree rather than the
whole repo; scope lands in the rendered prompt and on the gate. Gate schemas: fields that
reference acceptance criteria become `null`-permitted when `track: "review-only"` (schema
conditional, not a new schema — follow the 29.4 `stage-06x` precedent for how a track
shape drives validation).

- Acceptance: `devteam run --track review-only` completes on a fixture repo with **no
  `pipeline/` artifacts present**; no rendered prompt references a nonexistent file;
  full-track prompts byte-identical; `verify-chain` passes on the short track.
- Verify: `npm test`, `CI=true DEVTEAM_HEADLESS_COMMAND=cat npm test`, `npx eslint .`,
  `npm run consistency`.

### 35.2 `devteam review-pr <number|url>`

Fetch an inbound PR and review it. Materialize the PR into review inputs under
`pipeline/review-input/` (diff, changed-file list, PR title/body/description as stated
intent — the closest thing to a brief a PR offers), then dispatch the reviewer — and the
critic when `review.mode: adversarial` — against that input. Output: normal stage-05
gate(s) plus `pipeline/code-review/by-*.md`.

Uses `gh pr diff` / `gh pr view --json` via subprocess ([verify-first] confirm whether
any existing code shells to `gh`; `scripts/pr-publish.js` is the likely precedent —
reuse its auth/error handling rather than inventing a second pattern). No `gh` on PATH →
clear actionable error, never a silent skip.

**Publishing is opt-in and gated.** Default is local-only: findings on disk, nothing
sent. `--post` publishes findings as PR review comments; it must (a) print exactly what
will be posted and require interactive confirmation, (b) refuse in non-interactive
contexts unless `--yes` is also passed, (c) never post on a FAIL-to-render or partial
review. Posting to someone else's PR is public and hard to undo, so the confirmation has
to actually stop the command — not a prompt that defaults to yes.

- Acceptance: scripted `gh` stub drives an end-to-end review of a fixture PR producing a
  valid stage-05 gate; adversarial mode adds the critic; `--post` without confirmation
  posts nothing; missing `gh` errors clearly; a partial/failed review never posts.

### 35.3 Mechanical stamping for stage-06d

Close the gap phase 31 deferred. Add `stage-06d` to the stampable set and verify what
actually ran, per method:

- **Property-based:** detect the runner (fast-check / hypothesis / proptest via project
  manifest — never install), execute the property tests the stage wrote under the
  configured path, stamp pass/fail counts and the property count actually executed.
- **Mutation:** reuse the 31.4 runner path rather than adding a second one; stamp
  `mutation_score` with scope.
- **Formal:** presence-and-exit-code only (TLA+/Alloy/Lean toolchains are too varied to
  parse deeply) — stamp `{tool, ran, exit_code}` and treat unparseable output as
  `attempted_but_blocked`, never as success.

`methods_attempted[]` becomes orchestrator-derived; a method the model claims it ran but
that produced no executable evidence flips to `attempted_but_blocked:<method>` with the
model's claim preserved in the stamp block. A surviving mutant on a critical path or a
property counterexample stays FAIL per today's rules — the change is that the
orchestrator, not the model, decides whether the method ran at all.

- Acceptance: fixture project with a real property counterexample FAILs on orchestrator
  evidence; a model claiming `methods_attempted: ["property_based"]` with zero executed
  properties is downgraded; absent toolchain records a skip; existing 06d tests updated
  (enumerate them — this changes asserted behavior).

### 35.4 Findings report with mitigations

`devteam report --findings [--out <file>]`: a severity-ordered report aimed at *fixing
things*, not at proving a pipeline ran. One row per finding across every review artifact
present (security-review, red-team incl. the 31.2 mechanical floor, peer-review/critic,
06d, mutation, audit output under `docs/audit/` when present): severity, `file:line`,
what's wrong, **suggested mitigation**, rough effort, and provenance (model-asserted vs
orchestrator-observed — reuse the existing stamp/observed distinction so a reader can
tell which findings are machine-confirmed). Self-contained HTML like `devteam report`,
plus `--json`.

This is the deliverable for "put an existing codebase through reviews and produce reports
with suggested mitigations" — today that output is scattered across gates and markdown
files with no single ranked view.

- Acceptance: fixture pipeline with findings across three sources produces one ranked
  report with correct provenance labels; empty case renders an honest "no findings"
  rather than a broken table; `--json` shape schema-checked.

### 35.5 `refactor` track

Behavior-preservation, not new behavior — so the gate bar changes rather than relaxes.
Stages: `["build", "peer-review", "qa"]` with two additions: the build brief is a
*characterization* brief (capture current behavior first), and QA's bar is
"behavior preserved" — the existing test suite must pass unchanged **and** the 31.4
mutation gate is enabled by default on this track (a refactor that survives mutation
testing is a refactor that preserved behavior). No new ACs required; the gate's
AC-mapping fields go `null`-permitted as in 35.1.

- Acceptance: `--track refactor` runs on a fixture; a behavior-changing edit fails the
  preserved-behavior bar; mutation default-on for this track only.

## Out of scope

Audit-as-evidence (routing `docs/audit/` security findings through the 34.2 attestation
export — worth doing, blocked on 34.2 landing); auto-fixing review findings (that's
`--repair` and the `implement` skill, both of which already exist); competing with
dedicated PR-review SaaS on inline-comment UX; reviewing non-GitHub forges.

## Success signal

A brownfield repo with zero Stagecraft history can be put through
`devteam run --track review-only --scope src/payments/`, get an adversarial review plus a
mechanical red-team floor, and receive one ranked findings report with mitigations — with
every finding labelled as machine-confirmed or model-asserted. And an inbound PR can be
reviewed with the same machinery without anyone hand-assembling a brief.
