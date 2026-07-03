const { describe, it, afterEach } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { makeTargetProject, cleanup } = require("./_helpers");
const { stamp, stampStage03b, stampStage04a, stampStage06, extractAcsFromBrief } =
  require("../core/verify/stamp");

let _dirs = [];
function track(cwd) { _dirs.push(cwd); return cwd; }
afterEach(() => { _dirs.forEach(cleanup); _dirs = []; });

function seedGateRaw(cwd, name, content) {
  const dir = path.join(cwd, "pipeline", "gates");
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, `${name}.json`);
  fs.writeFileSync(file, JSON.stringify(content, null, 2));
  return file;
}

function configWith(verify) {
  return `routing:\n  default_host: generic\npipeline:\n  default_track: full\n  verify:\n${
    Object.entries(verify).map(([k, v]) => `    ${k}: ${JSON.stringify(v)}`).join("\n")
  }\n`;
}

describe("verify/stamp: extractAcsFromBrief", () => {
  it("finds AC-N in plain bullet form", () => {
    const text = "## Acceptance criteria\n- AC-1: foo\n- AC-2: bar\n- AC-3: baz\n";
    assert.deepEqual(extractAcsFromBrief(text), ["AC-1", "AC-2", "AC-3"]);
  });

  it("finds AC-N in bolded form", () => {
    const text = "**AC-1** — first\n**AC-2** — second\n";
    assert.deepEqual(extractAcsFromBrief(text), ["AC-1", "AC-2"]);
  });

  it("deduplicates: AC-N defined once even if mentioned in prose", () => {
    const text = "## Acceptance Criteria\n- AC-1: foo\n- AC-2: bar\n\nSee AC-1 for prior context.";
    assert.deepEqual(extractAcsFromBrief(text), ["AC-1", "AC-2"]);
  });

  it("returns empty for a brief with no AC-N references", () => {
    assert.deepEqual(extractAcsFromBrief("# Title\nProse only."), []);
  });

  it("does not extract AC-N that appears only as a prose cross-reference", () => {
    // Regression: brief says "existing AC-1 through AC-12" and word-wrap lands
    // AC-12 at the start of a line — must not produce orphan_criteria=[AC-12].
    const text = [
      "## Acceptance Criteria",
      "**AC-4** — Falls back to git diff --cached, preserving all existing",
      "behaviour unchanged (existing AC-1 through",
      "AC-12 from the initial build brief continue to apply).",
    ].join("\n");
    assert.deepEqual(extractAcsFromBrief(text), ["AC-4"]);
  });
});

