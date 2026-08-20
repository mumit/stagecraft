// Verification runner. Spawns an external command (lint, test, or SCA),
// captures result, returns a structured outcome the orchestrator can
// stamp onto a gate. This is the machinery that turns "the model says
// tests passed" into "the orchestrator ran the tests and observed
// exit code 0" — closing the gap between agent self-report and
// orchestrator verification.
//
// Public API:
//   - runCommand(command, opts) -> Promise<{ exitCode, stdout, stderr, durationMs, command, timedOut }>
//   - discoverScripts(cwd) -> { lint, test }    (reads package.json scripts; nulls when absent)
//   - resolveCommands(cwd, config) -> { lint, test }
//   - discoverTestCommands(cwd) -> [{ id, command }]
//   - resolveTestCommands(cwd, config) -> [{ id, command }]
//   - resolveTestConcurrency(config) -> bounded integer concurrency
//   - runTestCommands(commands, opts) -> aggregate result
//
// Commands run with shell:false where possible (split on whitespace),
// or shell:true when the configured command contains shell operators
// (&&, |, ;). The orchestrator passes `command` strings through from
// .devteam/config.yml or package.json — never user-controlled at
// invocation time.

const { spawn } = require("node:child_process");
const fs = require("node:fs");
const path = require("node:path");
const { terminateChild } = require("../process-kill");
const {
  receiptKey,
  reusableReceipt,
  writeReceipt,
  receiptSummary,
} = require("./receipts");

const DEFAULT_TIMEOUT_MS = 10 * 60 * 1000; // 10 min; lint and tests should fit easily
const DEFAULT_MAX_OUTPUT_BYTES = 1024 * 1024;
const DEFAULT_TEST_CONCURRENCY = 2;
const MAX_TEST_CONCURRENCY = 8;
const MAX_PYTHON_TEST_FILES = 2000;
const MAX_PYTHON_TEST_DEPTH = 6;

