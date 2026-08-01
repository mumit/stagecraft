// Tests for the tamper-evident gate chain (C6).

const { describe, it, afterEach } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { REPO_ROOT, makeTargetProject, seedGate, cleanup } = require("./_helpers");
const {
  stampChain,
  verifyChain,
  stampAll,
  canonicalGateHash,
  canonicalGateMac,
  MAC_ALGO,
} = require(path.join(REPO_ROOT, "core", "gates", "chain"));

let _dirs = [];
function track(cwd) { _dirs.push(cwd); return cwd; }
afterEach(() => { _dirs.forEach(cleanup); _dirs = []; });

function gatesDirOf(cwd) { return path.join(cwd, "pipeline", "gates"); }

// Seed the first three single-role full-track stages as PASS and stamp them.
function seedAndStamp(cwd) {
  seedGate(cwd, "stage-01", { status: "PASS" });
  seedGate(cwd, "stage-02", { status: "PASS" });
  seedGate(cwd, "stage-03", { status: "PASS" });
  stampAll(gatesDirOf(cwd), "full", { secret: null });
}

describe("gate chain: stamp", () => {
  it("genesis stage gets a null prev_hash; later stages commit to their predecessor", () => {
    const cwd = track(makeTargetProject());
    seedAndStamp(cwd);
    const g1 = JSON.parse(fs.readFileSync(path.join(gatesDirOf(cwd), "stage-01.json"), "utf8"));
    const g2 = JSON.parse(fs.readFileSync(path.join(gatesDirOf(cwd), "stage-02.json"), "utf8"));
    assert.equal(g1.chain.prev_hash, null);
    assert.equal(g1.chain.prev_stage, null);
    assert.equal(g2.chain.prev_stage, "stage-01");
    assert.equal(g2.chain.prev_hash, canonicalGateHash(g1));
  });

  it("hashing is canonical — key order does not matter", () => {
    const a = { status: "PASS", stage: "stage-01", blockers: [] };
    const b = { blockers: [], stage: "stage-01", status: "PASS" };
    assert.equal(canonicalGateHash(a), canonicalGateHash(b));
  });

  it("signs the complete canonical gate when a secret is supplied", () => {
    const cwd = track(makeTargetProject());
    seedGate(cwd, "stage-01", { status: "PASS" });
    const result = stampChain(gatesDirOf(cwd), "requirements", "full", { secret: "test-secret" });
    const gate = JSON.parse(fs.readFileSync(path.join(gatesDirOf(cwd), "stage-01.json"), "utf8"));
    assert.equal(result.signed, true);
    assert.equal(gate.chain.mac_algo, MAC_ALGO);
    assert.equal(gate.chain.mac, canonicalGateMac(gate, "test-secret"));
  });

  it("MAC canonicalization is independent of key order", () => {
    const a = { stage: "stage-01", status: "PASS", chain: { algo: "sha256-canonical-json", mac_algo: MAC_ALGO } };
    const b = { chain: { mac_algo: MAC_ALGO, algo: "sha256-canonical-json" }, status: "PASS", stage: "stage-01" };
    assert.equal(canonicalGateMac(a, "test-secret"), canonicalGateMac(b, "test-secret"));
  });
});

