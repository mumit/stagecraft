// Property-based testing verification for stage-06d (35.3). Detects a
// supported property-testing framework already present in the project
// (fast-check for JS/TS via package.json devDependency, hypothesis for
// Python via requirements.txt/pyproject.toml, proptest for Rust via
// Cargo.toml — devteam NEVER installs any of them), runs the property
// tests found under the configured path(s), and parses the runner's own
// summary output for an executed-property count and pass/fail. Absent
// toolchain, no matching files, a timeout, or unparseable output are all
// honest recorded skips — never a fabricated "ran" result — same doctrine
// as core/verify/mutation.js's runMutationGate.
//
// Only fast-check (run via Node's built-in test runner, `--test-reporter
// tap`) is integration-tested end-to-end in this codebase (see
// tests/verify-stamp-06d.test.js) — hypothesis/proptest detection and
// output parsing are unit-tested against canned tool output only, since
// this repo doesn't carry a Python or Rust toolchain. Honest scope note,
// not a silent gap: see changelog.d for phase 35.3.
//
// See plans/phase-35-existing-codebase-mode.md item 35.3.

const fs = require("node:fs");
const path = require("node:path");
const { runCommand } = require("./runner");

const DEFAULT_TIMEOUT_MS = 5 * 60 * 1000;
const DEFAULT_PATHS = ["src/tests/property"];
const MAX_FILES = 500;
const MAX_DEPTH = 6;

function resolvePropertyConfig(config) {
  const raw = (config && config.pipeline && config.pipeline.verify && config.pipeline.verify.property) || {};
  return {
    paths: Array.isArray(raw.paths) && raw.paths.length > 0 ? raw.paths : DEFAULT_PATHS,
    // Test/customization escape hatch mirroring mutation.js's `command`
    // override — lets a project (or a test fixture) substitute the exact
    // property-test invocation instead of relying on manifest detection.
    command: typeof raw.command === "string" && raw.command.trim() ? raw.command.trim() : null,
    timeout_ms: Number.isInteger(raw.timeout_ms) && raw.timeout_ms > 0 ? raw.timeout_ms : DEFAULT_TIMEOUT_MS,
  };
}

function readPackageJson(cwd) {
  const p = path.join(cwd, "package.json");
  if (!fs.existsSync(p)) return null;
  try { return JSON.parse(fs.readFileSync(p, "utf8")); } catch { return null; }
}

function readIfExists(p) {
  if (!fs.existsSync(p)) return "";
  try { return fs.readFileSync(p, "utf8"); } catch { return ""; }
}

// fast-check: JS/TS, detected via project devDependency. hypothesis:
// Python, detected via requirements.txt/pyproject.toml mentioning it (no
// single canonical manifest field the way package.json has deps, so a
// text scan is the honest option). proptest: Rust, via Cargo.toml.
function detectRunner(cwd) {
  const pkg = readPackageJson(cwd);
  const deps = pkg ? { ...(pkg.dependencies || {}), ...(pkg.devDependencies || {}) } : {};
  if (deps["fast-check"]) return { id: "fast-check" };

  const pyText = readIfExists(path.join(cwd, "requirements.txt")) + readIfExists(path.join(cwd, "pyproject.toml"));
  if (/hypothesis/i.test(pyText)) return { id: "hypothesis" };

  const cargoText = readIfExists(path.join(cwd, "Cargo.toml"));
  if (/proptest/i.test(cargoText)) return { id: "proptest" };

  return null;
}

const FILE_MATCHERS = {
  "fast-check": (name) => /\.test\.[cm]?[jt]sx?$/i.test(name),
  hypothesis: (name) => /^(?:test_.*|.*_test)\.py$/.test(name),
  proptest: (name) => /\.rs$/i.test(name),
};