describe("verify/stamp: stampStage04a — happy path", () => {
  it("stamps lint_passed=true when lint command exits 0", async () => {
    const cwd = track(makeTargetProject({
      config: configWith({ lint_command: "true", test_command: "true" }),
    }));
    const gatePath = seedGateRaw(cwd, "stage-04a", {
      stage: "stage-04a", status: "PASS", orchestrator: "devteam@test", host: "generic",
      track: "full", timestamp: "2026-06-02T12:00:00Z",
      blockers: [], warnings: [],
      lint_passed: true, tests_passed: true,
      dependency_review_passed: true, security_review_required: false,
    });
    const r = await stampStage04a(cwd, gatePath);
    assert.equal(r.ok, true);
    assert.equal(r.gate.status, "PASS");
    assert.equal(r.gate.lint_passed, true);
    assert.equal(r.gate.tests_passed, true);
    assert.ok(r.gate._orchestrator_stamped);
    assert.ok(r.gate._orchestrator_stamped.runs.lint);
    assert.equal(r.gate._orchestrator_stamped.runs.lint.exit_code, 0);
  });

  it("flips status to FAIL when lint exits non-zero (model claimed PASS)", async () => {
    const cwd = track(makeTargetProject({
      config: configWith({ lint_command: "false", test_command: "true" }),
    }));
    const gatePath = seedGateRaw(cwd, "stage-04a", {
      stage: "stage-04a", status: "PASS", orchestrator: "devteam@test", host: "generic",
      track: "full", timestamp: "2026-06-02T12:00:00Z",
      blockers: [], warnings: [],
      lint_passed: true, tests_passed: true, // model lied / was optimistic
      dependency_review_passed: true, security_review_required: false,
    });
    const r = await stampStage04a(cwd, gatePath);
    assert.equal(r.gate.status, "FAIL", "status must flip when lint actually fails");
    assert.equal(r.gate.lint_passed, false);
    assert.ok(r.gate.blockers.some((b) => /lint failed/.test(b)), "blocker recorded");
    const overrideField = r.gate._orchestrator_stamped.fields.find((f) => f.field === "lint_passed");
    assert.equal(overrideField.model_said, true);
    assert.equal(overrideField.orchestrator, false);
    assert.ok(r.gate._orchestrator_stamped.status_overridden, "status_overridden audit entry present");
  });

  it("records skipped runs when commands aren't configured", async () => {
    const cwd = track(makeTargetProject()); // default config — no verify section, no package.json
    const gatePath = seedGateRaw(cwd, "stage-04a", {
      stage: "stage-04a", status: "PASS", orchestrator: "devteam@test", host: "generic",
      track: "full", timestamp: "2026-06-02T12:00:00Z",
      blockers: [], warnings: [],
      lint_passed: true, tests_passed: true,
      dependency_review_passed: true, security_review_required: false,
    });
    const r = await stampStage04a(cwd, gatePath);
    assert.equal(r.ok, true);
    assert.match(r.gate._orchestrator_stamped.runs.lint.skipped, /no lint command/);
    assert.match(r.gate._orchestrator_stamped.runs.test.skipped, /no test command/);
    assert.equal(r.gate.status, "PASS", "skipped runs don't flip status");
  });

  // Audit P2-7: middle path of the command-resolution fall-through chain.
  // Unit-tested in verify-runner.test.js for resolveCommands directly;
  // this exercises it through the full stamping flow to catch any
  // wiring break between resolveCommands and the stamp logic.
  it("falls back to package.json scripts.lint / scripts.test when .devteam/config.yml has no verify section", async () => {
    // makeTargetProject's default config has no pipeline.verify.*
    const cwd = track(makeTargetProject());
    // Add a package.json with lint + test scripts that both succeed.
    fs.writeFileSync(
      path.join(cwd, "package.json"),
      JSON.stringify({ name: "test-fixture", scripts: { lint: "true", test: "true" } }, null, 2),
    );
    const gatePath = seedGateRaw(cwd, "stage-04a", {
      stage: "stage-04a", status: "PASS", orchestrator: "devteam@test", host: "generic",
      track: "full", timestamp: "2026-06-02T12:00:00Z",
      blockers: [], warnings: [],
      lint_passed: true, tests_passed: true,
      dependency_review_passed: true, security_review_required: false,
    });
    const r = await stampStage04a(cwd, gatePath);
    assert.equal(r.ok, true);
    // Both should resolve to "npm run lint" / "npm test" and exit 0.
    assert.equal(r.gate._orchestrator_stamped.runs.lint.exit_code, 0,
      "lint resolved from package.json scripts.lint and ran cleanly");
    assert.equal(r.gate._orchestrator_stamped.runs.test.exit_code, 0,
      "test resolved from package.json scripts.test and ran cleanly");
    // Should NOT show "skipped" — fall-through worked.
    assert.ok(!("skipped" in r.gate._orchestrator_stamped.runs.lint),
      "lint should not be skipped when package.json provides a script");
    assert.ok(!("skipped" in r.gate._orchestrator_stamped.runs.test),
      "test should not be skipped when package.json provides a script");
    assert.equal(r.gate.status, "PASS");
  });
});

