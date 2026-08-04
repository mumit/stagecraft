// Shared test helpers. Not a test file itself; imported by *.test.js.

const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { spawnSync } = require("node:child_process");

const REPO_ROOT = path.resolve(__dirname, "..");
const BIN = path.join(REPO_ROOT, "bin", "devteam");

function makeTargetProject(opts = {}) {
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "devteam-test-"));
  if (opts.config !== false) {
    fs.mkdirSync(path.join(cwd, ".devteam"), { recursive: true });
    fs.writeFileSync(
      path.join(cwd, ".devteam", "config.yml"),
      opts.config || "routing:\n  default_host: generic\npipeline:\n  default_track: full\n",
    );
  }
  if (opts.gates !== false) {
    fs.mkdirSync(path.join(cwd, "pipeline", "gates"), { recursive: true });
  }
  return cwd;
}

function seedGate(cwd, name, gate) {
  const dir = path.join(cwd, "pipeline", "gates");
  fs.mkdirSync(dir, { recursive: true });
  const finalGate = {
    stage: gate.stage || name.replace(/\.json$/, ""),
    orchestrator: "devteam@test",
    track: "full",
    timestamp: "2026-05-26T20:00:00Z",
    blockers: [],
    warnings: [],
    status: "PASS",
    ...gate,
  };
  const file = path.join(dir, name.endsWith(".json") ? name : `${name}.json`);
  fs.writeFileSync(file, JSON.stringify(finalGate, null, 2));
  return file;
}

function cleanup(cwd) {
  if (cwd && fs.existsSync(cwd) && cwd.includes("devteam-test-")) {
    fs.rmSync(cwd, { recursive: true, force: true });
  }
}

// 34.4: installs the real @devteam/host-gemini-cli plugin package (moved out
// of hosts/ into packages/host-gemini-cli/) into a tmpdir project's
// node_modules, mirroring core/router.js's external-adapter resolution
// (EXTERNAL_SCOPE/EXTERNAL_PREFIX). Tests that need a real end-to-end
// dispatch to gemini-cli (not just the host-name string) call this before
// running the CLI/orchestrator against `cwd`.
//
// This SYMLINKS the package rather than copying it, deliberately: the
// adapter's own requires (`../../core/adapters/headless`) are relative
// paths that only resolve when the file's real location is inside a
// Stagecraft checkout (see packages/host-gemini-cli/README.md's honest
// scope note). Node resolves `require()` against a symlink's *real* path
// by default, so a symlink here reproduces exactly what an `npm` workspace
// link would give a local dev install; a genuine copy (as a real registry
// install would produce) would break those requires — that gap is real and
// intentionally not papered over here.
function installGeminiCliPluginFixture(cwd) {
  const pluginSrc = path.join(REPO_ROOT, "packages", "host-gemini-cli");
  const scopeDir = path.join(cwd, "node_modules", "@devteam");
  fs.mkdirSync(scopeDir, { recursive: true });
  const destDir = path.join(scopeDir, "host-gemini-cli");
  if (!fs.existsSync(destDir)) fs.symlinkSync(pluginSrc, destDir, "dir");
  return destDir;
}

function runCLI(args, opts = {}) {
  const result = spawnSync("node", [BIN, ...args], {
    cwd: opts.cwd || process.cwd(),
    encoding: "utf8",
    env: { ...process.env, ...(opts.env || {}) },
  });
  return {
    status: result.status,
    stdout: result.stdout || "",
    stderr: result.stderr || "",
  };
}

module.exports = { REPO_ROOT, BIN, makeTargetProject, seedGate, cleanup, runCLI, installGeminiCliPluginFixture };
