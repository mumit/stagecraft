// tests/a11y-fixer.test.js
//
// Behavioral tests for core/a11y-fixer.js.
// Covers the pure-core functions (parseBlocker, buildA11yFixPrompt), the
// early-exit paths of fixA11yBlockers, and the dispatch → re-validation
// success path via DEVTEAM_HEADLESS_COMMAND mocks.

const { describe, it, afterEach } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { REPO_ROOT, cleanup } = require("./_helpers");
const {
  parseBlocker,
  buildA11yFixPrompt,
  fixA11yBlockers,
} = require(path.join(REPO_ROOT, "core", "a11y-fixer"));
const { clearConfigCache } = require(path.join(REPO_ROOT, "core", "config"));

// Capture stderr writes temporarily so warnings don't pollute test output.
async function captureStderrAsync(fn) {
  const orig = process.stderr.write.bind(process.stderr);
  const lines = [];
  process.stderr.write = (s) => { lines.push(s); return true; };
  try { return { result: await fn(), lines }; }
  finally { process.stderr.write = orig; }
}

let _tmpDirs = [];
function makeTmp() {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), "devteam-test-"));
  _tmpDirs.push(d);
  return d;
}
afterEach(() => { _tmpDirs.forEach(cleanup); _tmpDirs = []; });

// Minimal adapter stub with headless capability and a command that exits 0.
function makeAdapter(overrides = {}) {
  return {
    capabilities: {
      headless: true,
      headlessCommand: "true",
      ...overrides,
    },
  };
}

// ---------------------------------------------------------------------------
// parseBlocker — pure function
// ---------------------------------------------------------------------------

describe("parseBlocker — object input", () => {
  it("extracts id, element, wcag, severity, and remediation from a well-formed object", () => {
    const b = {
      id: "A11Y-1",
      element: "button.submit",
      wcag: "4.1.2",
      severity: "critical",
      description: "Remediation: Add an aria-label attribute.",
    };
    const r = parseBlocker(b);
    assert.equal(r.id, "A11Y-1");
    assert.equal(r.element, "button.submit");
    assert.equal(r.wcag, "4.1.2");
    assert.equal(r.severity, "critical");
    assert.equal(r.remediation, "Add an aria-label attribute.");
  });

  it("falls back to the full description when no 'Remediation:' prefix is present", () => {
    const b = { id: "A11Y-2", description: "Missing alt text on image." };
    const r = parseBlocker(b);
    assert.equal(r.remediation, "Missing alt text on image.");
  });

  it("returns null for a null input", () => {
    assert.equal(parseBlocker(null), null);
  });

  it("returns null for a non-object, non-string input (number)", () => {
    assert.equal(parseBlocker(42), null);
  });

  it("returns defaults for missing fields (empty strings)", () => {
    const r = parseBlocker({});
    assert.equal(r.id, "");
    assert.equal(r.element, "");
    assert.equal(r.wcag, "");
    assert.equal(r.remediation, "");
    assert.equal(r.severity, "");
  });
});

describe("parseBlocker — string input", () => {
  it("parses a valid JSON string as if it were an object", () => {
    const raw = JSON.stringify({
      id: "A11Y-3",
      description: "Remediation: Set aria-required=true.",
    });
    const r = parseBlocker(raw);
    assert.equal(r.id, "A11Y-3");
    assert.equal(r.remediation, "Set aria-required=true.");
  });

  it("treats a non-JSON string as a plain remediation text (malformed input)", () => {
    const r = parseBlocker("not valid json {{");
    assert.equal(r.id, "");
    assert.equal(r.element, "");
    assert.equal(r.remediation, "not valid json {{");
  });

  it("treats an empty JSON string as a plain remediation text", () => {
    // JSON.parse("") throws — should fall back gracefully
    const r = parseBlocker("");
    assert.equal(r.remediation, "");
  });
});

// ---------------------------------------------------------------------------
// buildA11yFixPrompt — pure function
// ---------------------------------------------------------------------------

