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
| stage-01  | requirements              | pm         | 13,994      | 10,618       | 24,612     | 6153    |
| stage-02  | design                    | principal  | 13,994      | 14,820       | 28,814     | 7204    |
| stage-03  | clarification             | pm         | 13,994      | 10,618       | 24,612     | 6153    |
| stage-03b | executable-spec           | pm         | 13,994      | 10,618       | 24,612     | 6153    |
| stage-04  | build                     | backend    | 13,994      | 7,817        | 21,811     | 5453    |
| stage-04  | build                     | frontend   | 13,994      | 6,583        | 20,577     | 5145    |
| stage-04  | build                     | platform   | 13,994      | 2,400        | 16,394     | 4099    |
| stage-04  | build                     | qa         | 13,994      | 3,105        | 17,099     | 4275    |
| stage-04a | pre-review                | platform   | 13,994      | 2,400        | 16,394     | 4099    |
| stage-04b | security-review           | security   | 13,994      | 7,303        | 21,297     | 5325    |
| stage-04c | red-team                  | red-team   | 13,994      | 13,683       | 27,677     | 6920    |
| stage-04d | migration-safety          | migrations | 13,994      | 8,272        | 22,266     | 5567    |
| stage-05  | peer-review               | reviewer   | 13,994      | 7,817        | 21,811     | 5453    |
| stage-06  | qa                        | qa         | 13,994      | 3,105        | 17,099     | 4275    |
| stage-06b | accessibility-audit       | qa         | 13,994      | 3,105        | 17,099     | 4275    |
| stage-06c | observability-gate        | platform   | 13,994      | 2,400        | 16,394     | 4099    |
| stage-06d | verification-beyond-tests | verifier   | 13,994      | 9,089        | 23,083     | 5771    |
| stage-06e | performance-budget        | qa         | 13,994      | 3,105        | 17,099     | 4275    |
| stage-07  | sign-off                  | pm         | 13,994      | 10,618       | 24,612     | 6153    |
| stage-07  | sign-off                  | platform   | 13,994      | 2,400        | 16,394     | 4099    |
| stage-08  | deploy                    | platform   | 13,994      | 2,400        | 16,394     | 4099    |
| stage-09  | retrospective             | principal  | 13,994      | 14,820       | 28,814     | 7204    |

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
stage-01,24612
stage-02,28814
stage-03,24612
stage-03b,24612
stage-04,21811
stage-04a,16394
stage-04b,21297
stage-04c,27677
stage-04d,22266
stage-05,21811
stage-06,17099
stage-06b,17099
stage-06c,16394
stage-06d,23083
stage-06e,17099
stage-07,24612
stage-08,16394
stage-09,28814
-->
<!-- /generated -->
