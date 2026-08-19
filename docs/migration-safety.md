# Migration safety

Stage 4d. Conditional — fires only when the pre-review heuristic (stage 4a) detects data-layer changes. Has veto power: a failing migration safety gate halts the pipeline regardless of peer-review approval.

- [What triggers it](#what-triggers-it)
- [What the migrations role reviews](#what-the-migrations-role-reviews)
- [Veto criteria](#veto-criteria)
- [Gate fields](#gate-fields)
- [Routing](#routing)
- [References](#references)

---

## What triggers it

The pre-review heuristic in `core/guards/migration-heuristic.js` scans changed
paths plus added lines and sets `migration_safety_required: true` in the
stage-04a gate when it detects:

- Files in migration directories (`migrations/`, `db/migrate/`, `database/migrations/`, etc.)
- Schema files (`schema.rb`, `schema.prisma`, `*.sql` schema files)
- DDL fragments in any changed file: `ALTER TABLE`, `CREATE TABLE`, `DROP TABLE`, `DROP COLUMN`, `RENAME COLUMN`, `RENAME TABLE`

If none of these are present, stage 4d is skipped entirely.

---

## What the migrations role reviews

The migrations reviewer answers six questions for each migration:

1. **What does this migration do?** Brief plain-language description.
2. **Is it a breaking change?** A breaking change removes or renames a column/table that live code still reads.
3. **Is a backfill required?** Required when adding a NOT NULL column to a table with existing rows.
4. **Is dual-write required?** Required when changing a column name or type while old code may still write the old name.
5. **What is the rollback plan?** Step-by-step procedure to undo the migration if something goes wrong.
6. **Was the rollback tested?** Has the rollback been executed against a test environment?

---

## Veto criteria

The gate sets `veto: true` automatically when any of these conditions are met:

| Condition | Veto trigger |
|---|---|
| `rollback_plan` is empty | Yes — every migration must have a rollback |
| `breaking_change: true` AND `rollback_tested: false` | Yes — breaking changes must have a verified rollback |
| `backfill_required: true` AND `backfill_strategy` is empty | Yes — a missing backfill strategy is a data-loss risk |

**A veto halts the pipeline.** Peer-review approvals cannot override it. The migrations role must re-review the fix after it is addressed.

---

## Gate fields

| Field | Type | Notes |
|---|---|---|
| `migration_files` | string[] | Files that triggered the heuristic |
| `breaking_change` | boolean | Whether the migration is breaking |
| `backfill_required` | boolean | Whether a backfill is needed |
| `backfill_strategy` | string | Required when `backfill_required: true` |
| `dual_write_required` | boolean | Whether dual-write is needed |
| `rollback_plan` | string | Step-by-step rollback procedure |
| `rollback_tested` | boolean | Whether rollback was verified in test env |
| `migration_approved` | boolean | Overall approval decision |
| `veto` | boolean | Whether this gate halts the pipeline |

---

## Routing

Route to a different host than the build agents. Migration review is most effective when the reviewer has different context than the implementer.

```yaml
routing:
  roles:
    migrations: codex   # or gemini-cli — different from the build host
```

---

## References

- Role brief: `roles/migrations.md`
- Heuristic: `core/guards/migration-heuristic.js`
- Related: [docs/FEATURES.md](FEATURES.md) § Pipeline stages — Migration safety
- Related: [docs/user-guide.md](user-guide.md) § Per-stage details — Stage 4d
