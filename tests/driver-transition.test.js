const { describe, it, afterEach } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { REPO_ROOT, makeTargetProject, cleanup } = require("./_helpers");
const { run } = require(path.join(REPO_ROOT, "core", "driver"));
const {
  TRANSITION_CONTROLS,
  transitionResult,
  applyTransitionResult,
} = require(path.join(REPO_ROOT, "core", "driver-transition"));
const {
  dispatchGuardTransition,
  normalizeDispatchResults,
  transientDelayPlan,
  dispatchOutcomeTransition,
  targetedFixNoChangeTransition,
  scopeGateTransition,
} = require(path.join(REPO_ROOT, "core", "driver-dispatch"));
const {
  retryBudgetTransition,
  convergenceTransition,
  blockedFixTransition,
  fixRetryTransition,
  nonCodeFixTransition,
  rulingPreflightTransition,
  rulingOutcomeTransition,
  rulingAppliedTransition,
  rulingDispatchVerificationTransition,
  mergeTransition,
} = require(path.join(REPO_ROOT, "core", "driver-recovery"));

let dirs = [];
function track(cwd) { dirs.push(cwd); return cwd; }
afterEach(() => { dirs.forEach(cleanup); dirs = []; });

function readRun(cwd) {
  const state = JSON.parse(fs.readFileSync(path.join(cwd, "pipeline", "run-state.json"), "utf8"));
  const log = fs.readFileSync(path.join(cwd, "pipeline", "run-log.jsonl"), "utf8")
    .trim()
    .split("\n")
    .map((line) => JSON.parse(line));
  return { state, outcomes: log.map((entry) => entry.outcome) };
}

describe("driver transition result", () => {
  it("applies patches and observability while returning loop control", () => {
    const summary = { halted: false };
    const state = { iterations: 1 };
    const logs = [];
    const events = [];
    const result = transitionResult(TRANSITION_CONTROLS.HALT, {
      summaryPatch: { halted: true, halt_action: "test" },
      statePatch: { last_action: "test" },
      logEvents: [{ outcome: "test-halt" }],
      emittedEvents: [{ type: "halt" }],
    });

    const control = applyTransitionResult(result, {
      summary,
      state,
      logEvent: (entry) => logs.push(entry),
      onEvent: (entry) => events.push(entry),
    });

    assert.equal(control, TRANSITION_CONTROLS.HALT);
    assert.deepEqual(summary, { halted: true, halt_action: "test" });
    assert.deepEqual(state, { iterations: 1, last_action: "test" });
    assert.deepEqual(logs, [{ outcome: "test-halt" }]);
    assert.deepEqual(events, [{ type: "halt" }]);
  });

  it("rejects malformed results before they can alter run state", () => {
    assert.throws(() => transitionResult("spin"), /invalid driver transition control/);
    assert.throws(
      () => transitionResult(TRANSITION_CONTROLS.CONTINUE, { logEvents: {} }),
      /events must be arrays/,
    );
  });
});

