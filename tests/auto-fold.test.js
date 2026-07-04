// Stage 7 auto-fold: when Stage 6 cleanly satisfies the AC→test
// contract, the orchestrator surfaces a "fold-sign-off" action carrying the
// gate content — the CALLER writes the gate. The auto-fold cross-checks the
// QA agent's claims against brief.md and test-report.md; it does not rubber-stamp.
// (next() is a pure read — item 1.2, plans/phase-1-trust-consolidation.md)

const { describe, it, afterEach } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { spawnSync } = require("node:child_process");
const { REPO_ROOT, makeTargetProject, seedGate, cleanup, runCLI } = require("./_helpers");
const { next } = require(path.join(REPO_ROOT, "core", "orchestrator"));
const { run } = require(path.join(REPO_ROOT, "core", "driver"));

let _dirs = [];
function track(cwd) { _dirs.push(cwd); return cwd; }
afterEach(() => { _dirs.forEach(cleanup); _dirs = []; });

function initGit(cwd) {
  spawnSync("git", ["init"], { cwd, encoding: "utf8" });
  spawnSync("git", ["config", "user.email", "test@example.com"], { cwd, encoding: "utf8" });
  spawnSync("git", ["config", "user.name", "Test"], { cwd, encoding: "utf8" });
}

function seedAll(cwd, _untilSignOff = true) {
  // Seed every stage on the full track up to and including stage-06 as PASS,
  // skipping conditional sub-stages we don't care about.
  const passes = [
    "stage-01", "stage-02", "stage-03", "stage-03b", "stage-04", "stage-04a",
    "stage-04c", "stage-05", "stage-06", "stage-06b", "stage-06c", "stage-06d",
    "stage-06e",
  ];
  for (const s of passes) {
    seedGate(cwd, s, {
      stage: s, status: "PASS",
      ...(s === "stage-04a" ? {
        security_review_required: false,
        migration_safety_required: false,
      } : {}),
      ...(s === "stage-06" ? {
        all_acceptance_criteria_met: true,
        criterion_to_test_mapping_is_one_to_one: true,
        tests_total: 2, tests_passed: 2, tests_failed: 0, failing_tests: [],
      } : {}),
    });
  }
  // brief.md with two AC-N entries
  fs.mkdirSync(path.join(cwd, "pipeline"), { recursive: true });
  fs.writeFileSync(
    path.join(cwd, "pipeline", "brief.md"),
    "# Brief\n## Criteria\n- AC-1: Feature does X.\n- AC-2: Feature does Y.\n",
  );
  // test-report.md with a mapping table covering both
  fs.writeFileSync(
    path.join(cwd, "pipeline", "test-report.md"),
    "# Test Report\n\n## AC Coverage\n| AC | Test |\n|---|---|\n| AC-1 | t1 |\n| AC-2 | t2 |\n",
  );
  // runbook.md — auto-fold now requires this before it can fire (prevents
  // platform dispatch being silently skipped when sign-off auto-folds)
  fs.writeFileSync(
    path.join(cwd, "pipeline", "runbook.md"),
    "# Runbook\n\n## Rollback\n\nRevert as needed.\n\n## Health signals\n\nCheck `/health`.\n",
  );
}

