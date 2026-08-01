"use strict";

const { describe, it, afterEach } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const { REPO_ROOT, cleanup, runCLI } = require("./_helpers");
const {
  writeDogfoodGitignoreBlock,
  CANONICAL_DOGFOOD_BLOCK,
  DOGFOOD_BLOCK_BEGIN,
} = require(path.join(REPO_ROOT, "core", "gitignore"));
const { KNOWN_DEPLOY_ADAPTERS } = require(path.join(REPO_ROOT, "core", "config"));

let _dirs = [];
function track(cwd) { _dirs.push(cwd); return cwd; }
afterEach(() => { _dirs.forEach(cleanup); _dirs = []; });

function makeDogfoodProject() {
  const cwd = track(fs.mkdtempSync(path.join(os.tmpdir(), "devteam-test-")));
  // Synthetic .git/ with hooks/ and info/ so the hook and exclude writes work
  fs.mkdirSync(path.join(cwd, ".git", "hooks"), { recursive: true });
  fs.mkdirSync(path.join(cwd, ".git", "info"), { recursive: true });
  return cwd;
}

describe("devteam init --adapter", () => {
  it("writes deploy section to config.yml when --adapter gizmos is specified", () => {
    const cwd = track(fs.mkdtempSync(path.join(os.tmpdir(), "devteam-test-")));

    const r = runCLI(["init", "--host", "generic", "--cwd", cwd, "--adapter", "gizmos"]);
    assert.equal(r.status, 0, `init failed: ${r.stderr}`);

    const cfgPath = path.join(cwd, ".devteam", "config.yml");
    assert.ok(fs.existsSync(cfgPath), "config.yml must exist");
    const content = fs.readFileSync(cfgPath, "utf8");
    assert.ok(content.includes("adapter: gizmos"), "config.yml must contain adapter: gizmos");
    assert.ok(content.includes("deploy:"), "config.yml must contain deploy: section");
    assert.ok(content.includes("gizmos:"), "config.yml must contain gizmos: subkey block");
    assert.ok(content.includes("TODO"), "placeholder values must be marked TODO");
  });

  it("writes deploy section to config.yml when --adapter cloud-run is specified", () => {
    const cwd = track(fs.mkdtempSync(path.join(os.tmpdir(), "devteam-test-")));

    const r = runCLI(["init", "--host", "generic", "--cwd", cwd, "--adapter", "cloud-run"]);
    assert.equal(r.status, 0, `init failed: ${r.stderr}`);

    const content = fs.readFileSync(path.join(cwd, ".devteam", "config.yml"), "utf8");
    assert.ok(content.includes("adapter: cloud-run"));
    assert.ok(content.includes("cloud_run:"));
    assert.ok(content.includes("project: my-project"));
  });

  it("exits 2 with error message for unknown adapter", () => {
    const cwd = track(fs.mkdtempSync(path.join(os.tmpdir(), "devteam-test-")));

    const r = runCLI(["init", "--host", "generic", "--cwd", cwd, "--adapter", "bogus-adapter"]);
    assert.equal(r.status, 2, "must exit 2 for unknown adapter");
    assert.ok(r.stderr.includes("Unknown deploy adapter"), "stderr must explain the error");
    assert.ok(r.stderr.includes("bogus-adapter"), "stderr must name the bad adapter");
  });

  it("omits deploy section but installs local adapter when --adapter is not specified", () => {
    const cwd = track(fs.mkdtempSync(path.join(os.tmpdir(), "devteam-test-")));

    const r = runCLI(["init", "--host", "generic", "--cwd", cwd]);
    assert.equal(r.status, 0, `init failed: ${r.stderr}`);

    const content = fs.readFileSync(path.join(cwd, ".devteam", "config.yml"), "utf8");
    assert.ok(!content.includes("deploy:"), "config.yml must not contain deploy: without --adapter");
    assert.ok(
      fs.existsSync(path.join(cwd, ".devteam", "adapters", "local.md")),
      "local deploy adapter must be installed as the no-config default",
    );
  });

  it("KNOWN_DEPLOY_ADAPTERS lists at least local, gizmos, cloud-run, docker-compose, npm, custom", () => {
    for (const name of ["local", "gizmos", "cloud-run", "docker-compose", "npm", "custom"]) {
      assert.ok(KNOWN_DEPLOY_ADAPTERS.includes(name), `KNOWN_DEPLOY_ADAPTERS must include ${name}`);
    }
  });

  it("--adapter docker-compose installs .devteam/adapters/docker-compose.md", () => {
    const cwd = track(fs.mkdtempSync(path.join(os.tmpdir(), "devteam-test-")));
    const r = runCLI(["init", "--host", "generic", "--cwd", cwd, "--adapter", "docker-compose"]);
    assert.equal(r.status, 0, `init failed: ${r.stderr}`);
    const spec = path.join(cwd, ".devteam", "adapters", "docker-compose.md");
    assert.ok(fs.existsSync(spec), ".devteam/adapters/docker-compose.md must be installed");
    const content = fs.readFileSync(spec, "utf8");
    assert.ok(content.includes("docker compose"), "adapter spec must contain docker compose instructions");
  });

  it("--adapter docker-compose scaffolds Dockerfile and docker-compose.yml stubs", () => {
    const cwd = track(fs.mkdtempSync(path.join(os.tmpdir(), "devteam-test-")));
    const r = runCLI(["init", "--host", "generic", "--cwd", cwd, "--adapter", "docker-compose"]);
    assert.equal(r.status, 0, `init failed: ${r.stderr}`);
    assert.ok(fs.existsSync(path.join(cwd, "Dockerfile")), "Dockerfile must be scaffolded");
    assert.ok(fs.existsSync(path.join(cwd, "docker-compose.yml")), "docker-compose.yml must be scaffolded");
    const composeContent = fs.readFileSync(path.join(cwd, "docker-compose.yml"), "utf8");
    assert.ok(composeContent.includes("services:"), "docker-compose.yml must contain a services block");
    assert.ok(composeContent.includes("healthcheck:"), "docker-compose.yml must include a healthcheck");
  });

  it("--adapter docker-compose --force overwrites existing Dockerfile", () => {
    const cwd = track(fs.mkdtempSync(path.join(os.tmpdir(), "devteam-test-")));
    fs.writeFileSync(path.join(cwd, "Dockerfile"), "FROM scratch\n");
    const r = runCLI(["init", "--host", "generic", "--cwd", cwd, "--adapter", "docker-compose", "--force"]);
    assert.equal(r.status, 0, `init --force failed: ${r.stderr}`);
    const content = fs.readFileSync(path.join(cwd, "Dockerfile"), "utf8");
    assert.ok(!content.startsWith("FROM scratch"), "--force must overwrite the existing Dockerfile");
  });

  it("--adapter docker-compose without --force skips existing Dockerfile", () => {
    const cwd = track(fs.mkdtempSync(path.join(os.tmpdir(), "devteam-test-")));
    fs.writeFileSync(path.join(cwd, "Dockerfile"), "FROM scratch\n");
    const r = runCLI(["init", "--host", "generic", "--cwd", cwd, "--adapter", "docker-compose"]);
    assert.equal(r.status, 0, `init failed: ${r.stderr}`);
    const content = fs.readFileSync(path.join(cwd, "Dockerfile"), "utf8");
    assert.ok(content.startsWith("FROM scratch"), "existing Dockerfile must not be overwritten without --force");
  });

  it("--adapter gizmos installs .devteam/adapters/gizmos.md but no Dockerfile", () => {
    const cwd = track(fs.mkdtempSync(path.join(os.tmpdir(), "devteam-test-")));
    const r = runCLI(["init", "--host", "generic", "--cwd", cwd, "--adapter", "gizmos"]);
    assert.equal(r.status, 0, `init failed: ${r.stderr}`);
    assert.ok(fs.existsSync(path.join(cwd, ".devteam", "adapters", "gizmos.md")), ".devteam/adapters/gizmos.md must be installed");
    assert.ok(!fs.existsSync(path.join(cwd, "Dockerfile")), "gizmos adapter should not scaffold a Dockerfile");
  });
});