describe("gate chain: verify", () => {
  it("an intact chain verifies", () => {
    const cwd = track(makeTargetProject());
    seedAndStamp(cwd);
    const r = verifyChain(gatesDirOf(cwd), "full");
    assert.equal(r.ok, true);
    assert.equal(r.checked, 3);
    assert.deepEqual(r.breaks, []);
  });

  it("tampering with an earlier gate is detected and located", () => {
    const cwd = track(makeTargetProject());
    seedAndStamp(cwd);
    // Mutate stage-01 AFTER the chain was stamped (simulate tampering).
    const p1 = path.join(gatesDirOf(cwd), "stage-01.json");
    const g1 = JSON.parse(fs.readFileSync(p1, "utf8"));
    g1.status = "FAIL"; // someone rewrites history
    fs.writeFileSync(p1, JSON.stringify(g1, null, 2) + "\n");
    const r = verifyChain(gatesDirOf(cwd), "full");
    assert.equal(r.ok, false);
    // stage-02 committed to the OLD stage-01 hash → its check breaks.
    assert.ok(r.breaks.some((b) => b.stage === "stage-02" && b.prev_stage === "stage-01"));
  });

  it("flags stamped-but-unstamped gates rather than silently passing", () => {
    const cwd = track(makeTargetProject());
    seedGate(cwd, "stage-01", { status: "PASS" });
    seedGate(cwd, "stage-02", { status: "PASS" }); // never stamped
    stampChain(gatesDirOf(cwd), "requirements", "full", { secret: null }); // stamp only stage-01
    const r = verifyChain(gatesDirOf(cwd), "full");
    assert.deepEqual(r.unstamped, ["stage-02"]);
  });

  it("surfaces resolved_by authority provenance (PR-D2)", () => {
    const cwd = track(makeTargetProject());
    seedGate(cwd, "stage-01", { status: "PASS" });
    seedGate(cwd, "stage-02", {
      status: "PASS",
      resolved_by: { authority: "auto-rule:formatting-only", grant_class: "formatting-only", ruling: "accept defaults", ts: "2026-06-10T00:00:00Z" },
    });
    stampAll(gatesDirOf(cwd), "full", { secret: null });
    const r = verifyChain(gatesDirOf(cwd), "full");
    assert.equal(r.ok, true);
    assert.ok(r.resolved.some((x) => x.stage === "stage-02" && x.authority === "auto-rule:formatting-only"));
  });

  it("re-stamping after an edit restores the chain (deliberate re-run path)", () => {
    const cwd = track(makeTargetProject());
    seedAndStamp(cwd);
    const p1 = path.join(gatesDirOf(cwd), "stage-01.json");
    const g1 = JSON.parse(fs.readFileSync(p1, "utf8"));
    g1.status = "WARN";
    fs.writeFileSync(p1, JSON.stringify(g1, null, 2) + "\n");
    assert.equal(verifyChain(gatesDirOf(cwd), "full").ok, false);
    stampAll(gatesDirOf(cwd), "full", { secret: null }); // deliberate re-stamp
    assert.equal(verifyChain(gatesDirOf(cwd), "full").ok, true);
  });

  it("verifies every signed gate with the correct secret", () => {
    const cwd = track(makeTargetProject());
    seedGate(cwd, "stage-01", { status: "PASS" });
    seedGate(cwd, "stage-02", { status: "PASS" });
    stampAll(gatesDirOf(cwd), "full", { secret: "test-secret" });
    const r = verifyChain(gatesDirOf(cwd), "full", { secret: "test-secret", requireSigned: true });
    assert.equal(r.ok, true);
    assert.deepEqual(r.unsigned, []);
    assert.deepEqual(r.invalid_macs, []);
  });

  it("rejects a signed gate when content changes or the secret is wrong", () => {
    const cwd = track(makeTargetProject());
    seedGate(cwd, "stage-01", { status: "PASS" });
    stampAll(gatesDirOf(cwd), "full", { secret: "test-secret" });
    const gatePath = path.join(gatesDirOf(cwd), "stage-01.json");
    const gate = JSON.parse(fs.readFileSync(gatePath, "utf8"));
    gate.status = "WARN";
    fs.writeFileSync(gatePath, JSON.stringify(gate, null, 2) + "\n");
    assert.deepEqual(verifyChain(gatesDirOf(cwd), "full", { secret: "test-secret" }).invalid_macs, [
      { stage: "stage-01", reason: "mac-mismatch" },
    ]);
    assert.equal(verifyChain(gatesDirOf(cwd), "full", { secret: "wrong-secret" }).ok, false);
  });

  it("warns when signed gates cannot be verified, and signed-only mode fails", () => {
    const cwd = track(makeTargetProject());
    seedGate(cwd, "stage-01", { status: "PASS" });
    stampAll(gatesDirOf(cwd), "full", { secret: "test-secret" });
    const compatible = verifyChain(gatesDirOf(cwd), "full", { secret: null });
    assert.equal(compatible.ok, true);
    assert.deepEqual(compatible.unverified_signatures, ["stage-01"]);
    assert.equal(verifyChain(gatesDirOf(cwd), "full", { secret: null, requireSigned: true }).ok, false);
  });

  it("rejects malformed MACs even when the signing secret is unavailable", () => {
    const cwd = track(makeTargetProject());
    seedGate(cwd, "stage-01", { status: "PASS" });
    stampAll(gatesDirOf(cwd), "full", { secret: "test-secret" });
    const gatePath = path.join(gatesDirOf(cwd), "stage-01.json");
    const gate = JSON.parse(fs.readFileSync(gatePath, "utf8"));
    gate.chain.mac = "hmac-sha256:not-a-mac";
    fs.writeFileSync(gatePath, JSON.stringify(gate, null, 2) + "\n");
    const r = verifyChain(gatesDirOf(cwd), "full", { secret: null });
    assert.equal(r.ok, false);
    assert.deepEqual(r.invalid_macs, [{ stage: "stage-01", reason: "malformed-mac" }]);
    assert.deepEqual(r.unverified_signatures, []);
  });

  it("signed-only mode rejects unsigned history and hash-only re-stamping", () => {
    const cwd = track(makeTargetProject());
    seedGate(cwd, "stage-01", { status: "PASS" });
    seedGate(cwd, "stage-02", { status: "PASS" });
    stampAll(gatesDirOf(cwd), "full", { secret: "test-secret" });

    const gatePath = path.join(gatesDirOf(cwd), "stage-01.json");
    const gate = JSON.parse(fs.readFileSync(gatePath, "utf8"));
    gate.status = "WARN";
    fs.writeFileSync(gatePath, JSON.stringify(gate, null, 2) + "\n");
    for (const stage of ["stage-01", "stage-02"]) {
      const stagePath = path.join(gatesDirOf(cwd), `${stage}.json`);
      const stagedGate = JSON.parse(fs.readFileSync(stagePath, "utf8"));
      delete stagedGate.chain.mac;
      delete stagedGate.chain.mac_algo;
      fs.writeFileSync(stagePath, JSON.stringify(stagedGate, null, 2) + "\n");
    }
    stampAll(gatesDirOf(cwd), "full", { secret: null });

    const r = verifyChain(gatesDirOf(cwd), "full", { secret: "test-secret", requireSigned: true });
    assert.equal(r.ok, false);
    assert.deepEqual(r.unsigned, ["stage-01", "stage-02"]);
  });

  it("refuses to overwrite an authenticated gate when the secret is absent", () => {
    const cwd = track(makeTargetProject());
    seedGate(cwd, "stage-01", { status: "PASS" });
    stampAll(gatesDirOf(cwd), "full", { secret: "test-secret" });
    const before = fs.readFileSync(path.join(gatesDirOf(cwd), "stage-01.json"), "utf8");
    const r = stampAll(gatesDirOf(cwd), "full", { secret: null });
    assert.deepEqual(r.stamped, []);
    assert.match(r.failed[0].reason, /refusing to overwrite/);
    assert.equal(fs.readFileSync(path.join(gatesDirOf(cwd), "stage-01.json"), "utf8"), before);
  });
});

