// Characterization of run()'s dispatch loop, by the order it decides things.
//
// F5's prologue slices were made safe by --plan-only: run the setup, halt
// before the first dispatch, compare a deterministic fingerprint. The loop has
// no such stopping point, so this pins the next best invariant -- the ordered
// sequence of decisions it emits through onEvent.
//
// That order is the thing an endpoint assertion cannot see. `completed: true`
// is reached identically whether a stage dispatched once or retried twice
// first, and 139 existing loop tests assert with events.find(...) -- one event,
// checked for its fields, order unconstrained. A decomposition that reordered
// the loop would pass all of them.

const { describe, it, afterEach } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { makeTargetProject, cleanup } = require("./_helpers");
const { traceRun, decisions } = require("./_loop-trace");

let dirs = [];
const track = (cwd) => { dirs.push(cwd); return cwd; };
afterEach(() => { dirs.forEach(cleanup); dirs = []; });

const runStage = (name, stage) => ({ action: "run-stage", stage, name });
const done = { action: "pipeline-complete", reason: "done" };

describe("dispatch loop: the ordinary path", () => {
  it("dispatches, records the dispatch, and completes", async () => {
    const { trace, summary } = await traceRun({
      cwd: track(makeTargetProject()),
      actions: [runStage("requirements", "stage-01"), done],
    });
    assert.deepEqual(decisions(trace), ["dispatch", "dispatched", "complete"]);
    assert.equal(summary.completed, true);
  });

  it("emits one dispatch/dispatched pair per stage, in stage order", async () => {
    const { trace } = await traceRun({
      cwd: track(makeTargetProject()),
      actions: [runStage("requirements", "stage-01"), runStage("build", "stage-04"), done],
    });
    assert.deepEqual(decisions(trace),
      ["dispatch", "dispatched", "dispatch", "dispatched", "complete"]);
  });

  it("records a merge and a skip without dispatching", async () => {
    const merge = await traceRun({
      cwd: track(makeTargetProject()),
      actions: [{ action: "merge", stage: "stage-04", name: "build" }, done],
      mergeWorkstreamGates: () => ({ merged: true, gatePath: "pipeline/gates/stage-04.json" }),
    });
    assert.deepEqual(decisions(merge.trace), ["merge", "complete"]);

    const skip = await traceRun({
      cwd: track(makeTargetProject()),
      actions: [{
        action: "skip-stage", stage: "stage-04b", name: "security-review",
        skip_kind: "conditionalOn", reason: "condition not met",
      }, done],
    });
    assert.deepEqual(decisions(skip.trace), ["skip-stage", "complete"]);
  });
});

describe("dispatch loop: retrying", () => {
  it("retries a dispatch that produced no gate, then continues", async () => {
    // The sequence is the point. Both this and a clean run end completed: true.
    let attempt = 0;
    const { trace, summary } = await traceRun({
      cwd: track(makeTargetProject()),
      actions: [runStage("requirements", "stage-01"), runStage("requirements", "stage-01"), done],
      dispatch: async () => {
        attempt += 1;
        return [attempt === 1
          ? { role: "pm", gatePath: null, exitCode: 1, durationMs: 1 }
          : { role: "pm", gatePath: "x", exitCode: 0, durationMs: 1 }];
      },
    });
    assert.deepEqual(decisions(trace),
      ["dispatch", "dispatched", "transient-retry", "dispatch", "dispatched", "complete"]);
    assert.equal(summary.completed, true);
  });

  it("counts a fix-and-retry against the stage before re-dispatching it", async () => {
    const cwd = track(makeTargetProject());
    fs.writeFileSync(path.join(cwd, "pipeline", "gates", "stage-04.platform.json"), "{}");
    const { trace, state } = await traceRun({
      cwd,
      actions: [{
        action: "fix-and-retry", stage: "stage-04", name: "build", failure_class: "code-defect",
        blockers: [{ text: "EOL base image", file: "Dockerfile" }],
        clear_gates: ["pipeline/gates/stage-04.platform.json"],
      }, runStage("build", "stage-04"), done],
      dispatch: async () => {
        fs.writeFileSync(path.join(cwd, "Dockerfile"), "FROM node:22-alpine\n");
        return [{ role: "platform", gatePath: "x", exitCode: 0, durationMs: 1 }];
      },
    });
    // fix-retry is recorded on the decision, one iteration before the dispatch
    // it authorizes -- which is what lets the re-dispatch be flagged isRetry.
    assert.deepEqual(decisions(trace).slice(0, 3), ["fix-retry", "dispatch", "dispatched"]);
    assert.deepEqual(state.fixRetries, { build: 1 });
  });

  it("escalates instead of looping when the fix never touched the blocker file", async () => {
    // Same three actions as above; the only difference is that the dispatch
    // does not write Dockerfile. Convergence, not retry budget, stops it.
    const cwd = track(makeTargetProject());
    fs.writeFileSync(path.join(cwd, "pipeline", "gates", "stage-04.platform.json"), "{}");
    const { trace, summary } = await traceRun({
      cwd,
      actions: [{
        action: "fix-and-retry", stage: "stage-04", name: "build", failure_class: "code-defect",
        blockers: [{ text: "EOL base image", file: "Dockerfile" }],
        clear_gates: ["pipeline/gates/stage-04.platform.json"],
      }, runStage("build", "stage-04"), done],
    });
    assert.deepEqual(decisions(trace), ["fix-retry", "dispatch", "dispatched", "halt"]);
    assert.equal(summary.halt_action, "resolve-escalation");
    assert.equal(summary.halt_failure_class, "convergence-exhausted");
    assert.match(summary.halt_reason, /without modifying blocker file/);
  });
});

