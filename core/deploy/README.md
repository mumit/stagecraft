# Deployment Adapters

Stage 8 deployment is pluggable. Each adapter provides a concrete
procedure for how `dev-platform` builds, deploys, and smoke-tests a
release. Projects pick one adapter in `.devteam/config.yml`:

```yaml
deploy:
  adapter: docker-compose  # or: kubernetes, terraform, custom
```

If `deploy.adapter` is omitted, Stage 8 defaults to `local`: it performs local
verification, records that no external deploy occurred, and writes the standard
deploy log/gate instead of escalating for missing configuration.
If Stage 7 records `deploy_requested: false`, Stage 8 also uses `local`; that
field is an explicit stop-before-external-deploy signal, not a Principal
decision point.

## Why adapters

v1–v2.3 hardcoded `docker compose` as the deploy primitive. That's
fine for local demos and toy projects but useless for any real
environment (K8s, serverless, cloud IaC, enterprise CI/CD). Adapters
let a project declare its actual deployment story without rewriting
`dev-platform.md`.

## Contract

Every adapter must:

1. Read `pipeline/gates/stage-07.json` and confirm `"pm_signoff": true`
   before doing anything that touches infrastructure. If Stage 7 records
   `"deploy_requested": false`, use `local` and record no external deploy
   instead of asking for a human deployment choice.
2. Perform the adapter-specific build and deploy steps in order, each
   wrapped so that a non-zero exit code halts the stage with a
   specific blocker written to `pipeline/gates/stage-08.json`.
3. Run smoke tests — what counts as a smoke test is adapter-specific
   (HTTP `/health`, a `kubectl rollout status`, a Terraform output
   diff, etc.) — and report pass/fail per service in
   `pipeline/deploy-log.md`.
4. Estimate the recurring infrastructure/cloud cost delta relative to
   the pre-change baseline. A `cost_delta_multiplier` of `1` means no
   meaningful change; `2.5` means 2.5x the previous recurring cost.
   A 10x-or-greater increase must FAIL unless a human explicitly
   approved the deploy and the gate records `cost_gate_override: true`
   plus `cost_gate_override_reason`.
5. Write `pipeline/gates/stage-08.json` with required baseline fields
   plus `deploy_adapter: "<name>"`, `environment: "<env>"`,
   `smoke_tests_passed: true | false`, `cost_delta_estimated`,
   `cost_delta_multiplier`, `cost_gate_override`, and an
   adapter-specific extras block under `adapter_result`.
6. Require `pipeline/runbook.md` to exist before the gate passes.
   Rationale: every deploy needs a named rollback/recovery procedure.
   See `templates/runbook-template.md` for the canonical blank form.
7. On failure: do NOT auto-rollback. Leave the environment in its
   failed state so the user can inspect, and write clear instructions
   in the deploy log pointing to the runbook's recovery section.

## Built-in adapters

| Adapter | File | Suits |
|---|---|---|
| `local` (default)          | `local.md`          | No external deploy; local/in-place verification |
| `docker-compose`           | `docker-compose.md` | Local dev, demo, single-host deploy |
| `kubernetes`               | `kubernetes.md`    | K8s clusters via `kubectl` / Helm  |
| `terraform`                | `terraform.md`     | IaC-managed infra on any cloud     |
| `cloud-run`                | `cloud-run.md`     | GCP Cloud Run via Artifact Registry + gcloud |
| `gizmos`                   | `gizmos.md`        | Gizmos platform (Cloudflare Workers, gizmos.run) |
| `npm`                      | `npm.md`           | npm package publish (CLI tools, libraries) |
| `custom`                   | `custom.md`        | Project-specific script (escape hatch) |

## Conventions files

Each adapter may have a companion `core/deploy/<adapter>.conventions.md` file.
When `deploy.adapter` is set in `.devteam/config.yml`, devteam writes the
conventions as a delimited block into `pipeline/context.md` before stages 01–03
dispatch (via `devteam run` or `devteam stage`). This makes deployment target
constraints visible to requirements, design, and build agents without repeating
them in every `--feature` string.

The block is idempotent — writing it twice does not duplicate it. If the adapter
changes, `devteam restart stage-01 --cascade` clears pipeline state; the next
run seeds fresh conventions.

Keep conventions files focused on what design and build agents need: language,
runtime, required file structure, state options, and health check requirements.
Do not duplicate the deployment procedure from `<adapter>.md`.

## Writing a new adapter

To add a new adapter (e.g. `nomad`, `ecs`, `cloudfoundry`):

1. Create `.devteam/adapters/<name>.md` following the structure of the
   built-in adapters. Include:
   - An "Assumptions" section naming what the adapter expects to find
     in the project (CLI tools on PATH, config file names, env vars)
   - A numbered procedure for the Stage 8 run
   - A "Gate body" section showing the `adapter_result` block shape
   - A "Runbook hooks" section stating what runbook sections this
     adapter depends on
2. Document your adapter's name and suitability in the table above.
3. Test by running a pipeline end-to-end against a representative
   target environment.

Adapters are markdown instructions, not code. The `dev-platform`
agent reads the selected adapter's markdown and follows it. This
keeps the surface easy to extend and review — adding an adapter is
writing down what you'd do by hand, not shipping Go/Node modules.

## Selecting an adapter

The default is `local`. To publish to a concrete target, select an adapter:

1. Edit `.devteam/config.yml`:
   ```yaml
   deploy:
     adapter: kubernetes
   ```
2. Adjust adapter-specific config in the same file — each adapter's
   documentation lists what it reads.
3. Run `/pipeline` or `/hotfix` as normal; `dev-platform` picks up the
   new adapter automatically.

`.devteam/config.yml` is gitignored from the user's project by default
(since it may carry environment-specific credentials or paths). Check
the adapter's own doc for exactly which fields are safe to commit
versus which should live in `.devteam/config.local.yml`.
