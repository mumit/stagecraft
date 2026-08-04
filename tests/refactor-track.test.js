// tests/refactor-track.test.js
//
// Phase-35 item 35.5 — `refactor` track: behavior preservation, not new
// behavior. Same 3-stage shape as `nano` (build -> peer-review -> qa), kept
// distinct by exactly two overrides:
//   (1) build (stage-04): CHARACTERIZATION brief objective/template instead
//       of nano's "implement the design" framing.
//   (2) qa (stage-06): AC-mapping fields null (no ACs on this track) and the
//       31.4 mutation smoke gate defaults to ENABLED (every other track
//       defaults it off).
// Everything else (stage list, peer-review sizing, readFirst) is
// deliberately identical to nano — asserted here as a regression guard so a
// future edit doesn't introduce a third, undocumented difference.

"use strict";

const { describe, it, afterEach } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const { REPO_ROOT, makeTargetProject, cleanup } = require("./_helpers");
const {
  TRACKS,
  STAGES_BY_TRACK,
  PEER_REVIEW_SIZING,
  getStage,
  orderedStageNamesForTrack,
} = require(path.join(REPO_ROOT, "core", "pipeline", "stages"));
const { buildDescriptor, next, mergeWorkstreamGates } = require(path.join(REPO_ROOT, "core", "orchestrator"));
const { stampStage06 } = require(path.join(REPO_ROOT, "core", "verify", "stamp"));
const { resolveMutationConfig } = require(path.join(REPO_ROOT, "core", "verify", "mutation"));

let _dirs = [];
function track(cwd) { _dirs.push(cwd); return cwd; }
afterEach(() => { _dirs.forEach(cleanup); _dirs = []; });

// ─── 1. Track contract ─────────────────────────────────────────────────────

describe("35.5: refactor track contract", () => {
  it("is registered in TRACKS with the same 3-stage shape as nano", () => {
    assert.ok(TRACKS.includes("refactor"));
    assert.deepEqual(STAGES_BY_TRACK.refactor, ["build", "peer-review", "qa"]);
    assert.deepEqual(STAGES_BY_TRACK.refactor, STAGES_BY_TRACK.nano, "stage list must match nano exactly");
  });

  it("has no requirements/design/sign-off/deploy stages", () => {
    const stages = orderedStageNamesForTrack("refactor");
    for (const forbidden of ["requirements", "design", "clarification", "sign-off", "deploy"]) {
      assert.ok(!stages.includes(forbidden), `refactor must not include "${forbidden}"`);
    }
  });

  it("peer-review sizing matches nano's (single reviewer, 1 approval) — not full's 4-area matrix", () => {
    assert.deepEqual(PEER_REVIEW_SIZING.refactor, PEER_REVIEW_SIZING.nano);
    assert.deepEqual(PEER_REVIEW_SIZING.refactor, { roles: ["backend"], required_approvals: 1 });
  });
});

// ─── 2. Difference (1): build's characterization override ─────────────────

describe("35.5: build stage — characterization brief, distinct from nano", () => {
  it("refactor gets a different objective and template than nano", () => {
    const buildDef = getStage("build");
    const refactorDescriptor = buildDescriptor(buildDef, "backend", { workstreamId: "stage-04.backend", track: "refactor" });
    const nanoDescriptor = buildDescriptor(buildDef, "backend", { workstreamId: "stage-04.backend", track: "nano" });

    assert.notEqual(refactorDescriptor.objective, nanoDescriptor.objective);
    assert.match(refactorDescriptor.objective, /characterize/i);
    assert.equal(refactorDescriptor.template, "characterization-template.md");
    assert.equal(nanoDescriptor.template, "build-template.md", "nano must be unaffected");
  });

  it("gate shape (pr_summaries_written, local_verification) is unchanged from nano", () => {
    const buildDef = getStage("build");
    const refactorDescriptor = buildDescriptor(buildDef, "backend", { workstreamId: "stage-04.backend", track: "refactor" });
    assert.deepEqual(refactorDescriptor.expectedGate, buildDef.gate);
  });

  it("characterization-template.md exists in templates/", () => {
    assert.ok(fs.existsSync(path.join(REPO_ROOT, "templates", "characterization-template.md")));
  });
});

// ─── 3. Difference (2): qa's null AC fields + objective ───────────────────

