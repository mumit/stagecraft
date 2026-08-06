### Fixed

- **`devteam review` had no way to raise (or disable) the per-dispatch timeout, unlike `devteam run`.** Every dispatch is hardcapped at `core/adapters/headless.js`'s `DEFAULT_TIMEOUT_MS` (10 minutes) unless the caller overrides `ctx.timeoutMs` — `devteam run` has exposed `--timeout-ms` for this since it was added, but `core/cli/commands/review.js` never accepted or passed one through to `core/driver.js#run()`. A thorough adversarial/security-review stage over a large diff can legitimately run past 10 minutes; one real run was killed mid-`Write` while producing its final report, with no way to ask for more time short of editing `headless.js` directly.

  Added `--timeout-ms` to `devteam review`, threaded through to `runDriver({ timeoutMs })` exactly as `devteam run` already does — `0` disables the timeout entirely, matching `run`'s own contract. `docs/reference/cli.md` regenerated (`npm run docs:generate`) to pick up the new flag.

  Two new tests in `tests/review-command.test.js`: a dispatch that outlives a short `--timeout-ms` is killed (confirmed to fail without the fix — the flag was previously either silently ignored or rejected as unrecognized, so no transcript was ever produced to inspect), and `--timeout-ms 0` disables it entirely.
