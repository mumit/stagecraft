"use strict";

const fs = require("node:fs");
const path = require("node:path");
const { generateHelp } = require(path.join(__dirname, "..", "flags"));
const { TRACKS } = require(path.join(__dirname, "..", "..", "pipeline", "stages"));
const { splitCommand } = require(path.join(__dirname, "..", "..", "command-line"));

const FRAMEWORK_ROOT = path.join(__dirname, "..", "..", "..");

const name = "doctor";

function pathDelimiterFor(platform) {
  return platform === "win32" ? ";" : path.delimiter;
}

function executableCandidates(bin, opts = {}) {
  const platform = opts.platform || process.platform;
  if (platform !== "win32" || path.extname(bin)) return [bin];

  const pathExt = opts.pathExt || process.env.PATHEXT || ".COM;.EXE;.BAT;.CMD";
  const extensions = pathExt
    .split(";")
    .map((ext) => ext.trim())
    .filter(Boolean)
    .map((ext) => ext.startsWith(".") ? ext : `.${ext}`);
  return [bin, ...extensions.map((ext) => `${bin}${ext}`)];
}

function isExecutable(file, platform) {
  fs.accessSync(file, platform === "win32" ? fs.constants.F_OK : fs.constants.X_OK);
}

// Pure-Node PATH probe — no subprocess. Returns the resolved path on success, null if not found.
// Exported for unit-testing.
function findOnPath(bin, pathVar, opts = {}) {
  const platform = opts.platform || process.platform;
  const delimiter = opts.pathDelimiter || pathDelimiterFor(platform);
  const dirs = (pathVar !== undefined ? pathVar : process.env.PATH || "").split(delimiter);
  const candidates = executableCandidates(bin, { ...opts, platform });
  for (const dir of dirs) {
    if (!dir) continue;
    for (const candidate of candidates) {
      const full = path.join(dir, candidate);
      try { isExecutable(full, platform); return full; } catch { /* try next */ }
    }
  }
  return null;
}

const flags = {
  cwd:  { type: "string",  description: "Target project directory" },
  help: { type: "boolean", description: "Show this help" },
};