describe("verify/stamp: stampStage06 — AC mapping", () => {
  function seedBrief(cwd, content) {
    fs.mkdirSync(path.join(cwd, "pipeline"), { recursive: true });
    fs.writeFileSync(path.join(cwd, "pipeline", "brief.md"), content);
  }
  function seedReport(cwd, content) {
    fs.mkdirSync(path.join(cwd, "pipeline"), { recursive: true });
    fs.writeFileSync(path.join(cwd, "pipeline", "test-report.md"), content);
  }

  it("PASSes when every AC in brief is covered by the test report", async () => {
    const cwd = track(makeTargetProject({
      config: configWith({ test_command: "true" }),
    }));
    seedBrief(cwd, "## Criteria\n- AC-1: foo\n- AC-2: bar\n");
    seedReport(cwd, "| AC | Test |\n|---|---|\n| AC-1 | t1 |\n| AC-2 | t2 |\n");
    const gatePath = seedGateRaw(cwd, "stage-06", {
      stage: "stage-06", status: "PASS", orchestrator: "devteam@test", host: "generic",
      track: "full", timestamp: "2026-06-02T12:00:00Z",
      blockers: [], warnings: [],
      all_acceptance_criteria_met: true,
      tests_total: 2, tests_passed: 2, tests_failed: 0, failing_tests: [],
      criterion_to_test_mapping_is_one_to_one: true,
    });
    const r = await stampStage06(cwd, gatePath);
    assert.equal(r.gate.status, "PASS");
    assert.equal(r.gate.all_acceptance_criteria_met, true);
    assert.equal(r.gate._orchestrator_stamped.runs.test.command, "true");
    assert.equal("suites" in r.gate._orchestrator_stamped.runs.test, false);
  });

  it("discovers and aggregates Node, pytest, and Go suites", { skip: process.platform === "win32" }, async () => {
    const cwd = track(makeTargetProject());
    fs.writeFileSync(path.join(cwd, "package.json"), JSON.stringify({
      name: "polyglot-fixture", scripts: { test: "node -e \"process.exit(0)\"" },
    }));
    fs.writeFileSync(path.join(cwd, "pytest.ini"), "[pytest]\n");
    fs.writeFileSync(path.join(cwd, "go.mod"), "module example.test/polyglot\n\ngo 1.22\n");
    const bin = path.join(cwd, "fake-bin");
    fs.mkdirSync(bin);
    for (const command of ["python3", "go"]) {
      const file = path.join(bin, command);
      fs.writeFileSync(file, "#!/bin/sh\nexit 0\n");
      fs.chmodSync(file, 0o755);
    }
    const gatePath = seedGateRaw(cwd, "stage-06", {
      stage: "stage-06", status: "PASS", orchestrator: "devteam@test", host: "generic",
      track: "full", timestamp: "2026-06-19T12:00:00Z",
      blockers: [], warnings: [], all_acceptance_criteria_met: true,
      tests_total: 3, tests_passed: 3, tests_failed: 0, failing_tests: [],
      criterion_to_test_mapping_is_one_to_one: true,
    });
    const originalPath = process.env.PATH;
    process.env.PATH = `${bin}${path.delimiter}${originalPath}`;
    try {
      const result = await stampStage06(cwd, gatePath);
      assert.equal(result.gate.status, "PASS");
      assert.equal(result.gate._orchestrator_stamped.runs.test.exit_code, 0);
      assert.deepEqual(
        result.gate._orchestrator_stamped.runs.test.suites.map((suite) => suite.id),
        ["node", "python", "go"],
      );
    } finally {
      process.env.PATH = originalPath;
    }
  });

  it("stamps configured suite resource groups and stable suite order", async () => {
    const cwd = track(makeTargetProject({
      config: configWith({
        test_concurrency: 2,
        test_suites: [
          { id: "slow", command: "node slow.js", resource_group: "browser" },
          { id: "fast", command: "node fast.js" },
        ],
      }),
    }));
    fs.writeFileSync(path.join(cwd, "slow.js"), "setTimeout(()=>{}, 80)");
    fs.writeFileSync(path.join(cwd, "fast.js"), "setTimeout(()=>{}, 10)");
    seedBrief(cwd, "## Criteria\n- AC-1: foo\n");
    seedReport(cwd, "| AC | Test |\n|---|---|\n| AC-1 | t1 |\n");
    const gatePath = seedGateRaw(cwd, "stage-06", {
      stage: "stage-06", status: "PASS", orchestrator: "devteam@test", host: "generic",
      track: "full", timestamp: "2026-06-19T12:00:00Z",
      blockers: [], warnings: [], all_acceptance_criteria_met: true,
      tests_total: 2, tests_passed: 2, tests_failed: 0, failing_tests: [],
      criterion_to_test_mapping_is_one_to_one: true,
    });
    const result = await stampStage06(cwd, gatePath);
    const suites = result.gate._orchestrator_stamped.runs.test.suites;
    assert.equal(result.gate.status, "PASS");
    assert.deepEqual(suites.map((suite) => suite.id), ["slow", "fast"]);
    assert.equal(suites[0].resource_group, "browser");
    assert.equal(suites[1].resource_group, undefined);
  });

  it("records and reuses successful verification receipts in gate provenance", async () => {
    const cwd = track(makeTargetProject({
      config: configWith({
        test_suites: [
          { id: "unit", command: "node test.js" },
        ],
      }),
    }));
    fs.writeFileSync(path.join(cwd, "test.js"), `
      const fs = require('node:fs');
      fs.mkdirSync('pipeline', { recursive: true });
      const file = 'pipeline/count.txt';
      const n = fs.existsSync(file) ? Number(fs.readFileSync(file, 'utf8')) : 0;
      fs.writeFileSync(file, String(n + 1));
    `);
    seedBrief(cwd, "## Criteria\n- AC-1: foo\n");
    seedReport(cwd, "| AC | Test |\n|---|---|\n| AC-1 | unit |\n");
    const gatePath = seedGateRaw(cwd, "stage-06", {
      stage: "stage-06", status: "PASS", orchestrator: "devteam@test", host: "generic",
      track: "full", timestamp: "2026-06-19T12:00:00Z",
      blockers: [], warnings: [], all_acceptance_criteria_met: true,
      tests_total: 1, tests_passed: 1, tests_failed: 0, failing_tests: [],
      criterion_to_test_mapping_is_one_to_one: true,
    });

    const first = await stampStage06(cwd, gatePath);
    const second = await stampStage06(cwd, gatePath);
    const firstReceipt = first.gate._orchestrator_stamped.runs.test.receipt;
    const secondReceipt = second.gate._orchestrator_stamped.runs.test.receipt;

    assert.equal(firstReceipt.reused, false);
    assert.equal(secondReceipt.reused, true);
    assert.match(secondReceipt.digest, /^sha256:/);
    assert.equal(fs.readFileSync(path.join(cwd, "pipeline", "count.txt"), "utf8"), "1");
  });

  it("honors pipeline.verify.receipts=false by rerunning instead of reusing", async () => {
    const cwd = track(makeTargetProject({
      config: configWith({
        receipts: false,
        test_suites: [
          { id: "unit", command: "node test.js" },
        ],
      }),
    }));
    fs.writeFileSync(path.join(cwd, "test.js"), `
      const fs = require('node:fs');
      fs.mkdirSync('pipeline', { recursive: true });
      const file = 'pipeline/count.txt';
      const n = fs.existsSync(file) ? Number(fs.readFileSync(file, 'utf8')) : 0;
      fs.writeFileSync(file, String(n + 1));
    `);
    seedBrief(cwd, "## Criteria\n- AC-1: foo\n");
    seedReport(cwd, "| AC | Test |\n|---|---|\n| AC-1 | unit |\n");
    const gatePath = seedGateRaw(cwd, "stage-06", {
      stage: "stage-06", status: "PASS", orchestrator: "devteam@test", host: "generic",
      track: "full", timestamp: "2026-06-19T12:00:00Z",
      blockers: [], warnings: [], all_acceptance_criteria_met: true,
      tests_total: 1, tests_passed: 1, tests_failed: 0, failing_tests: [],
      criterion_to_test_mapping_is_one_to_one: true,
    });

    const first = await stampStage06(cwd, gatePath);
    const second = await stampStage06(cwd, gatePath);

    assert.equal(first.gate._orchestrator_stamped.runs.test.receipt, undefined);
    assert.equal(second.gate._orchestrator_stamped.runs.test.receipt, undefined);
    assert.equal(fs.readFileSync(path.join(cwd, "pipeline", "count.txt"), "utf8"), "2");
  });

  it("flips status to FAIL when an AC is unmapped (model claimed met)", async () => {
    const cwd = track(makeTargetProject({
      config: configWith({ test_command: "true" }),
    }));
    seedBrief(cwd, "## Criteria\n- AC-1: foo\n- AC-2: bar\n- AC-3: baz\n");
    seedReport(cwd, "| AC | Test |\n|---|---|\n| AC-1 | t1 |\n| AC-2 | t2 |\n"); // AC-3 missing
    const gatePath = seedGateRaw(cwd, "stage-06", {
      stage: "stage-06", status: "PASS", orchestrator: "devteam@test", host: "generic",
      track: "full", timestamp: "2026-06-02T12:00:00Z",
      blockers: [], warnings: [],
      all_acceptance_criteria_met: true, // model claim
      tests_total: 2, tests_passed: 2, tests_failed: 0, failing_tests: [],
      criterion_to_test_mapping_is_one_to_one: true,
    });
    const r = await stampStage06(cwd, gatePath);
    assert.equal(r.gate.status, "FAIL");
    assert.equal(r.gate.all_acceptance_criteria_met, false);
    assert.ok(r.gate.blockers.some((b) => /unmapped/.test(b) && /AC-3/.test(b)));
  });

  it("flips status to FAIL when test command fails (model claimed PASS)", async () => {
    const cwd = track(makeTargetProject({
      config: configWith({ test_command: "false" }),
    }));
    seedBrief(cwd, "## Criteria\n- AC-1: foo\n");
    seedReport(cwd, "| AC | Test |\n|---|---|\n| AC-1 | t1 |\n");
    const gatePath = seedGateRaw(cwd, "stage-06", {
      stage: "stage-06", status: "PASS", orchestrator: "devteam@test", host: "generic",
      track: "full", timestamp: "2026-06-02T12:00:00Z",
      blockers: [], warnings: [],
      all_acceptance_criteria_met: true,
      tests_total: 1, tests_passed: 1, tests_failed: 0, failing_tests: [],
      criterion_to_test_mapping_is_one_to_one: true,
    });
    const r = await stampStage06(cwd, gatePath);
    assert.equal(r.gate.status, "FAIL");
    assert.ok(r.gate.blockers.some((b) => /test command failed/.test(b)));
  });

  it("skips AC mapping when brief.md is absent (hotfix/nano track)", async () => {
    const cwd = track(makeTargetProject({
      config: configWith({ test_command: "true" }),
    }));
    // No brief.md
    const gatePath = seedGateRaw(cwd, "stage-06", {
      stage: "stage-06", status: "PASS", orchestrator: "devteam@test", host: "generic",
      track: "nano", timestamp: "2026-06-02T12:00:00Z",
      blockers: [], warnings: [],
      all_acceptance_criteria_met: true,
      tests_total: 1, tests_passed: 1, tests_failed: 0, failing_tests: [],
      criterion_to_test_mapping_is_one_to_one: true,
    });
    const r = await stampStage06(cwd, gatePath);
    assert.equal(r.gate.status, "PASS");
    assert.match(r.gate._orchestrator_stamped.runs.ac_mapping.skipped, /brief\.md not found/);
  });
});

