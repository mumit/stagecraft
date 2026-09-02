# Architecture, Implementation, Plans, and Roadmap Review — September 2026

Status: **Proposed** (2026-09-02). Taken at v0.12.0, head `9f1ed62`, after Phase 42 closed.
No code changed in this session.

This review is **run and read**: the full offline suite, lint, and `npm run consistency`
were executed at head; four parallel deep-dives covered architecture (ARCHITECTURE.md, all
ADRs, the host-adapter contract, every adapter), implementation (hotspot modules, error
handling, security posture, tests, CI, Windows claims), plans and roadmap (all 42 phase
plans, the evidence reviews, BACKLOG, recent PRs), and docs/UX (README path, tracks,
prompt-asset volume, positioning). Every claim that mattered to a verdict was re-read
at the cited line before it was kept.

Like [`builder-review-2026-08.md`](builder-review-2026-08.md), findings carry IDs so
they can be referenced from PRs: **A** (architecture), **I** (implementation),
**P** (plans/evidence), **D** (docs/UX).

- [1. Headline](#1-headline)
- [2. Verdict by area](#2-verdict-by-area)
- [3. Architecture and design](#3-architecture-and-design)
- [4. Implementation](#4-implementation)
- [5. Plans and evidence](#5-plans-and-evidence)
- [6. Docs and UX](#6-docs-and-ux)
- [7. Strengths worth protecting](#7-strengths-worth-protecting)
- [8. Recommendation for the next quarter](#8-recommendation-for-the-next-quarter)
- [9. Method](#9-method)

## 1. Headline

The gated-pipeline thesis is sound and the engineering hygiene is well above average.
The problem is above the code: the roadmap has spent three months building routing,
learning, and attestation on top of a pipeline that, on the project's own evidence
([`d5-evidence-review-2026-08-27.md`](d5-evidence-review-2026-08-27.md) §3.3), finished
**1 run in 21**.

| Measured at head | Value |
|---|---|
| Tests passing / failing (skipped) | 3,721 / 0 (2), 90 s |
| Lint | clean |
| Consistency checks passing | 413 (ARCHITECTURE.md still says 185) |
| Autonomous runs that reached `complete` | 1 of 21 |
| Fix : feature commits, last 100 | 28 : 14 |
| Commits, top churn files, last 90 days | `core/orchestrator.js` 128 · `core/driver.js` 102 |

## 2. Verdict by area

In the project's own gate vocabulary:

| Area | Gate | One line |
|---|---|---|
| Architecture and design | **PASS** | Layering holds; the model-invocation boundary is genuinely clean. Two god-modules and unenforced gate schemas are the debts. |
| Implementation | **WARN** | Tests green, lint clean, security careful. A 1,672-line function, swallowed chain stamps, and a fail-open validator default. |
| Plans and evidence | **WARN** | Unusually honest reviews (three consecutive NO-GO verdicts), but the corpus is Stagecraft-on-Stagecraft plus one project with synthetic features. |
| Roadmap and focus | **ESCALATE** | 42 phases, three product theses, no confirmed external user. Completion rate should be the only metric until it moves. |
| Docs and UX | **WARN** | Good skeleton, 3.5 MB of markdown on it. Host lists and asset counts disagree across README, concepts, and comparative analysis. |

## 3. Architecture and design

### What holds

**Decision #2 (the core never spawns a model) is honored.** Every `spawn`/`exec` in
`core/` (~30 sites) is git, a `docker version` probe, a semgrep/cosign probe, the
project's own test runner, or the validator/hook re-exec. The single model-process spawn
is `core/adapters/headless.js:283`, the sanctioned adapter boundary. `core/` never
`require()`s anything under `hosts/`; the only references are comments
(`core/orchestrator.js:763,770,877`).

**Decision #13 (trust profiles) is fail-closed in code, not only in prose.**
`core/containment.js:44-58` throws on `remote` and on `contained` without an image;
wrapping is applied at `core/adapters/headless.js:196`.

**Adding a CLI host is cheap.** `hosts/codex/adapter.js` (40 lines) and
`hosts/antigravity/adapter.js` (64 lines) are shells over `makeMarkdownHostAdapter` and
`runHeadless`. That is real reuse, and the strongest argument that the host-agnostic
claim is earned.

### Debts

**A1 — Two god-modules with the highest churn.**
`core/driver.js:756-2428` is one function, `run()`, at 1,672 lines. Inside it the
`if (!trackHalted)` at `:1548` wraps a `for` loop at `:1549` whose body is 786 lines; the
budget guard, pre-build stoplist, and repair-mode block are duplicated between the
single-action and wave paths (`:1285-1300` vs `:1985-2002`). `core/orchestrator.js`
has `runStageHeadless` at 692 lines (`:978-1669`) mixing dispatch, isolation,
containment, telemetry, and stamping, with a 125-line `experimentalOmnigentDirector`
branch at `:1004`. The `driver-*.js` splits are honest extractions but each is imported
only by `driver.js`, and the loop itself, lock lifecycle, and the eleven
`if (r.action === ...)` branches (`:1655-2256`) were not moved.

**A2 — Gate JSON schemas are shipped but not enforced at runtime.** 22 schemas under
`core/gates/schemas/` are verified structurally in `tests/schemas.test.js` and
`tests/contract.test.js:38`, but `core/gates/validator.js:95-108` checks six required
fields, a status enum, retry integrity, and a 1 MB cap. There is no `schema_version`;
the only versioning is the `orchestrator: devteam@x.y.z` stamp (`:144`) plus
`prompt_pack_version` (`:192`). The validator also has side effects: it rewrites the
gate on disk (`:196`) and injects red-team blockers into `context.md` (`:225`).
Downstream code then trusts model-asserted `tokens_in`/`tokens_out`/`cost_usd`
(labelled as such at `core/driver.js:355-359`) and `file_ownership`
(`core/orchestrator.js:404`).

**A3 — Stage IDs are hardcoded across 59 non-test files.** `core/pipeline/stages.js`
is a real data table (STAGES, TRACKS, STAGES_BY_TRACK, `dependsOn`), but 26 files
special-case `stage-04` or `stage-07` outside it: `fix-recipes.js` (77 hits),
`orchestrator.js` (74), `validator.js` (31), `driver.js` (23), `ui/static/app.js` (54).
Stage-07 sign-off auto-fold and stage-08 local deploy record live inside the generic
runner (`core/orchestrator.js:2137-2335`). Renumbering a stage is a cross-cutting change.

**A4 — Capability negotiation is half-real.** `enforces.*`, `headless`, `httpNative`,
and `usageFormat` are consulted. `hooks`, `worktrees`, and `slashCommands` are declared
by every adapter and read by nothing; the ARCHITECTURE.md example ("no hooks → poll for
the gate file") is not how dispatch works. Core branches on host *names* in five places:
`core/coordinator.js:349-356`, `core/cli/commands/review.js:107,160`,
`core/config.js:284-300`, `core/orchestrator.js:1004-1009`,
`core/hooks/approval-derivation.js:40,110` (whose `KNOWN_HOSTS` lists `gemini-cli` but
not `acp` or `antigravity`). `capabilities.json` has seven distinct key sets across
seven adapters and no schema. `tests/capabilities.test.js:23` hardcodes four adapters.

**A5 — Config has no schema and no unknown-key detection.** `core/config.js:156-266`
normalizes 41 leaf keys across 11 sections; unknown values fall back silently. A second
un-normalized surface escapes via `_raw` at five sites (`hosts/omnigent/adapter.js:130`,
`hosts/openai-compat/invoke.js:49`, `hosts/acp/adapter.js:82`,
`core/verify/license-runner.js:180`, `core/cli/commands/doctor.js:158`). `verify`
(`:209`) and `deploy` (`:243`) pass through unvalidated while every sibling is coerced.
There is no `docs/reference/config.md`.

**A6 — ADR and host-directory drift.** `docs/adr/README.md:65,67` lists 023 and 025 as
Proposed; the files say Accepted. 026 and 027 are not indexed. `hosts/cloud-runner-github/`
contains only a `.DS_Store`. `hosts/docker/` is a Dockerfile, not an adapter, although
ADR-014 says it is not one. `ARCHITECTURE.md:196` and `core/orchestrator.js:109` still
name `gemini-cli` as a host. Eight separate `git diff/status` subprocess helpers exist
(`right-sizing.js:48`, `stoplist.js:53`, `driver.js:724`, `orchestrator.js:2024`,
`context-manifest.js:70`, `write-audit.js:64`, `redteam-floor.js:111`, `preflight.js:369`).

## 4. Implementation

### What holds

**Security is careful where it matters.** No `shell: true` in any adapter; host commands
go through the quote-aware tokenizer in `core/command-line.js`. `child_process.exec` is
never used; `execSync` only with a literal `git rev-parse` (`core/cli/commands/commit.js:294,414`).
The openai-compat bash tool (`hosts/openai-compat/tools.js:160-270`) does argv parsing,
shell-token rejection, a hard-coded executable allowlist, `find /` confinement, a
recursion guard, and process-group kill. The HMAC chain (`core/gates/chain.js`) uses
`timingSafeEqual` with a length check (`:70-77`), refuses to overwrite a signed gate
without the secret (`:119`), and attestations are written `wx` at mode 0600
(`core/evidence/attestation.js:454-459`). The secret is never logged.

**Tests are behavioural.** 3,320 cases across 178 files; zero `assert.ok(true)` or
`equal(x,x)`, no snapshot tests, one file uses `mock.method`. `tests/classify.test.js`
covers every branch of `classifyGate`/`classifyDispatch`; `tests/adapter-contract.test.js`
enumerates adapters dynamically and asserts behaviour. Roughly 40% pure unit, 60%
temp-dir or real-process. CI runs Node 22 and 24, a real `windows-latest` job,
consistency, doctor smoke, README onboarding smoke, evals stub, and a changelog guard.

**Startup discipline.** `bin/devteam:25-38` requires only the selected command module;
`core/observability.js:22` eagerly loads only `@opentelemetry/api` and gates the five
SDK packages on an OTLP endpoint env var. `devteam help/stages/hosts` measure 40 ms.

### Defects worth fixing

| ID | Where | What | Why it matters |
|---|---|---|---|
| **I1** | `core/orchestrator.js:1610, 1711, 1888` | Chain stamping wrapped in `catch { /* */ }` | A gate can be written and its tamper-evidence stamp silently skipped. This undercuts the audit claim the product is named for. Log or journal the failure at minimum. |
| **I2** | `core/gates/validator.js:876-902` | Internal error → PASS unless `--strict` or `CI=true` | A gate that green-lights on its own bug. Default strict when invoked by the orchestrator (non-interactive). |
| **I3** | `core/verify/runner.js:41-59` | `needsShell()` switches to `shell: true` on shell metacharacters; the non-shell path splits on whitespace instead of `splitCommand` | Not model-injectable directly, but the build stage can edit `package.json` scripts and the orchestrator runs `npm test` uncontained on the host (`core/containment.js:84` wraps host dispatch only). The header at `:17-21` claims "never user-controlled". Document the trust boundary or contain verification too. |
| **I4** | `core/driver.js:307-364` | `costUsdDetail` swallows per-gate parse errors | A corrupt gate lowers recorded spend and weakens the `--budget-usd` halt. |
| **I5** | `core/evidence/{bundle.js:15,resolutions.js:11,rulings.js:27,attestation.js:45}`, `core/gates/chain.js:34` | Five copies of `canonicalize`; the four evidence copies are byte-identical | Canonicalization is what hashes depend on. One copy, next to `sha256` (itself ×3: `reproducibility.js:37`, `verify/receipts.js:29`, `patterns.js:42`). |
| **I6** | `core/adapters/headless.js:283` | No PATHEXT or `.cmd` resolution when spawning the host CLI | npm-installed `claude`/`codex` are `.cmd` shims on Windows and will ENOENT. Only `doctor.js:21-39` knows about PATHEXT; the Windows CI job never dispatches a host. `win32` in `package.json` is over-claimed for dispatch. |
| **I7** | `core/verify/stamp.js:121, 558, 720` | `stampStage04a`/`06d`/`03b` are ~150 lines each with the same load-run-compare-push shape; `:150-166` is repeated near-verbatim per field | A fix lands in one of three. |
| **I8** | 59 files | `JSON.parse(fs.readFileSync(...))` inline 98 times although `core/gates/load-gate.js` exists | Inconsistent error handling on the one input the whole system trusts. |

Error handling overall: 555 catch sites, zero literally empty, 192 (35%) contain only a
comment, 53 more `return null/false/[]`. Most comments are honest ("best-effort",
"closed pipe"). I1 and I4 are the ones where swallowing changes what the product promises.
`fs` usage is uniformly synchronous (1,056 `*Sync`, zero `fs/promises`), which is fine
for a CLI but means the driver's async loop blocks on every read.
`eslint-plugin-security` is configured (`eslint.config.js:55-63`) but only catches
non-literal `exec()`; `spawn(cmd, {shell:true})` in I3 is invisible to it.

## 5. Plans and evidence

### The discipline is the best thing here, and the clearest warning

Dated evidence reviews reached NO-GO three times in a row
([`phase-41-evidence-review-2026-08.md`](phase-41-evidence-review-2026-08.md),
[`phase-41-evidence-review-2026-08-21.md`](phase-41-evidence-review-2026-08-21.md),
[`d5-evidence-review-2026-08-27.md`](d5-evidence-review-2026-08-27.md)). The August 27
review said NO-GO while every threshold counter was green: dogfooding averaged 23.4
dispatches per 5-dispatch run (retry storms), two projects disagreed 1.65× vs 18× on the
same measure, every feature was named "evidence round N", and there is no quality
dimension at all.

**P1 — What the evidence actually is.** Stagecraft running on itself, plus one other
project with synthetic features. Zero run logs existed in June
([`h3-ground-truth.md`](h3-ground-truth.md), [`adaptive-routing-evidence.md`](adaptive-routing-evidence.md)).
Across the corpus, 1 of 21 autonomous runs reached `complete`; 9 halted `structural-halt`,
3 `stoplist-halt`. The one organically completed change on record is the five-document
`loop` run of 2026-08-19. The gated capabilities (D5 adaptive routing, H3 recipes,
ADR-005, ADR-007 Tier 2) guard features whose value is unproven, while the number that
should alarm everyone, 20 of 21 halting, is treated as a footnote in the same documents.
`docs/FEATURES.md` "Adaptive routing — let your own data reconfigure the pipeline"
(with `--apply`) overclaims against a gate that has never opened.

### P2 — Phase status, 28 through 42

| Phase | Theme | Status | Reality check |
|---|---|---|---|
| 28 | Telemetry / corpus | hollow until 08-21 | Marked complete 08-01; cost coverage was zero until the pricing table and `dispatchObservation` fixes ([`builder-review-2026-08.md`](builder-review-2026-08.md) F3; 08-21 evidence review). |
| 29 | Scale-adaptive ceremony | done | `loop` is real (4 dispatches, measured). But assess inferred `full` for every new project and init wrote `full` until #431/#432 (F6/F8). The headline claim was false in practice for three weeks. |
| 30 | Closed learning loop | unproven | Code complete. Success signal ("recurrence trending down on a real project") never measured. |
| 31 | Verification depth | partial | 5 of 18 stages orchestrator-stamped vs ≥8 target; adversarial review still opt-in. |
| 32 | Perf / parallelism | partial | 32.4 deferred; 32.1 cache prefix shows no cross-dispatch reuse (builder review §4). |
| 33 | Eval flywheel | unproven | No real project has accumulated cases; `scripts/prompt-optimize.js` never justified a landed change. |
| 34 | ACP / attestation / compliance | done | gemini-cli plugin unpublished and resolves only inside a checkout (BACKLOG A10). |
| 35 | Existing-codebase mode | done | Code present. |
| 36 | External review | unwired | Own caveat still true a month later: `core/evidence/attestation.js` does not read `subject.json`. |
| 37 | Interface / token efficiency | done | Help rewrite was a real win. 37.2 inlining chased prompt bytes the builder review measured at 0.26% of dispatch cost. |
| 38 | Trust profiles | done (PR #413) | `core/containment.js`, ADR-020 present and fail-closed. |
| 39 | Calibration | no data | `core/performance/calibration.js` present; nothing to calibrate against. |
| 40 | Conversational refinement | done, buggy | Aug 22 audit found three structurally dead snapshot fields and a gate-losing apply bug. |
| 41 | Evidence-gated learning / routing | NO-GO ×3 | 41.2–41.4 correctly unbuilt. This is the process working. |
| 42 | Dogfood reliability | done (v0.12.0) | The only phase derived from actually running a real change. |

Older: Phase 21 is proposed with an empty host directory. Phase 23 (prototype mode) is
unreleased and overlaps `loop`. Phases 17 and 18 have said "collection in progress" since
June with no exit criterion. `plans/README.md` "Current state" says 42.1–42.3 are
unreleased while its table says Phase 42 complete in v0.12.0. `phase-27` header says
"first implementation slice in progress" while the index says complete.
`pipeline-speed-opportunities.md` points follow-up at superseded Phase 26.

**P3 — Scope.** Feature accretion with a coherent narrative ("the auditable agent SDLC
that learns") but not a coherent bet. Three product theses run in parallel with no
evidence any has a user: (a) day-to-day SDLC orchestrator (`loop`), (b) auditable
compliance evidence (34/36), (c) self-improving agents (30/33/41). Plus seven first-party
hosts and ten deploy-target docs. The builder review's own measurement (nine
code-reasoned claims overturned by running) says the codebase has outrun its
verification budget.

**P4 — Backlog hygiene.** `docs/BACKLOG.md`: D5 in both Shipped and open D; E11 in both
Shipped and open E; D9/D10/D11 marked ✅ but in open tables; the whole C section
struck-through duplicates Shipped; E13 says "Next P1: 42.4" (done); priority queue dated
2026-06-19. `docs/GAP-ANALYSIS.md` is a five-line redirect. Six of eleven open GitHub
issues are Omnigent items (#305–310) with no owner; #143 has zero comments despite
three reviews living in `plans/`. The 14 pending `changelog.d/` fragments are healthy,
and notably all bug fixes from dogfooding.

## 6. Docs and UX

| Count | Value |
|---|---|
| Markdown in repo | 321 files, 3.56 MB |
| `docs/` | 122 files, 1.7 MB; 38 top-level `.md` = 770 KB (`user-guide.md` 131 KB, `FEATURES.md` 80 KB, `faq.md` 79 KB) |
| CHANGELOG.md | 568 KB, 28 version headings |
| Five "start here" docs combined | ~230 KB |
| Prompt assets | roles 15 (105 KB), rules 30 (112 KB), skills 20 (146 KB), templates 34 (60 KB) |
| `devteam init --host claude-code` | 74 files; 369 KB of rules+agents+skills land in the target repo |
| CLI subcommands | 45 |

**D1 — The skeleton is right; the mass on it is not.** START-HERE routes to four reader
paths and `devteam --help` (28 lines, seven grouped buckets) is the best onboarding
surface in the repo. But README is 43 KB and tries to serve evaluator, operator,
contributor, and auditor on one page; its single `devteam run` row lists 17 flags in
~450 words (README.md:259). EXAMPLE.md is 38 KB, opens with a v0.11 dogfood capture
of a `--repair` run that hit three orchestration defects (EXAMPLE.md:26-70), and then
walks the `full` track the README just told the reader not to use. README's "(3 min)
Read EXAMPLE.md" is ~9K words.

**D2 — Facts are restated instead of owned.** CONTRIBUTING.md:497 says "one owner per
fact." In practice: "gate JSON" is explained in 11 of 38 top-level docs; track-selection
tables appear in four places (README, tracks.md, faq.md, concepts.md) and disagree on
whether `refactor` exists; the host list is 6 in README.md:5 (including the deprecated
Gemini plugin, omitting `antigravity`/`acp`), 7 from `devteam hosts`, 9 directories on
disk, 4 in concepts.md:18, and 6 and 7 on lines 44 and 73 of comparative-analysis.md.
README.md:241-242,376-379 say roles 12 / skills 13 / templates 15 / rules 10+9; the tree
has 15 / 20 / 34 / 30. EXAMPLE.md:696 says hotfix is "10 stages" with no red-team or
performance budget; `STAGES_BY_TRACK.hotfix` has 13 entries including both. The
1,688-line consistency script exists to fight exactly this; half of its prose checks
(`scripts/consistency.js:387-690`) would disappear if those facts lived only in
generated reference docs.

**D3 — First-run traps.**

- `loop` pins the build role to `backend` regardless of the change
  (`core/pipeline/stages.js:996`, `LOOP_DEFAULT_BUILD_ROLE`). Assessing "SMS opt-in
  toggle on settings page" recommends `loop` at `confidence: low` and routes a frontend
  feature to the backend specialist. The override, `loop_build_role`, is documented in
  exactly one doc.
- The `generic` host installs five files, then the rendered prompt inlines
  `(missing: .devteam/rules/pipeline.md)` and `(missing: .devteam/rules/gates-core.md)`.
  The zero-dependency path ships a broken prompt.
- Three true statements about the default track: `core/config.js:29` defaults `full`;
  `devteam init` writes `loop`; README.md:171,219 say "factory default `full`".
- Ten tracks and an eight-step decision tree (tracks.md:382-391) when three would do.
  `nano`, `loop`, and `refactor` are all 3–4 dispatch single-workstream shapes that
  differ in ways only ADR-025 explains.
- Four names for one thing: Stagecraft, `devteam`, `.devteam/`, `pipeline/`, plus both
  `DEVTEAM_*` and `STAGECRAFT_*` env vars and both `~/.stagecraft/` and `.devteam/` on
  disk. `loop` runs `stage-06` before `stage-05`; `stage-04e` is a script, not a stage.

**D4 — Prompt volume.** Per dispatch the fixed framework layer is 14.3 KB
(AGENTS.md + pipeline.md + gates-core.md) plus a 2.4–14.8 KB role brief before any
pipeline artifacts, skills, patterns, or memory. Rendered stage-01 `loop` prompt on a
claude-code install measures ~26 KB; stage-04 build 23.6 KB. `roles/backend.md` inlines
Build, Code Review, Test Fix, and Retrospective sections into every dispatch regardless
of stage; trimming per stage is the largest single lever at ~40% of dispatch bytes.
Not egregious, and the cache-friendly three-file prefix is a good design.

**D5 — Positioning.** `comparative-analysis.md` is unusually honest (§6 names where
competitors are better; "no framework was installed or benchmarked"). The target user
is a platform or regulated team (adoption-guide.md:35 says 1–2 person teams are a poor
fit; attestation, compliance, and ACP-for-external-review are enterprise-shaped). Yet
README's first screen is a solo `npm link` walkthrough.

## 7. Strengths worth protecting

- **One model-invocation boundary.** One spawn site, one HTTP site, one JSON-RPC site,
  all under `hosts/` or `core/adapters/`.
- **Fail-closed where it counts.** Trust profiles refuse to downgrade; the consequence
  ceiling on stage-07/08 needs an explicit `--allow-stage`; the HMAC chain reports
  unsigned/unverified rather than passing silently.
- **Behavioural tests and a real contract test** that enumerates adapters dynamically.
- **Institutional candor.** Three NO-GO reviews, a comparative analysis that names where
  competitors win, an adoption guide with "when to walk away", an EXAMPLE that shows the
  tool failing. It needs to sit *after* the value proposition, not in place of it, but
  it is rare and credible.
- **Startup discipline.** Per-command lazy require, OTel gated on an endpoint, 40 ms cold start.
- **The typed failure model** (`core/gates/classify.js`, `driver-transition.js`) gives the
  autonomy loop a principled shape even though `run()` has not been migrated onto it.

## 8. Recommendation for the next quarter

**One metric.** Completion rate, `complete / logical_runs` per project, reported by
`devteam evidence status`, targeted at ≥80% on `loop` across two *external*
repositories with organically chosen features. Nothing else ships until this moves.
Every phase since 28 assumed runs finish; the corpus says they don't.

### Finish

1. Completion-rate reporting and the retry-aware threshold counting the D5 review
   already asked for (its item 3), plus the evidence-identity mismatch warning (§5).
   Small, and it prevents the next false green.
2. The three implementation defects that touch the audit promise: **I1** logged chain
   stamps, **I2** strict-by-default validator under the orchestrator, **I5** one
   `canonicalize`.
3. Make `loop` change-aware (**D3**): derive the build role from `affected_files` or
   assess output, or fail loudly for UI changes. Most likely first-run disappointment.
4. Cut the visible track menu to `loop` / `quick` / `full`; keep the rest as tracks
   `assess` may pick (ADR-025 already decided the names stay). Delete two of the four
   track tables. State the default track once.
5. Extract the driver loop body and the duplicated dispatch/wave guard into the
   existing `driver-*.js` siblings (**A1**). The seams exist; use them.
6. Extend `npm run consistency` to fail on host-list and asset-count drift (**D2**),
   then stop hand-maintaining those numbers in README.
7. Wire `subject.json` → attestation (Phase 36 caveat) *only if* external review is
   the chosen second bet.

### Freeze

30.3 reflector, 33.4 prompt-optimize, further Phase 39 calibration, Phase 40 wave 3
(chat extensions), ACP server mode, any new host adapter, any new ADR that adds a concept.

### Delete

Phase 21 and the empty `hosts/cloud-runner-github/` (+ #276). Phase 25 and #305–310
(demote Omnigent to a plugin or remove). Phase 23 prototype mode. 32.4 best-of-N.
BACKLOG items E3/F2/F3/F5 (already "consciously deprioritized"). Archive
`pipeline-speed-opportunities.md`. Collapse 41.2–41.4 text into #143 until a gate opens.
Rewrite BACKLOG.md as one table with no struck-through rows. Move `plans/` and
`docs/audit-archive/` out of the user docs index.

**Rule for the quarter:** no Phase 43 that adds capability. Phase 37 proved a
"removes surface only" phase can be executed here. Make the next one "increases
completion rate only."

## 9. Method

Executed at head on 2026-09-02: `CI=true DEVTEAM_HEADLESS_COMMAND=cat npm test`,
`npx eslint .`, `node scripts/consistency.js`. Function lengths measured with a
brace-depth script; catch-site and duplication counts with `grep`; churn with
`git log --name-only`. Phase status and evidence figures come from the project's own
documents in `plans/` and were not re-derived from run logs. Prompt sizes come from
`scripts/prompt-budget.js` and from rendering prompts on a throwaway
`devteam init --host claude-code` project. Line numbers are anchors against `9f1ed62`,
not gospel; if a file has moved, search for the quoted code.

Two claims were checked and *not* kept: the `templates/null` string seen in test output
is a fixture artifact (`tests/write-audit.test.js:486` passes `template: null`), not a
product defect; and OpenTelemetry cold-start cost, suspected from `package.json`, is
absent because the SDK is lazy-loaded.
