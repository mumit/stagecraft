"use strict";

const { afterEach, describe, it } = require("node:test");
const assert = require("node:assert/strict");
const path = require("node:path");
const { cleanup, makeTargetProject, REPO_ROOT, seedGate } = require("./_helpers");
const { loadConfig } = require(path.join(REPO_ROOT, "core", "config"));
const generic = require(path.join(REPO_ROOT, "hosts", "generic", "adapter"));
const {
  buildDescriptor,
  computeDispatchPlan,
} = require(path.join(REPO_ROOT, "core", "orchestrator"));
const { getStage } = require(path.join(REPO_ROOT, "core", "pipeline", "stages"));
const {
  documentationScopeError,
  documentationScopeFromGate,
  isDocumentationPath,
  normalizeAffectedFile,
} = require(path.join(REPO_ROOT, "core", "pipeline", "affected-files"));
const { resolveRetryOwnership } = require(path.join(REPO_ROOT, "core", "retry-ownership"));

const directories = [];
afterEach(() => {
  directories.forEach(cleanup);
  directories.length = 0;
});

function target() {
  const cwd = makeTargetProject({
    config: "routing:\n  default_host: generic\npipeline:\n  default_track: loop\n",
  });
  directories.push(cwd);
  return cwd;
}

function seedDocumentationScope(cwd, files = ["docs/operator-guide.md", "README.md"]) {
  seedGate(cwd, "stage-01", {
    stage: "stage-01",
    status: "PASS",
    active_roles: ["documentation"],
    affected_files: files,
    acceptance_criteria_count: 1,
    out_of_scope_items: [],
    required_sections_complete: true,
  });
}

