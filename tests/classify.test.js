// Unit tests for gate-time failure classification (ADR-003 / H1).
// classifyGate is a pure function — exercised here directly with crafted
// gate/fixStep inputs, independent of next()'s wiring.

const { describe, it } = require("node:test");
const assert = require("node:assert/strict");
const path = require("node:path");
const { REPO_ROOT } = require("./_helpers");
const { classifyGate, classifyDispatch, MAX_RETRIES_DEFAULT } = require(path.join(REPO_ROOT, "core", "gates", "classify"));

describe("classifyGate", () => {
  it("corrupt flag → state-corruption (no status to read)", () => {
    assert.equal(classifyGate(null, null, { corrupt: true }), "state-corruption");
  });

  it("null gate → state-corruption", () => {
    assert.equal(classifyGate(null, null), "state-corruption");
  });

  it("ESCALATE → judgment-gate", () => {
    assert.equal(classifyGate({ status: "ESCALATE" }, null), "judgment-gate");
  });

  it("FAIL with no recipe (null fixSteps) → code-defect", () => {
    assert.equal(classifyGate({ status: "FAIL" }, null), "code-defect");
  });

  it("FAIL with an empty fixSteps array → code-defect (no recipe)", () => {
    assert.equal(classifyGate({ status: "FAIL" }, []), "code-defect");
  });

  it("FAIL with executable commands → code-defect", () => {
    const steps = [
      { description: "Note the blockers", commands: [] },
      { description: "Re-run build", commands: ["devteam stage build --headless"] },
    ];
    assert.equal(classifyGate({ status: "FAIL" }, steps), "code-defect");
  });

  it("FAIL whose every step is human-action (all empty commands) → external-blocked", () => {
    const steps = [
      { description: "Obtain PM sign-off", commands: [] },
      { description: "Contact the security team", commands: [] },
    ];
    assert.equal(classifyGate({ status: "FAIL" }, steps), "external-blocked");
  });

  it("PASS → null (not a failure)", () => {
    assert.equal(classifyGate({ status: "PASS" }, null), null);
  });

  it("WARN → null (not a failure)", () => {
    assert.equal(classifyGate({ status: "WARN" }, null), null);
  });

  it("exposes a default retry ceiling", () => {
    assert.equal(MAX_RETRIES_DEFAULT, 2);
  });
});

describe("classifyDispatch", () => {
  it("wrote a gate → ok", () => {
    assert.equal(classifyDispatch({ wroteGate: true, exitCode: 0, timedOut: false }), "ok");
  });

  it("non-zero exit, no gate, first time → transient", () => {
    assert.equal(classifyDispatch({ wroteGate: false, exitCode: 1, timedOut: false }, { transientRetries: 0 }), "transient");
  });

  it("timed out, no gate, first time → transient", () => {
    assert.equal(classifyDispatch({ wroteGate: false, exitCode: null, timedOut: true }, { transientRetries: 0 }), "transient");
  });

  it("clean exit (0) but no gate → structural-input immediately", () => {
    assert.equal(classifyDispatch({ wroteGate: false, exitCode: 0, timedOut: false }, { transientRetries: 0 }), "structural-input");
  });

  it("no gate after the transient budget is spent → structural-input", () => {
    assert.equal(classifyDispatch({ wroteGate: false, exitCode: 1, timedOut: false }, { transientRetries: 1, maxTransientRetries: 1 }), "structural-input");
  });

  it("stub gate present, clean exit, first attempt → transient (not structural-input)", () => {
    assert.equal(
      classifyDispatch({ wroteGate: false, exitCode: 0, timedOut: false, stubGate: true }, { transientRetries: 0 }),
      "transient",
    );
  });

  it("stub gate present, crash exit, first attempt → transient", () => {
    assert.equal(
      classifyDispatch({ wroteGate: false, exitCode: 1, timedOut: false, stubGate: true }, { transientRetries: 0 }),
      "transient",
    );
  });

  it("stub gate present after budget spent → structural-input", () => {
    assert.equal(
      classifyDispatch({ wroteGate: false, exitCode: 0, timedOut: false, stubGate: true }, { transientRetries: 1, maxTransientRetries: 1 }),
      "structural-input",
    );
  });

  it("wrote a real gate (overwrite of stub) → ok regardless of exit code", () => {
    assert.equal(
      classifyDispatch({ wroteGate: true, exitCode: 0, timedOut: false, stubGate: false }),
      "ok",
    );
  });
});

// Issue #490. codex exits 0 with an empty stream when the account is out of
// quota; four consecutive runs halted as "input is structurally unworkable",
// which sent the operator to re-read a feature description instead of checking
// the account. A clean exit that produced ZERO bytes did not evaluate the input
// at all, so naming the input is wrong — and the two conditions want opposite
// responses: change the input, versus fix the host and re-run it unchanged.
describe("classifyDispatch: a silent host is not a structural input", () => {
  const silent = { wroteGate: false, exitCode: 0, timedOut: false, noOutput: true };

  it("classifies a clean exit with no output at all as host-silent", () => {
    assert.equal(classifyDispatch(silent), "host-silent");
  });

  it("still calls a clean exit WITH output structural", () => {
    // The host ran and declined to write a gate. That is evidence about the
    // input, and the existing behaviour is correct.
    assert.equal(classifyDispatch({ ...silent, noOutput: false }), "structural-input");
  });

  it("treats an unreported outputBytes as structural, not silent", () => {
    // An adapter that cannot report bytes must not have its dispatches
    // reclassified: unknown is not silence.
    assert.equal(classifyDispatch({ wroteGate: false, exitCode: 0, timedOut: false }),
      "structural-input");
  });

  it("does not reclassify a crash or a timeout", () => {
    // Those already retry; silence is only meaningful on a *clean* exit.
    assert.equal(classifyDispatch({ wroteGate: false, exitCode: 1, timedOut: false, noOutput: true }),
      "transient");
    assert.equal(classifyDispatch({ wroteGate: false, exitCode: null, timedOut: true, noOutput: true }),
      "transient");
  });

  it("never overrides a written gate", () => {
    assert.equal(classifyDispatch({ wroteGate: true, exitCode: 0, timedOut: false, noOutput: true }),
      "ok");
  });

  it("leaves the stub-gate path alone", () => {
    // A stub gate means the host wrote something and ran out of room; that is
    // transient on its own terms and unrelated to silence.
    assert.equal(classifyDispatch(
      { wroteGate: false, exitCode: 0, timedOut: false, stubGate: true, noOutput: true },
      { transientRetries: 0, maxTransientRetries: 2 },
    ), "transient");
  });
});
