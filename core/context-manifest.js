const fs = require("node:fs");
const path = require("node:path");
const crypto = require("node:crypto");
const { spawnSync } = require("node:child_process");

const DEFAULT_LIMIT = 40;
const IGNORED_PREFIXES = [
  ".git/",
  ".devteam/",
  ".codex/",
  ".codex-tmp/",
  ".devteam-tmp/",
  "pipeline/",
];

function normalizeRel(file) {
  return String(file || "").replace(/\\/g, "/").replace(/^\/+/, "");
}

function isManifestInputPath(file) {
  const rel = normalizeRel(file);
  if (!rel || rel.includes("\0")) return false;
  return !IGNORED_PREFIXES.some((prefix) => rel === prefix.slice(0, -1) || rel.startsWith(prefix));
}

function parsePorcelainStatus(stdout) {
  const entries = String(stdout || "").split("\0").filter(Boolean);
  const out = [];
  for (let i = 0; i < entries.length; i++) {
    const raw = entries[i];
    const code = raw.slice(0, 2);
    let file = raw.slice(3);
    let previous = null;
    if (code.includes("R") || code.includes("C")) {
      previous = file;
      file = entries[i + 1] || file;
      i++;
    }
    file = normalizeRel(file);
    if (!isManifestInputPath(file)) continue;
    out.push({ status: code.trim() || "M", path: file, previous_path: previous ? normalizeRel(previous) : null });
  }
  return out;
}

function sha256File(abs) {
  const hash = crypto.createHash("sha256");
  hash.update(fs.readFileSync(abs));
  return `sha256:${hash.digest("hex")}`;
}

function fileFacts(cwd, entry) {
  const abs = path.join(cwd, entry.path);
  let stat = null;
  try {
    stat = fs.statSync(abs);
  } catch {
    stat = null;
  }
  const exists = !!stat && stat.isFile();
  return {
    path: entry.path,
    status: entry.status,
    previous_path: entry.previous_path || undefined,
    exists,
    bytes: exists ? stat.size : null,
    sha256: exists ? sha256File(abs) : null,
  };
}

function collectChangedFileManifest(cwd, opts = {}) {
  if (!cwd) return { ok: false, source: "none", files: [], truncated: false, omitted_count: 0 };
  const limit = Number.isInteger(opts.limit) && opts.limit > 0 ? opts.limit : DEFAULT_LIMIT;
  const result = spawnSync("git", ["status", "--porcelain", "-z", "--untracked-files=all"], {
    cwd,
    encoding: "utf8",
  });
  if (result.status !== 0) {
    return { ok: false, source: "git-status", files: [], truncated: false, omitted_count: 0 };
  }
  const seen = new Set();
  const parsed = parsePorcelainStatus(result.stdout).filter((entry) => {
    if (seen.has(entry.path)) return false;
    seen.add(entry.path);
    return true;
  });
  const selected = parsed.slice(0, limit).map((entry) => fileFacts(cwd, entry));
  return {
    ok: true,
    source: "git-status",
    files: selected,
    truncated: parsed.length > selected.length,
    omitted_count: Math.max(0, parsed.length - selected.length),
  };
}

module.exports = {
  DEFAULT_LIMIT,
  collectChangedFileManifest,
  isManifestInputPath,
  parsePorcelainStatus,
};
