// Path helpers for B9 — bounded workspace isolation.
//
// When isolation === "bounded", in-flight feature artifacts live under
// pipeline/changes/<changeId>/ instead of the global pipeline/. All
// path construction in the orchestrator, headless runner, and adapters
// goes through these helpers so the change is contained in one file.
//
// changeId === null → in-place mode (the default); all helpers return
// the same paths they always did, so callers need no conditional logic.

const path = require("node:path");

// Root of the pipeline artifact tree for a given change.
// null changeId → <cwd>/pipeline  (in-place, historical behavior)
// non-null      → <cwd>/pipeline/changes/<changeId>
function pipelineRoot(cwd, changeId) {
  return changeId
    ? path.join(cwd, "pipeline", "changes", changeId)
    : path.join(cwd, "pipeline");
}

function gatesDir(cwd, changeId) {
  return path.join(pipelineRoot(cwd, changeId), "gates");
}

function logsDir(cwd, changeId) {
  return path.join(pipelineRoot(cwd, changeId), "logs");
}

// Rewrite a pipeline/-relative path to its bounded form.
//   "pipeline/brief.md"          → "pipeline/changes/<id>/brief.md"
//   "pipeline/gates/stage-01.json" → "pipeline/changes/<id>/gates/stage-01.json"
//   "AGENTS.md"                  → "AGENTS.md"  (not pipeline-relative; unchanged)
//
// Path separators are normalized to forward slashes so the comparison is
// stable across platforms and the prompt text looks consistent.
function prefixPipelineRelative(relPath, changeId) {
  if (!changeId || !relPath) return relPath;
  const normalized = relPath.replace(/\\/g, "/");
  if (!normalized.startsWith("pipeline/")) return relPath;
  return path.join("pipeline", "changes", changeId, normalized.slice("pipeline/".length));
}

// Paths Stagecraft itself owns in a target project: its own state, and the
// per-host surfaces `devteam init` lays down. None of them is ever part of the
// change under review, so every "what changed?" reader filters them out —
// the changed-file manifest, right-sizing's role inference, and the file list
// `assess` scores a track from.
//
// This list used to be copy-pasted into each of those three readers, and all
// three drifted the same way: they covered `.codex/` and nothing else, so an
// operator who ran `devteam init --host claude-code` and had not yet committed
// got 68 framework files reported as their diff. In `assess` that was not just
// noise — `.claude/skills/qa-test-authoring/SKILL.md` matches the security
// heuristic's `/auth/i` on the word "authoring", which promoted a trivial
// change from `loop` (4 dispatches) to `full` (20+). One shared predicate is
// what stops the three from drifting apart again.
//
// The roots are static rather than read from hosts/*/adapter.js: this module is
// a zero-dependency leaf that the render path and the guards both sit on, and
// it must not pull in the router. tests/context-manifest.test.js reads every
// hosts/*/capabilities.json and fails when a declared skillsDir or
// rolePromptsDir root is missing here.
const FRAMEWORK_OWNED_PREFIXES = [
  ".git/",
  ".devteam/",
  ".devteam-tmp/",
  "pipeline/",
  // host install surfaces — keep in lockstep with hosts/*/capabilities.json
  ".acp/",
  ".agents/",
  ".claude/",
  ".codex/",
  ".codex-tmp/",
  ".omnigent/",
  ".openai-compat/",
];

// True when `file` is Stagecraft-owned rather than part of the subject change.
// Matching is on a full path segment, so a project's own `.claude-notes/` or
// `src/agents/` is never swallowed by a prefix that merely looks similar.
function isFrameworkOwnedPath(file) {
  const rel = String(file || "").replace(/\\/g, "/").replace(/^\.\//, "").replace(/^\/+/, "");
  if (!rel) return false;
  return FRAMEWORK_OWNED_PREFIXES.some(
    (prefix) => rel === prefix.slice(0, -1) || rel.startsWith(prefix),
  );
}

module.exports = {
  pipelineRoot,
  gatesDir,
  logsDir,
  prefixPipelineRelative,
  FRAMEWORK_OWNED_PREFIXES,
  isFrameworkOwnedPath,
};
