# Stage 8 — Deploy (Platform Dev)

Invoke: `dev-platform` agent.
Preconditions:
- `pipeline/gates/stage-07.json` has `"pm_signoff": true`
- Stage 7's documentation gate is satisfied (`docs_surface_affected: false` with a `docs_skipped_reason`, or `docs_surface_affected: true` and `docs_updated: true`)
- `pipeline/runbook.md` exists and has `## Rollback` + `## Health signals`
  sections (see `templates/runbook-template.md` for the canonical blank form)
- `.devteam/config.yml` names a valid adapter in `deploy.adapter`, or the
  default `local` adapter is used

Stage 8 is **adapter-driven**. The dev-platform
agent reads the selected adapter's instructions from
`.devteam/adapters/<adapter>.md` and follows them. If `deploy.adapter` is
missing, use `.devteam/adapters/local.md`. Built-in adapters:
`local` (default no external deploy), `docker-compose`, `kubernetes`,
`terraform`, `cloud-run`, `gizmos`, `npm`, `custom`. See
`.devteam/adapters/README.md` for the contract.

If `pipeline/gates/stage-07.json` has `deploy_requested: false`, Stage 8 must
not escalate to ask whether to deploy. The orchestrator writes the
local/no-external-deploy gate and deploy log directly, records local
verification only, and sets `adapter_result.external_deploy: false` with a
warning that Stage 7 requested no external deploy.

Output:
- `pipeline/deploy-log.md` — human-readable, includes a runbook
  pointer
- `pipeline/gates/stage-08.json` — gate with fields `deploy_adapter`,
  `environment`, `smoke_tests_passed`, `runbook_referenced`,
  `cost_delta_estimated`, `cost_delta_multiplier`, `cost_gate_override`, and
  an adapter-specific `adapter_result` block

On failure: do NOT auto-rollback. The deploy log points to the
runbook's `§Rollback` section; the orchestrator surfaces that
pointer and the user decides.

Post-deploy: invoke `pm` agent to write stakeholder summary.

## Gate

Gate file: `pipeline/gates/stage-08.json`.

```json
{
  "stage": "stage-08",
  "status": "PASS",
  "track": "full",
  "timestamp": "<ISO 8601>",
  "orchestrator": "devteam@<version>",
  "workstream": "platform",
  "host": "claude-code",
  "blockers": [],
  "warnings": [],
  "deploy_completed": true,
  "smoke_tests_passed": true,
  "rollback_executed": false,
  "deploy_adapter": "local | docker-compose | kubernetes | terraform | cloud-run | gizmos | npm | custom",
  "environment": "<adapter-specific>",
  "runbook_referenced": true,
  "cost_delta_estimated": true,
  "cost_delta_multiplier": 1,
  "cost_gate_override": false,
  "adapter_result": {}
}
```

`deploy_adapter` is the **deploy** adapter (Stage 8 target). The **host** adapter
(which AI tool produced the gate) lives in the top-level `host` field.
The gate passes only when `status: "PASS"` AND `runbook_referenced: true`.
For `deploy_adapter: "local"`, `deploy_completed: true` means the local
verification procedure completed; `adapter_result.external_deploy` must be
`false` to avoid implying a public/environment deploy occurred.
When Stage 7 has `deploy_requested: false`, the local adapter is the expected
outcome even if another deploy adapter is absent.

## Cost Gate

Before deploying, estimate the recurring infrastructure/cloud cost delta relative
to the pre-change baseline. Record it in `cost_delta_multiplier`:

- `1` means no meaningful recurring cost change.
- `2.5` means the deploy is estimated to cost 2.5x the previous baseline.
- Values below `1` are allowed for cost reductions.

Set `cost_delta_estimated: true` only after making the estimate. A PASS or WARN
Stage 8 gate without that estimate is invalid. If `cost_delta_multiplier >= 10`
(a 10x-or-greater recurring cost increase), the deploy must not pass unless a
human explicitly approved the increase; set `cost_gate_override: true` and
include `cost_gate_override_reason` naming the approval source. Without that
override, write `status: "FAIL"` with a blocker instead of deploying.
