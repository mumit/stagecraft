// `devteam evidence accept-resolution --stage` (ADR-012).
//
// pendingResolution returns the newest unaccepted fix/retry. On a run that
// retried stage-04 successfully and then escalated at stage-06, the newest slot
// holds a retry that never resolved — assertPassingGate correctly refuses it,
// and before --stage existed there was then no way to accept stage-04's
// genuine, derivable resolution at all. Observed on a real run, and part of why
// accepted-resolution evidence stayed at zero.

const { describe, it } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const REPO_ROOT = path.resolve(__dirname, "..");
const { pendingResolution, pendingResolutionStages, appendAcceptedResolution } =
  require(path.join(REPO_ROOT, "core", "evidence", "resolutions"));

const RESOLVED = {
  ts: "2026-08-21T00:00:00Z", outcome: "fix-retry", stage: "stage-04",
  failure_class: "code-defect", attempt: 1, cleared_gates: 1, derivable: true,
};
const UNRESOLVED = {
  ts: "2026-08-21T01:00:00Z", outcome: "fix-retry", stage: "stage-06",
  failure_class: "code-defect", attempt: 1, cleared_gates: 0, derivable: false,
};

function project({ gates = {} } = {}) {
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "devteam-test-accept-"));
  const pipe = path.join(cwd, "pipeline");
  fs.mkdirSync(path.join(pipe, "gates"), { recursive: true });
  fs.writeFileSync(path.join(pipe, "run-log.jsonl"),
    [RESOLVED, UNRESOLVED].map((e) => JSON.stringify(e)).join("\n") + "\n");
  for (const [stage, status] of Object.entries(gates)) {
    fs.writeFileSync(path.join(pipe, "gates", `${stage}.json`), JSON.stringify({ stage, status }));
  }
  return { cwd, pipe, cleanup: () => fs.rmSync(cwd, { recursive: true, force: true }) };
}

describe("pendingResolution: stage selection", () => {
  it("returns the newest unaccepted retry when no stage is named", () => {
    assert.equal(pendingResolution([RESOLVED, UNRESOLVED]).stage, "stage-06");
  });

  it("returns the named stage's retry when one is", () => {
    const p = pendingResolution([RESOLVED, UNRESOLVED], { stage: "stage-04" });
    assert.equal(p.stage, "stage-04");
    assert.equal(p.derivable, true);
  });

  it("returns null for a stage with no unaccepted retry", () => {
    assert.equal(pendingResolution([RESOLVED, UNRESOLVED], { stage: "stage-05" }), null);
  });

  it("lists every stage with an unaccepted retry, newest first", () => {
    assert.deepEqual(pendingResolutionStages([RESOLVED, UNRESOLVED]), ["stage-06", "stage-04"]);
  });
});

describe("accept-resolution: an unresolved later retry no longer blocks an earlier one", () => {
  it("refuses the newest when its gate is not PASS, and names the alternative", () => {
    const p = project({ gates: { "stage-04": "PASS", "stage-06": "ESCALATE" } });
    try {
      assert.throws(() => appendAcceptedResolution(p.pipe, {}),
        /stage-06 gate must be PASS.*stage-04.*--stage/s);
    } finally { p.cleanup(); }
  });

  it("accepts the earlier, genuinely resolved retry when named", () => {
    const p = project({ gates: { "stage-04": "PASS", "stage-06": "ESCALATE" } });
    try {
      const event = appendAcceptedResolution(p.pipe, { stage: "stage-04" });
      assert.equal(event.outcome, "resolution-accepted");
      assert.equal(event.stage, "stage-04");
      assert.equal(event.derivable, true);
    } finally { p.cleanup(); }
  });

  it("still refuses a named stage whose gate is not PASS", () => {
    // The selector chooses which resolution to consider; it never bypasses
    // ADR-012's requirement that the stage actually ended up passing.
    const p = project({ gates: { "stage-04": "PASS", "stage-06": "ESCALATE" } });
    try {
      assert.throws(() => appendAcceptedResolution(p.pipe, { stage: "stage-06" }),
        /stage-06 gate must be PASS/);
    } finally { p.cleanup(); }
  });

  it("does not accept the same resolution twice", () => {
    const p = project({ gates: { "stage-04": "PASS", "stage-06": "ESCALATE" } });
    try {
      appendAcceptedResolution(p.pipe, { stage: "stage-04" });
      assert.throws(() => appendAcceptedResolution(p.pipe, { stage: "stage-04" }),
        /no unaccepted fix\/retry resolution is available for stage-04/);
    } finally { p.cleanup(); }
  });

  it("reports a bare not-available message when nothing else is pending", () => {
    const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "devteam-test-accept-none-"));
    const pipe = path.join(cwd, "pipeline");
    fs.mkdirSync(path.join(pipe, "gates"), { recursive: true });
    fs.writeFileSync(path.join(pipe, "run-log.jsonl"), JSON.stringify({ outcome: "complete" }) + "\n");
    try {
      assert.throws(() => appendAcceptedResolution(pipe, {}),
        /no unaccepted fix\/retry resolution is available$/);
    } finally { fs.rmSync(cwd, { recursive: true, force: true }); }
  });
});
