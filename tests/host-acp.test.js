// hosts/acp/ — Agent Client Protocol host adapter (plans/phase-34-interop-
// auditable-sdlc.md §34.1).
//
// No network: every test drives tests/fixtures/acp-stub-agent.js, a
// scripted ACP agent that speaks the real wire protocol (newline-delimited
// JSON-RPC 2.0) over stdio but never touches a model. Structural adapter
// checks (capabilities shape, install/status/uninstall round-trip,
// renderStagePrompt contract, shared gate-footer equivalence) are covered
// generically by tests/adapter-contract.test.js — this file covers the
// custom invoke() session lifecycle and enforcement mapping that no other
// adapter exercises.

const { describe, it, afterEach } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { REPO_ROOT, cleanup } = require("./_helpers");

const adapter = require(path.join(REPO_ROOT, "hosts", "acp", "adapter.js"));
const { evaluateToolCall, selectOption, findDangerousCommandMatch } = require(
  path.join(REPO_ROOT, "hosts", "acp", "permissions.js"),
);
const STUB_PATH = path.join(REPO_ROOT, "tests", "fixtures", "acp-stub-agent.js");

let _dirs = [];
function tmpdir() {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), "devteam-test-acp-"));
  fs.mkdirSync(path.join(d, "pipeline", "gates"), { recursive: true });
  _dirs.push(d);
  return d;
}
afterEach(() => {
  for (const d of _dirs) cleanup(d);
  _dirs = [];
});

function makeDescriptor(overrides = {}) {
  return {
    stage: "stage-04",
    name: "build",
    role: "backend",
    rolesInStage: ["backend"],
    workstreamId: "stage-04.backend",
    objective: "test objective",
    readFirst: [],
    allowedWrites: ["pipeline/build-plan.md"],
    artifact: "pipeline/build-plan.md",
    template: "build-template.md",
    expectedGate: {},
    ...overrides,
  };
}

function makeCtx(cwd, overrides = {}) {
  return { track: "full", feature: "test", cwd, isolation: "in-place", log: false, ...overrides };
}