describe("driver dispatch handlers", () => {
  const action = { action: "run-stage", stage: "stage-01", name: "requirements" };
  const base = { iteration: 1, stage: "stage-01", name: "requirements", action: "run-stage" };

  it("returns typed ceiling, until, and budget guard halts", () => {
    const common = {
      action,
      base,
      consequenceCeiling: new Set(),
      allowStages: new Set(),
      order: ["requirements", "build"],
      untilIndex: -1,
      until: null,
      budgetUsd: null,
      spent: 0,
      budgetTokens: null,
      tokensUsed: 0,
      tokenBasis: null,
    };
    const ceiling = dispatchGuardTransition({
      ...common,
      consequenceCeiling: new Set(["requirements"]),
    });
    const until = dispatchGuardTransition({
      ...common,
      action: { ...action, name: "build" },
      untilIndex: 0,
      until: "requirements",
    });
    const budget = dispatchGuardTransition({ ...common, budgetUsd: 5, spent: 5 });
    const tokenBudget = dispatchGuardTransition({
      ...common, budgetTokens: 1000, tokensUsed: 1000, tokenBasis: "observed",
    });

    assert.equal(ceiling.summaryPatch.halt_action, "ceiling");
    assert.equal(until.summaryPatch.halt_action, "until");
    assert.equal(budget.summaryPatch.halt_action, "budget");
    assert.equal(tokenBudget.summaryPatch.halt_action, "budget");
    assert.match(tokenBudget.summaryPatch.halt_reason, /token budget/);
    assert.equal(dispatchGuardTransition(common), null);
  });

  it("normalizes array and wrapped dispatch results", () => {
    const direct = normalizeDispatchResults([
      { gatePath: "gate", exitCode: 0 },
      { skipped: true, gatePath: null, exitCode: null },
    ]);
    const wrapped = normalizeDispatchResults({
      results: [{ gatePath: null, exitCode: 1, timedOut: true, stubGate: true }],
    });

    assert.deepEqual(direct, {
      results: [
        { gatePath: "gate", exitCode: 0 },
        { skipped: true, gatePath: null, exitCode: null },
      ],
      timedOut: false,
      wroteGate: true,
      stubGate: false,
      exitCode: 0,
      // Neither result reports hadWrites, so none is treated as true.
      hadWrites: false,
      queueWaitMs: 0,
      // These results carry no outputBytes at all, which is "unknown", not
      // "silent" — an adapter that does not report it must never be read as a
      // host that said nothing.
      noOutput: false,
    });
    assert.equal(wrapped.timedOut, true);
    assert.equal(wrapped.wroteGate, false);
    assert.equal(wrapped.stubGate, true);
    assert.equal(wrapped.exitCode, 1);
  });

  // A host that exits 0 having written nothing at all never ran the turn — a
  // blocked account, an expired credential. That says nothing about the input,
  // so it must not be reported as "input is structurally unworkable": the two
  // conditions want opposite responses (fix the host and re-run unchanged, vs
  // change the input). See issue #490.
  it("reports total silence across every dispatch as noOutput", () => {
    assert.equal(normalizeDispatchResults([
      { gatePath: null, exitCode: 0, outputBytes: 0 },
      { gatePath: null, exitCode: 0, outputBytes: 0 },
    ]).noOutput, true);
  });

  it("does not call it silence when any dispatch spoke", () => {
    // One host speaking means the turn ran somewhere; the silence has to be
    // unanimous to mean "no host ran".
    assert.equal(normalizeDispatchResults([
      { gatePath: null, exitCode: 0, outputBytes: 0 },
      { gatePath: null, exitCode: 0, outputBytes: 512 },
    ]).noOutput, false);
  });

  it("treats an absent outputBytes as unknown, not silent", () => {
    assert.equal(normalizeDispatchResults([
      { gatePath: null, exitCode: 0 },
    ]).noOutput, false);
    assert.equal(normalizeDispatchResults([
      { gatePath: null, exitCode: 0, outputBytes: undefined },
    ]).noOutput, false);
  });

  it("ignores skipped workstreams when judging silence", () => {
    assert.equal(normalizeDispatchResults([
      { skipped: true, gatePath: null, exitCode: null },
      { gatePath: null, exitCode: 0, outputBytes: 0 },
    ]).noOutput, true);
  });

  it("is false when nothing was dispatched at all", () => {
    assert.equal(normalizeDispatchResults([]).noOutput, false);
  });

  it("returns typed ok, transient, and structural dispatch outcomes", () => {
    const common = {
      action,
      base,
      transient: {},
      maxTransientRetries: 1,
      retryDelayMs: 25,
      timedOut: false,
      stubGate: false,
    };
    const ok = dispatchOutcomeTransition({ ...common, wroteGate: true, exitCode: 0 });
    const transient = dispatchOutcomeTransition({ ...common, wroteGate: false, exitCode: 1 });
    const structural = dispatchOutcomeTransition({
      ...common,
      transient: { requirements: 1 },
      wroteGate: false,
      exitCode: 1,
    });

    assert.equal(ok.details.dispatchClass, "ok");
    assert.equal(ok.statePatch.transient.requirements, 0);
    assert.equal(transient.details.retry, true);
    assert.equal(transient.statePatch.transient.requirements, 1);
    assert.equal(transient.logEvents[0].outcome, "transient-retry");
    assert.equal(transient.logEvents[0].delay_ms, 25);
    assert.equal(structural.control, TRANSITION_CONTROLS.HALT);
    assert.equal(structural.summaryPatch.halt_action, "structural-input");
  });

  it("shortens retry delay for immediate non-timeout no-gate failures", () => {
    assert.deepEqual(
      transientDelayPlan({ retryDelayMs: 30000, timedOut: false, stubGate: false, exitCode: 1 }),
      { delayMs: 5000, retryReason: "nonzero-exit-no-gate", backoffClass: "short" },
    );
    assert.deepEqual(
      transientDelayPlan({ retryDelayMs: 30000, timedOut: true, stubGate: false, exitCode: 1 }),
      { delayMs: 30000, retryReason: "timeout", backoffClass: "full" },
    );
  });

  it("builds targeted-fix and scope-gate halt results", () => {
    const targeted = targetedFixNoChangeTransition({
      action: { ...action, name: "build" },
      base,
      evidence: "Dockerfile",
      workstream: "platform",
    });
    const scope = scopeGateTransition({ base, outOfScope: ["README.md"] });

    assert.equal(targeted.summaryPatch.halt_failure_class, "convergence-exhausted");
    assert.equal(targeted.logEvents[0].outcome, "targeted-fix-no-source-change");
    assert.equal(scope.summaryPatch.halt_action, "scope-gate");
    assert.equal(scopeGateTransition({ base, outOfScope: [] }), null);
  });
});

