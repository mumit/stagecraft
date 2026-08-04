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
| stage-01  | requirements              | pm         | 12,473      | 9,828        | 22,301     | 5576    |
| stage-02  | design                    | principal  | 12,473      | 14,528       | 27,001     | 6751    |
| stage-03  | clarification             | pm         | 12,473      | 9,828        | 22,301     | 5576    |
| stage-03b | executable-spec           | pm         | 12,473      | 9,828        | 22,301     | 5576    |
| stage-04  | build                     | backend    | 12,473      | 7,530        | 20,003     | 5001    |
| stage-04  | build                     | frontend   | 12,473      | 6,295        | 18,768     | 4692    |
| stage-04  | build                     | platform   | 12,473      | 2,400        | 14,873     | 3719    |
| stage-04  | build                     | qa         | 12,473      | 2,718        | 15,191     | 3798    |
| stage-04a | pre-review                | platform   | 12,473      | 2,400        | 14,873     | 3719    |
| stage-04b | security-review           | security   | 12,473      | 7,303        | 19,776     | 4944    |
| stage-04c | red-team                  | red-team   | 12,473      | 13,683       | 26,156     | 6539    |
| stage-04d | migration-safety          | migrations | 12,473      | 8,272        | 20,745     | 5187    |
| stage-05  | peer-review               | reviewer   | 12,473      | 7,249        | 19,722     | 4931    |
| stage-06  | qa                        | qa         | 12,473      | 2,718        | 15,191     | 3798    |
| stage-06b | accessibility-audit       | qa         | 12,473      | 2,718        | 15,191     | 3798    |
| stage-06c | observability-gate        | platform   | 12,473      | 2,400        | 14,873     | 3719    |
| stage-06d | verification-beyond-tests | verifier   | 12,473      | 9,089        | 21,562     | 5391    |
| stage-06e | performance-budget        | qa         | 12,473      | 2,718        | 15,191     | 3798    |
| stage-07  | sign-off                  | pm         | 12,473      | 9,828        | 22,301     | 5576    |
| stage-07  | sign-off                  | platform   | 12,473      | 2,400        | 14,873     | 3719    |
| stage-08  | deploy                    | platform   | 12,473      | 2,400        | 14,873     | 3719    |
| stage-09  | retrospective             | principal  | 12,473      | 14,528       | 27,001     | 6751    |

## Top 5 heaviest framework files

| File                | Bytes  | Tokens~ |
| ------------------- | ------ | ------- |
| roles/principal.md  | 14,528 | 3632    |
| roles/red-team.md   | 13,683 | 3421    |
| roles/pm.md         | 9,828  | 2457    |
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

<!-- budget-data
stage-01,22301
stage-02,27001
stage-03,22301
stage-03b,22301
stage-04,20003
stage-04a,14873
stage-04b,19776
stage-04c,26156
stage-04d,20745
stage-05,19722
stage-06,15191
stage-06b,15191
stage-06c,14873
stage-06d,21562
stage-06e,15191
stage-07,22301
stage-08,14873
stage-09,27001
-->
<!-- /generated -->