// Sets several env vars for the duration of fn, restoring the prior values
// (or absence) afterward — same discipline as tests/headless.test.js's
// withEnv, generalized to a batch since the stub agent takes several.
async function withEnvVars(vars, fn) {
  const prior = {};
  for (const key of Object.keys(vars)) prior[key] = process.env[key];
  for (const [key, value] of Object.entries(vars)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  try {
    return await fn();
  } finally {
    for (const [key, value] of Object.entries(prior)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
}

describe("hosts/acp: capabilities", () => {
  it("pins the ACP protocol version and declares call-time enforcement", () => {
    assert.equal(adapter.capabilities.name, "acp");
    assert.equal(adapter.capabilities.acpProtocolVersion, 1);
    assert.equal(adapter.capabilities.enforces.allowed_writes, "tool-call-time");
    assert.equal(adapter.capabilities.enforces.stoplist, "tool-call-time");
  });
});

describe("hosts/acp: resolveAgentCommand precedence", () => {
  it("DEVTEAM_HEADLESS_COMMAND overrides everything", async () => {
    await withEnvVars({ DEVTEAM_HEADLESS_COMMAND: "node stub.js" }, () => {
      const cmd = adapter.resolveAgentCommand(makeDescriptor({ agentCommand: "ignored-agent" }), makeCtx(tmpdir()));
      assert.equal(cmd, "node stub.js");
    });
  });

  it("descriptor.agentCommand (routing acp:<command> form) is used absent an env override", async () => {
    await withEnvVars({ DEVTEAM_HEADLESS_COMMAND: undefined }, () => {
      const cmd = adapter.resolveAgentCommand(makeDescriptor({ agentCommand: "my-acp-agent --flag" }), makeCtx(tmpdir()));
      assert.equal(cmd, "my-acp-agent --flag");
    });
  });

  it("falls back to capabilities.headlessCommand absent any override", async () => {
    await withEnvVars({ DEVTEAM_HEADLESS_COMMAND: undefined }, () => {
      const cmd = adapter.resolveAgentCommand(makeDescriptor(), makeCtx(tmpdir()));
      assert.equal(cmd, adapter.capabilities.headlessCommand);
    });
  });
});

describe("hosts/acp: end-to-end stage via stub agent", () => {
  it("completes a stage: initialize → session/new → session/prompt → allowed write → gate written", async () => {
    const cwd = tmpdir();
    const gatePath = path.join(cwd, "pipeline", "gates", "stage-04.backend.json");
    const gateJson = JSON.stringify({ stage: "stage-04", workstream: "backend", status: "PASS", host: "acp", orchestrator: "devteam@test" });

    await withEnvVars({
      DEVTEAM_HEADLESS_COMMAND: `node "${STUB_PATH}"`,
      ACP_STUB_MODE: "normal",
      ACP_STUB_ALLOWED_PATH: path.join(cwd, "pipeline", "build-plan.md"),
      ACP_STUB_GATE_PATH: gatePath,
      ACP_STUB_GATE_JSON: gateJson,
    }, async () => {
      const result = await adapter.invoke(makeDescriptor(), makeCtx(cwd), "rendered stage prompt");
      assert.equal(result.gatePath, gatePath);
      assert.equal(result.stopReason, "end_turn");
      assert.equal(result.timedOut, false);
      assert.equal(result.protocolError, undefined);
      assert.ok(fs.existsSync(gatePath));
      assert.equal(fs.readFileSync(gatePath, "utf8"), gateJson);
    });
  });
});

describe("hosts/acp: permission mapping denies at call time", () => {
  it("an edit outside allowedWrites is denied via a real reject option (not merely absent)", async () => {
    const cwd = tmpdir();
    const decisionPath = path.join(cwd, "decision.json");
    const forbiddenPath = path.join(cwd, "secret.txt");

    await withEnvVars({
      DEVTEAM_HEADLESS_COMMAND: `node "${STUB_PATH}"`,
      ACP_STUB_MODE: "out-of-scope-write",
      ACP_STUB_FORBIDDEN_PATH: forbiddenPath,
      ACP_STUB_DECISION_PATH: decisionPath,
    }, async () => {
      const result = await adapter.invoke(makeDescriptor(), makeCtx(cwd), "rendered stage prompt");
      assert.equal(result.gatePath, null, "no gate should be written when the only write attempt is denied");
      assert.ok(fs.existsSync(decisionPath));
      const decision = JSON.parse(fs.readFileSync(decisionPath, "utf8"));
      assert.equal(decision.outcome.outcome, "selected");
      assert.equal(decision.outcome.optionId, "reject");
    });
  });

  it("a stoplisted dangerous command (rm -rf) is denied via a real reject option", async () => {
    const cwd = tmpdir();
    const decisionPath = path.join(cwd, "decision.json");

    await withEnvVars({
      DEVTEAM_HEADLESS_COMMAND: `node "${STUB_PATH}"`,
      ACP_STUB_MODE: "dangerous-command",
      ACP_STUB_DECISION_PATH: decisionPath,
    }, async () => {
      const result = await adapter.invoke(makeDescriptor(), makeCtx(cwd), "rendered stage prompt");
      assert.equal(result.gatePath, null);
      const decision = JSON.parse(fs.readFileSync(decisionPath, "utf8"));
      assert.equal(decision.outcome.outcome, "selected");
      assert.equal(decision.outcome.optionId, "reject");
    });
  });
});

describe("hosts/acp: malformed-protocol and timeout handling", () => {
  it("a malformed (non-JSON) line from the agent terminates the session and reports a protocol error, not a hang", async () => {
    const cwd = tmpdir();
    await withEnvVars({
      DEVTEAM_HEADLESS_COMMAND: `node "${STUB_PATH}"`,
      ACP_STUB_MODE: "malformed",
    }, async () => {
      const result = await adapter.invoke(makeDescriptor(), makeCtx(cwd, { timeoutMs: 10000 }), "rendered stage prompt");
      assert.equal(result.gatePath, null);
      assert.equal(result.timedOut, false);
      assert.ok(typeof result.protocolError === "string" && result.protocolError.length > 0);
    });
  });

  it("an agent that never responds to session/prompt is bounded by ctx.timeoutMs", async () => {
    const cwd = tmpdir();
    await withEnvVars({
      DEVTEAM_HEADLESS_COMMAND: `node "${STUB_PATH}"`,
      ACP_STUB_MODE: "hang",
    }, async () => {
      const result = await adapter.invoke(makeDescriptor(), makeCtx(cwd, { timeoutMs: 300 }), "rendered stage prompt");
      assert.equal(result.timedOut, true);
      assert.equal(result.exitCode, null);
      assert.equal(result.gatePath, null);
    });
  });
});

describe("hosts/acp/permissions: unit-level mapping", () => {
  it("denies an edit tool call whose location falls outside allowedWrites", () => {
    const descriptor = makeDescriptor({ allowedWrites: ["pipeline/build-plan.md"] });
    const toolCall = { kind: "edit", locations: [{ path: "/repo/secret.txt" }] };
    const { deny, reason } = evaluateToolCall(toolCall, descriptor, "/repo");
    assert.equal(deny, true);
    assert.match(reason, /allowed-writes/);
  });

  it("allows an edit tool call whose location is inside allowedWrites", () => {
    const descriptor = makeDescriptor({ allowedWrites: ["pipeline/build-plan.md"] });
    const toolCall = { kind: "edit", locations: [{ path: "/repo/pipeline/build-plan.md" }] };
    const { deny } = evaluateToolCall(toolCall, descriptor, "/repo");
    assert.equal(deny, false);
  });

  it("does not gate a read tool call against allowedWrites", () => {
    const descriptor = makeDescriptor({ allowedWrites: ["pipeline/build-plan.md"] });
    const toolCall = { kind: "read", locations: [{ path: "/repo/secret.txt" }] };
    const { deny } = evaluateToolCall(toolCall, descriptor, "/repo");
    assert.equal(deny, false);
  });

  it("findDangerousCommandMatch flags rm -rf and git push --force/-f, not ordinary commands", () => {
    assert.ok(findDangerousCommandMatch({ rawInput: { command: "rm -rf ./build" } }));
    assert.ok(findDangerousCommandMatch({ rawInput: { command: "git push --force origin main" } }));
    assert.ok(findDangerousCommandMatch({ rawInput: { command: "git push -f origin main" } }));
    assert.equal(findDangerousCommandMatch({ rawInput: { command: "npm test" } }), null);
    assert.equal(findDangerousCommandMatch({ rawInput: { command: "rm -f build/output.txt" } }), null);
  });

  it("selectOption prefers the *_once option and returns null when no compatible option exists", () => {
    const options = [
      { optionId: "always-allow", name: "Always allow", kind: "allow_always" },
      { optionId: "once-allow", name: "Allow once", kind: "allow_once" },
    ];
    assert.deepEqual(selectOption(options, false), { optionId: "once-allow" });
    assert.equal(selectOption(options, true), null); // no reject_* option offered
  });
});
