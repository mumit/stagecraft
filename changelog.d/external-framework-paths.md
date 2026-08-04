### Added

- **feat(pipeline):** framework files (`.devteam/rules/*.md`, role briefs, templates) now resolve
  correctly when a review workspace's state root differs from the subject being reviewed
  (`plans/phase-36-external-review-mode.md`, item 36.2). `core/pipeline/stages.js` gains
  `isFrameworkReadFirstPath()`, derived from the existing `FRAMEWORK_READ_FIRST` constant, and
  `core/adapters/render-helpers.js` gains `resolveFrameworkPath(relPath, ctx)`: when
  `ctx.processCwd` (the subject, 36.1's `codeRoot`) differs from `ctx.cwd` (the review workspace,
  `stateRoot`), a framework path renders as an absolute path into `stateRoot` instead of a
  relative path that would resolve into the subject, where it does not exist.
  `core/orchestrator.js#buildDescriptor` applies this to `readFirst` entries;
  `core/adapters/markdown-host.js` (the acp/codex/gemini-cli shared renderer) applies it to the
  role-brief and template pointers. `AGENTS.md` is deliberately left "subject"-rooted — a
  reviewer must read the subject's own `AGENTS.md`, not Stagecraft's init stub.

  Every pre-36.3 caller leaves `ctx.processCwd` unset (36.3 is what will start setting it for a
  real review workspace), so `codeRoot === stateRoot` everywhere in production today and this
  change is a byte-identical no-op until then — covered by
  `tests/external-framework-paths.test.js`'s equal-roots regression, run against both
  `buildDescriptor()`'s output and the fully rendered acp-host prompt.

  Honest scope note: implemented via a small path-based lookup derived from
  `FRAMEWORK_READ_FIRST` rather than annotating every one of `core/pipeline/stages.js`'s ~20
  per-stage `readFirst` arrays with an explicit `{path, root: "framework"}` object — the object
  form (`{path, root, optional}`) is real and honored when present, but marking the two known
  rule files by path keeps this a two-function, zero-`stages.js`-diff change instead of one that
  also has to fix `scripts/prompt-budget.js`'s and `scripts/prompt-optimize.js`'s existing
  strict-shape/`.includes()` readFirst consumers. See the PR description for the full
  deviation rationale.