describe("buildA11yFixPrompt — empty / malformed input", () => {
  it("returns an empty string for an empty blockers array", () => {
    assert.equal(buildA11yFixPrompt([]), "");
  });

  it("returns an empty string when all blockers parse to null (only nulls)", () => {
    // parseBlocker(null) → null, parseBlocker(42) → null
    assert.equal(buildA11yFixPrompt([null, 42]), "");
  });
});

describe("buildA11yFixPrompt — single blocker", () => {
  it("includes the WCAG rules header and the fix instruction", () => {
    const blockers = [{ id: "A11Y-1", wcag: "4.1.2", element: "nav", description: "Remediation: Add aria-label." }];
    const prompt = buildA11yFixPrompt(blockers);
    assert.ok(prompt.includes("WCAG 2.1 AA"));
    assert.ok(prompt.includes("src/frontend/index.html"));
    assert.ok(prompt.includes("Fix 1"));
    assert.ok(prompt.includes("(A11Y-1)"));
    assert.ok(prompt.includes("WCAG 4.1.2"));
    assert.ok(prompt.includes("element: `nav`"));
    assert.ok(prompt.includes("Add aria-label."));
  });

  it("omits absent optional fields (no wcag, no element)", () => {
    const blockers = [{ id: "A11Y-X", description: "Remediation: Apply fix." }];
    const prompt = buildA11yFixPrompt(blockers);
    assert.ok(prompt.includes("Fix 1"));
    assert.ok(!prompt.includes("WCAG undefined"));
    assert.ok(!prompt.includes("element: ``"));
  });
});

describe("buildA11yFixPrompt — multiple blockers", () => {
  it("numbers each fix sequentially", () => {
    const blockers = [
      { id: "A-1", description: "Remediation: First fix." },
      { id: "A-2", description: "Remediation: Second fix." },
    ];
    const prompt = buildA11yFixPrompt(blockers);
    assert.ok(prompt.includes("Fix 1"));
    assert.ok(prompt.includes("Fix 2"));
    assert.ok(prompt.includes("First fix."));
    assert.ok(prompt.includes("Second fix."));
  });

  it("silently skips null-parsing blockers without breaking the numbering of valid ones", () => {
    // null → filtered before building, so only valid blockers are numbered
    const blockers = [null, { id: "A-1", description: "Remediation: Only fix." }];
    const prompt = buildA11yFixPrompt(blockers);
    assert.ok(prompt.includes("Fix 1"));
    assert.ok(prompt.includes("Only fix."));
    // Should not contain "Fix 2" since there's only one valid blocker
    assert.ok(!prompt.includes("Fix 2"));
  });
});

// ---------------------------------------------------------------------------
// fixA11yBlockers — structural-fix warning (isStructuralFix exercised via stderr)
// ---------------------------------------------------------------------------

describe("fixA11yBlockers — structural-fix warning", () => {
  it("emits a stderr warning when a blocker remediation mentions 'add a label'", async () => {
    const cwd = makeTmp();
    const blockers = [{ id: "A-S1", description: "Remediation: Add a label to the input." }];
    // Use adapter with no headlessCommand so dispatch fails fast after the warning.
    const adapter = makeAdapter({ headlessCommand: undefined });
    const { lines } = await captureStderrAsync(() =>
      fixA11yBlockers(cwd, blockers, { _adapter: adapter }),
    );
    assert.ok(
      lines.some((l) => l.includes("WARNING") && l.includes("structural HTML")),
      `expected structural warning; got: ${lines.join("")}`,
    );
  });

  it("emits a structural warning for 'skip-link' remediation text", async () => {
    const cwd = makeTmp();
    const blockers = [{ id: "A-S2", description: "Remediation: Add a skip navigation link." }];
    const adapter = makeAdapter({ headlessCommand: undefined });
    const { lines } = await captureStderrAsync(() =>
      fixA11yBlockers(cwd, blockers, { _adapter: adapter }),
    );
    assert.ok(lines.some((l) => l.includes("WARNING")));
  });
});

// ---------------------------------------------------------------------------
// fixA11yBlockers — early-exit paths (no real LLM invoked)
// ---------------------------------------------------------------------------

