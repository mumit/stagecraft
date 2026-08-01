// tests/compact-qa-fold.test.js
//
// Tests for plans/phase-29-scale-adaptive-ceremony.md item 29.4 — fold
// accessibility-audit (06b) / observability-gate (06c) /
// verification-beyond-tests (06d) / performance-budget (06e) into one
// "verification-sweep" (stage-06x) dispatch on compact_qa tracks.
//
// Coverage:
//   1. foldQaSweep()/isCompactQaTrack() unit behavior.
//   2. Full track is untouched — stage definitions + rendered prompts for
//      the four specialty-QA stages are byte-identical to their unfolded
//      shape (no accidental drift while wiring the fold).
//   3. stage-06x schema accepts both the folded (combined) and unfolded
//      (standalone stage-06b/c/d/e) gate shapes.
//   4. Right-sizing skip logic for the folded slot (deterministicSkipForStage).

"use strict";

const { describe, it } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const REPO_ROOT = path.resolve(__dirname, "..");
const {
  STAGES,
  getStage,
  orderedStageNamesForTrack,
  isCompactQaTrack,
  foldQaSweep,
  QA_SWEEP_STAGES,
  FOLD_ONLY_STAGES,
} = require(path.join(REPO_ROOT, "core", "pipeline", "stages"));
const { buildDescriptor } = require(path.join(REPO_ROOT, "core", "orchestrator"));
const { loadAdapter } = require(path.join(REPO_ROOT, "core", "router"));
const { deterministicSkipForStage } = require(path.join(REPO_ROOT, "core", "pipeline", "right-sizing"));
const { makeTargetProject, cleanup } = require("./_helpers");

function readSchema(stageId) {
  return JSON.parse(fs.readFileSync(path.join(REPO_ROOT, "core", "gates", "schemas", `${stageId}.schema.json`), "utf8"));
}

// Minimal structural check (no ajv dependency, matches tests/schemas.test.js's
// existing approach): every field in schema.required must be present as a key
// on the gate object.
function satisfiesRequired(schema, gate) {
  return schema.required.every((field) => field in gate);
}

// ─── 1. Fold mechanics ──────────────────────────────────────────────────────

describe("29.4: foldQaSweep / isCompactQaTrack", () => {
  it("quick is flagged compact_qa; full and hotfix are not", () => {
    assert.equal(isCompactQaTrack("quick"), true);
    assert.equal(isCompactQaTrack("full"), false);
    assert.equal(isCompactQaTrack("hotfix"), false);
    assert.equal(isCompactQaTrack("loop"), false);
  });

  it("folds 2+ QA_SWEEP_STAGES members into one verification-sweep entry at the first position", () => {
    const folded = foldQaSweep(["qa", "accessibility-audit", "performance-budget", "sign-off"]);
    assert.deepEqual(folded, ["qa", "verification-sweep", "sign-off"]);
  });

  it("leaves a list with 0 or 1 QA_SWEEP_STAGES members unchanged", () => {
    assert.deepEqual(foldQaSweep(["qa", "sign-off"]), ["qa", "sign-off"]);
    assert.deepEqual(
      foldQaSweep(["qa", "accessibility-audit", "sign-off"]),
      ["qa", "accessibility-audit", "sign-off"],
    );
  });

  it("orderedStageNamesForTrack('quick') dispatches verification-sweep, not the two standalone stages", () => {
    const order = orderedStageNamesForTrack("quick");
    assert.ok(order.includes("verification-sweep"));
    assert.ok(!order.includes("accessibility-audit"));
    assert.ok(!order.includes("performance-budget"));
  });

  it("verification-sweep is excluded from ORDERED_STAGE_NAMES (fold-only stage)", () => {
    assert.ok(FOLD_ONLY_STAGES.includes("verification-sweep"));
  });
});

