# Gate Contract — Universal Fields

Every stage writes a JSON gate file to `pipeline/gates/`.
The orchestrator reads JSON, not prose. Gates are machine-readable.

> **Per-stage schemas** (extra fields, examples, field semantics) live in
> each stage's rules/stage-NN.md file. This file covers only the universal
> contract that applies to every gate regardless of stage.

## Required Fields (all gates)

```json
{
  "stage": "string",
  "status": "PASS | WARN | FAIL | ESCALATE",
  "orchestrator": "devteam@<version>",
  "track": "full | quick | nano | config-only | dep-update | hotfix",
  "timestamp": "ISO 8601",
  "blockers": [],
  "warnings": []
}
```

**Status lattice:** `ESCALATE` wins over `FAIL` wins over `WARN` wins over `PASS`.
The orchestrator uses this precedence when merging workstream gates into a stage gate.

The legacy `agent` field has been removed. The orchestrator adds `orchestrator`
automatically — the role writing the gate does not provide it.

## Workstream vs. stage gates

Stages with a single role write **one stage gate** at `pipeline/gates/<stage>.json`.

Stages with multiple roles (`stage-04` build, `stage-05` review) write
**one workstream gate per role**; the orchestrator merges them into the stage gate.

Workstream gates carry two additional identity fields:

```json
{
  "workstream": "backend",
  "host": "claude-code"
}
```

`workstream` is the role; `host` is the adapter that produced the gate.

Workstream gate path: `pipeline/gates/<stage>.<workstream>.json`
(e.g. `pipeline/gates/stage-04.backend.json`).

Merged stage gate adds a `workstreams[]` array summarising all workstream outcomes.

## `affected_workstreams[]` — required on FAIL gates

When `status` is `FAIL`, include an `affected_workstreams` array naming the
Stage 4 build workstreams that own the reported defects:

```bash
jq .affected_workstreams pipeline/gates/<stage>.json
# → ["backend"]
# → ["backend", "platform"]
```

Omitting `affected_workstreams` on a FAIL gate is not a hard-stop but the
validator emits an advisory.

## `noted_for_followup[]` — structured objects, not plain strings

Gates that produce non-blocking observations emit them as objects:

| Field | Required | Notes |
|-------|----------|-------|
| `id` | yes | Stable identifier within the gate, e.g. `RT-06` |
| `text` | yes | One-sentence description |
| `track_for` | yes | `ticket \| lessons-learned \| adr-amendment \| brief-amendment \| deploy-note` |
| `file` | no | Source file with optional `:line` |
| `effort` | no | `XS / S / M / L / XL` |

Items with `track_for: "ticket"` surface in `open_followups[]` in stage-07 and
stage-09 gates. Plain-string entries are still accepted for backwards
compatibility but newly written gates should use the object form.

## Retry Protocol

On FAIL gates with retries, include:

```json
{
  "retry_number": 1,
  "previous_failure_reason": "string",
  "this_attempt_differs_by": "string — required, must be non-empty"
}
```

If `retry_number >= 2` AND the failure matches the previous FAIL gate exactly:
set `"status": "ESCALATE"` and halt. Same failure twice = escalate, don't retry.

**Enforced:** the validator exits 1 when `retry_number >= 1` but
`this_attempt_differs_by` is missing or empty.

## Track field

Every gate should carry a `"track"` field. Valid values: `full`, `quick`, `nano`, `config-only`, `dep-update`, `hotfix`, `loop`, `review-only`, `review-pr`. The validator emits an advisory (non-blocking) when the field is missing or carries an unrecognised value. Treat missing as `full` for compatibility.

## Tamper-evident chain

Stage-level gates carry an optional `chain` field committed by the orchestrator
(not written by hand):

```json
{
  "chain": {
    "prev_stage": "stage-04",
    "prev_hash": "sha256:…",
    "algo": "sha256-canonical-json",
    "mac_algo": "hmac-sha256-canonical-json",
    "mac": "hmac-sha256:…"
  }
}
```

When `DEVTEAM_SIGNING_SECRET` is set, stamping also authenticates the complete
gate (including predecessor metadata) with HMAC-SHA256. The secret is never
accepted as a CLI argument or written to disk. Use `devteam verify-chain` to
check; add `--require-signed`, or set `pipeline.require_signed_gates: true`, to
reject unsigned or unverifiable gates. Without signed-only policy, legacy
unsigned gates remain compatible and are reported as warnings. Use
`devteam stamp-chain` after a deliberate earlier-stage re-run. See
`core/gates/chain.js` and ADR-011.

## What the validator enforces

`gate-validator.js` runs after every subagent stop:

1. **Bypassed-escalation sweep.** If any gate has `status: "ESCALATE"` but is
   not the most recently modified, exits 3.
2. **Most-recent-gate status.** Exit 0 (PASS), 2 (FAIL), 3 (ESCALATE).
3. **Required-field presence.** Exits 1 on gates missing `stage`, `status`,
   `orchestrator`, `timestamp`, `blockers`, `warnings`. Workstream gates also
   require `workstream` and `host`.
4. **Retry integrity.** Exits 1 when `retry_number >= 1` without a non-empty
   `this_attempt_differs_by`.
5. **Advisory: track field.** Warns without halting when `track` is missing.
6. **Advisory: lessons-learned format.** Checks `pipeline/lessons-learned.md`
   for malformed `**Reinforced:**` lines.

## Failure classification

`devteam next` tags every non-pass action with a `failure_class`. The class is
derived from gate state, not written into the gate (ADR-003):

| `failure_class` | When | Action |
|---|---|---|
| `state-corruption` | gate unreadable / malformed JSON | Repair the gate file — retry won't help. |
| `judgment-gate` | `status: ESCALATE` | `devteam ruling`, not a retry. |
| `external-blocked` | FAIL, all fix steps require human action | A person must act; pipeline can't self-advance. |
| `code-defect` | FAIL with executable fix steps | Re-dispatch the workstream. |
| `convergence-exhausted` | FAIL and `retry_number >= autonomy.max_retries` | Retry budget spent; `next()` returns `resolve-escalation`. |

A `fix-and-retry` action also carries `clear_gates` — the gate files to clear
before re-running. The autonomous driver (`devteam run`) consumes this directly.
