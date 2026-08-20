# Pipeline Build (Stages 4–8)

The implementation half of the pipeline: build, pre-review, peer code
review, test, sign-off, and deploy. Each stage's rules live in its own
`stage-NN.md` file so the orchestrator (and any agent following a
specific stage) can load only what it needs.

Stages 1, 2, and 9 also have dedicated `stage-NN.md` files because they
carry artifact or gate details worth loading independently. Stage 3
(clarification) and stage 03b (executable spec) stay in `pipeline-core.md`
and their role/skill guidance because they are lightweight routing steps,
not broad procedural rule files. Track routing and the safety stoplist live
in `pipeline-tracks.md`. The full index is in `pipeline.md`. Gate schemas
(required fields, validator behavior, retry protocol) live in
`gates-core.md`.

## Stage index

| Stage | File | Role | Summary |
|---|---|---|---|
| 4 | [`stage-04.md`](stage-04.md) | backend, frontend, platform, qa; optional documentation | Parallel build across code workstreams, or an exact-file documentation-only workstream. Each role writes a per-area PR summary + gate. |
| 4a | [`stage-04a.md`](stage-04a.md) | platform | Pre-review: lint + dep review + SCA + security/migration-safety trigger heuristics. |
| 4b | [`stage-04b.md`](stage-04b.md) | security | Security review — conditional on stage-04a's `security_review_required`. Has veto. |
| 4c | [`stage-04c.md`](stage-04c.md) | red-team | Adversarial review. Unconditional on full + hotfix. Blocking findings must be addressed before Stage 5. |
| 4d | [`stage-04d.md`](stage-04d.md) | migrations | Migration safety — conditional on stage-04a's `migration_safety_required`. Has veto. |
| 4e | [`stage-04e.md`](stage-04e.md) | (script) | Mechanical pre-peer-review preflight: git hygiene, import paths, deferred red-team count. |
| 5 | [`stage-05.md`](stage-05.md) | reviewer × active areas | Peer review. Matrix or scoped shape, including exact-file documentation-only review; per-area gates merged by the orchestrator. |
| 6 | [`stage-06.md`](stage-06.md) | qa | Test execution. Every acceptance criterion maps 1:1 to a test. |
| 6b | [`stage-06b.md`](stage-06b.md) | qa | Accessibility audit. Tracks: full, quick, hotfix. |
| 6c | [`stage-06c.md`](stage-06c.md) | platform | Observability gate — verify brief §9 signals actually emit. Tracks: full, hotfix. |
| 6d | [`stage-06d.md`](stage-06d.md) | verifier | Verification beyond tests: property-based, mutation, formal. Tracks: full. |
| 6e | [`stage-06e.md`](stage-06e.md) | qa | Performance budget: Lighthouse, bundle size, load test. Tracks: full, quick, hotfix. |
| 6x | [`stage-06x.md`](stage-06x.md) | qa | Verification sweep (29.4) — folds 6b/6c/6d/6e into one dispatch on `compact_qa` tracks. Tracks: quick. |
| 7 | [`stage-07.md`](stage-07.md) | pm, platform | Sign-off. Auto-folds from Stage 6 when the AC→test contract is satisfied. |
| 8 | [`stage-08.md`](stage-08.md) | platform | Deploy. Adapter-driven (docker-compose / kubernetes / terraform / custom). |

## How to use these files

- **Orchestrator agent:** load only the stage rules you're about to
  dispatch. Earlier stages are already complete (their gates are on
  disk); later stages haven't started. Loading the index plus the
  single `stage-NN.md` you're working on is enough.
- **Role briefs:** point at the specific `stage-NN.md` you need rather
  than this index. The role briefs do — see e.g.
  `roles/qa.md` § "On a Test-Execution Task".
- **Reviewers / auditors:** read the relevant stage file plus
  `gates-core.md` for the universal gate-field reference, and each `stage-NN.md` for per-stage fields.