describe("35.5: qa stage — AC-mapping fields null-permitted, distinct from nano", () => {
  it("refactor's gate skeleton nulls the AC-mapping fields; nano's stays boolean false", () => {
    const qaDef = getStage("qa");
    const refactorDescriptor = buildDescriptor(qaDef, "qa", { workstreamId: "stage-06", track: "refactor" });
    const nanoDescriptor = buildDescriptor(qaDef, "qa", { workstreamId: "stage-06", track: "nano" });

    assert.equal(refactorDescriptor.expectedGate.all_acceptance_criteria_met, null);
    assert.equal(refactorDescriptor.expectedGate.criterion_to_test_mapping_is_one_to_one, null);
    assert.equal(nanoDescriptor.expectedGate.all_acceptance_criteria_met, false, "nano must be unaffected");
    assert.equal(nanoDescriptor.expectedGate.criterion_to_test_mapping_is_one_to_one, false, "nano must be unaffected");
  });

  it("refactor's objective mentions the behavior-preserved bar; nano's does not", () => {
    const qaDef = getStage("qa");
    const refactorDescriptor = buildDescriptor(qaDef, "qa", { workstreamId: "stage-06", track: "refactor" });
    const nanoDescriptor = buildDescriptor(qaDef, "qa", { workstreamId: "stage-06", track: "nano" });
    assert.match(refactorDescriptor.objective, /behavior/i);
    assert.notEqual(refactorDescriptor.objective, nanoDescriptor.objective);
  });
});

// ─── 4. Mutation gate (31.4) default flips ONLY on refactor ────────────────

describe("35.5: 31.4 mutation gate defaults to enabled on refactor only", () => {
  it("resolveMutationConfig defaults enabled=true for track 'refactor' with no explicit config", () => {
    assert.equal(resolveMutationConfig({ pipeline: { verify: {} } }, "refactor").enabled, true);
  });

  for (const t of ["full", "quick", "nano", "hotfix", "config-only", "dep-update", "loop", "review-only", "review-pr", undefined]) {
    it(`resolveMutationConfig stays disabled by default for track ${JSON.stringify(t)}`, () => {
      assert.equal(resolveMutationConfig({ pipeline: { verify: {} } }, t).enabled, false);
    });
  }

  it("an explicit enabled:false in config overrides the refactor-track default", () => {
    assert.equal(
      resolveMutationConfig({ pipeline: { verify: { mutation: { enabled: false } } } }, "refactor").enabled,
      false,
    );
  });

  it("an explicit enabled:true in config still works on every other track (unchanged behavior)", () => {
    assert.equal(
      resolveMutationConfig({ pipeline: { verify: { mutation: { enabled: true } } } }, "quick").enabled,
      true,
    );
  });
});

// ─── 5. Mutation gate integration via stampStage06 ─────────────────────────

function seedGateRaw(cwd, name, content) {
  const dir = path.join(cwd, "pipeline", "gates");
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, `${name}.json`);
  fs.writeFileSync(file, JSON.stringify(content, null, 2));
  return file;
}

function base06Gate(overrides = {}) {
  return {
    stage: "stage-06",
    status: "PASS",
    orchestrator: "devteam@test",
    host: "generic",
    track: "refactor",
    timestamp: "2026-08-04T00:00:00Z",
    blockers: [],
    warnings: [],
    all_acceptance_criteria_met: null,
    tests_total: 1, tests_passed: 1, tests_failed: 0, failing_tests: [],
    criterion_to_test_mapping_is_one_to_one: null,
    ...overrides,
  };
}

function configWithVerify(verifyYaml) {
  return `routing:\n  default_host: generic\npipeline:\n  default_track: refactor\n  verify:\n${verifyYaml}\n`;
}

function seedChangedFiles(cwd, files) {
  fs.mkdirSync(path.join(cwd, "pipeline"), { recursive: true });
  fs.writeFileSync(path.join(cwd, "pipeline", "changed-files.txt"), files.join("\n") + "\n");
}