describe("verify/stamp: stampStage03b — spec drift detection", () => {
  function seedBrief(cwd, content) {
    fs.mkdirSync(path.join(cwd, "pipeline"), { recursive: true });
    fs.writeFileSync(path.join(cwd, "pipeline", "brief.md"), content);
  }
  function seedSpec(cwd, content) {
    fs.mkdirSync(path.join(cwd, "pipeline"), { recursive: true });
    fs.writeFileSync(path.join(cwd, "pipeline", "spec.feature"), content);
  }
  function seedGate03b(cwd, extra = {}) {
    return seedGateRaw(cwd, "stage-03b", {
      stage: "stage-03b", status: "PASS", orchestrator: "devteam@test", host: "generic",
      track: "full", timestamp: "2026-06-13T12:00:00Z",
      blockers: [], warnings: [],
      criteria_count: 0,
      scenarios_count: 0,
      criteria_to_scenario_mapping: [],
      all_criteria_mapped: false,
      orphan_scenarios: [],
      orphan_criteria: [],
      drift: false,
      ...extra,
    });
  }
  const BRIEF_2ACS = "## ACs\n- AC-1: user can sign in\n- AC-2: user can reset password\n";
  const SPEC_2ACS  =
    "Feature: auth\n  @AC-1\n  Scenario: AC-1 — sign in\n    Given a user exists\n    When they sign in\n    Then session created\n" +
    "  @AC-2\n  Scenario: AC-2 — reset password\n    Given a user exists\n    When they reset\n    Then email sent\n";

  it("stamps all gate fields from actual brief + spec (happy path)", async () => {
    const cwd = track(makeTargetProject());
    seedBrief(cwd, BRIEF_2ACS);
    seedSpec(cwd, SPEC_2ACS);
    const gatePath = seedGate03b(cwd);
    const r = await stampStage03b(cwd, gatePath);
    assert.equal(r.ok, true);
    assert.equal(r.gate.criteria_count, 2);
    assert.equal(r.gate.scenarios_count, 2);
    assert.equal(r.gate.all_criteria_mapped, true);
    assert.equal(r.gate.drift, false);
    assert.deepEqual(r.gate.orphan_criteria, []);
    assert.deepEqual(r.gate.orphan_scenarios, []);
    assert.equal(r.gate.criteria_to_scenario_mapping.length, 2);
    const ac1 = r.gate.criteria_to_scenario_mapping.find((m) => m.criterion_id === "AC-1");
    assert.ok(ac1, "AC-1 mapping present");
    assert.ok(ac1.scenarios.some((s) => /sign in/.test(s)), "AC-1 scenario name present");
    assert.ok(r.gate._orchestrator_stamped);
    assert.equal(r.gate._orchestrator_stamped.runs.spec_verify.drift, false);
  });

  it("flips status to FAIL and records model_said when drift detected (model claimed PASS)", async () => {
    const cwd = track(makeTargetProject());
    seedBrief(cwd, "## ACs\n- AC-1: a\n- AC-2: b\n");
    seedSpec(cwd, "Feature: x\n  @AC-1\n  Scenario: AC-1\n    Then ok\n"); // AC-2 missing
    const gatePath = seedGate03b(cwd, {
      status: "PASS",
      all_criteria_mapped: true, // model claimed mapped
      drift: false,              // model claimed no drift
    });
    const r = await stampStage03b(cwd, gatePath);
    assert.equal(r.gate.status, "FAIL", "status must flip to FAIL when drift found");
    assert.equal(r.gate.drift, true);
    assert.equal(r.gate.all_criteria_mapped, false);
    assert.ok(r.gate.orphan_criteria.includes("AC-2"), "AC-2 is orphan");
    const driftField = r.gate._orchestrator_stamped.fields.find((f) => f.field === "drift");
    assert.equal(driftField.model_said, false, "model_said=false recorded");
    assert.equal(driftField.orchestrator, true, "orchestrator=true recorded");
    assert.ok(r.gate._orchestrator_stamped.status_overridden, "status_overridden audit present");
    assert.ok(r.gate.blockers.some((b) => /spec drift/.test(b)), "drift blocker added");
  });

  it("generates scaffold and records it when spec.feature is absent", async () => {
    const cwd = track(makeTargetProject());
    seedBrief(cwd, "## ACs\n- AC-1: sign in\n");
    // No spec.feature — stamper should generate one
    const gatePath = seedGate03b(cwd);
    const r = await stampStage03b(cwd, gatePath);
    assert.equal(r.ok, true);
    // Scaffold was generated
    assert.ok(r.gate._orchestrator_stamped.runs.spec_generate.generated, "scaffold generated");
    // Even a generated scaffold has all_criteria_mapped=false (Given/When/Then are TODOs)
    // but criteria_count should reflect the brief
    assert.equal(r.gate.criteria_count, 1);
    // The spec.feature should now exist on disk
    assert.ok(fs.existsSync(path.join(cwd, "pipeline", "spec.feature")));
  });

  it("does NOT drift when a stale test-report.md from a prior feature run is present", async () => {
    const cwd = track(makeTargetProject());
    seedBrief(cwd, BRIEF_2ACS);
    seedSpec(cwd, SPEC_2ACS);
    // Stale test-report from a previous feature referencing ACs that don't match the new brief
    fs.writeFileSync(
      path.join(cwd, "pipeline", "test-report.md"),
      "| AC-9 | old feature test | PASS |\n| AC-10 | old feature test | PASS |\n",
    );
    const gatePath = seedGate03b(cwd);
    const r = await stampStage03b(cwd, gatePath);
    assert.equal(r.ok, true);
    assert.equal(r.gate.drift, false, "stale test-report must not cause drift in stage-03b");
    assert.equal(r.gate.status, "PASS", "status must remain PASS");
    assert.equal(r.gate._orchestrator_stamped.runs.spec_verify.orphan_in_tests_count, 0);
    assert.equal(r.gate._orchestrator_stamped.runs.spec_verify.unknown_in_tests_count, 0);
  });

  it("records orphan_in_tests_count and unknown_in_tests_count in spec_verify run (always zero in 03b)", async () => {
    const cwd = track(makeTargetProject());
    seedBrief(cwd, BRIEF_2ACS);
    seedSpec(cwd, SPEC_2ACS);
    const gatePath = seedGate03b(cwd);
    const r = await stampStage03b(cwd, gatePath);
    assert.equal(r.ok, true);
    assert.equal(typeof r.gate._orchestrator_stamped.runs.spec_verify.orphan_in_tests_count, "number");
    assert.equal(typeof r.gate._orchestrator_stamped.runs.spec_verify.unknown_in_tests_count, "number");
  });

  it("skips brief-dependent logic when pipeline/brief.md is absent", async () => {
    const cwd = track(makeTargetProject());
    // No brief.md, no spec.feature
    const gatePath = seedGate03b(cwd);
    const r = await stampStage03b(cwd, gatePath);
    assert.equal(r.ok, true);
    assert.match(r.gate._orchestrator_stamped.runs.spec_verify.skipped, /brief\.md not found/);
    // No status flip — stamper degrades gracefully
    assert.equal(r.gate.status, "PASS");
  });

  it("records model_said vs orchestrator when gate counts disagree", async () => {
    const cwd = track(makeTargetProject());
    seedBrief(cwd, BRIEF_2ACS);
    seedSpec(cwd, SPEC_2ACS);
    const gatePath = seedGate03b(cwd, {
      criteria_count: 99,  // wrong model value
      scenarios_count: 99,
    });
    const r = await stampStage03b(cwd, gatePath);
    const ccField = r.gate._orchestrator_stamped.fields.find((f) => f.field === "criteria_count");
    assert.equal(ccField.model_said, 99, "model_said captured");
    assert.equal(ccField.orchestrator, 2, "orchestrator observed 2");
    assert.equal(r.gate.criteria_count, 2, "gate overwritten with orchestrator value");
  });

  it("dispatch: stage-03b is stampable and round-trips through stamp()", async () => {
    const cwd = track(makeTargetProject());
    seedBrief(cwd, BRIEF_2ACS);
    seedSpec(cwd, SPEC_2ACS);
    seedGate03b(cwd);
    const r = await stamp(cwd, "stage-03b");
    assert.equal(r.ok, true, r.error);
    assert.equal(r.gate.drift, false);
  });
});

