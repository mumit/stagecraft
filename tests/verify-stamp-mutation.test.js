// 31.4 — opt-in, time-boxed, changed-files-only mutation smoke gate at
// stage-06 (QA) stamping.
//
// Locks the contract that: disabled by default (today's stage-06 behaviour
// is unaffected); an absent runner or an empty changed-file scope records
// an honest skip, never a fabricated pass; a below-threshold score is
// advisory (gate warning + noted_for_followup, surfaced in `devteam advise`
// classification) unless threshold_hard is set, in which case it flips the
// gate to FAIL the same way every other stamped check does; a hung run is
// killed cleanly via the existing process-kill machinery and recorded as a
// skip rather than a false pass.

const { describe, it, afterEach } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { makeTargetProject, cleanup } = require("./_helpers");
const { stampStage06 } = require("../core/verify/stamp");
const { detectRunner, scopeFiles, parseScore } = require("../core/verify/mutation");
const { classifyItem } = require("../core/advise");

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

function base06Gate(overrides = {}) {
  return {
    stage: "stage-06",
    status: "PASS",
    orchestrator: "devteam@test",
    host: "generic",
    track: "full",
    timestamp: "2026-07-31T00:00:00Z",
    blockers: [],
    warnings: [],
    all_acceptance_criteria_met: true,
    tests_total: 1, tests_passed: 1, tests_failed: 0, failing_tests: [],
    criterion_to_test_mapping_is_one_to_one: true,
    ...overrides,
  };
}

function configWithVerify(verifyYaml) {
  return `routing:\n  default_host: generic\npipeline:\n  default_track: full\n  verify:\n${verifyYaml}\n`;
}

function seedChangedFiles(cwd, files) {
  fs.mkdirSync(path.join(cwd, "pipeline"), { recursive: true });
  fs.writeFileSync(path.join(cwd, "pipeline", "changed-files.txt"), files.join("\n") + "\n");
}

describe("verify/stamp: stampStage06 mutation gate — disabled by default", () => {
  it("records an honest skip and touches nothing else on the gate (today's behaviour, unopted-in)", async () => {
    const cwd = track(makeTargetProject({
      config: configWithVerify("    test_command: \"true\"\n"),
    }));
    seedChangedFiles(cwd, ["src/foo.js"]);
    const gatePath = seedGateRaw(cwd, "stage-06", base06Gate());
    const r = await stampStage06(cwd, gatePath);
    assert.equal(r.gate.status, "PASS");
    assert.equal(r.stamp.runs.mutation.ran, false);
    assert.equal(r.stamp.runs.mutation.skipped, true);
    assert.match(r.stamp.runs.mutation.reason, /disabled/);
    assert.equal(r.gate.mutation_score, undefined);
    assert.equal(r.gate.mutation_runner, undefined);
    assert.equal(r.gate.noted_for_followup, undefined);
  });
});

describe("verify/stamp: stampStage06 mutation gate — no supported runner", () => {
  it("records a skip, not a silence, when neither Stryker nor mutmut is detected", async () => {
    const cwd = track(makeTargetProject({
      // test_command: null — this test overrides PATH below to guarantee
      // `mutmut` can't resolve, which would also break an unrelated "true"
      // test-command subprocess; skip test execution entirely so the only
      // thing under test is mutation-runner detection.
      config: configWithVerify("    test_command: null\n    mutation:\n      enabled: true\n"),
    }));
    seedChangedFiles(cwd, ["src/foo.js"]);
    const gatePath = seedGateRaw(cwd, "stage-06", base06Gate());

    // Guarantee determinism regardless of the host machine: run with a PATH
    // that cannot resolve a real `mutmut` binary, and no package.json (so
    // no Stryker devDependency either).
    const emptyBin = path.join(cwd, "empty-bin");
    fs.mkdirSync(emptyBin);
    const originalPath = process.env.PATH;
    process.env.PATH = emptyBin;
    try {
      const r = await stampStage06(cwd, gatePath);
      assert.equal(r.stamp.runs.mutation.ran, false);
      assert.equal(r.stamp.runs.mutation.skipped, true);
      assert.match(r.stamp.runs.mutation.reason, /no supported mutation runner/);
      assert.equal(r.gate.mutation_score, undefined);
      assert.equal(r.gate.status, "PASS", "an absent runner must never be treated as a pass or a fail");
    } finally {
      process.env.PATH = originalPath;
    }
  });
});