function run(positional, _flags) {
  if (_flags.help) { console.log(generateHelp("devteam doctor [options]", flags)); process.exit(0); }
  const cwd = _flags.cwd || process.cwd();
  const { loadConfig, configPath } = require(path.join(FRAMEWORK_ROOT, "core", "config"));
  let criticalFailures = 0;
  let warnings = 0;

  function check(label, ok, detail) {
    const icon = ok === true ? "✓" : ok === "info" ? "ℹ" : ok === "warn" ? "⚠" : "✗";
    console.log(`  ${icon} ${label}${detail ? `  — ${detail}` : ""}`);
    if (ok === false) criticalFailures++;
    if (ok === "warn") warnings++;
  }

  console.log("Framework install");
  check("bin/devteam exists", fs.existsSync(path.join(FRAMEWORK_ROOT, "bin", "devteam")));
  check("core/orchestrator.js loads", fs.existsSync(path.join(FRAMEWORK_ROOT, "core", "orchestrator.js")));
  check("package.json parses",
    (() => { try { JSON.parse(fs.readFileSync(path.join(FRAMEWORK_ROOT, "package.json"), "utf8")); return true; } catch { return false; } })());
  check("node_modules/js-yaml present", fs.existsSync(path.join(FRAMEWORK_ROOT, "node_modules", "js-yaml")),
    fs.existsSync(path.join(FRAMEWORK_ROOT, "node_modules", "js-yaml")) ? null : "run `npm install` in the framework dir");
  const hfAvailable = fs.existsSync(path.join(FRAMEWORK_ROOT, "node_modules", "@huggingface", "transformers"));
  check("builtin memory retrieval", true, "available (dependency-free)");
  check("transformer embeddings (optional)",
    "info",
    hfAvailable ? "available (DEVTEAM_EMBEDDING_PROVIDER=local works)" : "not installed — assess upstream advisories before adding @huggingface/transformers");

  console.log("\nTarget project");
  console.log(`  cwd: ${cwd}`);
  const configFile = configPath(cwd);
  check(".devteam/config.yml exists", fs.existsSync(configFile),
    fs.existsSync(configFile) ? null : "run `devteam init --host <name>`");
  // 42.6: which of the two install shapes this is. Reported rather than
  // checked -- a checkout-local install is a deliberate choice, not a fault --
  // except for "untracked", which is neither shape and is usually an install
  // nobody finished. Without this, a deliberately-local setup and a committed
  // one that lost its files looked identical here, and they need opposite fixes.
  {
    const { resolveInstallMode, describeInstallMode } = require(path.join(__dirname, "..", "..", "install-mode"));
    const resolved = resolveInstallMode(cwd);
    const described = describeInstallMode(resolved);
    check("install mode", resolved.mode === "untracked" ? "warn" : "info",
      described.advice ? `${described.text} — ${described.advice}` : described.text);
  }
  check("pipeline/gates/ exists", fs.existsSync(path.join(cwd, "pipeline", "gates")));

  if (!fs.existsSync(configFile)) {
    console.log(`\n${criticalFailures} critical failure(s), ${warnings} warning(s)`);
    process.exit(1);
  }

  const config = loadConfig(cwd);
  console.log("\nConfig");
  check("config parses", config._source === "file", `source: ${config._source}`);
  check("default_host set", !!config.routing.default_host, `→ ${config.routing.default_host}`);
  check(`default_track is valid`, TRACKS.includes(config.pipeline.default_track),
    `→ ${config.pipeline.default_track}`);

  // Gather all hosts referenced by the config
  const referencedHosts = new Set();
  referencedHosts.add(config.routing.default_host);
  for (const v of Object.values(config.routing.roles || {})) referencedHosts.add(v);
  for (const v of Object.values(config.routing.stages || {})) referencedHosts.add(v);

  console.log("\nAdapters");
  const { listHosts, loadAdapter } = require(path.join(FRAMEWORK_ROOT, "core", "router"));
  const available = new Set(listHosts());
  for (const h of referencedHosts) {
    // Phase-28 item 28.6: Gemini CLI stopped serving free/Pro/Ultra requests
    // 2026-06-18 in favor of Antigravity CLI. Phase 34.4 moved the adapter
    // itself out to the @devteam/host-gemini-cli plugin package, so this
    // check runs BEFORE the availability gate below — routing to gemini-cli
    // is the deprecation signal, independent of whether the plugin happens
    // to be installed.
    if (h === "gemini-cli") {
      check("  gemini-cli is deprecated upstream", "warn",
        "Gemini CLI stopped serving free/Pro/Ultra requests 2026-06-18 — migrate with: devteam init --host antigravity");
    }
    if (!available.has(h)) {
      check(`host "${h}" available`, false, h === "gemini-cli"
        ? "moved to a plugin package — install: npm install @devteam/host-gemini-cli"
        : `no adapter at hosts/${h}/`);
      continue;
    }
    const adapter = loadAdapter(h);
    const status = adapter.status(cwd);
    check(`host "${h}" install`, status.ok, status.ok ? null : `${status.missing.length} missing file(s)`);
    if (adapter.capabilities && adapter.capabilities.headless && adapter.capabilities.headlessCommand) {
      let bin;
      try {
        ({ bin } = splitCommand(adapter.capabilities.headlessCommand, "headlessCommand"));
      } catch (err) {
        check(`  headlessCommand parses`, "warn", err.message);
        continue;
      }
      const found = findOnPath(bin);
      check(`  ${bin} on PATH (for --headless)`, found ? true : "warn",
        found ? found : `${bin} not found; --headless will fail`);
    }
  }

  // Dogfood mode checks: only shown when profile: dogfood is set in config.yml
  const profile = config._raw?.profile;
  if (profile === "dogfood") {
    console.log("\nDogfood mode");

    // 1. Pre-commit hook present and contains guard
    const hookPath    = path.join(cwd, ".git", "hooks", "pre-commit");
    const hookExists  = fs.existsSync(hookPath);
    const hookContent = hookExists ? fs.readFileSync(hookPath, "utf8") : "";
    const guardOk = hookExists && hookContent.includes("# stagecraft-dogfood");
    check("pre-commit infrastructure guard", guardOk,
      guardOk ? null : hookExists ? "guard marker missing — re-run devteam init --profile dogfood" : "hook missing — run devteam init --profile dogfood");

    // 2. Hook is executable (only checked when hook exists)
    if (hookExists) {
      let hookExecutable = false;
      try { fs.accessSync(hookPath, fs.constants.X_OK); hookExecutable = true; } catch { /* */ }
      check("pre-commit hook is executable", hookExecutable,
        hookExecutable ? null : "run: chmod +x .git/hooks/pre-commit");
    }

    // 3. Dogfood gitignore block present
    const giPath = path.join(cwd, ".gitignore");
    const giContent = fs.existsSync(giPath) ? fs.readFileSync(giPath, "utf8") : "";
    const giOk = giContent.includes("# BEGIN stagecraft-dogfood");
    check(".gitignore dogfood block present", giOk,
      giOk ? null : "run: devteam init --profile dogfood");

    // 4. pipeline/stages/deploy.md in .git/info/exclude
    const excludePath = path.join(cwd, ".git", "info", "exclude");
    const excludeContent = fs.existsSync(excludePath) ? fs.readFileSync(excludePath, "utf8") : "";
    const excludeOk = excludeContent.includes("pipeline/stages/deploy.md");
    check(".git/info/exclude: deploy.md entry", excludeOk,
      excludeOk ? null : "run: devteam init --profile dogfood");

    // 5. No npm publish script (anti-pattern for dogfooding)
    const pkgPath = path.join(cwd, "package.json");
    if (fs.existsSync(pkgPath)) {
      let pkg = {};
      try { pkg = JSON.parse(fs.readFileSync(pkgPath, "utf8")); } catch { /* */ }
      const hasPublish = !!(pkg.scripts && pkg.scripts.publish);
      check("no npm publish script", hasPublish ? "warn" : true,
        hasPublish ? "dogfood mode on a publishable package — double-check you are in the right project" : null);
    }

    // 6. Budget reminder (advisory — always shown in dogfood mode)
    check("usage-budget reminder", "info",
      "use --budget-usd and/or --budget-tokens with devteam run to cap usage");
  }

  console.log("");
  if (criticalFailures > 0) {
    console.log(`❌ ${criticalFailures} critical failure(s), ${warnings} warning(s)`);
    process.exit(1);
  }
  if (warnings > 0) {
    console.log(`⚠️  ${warnings} warning(s)`);
    process.exit(0);
  }
  console.log("✅ everything looks good");
}

module.exports = { name, flags, run, findOnPath };
