# Host Adapter Contract

The minimum a new host (Claude Code, Codex, Gemini CLI, plain terminal, …) must implement to plug into the Stagecraft core.

The core never calls a model. The adapter is the only place that knows about the host's invocation primitives. Adding a host = implementing this file's contract.

A project may have one or more adapters installed simultaneously. The orchestrator selects which adapter handles each stage via `routing` config in the target project's `.devteam/config.yml` — keyed by role with a per-stage override. Adapters don't need to know about routing; from each adapter's perspective, it gets called for a stage and does its job.

## Shape

A built-in host adapter is a directory under `hosts/<name>/` containing at
minimum:

```
hosts/<name>/
├── adapter.js           ← implements the methods below
├── capabilities.json    ← what this host supports
└── install/             ← files laid down in target project at `devteam init`
```

External adapters use the same exported `adapter.js` contract and may be
installed as npm packages named `@devteam/host-<name>`. For example,
`npm install @devteam/host-acme` makes the `acme` host discoverable to
`devteam hosts`, `devteam init --host acme`, and normal routing resolution
when the package is installed under the current project's `node_modules`.
The package may expose either `adapter.js` at its package root or a package
entrypoint that exports the adapter object. `packages/host-gemini-cli/` in
this repo (phase 34.4) is a concrete example — a first-party-*maintained*
adapter that isn't first-party-*shipped*, published as `@devteam/host-gemini-cli`.

## capabilities.json

Declarative. Read by the orchestrator to branch behavior. Unknown keys are ignored, missing keys default to `false`.

```json
{
  "name": "claude-code",
  "displayName": "Claude Code",
  "version": "1",
  "hooks": true,
  "subagents": true,
  "slashCommands": true,
  "worktrees": true,
  "headless": true,
  "headlessCommand": "claude --print",
  "skillFormat": "markdown",
  "skillsDir": ".claude/skills",
  "commandsDir": ".claude/commands",
  "enforces": {
    "allowed_writes": "tool-call-time",
    "stoplist": "tool-call-time"
  }
}
```

Capability semantics:

| Key              | What it enables                                                       | Fallback when false             |
|------------------|-----------------------------------------------------------------------|---------------------------------|
| `hooks`          | Auto-advance pipeline when a gate file is written                     | Orchestrator polls the gate file |
| `subagents`      | Fan out workstreams (Backend / Frontend / Platform) in parallel       | Sequential stage execution      |
| `slashCommands`  | Install `/devteam:*` slash commands                                   | User invokes `devteam` from terminal |
| `worktrees`      | Host exposes a native worktree/workspace primitive for adapter-specific flows | Core-managed `pipeline.workstream_isolation: git-worktree` remains available for parallel headless builds; otherwise shared checkout |
| `headless`       | Adapter can drive the host non-interactively (`cli-driven` mode)      | `user-driven` only              |
| `enforces.<rule>`| Where the host enforces a core rule. Values: `tool-call-time` (blocked at write — hooks), `post-hoc-audit` (orchestrator write-audit diffs git state before/after invoke; unauthorized writes flip the gate to FAIL, while narrow runtime caches such as Python `__pycache__/*.pyc` are ignored), `prompt-only` (advisory only; no automated enforcement). | See `core/guards/write-audit.js`. |
| `enforces.shell` | `true` if the agent can execute command-line tools (for example through a bash tool or direct-command executor). Required by pre-review, qa, verification-beyond-tests, deploy. | Orchestrator refuses dispatch with a named error. |
| `enforces.network` | `true` if the agent can make outbound network requests. | Orchestrator refuses dispatch with a named error. |
| `goalLoop`       | Host supports a session-level convergence directive (`/goal "condition"`). When `true`, the orchestrator prepends `/goal "…"` to the prompt for stages that declare `goalCondition`. | Prompt is sent as-is; no goal loop. |

`headlessCommand` is parsed into an executable plus argument vector and passed
directly to `spawn()`; Stagecraft does not invoke a shell. Quote arguments or
absolute executable paths that contain spaces, for example
`"C:\Program Files\Vendor\agent.exe" --print`.

Headless subprocess stdout/stderr is written to
`pipeline/logs/<workstreamId>.log` by default. It is not mirrored to the
terminal unless `DEVTEAM_HEADLESS_TEE=1`, `DEVTEAM_VERBOSE=1`, or `ctx.tee`
is enabled, so autonomous runs do not dump prompts or large diffs into the
operator console.

## adapter.js methods

