const crypto = require("node:crypto");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const { version: STAGECRAFT_VERSION } = require("../../package.json");

const RECEIPT_SCHEMA_VERSION = "1";
const EXCLUDED_DIRS = new Set([
  ".git",
  ".codex",
  ".codex-tmp",
  ".devteam-tmp",
  "node_modules",
  "pipeline",
  "coverage",
  "dist",
  "build",
]);
const MATERIAL_ENV_KEYS = [
  "CI",
  "NODE_ENV",
  "PATH",
  "PYTHONPATH",
  "GOFLAGS",
  "NPM_CONFIG_REGISTRY",
];

function sha256(value) {
  return crypto.createHash("sha256").update(value).digest("hex");
}

function stable(value) {
  if (Array.isArray(value)) return value.map(stable);
  if (value && typeof value === "object") {
    return Object.keys(value).sort().reduce((acc, key) => {
      if (value[key] !== undefined) acc[key] = stable(value[key]);
      return acc;
    }, {});
  }
  return value;
}

function stableJson(value) {
  return JSON.stringify(stable(value));
}

function relPath(cwd, file) {
  return path.relative(cwd, file).replace(/\\/g, "/");
}

function walkMaterialFiles(cwd) {
  const files = [];
  const root = path.resolve(cwd);
  const stack = [root];
  while (stack.length > 0) {
    const dir = stack.pop();
    let entries;
    try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { continue; }
    entries.sort((a, b) => a.name.localeCompare(b.name));
    for (const entry of entries) {
      if (entry.isSymbolicLink()) continue;
      const full = path.join(dir, entry.name);
      const rel = relPath(root, full);
      if (entry.isDirectory()) {
        if (EXCLUDED_DIRS.has(entry.name)) continue;
        stack.push(full);
      } else if (entry.isFile()) {
        files.push(rel);
      }
    }
  }
  files.sort();
  return files;
}

function workspaceDigest(cwd) {
  const root = path.resolve(cwd);
  const files = walkMaterialFiles(root);
  const entries = [];
  for (const rel of files) {
    const full = path.join(root, rel);
    try {
      const content = fs.readFileSync(full);
      entries.push({ path: rel, sha256: sha256(content) });
    } catch {
      entries.push({ path: rel, unreadable: true });
    }
  }
  return {
    digest: sha256(stableJson(entries)),
    files_count: entries.length,
  };
}

function materialEnv(env = process.env) {
  return MATERIAL_ENV_KEYS.reduce((acc, key) => {
    if (env[key] !== undefined) acc[key] = env[key];
    return acc;
  }, {});
}

function configDigest(config) {
  const verify = config && config.pipeline && config.pipeline.verify
    ? config.pipeline.verify
    : {};
  return sha256(stableJson({ verify }));
}

function receiptRootFromGate(gatePath) {
  const gatesDir = path.dirname(gatePath);
  return path.join(path.dirname(gatesDir), "verification-receipts");
}

function receiptKey({ cwd, command, suiteId, purpose, config }) {
  const workspace = workspaceDigest(cwd);
  const payload = {
    schema_version: RECEIPT_SCHEMA_VERSION,
    command,
    suite_id: suiteId || "command",
    purpose,
    workspace_digest: workspace.digest,
    workspace_files_count: workspace.files_count,
    config_digest: configDigest(config),
    env_digest: sha256(stableJson(materialEnv())),
    toolchain: {
      node: process.version,
      platform: process.platform,
      arch: process.arch,
      os_release: os.release(),
    },
    stagecraft_version: STAGECRAFT_VERSION,
  };
  return {
    key: payload,
    digest: `sha256:${sha256(stableJson(payload))}`,
  };
}

function receiptPath(root, digest) {
  return path.join(root, `${digest.replace(/^sha256:/, "")}.json`);
}

function readReceipt(root, digest) {
  const file = receiptPath(root, digest);
  try {
    const receipt = JSON.parse(fs.readFileSync(file, "utf8"));
    return { receipt, path: file };
  } catch {
    return null;
  }
}

function writeReceipt(root, receipt) {
  fs.mkdirSync(root, { recursive: true });
  const file = receiptPath(root, receipt.digest);
  fs.writeFileSync(file, JSON.stringify(receipt, null, 2) + "\n", "utf8");
  return file;
}

function reusableReceipt(root, digest) {
  const found = readReceipt(root, digest);
  if (!found) return null;
  const { receipt } = found;
  if (
    receipt
    && receipt.schema_version === RECEIPT_SCHEMA_VERSION
    && receipt.digest === digest
    && receipt.result
    && receipt.result.exitCode === 0
    && receipt.result.timedOut !== true
    && !receipt.result.spawnError
  ) {
    return { ...receipt.result, receipt };
  }
  return null;
}

function receiptSummary({ digest, reused, reason, receipt, path: receiptFile }) {
  const original = receipt || {};
  return {
    digest,
    reused: Boolean(reused),
    reason,
    original_duration_ms: original.result ? original.result.durationMs : undefined,
    original_executed_at: original.executed_at,
    path: receiptFile ? receiptFile.replace(/\\/g, "/") : undefined,
  };
}

module.exports = {
  RECEIPT_SCHEMA_VERSION,
  receiptKey,
  receiptRootFromGate,
  reusableReceipt,
  writeReceipt,
  receiptSummary,
};
