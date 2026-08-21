- **`devteam patterns seed` — start from the conventions a project already
  documents ([ADR-024](docs/adr/024-cold-start-pattern-seeding.md)).** Pattern
  learning only learned from pain: every gate-derived observation begins as a
  blocker, warning, or follow-up, so a project's first run had an empty pattern
  store and agents rediscovered the house rules by failing a gate — even when
  those rules had been written down for years. Seeding reads `AGENTS.md`,
  `CONTRIBUTING.md`, `CLAUDE.md`, `docs/project-conventions.md`, and
  `docs/CONVENTIONS.md`, extracts the statements carrying normative language
  (*must*, *never*, *always*, *prefer*, *avoid*, *require*), and lands them as
  candidates in the same review queue gate-derived ones use. A seeded candidate
  proposes the project's own sentence as its `proposed_prompt_text` and records
  `proposed_from` so a reviewer sees the source document; the per-domain
  templates cannot express a specific house rule. *Honest scope note:*
  candidates only — nothing is promoted and nothing reaches a prompt without the
  existing human `devteam patterns promote`, and seeded candidates enter as
  `nudge` because a documented preference is not evidence of a defect. Headings,
  tables, and fenced code are skipped; wrapped prose is rejoined so fragments are
  never emitted; statements are capped at 40 and bounded to 24–240 characters;
  and every one is secret-scanned at the same bar promotion applies to
  operator-authored text. Re-running is idempotent, and seeded proposals survive
  a later `patterns collect` (they live in their own `seeded.json`, since
  `pending-review.json` is rewritten on every collection).
