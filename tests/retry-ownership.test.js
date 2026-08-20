"use strict";

const { afterEach, describe, it } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { cleanup, makeTargetProject, REPO_ROOT, seedGate } = require("./_helpers");
const { resolveRetryOwnership } = require(path.join(REPO_ROOT, "core", "retry-ownership"));
const { STAGES } = require(path.join(REPO_ROOT, "core", "pipeline", "stages"));

const directories = [];
afterEach(() => {
  directories.forEach(cleanup);
  directories.length = 0;
});

function target() {
  const cwd = makeTargetProject();
  directories.push(cwd);
  return cwd;
}

function resolve(cwd, blockers, clearGates) {
  return resolveRetryOwnership({
    cwd,
    changeId: null,
    retryAction: {
      stage: "stage-06",
      name: "qa",
      blockers,
      clear_gates: clearGates,
    },
    track: "full",
    config: { pipeline: {} },
  });
}

describe("retry ownership", () => {
  it("rejects a documentation target assigned to a backend-only retry", () => {
    const result = resolve(
      target(),
      [{ file: "docs/operator-guide.md", text: "stale instructions" }],
      ["pipeline/gates/stage-04.backend.json", "pipeline/gates/stage-04.json"],
    );

    assert.equal(result.incompatible, true);
    assert.deepEqual(result.target_paths, ["docs/operator-guide.md"]);
    assert.deepEqual(result.candidate_roles, ["backend"]);
    assert.equal(result.targetedFix, null);
  });

  it("selects a compatible candidate deterministically without widening role writes", () => {
    const cwd = target();
    const roleWritesBefore = structuredClone(STAGES.build.roleWrites);
    const result = resolve(
      cwd,
      [{ file: "package.json", text: "missing script" }],
      [
        "pipeline/gates/stage-04.backend.json",
        "pipeline/gates/stage-04.frontend.json",
        "pipeline/gates/stage-04.platform.json",
        "pipeline/gates/stage-04.json",
      ],
    );

    assert.equal(result.incompatible, false);
    assert.deepEqual(result.compatible_roles, ["backend", "platform"]);
    assert.equal(result.targetedFix.workstream, "backend");
    assert.deepEqual(STAGES.build.roleWrites, roleWritesBefore);
  });

  it("prefers a compatible stage-02 owner over stage ordering", () => {
    const cwd = target();
    seedGate(cwd, "stage-02", {
      status: "PASS",
      file_ownership: { "Dockerfile": "platform" },
    });
    fs.writeFileSync(path.join(cwd, "Dockerfile"), "FROM node:22\n");
    const result = resolve(
      cwd,
      [{ file: "Dockerfile:3", text: "missing USER" }],
      [
        "pipeline/gates/stage-04.backend.json",
        "pipeline/gates/stage-04.platform.json",
        "pipeline/gates/stage-04.json",
      ],
    );

    assert.deepEqual(result.target_paths, ["Dockerfile"]);
    assert.equal(result.targetedFix.workstream, "platform");
  });

  it("leaves unstructured blockers on the existing bounded retry path", () => {
    const result = resolve(
      target(),
      ["test suite failed without a target path"],
      ["pipeline/gates/stage-04.backend.json", "pipeline/gates/stage-04.json"],
    );

    assert.equal(result.evaluated, false);
    assert.equal(result.targetedFix, null);
  });

  it("checks an action-level requested artifact even when blockers have no path", () => {
    const cwd = target();
    const result = resolveRetryOwnership({
      cwd,
      changeId: null,
      retryAction: {
        stage: "stage-06",
        name: "qa",
        blockers: [],
        requested_artifact: "docs/release-notes.md",
        clear_gates: ["pipeline/gates/stage-04.backend.json", "pipeline/gates/stage-04.json"],
      },
      track: "full",
      config: { pipeline: {} },
    });

    assert.equal(result.incompatible, true);
    assert.deepEqual(result.target_paths, ["docs/release-notes.md"]);
  });
});
