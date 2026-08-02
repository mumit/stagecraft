// OpenAI-compatible host adapter.
//
// Routes Stagecraft roles to any provider that exposes an OpenAI-compatible
// Chat Completions endpoint — OpenAI, OpenRouter, Fireworks AI, Fuel iX,
// hosted open-weight providers, or internal gateways — without requiring a
// dedicated CLI tool. Invocation is HTTP-native (httpNative: true in
// capabilities); the agentic tool-call loop lives in invoke.js.
//
// Capability deltas vs claude-code:
//   - no hooks          → gate polling is orchestrator-driven (no SubagentStop)
//   - no subagents      → each workstream dispatches sequentially in its HTTP loop
//   - no headlessCommand → invoke() bypasses runHeadless entirely
//   - shell via bash()  → roles with "Bash" in toolBudget receive a direct,
//                         allowlisted command executor
//
// Configuration (.devteam/config.yml):
//   hosts:
//     openai-compat:
//       base_url: https://api.openai.com/v1
//       api_key_env: OPENAI_API_KEY
//       models:
//         default: gpt-4.1-mini
//         principal: gpt-4.1
//         security: gpt-4.1
//         red-team: gpt-4.1
//         migrations: gpt-4.1
//         qa: gpt-4.1-mini
//         verifier: gpt-4.1
//       caching:
//         enabled: false  # phase 32.1: cache_control breakpoints for
//                          # Anthropic-compatible endpoints reached through
//                          # this HTTP-native adapter (see invoke.js)

const capabilities = require("./capabilities.json");
const { makeMarkdownHostAdapter } = require("../../core/adapters/markdown-host");
const { invoke } = require("./invoke");

const { install, uninstall, status, renderStagePrompt, renderStagePromptLayers } =
  makeMarkdownHostAdapter(capabilities);

module.exports = {
  capabilities,
  install,
  uninstall,
  status,
  renderStagePrompt,
  renderStagePromptLayers,
  invoke,
};
