# openai-compat host adapter — design notes

> **Decision:** The shell-execution approach described here (Option A: native bash tool) was accepted in [ADR-013](adr/013-openai-compat-shell-execution.md). This document retains the full options analysis and implementation reasoning that informed that decision.

---

## 1. What "first-class" means

A first-class host in stagecraft can run every stage in every pipeline track without routing any workstream to a different host. The three existing hosts (claude-code, codex, gemini-cli) are all first-class on that definition. The openai-compat adapter, as introduced, was not: five stages with `requiredCapabilities: { shell: true }` threw a hard capability error before any prompt was sent.

This document covers the analysis that preceded the decision to extend openai-compat to full first-class status.

---

## 2. The five shell-dependent stages

| Stage | ID | Role | What the shell is used for |
|-------|-----|------|---------------------------|
| pre-review | stage-04a | platform | `npm test`, `eslint`, `npm audit`, license check |
| qa | stage-06 | qa | Run acceptance test suite against `src/tests/` |
| verification-beyond-tests | stage-06d | verifier | Property-based (`fast-check`), mutation (`stryker`), formal (`TLA+`) |
| performance-budget | stage-06e | qa | `lighthouse`, bundle size diff, `k6` load test |
| deploy | stage-08 | platform | Execute `pipeline/runbook.md` steps |

All five share the same pattern: the model reads context, decides what commands to run, runs them, and records results in a pipeline artifact and gate JSON. None require a separate agent runtime — they need a `bash()` call in the tool-call loop.

The capability check is in `core/orchestrator.js::assertCapabilities`. It compares `stageDef.requiredCapabilities` against `adapter.capabilities.enforces` and throws before dispatch if any required capability is missing. Setting `enforces.shell: true` in `capabilities.json` is the mechanical unblock; the tool must actually exist to be useful.

---

## 3. Options considered

### Option A — Add a `bash` tool to the openai-compat adapter *(chosen)*

Extend `hosts/openai-compat/tools.js` with a `bash(command)` function tool. The model calls it the same way it calls `write_file`. Execution parses the command string into argv, rejects shell syntax and non-allowlisted executables, uses Node.js `child_process.spawn` with a detached process group, returns stdout + stderr + exit code as the tool result, and the loop continues.

**What changes:** `tools.js` (BASH definition + executeBash), `capabilities.json` (shell: true), `buildTools()` (include bash when toolBudget has Bash), `executeTool()` (dispatch).

**Pros:**
- Zero new dependencies — pure `child_process`, already used in headless.js
- Architecturally coherent: the model makes decisions through tool calls, not prompt engineering
- No separate process to install or maintain
- Similar operational role to how claude-code exposes shell to subagents, with a narrower direct-command executor
- Solves all 5 blocked stages simultaneously

**Cons:**
- No OS sandboxing out of the box — allowlisted commands still run with the invoking process's permissions
- Adds a new attack surface: a coerced model could request allowed verification, package, or deploy commands

**Security verdict:** Narrower than a raw shell because shell syntax and non-allowlisted executables are rejected, but still not an OS sandbox. The threat model is a capable but trustworthy model executing approved project commands. Mitigation remains: run in CI with restricted credentials, review logs, and use post-hoc write audit as a tripwire.

---

### Option B — Route shell stages to a different host via `routing.stages`

Keep `openai-compat` shell: false and add per-stage overrides:

```yaml
routing:
  default_host: openai-compat
  stages:
    pre-review: claude-code
    qa:         claude-code
    deploy:     claude-code
```

**Pros:** No code changes. Fine-grained per-stage control.

**Cons:** Requires claude-code (or codex) installed — defeats the "no additional CLI" goal. Not first-class operation. Adds config complexity.

**Verdict:** Valid workaround documented in the example config before this work. Not sufficient for first-class status.

---

### Option C — Build a thin `stagecraft-shell` CLI wrapper

A Node.js script (`bin/stagecraft-shell`) that accepts a prompt on stdin, calls an OpenAI-compatible Chat Completions API, runs the 40-iter tool-call loop with bash included, and exits. The adapter uses it as its `headlessCommand`.

**Pros:** Could be published as a standalone open-source tool. Explicit separation of concerns.

**Cons:** Reimplements `invoke.js` as a subprocess — duplicate logic that diverges over time. Adds a CLI binary to install and version-pin (the same problem as codex/gemini-cli). No practical advantage over Option A.

**Verdict:** Only worthwhile if the goal is a publishable standalone CLI. Out of scope.

---

### Option D — Allow-list model (`allowed_commands` config)

Add a `hosts.openai-compat.allowed_commands` section to `.devteam/config.yml` and reject any command not on the list.

**Pros:** Tighter security surface.

**Cons:** Fragile — projects use `yarn`, `pnpm`, `make`, `nx`, custom scripts. Stage prompts already enumerate what commands to run; duplicating that list in config is a maintenance burden. Model still has `write_file` with no command-level restriction; the security gain is marginal.

**Verdict:** Worth revisiting in a future hardening ADR. Not warranted for first-class operation. The `bash` tool reports failures and can emit full tool traces in verbose mode.

---

### Option E — OpenHands / external agent runtime

Route shell-stage dispatches to a sandboxed Docker-backed agent (OpenHands). stagecraft talks to its REST API instead of the chat-completions endpoint.

**Pros:** Docker-sandboxed shell execution. Purpose-built for software engineering tasks.

**Cons:** Requires a running service (Docker, OpenHands server). Adapter would need a completely different API client. Heavy infrastructure dependency for stages that just need `npm test`.

