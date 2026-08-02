// Antigravity CLI host adapter.
//
// Antigravity CLI (binary: `agy`) is Google's successor to Gemini CLI —
// Gemini CLI stopped serving free/Pro/Ultra requests 2026-06-18 (phase-28
// item 28.6; see plans/phase-28-ground-truth-telemetry.md). Confirmed
// against a live `agy --help` and one authenticated `agy --print` dispatch,
// not just public docs (some third-party "cheat sheet" sites returned by
// web search disagreed with the real binary — e.g. the actual global
// customization root is `~/.gemini/config/`, not the
// `~/.gemini/antigravity-cli/` path several of those pages claimed).
//
// install: copies roles/*.md verbatim into <target>/.agents/prompts/roles/
//          (agy consumes plain markdown — no frontmatter, same as
//          gemini-cli/codex), renders rules/*.md into <target>/.devteam/
//          rules/ to satisfy "Read first" references, and copies
//          skills/*/SKILL.md to <target>/.agents/skills/<name>/ — this
//          matches agy's own documented skill contract (a project-level
//          "customization root" at `.agents/` with a `skills/<name>/
//          SKILL.md` layout), so these also double as real agy skills,
//          not just files Stagecraft happens to own.
// renderStagePrompt: emits an Antigravity-idiomatic prompt that points at
//          the installed role prompt.
// status: verifies installed files exist and are non-empty.
// uninstall: removes the install payload.
//
// Capability deltas (vs claude-code):
//   - no hooks            → no auto-validate; users run `devteam
//                           validate` manually or via shell aliases.
//                           (agy plugins do support hooks.json, but
//                           Stagecraft does not wire into it here.)
//   - no slash commands   → users invoke `devteam` directly from
//                           the terminal
//   - no subagents        → orchestrator runs each workstream in
//                           its own agy session (agy does have an
//                           --agent flag / native agent concept, but
//                           Stagecraft doesn't dispatch to it — same
//                           stance as the codex adapter)
//   - goalLoop: false     → agy has no documented `/goal` convergence
//                           directive (that's a claude-code/codex-only
//                           slash command Stagecraft prepends itself)
//   - telemetry: estimated → agy's print/JSON output was not parsed for
//                           usage in this item; native capture is
//                           tracked separately under item 28.3
//   - headless: true      → `agy --print --dangerously-skip-permissions`
//                           reads the prompt from stdin (confirmed live);
//                           DEVTEAM_HEADLESS_COMMAND overrides the bin if
//                           your install uses a different name

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
