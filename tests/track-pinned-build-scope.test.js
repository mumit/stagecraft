"use strict";

// ADR-027: a track-pinned build role (loop/nano/refactor's sole build owner)
// additively gets the PM-approved Stage 1 affected_files list, so a project
// whose layout doesn't match the static src/backend/-style roleWrites
// convention can still write its approved work. quick/full/dep-update are
// explicitly out of scope — see isTrackPinnedBuildRole's why-comment in
// core/pipeline/stages.js.

const { afterEach, describe, it } = require("node:test");
const assert = require("node:assert/strict");
const path = require("node:path");
const { cleanup, makeTargetProject, REPO_ROOT, seedGate } = require("./_helpers");
const { loadConfig } = require(path.join(REPO_ROOT, "core", "config"));
const { buildDescriptor } = require(path.join(REPO_ROOT, "core", "orchestrator"));
const { getStage, isTrackPinnedBuildRole } = require(path.join(REPO_ROOT, "core", "pipeline", "stages"));
const {
  buildScopeFromGate,
  loadBuildScope,
} = require(path.join(REPO_ROOT, "core", "pipeline", "affected-files"));
const { resolveRetryOwnership } = require(path.join(REPO_ROOT, "core", "retry-ownership"));

const directories = [];
afterEach(() => {
  directories.forEach(cleanup);
  directories.length = 0;
});

function target(track = "loop") {
  const cwd = makeTargetProject({
    config: `routing:\n  default_host: generic\npipeline:\n  default_track: ${track}\n`,
  });
  directories.push(cwd);
  return cwd;
}

// A flat, non-monorepo layout: nothing here lives under src/backend/,
// src/frontend/, src/infra/, or src/tests/.
const FLAT_LAYOUT_FILES = ["src/server.js", "src/cli.js", "public/index.html", "test/generate.test.js"];

function seedFlatLayoutGate(cwd, roles = ["backend"], files = FLAT_LAYOUT_FILES) {
  seedGate(cwd, "stage-01", {
    stage: "stage-01",
    status: "PASS",
    active_roles: roles,
    affected_files: files,
    acceptance_criteria_count: 1,
    out_of_scope_items: [],
    required_sections_complete: true,
  });
}

describe("ADR-027 isTrackPinnedBuildRole", () => {
  it("is true only for the structural single-build-role branches", () => {
    for (const t of ["loop", "nano", "refactor"]) {
      assert.equal(isTrackPinnedBuildRole(getStage("build"), t, {}, "backend"), true, t);
    }
  });

  it("is false for tracks that derive their build matrix from the change", () => {
    for (const t of ["quick", "full", "hotfix", "config-only", "dep-update"]) {
      assert.equal(isTrackPinnedBuildRole(getStage("build"), t, {}, "backend"), false, t);
    }
  });

  it("is false for any role that isn't the pinned one, and for non-build stages", () => {
    assert.equal(isTrackPinnedBuildRole(getStage("build"), "loop", {}, "frontend"), false);
    assert.equal(isTrackPinnedBuildRole(getStage("peer-review"), "loop", {}, "backend"), false);
  });

  it("follows pipeline.loop_build_role", () => {
    const configured = { pipeline: { loop_build_role: "frontend" } };
    assert.equal(isTrackPinnedBuildRole(getStage("build"), "loop", configured, "frontend"), true);
    assert.equal(isTrackPinnedBuildRole(getStage("build"), "loop", configured, "backend"), false);
  });
});

describe("ADR-027 buildScopeFromGate / loadBuildScope", () => {
  it("drops invalid entries instead of invalidating the whole scope", () => {
    const scope = buildScopeFromGate({
      stage: "stage-01",
      status: "PASS",
      affected_files: ["src/server.js", "docs/", "../escape.js", "src/server.js", "public/index.html"],
    });
    assert.deepEqual(scope.files, ["src/server.js", "public/index.html"]);
    assert.deepEqual(scope.dropped, ["docs/", "../escape.js", "src/server.js"]);
  });

  it("is empty for a non-PASS or missing gate", () => {
    assert.deepEqual(buildScopeFromGate(null), { files: [], dropped: [] });
    assert.deepEqual(buildScopeFromGate({ stage: "stage-01", status: "ESCALATE", affected_files: ["a.js"] }),
      { files: [], dropped: [] });
  });

  it("loads from disk the same way documentation scope does", () => {
    const cwd = target();
    seedFlatLayoutGate(cwd);
    assert.deepEqual(loadBuildScope(cwd, null).files.sort(), [...FLAT_LAYOUT_FILES].sort());
  });
});