**Verdict:** Appropriate for security-critical production environments. Out of scope for this design.

---

## 4. The bash tool design

### Tool definition

```javascript
const BASH = {
  type: "function",
  function: {
    name: "bash",
    description:
      "Execute an allowlisted command in the project root and return stdout, stderr, and exit code. " +
      "Use for running tests, linters, build scripts, and deploy commands. " +
      "The command is parsed into argv and is not run through a shell. " +
      "Working directory is always the project root.",
    parameters: {
      type: "object",
      properties: {
        command: {
          type: "string",
          description: "Command to run at the project root. Use direct commands such as `npm test`, not shell syntax.",
        },
        timeout_ms: {
          type: "number",
          description: "Optional timeout in milliseconds. Defaults to 60000 (60 s).",
        },
      },
      required: ["command"],
    },
  },
};
```

### Execution model

- Parse the command string into argv, reject shell syntax, then `spawn()` one of the built-in allowlisted executables with `{ cwd, detached: true }`
- Kills the command's process group when the command exits or the timeout fires so child processes do not keep inherited stdout/stderr pipes open
- Captures stdout and stderr separately
- Returns a structured result string: `exit_code`, `stdout`, `stderr` (each truncated to 8 KB to prevent message bloat in long tool-call loops)
- Quiet mode logs writes, bash failures, and tool errors; verbose mode logs every tool call and result summary
- On timeout: returns `"error: command timed out after Nms"`
- Per-call `timeout_ms` argument; outer `ctx.timeoutMs` caps the full dispatch

### Tool selection — `buildTools()` logic

`bash` is included when the role's `toolBudget` (from `core/roles.js::ROLE_TOOLS`) contains `"Bash"`:

| Role | Has Bash | Gets bash tool |
|------|----------|----------------|
| platform | ✓ | ✓ |
| qa | ✓ | ✓ |
| backend | ✓ | ✓ |
| frontend | ✓ | ✓ |
| verifier | ✓ | ✓ |
| principal | ✓ | ✓ |
| security | ✓ | ✓ |
| red-team | ✓ | ✓ |
| pm | ✗ | ✗ |
| reviewer | ✗ | ✗ |

---

## 5. Goal loop: is it needed?

Stages with `goalCondition` (build 04, qa 06) are designed for claude-code's re-invoke loop: if the gate has blockers, the orchestrator dispatches again with patch instructions until the condition is met.

For openai-compat, the 40-iteration tool-call loop serves the same purpose **within a single dispatch**: the model runs a command, sees it fail, patches the code, re-runs, and continues until it produces a passing gate — all within one HTTP session.

The key difference is **context accumulation**: claude-code's goal loop starts fresh each iteration (context is the gate blockers). openai-compat's loop accumulates the full conversation. In practice:

- Build stage: brief + design spec + code reads + bash output per attempt
- 40 iterations × ~2 KB per tool result ≈ 80 KB additional context
- Long-context models with reliable native `tool_calls` handle this best

The existing 40-iteration loop is sufficient for first-class operation. No separate goal-loop implementation is needed. The driver's re-dispatch mechanism (classifying no-gate as `transient`) remains available as a fallback.

---

## 6. Security model

| Risk | Mitigation |
|------|-----------|
| Model runs `rm -rf /` | Same risk as claude-code; defense is reviewing the model's plan before approving stages |
| Model runs `git push --force` | Post-hoc write audit catches unexpected git state; logs are retained |
| Infinite bash loop | `timeout_ms` per call + `MAX_TOOL_ITERATIONS` cap total iterations |
| Secret leakage via command output | Same exposure as `read_file`; no incremental risk |
| Prompt injection via command output | Output is returned as tool message content (data), not as system instructions |

---

## 7. What first-class operation looks like

A complete all-openai-compat config — no claude-code, no codex, no other CLI. The example below uses OpenAI model IDs; swap `base_url`, `api_key_env`, and model IDs for OpenRouter, Fireworks AI, Fuel iX, DeepSeek-compatible endpoints, Moonshot-compatible endpoints, or an internal gateway.

```yaml
routing:
  default_host: openai-compat

hosts:
  openai-compat:
    base_url: https://api.openai.com/v1
    api_key_env: OPENAI_API_KEY
    models:
      default:    gpt-4.1-mini
      principal:  gpt-4.1
      security:   gpt-4.1
      red-team:   gpt-4.1
      migrations: gpt-4.1
      platform:   gpt-4.1-mini
      backend:    gpt-4.1-mini
      frontend:   gpt-4.1-mini
      reviewer:   gpt-4.1-mini
      qa:         gpt-4.1-mini
      verifier:   gpt-4.1
      pm:         gpt-4.1
```

Every stage runs. One API key for the configured provider. No CLI installation.

---

## 8. Out of scope

| Feature | Rationale |
|---------|-----------|
| `worktrees: true` | Requires git-worktree support on the local machine; low value add for the HTTP model |
| `hooks: true` | Hooks are claude-code-specific (SubagentStop, PostToolUse). Approval-derivation is orchestrator-driven |
| `subagents: true` | openai-compat dispatches sequentially; multi-agent fan-out via the orchestrator |
| convergence conditions | Rendered into the prompt as `## Done when` (ADR-023); the 40-iteration tool loop covers the iteration itself, see §5 |
| Allow-list for bash | Valid security concern; deferred to a future hardening ADR |
| Streaming output | Model output already streamed to stdout in invoke.js |
