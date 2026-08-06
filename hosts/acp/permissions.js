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
const { parseCommandLine } = require("../../core/command-line");

// Parity list with hosts/claude-code/adapter.js's renderSettingsLocal()
// permissions.deny. Matched against the tool call's rawInput (typically
// `{ command: "..." }` for an "execute" kind call) and title — the closest
// ACP gets to claude-code's own Bash-argument glob matching.
const DANGEROUS_COMMAND_PATTERNS = [
  { name: "rm-rf", re: /\brm\s+(?:-\S+\s+)*-[a-zA-Z]*[rR][a-zA-Z]*[fF][a-zA-Z]*\b|\brm\s+(?:-\S+\s+)*-[a-zA-Z]*[fF][a-zA-Z]*[rR][a-zA-Z]*\b/ },
  { name: "git-push-force", re: /\bgit\s+push\b[^\n]*(--force\b|(?:^|\s)-f\b)/ },
];

const WRITE_KINDS = new Set(["edit", "delete", "move"]);

// review mode's execute allowlist (36.1, plans/phase-36-external-review-mode.md
// §36.1) — "review genuinely needs shell for rg/grep/git log" without opening
// the door to a shell call mutating the subject (sed -i, git checkout, a build
// script), which WRITE_KINDS above cannot see because it never inspects
// kind:"execute" calls. git is restricted to its read-only subcommands; every
// other binary here takes no argument-shape restriction. hosts.acp.review.
// exec_allowlist (config._raw.hosts.acp.review.exec_allowlist) extends the
// plain-binary set without code changes.
//
// 36.1's original scope note flagged this: "if [denying every chained/piped
// command outright] turns out to make real reviews impractical, the fix is
// the exec_allowlist extension point or a narrower parse, not silently
// loosening the default." It did — a real reviewing agent's normal
// exploration style is `cd <dir> && find . | head -50 && echo "---" && cat
// file 2>/dev/null`, and every one of those pieces got refused outright,
// so the agent gave up instead of ever writing its review. cd/echo/sort/
// head/tail cost nothing security-wise (no filesystem write, no code
// execution) and complete that natural set.
const REVIEW_EXEC_ALLOWLIST = new Set(["rg", "grep", "ls", "cat", "find", "wc", "cd", "echo", "sort", "head", "tail"]);
const REVIEW_EXEC_GIT_SUBCOMMANDS = new Set(["log", "diff", "show", "status"]);

// A redirect that never touches the filesystem: discarding a stream
// (`2>/dev/null`, `>/dev/null`) or duplicating one file descriptor onto
// another (`2>&1`, `1>&2`). Matched as a single whitespace-delimited token
// — exactly how parseCommandLine tokenizes it once splitOnChainOperators
// below has already cut it free of any trailing operator — and skipped
// rather than treated as the file-redirect risk `>`/`>>` on their own
// represent.
const SAFE_FD_REDIRECT_RE = /^[012]?>>?(&[012]|\/dev\/null)$/;

