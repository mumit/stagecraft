---
name: platform-deploy
description: "Platform Developer: Stage 8 deploy task. Adapter-driven deployment — read config.yml for the adapter, follow adapter instructions, write deploy-log.md and stage-08.json."
---

# Platform Deploy Task (Stage 8)

Use this skill when you are the Platform Developer executing the Stage 8
deploy stage. Stage 8 is adapter-driven. Read `.devteam/config.yml`, discover
which adapter the project has selected, and follow that adapter's instructions
in `.devteam/adapters/<adapter>.md`. If no adapter is configured, default to
`local` and follow `.devteam/adapters/local.md`.

## Step 0 — Common preconditions (every adapter)

1. **PM sign-off.** Read `pipeline/gates/stage-07.json`. If `"pm_signoff": true`
   is absent or false: write `"status": "ESCALATE"` with reason
   "PM sign-off missing — cannot deploy" and halt.
   If `"deploy_requested": false`, do **not** ask the Principal whether to
   deploy. Treat it as an explicit instruction that no external deployment was
   requested; use the `local` adapter, run/record local verification, and mark
   `adapter_result.external_deploy: false`.
2. **Runbook.** Confirm `pipeline/runbook.md` exists and contains at minimum
   a `## Rollback` and `## Health signals` section. If missing: write
   `"status": "ESCALATE"` with reason "Runbook required for Stage 8".
3. **Config.** Read `.devteam/config.yml`. Find `deploy.adapter`. If missing,
   use `local`. Accept one of: `local`, `docker-compose`, `kubernetes`,
   `terraform`, `cloud-run`, `gizmos`, `npm`, `custom`. Unknown adapter:
   write `"status": "FAIL"` with reason "Unknown deploy adapter." Do not
   escalate for a missing adapter; `local` is the safe default.

## Step 1 — Load adapter instructions

Read `.devteam/adapters/<adapter>.md` and follow the adapter's numbered procedure.
Adapters are authoritative for their own deploy story.

## Step 2 — Write outputs

Every adapter's procedure ends with writing two artefacts:

1. **`pipeline/deploy-log.md`**: human-readable record of the deploy,
   including a `**Runbook**: pipeline/runbook.md §<section>` line that
   points a future on-call engineer at the recovery procedure.
2. **`pipeline/gates/stage-08.json`**: gate with the baseline fields
   required by `.devteam/rules/gates-core.md` plus:
   ```json
   {
     "deploy_adapter": "<name>",
     "environment": "<env>",
     "smoke_test_passed": true,
     "runbook_referenced": true,
     "adapter_result": { /* adapter-specific */ }
   }
   ```

## Step 3 — Failure handling

On any step failure: write `"status": "FAIL"` with the failing output as a
blocker, halt. **Do NOT auto-rollback.** The runbook names the rollback
procedure and the orchestrator surfaces it to the user; a human decides
whether to roll back immediately or investigate first.

The user can follow the runbook's `§Rollback` section. Do not execute
rollback from the role unless the adapter explicitly declares auto-rollback
is safe for it (none of the built-in adapters do).
