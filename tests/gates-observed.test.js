// core/gates/observed.js — one answer to "what did this dispatch cost, and
// what did it run on", shared by every reader of a gate.
//
// Three readers wanted this and two had drifted to the model-asserted fields:
// the run's cost total was right, while the durable dispatch-observation writer
// and the evidence gate-snapshot fallback both reported cost_obs 0 and
// model=unknown for dispatches the orchestrator had actually observed. The
// 2026-08-21 Phase 41 re-review found that still blocking D5.

const { describe, it } = require("node:test");
const assert = require("node:assert/strict");
const path = require("node:path");

const REPO_ROOT = path.resolve(__dirname, "..");
const { observedCostForGate, observedModelForGate } =
  require(path.join(REPO_ROOT, "core", "gates", "observed"));

describe("observedCostForGate: strongest evidence first", () => {
  it("prefers a cost the host reported", () => {
    const entry = observedCostForGate({
      cost_usd: 99,
      _orchestrator_observed: { cost_usd: 0.53, cost_usd_derived: 7 },
    });
    assert.deepEqual(entry, { cost: 0.53, source: "observed" });
  });

  it("falls back to a token-derived cost before the model's claim", () => {
    const entry = observedCostForGate({
      cost_usd: 99,
      _orchestrator_observed: { cost_usd: null, cost_usd_derived: 0.75 },
    });
    assert.deepEqual(entry, { cost: 0.75, source: "derived" });
  });

  it("uses the model's claim only when nothing was observed", () => {
    assert.deepEqual(observedCostForGate({ cost_usd: 2 }), { cost: 2, source: "asserted" });
  });

  it("returns null rather than zero when a gate carries no cost", () => {
    // Absent is not free. A zero here would inflate cost coverage with
    // dispatches nobody priced.
    assert.equal(observedCostForGate({}), null);
    assert.equal(observedCostForGate(null), null);
    assert.equal(observedCostForGate({ cost_usd: -1 }), null);
    assert.equal(observedCostForGate({ cost_usd: "free" }), null);
  });

  it("treats a reported zero as a real observation", () => {
    assert.deepEqual(observedCostForGate({ _orchestrator_observed: { cost_usd: 0 } }),
      { cost: 0, source: "observed" });
  });
});

describe("observedModelForGate: strongest evidence first", () => {
  it("prefers what the host reported serving", () => {
    assert.equal(observedModelForGate({
      model: "asserted", model_requested: "requested",
      _orchestrator_observed: { model_observed: "claude-opus-5" },
    }), "claude-opus-5");
  });

  it("falls back to what routing asked for", () => {
    // The case that matters on codex, whose stream reports no model at all.
    assert.equal(observedModelForGate({
      model: "asserted", model_requested: "claude-opus-5",
      _orchestrator_observed: { model_observed: null },
    }), "claude-opus-5");
  });

  it("uses the model's own claim last", () => {
    assert.equal(observedModelForGate({ model: "self-reported" }), "self-reported");
  });

  it("returns null when a gate names no model", () => {
    // Callers render this as "unknown"; routing evidence keyed on "unknown" is
    // not routing evidence.
    assert.equal(observedModelForGate({}), null);
    assert.equal(observedModelForGate(null), null);
    assert.equal(observedModelForGate({ model: "" }), null);
  });
});

describe("the evidence path reports a cost the orchestrator observed", () => {
  const { analyzeEvidence } = require(path.join(REPO_ROOT, "core", "evidence", "analyzer"));

  // Shaped like a real post-fix gate: cost only in _orchestrator_observed,
  // model only in model_requested, nothing model-asserted.
  const gate = {
    source: "current",
    source_id: "stage-04.backend.json",
    gate: {
      stage: "stage-04", workstream: "backend", host: "claude-code", status: "PASS",
      model_requested: "claude-opus-5",
      _orchestrator_observed: { cost_usd: 0.53, model_observed: null },
    },
  };

  it("counts it through the gate-snapshot fallback", () => {
    const report = analyzeEvidence({ events: [], gates: [gate], quality: {} });
    assert.deepEqual(report.routing, [{
      role: "backend", host: "claude-code", model: "claude-opus-5",
      gate_observations: 1, independent_observations: 1, pass: 1, warn: 0, fail: 0, escalate: 0,
      cost_observations: 1, total_cost_usd: 0.53,
      duration_observations: 0, total_duration_ms: 0,
      prompt_observations: 0, total_prompt_bytes: 0,
    }]);
  });

  it("counts it through the durable dispatch-observation path", () => {
    const report = analyzeEvidence({
      events: [
        { outcome: "run-start", intent: "feature", logical_run_id: "T0" },
        {
          outcome: "dispatch-observation", stage: "stage-04", role: "backend",
          host: "claude-code", model: "claude-opus-5", status: "PASS",
          cost_usd: 0.53, cost_basis: "observed",
        },
        { outcome: "complete" },
      ],
      gates: [], quality: {},
    });
    assert.equal(report.routing[0].cost_observations, 1);
    assert.equal(report.routing[0].model, "claude-opus-5");
    assert.equal(report.quality.cost_coverage_dispatches ?? report.routing[0].cost_observations, 1);
  });
});
