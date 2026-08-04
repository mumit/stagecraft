// Gemini CLI host adapter.
//
// Moved out of hosts/ into this plugin package by phase 34.4 (completes
// 28.6) — see README.md in this directory for why and for the honest
// scope note on relative-require resolution. Adapter contract and
// behavior are otherwise unchanged.
//
// install: copies roles/*.md verbatim into <target>/.gemini/prompts/roles/
//          (gemini consumes plain markdown — no frontmatter), renders
//          rules/*.md into <target>/.devteam/rules/ to satisfy "Read
//          first" references, and copies skills/*/SKILL.md to
//          <target>/.gemini/skills/<name>/.
// renderStagePrompt: emits a Gemini-CLI-idiomatic prompt that points
//          at the installed role prompt.
// status: verifies installed files exist and are non-empty.
// uninstall: removes the install payload.
//
// Capability deltas (vs claude-code):
//   - no hooks            → no auto-validate; users run `devteam
//                           validate` manually or via shell aliases
//   - no slash commands   → users invoke `devteam` directly from
//                           the terminal
//   - no subagents        → orchestrator runs each workstream in
//                           its own gemini session
//   - headless: true      → `gemini` reads from stdin; DEVTEAM_
//                           HEADLESS_COMMAND env var overrides the
//                           bin if your gemini install uses a
//                           different name (e.g. `gemini-cli`)

const capabilities = require("./capabilities.json");
const { runHeadless } = require("../../core/adapters/headless");
const { makeMarkdownHostAdapter } = require("../../core/adapters/markdown-host");

const { install, uninstall, status, renderStagePrompt, renderStagePromptLayers } = makeMarkdownHostAdapter(capabilities);

function invoke(descriptor, ctx, preRenderedPrompt) {
  return runHeadless(module.exports, descriptor, ctx, preRenderedPrompt);
}

module.exports = {
  capabilities,
  install,
  uninstall,
  status,
  renderStagePrompt,
  renderStagePromptLayers,
  invoke,
};