// Bounded BFS over a configured path — mirrors runner.js's Python
// test-discovery walk (symlinks skipped, node_modules/.git pruned,
// capped file/depth counts so a misconfigured path can't hang stamping).
function walkFiles(rootDir, matcher) {
  if (!fs.existsSync(rootDir)) return [];
  const out = [];
  const queue = [{ dir: rootDir, depth: 0 }];
  const seen = new Set();
  while (queue.length > 0 && out.length < MAX_FILES) {
    const { dir, depth } = queue.shift();
    const resolved = path.resolve(dir);
    if (seen.has(resolved)) continue;
    seen.add(resolved);
    let entries;
    try { entries = fs.readdirSync(resolved, { withFileTypes: true }); } catch { continue; }
    for (const entry of entries) {
      if (entry.isSymbolicLink()) continue;
      const full = path.join(resolved, entry.name);
      if (entry.isFile()) {
        if (matcher(entry.name)) out.push(full);
      } else if (entry.isDirectory() && depth < MAX_DEPTH && entry.name !== "node_modules" && entry.name !== ".git") {
        queue.push({ dir: full, depth: depth + 1 });
      }
      if (out.length >= MAX_FILES) break;
    }
  }
  return out;
}

function buildCommand(runnerId, relFiles) {
  if (runnerId === "fast-check") return `node --test --test-reporter=tap ${relFiles.join(" ")}`;
  if (runnerId === "hypothesis") return `pytest ${relFiles.join(" ")}`;
  if (runnerId === "proptest") return "cargo test";
  throw new Error(`no command builder for property runner "${runnerId}"`);
}

// TAP output (Node's built-in test runner, `--test-reporter=tap`):
// "# tests N", "# pass N", "# fail N" summary lines. fast-check's own
// failure message is a distinctive "Property failed after N tests" —
// each occurrence is one counterexample; the N values sum to a
// (conservative) cases-tried estimate. A passing run doesn't print a
// count of cases explored, so cases_tried stays null there — an honest
// omission rather than a fabricated number.
const TAP_TESTS_RE = /^#\s*tests\s+(\d+)/m;
const TAP_PASS_RE = /^#\s*pass\s+(\d+)/m;
const TAP_FAIL_RE = /^#\s*fail\s+(\d+)/m;
const FASTCHECK_COUNTEREXAMPLE_RE = /Property failed after (\d+) tests?/g;

// pytest's summary line ("1 failed, 4 passed in 0.12s" / "5 passed in
// 0.10s") — order varies, so passed/failed are matched independently.
// hypothesis prints "Falsifying example: ..." per counterexample.
const PYTEST_PASSED_RE = /(\d+)\s+passed/;
const PYTEST_FAILED_RE = /(\d+)\s+failed/;
const HYPOTHESIS_FALSIFYING_RE = /Falsifying example/g;

// cargo test's summary line: "test result: ok. 4 passed; 0 failed; ...".
// proptest emits "Test failed: ..." per counterexample.
const CARGO_RESULT_RE = /test result:\s*(ok|FAILED)\.\s*(\d+)\s+passed;\s*(\d+)\s+failed;/;
const PROPTEST_FAILURE_RE = /Test failed:/g;