describe("35.5: stampStage06 mutation gate runs by default on the refactor track", () => {
  it("runs the mutation gate with no `mutation.enabled` in config at all, on track refactor", async () => {
    const cwd = track(makeTargetProject({
      config: configWithVerify(
        "    test_command: \"true\"\n    mutation:\n      command: \"node fake-mutation.js\"\n      threshold: 0.7\n",
      ),
    }));
    fs.writeFileSync(path.join(cwd, "fake-mutation.js"), `console.log("9/10 mutants killed (90.00%)");`);
    seedChangedFiles(cwd, ["src/foo.js"]);
    const gatePath = seedGateRaw(cwd, "stage-06", base06Gate());

    const r = await stampStage06(cwd, gatePath);
    assert.equal(r.stamp.runs.mutation.ran, true, "mutation gate should have run by default on refactor");
    assert.equal(r.gate.mutation_score, 0.9);
    assert.equal(r.gate.status, "PASS");
  });

  it("stays disabled with the same unconfigured verify block on track nano", async () => {
    const cwd = track(makeTargetProject({
      config: "routing:\n  default_host: generic\npipeline:\n  default_track: nano\n  verify:\n    test_command: \"true\"\n    mutation:\n      command: \"node fake-mutation.js\"\n",
    }));
    fs.writeFileSync(path.join(cwd, "fake-mutation.js"), `console.log("9/10 mutants killed (90.00%)");`);
    seedChangedFiles(cwd, ["src/foo.js"]);
    const gatePath = seedGateRaw(cwd, "stage-06", base06Gate({
      track: "nano", all_acceptance_criteria_met: false, criterion_to_test_mapping_is_one_to_one: false,
    }));

    const r = await stampStage06(cwd, gatePath);
    assert.equal(r.stamp.runs.mutation.ran, false);
    assert.match(r.stamp.runs.mutation.reason, /disabled/);
    assert.match(r.stamp.runs.mutation.reason, /default/);
    assert.equal(r.gate.mutation_score, undefined);
  });

  it("an explicit enabled:false on refactor is honored (reason says explicitly overridden)", async () => {
    const cwd = track(makeTargetProject({
      config: configWithVerify(
        "    test_command: \"true\"\n    mutation:\n      enabled: false\n      command: \"node fake-mutation.js\"\n",
      ),
    }));
    seedChangedFiles(cwd, ["src/foo.js"]);
    const gatePath = seedGateRaw(cwd, "stage-06", base06Gate());

    const r = await stampStage06(cwd, gatePath);
    assert.equal(r.stamp.runs.mutation.ran, false);
    assert.match(r.stamp.runs.mutation.reason, /explicitly overridden off on the refactor track/);
  });
});

// ─── 6. Behavior-preserved bar: a behavior-changing edit fails QA ─────────

describe("35.5: a behavior-changing edit fails the preserved-behavior bar", () => {
  it("stage-06 gate FAILs when the existing test suite no longer passes on refactor", async () => {
    const cwd = track(makeTargetProject({
      config: configWithVerify("    test_command: \"false\"\n"),
    }));
    seedChangedFiles(cwd, ["src/foo.js"]);
    const gatePath = seedGateRaw(cwd, "stage-06", base06Gate());

    const r = await stampStage06(cwd, gatePath);
    assert.equal(r.gate.status, "FAIL", "a broken existing suite must fail the behavior-preserved bar");
    assert.ok(r.gate.blockers.length > 0, "FAIL must carry at least one blocker");
  });

  it("AC-mapping fields stay null (not forced to a boolean) when the bar fails", async () => {
    const cwd = track(makeTargetProject({
      config: configWithVerify("    test_command: \"false\"\n"),
    }));
    seedChangedFiles(cwd, ["src/foo.js"]);
    const gatePath = seedGateRaw(cwd, "stage-06", base06Gate());

    const r = await stampStage06(cwd, gatePath);
    assert.equal(r.gate.all_acceptance_criteria_met, null);
    assert.equal(r.gate.criterion_to_test_mapping_is_one_to_one, null);
  });
});

// ─── 7. --track refactor runs end-to-end on a fixture ──────────────────────

function passGateFor(stageId, extra = {}) {
  return {
    stage: stageId,
    status: "PASS",
    orchestrator: "devteam@test",
    host: "generic",
    track: "refactor",
    timestamp: new Date().toISOString(),
    blockers: [],
    warnings: [],
    ...extra,
  };
}

