<!-- generated: do not hand-edit -->
<!-- To regenerate: npm run docs:generate (source: hosts/*/capabilities.json) -->

# Host Capability Reference

Derived from `hosts/*/capabilities.json`. 6 host adapters.
Run `npm run docs:generate` to regenerate after editing capabilities files.

### Capabilities

| Host          | Display name                           | headless | hooks | subagents | slashCommands | worktrees | goalLoop |
| ------------- | -------------------------------------- | -------- | ----- | --------- | ------------- | --------- | -------- |
| claude-code   | Claude Code                            | yes      | yes   | yes       | yes           | yes       | yes      |
| codex         | Codex CLI                              | yes      | no    | no        | no            | yes       | yes      |
| gemini-cli    | Gemini CLI                             | yes      | no    | no        | no            | yes       | no       |
| generic       | Generic CLI (no host integration)      | no       | no    | no        | no            | no        | no       |
| omnigent      | Omnigent                               | yes      | no    | no        | no            | no        | no       |
| openai-compat | OpenAI-compatible Chat Completions API | yes      | no    | no        | no            | no        | no       |

### Enforcement levels

How each host enforces the framework's core rules:

| Host          | allowed_writes | stoplist       | shell        | network      | tool_budget |
| ------------- | -------------- | -------------- | ------------ | ------------ | ----------- |
| claude-code   | tool-call-time | tool-call-time | enforced     | enforced     | native      |
| codex         | post-hoc-audit | prompt-only    | enforced     | enforced     | prompt-only |
| gemini-cli    | post-hoc-audit | prompt-only    | enforced     | enforced     | prompt-only |
| generic       | prompt-only    | prompt-only    | not enforced | not enforced | prompt-only |
| omnigent      | post-hoc-audit | prompt-only    | enforced     | enforced     | prompt-only |
| openai-compat | post-hoc-audit | prompt-only    | enforced     | enforced     | prompt-only |

### Headless commands

Command the orchestrator spawns in `--headless` mode:

| Host          | headlessCommand                                                                     |
| ------------- | ----------------------------------------------------------------------------------- |
| claude-code   | claude --dangerously-skip-permissions --print --output-format stream-json --verbose |
| codex         | codex exec --sandbox workspace-write                                                |
| gemini-cli    | gemini                                                                              |
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