// Tries every known runner's output format in turn (the configured-command
// override doesn't declare which framework it wraps, so all three are
// tried); the first that matches wins. Returns null when nothing parses —
// the caller must treat that as an honest skip, not a pass.
function parseOutput(output) {
  const tapTests = TAP_TESTS_RE.exec(output);
  const tapPass = TAP_PASS_RE.exec(output);
  const tapFail = TAP_FAIL_RE.exec(output);
  if (tapTests && tapPass && tapFail) {
    const counterMatches = [...output.matchAll(FASTCHECK_COUNTEREXAMPLE_RE)];
    return {
      format: "tap",
      properties_asserted: Number(tapTests[1]),
      cases_tried: counterMatches.length > 0 ? counterMatches.reduce((sum, m) => sum + Number(m[1]), 0) : null,
      counterexamples_found: counterMatches.length,
      passed: Number(tapFail[1]) === 0,
    };
  }

  // Checked before the pytest patterns below: "test result: ok. 4 passed;
  // 0 failed;" would otherwise also satisfy PYTEST_PASSED_RE/PYTEST_FAILED_RE
  // (both are bare "(\d+)\s+passed"/"(\d+)\s+failed", no format-specific
  // anchor), silently misattributing a cargo run to the pytest branch.
  const cargo = CARGO_RESULT_RE.exec(output);
  if (cargo) {
    const passedN = Number(cargo[2]);
    const failedN = Number(cargo[3]);
    const failures = [...output.matchAll(PROPTEST_FAILURE_RE)];
    return {
      format: "cargo",
      properties_asserted: passedN + failedN,
      cases_tried: null,
      counterexamples_found: failures.length,
      passed: cargo[1] === "ok",
    };
  }

  const pytestPassed = PYTEST_PASSED_RE.exec(output);
  const pytestFailed = PYTEST_FAILED_RE.exec(output);
  if (pytestPassed || pytestFailed) {
    const passedN = pytestPassed ? Number(pytestPassed[1]) : 0;
    const failedN = pytestFailed ? Number(pytestFailed[1]) : 0;
    const falsifying = [...output.matchAll(HYPOTHESIS_FALSIFYING_RE)];
    return {
      format: "pytest",
      properties_asserted: passedN + failedN,
      cases_tried: null,
      counterexamples_found: falsifying.length,
      passed: failedN === 0,
    };
  }

  return null;
}

// Public entry point. Returns a single { ran, skipped, reason, ... }
// record shaped like runMutationGate's — plus properties_asserted/
// cases_tried/counterexamples_found/passed when a run actually completed
// and parsed.
async function runPropertyGate(cwd, config) {
  const pCfg = resolvePropertyConfig(config);

  let runnerId;
  let command;
  let filesFound;

  if (pCfg.command) {
    runnerId = "configured";
    command = pCfg.command;
    filesFound = null;
  } else {
    const runner = detectRunner(cwd);
    if (!runner) {
      return {
        ran: false, skipped: true,
        reason: "no supported property-based testing framework found — fast-check (package.json), " +
          "hypothesis (requirements.txt/pyproject.toml), or proptest (Cargo.toml); devteam never installs any of them",
      };
    }
    const matcher = FILE_MATCHERS[runner.id];
    const files = pCfg.paths.flatMap((p) => walkFiles(path.join(cwd, p), matcher));
    if (files.length === 0) {
      return {
        ran: false, skipped: true,
        reason: `no property test files found under ${pCfg.paths.join(", ")}`,
        runner: runner.id,
      };
    }
    runnerId = runner.id;
    filesFound = files.map((f) => path.relative(cwd, f));
    command = buildCommand(runner.id, filesFound);
  }

  const result = await runCommand(command, { cwd, timeoutMs: pCfg.timeout_ms });

  if (result.timedOut) {
    return {
      ran: false, skipped: true,
      reason: `property run exceeded timeout_ms=${pCfg.timeout_ms} — killed`,
      runner: runnerId, command, duration_ms: result.durationMs, timed_out: true,
    };
  }
  if (result.spawnError) {
    return {
      ran: false, skipped: true,
      reason: `could not run property command: ${result.spawnError}`,
      runner: runnerId, command,
    };
  }

  const parsed = parseOutput(`${result.stdout}\n${result.stderr}`);
  if (!parsed) {
    return {
      ran: false, skipped: true,
      reason: `property test output unparseable (exit ${result.exitCode})`,
      runner: runnerId, command, exit_code: result.exitCode, duration_ms: result.durationMs,
    };
  }

  return {
    ran: true,
    skipped: false,
    reason: `${command} (exit ${result.exitCode})`,
    runner: runnerId,
    command,
    exit_code: result.exitCode,
    duration_ms: result.durationMs,
    properties_asserted: parsed.properties_asserted,
    cases_tried: parsed.cases_tried,
    counterexamples_found: parsed.counterexamples_found,
    passed: parsed.passed,
    files: filesFound || undefined,
  };
}

module.exports = {
  runPropertyGate,
  resolvePropertyConfig,
  detectRunner,
  parseOutput,
  buildCommand,
  walkFiles,
};
