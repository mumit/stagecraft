<!-- generated: do not hand-edit -->
<!-- To regenerate: npm run docs:generate (source: core/cli/commands/*.js) -->

# CLI Reference

Full `devteam` command reference. 39 commands.
Derived from the per-command flag schemas in `core/cli/commands/`.
Run `npm run docs:generate` to regenerate after adding or changing flags.

All flags are optional unless marked otherwise. `--help` is available on every command.

---

### `devteam stage <name> [options]`

Render stage prompt(s) for <name>, or drive the host CLI non-interactively with --headless.

| Flag                             | Type   | Description                                                                 |
| -------------------------------- | ------ | --------------------------------------------------------------------------- |
| --feature                        | string | Feature description passed to the prompt                                    |
| --feature-file                   | string | Read feature description from a UTF-8 text file                             |
| --track                          | string | Override the pipeline track                                                 |
| --cwd                            | string | Target project directory                                                    |
| --headless                       | bool   | Drive host CLI non-interactively                                            |
| --timeout-ms                     | number | Per-workstream wall-clock cap (default 600000)                              |
| --patch                          | bool   | Scope build agents to patch items from a prior gate                         |
| --from                           | string | Stage to read patch items from (default: red-team)                          |
| --skip-completed                 | bool   | Skip workstreams whose gate file already exists                             |
| --workstream                     | list   | Dispatch only this workstream (repeatable)                                  |
| --experimental-omnigent-director | bool   | EXPERIMENTAL: run planned Omnigent workstreams through one director session |
| --force                          | bool   | Bypass stoplist guard                                                       |
| --json                           | bool   | JSON output                                                                 |
| --skip-preflight                 | bool   | Skip automatic preflight check before peer-review                           |

### `devteam next [options]`

Inspect pipeline/gates/ and report what to do next: run a stage, merge, fix a FAIL, resolve an ESCALATE, or done.

| Flag          | Type   | Description                                                                  |
| ------------- | ------ | ---------------------------------------------------------------------------- |
| --cwd         | string | Target project directory                                                     |
| --feature     | string | Feature name (bounded isolation mode)                                        |
| --track       | string | Override the pipeline track (default: read from run-state.json, then config) |
| --json        | bool   | JSON output                                                                  |
| --skip-advise | bool   | Suppress unresolved follow-up advisory warning                               |

### `devteam run [options]`

Bounded autonomous driver with optional TTY watch mode: loop next → dispatch → merge until pipeline-complete, halting for anything that needs a human. Use --feature for new work; --repair for bug fixes.

| Flag               | Type   | Description                                                                                          |
| ------------------ | ------ | ---------------------------------------------------------------------------------------------------- |
| --cwd              | string | Target project directory                                                                             |
| --feature          | string | Feature description                                                                                  |
| --feature-file     | string | Read feature description from a UTF-8 text file                                                      |
| --repair           | string | Bug symptom for repair mode (exclusive with --feature; ADR-009)                                      |
| --repair-at        | string | Skip diagnosis: seed affected-files from file:line location(s) (comma-separated; ADR-009 Phase 2)    |
| --track            | string | Override the pipeline track                                                                          |
| --until            | string | Stop before this stage                                                                               |
| --max-iterations   | number | Iteration cap                                                                                        |
| --budget-usd       | number | Cost cap in USD                                                                                      |
| --timeout-ms       | number | Per-dispatch timeout (ms)                                                                            |
| --retry-delay-ms   | number | Backoff delay between transient retries (ms)                                                         |
| --auto-rule        | list   | Auto-apply Principal rulings of these classes (comma-separated)                                      |
| --allow-stage      | list   | Grant consequence-ceiling approval for this stage (repeatable, comma-separated)                      |
| --resume           | bool   | Resume an interrupted run                                                                            |
| --force            | bool   | Force-unlock a stale run.lock                                                                        |
| --json             | bool   | JSON summary on stdout                                                                               |
| --fail-on-advisory | toggle | Exit 3 if advisory blockers remain after pipeline-complete (=all adds PEER_REVIEW_RISK to threshold) |
| --auto-commit      | bool   | Automatically commit pipeline artifacts after a clean halt (ceiling, --until, budget)                |
| --watch            | bool   | Render rolling liveness status on an interactive terminal                                            |

### `devteam prototype <start|build|note|promote> [id-or-title] [options]`

Pre-SDLC fast-learning workflow. Creates prototype packets, optionally runs the build prompt through a headless host, appends feedback, and writes a promotion handoff into a normal Stagecraft track.

| Flag               | Type   | Description                                               |
| ------------------ | ------ | --------------------------------------------------------- |
| --cwd              | string | Target project directory                                  |
| --id               | string | Prototype id (default: slug from title)                   |
| --feature          | string | Prototype intent text                                     |
| --feature-file     | string | Read prototype intent from a UTF-8 file                   |
| --feedback         | string | Feedback text for prototype note                          |
| --host             | string | Host for prototype build (default: routing.default_host)  |
| --apply-to-project | bool   | Allow prototype build writes outside the packet workspace |
| --timeout-ms       | number | Prototype build timeout in milliseconds                   |
| --track            | string | Promotion target track (default: full)                    |
| --force            | bool   | Overwrite an existing prototype packet on start           |
| --json             | bool   | Machine-readable output                                   |

### `devteam commit [options]`

Stage exactly the right pipeline artifacts for completed stages and generate a meaningful commit message. Tracks a cursor so repeated calls are idempotent.

| Flag      | Type   | Description                                        |
| --------- | ------ | -------------------------------------------------- |
| --all     | bool   | Stage all gate-bearing stages regardless of cursor |
| --dry-run | bool   | Print what would be staged without committing      |
| --message | string | Override generated commit message                  |
| --json    | bool   | Machine-readable output                            |
| --cwd     | string | Target project directory                           |

### `devteam compact [options]`

Remove all devteam-managed marker sections from pipeline/context.md. Sections are regenerated on the next run when still needed. Use to prune context.md after a long pipeline run or before switching to bounded isolation.

| Flag      | Type   | Description                                             |
| --------- | ------ | ------------------------------------------------------- |
| --dry-run | bool   | Show what would be removed without modifying context.md |
| --json    | bool   | Machine-readable output                                 |
| --cwd     | string | Target project directory                                |

### `devteam validate [options]`

Validate the most recent gate in pipeline/gates/. Exit codes: 0 PASS/WARN, 1 malformed, 2 FAIL, 3 ESCALATE.

| Flag  | Type   | Description              |
| ----- | ------ | ------------------------ |
| --cwd | string | Target project directory |

### `devteam verify-chain [options]`

Verify predecessor hashes and optional HMAC authentication across the stage-gate chain.

| Flag             | Type   | Description                                  |
| ---------------- | ------ | -------------------------------------------- |
| --cwd            | string | Target project directory                     |
| --track          | string | Override the pipeline track                  |
| --json           | bool   | JSON output                                  |
| --require-signed | bool   | Fail unless every gate has a verifiable HMAC |

### `devteam stamp-chain [options]`

(Re)stamp the chain on all stage gates, in order. Use after a deliberate earlier-stage re-run.

| Flag    | Type   | Description                 |
| ------- | ------ | --------------------------- |
| --cwd   | string | Target project directory    |
| --track | string | Override the pipeline track |

### `devteam merge <stage-name> [options]`

Merge per-workstream gates into the stage gate.

| Flag    | Type   | Description                 |
| ------- | ------ | --------------------------- |
| --cwd   | string | Target project directory    |
| --track | string | Override the pipeline track |

### `devteam derive-approvals [<file>] [options]`

Re-run the approval-derivation hook on pipeline/code-review/by-*.md and rewrite per-area stage-05 gates.

| Flag      | Type   | Description                           |
| --------- | ------ | ------------------------------------- |
| --cwd     | string | Target project directory              |
| --feature | string | Feature name (bounded isolation mode) |
| --json    | bool   | JSON output                           |

### `devteam restart <stage> [options]`

Clear a stage's gate(s) so the pipeline can re-run it. With --cascade, also clears every subsequent stage.

| Flag           | Type   | Description                                      |
| -------------- | ------ | ------------------------------------------------ |
| --cwd          | string | Target project directory                         |
| --feature      | string | Feature name (bounded isolation mode)            |
| --cascade      | bool   | Also clear every stage after this one            |
| --keep-context | bool   | Preserve injected blocker sections in context.md |
| --dry-run      | bool   | Print what would be deleted without acting       |
| --track        | string | Override the pipeline track (for cascade)        |

### `devteam ruling [options]`

Dispatch the Principal subagent for an ad-hoc ruling. The ruling lands in pipeline/context.md.

| Flag          | Type   | Description                              |
| ------------- | ------ | ---------------------------------------- |
| --cwd         | string | Target project directory                 |
| --topic       | string | Ruling topic (auto-derived when omitted) |
| --context     | string | Comma-separated extra context paths      |
| --target-gate | string | Path to the escalating gate              |
| --headless    | bool   | Dispatch via host CLI non-interactively  |

### `devteam fix-escalation [options]`

Implement the Principal ruling written by devteam ruling. Dispatches an applicator agent that reads PRINCIPAL-RULING entries.

| Flag       | Type   | Description                             |
| ---------- | ------ | --------------------------------------- |
| --cwd      | string | Target project directory                |
| --headless | bool   | Dispatch via host CLI non-interactively |

### `devteam preflight [options]`

Run mechanical pre-peer-review checks (stage-04e): committed-but-ignored files, broken test imports, deferred red-team items.

| Flag         | Type   | Description                                |
| ------------ | ------ | ------------------------------------------ |
| --cwd        | string | Target project directory                   |
| --skip-write | bool   | Run checks but do not write stage-04e.json |

### `devteam advise [options]`

Inspect and triage follow-up items (DEFERRED, KNOWN-FLAKY, BRIEF-AMEND-NEEDED) before peer-review.

| Flag         | Type   | Description                            |
| ------------ | ------ | -------------------------------------- |
| --cwd        | string | Target project directory               |
| --feature    | string | Feature name (bounded isolation mode)  |
| --apply      | string | Apply selections, e.g. AC-11=A,AC-12=B |
| --json       | bool   | JSON output                            |
| --timeout-ms | number | Timeout for a11y-fixer dispatch (ms)   |

### `devteam init --host <list> [options]`

Install host adapter(s) into the current project. Writes .devteam/config.yml and creates pipeline/gates/ workspace.

| Flag      | Type   | Description                                                                                               |
| --------- | ------ | --------------------------------------------------------------------------------------------------------- |
| --host    | string | Host adapter(s), comma-separated                                                                          |
| --adapter | string | Deploy adapter for stage-08: local, docker-compose, kubernetes, terraform, cloud-run, gizmos, npm, custom |
| --force   | bool   | Overwrite existing config/files                                                                           |
| --cwd     | string | Target project directory                                                                                  |
| --profile | string | Optional profile: dogfood                                                                                 |

### `devteam doctor [options]`

Pre-flight check: install integrity, target layout, config validity, adapter status, and host CLIs on PATH.

| Flag  | Type   | Description              |
| ----- | ------ | ------------------------ |
| --cwd | string | Target project directory |

### `devteam summary [options]`

One-screen pipeline state report.

| Flag   | Type   | Description              |
| ------ | ------ | ------------------------ |
| --cwd  | string | Target project directory |
| --json | bool   | JSON output              |

### `devteam log [options]`

Chronological event timeline: every gate and artifact write in mtime order. --follow tails at 1-second poll.

| Flag      | Type   | Description                           |
| --------- | ------ | ------------------------------------- |
| --cwd     | string | Target project directory              |
| --feature | string | Feature name (bounded isolation mode) |
| --json    | bool   | JSON output (one object per line)     |
| --follow  | bool   | Tail pipeline/ at 1s poll             |

### `devteam report [options]`

Generate a self-contained HTML report of the most recent pipeline run. Embeds status, per-stage timing, dispatch counts, blocker log, and all pipeline documents. Written to pipeline/report.html and opened in the default browser.

| Flag      | Type   | Description                                 |
| --------- | ------ | ------------------------------------------- |
| --cwd     | string | Target project directory (default: cwd)     |
| --out     | string | Output path (default: pipeline/report.html) |
| --feature | string | Feature name (for bounded-isolation runs)   |
| --json    | bool   | Print raw data as JSON; skip HTML           |
| --no-open | bool   | Write file but don't open browser           |

### `devteam performance critical-path [options]`

Reconstruct run critical path from run-log.jsonl: dispatch wall, workstream compute, retry delay, telemetry coverage, and verification reuse candidates.

| Flag      | Type   | Description                           |
| --------- | ------ | ------------------------------------- |
| --cwd     | string | Target project directory              |
| --feature | string | Feature name (bounded isolation mode) |
| --json    | bool   | JSON output                           |

### `devteam evidence <status|export|identity|accept-resolution> [options]`

Assess evidence-gated capabilities offline, export consented aggregates, manage project identity, or explicitly accept a successful fix/retry resolution.

| Flag      | Type   | Description                                        |
| --------- | ------ | -------------------------------------------------- |
| --cwd     | string | Target project directory                           |
| --feature | string | Feature name for bounded isolation                 |
| --json    | bool   | Emit stable aggregate JSON                         |
| --out     | string | New local export file                              |
| --consent | bool   | Acknowledge the documented export boundary         |
| --bundle  | list   | Validated bundle for portfolio status (repeatable) |
| --rotate  | bool   | Rotate the local project identity                  |
| --delete  | bool   | Delete the local project identity                  |
| --yes     | bool   | Confirm identity mutation or resolution acceptance |

### `devteam ui [options]`

Start a local web UI at http://127.0.0.1:3737/ showing pipeline state with live updates via SSE.

| Flag   | Type   | Description                       |
| ------ | ------ | --------------------------------- |
| --cwd  | string | Target project directory          |
| --port | number | Port to listen on (default: 3737) |
| --open | bool   | Open browser automatically        |

### `devteam memory <subcommand> [options]`

Persistent project memory. Subcommands: ingest, query, stats, clear, reindex, promote.

| Flag    | Type   | Description              |
| ------- | ------ | ------------------------ |
| --cwd   | string | Target project directory |
| --limit | string | Max results to return    |
| --kind  | string | Filter by artifact kind  |
| --org   | bool   | Target org-shared store  |
| --json  | bool   | JSON output              |

### `devteam patterns <collect|list|review|promote|retire|stats> [options]`

Project-local pattern learning. Collect sanitized observations, review candidates, promote advisory guidance, retire stale patterns, and inspect stats.

| Flag      | Type   | Description                        |
| --------- | ------ | ---------------------------------- |
| --cwd     | string | Target project directory           |
| --feature | string | Feature name for bounded isolation |
| --json    | bool   | Emit JSON output                   |
| --text    | string | Prompt text for promote            |
| --reason  | string | Retirement reason                  |

### `devteam corpus stats [options]`

Summarize the run corpus (.devteam/corpus/dispatches.jsonl): total dispatches, per-stage pass rates, per-(role, host) dispatch counts — the D5/H3 evidence-gate questions in docs/BACKLOG.md.

| Flag   | Type   | Description              |
| ------ | ------ | ------------------------ |
| --cwd  | string | Target project directory |
| --json | bool   | JSON output              |

### `devteam architecture <subcommand> [options]`

Query the org-shared store for prior ADRs and lessons learned. Principal consults this before designing.

| Flag    | Type   | Description                  |
| ------- | ------ | ---------------------------- |
| --cwd   | string | Target project directory     |
| --limit | string | Max results to return        |
| --kind  | string | Artifact kind (default: adr) |
| --json  | bool   | JSON output                  |

### `devteam reproduce <stage-id> [options]`

Report what was recorded for a stage (model version, temperature, seed, prompt hash) for replay.

| Flag   | Type   | Description              |
| ------ | ------ | ------------------------ |
| --cwd  | string | Target project directory |
| --json | bool   | JSON output              |

### `devteam verify <stage-id> [options]`

Orchestrator-stamped verification: run configured or auto-discovered Node, pytest, and Go suites, then rewrite gate fields with observed reality.

| Flag   | Type   | Description              |
| ------ | ------ | ------------------------ |
| --cwd  | string | Target project directory |
| --json | bool   | JSON output              |

### `devteam replay <stage-id> [options]`

Re-run a recorded stage with current config and diff the result against the original gate.

| Flag             | Type   | Description                                |
| ---------------- | ------ | ------------------------------------------ |
| --cwd            | string | Target project directory                   |
| --feature        | string | Feature name (bounded isolation mode)      |
| --json           | bool   | JSON output                                |
| --dry-run        | bool   | Print plan without invoking host           |
| --restore-backup | bool   | Restore leftover replay backup(s) and exit |

### `devteam ci <install|show> [options]`

Drop a CI workflow template into the target project (install), or print it to stdout (show).

| Flag    | Type   | Description                         |
| ------- | ------ | ----------------------------------- |
| --cwd   | string | Target project directory            |
| --ci    | string | CI system (default: github-actions) |
| --out   | string | Output directory for install        |
| --force | bool   | Overwrite existing workflow file    |

### `devteam spec <verify|generate> [options]`

Drift-check brief.md ↔ spec.feature ↔ test-report.md (verify), or scaffold a spec.feature from brief ACs (generate).

| Flag      | Type   | Description                     |
| --------- | ------ | ------------------------------- |
| --cwd     | string | Target project directory        |
| --strict  | bool   | Also fail on multi-mapped ACs   |
| --json    | bool   | JSON output                     |
| --force   | bool   | Overwrite existing spec.feature |
| --feature | string | Feature name for scaffold       |

### `devteam consistency analyze [options]`

Cross-artifact drift check: brief → spec → reviews → red-team → test-report → gate field reality.

| Flag     | Type   | Description              |
| -------- | ------ | ------------------------ |
| --cwd    | string | Target project directory |
| --strict | bool   | Stricter drift checks    |
| --json   | bool   | JSON output              |

### `devteam assess [options] [files...]`

Infer the best pipeline track for the current change from file paths, content, and description heuristics.

| Flag          | Type   | Description                                                                 |
| ------------- | ------ | --------------------------------------------------------------------------- |
| --cwd         | string | Target project directory                                                    |
| --description | string | Change description for heuristics                                           |
| --json        | bool   | JSON output                                                                 |
| --apply       | bool   | Write inferred track to .devteam/config.yml as custom_stages (project-wide) |
| --confirm     | bool   | Write pipeline/track.json with source:human (operator-confirmed)            |
| --no-content  | bool   | Skip file content scan                                                      |

### `devteam standards discover [options]`

Scan the project codebase and produce docs/project-conventions.md with detected tech stack, style, and tooling.

| Flag      | Type   | Description                                    |
| --------- | ------ | ---------------------------------------------- |
| --cwd     | string | Target project directory                       |
| --json    | bool   | JSON output                                    |
| --dry-run | bool   | Print report without writing                   |
| --force   | bool   | Overwrite existing docs/project-conventions.md |

### `devteam stages`

List known stage names.

### `devteam hosts`

List installed host adapters.

### `devteam help`

Show command list and quickstart.

<!-- /generated -->
