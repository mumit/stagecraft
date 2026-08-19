"use strict";

const fs = require("node:fs");
const path = require("node:path");
const { spawnSync } = require("node:child_process");

function addedLines(patch) {
  return String(patch || "")
    .split(/\r?\n/)
    .filter((line) => line.startsWith("+") && !line.startsWith("+++"))
    .map((line) => line.slice(1))
    .join("\n");
}

function git(args, cwd) {
  return spawnSync("git", args, { cwd, encoding: "utf8", timeout: 10_000 });
}

function readFull(filePath) {
  try { return fs.readFileSync(filePath, "utf8"); } catch { return ""; }
}

// Return only newly added lines when a file belongs to the current Git worktree.
// Untracked and non-Git files fall back to the full body. If agents already
// committed their work, inspect HEAD's patch; this matches Stagecraft's build
// lifecycle, where one build commit precedes pre-review.
function readChangedContent(filePath, opts = {}) {
  const requestedCwd = opts.cwd || process.cwd();
  const unresolved = path.isAbsolute(filePath) ? filePath : path.join(requestedCwd, filePath);
  let absolute;
  try { absolute = fs.realpathSync(unresolved); } catch { return readFull(unresolved); }
  const rootResult = git(["rev-parse", "--show-toplevel"], path.dirname(absolute));
  if (!rootResult || rootResult.status !== 0) return readFull(absolute);
  const cwd = String(rootResult.stdout).trim();
  const relative = path.relative(cwd, absolute);
  if (!cwd || relative.startsWith("..") || path.isAbsolute(relative)) return readFull(absolute);

  const status = git(["status", "--porcelain", "--", relative], cwd);
  if (!status || status.status !== 0) return readFull(absolute);
  if (String(status.stdout).split(/\r?\n/).some((line) => line.startsWith("??"))) {
    return readFull(absolute);
  }

  const patches = [
    git(["diff", "--no-ext-diff", "--unified=0", "--", relative], cwd),
    git(["diff", "--cached", "--no-ext-diff", "--unified=0", "--", relative], cwd),
  ];
  const visible = patches.filter((result) => result && result.status === 0 && result.stdout);
  if (visible.length > 0) return visible.map((result) => addedLines(result.stdout)).filter(Boolean).join("\n");

  const committed = git(["show", "--format=", "--no-ext-diff", "--unified=0", "HEAD", "--", relative], cwd);
  if (committed && committed.status === 0 && committed.stdout) return addedLines(committed.stdout);
  return readFull(absolute);
}

module.exports = { readChangedContent, addedLines };
