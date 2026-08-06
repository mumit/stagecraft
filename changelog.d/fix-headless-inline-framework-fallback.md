### Fixed

- **claude-code headless dispatches no longer silently stall once a prompt carries phase-37.2's inlined framework content.** `core/adapters/headless.js`'s "C2" guard against claude-code's `--print` mode 4000-char "Goal condition" limit (which rejects the prompt and exits 0 with no gate written — a silent, structural-input halt) only ever backed off `patchItems`. It never accounted for `prompts.inline_framework` (default `true` since 37.2), which inlines `AGENTS.md`, `.devteam/rules/*.md`, and the role brief — ~18-22 KB — directly into the prompt. Every claude-code headless dispatch past the first couple of stages was therefore guaranteed to exceed the limit regardless of `patchItems`, with no error surfaced.

  The fallback chain now backs off in order: drop `patchItems`, then drop the inlined framework/role-brief content (`core/adapters/render-helpers.js#shouldInlineFramework` gained a per-call `ctx.inlineFrameworkOverride === false` escape hatch, independent of `.devteam/config.yml`), and — if still over budget after both — reject with a clear error instead of spawning a dispatch that would silently no-op.

  Three new tests in `tests/headless.test.js` cover each branch of the chain (patchItems-only overflow, framework-only overflow, and the hard-reject case), verified to fail without the fix.

  Honest scope note: projects on `prompts.inline_framework: true` (the default) with a large `AGENTS.md`/rules set routed to claude-code headless may still want `inline_framework: false` set explicitly for that host — this fix stops the silent stall, but a run that leans on the fallback loses the cache-prefix benefit 37.2 was for on every affected dispatch.