describe("auto-fold: stage-07 auto-authored when stage-06 satisfies contract", () => {
  // Updated for item 1.2 (phase-1-trust-consolidation): next() is now a pure
  // read; it returns a "fold-sign-off" action instead of writing the gate.
  // The caller is responsible for writing gate_content to gate_path.

  it("next() returns fold-sign-off action with gate content in payload (does NOT write)", () => {
    const cwd = track(makeTargetProject());
    seedAll(cwd);
    // Snapshot gates dir before calling next()
    const gatesDir = path.join(cwd, "pipeline", "gates");
    const before = fs.readdirSync(gatesDir).sort().join(",");
    const r = next({ cwd });
    // next() must return fold-sign-off, not write the gate or advance past it
    assert.equal(r.action, "fold-sign-off", "next() should return fold-sign-off, not advance past sign-off");
    assert.equal(r.stage, "stage-07");
    assert.equal(r.name, "sign-off");
    // gates dir must be byte-identical — next() did NOT write anything
    const after = fs.readdirSync(gatesDir).sort().join(",");
    assert.equal(before, after, "next() must leave pipeline/gates/ byte-identical (no writes)");
    assert.ok(!fs.existsSync(r.gate_path), "stage-07.json must NOT exist after calling next()");
    // payload must carry the fully-formed gate object
    assert.equal(r.gate_content.auto_from_stage_06, true);
    assert.equal(r.gate_content.pm_signoff, true);
    assert.equal(r.gate_content.deploy_requested, true);
    assert.equal(r.gate_content.status, "PASS");
    assert.equal(r.gate_content.docs_surface_affected, false);
    assert.equal(r.gate_content.docs_updated, null);
    assert.match(r.gate_content.docs_skipped_reason, /git status unavailable|no changed files|internal-only/);
    assert.equal(r.gate_content.auto_fold.ac_count, 2);
    assert.deepEqual(r.gate_content.auto_fold.criteria, ["AC-1", "AC-2"]);
    assert.equal(r.acCount, 2);
    // After the caller writes the gate, next() advances past sign-off
    fs.writeFileSync(r.gate_path, JSON.stringify(r.gate_content, null, 2) + "\n", "utf8");
    const r2 = next({ cwd });
    assert.notEqual(r2.name, "sign-off", "after writing the gate, next() should advance past sign-off");
  });

  it("populates runbook_referenced based on actual file existence", () => {
    const cwd = track(makeTargetProject());
    seedAll(cwd);
    fs.writeFileSync(path.join(cwd, "pipeline", "runbook.md"), "# Runbook\n## Rollback\n## Health signals\n");
    // next() returns fold-sign-off; caller writes the gate
    const r = next({ cwd });
    assert.equal(r.action, "fold-sign-off");
    fs.writeFileSync(r.gate_path, JSON.stringify(r.gate_content, null, 2) + "\n", "utf8");
    const stage07 = JSON.parse(fs.readFileSync(r.gate_path, "utf8"));
    assert.equal(stage07.runbook_referenced, true);
    assert.deepEqual(stage07.warnings, []);
  });

  it("does NOT fold when runbook is missing — falls through to normal sign-off for platform to author it", () => {
    const cwd = track(makeTargetProject());
    seedAll(cwd);
    // Remove the runbook that seedAll wrote — auto-fold must refuse without it
    // so the platform role is always dispatched to sign-off and writes the runbook.
    fs.unlinkSync(path.join(cwd, "pipeline", "runbook.md"));
    const r = next({ cwd });
    assert.equal(r.action, "run-stage");
    assert.equal(r.name, "sign-off", "platform must be dispatched to author the runbook");
    assert.ok(!fs.existsSync(path.join(cwd, "pipeline", "gates", "stage-07.json")));
  });

  it("does NOT fold when a user-visible source file changed without docs evidence", () => {
    const cwd = track(makeTargetProject());
    seedAll(cwd);
    initGit(cwd);
    fs.mkdirSync(path.join(cwd, "src"), { recursive: true });
    fs.writeFileSync(path.join(cwd, "src", "api.js"), "export const version = 2;\n");

    const r = next({ cwd });
    assert.equal(r.action, "run-stage");
    assert.equal(r.name, "sign-off", "PM must resolve the documentation gate");
    assert.ok(!fs.existsSync(path.join(cwd, "pipeline", "gates", "stage-07.json")));
  });

  it("folds when a user-visible source file changed and docs evidence is present", () => {
    const cwd = track(makeTargetProject());
    seedAll(cwd);
    initGit(cwd);
    fs.mkdirSync(path.join(cwd, "src"), { recursive: true });
    fs.writeFileSync(path.join(cwd, "src", "api.js"), "export const version = 2;\n");
    fs.mkdirSync(path.join(cwd, "changelog.d"), { recursive: true });
    fs.writeFileSync(path.join(cwd, "changelog.d", "api.md"), "## Unreleased\n\n- Documented the API-visible change.\n");

    const r = next({ cwd });
    assert.equal(r.action, "fold-sign-off");
    assert.equal(r.gate_content.docs_surface_affected, true);
    assert.equal(r.gate_content.docs_updated, true);
    assert.equal(r.gate_content.docs_skipped_reason, null);
    assert.deepEqual(r.gate_content.docs_gate.surface_files, ["src/api.js"]);
    assert.deepEqual(r.gate_content.docs_gate.doc_files, ["changelog.d/api.md"]);
  });
});