// 29.1: the `loop` track lists stages in a NON-numeric order — qa (stage-06)
// runs before peer-review (stage-05), the reverse of every other track.
// predecessorGate() walks STAGES_BY_TRACK in declared order, not by stage
// number, so the chain must still link correctly on this track.
describe("gate chain: loop track (non-numeric stage order)", () => {
  it("stamps and verifies the inverted stage-06 -> stage-05 predecessor link", () => {
    const cwd = track(makeTargetProject());
    seedGate(cwd, "stage-01", { status: "PASS", track: "loop" });
    seedGate(cwd, "stage-04", { status: "PASS", track: "loop" });
    seedGate(cwd, "stage-06", { status: "PASS", track: "loop" });
    seedGate(cwd, "stage-05", { status: "PASS", track: "loop" });
    stampAll(gatesDirOf(cwd), "loop", { secret: null });

    const g06 = JSON.parse(fs.readFileSync(path.join(gatesDirOf(cwd), "stage-06.json"), "utf8"));
    const g05 = JSON.parse(fs.readFileSync(path.join(gatesDirOf(cwd), "stage-05.json"), "utf8"));
    assert.equal(g06.chain.prev_stage, "stage-04", "stage-06's predecessor on loop is stage-04");
    assert.equal(g05.chain.prev_stage, "stage-06", "stage-05's predecessor on loop is stage-06, not stage-04");
    assert.equal(g05.chain.prev_hash, canonicalGateHash(g06));

    const r = verifyChain(gatesDirOf(cwd), "loop");
    assert.equal(r.ok, true);
    assert.equal(r.checked, 4);
    assert.deepEqual(r.breaks, []);
    assert.deepEqual(r.unstamped, []);
  });

  it("tampering with stage-06 breaks stage-05's recorded hash on loop", () => {
    const cwd = track(makeTargetProject());
    seedGate(cwd, "stage-01", { status: "PASS", track: "loop" });
    seedGate(cwd, "stage-04", { status: "PASS", track: "loop" });
    seedGate(cwd, "stage-06", { status: "PASS", track: "loop" });
    seedGate(cwd, "stage-05", { status: "PASS", track: "loop" });
    stampAll(gatesDirOf(cwd), "loop", { secret: null });

    const p06 = path.join(gatesDirOf(cwd), "stage-06.json");
    const g06 = JSON.parse(fs.readFileSync(p06, "utf8"));
    g06.status = "FAIL";
    fs.writeFileSync(p06, JSON.stringify(g06, null, 2) + "\n");

    const r = verifyChain(gatesDirOf(cwd), "loop");
    assert.equal(r.ok, false);
    assert.ok(r.breaks.some((b) => b.stage === "stage-05" && b.prev_stage === "stage-06"));
  });
});
