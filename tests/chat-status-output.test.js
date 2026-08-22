// What `/status` prints in an interactive chat session.
//
// #464 gave the snapshot the run's outcome so the model could reason about it.
// The human half was still wrong: printSnapshot labelled next().reason as
// "why", so a run that had failed on its first dispatch printed
//
//   run:   failed; stage requirements; 1 iteration(s)
//   why:   stage not started
//
// -- two contradictory lines -- while the actual reason sat in the snapshot
// unprinted. next() describes what to do next, not what went wrong.

const { describe, it, mock } = require("node:test");
const assert = require("node:assert/strict");
const { printSnapshot } = require("../core/cli/commands/chat");

function render(snapshot) {
  const lines = [];
  const write = mock.method(process.stdout, "write", (text) => { lines.push(text); return true; });
  try { printSnapshot(snapshot); } finally { write.mock.restore(); }
  return lines.join("");
}

const base = {
  pipeline: { track: "loop" },
  unavailable: [],
  next: { action: "run-stage", name: "requirements", reason: "stage not started",
    suggested_command: "devteam stage requirements --headless" },
};
const withRun = (run) => ({ ...base, run: { iterations: 1, cost_usd: 0, ...run } });

describe("chat /status: why the run stopped", () => {
  it("reports a failure reason rather than the next action's reason", () => {
    const out = render(withRun({
      status: "failed", current_stage: "requirements", failed: true,
      failure_reason: 'host "generic" cannot drive workstream "pm" headlessly',
    }));
    assert.match(out, /^why: {3}host "generic" cannot drive workstream "pm" headlessly$/m);
    assert.doesNotMatch(out, /^why: {3}stage not started$/m);
  });

  it("reports a halt reason", () => {
    const out = render(withRun({
      status: "halted", halted: true, halt_action: "budget",
      halt_reason: "budget cap reached: $5.10 ≥ $5.00",
    }));
    assert.match(out, /^why: {3}budget cap reached/m);
  });

  it("prefers the failure reason when a run somehow carries both", () => {
    const out = render(withRun({
      status: "failed", halt_reason: "reached --until boundary", failure_reason: "disk full",
    }));
    assert.match(out, /^why: {3}disk full$/m);
  });

  it("keeps the next action's reason, labelled as a note about that action", () => {
    const out = render(withRun({ status: "halted", halt_reason: "stopped" }));
    assert.match(out, /^note: {2}stage not started$/m);
    assert.match(out, /^try: {3}devteam stage requirements --headless$/m);
  });
});

describe("chat /status: when the outcome is unknown", () => {
  it("says the outcome was never recorded for a pre-#464 run-state", () => {
    const out = render({ ...base, unavailable: ["run-outcome"], run: { iterations: 3, cost_usd: 0, status: null } });
    assert.match(out, /^why: {3}not recorded \(run-state predates run-outcome tracking\)$/m);
  });

  it("prints no why line for a run that has not stopped", () => {
    const out = render(withRun({ status: "in-progress" }));
    assert.doesNotMatch(out, /^why:/m);
    assert.match(out, /^run: {3}in-progress/m);
  });

  it("handles a project with no run at all", () => {
    const out = render({ ...base, run: null });
    assert.match(out, /^run: {3}none$/m);
    assert.match(out, /^cost: {2}unavailable$/m);
    assert.doesNotMatch(out, /^why:/m);
  });
});
