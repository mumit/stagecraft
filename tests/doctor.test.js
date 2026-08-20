"use strict";

const { describe, it, afterEach } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const { cleanup, runCLI, makeTargetProject } = require("./_helpers");

let _dirs = [];
function track(cwd) { _dirs.push(cwd); return cwd; }
afterEach(() => { _dirs.forEach(cleanup); _dirs = []; });

// Creates a minimal tempdir with a valid .devteam/config.yml and pipeline/gates/
// so that doctor can load config and reach the dogfood section.
function makeDogfoodProject(opts = {}) {
  const cwd = track(fs.mkdtempSync(path.join(os.tmpdir(), "devteam-test-")));

  fs.mkdirSync(path.join(cwd, ".devteam"), { recursive: true });
  const configYml = opts.noProfile
    ? "routing:\n  default_host: generic\npipeline:\n  default_track: full\n"
    : "profile: dogfood\n\nrouting:\n  default_host: generic\npipeline:\n  default_track: full\n";
  fs.writeFileSync(path.join(cwd, ".devteam", "config.yml"), configYml);

  fs.mkdirSync(path.join(cwd, "pipeline", "gates"), { recursive: true });
  fs.mkdirSync(path.join(cwd, ".git", "hooks"), { recursive: true });
  fs.mkdirSync(path.join(cwd, ".git", "info"), { recursive: true });

  if (opts.hookContent !== undefined) {
    fs.writeFileSync(path.join(cwd, ".git", "hooks", "pre-commit"), opts.hookContent);
    if (opts.hookExecutable !== false) {
      fs.chmodSync(path.join(cwd, ".git", "hooks", "pre-commit"), 0o755);
    } else {
      fs.chmodSync(path.join(cwd, ".git", "hooks", "pre-commit"), 0o644);
    }
  }

  if (opts.gitignoreContent !== undefined) {
    fs.writeFileSync(path.join(cwd, ".gitignore"), opts.gitignoreContent);
  }

  if (opts.excludeContent !== undefined) {
    fs.writeFileSync(path.join(cwd, ".git", "info", "exclude"), opts.excludeContent);
  }

  if (opts.packageJson !== undefined) {
    fs.writeFileSync(path.join(cwd, "package.json"), JSON.stringify(opts.packageJson, null, 2));
  }

  return cwd;
}

const GUARD_MARKER = "# stagecraft-dogfood: infrastructure guard";
const DOGFOOD_BLOCK = "# BEGIN stagecraft-dogfood";
const DEPLOY_EXCLUDE = "pipeline/stages/deploy.md";

