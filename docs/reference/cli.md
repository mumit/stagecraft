<!-- generated: do not hand-edit -->
<!-- To regenerate: npm run docs:generate (source: bin/devteam + core/cli/commands/*.js) -->

# CLI Reference

Full `devteam` command reference. 43 commands.
Derived from the global CLI surface in `bin/devteam` and per-command flag schemas in `core/cli/commands/`.
Run `npm run docs:generate` to regenerate after adding or changing flags.

## Global options

| Invocation | Description |
|---|---|
| `devteam --version` | Print the Stagecraft version from `package.json` and exit. |

All command flags are optional unless marked otherwise. `--help` is available on every command.

---

### `devteam chat ["question"] [options]`

Grounded, read-only conversation about current pipeline state and the safest next command. No question opens a TTY session; chat never executes its recommendation.

| Flag             | Type   | Description                                                    |
| ---------------- | ------ | -------------------------------------------------------------- |
| --cwd            | string | Target project directory                                       |
| --feature        | string | Feature description for bounded isolation lookup               |
| --host           | string | Headless host override (supports acp:<agent-command>)          |
| --model          | string | Model override for this conversation                           |
| --timeout-ms     | number | Per-turn host timeout in milliseconds                          |
| --json           | bool   | JSON output for a one-shot question                            |
| --dry-run        | bool   | Print the grounded prompt without calling a host               |
| --refine         | string | Propose a refinement: requirements | design | ruling           |
| --proposal       | string | Inspect, apply, or reject a proposal id                        |
| --apply          | bool   | Explicitly apply --proposal after rechecking hash/invalidation |
| --reject         | bool   | Reject --proposal without changing the artifact                |
| --list-proposals | bool   | List local artifact proposals and status                       |

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
| --trust-profile                  | string | Execution boundary: trusted or contained (fail-closed)                      |
| --patch                          | bool   | Scope build agents to patch items from a prior gate                         |
| --from                           | string | Stage to read patch items from (default: red-team)                          |
| --skip-completed                 | bool   | Skip workstreams whose gate file already exists                             |
| --workstream                     | list   | Dispatch only this workstream (repeatable)                                  |
| --scope                          | list   | Scope review to this path (repeatable; review-only track)                   |
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
| --scope            | list   | Scope review to this path (repeatable; review-only track)                                            |
| --until            | string | Stop after this stage (inclusive)                                                                    |
| --max-iterations   | number | Iteration cap                                                                                        |
| --budget-usd       | number | Cost cap in USD                                                                                      |
| --budget-tokens    | number | Observed/estimated token cap (not provider quota)                                                    |
| --timeout-ms       | number | Per-dispatch timeout (ms)                                                                            |
| --trust-profile    | string | Execution boundary: trusted or contained (fail-closed)                                               |
| --retry-delay-ms   | number | Backoff delay between transient retries (ms)                                                         |
| --auto-rule        | list   | Auto-apply Principal rulings of these classes (comma-separated)                                      |
| --allow-stage      | list   | Grant consequence-ceiling approval for this stage (repeatable, comma-separated)                      |
| --plan-only        | bool   | Materialize pipeline/run-plan.json and stop before the first dispatch                                |
| --resume           | bool   | Resume an interrupted run                                                                            |
| --force            | bool   | Force-unlock a stale run.lock or authorize a scoped stoplist bypass                                  |
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

| Flag       | Type   | Description                                                   |
| ---------- | ------ | ------------------------------------------------------------- |
| --cwd      | string | Target project directory                                      |
| --feature  | string | Feature name (bounded isolation mode)                         |
| --json     | bool   | JSON output (one object per line)                             |
| --follow   | bool   | Tail pipeline/ at 1s poll                                     |
| --timeline | bool   | Show durable queue/invoke/verification/retry/blocker timeline |

### `devteam report [options]`

Generate a self-contained HTML report of the most recent pipeline run. Embeds status, per-stage timing, dispatch counts, blocker log, and all pipeline documents. Written to pipeline/report.html and opened in the default browser. With --findings, generates a severity-ordered findings report instead, collected across every review artifact present (security-review, red-team, peer-review/critic, verification-beyond-tests, mutation, docs/audit/*.md) and labelled orchestrator-observed vs model-asserted — written to pipeline/findings-report.html.

| Flag       | Type   | Description                                                                                      |
| ---------- | ------ | ------------------------------------------------------------------------------------------------ |
| --cwd      | string | Target project directory (default: cwd)                                                          |
| --out      | string | Output path (default: pipeline/report.html, or pipeline/findings-report.html with --findings)    |
| --feature  | string | Feature name (for bounded-isolation runs)                                                        |
| --findings | bool   | Generate the severity-ordered findings report (Phase 35.4) instead of the pipeline status report |
| --json     | bool   | Print raw data as JSON; skip HTML                                                                |
| --no-open  | bool   | Write file but don't open browser                                                                |

### `devteam performance critical-path [options]`

Reconstruct run critical path from run-log.jsonl: dispatch wall, workstream compute, retry delay, telemetry coverage, and verification reuse candidates.

| Flag      | Type   | Description                                                |
| --------- | ------ | ---------------------------------------------------------- |
| --cwd     | string | Target project directory                                   |
| --feature | string | Feature name (bounded isolation mode)                      |
| --input   | list   | Additional local project root for calibration (repeatable) |
| --fit     | string | Track fit feedback: too-light, right, or too-heavy         |
| --reason  | string | Bounded fit reason code                                    |
| --json    | bool   | JSON output                                                |

### `devteam evidence <status|export|identity|accept-resolution|verify-attestation> [options]`

Assess evidence-gated capabilities offline, export consented aggregates or a per-run in-toto-shaped attestation, manage project identity, explicitly accept a successful fix/retry resolution, or offline-verify an attestation bundle.

| Flag               | Type   | Description                                                                     |
| ------------------ | ------ | ------------------------------------------------------------------------------- |
| --cwd              | string | Target project directory                                                        |
| --feature          | string | Feature name for bounded isolation                                              |
| --json             | bool   | Emit stable aggregate JSON                                                      |
| --out              | string | New local export file                                                           |
| --consent          | bool   | Acknowledge the documented export boundary                                      |
| --bundle           | list   | Validated bundle for portfolio status (repeatable)                              |
| --rotate           | bool   | Rotate the local project identity                                               |
| --delete           | bool   | Delete the local project identity                                               |
| --yes              | bool   | Confirm identity mutation, resolution acceptance, or ruling record              |
| --class            | string | Ruling class for record-ruling (lowercase-kebab, e.g. formatting-only)          |
| --stage            | string | Stage to accept a resolution for (default: the newest unaccepted one)           |
| --attestation      | bool   | Export an in-toto-shaped, per-stage attestation instead of the aggregate bundle |
| --track            | string | Override the pipeline track for --attestation chain verification                |
| --allow-unverified | bool   | Attest even when the gate chain is broken, stamping the bundle as unverified    |
| --sign             | bool   | Sign the --attestation bundle with cosign sign-blob (must be on PATH)           |

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

### `devteam patterns <collect|list|review|promote|retire|demote|export|stats> [options]`

Project-local pattern learning. Collect sanitized observations, review candidates (flagging recurrence-heavy patterns for demotion), promote advisory guidance, retire or demote patterns, export promoted patterns as an Agent Skills SKILL.md, and inspect stats.

| Flag       | Type   | Description                                                                                                        |
| ---------- | ------ | ------------------------------------------------------------------------------------------------------------------ |
| --cwd      | string | Target project directory                                                                                           |
| --feature  | string | Feature name for bounded isolation                                                                                 |
| --json     | bool   | Emit JSON output                                                                                                   |
| --text     | string | Prompt text for promote                                                                                            |
| --reason   | string | Retirement or demotion reason                                                                                      |
| --operator | string | Override the recorded demote operator (default: OS user)                                                           |
| --skill    | bool   | Export format for `export`: Agent Skills SKILL.md (currently the only supported format)                            |
| --out      | string | Parent directory for `export --skill` (default: .devteam/); the skill itself is written to <out>/learned-patterns/ |

### `devteam corpus stats [options]`

Summarize the run corpus (.devteam/corpus/dispatches.jsonl): total dispatches, per-stage pass rates, per-(role, host) dispatch counts — the D5/H3 evidence-gate questions in docs/BACKLOG.md.

| Flag   | Type   | Description              |
| ------ | ------ | ------------------------ |
| --cwd  | string | Target project directory |
| --json | bool   | JSON output              |

### `devteam evals <gc|run|compare> [options]`

Eval flywheel. `gc` removes .devteam/evals/blobs/ entries no captured case's inputs/manifest.json references (cases are captured automatically on gate FAIL/ESCALATE and stamp overrides, plans/phase-33-eval-flywheel.md item 33.1). `run` replays captured cases against the CURRENT framework — --stub (default) scores structurally, free; --headless-host <h> dispatches for real and flags a resolved case that fails again as a regression (item 33.2). `compare --pack <A> --pack <B>` reports per-stage pass-rate deltas between two prompt_pack_version values from the run corpus, refusing a stage below --min-n dispatches on either pack (item 33.3).

| Flag            | Type   | Description                                                                |
| --------------- | ------ | -------------------------------------------------------------------------- |
| --cwd           | string | Target project directory                                                   |
| --stub          | bool   | run: structural-only replay (default; free, no model)                      |
| --headless-host | string | run: dispatch for real against this host's headless machinery              |
| --filter        | string | run: only replay cases matching this stage id or case id                   |
| --budget-usd    | number | run: required cost cap before a --headless-host sweep                      |
| --pack          | list   | compare: prompt_pack_version to compare — pass twice (--pack A --pack B)   |
| --min-n         | number | compare: minimum dispatches required per cell before comparing (default 5) |
| --json          | bool   | JSON output (run: JSONL, one line per case)                                |

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

Orchestrator-stamped verification: run configured or auto-discovered Node, pytest, and Go suites, rewrite gate fields with observed reality, then repair the active run's gate chain. Signed history requires DEVTEAM_SIGNING_SECRET.

| Flag    | Type   | Description                        |
| ------- | ------ | ---------------------------------- |
| --cwd   | string | Target project directory           |
| --track | string | Override the active pipeline track |
| --json  | bool   | JSON output                        |

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

| Flag      | Type   | Description                                                   |
| --------- | ------ | ------------------------------------------------------------- |
| --cwd     | string | Target project directory                                      |
| --strict  | bool   | Also fail on multi-mapped criteria                            |
| --track   | string | Track to verify against (default: the project's active track) |
| --json    | bool   | JSON output                                                   |
| --force   | bool   | Overwrite existing spec.feature                               |
| --feature | string | Feature name for scaffold                                     |

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
| --feature     | string | Change description for heuristics                                           |
| --description | string | Alias for --feature                                                         |
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

### `devteam review-pr <number|url> [options]`

Materialize an inbound GitHub PR (diff, changed files, title/body) into pipeline/review-input/ and dispatch stage-05 against it: a single reviewer in panel mode, reviewer then critic when review.mode: adversarial. Local-only by default; --post publishes the review as a PR comment after printing the exact payload and requiring interactive confirmation (or --yes in a non-interactive context) — refuses outright on a partial/incomplete review. Requires the gh CLI, authenticated (plans/phase-35-existing-codebase-mode.md item 35.2).

| Flag        | Type   | Description                                                                                                           |
| ----------- | ------ | --------------------------------------------------------------------------------------------------------------------- |
| --cwd       | string | Target project directory                                                                                              |
| --post      | bool   | Publish the review as a PR comment (opt-in; see --yes)                                                                |
| --yes       | bool   | Auto-confirm --post; required in a non-interactive context                                                            |
| --workspace | string | Override the derived ~/.stagecraft/reviews/<slug> workspace path (only used when --cwd is not an initialised project) |
| --json      | bool   | JSON output                                                                                                           |

### `devteam review <path> [options]`

Zero-install external review: no init, no config, nothing written to <path>. Creates (or reuses) a review workspace under ~/.stagecraft/reviews/<slug>/ and dispatches the track there with ctx.processCwd=<path>, ctx.cwd=<workspace>. Only --host acp mechanically prevents writes to <path> (hosts/acp/permissions.js); any other host prints a warning and refuses without --allow-unenforced-writes. Prints the 35.4 findings report path on completion. --list shows existing workspaces: subject path, last run date, last status.

| Flag                      | Type   | Description                                                                                                                                                                                                           |
| ------------------------- | ------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| --scope                   | list   | Scope the review to this path within the subject (repeatable; review-only track)                                                                                                                                      |
| --track                   | string | Pipeline track to dispatch (default: review-only)                                                                                                                                                                     |
| --host                    | string | Dispatch host (default: acp — the only host that mechanically prevents writes to the subject)                                                                                                                         |
| --workspace               | string | Override the derived ~/.stagecraft/reviews/<slug> workspace path                                                                                                                                                      |
| --allow-unenforced-writes | bool   | Required with --host anything other than acp: acknowledges that writes to the subject are not mechanically prevented                                                                                                  |
| --timeout-ms              | number | Per-dispatch timeout (ms) — default 10 minutes (core/adapters/headless.js's DEFAULT_TIMEOUT_MS); 0 disables it. A thorough adversarial/security-review stage over a large diff can legitimately run past the default. |
| --json                    | bool   | JSON output                                                                                                                                                                                                           |
| --open                    | bool   | Open the findings report in a browser when the run finishes                                                                                                                                                           |
| --list                    | bool   | List existing review workspaces instead of running a review                                                                                                                                                           |

### `devteam stages`

List known stage names.

### `devteam hosts`

List installed host adapters.

### `devteam help`

Show command list and quickstart.

| Flag  | Type | Description                                                 |
| ----- | ---- | ----------------------------------------------------------- |
| --all | bool | Show the full command reference (every command, every flag) |

<!-- /generated -->
