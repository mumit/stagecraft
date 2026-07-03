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
| stage-01  | requirements              | pm         | 12,437      | 9,828        | 22,265     | 5567    |
| stage-02  | design                    | principal  | 12,437      | 14,066       | 26,503     | 6626    |
| stage-03  | clarification             | pm         | 12,437      | 9,828        | 22,265     | 5567    |
| stage-03b | executable-spec           | pm         | 12,437      | 9,828        | 22,265     | 5567    |
| stage-04  | build                     | backend    | 12,437      | 7,530        | 19,967     | 4992    |
| stage-04  | build                     | frontend   | 12,437      | 6,295        | 18,732     | 4683    |
| stage-04  | build                     | platform   | 12,437      | 2,400        | 14,837     | 3710    |
| stage-04  | build                     | qa         | 12,437      | 2,718        | 15,155     | 3789    |
| stage-04a | pre-review                | platform   | 12,437      | 2,400        | 14,837     | 3710    |
| stage-04b | security-review           | security   | 12,437      | 7,303        | 19,740     | 4935    |
| stage-04c | red-team                  | red-team   | 12,437      | 13,675       | 26,112     | 6528    |
| stage-04d | migration-safety          | migrations | 12,437      | 8,272        | 20,709     | 5178    |
| stage-05  | peer-review               | reviewer   | 12,437      | 6,330        | 18,767     | 4692    |
| stage-06  | qa                        | qa         | 12,437      | 2,718        | 15,155     | 3789    |
| stage-06b | accessibility-audit       | qa         | 12,437      | 2,718        | 15,155     | 3789    |
| stage-06c | observability-gate        | platform   | 12,437      | 2,400        | 14,837     | 3710    |
| stage-06d | verification-beyond-tests | verifier   | 12,437      | 9,089        | 21,526     | 5382    |
| stage-06e | performance-budget        | qa         | 12,437      | 2,718        | 15,155     | 3789    |
| stage-07  | sign-off                  | pm         | 12,437      | 9,828        | 22,265     | 5567    |
| stage-07  | sign-off                  | platform   | 12,437      | 2,400        | 14,837     | 3710    |
| stage-08  | deploy                    | platform   | 12,437      | 2,400        | 14,837     | 3710    |
| stage-09  | retrospective             | principal  | 12,437      | 14,066       | 26,503     | 6626    |

## Top 5 heaviest framework files

| File                | Bytes  | Tokens~ |
| ------------------- | ------ | ------- |
| roles/principal.md  | 14,066 | 3517    |
| roles/red-team.md   | 13,675 | 3419    |
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
stage-01,22265
stage-02,26503
stage-03,22265
stage-03b,22265
stage-04,19967
stage-04a,14837
stage-04b,19740
stage-04c,26112
stage-04d,20709
stage-05,18767
stage-06,15155
stage-06b,15155
stage-06c,14837
stage-06d,21526
stage-06e,15155
stage-07,22265
stage-08,14837
stage-09,26503
-->
<!-- /generated -->
