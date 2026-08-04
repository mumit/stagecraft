<!-- generated: do not hand-edit -->
<!-- To regenerate: npm run docs:generate (source: hosts/*/capabilities.json) -->

# Host Capability Reference

Derived from `hosts/*/capabilities.json`. 7 host adapters.
Run `npm run docs:generate` to regenerate after editing capabilities files.

### Capabilities

| Host          | Display name                           | headless | hooks | subagents | slashCommands | worktrees | goalLoop | telemetry |
| ------------- | -------------------------------------- | -------- | ----- | --------- | ------------- | --------- | -------- | --------- |
| acp           | Agent Client Protocol                  | yes      | no    | no        | no            | no        | no       | estimated |
| antigravity   | Antigravity CLI                        | yes      | no    | no        | no            | yes       | no       | estimated |
| claude-code   | Claude Code                            | yes      | yes   | yes       | yes           | yes       | yes      | native    |
| codex         | Codex CLI                              | yes      | no    | no        | no            | yes       | yes      | native    |
| generic       | Generic CLI (no host integration)      | no       | no    | no        | no            | no        | no       | estimated |
| omnigent      | Omnigent                               | yes      | no    | no        | no            | no        | no       | estimated |
| openai-compat | OpenAI-compatible Chat Completions API | yes      | no    | no        | no            | no        | no       | native    |

`telemetry`: `native` — token usage is parsed from the host CLI/API's own output (see docs/cost.md). `estimated` — no native capture; the orchestrator records a promptBytes/4 estimate flagged with `tokens_estimated: true`.

### Enforcement levels

How each host enforces the framework's core rules:

| Host          | allowed_writes | stoplist       | shell        | network      | tool_budget |
| ------------- | -------------- | -------------- | ------------ | ------------ | ----------- |
| acp           | tool-call-time | tool-call-time | enforced     | enforced     | prompt-only |
| antigravity   | post-hoc-audit | prompt-only    | enforced     | enforced     | prompt-only |
| claude-code   | tool-call-time | tool-call-time | enforced     | enforced     | native      |
| codex         | post-hoc-audit | prompt-only    | enforced     | enforced     | prompt-only |
| generic       | prompt-only    | prompt-only    | not enforced | not enforced | prompt-only |
| omnigent      | post-hoc-audit | prompt-only    | enforced     | enforced     | prompt-only |
| openai-compat | post-hoc-audit | prompt-only    | enforced     | enforced     | prompt-only |

### Headless commands

Command the orchestrator spawns in `--headless` mode:

| Host          | headlessCommand                                                                     |
| ------------- | ----------------------------------------------------------------------------------- |
| acp           | npx -y @agentclientprotocol/claude-agent-acp                                        |
| antigravity   | agy --print --dangerously-skip-permissions                                          |
| claude-code   | claude --dangerously-skip-permissions --print --output-format stream-json --verbose |
| codex         | codex exec --sandbox workspace-write --json                                         |
| omnigent      | omnigent run .omnigent/stagecraft/agent --no-session                                |
| openai-compat | —                                                                                   |

### Enforcement level glossary

| Level | Meaning |
| ----- | ------- |
| `tool-call-time` | Blocked at the tool-call boundary before the write reaches disk. |
| `post-hoc-audit` | Checked after the workstream exits via git-status diff; violations fail the gate. |
| `prompt-only` | Advisory only — written into the prompt; not technically enforced. |
| `enforced` | Capability is declared and enforced (boolean enforcement fields). |
| `not enforced` | Capability is absent or disabled for this host. |

<!-- /generated -->
