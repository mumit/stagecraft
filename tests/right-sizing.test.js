const { describe, it, afterEach } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { REPO_ROOT, makeTargetProject, seedGate, cleanup } = require("./_helpers");
const {
  candidateActiveRoles,
  deterministicSkipForStage,
  deterministicSkipsForOrder,
  highConfidenceTrack,
} = require(path.join(REPO_ROOT, "core", "pipeline", "right-sizing"));
const { next } = require(path.join(REPO_ROOT, "core", "orchestrator"));

let _dirs = [];
function track(cwd) { _dirs.push(cwd); return cwd; }
afterEach(() => { _dirs.forEach(cleanup); _dirs = []; });

describe("right-sizing helpers", () => {
  it("derives candidate active workstreams from changed paths", () => {
    const cwd = track(makeTargetProject());
    const result = candidateActiveRoles(cwd, {
      files: ["src/backend/routes/hello.js", "src/tests/hello.test.js", "docs/README.md"],
    });
    assert.deepEqual(result.roles.sort(), ["backend", "documentation", "qa"]);
    assert.deepEqual(result.trigger_inputs.matched_files_by_role.backend, ["src/backend/routes/hello.js"]);
  });

  it("only returns automatic track choices at high confidence", () => {
    const cwd = track(makeTargetProject());
    assert.equal(highConfidenceTrack(cwd, "small fix", { files: [] }), null);
    const dep = highConfidenceTrack(cwd, "bump express", { files: ["package-lock.json"] });
    assert.equal(dep.track, "dep-update");
    assert.equal(dep.confidence, "high");
  });

  it("skips advanced gates only when deterministic triggers are absent", () => {
    const cwd = track(makeTargetProject());
    const noA11y = deterministicSkipForStage("accessibility-audit", cwd, {
      files: ["src/backend/api.js"],
    });
    assert.equal(noA11y.skip_kind, "right-sizing.accessibility");

    const needsA11y = deterministicSkipForStage("accessibility-audit", cwd, {
      files: ["src/frontend/Button.tsx"],
    });
    assert.equal(needsA11y, null);
  });

  it("keeps performance budget active for seeded performance scope", () => {
    const cwd = track(makeTargetProject());
    fs.mkdirSync(path.join(cwd, "pipeline"), { recursive: true });
    fs.writeFileSync(path.join(cwd, "pipeline", "design-spec.md"), "Measure p95 latency and throughput.\n");
    const skips = deterministicSkipsForOrder(["performance-budget"], cwd, { files: [] });
    assert.deepEqual(skips, {});
  });
});

describe("next: right-sizing deterministic skips", () => {
  it("audits right-sized skips and force_stages overrides them", () => {
    const cwd = track(makeTargetProject({
      config: "pipeline:\n  default_track: full\n  force_stages:\n    - accessibility-audit\n",
    }));
    for (const s of [
      "stage-01", "stage-02", "stage-03", "stage-03b", "stage-04", "stage-04a",
      "stage-04c", "stage-05", "stage-06",
    ]) {
      seedGate(cwd, s, { status: "PASS" });
    }
    seedGate(cwd, "stage-04a", { status: "PASS", security_review_required: false, migration_safety_required: false });
    const r = next({ cwd, auditSkips: true, auditedSkips: ["security-review", "migration-safety"] });
    assert.equal(r.action, "run-stage");
    assert.equal(r.name, "accessibility-audit");
  });

  it("returns typed right-sizing skip events with trigger inputs", () => {
    const cwd = track(makeTargetProject());
    for (const s of [
      "stage-01", "stage-02", "stage-03", "stage-03b", "stage-04", "stage-04a",
      "stage-04c", "stage-05", "stage-06",
    ]) {
      seedGate(cwd, s, { status: "PASS" });
    }
    seedGate(cwd, "stage-04a", { status: "PASS", security_review_required: false, migration_safety_required: false });
    const r = next({ cwd, auditSkips: true, auditedSkips: ["security-review", "migration-safety"] });
    assert.equal(r.action, "skip-stage");
    assert.equal(r.name, "accessibility-audit");
    assert.equal(r.skip_kind, "right-sizing.accessibility");
    assert.ok(Array.isArray(r.trigger_inputs.changed_files));
    assert.ok(Array.isArray(r.trigger_inputs.matched_files));
  });
});