// 30.5: devteam init offers (never auto-installs) the SKILL.md export path.
describe("devteam init: SKILL.md export offer", () => {
  function seedPromotedPattern(cwd) {
    fs.mkdirSync(path.join(cwd, ".devteam", "patterns"), { recursive: true });
    fs.writeFileSync(
      path.join(cwd, ".devteam", "patterns", "promoted.json"),
      JSON.stringify({
        schema_version: "1.0",
        patterns: [{
          id: "some-pattern",
          status: "promoted",
          tier: "warning",
          domain: "docs",
          prompt_text: "Document user-visible HTTP endpoints during implementation.",
          evidence: { observations: 1, last_reinforced: "2026-07-01" },
          stats: { injected: 0, recurrence_after_injection: 0, noise_reports: 0 },
        }],
      }, null, 2),
    );
  }

  it("mentions the export tip when promoted patterns exist and the host has a skills directory", () => {
    const cwd = track(fs.mkdtempSync(path.join(os.tmpdir(), "devteam-test-")));
    seedPromotedPattern(cwd);
    const r = runCLI(["init", "--host", "claude-code", "--cwd", cwd]);
    assert.equal(r.status, 0, `init failed: ${r.stderr}`);
    assert.match(r.stdout, /devteam patterns export --skill/);
    assert.match(r.stdout, /\.claude\/skills/);
  });

  it("does not mention the export tip when no patterns are promoted", () => {
    const cwd = track(fs.mkdtempSync(path.join(os.tmpdir(), "devteam-test-")));
    const r = runCLI(["init", "--host", "claude-code", "--cwd", cwd]);
    assert.equal(r.status, 0, `init failed: ${r.stderr}`);
    assert.doesNotMatch(r.stdout, /patterns export/);
  });

  it("does not mention the export tip for a host without a skills directory", () => {
    const cwd = track(fs.mkdtempSync(path.join(os.tmpdir(), "devteam-test-")));
    seedPromotedPattern(cwd);
    const r = runCLI(["init", "--host", "generic", "--cwd", cwd]);
    assert.equal(r.status, 0, `init failed: ${r.stderr}`);
    assert.doesNotMatch(r.stdout, /patterns export/);
  });
});

