# Runbook: Autonomous run (`devteam run`)

`devteam run` is the bounded autonomous driver (ADR-003). It loops
`next → dispatch → merge` until the pipeline completes, and **halts cleanly the
moment something needs a human**. The loop is deterministic code; the only LLMs
involved are the workstream agents it dispatches.

**Scope (today, Phase 1 + Phase 2 PR-C2):** the driver advances the happy path,
**auto-fixes `code-defect` failures** (clears the failing gate, writes the
blockers into `pipeline/context.md`, and re-dispatches — bounded by a retry
ceiling), **retries transient dispatch failures** with backoff, and — only when
you pass `--auto-rule` — **auto-resolves escalations whose ruling class you
pre-authorized**. It still halts for a human on un-granted escalations,
cannot-decide, `state-corruption`/`external-blocked`, the consequence ceiling, a
budget cap, and structural dispatch failures.

## Autonomous escalation resolution (`--auto-rule`)

By default the driver **halts on every escalation** — it doesn't even dispatch
the Principal. Opt in per-run with an allowlist of bounded ruling classes:

```bash
devteam run --auto-rule formatting-only,doc-only
```

When an escalation arises, the driver dispatches the Principal (`devteam ruling`)
and reads its newest output:

- **`PRINCIPAL-RULING: … [class: X]`** where **X is in your allowlist** → applies
  it (`devteam fix-escalation`), records `auto-ruled` (with the grant class,
  the ruling, and `authority: auto-rule:X`) to `run-log.jsonl`, and resumes.
- **ruling class not granted, or `unclassified`** → halt for a human.
- **`PRINCIPAL-CANNOT-DECIDE: <authority|information|value>`** → halt and surface
  the typed question. Never auto-resolved.

**Hard stops `--auto-rule` can never cross** (halt even with a matching grant):
the consequence ceiling (`sign-off`/`deploy`), and `convergence-exhausted`. And
the driver auto-rules a given escalation **at most once** — if it re-escalates,
it halts. The grant is **CLI-only and per-run** (nothing persists in the repo),
and is an **allowlist only** (no wildcard).

### Choosing which classes to pass

There is no fixed enumeration of valid classes. The class slug is whatever the
Principal writes in its `[class: <slug>]` suffix — it varies by project and
ruling content. To discover what classes a run will actually emit, **do a dry
run without `--auto-rule`**: the driver halts at each escalation, and
`pipeline/run-log.jsonl` records the `grant_class` the Principal used. Review
those entries, decide which categories you are comfortable approving
autonomously, and re-run with `--auto-rule` set to exactly those slugs.

Common classes the Principal emits (from its own examples):

