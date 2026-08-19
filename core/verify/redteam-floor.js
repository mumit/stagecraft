// Mechanical red-team floor (31.2). Post-dispatch for stage-04c, the
// orchestrator runs a handful of checks that cannot be sweet-talked by a
// model's self-report: a dependency audit, the existing secret-scan over
// the changeset, semgrep (only if the project already configures it), and
// a lockfile delta since the previous stage-04c attempt. Each check reports
// { ran, skipped, reason, findings } — never silently treated as pass when
// it didn't actually run (see runDependencyAudit's offline handling).
//
// [verify-first, 31.2] Phase 19 / PR #264 ("polyglot verification") only
// discovers TEST commands (Node/pytest/go test) — see resolveTestCommands
// in ./runner.js. There is no existing polyglot dependency-audit/SCA
// equivalent (no pip-audit / govulncheck detection) to reuse. This module
// therefore only wires `npm audit --json` for Node projects; non-Node
// projects record an honest skip rather than inventing new tooling.

const fs = require("node:fs");
const path = require("node:path");
const { spawnSync } = require("node:child_process");
const { runCommand } = require("./runner");
const { scanContent, isAllowlistedPath } = require("../hooks/secret-scan");
const { listArchives } = require("../gates/archive");

const NETWORK_ERROR_RE = /ENOTFOUND|ETIMEDOUT|ECONNREFUSED|ECONNRESET|EAI_AGAIN|ENETUNREACH|network|getaddrinfo|audit endpoint/i;
const NPM_SEVERITY_MAP = { info: "low", low: "low", moderate: "medium", high: "high", critical: "critical" };
const MAX_SCAN_BYTES = 1_000_000;
const SEMGREP_CONFIG_CANDIDATES = [".semgrep.yml", ".semgrep.yaml", "semgrep.yml", "semgrep.yaml", ".semgrep"];
const SEMGREP_SEVERITY_MAP = { ERROR: "high", WARNING: "medium", INFO: "low" };

function record({ ran, reason, findings }) {
  return { ran, skipped: !ran, reason: reason || null, findings: findings || [] };
}

// --- (a) dependency audit ----------------------------------------------

function extractNpmAuditFindings(parsed) {
  const vulns = (parsed && parsed.vulnerabilities) || {};
  const findings = [];
  let i = 0;
  for (const [name, v] of Object.entries(vulns)) {
    i += 1;
    const npmSeverity = typeof v?.severity === "string" ? v.severity : "moderate";
    const severity = NPM_SEVERITY_MAP[npmSeverity] || "medium";
    const via = Array.isArray(v?.via) ? v.via.find((x) => x && typeof x === "object" && x.title) : null;
    findings.push({
      id: `RT-MECH-audit-${i}`,
      severity,
      surface: "dependency_supply_chain",
      summary: `dependency vulnerability: ${name} (${npmSeverity})${via ? ` — ${via.title}` : ""}`,
    });
  }
  return findings;
}

async function runDependencyAudit(cwd, config) {
  const verify = (config && config.pipeline && config.pipeline.verify) || {};
  const override = verify.dependency_audit_command;

  if (override === null) {
    return record({ ran: false, reason: "dependency audit explicitly disabled (verify.dependency_audit_command: null)" });
  }

  let command;
  if (typeof override === "string" && override.trim()) {
    command = override.trim();
  } else if (fs.existsSync(path.join(cwd, "package.json"))) {
    command = "npm audit --json";
  } else {
    return record({
      ran: false,
      reason: "no polyglot dependency-audit tooling for this project type — Phase 19/PR #264 covers test-suite discovery only, not SCA",
    });
  }

  const result = await runCommand(command, { cwd, timeoutMs: 5 * 60 * 1000 });

  let parsed = null;
  try { parsed = JSON.parse(result.stdout); } catch { parsed = null; }

  if (!parsed) {
    if (result.spawnError) {
      return record({ ran: false, reason: `could not run dependency audit: ${result.spawnError}` });
    }
    const offline = NETWORK_ERROR_RE.test(result.stderr || "") || NETWORK_ERROR_RE.test(result.stdout || "");
    if (offline) {
      // Network-unavailable is an honest skip, never a pass — the absence of
      // a result must never be mistaken for the absence of vulnerabilities.
      return record({ ran: false, reason: "offline" });
    }
    return record({ ran: false, reason: `dependency-audit output unparseable (exit ${result.exitCode})` });
  }

  const findings = extractNpmAuditFindings(parsed);
  return {
    ran: true,
    skipped: false,
    reason: `${command} (exit ${result.exitCode}, ${findings.length} finding(s))`,
    findings,
  };
}

