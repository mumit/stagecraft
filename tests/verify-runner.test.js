const { describe, it, afterEach } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const {
  runCommand,
  runCommandWithReceipt,
  discoverScripts,
  discoverTestCommands,
  resolveCommands,
  resolveTestCommands,
  resolveTestConcurrency,
  runTestCommands,
} = require("../core/verify/runner");

let _dirs = [];
function tmpdir() {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), "devteam-test-verify-"));
  _dirs.push(d);
  return d;
}
afterEach(() => {
  for (const d of _dirs) try { fs.rmSync(d, { recursive: true, force: true }); } catch { /* test cleanup; ignore */ }
  _dirs = [];
});

function writeScript(d, name, code) {
  const file = path.join(d, name);
  fs.writeFileSync(file, code);
  return file;
}

describe("verify/runner: runCommand", () => {
  it("captures stdout and exit 0 from a passing command", async () => {
    const d = tmpdir();
    const f = writeScript(d, "ok.js", "console.log('ok')");
    const r = await runCommand(`node ${f}`);
    assert.equal(r.exitCode, 0);
    assert.match(r.stdout, /ok/);
    assert.ok(r.durationMs >= 0);
    assert.equal(r.timedOut, false);
  });

  it("bounds captured stdout and marks truncation", async () => {
    const d = tmpdir();
    const f = writeScript(d, "chatty.js", "process.stdout.write('x'.repeat(100))");
    const r = await runCommand(`node ${f}`, { maxOutputBytes: 10 });
    assert.equal(r.exitCode, 0);
    assert.equal(r.stdout.length, 10);
    assert.equal(r.stdoutTruncated, true);
    assert.equal(r.stderrTruncated, false);
  });

  it("captures non-zero exit codes", async () => {
    const d = tmpdir();
    const f = writeScript(d, "exit7.js", "process.exit(7)");
    const r = await runCommand(`node ${f}`);
    assert.equal(r.exitCode, 7);
  });

  it("captures stderr from a failing command", async () => {
    const d = tmpdir();
    const f = writeScript(d, "fail.js", "console.error('bad'); process.exit(1)");
    const r = await runCommand(`node ${f}`);
    assert.equal(r.exitCode, 1);
    assert.match(r.stderr, /bad/);
  });

  it("returns spawnError on a missing binary, not throwing", async () => {
    const r = await runCommand("this-binary-does-not-exist-anywhere-12345");
    assert.equal(r.exitCode, null);
    assert.ok(r.spawnError);
  });

  it("times out a hung process", async () => {
    const d = tmpdir();
    const f = writeScript(d, "hang.js", "setInterval(()=>{},1000)");
    const r = await runCommand(`node ${f}`, { timeoutMs: 200 });
    assert.equal(r.timedOut, true);
    assert.ok(r.durationMs < 4000, `expected fast timeout, got ${r.durationMs}ms`);
  });

  it("uses shell when command contains shell operators", async () => {
    // `&&` requires shell:true; this verifies the shell branch fires.
    const d = tmpdir();
    const a = writeScript(d, "a.js", "console.log(1)");
    const b = writeScript(d, "b.js", "console.log(2)");
    const r = await runCommand(`node ${a} && node ${b}`);
    assert.equal(r.exitCode, 0);
    assert.match(r.stdout, /1/);
    assert.match(r.stdout, /2/);
  });
});

describe("verify/runner: content-addressed receipts", () => {
  it("reuses a successful command when the full receipt key matches", async () => {
    const d = tmpdir();
    const receipts = path.join(d, "pipeline", "verification-receipts");
    fs.mkdirSync(path.join(d, "pipeline"), { recursive: true });
    const script = writeScript(d, "count.js", `
      const fs = require('node:fs');
      const file = 'pipeline/count.txt';
      const n = fs.existsSync(file) ? Number(fs.readFileSync(file, 'utf8')) : 0;
      fs.writeFileSync(file, String(n + 1));
      console.log('run ' + (n + 1));
    `);
    const opts = {
      cwd: d,
      receipts: {
        root: receipts,
        cwd: d,
        purpose: "stage-06:test",
        suiteId: "unit",
        config: { pipeline: { verify: { test_command: `node ${script}` } } },
      },
    };

    const first = await runCommandWithReceipt(`node ${script}`, opts);
    const second = await runCommandWithReceipt(`node ${script}`, opts);

    assert.equal(first.exitCode, 0);
    assert.equal(first.receipt.reused, false);
    assert.equal(second.exitCode, 0);
    assert.equal(second.receipt.reused, true);
    assert.equal(fs.readFileSync(path.join(d, "pipeline", "count.txt"), "utf8"), "1");
  });

  it("invalidates a receipt when material workspace files change", async () => {
    const d = tmpdir();
    const receipts = path.join(d, "pipeline", "verification-receipts");
    fs.mkdirSync(path.join(d, "pipeline"), { recursive: true });
    const source = path.join(d, "src.js");
    fs.writeFileSync(source, "module.exports = 1;\n");
    const script = writeScript(d, "count.js", `
      const fs = require('node:fs');
      const file = 'pipeline/count.txt';
      const n = fs.existsSync(file) ? Number(fs.readFileSync(file, 'utf8')) : 0;
      fs.writeFileSync(file, String(n + 1));
    `);
    const opts = {
      cwd: d,
      receipts: {
        root: receipts,
        cwd: d,
        purpose: "stage-06:test",
        suiteId: "unit",
        config: {},
      },
    };

    await runCommandWithReceipt(`node ${script}`, opts);
    fs.writeFileSync(source, "module.exports = 2;\n");
    const second = await runCommandWithReceipt(`node ${script}`, opts);

    assert.equal(second.receipt.reused, false);
    assert.equal(fs.readFileSync(path.join(d, "pipeline", "count.txt"), "utf8"), "2");
  });

  it("does not reuse failed command results", async () => {
    const d = tmpdir();
    const receipts = path.join(d, "pipeline", "verification-receipts");
    const script = writeScript(d, "fail.js", "process.exit(4)");
    const opts = {
      cwd: d,
      receipts: {
        root: receipts,
        cwd: d,
        purpose: "stage-06:test",
        suiteId: "unit",
        config: {},
      },
    };

    const first = await runCommandWithReceipt(`node ${script}`, opts);
    const second = await runCommandWithReceipt(`node ${script}`, opts);

    assert.equal(first.exitCode, 4);
    assert.equal(first.receipt.reused, false);
    assert.equal(second.exitCode, 4);
    assert.equal(second.receipt.reused, false);
  });
});

