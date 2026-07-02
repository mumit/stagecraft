# Phase 24 — Omnigent Runtime Adapter

Status: initial adapter, launch-profile, prompt-transport, policy-file bridge,
session-evidence, and experimental director-prototype slices implemented under
parent issue
[#291](https://github.com/telus-labs/stagecraft/issues/291).

## Goal

Let Stagecraft dispatch workstreams through Omnigent while preserving the
Stagecraft contracts that already make multi-host pipelines safe: per-workstream
gates, host-neutral artifacts, write audits, and deterministic `next()` behavior.

## Design Decision

Omnigent is a Stagecraft **host runtime**, not the Stagecraft core runtime.

That means:

- add `hosts/omnigent/`
- use the existing routing config to send roles/stages to Omnigent
- keep Stagecraft's Node orchestrator as the owner of stages, gates, bounded
  autonomy, retries, and validation
- let Omnigent choose/run the underlying harness for a single workstream prompt
  by default, with an explicit experimental director mode for selected
  all-Omnigent multi-workstream stages

Replacing `core/orchestrator.js` with an Omnigent director is out of scope for
this phase. The director prototype keeps Stagecraft in charge of stage planning,
gate validation, merge behavior, retries, and `next()` decisions.

## Phase 24.1 — Minimal Adapter

Deliverables:

- `hosts/omnigent/capabilities.json`
- `hosts/omnigent/adapter.js`
- installed `.omnigent/stagecraft/agent/config.yaml`
- contract and adapter-specific tests
- generated host reference docs

Acceptance:

- `devteam hosts` lists `omnigent`
- `devteam init --host omnigent` installs role prompts, skills, templates, rules,
  and the Omnigent agent bundle
- `devteam stage <name> --headless` can invoke `omnigent run ... --prompt <prompt>`
  when Omnigent is on `PATH`
- write violations are returned to the orchestrator as `writeViolations`

Verification:

```bash
node --test tests/omnigent-adapter.test.js tests/adapter-contract.test.js tests/install-roundtrip.test.js tests/router.test.js tests/cli.test.js
npm run docs:generate
npm run consistency
npx eslint .
```

## Phase 24.2 — Launch Configuration

Tracking issue: [#292](https://github.com/telus-labs/stagecraft/issues/292).

Status: implemented.

Deliverables:

- `hosts.omnigent` config block in `.devteam/config.yml`
- fields for `agent_spec_path`/`agent_spec`, `harness`, `model`, `server_url`,
  `session_mode`, `session_id`, and optional `extra_args`
- docs for local and remote Omnigent server topologies

Acceptance:

- default behavior remains compatible with Phase 24.1
- config can select `claude-sdk`, `codex`, or another Omnigent harness without
  editing installed YAML
- `DEVTEAM_HEADLESS_COMMAND` still overrides all config for emergency use

Verification:

```bash
node --test tests/omnigent-adapter.test.js
```

## Phase 24.3 — Prompt Transport

Tracking issue: [#293](https://github.com/telus-labs/stagecraft/issues/293).

Status: implemented.

Deliverables:

- prefer Omnigent's current `--prompt`, with stdin available through config
- opt-in `--prompt-file` remains supported through `prompt_transport: prompt-file`
- structural-input diagnostics distinguish command-length failure from model
  no-gate failure

Acceptance:

- long Stagecraft prompts do not depend on OS argument-length limits
- no prompt text is echoed into the operator console by default

Verification:

```bash
node --test tests/omnigent-adapter.test.js
```

## Phase 24.4 — Policy Bridge

Tracking issue: [#294](https://github.com/telus-labs/stagecraft/issues/294).

Status: implemented.

Deliverables:

- map Stagecraft allowed writes into an Omnigent policy-file filesystem section
- map shell/network stage requirements into Omnigent sandbox/policy settings
- map role tool budgets into Omnigent policy input
- document which guarantees are tool-call-time requests vs post-hoc Stagecraft
  validation

Acceptance:

- adapter tests cover policy config rendering
- docs clearly state the fallback when an Omnigent harness cannot enforce a
  rule natively
- Stagecraft post-hoc write audit remains active

Verification:

```bash
node --test tests/omnigent-adapter.test.js tests/adapter-contract.test.js
```

## Phase 24.5 — Session Evidence

Tracking issue: [#295](https://github.com/telus-labs/stagecraft/issues/295).

Status: implemented.

Deliverables:

- capture Omnigent session/conversation identifiers when available
- record adapter-private metadata in a `pipeline/logs/*.omnigent.json` sidecar
  without changing gate schemas
- retain policy verdict counts without raw policy lines

Acceptance:

- exported gate schemas remain host-neutral
- operators can trace a Stagecraft workstream log back to the Omnigent session
  that produced it

Verification:

```bash
node --test tests/omnigent-adapter.test.js
```

## Phase 24.6 — Director Experiment

Tracking issue: [#296](https://github.com/telus-labs/stagecraft/issues/296).

Deliverables:

- prototype behind `devteam stage <name> --headless --experimental-omnigent-director`
- one Omnigent director session may run several Stagecraft workstreams when
  every planned workstream routes to `omnigent`
- director prompt includes each original child workstream prompt and every
  expected `pipeline/gates/<stage>.<role>.json`
- director results are mapped back onto normal child workstreams; no director
  gate is written or consumed

Acceptance:

- existing per-workstream merge behavior remains unchanged
- a missing or malformed child gate blocks the stage exactly as it does today
- no change to the stable gate identity fields
- `--skip-completed` is rejected with director mode until partial-resume
  semantics are designed

Verification:

```bash
node --test tests/orchestrator.test.js tests/cli.test.js tests/omnigent-adapter.test.js
```

## Open Questions

- Should Omnigent session mode default to `--no-session` for reproducibility, or
  persistent sessions for better supervision?
- Should Stagecraft generate one agent bundle per role, or a single generic
  workstream executor plus `--prompt` prompt?
- Which Omnigent policy fields are stable enough to treat as a Stagecraft
  adapter contract rather than a best-effort integration?
- Should remote Omnigent server execution be modeled as part of this host
  adapter, or as a separate cloud-runner transport?