| Class | Typical ruling content |
|---|---|
| `formatting-only` | Whitespace, naming style, no semantic change |
| `doc-only` | Comment or documentation update only |
| `known-safe-dependency-bump` | Version bump with no breaking API change |
| `scope-cut` | Removing a deliverable from scope |
| `security-tradeoff` | Accepting a documented security constraint |
| `diagnosis-approved` | Special: auto-approves the repair-mode diagnosis gate (see [§ Repair mode](#repair-mode-devteam-run---repair-adr-009)) |

The Principal's prompt instructs it to pick the **narrowest honest class** and
never inflate a class to match a suspected grant. `unclassified` is the
fallback when the ruling doesn't fit a narrow category — it is never
auto-applied regardless of what you pass.

---

## Pre-run checklist

Before `devteam run` on an autonomous or CI pipeline:

1. **Describe the work** — pass `--feature` or `--feature-file`; this gives inline assessment and right-sizing a concrete signal.
2. **Review the inferred track when risk warrants it** — `devteam run` assesses and writes `pipeline/track.json` automatically when no track decision exists. Use `devteam assess --confirm` or explicit `--track <name>` when you want a human-confirmed choice. Supplying `pipeline/changed-files.txt` or file arguments to `devteam assess` improves file-based inference but is optional.
3. **Verify the stoplist** — if your change description mentions auth, PII, payments, or migrations, use `full` track; lighter tracks will be blocked anyway.

```bash
devteam run --feature "add sorting to the results page"  # assesses inline; generic work defaults to loop
devteam assess --description "fix login validation bug" --confirm  # optional human-confirmed track
devteam run --feature "fix login validation bug" --track full       # explicit safety override
```

## Launch

```bash
devteam run                       # drive the configured track to completion
devteam run --watch               # rolling liveness block on an interactive terminal
devteam run --json                # structured summary on stdout (for tooling)
devteam run --until peer-review   # stop after a specific stage
devteam run --budget-usd 10       # stop before a dispatch once spend ≥ $10
devteam run --budget-tokens 5000000  # provider-neutral observed/estimated token cap
devteam run --allow-stage sign-off --allow-stage deploy   # grant the ceiling
devteam run --resume              # continue after a crash/stop
devteam run --force               # override a stale lock

# Repair mode (ADR-009) — bug-fix intent, not a feature:
devteam run --repair "symptom"                                 # hotfix depth default; diagnosis stage runs first
devteam run --repair "symptom" --track full                    # full pipeline with repair behavior
devteam run --repair "symptom" --auto-rule diagnosis-approved  # auto-approve the diagnosis gate
devteam run --repair "symptom" --repair-at src/auth.js:42      # skip diagnosis; seed affected-files directly
```

`--repair` and `--feature` are mutually exclusive. See [§ Repair mode](#repair-mode-devteam-run---repair-adr-009) below and [`docs/runbooks/repair-flow.md`](repair-flow.md) for the diagnosis gate, scope-gate FAIL recovery, and tri-state reproduction.

At startup, non-JSON runs print a plan preview to **stderr** with the effective track,
included/total stages, configured skips, conditional stages, track-sized workstream
counts, and the plan fingerprint. The complete pre-dispatch contract is written to
`pipeline/run-plan.json`: stage order/disposition, candidate roles, resolved hosts and
models, track provenance, and ceremony preview. The same data is recorded as a typed
`run-plan` event in `run-log.jsonl`. A resumed run refuses changed stage or routing
decisions; restart without `--resume` after reviewing the new plan. Conditional stages
remain labelled conditional because their upstream gate does not exist at preflight.

Progress prints to **stderr**; the `--json` summary prints to **stdout**. `--watch`
and `--json` are mutually exclusive. When watch output is redirected or stderr is
not a TTY, Stagecraft prints a warning and uses the existing line-per-event format
without ANSI control sequences.

### Launching in the Docker runner

For unattended local or worker-machine runs, build the runner from the
Stagecraft repo and execute it against a mounted target project:

```bash
docker build -f hosts/docker/Dockerfile -t stagecraft-runner:local .

cd /path/to/target-project
docker run --rm \
  --user "$(id -u):$(id -g)" \
  -v "$PWD:/workspace" \
  --env-file .devteam/docker.env \
  stagecraft-runner:local run --cwd /workspace --budget-usd 10
```

The container runs the same `devteam run` loop documented here. It does not
change gate semantics, exit codes, or the consequence ceiling. It keeps
credentials runtime-only, reports existing `pipeline/run.lock` files, and
removes a stale lock only when `STAGECRAFT_RUNNER_CLEAR_STALE_LOCK=1` is set.
See [`hosts/docker/README.md`](../../hosts/docker/README.md) for UID/GID build
args, secret handling, and resource limits.

## What it writes

| File | Purpose |
|---|---|
| `pipeline/run.lock` | Exclusive lock for the run (pid + host + start time). Removed on exit. |
| `pipeline/run-state.json` | Resumable state: current stage, iteration count, per-stage retry counts. |
| `pipeline/run-log.jsonl` | One line per transition (stage, action, `failure_class`, outcome, duration, cost) — the audit + debug trail. |
| `pipeline/gates/archive/<stage>.attempt-N.json` | A snapshot of each failed attempt's stage gate, taken before the auto-fix retry clears/overwrites it. Diff `attempt-1` vs `attempt-2` to see whether blockers were shrinking or stuck — the post-mortem record of a `code-defect` retry sequence. `devteam restart` clears the archive directory; a normal stage re-run does not. |

## Exit codes

| Code | Meaning |
|---|---|
| `0` | `pipeline-complete`, or a clean configured stop (`--until` boundary, or the consequence ceiling — a gate you must approve). |
| `1` | Halted on something that needs fixing (FAIL, escalation, no-progress, merge failure, budget cap, max iterations). |
| `2` | Could not acquire the lock (another run is active). |
| `3` | Pipeline complete **and** `--fail-on-advisory` is set **and** at least one unaddressed blocker-class item (QA_BLOCKER or A11Y_FIX by default; +PEER_REVIEW_RISK with `=all`) remains. |

Use exit 3 in CI to enforce a stricter merge gate. The default (no flag) keeps the exit-0 contract so `if devteam run; then merge` pipelines are unaffected. See [lenient vs strict CI patterns](../ci.md#lenient-vs-strict-advisory-gate).

## Why it halted — and what to do

Read the `halt_action` (and `failure_class`) in the summary, or the last line of
`run-log.jsonl`:

| `halt_action` | What happened | Do this |
|---|---|---|
| `unconfirmed-track` | `autonomy.require_confirmed_track` is set and `pipeline/track.json` carries an inferred track at medium or low confidence. | Run `devteam assess --confirm` to write `source:"human"`, or pass `--track <name>` explicitly. `--force` bypasses in an emergency. |
| `stoplist` | The change description or `pipeline/brief.md` matched a safety-stoplist phrase (auth/credentials/PII/payments/migrations/…) and the resolved track is lighter than `full`. Checked at run start and again before build. | Switch to `devteam run --track full`. If this is a false positive, re-run with `--force`. |
| `fix-and-retry` | A FAIL the driver won't auto-retry: `state-corruption` (gate unreadable) or `external-blocked` (needs a human/external action). | Run `devteam next` and follow [fix-and-retry.md](fix-and-retry.md). |
| `resolve-escalation` | A gate escalated (`judgment-gate`), the retry budget was spent on a `code-defect` (`convergence-exhausted`), or an escalation's ruling class wasn't in your `--auto-rule` grant. | Follow [escalation.md](escalation.md), then re-run `devteam run`. |
| `resolve-escalation` (`cannot-decide`) | The Principal declared it cannot decide — the run summary carries `cannot_decide.{reason_class, question}`. | Supply the missing authority/information/ranking, encode a `PRINCIPAL-RULING:` line, then re-run. |
| `ceiling` | The next stage is `sign-off` or `deploy` — irreversible/outward-facing. | Review, then re-run with `--allow-stage <name>` to grant it. |
| `budget` | Cumulative `cost_usd` reached `--budget-usd`, or trusted token usage reached `--budget-tokens`. Token accounting accepts orchestrator-observed counts and explicitly flagged prompt-byte estimates, includes every retry through the append-only dispatch corpus, and ignores model-authored token claims. | Raise the applicable cap or stop. Both caps prevent the *next* dispatch, so either can overshoot by one dispatch. A token cap is local accounting, not a prediction of a provider subscription quota. |
| `until` | Reached the `--until` boundary. | Expected stop — nothing to do. |
| `structural-input` | A stage was dispatched but wrote no gate, and it isn't transient (clean exit with no output, or repeated failure after the transient budget). | Retrying won't help — inspect `pipeline/logs/<workstream>.log` (context overflow, persistent auth/config error). |
| `merge-failed` | A workstream gate was missing or malformed at merge. | Read the reason; fix or re-run the missing workstream. |
| `max-iterations` | The loop hit its guard (`--max-iterations`, default 100). | Almost always a stuck stage — inspect `run-log.jsonl`. |
| `scope-gate` | The build wrote files outside the diagnosed `affected_files` list (ADR-009 structural scope gate). | See [repair-flow.md § Scope-gate FAIL recovery](repair-flow.md#scope-gate-fail-recovery). |

**Non-halt events** you'll see in progress output / `run-log.jsonl` as the driver works autonomously: `skip-stage` (configured or conditional skip with trigger inputs; override with `pipeline.force_stages`), `fix-retry` (cleared the failing gate + re-dispatching a `code-defect`, up to `autonomy.max_retries`, default 2), `workstream-queued` (a ready workstream is waiting behind `routing.host_concurrency`), `transient-retry` (a no-gate dispatch is being retried after backoff, with `retry_reason` and `backoff_class`, up to once before it's deemed structural), `wave-formed` (a real 2+ member stage wave was dispatched concurrently — see [Stage DAG waves](#stage-dag-waves-adr-017-phase-32-item-326) below), and `auto-ruled` (an escalation was auto-resolved under an `--auto-rule` grant — carries `grant_class`, the `ruling`, and `authority`). After every non-skipped workstream dispatch, `dispatch-observation` retains only stage/role/host/model/status, gate-written and timeout flags, and optional numeric cost/duration for privacy-safe evidence analysis; it does not copy blockers, warnings, reasons, prompts, responses, paths, or transcripts.

## The consequence ceiling

`devteam run` never advances **into** `sign-off` (stage-07) or `deploy`
(stage-08) on its own — these are irreversible/outward-facing and require an
explicit human grant via `--allow-stage`. This is the line that keeps autonomy
bounded: the driver does the mechanical work up to the decisions that carry real
consequences, and stops there for you.

## Liveness: heartbeats and stall detection (ADR-007 Tier 1)

The driver emits a `heartbeat` event to `run-log.jsonl` at the **start of every
loop iteration**, before dispatching. This bounds the age of the last log entry:
if `run-log.jsonl` went quiet, the driver itself is not looping.

Alongside each `run-stage`/`continue-stage` dispatch the driver runs an
**observe-only stall probe**. It wakes every 60 s and checks whether the
workstream log (`pipeline/logs/`) or any stage gate updated. If neither showed
≥ 512 bytes of growth nor a gate update within 5 minutes, the probe emits a
`stall-detected` event (with `stall_class: "observed"`) to `run-log.jsonl` and
`onEvent`. The dispatch continues unchanged — **no process is killed, no
Promise.race fires**. The probe self-cancels when the dispatch settles so no
stale event is emitted after the stage moves on.

Note: the probe detects **silent hangs** (flat output, no gate) but **not
loop-spew** (a model emitting repetitive output indefinitely resets the clock).
Catching loop-spew requires content-distinct growth and rides with ADR-007
Tier 2 (not yet shipped).

Use `devteam status` to see a liveness snapshot at any time. During a foreground run,
`devteam run --watch` renders a rolling block with the current stage, dispatch elapsed
time, active workstreams, the last settled workstream, transcript/gate pointers, the latest
observed log-growth rate, heartbeat age, and stall status. The display consumes callback
events from the existing probe and does not poll pipeline files.

Line progress is enriched too: each workstream emits a start line and a finish line with
its role, host, exit outcome, elapsed time, and gate/log paths. This keeps redirected or
CI logs useful even when `--watch` is unavailable.

**Config:** `autonomy.stall_threshold_ms` (default 300000) and
`autonomy.stall_min_growth_bytes` (default 512) in `.devteam/config.yml`.

## Critical-path reporting

Use the run-log backed performance report after a long or surprising run:

```bash
devteam performance critical-path
devteam performance critical-path --json
devteam performance critical-path --feature "bounded feature name"
```

The report reconstructs dispatch wall time, merge time, retry delay, summed
workstream compute, estimated parallel savings, telemetry coverage, and repeated
orchestrator-stamped verification commands. It reads `run-log.jsonl` and
`_orchestrator_stamped` gate metadata; it does not trust model-authored claims
about tests or elapsed time.

For real-project baselines, collect at least five successful or cleanly halted
runs per project and retain the JSON output. Compute p50/p95 over
`reported_critical_path_ms`, per-dispatch `duration_ms`, retry delay, and merge
wall time. Compare projects only by aggregate timing and stage/workstream
categories; do not export prompts, transcript excerpts, blockers, feature text,
or repository identity.

## Stage DAG waves (ADR-017, phase-32 item 32.6)

Two curated stage pairs/groups have a `dependsOn` entry
(`core/pipeline/stages.js`) naming their real prerequisite instead of the
implicit "immediately preceding stage in track order": `red-team` depends on
`build`, and each of `accessibility-audit` / `observability-gate` /
`verification-beyond-tests` / `performance-budget` depends on `qa`. Once a
stage's named dependencies hold a PASS/WARN gate, the driver may dispatch it
concurrently with whatever else is ready, instead of waiting for stages between
it and its dependency in declared order to finish first:

- `{pre-review ∥ red-team}` — both become ready as soon as `build` PASSes.
- `{accessibility-audit ∥ observability-gate ∥ verification-beyond-tests ∥ performance-budget}`
  — all four become ready as soon as `qa` PASSes.

`autonomy.max_parallel_stages` (default **2**) caps how many ready stages are
dispatched together as one wave, in declared STAGES-table order; members past
the cap wait for the next wave. Setting it to `1` is the escape hatch — every
wave degrades to a single dispatch, identical to pre-ADR-017 behavior, with no
change to `dependsOn` or track structure. This is deliberately conservative:
the four-stage QA region ships as two waves of two by default rather than one
wave of four (ADR-017 Resolution §1) until real run-corpus data justifies
raising it.

A wave halts the run the same way a single dispatch would (a HALT-worthy
failure, budget cap, `--until`, or the consequence ceiling) — the driver does
not begin forming a *new* wave until every current member reaches a terminal
PASS/WARN or an unresolved halt, but a member that already passed is never
invalidated because a sibling failed. `state.iterations` and
`--max-iterations` count one wave as one iteration, regardless of member
count. Gate-chain order (`verify-chain`) is unaffected — it records
declared-order-of-record, not execution order, so a wave changes *when*
stages run, never their order-of-record for chain verification.

Only fresh (`run-stage`) and resuming (`continue-stage`) dispatches are
batched into a real, concurrently-dispatched wave. If a `fix-and-retry` (or
any other non-dispatch action) would be part of the ready set, the wave
collapses to that single action and is handled exactly like every dispatch
before ADR-017 — concurrent retry bookkeeping for multiple simultaneously
failing members is not implemented.

`run-log.jsonl` gains a `wave_id` (monotonic per run) on every member's
dispatch events when — and only when — a real 2+ member wave forms; a
size-one wave carries no `wave_id` field at all, so it is byte-identical to a
pre-ADR-017 log. `devteam performance critical-path`'s report gains a
`waves` array and a `wave_realized_savings_ms` figure
(`sum(member durations) - max(member durations)`, per wave) alongside its
existing sequential dispatch-wall-time accounting — the sequential figure is
not corrected by this number, it is additive context for reading it.

## Advisory sweep on completion (ADR-008)

After `pipeline-complete`, the driver runs an in-process advisory sweep (the same
classification logic as `devteam advise`) to surface any unresolved
`noted_for_followup` items from the gate files.

- **`advisory_blockers_count`** and **`advisory_breakdown`** (per-class counts)
  are added to the `--json` summary.
- When any blocker-class items remain, the driver prints to **stderr**:
  ```
  pipeline complete — N advisory blocker(s) remain; run `devteam advise` to review
  ```
- **The default exit code is unchanged.** Pipeline-complete still exits 0.
  External `if devteam run; then merge` consumers are unaffected.
- **`--fail-on-advisory`** opts in to exit 3 when blocker-class items remain
  (threshold: `QA_BLOCKER` + `A11Y_FIX`). Use `--fail-on-advisory=all` to also
  include `PEER_REVIEW_RISK`.

```bash
devteam run --fail-on-advisory        # exit 3 if QA_BLOCKER or A11Y_FIX items remain
devteam run --fail-on-advisory=all    # exit 3 if any blocker-class item remains
devteam run                           # exit 0 as before; loud line only
```

## `devteam status`

```bash
devteam status          # human-readable liveness snapshot
devteam status --json   # machine-readable (CI, tooling)
devteam status --verbose # include active/last workstream details
```

Reads `run-state.json` and the tail of `run-log.jsonl`; reports:

| Field | Meaning |
|---|---|
| `status` | `running` / `completed` / `halted` / `no-run` |
| `current_stage` | The stage the driver is working on |
| `last_action` | Last action dispatched |
| `iterations` | Loop iterations completed so far |
| `cost_usd` | Cumulative cost from all gate files, preferring each gate's orchestrator-observed usage over the model's self-report where available (phase-28 item 28.4) |
| `cost_basis` | `"observed"` (every gate had orchestrator-observed usage), `"model-asserted"` (none did — the pre-28.1 default), `"mixed"`, or `null` (no cost recorded yet) |
| `tokens_used` | Cumulative trusted input + output tokens, including retry/resume dispatches |
| `token_basis` | `"observed"`, `"estimated"`, `"mixed"`, or `null`; model-authored claims are excluded |
| `token_coverage_complete` | Whether every counted dispatch/gate had trusted token telemetry |
| `last_heartbeat_age_ms` | Ms since the last heartbeat event |
| `last_event_age_ms` | Ms since any event in run-log.jsonl |
| `stall_detected` | `true` if the most recent dispatch event was stall-detected |
| `active_workstreams` | Array of currently running workstreams with role, host, started time, gate path, and log path |
| `last_workstream` | Last workstream that finished or skipped, with outcome, duration, gate path, and log path |

## Repair mode (`devteam run --repair`) (ADR-009)

`--repair "<symptom>"` is the bug-fix intent flag. It is orthogonal to `--track` and mutually
exclusive with `--feature`. What changes when you use it:

1. **Diagnosis stage.** Stage-01 (requirements) produces a DIAGNOSIS document instead of a
   feature brief. The PM role reads the symptom, traces the code path, and writes
   `pipeline/diagnosis.md` with root cause, proposed fix, and an `affected_files` list.
   The gate always lands as ESCALATE — it cannot proceed without your explicit approval
   (`devteam next`) or `--auto-rule diagnosis-approved`.

2. **PATCH-MODE-scoped build.** The build runs with a `⚠️ PATCH MODE — targeted fix only`
   block injected, scoped to the `affected_files` list. Any file written outside that set
   causes a `scope-gate` halt. See [repair-flow.md § Scope-gate FAIL recovery](repair-flow.md#scope-gate-fail-recovery).

3. **Failing-first reproduction.** Stage-03b (executable-spec) is injected before build even
   on hotfix depth. The agent writes a Gherkin scenario that is RED before the fix and GREEN
   after; the stamp layer verifies. Gate field `reproduced` is tri-state: `true` / `false` /
   `"unverifiable: <reason>"`. See [repair-flow.md § Tri-state reproduction](repair-flow.md#tri-state-reproduction-reproduced-field).

**Escape hatch.** When you already know the defect location, `--repair-at src/auth.js:42`
seeds `affected_files` directly and skips the LLM diagnosis dispatch. Combine with `--repair`
to retain PATCH-MODE scoping and the scope gate.

**Track default.** `--repair` defaults to `hotfix` depth. Override with `--track full` when
the symptom is broad or the fix is uncertain. Auth/payments/migration symptoms auto-upgrade via
the stoplist regardless.

**Intent tag.** Every run-state and run-log event carries `intent: "repair"` so repair runs
are distinguishable from feature runs in history and telemetry.

For the full operator guide, see [`docs/runbooks/repair-flow.md`](repair-flow.md).

---

## Honest limitations

- **Auto-fix only amplifies a competent agent.** On a `code-defect`, the driver
  clears the failing gate and re-dispatches — but whether the *agent* writes a
  correct fix is on the agent. If it doesn't converge within
  `autonomy.max_retries`, the driver escalates (`convergence-exhausted`).
- **Transient-classification is heuristic v1.** The driver classifies dispatch
  failures as `transient` (retry with backoff) or `structural-input` (halt) from
  the exit code and output shape. Edge cases can mis-classify — inspect
  `run-log.jsonl` if the driver retries something that shouldn't be retried.
- **Convergence is progress-based (Phase 4.2).** Both `devteam run` and
  `devteam next` detect a stuck agent by comparing the blocker sets of the last
  two archived attempts: if they are identical the breaker trips and escalates
  with evidence (`"blocker 'X' identical across attempts 1,2"`). A count-based
  ceiling (`autonomy.max_retries`, default 2) is the backstop for the first
  retry, before two archives exist to compare. The `no_progress_evidence` field
  in `run-log.jsonl` carries the operator-readable evidence when this fires.
- **Budget is retrospective.** The cap blocks the *next* dispatch; a single
  expensive stage can overshoot it.
- **Lock is advisory.** `devteam run` holds the lock, but other mutating
  commands (`devteam stage`, `devteam merge`) do not yet check it — don't run
  them against a live autonomous run.
- **Stall detector logs stalls but does not yet act on them (observe-first).**
  `stall-detected` events in `run-log.jsonl` surface the condition but no
  autonomous action is taken. Tier-2 active stall response (SIGTERM kill policy)
  is evidence-gated on the data this item produces — see ADR-007.
- **Stale archives from a prior run can trip the no-progress breaker.** The
  convergence breaker compares the blocker sets in `pipeline/gates/archive/` to
  determine whether a retry made progress. If archive files from a *previous* run
  survive (because the run ended without a `devteam restart`), the breaker may
  see `attempt-1.json` from the old run and `attempt-1.json` from the new run as
  the same stage, conclude no progress was made, and escalate immediately.
  `devteam restart` clears the archive directory and should be called at the start
  of any fresh run. Operators on versions before Phase 5.2 (which fixed archive
  lifecycle management) may see this symptom when upgrading — clearing the archive
  directory manually (`rm -rf pipeline/gates/archive/`) before the first Phase 5.2+
  run resolves it.
