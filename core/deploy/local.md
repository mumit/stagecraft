# Adapter: local

Default safe deploy adapter for projects that have not declared an external
deployment target. It performs local/in-place verification and records that no
external environment was published.

Use this adapter when `.devteam/config.yml` omits `deploy.adapter`, or when the
project explicitly sets:

```yaml
deploy:
  adapter: local
  local:
    smoke_command: "npm test"       # optional; defaults to discovered tests
    start_command: "npm start"      # optional local server command
    smoke_url: "http://127.0.0.1:3000/health"  # optional
```

## Assumptions

- This adapter must not push, publish, mutate cloud infrastructure, or expose a
  public endpoint.
- `pipeline/gates/stage-07.json` may set `deploy_requested: false`. That is an
  explicit request to stop before any external deploy, not an escalation. Record
  local verification and `adapter_result.external_deploy: false`.
- `pipeline/runbook.md` exists and names rollback plus health signals.
- The project may have no server process. In that case the adapter records a
  local verification-only deploy.

## Procedure

### 1. Preconditions

- Read `pipeline/gates/stage-07.json`. Confirm `pm_signoff: true`.
  If missing or false: write `status: ESCALATE` with reason
  "PM sign-off missing — cannot deploy" and halt.
- If `deploy_requested: false`, continue with this adapter and add a warning:
  "Stage 7 requested no external deploy; local verification only." Do not ask
  the Principal whether to configure another adapter.
- Confirm `pipeline/runbook.md` exists and contains `## Rollback` and
  `## Health signals`. If missing: write `status: ESCALATE` with reason
  "Runbook required for Stage 8" and halt.

### 2. Choose a local smoke check

Use the first applicable option:

1. If `deploy.local.smoke_command` is configured, run it.
2. Else if `package.json` has a `test` script, run `npm test`.
3. Else if the project has Go tests, run `go test ./...`.
4. Else if pytest is configured or Python tests are present, run
   `python3 -m pytest`.
5. Else record `smoke_tests_passed: true` with warning
   "No local smoke command discovered; no external deploy performed."

If `deploy.local.start_command` and `deploy.local.smoke_url` are both
configured, start the server in the background, poll `smoke_url`, then stop the
server before writing the gate. If either command or URL is absent, do not infer
how to launch the service.

### 3. Write outputs

#### `pipeline/deploy-log.md`

```markdown
# Deploy Log

**Date**: <ISO>
**Method**: local — no external deploy
**Runbook**: pipeline/runbook.md §Rollback

## Local verification
<command run, or explanation that no command was discovered>

## External deploy
Not performed. <No deploy adapter was configured | Stage 7 set deploy_requested: false>.

## Recovery procedure
See runbook §Rollback.
```

#### `pipeline/gates/stage-08.json`

```json
{
  "stage": "stage-08",
  "status": "PASS",
  "track": "<track>",
  "timestamp": "<ISO>",
  "orchestrator": "devteam@<version>",
  "workstream": "platform",
  "host": "<host>",
  "deploy_completed": true,
  "smoke_tests_passed": true,
  "rollback_executed": false,
  "deploy_adapter": "local",
  "environment": "local",
  "runbook_referenced": true,
  "cost_delta_estimated": true,
  "cost_delta_multiplier": 1,
  "cost_gate_override": false,
  "adapter_result": {
    "deploy_requested": false,
    "external_deploy": false,
    "reason": "<missing deploy.adapter | stage-07 deploy_requested false>",
    "smoke_command": "<command or null>",
    "smoke_exit_code": 0
  },
  "blockers": [],
  "warnings": [
    "Stage 7 requested no external deploy; local verification only."
  ]
}
```

If the local smoke command fails, write `status: "FAIL"` with the failing command
and output in `blockers[]`. Do not rollback; no external deploy occurred.

## Runbook hooks

This adapter requires `pipeline/runbook.md` to include:

- **§Rollback** — even local-only deploys must name the recovery procedure that
  would apply if a later external adapter is selected.
- **§Health signals** — what operators should check after a real deploy.