describe("ADR-022 exact documentation scope", () => {
  it("accepts exact documentation paths and rejects escape or wildcard authority", () => {
    assert.equal(normalizeAffectedFile("docs/guide.md"), "docs/guide.md");
    assert.equal(isDocumentationPath("CONTRIBUTING.md"), true);
    assert.equal(isDocumentationPath("docs/diagram.png"), true);
    for (const invalid of ["docs/", "docs/**", "../README.md", "/tmp/README.md", "docs\\guide.md", "docs/a:b.md", "docs/a\nb.md"]) {
      assert.equal(normalizeAffectedFile(invalid), null, invalid);
    }
  });

  it("requires documentation to be the sole active role with a non-empty docs-only list", () => {
    assert.match(documentationScopeError({
      stage: "stage-01",
      status: "PASS",
      active_roles: ["backend", "documentation"],
      affected_files: ["README.md"],
    }), /documentation-only/);
    assert.match(documentationScopeError({
      stage: "stage-01",
      status: "PASS",
      active_roles: ["documentation"],
      affected_files: ["src/backend/app.js"],
    }), /non-documentation/);
    assert.match(documentationScopeError({
      stage: "stage-01",
      status: "PASS",
      active_roles: ["documentation"],
      affected_files: [],
    }), /empty or missing/);
  });

  it("selects documentation for loop build and panel review, without changing normal loop", () => {
    const cwd = target();
    const config = loadConfig(cwd);
    const gatesDir = path.join(cwd, "pipeline", "gates");
    assert.deepEqual(
      computeDispatchPlan(getStage("build"), config, "loop", { gatesDir }).map((entry) => entry.role),
      ["backend"],
    );
    seedDocumentationScope(cwd);
    assert.deepEqual(
      computeDispatchPlan(getStage("build"), config, "loop", { gatesDir }).map((entry) => entry.role),
      ["documentation"],
    );
    assert.deepEqual(
      computeDispatchPlan(getStage("peer-review"), config, "loop", { gatesDir }).map((entry) => entry.role),
      ["documentation"],
    );
    assert.deepEqual(
      computeDispatchPlan(getStage("qa"), config, "loop", { gatesDir }).map((entry) => entry.role),
      ["qa"],
    );

    const adversarialCwd = makeTargetProject({
      config: "routing:\n  default_host: generic\npipeline:\n  default_track: loop\nreview:\n  mode: adversarial\n",
    });
    directories.push(adversarialCwd);
    seedDocumentationScope(adversarialCwd);
    assert.deepEqual(
      computeDispatchPlan(
        getStage("peer-review"),
        loadConfig(adversarialCwd),
        "loop",
        { gatesDir: path.join(adversarialCwd, "pipeline", "gates") },
      ).map((entry) => entry.role),
      ["documentation"],
      "the docs-only scoped reviewer replaces an inapplicable adversarial matrix",
    );
  });

  it("gives build, QA, and review the same affected-file contract while only build may edit it", () => {
    const cwd = target();
    seedDocumentationScope(cwd);
    const affected = ["docs/operator-guide.md", "README.md"];
    const build = buildDescriptor(getStage("build"), "documentation", {
      cwd, track: "loop", workstreamId: "stage-04", rolesInStage: ["documentation"],
    });
    const qa = buildDescriptor(getStage("qa"), "qa", { cwd, track: "loop" });
    const review = buildDescriptor(getStage("peer-review"), "documentation", {
      cwd, track: "loop", workstreamId: "stage-05", rolesInStage: ["documentation"],
    });

    assert.deepEqual(build.approvedAffectedFiles, affected);
    assert.deepEqual(qa.approvedAffectedFiles, affected);
    assert.deepEqual(review.approvedAffectedFiles, affected);
    for (const file of affected) assert.ok(build.allowedWrites.includes(file));
    assert.ok(!qa.allowedWrites.includes("README.md"));
    assert.ok(!review.allowedWrites.includes("README.md"));
    assert.ok(!getStage("build").roleWrites.documentation.some((entry) => entry === "docs/" || entry.includes("*")));

    const prompt = generic.renderStagePrompt(build, {
      cwd,
      track: "loop",
      feature: "refresh operator documentation",
    });
    assert.match(prompt, /Approved affected files \(exact scope contract\)/);
    assert.match(prompt, /docs\/operator-guide\.md/);
    assert.match(prompt, /README\.md/);
  });

  it("refuses a direct documentation build without prior Stage 1 approval", () => {
    const cwd = target();
    assert.throws(
      () => buildDescriptor(getStage("build"), "documentation", { cwd, track: "loop" }),
      /requires a PASS stage-01 gate/,
    );
    assert.throws(
      () => buildDescriptor(getStage("peer-review"), "documentation", { cwd, track: "loop" }),
      /requires a PASS stage-01 gate/,
    );
  });

  it("routes an approved documentation retry and rejects a newly discovered sibling", () => {
    const cwd = target();
    seedDocumentationScope(cwd, ["docs/operator-guide.md"]);
    const base = {
      cwd,
      changeId: null,
      track: "loop",
      config: loadConfig(cwd),
    };
    const approved = resolveRetryOwnership({
      ...base,
      retryAction: {
        stage: "stage-06",
        name: "qa",
        blockers: [{ file: "docs/operator-guide.md", text: "example is stale" }],
        clear_gates: ["pipeline/gates/stage-04.json", "pipeline/gates/stage-06.json"],
      },
    });
    assert.equal(approved.incompatible, false);
    assert.equal(approved.targetedFix.workstream, "documentation");

    const unapproved = resolveRetryOwnership({
      ...base,
      retryAction: {
        stage: "stage-06",
        name: "qa",
        blockers: [{ file: "docs/new-guide.md", text: "must also be updated" }],
        clear_gates: ["pipeline/gates/stage-04.json", "pipeline/gates/stage-06.json"],
      },
    });
    assert.equal(unapproved.incompatible, true);
    assert.deepEqual(unapproved.candidate_roles, ["documentation"]);
  });

  it("does not select scope from an unapproved or invalid gate", () => {
    assert.deepEqual(documentationScopeFromGate({
      stage: "stage-01",
      status: "ESCALATE",
      active_roles: ["documentation"],
      affected_files: ["README.md"],
    }), { selected: false, affectedFiles: [], error: null });
    assert.deepEqual(documentationScopeFromGate({
      stage: "stage-01",
      status: "ESCALATE",
      active_roles: ["documentation"],
      affected_files: [],
    }), { selected: false, affectedFiles: [], error: null });
  });
});