describe("devteam doctor — dogfood mode section", () => {
  it("shows 'Dogfood mode' section when profile: dogfood is set", () => {
    const cwd = makeDogfoodProject({
      hookContent: `#!/bin/bash\n${GUARD_MARKER}\n`,
      gitignoreContent: `${DOGFOOD_BLOCK}\n# END stagecraft-dogfood\n`,
      excludeContent: `${DEPLOY_EXCLUDE}\n`,
    });

    const r = runCLI(["doctor", "--cwd", cwd]);

    assert.ok(r.stdout.includes("Dogfood mode"), `stdout must include 'Dogfood mode'\n${r.stdout}`);
  });

  it("does NOT show 'Dogfood mode' section when profile is absent", () => {
    const cwd = makeDogfoodProject({ noProfile: true });

    const r = runCLI(["doctor", "--cwd", cwd]);

    assert.ok(!r.stdout.includes("Dogfood mode"), `stdout must NOT include 'Dogfood mode'\n${r.stdout}`);
  });

  it("passes pre-commit guard check when hook contains guard marker", () => {
    const cwd = makeDogfoodProject({
      hookContent: `#!/bin/bash\n${GUARD_MARKER} — managed by devteam init --profile dogfood\n`,
      gitignoreContent: `${DOGFOOD_BLOCK}\n# END stagecraft-dogfood\n`,
      excludeContent: `${DEPLOY_EXCLUDE}\n`,
    });

    const r = runCLI(["doctor", "--cwd", cwd]);

    assert.ok(r.stdout.includes("✓ pre-commit infrastructure guard"), r.stdout);
  });

  it("fails pre-commit guard check when hook is missing", () => {
    const cwd = makeDogfoodProject({
      gitignoreContent: `${DOGFOOD_BLOCK}\n# END stagecraft-dogfood\n`,
      excludeContent: `${DEPLOY_EXCLUDE}\n`,
    });

    const r = runCLI(["doctor", "--cwd", cwd]);

    assert.ok(r.stdout.includes("✗ pre-commit infrastructure guard"), r.stdout);
    assert.ok(r.stdout.includes("hook missing"), r.stdout);
  });

  it("fails pre-commit guard check when hook exists but lacks guard marker", () => {
    const cwd = makeDogfoodProject({
      hookContent: "#!/bin/bash\necho hello\n",
      gitignoreContent: `${DOGFOOD_BLOCK}\n# END stagecraft-dogfood\n`,
      excludeContent: `${DEPLOY_EXCLUDE}\n`,
    });

    const r = runCLI(["doctor", "--cwd", cwd]);

    assert.ok(r.stdout.includes("✗ pre-commit infrastructure guard"), r.stdout);
    assert.ok(r.stdout.includes("guard marker missing"), r.stdout);
  });

  it("passes executable check when hook is executable", () => {
    const cwd = makeDogfoodProject({
      hookContent: `#!/bin/bash\n${GUARD_MARKER}\n`,
      hookExecutable: true,
      gitignoreContent: `${DOGFOOD_BLOCK}\n# END stagecraft-dogfood\n`,
      excludeContent: `${DEPLOY_EXCLUDE}\n`,
    });

    const r = runCLI(["doctor", "--cwd", cwd]);

    assert.ok(r.stdout.includes("✓ pre-commit hook is executable"), r.stdout);
  });

  it("fails when hook is not executable", () => {
    const cwd = makeDogfoodProject({
      hookContent: `#!/bin/bash\n${GUARD_MARKER}\n`,
      hookExecutable: false,
      gitignoreContent: `${DOGFOOD_BLOCK}\n# END stagecraft-dogfood\n`,
      excludeContent: `${DEPLOY_EXCLUDE}\n`,
    });

    const r = runCLI(["doctor", "--cwd", cwd]);

    assert.ok(r.stdout.includes("✗ pre-commit hook is executable"), r.stdout);
    assert.ok(r.stdout.includes("chmod +x"), r.stdout);
  });

  it("passes gitignore block check when dogfood block present", () => {
    const cwd = makeDogfoodProject({
      hookContent: `#!/bin/bash\n${GUARD_MARKER}\n`,
      gitignoreContent: `${DOGFOOD_BLOCK}\npipeline/brief.md\n# END stagecraft-dogfood\n`,
      excludeContent: `${DEPLOY_EXCLUDE}\n`,
    });

    const r = runCLI(["doctor", "--cwd", cwd]);

    assert.ok(r.stdout.includes("✓ .gitignore dogfood block present"), r.stdout);
  });

  it("fails gitignore block check when dogfood block is absent", () => {
    const cwd = makeDogfoodProject({
      hookContent: `#!/bin/bash\n${GUARD_MARKER}\n`,
      gitignoreContent: "node_modules/\n",
      excludeContent: `${DEPLOY_EXCLUDE}\n`,
    });

    const r = runCLI(["doctor", "--cwd", cwd]);

    assert.ok(r.stdout.includes("✗ .gitignore dogfood block present"), r.stdout);
  });

  it("passes exclude check when pipeline/stages/deploy.md is in .git/info/exclude", () => {
    const cwd = makeDogfoodProject({
      hookContent: `#!/bin/bash\n${GUARD_MARKER}\n`,
      gitignoreContent: `${DOGFOOD_BLOCK}\n# END stagecraft-dogfood\n`,
      excludeContent: `${DEPLOY_EXCLUDE}\n`,
    });

    const r = runCLI(["doctor", "--cwd", cwd]);

    assert.ok(r.stdout.includes("✓ .git/info/exclude: deploy.md entry"), r.stdout);
  });

  it("fails exclude check when deploy.md entry is missing from .git/info/exclude", () => {
    const cwd = makeDogfoodProject({
      hookContent: `#!/bin/bash\n${GUARD_MARKER}\n`,
      gitignoreContent: `${DOGFOOD_BLOCK}\n# END stagecraft-dogfood\n`,
      excludeContent: "# nothing\n",
    });

    const r = runCLI(["doctor", "--cwd", cwd]);

    assert.ok(r.stdout.includes("✗ .git/info/exclude: deploy.md entry"), r.stdout);
  });

  it("passes npm publish check and skips it when no package.json exists", () => {
    const cwd = makeDogfoodProject({
      hookContent: `#!/bin/bash\n${GUARD_MARKER}\n`,
      gitignoreContent: `${DOGFOOD_BLOCK}\n# END stagecraft-dogfood\n`,
      excludeContent: `${DEPLOY_EXCLUDE}\n`,
    });

    const r = runCLI(["doctor", "--cwd", cwd]);

    // No package.json → check is skipped entirely; no mention of publish
    assert.ok(!r.stdout.includes("npm publish"), r.stdout);
  });

  it("passes no-publish check when package.json has no publish script", () => {
    const cwd = makeDogfoodProject({
      hookContent: `#!/bin/bash\n${GUARD_MARKER}\n`,
      gitignoreContent: `${DOGFOOD_BLOCK}\n# END stagecraft-dogfood\n`,
      excludeContent: `${DEPLOY_EXCLUDE}\n`,
      packageJson: { name: "myapp", scripts: { test: "node --test" } },
    });

    const r = runCLI(["doctor", "--cwd", cwd]);

    assert.ok(r.stdout.includes("✓ no npm publish script"), r.stdout);
  });

  it("warns when package.json has a publish script", () => {
    const cwd = makeDogfoodProject({
      hookContent: `#!/bin/bash\n${GUARD_MARKER}\n`,
      gitignoreContent: `${DOGFOOD_BLOCK}\n# END stagecraft-dogfood\n`,
      excludeContent: `${DEPLOY_EXCLUDE}\n`,
      packageJson: { name: "myapp", scripts: { publish: "npm publish" } },
    });

    const r = runCLI(["doctor", "--cwd", cwd]);

    assert.ok(r.stdout.includes("⚠ no npm publish script"), r.stdout);
    assert.ok(r.stdout.includes("double-check you are in the right project"), r.stdout);
  });

  it("always shows usage-budget reminder as info", () => {
    const cwd = makeDogfoodProject({
      hookContent: `#!/bin/bash\n${GUARD_MARKER}\n`,
      gitignoreContent: `${DOGFOOD_BLOCK}\n# END stagecraft-dogfood\n`,
      excludeContent: `${DEPLOY_EXCLUDE}\n`,
    });

    const r = runCLI(["doctor", "--cwd", cwd]);

    assert.ok(r.stdout.includes("ℹ usage-budget reminder"), r.stdout);
    assert.ok(r.stdout.includes("use --budget-usd and/or --budget-tokens"), r.stdout);
  });
});