// ─── 2. Full track untouched — byte-identical prompts ──────────────────────
//
// Hard-coded snapshot of the four specialty-QA stage definitions as they
// stood before 29.4 (unchanged by this work — full/hotfix aren't flagged
// compact_qa, so they keep dispatching these four standalone). If a future
// edit to stages.js accidentally touches one of these while working on the
// fold, this test's deep-equal catches it; the rendered-prompt comparison
// additionally proves buildDescriptor()/renderStagePrompt() produce
// byte-identical output for the live STAGES entry vs. this snapshot.
const FULL_TRACK_QA_SNAPSHOT = {
  "accessibility-audit": {
    stage: "stage-06b",
    roles: ["qa"],
    objective: "Audit UI changes for WCAG accessibility violations using axe-core / pa11y / lighthouse. PASS requires zero critical + zero serious findings.",
    readFirst: ["AGENTS.md", ".devteam/rules/pipeline.md", ".devteam/rules/gates-core.md", "pipeline/context.md", "pipeline/brief.md", "pipeline/design-spec.md", "pipeline/test-report.md"],
    allowedWrites: ["pipeline/accessibility-report.md", "pipeline/axe-report.json", "pipeline/gates/stage-06b.json"],
    artifact: "pipeline/accessibility-report.md",
    template: "test-report-template.md",
    gate: {
      audit_method: null,
      wcag_level: "AA",
      violations: { critical: 0, serious: 0, moderate: 0, minor: 0 },
      components_audited: [],
      audit_skipped_reason: null,
      noted_for_followup: [],
    },
  },
  "observability-gate": {
    stage: "stage-06c",
    roles: ["platform"],
    objective: "Verify that every metric / log / trace the design-spec promised is actually emitted by the shipped code. Closes the gap where designs claim instrumentation that never lands.",
    readFirst: ["AGENTS.md", ".devteam/rules/pipeline.md", ".devteam/rules/gates-core.md", "pipeline/context.md", "pipeline/brief.md", "pipeline/design-spec.md", "pipeline/test-report.md"],
    allowedWrites: ["pipeline/observability-report.md", "pipeline/gates/stage-06c.json"],
    artifact: "pipeline/observability-report.md",
    template: "test-report-template.md",
    gate: {
      metrics: { required: [], verified: [], gap: [] },
      logs: { required: [], verified: [], gap: [] },
      traces: { required: [], verified: [], gap: [] },
      verification_method: null,
    },
  },
  "verification-beyond-tests": {
    stage: "stage-06d",
    roles: ["verifier"],
    objective: "Apply property-based testing, mutation testing, and/or formal verification to the changed code. Run AFTER stage-06 (qa) PASS — tests are the floor, this stage raises the ceiling. Surface counterexamples + surviving mutants + invariant violations as blocking findings.",
    readFirst: ["AGENTS.md", ".devteam/rules/pipeline.md", ".devteam/rules/gates-core.md", "pipeline/context.md", "pipeline/brief.md", "pipeline/design-spec.md", "pipeline/spec.feature", "pipeline/test-report.md", "pipeline/red-team-report.md"],
    allowedWrites: ["pipeline/verification-report.md", "pipeline/gates/stage-06d.json", "src/tests/property/", "pipeline/formal/", "pipeline/reports/"],
    artifact: "pipeline/verification-report.md",
    template: "verification-report-template.md",
    requiredCapabilities: { shell: true },
    gate: {
      methods_attempted: [],
      methods_skipped: [],
      candidates_inventoried: 0,
      property_based: null,
      mutation: null,
      formal: null,
      findings_count: 0,
      blocking_findings: [],
      non_blocking_findings: [],
    },
  },
  "performance-budget": {
    stage: "stage-06e",
    roles: ["qa"],
    objective: "Measure Lighthouse performance scores, bundle size delta, and load-test throughput against project budgets. FAIL if any budget is exceeded. PASS (with skipped_reason) when the change has no performance-relevant surface.",
    readFirst: ["AGENTS.md", ".devteam/rules/pipeline.md", ".devteam/rules/gates-core.md", "pipeline/context.md", "pipeline/brief.md", "pipeline/design-spec.md", "pipeline/test-report.md"],
    allowedWrites: ["pipeline/performance-report.md", "pipeline/lhci-result.json", "pipeline/gates/stage-06e.json"],
    artifact: "pipeline/performance-report.md",
    template: "performance-report-template.md",
    requiredCapabilities: { shell: true },
    gate: {
      checks_performed: [],
      lighthouse: null,
      bundle: null,
      load_test: null,
      budget_exceeded: false,
      skipped_reason: null,
    },
  },
};