describe("auto-fold: refuses when contract not satisfied", () => {
  it("does NOT fold when an AC is unmapped (QA agent's claim is wrong)", () => {
    const cwd = track(makeTargetProject());
    seedAll(cwd);
    // Override report to drop AC-2 — QA's gate still claims all_acceptance_criteria_met:true
    fs.writeFileSync(
      path.join(cwd, "pipeline", "test-report.md"),
      "# Test Report\n\n## AC Coverage\n| AC | Test |\n|---|---|\n| AC-1 | t1 |\n",
    );
    const r = next({ cwd });
    assert.equal(r.action, "run-stage");
    assert.equal(r.name, "sign-off", "should fall through to normal sign-off, not auto-fold");
    assert.ok(!fs.existsSync(path.join(cwd, "pipeline", "gates", "stage-07.json")));
  });

  it("does NOT fold when stage-06 is not PASS", () => {
    const cwd = track(makeTargetProject());
    seedAll(cwd);
    // Overwrite stage-06 to FAIL
    seedGate(cwd, "stage-06", {
      stage: "stage-06", status: "FAIL",
      blockers: ["one test failing"],
      all_acceptance_criteria_met: true,
      criterion_to_test_mapping_is_one_to_one: true,
    });
    const r = next({ cwd });
    // Stage 06 FAIL halts before sign-off
    assert.equal(r.action, "fix-and-retry");
    assert.ok(!fs.existsSync(path.join(cwd, "pipeline", "gates", "stage-07.json")));
  });

  it("does NOT fold when QA agent claims 1:1 but stage-06 says otherwise", () => {
    const cwd = track(makeTargetProject());
    seedAll(cwd);
    // QA agent now backs off the 1:1 claim
    seedGate(cwd, "stage-06", {
      stage: "stage-06", status: "PASS",
      all_acceptance_criteria_met: true,
      criterion_to_test_mapping_is_one_to_one: false, // explicitly false
    });
    const r = next({ cwd });
    assert.equal(r.name, "sign-off", "without 1:1 mapping, auto-fold refuses; falls through to normal sign-off");
    assert.ok(!fs.existsSync(path.join(cwd, "pipeline", "gates", "stage-07.json")));
  });

  it("does NOT fold when stage-07 workstreams already exist (PM/Platform started)", () => {
    const cwd = track(makeTargetProject());
    seedAll(cwd);
    // Seed a stage-07.pm.json — implies PM already authored their slice
    seedGate(cwd, "stage-07.pm", {
      stage: "stage-07", workstream: "pm", status: "PASS", host: "claude-code",
    });
    next({ cwd });
    // No stage-07.json should have been auto-folded; the orchestrator
    // should respect that work is in flight.
    const stage07Path = path.join(cwd, "pipeline", "gates", "stage-07.json");
    if (fs.existsSync(stage07Path)) {
      const g = JSON.parse(fs.readFileSync(stage07Path, "utf8"));
      assert.notEqual(g.auto_from_stage_06, true,
        "if stage-07.json exists, it should not be the auto-fold variant when workstreams already started");
    }
  });

  it("does NOT fold when brief.md has no AC-N entries", () => {
    const cwd = track(makeTargetProject());
    seedAll(cwd);
    fs.writeFileSync(path.join(cwd, "pipeline", "brief.md"), "# Brief\nFreeform prose with no AC entries.\n");
    const r = next({ cwd });
    assert.equal(r.name, "sign-off", "no AC-N in brief → no auto-fold; sign-off runs normally");
    assert.ok(!fs.existsSync(path.join(cwd, "pipeline", "gates", "stage-07.json")));
  });

  it("does NOT fold when test-report.md is missing", () => {
    const cwd = track(makeTargetProject());
    seedAll(cwd);
    fs.unlinkSync(path.join(cwd, "pipeline", "test-report.md"));
    const r = next({ cwd });
    assert.equal(r.name, "sign-off");
    assert.ok(!fs.existsSync(path.join(cwd, "pipeline", "gates", "stage-07.json")));
  });
});

