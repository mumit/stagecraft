# Pipeline Tracks (Stage 0)

This file covers track routing, the safety stoplist, the budget gate,
and async-friendly checkpoints — everything the orchestrator decides
*before* invoking Stage 1. The pipeline definition itself lives in
`pipeline-core.md` (Stages 1–3, 9, durations) and `pipeline-build.md`
(Stages 4–8 — index that points at each per-stage file). The full
index is in `pipeline.md`.

## Stage 0 — Routing + budget (orchestrator, pre-stage)

### Budget gate (opt-in)

Before Stage 1, the orchestrator initialises budget tracking if
`.devteam/config.yml` has `budget.enabled: true`. Budget tracking
writes `pipeline/budget.md` at run start with zero counters and
updates it at every stage boundary:

```markdown
# Budget

Started: <ISO>
Tokens max: 500000
Wall-clock max: 90 min

## Running totals
| Stage | Tokens | Elapsed (min) |
|-------|--------|---------------|
| 1     | 12000  | 3.2           |
| 2     | 45000  | 8.7           |
| ...   | ...    | ...           |
```

After each stage gate passes, the orchestrator checks the running
totals against the configured maximums. On exceed:

- `on_exceed: escalate` — write `pipeline/gates/stage-budget.json`
  with `status: ESCALATE`, `escalation_reason: "Budget exceeded
  — <tokens | wall-clock>"`, and `decision_needed: "Continue
  (override budget), or halt and inspect?"`. The orchestrator halts.
- `on_exceed: warn` — log the breach, continue the pipeline. Useful
  for calibration runs where the team is still tuning limits.

Token counts are best-effort — the orchestrator sums reported usage
where Claude Code surfaces it, otherwise estimates from character
counts. This is a guardrail, not a cryptographic limit.

When `budget.enabled: false` (default), no tracking happens. This is
what projects that don't want the overhead should use.

### Track routing

Before Stage 1, the orchestrator must decide which track to run. Ten tracks
exist and they share gates, agents, and artefacts where they overlap, but
differ on which stages run and how many approvals a gate requires (the table
below predates `review-only`/`review-pr`/`refactor` — see `docs/tracks.md` for those):

| Track | CLI flag | Runs | Stage 5 approvals | Retro |
|---|---|---|---|---|
| **Full** | `--track full` | Stages 1–9 as defined below | 2 per area (matrix) | Full Stage 9 |
| **Quick** | `--track quick` | 1 (mini-brief) → 4 (single dev) → 5 (1 cross-area reviewer) → 6 → 7 (auto) → 8 (optional) → 9 (abbreviated) | 1 per area | Single-dev contribution + Principal synthesis |
| **Nano** | `--track nano` | 4 (single dev) → 6 (affected tests, no regression) → 7 (auto) | None | Fix-log entry only |
| **Config-only** | `--track config-only` | 4 (platform) → 4a (lint + config validate) → 6 (no-regression) → 8 (optional) | N/A | Fix-log entry only |
| **Dep update** | `--track dep-update` | 4 (platform + changelog scan + SCA) → 5 (single supply-chain reviewer) → 6 (no-regression) → 8 (optional) | 1 (supply-chain focus) | Fix-log entry only |
| **Hotfix** | `--track hotfix` | 4 → 4b (conditional) → 5 → 6 → 7 → 8 (design + 4a skipped; blast-radius rule active) | 2 per area | Abbreviated single-section retro |
| **Loop** | `--track loop` | 1 (one-screen brief) → 4 (single workstream, default backend) → 6 (qa) → 5 (1 reviewer) — note qa before peer-review, the reverse of every other track | 1 (single reviewer) | None; no sign-off/deploy on this track |
| **Review-only** | `--track review-only` | 4b (security-review) → 4c (red-team) → 5 (peer-review) — no requirements/design/build; reviews code that already exists, optionally narrowed with `--scope <path>` (repeatable) | 2 per area (matrix) | None; no sign-off/deploy on this track |

The routing decision is recorded in `pipeline/context.md` under `## Brief
Changes` as `TRACK: <name>` with a one-line rationale. Each gate file in
`pipeline/gates/` includes `"track": "<name>"` in its body so the
gate-validator and downstream tooling can branch on track.

**Safety stoplist** — the `full` track is mandatory for any change
that touches:

- Authentication / authorization / session handling
- Cryptography, key management, secrets rotation
- PII / payments / regulated-data handling
- Schema migrations, destructive data changes
- Feature-flag introduction (toggling existing flags is fine on `config-only`)
- New external dependencies (upgrades are fine on `dep-update`)

The lighter tracks (`quick`, `config-only`, `dep-update`) must not be
used to bypass this list. If the orchestrator is uncertain whether a
change crosses the stoplist, it must default to `full`. As of
B-13 (audit 2026-05-07), `devteam` enforces the stoplist
programmatically by refusing the lighter tracks on description or diff
matches. `--force` authorizes a false-positive bypass scoped to the hashed
feature, active brief, and stoplist policy. The same logical run may reuse that
ruling; any bound-input change invalidates it before dispatch.

The rules in `pipeline-build.md` and the per-stage `stage-NN.md` files
describe the **full** track. When a gate in a lighter track differs from
the full-track definition (for example, Stage 5 needing only one approval
on `quick`), those differences are captured in the stage files and in
`STAGES_BY_TRACK` in `core/pipeline/stages.js` — the stages file is
authoritative for which stages run on each track.

### Async-friendly checkpoints (opt-in)

By default, the pipeline halts at Checkpoints A, B, and C waiting for
a human `proceed`. Teams can pre-approve a checkpoint when a
precondition holds, configured in `.devteam/config.yml`:

```yaml
checkpoints:
  c:
    auto_pass_when: all_criteria_passed
```

Supported conditions:

- `null` / absent — always wait for human (default; current behaviour)
- `no_warnings` — auto-pass if the stage gate has zero warnings
- `all_criteria_passed` — auto-pass if `stage-06.json` has
  `all_acceptance_criteria_met: true` (Checkpoint C only)

Auto-pass writes a record to `pipeline/context.md` under `## Brief Changes` as:

```
<ISO> — Checkpoint <X> auto-passed via config (<condition>)
```

Never auto-pass security-sensitive work. The safety stoplist above
and the Stage 4.5b security-engineer veto remain the hard guards —
auto-pass at checkpoints does not override them. As of B-24 (audit
2026-05-07), `devteam checkpoint <stage>` implements the
auto-pass with explicit stoplist suppression on context.md content.