describe("verify/stamp: stampStage06 mutation gate — empty scope", () => {
  it("records a skip when no changed file falls within pipeline.verify.mutation.paths", async () => {
    const cwd = track(makeTargetProject({
      config: configWithVerify(
        "    test_command: \"true\"\n    mutation:\n      enabled: true\n      paths: [\"src/\"]\n",
      ),
    }));
    seedChangedFiles(cwd, ["docs/readme.md"]);
    const gatePath = seedGateRaw(cwd, "stage-06", base06Gate());
    const r = await stampStage06(cwd, gatePath);
    assert.equal(r.stamp.runs.mutation.ran, false);
    assert.match(r.stamp.runs.mutation.reason, /pipeline\.verify\.mutation\.paths/);
    assert.equal(r.gate.mutation_score, undefined);
  });
});

describe("verify/stamp: stampStage06 mutation gate — below-threshold WARN", () => {
  it("stamps mutation_score/runner/scope and WARNs via a noted_for_followup item classified PEER_REVIEW_RISK", async () => {
    const cwd = track(makeTargetProject({
      config: configWithVerify(
        "    test_command: \"true\"\n    mutation:\n      enabled: true\n      command: \"node fake-mutation.js\"\n      threshold: 0.7\n",
      ),
    }));
    fs.writeFileSync(path.join(cwd, "fake-mutation.js"), `
      console.log("5/10 mutants killed (50.00%)");
    `);
    seedChangedFiles(cwd, ["src/foo.js"]);
    const gatePath = seedGateRaw(cwd, "stage-06", base06Gate());

    const r = await stampStage06(cwd, gatePath);
    assert.equal(r.gate.mutation_score, 0.5);
    assert.equal(r.gate.mutation_runner, "configured");
    assert.equal(r.gate.mutation_scope.mutated_files.length, 1);
    assert.equal(r.gate.status, "PASS", "advisory (non-hard) below-threshold must not flip status");
    assert.ok(r.gate.warnings.some((w) => w.includes("mutation-below-threshold")));
    assert.equal(r.gate.noted_for_followup.length, 1);
    const item = r.gate.noted_for_followup[0];
    assert.equal(item.severity, "high");
    assert.equal(classifyItem(item, cwd), "PEER_REVIEW_RISK", "must surface in devteam advise classification");
  });

  it("does not warn when the score is at or above threshold", async () => {
    const cwd = track(makeTargetProject({
      config: configWithVerify(
        "    test_command: \"true\"\n    mutation:\n      enabled: true\n      command: \"node fake-mutation.js\"\n      threshold: 0.7\n",
      ),
    }));
    fs.writeFileSync(path.join(cwd, "fake-mutation.js"), `
      console.log("9/10 mutants killed (90.00%)");
    `);
    seedChangedFiles(cwd, ["src/foo.js"]);
    const gatePath = seedGateRaw(cwd, "stage-06", base06Gate());

    const r = await stampStage06(cwd, gatePath);
    assert.equal(r.gate.mutation_score, 0.9);
    assert.equal(r.gate.status, "PASS");
    assert.equal(r.gate.noted_for_followup, undefined);
  });
});