// Command substitution — `` `...` `` or `$(...)` — nests another shell
// invocation inside a token. Deliberately not parsed recursively (the same
// reasoning as the header comment below on quote-aware parsing risk): denied
// outright, wherever in the raw command string it appears, before any
// tokenizing happens.
const COMMAND_SUBSTITUTION_RE = /`|\$\(/;

// Quote-aware split on the chain operators that sequence one already-
// validated command into the next (&&, ||, ;) or pipe one command's stdout
// into the next's stdin (|). None of these write anywhere *on their own*;
// composing read-only operations (sequence or pipe) yields another
// read-only operation, so splitting on them and validating every resulting
// segment against the same allowlist is exactly as safe as validating one
// command.
//
// This can't just look for &&/||/;/| as their own whitespace-delimited
// token via parseCommandLine — real commands routinely glue an operator
// directly onto a preceding quoted argument or redirect with no space
// (`echo "foo"; next`, `cat x 2>/dev/null; next`), and parseCommandLine only
// ends a token on whitespace, not on a closing quote. So this scans the raw
// string itself, character by character, respecting quotes, and only splits
// outside them.
function splitOnChainOperators(command) {
  const segments = [];
  let current = "";
  let quote = null;
  for (let i = 0; i < command.length; i++) {
    const ch = command[i];
    if (quote) {
      current += ch;
      if (ch === quote) quote = null;
      continue;
    }
    if (ch === "'" || ch === '"') {
      quote = ch;
      current += ch;
      continue;
    }
    if (ch === ";") {
      segments.push(current);
      current = "";
      continue;
    }
    if ((ch === "&" && command[i + 1] === "&") || (ch === "|" && command[i + 1] === "|")) {
      segments.push(current);
      current = "";
      i++; // consume the second character of && / ||
      continue;
    }
    if (ch === "|") {
      segments.push(current);
      current = "";
      continue;
    }
    current += ch;
  }
  segments.push(current);
  return segments;
}

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
// are project-relative (e.g. "pipeline/build-plan.md"). Paths outside root
// can't be relativized meaningfully — treat them as violations rather than
// silently allowing writes outside the project root.
function relativeToProject(absPath, root) {
  if (!path.isAbsolute(absPath)) return absPath.replace(/\\/g, "/");
  const rel = path.relative(root, absPath);
  if (rel.startsWith("..")) return null;
  return rel.replace(/\\/g, "/");
}

// evaluateToolCall's third argument used to be a single `cwd` string (single-
// root: writes are checked against that one root's allowedWrites). 36.1 adds
// a two-root review mode without breaking that call shape — a bare string is
// still "normal mode, one root doing double duty as both codeRoot and
// stateRoot", so every pre-36.1 caller (including this file's own tests)
// keeps working unchanged.
function normalizeRoots(rootsOrCwd) {
  if (typeof rootsOrCwd === "string") {
    return { codeRoot: rootsOrCwd, stateRoot: rootsOrCwd, mode: "normal", execAllowlist: [] };
  }
  const r = rootsOrCwd || {};
  return {
    codeRoot: r.codeRoot,
    stateRoot: r.stateRoot || r.codeRoot,
    mode: r.mode === "review" ? "review" : "normal",
    execAllowlist: Array.isArray(r.execAllowlist) ? r.execAllowlist : [],
  };
}

function findWriteViolation(toolCall, descriptor, rootsOrCwd) {
  if (!WRITE_KINDS.has(toolCall.kind)) return null;
  const { codeRoot, stateRoot, mode } = normalizeRoots(rootsOrCwd);
  const locations = Array.isArray(toolCall.locations) ? toolCall.locations : [];
  const allowedWrites = descriptor.allowedWrites || [];
  for (const loc of locations) {
    if (!loc || typeof loc.path !== "string") continue;

    if (mode === "review") {
      // codeRoot may be absent (36.5: a PR review with no checkout has no
      // subject on disk at all, so every write target is under stateRoot).
      if (codeRoot) {
        const relCode = relativeToProject(loc.path, codeRoot);
        if (relCode !== null) return { path: loc.path, rel: relCode, readOnlySubject: true };
      }
      const relState = relativeToProject(loc.path, stateRoot);
      if (relState === null || !isAllowed(relState, allowedWrites)) {
        return { path: loc.path, rel: relState };
      }
      continue;
    }

    const rel = relativeToProject(loc.path, codeRoot);
    if (rel === null || !isAllowed(rel, allowedWrites)) {
      return { path: loc.path, rel };
    }
  }
  return null;
}

// Review mode's deny-by-default execute gate. Splits the raw command
// (quote-aware — see splitOnChainOperators) into segments on &&/||/;/|,
// then parses each segment to tokens (never substring-matches the raw
// string for the allowlist decision itself — command substitution is the
// one exception, checked directly against the whole raw string below, since
// it can't safely be parsed recursively) and validates each segment's
// leading binary against the allowlist independently — a chain or pipe of
// read-only commands is itself read-only, by construction. A real file
// redirect (`>`, `>>`, `<`) or backgrounding (`&`) still denies the whole
// command outright; only the filesystem-inert fd redirects in
// SAFE_FD_REDIRECT_RE are recognized and skipped. Returns a reason string,
// or null to allow.
function findReviewExecViolation(toolCall, execAllowlist) {
  const command = toolCall.rawInput && typeof toolCall.rawInput.command === "string"
    ? toolCall.rawInput.command
    : null;
  if (!command || !command.trim()) {
    return "review-mode: execute call has no inspectable command — denied by default";
  }
  if (COMMAND_SUBSTITUTION_RE.test(command)) {
    return `review-mode: execute denied — command substitution in command ${JSON.stringify(command)}`;
  }

  const allowlist = execAllowlist.length
    ? new Set([...REVIEW_EXEC_ALLOWLIST, ...execAllowlist])
    : REVIEW_EXEC_ALLOWLIST;
  const segments = splitOnChainOperators(command);
  for (const segment of segments) {
    let tokens;
    try {
      tokens = parseCommandLine(segment);
    } catch {
      return `review-mode: execute denied — unparseable command ${JSON.stringify(command)}`;
    }
    if (tokens.length === 0) {
      return `review-mode: execute denied — empty sub-command in ${JSON.stringify(command)}`;
    }

    const args = [];
    for (const token of tokens) {
      if (SAFE_FD_REDIRECT_RE.test(token)) continue; // discard/dup a stream — no filesystem write
      if (token === "&" || token.includes(">") || token.includes("<")) {
        // A real file redirect or a lone background `&` — the risk this
        // whole gate exists to close. Deny the entire command, not just
        // this piece.
        return `review-mode: execute denied — redirection/backgrounding in command ${JSON.stringify(command)}`;
      }
      args.push(token);
    }
    if (args.length === 0) {
      return `review-mode: execute denied — empty sub-command in ${JSON.stringify(command)}`;
    }

    const bin = path.basename(args[0]);
    if (bin === "git") {
      if (!REVIEW_EXEC_GIT_SUBCOMMANDS.has(args[1])) {
        return `review-mode: execute denied — "git ${args[1] || ""}" is not a read-only allowlisted subcommand: ${JSON.stringify(command)}`;
      }
      continue;
    }
    if (!allowlist.has(bin)) {
      return `review-mode: execute denied — "${bin}" is not on the read-only allowlist: ${JSON.stringify(command)}`;
    }
  }
  return null;
}

// Evaluate one ACP toolCall against this dispatch's rules. `rootsOrCwd` is
// either a plain cwd string (normal mode, single root — pre-36.1 shape) or
// { codeRoot, stateRoot, mode, execAllowlist } (36.1's two-root review mode).
// Returns { deny: boolean, reason: string|null } — deny:false means allow.
function evaluateToolCall(toolCall, descriptor, rootsOrCwd) {
  const roots = normalizeRoots(rootsOrCwd);

  const violation = findWriteViolation(toolCall, descriptor, roots);
  if (violation) {
    if (violation.readOnlySubject) {
      return {
        deny: true,
        reason: `review-mode: read-only — "${violation.rel}" is inside the subject under review; writes are only permitted in the review workspace`,
      };
    }
    return {
      deny: true,
      reason: `allowed-writes: "${violation.rel || violation.path}" is not in this workstream's allowedWrites`,
    };
  }

  if (roots.mode === "review" && toolCall.kind === "execute") {
    const reason = findReviewExecViolation(toolCall, roots.execAllowlist);
    if (reason) return { deny: true, reason };
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
  REVIEW_EXEC_ALLOWLIST,
  REVIEW_EXEC_GIT_SUBCOMMANDS,
  findDangerousCommandMatch,
  findWriteViolation,
  findReviewExecViolation,
  evaluateToolCall,
  selectOption,
};
