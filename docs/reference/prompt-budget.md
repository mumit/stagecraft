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
| stage-01  | requirements              | pm         | 13,670      | 9,831        | 23,501     | 5876    |
| stage-02  | design                    | principal  | 13,670      | 14,528       | 28,198     | 7050    |
| stage-03  | clarification             | pm         | 13,670      | 9,831        | 23,501     | 5876    |
| stage-03b | executable-spec           | pm         | 13,670      | 9,831        | 23,501     | 5876    |
| stage-04  | build                     | backend    | 13,670      | 7,817        | 21,487     | 5372    |
| stage-04  | build                     | frontend   | 13,670      | 6,583        | 20,253     | 5064    |
| stage-04  | build                     | platform   | 13,670      | 2,400        | 16,070     | 4018    |
| stage-04  | build                     | qa         | 13,670      | 2,718        | 16,388     | 4097    |
| stage-04a | pre-review                | platform   | 13,670      | 2,400        | 16,070     | 4018    |
| stage-04b | security-review           | security   | 13,670      | 7,303        | 20,973     | 5244    |
| stage-04c | red-team                  | red-team   | 13,670      | 13,683       | 27,353     | 6839    |
| stage-04d | migration-safety          | migrations | 13,670      | 8,272        | 21,942     | 5486    |
| stage-05  | peer-review               | reviewer   | 13,670      | 7,249        | 20,919     | 5230    |
| stage-06  | qa                        | qa         | 13,670      | 2,718        | 16,388     | 4097    |
| stage-06b | accessibility-audit       | qa         | 13,670      | 2,718        | 16,388     | 4097    |
| stage-06c | observability-gate        | platform   | 13,670      | 2,400        | 16,070     | 4018    |
| stage-06d | verification-beyond-tests | verifier   | 13,670      | 9,089        | 22,759     | 5690    |
| stage-06e | performance-budget        | qa         | 13,670      | 2,718        | 16,388     | 4097    |
| stage-07  | sign-off                  | pm         | 13,670      | 9,831        | 23,501     | 5876    |
| stage-07  | sign-off                  | platform   | 13,670      | 2,400        | 16,070     | 4018    |
| stage-08  | deploy                    | platform   | 13,670      | 2,400        | 16,070     | 4018    |
| stage-09  | retrospective             | principal  | 13,670      | 14,528       | 28,198     | 7050    |

## Top 5 heaviest framework files

| File                | Bytes  | Tokens~ |
| ------------------- | ------ | ------- |
| roles/principal.md  | 14,528 | 3632    |
| roles/red-team.md   | 13,683 | 3421    |
| roles/pm.md         | 9,831  | 2458    |
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
stage-01,23501
stage-02,28198
stage-03,23501
stage-03b,23501
stage-04,21487
stage-04a,16070
stage-04b,20973
stage-04c,27353
stage-04d,21942
stage-05,20919
stage-06,16388
stage-06b,16388
stage-06c,16070
stage-06d,22759
stage-06e,16388
stage-07,23501
stage-08,16070
stage-09,28198
-->
<!-- /generated -->