describe("driver recovery handlers", () => {
  const action = {
    action: "fix-and-retry",
    stage: "stage-04",
    name: "build",
    failure_class: "code-defect",
    blockers: ["test failure"],
  };
  const base = { iteration: 1, stage: "stage-04", name: "build", action: "fix-and-retry" };

  it("builds retry-budget and convergence halts", () => {
    assert.equal(retryBudgetTransition({ action, base, attempts: 1, maxRetries: 2 }), null);
    const budget = retryBudgetTransition({ action, base, attempts: 2, maxRetries: 2 });
    const progress = convergenceTransition({
      action, base, kind: "no-progress", evidence: "same blocker", archived: "attempt-2.json",
    });
    const source = convergenceTransition({
      action, base, kind: "no-source-change", evidence: "Dockerfile", archived: null,
    });

    assert.equal(budget.summaryPatch.halt_failure_class, "convergence-exhausted");
    assert.equal(progress.summaryPatch.no_progress_evidence, "same blocker");
    assert.equal(source.summaryPatch.no_source_change_evidence, "Dockerfile");
  });

  it("builds blocked and continuing fix transitions", () => {
    const blocked = blockedFixTransition({ action, base, archived: null });
    const retry = fixRetryTransition({
      action,
      base,
      attempts: 0,
      clearedCount: 1,
      archived: "attempt-1.json",
      target: { workstream: "backend", patch_items: 1 },
      targetedFix: { workstream: "backend" },
      fixRetries: {},
    });
    const nonCode = nonCodeFixTransition({
      action: { ...action, failure_class: "state-corruption", reason: "bad gate" },
      base,
    });

    assert.equal(blocked.summaryPatch.halt_failure_class, "structural-input");
    assert.equal(retry.control, TRANSITION_CONTROLS.CONTINUE);
    assert.equal(retry.statePatch.fixRetries.build, 1);
    assert.equal(retry.logEvents[0].outcome, "fix-retry");
    assert.equal(nonCode.summaryPatch.halt_failure_class, "state-corruption");
  });

  it("verifies applicator build dispatch through a typed transition", () => {
    const latest = {
      class: "code-fix",
      decision: "dispatch backend build workstream",
    };
    const missing = rulingDispatchVerificationTransition({
      base, latest, buildGateUpdated: false,
    });
    const updated = rulingDispatchVerificationTransition({
      base, latest, buildGateUpdated: true,
    });
    const unrelated = rulingDispatchVerificationTransition({
      base,
      latest: { class: "formatting-only", decision: "fix gate shape" },
      buildGateUpdated: false,
    });

    assert.equal(missing.control, TRANSITION_CONTROLS.HALT);
    assert.equal(missing.summaryPatch.halt_failure_class, "applicator-did-not-dispatch-build");
    assert.equal(missing.logEvents[0].outcome, "applicator-did-not-dispatch-build");
    assert.equal(updated.control, TRANSITION_CONTROLS.CONTINUE);
    assert.equal(updated.details.resetAutoRule, true);
    assert.equal(unrelated, null);
  });

  it("builds ruling preflight and Principal outcome transitions", () => {
    const rulingAction = {
      action: "resolve-escalation",
      stage: "stage-01",
      name: "requirements",
      failure_class: "judgment-gate",
      reason: "decision needed",
    };
    const noGrant = rulingPreflightTransition({
      action: rulingAction, base, grantCount: 0, hardStop: false, alreadyTried: false,
    });
    const cannotDecide = rulingOutcomeTransition({
      base,
      rulingResult: { exitCode: 0 },
      latest: { type: "cannot-decide", reason_class: "missing-context", question: "Which API?" },
      grantSet: new Set(["formatting-only"]),
    });
    const ungranted = rulingOutcomeTransition({
      base,
      rulingResult: { exitCode: 0 },
      latest: { type: "ruling", class: "architecture" },
      grantSet: new Set(["formatting-only"]),
    });

    assert.equal(noGrant.summaryPatch.halt_failure_class, "judgment-gate");
    assert.equal(cannotDecide.summaryPatch.halt_failure_class, "cannot-decide");
    assert.equal(ungranted.logEvents[0].outcome, "auto-rule-ungranted");
    assert.equal(rulingPreflightTransition({
      action: rulingAction, base, grantCount: 1, hardStop: false, alreadyTried: false,
    }), null);
  });

  it("builds applied-ruling and merge transitions", () => {
    const applied = rulingAppliedTransition({
      base,
      applyResult: { exitCode: 0 },
      latest: { class: "formatting-only", decision: "apply" },
    });
    const applyFailed = rulingAppliedTransition({
      base,
      applyResult: { exitCode: 2 },
      latest: { class: "formatting-only", decision: "apply" },
    });
    const merged = mergeTransition({ base, mergeResult: { merged: true } });
    const mergeFailed = mergeTransition({
      base, mergeResult: { merged: false, reason: "missing frontend gate" },
    });

    assert.equal(applied.details.authority, "auto-rule:formatting-only");
    assert.equal(applyFailed.summaryPatch.halt_action, "resolve-escalation");
    assert.equal(merged.control, TRANSITION_CONTROLS.CONTINUE);
    assert.equal(mergeFailed.summaryPatch.halt_action, "merge-failed");
  });
});