describe("verify/stamp: dispatch", () => {
  it("rejects unknown stage", async () => {
    const cwd = track(makeTargetProject());
    const r = await stamp(cwd, "stage-99");
    assert.equal(r.ok, false);
    assert.match(r.error, /no orchestrator stamping defined/);
  });

  it("rejects missing gate", async () => {
    const cwd = track(makeTargetProject());
    const r = await stamp(cwd, "stage-04a");
    assert.equal(r.ok, false);
    assert.match(r.error, /gate not found/);
  });
});

// ─── ADR-009 Phase 3: reproduction tri-state (stage-03b repair mode) ─────────

describe("verify/stamp: stampStage03b — reproduction tri-state (ADR-009 Phase 3)", () => {
  function seedBrief(cwd, content) {
    fs.mkdirSync(path.join(cwd, "pipeline"), { recursive: true });
    fs.writeFileSync(path.join(cwd, "pipeline", "brief.md"), content);
  }
  function seedSpec(cwd, content) {
    fs.mkdirSync(path.join(cwd, "pipeline"), { recursive: true });
    fs.writeFileSync(path.join(cwd, "pipeline", "spec.feature"), content);
  }
  function seedGate03bRepair(cwd, extra = {}) {
    return seedGateRaw(cwd, "stage-03b", {
      stage: "stage-03b", status: "PASS", orchestrator: "devteam@test", host: "generic",
      track: "hotfix", timestamp: "2026-06-15T00:00:00Z",
      blockers: [], warnings: [],
      criteria_count: 0, scenarios_count: 0, criteria_to_scenario_mapping: [],
      all_criteria_mapped: false, orphan_scenarios: [], orphan_criteria: [], drift: false,
      reproduced: false, // repair mode sentinel
      ...extra,
    });
  }

  it("unverifiable bug adds loud WARN, does NOT add a blocker, and never silent-passes", async () => {
    const cwd = track(makeTargetProject());
    seedBrief(cwd, "## Regression\n- RC-1: OAuth token refresh fails after 24 h\n");
    const unverifiableReason = "unverifiable: external OAuth provider not reproducible in test environment";
    const gatePath = seedGate03bRepair(cwd, { reproduced: unverifiableReason });
    const r = await stampStage03b(cwd, gatePath);
    assert.equal(r.ok, true);
    // reproduced field kept as-is (the string value from the model)
    assert.equal(r.gate.reproduced, unverifiableReason);
    // WARN must be present and loud — never silent-pass
    assert.ok(
      r.gate.warnings.some((w) => /WARN reproduction-unverifiable/.test(w)),
      "a loud WARN must be added for unverifiable reproduction",
    );
    // No blocker — run proceeds past the unverifiable stage
    assert.ok(
      !r.gate.blockers.some((b) => /reproduction/.test(b)),
      "unverifiable reproduction must NOT add a blocker (run proceeds)",
    );
    // Stamp audit records the unverifiable result
    assert.equal(r.gate._orchestrator_stamped.runs.reproduction_pre_build.unverifiable, true);
    assert.equal(r.gate._orchestrator_stamped.runs.reproduction_pre_build.reason, unverifiableReason);
  });

  it("reproduced:true model claim records pre-build test run (test command fails = pre-fix red)", async () => {
    const cwd = track(makeTargetProject({
      config: "routing:\n  default_host: generic\npipeline:\n  default_track: full\n  verify:\n    test_command: \"false\"\n",
    }));
    seedBrief(cwd, "## Regression\n- RC-1: button does not submit form\n");
    const gatePath = seedGate03bRepair(cwd, { reproduced: true });
    const r = await stampStage03b(cwd, gatePath);
    assert.equal(r.ok, true);
    // Model's claim is kept (stage-04a will finalize it)
    assert.equal(r.gate.reproduced, true);
    // Pre-build test run recorded (test fails = red state confirmed)
    const preBuild = r.gate._orchestrator_stamped.runs.reproduction_pre_build;
    assert.ok(preBuild, "reproduction_pre_build must be recorded");
    assert.equal(preBuild.pre_build_tests_passed, false, "pre-fix red state must be recorded");
    // Orchestrator deferred — not yet finalized
    const reproField = r.gate._orchestrator_stamped.fields.find((f) => f.field === "reproduced");
    assert.ok(reproField, "reproduced field entry must be present");
    assert.ok(reproField.orchestrator_deferred, "orchestrator_deferred must be set (finalized at stage-04a)");
  });

  it("reproduced:false model claim records pre-build test run (test passes = cannot reproduce)", async () => {
    const cwd = track(makeTargetProject({
      config: "routing:\n  default_host: generic\npipeline:\n  default_track: full\n  verify:\n    test_command: \"true\"\n",
    }));
    seedBrief(cwd, "## Regression\n- RC-1: modal stays open on Escape\n");
    const gatePath = seedGate03bRepair(cwd, { reproduced: false });
    const r = await stampStage03b(cwd, gatePath);
    assert.equal(r.ok, true);
    assert.equal(r.gate.reproduced, false);
    const preBuild = r.gate._orchestrator_stamped.runs.reproduction_pre_build;
    assert.equal(preBuild.pre_build_tests_passed, true, "pre-build passing recorded when tests green");
  });

  it("reproduced field absent (feature run) does not add reproduction_pre_build", async () => {
    const cwd = track(makeTargetProject());
    seedBrief(cwd, "## ACs\n- AC-1: user can log in\n");
    const SPEC = "Feature: auth\n  @AC-1\n  Scenario: AC-1 — log in\n    Given a user\n    When they log in\n    Then session created\n";
    seedSpec(cwd, SPEC);
    // No reproduced field — feature run
    const gatePath = seedGateRaw(cwd, "stage-03b", {
      stage: "stage-03b", status: "PASS", orchestrator: "devteam@test", host: "generic",
      track: "full", timestamp: "2026-06-15T00:00:00Z",
      blockers: [], warnings: [],
      criteria_count: 0, scenarios_count: 0, criteria_to_scenario_mapping: [],
      all_criteria_mapped: false, orphan_scenarios: [], orphan_criteria: [], drift: false,
    });
    const r = await stampStage03b(cwd, gatePath);
    assert.equal(r.ok, true);
    assert.ok(!r.gate._orchestrator_stamped.runs.reproduction_pre_build,
      "feature run must not have reproduction_pre_build in stamp");
    assert.equal(r.gate.reproduced, undefined, "feature run must not have reproduced field");
  });
});

