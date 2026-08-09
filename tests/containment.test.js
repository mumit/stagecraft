"use strict";

const { describe, it, afterEach } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const {
  normalizeExecutionConfig,
  publicTrustPlan,
  resolveTrustProfile,
  wrapContainedInvocation,
} = require("../core/containment");

const temporary = [];
afterEach(() => {
  for (const dir of temporary.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

function workspace() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "devteam-test-contained-"));
  temporary.push(dir);
  return dir;
}

function config(overrides = {}) {
  return {
    execution: normalizeExecutionConfig({
      trust_profile: "contained",
      contained: { image: "agent:test", env_allowlist: ["MODEL_KEY"], ...overrides },
    }),
  };
}

describe("execution trust profiles", () => {
  it("defaults to honest unsandboxed trusted execution", () => {
    const execution = normalizeExecutionConfig();
    assert.equal(execution.trust_profile, "trusted");
    assert.deepEqual(publicTrustPlan({ execution }, "trusted"), {
      profile: "trusted", os_sandboxed: false, provider: null,
    });
  });

  it("fails closed for contained without an image and for reserved remote", () => {
    assert.throws(() => resolveTrustProfile({ execution: normalizeExecutionConfig({ trust_profile: "contained" }) }), /requires execution\.contained\.image/);
    assert.throws(() => resolveTrustProfile({ execution: normalizeExecutionConfig() }, "remote"), /not implemented/);
  });

  it("wraps the adapter command with non-root, resource-bounded Docker policy", () => {
    const cwd = workspace();
    const execution = config().execution;
    const invocation = wrapContainedInvocation({
      bin: "agent-cli",
      args: ["--print"],
      ctx: { cwd, trustProfile: "contained", containment: execution.contained },
      env: { PATH: "/bin", MODEL_KEY: "secret", AMBIENT_SECRET: "nope" },
      dockerCheck: () => true,
    });
    assert.equal(invocation.bin, "docker");
    assert.ok(invocation.args.includes("--read-only"));
    assert.ok(invocation.args.includes("no-new-privileges:true"));
    assert.ok(invocation.args.includes("ALL"));
    assert.ok(invocation.args.includes("none"));
    assert.ok(invocation.args.includes("MODEL_KEY"));
    assert.ok(!invocation.args.includes("MODEL_KEY=secret"), "secret values stay out of argv");
    assert.ok(!invocation.args.some((arg) => arg.includes("AMBIENT_SECRET")));
    assert.deepEqual(invocation.args.slice(-3), ["agent:test", "agent-cli", "--print"]);
  });

  it("fingerprints the private image reference without persisting it", () => {
    const execution = config().execution;
    const plan = publicTrustPlan({ execution }, "contained");
    assert.match(plan.image_ref_sha256, /^sha256:[a-f0-9]{64}$/);
    assert.equal(JSON.stringify(plan).includes("agent:test"), false);
  });

  it("refuses a process cwd outside the disposable workspace", () => {
    const cwd = workspace();
    const outside = workspace();
    const execution = config().execution;
    assert.throws(() => wrapContainedInvocation({
      bin: "agent-cli", args: [], dockerCheck: () => true,
      ctx: { cwd, processCwd: outside, trustProfile: "contained", containment: execution.contained },
    }), /outside its disposable/);
  });

  it("never checks Docker or changes process shape for trusted execution", () => {
    const cwd = workspace();
    const invocation = wrapContainedInvocation({
      bin: "cat", args: ["--help"], ctx: { cwd, trustProfile: "trusted" },
      env: { PATH: "/bin" }, dockerCheck: () => { throw new Error("must not run"); },
    });
    assert.equal(invocation.bin, "cat");
    assert.deepEqual(invocation.args, ["--help"]);
    assert.equal(invocation.contained, false);
  });
});
