// A trace harness for run()'s dispatch loop.
//
// The prologue had --plan-only: run everything up to the first dispatch, halt,
// and read a deterministic fingerprint off disk. The loop has no equivalent --
// it is stateful, mutates `state` and `summary` throughout, and its only
// natural stopping point is the end.
//
// What it does have is onEvent: 24 typed events emitted in the order the loop
// decides things. 139 tests already drive the loop through its injectable
// seams, but they assert with events.find(...) -- one event, checked for its
// fields. Nothing pins the *order*, so a loop that reached the same endpoint by
// a different route reads as unchanged.
//
// traceRun records that order. It is the loop's analogue of plan_fingerprint:
// a compact, order-sensitive signature of what the loop actually did, which is
// the property a decomposition has to preserve and an endpoint assertion
// cannot see.

const path = require("node:path");
const { run } = require("../core/driver");

// traceRun -- drive run() with scripted seams and record the decision order.
//
//   actions   an array of next() results, consumed one per loop iteration.
//             Anything past the end returns pipeline-complete, so a scenario
//             that halts early does not need padding.
//   dispatch  optional runStageHeadless stub. Defaults to one passing
//             workstream, which is what most scenarios want.
//
// Returns { summary, trace, events, state } where `trace` is the ordered list
// of event types and `events` the full objects for field-level assertions.
async function traceRun({ cwd, actions = [], dispatch, ...opts } = {}) {
  const events = [];
  const queue = [...actions];
  const summary = await run({
    cwd,
    budgetUsd: 10,
    next: () => queue.shift() || { action: "pipeline-complete", reason: "done" },
    runStageHeadless: dispatch || (async () => [{ role: "pm", gatePath: "x", exitCode: 0, durationMs: 1 }]),
    // Without this the loop consults the real stall probe, which watches the
    // clock and makes traces non-deterministic.
    stallProbe: () => () => {},
    onEvent: (event) => events.push(event),
    ...opts,
  });
  let state = null;
  try {
    state = JSON.parse(require("node:fs").readFileSync(
      path.join(cwd, "pipeline", "run-state.json"), "utf8"));
  } catch { /* a run that never acquired state */ }
  return { summary, events, state, trace: events.map((e) => e.type) };
}

// Drop the events every run emits regardless of what the loop decides, so a
// scenario's trace is the decisions and not the preamble.
// heartbeat is a per-iteration tick, not a decision; summary.iterations already
// counts them, and leaving them in buries the shape of a trace.
const PREAMBLE = new Set([
  "run-plan", "track-confidence-check", "cost-basis-warning", "token-coverage-warning", "heartbeat",
]);
const decisions = (trace) => trace.filter((type) => !PREAMBLE.has(type));

module.exports = { traceRun, decisions, PREAMBLE };