function needsShell(command) {
  return /[|&;<>$`\\]/.test(command);
}

function runCommand(command, opts = {}) {
  const cwd = opts.cwd || process.cwd();
  const timeoutMs = typeof opts.timeoutMs === "number" ? opts.timeoutMs : DEFAULT_TIMEOUT_MS;
  const maxOutputBytes = Number.isInteger(opts.maxOutputBytes) && opts.maxOutputBytes >= 0
    ? opts.maxOutputBytes
    : DEFAULT_MAX_OUTPUT_BYTES;

  return new Promise((resolve) => {
    const started = Date.now();
    const useShell = needsShell(command);
    const args = useShell ? [] : command.trim().split(/\s+/);
    const cmd = useShell ? command : args.shift();
    const child = spawn(cmd, args, {
      cwd,
      shell: useShell,
      env: { ...process.env, CI: process.env.CI || "1" },
      stdio: ["ignore", "pipe", "pipe"],
    });

    let stdout = "";
    let stderr = "";
    let stdoutBytes = 0;
    let stderrBytes = 0;
    let stdoutTruncated = false;
    let stderrTruncated = false;
    let timedOut = false;
    let finished = false;

    function capture(kind, chunk) {
      const text = chunk.toString("utf8");
      const bytes = Buffer.byteLength(text);
      const current = kind === "stdout" ? stdoutBytes : stderrBytes;
      const remaining = Math.max(0, maxOutputBytes - current);
      let addition = text;
      let truncated = false;
      if (bytes > remaining) {
        addition = remaining > 0 ? Buffer.from(text).subarray(0, remaining).toString("utf8") : "";
        truncated = true;
      }
      if (kind === "stdout") {
        stdout += addition;
        stdoutBytes += Math.min(bytes, remaining);
        if (truncated) stdoutTruncated = true;
      } else {
        stderr += addition;
        stderrBytes += Math.min(bytes, remaining);
        if (truncated) stderrTruncated = true;
      }
    }

    const timer = setTimeout(() => {
      timedOut = true;
      terminateChild(child, { graceMs: 2000 });
    }, timeoutMs);
    timer.unref();

    child.stdout.on("data", (d) => { capture("stdout", d); });
    child.stderr.on("data", (d) => { capture("stderr", d); });

    child.on("error", (err) => {
      if (finished) return;
      finished = true;
      clearTimeout(timer);
      resolve({
        exitCode: null,
        stdout,
        stderr: stderr + `\n[runner] spawn error: ${err.message}`,
        durationMs: Date.now() - started,
        command,
        timedOut: false,
        spawnError: err.code || err.message,
        stdoutTruncated,
        stderrTruncated,
      });
    });

    child.on("close", (code, signal) => {
      if (finished) return;
      finished = true;
      clearTimeout(timer);
      resolve({
        exitCode: code,
        stdout,
        stderr,
        durationMs: Date.now() - started,
        command,
        timedOut,
        signal: signal || null,
        stdoutTruncated,
        stderrTruncated,
      });
    });
  });
}

async function runCommandWithReceipt(command, opts = {}) {
  const receipts = opts.receipts;
  if (!receipts || receipts.enabled === false || !receipts.root || !receipts.cwd || !receipts.purpose) {
    return runCommand(command, opts);
  }

  const { digest, key } = receiptKey({
    cwd: receipts.cwd,
    command,
    suiteId: receipts.suiteId || "command",
    purpose: receipts.purpose,
    config: receipts.config || {},
  });
  const cached = reusableReceipt(receipts.root, digest);
  if (cached) {
    return {
      ...cached,
      command,
      durationMs: 0,
      receipt: receiptSummary({
        digest,
        reused: true,
        reason: "full key matched",
        receipt: cached.receipt,
      }),
    };
  }

  const result = await runCommand(command, opts);
  const passed = result.exitCode === 0 && !result.timedOut && !result.spawnError;
  const summary = {
    digest,
    reused: false,
    reason: passed ? "miss; executed and stored" : "miss; failed result not reusable",
  };
  if (passed) {
    const receipt = {
      schema_version: "1",
      digest,
      key,
      executed_at: new Date().toISOString(),
      result: {
        command: result.command,
        exitCode: result.exitCode,
        stdout: result.stdout,
        stderr: result.stderr,
        durationMs: result.durationMs,
        timedOut: result.timedOut,
        signal: result.signal || null,
        stdoutTruncated: result.stdoutTruncated || undefined,
        stderrTruncated: result.stderrTruncated || undefined,
      },
    };
    summary.path = writeReceipt(receipts.root, receipt);
  }
  return {
    ...result,
    receipt: receiptSummary(summary),
  };
}

function discoverScripts(cwd) {
  const pkgPath = path.join(cwd, "package.json");
  if (!fs.existsSync(pkgPath)) return { lint: null, test: null };
  try {
    const pkg = JSON.parse(fs.readFileSync(pkgPath, "utf8"));
    const scripts = pkg.scripts || {};
    return {
      lint: scripts.lint ? "npm run lint" : null,
      test: scripts.test ? "npm test" : null,
    };
  } catch {
    return { lint: null, test: null };
  }
}

function regularFile(file) {
  try {
    const stat = fs.lstatSync(file);
    return stat.isFile() && !stat.isSymbolicLink();
  } catch {
    return false;
  }
}

function regularDirectory(dir) {
  try {
    const stat = fs.lstatSync(dir);
    return stat.isDirectory() && !stat.isSymbolicLink();
  } catch {
    return false;
  }
}

function fileContains(file, pattern) {
  if (!regularFile(file)) return false;
  try { return pattern.test(fs.readFileSync(file, "utf8")); } catch { return false; }
}

function hasPythonTests(cwd) {
  if (regularFile(path.join(cwd, "pytest.ini"))) return true;
  if (fileContains(path.join(cwd, "pyproject.toml"), /^\s*\[tool\.pytest(?:\.|\])/m)) return true;
  if (fileContains(path.join(cwd, "setup.cfg"), /^\s*\[tool:pytest\]\s*$/m)) return true;

  const queue = [{ dir: cwd, depth: 0 }];
  const seen = new Set();
  let inspected = 0;
  while (queue.length > 0 && inspected < MAX_PYTHON_TEST_FILES) {
    const { dir, depth } = queue.shift();
    const resolved = path.resolve(dir);
    if (seen.has(resolved)) continue;
    seen.add(resolved);
    if (!regularDirectory(resolved)) continue;
    let entries;
    try { entries = fs.readdirSync(resolved, { withFileTypes: true }); } catch { continue; }
    for (const entry of entries) {
      if (entry.isSymbolicLink()) continue;
      if (entry.isFile()) {
        inspected += 1;
        if (/^(?:test_.*|.*_test)\.py$/.test(entry.name) || entry.name === "conftest.py") return true;
      } else if (entry.isDirectory() && depth < MAX_PYTHON_TEST_DEPTH
        && (resolved !== path.resolve(cwd) || ["tests", "test"].includes(entry.name))) {
        queue.push({ dir: path.join(resolved, entry.name), depth: depth + 1 });
      }
      if (inspected >= MAX_PYTHON_TEST_FILES) break;
    }
  }
  return false;
}

function discoverTestCommands(cwd) {
  const commands = [];
  const nodeTest = discoverScripts(cwd).test;
  if (nodeTest) commands.push({ id: "node", command: nodeTest });
  if (hasPythonTests(cwd)) {
    commands.push({
      id: "python",
      command: process.platform === "win32" ? "py -m pytest" : "python3 -m pytest",
    });
  }
  if (regularFile(path.join(cwd, "go.mod"))) {
    commands.push({ id: "go", command: "go test ./..." });
  }
  return commands;
}

// Resolve which lint/test commands to run for this project. Precedence:
// .devteam/config.yml `pipeline.verify.{lint,test}_command` wins; then
// package.json scripts; then null (skip with a warning recorded in the
// gate). Explicit `null` or empty string in config means "skip" — not
// the same as omitted, which falls back to discovery.
function resolveCommands(cwd, config) {
  const verify = (config && config.pipeline && config.pipeline.verify) || {};
  const discovered = discoverScripts(cwd);

  function pick(configKey, discoveredValue) {
    if (configKey === null) return null;            // explicit skip
    if (typeof configKey === "string" && configKey.trim()) return configKey.trim();
    return discoveredValue;
  }

  return {
    lint: pick(verify.lint_command, discovered.lint),
    test: pick(verify.test_command, discovered.test),
  };
}

function resolveTestCommands(cwd, config) {
  const verify = (config && config.pipeline && config.pipeline.verify) || {};
  if (Object.prototype.hasOwnProperty.call(verify, "test_command")) {
    if (verify.test_command === null) return [];
    if (typeof verify.test_command === "string" && verify.test_command.trim()) {
      return [{ id: "configured", command: verify.test_command.trim() }];
    }
  }
  if (Array.isArray(verify.test_suites)) {
    return verify.test_suites
      .map((suite, index) => {
        if (!suite || typeof suite !== "object") return null;
        if (typeof suite.command !== "string" || !suite.command.trim()) return null;
        const id = typeof suite.id === "string" && suite.id.trim()
          ? suite.id.trim()
          : `suite-${index + 1}`;
        const resourceGroup = typeof suite.resource_group === "string" && suite.resource_group.trim()
          ? suite.resource_group.trim()
          : null;
        return { id, command: suite.command.trim(), resource_group: resourceGroup };
      })
      .filter(Boolean);
  }
  return discoverTestCommands(cwd);
}

function normalizeConcurrency(value, fallback = 1) {
  const n = Number.isInteger(value) ? value : fallback;
  return Math.max(1, Math.min(MAX_TEST_CONCURRENCY, n));
}

function resolveTestConcurrency(config) {
  const verify = (config && config.pipeline && config.pipeline.verify) || {};
  return normalizeConcurrency(verify.test_concurrency, DEFAULT_TEST_CONCURRENCY);
}

function suiteResourceGroup(suite) {
  if (!suite) return null;
  if (typeof suite.resource_group === "string" && suite.resource_group.trim()) return suite.resource_group.trim();
  if (typeof suite.resourceGroup === "string" && suite.resourceGroup.trim()) return suite.resourceGroup.trim();
  return null;
}

async function runTestCommands(commands, opts = {}) {
  const concurrency = normalizeConcurrency(opts.concurrency, 1);
  const runs = new Array(commands.length);
  const started = new Set();
  const activeGroups = new Set();
  let active = 0;
  let completed = 0;

  await new Promise((resolve) => {
    function nextRunnableIndex() {
      for (let index = 0; index < commands.length; index += 1) {
        if (started.has(index)) continue;
        const group = suiteResourceGroup(commands[index]);
        if (group && activeGroups.has(group)) continue;
        return index;
      }
      return -1;
    }

    function schedule() {
      if (completed >= commands.length) {
        resolve();
        return;
      }
      while (active < concurrency) {
        const index = nextRunnableIndex();
        if (index === -1) break;
        const suite = commands[index];
        const resourceGroup = suiteResourceGroup(suite);
        started.add(index);
        active += 1;
        if (resourceGroup) activeGroups.add(resourceGroup);
        const commandOpts = {
          ...opts,
          receipts: opts.receipts
            ? {
                ...opts.receipts,
                suiteId: suite.id,
              }
            : undefined,
        };
        runCommandWithReceipt(suite.command, commandOpts).then((result) => {
          runs[index] = {
            id: suite.id,
            resource_group: resourceGroup || undefined,
            ...result,
          };
        }).finally(() => {
          active -= 1;
          completed += 1;
          if (resourceGroup) activeGroups.delete(resourceGroup);
          schedule();
        });
      }
    }

    schedule();
  });

  return {
    passed: runs.length > 0 && runs.every((run) =>
      run.exitCode === 0 && !run.timedOut && !run.spawnError),
    durationMs: runs.reduce((sum, run) => sum + run.durationMs, 0),
    runs,
  };
}

module.exports = {
  runCommand,
  // Exported for core/standards/discover.js: project discovery must report the
  // same Python test story the verify runner will actually execute, rather
  // than carrying a second, weaker heuristic of its own.
  hasPythonTests,
  runCommandWithReceipt,
  discoverScripts,
  discoverTestCommands,
  resolveCommands,
  resolveTestCommands,
  resolveTestConcurrency,
  runTestCommands,
};
