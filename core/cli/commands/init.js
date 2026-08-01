"use strict";

const fs = require("node:fs");
const path = require("node:path");
const { generateHelp } = require(path.join(__dirname, "..", "flags"));
const { listHosts, loadAdapter } = require(path.join(__dirname, "..", "..", "router"));
const { writeConfigIfAbsent, configPath, KNOWN_DEPLOY_ADAPTERS, DEPLOY_ADAPTER_ARTIFACTS } = require(path.join(__dirname, "..", "..", "config"));
const { writeGitignoreBlock } = require(path.join(__dirname, "..", "..", "gitignore"));
const patternsLib = require(path.join(__dirname, "..", "..", "patterns"));

const DEPLOY_SRC_DIR = path.join(__dirname, "..", "..", "deploy");

// Install the built-in adapter spec and any adapter-specific project artifacts.
// Safe to re-run: files are only written when absent (or --force).
function installDeployAdapter(cwd, adapterName, opts = {}) {
  const results = { written: [], skipped: [] };

  // Copy the built-in adapter procedure into .devteam/adapters/<name>.md so
  // the platform-deploy skill can find it regardless of host (claude-code can
  // reach the framework source; openai-compat can only read project files).
  const specSrc = path.join(DEPLOY_SRC_DIR, `${adapterName}.md`);
  if (fs.existsSync(specSrc)) {
    const destDir = path.join(cwd, ".devteam", "adapters");
    const destPath = path.join(destDir, `${adapterName}.md`);
    if (!fs.existsSync(destPath) || opts.force) {
      fs.mkdirSync(destDir, { recursive: true });
      fs.copyFileSync(specSrc, destPath);
      results.written.push(path.relative(cwd, destPath));
    } else {
      results.skipped.push(path.relative(cwd, destPath));
    }
  }

  // Scaffold adapter-specific project artifacts (Dockerfile, compose file…).
  for (const { rel, content } of (DEPLOY_ADAPTER_ARTIFACTS[adapterName] || [])) {
    const dest = path.join(cwd, rel);
    if (!fs.existsSync(dest) || opts.force) {
      fs.mkdirSync(path.dirname(dest), { recursive: true });
      fs.writeFileSync(dest, content, "utf8");
      results.written.push(rel);
    } else {
      results.skipped.push(rel);
    }
  }

  return results;
}

const name = "init";

const flags = {
  host:    { type: "string",  description: "Host adapter(s), comma-separated" },
  adapter: { type: "string",  description: `Deploy adapter for stage-08: ${KNOWN_DEPLOY_ADAPTERS.join(", ")}` },
  force:   { type: "boolean", description: "Overwrite existing config/files" },
  cwd:     { type: "string",  description: "Target project directory" },
  profile: { type: "string",  description: "Optional profile: dogfood" },
  help:    { type: "boolean", description: "Show this help" },
};

