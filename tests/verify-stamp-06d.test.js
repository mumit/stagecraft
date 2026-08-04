// 35.3 — orchestrator-verified evidence that stage-06d's methods actually
// ran. Before this, STAMPABLE_STAGES was {stage-03b, stage-04a, stage-04c,
// stage-06} — 06d was absent, so methods_attempted[] was 100%
// model-asserted (plans/phase-31-verification-depth.md's explicit
// out-of-scope item, closed by plans/phase-35-existing-codebase-mode.md
// item 35.3).
//
// Contract under test: for each BARE method tag the model claims
// (methods_attempted contains "property"/"mutation"/"formal", not already
// an honest "attempted_but_blocked:*"), the orchestrator tries to produce
// real executable evidence.
//   - Evidence found + method ran cleanly  -> claim confirmed, orchestrator's
//     own numbers overwrite the model's.
//   - Evidence found but the run genuinely fails (a real counterexample, a
//     mutation score below the model's own pre-declared threshold) -> the
//     claim stays confirmed (it DID run) but the gate FAILs — this is the
//     acceptance criterion "fixture with a real property counterexample
//     FAILs on orchestrator evidence".
//   - No evidence at all (no toolchain, no test files, zero properties
//     executed, mutation gate not enabled, no formal command configured)
//     -> the claim downgrades to "attempted_but_blocked:<method>", the
//     model's original sub-object is preserved under
//     stamp.runs.<method>.model_claim, and a warning is raised.
//
// Formal is presence-and-exit-code only (core/verify/formal.js):
// TLA+/Alloy/Lean output is too varied to parse, so a non-zero exit is a
// warning for human triage, never an auto-blocker.

const { describe, it, afterEach } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { makeTargetProject, cleanup } = require("./_helpers");
const { stampStage06d } = require("../core/verify/stamp");
const { detectRunner, parseOutput, buildCommand, walkFiles } = require("../core/verify/property");
const { resolveFormalConfig } = require("../core/verify/formal");

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