describe("driver transition characterization", () => {
  it("pins successful dispatch and completion state/log outcomes", async () => {
    const cwd = track(makeTargetProject());
    const actions = [
      { action: "run-stage", stage: "stage-01", name: "requirements" },
      { action: "pipeline-complete", reason: "done" },
    ];
    let index = 0;

    const summary = await run({
      cwd,
      budgetUsd: 10,
      next: () => actions[index++],
      runStageHeadless: async () => [{ role: "pm", gatePath: "gate", exitCode: 0 }],
      stallProbe: () => () => {},
    });
    const persisted = readRun(cwd);

    assert.deepEqual({
      completed: summary.completed,
      halted: summary.halted,
      stages_advanced: summary.stages_advanced,
      iterations: summary.iterations,
    }, {
      completed: true,
      halted: false,
      stages_advanced: ["requirements"],
      iterations: 2,
    });
    assert.deepEqual(persisted.outcomes, [
      "run-plan", "run-start", "heartbeat", "dispatch-started", "dispatch-observation", "dispatched", "heartbeat", "complete",
    ]);
    assert.equal(persisted.state.last_action, "pipeline-complete");
    assert.equal(persisted.state.retries.requirements, 1);
    assert.equal(persisted.state.transient.requirements, 0);
  });

  it("pins transient retry state/log outcomes", async () => {
    const cwd = track(makeTargetProject());
    const actions = [
      { action: "run-stage", stage: "stage-01", name: "requirements" },
      { action: "run-stage", stage: "stage-01", name: "requirements" },
      { action: "pipeline-complete", reason: "done" },
    ];
    const dispatches = [
      [{ role: "pm", gatePath: null, exitCode: 1 }],
      [{ role: "pm", gatePath: "gate", exitCode: 0 }],
    ];
    let actionIndex = 0;
    let dispatchIndex = 0;

    const summary = await run({
      cwd,
      budgetUsd: 10,
      retryDelayMs: 0,
      sleep: () => Promise.resolve(),
      next: () => actions[actionIndex++],
      runStageHeadless: async () => dispatches[dispatchIndex++],
      stallProbe: () => () => {},
    });
    const persisted = readRun(cwd);

    assert.equal(summary.completed, true);
    assert.deepEqual(persisted.outcomes, [
      "run-plan", "run-start",
      "heartbeat", "dispatch-started", "dispatch-observation", "dispatched", "transient-retry",
      "heartbeat", "dispatch-started", "dispatch-observation", "dispatched",
      "heartbeat", "complete",
    ]);
    assert.equal(persisted.state.retries.requirements, 2);
    assert.equal(persisted.state.transient.requirements, 0);
  });

  it("pins fix, ruling, and merge terminal traces", async () => {
    const cases = [
      {
        action: {
          action: "fix-and-retry",
          stage: "stage-01",
          name: "requirements",
          failure_class: "state-corruption",
          reason: "gate unreadable",
          blockers: ["invalid JSON"],
        },
        haltAction: "fix-and-retry",
        failureClass: "state-corruption",
        terminalOutcome: "halt",
      },
      {
        action: {
          action: "resolve-escalation",
          stage: "stage-01",
          name: "requirements",
          failure_class: "judgment-gate",
          reason: "human judgment required",
        },
        haltAction: "resolve-escalation",
        failureClass: "judgment-gate",
        terminalOutcome: "halt",
      },
      {
        action: { action: "merge", stage: "stage-04", name: "build" },
        mergeWorkstreamGates: () => ({ merged: false, reason: "missing frontend gate" }),
        haltAction: "merge-failed",
        failureClass: null,
        terminalOutcome: "merge-failed",
      },
    ];

    for (const scenario of cases) {
      const cwd = track(makeTargetProject());
      const summary = await run({
        cwd,
        budgetUsd: 10,
        next: () => scenario.action,
        mergeWorkstreamGates: scenario.mergeWorkstreamGates,
      });
      const persisted = readRun(cwd);

      assert.equal(summary.halted, true);
      assert.equal(summary.halt_action, scenario.haltAction);
      assert.equal(summary.halt_failure_class, scenario.failureClass);
      const expected = scenario.action.action === "merge"
        ? ["run-plan", "run-start", "heartbeat", "merge-started", "merge-finished", scenario.terminalOutcome]
        : ["run-plan", "run-start", "heartbeat", scenario.terminalOutcome];
      assert.deepEqual(persisted.outcomes, expected);
      assert.equal(persisted.state.last_action, scenario.action.action);
    }
  });
});