```ts
interface HostAdapter {
  capabilities: Capabilities;            // loaded from capabilities.json

  // 1. INSTALL — called by `devteam init --host <name>` in a target project.
  // Lays down skills, commands, hooks, agent files from `install/`,
  // and renders shared roles from `roles/*.md` into the host-expected path.
  install(targetDir: string, opts: InstallOpts): Promise<InstallResult>;

  // 2. RENDER STAGE PROMPT — given a stage descriptor from core, return the
  // text the user (or the host's CLI) should consume to perform the stage.
  // Host-specific because skill-loading syntax differs (e.g. Claude Code
  // uses "Use the implement skill", Codex uses an explicit prompt path).
  renderStagePrompt(stage: StageDescriptor, ctx: PipelineContext): string;

  // 3. INVOKE — optional, only if capabilities.headless = true.
  // Run the host non-interactively for a stage. Returns the exit code and
  // the gate JSON path the host wrote. user-driven mode skips this entirely.
  invoke?(stage: StageDescriptor, ctx: PipelineContext, preRenderedPrompt?: string): Promise<InvokeResult>;

  // 4. STATUS — verify the install is healthy in a target project.
  // Called by `devteam doctor`. Returns missing/broken pieces.
  status(targetDir: string): Promise<StatusReport>;

  // 5. UNINSTALL — best-effort cleanup of the install payload.
  uninstall(targetDir: string): Promise<void>;
}

interface InstallOpts {
  isolation: "in-place" | "bounded";     // pipeline artifact placement; default "in-place"
  force: boolean;                        // overwrite existing files
  roles: string[];                       // which roles/*.md to render (default: all)
}

interface InstallResult {
  written: string[];                     // files created
  skipped: string[];                     // files left alone (already present)
  warnings: string[];
}

interface StageDescriptor {
  stage: string;                         // "stage-04"
  name: string;                          // "build"
  role: string;                          // the role THIS dispatch is for (single)
  rolesInStage: string[];                // all roles in this stage (context)
  workstreamId: string;                  // "stage-04.backend" for multi-role; "stage-01" otherwise
  objective: string;
  readFirst: string[];
  allowedWrites: string[];
  artifact: string;                      // "pipeline/build-plan.md"
  template: string;                      // "build-template.md"
  expectedGate: object;                  // JSON Schema for the gate file
  goalCondition: string | null;          // Convergence condition for goal-loop hosts; null if none
  disableTools?: boolean;                // Offer/permit no tools; fail closed where the protocol supports it
}

interface PipelineContext {
  track: "full" | "quick" | "nano" | "hotfix" | ...;
  feature: string;                       // free-text title
  cwd: string;
  isolation: "in-place" | "isolated";
  captureOutput?: boolean;               // Return bounded assistant text without enabling transcript logs
}

interface InvokeResult {
  exitCode: number;
  gatePath: string | null;
  durationMs: number;
  output?: string;                       // Present only when captureOutput was requested and supported
}

interface StatusReport {
  ok: boolean;
  missing: string[];
  stale: string[];                       // files older than current core version
  notes: string[];
}
```

`preRenderedPrompt` is optional for external callers and required when the
orchestrator has composed or reduced the exact prompt that must be sent. An
adapter must send it verbatim when present. Core one-off workflows use
`core/adapters/invoke-task.js`, which creates a narrowly scoped synthetic
descriptor and calls this same method; they do not parse `headlessCommand` or
spawn a model process. A headless adapter therefore must implement `invoke()`
even when it also declares `headlessCommand`.

`captureOutput` is an additive adapter boundary used by read-only conversational
turns. A CLI adapter captures at most 256 KiB of parsed assistant stdout;
structured Claude/Codex streams are reduced to assistant text before capture.
HTTP-native OpenAI-compatible and ACP adapters return the equivalent assistant
content. It does not imply tool denial: `disableTools` is the separate request.
OpenAI-compatible hosts advertise no tools and reject a returned tool call; ACP
rejects every permission request. Same-user CLI processes must still be treated
as unsandboxed.

## Lifecycle: how a stage actually runs

A stage definition in `core/pipeline/stages.js` carries `roles: string[]` (1+ roles). The orchestrator **decomposes** a stage into one **workstream dispatch** per role. Single-role stages (stage-01: `roles: ["pm"]`) decompose into a single dispatch — same code path as multi-role.

```
devteam stage build               (user types in terminal OR slash-command wrapper)
  │
  ├─► core/orchestrator loads stage definition (stage-04, roles=[backend, frontend, platform, qa])
  ├─► core/guards check stoplist, allowed-writes
  │
  ├─► for each role in stage.roles:                         ◄── per-workstream dispatch
  │     ├─► core/router picks adapter:
  │     │     routing.stages[stage] → routing.roles[role] → routing.default_host
  │     ├─► build StageDescriptor with role, workstreamId
  │     ├─► adapter.renderStagePrompt(descriptor, ctx) ──► prompt text
  │     ├─► if adapter.capabilities.headless && mode=cli-driven:
  │     │     adapter.invoke(descriptor, ctx)
  │     │   else (user-driven):
  │     │     print prompt, wait
  │     │
  │     ├─► poll/event: workstream gate appears at
  │     │     pipeline/gates/stage-04.<role>.json
  │     └─► core/gates/validator.js validates that workstream entry
  │
  ├─► core/orchestrator merges per-workstream gates into pipeline/gates/stage-04.json
  ├─► stage status = PASS iff every workstream entry is PASS
  └─► advance, escalate, or halt
```

Because routing happens per workstream, a single stage can dispatch to multiple hosts: in the example, `backend` might go to `codex` while `frontend`/`platform`/`qa` go to `claude-code`. The gate JSON contract is what makes that handoff safe — the next stage reads the same artifacts regardless of who produced them.

### Multi-role stages — orchestrator responsibilities

The orchestrator (not the adapter) owns:

1. **Decomposition.** Iterate `stage.roles`, build one `StageDescriptor` per role.
2. **Dispatch fan-out.** Decide serial vs parallel based on the dispatched adapters' capabilities. If all roles route to the same host and that host has `subagents: true`, the orchestrator MAY consolidate into a single host invocation that uses subagents. Otherwise each workstream is a separate invocation.
3. **Gate merge.** Read every `pipeline/gates/<stage>.<role>.json`, merge into `pipeline/gates/<stage>.json` with shape:
   ```json
   {
     "stage": "stage-04",
     "orchestrator": "devteam@1.0",
     "workstreams": [
       { "role": "backend",  "host": "codex",       "status": "PASS", "...": "..." },
       { "role": "frontend", "host": "claude-code", "status": "PASS", "...": "..." }
     ],
     "status": "PASS"
   }
   ```
4. **Adapters never see each other's output.** Each adapter writes its workstream gate and is done.

## Gate JSON identity fields

Every gate (workstream-level and stage-level) carries:

| Field          | Value                                  | Why                                   |
|----------------|----------------------------------------|---------------------------------------|
| `stage`        | `"stage-04"`                           | Which stage this gate belongs to.     |
| `workstream`   | `"backend"` (workstream gates only)    | Which role produced it.               |
| `orchestrator` | `"devteam@1.0"`                        | Core version that minted the gate.    |
| `host`         | `"codex"` (workstream gates only)      | Adapter that produced the workstream. |
| `status`       | `"PASS" | "WARN" | "FAIL" | "ESCALATE"`| Outcome.                              |

The legacy `agent` field is removed. Adapters MUST write `host` and `orchestrator`. Stage-level merged gates omit `workstream` and `host` and instead carry the `workstreams: []` array.

## Rules an adapter MUST follow

1. **Don't reimplement core logic.** No stage definitions, no gate schemas, no stoplist, no budget logic inside `adapter.js`. If you find yourself porting one, it belongs in `core/`.
2. **Don't write outside `install/` paths declared at install time.** Adapter writes are tracked and uninstallable.
3. **Don't mutate `roles/*.md`.** Roles are read-only inputs; the adapter renders them into the host's expected path (copy or transform), but the source of truth stays in `roles/`.
4. **Don't fail silently on missing capabilities.** If asked to do something `capabilities.json` says it can't do, throw — let the orchestrator handle the fallback.
5. **Idempotent install.** `install` called twice with the same opts is a no-op.

## Reference adapters

- `hosts/claude-code/` — full capabilities (hooks, subagents, slash commands, worktrees, headless via `claude --print`).
- `hosts/codex/` — skills + prompts, no hooks, headless via `codex exec --sandbox workspace-write`.
- `hosts/antigravity/` — skills + prompts, no hooks, headless via `agy --print --dangerously-skip-permissions`. Supported successor to `gemini-cli` (Gemini CLI stopped serving free/Pro/Ultra requests 2026-06-18).
- `packages/host-gemini-cli/` — skills + prompts, no hooks, headless via `gemini`. Deprecated upstream; `devteam doctor` warns when routing resolves to it. Phase 34.4 moved this out of `hosts/` into a `@devteam/host-gemini-cli` plugin package (the A4 mechanism below) — `devteam init --host gemini-cli` requires `npm install @devteam/host-gemini-cli` first.
- `hosts/omnigent/` — skills + prompts + `.omnigent/stagecraft/agent/config.yaml`, no hooks, headless via `omnigent run ... --no-session --prompt <prompt>`.
- `hosts/openai-compat/` — HTTP-native host; no CLI subprocess, talks to OpenAI-compatible Chat Completions APIs.
- `hosts/acp/` — [Agent Client Protocol](https://agentclientprotocol.com) client; skills + prompts, no hooks, `invoke()` speaks newline-delimited JSON-RPC 2.0 directly to the configured agent's stdio instead of piping a prompt through `core/adapters/headless.js`. Enforces allowed-writes and a dangerous-command stoplist at ACP's `session/request_permission` call time — the first non-claude-code host with call-time (rather than post-hoc or prompt-only) enforcement. Routing carries the agent's launch command inline (`routing.roles.<role>: acp:<agent-command>`), since there's no single default ACP binary the way there is for claude/codex/gemini.
- `hosts/generic/` — none of the above; only `renderStagePrompt` and a noop `install`. Proves the contract is genuinely host-agnostic.
