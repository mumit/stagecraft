// core/numbers.js — one home for the telemetry-number predicate that
// core/driver.js, core/corpus.js, and core/gates/observed.js each used to
// carry privately.

const { describe, it } = require("node:test");
const assert = require("node:assert/strict");
const { nonNegativeNumber } = require("../core/numbers");

describe("nonNegativeNumber", () => {
  it("passes finite non-negative numbers through, zero included", () => {
    assert.equal(nonNegativeNumber(0), 0);
    assert.equal(nonNegativeNumber(1), 1);
    assert.equal(nonNegativeNumber(0.5), 0.5);
    assert.equal(nonNegativeNumber(1e12), 1e12);
  });

  it("rejects negatives", () => {
    assert.equal(nonNegativeNumber(-1), null);
    assert.equal(nonNegativeNumber(-0.001), null);
  });

  it("rejects non-finite numbers", () => {
    assert.equal(nonNegativeNumber(NaN), null);
    assert.equal(nonNegativeNumber(Infinity), null);
    assert.equal(nonNegativeNumber(-Infinity), null);
  });

  it("rejects anything that is not a number, including numeric strings", () => {
    // Host CLIs and models emit JSON; a quoted number must not be trusted as
    // one, or a budget would silently count a value nobody validated.
    for (const v of ["1", "", null, undefined, {}, [], true, false, 1n]) {
      assert.equal(nonNegativeNumber(v), null, `${String(v)} must be rejected`);
    }
  });

  it("returns null rather than 0 for a missing value", () => {
    // The distinction budgets depend on: absent means "no coverage", not "free".
    assert.notEqual(nonNegativeNumber(undefined), 0);
    assert.equal(nonNegativeNumber(undefined), null);
  });

  it("treats -0 as zero", () => {
    assert.equal(Object.is(nonNegativeNumber(-0), -0), true);
    assert.equal(nonNegativeNumber(-0) >= 0, true);
  });
});