function run(positional, _flags) {
  if (_flags.help) { console.log(generateHelp("devteam init --host <list> [options]", flags)); process.exit(0); }
  if (!_flags.host) {
    console.error(generateHelp("devteam init --host <list> [options]", flags));
    console.error(`Available hosts: ${listHosts().join(", ") || "(none)"}`);
    process.exit(2);
  }
  const hosts = _flags.host.split(",").map((s) => s.trim()).filter(Boolean);
  const cwd = _flags.cwd || process.cwd();
  const available = new Set(listHosts());
  const unknown = hosts.filter((h) => !available.has(h));
  if (unknown.length > 0) {
    console.error(`Unknown host(s): ${unknown.join(", ")}`);
    console.error(`Available: ${[...available].join(", ")}`);
    process.exit(2);
  }

  const adapter = _flags.adapter || null;
  if (adapter && !KNOWN_DEPLOY_ADAPTERS.includes(adapter)) {
    console.error(`Unknown deploy adapter: ${adapter}`);
    console.error(`Known adapters: ${KNOWN_DEPLOY_ADAPTERS.join(", ")}`);
    process.exit(2);
  }

  console.log(`Initializing devteam in: ${cwd}`);
  console.log(`Host(s): ${hosts.join(", ")}`);
  if (adapter) console.log(`Deploy adapter: ${adapter}`);

  const cfg = writeConfigIfAbsent(cwd, hosts, { force: !!_flags.force, adapter });
  console.log(cfg.written
    ? `  ✓ wrote ${path.relative(cwd, cfg.path)}`
    : `  - skipped ${path.relative(cwd, cfg.path)} (${cfg.reason}; use --force to overwrite)`);

  for (const dir of ["pipeline", "pipeline/gates", ".devteam/templates"]) {
    const p = path.join(cwd, dir);
    if (!fs.existsSync(p)) {
      fs.mkdirSync(p, { recursive: true });
      console.log(`  ✓ created ${dir}/`);
    } else {
      console.log(`  - exists  ${dir}/`);
    }
  }

  const agentsPath = path.join(cwd, "AGENTS.md");
  if (!fs.existsSync(agentsPath) || _flags.force) {
    const stub = [
      "# Project context",
      "",
      "<!-- Fill in: project name, language/stack, key constraints, team conventions.",
      "     This file is read by every pipeline agent before each stage. -->",
      "",
    ].join("\n");
    fs.writeFileSync(agentsPath, stub, "utf8");
    console.log(`  ✓ wrote AGENTS.md (stub — edit with project context)`);
  } else {
    console.log(`  - exists  AGENTS.md`);
  }

  const installedAdapters = [];
  for (const hostName of hosts) {
    console.log(`\nInstalling host adapter: ${hostName}`);
    const adapter = loadAdapter(hostName);
    installedAdapters.push({ hostName, adapter });
    const r = adapter.install(cwd, { force: !!_flags.force });
    console.log(`  written: ${r.written.length}, skipped: ${r.skipped.length}`);
    for (const f of r.warnings) console.log(`  ⚠️  ${f}`);
  }

  // 30.5: offer (never auto-install) the SKILL.md export path when there's
  // both something to export and somewhere for it to go. Reads each
  // installed adapter's own capabilities.skillsDir rather than hardcoding
  // host names, so a new host adapter picks this up for free.
  const hostSkillsDirs = installedAdapters
    .map(({ hostName, adapter }) => ({ hostName, skillsDir: adapter.capabilities && adapter.capabilities.skillsDir }))
    .filter((entry) => entry.skillsDir);
  if (hostSkillsDirs.length > 0) {
    const promotedCount = patternsLib.loadPromoted(cwd).filter((p) => p.status === "promoted").length;
    if (promotedCount > 0) {
      console.log(`\n${promotedCount} promoted pattern(s) found in .devteam/patterns/promoted.json.`);
      console.log("  Tip: export them as a portable Agent Skill: devteam patterns export --skill");
      for (const { hostName, skillsDir } of hostSkillsDirs) {
        console.log(`       then copy the result into ${hostName}'s skills directory: ${skillsDir}/${patternsLib.DEFAULT_SKILL_NAME}/`);
      }
    }
  }

  const deployAdapterToInstall = adapter || "local";
  if (deployAdapterToInstall) {
    console.log(`\nInstalling deploy adapter: ${deployAdapterToInstall}${adapter ? "" : " (default)"}`);
    const dr = installDeployAdapter(cwd, deployAdapterToInstall, { force: !!_flags.force });
    for (const f of dr.written)  console.log(`  ✓ wrote   ${f}`);
    for (const f of dr.skipped)  console.log(`  - exists  ${f}`);
  }

  const giResult = writeGitignoreBlock(cwd);
  if (giResult === "skipped") {
    // block already matches canonical; no output needed
  } else if (giResult === "wrote") {
    console.log("  ✓ wrote .gitignore (stagecraft block)");
  } else {
    console.log("  ✓ updated .gitignore (stagecraft block)");
  }

  if (_flags.profile === "dogfood") {
    const { writeDogfoodGitignoreBlock } = require(path.join(__dirname, "..", "..", "gitignore"));
    const dgr = writeDogfoodGitignoreBlock(cwd);
    console.log(dgr === "skipped"
      ? "  ✓ .gitignore dogfood block already up-to-date"
      : `  ✓ ${dgr === "wrote" ? "wrote" : "updated"} .gitignore (dogfood block)`);

    // Pre-commit infrastructure guard
    const hookDir  = path.join(cwd, ".git", "hooks");
    const hookPath = path.join(hookDir, "pre-commit");
    const GUARD_MARKER = "# stagecraft-dogfood: infrastructure guard";
    const GUARD_BLOCK = [
      "#!/bin/bash",
      "# stagecraft-dogfood: infrastructure guard — managed by devteam init --profile dogfood",
      'BLOCKED_PREFIXES="core/ bin/devteam pipeline/stages/ roles/ rules/"',
      'for f in $(git diff --cached --name-only); do',
      '  for b in $BLOCKED_PREFIXES; do',
      '    if [[ "$f" == ${b}* ]] || [[ "$f" == "$b" ]]; then',
      '      echo "ERROR [dogfood guard]: cannot commit changes to Stagecraft infrastructure: $f"',
      '      echo "       Stagecraft files must not be modified during a dogfood run."',
      '      echo "       Use \'git restore --staged $f\' to unstage, or fix the root cause."',
      '      exit 1',
      '    fi',
      '  done',
      'done',
    ].join("\n");

    if (!fs.existsSync(hookDir)) {
      console.log("  ⚠ .git/hooks/ not found — is this a git repository?");
    } else if (fs.existsSync(hookPath) && fs.readFileSync(hookPath, "utf8").includes(GUARD_MARKER)) {
      console.log("  ✓ pre-commit hook dogfood guard already present");
    } else if (fs.existsSync(hookPath)) {
      const existing = fs.readFileSync(hookPath, "utf8");
      const lines = existing.split("\n");
      const shebangLine = lines[0].startsWith("#!") ? lines[0] : null;
      const rest = shebangLine ? lines.slice(1).join("\n") : existing;
      const guardBody = GUARD_BLOCK.split("\n").slice(1).join("\n"); // skip #!/bin/bash
      const newContent = shebangLine
        ? shebangLine + "\n" + guardBody + "\n" + rest
        : GUARD_BLOCK + "\n" + existing;
      fs.writeFileSync(hookPath, newContent, "utf8");
      fs.chmodSync(hookPath, 0o755);
      console.log("  ✓ pre-commit hook: prepended dogfood infrastructure guard");
    } else {
      fs.mkdirSync(hookDir, { recursive: true });
      fs.writeFileSync(hookPath, GUARD_BLOCK + "\n", "utf8");
      fs.chmodSync(hookPath, 0o755);
      console.log("  ✓ wrote pre-commit hook (dogfood infrastructure guard)");
    }

    // .git/info/exclude entry
    const infoDir     = path.join(cwd, ".git", "info");
    const excludePath = path.join(infoDir, "exclude");
    const EXCLUDE_LINE = "pipeline/stages/deploy.md";
    if (fs.existsSync(infoDir)) {
      const exc = fs.existsSync(excludePath) ? fs.readFileSync(excludePath, "utf8") : "";
      if (!exc.includes(EXCLUDE_LINE)) {
        const sep = exc.length > 0 && !exc.endsWith("\n") ? "\n" : "";
        fs.writeFileSync(excludePath, exc + sep + EXCLUDE_LINE + "\n", "utf8");
        console.log("  ✓ wrote .git/info/exclude (pipeline/stages/deploy.md)");
      } else {
        console.log("  ✓ .git/info/exclude already contains deploy.md entry");
      }
    } else {
      console.log("  ⚠ .git/info/ not found — skipping .git/info/exclude");
    }

    // Write profile marker to config.yml
    const cfgPath = path.join(cwd, ".devteam", "config.yml");
    if (fs.existsSync(cfgPath)) {
      const cfgContent = fs.readFileSync(cfgPath, "utf8");
      if (!cfgContent.includes("profile: dogfood")) {
        fs.writeFileSync(cfgPath, `profile: dogfood\n\n${cfgContent}`, "utf8");
        console.log("  ✓ wrote profile: dogfood to .devteam/config.yml");
      } else {
        console.log("  ✓ profile: dogfood already in .devteam/config.yml");
      }
    }

    console.log("\n✅ Dogfood profile active. Run 'devteam doctor' to verify the install.");
    console.log("   Tip: use --budget-usd with devteam run to cap spend during dogfood runs.");
  }

  console.log(`\nNext: edit ${path.relative(cwd, configPath(cwd))} if you need custom routing, then \`devteam stage requirements --feature "..."\`.`);
}

module.exports = { name, flags, run };
