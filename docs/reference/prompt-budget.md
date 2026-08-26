<!-- generated: do not hand-edit -->
<!-- To regenerate: npm run docs:generate (source: core/pipeline/stages.js + rules/ + roles/) -->

# Prompt Budget Reference

Framework prose loaded by every model dispatch — derived from `readFirst` arrays in
`core/pipeline/stages.js`. **Token estimate: bytes ÷ 4** (conservative floor; GPT/Claude
tokenizers average ~3.5–4 bytes/token for English prose).

**Included:** `AGENTS.md`, `rules/` files mapped from `.devteam/rules/`, and the role brief
for each dispatched role.
**Excluded:** `pipeline/*` artifacts (project-dependent, unknown at analysis time).

Run `npm run docs:generate` to regenerate after editing stages.js, rules/, or roles/.

## Per-dispatch framework cost

Multi-role stages appear once per dispatched role. The CI advisory
(`npm run consistency`) warns when any stage's max-dispatch bytes grow >10%.

| Stage     | Name                      | Role       | Framework B | Role brief B | Dispatch B | Tokens~ |
| --------- | ------------------------- | ---------- | ----------- | ------------ | ---------- | ------- |
| stage-01  | requirements              | pm         | 14,281      | 10,618       | 24,899     | 6225    |
| stage-02  | design                    | principal  | 14,281      | 14,820       | 29,101     | 7276    |
| stage-03  | clarification             | pm         | 14,281      | 10,618       | 24,899     | 6225    |
| stage-03b | executable-spec           | pm         | 14,281      | 10,618       | 24,899     | 6225    |
| stage-04  | build                     | backend    | 14,281      | 7,817        | 22,098     | 5525    |
| stage-04  | build                     | frontend   | 14,281      | 6,583        | 20,864     | 5216    |
| stage-04  | build                     | platform   | 14,281      | 2,400        | 16,681     | 4171    |
| stage-04  | build                     | qa         | 14,281      | 3,105        | 17,386     | 4347    |
| stage-04a | pre-review                | platform   | 14,281      | 2,400        | 16,681     | 4171    |
| stage-04b | security-review           | security   | 14,281      | 7,303        | 21,584     | 5396    |
| stage-04c | red-team                  | red-team   | 14,281      | 13,683       | 27,964     | 6991    |
| stage-04d | migration-safety          | migrations | 14,281      | 8,272        | 22,553     | 5639    |
| stage-05  | peer-review               | reviewer   | 14,281      | 7,817        | 22,098     | 5525    |
| stage-06  | qa                        | qa         | 14,281      | 3,105        | 17,386     | 4347    |
| stage-06b | accessibility-audit       | qa         | 14,281      | 3,105        | 17,386     | 4347    |
| stage-06c | observability-gate        | platform   | 14,281      | 2,400        | 16,681     | 4171    |
| stage-06d | verification-beyond-tests | verifier   | 14,281      | 9,089        | 23,370     | 5843    |
| stage-06e | performance-budget        | qa         | 14,281      | 3,105        | 17,386     | 4347    |
| stage-07  | sign-off                  | pm         | 14,281      | 10,618       | 24,899     | 6225    |
| stage-07  | sign-off                  | platform   | 14,281      | 2,400        | 16,681     | 4171    |
| stage-08  | deploy                    | platform   | 14,281      | 2,400        | 16,681     | 4171    |
| stage-09  | retrospective             | principal  | 14,281      | 14,820       | 29,101     | 7276    |

## Top 5 heaviest framework files

| File                | Bytes  | Tokens~ |
| ------------------- | ------ | ------- |
| roles/principal.md  | 14,820 | 3705    |
| roles/red-team.md   | 13,683 | 3421    |
| roles/pm.md         | 10,618 | 2655    |
| roles/verifier.md   | 9,089  | 2273    |
| roles/migrations.md | 8,272  | 2068    |

## Advisory file-size ceilings

`scripts/consistency.js` emits advisories when these ceilings are exceeded.
Advisories are non-blocking (they print but do not fail CI).

| File class         | Ceiling |
| ------------------ | ------- |
| Role brief         | 16 KB   |
| Stage rule file    | 8 KB    |
| AGENTS.md          | 10 KB   |

## Runtime changed-file manifest

Each dispatch may also include a compact changed-file manifest with paths, byte sizes,
and SHA-256 digests only. It is intentionally excluded from the framework growth guard
because it is project/runtime dependent, but it is bounded and measurable.

| Limit | Estimated bytes | Tokens~ |
| ----- | --------------- | ------- |
| 40 files | 5,988 | 1497 |

This replaces eager changed-file content loading: agents inspect file bodies on demand
when the manifest shows a relevant path or digest change.

Framework-owned paths never enter it: Stagecraft's own state and every host install
surface `devteam init` writes. The same predicate filters right-sizing's role
inference and the file list `assess` scores a track from — see
`FRAMEWORK_OWNED_PREFIXES` in [`core/paths.js`](../../core/paths.js).

<!-- budget-data
stage-01,24899
stage-02,29101
stage-03,24899
stage-03b,24899
stage-04,22098
stage-04a,16681
stage-04b,21584
stage-04c,27964
stage-04d,22553
stage-05,22098
stage-06,17386
stage-06b,17386
stage-06c,16681
stage-06d,23370
stage-06e,17386
stage-07,24899
stage-08,16681
stage-09,29101
-->
<!-- /generated -->