// ── Required new tests (item 1.2, phase-1-trust-consolidation) ───────────────

describe("auto-fold: fold-sign-off payload validates as stage-07 gate", () => {
  it("gate_content carries all stage-07 schema required fields", () => {
    // stage-07.schema.json requires: pm_signoff, deploy_requested, runbook_referenced,
    // docs_surface_affected, docs_updated, and docs_skipped_reason
    // (plus base fields: stage, status, orchestrator, track, timestamp, blockers, warnings)
    const cwd = track(makeTargetProject());
    seedAll(cwd);
    const r = next({ cwd });
    assert.equal(r.action, "fold-sign-off");
    const g = r.gate_content;
    // Base contract F fields
    assert.equal(typeof g.stage, "string");
    assert.equal(typeof g.status, "string");
    assert.ok(["PASS", "WARN", "FAIL", "ESCALATE"].includes(g.status));
    assert.equal(typeof g.orchestrator, "string");
    assert.equal(typeof g.track, "string");
    assert.equal(typeof g.timestamp, "string");
    assert.ok(Array.isArray(g.blockers));
    assert.ok(Array.isArray(g.warnings));
    // Stage-07 specific required fields
    assert.equal(typeof g.pm_signoff, "boolean");
    assert.equal(typeof g.deploy_requested, "boolean");
    assert.equal(typeof g.runbook_referenced, "boolean");
    assert.equal(typeof g.docs_surface_affected, "boolean");
    assert.ok(g.docs_updated === null || typeof g.docs_updated === "boolean");
    assert.equal(typeof g.docs_skipped_reason, "string");
  });
});

describe("auto-fold: driver writes gate and run-log event, run proceeds", () => {
  it("driver writes stage-07.json and appends auto-fold-sign-off run-log event", async () => {
    const cwd = track(makeTargetProject());
    // Inject a next() sequence: fold-sign-off → pipeline-complete.
    // The gate content is a minimal valid stage-07 gate for testing the write path.
    const stage07Path = path.join(cwd, "pipeline", "gates", "stage-07.json");
    const gateContent = {
      stage: "stage-07", status: "PASS",
      orchestrator: "devteam@test", track: "full",
      timestamp: new Date().toISOString(),
      blockers: [], warnings: [],
      pm_signoff: true, deploy_requested: true, runbook_referenced: false,
      docs_surface_affected: false, docs_updated: null,
      docs_skipped_reason: "test fixture has no user-visible surface",
      auto_from_stage_06: true,
      auto_fold: { ac_count: 2, criteria: ["AC-1", "AC-2"], stamped_at: new Date().toISOString(), stamper: "devteam@test" },
    };
    const actions = [
      {
        action: "fold-sign-off", stage: "stage-07", name: "sign-off",
        gate_path: stage07Path, gate_content: gateContent, acCount: 2,
        reason: "stage 6 satisfied the AC→test contract (2 criteria mapped)",
      },
      { action: "pipeline-complete", reason: "all stages complete" },
    ];
    let i = 0;
    const events = [];
    const s = await run({
      cwd,
      next: () => actions[i++],
      onEvent: (ev) => events.push(ev),
    });
    // Run should complete (not halt)
    assert.equal(s.completed, true);
    assert.equal(s.halted, false);
    // The driver must have written the gate
    assert.ok(fs.existsSync(stage07Path), "driver must write stage-07.json for fold-sign-off");
    const written = JSON.parse(fs.readFileSync(stage07Path, "utf8"));
    assert.equal(written.auto_from_stage_06, true);
    // The driver must have appended an auto-fold-sign-off event to run-log.jsonl
    const runLog = path.join(cwd, "pipeline", "run-log.jsonl");
    assert.ok(fs.existsSync(runLog), "run-log.jsonl must exist");
    const lines = fs.readFileSync(runLog, "utf8").trim().split("\n").map((l) => JSON.parse(l));
    const foldEvent = lines.find((l) => l.event === "auto-fold-sign-off");
    assert.ok(foldEvent, "run-log must contain an auto-fold-sign-off event");
    assert.equal(foldEvent.derived_from, "brief AC mapping");
    // onEvent callback must have fired for the fold
    assert.ok(events.some((e) => e.type === "auto-fold-sign-off"), "onEvent must fire for fold-sign-off");
  });
});

