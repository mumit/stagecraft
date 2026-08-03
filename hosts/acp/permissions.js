// Map Stagecraft's core write/command rules onto ACP's
// `session/request_permission` request — the enforcement half of the ACP
// adapter (see hosts/acp/adapter.js).
//
// ACP hands the client (us) every tool call BEFORE it runs, with enough
// structure (kind, locations, rawInput) to make a real decision — unlike
// claude-code's own tool-call-time enforcement, which is a set of static
// permission globs configured once at install time
// (hosts/claude-code/adapter.js renderSettingsLocal: `Write(pipeline/**)`,
// not the exact per-workstream descriptor.allowedWrites list). ACP lets us
// check the *actual* dispatch's allowedWrites on every call, which is why
// capabilities.json declares allowed_writes: "tool-call-time" here rather
// than the post-hoc-audit every other non-claude-code host uses — per
// plans/phase-34-interop-auditable-sdlc.md §34.1, this is the first
// non-claude-code host with call-time enforcement.
//
// "stoplist" here mirrors claude-code's actual enforced deny-list
// (hosts/claude-code/adapter.js renderSettingsLocal → permissions.deny:
// `Bash(rm -rf *)`, `Bash(git push --force *)`, `Bash(git push -f *)`) —
// NOT core/guards/stoplist.js's topic-based patterns (auth/crypto/PII/…),
// which gate *track selection* for a whole run and would false-positive on
// completely ordinary full-track work that touches, say, `auth.js`.

const path = require("node:path");
const { isAllowed } = require("../../core/guards/write-audit");

// Parity list with hosts/claude-code/adapter.js's renderSettingsLocal()
// permissions.deny. Matched against the tool call's rawInput (typically
// `{ command: "..." }` for an "execute" kind call) and title — the closest
// ACP gets to claude-code's own Bash-argument glob matching.
const DANGEROUS_COMMAND_PATTERNS = [
  { name: "rm-rf", re: /\brm\s+(?:-\S+\s+)*-[a-zA-Z]*[rR][a-zA-Z]*[fF][a-zA-Z]*\b|\brm\s+(?:-\S+\s+)*-[a-zA-Z]*[fF][a-zA-Z]*[rR][a-zA-Z]*\b/ },
  { name: "git-push-force", re: /\bgit\s+push\b[^\n]*(--force\b|(?:^|\s)-f\b)/ },
];

const WRITE_KINDS = new Set(["edit", "delete", "move"]);

function commandText(toolCall) {
  const parts = [];
  if (typeof toolCall.title === "string") parts.push(toolCall.title);
  if (toolCall.rawInput !== undefined && toolCall.rawInput !== null) {
    try { parts.push(JSON.stringify(toolCall.rawInput)); } catch { /* non-serializable rawInput */ }
  }
  return parts.join("\n");
}

function findDangerousCommandMatch(toolCall) {
  const text = commandText(toolCall);
  if (!text) return null;
  for (const pattern of DANGEROUS_COMMAND_PATTERNS) {
    const m = text.match(pattern.re);
    if (m) return { name: pattern.name, matched: m[0] };
  }
  return null;
}

// Locations are absolute paths per the ACP schema; allowedWrites entries
// are project-relative (e.g. "pipeline/build-plan.md"). Paths outside cwd
// can't be relativized meaningfully — treat them as violations rather than
// silently allowing writes outside the project root.
function relativeToProject(absPath, cwd) {
  if (!path.isAbsolute(absPath)) return absPath.replace(/\\/g, "/");
  const rel = path.relative(cwd, absPath);
  if (rel.startsWith("..")) return null;
  return rel.replace(/\\/g, "/");
}

function findWriteViolation(toolCall, descriptor, cwd) {
  if (!WRITE_KINDS.has(toolCall.kind)) return null;
  const locations = Array.isArray(toolCall.locations) ? toolCall.locations : [];
  const allowedWrites = descriptor.allowedWrites || [];
  for (const loc of locations) {
    if (!loc || typeof loc.path !== "string") continue;
    const rel = relativeToProject(loc.path, cwd);
    if (rel === null || !isAllowed(rel, allowedWrites)) {
      return { path: loc.path, rel };
    }
  }
  return null;
}

// Evaluate one ACP toolCall against this dispatch's rules. Returns
// { deny: boolean, reason: string|null } — deny:false means allow.
function evaluateToolCall(toolCall, descriptor, cwd) {
  const violation = findWriteViolation(toolCall, descriptor, cwd);
  if (violation) {
    return {
      deny: true,
      reason: `allowed-writes: "${violation.rel || violation.path}" is not in this workstream's allowedWrites`,
    };
  }
  const dangerous = findDangerousCommandMatch(toolCall);
  if (dangerous) {
    return {
      deny: true,
      reason: `stoplist: matched dangerous-command pattern "${dangerous.name}" (${JSON.stringify(dangerous.matched)})`,
    };
  }
  return { deny: false, reason: null };
}

// Pick the PermissionOption to select for a given deny/allow decision.
// ACP requires us to name one of the offered `options` (or cancel) — we
// never invent an option id. Preference: the "once" variant over
// "always" (Stagecraft re-decides every call from the current descriptor;
// an agent-remembered "always" would bypass that). Returns { optionId } or
// null when no compatible option was offered (caller must cancel instead).
function selectOption(options, deny) {
  const wanted = deny ? ["reject_once", "reject_always"] : ["allow_once", "allow_always"];
  for (const kind of wanted) {
    const opt = (options || []).find((o) => o && o.kind === kind);
    if (opt) return { optionId: opt.optionId };
  }
  if (!deny && Array.isArray(options) && options.length > 0) {
    // No allow_once/allow_always offered but options exist — degrade to
    // the first option rather than stalling the turn; deny has no such
    // fallback (silence must never default to permissive).
    return { optionId: options[0].optionId };
  }
  return null;
}

module.exports = {
  DANGEROUS_COMMAND_PATTERNS,
  findDangerousCommandMatch,
  findWriteViolation,
  evaluateToolCall,
  selectOption,
};