function base06dGate(overrides = {}) {
  return {
    stage: "stage-06d",
    status: "PASS",
    orchestrator: "devteam@test",
    host: "generic",
    track: "full",
    timestamp: "2026-07-31T00:00:00Z",
    blockers: [],
    warnings: [],
    methods_attempted: [],
    methods_skipped: [],
    candidates_inventoried: 1,
    property_based: null,
    mutation: null,
    formal: null,
    findings_count: 0,
    blocking_findings: [],
    non_blocking_findings: [],
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

// -- property-based -----------------------------------------------------

describe("verify/stamp: stampStage06d property_based — no toolchain detected", () => {
  it("downgrades a claimed 'property' method to attempted_but_blocked, no FAIL", async () => {
    const cwd = track(makeTargetProject());
    const gatePath = seedGateRaw(cwd, "stage-06d", base06dGate({ methods_attempted: ["property"] }));

    const r = await stampStage06d(cwd, gatePath);
    assert.deepEqual(r.gate.methods_attempted, ["attempted_but_blocked:property"]);
    assert.equal(r.gate.status, "PASS", "absent toolchain must never be treated as a pass or a fail");
    assert.ok(r.gate.warnings.some((w) => w.includes("property-attempted-but-blocked")));
    assert.match(r.stamp.runs.property.reason, /no supported property-based testing framework found/);
  });
});

describe("verify/stamp: stampStage06d property_based — zero executed properties", () => {
  it("downgrades even when the configured command runs cleanly but asserts nothing", async () => {
    const cwd = track(makeTargetProject({
      config: configWithVerify("    property:\n      command: \"node fake-property-empty.js\"\n"),
    }));
    fs.writeFileSync(path.join(cwd, "fake-property-empty.js"), `
      console.log("# tests 0");
      console.log("# pass 0");
      console.log("# fail 0");
    `);
    const gatePath = seedGateRaw(cwd, "stage-06d", base06dGate({
      methods_attempted: ["property"],
      property_based: { properties_asserted: 5, cases_tried: 500, counterexamples_found: 0, tool: "fast-check" },
    }));

    const r = await stampStage06d(cwd, gatePath);
    assert.deepEqual(r.gate.methods_attempted, ["attempted_but_blocked:property"]);
    assert.equal(r.gate.status, "PASS");
    assert.ok(r.gate.warnings.some((w) => w.includes("orchestrator ran the property command but found zero executed properties")));
    assert.deepEqual(r.stamp.runs.property.model_claim, { properties_asserted: 5, cases_tried: 500, counterexamples_found: 0, tool: "fast-check" });
  });
});

describe("verify/stamp: stampStage06d property_based — real counterexample", () => {
  it("FAILs the gate on orchestrator-observed evidence, keeps the method confirmed (it DID run)", async () => {
    const cwd = track(makeTargetProject({
      config: configWithVerify("    property:\n      command: \"node fake-property-fail.js\"\n"),
    }));
    fs.writeFileSync(path.join(cwd, "fake-property-fail.js"), `
      console.log("# tests 1");
      console.log("# pass 0");
      console.log("# fail 1");
      console.log("Property failed after 3 tests");
      console.log('{ seed: -1, path: "0:0", endOnFailure: true }');
      console.log('Counterexample: [""]');
    `);
    const gatePath = seedGateRaw(cwd, "stage-06d", base06dGate({
      methods_attempted: ["property"],
      property_based: { properties_asserted: 1, cases_tried: 100, counterexamples_found: 0, tool: "fast-check" },
    }));

    const r = await stampStage06d(cwd, gatePath);
    assert.deepEqual(r.gate.methods_attempted, ["property"], "method genuinely ran — stays confirmed, not downgraded");
    assert.equal(r.gate.status, "FAIL");
    assert.ok(r.gate.blockers.some((b) => b.includes("property-based verification failed")));
    assert.equal(r.gate.property_based.counterexamples_found, 1);
    assert.equal(r.gate.property_based.properties_asserted, 1);
  });
});

describe("verify/stamp: stampStage06d property_based — confirmed pass", () => {
  it("stamps orchestrator-observed counts and leaves the gate PASS", async () => {
    const cwd = track(makeTargetProject({
      config: configWithVerify("    property:\n      command: \"node fake-property-pass.js\"\n"),
    }));
    fs.writeFileSync(path.join(cwd, "fake-property-pass.js"), `
      console.log("# tests 3");
      console.log("# pass 3");
      console.log("# fail 0");
    `);
    const gatePath = seedGateRaw(cwd, "stage-06d", base06dGate({ methods_attempted: ["property"] }));

    const r = await stampStage06d(cwd, gatePath);
    assert.deepEqual(r.gate.methods_attempted, ["property"]);
    assert.equal(r.gate.status, "PASS");
    assert.equal(r.gate.property_based.properties_asserted, 3);
    assert.equal(r.gate.property_based.counterexamples_found, 0);
    assert.equal(r.gate.property_based.tool, "configured");
  });
});

// -- mutation (reuses the 31.4 runner path) ------------------------------

describe("verify/stamp: stampStage06d mutation — disabled by default", () => {
  it("downgrades a claimed 'mutation' method when the 31.4 gate isn't opted in", async () => {
    const cwd = track(makeTargetProject());
    seedChangedFiles(cwd, ["src/foo.js"]);
    const gatePath = seedGateRaw(cwd, "stage-06d", base06dGate({ methods_attempted: ["mutation"] }));

    const r = await stampStage06d(cwd, gatePath);
    assert.deepEqual(r.gate.methods_attempted, ["attempted_but_blocked:mutation"]);
    assert.equal(r.gate.status, "PASS");
    assert.match(r.stamp.runs.mutation.reason, /disabled/);
  });
});

describe("verify/stamp: stampStage06d mutation — below the model's declared threshold", () => {
  it("FAILs using the model's pre-declared threshold, not the 31.4 default", async () => {
    const cwd = track(makeTargetProject({
      config: configWithVerify("    mutation:\n      enabled: true\n      command: \"node fake-mutation.js\"\n"),
    }));
    fs.writeFileSync(path.join(cwd, "fake-mutation.js"), `
      console.log("5/10 mutants killed (50.00%)");
    `);
    seedChangedFiles(cwd, ["src/foo.js"]);
    const gatePath = seedGateRaw(cwd, "stage-06d", base06dGate({
      methods_attempted: ["mutation"],
      mutation: { threshold: 0.8, tool: "stryker" },
    }));

    const r = await stampStage06d(cwd, gatePath);
    assert.deepEqual(r.gate.methods_attempted, ["mutation"]);
    assert.equal(r.gate.mutation.threshold, 0.8, "honors the model's pre-declared threshold");
    assert.equal(r.gate.mutation.score, 0.5);
    assert.equal(r.gate.status, "FAIL");
    assert.ok(r.gate.blockers.some((b) => b.includes("mutation score 50.0% below declared threshold 80.0%")));
  });
});

describe("verify/stamp: stampStage06d mutation — above threshold", () => {
  it("confirms the claim and leaves the gate PASS", async () => {
    const cwd = track(makeTargetProject({
      config: configWithVerify("    mutation:\n      enabled: true\n      command: \"node fake-mutation.js\"\n"),
    }));
    fs.writeFileSync(path.join(cwd, "fake-mutation.js"), `
      console.log("9/10 mutants killed (90.00%)");
    `);
    seedChangedFiles(cwd, ["src/foo.js"]);
    const gatePath = seedGateRaw(cwd, "stage-06d", base06dGate({
      methods_attempted: ["mutation"],
      mutation: { threshold: 0.7, tool: "stryker" },
    }));

    const r = await stampStage06d(cwd, gatePath);
    assert.deepEqual(r.gate.methods_attempted, ["mutation"]);
    assert.equal(r.gate.mutation.score, 0.9);
    assert.equal(r.gate.status, "PASS");
  });
});

// -- formal: presence-and-exit-code only ---------------------------------

describe("verify/stamp: stampStage06d formal — no command configured", () => {
  it("downgrades a claimed 'formal' method, no FAIL", async () => {
    const cwd = track(makeTargetProject());
    const gatePath = seedGateRaw(cwd, "stage-06d", base06dGate({
      methods_attempted: ["formal"],
      formal: { tool: "TLA+", property_modeled: "mutual exclusion", counterexample_found: false },
    }));

    const r = await stampStage06d(cwd, gatePath);
    assert.deepEqual(r.gate.methods_attempted, ["attempted_but_blocked:formal"]);
    assert.equal(r.gate.status, "PASS");
    assert.ok(r.gate.warnings.some((w) => w.includes("formal-attempted-but-blocked")));
    assert.deepEqual(r.stamp.runs.formal.model_claim, { tool: "TLA+", property_modeled: "mutual exclusion", counterexample_found: false });
  });
});

describe("verify/stamp: stampStage06d formal — configured command runs, exit 0", () => {
  it("stamps {tool, ran, exit_code} only, preserves the model's other formal fields", async () => {
    const cwd = track(makeTargetProject({
      config: configWithVerify("    formal:\n      command: \"true\"\n      tool: \"TLA+\"\n"),
    }));
    const gatePath = seedGateRaw(cwd, "stage-06d", base06dGate({
      methods_attempted: ["formal"],
      formal: { tool: "TLA+", property_modeled: "mutual exclusion", depth_explored: 12, counterexample_found: false },
    }));

    const r = await stampStage06d(cwd, gatePath);
    assert.deepEqual(r.gate.methods_attempted, ["formal"]);
    assert.equal(r.gate.status, "PASS");
    assert.equal(r.gate.formal.ran, true);
    assert.equal(r.gate.formal.exit_code, 0);
    assert.equal(r.gate.formal.tool, "TLA+");
    assert.equal(r.gate.formal.depth_explored, 12, "model's judgment fields untouched by the presence-and-exit-code stamp");
    assert.equal(r.gate.warnings.length, 0);
  });
});

describe("verify/stamp: stampStage06d formal — configured command runs, non-zero exit", () => {
  it("warns for human triage but does NOT auto-FAIL (output too varied to parse)", async () => {
    const cwd = track(makeTargetProject({
      config: configWithVerify("    formal:\n      command: \"false\"\n"),
    }));
    const gatePath = seedGateRaw(cwd, "stage-06d", base06dGate({ methods_attempted: ["formal"] }));

    const r = await stampStage06d(cwd, gatePath);
    assert.deepEqual(r.gate.methods_attempted, ["formal"]);
    assert.equal(r.gate.formal.exit_code, 1);
    assert.equal(r.gate.formal.tool, "configured");
    assert.equal(r.gate.status, "PASS", "presence-and-exit-code only — non-zero exit is a warning, never an auto-blocker");
    assert.ok(r.gate.warnings.some((w) => w.includes("formal-nonzero-exit")));
  });
});

// -- claims left untouched ------------------------------------------------

describe("verify/stamp: stampStage06d — methods not claimed are untouched", () => {
  it("does not invent evidence for a legitimately skipped method", async () => {
    const cwd = track(makeTargetProject());
    const gatePath = seedGateRaw(cwd, "stage-06d", base06dGate({
      methods_attempted: [],
      methods_skipped: [{ method: "property", reason: "no pure functions in diff" }],
    }));

    const r = await stampStage06d(cwd, gatePath);
    assert.deepEqual(r.gate.methods_attempted, []);
    assert.equal(r.gate.status, "PASS");
    assert.deepEqual(r.stamp.runs, {});
  });

  it("leaves an already-honest attempted_but_blocked claim alone", async () => {
    const cwd = track(makeTargetProject());
    const gatePath = seedGateRaw(cwd, "stage-06d", base06dGate({
      methods_attempted: ["attempted_but_blocked:mutation"],
    }));

    const r = await stampStage06d(cwd, gatePath);
    assert.deepEqual(r.gate.methods_attempted, ["attempted_but_blocked:mutation"]);
    assert.equal(r.gate.status, "PASS");
  });
});

// -- unit tests: core/verify/property.js ---------------------------------

describe("verify/property: detectRunner / parseOutput / buildCommand / walkFiles (unit)", () => {
  it("detects fast-check via a package.json dependency", () => {
    const cwd = track(makeTargetProject());
    fs.writeFileSync(path.join(cwd, "package.json"), JSON.stringify({
      name: "fixture", devDependencies: { "fast-check": "^3.0.0" },
    }));
    assert.equal(detectRunner(cwd).id, "fast-check");
  });

  it("detects hypothesis via requirements.txt", () => {
    const cwd = track(makeTargetProject());
    fs.writeFileSync(path.join(cwd, "requirements.txt"), "hypothesis==6.100.0\n");
    assert.equal(detectRunner(cwd).id, "hypothesis");
  });

  it("detects proptest via Cargo.toml", () => {
    const cwd = track(makeTargetProject());
    fs.writeFileSync(path.join(cwd, "Cargo.toml"), "[dev-dependencies]\nproptest = \"1\"\n");
    assert.equal(detectRunner(cwd).id, "proptest");
  });

  it("returns null when no manifest signals any known framework", () => {
    const cwd = track(makeTargetProject());
    assert.equal(detectRunner(cwd), null);
  });

  it("parseOutput parses a passing TAP summary with no counterexamples", () => {
    const parsed = parseOutput("# tests 2\n# pass 2\n# fail 0\n");
    assert.equal(parsed.properties_asserted, 2);
    assert.equal(parsed.counterexamples_found, 0);
    assert.equal(parsed.passed, true);
    assert.equal(parsed.cases_tried, null, "no failure message — cases_tried honestly omitted, not fabricated");
  });

  it("parseOutput parses a failing TAP summary and sums counterexample case counts", () => {
    const parsed = parseOutput(
      "# tests 2\n# pass 1\n# fail 1\nProperty failed after 7 tests\nCounterexample: [1]\n",
    );
    assert.equal(parsed.properties_asserted, 2);
    assert.equal(parsed.counterexamples_found, 1);
    assert.equal(parsed.cases_tried, 7);
    assert.equal(parsed.passed, false);
  });

  it("parseOutput parses a pytest/hypothesis summary", () => {
    const parsed = parseOutput("1 failed, 4 passed in 0.12s\nFalsifying example: test_x(x=0)\n");
    assert.equal(parsed.properties_asserted, 5);
    assert.equal(parsed.counterexamples_found, 1);
    assert.equal(parsed.passed, false);
  });

  it("parseOutput parses a cargo test/proptest summary", () => {
    const parsed = parseOutput(
      "test result: FAILED. 3 passed; 1 failed; 0 ignored; 0 measured; 0 filtered out\nTest failed: assertion failed\n",
    );
    assert.equal(parsed.properties_asserted, 4);
    assert.equal(parsed.counterexamples_found, 1);
    assert.equal(parsed.passed, false);
  });

  it("parseOutput returns null for unrecognized output (honest skip upstream)", () => {
    assert.equal(parseOutput("some unrelated tool output\n"), null);
  });

  it("buildCommand builds the node:test invocation for fast-check", () => {
    assert.equal(buildCommand("fast-check", ["a.test.js", "b.test.js"]), "node --test --test-reporter=tap a.test.js b.test.js");
  });

  it("walkFiles finds matching files under a directory, bounded and symlink-safe", () => {
    const cwd = track(makeTargetProject());
    const dir = path.join(cwd, "src", "tests", "property");
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, "a.property.test.js"), "");
    fs.writeFileSync(path.join(dir, "readme.md"), "");
    const found = walkFiles(dir, (name) => /\.test\.[cm]?[jt]sx?$/i.test(name));
    assert.equal(found.length, 1);
    assert.match(found[0], /a\.property\.test\.js$/);
  });
});

// -- unit tests: core/verify/formal.js -----------------------------------

describe("verify/formal: resolveFormalConfig (unit)", () => {
  it("returns command: null when unconfigured", () => {
    assert.equal(resolveFormalConfig({}).command, null);
  });

  it("reads command/tool/timeout_ms from pipeline.verify.formal", () => {
    const cfg = resolveFormalConfig({
      pipeline: { verify: { formal: { command: "tlc spec.tla", tool: "TLA+", timeout_ms: 1000 } } },
    });
    assert.equal(cfg.command, "tlc spec.tla");
    assert.equal(cfg.tool, "TLA+");
    assert.equal(cfg.timeout_ms, 1000);
  });
});