describe("fixA11yBlockers — early exits", () => {
  it("returns dispatch-failed immediately for an empty blockers array", async () => {
    const cwd = makeTmp();
    const { result } = await captureStderrAsync(() => fixA11yBlockers(cwd, []));
    assert.equal(result.status, "dispatch-failed");
    assert.equal(result.exitCode, 1);
    assert.ok(result.reason.includes("no blockers"));
  });

  it("returns dispatch-failed immediately for a non-array blockers argument", async () => {
    const cwd = makeTmp();
    const { result } = await captureStderrAsync(() => fixA11yBlockers(cwd, null));
    assert.equal(result.status, "dispatch-failed");
    assert.ok(result.reason.includes("no blockers"));
  });

  it("returns dispatch-failed when the adapter lacks headless capability", async () => {
    const cwd = makeTmp();
    const adapter = makeAdapter({ headless: false });
    const blockers = [{ id: "A-1", description: "Remediation: Fix it." }];
    const { result } = await captureStderrAsync(() =>
      fixA11yBlockers(cwd, blockers, { _adapter: adapter }),
    );
    assert.equal(result.status, "dispatch-failed");
    assert.ok(result.reason.includes("headless"));
    assert.deepEqual(result.remainingBlockers, blockers);
  });

  it("returns dispatch-failed when the headless adapter has no invoke implementation", async () => {
    const cwd = makeTmp();
    const adapter = makeAdapter();
    const blockers = [{ id: "A-1", description: "Remediation: Fix it." }];
    const { result } = await captureStderrAsync(() =>
      fixA11yBlockers(cwd, blockers, { _adapter: adapter }),
    );
    assert.equal(result.status, "dispatch-failed");
    assert.ok(result.reason.includes("adapter.invoke"));
  });
});

// ---------------------------------------------------------------------------
// fixA11yBlockers — dispatch path: agent exits non-zero
// ---------------------------------------------------------------------------

describe("fixA11yBlockers — agent exits non-zero", () => {
  it("returns dispatch-failed with the agent's exit code when command exits 1", async () => {
    const cwd = makeTmp();
    const blockers = [{ id: "A-1", description: "Remediation: Add aria-label." }];
    const adapter = {
      ...makeAdapter(),
      invoke: async () => ({ exitCode: 1, timedOut: false, writeViolations: [] }),
    };
    const { result } = await captureStderrAsync(() =>
      fixA11yBlockers(cwd, blockers, { _adapter: adapter }),
    );
    assert.equal(result.status, "dispatch-failed");
    assert.equal(result.exitCode, 1);
    assert.deepEqual(result.remainingBlockers, blockers);
  });
});

// ---------------------------------------------------------------------------
// fixA11yBlockers — success path: dispatch exits 0 → re-validation
//
// This covers the "reason the module exists" path: agent fixes the HTML,
// exits 0, then the accessibility audit is re-run to verify.
//
// Setup: a minimal devteam project (just .devteam/config.yml pointing to
// claude-code, which has capabilities.headless = true).  DEVTEAM_HEADLESS_COMMAND
// is set to a node script that controls the gate written by the re-run.
// ---------------------------------------------------------------------------

// Write a minimal devteam project into a tempdir so runStageHeadless can
// resolve the host adapter (claude-code has capabilities.headless=true).
function makeDevteamProject() {
  const cwd = makeTmp();
  fs.mkdirSync(path.join(cwd, ".devteam"), { recursive: true });
  fs.writeFileSync(
    path.join(cwd, ".devteam", "config.yml"),
    "routing:\n  default_host: claude-code\n",
  );
  fs.mkdirSync(path.join(cwd, "pipeline", "gates"), { recursive: true });
  return cwd;
}

