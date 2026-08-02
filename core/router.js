// Resolve and load host adapters per (stage, role).
//
// Built-in adapters live under <project-root>/hosts/<name>/adapter.js.
// External adapters may be installed as @devteam/host-<name> packages.
// Each adapter module exports the contract documented in
// core/adapters/host-adapter.md: capabilities, install, renderStagePrompt,
// [invoke], status, uninstall.

const fs = require("node:fs");
const path = require("node:path");
const { resolveRoute } = require("./config");

const PROJECT_ROOT = path.resolve(__dirname, "..");
const HOSTS_DIR = path.join(PROJECT_ROOT, "hosts");
const EXTERNAL_SCOPE = "@devteam";
const EXTERNAL_PREFIX = "host-";

function adapterPath(hostName) {
  return path.join(HOSTS_DIR, hostName, "adapter.js");
}

function packageNameForHost(hostName) {
  return `${EXTERNAL_SCOPE}/${EXTERNAL_PREFIX}${hostName}`;
}

function moduleSearchRoots() {
  return Array.from(new Set([process.cwd(), PROJECT_ROOT]));
}

function externalAdapterPath(hostName) {
  const packageName = packageNameForHost(hostName);
  const paths = moduleSearchRoots();
  for (const specifier of [`${packageName}/adapter.js`, packageName]) {
    try {
      return require.resolve(specifier, { paths });
    } catch (err) {
      if (err && err.code !== "MODULE_NOT_FOUND") throw err;
    }
  }
  return null;
}

function externalPackageScopeDir(root) {
  return path.join(root, "node_modules", EXTERNAL_SCOPE);
}

function listExternalHosts() {
  const hosts = new Set();
  for (const root of moduleSearchRoots()) {
    const scopeDir = externalPackageScopeDir(root);
    if (!fs.existsSync(scopeDir)) continue;
    for (const entry of fs.readdirSync(scopeDir, { withFileTypes: true })) {
      if (!entry.isDirectory() || !entry.name.startsWith(EXTERNAL_PREFIX)) {
        continue;
      }
      const hostName = entry.name.slice(EXTERNAL_PREFIX.length);
      if (hostName && externalAdapterPath(hostName)) {
        hosts.add(hostName);
      }
    }
  }
  return Array.from(hosts).sort();
}

function loadAdapter(hostName) {
  const p = fs.existsSync(adapterPath(hostName))
    ? adapterPath(hostName)
    : externalAdapterPath(hostName);
  if (!p) {
    throw new Error(
      `No adapter found for host "${hostName}". Checked ${adapterPath(hostName)} ` +
      `and package ${packageNameForHost(hostName)}. ` +
      `Available hosts: ${listHosts().join(", ") || "(none installed)"}.`,
    );
  }
  return require(p);
}

function listHosts() {
  const hosts = new Set();
  if (fs.existsSync(HOSTS_DIR)) {
    for (const name of fs.readdirSync(HOSTS_DIR)) {
      if (fs.existsSync(adapterPath(name))) hosts.add(name);
    }
  }
  for (const name of listExternalHosts()) hosts.add(name);
  return Array.from(hosts).sort();
}

function resolveAdapter(config, stage, role) {
  const { hostName, model } = resolveRoute(config, stage, role);
  if (!hostName) {
    throw new Error(
      `Routing did not resolve a host for stage="${stage}" role="${role}". ` +
      `Set routing.default_host in .devteam/config.yml.`,
    );
  }
  // 32.3: model is the routing-resolved model for this (stage, role), if
  // routing.roles/stages pinned one via the {host, model} object form.
  // Undefined when nothing pinned one — adapters treat that as "use your
  // own default."
  return { hostName, model, adapter: loadAdapter(hostName) };
}

module.exports = { resolveAdapter, loadAdapter, listHosts };