// The operator-facing half of issue #490: what the halt actually says.
describe("dispatchOutcomeTransition: the silent-host halt names the host", () => {
  const silentHalt = () => dispatchOutcomeTransition({
    action: { name: "requirements" },
    base: { iteration: 1, stage: "stage-01", name: "requirements" },
    transient: {}, maxTransientRetries: 2, retryDelayMs: 0,
    wroteGate: false, exitCode: 0, timedOut: false, stubGate: false,
    noOutput: true,
  });

  it("halts with its own action rather than structural-input", () => {
    const t = silentHalt();
    assert.equal(t.summaryPatch.halt_action, "host-silent");
    assert.equal(t.summaryPatch.halt_failure_class, "host-silent");
  });

  it("points at the host, not the input", () => {
    const reason = silentHalt().summaryPatch.halt_reason;
    assert.match(reason, /written no output at all/);
    assert.match(reason, /quota, credentials, and connectivity/);
    assert.match(reason, /re-run unchanged/);
    assert.doesNotMatch(reason, /structurally unworkable/);
  });

  it("logs a distinguishable outcome", () => {
    const t = silentHalt();
    assert.equal(t.logEvents[0].outcome, "host-silent-halt");
    assert.equal(t.emittedEvents[0].type, "host-silent");
  });

  it("a clean exit WITH output still halts as structural-input", () => {
    const t = dispatchOutcomeTransition({
      action: { name: "requirements" },
      base: { iteration: 1, stage: "stage-01", name: "requirements" },
      transient: {}, maxTransientRetries: 2, retryDelayMs: 0,
      wroteGate: false, exitCode: 0, timedOut: false, stubGate: false,
      noOutput: false,
    });
    assert.equal(t.summaryPatch.halt_action, "structural-input");
    assert.match(t.summaryPatch.halt_reason, /structurally unworkable/);
  });
});
