"use strict";

const fs = require("node:fs");
const path = require("node:path");
const crypto = require("node:crypto");

const SCHEMA_VERSION = "1.0";
const KNOWLEDGE_DIR = path.join(".devteam", "knowledge");
const PROJECT_FILE = "project.json";
const MAX_FACTS = 6;
const MAX_FACT_CHARS = 320;
const MAX_BYTES = 1600;
const FINGERPRINT_PATHS = [
  "package.json", "package-lock.json", "yarn.lock", "pnpm-lock.yaml", "bun.lockb",
  "tsconfig.json", "pyproject.toml", "requirements.txt", "go.mod", "Cargo.toml",
  "eslint.config.js", "eslint.config.mjs", "biome.json", ".editorconfig",
  "src", "lib", "app", "pkg", "cmd", "internal",
];

function projectKnowledgePath(cwd) {
  return path.join(cwd, KNOWLEDGE_DIR, PROJECT_FILE);
}

function compactList(items) {
  return (items || []).filter(Boolean).join(", ");
}

function sourceFingerprint(cwd) {
  const signals = [];
  for (const relative of FINGERPRINT_PATHS) {
    try {
      const stat = fs.statSync(path.join(cwd, relative));
      signals.push(`${relative}:${stat.isDirectory() ? "d" : "f"}:${stat.size}:${Math.trunc(stat.mtimeMs)}`);
    } catch { /* absent paths are not signals */ }
  }
  return `sha256:${crypto.createHash("sha256").update(signals.join("\n")).digest("hex")}`;
}

function factsFromDiscovery(result) {
  const stack = result.tech_stack || {};
  const test = result.test_config || {};
  const tooling = Object.entries(result.tooling || {}).filter(([, present]) => present).map(([name]) => name);
  const facts = [];
  const stackParts = [
    compactList(stack.languages),
    stack.frameworks && stack.frameworks.length ? `frameworks: ${compactList(stack.frameworks)}` : null,
    stack.package_manager ? `package manager: ${stack.package_manager}` : null,
    stack.bundler ? `bundler: ${stack.bundler}` : null,
  ].filter(Boolean);
  if (stackParts.length > 0) facts.push(`Stack — ${stackParts.join("; ")}.`);
  const conventionParts = [
    result.module_system && result.module_system !== "unknown" ? `modules: ${result.module_system}` : null,
    result.naming && result.naming.file_style !== "unknown" ? `file names: ${result.naming.file_style}` : null,
  ].filter(Boolean);
  if (conventionParts.length > 0) facts.push(`Conventions — ${conventionParts.join("; ")}.`);
  if (test.framework) {
    const testParts = [`runner: ${test.framework}`];
    if (test.pattern) testParts.push(`pattern: ${test.pattern}`);
    if (test.co_located !== null && test.co_located !== undefined) testParts.push(`co-located: ${test.co_located ? "yes" : "no"}`);
    facts.push(`Tests — ${testParts.join("; ")}.`);
  }
  if (tooling.length > 0) facts.push(`Tooling — ${tooling.join(", ")}.`);
  if (Array.isArray(result.verification_commands) && result.verification_commands.length > 0) {
    facts.push(`Verify with — ${result.verification_commands.map((command) => `\`${command}\``).join(", ")}.`);
  }
  return facts.slice(0, MAX_FACTS).map((text) => ({
    kind: "detected-convention",
    source: "static-discovery",
    text: text.slice(0, MAX_FACT_CHARS),
  }));
}

function writeProjectFacts(cwd, result) {
  const file = projectKnowledgePath(cwd);
  const payload = {
    schema_version: SCHEMA_VERSION,
    generated_at: result.timestamp || new Date().toISOString(),
    generator: "devteam standards discover",
    source_fingerprint: sourceFingerprint(cwd),
    facts: factsFromDiscovery(result),
  };
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const temporary = `${file}.tmp-${process.pid}`;
  fs.writeFileSync(temporary, `${JSON.stringify(payload, null, 2)}\n`, "utf8");
  fs.renameSync(temporary, file);
  return { file, facts: payload.facts, generated_at: payload.generated_at };
}

function loadProjectFacts(cwd) {
  try {
    const parsed = readProjectPack(cwd);
    if (!parsed || parsed.schema_version !== SCHEMA_VERSION || !Array.isArray(parsed.facts)) return [];
    const out = [];
    let bytes = 0;
    for (const item of parsed.facts.slice(0, MAX_FACTS)) {
      if (!item || typeof item.text !== "string") continue;
      const fact = {
        kind: "detected-convention",
        source: "static-discovery",
        text: item.text.slice(0, MAX_FACT_CHARS),
      };
      const nextBytes = bytes + Buffer.byteLength(fact.text, "utf8");
      if (nextBytes > MAX_BYTES && out.length > 0) continue;
      bytes = nextBytes;
      out.push(fact);
    }
    return out;
  } catch {
    return [];
  }
}

function readProjectPack(cwd) {
  return JSON.parse(fs.readFileSync(projectKnowledgePath(cwd), "utf8"));
}

function refreshProjectFacts(cwd) {
  const { discover } = require("./standards/discover");
  return writeProjectFacts(cwd, discover(cwd));
}

function loadCurrentProjectFacts(cwd, opts = {}) {
  try {
    const pack = readProjectPack(cwd);
    const existing = loadProjectFacts(cwd);
    if (pack.schema_version === SCHEMA_VERSION && pack.source_fingerprint === sourceFingerprint(cwd)) return existing;
  } catch { /* missing/malformed/stale packs are recomputed below */ }
  try {
    const result = require("./standards/discover").discover(cwd);
    if (opts.persist && fs.existsSync(path.join(cwd, ".devteam"))) {
      return writeProjectFacts(cwd, result).facts;
    }
    return factsFromDiscovery(result);
  } catch {
    return [];
  }
}

module.exports = {
  SCHEMA_VERSION,
  KNOWLEDGE_DIR,
  PROJECT_FILE,
  MAX_BYTES,
  projectKnowledgePath,
  sourceFingerprint,
  factsFromDiscovery,
  writeProjectFacts,
  loadProjectFacts,
  refreshProjectFacts,
  loadCurrentProjectFacts,
};
