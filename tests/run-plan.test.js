"use strict";

const { describe, it, afterEach } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { makeTargetProject, cleanup } = require("./_helpers");
const { loadConfig, clearConfigCache } = require("../core/config");
const { orderedStageNamesForTrack } = require("../core/pipeline/stages");
const { buildRunPlan, persistRunPlan } = require("../core/run-plan");

let directories = [];
afterEach(() => {
  directories.forEach(cleanup);
  directories = [];
  clearConfigCache();
});

function fixture() {
  const cwd = makeTargetProject({
    config: [
      "routing:",
      "  default_host: generic",
      "  roles:",
      "    backend:",
      "      host: codex",
      "      model: senior-builder",
      "pipeline:",
      "  default_track: loop",
      "",
    ].join("\n"),
  });
  directories.push(cwd);
  return { cwd, config: loadConfig(cwd) };
}

function planFor(config, overrides = {}) {
  return buildRunPlan({
    changeId: null,
    order: orderedStageNamesForTrack("loop"),
    track: "loop",
    trackSource: "inferred",
    trackConfidence: "low",
    intent: "feature",
    config,
    candidateActiveRoles: [],
    expectedWorkstreams: 4,
    ceremonyPreview: { estimate_basis: "static", cost_usd: 1 },
    runId: "2026-08-08T00:00:00.000Z",
    generatedAt: "2026-08-08T00:00:00.000Z",
    ...overrides,
  });
}

describe("materialized run plan (ADR-018)", () => {
  it("records stage order and candidate route/model decisions", () => {
    const { config } = fixture();
    const plan = planFor(config);
    assert.deepEqual(plan.stages.map((stage) => stage.name), ["requirements", "build", "qa", "peer-review"]);
    assert.equal(plan.base_workstreams, 4, "loop counts track-sized roles, not static four-area build/review roles");
    const build = plan.stages.find((stage) => stage.name === "build");
    assert.deepEqual(build.configured_roles, ["backend"]);
    assert.deepEqual(build.dispatches, [{
      role: "backend",
      host: "codex",
      model: "senior-builder",
      status: "candidate",
    }]);
  });

  it("reuses an identical plan on resume and rejects execution drift", () => {
    const { cwd, config } = fixture();
    const original = planFor(config);
    const first = persistRunPlan(cwd, null, original);
    assert.equal(first.reused, false);

    const costOnlyChange = planFor(config, {
      ceremonyPreview: { estimate_basis: "empirical", cost_usd: 2 },
      generatedAt: "2026-08-09T00:00:00.000Z",
    });
    const resumed = persistRunPlan(cwd, null, costOnlyChange, { resume: true });
    assert.equal(resumed.reused, true, "advisory ceremony changes do not invalidate a resume");
    assert.equal(resumed.plan.generated_at, original.generated_at, "the original plan remains immutable");

    const drifted = planFor(config, { trackSource: "human" });
    assert.throws(
      () => persistRunPlan(cwd, null, drifted, { resume: true }),
      (error) => error && error.code === "ERUNPLANDRIFT",
    );
    const onDisk = JSON.parse(fs.readFileSync(path.join(cwd, "pipeline", "run-plan.json"), "utf8"));
    assert.equal(onDisk.plan_fingerprint, original.plan_fingerprint);
  });

  it("materializes the trust boundary and binds it to resume", () => {
    const { config } = fixture();
    const trusted = planFor(config);
    assert.deepEqual(trusted.execution_trust, {
      profile: "trusted", os_sandboxed: false, provider: null,
    });
    config.execution = require("../core/containment").normalizeExecutionConfig({
      trust_profile: "contained",
      contained: { image: "agent:test", env_allowlist: ["MODEL_KEY"] },
    });
    const contained = planFor(config);
    assert.equal(contained.execution_trust.profile, "contained");
    assert.equal(contained.execution_trust.network, "none");
    assert.deepEqual(contained.execution_trust.environment_allowlist, ["MODEL_KEY"]);
    assert.notEqual(contained.plan_fingerprint, trusted.plan_fingerprint);
    assert.equal(JSON.stringify(contained).includes("agent:test"), false, "private image name omitted");
  });
});
