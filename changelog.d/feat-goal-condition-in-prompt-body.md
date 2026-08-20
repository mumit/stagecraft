- **Convergence conditions moved from `/goal` into the prompt body
  ([ADR-023](docs/adr/023-goal-condition-in-prompt-body.md)).** `build` and `qa`
  declare a `goalCondition`, which was delivered as claude-code's
  `/goal "<condition>"` slash command. That handler rejects input over 4,000
  characters — and in `--print` mode the limit applies to the whole piped
  prompt, not the condition — so the orchestrator's fallback chain **discarded
  the inlined framework from every `build` and `qa` dispatch** to make room,
  dropping `patchItems` first. Measured on the dispatch path, that bought a
  directive which survived only when few files were dirty: at 3 changed files
  `/goal` fit, at 12 it did not. The condition is now rendered as a
  `## Done when` section in the prompt itself, so it survives at any prompt
  size and reaches all seven hosts rather than the two that declared
  `goalLoop`. On a four-file project the bytes actually sent to `build` go from
  3,621 to 23,369, with the framework inlined again.
- **`capabilities.goalLoop` and `capabilities.promptCharLimit` are removed from
  the adapter contract.** Both described one Claude Code slash-command handler
  rather than a host property; prompts are piped to stdin, so no host has an
  argv ceiling. `codex` had declared `goalLoop: true` despite `codex exec`
  having no slash-command layer, so it was paying the full content-dropping
  cost for a directive it could not act on. The `shrinkComposedPrompt` fallback
  chain is removed with them. `devteam chat`'s prompt budgets, which read
  `promptCharLimit` incidentally, are now explicit named constants instead of
  inheriting a 4,000-char bound that never applied to them. *Honest scope note:*
  convergence is now advisory — a prompt line asks the model to keep going where
  `/goal` asked the host's own loop to. The mechanism that actually re-dispatches
  a stage whose gate does not pass is the driver's fix-and-retry loop (ADR-003),
  and always was.
