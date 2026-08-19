const { describe, it, afterEach } = require("node:test");
const assert = require("node:assert/strict");
const path = require("node:path");
const fs = require("node:fs");
const { makeTargetProject, seedGate, cleanup, runCLI } = require("./_helpers");

let dirs = [];
function track(cwd) { dirs.push(cwd); return cwd; }
afterEach(() => { dirs.forEach(cleanup); dirs = []; });

describe("gate chain CLI authentication", () => {
  it("stamps and verifies an authenticated chain", () => {
    const cwd = track(makeTargetProject());
    seedGate(cwd, "stage-01", { status: "PASS" });
    const env = { DEVTEAM_SIGNING_SECRET: "test-secret" };
    const stamped = runCLI(["stamp-chain", "--cwd", cwd], { env });
    assert.equal(stamped.status, 0);
    assert.match(stamped.stdout, /Authenticated 1 stage gate/);

    const verified = runCLI(["verify-chain", "--cwd", cwd, "--require-signed", "--json"], { env });
    assert.equal(verified.status, 0);
    const payload = JSON.parse(verified.stdout);
    assert.equal(payload.ok, true);
    assert.equal(payload.require_signed, true);
    assert.deepEqual(payload.invalid_macs, []);
  });

  it("honors pipeline.require_signed_gates and fails without a secret", () => {
    const cwd = track(makeTargetProject({
      config: "pipeline:\n  default_track: full\n  require_signed_gates: true\n",
    }));
    seedGate(cwd, "stage-01", { status: "PASS" });
    const unsigned = runCLI(["stamp-chain", "--cwd", cwd], { env: { DEVTEAM_SIGNING_SECRET: "" } });
    assert.equal(unsigned.status, 0);

    const verified = runCLI(["verify-chain", "--cwd", cwd, "--json"], {
      env: { DEVTEAM_SIGNING_SECRET: "" },
    });
    assert.equal(verified.status, 1);
    const payload = JSON.parse(verified.stdout);
    assert.deepEqual(payload.unsigned, ["stage-01"]);
  });

  it("does not expose the signing secret in gate JSON", () => {
    const cwd = track(makeTargetProject());
    seedGate(cwd, "stage-01", { status: "PASS" });
    runCLI(["stamp-chain", "--cwd", cwd], { env: { DEVTEAM_SIGNING_SECRET: "never-write-this" } });
    const gate = require(path.join(cwd, "pipeline", "gates", "stage-01.json"));
    assert.doesNotMatch(JSON.stringify(gate), /never-write-this/);
  });
});

describe("gate chain CLI active-run safety", () => {
  function seedHotfixRunPlan(cwd) {
    fs.writeFileSync(path.join(cwd, "pipeline", "run-plan.json"), JSON.stringify({
      schema: "stagecraft.run-plan/v1",
      track: "hotfix",
      stages: [],
    }, null, 2));
  }

  function seedPreReview(cwd) {
    return seedGate(cwd, "stage-04a", {
      track: "hotfix", host: "generic", lint_passed: true, tests_passed: true,
      dependency_review_passed: true, security_review_required: false,
    });
  }

  it("uses the materialized run track instead of the mutable config default", () => {
    const cwd = track(makeTargetProject());
    seedHotfixRunPlan(cwd);
    seedGate(cwd, "stage-01", { track: "hotfix" });
    seedGate(cwd, "stage-04", { track: "hotfix" });

    const stamped = runCLI(["stamp-chain", "--cwd", cwd]);
    assert.equal(stamped.status, 0, stamped.stderr);
    const build = require(path.join(cwd, "pipeline", "gates", "stage-04.json"));
    assert.equal(build.chain.prev_stage, null, "hotfix begins at stage-04 even when a repair diagnosis gate exists");
    const verified = runCLI(["verify-chain", "--cwd", cwd, "--json"]);
    assert.equal(verified.status, 0, verified.stderr);
  });

  it("re-stamps the affected chain after on-demand verification", () => {
    const cwd = track(makeTargetProject({
      config: "routing:\n  default_host: generic\npipeline:\n  default_track: full\n  verify:\n    lint_command: null\n    test_command: null\n",
    }));
    seedHotfixRunPlan(cwd);
    seedGate(cwd, "stage-04", { track: "hotfix" });
    seedPreReview(cwd);
    seedGate(cwd, "stage-04c", { track: "hotfix" });
    seedGate(cwd, "stage-05", { track: "hotfix" });
    assert.equal(runCLI(["stamp-chain", "--cwd", cwd]).status, 0);

    const verifiedStage = runCLI(["verify", "stage-04a", "--cwd", cwd, "--json"]);
    assert.equal(verifiedStage.status, 0, verifiedStage.stderr);
    const payload = JSON.parse(verifiedStage.stdout);
    assert.equal(payload.chain.track, "hotfix");
    assert.equal(payload.chain.track_source, "run-plan");
    assert.deepEqual(payload.chain.restamped, ["stage-04", "stage-04a", "stage-04c", "stage-05"]);

    const verifiedChain = runCLI(["verify-chain", "--cwd", cwd, "--json"]);
    assert.equal(verifiedChain.status, 0, verifiedChain.stdout + verifiedChain.stderr);
    assert.equal(JSON.parse(verifiedChain.stdout).ok, true);
  });

  it("refuses to rewrite signed history without the signing secret", () => {
    const cwd = track(makeTargetProject({
      config: "routing:\n  default_host: generic\npipeline:\n  default_track: full\n  verify:\n    lint_command: null\n    test_command: null\n",
    }));
    seedHotfixRunPlan(cwd);
    seedGate(cwd, "stage-04", { track: "hotfix" });
    const gatePath = seedPreReview(cwd);
    const env = { DEVTEAM_SIGNING_SECRET: "chain-secret" };
    assert.equal(runCLI(["stamp-chain", "--cwd", cwd], { env }).status, 0);
    const before = fs.readFileSync(gatePath);

    const result = runCLI(["verify", "stage-04a", "--cwd", cwd, "--json"], {
      env: { DEVTEAM_SIGNING_SECRET: "" },
    });
    assert.equal(result.status, 1);
    assert.match(JSON.parse(result.stdout).error, /DEVTEAM_SIGNING_SECRET/);
    assert.deepEqual(fs.readFileSync(gatePath), before);
  });
});