describe("dispatch loop: halting before a dispatch", () => {
  it("halts at the --until boundary without dispatching", async () => {
    const { trace, summary } = await traceRun({
      cwd: track(makeTargetProject()),
      actions: [runStage("build", "stage-04")],
      until: "requirements",
    });
    assert.deepEqual(decisions(trace), ["until"]);
    assert.equal(summary.halt_action, "until");
    assert.equal(summary.iterations, 1);
  });

  it("runs the --until stage itself, then halts on the next one", async () => {
    // The boundary is inclusive -- core/driver-dispatch.js blocks stages
    // *after* untilIndex, so the named stage runs. #458 corrected the CLI help
    // to say so; nothing pinned the behavior, and an off-by-one here passed
    // both this suite and tests/run.test.js until this test existed.
    const { trace, summary } = await traceRun({
      cwd: track(makeTargetProject()),
      actions: [runStage("requirements", "stage-01"), runStage("build", "stage-04")],
      until: "requirements",
    });
    assert.deepEqual(decisions(trace), ["dispatch", "dispatched", "until"]);
    assert.equal(summary.halt_action, "until");
  });

  it("halts on the budget cap without dispatching", async () => {
    const { trace, summary } = await traceRun({
      cwd: track(makeTargetProject()),
      actions: [runStage("requirements", "stage-01")],
      budgetUsd: 0,
    });
    assert.deepEqual(decisions(trace), ["budget"]);
    assert.equal(summary.halt_action, "budget");
  });

  it("prefers the operator's boundary over the budget when both apply", async () => {
    // Precedence, which is purely an ordering property: driver-dispatch.js
    // checks ceiling, then until, then budget. A run that has passed its cap
    // *and* reached its boundary reports the boundary -- the thing the operator
    // asked for -- not the cap. Reordering those checks is invisible to any
    // assertion that looks at one halt in isolation.
    const { trace, summary } = await traceRun({
      cwd: track(makeTargetProject()),
      actions: [runStage("build", "stage-04")],
      until: "requirements",
      budgetUsd: 0,
    });
    assert.deepEqual(decisions(trace), ["until"]);
    assert.equal(summary.halt_action, "until");
  });

  it("guards a loop that never advances", async () => {
    const { trace, summary } = await traceRun({
      cwd: track(makeTargetProject()),
      next: () => ({ action: "merge", stage: "stage-04", name: "build" }),
      maxIterations: 3,
      mergeWorkstreamGates: () => ({ merged: true }),
    });
    assert.deepEqual(decisions(trace), ["merge", "merge", "merge"]);
    assert.equal(summary.halt_action, "max-iterations");
    assert.equal(summary.iterations, 3);
  });
});
