# CI integration (F4)

Stagecraft ships a CI workflow template that **validates and publishes** pipeline state on pull requests. It does **not** run the pipeline itself in CI. Running an LLM pipeline on every PR is expensive, and the pipeline is designed to be human-driven. CI's job is to surface the audit trail that local runs produced.

This is the **F4** BACKLOG item.

- [What the workflow does](#what-the-workflow-does)
- [Install](#install)
- [Required GitHub permissions](#required-github-permissions)
- [What the PR review experience looks like](#what-the-pr-review-experience-looks-like)
- [Why not run the pipeline in CI?](#why-not-run-the-pipeline-in-ci)
- [Autonomous jobs and the Docker runner](#autonomous-jobs-and-the-docker-runner)
- [Other CI systems](#other-ci-systems)
- [Pinning + drift](#pinning--drift)
- [See also](#see-also)

## What the workflow does

When a PR touches `pipeline/` or `.devteam/`:

1. **Checks out** the target project at the PR's head commit.
2. **Checks out Stagecraft** at a pinned version (configurable env var).
3. **Skips cleanly** if the PR includes no gates. If `pipeline/gates/` is empty or absent, the workflow short-circuits with a `::notice::` and exits green.
4. **Validates** every gate file with Stagecraft's validator. Exit codes propagate: 0 PASS/WARN (job stays green), 1 malformed (fail), 2 FAIL gate (fail), 3 ESCALATE (fail — surfaces needs-resolution).
5. **Verifies the authenticated gate chain (C6)** with `devteam verify-chain`. CI recomputes predecessor hashes and verifies HMACs when `DEVTEAM_SIGNING_SECRET` is configured. Exit 1 means a hash break, invalid MAC, or signed-only policy violation. Legacy unsigned gates remain warnings unless `pipeline.require_signed_gates: true` is set. **Blocking by design** — an authenticated audit trail is only meaningful when verification failure stops promotion.
6. **Posts each gate as a GitHub check run** on the PR head commit via `scripts/pr-publish.js`. PASS→success, WARN→neutral, FAIL/ESCALATE→failure. Reviewers see "15/18 stages passing" in the PR's status bar with click-through to per-stage detail.
7. **Reproducibility drift check** (advisory, doesn't block merge): runs `devteam reproduce` on each gate, surfacing any drift between the recorded `system_prompt_hash` and what would render today.

Not invoking the LLM in CI keeps cost predictable and avoids running the pipeline without human oversight.

## Install

In your target project:

```bash
devteam ci install                       # drops the workflow into .github/workflows/
devteam ci install --force               # overwrite an existing file
devteam ci install --out custom/path/    # redirect output (rare)
devteam ci show                          # print the template to stdout (preview)
```

After install:

1. Open `.github/workflows/stagecraft-pr-checks.yml` and edit the two Stagecraft env vars at the top:
   - `STAGECRAFT_REPO`: where to fetch Stagecraft from (e.g. `your-org/stagecraft`)
   - `STAGECRAFT_REF`: which Stagecraft version/tag/sha to pin
2. Optional authenticated enforcement: add a repository Actions secret named `DEVTEAM_SIGNING_SECRET`, use the same protected secret while running/stamping Stagecraft, and set `pipeline.require_signed_gates: true` in `.devteam/config.yml`. Pull requests from forks do not receive repository secrets and therefore fail strict verification by design.
3. If using `openai-compat` as your host: add the API-key env var named by `api_key_env` in your config (e.g. `OPENAI_API_KEY`, `FIREWORKS_API_KEY`, `FUELIX_API_KEY`, or `OPENROUTER_API_KEY`) as a repository Actions secret. `openai-compat` has no CLI and no `headlessCommand` — it calls the configured OpenAI-compatible API directly via HTTP, so CI only needs the key in the environment.
3. Commit + push the workflow file.
4. Open a PR that touches `pipeline/gates/` and watch the checks fire.

## Required GitHub permissions

The workflow declares:

```yaml
permissions:
  contents: read
  checks: write
  pull-requests: write
```

These are scoped to the workflow run. No PAT is needed. The runner's default `GITHUB_TOKEN` is used for posting check runs.

## What the PR review experience looks like

Without this workflow, a PR with a `pipeline/gates/stage-04.json` PASS gate looks identical to one with a FAIL gate. Reviewers have to read the JSON. With it:

```
✓ stagecraft pr-checks / validate-and-publish
   ✓ stage-01 requirements      PASS  (12s)
   ✓ stage-02 design             PASS  (47s)
   ✓ stage-03 clarification      PASS  (skipped, auto-folded)
   ✓ stage-04 build              PASS  (4 workstreams)
   ✓ stage-04a pre-review         PASS
   ✗ stage-04b security-review    FAIL  ← visible in the PR status bar
       Blockers:
       - High-severity finding in src/backend/auth.ts:42
   ⚠ stage-04c red-team           WARN  ← yellow in the status bar
       Warnings:
       - 2 noted-for-followup findings
   ...
```

Each line in the PR's "Checks" tab links back to the gate detail. A reviewer can see at a glance which stages need attention.

## Why not run the pipeline in CI?

Three reasons:

1. **Cost.** A `full`-track run is 5–60 minutes of LLM time. Running it on every PR, including draft PRs and force-pushes, multiplies that by PR volume.
2. **Human-in-the-loop.** Stagecraft's pipeline is designed for a human reading the prompt and decisions at each stage. Running it unattended in CI means agents make decisions that nobody sees until after the fact.
3. **Shape mismatch.** A PR has *already been built*. Running `devteam stage build` against a PR doesn't fit the model.

The validate-and-publish path (this workflow) is the appropriate CI integration. If your team eventually wants to run a `nano` track on `dependabot` PRs, or an `audit-quick` on PRs touching sensitive paths, those belong in separate adjacent workflow files, not as a replacement for this one.

## Autonomous jobs and the Docker runner

When you intentionally want CI or a scheduler to run model work, keep it in a
separate job from `devteam ci install`'s validation workflow. The Docker runner
is the supported packaging path for that use case: it runs the normal
orchestrator as a non-root user against a mounted workspace and writes normal
`pipeline/` artifacts back to the checkout.

```yaml
- name: Build Stagecraft runner
  run: docker build -f hosts/docker/Dockerfile -t stagecraft-runner:ci .

- name: Run low-risk pipeline
  run: |
    docker run --rm \
      -v "$PWD:/workspace" \
      --env-file .devteam/docker.env \
      stagecraft-runner:ci run --cwd /workspace --track nano --budget-usd 10
```

Generate `.devteam/docker.env` from CI secrets or use your platform's native
secret injection. Do not bake provider keys into the image. The runner preserves
normal `devteam run` exit codes, including the consequence ceiling and advisory
strictness, so CI scripts can handle success, halt, and advisory-blocked states
the same way they do outside Docker.

## Other CI systems

`devteam ci install --ci <type>` currently supports only `github-actions`. GitLab CI / Buildkite / CircleCI templates are BACKLOG candidates. The Stagecraft side (validator + pr-publish.js) is CI-agnostic; the templates just need to be written.

## Pinning + drift

The template pins `STAGECRAFT_REF: <version>`. Update it on each Stagecraft release you want to adopt. Pinning matters because:

- Validator behavior could change (rare but possible).
- `scripts/pr-publish.js`'s output shape could evolve.
- A floating ref (`@main`) means your CI silently changes when Stagecraft does.

Update the workflow file in lockstep with Stagecraft upgrades.

## Track provenance in CI (`devteam assess` + `require_confirmed_track`)

Before running the pipeline autonomously in CI, record the track decision with `devteam assess`:

```yaml
- name: Assess track
  run: devteam assess --feature "${{ github.event.pull_request.title }}" --confirm
  # writes pipeline/track.json with source:"human" (--confirm) so devteam run
  # proceeds without the unconfirmed-track guard triggering.
```

By default, `devteam run` warns on an inferred track but never halts. To enforce the guard in CI, set `autonomy.require_confirmed_track: true` in `.devteam/config.yml`:

```yaml
autonomy:
  require_confirmed_track: true
```

With the flag on, an inferred `pipeline/track.json` at medium or low confidence halts with `unconfirmed-track` instead of proceeding. High confidence proceeds. The flag is **not** tied to `CI=true` — it is an explicit opt-in so unrelated tooling running under a CI environment does not silently change track behavior.

**CI pipeline pattern with track recording + strict guard:**

```yaml
- name: Assess track (record with human-confirm)
  run: devteam assess --feature "$FEATURE_DESC" --confirm

- name: Run pipeline
  run: devteam run --json > run-summary.json
  # With require_confirmed_track:true, --confirm above means source:"human" → no halt.
  # Without --confirm, medium/low inferred would halt here.
```

## Lenient vs strict advisory gate

`devteam run` emits a loud advisory line on stderr and adds `advisory_blockers_count`
to the `--json` summary when unresolved follow-up items remain after
`pipeline-complete`. The exit code is **0 by default** so existing
`if devteam run; then merge` pipelines are unaffected.

Teams that want CI to block on advisory findings can opt in with
`--fail-on-advisory`:

**Lenient (default) — report advisory blockers, don't block merge:**

```yaml
- name: Run pipeline
  run: devteam run --json > run-summary.json
  # exits 0 even if advisory blockers remain; loud line appears in logs
```

**Strict — block merge on QA_BLOCKER or A11Y_FIX findings (exit 3):**

```yaml
- name: Run pipeline
  run: devteam run --fail-on-advisory
  # exits 3 if QA_BLOCKER or A11Y_FIX items remain; exits 0 otherwise
```

**All-class strict — also block on PEER_REVIEW_RISK:**

```yaml
- name: Run pipeline
  run: devteam run --fail-on-advisory=all
  # exits 3 if any blocker-class item (QA_BLOCKER, A11Y_FIX, PEER_REVIEW_RISK) remains
```

Exit code 3 is distinct from exit 1 (a pipeline halt) so scripts can distinguish
"pipeline didn't finish" from "pipeline finished but has outstanding advisories".

## See also

- [`templates/ci/github-actions/stagecraft-pr-checks.yml`](../templates/ci/github-actions/stagecraft-pr-checks.yml) — the workflow itself.
- [`scripts/pr-publish.js`](../scripts/pr-publish.js) — what the workflow invokes for check-run posting.
- [`docs/BACKLOG.md`](BACKLOG.md) F4 — the BACKLOG entry this implements.
- [`docs/reproducibility.md`](reproducibility.md) — the drift check that runs as an advisory step.
