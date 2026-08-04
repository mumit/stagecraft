"use strict";

const name = "help";
const flags = {};

function run() {
  console.log(`devteam — model-agnostic AI dev team orchestrator

Usage: devteam <command> [args]

Commands:
  init --host <list> [--force]     Install host adapter(s) into the current
       [--adapter <name>]           project. <list> is comma-separated, e.g.
       [--profile dogfood]          "claude-code" or "claude-code,codex".
                                   Writes .devteam/config.yml and creates
                                   pipeline/gates/ workspace. --adapter sets
                                   the stage-08 deploy target (gizmos,
                                   cloud-run, docker-compose, kubernetes,
                                   terraform, custom) so you don't need to
                                   hand-edit config.yml. --profile dogfood
                                   installs four dogfooding safeguards: a
                                   supplemental .gitignore block, a pre-commit
                                   infrastructure guard, a .git/info/exclude
                                   entry for deploy.md, and a profile: dogfood
                                   config marker. See docs/guides/dogfooding.md.
  stage <name> [--feature "..."]   Render stage prompt(s) for <name>. With
        [--feature-file <path>]       --feature-file reads the feature brief
                                   from a UTF-8 text file.
        [--headless]                 With --headless, drives each workstream's
        [--timeout-ms N]             host CLI non-interactively (claude --print,
        [--patch [--from <stage>]]   codex workspace-write mode) and reports
        [--skip-completed]           exit codes + gate paths. --timeout-ms caps each
        [--workstream <role>]        workstream's wall-clock (default 600000,
                                   i.e. 10 min); pass 0 to disable.
                                   --patch scopes build agents to the patch
                                   items from the named stage's gate (reads
                                   must_address_before_peer_review, falling
                                   back to blockers[]); default: red-team.
                                   --skip-completed skips dispatching any
                                   workstream whose gate file already exists.
                                   --workstream <role> dispatches only the
                                   named role; repeat for multiple. All other
                                   workstreams are left untouched (their
                                   existing gate files are preserved).
  next [--json]                    Inspect pipeline/gates/ and report what
                                   to do next: run a stage, continue a
                                   partial multi-role stage, merge, fix a
                                   FAIL, resolve an ESCALATE, or done.
  run [--feature "..."]            Bounded autonomous driver: loop next →
      [--feature-file <path>]       dispatch → merge until pipeline-complete.
                                   --feature-file reads the feature brief
      [--repair "symptom"]          from a UTF-8 text file. --feature for
      [--repair-at <file:line>]     additive work; --repair for
      [--track <t>] [--until <s>]  bug fixes (ADR-009, hotfix depth default;
      [--max-iterations N]          diagnosis stage + PATCH-MODE-scoped build
      [--budget-usd X]              + failing-first reproduction). --repair-at
      [--timeout-ms N]              skips diagnosis, seeds affected-files.
      [--retry-delay-ms N]          Auto-fixes code-defect FAILs and retries
      [--auto-rule <classes>]       transient failures. With --auto-rule,
      [--allow-stage <s>]           auto-applies Principal rulings whose
                                   [class:] is in the granted allowlist.
      [--resume] [--force] [--json] Halts for a human on escalations, the
      [--fail-on-advisory[=all]]    consequence ceiling (sign-off / deploy),
      [--auto-commit]               a budget cap, or a structural failure.
      [--watch]                    --watch renders rolling liveness on a TTY
                                   and falls back to line output when redirected.
                                   --fail-on-advisory exits 3 when advisory
                                   blockers remain (=all adds PEER_REVIEW_RISK).
                                   --auto-commit commits pipeline artifacts on
                                   a clean halt (ceiling, --until, budget).
                                   Writes run.lock, run-state.json, run-log.
  prototype <start|build|note|promote>
                                   Pre-SDLC fast-learning workflow. start
       [id-or-title] [--feature]    creates pipeline/prototypes/<id>/ with
       [--feedback] [--track]       intent, build prompt, feedback, promotion
       [--host] [--apply-to-project] handoff, and metadata. build runs the
                                   prompt through a headless host in a packet
                                   workspace unless --apply-to-project is set.
                                   note appends demo feedback. promote writes
                                   the hardening command for a normal track.
                                   Prototype packets are not gate evidence.
  commit [--all]                   Commit pipeline artifacts after a clean
         [--dry-run]                pipeline stage. Stages only gate-bearing
         [--message "..."]          files for completed stages (cursor-aware);
         [--json] [--cwd <dir>]     --all stages all completed stages regardless
                                   of cursor. --dry-run prints without committing.
                                   Used automatically by --auto-commit.
  compact [--dry-run]              Remove all devteam-managed marker sections
          [--json] [--cwd <dir>]   from pipeline/context.md. These sections
                                   (run-blockers, red-team-blockers, deploy-
                                   target, etc.) are regenerated by devteam on
                                   the next run when still needed. Use to prune
                                   context.md after a long pipeline run or
                                   before switching to bounded isolation.
                                   --dry-run shows what would be removed.
  hook <name>                      Dispatch a framework hook script by name.
                                   Names: validate, secret-scan, approval-
                                   derivation. Used by .claude/settings.local.json
                                   hooks; resolves script paths at runtime so
                                   the file is portable across machines.
  validate                         Validate the most recent gate in
                                   pipeline/gates/. Exit codes: 0 PASS/WARN,
                                   1 malformed, 2 FAIL, 3 ESCALATE. Used
                                   by host hooks (e.g. Claude Code Stop).
  verify-chain [--track <t>]       C6: verify predecessor hashes and optional
       [--require-signed] [--json]  HMAC authentication. Reports breaks,
                                   invalid MACs, and unsigned gates. Exit 0
                                   intact, 1 failed (CI-usable).
  stamp-chain [--track <t>]        C6: (re)stamp the chain on all stage gates,
                                   in order. Use after a deliberate earlier-
                                   stage re-run, or to stamp interactive gates.
  merge <stage>                    Merge per-workstream gates into stage gate.
  preflight [--cwd <dir>]          Run mechanical pre-peer-review checks
       [--skip-write]               (stage-04e): committed-but-ignored files,
                                   broken test import paths, and deferred red-team
                                   item count. Writes pipeline/gates/stage-04e.json.
                                   Exits 1 on FAIL. Also runs automatically when
                                   'devteam stage peer-review' is invoked (unless
                                   stage-04e.json already exists and is PASS).
  derive-approvals [<file>]        Re-run the approval-derivation hook on
        [--cwd <dir>] [--json]      pipeline/code-review/by-*.md and rewrite the
                                   per-area stage-05.<area>.json gates. Use after
                                   hand-editing a review file outside an active
                                   Claude Code session (the hook only fires on
                                   agent saves; shell/editor saves bypass it).
                                   Without an argument, derives every by-*.md
                                   under pipeline/code-review/. Follow with
                                   'devteam merge peer-review' to rebuild the
                                   merged stage-05.json. See docs/runbooks/
                                   fix-and-retry.md § Case 5.
  restart <stage> [--cascade]      Clear a stage's gate(s) so the pipeline can
       [--keep-context]            re-run it. With --cascade, also clears every
       [--dry-run]                 stage that comes after this one in the active
                                   track. By default also strips that stage's
                                   injected blocker sections from pipeline/
                                   context.md (--keep-context to preserve them).
                                   Use after an ESCALATE or FAIL to re-run from
                                   a specific point.
  ruling [--topic "..."]           Dispatch the Principal subagent for an ad-hoc
       [--context paths]           ruling. --topic is optional: when omitted the
       [--target-gate path]        topic is auto-derived from the escalating gate's
       [--headless]                escalation_reason + decision_needed. The ruling
                                   lands in pipeline/context.md as a PRINCIPAL-RULING
                                   line; no gate is written.
                                   See docs/runbooks/escalation.md.
  fix-escalation                   Implement the Principal ruling written by
       [--headless]                devteam ruling. Dispatches an applicator agent
                                   that reads PRINCIPAL-RULING entries from
                                   pipeline/context.md and fixes gates, runs stages,
                                   and merges — so devteam next advances. No
                                   hand-editing required.
  advise [--apply <selections>]    Triage noted_for_followup[] items across all
         [--feature "..."]          completed gates. Classifies each as
         [--json] [--cwd <dir>]     QA_BLOCKER, PEER_REVIEW_RISK, QA_NOISE, or
         [--timeout-ms N]           INFO. --apply writes selections to
                                   pipeline/context.md (format: AC-11=A,AC-12=B
                                   or AC-11=A:TICKET-123). Runs automatically at
                                   pipeline-complete when items are present.
  status [--json]                  Liveness report (ADR-007 Tier 1): reads
                                   run-state.json + run-log.jsonl tail and
                                   reports status / current_stage /
                                   last_action / iterations / cost_usd /
                                   last_heartbeat_age_ms / last_event_age_ms /
                                   stall_detected. Read-only; no --watch.
  performance critical-path        Reconstruct run critical path from
       [--feature "..."] [--json]  run-log.jsonl: dispatch wall time,
                                   workstream compute, parallel savings,
                                   retry delay, telemetry coverage, and
                                   repeated verification-command candidates.
  evidence status [--json]         Read-only evidence readiness for #142-#145.
       [--feature <name>]          Aggregates bounded run logs, current gates,
                                   and gate archives; reports local threshold
                                   progress separately from cross-project
                                   conditions. Repeated --bundle files run
                                   validated, de-duplicated portfolio analysis.
  evidence export --out <file>     Write a local aggregate-only bundle. Requires
       --consent                   explicit consent and a new destination; never
                                   uploads or overwrites evidence.
  evidence accept-resolution --yes Record explicit human acceptance of the latest
       [--feature <name>]          successful fix/retry in the bounded pipeline.
  evidence identity               Inspect the pseudonymous project reference.
       [--rotate|--delete] --yes   Rotation/deletion require confirmation; raw
                                   identity entropy is never printed.
  summary [--json]                 One-screen pipeline state report.
  log [--follow] [--json]          Chronological event timeline: every gate
                                   and every artifact write, in mtime order,
                                   with key fields per stage. --follow tails
                                   the pipeline/ directory at 1s poll. Works
                                   in both headless and user-driven modes.
  report [--out <file>]            Post-run HTML report. Embeds the full
       [--no-open] [--json]        pipeline story — status badge, progress bar,
       [--feature "..."]           per-stage timing and dispatch counts, blocker
                                   log, and all pipeline documents (brief, spec,
                                   design, reviews, test report, ADRs). Written
                                   to pipeline/report.html and opened in the
                                   default browser. --json emits the raw
                                   collected data without generating HTML.
  doctor                           Pre-flight check: install integrity,
                                   target layout, config validity, adapter
                                   status, host CLIs on PATH.
  ui [--port N] [--open]           Start a local web UI on http://127.0.0.1:3737/
                                   showing pipeline state, gate detail, live
                                   updates via SSE. --open launches the browser.
  memory <subcommand>              Persistent project memory.
    ingest                         Index pipeline/* artifacts (brief,
                                   design-spec, ADRs, retro, etc.) via
                                   semantic embeddings into .devteam/memory/.
    query "text" [--limit N]       Semantic search. Add --org to query
       [--kind <k>] [--org]        the org-shared store at
                                   ~/.stagecraft/memory/.
    stats [--org]                  What's indexed (project or org).
    clear [--org]                  Wipe per-project (or org) store.
    reindex                        Re-embed everything (after embedder change).
                                   Local embedder by default; ~150MB model
                                   downloaded once on first ingest.
    promote [<kinds...>]           Copy this project's records to the
                                   org-shared store. Default kinds:
                                   adr + lessons-learned. Architectural
                                   continuity reads from there.
  patterns <subcommand>            Project-local pattern learning.
    collect                        Harvest sanitized blockers, warnings,
                                   follow-ups, and retry outcomes into
                                   .devteam/patterns/observations.jsonl.
    list | review                  Show grouped candidates and promoted
                                   patterns. Candidates are not injected.
    promote <candidate>            Promote reviewed guidance into future
       [--text "..."]              coding-agent prompts.
    retire <pattern>               Stop injecting a promoted pattern.
    stats                          Show observation, promotion, injection,
                                   recurrence, and noise counters.
  architecture lookup "<topic>"    Query the org-shared store for
       [--limit N] [--kind adr|    prior ADRs (or lessons) on a topic.
        lessons-learned]            Principal consults this before designing
                                   so prior commitments are honored or
                                   explicitly superseded — architecture
                                   doesn't drift because the architect remembers.
  reproduce <stage-id> [--json]    Read pipeline/gates/<stage-id>.json
                                   and report what was recorded for replay
                                   (model_version, temperature, seed, prompt
                                   hash, tools hash). Re-renders the current
                                   prompt and compares hashes to surface drift.
  verify <stage-id> [--json]       Orchestrator-stamped verification. For
                                   stage-04a (lint+tests) and stage-06 (tests
                                   + AC mapping), runs the configured commands
                                   and rewrites the gate fields with what was
                                   actually observed. stage-04c (red-team) runs
                                   a mechanical floor instead — dependency
                                   audit, secret-scan, semgrep (if configured),
                                   and a lockfile delta — merging into
                                   findings_count / must_address_before_peer_review.
                                   Flips status to FAIL if
                                   the orchestrator's truth disagrees with the
                                   model's claim. Commands resolve from
                                   .devteam/config.yml pipeline.verify.* or
                                   auto-discovered Node, pytest, and Go suites.
  replay <stage-id> [--dry-run]    Re-run a recorded stage with CURRENT
       [--json]                     config and diff the result. Writes the
                                   new gate to pipeline/gates/replay/<stage>.
                                   <timestamp>.json. --dry-run prints the
                                   plan + drift check without invoking the
                                   host.
  ci install [--ci <type>]         Drop a CI workflow template into
       [--out <dir>] [--force]      the target project. Currently supports
                                   --ci github-actions (the default). The
                                   workflow validates pipeline/gates/ + posts
                                   each gate as a GitHub check run on PRs.
                                   It does NOT run the pipeline itself in CI.
  ci show [--ci <type>]            Print the workflow template to stdout.
  spec verify [--strict] [--json]  Drift-check brief.md ↔ spec.feature ↔
                                   test-report.md. Exits non-zero if any AC
                                   in brief lacks a scenario, any scenario
                                   lacks an AC tag, or any test references
                                   an unknown AC. --strict also fails when
                                   one AC is mapped by multiple scenarios.
  spec generate [--feature "..."]  Scaffold pipeline/spec.feature from the
       [--force]                   brief's numbered AC-N entries — one
                                   tagged Scenario per AC. Refuses to
                                   overwrite without --force.
  consistency analyze              Cross-artifact drift across the full
       [--strict] [--json]         pipeline chain: brief -> spec ->
                                   pr-*.md ## Verify -> red-team
                                   must-address -> test-report -> gate
                                   field reality. Generalizes 'spec
                                   verify' to every intermediate
                                   artifact + the gate-vs-reality
                                   dimension. Exits non-zero on drift.
  assess [--description "..."]    Infer the best track for the
       [--json] [--apply]          current change. Reads pipeline/
       [--cwd <dir>] [files...]    changed-files.txt (or explicit file
                                   list) and applies path/content/
                                   description heuristics to recommend
                                   a track. --apply writes the result
                                   to pipeline.custom_stages in
                                   .devteam/config.yml so subsequent
                                   'devteam next' and 'devteam stage'
                                   use the inferred stage list.
  standards discover               Scan the project codebase and
       [--cwd <dir>] [--json]      produce docs/project-conventions.md
       [--dry-run] [--force]       with detected tech stack, module
                                   system, file layout, naming style,
                                   tooling, test config, and common
                                   import paths. --dry-run prints
                                   without writing. --json emits the
                                   structured discovery result.
  review-pr <number|url>           Materialize an inbound GitHub PR (diff,
       [--post] [--yes] [--json]    changed files, title/body) into
                                   pipeline/review-input/ and dispatch
                                   stage-05 against it: a single reviewer
                                   in panel mode, reviewer then critic when
                                   review.mode: adversarial. Local-only by
                                   default. --post publishes the review as
                                   a PR comment: prints the exact payload
                                   and requires interactive confirmation;
                                   refuses in a non-interactive context
                                   without --yes; refuses outright on a
                                   partial/incomplete review. Requires
                                   the gh CLI, authenticated.
  review <path> [--scope <p>]      Zero-install external review: no init, no
       [--track review-only]        config, nothing written to <path>. Creates
       [--host acp] [--workspace]   (or reuses) a review workspace under
       [--json] [--open]            ~/.stagecraft/reviews/<slug>/ and dispatches
                                   the track there with ctx.processCwd=<path>,
                                   ctx.cwd=<workspace>. Only --host acp
                                   mechanically prevents writes to <path>
                                   (hosts/acp/permissions.js); any other host
                                   prints a warning and refuses without
                                   --allow-unenforced-writes. Prints the 35.4
                                   findings report path on completion.
  review --list [--json]          Show existing review workspaces: subject
                                   path, last run date, last status.
  stages                           List known stage names.
  hosts                            List available host adapters.
  help                             Show this message.

Quickstart:
  1. cd into your target project (NOT the Stagecraft repo).
  2. devteam init --host claude-code         # lays down rules, roles, hooks
  3. devteam doctor                          # verify install
  4. devteam stage requirements --feature "your feature description"
       — by default, this RENDERS the prompt; you feed it to your model.
       — inside Claude Code, use /devteam stage <name> instead.
       — to drive the host CLI automatically: add --headless.
  5. After the model writes the gate JSON: devteam next  → tells you
     what to do next (advance, fix, merge, escalate, or done).

devteam never calls a model itself. Adapters under hosts/ are where the
host-specific glue lives; the orchestrator just renders prompts and
validates the gate JSON that comes back.
`);
}

module.exports = { name, flags, run };
