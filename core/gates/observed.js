"use strict";

// What a gate says a dispatch actually cost and ran on.
//
// A gate carries two classes of claim. The model writes `cost_usd` and `model`
// itself; the orchestrator writes `_orchestrator_observed` from what the host
// reported, plus `model_requested` from what routing asked for before the
// dispatch. The orchestrator's fields are evidence; the model's are assertions.
//
// This lives in one place because three readers wanted it and each had its own
// answer: core/driver.js's run cost total (correct), its dispatch-observation
// writer (model-asserted), and core/evidence/analyzer.js's gate-snapshot
// routing fallback (model-asserted). The 2026-08-21 Phase 41 re-review found
// the last two still reporting `cost_obs: 0` and `model=unknown` for dispatches
// whose cost the orchestrator had observed — the same drift the framework-owned
// path list produced before it was centralized (core/paths.js).

const { nonNegativeNumber } = require("../numbers");

// Strongest evidence first: a cost the host reported, then one derived from
// host-observed tokens and core/pricing.js, then the model's own claim.
// Returns null when a gate carries none — absent is not zero.
function observedCostForGate(gate) {
  const observed = gate && gate._orchestrator_observed;
  const reported = nonNegativeNumber(observed && observed.cost_usd);
  if (reported !== null) return { cost: reported, source: "observed" };
  const derived = nonNegativeNumber(observed && observed.cost_usd_derived);
  if (derived !== null) return { cost: derived, source: "derived" };
  const asserted = nonNegativeNumber(gate && gate.cost_usd);
  if (asserted !== null) return { cost: asserted, source: "asserted" };
  return null;
}

// Strongest evidence first: what the host reported serving, then what routing
// asked for (phase-32 item 32.3 stamps model_requested before dispatch), then
// the model's own claim. Routing evidence keyed on "unknown" is not routing
// evidence, and every pre-fix record in a real corpus carried exactly that.
function observedModelForGate(gate) {
  if (!gate || typeof gate !== "object") return null;
  const observed = gate._orchestrator_observed;
  const fromHost = observed && typeof observed.model_observed === "string" && observed.model_observed
    ? observed.model_observed : null;
  if (fromHost) return fromHost;
  if (typeof gate.model_requested === "string" && gate.model_requested) return gate.model_requested;
  return typeof gate.model === "string" && gate.model ? gate.model : null;
}

module.exports = { observedCostForGate, observedModelForGate };