describe("29.4: full track is untouched (byte-identical prompts)", () => {
  it("full track's stage order is exactly the pre-29.4 ORDERED_STAGE_NAMES sequence", () => {
    // No fold applied — full isn't flagged compact_qa.
    const order = orderedStageNamesForTrack("full");
    assert.deepEqual(order, [
      "requirements", "design", "clarification", "executable-spec", "build",
      "pre-review", "security-review", "red-team", "migration-safety",
      "peer-review", "qa", "accessibility-audit", "observability-gate",
      "verification-beyond-tests", "performance-budget", "sign-off", "deploy",
      "retrospective",
    ]);
  });

  for (const [name, snapshot] of Object.entries(FULL_TRACK_QA_SNAPSHOT)) {
    it(`"${name}" (${snapshot.stage}) definition is byte-identical to its pre-29.4 shape`, () => {
      assert.deepEqual(getStage(name), snapshot);
    });

    it(`"${name}" (${snapshot.stage}) rendered prompt on full track is byte-identical to the pre-29.4 shape`, () => {
      // No `cwd` in ctx — the generic adapter's renderStagePrompt doesn't read
      // it (only markdown-host adapters do, for template-existence checks),
      // and tests must never point at the real repo (tests/_helpers.js guard).
      const adapter = loadAdapter("generic");
      const ctx = { track: "full", feature: "test feature", isolation: "in-place", orchestrator: "devteam@test" };

      const liveDescriptor = buildDescriptor(getStage(name), snapshot.roles[0], { track: "full", workstreamId: snapshot.stage });
      const snapshotDescriptor = buildDescriptor(snapshot, snapshot.roles[0], { track: "full", workstreamId: snapshot.stage });

      const livePrompt = adapter.renderStagePrompt(liveDescriptor, ctx);
      const snapshotPrompt = adapter.renderStagePrompt(snapshotDescriptor, ctx);
      assert.equal(livePrompt, snapshotPrompt);
      assert.ok(!livePrompt.includes("stage-06x"), "full-track prompt must never mention the folded stage");
      assert.ok(!livePrompt.includes("verification-sweep"), "full-track prompt must never mention the folded stage");
    });
  }
});

// ─── 3. stage-06x schema accepts both shapes ───────────────────────────────