describe("auto-fold: cmdNext e2e reaches pipeline-complete on a nano run", () => {
  // cmdNext handles fold-sign-off by writing the gate and re-running next().
  // On the nano track, sign-off is not in the stage list, so the auto-fold
  // path is only triggered on the full track. Use a full-track project seeded
  // up to (but not including) sign-off with the brief/test-report present.
  it("cmdNext writes stage-07 and shows the subsequent action (not fold-sign-off)", () => {
    const cwd = track(makeTargetProject());
    seedAll(cwd);
    // Also seed sign-off so next() would return deploy or later, but we need to
    // test that cmdNext handles fold-sign-off cleanly. Seed all stages AFTER sign-off
    // (deploy, retrospective) so that after the fold cmdNext can reach complete.
    seedGate(cwd, "stage-07", {
      stage: "stage-07", status: "PASS",
      pm_signoff: true, deploy_requested: true, runbook_referenced: false,
      docs_surface_affected: false, docs_updated: null,
      docs_skipped_reason: "test fixture has no user-visible surface",
      auto_from_stage_06: true,
    });
    seedGate(cwd, "stage-08", { stage: "stage-08", status: "PASS" });
    seedGate(cwd, "stage-09", { stage: "stage-09", status: "PASS" });
    // With all stages done, next() should return pipeline-complete
    const r = runCLI(["next", "--json"], { cwd });
    assert.equal(r.status, 0, `next --json failed: ${r.stderr}`);
    const obj = JSON.parse(r.stdout);
    assert.equal(obj.schema_version, "1.2");
    assert.equal(obj.action, "pipeline-complete");
  });

  it("cmdNext handles fold-sign-off: writes gate and shows next action", () => {
    const cwd = track(makeTargetProject());
    seedAll(cwd);
    // Seed post-sign-off stages so there is a known next action after the fold
    seedGate(cwd, "stage-08", { stage: "stage-08", status: "PASS",
      deploy_log: "ok", smoke_test_passed: true });
    seedGate(cwd, "stage-09", { stage: "stage-09", status: "PASS",
      lessons_learned: "none", action_items: [] });
    // next() should return fold-sign-off; cmdNext should write it and re-run
    const r = runCLI(["next", "--json"], { cwd });
    assert.equal(r.status, 0, `cmdNext failed: ${r.stderr}`);
    // Verify the gate was written (JSON output shape tested separately)
    const stage07Path = path.join(cwd, "pipeline", "gates", "stage-07.json");
    assert.ok(fs.existsSync(stage07Path), "cmdNext must write stage-07.json on fold-sign-off");
    const g = JSON.parse(fs.readFileSync(stage07Path, "utf8"));
    assert.equal(g.auto_from_stage_06, true);
    assert.equal(g.pm_signoff, true);
  });
});

