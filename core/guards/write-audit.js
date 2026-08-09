// Write-audit guard (C1 — filesystem-level allowedWrites enforcement).
//
// Provides post-hoc enforcement for adapters that have no hook mechanism
// (codex, gemini-cli, openai-compat). The orchestrator snapshots the
// working-tree dirty state before invoking the host process, then diffs
// after; any newly appearing path that isn't covered by the stage's
// allowedWrites list is a violation.
//
// "Covered" means:
//   - exact file match:     allowedWrites contains "pipeline/brief.md" and
//                           the written path is exactly "pipeline/brief.md"
//   - directory prefix:     allowedWrites contains "pipeline/adr/" and the
//                           written path starts with "pipeline/adr/"
//
// Pre-existing dirty files (present in the before snapshot) are never
// flagged — they weren't written by this invocation.
//
// If git is unavailable or the directory is not a repo, ok: false is
// returned and the audit is skipped rather than false-positiving.
//
// Directory expansion: git --porcelain reports an entirely-new untracked
// directory as a single "dir/" entry rather than listing its contents
// individually (e.g. "pipeline/" instead of "pipeline/brief.md",
// "pipeline/context.md", …). snapshotWritables expands these directory
// entries via readdirSync so the paths set always contains exact file paths,
// which allowedWrites matching relies on.

const fs = require("node:fs");
const path = require("node:path");
const { execFileSync } = require("node:child_process");

// Recursively expand an untracked directory into its individual file paths.
// git --porcelain reports wholly-new directories as a single "dir/" entry;
// this helper resolves those to exact file paths so allowedWrites matching works.
// Falls back to adding the original "dir/" entry unchanged on any fs error.
function expandDirIntoSet(absDir, relPrefix, pathSet) {
  let entries;
  try {
    entries = fs.readdirSync(absDir, { withFileTypes: true });
  } catch {
    pathSet.add(relPrefix); // fs error — revert to old behaviour
    return;
  }
  for (const entry of entries) {
    const rel = relPrefix + entry.name;
    if (entry.isDirectory()) {
      expandDirIntoSet(path.join(absDir, entry.name), rel + "/", pathSet);
    } else {
      pathSet.add(rel);
    }
  }
}

/**
 * Capture the current set of modified/untracked paths visible to git.
 * Returns { paths: Set<string>, ok: boolean }.
 * ok=false when git is unavailable or the directory is not a repo.
 */
function snapshotWritables(cwd) {
  try {
    // -z: NUL-delimited records; paths are never quoted even when they contain
    // spaces or special characters. Without -z, git wraps such paths in double
    // quotes and applies C-style escaping, which the old slice(3) mis-parsed.
    const out = execFileSync("git", ["status", "--porcelain", "-z"], {
      cwd,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    });
    const paths = new Set();
    let skipNext = false;
    for (const record of out.split("\0")) {
      if (skipNext) {
        skipNext = false;
        continue; // old path in a rename/copy pair — we already recorded the new name
      }
      if (!record) continue;
      // Format: "XY path" — two status chars followed by a space then the path.
      const xy = record.slice(0, 2);
      const filePath = record.slice(3);
      // For renames/copies the NEXT NUL-delimited record is the original path.
      if (xy[0] === "R" || xy[0] === "C" || xy[1] === "R" || xy[1] === "C") {
        skipNext = true;
      }
      if (filePath.endsWith("/")) {
        // git aggregated an entirely-new untracked directory into a single
        // "dir/" entry — expand it so the audit can compare against exact
        // allowedWrites entries such as "pipeline/brief.md".
        expandDirIntoSet(path.join(cwd, filePath), filePath, paths);
      } else {
        paths.add(filePath);
      }
    }
    return { paths, ok: true };
  } catch {
    return { paths: new Set(), ok: false };
  }
}

/**
 * Check whether a file path is covered by an allowedWrites entry.
 * Path separators are normalized to forward slashes for cross-platform safety.
 */
function isAllowed(filePath, allowedWrites) {
  if (!Array.isArray(allowedWrites) || allowedWrites.length === 0) return false;
  const normalized = filePath.replace(/\\/g, "/");
  return allowedWrites.some((entry) => {
    const e = (entry || "").replace(/\\/g, "/");
    // Trailing-slash directory prefix match.
    if (e.endsWith("/")) {
      return normalized.startsWith(e) || normalized === e.slice(0, -1);
    }
    // Fast path: no wildcards or placeholders → exact match only.
    if (!e.includes("*") && !e.includes("<")) {
      return normalized === e;
    }
    // Glob/placeholder match. <anything> normalizes to *; * matches within one
    // path segment; ** matches across segments (same semantics as .gitignore).
    const pattern = e.replace(/<[^>]*>/g, "*");
    const doubleStarToken = "__STAGECRAFT_DOUBLE_STAR__";
    const regexStr = "^" + pattern
      .replace(/[.+^${}()|[\]\\]/g, "\\$&") // escape regex specials except *
      .replace(/\*\*/g, doubleStarToken)     // stash ** before single-* replace
      .replace(/\*/g, "[^/]*")               // * = one segment (no slashes)
      .replace(new RegExp(doubleStarToken, "g"), ".*") // ** = any depth
      + "$";
    return new RegExp(regexStr).test(normalized);
  });
}

/**
 * Runtime tools can create cache files while an agent is reading or verifying
 * code. These files are not authored project changes and should not flip gates
 * to FAIL, but keep the list narrow so source writes remain visible.
 */
function isIgnoredRuntimeArtifact(filePath) {
  const normalized = String(filePath || "").replace(/\\/g, "/");
  if (!normalized) return false;
  if (/(^|\/)__pycache__\/[^/]+\.py[cod]$/.test(normalized)) return true;
  if (/(^|\/)\.pytest_cache\//.test(normalized)) return true;
  if (/(^|\/)\.mypy_cache\//.test(normalized)) return true;
  if (/(^|\/)\.ruff_cache\//.test(normalized)) return true;
  // pipeline/verification-receipts/ is written by the orchestrator's own
  // post-dispatch stamping step (core/verify/runner.js#writeReceipt), never
  // by the dispatched agent — it's stagecraft's internal bookkeeping, not an
  // authored project change, and the directory is shared across every
  // workstream's own stamp step, not scoped per-role. A real build correctly
  // flagged a receipt file another (concurrently or previously stamped)
  // workstream had just written as an "unauthorized write" for platform,
  // flipping an otherwise-passing gate to FAIL over a file platform never
  // touched and was never meant to be constrained by its own allowedWrites.
  if (/(^|\/)pipeline(?:\/changes\/[^/]+)?\/verification-receipts\//.test(normalized)) return true;
  return false;
}

/**
 * Diff two snapshots and return paths newly written during an invocation.
 * Returns { violations: string[], newPaths: string[], ignoredPaths: string[], audited: boolean }.
 * audited=false when either snapshot reported ok=false (git unavailable).
 */
function auditWrites(before, after, allowedWrites) {
  if (!before.ok || !after.ok) {
    return { violations: [], newPaths: [], ignoredPaths: [], audited: false };
  }
  const newPaths = [...after.paths].filter((p) => !before.paths.has(p));
  const ignoredPaths = newPaths.filter(isIgnoredRuntimeArtifact);
  const violations = newPaths.filter((p) => !isIgnoredRuntimeArtifact(p) && !isAllowed(p, allowedWrites));
  return { violations, newPaths, ignoredPaths, audited: true };
}

module.exports = { snapshotWritables, auditWrites, isAllowed, isIgnoredRuntimeArtifact };
