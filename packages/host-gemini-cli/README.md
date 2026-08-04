# @devteam/host-gemini-cli

Stagecraft host adapter for [Gemini CLI](https://github.com/google-gemini/gemini-cli).

**Deprecated upstream.** Gemini CLI stopped serving free/Pro/Ultra requests
2026-06-18. Google's supported successor is Antigravity CLI — migrate with
`devteam init --host antigravity` (see `hosts/antigravity/` in the main
Stagecraft repo). This adapter is kept working for existing projects that
still route to `gemini-cli`; `devteam doctor` warns whenever routing resolves
to it.

## Why this is a plugin, not a first-party host

Phase 34.4 (`plans/phase-34-interop-auditable-sdlc.md`) moved this adapter out
of `hosts/` and into `packages/host-gemini-cli/` per the A4 pluggable-adapter
mechanism (`core/router.js`; contract documented in
`core/adapters/host-adapter.md`). First-party maintenance cost for a host
whose upstream has already end-of-lifed the product it targets isn't a good
trade against adapters for hosts still receiving investment. The adapter
itself is unchanged — same contract, same capabilities, same tests — only its
location and packaging moved.

## Install

```
npm install @devteam/host-gemini-cli
devteam init --host gemini-cli
```

`devteam init --host gemini-cli` without the package installed fails with
this exact instruction (`core/cli/commands/init.js`).

## Honest scope note

This package is shaped to be publishable (own `package.json`, own tests,
standalone `README.md`) but is **not published to any registry** as part of
34.4 — that's a separate decision (which registry, under which org) that
this item doesn't make. Within this repo, `adapter.js` reaches Stagecraft's
core via relative paths (`../../core/adapters/headless`,
`../../core/adapters/markdown-host`), which resolve correctly because this
package lives inside a Stagecraft checkout at `packages/host-gemini-cli/`.
A genuinely standalone install (this package alone, `stagecraft` as an
installed sibling dependency rather than a relative filesystem neighbor)
would need those requires rewritten to resolve `stagecraft` as a package
(e.g. `require("stagecraft/core/adapters/headless")`) — which in turn needs
Stagecraft itself to be a publishable, non-private package. Both are real
gaps, not fixed here; tracked as `docs/BACKLOG.md` item A10.

## Contract

Implements the standard adapter surface: `capabilities`, `install`,
`renderStagePrompt`, `renderStagePromptLayers`, `status`, `uninstall`,
`invoke` (headless). See `core/adapters/host-adapter.md` in the main repo for
the full contract.

## Tests

`npm test` in this directory runs `tests/*.test.js` standalone. The main
Stagecraft repo's `npm test` also runs these (see root `package.json`'s test
script), so a regression here fails CI the same as any first-party adapter.
