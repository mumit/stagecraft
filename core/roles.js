// Source of truth for the available role names and per-role tool budgets.
//
// The role list is derived from `roles/*.md` — adding a role brief there
// makes it visible to every host adapter automatically. Previously each
// adapter declared its own role list; auditor's addition surfaced the
// friction (three places to update for one new role).
//
// ROLE_TOOLS is the host-neutral per-role tool-budget table (G10 / 6.1).
// Previously this lived in hosts/claude-code/adapter.js (ROLE_FRONTMATTER),
// so only claude-code dispatches ever got a non-null budget — codex, gemini-cli,
// and generic dispatches returned null, and the prompt-only advisory never
// rendered. Moving the table here lets the orchestrator resolve the budget
// before knowing which host will handle the workstream.
//
// Per-host *customization* (claude-code's ROLE_FRONTMATTER with model, name,
// description, permissionMode) still lives in the adapter. That module imports
// toolBudgetFor() from here so the tools value stays in one place.

const fs = require("node:fs");
const path = require("node:path");

const ROLES_DIR = path.resolve(__dirname, "..", "roles");

// Per-role tool budget as comma-separated Claude Code tool names.
// The claude-code adapter reads these to build subagent frontmatter;
// all adapters receive them via descriptor.toolBudget (orchestrator-stamped).
const ROLE_TOOLS = {
  pm:         "Read, Write, Glob",
  principal:  "Read, Write, Glob, Grep, Bash",
  reviewer:   "Read, Write, Glob, Grep",
  security:   "Read, Write, Glob, Grep, Bash",
  backend:    "Read, Write, Edit, Glob, Grep, Bash",
  frontend:   "Read, Write, Edit, Glob, Grep, Bash",
  platform:   "Read, Write, Edit, Glob, Grep, Bash",
  qa:         "Read, Write, Edit, Glob, Grep, Bash",
  auditor:    "Read, Glob, Grep, Bash, Write",
  "red-team": "Read, Glob, Grep, Bash, Write",
  migrations: "Read, Glob, Grep, Bash, Write",
  verifier:   "Read, Glob, Grep, Bash, Write",
  // 30.3: the Reflector's dispatch prompt embeds everything it needs (gate
  // summaries, run-log excerpt, promoted patterns) — no Write, it only ever
  // emits JSON to stdout.
  reflector:  "Read, Glob, Grep",
};

// Return the declared tool budget for a role as a string array, or null if
// the role is unknown. Called by the orchestrator (host-neutral budget
// resolution) and re-exported by the claude-code adapter (subagent frontmatter).
function toolBudgetFor(role) {
  const tools = ROLE_TOOLS[role];
  if (!tools) return null;
  return tools.split(", ").map((t) => t.trim()).filter(Boolean);
}

function listRoles() {
  if (!fs.existsSync(ROLES_DIR)) return [];
  return fs.readdirSync(ROLES_DIR)
    .filter((f) => f.endsWith(".md") && f !== "README.md")
    .map((f) => f.replace(/\.md$/, ""))
    .sort();
}

module.exports = { listRoles, toolBudgetFor, ROLES_DIR };