// Phase-28 item 28.6: Gemini CLI stopped serving free/Pro/Ultra requests
// 2026-06-18 — devteam doctor must flag any routing that still resolves to
// it and point at the antigravity replacement, without breaking gemini-cli
// itself (retirement is a later item, 34.4).
describe("devteam doctor — gemini-cli deprecation warning", () => {
  it("warns when default_host routes to gemini-cli", () => {
    const cwd = makeTargetProject({
      config: "routing:\n  default_host: gemini-cli\npipeline:\n  default_track: full\n",
    });
    track(cwd);

    const r = runCLI(["doctor", "--cwd", cwd]);

    assert.ok(r.stdout.includes("gemini-cli is deprecated upstream"), r.stdout);
    assert.ok(r.stdout.includes("--host antigravity"), r.stdout);
  });

  it("warns when a role/stage override routes to gemini-cli even if default_host differs", () => {
    const cwd = makeTargetProject({
      config: "routing:\n  default_host: generic\n  roles:\n    qa: gemini-cli\npipeline:\n  default_track: full\n",
    });
    track(cwd);

    const r = runCLI(["doctor", "--cwd", cwd]);

    assert.ok(r.stdout.includes("gemini-cli is deprecated upstream"), r.stdout);
  });

  it("does NOT warn when routing never resolves to gemini-cli", () => {
    const cwd = makeTargetProject({
      config: "routing:\n  default_host: antigravity\npipeline:\n  default_track: full\n",
    });
    track(cwd);

    const r = runCLI(["doctor", "--cwd", cwd]);

    assert.ok(!r.stdout.includes("gemini-cli is deprecated upstream"), r.stdout);
  });
});