describe("29.4: stage-06x schema accepts both folded and unfolded gate shapes", () => {
  const sweepSchema = readSchema("stage-06x");

  it("folded shape (quick: accessibility + performance only) satisfies stage-06x.required", () => {
    const gate = {
      stage: "stage-06x", status: "PASS", orchestrator: "devteam@test", track: "quick",
      timestamp: new Date().toISOString(), blockers: [], warnings: [],
      sections_included: ["accessibility", "performance"],
      accessibility: { audit_method: "axe-core", wcag_level: "AA", violations: { critical: 0, serious: 0, moderate: 0, minor: 0 }, components_audited: [] },
      observability: null,
      verification_beyond_tests: null,
      performance: { checks_performed: ["lighthouse"], lighthouse: { score: 0.92 }, bundle: null, load_test: null, budget_exceeded: false },
    };
    assert.ok(satisfiesRequired(sweepSchema, gate));
    assert.ok(gate.sections_included.every((s) => sweepSchema.properties.sections_included.items.enum.includes(s)));
  });

  it("fully-folded shape (all four sections, a hypothetical future compact_qa track) also satisfies stage-06x.required", () => {
    const gate = {
      stage: "stage-06x", status: "PASS", orchestrator: "devteam@test", track: "quick",
      timestamp: new Date().toISOString(), blockers: [], warnings: [],
      sections_included: ["accessibility", "observability", "verification_beyond_tests", "performance"],
      accessibility: { audit_method: "axe-core", wcag_level: "AA", violations: { critical: 0, serious: 0, moderate: 0, minor: 0 }, components_audited: [] },
      observability: { metrics: { required: [], verified: [], gap: [] }, logs: { required: [], verified: [], gap: [] }, traces: { required: [], verified: [], gap: [] }, verification_method: "code-grep" },
      verification_beyond_tests: { methods_attempted: [], methods_skipped: [], candidates_inventoried: 0, findings_count: 0, blocking_findings: [] },
      performance: { checks_performed: ["lighthouse"], lighthouse: { score: 0.92 }, bundle: null, load_test: null, budget_exceeded: false },
    };
    assert.ok(satisfiesRequired(sweepSchema, gate));
  });

  it("unfolded standalone shapes (real stage-06b/06c/06d/06e gates, as full/hotfix still produce) still satisfy their own unchanged schemas", () => {
    const identity = { orchestrator: "devteam@test", track: "full", timestamp: new Date().toISOString(), blockers: [], warnings: [] };
    const examples = {
      "stage-06b": { stage: "stage-06b", status: "PASS", ...identity, ...STAGES["accessibility-audit"].gate },
      "stage-06c": { stage: "stage-06c", status: "PASS", ...identity, ...STAGES["observability-gate"].gate },
      "stage-06d": { stage: "stage-06d", status: "PASS", ...identity, ...STAGES["verification-beyond-tests"].gate },
      "stage-06e": { stage: "stage-06e", status: "PASS", ...identity, ...STAGES["performance-budget"].gate },
    };
    for (const [stageId, gate] of Object.entries(examples)) {
      assert.ok(satisfiesRequired(readSchema(stageId), gate), `${stageId} example gate should satisfy its own schema`);
    }
  });
});

// ─── 4. Right-sizing skip logic for the folded slot ────────────────────────

describe("29.4: right-sizing skip logic for verification-sweep", () => {
  let _dirs = [];
  const track = (cwd) => { _dirs.push(cwd); return cwd; };
  const { afterEach } = require("node:test");
  afterEach(() => { _dirs.forEach(cleanup); _dirs = []; });

  it("skips when none of the four constituent triggers fire", () => {
    const cwd = track(makeTargetProject());
    const skip = deterministicSkipForStage("verification-sweep", cwd, { files: ["src/backend/api.js"] });
    assert.equal(skip.skip_kind, "right-sizing.verification-sweep");
  });

  it("does not skip when the accessibility trigger fires (frontend file changed)", () => {
    const cwd = track(makeTargetProject());
    const skip = deterministicSkipForStage("verification-sweep", cwd, { files: ["src/frontend/Button.tsx"] });
    assert.equal(skip, null);
  });

  it("does not skip when the performance trigger fires (performance-relevant file changed)", () => {
    const cwd = track(makeTargetProject());
    const skip = deterministicSkipForStage("verification-sweep", cwd, { files: ["src/frontend/benchmark.js"] });
    assert.equal(skip, null);
  });
});

// Sanity: QA_SWEEP_STAGES matches the four stage names this whole file
// exercises (keeps the fixture above honest if stages.js's list ever changes).
describe("29.4: QA_SWEEP_STAGES contract", () => {
  it("is exactly the four specialty-QA stages", () => {
    assert.deepEqual(
      [...QA_SWEEP_STAGES].sort(),
      ["accessibility-audit", "observability-gate", "performance-budget", "verification-beyond-tests"].sort(),
    );
  });
});