const STAGE_GATE_EXTRAS = {
  "stage-04": { pr_summaries_written: [], local_verification: ["npm test"] },
  "stage-05": { review_shape: "scoped", required_approvals: 1, approvals: ["backend"], changes_requested: [], escalated_to_principal: false },
  "stage-06": {
    all_acceptance_criteria_met: null,
    criterion_to_test_mapping_is_one_to_one: null,
    tests_total: 1, tests_passed: 1, tests_failed: 0, failing_tests: [],
  },
};

function writeGate(cwd, name, gate) {
  const dir = path.join(cwd, "pipeline", "gates");
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, `${name}.json`), JSON.stringify(gate, null, 2));
}

function writeStageGates(cwd, stageName) {
  const stageDef = getStage(stageName);
  const { rolesForStage } = require(path.join(REPO_ROOT, "core", "pipeline", "stages"));
  const roles = rolesForStage(stageDef, "refactor");
  const extra = STAGE_GATE_EXTRAS[stageDef.stage] || {};
  if (roles.length === 1) {
    writeGate(cwd, stageDef.stage, { ...passGateFor(stageDef.stage, extra), workstream: roles[0] });
  } else {
    for (const role of roles) {
      writeGate(cwd, `${stageDef.stage}.${role}`, { ...passGateFor(stageDef.stage, extra), workstream: role });
    }
  }
}

describe("35.5: --track refactor runs end-to-end on a fixture", () => {
  it("walks build -> peer-review -> qa to pipeline-complete", () => {
    const cwd = track(makeTargetProject({
      config: "routing:\n  default_host: generic\npipeline:\n  default_track: refactor\n",
    }));

    const trace = [];
    for (let i = 0; i < 50; i++) {
      const r = next({ cwd, track: "refactor" });
      trace.push({ action: r.action, name: r.name });
      if (r.action === "pipeline-complete") break;
      if (r.action === "run-stage" || r.action === "continue-stage") {
        writeStageGates(cwd, r.name);
        continue;
      }
      if (r.action === "merge") {
        const m = mergeWorkstreamGates(r.name, { cwd, track: "refactor" });
        assert.equal(m.merged, true, `merge of ${r.name} failed: ${m.reason}`);
        continue;
      }
      throw new Error(`unexpected action "${r.action}" at ${r.name}: ${r.reason}`);
    }
    const names = trace.map((t) => t.name).filter(Boolean);
    assert.ok(names.includes("build"), "build not dispatched");
    assert.ok(names.includes("peer-review"), "peer-review not dispatched");
    assert.ok(names.includes("qa"), "qa not dispatched");
    assert.equal(trace[trace.length - 1].action, "pipeline-complete");

    // peer-review sizing matches nano (single reviewer) -> no merge needed
    const peerActions = trace.filter((t) => t.name === "peer-review").map((t) => t.action);
    assert.ok(!peerActions.includes("merge"), "refactor peer-review should NOT require merge (nano-like sizing)");
  });

  it("leaves a complete audit trail with null AC fields on the qa gate", () => {
    const cwd = track(makeTargetProject({
      config: "routing:\n  default_host: generic\npipeline:\n  default_track: refactor\n",
    }));

    for (let i = 0; i < 50; i++) {
      const r = next({ cwd, track: "refactor" });
      if (r.action === "pipeline-complete") break;
      if (r.action === "run-stage" || r.action === "continue-stage") { writeStageGates(cwd, r.name); continue; }
      if (r.action === "merge") { mergeWorkstreamGates(r.name, { cwd, track: "refactor" }); continue; }
    }

    for (const stageId of ["stage-04", "stage-05", "stage-06"]) {
      const p = path.join(cwd, "pipeline", "gates", `${stageId}.json`);
      assert.ok(fs.existsSync(p), `missing audit trail: ${stageId}.json`);
      const g = JSON.parse(fs.readFileSync(p, "utf8"));
      assert.equal(g.status, "PASS", `${stageId}.json must be PASS for refactor to complete`);
      assert.equal(g.track, "refactor");
    }
    const qaGate = JSON.parse(fs.readFileSync(path.join(cwd, "pipeline", "gates", "stage-06.json"), "utf8"));
    assert.equal(qaGate.all_acceptance_criteria_met, null);
    assert.equal(qaGate.criterion_to_test_mapping_is_one_to_one, null);
  });
});
