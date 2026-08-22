// The chat snapshot's `run` block -- how the run being discussed ended.
//
// Three of its fields were structurally dead: run_id, status, and halted read
// keys (`run_id`, `status`, `halted`) that nothing in the codebase has ever
// written to run-state.json. So a user asking "why did the run stop?" got a
// coordinator that could not tell a halted run from a running one, with
// `unavailable: []` telling the model nothing was missing.

const { describe, it, afterEach } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { makeTargetProject, cleanup } = require("./_helpers");
const { projectSnapshot } = require("../core/coordinator");

let dirs = [];
const track = (cwd) => { dirs.push(cwd); return cwd; };
afterEach(() => { dirs.forEach(cleanup); dirs = []; });

const CONFIG = "routing:\n  default_host: generic\npipeline:\n  default_track: loop\n";
const STARTED = "2026-08-21T10:00:00.000Z";

function project(runState) {
  const cwd = track(makeTargetProject({ config: CONFIG }));
  if (runState) {
    fs.mkdirSync(path.join(cwd, "pipeline"), { recursive: true });
    fs.writeFileSync(path.join(cwd, "pipeline", "run-state.json"),
      JSON.stringify({ track: "loop", started_at: STARTED, iterations: 1, ...runState }, null, 2));
  }
  return cwd;
}
const runOf = (cwd) => projectSnapshot(cwd, {}).run;

describe("chat snapshot: run identity", () => {
  it("reports the invocation id and the lineage root", () => {
    // 42.5: a --resume mints a new run_id and carries logical_run_id forward.
    // Neither was ever stored under the key the snapshot used to read.
    const run = runOf(project({ logical_run_id: "2026-08-20T09:00:00.000Z" }));
    assert.equal(run.run_id, STARTED);
    assert.equal(run.logical_run_id, "2026-08-20T09:00:00.000Z");
  });

  it("is null when there is no run to describe", () => {
    assert.equal(runOf(project(null)), null);
  });
});

describe("chat snapshot: how the run ended", () => {
  it("reports a halt with the action and the reason", () => {
    const run = runOf(project({
      halted: true, completed: false,
      halt_action: "budget", halt_reason: "budget cap reached: $5.10 ≥ $5.00",
    }));
    assert.equal(run.status, "halted");
    assert.equal(run.halted, true);
    assert.equal(run.halt_action, "budget");
    assert.match(run.halt_reason, /budget cap reached/);
  });

  it("reports a completed run", () => {
    const run = runOf(project({ completed: true, halted: false }));
    assert.equal(run.status, "completed");
    assert.equal(run.halted, false);
  });

  it("reports a run that ended by throwing", () => {
    // A crash ends a run as surely as a halt. Without this the snapshot said
    // "not halted, no status" for a run that never got past its first dispatch.
    const run = runOf(project({
      completed: false, halted: false, failed: true,
      failure_reason: 'host "generic" cannot drive workstream "pm" headlessly',
    }));
    assert.equal(run.status, "failed");
    assert.match(run.failure_reason, /cannot drive workstream/);
  });

  it("reports a run still executing", () => {
    // run() saves state once, on the way out, so the state read here belongs to
    // the previous invocation. The lock is what says one is running now.
    const cwd = project({ completed: false, halted: false, failed: false });
    fs.writeFileSync(path.join(cwd, "pipeline", "run.lock"), "{}");
    assert.equal(runOf(cwd).status, "in-progress");
  });
});

describe("chat snapshot: missing evidence is declared", () => {
  it("marks the outcome unavailable for a run-state predating these fields", () => {
    // The prompt instructs the model to call out missing evidence, so silence
    // here would read as "it did not halt" rather than "nobody recorded it".
    const snapshot = projectSnapshot(project({ iterations: 3 }), {});
    assert.ok(snapshot.unavailable.includes("run-outcome"));
    assert.equal(snapshot.run.status, null);
  });

  it("does not mark it unavailable once the outcome is recorded", () => {
    const snapshot = projectSnapshot(project({ halted: true, halt_action: "until" }), {});
    assert.equal(snapshot.unavailable.includes("run-outcome"), false);
  });

  it("truncates a hostile failure_reason like every other project string", () => {
    const run = runOf(project({ failed: true, failure_reason: "x".repeat(5000) }));
    assert.ok(run.failure_reason.length <= 420, "must be bounded before reaching the host");
  });
});