describe("ADR-027 buildDescriptor widens allowedWrites for the pinned role only", () => {
  it("grants a loop build's pinned role the approved flat-layout paths", () => {
    const cwd = target("loop");
    seedFlatLayoutGate(cwd);
    const build = buildDescriptor(getStage("build"), "backend", { cwd, track: "loop", config: loadConfig(cwd) });
    for (const file of FLAT_LAYOUT_FILES) assert.ok(build.allowedWrites.includes(file), file);
    for (const file of FLAT_LAYOUT_FILES) assert.ok(build.approvedAffectedFiles.includes(file), file);
    // still has its static contract, this is additive
    assert.ok(build.allowedWrites.some((entry) => entry.startsWith("src/backend/")));
  });

  it("does not widen a role that isn't the track-pinned one", () => {
    const cwd = target("loop");
    seedFlatLayoutGate(cwd, ["backend"]);
    // documentation isn't the pinned role and has no scope selected here, so
    // this exercises the "not the pinned role" branch via qa in the same stage.
    const qa = buildDescriptor(getStage("qa"), "qa", { cwd, track: "loop", config: loadConfig(cwd) });
    for (const file of FLAT_LAYOUT_FILES) assert.ok(!qa.allowedWrites.includes(file), file);
  });

  it("does NOT widen quick/full even when a single role is the only one dispatched this time", () => {
    for (const track of ["quick", "full"]) {
      const cwd = target(track);
      seedFlatLayoutGate(cwd);
      const build = buildDescriptor(getStage("build"), "backend", { cwd, track, config: loadConfig(cwd) });
      for (const file of FLAT_LAYOUT_FILES) {
        assert.ok(!build.allowedWrites.includes(file), `${track} must not inherit ${file}`);
      }
      assert.deepEqual(build.approvedAffectedFiles, [], track);
    }
  });

  it("follows pipeline.loop_build_role to the configured role, not backend by default", () => {
    const cwd = target("loop");
    seedFlatLayoutGate(cwd, ["frontend"]);
    const config = loadConfig(cwd);
    config.pipeline.loop_build_role = "frontend";
    const build = buildDescriptor(getStage("build"), "frontend", { cwd, track: "loop", config });
    for (const file of FLAT_LAYOUT_FILES) assert.ok(build.allowedWrites.includes(file), file);
  });
});

describe("ADR-027 retry routing mirrors the same widening", () => {
  it("routes a retry into a flat-layout path back to loop's pinned build role", () => {
    const cwd = target("loop");
    seedFlatLayoutGate(cwd);
    const result = resolveRetryOwnership({
      cwd,
      changeId: null,
      track: "loop",
      config: loadConfig(cwd),
      retryAction: {
        stage: "stage-06",
        name: "qa",
        blockers: [{ file: "src/server.js", text: "handler throws on empty body" }],
        clear_gates: ["pipeline/gates/stage-04.json", "pipeline/gates/stage-06.json"],
      },
    });
    assert.equal(result.incompatible, false);
    assert.equal(result.targetedFix.workstream, "backend");
  });

  it("still reports incompatible for quick, which has no widened scope to route into", () => {
    const cwd = target("quick");
    seedFlatLayoutGate(cwd);
    const result = resolveRetryOwnership({
      cwd,
      changeId: null,
      track: "quick",
      config: loadConfig(cwd),
      retryAction: {
        stage: "stage-06",
        name: "qa",
        blockers: [{ file: "src/server.js", text: "handler throws on empty body" }],
        clear_gates: ["pipeline/gates/stage-04.backend.json", "pipeline/gates/stage-06.json"],
      },
    });
    assert.equal(result.incompatible, true);
  });
});
