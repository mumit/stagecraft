// core/driver-safety.js — the effective safety policy for a run, extracted
// from run()'s prologue (audit P2-2 decomposition, slice 2).
//
// Characterization tests pinning the seam. The split matters: resolveRunSafety
// decides *what* to warn about and returns it, emitSafetyWarnings decides
// where it goes. That is what lets the policy be tested without capturing
// process output.

const { describe, it } = require("node:test");
const assert = require("node:assert/strict");
const path = require("node:path");

const REPO_ROOT = path.resolve(__dirname, "..");
const { resolveRunSafety, emitSafetyWarnings, LEGACY_STATE_WARNING, NO_CAP_WARNING } =
  require(path.join(REPO_ROOT, "core", "driver-safety"));

describe("resolveRunSafety: caps", () => {
  it("carries explicit caps through to the policy", () => {
    const r = resolveRunSafety({ budgetUsd: 10, budgetTokens: 500000 });
    assert.equal(r.budgetUsd, 10);
    assert.equal(r.budgetTokens, 500000);
    assert.equal(r.policy.budget_usd, 10);
    assert.equal(r.policy.budget_tokens, 500000);
  });

  it("reports budgetUsd/budgetTokens straight off the resolved policy", () => {
    // The caller reads these instead of re-deriving them, so they must not
    // drift from policy.* — that pairing is the whole point of returning both.
    const r = resolveRunSafety({ budgetUsd: 3 });
    assert.equal(r.budgetUsd, r.policy.budget_usd);
    assert.equal(r.budgetTokens, r.policy.budget_tokens);
  });
});

describe("resolveRunSafety: warnings", () => {
  it("warns when a run has no cap of either kind", () => {
    // Legal and sometimes intended, so it warns rather than blocking — but an
    // uncapped autonomous run is the most expensive way to be surprised.
    assert.deepEqual(resolveRunSafety({}).warnings, [NO_CAP_WARNING]);
  });

  it("stays silent when either cap is set", () => {
    assert.deepEqual(resolveRunSafety({ budgetUsd: 5 }).warnings, []);
    assert.deepEqual(resolveRunSafety({ budgetTokens: 1000 }).warnings, []);
  });

  it("treats a zero cap as a cap, not as absent", () => {
    assert.deepEqual(resolveRunSafety({ budgetUsd: 0 }).warnings, []);
  });

  it("warns when a resumed run's state predates persisted safety policy", () => {
    const r = resolveRunSafety({ resume: true, state: { started_at: "2026-01-01T00:00:00Z" }, budgetUsd: 5 });
    assert.ok(r.warnings.includes(LEGACY_STATE_WARNING),
      `expected the legacy-state warning, got ${JSON.stringify(r.warnings)}`);
  });

  it("can report both warnings at once", () => {
    const r = resolveRunSafety({ resume: true, state: { started_at: "2026-01-01T00:00:00Z" } });
    assert.deepEqual(r.warnings, [LEGACY_STATE_WARNING, NO_CAP_WARNING]);
  });
});

describe("emitSafetyWarnings", () => {
  it("writes each warning in order through the injected sink", () => {
    const written = [];
    emitSafetyWarnings(["a", "b"], (text) => written.push(text));
    assert.deepEqual(written, ["a", "b"]);
  });

  it("is a no-op for an empty or missing list", () => {
    const written = [];
    emitSafetyWarnings([], (t) => written.push(t));
    emitSafetyWarnings(undefined, (t) => written.push(t));
    assert.deepEqual(written, []);
  });
});
