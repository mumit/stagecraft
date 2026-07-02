# Omnigent Runtime Adapter

Stagecraft can use [Omnigent](https://github.com/omnigent-ai/omnigent) as a
host runtime without moving Stagecraft's core orchestration into Omnigent.

The boundary is the existing host adapter contract:

- Stagecraft owns stage order, routing, prompt rendering, gate schemas, gate
  validation, retries, bounded-autonomy state, and gate-chain evidence.
- Omnigent owns the runtime that consumes one workstream prompt: harness/model
  selection, session execution, local or managed sandboxing, and optional
  Omnigent policies.
- The filesystem remains the exchange surface. The agent writes the normal
  Stagecraft artifact and gate JSON files, and Stagecraft validates them after
  the run.

## Shipped Slice

The `omnigent` host adapter installs:

- role prompts under `.omnigent/stagecraft/roles/`
- Stagecraft skills under `.omnigent/stagecraft/skills/`
- shared rules and templates under `.devteam/`
- a default Omnigent agent bundle at `.omnigent/stagecraft/agent/`
  (`config.yaml` plus any future bundled assets)

With no `hosts.omnigent` config block, the adapter keeps the Phase 24.1
headless command shape:

```bash
omnigent run .omnigent/stagecraft/agent --no-session --prompt <stage-prompt>
```

Unlike the existing CLI hosts, Omnigent's one-shot path accepts the prompt as
`--prompt`, stdin, or opt-in `--prompt-file`, so the adapter implements a
custom `invoke()` instead of using the shared stdin-based `runHeadless()` helper.

The installed default agent spec uses Omnigent's Codex harness because that
harness carries its own coding tools. Operators can choose harnesses and launch
topology in `.devteam/config.yml`; `DEVTEAM_HEADLESS_COMMAND` remains the
highest-precedence emergency override, for example:

```bash
DEVTEAM_HEADLESS_COMMAND='omnigent run .omnigent/stagecraft/agent --no-session --harness claude-sdk' \
  devteam stage build --headless
```

## Capability Posture

The first adapter slice is intentionally conservative:

| Capability | Current posture |
|---|---|
| `headless` | yes, through `omnigent run ... --prompt` |
| `hooks` | no; Stagecraft polls/validates gate files after the process exits |
| `subagents` | no; Stagecraft still dispatches one workstream per role |
| `slashCommands` | no; users invoke `devteam` directly |
| `worktrees` | no adapter-specific mapping yet |
| `allowed_writes` | `post-hoc-audit` via Stagecraft write audit |
| `stoplist` | `prompt-only` |
| `tool_budget` | `prompt-only` |

This keeps the first release honest: Omnigent is an execution host, not yet a
replacement for Stagecraft dispatch fan-out or policy enforcement.

## Configuration Sketch

Single-host routing:

```yaml
routing:
  default_host: omnigent
```

Local no-session execution is the default and can be made explicit:

```yaml
routing:
  default_host: omnigent

hosts:
  omnigent:
    agent_spec_path: .omnigent/stagecraft/agent
    harness: codex
    model: gpt-5-codex
    session_mode: no-session
    prompt_transport: argument
    policy_mode: off
```

This renders the same shape as the default command, with configured additions:

```bash
omnigent run .omnigent/stagecraft/agent --harness codex --model gpt-5-codex --no-session --prompt <stage-prompt>
```

Server-backed execution omits `--no-session` and can pass a server URL plus
safe extra arguments:

```yaml
routing:
  default_host: omnigent

hosts:
  omnigent:
    agent_spec_path: .omnigent/stagecraft/agent
    harness: claude-sdk
    model: claude-sonnet-4
    server_url: https://omnigent.internal.example
    session_mode: session
    prompt_transport: stdin
    policy_mode: file
    extra_args:
      - --profile
      - delivery-team
```

To resume a known session, set `session_mode: resume` and `session_id`; the
adapter passes `--session <id>`.

`prompt_transport` can be:

| Value | Behavior |
|---|---|
| `argument` | Default. Appends `--prompt <prompt>` and emits a structural command-length diagnostic if the OS rejects the argument vector. |
| `stdin` | Writes the prompt to process stdin without putting prompt text in arguments. |
| `prompt-file` | Compatibility mode for Omnigent CLIs that support it. Writes the Stagecraft prompt to a private temporary file, passes `--prompt-file <path>`, and removes the file after Omnigent exits. |

`extra_args` is an array, not a shell string, and cannot override Stagecraft's
prompt transport flags (`-p`, `--prompt`, or `--prompt-file`). Prompt text is
not mirrored to the operator console by default; only transcript output from
Omnigent is logged.

## Policy Bridge

`policy_mode` controls whether Stagecraft renders workstream constraints into an
Omnigent policy file:

| Value | Behavior |
|---|---|
| `off` | Default. Stagecraft includes constraints in the prompt and keeps post-hoc write audit/gate validation as the enforcement backstop. |
| `file` | Writes a private temporary JSON policy file and passes `--policy-file <path>` to Omnigent. The file is removed after the process exits. |

The generated policy includes:

- the workstream, stage, and role
- `allowedWrites` as filesystem write allowlist input
- shell/network requirements from the stage definition
- the host-neutral role tool budget from `core/roles.js`
- an explicit note that Stagecraft still performs post-run write audit and gate
  validation

This is a tool-call-time enforcement request to Omnigent, not a replacement for
Stagecraft validation. If the selected Omnigent harness ignores or cannot enforce
the policy file, Stagecraft still audits writes after the run and blocks on
missing or malformed gates exactly as before.
The audit ignores Omnigent/Codex runtime-home cache writes under
`.codex-tmp/omnigent-codex-home-*`; normal project paths remain subject to the
workstream `allowedWrites` list.

## Session Evidence

When Omnigent output includes session or conversation identifiers, Stagecraft
records adapter-private evidence beside the workstream transcript:

```text
pipeline/logs/<workstreamId>.omnigent.json
```

The sidecar uses schema `stagecraft.omnigent.evidence.v1` and may include:

- Omnigent `session_id` and `conversation_id`
- policy verdict counts (`allow`, `deny`, `warn`, `block`)
- the related transcript path
- workstream, stage, role, host, and observation timestamp

It deliberately does not add fields to gate JSON, does not retain prompt text,
does not keep raw transcript excerpts, and does not store raw policy lines.
This gives operators a pointer back to the Omnigent session while preserving
Stagecraft's host-neutral gate schemas and evidence export posture.

## Experimental Director Mode

By default, Stagecraft dispatches one Omnigent process per workstream. For
all-Omnigent multi-workstream stages, an explicit prototype mode can ask one
Omnigent director session to coordinate the planned child workstreams:

```bash
devteam stage build --headless --experimental-omnigent-director
```

Guardrails:

- every planned workstream for the stage must route to `omnigent`
- `--headless` is required
- `--skip-completed` is rejected until partial-resume semantics are designed
- the director must write the normal child gates, such as
  `pipeline/gates/stage-04.backend.json` and
  `pipeline/gates/stage-04.qa.json`
- Stagecraft does not write or consume a director gate

The director prompt embeds each original child workstream prompt and lists every
expected child gate. After Omnigent exits, Stagecraft maps the result back onto
the normal workstream result list and then uses the same merge, validation,
write-audit, and `devteam next` behavior as ordinary fan-out. Missing or
malformed child gates block the stage exactly as they do without director mode.

Mixed routing:

```yaml
routing:
  default_host: claude-code
  roles:
    backend: omnigent
    verifier: omnigent
```

Policy-file bridging is opt-in. Until `policy_mode: file` is enabled, allowed
writes remain post-hoc audited by Stagecraft and tool budgets/stoplists remain
prompt-only for Omnigent.

## Follow-Up Phases

Parent tracking issue: [#291](https://github.com/telus-labs/stagecraft/issues/291).

1. **Configurable Omnigent launch profile** ([#292](https://github.com/telus-labs/stagecraft/issues/292)). Implemented in the Phase 24.2 slice:
   `hosts.omnigent.*` config fields select harness, model, server URL,
   no-session/session/resume mode, agent spec path, and safe extra args while
   preserving `DEVTEAM_HEADLESS_COMMAND` as the emergency override.
2. **Prompt transport hardening** ([#293](https://github.com/telus-labs/stagecraft/issues/293)). Implemented in the Phase 24.3 slice:
   default to Omnigent's current `--prompt` one-shot path, support stdin, retain
   opt-in `--prompt-file` compatibility for CLIs that expose it, and classify OS
   command-length failures as prompt transport errors.
3. **Policy bridge** ([#294](https://github.com/telus-labs/stagecraft/issues/294)). Implemented in the Phase 24.4 slice:
   `policy_mode: file` maps Stagecraft `allowedWrites`, shell/network
   requirements, and tool budgets into a temporary Omnigent policy file while
   keeping Stagecraft's post-hoc audit as the backstop.
4. **Session evidence** ([#295](https://github.com/telus-labs/stagecraft/issues/295)). Implemented in the Phase 24.5 slice:
   capture Omnigent conversation/session IDs and policy verdict counts in an
   adapter-private log sidecar without adding host-specific fields to gate
   schemas.
5. **Optional stage consolidation** ([#296](https://github.com/telus-labs/stagecraft/issues/296)). Implemented as an experimental prototype:
   `--experimental-omnigent-director` lets one Omnigent director session handle
   all planned workstreams for an all-Omnigent multi-workstream stage while
   preserving the existing child gate contract. It does not replace Stagecraft
   fan-out by default.

Next roadmap: [Phase 25](../plans/phase-25-omnigent-director-hardening.md) is
proposed and parked under [#305](https://github.com/telus-labs/stagecraft/issues/305).
It tracks director dogfooding, partial resume semantics, director session
evidence, policy conformance, and remote execution topology decisions.

## Non-Goals

- Do not move Stagecraft's gate validator or `next()` decision logic into
  Omnigent.
- Do not add Omnigent-specific fields to the host-neutral gate schema.
- Do not claim tool-call-time enforcement until Omnigent policy integration is
  wired and tested through the adapter.
- Do not make Omnigent the only route to multi-model execution; Stagecraft's
  existing per-role host routing remains supported.