describe("verify/stamp: stampStage06 mutation gate — threshold_hard FAILs", () => {
  it("flips a model-PASS gate to FAIL when threshold_hard is set and the score is below threshold", async () => {
    const cwd = track(makeTargetProject({
      config: configWithVerify(
        "    test_command: \"true\"\n    mutation:\n      enabled: true\n      command: \"node fake-mutation.js\"\n      threshold: 0.7\n      threshold_hard: true\n",
      ),
    }));
    fs.writeFileSync(path.join(cwd, "fake-mutation.js"), `
      console.log("5/10 mutants killed (50.00%)");
    `);
    seedChangedFiles(cwd, ["src/foo.js"]);
    const gatePath = seedGateRaw(cwd, "stage-06", base06Gate());

    const r = await stampStage06(cwd, gatePath);
    assert.equal(r.gate.mutation_score, 0.5);
    assert.equal(r.gate.status, "FAIL");
    assert.ok(r.gate.blockers.some((b) => b.includes("mutation score below hard threshold")));
    assert.ok(r.gate._orchestrator_stamped.status_overridden, "status_overridden audit entry present");
  });
});

describe("verify/stamp: stampStage06 mutation gate — timeout", () => {
  it("kills a hung mutation run cleanly and records a skip, never a fabricated score", async () => {
    const cwd = track(makeTargetProject({
      config: configWithVerify(
        "    test_command: \"true\"\n    mutation:\n      enabled: true\n" +
        "      command: \"node -e \\\"setTimeout(()=>{}, 5000)\\\"\"\n      timeout_ms: 200\n",
      ),
    }));
    seedChangedFiles(cwd, ["src/foo.js"]);
    const gatePath = seedGateRaw(cwd, "stage-06", base06Gate());

    const r = await stampStage06(cwd, gatePath);
    assert.equal(r.stamp.runs.mutation.ran, false);
    assert.equal(r.stamp.runs.mutation.skipped, true);
    assert.equal(r.stamp.runs.mutation.timed_out, true);
    assert.match(r.stamp.runs.mutation.reason, /exceeded timeout_ms/);
    assert.equal(r.gate.mutation_score, undefined);
    assert.equal(r.gate.status, "PASS", "a timed-out run must never be treated as a pass or a fail");
  });
});

describe("verify/mutation: detectRunner / scopeFiles / parseScore (unit)", () => {
  it("detects Stryker via a @stryker-mutator/core devDependency", () => {
    const cwd = track(makeTargetProject());
    fs.writeFileSync(path.join(cwd, "package.json"), JSON.stringify({
      name: "fixture", devDependencies: { "@stryker-mutator/core": "^8.0.0" },
    }));
    const runner = detectRunner(cwd);
    assert.equal(runner.id, "stryker");
  });

  it("returns null when no package.json and mutmut is not on PATH", () => {
    const cwd = track(makeTargetProject());
    const emptyBin = path.join(cwd, "empty-bin");
    fs.mkdirSync(emptyBin);
    const originalPath = process.env.PATH;
    process.env.PATH = emptyBin;
    try {
      assert.equal(detectRunner(cwd), null);
    } finally {
      process.env.PATH = originalPath;
    }
  });

  it("scopeFiles intersects changed files with configured path prefixes", () => {
    const files = ["src/foo.js", "docs/readme.md", "src/bar/baz.js"];
    assert.deepEqual(scopeFiles(files, ["src/"]), ["src/foo.js", "src/bar/baz.js"]);
    assert.deepEqual(scopeFiles(files, null), files);
  });

  it("parseScore parses the Stryker clear-text summary line", () => {
    const parsed = parseScore("Ran 12 tests\n138/142 mutants killed (97.18%)\n4 survivors:\n");
    assert.equal(parsed.format, "stryker");
    assert.equal(Math.round(parsed.score * 10000) / 10000, 0.9718);
    assert.equal(parsed.mutants.generated, 142);
    assert.equal(parsed.mutants.killed, 138);
  });

  it("parseScore returns null for unrecognized output (honest skip upstream)", () => {
    assert.equal(parseScore("some unrelated tool output\n"), null);
  });
});
