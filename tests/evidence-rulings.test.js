// Phase 42.5 — a typed path for recording a Principal ruling a human applied.
//
// `--auto-rule` already produces durable `auto-ruled` evidence. A ruling made
// by hand left no typed trace, and the plan forbids inferring one from prose,
// so this is the supported alternative. Modelled on ADR-012's resolution
// acceptance, including its central safeguard: the record binds to a real
// observed halt, so ruling evidence cannot be minted for an escalation that
// never happened.

const { describe, it } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const REPO_ROOT = path.resolve(__dirname, "..");
const { pendingRuling, appendRecordedRuling, haltEventRef } =
  require(path.join(REPO_ROOT, "core", "evidence", "rulings"));
const { analyzeEvidence } = require(path.join(REPO_ROOT, "core", "evidence", "analyzer"));

function project(events) {
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "devteam-test-rulings-"));
  const pipe = path.join(cwd, "pipeline");
  fs.mkdirSync(pipe, { recursive: true });
  if (events) {
    fs.writeFileSync(path.join(pipe, "run-log.jsonl"),
      events.map((e) => JSON.stringify(e)).join("\n") + "\n");
  }
  return { cwd, pipe, cleanup: () => fs.rmSync(cwd, { recursive: true, force: true }) };
}

const HALT = { ts: "2026-08-21T00:00:00Z", outcome: "halt", stage: "stage-04", failure_class: "judgment-gate", iteration: 1 };

describe("evidence: recording a manual Principal ruling", () => {
  it("binds the record to a real judgment-gate halt", () => {
    const p = project([{ outcome: "run-start", intent: "feature" }, HALT]);
    try {
      const event = appendRecordedRuling(p.pipe, { rulingClass: "doc-only", now: "2026-08-21T01:00:00Z" });
      assert.equal(event.outcome, "ruling-recorded");
      assert.equal(event.ruling_class, "doc-only");
      assert.equal(event.stage, "stage-04");
      assert.equal(event.halt_event_sha256, haltEventRef(HALT));
    } finally { p.cleanup(); }
  });

  it("refuses when no escalation ever happened", () => {
    // The safeguard that matters: a human cannot mint ruling evidence for an
    // escalation the pipeline never produced.
    const p = project([{ outcome: "run-start", intent: "feature" }, { outcome: "complete" }]);
    try {
      assert.throws(() => appendRecordedRuling(p.pipe, { rulingClass: "doc-only" }),
        /no unrecorded judgment-gate escalation/);
    } finally { p.cleanup(); }
  });

  it("refuses a halt that is not a judgment gate", () => {
    const p = project([{ ...HALT, failure_class: "code-defect" }]);
    try {
      assert.throws(() => appendRecordedRuling(p.pipe, { rulingClass: "doc-only" }),
        /no unrecorded judgment-gate escalation/);
    } finally { p.cleanup(); }
  });

  it("will not record the same escalation twice", () => {
    const p = project([HALT]);
    try {
      appendRecordedRuling(p.pipe, { rulingClass: "doc-only" });
      assert.throws(() => appendRecordedRuling(p.pipe, { rulingClass: "doc-only" }),
        /no unrecorded judgment-gate escalation/);
    } finally { p.cleanup(); }
  });

  it("records a second ruling once a new escalation exists", () => {
    const p = project([HALT]);
    try {
      appendRecordedRuling(p.pipe, { rulingClass: "doc-only" });
      fs.appendFileSync(path.join(p.pipe, "run-log.jsonl"),
        JSON.stringify({ ...HALT, ts: "2026-08-21T02:00:00Z", iteration: 2 }) + "\n");
      const second = appendRecordedRuling(p.pipe, { rulingClass: "formatting-only" });
      assert.equal(second.ruling_class, "formatting-only");
    } finally { p.cleanup(); }
  });

  it("requires a usable class and stores no free-form prose", () => {
    const p = project([HALT]);
    try {
      for (const bad of [undefined, "", "   ", 42, "x".repeat(65)]) {
        assert.throws(() => appendRecordedRuling(p.pipe, { rulingClass: bad }), /ruling class is required/);
      }
      const event = appendRecordedRuling(p.pipe, { rulingClass: "  Doc-Only  " });
      assert.equal(event.ruling_class, "doc-only", "normalized, not stored as typed");
      // The halt's free-form reason must not travel into the record.
      assert.equal(JSON.stringify(event).includes("reason"), false);
    } finally { p.cleanup(); }
  });

  it("refuses when the run log is missing", () => {
    const p = project(null);
    try {
      assert.throws(() => appendRecordedRuling(p.pipe, { rulingClass: "doc-only" }), /run log is missing/);
    } finally { p.cleanup(); }
  });

  it("pendingRuling returns the newest unanswered escalation", () => {
    const older = { ...HALT, ts: "2026-08-21T00:00:00Z", iteration: 1 };
    const newer = { ...HALT, ts: "2026-08-21T03:00:00Z", iteration: 2 };
    const pending = pendingRuling([older, newer]);
    assert.equal(pending.halt_event_sha256, haltEventRef(newer));
  });
});

describe("evidence: recorded rulings stay a separate population", () => {
  it("does not merge hand-recorded rulings into auto-applied ones", () => {
    // ADR-005 asks which grants operators routinely approve. An auto-applied
    // ruling is evidence a standing grant already exists; a hand-recorded one
    // is evidence about what a human chose. Merging answers a different
    // question than the gate poses.
    const report = analyzeEvidence({
      events: [
        { outcome: "run-start", intent: "feature" },
        { outcome: "auto-ruled", grant_class: "formatting-only" },
        { outcome: "ruling-recorded", ruling_class: "doc-only", stage: "stage-04" },
        { outcome: "complete" },
      ],
      gates: [], quality: {},
    });
    assert.deepEqual(report.rulings, [{ ruling_class: "formatting-only", observations: 1 }]);
    assert.deepEqual(report.recorded_rulings, [{ ruling_class: "doc-only", observations: 1 }]);
  });
});
