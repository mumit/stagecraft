# Project Knowledge Pack

The Project Knowledge Pack is the bounded learned-context block in every stage
prompt. Its purpose is practical: an implementation or review agent should not
spend its first turn rediscovering the repository's stack, verification
commands, and already-reviewed local failure patterns.

It combines three sources without flattening their trust levels:

| Source | Prompt subsection | Trust and lifecycle |
|---|---|---|
| Static repository discovery | Detected conventions | Deterministic facts from manifests and known config files; generated locally with no model or network call. |
| Promoted project patterns | Reviewed patterns and outcome evidence | Operator-reviewed guidance from real gate observations; selected by stage/workstream relevance and evaluated after injection. |
| Semantic project/org memory | Retrieved history | Similar prior artifacts with source attribution; advisory background, never a requirement. |

Stage rules, allowed writes, stoplists, and gate schemas remain authoritative
over every pack entry.

## Detected project facts

`devteam init` writes `.devteam/knowledge/project.json`. An existing project
without that file persists it on its first headless dispatch; preview-only
planning computes facts in memory and remains read-only. The file is operational
state and is included in Stagecraft's managed `.gitignore` block.

Discovery is polyglot: the Python test story is read through the same detector
`devteam verify` uses to actually run the suite (`hasPythonTests` in
`core/verify/runner.js`), so the pack reports the tests that will run rather
than a second, weaker heuristic. Stagecraft's own directories are excluded from
the project's reported structure — see `isFrameworkOwnedPath` in
[`core/paths.js`](../core/paths.js).

The generator scans at most 50 source files and emits a compact subset only:

- language, allow-listed frameworks, package manager (npm/yarn/pnpm/bun, or
  pip/poetry/uv/pipenv), and bundler;
- module system and dominant filename style (`kebab-case`, `PascalCase`,
  `camelCase`, `snake_case`, `lowercase`, `mixed`, or `unknown` — a bare
  single-word name is reported as `lowercase` rather than claimed by a
  convention it does not demonstrate);
- test runner, test-file pattern, and co-location;
- detected tooling;
- canonical commands derived from known package scripts (`test`, `lint`,
  `typecheck`, `check`, `build`) or the standard Go/Python/Rust test command.

Arbitrary source prose, package scripts, filenames, and imports are not copied
into prompt instructions. The pack carries a cheap fingerprint of manifests,
tooling config, and source-directory metadata; a stage refreshes it when those
signals change. `devteam standards discover --force` also refreshes it while
writing the human-readable `docs/project-conventions.md` report.

Detected facts are capped at 1,600 bytes. Missing, malformed, or unknown-schema
packs degrade to regeneration or an empty facts section; they never block a
dispatch.

## Evaluated patterns

Pattern promotion is still an explicit review decision. Stagecraft never turns
raw review prose into future instructions automatically. After promotion, each
real dispatch records injection and collection records a recurrence when the
same blocker returns in that stage.

Every promoted pattern has an evaluation window beginning at its latest
promotion:

- `untried` — no real dispatch has used this revision;
- `no-recurrence-observed` — injected at least once with no matched recurrence;
- `monitor` — a recurrence exists below the configured threshold;
- `quarantined` — recurrences since promotion reached
  `patterns.demotion_recurrence_threshold` (default 3).

A quarantined pattern remains in the audit store but is excluded from prompt
selection immediately, so demonstrably weak guidance stops consuming context
or teaching the same failed advice. The operator then runs `devteam patterns
demote <id>`, revises it, and re-promotes it. Re-promotion starts a new
evaluation window while preserving lifetime counters and demotion history.

The status is evidence of recurrence behavior, not proof of causality. In
particular, `no-recurrence-observed` does not claim the prompt caused success.

## Retrieved history

Retrieved memory remains opt-in and headless-only because retrieval is
asynchronous. The builtin provider is dependency-free; transformer semantics are
an explicit opt-in. Matching chunks are capped at 1,200 bytes and retain `kind` and
`source`. See [Persistent project memory](memory.md) for ingestion, privacy,
org promotion, and retrieval limits.

## Refresh and inspect

```bash
devteam standards discover --force   # refresh facts + human-readable report
devteam patterns review              # inspect candidates and evaluations
devteam patterns stats               # includes quarantined count
devteam memory stats                 # inspect semantic-memory coverage
```

The rendered prompt shows all three sources under one `## Project Knowledge
Pack` heading, with provenance on each entry.
