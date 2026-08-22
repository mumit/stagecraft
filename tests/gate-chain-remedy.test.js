// The retry-ownership halt tells an operator how to fix file ownership.
// Following the obvious reading of the old advice broke their audit chain.
//
// file_ownership lives inside pipeline/gates/stage-02.json, and stage gates are
// chained: each records a hash of its predecessor (core/gates/chain.js, "the EU
// AI Act / SOC 2 ask"). Editing that gate changes its hash, so the next gate's
// recorded prev_hash stops matching. Nothing checks the chain during a run --
// only `devteam verify-chain`, `devteam verify`, and evidence attestation do --
// so the break surfaces much later, at export, with no memory of the cause.

const { describe, it, afterEach } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { makeTargetProject, seedGate, cleanup } = require("./_helpers");
const { stampAll, verifyChain } = require("../core/gates/chain");
const { retryOwnershipTransition } = require("../core/driver-recovery");

let dirs = [];
const track = (cwd) => { dirs.push(cwd); return cwd; };
afterEach(() => { dirs.forEach(cleanup); dirs = []; });

function chained() {
  const cwd = track(makeTargetProject());
  seedGate(cwd, "stage-01", { stage: "stage-01", status: "PASS", track: "full" });
  seedGate(cwd, "stage-02", {
    stage: "stage-02", status: "PASS", track: "full",
    file_ownership: { "src/a.js": "backend" },
  });
  seedGate(cwd, "stage-04", { stage: "stage-04", status: "PASS", track: "full" });
  const gatesDir = path.join(cwd, "pipeline", "gates");
  stampAll(gatesDir, "full");
  return { cwd, gatesDir };
}

describe("editing a stage gate by hand breaks the chain", () => {
  it("a file_ownership edit is detected and located", () => {
    const { gatesDir } = chained();
    assert.equal(verifyChain(gatesDir, "full").ok, true, "the fixture starts intact");

    const file = path.join(gatesDir, "stage-02.json");
    const gate = JSON.parse(fs.readFileSync(file, "utf8"));
    gate.file_ownership["src/b.js"] = "frontend";
    fs.writeFileSync(file, JSON.stringify(gate, null, 2));

    const after = verifyChain(gatesDir, "full");
    assert.equal(after.ok, false);
    assert.equal(after.breaks.length, 1);
    assert.equal(after.breaks[0].stage, "stage-04");
    assert.equal(after.breaks[0].prev_stage, "stage-02");
    assert.notEqual(after.breaks[0].recorded, after.breaks[0].recomputed);
  });

  it("re-stamping repairs it, which is what the halt now points at", () => {
    const { gatesDir } = chained();
    const file = path.join(gatesDir, "stage-02.json");
    const gate = JSON.parse(fs.readFileSync(file, "utf8"));
    gate.file_ownership["src/b.js"] = "frontend";
    fs.writeFileSync(file, JSON.stringify(gate, null, 2));
    assert.equal(verifyChain(gatesDir, "full").ok, false);

    stampAll(gatesDir, "full");
    assert.equal(verifyChain(gatesDir, "full").ok, true);
  });
});

describe("the retry-ownership halt names a safe remedy", () => {
  const transition = () => retryOwnershipTransition({
    action: { name: "build", blockers: [] },
    base: { iteration: 1, stage: "stage-04", name: "build" },
    archived: null,
    ownership: { target_paths: ["src/a.js", "web/b.js"], candidate_roles: ["backend"] },
  });

  it("keeps the diagnosis", () => {
    const reason = transition().summaryPatch.halt_reason;
    assert.match(reason, /no candidate build role can write every target/);
    assert.match(reason, /src\/a\.js, web\/b\.js/);
    assert.match(reason, /no host was invoked/);
  });

  it("points at re-running design rather than at correcting the gate", () => {
    const reason = transition().summaryPatch.halt_reason;
    assert.match(reason, /re-run design so stage-02 file_ownership covers them/);
    assert.doesNotMatch(reason, /correct stage-02 file_ownership/,
      "the old advice read as 'open the gate and edit it'");
  });

  it("says what a hand edit costs, and how to repair it", () => {
    const reason = transition().summaryPatch.halt_reason;
    assert.match(reason, /breaks the gate chain/);
    assert.match(reason, /devteam stamp-chain/);
  });
});