// --- (b) secret-scan over the changed-file set --------------------------

function getChangedFiles(cwd) {
  const changedFilesTxt = path.join(cwd, "pipeline", "changed-files.txt");
  if (fs.existsSync(changedFilesTxt)) {
    try {
      const files = fs.readFileSync(changedFilesTxt, "utf8").split(/\r?\n/).map((s) => s.trim()).filter(Boolean);
      if (files.length > 0) return files;
    } catch { /* fall through to git */ }
  }
  const working = spawnSync("git", ["diff", "--name-only", "HEAD"], { cwd, encoding: "utf8" });
  if (!working || working.status !== 0) return [];
  const workingFiles = working.stdout.split(/\r?\n/).filter(Boolean);
  if (workingFiles.length > 0) return workingFiles;

  // Build agents normally commit before red-team runs. In that lifecycle an
  // empty working-tree diff means the changeset is the latest commit, not that
  // there are no changed files.
  const committed = spawnSync("git", ["show", "--name-only", "--format=", "HEAD"], { cwd, encoding: "utf8" });
  if (!committed || committed.status !== 0) return [];
  return committed.stdout.split(/\r?\n/).filter(Boolean);
}

function runSecretScanFloor(cwd, changedFiles) {
  if (changedFiles.length === 0) {
    return record({ ran: true, reason: "no changed files detected (pipeline/changed-files.txt absent and neither the working tree nor HEAD contains a changeset)" });
  }

  const findings = [];
  let scanned = 0;
  let i = 0;
  for (const rel of changedFiles) {
    if (isAllowlistedPath(rel)) continue;
    const abs = path.join(cwd, rel);
    let content;
    try {
      const stat = fs.lstatSync(abs);
      if (!stat.isFile() || stat.isSymbolicLink() || stat.size > MAX_SCAN_BYTES) continue;
      content = fs.readFileSync(abs, "utf8");
    } catch { continue; }
    scanned += 1;
    for (const hit of scanContent(content)) {
      i += 1;
      findings.push({
        id: `RT-MECH-secret-${i}`,
        severity: hit.severity === "critical" ? "critical" : "medium",
        surface: "secret_exposure",
        summary: `${hit.name} detected in ${rel}:${hit.line}`,
      });
    }
  }
  return {
    ran: true,
    skipped: false,
    reason: `scanned ${scanned}/${changedFiles.length} changed file(s), ${findings.length} finding(s)`,
    findings,
  };
}

// --- (c) semgrep, only if config + binary already present ---------------

function findSemgrepConfig(cwd) {
  for (const name of SEMGREP_CONFIG_CANDIDATES) {
    const p = path.join(cwd, name);
    if (fs.existsSync(p)) return p;
  }
  return null;
}

function semgrepOnPath() {
  const probe = spawnSync(process.platform === "win32" ? "where" : "which", ["semgrep"], { encoding: "utf8" });
  return Boolean(probe) && probe.status === 0;
}

function mapSemgrepSeverity(sev) {
  return SEMGREP_SEVERITY_MAP[String(sev || "").toUpperCase()] || "medium";
}