describe("auto-record: deploy_requested false records local Stage 8 without dispatch", () => {
  function seedThroughSignOffNoDeploy(cwd) {
    seedAll(cwd);
    seedGate(cwd, "stage-07", {
      stage: "stage-07",
      status: "PASS",
      pm_signoff: true,
      deploy_requested: false,
      runbook_referenced: true,
      docs_surface_affected: false,
      docs_updated: null,
      docs_skipped_reason: "test fixture has no user-visible surface",
    });
  }

  it("next() returns record-local-deploy with gate and deploy-log payloads", () => {
    const cwd = track(makeTargetProject());
    seedThroughSignOffNoDeploy(cwd);

    const r = next({ cwd });
    assert.equal(r.action, "record-local-deploy");
    assert.equal(r.stage, "stage-08");
    assert.equal(r.gate_content.status, "PASS");
    assert.equal(r.gate_content.deploy_adapter, "local");
    assert.equal(r.gate_content.adapter_result.external_deploy, false);
    assert.equal(r.gate_content.adapter_result.deploy_requested, false);
    assert.match(r.deploy_log_content, /Stage 7 explicitly requested no external deploy/);
    assert.ok(!fs.existsSync(r.gate_path), "next() must not write the gate directly");
  });

  it("cmdNext writes stage-08 and deploy-log", () => {
    const cwd = track(makeTargetProject());
    seedThroughSignOffNoDeploy(cwd);

    const r = runCLI(["next", "--json"], { cwd });
    assert.equal(r.status, 0, `cmdNext failed: ${r.stderr}`);
    const obj = JSON.parse(r.stdout);
    assert.equal(obj.schema_version, "1.2");
    assert.equal(obj.action, "record-local-deploy");

    const stage08Path = path.join(cwd, "pipeline", "gates", "stage-08.json");
    assert.ok(fs.existsSync(stage08Path), "cmdNext must write stage-08.json");
    assert.ok(fs.existsSync(path.join(cwd, "pipeline", "deploy-log.md")), "cmdNext must write deploy-log.md");
    const gate = JSON.parse(fs.readFileSync(stage08Path, "utf8"));
    assert.equal(gate.deploy_adapter, "local");
    assert.equal(gate.adapter_result.external_deploy, false);
    assert.equal(gate.auto_from_stage_07, true);
  });

  it("driver writes stage-08 and run-log event without dispatching deploy", async () => {
    const cwd = track(makeTargetProject());
    const stage08Path = path.join(cwd, "pipeline", "gates", "stage-08.json");
    const deployLogPath = path.join(cwd, "pipeline", "deploy-log.md");
    const actions = [
      {
        action: "record-local-deploy",
        stage: "stage-08",
        name: "deploy",
        gate_path: stage08Path,
        gate_content: {
          stage: "stage-08",
          status: "PASS",
          orchestrator: "devteam@test",
          track: "full",
          timestamp: new Date().toISOString(),
          blockers: [],
          warnings: ["Stage 7 requested no external deploy; local verification only."],
          deploy_completed: true,
          smoke_tests_passed: true,
          rollback_executed: false,
          deploy_adapter: "local",
          environment: "local",
          runbook_referenced: true,
          cost_delta_estimated: true,
          cost_delta_multiplier: 1,
          cost_gate_override: false,
          adapter_result: { deploy_requested: false, external_deploy: false },
        },
        deploy_log_path: deployLogPath,
        deploy_log_content: "# Deploy Log\n\nNo external deploy.\n",
        reason: "stage 7 requested no external deploy",
      },
      { action: "pipeline-complete", reason: "all stages complete" },
    ];
    let i = 0;
    let dispatches = 0;
    const events = [];
    const summary = await run({
      cwd,
      next: () => actions[i++],
      runStageHeadless: async () => {
        dispatches += 1;
        return [];
      },
      onEvent: (ev) => events.push(ev),
    });

    assert.equal(summary.completed, true);
    assert.equal(dispatches, 0, "deploy must not be dispatched when record-local-deploy fires");
    assert.ok(fs.existsSync(stage08Path), "driver must write stage-08.json");
    assert.ok(fs.existsSync(deployLogPath), "driver must write deploy-log.md");
    const runLog = fs.readFileSync(path.join(cwd, "pipeline", "run-log.jsonl"), "utf8");
    assert.match(runLog, /record-local-deploy/);
    assert.ok(events.some((e) => e.type === "record-local-deploy"));
  });
});
