"use strict";

// Opt-in filesystem isolation for parallel build workstreams.
//
// Every role starts from the same byte-for-byte workspace snapshot in a
// detached Git worktree. On completion, only role-authorized paths are
// reconciled into the operator's checkout. If another workstream changed the
// same file first, a deterministic three-way merge is attempted; unresolved
// overlap is reported as a conflict instead of silently taking last-writer.

const crypto = require("node:crypto");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { execFileSync, spawnSync } = require("node:child_process");
const { isAllowed, isIgnoredRuntimeArtifact } = require("./guards/write-audit");

const MAX_MERGE_BYTES = 1024 * 1024;
const EXCLUDED_DIRS = new Set([
  ".git", "node_modules", ".venv", "venv", ".tox", ".mypy_cache",
  ".pytest_cache", "coverage", "dist", "build", "target", ".next",
]);
const EXCLUDED_DEVTEAM_DIRS = new Set(["worktrees", "memory", "corpus", "evals"]);

function rel(root, file) {
  return path.relative(root, file).replace(/\\/g, "/");
}

function excludedDirectory(relativePath, name) {
  if (EXCLUDED_DIRS.has(name)) return true;
  const parts = relativePath.split("/");
  if (parts[0] === ".devteam" && parts.length === 2 && EXCLUDED_DEVTEAM_DIRS.has(name)) return true;
  return false;
}

function digest(buffer) {
  return crypto.createHash("sha256").update(buffer).digest("hex");
}

function snapshotTree(root) {
  const resolved = path.resolve(root);
  const files = new Map();
  const stack = [resolved];
  while (stack.length > 0) {
    const dir = stack.pop();
    let entries;
    try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { continue; }
    entries.sort((a, b) => a.name.localeCompare(b.name));
    for (const entry of entries) {
      if (entry.name === ".git") continue;
      const full = path.join(dir, entry.name);
      const relative = rel(resolved, full);
      if (!relative || relative.startsWith("../")) continue;
      if (entry.isDirectory()) {
        if (!excludedDirectory(relative, entry.name)) stack.push(full);
        continue;
      }
      if (entry.isSymbolicLink()) {
        let target;
        try { target = fs.readlinkSync(full); } catch { continue; }
        files.set(relative, { type: "symlink", hash: digest(Buffer.from(target)), target });
        continue;
      }
      if (!entry.isFile()) continue;
      let content;
      let mode;
      try {
        content = fs.readFileSync(full);
        mode = fs.statSync(full).mode & 0o777;
      } catch { continue; }
      files.set(relative, {
        type: "file",
        hash: digest(content),
        mode,
        content: content.length <= MAX_MERGE_BYTES ? content : null,
      });
    }
  }
  return files;
}

function sameEntry(a, b) {
  if (!a || !b) return a === b;
  return a.type === b.type && a.hash === b.hash && a.mode === b.mode;
}

function changedPaths(before, after) {
  const paths = new Set([...before.keys(), ...after.keys()]);
  return [...paths].filter((p) => !sameEntry(before.get(p), after.get(p))).sort();
}

function safeSegment(value) {
  return String(value || "workstream").replace(/[^a-zA-Z0-9._-]+/g, "-").slice(0, 96);
}

function safeSymlink(root, relative, target) {
  if (path.isAbsolute(target)) return false;
  const linkDir = path.dirname(path.join(root, relative));
  const resolvedTarget = path.resolve(linkDir, target);
  const resolvedRoot = path.resolve(root);
  return resolvedTarget === resolvedRoot || resolvedTarget.startsWith(`${resolvedRoot}${path.sep}`);
}

function isVerificationReceipt(relative) {
  return /(^|\/)pipeline(?:\/changes\/[^/]+)?\/verification-receipts\//.test(relative);
}

function ensureGitRoot(cwd) {
  let root;
  try {
    root = execFileSync("git", ["rev-parse", "--show-toplevel"], {
      cwd, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"],
    }).trim();
  } catch {
    throw new Error("pipeline.workstream_isolation=git-worktree requires a Git working tree");
  }
  const resolvedRoot = fs.realpathSync(root);
  const resolvedCwd = fs.realpathSync(cwd);
  if (resolvedRoot !== resolvedCwd) {
    throw new Error(
      `pipeline.workstream_isolation=git-worktree requires --cwd to be the Git root (${root})`,
    );
  }
}

function copyRootFile(root, workspace, relative) {
  const source = path.join(root, relative);
  const target = path.join(workspace, relative);
  const stat = fs.lstatSync(source);
  fs.mkdirSync(path.dirname(target), { recursive: true });
  try { fs.rmSync(target, { recursive: true, force: true }); } catch { /* replace below */ }
  if (stat.isSymbolicLink()) fs.symlinkSync(fs.readlinkSync(source), target);
  else {
    fs.copyFileSync(source, target);
    fs.chmodSync(target, stat.mode & 0o777);
  }
}