describe("verify/runner: discoverScripts", () => {
  it("returns null/null when no package.json", () => {
    const d = tmpdir();
    assert.deepEqual(discoverScripts(d), { lint: null, test: null });
  });

  it("reads scripts.lint and scripts.test from package.json", () => {
    const d = tmpdir();
    fs.writeFileSync(path.join(d, "package.json"), JSON.stringify({
      scripts: { lint: "eslint .", test: "jest" },
    }));
    const r = discoverScripts(d);
    assert.equal(r.lint, "npm run lint");
    assert.equal(r.test, "npm test");
  });

  it("returns null for missing scripts", () => {
    const d = tmpdir();
    fs.writeFileSync(path.join(d, "package.json"), JSON.stringify({
      scripts: { build: "tsc" },
    }));
    assert.deepEqual(discoverScripts(d), { lint: null, test: null });
  });

  it("returns null/null on malformed package.json (doesn't throw)", () => {
    const d = tmpdir();
    fs.writeFileSync(path.join(d, "package.json"), "{ not json");
    assert.deepEqual(discoverScripts(d), { lint: null, test: null });
  });
});

describe("verify/runner: polyglot test discovery", () => {
  it("discovers Node, pytest, and Go suites in stable order", () => {
    const d = tmpdir();
    fs.writeFileSync(path.join(d, "package.json"), JSON.stringify({ scripts: { test: "node --test" } }));
    fs.writeFileSync(path.join(d, "pytest.ini"), "[pytest]\n");
    fs.writeFileSync(path.join(d, "go.mod"), "module example.test/polyglot\n\ngo 1.22\n");
    assert.deepEqual(discoverTestCommands(d), [
      { id: "node", command: "npm test" },
      {
        id: "python",
        command: process.platform === "win32" ? "py -m pytest" : "python3 -m pytest",
      },
      { id: "go", command: "go test ./..." },
    ]);
  });

  it("detects conventional Python test files without treating any pyproject as pytest", () => {
    const d = tmpdir();
    fs.writeFileSync(path.join(d, "pyproject.toml"), "[project]\nname = 'library'\n");
    assert.deepEqual(discoverTestCommands(d), []);
    fs.mkdirSync(path.join(d, "tests"));
    fs.writeFileSync(path.join(d, "tests", "test_unit.py"), "def test_ok():\n    assert True\n");
    assert.equal(discoverTestCommands(d)[0].id, "python");
  });

  it("does not follow a symlinked Python test directory", { skip: process.platform === "win32" }, () => {
    const d = tmpdir();
    const outside = tmpdir();
    fs.writeFileSync(path.join(outside, "test_external.py"), "def test_ok():\n    assert True\n");
    fs.symlinkSync(outside, path.join(d, "tests"));
    assert.deepEqual(discoverTestCommands(d), []);
  });

  it("keeps a configured command exclusive and honors explicit null", () => {
    const d = tmpdir();
    fs.writeFileSync(path.join(d, "package.json"), JSON.stringify({ scripts: { test: "node --test" } }));
    fs.writeFileSync(path.join(d, "go.mod"), "module example.test/polyglot\n");
    assert.deepEqual(resolveTestCommands(d, {
      pipeline: { verify: { test_command: "custom-test --all" } },
    }), [{ id: "configured", command: "custom-test --all" }]);
    assert.deepEqual(resolveTestCommands(d, {
      pipeline: { verify: { test_command: null } },
    }), []);
  });

  it("uses configured test_suites when no exclusive test_command is set", () => {
    const d = tmpdir();
    fs.writeFileSync(path.join(d, "package.json"), JSON.stringify({ scripts: { test: "node --test" } }));
    assert.deepEqual(resolveTestCommands(d, {
      pipeline: {
        verify: {
          test_suites: [
            { id: "unit", command: "npm test", resource_group: "cpu" },
            { command: "npm run integration" },
            { id: "ignored" },
          ],
        },
      },
    }), [
      { id: "unit", command: "npm test", resource_group: "cpu" },
      { id: "suite-2", command: "npm run integration", resource_group: null },
    ]);
  });

  it("runs every suite and reports aggregate failure without short-circuiting", async () => {
    const d = tmpdir();
    const pass = writeScript(d, "pass.js", "process.exit(0)");
    const fail = writeScript(d, "fail.js", "process.exit(3)");
    const result = await runTestCommands([
      { id: "node", command: `node ${pass}` },
      { id: "python", command: `node ${fail}` },
    ], { cwd: d });
    assert.equal(result.passed, false);
    assert.deepEqual(result.runs.map((run) => run.exitCode), [0, 3]);
    assert.ok(result.durationMs >= 0);
  });

  it("runs independent suites concurrently while preserving result order", async () => {
    const d = tmpdir();
    const slow = writeScript(d, "slow.js", "setTimeout(()=>{ console.log('slow'); }, 220)");
    const fast = writeScript(d, "fast.js", "setTimeout(()=>{ console.log('fast'); }, 20)");
    const started = Date.now();
    const result = await runTestCommands([
      { id: "slow", command: `node ${slow}` },
      { id: "fast", command: `node ${fast}` },
    ], { cwd: d, concurrency: 2 });
    const elapsed = Date.now() - started;
    assert.equal(result.passed, true);
    assert.deepEqual(result.runs.map((run) => run.id), ["slow", "fast"]);
    assert.ok(elapsed < 400, `expected concurrent wall time, got ${elapsed}ms`);
  });

  it("does not run suites with the same resource group at the same time", async () => {
    const d = tmpdir();
    const script = writeScript(d, "grouped.js", `
      const fs = require('node:fs');
      const path = require('node:path');
      const lock = path.join(process.cwd(), 'exclusive.lock');
      if (fs.existsSync(lock)) process.exit(9);
      fs.writeFileSync(lock, process.argv[2]);
      setTimeout(() => {
        fs.unlinkSync(lock);
      }, 80);
    `);
    const result = await runTestCommands([
      { id: "a", command: `node ${script} a`, resource_group: "exclusive" },
      { id: "b", command: `node ${script} b`, resource_group: "exclusive" },
    ], { cwd: d, concurrency: 2 });
    assert.equal(result.passed, true);
    assert.deepEqual(result.runs.map((run) => run.resource_group), ["exclusive", "exclusive"]);
  });
});

