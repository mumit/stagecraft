# Phase 31 — Verification Depth

Status: **complete** (2026-08-02) — all five items shipped
(from [landscape-review-2026-07.md](landscape-review-2026-07.md) §3.4).
Prompts: [prompts/roadmap-2026-prompts.md](prompts/roadmap-2026-prompts.md) §31.

| Item | Status |
|---|---|
| 31.1 per-role stamping | ✅ complete — stage-04 workstreams stamped individually plus a merged stamp; receipts prevent duplicate suite runs |
| 31.2 mechanical red-team floor | ✅ complete — dependency audit, secret scan, semgrep-if-configured, dependency diff; stage-04c now stampable |
| 31.3 adversarial review pair | ✅ complete — opt-in `review.mode: adversarial`, reviewer then critic, cross-host by default |
| 31.4 mutation smoke gate | ✅ complete — opt-in, changed-files-only, time-boxed; WARN by default, FAIL when `threshold_hard` |
| 31.5 stage-05 quorum re-derivation | ✅ complete — merged gate re-derives approvals from the review files on every host |

Stamping now covers stage-03b, 04a, 04c, and 06. **Stage-06d is still not stamped** —
property-based and formal-method results remain model-asserted. That is
[phase 35](phase-35-existing-codebase-mode.md) item 35.3.

## Why

The validator's own header says it: "the validator only enforces shape, not truth."
Orchestrator-stamped truth exists for 3 of 18 stages, and only on single-workstream
dispatches — so stage-04 (build) and stage-05 (peer-review), the stages where models
most often overclaim, are never stamped. Red-team is 100% prompt-level: a model
reporting `findings_count: 0` is believed, in the exact stage whose job is distrust.
Meanwhile 2026 evidence says review *panels* underperform an adversarial reviewer–critic
pair and are measurably collusion-prone. Verification is Stagecraft's identity; this
phase makes the identity true for most of the pipeline.

## Work items

### 31.1 Per-role stamping for multi-workstream stages

[verify-first] Claim: `core/verify/stamp.js` stamping is bypassed when
`plan.workstreams.length !== 1` (orchestrator comment: "Multi-role stages would need
per-role stamping, which isn't in scope here").

Implement: stamp per workstream gate after each workstream completes (not after merge):
for stampable checks that are workstream-scoped (lint/tests over that workstream's
`allowedWrites` surface), run them per role; workspace-global checks (full test suite)
run once post-merge and stamp the merged stage gate. Verification receipts
(`core/verify/receipts.js`) already dedupe repeated identical commands — reuse them so
4 workstreams don't mean 4 full test runs. Extend `STAMPABLE_STAGES` mechanics rather
than special-casing.

- Acceptance: a 4-workstream stage-04 stubbed run produces per-role stamps + one merged
  stamp; a model claiming `tests_passed: true` against a failing suite gets overridden
  on the merged gate; receipts prevent duplicate suite runs.
- Verify: `npm test`, `CI=true DEVTEAM_HEADLESS_COMMAND=cat npm test`, `npx eslint .`,
  `npm run consistency`.

### 31.2 Mechanical red-team floor (stage-04c)

Keep the model's adversarial pass; add an orchestrator-run floor that cannot be
sweet-talked: (a) `npm audit --json` (or the polyglot equivalent already resolved by
`core/verify/` suite detection) — network-dependent, so absence of network records
`skipped: offline` rather than PASS; (b) the existing secret-scan over changed files;
(c) semgrep with the project's config if a config file exists (never install it);
(d) dependency-diff review: new deps since the last gate listed on the gate.
Orchestrator findings merge into the gate; `findings_count` becomes
max(model, mechanical); a mechanical HIGH finding forces `must_address_before_peer_review`
regardless of the model's report. Stamp block records what ran and what was skipped.

- Acceptance: seeded vulnerable fixture flips a model-PASS to FAIL; offline behavior
  records skips honestly; stage-04c joins `STAMPABLE_STAGES` (multi-tool variant).

### 31.3 Adversarial review pair mode (stage-05)

Add `review.mode: panel | adversarial` (default stays `panel` — no behavior change
without opt-in). Adversarial mode dispatches two workstreams: a **reviewer** (writes
findings with file:line evidence) and a **critic** whose brief is to attack the
*review* — find what the reviewer missed, challenge unsupported approvals, and
explicitly answer "what would make this approval wrong?". Approval requires the critic
gate to record `challenges_resolved: true` with per-challenge dispositions. When
multiple hosts are configured, route reviewer and critic to different hosts by default
(cross-model verification — the Zenflow-validated pattern, and the collusion
counter-measure). New role brief `roles/critic.md`; reuse approval-derivation for both.

- Acceptance: adversarial stubbed run produces reviewer + critic gates and a merged
  stage-05 gate; unresolved challenges block; routing splits hosts when ≥2 configured;
  panel mode byte-identical to today.

### 31.4 Mutation smoke gate (opt-in)

`pipeline.verify.mutation: {enabled, threshold, paths}` — when enabled and a supported
runner is present in the project (Stryker for JS/TS, mutmut for Python; never installed
by Stagecraft), stage-06 stamping runs a **changed-files-only, time-boxed** mutation
pass and stamps `mutation_score`. Below-threshold is a WARN by default (advisory,
surfaces in `devteam advise`), FAIL only when `threshold_hard: true`. This is the
counter-measure to "same model writes code and tests that validate each other's blind
spots."

- Acceptance: fixture project with a killable-mutant gap scores below threshold and
  WARNs; time-box kills long runs cleanly (reuse `core/process-kill.js`); absent runner
  → recorded skip, not silence.

### 31.5 Stage-05 quorum verification

[verify-first] Claim: peer-review quorum/approval counting relies on approval-derivation
hook output (claude-code) or model-written gates (other hosts), and `devteam
derive-approvals` exists precisely because saves outside the hook bypass it.

Implement: post-merge, the orchestrator independently re-derives approval state from
`pipeline/code-review/by-*.md` (the parser already exists in
`core/hooks/approval-derivation.js` — call it directly, don't reimplement) and stamps
disagreements. A gate claiming APPROVED whose review file says CHANGES REQUESTED flips
to FAIL with the field-level diff recorded.

- Acceptance: seeded mismatch (gate says approved, file says changes-requested) is
  caught on every host, not just claude-code.

## Out of scope

Fuzzing/property-testing orchestration (06d stays prompt-level this phase), SAST beyond
semgrep-if-configured, stamping stages whose truth is inherently judgment (design,
retro), changing the default review mode (needs real-run evidence first — corpus from
Phase 28 will show panel vs adversarial outcomes).

## Success signal

≥8 of 18 stages carry an `_orchestrator_stamped`/`_orchestrator_observed` block; build
and peer-review can no longer pass on unverified self-report anywhere; red-team has a
mechanical floor. The comparative-analysis claim "mechanically overrules model claims"
becomes true for the majority of the pipeline instead of 3 stages.