async function runSemgrepFloor(cwd, changedFiles) {
  const configPath = findSemgrepConfig(cwd);
  if (!configPath) {
    return record({ ran: false, reason: "no semgrep config found in project (devteam never installs semgrep or its config)" });
  }
  if (!semgrepOnPath()) {
    return record({ ran: false, reason: "semgrep config present but the semgrep binary is not on PATH (devteam never auto-installs it)" });
  }
  if (changedFiles.length === 0) {
    return record({ ran: false, reason: "no changed files to scan" });
  }

  const args = ["--config", configPath, "--json", "--quiet", ...changedFiles];
  const proc = spawnSync("semgrep", args, { cwd, encoding: "utf8", timeout: 5 * 60 * 1000, maxBuffer: 10 * 1024 * 1024 });

  let parsed = null;
  try { parsed = JSON.parse(proc.stdout); } catch { parsed = null; }
  if (!parsed) {
    return record({ ran: false, reason: `semgrep output unparseable (exit ${proc.status})` });
  }

  const results = Array.isArray(parsed.results) ? parsed.results : [];
  const findings = results.map((r, idx) => ({
    id: `RT-MECH-semgrep-${idx + 1}`,
    severity: mapSemgrepSeverity(r?.extra?.severity),
    surface: "static_analysis",
    summary: `${r.check_id || "semgrep finding"}: ${r?.extra?.message || ""} (${r.path}:${r?.start?.line ?? "?"})`,
  }));
  return {
    ran: true,
    skipped: false,
    reason: `${configPath} (exit ${proc.status}, ${findings.length} finding(s))`,
    findings,
  };
}

// --- (d) new-dependencies diff since the previous stage-04c attempt ------

function readLockfileSnapshot(cwd) {
  const lockPath = path.join(cwd, "package-lock.json");
  if (!fs.existsSync(lockPath)) return null;
  let lock;
  try { lock = JSON.parse(fs.readFileSync(lockPath, "utf8")); } catch { return null; }

  const snapshot = {};
  if (lock.packages && typeof lock.packages === "object") {
    // npm lockfileVersion 3 shape: keys are "node_modules/name" or
    // "node_modules/@scope/name" (possibly nested for dedupe).
    for (const [key, meta] of Object.entries(lock.packages)) {
      if (!key || key === "") continue;
      const idx = key.lastIndexOf("node_modules/");
      if (idx === -1) continue;
      const name = key.slice(idx + "node_modules/".length);
      if (!name) continue;
      snapshot[name] = meta && meta.version ? meta.version : null;
    }
  } else if (lock.dependencies && typeof lock.dependencies === "object") {
    // npm lockfileVersion 1/2 shape: top-level name -> { version }.
    for (const [name, meta] of Object.entries(lock.dependencies)) {
      snapshot[name] = meta && meta.version ? meta.version : null;
    }
  }
  return snapshot;
}

function computeDependencyDiff(cwd, gatesDir) {
  const currentSnapshot = readLockfileSnapshot(cwd);
  if (!currentSnapshot) {
    return { ran: false, skipped: true, reason: "no package-lock.json found", findings: [], new_dependencies: [], removed_dependencies: [] };
  }

  const attempts = listArchives(gatesDir, "stage-04c");
  let previousSnapshot = null;
  for (let idx = attempts.length - 1; idx >= 0; idx -= 1) {
    try {
      const archived = JSON.parse(fs.readFileSync(attempts[idx].file, "utf8"));
      const prev = archived?._orchestrator_stamped?.runs?.dependency_diff?.snapshot;
      if (prev && typeof prev === "object") { previousSnapshot = prev; break; }
    } catch { /* try an earlier attempt */ }
  }

  if (!previousSnapshot) {
    return {
      ran: true,
      skipped: false,
      reason: "no previous stage-04c attempt to diff against — recording baseline snapshot",
      findings: [],
      new_dependencies: [],
      removed_dependencies: [],
      snapshot: currentSnapshot,
    };
  }

  const newDeps = Object.keys(currentSnapshot).filter((name) => !(name in previousSnapshot))
    .map((name) => ({ name, version: currentSnapshot[name] }));
  const removedDeps = Object.keys(previousSnapshot).filter((name) => !(name in currentSnapshot));

  return {
    ran: true,
    skipped: false,
    reason: `${newDeps.length} new, ${removedDeps.length} removed since previous stage-04c attempt`,
    findings: [],
    new_dependencies: newDeps,
    removed_dependencies: removedDeps,
    snapshot: currentSnapshot,
  };
}

module.exports = {
  runDependencyAudit,
  runSecretScanFloor,
  runSemgrepFloor,
  computeDependencyDiff,
  getChangedFiles,
  extractNpmAuditFindings,
  findSemgrepConfig,
  readLockfileSnapshot,
};