// Write a node script that writes a gate file to ./pipeline/gates/stage-06b.json
// relative to CWD when invoked, then exits 0.
function writeGateScript(dir, gate) {
  const scriptDir = path.join(dir, "script dir");
  fs.mkdirSync(scriptDir, { recursive: true });
  const p = path.join(scriptDir, "write gate.js");
  fs.writeFileSync(p, [
    "const fs = require('node:fs');",
    "const path = require('node:path');",
    "const gdir = path.join(process.cwd(), 'pipeline', 'gates');",
    "fs.mkdirSync(gdir, { recursive: true });",
    `fs.writeFileSync(path.join(gdir, 'stage-06b.json'), ${JSON.stringify(JSON.stringify(gate))});`,
  ].join("\n"));
  return p;
}

// Save/restore DEVTEAM_HEADLESS_COMMAND and DEVTEAM_NO_LOG around a test fn.
async function withHeadlessCommand(cmd, fn) {
  const prevCmd = process.env.DEVTEAM_HEADLESS_COMMAND;
  const prevLog = process.env.DEVTEAM_NO_LOG;
  process.env.DEVTEAM_HEADLESS_COMMAND = cmd;
  process.env.DEVTEAM_NO_LOG = "1"; // suppress log files in tempdir
  try {
    return await fn();
  } finally {
    if (prevCmd === undefined) delete process.env.DEVTEAM_HEADLESS_COMMAND;
    else process.env.DEVTEAM_HEADLESS_COMMAND = prevCmd;
    if (prevLog === undefined) delete process.env.DEVTEAM_NO_LOG;
    else process.env.DEVTEAM_NO_LOG = prevLog;
    clearConfigCache(); // prevent cross-test cwd pollution
  }
}

describe("fixA11yBlockers — success path: dispatch exits 0 + audit re-run writes PASS gate", () => {
  it("returns status PASS and exitCode 0 when the re-run gate shows no blockers", async () => {
    const cwd = makeDevteamProject();
    const scriptPath = writeGateScript(cwd, { status: "PASS", blockers: [] });
    assert.ok(scriptPath.includes(" "), `scriptPath must contain spaces: ${scriptPath}`);
    const cmd = `"${process.execPath}" "${scriptPath}"`;

    const blockers = [{ id: "A-1", description: "Remediation: Add aria-label." }];
    const { result } = await captureStderrAsync(() =>
      withHeadlessCommand(cmd, () => fixA11yBlockers(cwd, blockers)),
    );
    assert.equal(result.status, "PASS");
    assert.equal(result.exitCode, 0);
    assert.deepEqual(result.remainingBlockers, []);
  });
});

describe("fixA11yBlockers — success path: dispatch exits 0 + audit re-run writes FAIL gate", () => {
  it("returns status FAIL and exitCode 1 with remaining blockers when audit still fails", async () => {
    const cwd = makeDevteamProject();
    const remaining = [{ id: "A-2", description: "Still failing" }];
    const scriptPath = writeGateScript(cwd, { status: "FAIL", blockers: remaining });
    assert.ok(scriptPath.includes(" "), `scriptPath must contain spaces: ${scriptPath}`);
    const cmd = `"${process.execPath}" "${scriptPath}"`;

    const blockers = [{ id: "A-2", description: "Remediation: Add alt text." }];
    const { result } = await captureStderrAsync(() =>
      withHeadlessCommand(cmd, () => fixA11yBlockers(cwd, blockers)),
    );
    assert.equal(result.status, "FAIL");
    assert.equal(result.exitCode, 1);
    assert.deepEqual(result.remainingBlockers, remaining);
  });
});

describe("fixA11yBlockers — success path: dispatch exits 0 + audit re-run writes no gate", () => {
  it("returns status MISSING and exitCode 1 when the re-run does not produce a gate", async () => {
    const cwd = makeDevteamProject();
    // 'true' exits 0 but writes nothing — gate remains absent after the re-run.
    const blockers = [{ id: "A-3", description: "Remediation: Add role attribute." }];
    const { result } = await captureStderrAsync(() =>
      withHeadlessCommand("true", () => fixA11yBlockers(cwd, blockers)),
    );
    assert.equal(result.status, "MISSING");
    assert.equal(result.exitCode, 1);
    assert.ok(result.reason && result.reason.includes("gate not written"));
  });
});
