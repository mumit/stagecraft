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
  // Right-sizing and active-role discovery both read the project's own files
  // (core/pipeline/right-sizing.js: gitChangedFiles, with listProjectFiles as
  // the non-repo fallback). The default fixture has none -- only framework-owned
  // paths, which isRightSizingInputPath filters out -- so on a bare project
  // every discovery answer is [] and every assertion about one passes whether
  // the logic works or not. `files` opts in to a project that can actually be
  // right-sized. Not the default: 3,500 existing tests are written against the
  // bare shape and should keep their fast, empty fixture.
  if (opts.files) {
    for (const [relative, content] of Object.entries(opts.files)) {
      const target = path.join(cwd, relative);
      fs.mkdirSync(path.dirname(target), { recursive: true });
      fs.writeFileSync(target, content);
    }
  }
  return cwd;
}

// A project with a real shape: backend source, a frontend component, a test,
// and infrastructure -- one file per WORKSTREAM_RULES role, so discovery has
// something to find and a wrong answer is visibly wrong. Callers override or
// extend via `files`.
const REALISTIC_FILES = {
  "package.json": '{\n  "name": "fixture",\n  "version": "1.0.0"\n}\n',
  "src/backend/api.js": "function handler(req, res) { res.end('ok'); }\nmodule.exports = { handler };\n",
  "src/frontend/App.jsx": "export default function App() { return null; }\n",
  "tests/api.test.js": "require('node:test');\n",
  "infra/main.tf": 'resource "null_resource" "noop" {}\n',
  "README.md": "# Fixture\n\nA project with enough shape to right-size.\n",
};

function makeRealisticProject(opts = {}) {
  return makeTargetProject({
    ...opts,
    files: { ...REALISTIC_FILES, ...(opts.files || {}) },
  });
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

// Writes a small Node script at <dir>/mutate.js that writes `filename` into
// whatever directory it's actually run from (its own process.cwd(), not
// `dir`) — used by write-audit integration tests to simulate a headless
// agent mutating a directory via `DEVTEAM_HEADLESS_COMMAND=<node> <script>`.
// Returns the script's absolute path.
function writeMutationScript(dir, filename = "mutated.txt") {
  const scriptPath = path.join(dir, "mutate.js");
  fs.writeFileSync(scriptPath, [
    "const fs = require('node:fs');",
    `fs.writeFileSync(${JSON.stringify(filename)}, 'mutated by test\\n');`,
    "",
  ].join("\n"), "utf8");
  return scriptPath;
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

module.exports = { REPO_ROOT, BIN, makeTargetProject, makeRealisticProject, REALISTIC_FILES, seedGate, cleanup, runCLI, installGeminiCliPluginFixture, writeMutationScript };