// ─── ADR-009 Phase 3: reproduction finalization in stampStage04a ─────────────

describe("verify/stamp: stampStage04a — reproduction finalization (ADR-009 Phase 3)", () => {
  function base04aGate(extra = {}) {
    return {
      stage: "stage-04a", status: "PASS", orchestrator: "devteam@test", host: "generic",
      track: "hotfix", timestamp: "2026-06-15T00:00:00Z",
      blockers: [], warnings: [],
      lint_passed: true, tests_passed: true,
      dependency_review_passed: true, license_check_passed: true,
      security_review_required: false, migration_safety_required: false,
      license_findings: [],
      ...extra,
    };
  }
  function base03bGate(extra = {}) {
    return {
      stage: "stage-03b", status: "PASS", orchestrator: "devteam@test", host: "generic",
      track: "hotfix", timestamp: "2026-06-15T00:00:00Z",
      blockers: [], warnings: [],
      criteria_count: 0, scenarios_count: 0, criteria_to_scenario_mapping: [],
      all_criteria_mapped: false, orphan_scenarios: [], orphan_criteria: [], drift: false,
      reproduced: true, // model's claim
      ...extra,
    };
  }

  it("red-before/green-after: stamps reproduced:true on stage-03b when pre-build failed and post-fix tests pass", async () => {
    const cwd = track(makeTargetProject({
      config: "routing:\n  default_host: generic\npipeline:\n  default_track: full\n  verify:\n    test_command: \"true\"\n",
    }));
    // Stage-03b gate: model claimed reproduced:true, pre-build test FAILED (red before fix)
    seedGateRaw(cwd, "stage-03b", {
      ...base03bGate(),
      _orchestrator_stamped: {
        stamper_version: "1",
        at: "2026-06-15T00:00:00Z",
        fields: [{ field: "reproduced", model_said: true, orchestrator_deferred: "verified-at-stage-04a" }],
        runs: {
          spec_generate: { skipped: "spec.feature already exists" },
          spec_verify: { drift: false, criteria_count: 0, scenarios_count: 0 },
          reproduction_pre_build: {
            command: "false",
            exit_code: 1,
            duration_ms: 5,
            pre_build_tests_passed: false, // RED before fix
          },
        },
      },
    });
    const gate04aPath = seedGateRaw(cwd, "stage-04a", base04aGate());
    await stampStage04a(cwd, gate04aPath);
    // Read the stage-03b gate to verify it was updated by the stamp
    const gate03b = JSON.parse(fs.readFileSync(path.join(cwd, "pipeline", "gates", "stage-03b.json"), "utf8"));
    assert.equal(gate03b.reproduced, true, "reproduced must be stamped true by orchestrator (not just agent-asserted)");
    const verification = gate03b._orchestrator_stamped.runs.reproduction_verification;
    assert.ok(verification, "reproduction_verification record must be added");
    assert.equal(verification.green_after_confirmed, true, "green_after_confirmed must be true");
    assert.equal(verification.red_before_confirmed, true, "red_before_confirmed must be true");
    assert.equal(verification.post_build_tests_passed, true);
    assert.equal(verification.pre_build_tests_passed, false);
  });

  it("stamps reproduced:false on stage-03b when post-fix tests fail (fix did not work)", async () => {
    const cwd = track(makeTargetProject({
      config: "routing:\n  default_host: generic\npipeline:\n  default_track: full\n  verify:\n    test_command: \"false\"\n",
    }));
    seedGateRaw(cwd, "stage-03b", {
      ...base03bGate(),
      _orchestrator_stamped: {
        stamper_version: "1",
        at: "2026-06-15T00:00:00Z",
        fields: [],
        runs: {
          reproduction_pre_build: { pre_build_tests_passed: false, exit_code: 1 },
        },
      },
    });
    const gate04aPath = seedGateRaw(cwd, "stage-04a", base04aGate({ tests_passed: true }));
    await stampStage04a(cwd, gate04aPath);
    const gate03b = JSON.parse(fs.readFileSync(path.join(cwd, "pipeline", "gates", "stage-03b.json"), "utf8"));
    assert.equal(gate03b.reproduced, false, "reproduced must be stamped false when post-fix tests fail");
    assert.equal(gate03b._orchestrator_stamped.runs.reproduction_verification.green_after_confirmed, false);
  });

  it("does not modify stage-03b gate when reproduced is unverifiable", async () => {
    const cwd = track(makeTargetProject({
      config: "routing:\n  default_host: generic\npipeline:\n  default_track: full\n  verify:\n    test_command: \"true\"\n",
    }));
    const unverifiableReason = "unverifiable: external payment gateway";
    const gate03bContent = {
      ...base03bGate({ reproduced: unverifiableReason }),
      _orchestrator_stamped: {
        stamper_version: "1",
        at: "2026-06-15T00:00:00Z",
        fields: [],
        runs: { reproduction_pre_build: { unverifiable: true, reason: unverifiableReason } },
      },
    };
    seedGateRaw(cwd, "stage-03b", gate03bContent);
    const gate04aPath = seedGateRaw(cwd, "stage-04a", base04aGate());
    await stampStage04a(cwd, gate04aPath);
    const gate03b = JSON.parse(fs.readFileSync(path.join(cwd, "pipeline", "gates", "stage-03b.json"), "utf8"));
    assert.equal(gate03b.reproduced, unverifiableReason,
      "unverifiable reproduced must not be changed by stage-04a stamp");
    assert.ok(!gate03b._orchestrator_stamped.runs.reproduction_verification,
      "reproduction_verification must not be added for unverifiable bugs");
  });

  it("skips reproduction finalization gracefully when no stage-03b gate exists (feature run)", async () => {
    const cwd = track(makeTargetProject({
      config: "routing:\n  default_host: generic\npipeline:\n  default_track: full\n  verify:\n    test_command: \"true\"\n",
    }));
    // No stage-03b gate — feature run
    const gate04aPath = seedGateRaw(cwd, "stage-04a", base04aGate());
    const r = await stampStage04a(cwd, gate04aPath);
    assert.equal(r.ok, true, "stage-04a stamp must succeed even without stage-03b gate");
    assert.equal(r.gate.tests_passed, true);
  });
});