describe("devteam init --profile dogfood", () => {
  it("writeDogfoodGitignoreBlock appends the dogfood block to .gitignore", () => {
    const cwd = track(fs.mkdtempSync(path.join(os.tmpdir(), "devteam-test-")));
    const giPath = path.join(cwd, ".gitignore");

    const result = writeDogfoodGitignoreBlock(cwd);

    assert.equal(result, "wrote");
    const content = fs.readFileSync(giPath, "utf8");
    assert.ok(content.includes(DOGFOOD_BLOCK_BEGIN));
    assert.ok(content.includes("pipeline/brief.md"));
    assert.ok(content.includes("pipeline/code-review/"));
  });

  it("writeDogfoodGitignoreBlock returns 'skipped' when block already matches canonical", () => {
    const cwd = track(fs.mkdtempSync(path.join(os.tmpdir(), "devteam-test-")));
    const giPath = path.join(cwd, ".gitignore");
    fs.writeFileSync(giPath, CANONICAL_DOGFOOD_BLOCK + "\n", "utf8");

    const result = writeDogfoodGitignoreBlock(cwd);

    assert.equal(result, "skipped");
    assert.equal(fs.readFileSync(giPath, "utf8"), CANONICAL_DOGFOOD_BLOCK + "\n");
  });

  it("writeDogfoodGitignoreBlock returns 'updated' when block is outdated", () => {
    const cwd = track(fs.mkdtempSync(path.join(os.tmpdir(), "devteam-test-")));
    const giPath = path.join(cwd, ".gitignore");
    const oldBlock = `${DOGFOOD_BLOCK_BEGIN}\npipeline/brief.md\n# END stagecraft-dogfood`;
    fs.writeFileSync(giPath, oldBlock, "utf8");

    const result = writeDogfoodGitignoreBlock(cwd);

    assert.equal(result, "updated");
    const content = fs.readFileSync(giPath, "utf8");
    assert.ok(content.includes("pipeline/code-review/"), "canonical entries must appear");
    assert.equal((content.match(/# BEGIN stagecraft-dogfood/g) || []).length, 1, "exactly one block");
  });

  it("devteam init --profile dogfood writes pre-commit hook with guard marker", () => {
    const cwd = makeDogfoodProject();

    const r = runCLI(["init", "--host", "generic", "--cwd", cwd, "--profile", "dogfood"]);
    assert.equal(r.status, 0, `init failed: ${r.stderr}`);

    const hookPath = path.join(cwd, ".git", "hooks", "pre-commit");
    assert.ok(fs.existsSync(hookPath), "pre-commit hook must exist");
    const content = fs.readFileSync(hookPath, "utf8");
    assert.ok(content.includes("# stagecraft-dogfood: infrastructure guard"));
    assert.ok(content.includes("BLOCKED_PREFIXES"));
    // Hook must be executable
    assert.doesNotThrow(() => fs.accessSync(hookPath, fs.constants.X_OK));
  });

  it("devteam init --profile dogfood adds pipeline/stages/deploy.md to .git/info/exclude", () => {
    const cwd = makeDogfoodProject();

    const r = runCLI(["init", "--host", "generic", "--cwd", cwd, "--profile", "dogfood"]);
    assert.equal(r.status, 0, `init failed: ${r.stderr}`);

    const excludePath = path.join(cwd, ".git", "info", "exclude");
    assert.ok(fs.existsSync(excludePath), ".git/info/exclude must exist");
    const content = fs.readFileSync(excludePath, "utf8");
    assert.ok(content.includes("pipeline/stages/deploy.md"));
  });

  it("devteam init --profile dogfood writes profile: dogfood to config.yml", () => {
    const cwd = makeDogfoodProject();

    const r = runCLI(["init", "--host", "generic", "--cwd", cwd, "--profile", "dogfood"]);
    assert.equal(r.status, 0, `init failed: ${r.stderr}`);

    const cfgPath = path.join(cwd, ".devteam", "config.yml");
    assert.ok(fs.existsSync(cfgPath), "config.yml must exist");
    const content = fs.readFileSync(cfgPath, "utf8");
    assert.ok(content.includes("profile: dogfood"));
  });

  it("running --profile dogfood twice is idempotent: hook not duplicated, block not duplicated", () => {
    const cwd = makeDogfoodProject();

    runCLI(["init", "--host", "generic", "--cwd", cwd, "--profile", "dogfood"]);
    const r2 = runCLI(["init", "--host", "generic", "--cwd", cwd, "--profile", "dogfood"]);
    assert.equal(r2.status, 0, `second init failed: ${r2.stderr}`);

    // Dogfood gitignore block: exactly one
    const giContent = fs.readFileSync(path.join(cwd, ".gitignore"), "utf8");
    assert.equal(
      (giContent.match(/# BEGIN stagecraft-dogfood/g) || []).length,
      1,
      "gitignore must have exactly one dogfood block",
    );

    // Hook: guard marker appears exactly once
    const hookContent = fs.readFileSync(
      path.join(cwd, ".git", "hooks", "pre-commit"),
      "utf8",
    );
    assert.equal(
      (hookContent.match(/# stagecraft-dogfood: infrastructure guard/g) || []).length,
      1,
      "hook guard marker must appear exactly once",
    );

    // config.yml: profile: dogfood appears exactly once
    const cfgContent = fs.readFileSync(path.join(cwd, ".devteam", "config.yml"), "utf8");
    assert.equal(
      (cfgContent.match(/profile: dogfood/g) || []).length,
      1,
      "config.yml must have profile: dogfood exactly once",
    );
  });
});
