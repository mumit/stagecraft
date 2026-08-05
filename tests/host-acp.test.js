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
const { evaluateToolCall, selectOption, findDangerousCommandMatch, findReviewExecViolation } = require(
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

// Two-root permission model + review mode (36.1, plans/phase-36-external-
// review-mode.md §36.1). The describe block above stays untouched — every
// test there still calls evaluateToolCall(toolCall, descriptor, "/repo"), a
// bare string, proving the pre-36.1 single-root call shape is unaffected.
describe("hosts/acp/permissions: two-root review mode (36.1)", () => {
  const roots = (mode, overrides = {}) => ({
    codeRoot: "/repo/code", stateRoot: "/repo/state", mode, ...overrides,
  });

  it("a write into codeRoot is denied in review mode and allowed in normal mode, same descriptor and toolCall", () => {
    const descriptor = makeDescriptor({ allowedWrites: ["build-plan.md"] });
    const toolCall = { kind: "edit", locations: [{ path: "/repo/code/build-plan.md" }] };

    const inReview = evaluateToolCall(toolCall, descriptor, roots("review"));
    assert.equal(inReview.deny, true);
    assert.match(inReview.reason, /review-mode/);
    assert.match(inReview.reason, /read-only/);

    // Same toolCall/descriptor, single root == codeRoot == today's cwd.
    const inNormal = evaluateToolCall(toolCall, descriptor, "/repo/code");
    assert.equal(inNormal.deny, false);
  });

  it("a write under stateRoot matching allowedWrites is allowed in review mode", () => {
    const descriptor = makeDescriptor({ allowedWrites: ["pipeline/build-plan.md"] });
    const toolCall = { kind: "edit", locations: [{ path: "/repo/state/pipeline/build-plan.md" }] };
    const { deny } = evaluateToolCall(toolCall, descriptor, roots("review"));
    assert.equal(deny, false);
  });

  it("a write under stateRoot NOT matching allowedWrites is denied in review mode", () => {
    const descriptor = makeDescriptor({ allowedWrites: ["pipeline/build-plan.md"] });
    const toolCall = { kind: "edit", locations: [{ path: "/repo/state/secret.txt" }] };
    const { deny, reason } = evaluateToolCall(toolCall, descriptor, roots("review"));
    assert.equal(deny, true);
    assert.match(reason, /allowed-writes/);
  });

  it("a write outside both codeRoot and stateRoot stays denied in review mode", () => {
    const descriptor = makeDescriptor({ allowedWrites: ["pipeline/build-plan.md"] });
    const toolCall = { kind: "edit", locations: [{ path: "/elsewhere/file.txt" }] };
    const { deny } = evaluateToolCall(toolCall, descriptor, roots("review"));
    assert.equal(deny, true);
  });

  it("codeRoot absent (36.5's diff-only review) skips straight to the stateRoot check", () => {
    const descriptor = makeDescriptor({ allowedWrites: ["pipeline/build-plan.md"] });
    const toolCall = { kind: "edit", locations: [{ path: "/repo/state/pipeline/build-plan.md" }] };
    const { deny } = evaluateToolCall(toolCall, descriptor, { stateRoot: "/repo/state", mode: "review" });
    assert.equal(deny, false);
  });

  it("`rg foo` is allowed and `sed -i` is denied in review mode; `sed -i` is still allowed (unrestricted) in normal mode", () => {
    const descriptor = makeDescriptor();
    const rg = { kind: "execute", rawInput: { command: "rg foo" } };
    const sed = { kind: "execute", rawInput: { command: "sed -i s/a/b/ file.js" } };

    assert.equal(evaluateToolCall(rg, descriptor, roots("review")).deny, false);
    const sedDenied = evaluateToolCall(sed, descriptor, roots("review"));
    assert.equal(sedDenied.deny, true);
    assert.match(sedDenied.reason, /review-mode/);
    assert.match(sedDenied.reason, /sed/);

    // normal mode's execute handling is unchanged: only the dangerous-command
    // stoplist applies, and "sed -i ..." isn't on it.
    assert.equal(evaluateToolCall(sed, descriptor, "/repo/code").deny, false);
  });

  it("`rg foo > out.txt` is denied in review mode (redirection)", () => {
    const descriptor = makeDescriptor();
    const toolCall = { kind: "execute", rawInput: { command: "rg foo > out.txt" } };
    const { deny, reason } = evaluateToolCall(toolCall, descriptor, roots("review"));
    assert.equal(deny, true);
    assert.match(reason, /redirection|metacharacter/);
  });

  it("denies pipes, backgrounding, command substitution, and semicolons even when the leading binary is allowlisted", () => {
    const descriptor = makeDescriptor();
    for (const command of [
      "rg foo | tee out.txt",
      "cat file.txt; rm -rf /",
      "ls && git checkout .",
      "echo $(rm -rf /)",
      "echo `rm -rf /`",
    ]) {
      const { deny } = evaluateToolCall({ kind: "execute", rawInput: { command } }, descriptor, roots("review"));
      assert.equal(deny, true, `expected deny for: ${command}`);
    }
  });

  it("git is restricted to read-only subcommands in review mode: log/diff/show/status allowed, checkout denied", () => {
    const descriptor = makeDescriptor();
    for (const sub of ["log", "diff", "show", "status"]) {
      const { deny } = evaluateToolCall({ kind: "execute", rawInput: { command: `git ${sub}` } }, descriptor, roots("review"));
      assert.equal(deny, false, `expected allow for: git ${sub}`);
    }
    const denied = evaluateToolCall({ kind: "execute", rawInput: { command: "git checkout ." } }, descriptor, roots("review"));
    assert.equal(denied.deny, true);
    assert.match(denied.reason, /git checkout/);
  });

  it("hosts.acp.review.exec_allowlist extends (not replaces) the default read-only binaries", () => {
    const descriptor = makeDescriptor();
    const jq = { kind: "execute", rawInput: { command: "jq '.foo' file.json" } };
    assert.equal(evaluateToolCall(jq, descriptor, roots("review")).deny, true);
    assert.equal(evaluateToolCall(jq, descriptor, roots("review", { execAllowlist: ["jq"] })).deny, false);
    // default allowlist members keep working alongside the extension.
    const rg = { kind: "execute", rawInput: { command: "rg foo" } };
    assert.equal(evaluateToolCall(rg, descriptor, roots("review", { execAllowlist: ["jq"] })).deny, false);
  });

  it("an execute call with no parseable command is denied by default, not silently allowed", () => {
    assert.match(findReviewExecViolation({ kind: "execute", rawInput: {} }, []), /no inspectable command/);
    assert.match(findReviewExecViolation({ kind: "execute" }, []), /no inspectable command/);
  });

  it("read-kind calls are still ungated by location in review mode (unchanged from normal mode — see plans/acp-read-scope.md)", () => {
    const descriptor = makeDescriptor({ allowedWrites: ["pipeline/build-plan.md"] });
    const toolCall = { kind: "read", locations: [{ path: "/repo/code/secret.txt" }] };
    const { deny } = evaluateToolCall(toolCall, descriptor, roots("review"));
    assert.equal(deny, false);
  });
});

describe("hosts/acp: review mode wiring end-to-end (36.1)", () => {
  it("adapter.invoke actually plumbs ctx.externalReviewMode through to the permission evaluator: same write allowed in normal mode, denied in review mode", async () => {
    const cwd = tmpdir();
    const decisionPath = path.join(cwd, "decision.json");
    const codeRootPath = path.join(cwd, "pipeline", "build-plan.md"); // matches makeDescriptor()'s allowedWrites
    fs.mkdirSync(path.dirname(codeRootPath), { recursive: true });

    await withEnvVars({
      DEVTEAM_HEADLESS_COMMAND: `node "${STUB_PATH}"`,
      ACP_STUB_MODE: "out-of-scope-write",
      ACP_STUB_FORBIDDEN_PATH: codeRootPath,
      ACP_STUB_DECISION_PATH: decisionPath,
    }, async () => {
      const result = await adapter.invoke(makeDescriptor(), makeCtx(cwd, { externalReviewMode: true }), "rendered stage prompt");
      assert.equal(result.gatePath, null, "no gate should be written when the only write attempt is denied");
      const decision = JSON.parse(fs.readFileSync(decisionPath, "utf8"));
      assert.equal(decision.outcome.outcome, "selected");
      assert.equal(decision.outcome.optionId, "reject", "review mode must deny a write to processCwd even though it matches allowedWrites");
    });
  });
});

// Phase-36 item 36.5 (plans/phase-36-external-review-mode.md §36.5) — a PR
// review with no checkout has no subject on disk at all, so codeRoot must be
// genuinely absent, not merely defaulted to ctx.cwd. hosts/acp/permissions.js
// already special-cased a falsy codeRoot ("codeRoot absent (36.5's diff-only
// review) skips straight to the stateRoot check", above) — but adapter.js's
// own `codeRoot: processCwd` (where `processCwd = ctx.processCwd || ctx.cwd`)
// never actually produced a falsy codeRoot: with ctx.processCwd unset,
// codeRoot silently became ctx.cwd itself, which is exactly the "same write
// allowed in normal mode, denied in review mode" test above proves gets
// denied. ctx.noCodeRoot is the explicit opt-in that flips that off.
describe("hosts/acp: review mode wiring end-to-end (36.5 — codeRoot genuinely absent)", () => {
  it("ctx.noCodeRoot:true allows a write under ctx.cwd matching allowedWrites, with no ctx.processCwd set", async () => {
    const cwd = tmpdir();
    const allowedPath = path.join(cwd, "pipeline", "build-plan.md"); // matches makeDescriptor()'s allowedWrites
    fs.mkdirSync(path.dirname(allowedPath), { recursive: true });
    const gatePath = path.join(cwd, "pipeline", "gates", "stage-04.backend.json"); // matches makeDescriptor()'s workstreamId
    const gateJson = JSON.stringify({ stage: "stage-04", status: "PASS" });

    await withEnvVars({
      DEVTEAM_HEADLESS_COMMAND: `node "${STUB_PATH}"`,
      ACP_STUB_MODE: "normal",
      ACP_STUB_ALLOWED_PATH: allowedPath,
      ACP_STUB_GATE_PATH: gatePath,
      ACP_STUB_GATE_JSON: gateJson,
    }, async () => {
      const result = await adapter.invoke(
        makeDescriptor(),
        makeCtx(cwd, { externalReviewMode: true, noCodeRoot: true }),
        "rendered stage prompt",
      );
      assert.equal(result.gatePath, gatePath, "the write must be allowed and the gate written — without the adapter.js fix, codeRoot === stateRoot and this write is denied as `readOnlySubject`, exactly like the plain-omitted-processCwd test above");
      assert.ok(fs.existsSync(gatePath));
    });
  });

  it("omitting ctx.noCodeRoot keeps the fail-closed default even with the same paths (no accidental broadening)", async () => {
    const cwd = tmpdir();
    const allowedPath = path.join(cwd, "pipeline", "build-plan.md");
    fs.mkdirSync(path.dirname(allowedPath), { recursive: true });
    const gatePath = path.join(cwd, "pipeline", "gates", "stage-04.backend.json");

    await withEnvVars({
      DEVTEAM_HEADLESS_COMMAND: `node "${STUB_PATH}"`,
      ACP_STUB_MODE: "normal",
      ACP_STUB_ALLOWED_PATH: allowedPath,
      ACP_STUB_GATE_PATH: gatePath,
      ACP_STUB_GATE_JSON: JSON.stringify({ stage: "stage-04", status: "PASS" }),
    }, async () => {
      // ctx.noCodeRoot deliberately absent — externalReviewMode alone must
      // not be enough to allow this write.
      const result = await adapter.invoke(makeDescriptor(), makeCtx(cwd, { externalReviewMode: true }), "rendered stage prompt");
      assert.equal(result.gatePath, null, "without ctx.noCodeRoot, codeRoot still falls back to ctx.cwd and the write is denied");
    });
  });
});