describe("verify/runner: resolveCommands", () => {
  it("config wins over package.json discovery", () => {
    const d = tmpdir();
    fs.writeFileSync(path.join(d, "package.json"), JSON.stringify({
      scripts: { lint: "eslint .", test: "jest" },
    }));
    const r = resolveCommands(d, {
      pipeline: { verify: { lint_command: "custom-lint --strict", test_command: "pytest" } },
    });
    assert.equal(r.lint, "custom-lint --strict");
    assert.equal(r.test, "pytest");
  });

  it("falls back to package.json when config is absent", () => {
    const d = tmpdir();
    fs.writeFileSync(path.join(d, "package.json"), JSON.stringify({
      scripts: { lint: "eslint .", test: "jest" },
    }));
    const r = resolveCommands(d, {});
    assert.equal(r.lint, "npm run lint");
    assert.equal(r.test, "npm test");
  });

  it("config null explicitly disables (different from omitted)", () => {
    const d = tmpdir();
    fs.writeFileSync(path.join(d, "package.json"), JSON.stringify({
      scripts: { lint: "eslint .", test: "jest" },
    }));
    const r = resolveCommands(d, {
      pipeline: { verify: { lint_command: null } },
    });
    assert.equal(r.lint, null, "explicit null = skip lint");
    assert.equal(r.test, "npm test", "test still falls back");
  });

  it("returns null when neither config nor package.json provides", () => {
    const d = tmpdir();
    const r = resolveCommands(d, {});
    assert.deepEqual(r, { lint: null, test: null });
  });

  it("resolves bounded test concurrency from config", () => {
    assert.equal(resolveTestConcurrency({ pipeline: { verify: { test_concurrency: 4 } } }), 4);
    assert.equal(resolveTestConcurrency({ pipeline: { verify: { test_concurrency: 0 } } }), 1);
    assert.equal(resolveTestConcurrency({ pipeline: { verify: { test_concurrency: 99 } } }), 8);
    assert.equal(resolveTestConcurrency({}), 2);
  });
});
