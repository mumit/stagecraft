// C5 — capability-required permissions.
//
// Verifies that:
//   1. Each adapter's capabilities.json correctly declares shell/network.
//   2. Stage definitions mark the right stages as shell-requiring.
//   3. The orchestrator refuses to dispatch a shell-requiring stage to a
//      host that does not declare enforces.shell: true.

const { describe, it } = require("node:test");
const assert = require("node:assert/strict");
const path = require("node:path");
const { REPO_ROOT, makeTargetProject, cleanup, runCLI } = require("./_helpers");
const { getStage } = require(path.join(REPO_ROOT, "core", "pipeline", "stages"));

// ---------------------------------------------------------------------------
// Adapter capability declarations
// ---------------------------------------------------------------------------

describe("capabilities.json — adapter declarations", () => {
  // 34.4: gemini-cli moved to packages/host-gemini-cli/ (plugin package,
  // not under hosts/); its own capabilities.json coverage now lives in
  // packages/host-gemini-cli/tests/adapter.test.js.
  const adapters = ["claude-code", "codex", "generic", "omnigent"];

  for (const name of adapters) {
    const caps = require(path.join(REPO_ROOT, "hosts", name, "capabilities.json"));
    const expectShell = name !== "generic";

    it(`${name}: enforces.shell === ${expectShell}`, () => {
      assert.strictEqual(
        caps.enforces.shell,
        expectShell,
        `${name} enforces.shell should be ${expectShell}`,
      );
    });

    it(`${name}: enforces.network === ${expectShell}`, () => {
      assert.strictEqual(
        caps.enforces.network,
        expectShell,
        `${name} enforces.network should be ${expectShell}`,
      );
    });
  }

  it("claude-code still declares allowed_writes and stoplist", () => {
    const caps = require(path.join(REPO_ROOT, "hosts", "claude-code", "capabilities.json"));
    assert.ok(caps.enforces.allowed_writes, "allowed_writes missing");
    assert.ok(caps.enforces.stoplist, "stoplist missing");
  });

  it("codex headless command grants workspace writes for artifact and gate creation", () => {
    // Phase-28 item 28.3 appended `--json` to capture orchestrator-observed
    // usage telemetry (core/adapters/codex-exec-json.js) — this test's
    // actual concern is the sandbox mode, so it checks for that flag rather
    // than pinning the full command string.
    const caps = require(path.join(REPO_ROOT, "hosts", "codex", "capabilities.json"));
    assert.match(caps.headlessCommand, /--sandbox workspace-write\b/);
  });
});

// ---------------------------------------------------------------------------
// Stage definitions — requiredCapabilities field
// ---------------------------------------------------------------------------

describe("stage definitions — requiredCapabilities", () => {
  const shellRequired = ["pre-review", "qa", "verification-beyond-tests", "deploy"];
  const noShellRequired = [
    "requirements", "design", "clarification", "executable-spec",
    "build", "security-review", "red-team", "migration-safety",
    "peer-review", "accessibility-audit", "observability-gate",
    "sign-off", "retrospective",
  ];

  for (const name of shellRequired) {
    it(`${name} declares requiredCapabilities.shell: true`, () => {
      const def = getStage(name);
      assert.ok(def, `stage "${name}" not found`);
      assert.strictEqual(
        def.requiredCapabilities?.shell,
        true,
        `${name}.requiredCapabilities.shell should be true`,
      );
    });
  }

  for (const name of noShellRequired) {
    it(`${name} does NOT require shell`, () => {
      const def = getStage(name);
      assert.ok(def, `stage "${name}" not found`);
      assert.ok(
        !def.requiredCapabilities?.shell,
        `${name} should not require shell, got: ${JSON.stringify(def.requiredCapabilities)}`,
      );
    });
  }
});

// ---------------------------------------------------------------------------
// Orchestrator enforcement — CLI integration
// ---------------------------------------------------------------------------

describe("orchestrator: capability gate fires at dispatch time", () => {
  const genericConfig =
    "routing:\n  default_host: generic\npipeline:\n  default_track: full\n";

  it("devteam stage pre-review with generic host exits non-zero with shell error", () => {
    const cwd = makeTargetProject({ config: genericConfig });
    try {
      const r = runCLI(["stage", "pre-review"], { cwd });
      assert.notStrictEqual(r.status, 0, "should exit non-zero");
      const output = r.stderr + r.stdout;
      assert.ok(
        output.includes("shell"),
        `expected "shell" in output, got:\n${output}`,
      );
    } finally {
      cleanup(cwd);
    }
  });

  it("devteam stage deploy with generic host exits non-zero with shell error", () => {
    const cwd = makeTargetProject({ config: genericConfig });
    try {
      const r = runCLI(["stage", "deploy"], { cwd });
      assert.notStrictEqual(r.status, 0, "should exit non-zero");
      const output = r.stderr + r.stdout;
      assert.ok(
        output.includes("shell"),
        `expected "shell" in output, got:\n${output}`,
      );
    } finally {
      cleanup(cwd);
    }
  });

  it("devteam stage qa with generic host exits non-zero with shell error", () => {
    const cwd = makeTargetProject({ config: genericConfig });
    try {
      const r = runCLI(["stage", "qa"], { cwd });
      assert.notStrictEqual(r.status, 0, "should exit non-zero");
      const output = r.stderr + r.stdout;
      assert.ok(
        output.includes("shell"),
        `expected "shell" in output, got:\n${output}`,
      );
    } finally {
      cleanup(cwd);
    }
  });

  it("devteam stage requirements with generic host does NOT error on shell", () => {
    const cwd = makeTargetProject({ config: genericConfig });
    try {
      const r = runCLI(["stage", "requirements"], { cwd });
      const output = r.stderr + r.stdout;
      // May fail for other reasons (missing files, etc.) but not for capability
      assert.ok(
        !output.includes('requires the "shell"'),
        `should not have shell capability error, got:\n${output}`,
      );
    } finally {
      cleanup(cwd);
    }
  });

  it("error message names the stage, role, and host", () => {
    const cwd = makeTargetProject({ config: genericConfig });
    try {
      const r = runCLI(["stage", "pre-review"], { cwd });
      const output = r.stderr + r.stdout;
      assert.ok(output.includes("stage-04a"), `expected stage id in output:\n${output}`);
      assert.ok(output.includes("generic"), `expected host name in output:\n${output}`);
    } finally {
      cleanup(cwd);
    }
  });
});