function syncBaseline(root, workspace, baseline) {
  const current = snapshotTree(workspace);
  for (const [relative, entry] of baseline) {
    if (!sameEntry(entry, current.get(relative))) copyRootFile(root, workspace, relative);
  }
  for (const relative of current.keys()) {
    if (!baseline.has(relative)) fs.rmSync(path.join(workspace, relative), { recursive: true, force: true });
  }
}

function rootEntry(root, relative) {
  const file = path.join(root, relative);
  let stat;
  try { stat = fs.lstatSync(file); } catch { return null; }
  if (stat.isSymbolicLink()) {
    const target = fs.readlinkSync(file);
    return { type: "symlink", hash: digest(Buffer.from(target)), target };
  }
  if (!stat.isFile()) return null;
  const content = fs.readFileSync(file);
  return { type: "file", hash: digest(content), mode: stat.mode & 0o777, content };
}

function atomicWrite(file, content, mode) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.stagecraft-${process.pid}-${crypto.randomBytes(4).toString("hex")}.tmp`;
  fs.writeFileSync(tmp, content);
  if (mode) fs.chmodSync(tmp, mode);
  fs.renameSync(tmp, file);
}

function isText(buffer) {
  return Buffer.isBuffer(buffer) && !buffer.includes(0);
}

function mergeText(current, base, incoming) {
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), "stagecraft-merge-"));
  const currentFile = path.join(temp, "current");
  const baseFile = path.join(temp, "base");
  const incomingFile = path.join(temp, "incoming");
  try {
    fs.writeFileSync(currentFile, current);
    fs.writeFileSync(baseFile, base);
    fs.writeFileSync(incomingFile, incoming);
    const result = spawnSync("git", ["merge-file", "-p", currentFile, baseFile, incomingFile], {
      encoding: null, stdio: ["ignore", "pipe", "pipe"],
    });
    return result.status === 0 ? result.stdout : null;
  } finally {
    fs.rmSync(temp, { recursive: true, force: true });
  }
}

function normalizeWorkspaceStrings(value, workspace, root) {
  if (typeof value === "string") {
    return value.startsWith(workspace) ? `${root}${value.slice(workspace.length)}` : value;
  }
  if (Array.isArray(value)) return value.map((item) => normalizeWorkspaceStrings(item, workspace, root));
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value).map(([key, item]) => [key, normalizeWorkspaceStrings(item, workspace, root)]),
    );
  }
  return value;
}

function normalizeGatePaths(gatePath, workspace, root) {
  if (!gatePath || !fs.existsSync(gatePath)) return;
  try {
    const gate = JSON.parse(fs.readFileSync(gatePath, "utf8"));
    const normalized = normalizeWorkspaceStrings(gate, workspace, root);
    if (JSON.stringify(normalized) !== JSON.stringify(gate)) {
      fs.writeFileSync(gatePath, JSON.stringify(normalized, null, 2) + "\n", "utf8");
    }
  } catch { /* malformed gates are handled by the normal validator */ }
}

class WorkstreamIsolation {
  constructor({ cwd, stage, workstreams }) {
    ensureGitRoot(cwd);
    this.inputCwd = path.resolve(cwd);
    this.cwd = fs.realpathSync(cwd);
    this.stage = stage;
    this.workstreams = workstreams;
    this.baseline = snapshotTree(this.cwd);
    for (const [relative, entry] of this.baseline) {
      if (entry.type === "symlink" && !safeSymlink(this.cwd, relative, entry.target)) {
        throw new Error(
          `pipeline.workstream_isolation=git-worktree cannot safely reproduce escaping symlink: ${relative}`,
        );
      }
    }
    this.runRoot = path.join(
      this.cwd, ".devteam", "worktrees",
      `${safeSegment(stage)}-${process.pid}-${crypto.randomBytes(4).toString("hex")}`,
    );
    this.entries = new Map();
  }

  prepareAll() {
    fs.mkdirSync(this.runRoot, { recursive: true });
    try {
      for (const ws of this.workstreams) {
        const workspace = path.join(this.runRoot, safeSegment(ws.descriptor.workstreamId));
        execFileSync("git", ["worktree", "add", "--detach", workspace, "HEAD"], {
          cwd: this.cwd, stdio: ["ignore", "ignore", "pipe"],
        });
        syncBaseline(this.cwd, workspace, this.baseline);
        this.entries.set(ws.descriptor.workstreamId, { workspace, active: true });
      }
      return this;
    } catch (err) {
      this.cleanupAll();
      throw new Error(`could not prepare isolated build workstreams: ${err.message}`);
    }
  }

  entryFor(ws) {
    return this.entries.get(ws.descriptor.workstreamId) || null;
  }

  contextFor(ws, ctx) {
    const entry = this.entryFor(ws);
    return entry ? { ...ctx, cwd: entry.workspace, processCwd: null } : ctx;
  }

  workspacePath(ws, rootPath) {
    const entry = this.entryFor(ws);
    if (!entry) return rootPath;
    const relative = rel(this.inputCwd, path.resolve(rootPath));
    if (!relative || relative.startsWith("../")) throw new Error(`isolation path escapes project root: ${rootPath}`);
    return path.join(entry.workspace, relative);
  }

  reconcile(ws, { gatePath, logPath, patchGate }) {
    const entry = this.entryFor(ws);
    if (!entry) return { gatePath, logPath, violations: [], conflicts: [] };
    normalizeGatePaths(gatePath, entry.workspace, this.cwd);
    const after = snapshotTree(entry.workspace);
    const allChanges = changedPaths(this.baseline, after);
    const rootLog = logPath ? path.join(this.cwd, rel(entry.workspace, logPath)) : null;
    const logRelative = rootLog ? rel(this.cwd, rootLog) : null;
    const allowed = ws.descriptor.allowedWrites || [];
    const operational = new Set(logRelative ? [logRelative] : []);
    const violations = allChanges.filter((p) => {
      if (operational.has(p) || isVerificationReceipt(p) || isIgnoredRuntimeArtifact(p)) return false;
      const incoming = after.get(p);
      if (incoming?.type === "symlink" && !safeSymlink(entry.workspace, p, incoming.target)) return true;
      return !isAllowed(p, allowed);
    });
    if (violations.length > 0 && typeof patchGate === "function") {
      patchGate(gatePath, { violations, conflicts: [] });
    }

    const finalSnapshot = violations.length > 0 ? snapshotTree(entry.workspace) : after;
    const changes = changedPaths(this.baseline, finalSnapshot)
      .filter((p) => !isIgnoredRuntimeArtifact(p) || isVerificationReceipt(p))
      .filter((p) => operational.has(p) || isVerificationReceipt(p) || isAllowed(p, allowed));
    const conflicts = [];
    for (const relative of changes) {
      const base = this.baseline.get(relative) || null;
      const incoming = finalSnapshot.get(relative) || null;
      const current = rootEntry(this.cwd, relative);
      const target = path.join(this.cwd, relative);
      if (sameEntry(current, incoming)) continue;
      if (sameEntry(current, base)) {
        if (!incoming) fs.rmSync(target, { recursive: true, force: true });
        else if (incoming.type === "symlink") {
          fs.rmSync(target, { recursive: true, force: true });
          fs.mkdirSync(path.dirname(target), { recursive: true });
          fs.symlinkSync(incoming.target, target);
        } else {
          atomicWrite(target, fs.readFileSync(path.join(entry.workspace, relative)), incoming.mode);
        }
        continue;
      }
      if (
        base && incoming && current
        && base.type === "file" && incoming.type === "file" && current.type === "file"
        && base.content && isText(base.content) && isText(current.content)
      ) {
        const incomingContent = fs.readFileSync(path.join(entry.workspace, relative));
        if (isText(incomingContent)) {
          const merged = mergeText(current.content, base.content, incomingContent);
          if (merged !== null) {
            atomicWrite(target, merged, incoming.mode);
            continue;
          }
        }
      }
      conflicts.push(relative);
    }
    if (conflicts.length > 0 && typeof patchGate === "function") {
      patchGate(gatePath, { violations: [], conflicts });
      const gateRelative = rel(entry.workspace, gatePath);
      if (isAllowed(gateRelative, allowed) && fs.existsSync(gatePath)) {
        atomicWrite(path.join(this.cwd, gateRelative), fs.readFileSync(gatePath), fs.statSync(gatePath).mode & 0o777);
      }
    }
    const rootGate = gatePath && fs.existsSync(gatePath)
      ? path.join(this.cwd, rel(entry.workspace, gatePath))
      : null;
    return {
      gatePath: rootGate,
      logPath: rootLog && fs.existsSync(rootLog) ? rootLog : null,
      violations,
      conflicts,
    };
  }

  cleanup(ws) {
    const entry = this.entryFor(ws);
    if (!entry || !entry.active) return;
    entry.active = false;
    try {
      execFileSync("git", ["worktree", "remove", "--force", entry.workspace], {
        cwd: this.cwd, stdio: ["ignore", "ignore", "ignore"],
      });
    } catch {
      try { fs.rmSync(entry.workspace, { recursive: true, force: true }); } catch { /* best effort */ }
    }
  }

  cleanupAll() {
    for (const ws of this.workstreams) this.cleanup(ws);
    try { fs.rmSync(this.runRoot, { recursive: true, force: true }); } catch { /* best effort */ }
    try { execFileSync("git", ["worktree", "prune"], { cwd: this.cwd, stdio: "ignore" }); } catch { /* best effort */ }
  }
}

function shouldIsolateBuildWorkstreams(config, plan) {
  if (!Array.isArray(plan?.workstreams) || plan.workstreams.length === 0) return false;
  if (plan?.ctx?.trustProfile === "contained") return true;
  return config?.pipeline?.workstream_isolation === "git-worktree"
    && plan.stage === "stage-04"
    && plan.workstreams.length > 1;
}

module.exports = {
  WorkstreamIsolation,
  changedPaths,
  shouldIsolateBuildWorkstreams,
  snapshotTree,
};
