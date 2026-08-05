### Fixed

- `devteam help`'s top-level command listing was missing `corpus` and `evals` entirely — both are real, working, `--help`-documented commands (registered in `core/cli/command-list.js`, phase 37.1), just never added to this hand-written summary list. Added one-line entries for each, matching the surrounding style. `tests/cli.test.js` gained a regression test asserting every command in `core/cli/command-list.js` appears in the top-level listing, so a future command can't silently go missing from it again.

  Honest scope note: this listing is still hand-maintained prose, not generated from the flag specs like `docs/reference/cli.md` (which already listed both commands correctly) or the per-command `--help` output (phase 37.1) — unifying it with the generated doc is a larger change than this fix and out of scope here.
