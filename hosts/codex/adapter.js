// Codex CLI host adapter.
//
// install: copies roles/*.md verbatim into <target>/.codex/prompts/roles/
//          (codex consumes plain markdown — no frontmatter) and renders
//          rules/*.md into <target>/.devteam/rules/ to satisfy "Read first"
//          references in the role briefs.
// renderStagePrompt: emits a Codex-idiomatic prompt that points at the
//          installed role prompt and inlines the gate skeleton.
// status:  verifies installed files exist and are non-empty.
// uninstall: removes the files install() laid down.
//
// Capability deltas vs claude-code:
//   - no subagents      → orchestrator runs each workstream as its own
//                         codex session
//   - no hooks          → enforcement of allowed_writes/stoplist is
//                         prompt-only; the post-hoc gate validator catches
//                         violations after the fact
//   - no slash commands → users invoke `devteam` from the terminal directly
//   - headless: true    → `codex exec --sandbox workspace-write`
//                         can drive this non-interactively

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
