// 31.2 — stage-04c (red-team) mechanical floor.
//
// Locks the contract that the orchestrator's post-dispatch checks
// (dependency audit, secret-scan over the changeset, semgrep-if-configured,
// lockfile delta) merge into the stage-04c gate rather than trusting the
// model's self-reported findings_count: a mechanical HIGH+ finding forces
// must_address_before_peer_review and flips PASS to FAIL; an offline
// dependency audit records an honest skip, never a pass; an absent semgrep
// config/binary records a skip, never a silent no-op that looks like a pass.

const { describe, it, afterEach } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { execFileSync } = require("node:child_process");
const { makeTargetProject, cleanup } = require("./_helpers");
const { stampStage04c, STAMPABLE_STAGES } = require("../core/verify/stamp");
const { getChangedFiles } = require("../core/verify/redteam-floor");

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

function base04cGate(overrides = {}) {
  return {
    stage: "stage-04c",
    status: "PASS",
    orchestrator: "devteam@test",
    host: "generic",
    track: "full",
    timestamp: "2026-07-31T00:00:00Z",
    blockers: [],
    warnings: [],
    surfaces_walked: ["input_boundaries"],
    findings_count: 0,
    severity_breakdown: { critical: 0, high: 0, medium: 0, low: 0 },
    must_address_before_peer_review: [],
    noted_for_followup: [],
    ...overrides,
  };
}

function configWithVerify(verifyYaml) {
  return `routing:\n  default_host: generic\npipeline:\n  default_track: full\n  verify:\n${verifyYaml}\n`;
}

describe("verify/stamp: stage-04c is registered as stampable", () => {
  it("STAMPABLE_STAGES includes stage-04c", () => {
    assert.ok(STAMPABLE_STAGES.has("stage-04c"));
  });
});

describe("verify/redteam-floor: committed changeset discovery", () => {
  it("falls back to the latest commit after build agents commit their work", () => {
    const cwd = track(makeTargetProject());
    execFileSync("git", ["init", "-q"], { cwd });
    execFileSync("git", ["config", "user.email", "stagecraft@example.invalid"], { cwd });
    execFileSync("git", ["config", "user.name", "Stagecraft Test"], { cwd });
    fs.writeFileSync(path.join(cwd, "changed.js"), "module.exports = true;\n");
    execFileSync("git", ["add", "changed.js"], { cwd });
    execFileSync("git", ["commit", "-qm", "build output"], { cwd });

    assert.deepEqual(getChangedFiles(cwd), ["changed.js"]);
  });

  it("prefers an explicit pipeline changed-file manifest", () => {
    const cwd = track(makeTargetProject());
    fs.writeFileSync(path.join(cwd, "pipeline", "changed-files.txt"), "manifest.js\n");
    assert.deepEqual(getChangedFiles(cwd), ["manifest.js"]);
  });

  it("secret-scans the latest committed changeset when the working tree is clean", async () => {
    const cwd = track(makeTargetProject({
      config: configWithVerify("    dependency_audit_command: null"),
    }));
    execFileSync("git", ["init", "-q"], { cwd });
    execFileSync("git", ["config", "user.email", "stagecraft@example.invalid"], { cwd });
    execFileSync("git", ["config", "user.name", "Stagecraft Test"], { cwd });
    const fixtureKeyValue = ["ABCDEFGHIJKLMNOPQRSTUVWXYZ", "abcdefghij0123"].join("");
    fs.writeFileSync(path.join(cwd, "committed-secret.js"), `module.exports = { api_key: "${fixtureKeyValue}" };\n`);
    execFileSync("git", ["add", "committed-secret.js"], { cwd });
    execFileSync("git", ["commit", "-qm", "build output"], { cwd });
    const gatePath = seedGateRaw(cwd, "stage-04c", base04cGate());

    const result = await stampStage04c(cwd, gatePath);
    assert.equal(result.stamp.runs.secret_scan.ran, true);
    assert.equal(result.stamp.runs.secret_scan.findings.length, 1);
    assert.match(result.stamp.runs.secret_scan.findings[0].summary, /committed-secret\.js/);
  });
});

describe("verify/stamp: stampStage04c — dependency audit", () => {
  it("a seeded vulnerable fixture flips a model-PASS gate to FAIL", async () => {
    const cwd = track(makeTargetProject({
      config: configWithVerify("    dependency_audit_command: \"node fake-audit.js\""),
    }));
    fs.writeFileSync(path.join(cwd, "fake-audit.js"), `
      console.log(JSON.stringify({
        vulnerabilities: { lodash: { severity: "critical", via: [{ title: "Prototype Pollution" }] } },
        metadata: { vulnerabilities: { critical: 1, high: 0, moderate: 0, low: 0, info: 0, total: 1 } },
      }));
      process.exit(1);
    `);
    const gatePath = seedGateRaw(cwd, "stage-04c", base04cGate());

    const r = await stampStage04c(cwd, gatePath);
    assert.equal(r.ok, true);
    assert.equal(r.gate.status, "FAIL", "a mechanical critical finding must flip PASS to FAIL");
    assert.equal(r.gate.findings_count, 1);
    assert.equal(r.gate.severity_breakdown.critical, 1);
    assert.equal(r.gate.must_address_before_peer_review.length, 1);
    assert.equal(r.gate.must_address_before_peer_review[0].source, "mechanical");
    assert.equal(r.gate.must_address_before_peer_review[0].severity, "critical");
    assert.ok(r.gate.blockers.some((b) => b.includes("mechanical red-team floor")));
    assert.equal(r.stamp.runs.dependency_audit.ran, true);
    assert.equal(r.stamp.runs.dependency_audit.findings.length, 1);
  });

  it("records an honest 'offline' skip when the dependency audit can't reach the network — never a pass", async () => {
    const cwd = track(makeTargetProject({
      config: configWithVerify("    dependency_audit_command: \"node fake-audit-offline.js\""),
    }));
    fs.writeFileSync(path.join(cwd, "fake-audit-offline.js"), `
      process.stderr.write("npm error code ENOTFOUND\\nnpm error network request to registry failed\\n");
      process.exit(1);
    `);
    const gatePath = seedGateRaw(cwd, "stage-04c", base04cGate());

    const r = await stampStage04c(cwd, gatePath);
    assert.equal(r.ok, true);
    assert.equal(r.stamp.runs.dependency_audit.ran, false);
    assert.equal(r.stamp.runs.dependency_audit.skipped, true);
    assert.equal(r.stamp.runs.dependency_audit.reason, "offline");
    assert.equal(r.stamp.runs.dependency_audit.findings.length, 0);
    // No findings anywhere else in this fixture — status must stay PASS,
    // not be inferred as passing *because* the audit was skipped.
    assert.equal(r.gate.status, "PASS");
    assert.equal(r.gate.findings_count, 0);
  });

  it("skips with a clear reason when explicitly disabled via config null", async () => {
    const cwd = track(makeTargetProject({
      config: configWithVerify("    dependency_audit_command: null"),
    }));
    const gatePath = seedGateRaw(cwd, "stage-04c", base04cGate());
    const r = await stampStage04c(cwd, gatePath);
    assert.equal(r.stamp.runs.dependency_audit.ran, false);
    assert.match(r.stamp.runs.dependency_audit.reason, /explicitly disabled/);
  });

  it("skips with a scoping note for non-Node projects (no polyglot SCA equivalent exists — Phase 19 only covers test discovery)", async () => {
    const cwd = track(makeTargetProject()); // no package.json
    const gatePath = seedGateRaw(cwd, "stage-04c", base04cGate());
    const r = await stampStage04c(cwd, gatePath);
    assert.equal(r.stamp.runs.dependency_audit.ran, false);
    assert.match(r.stamp.runs.dependency_audit.reason, /polyglot dependency-audit tooling/);
  });
});

describe("verify/stamp: stampStage04c — semgrep", () => {
  it("skips when no semgrep config exists in the project", async () => {
    const cwd = track(makeTargetProject({
      config: configWithVerify("    dependency_audit_command: null"),
    }));
    const gatePath = seedGateRaw(cwd, "stage-04c", base04cGate());
    const r = await stampStage04c(cwd, gatePath);
    assert.equal(r.stamp.runs.semgrep.ran, false);
    assert.equal(r.stamp.runs.semgrep.skipped, true);
    assert.match(r.stamp.runs.semgrep.reason, /no semgrep config/);
    assert.deepEqual(r.stamp.runs.semgrep.findings, []);
  });
});

describe("verify/stamp: stampStage04c — findings_count := max(model, mechanical)", () => {
  it("model findings_count 0 + 2 mechanical (secret-scan) findings merges to 2, without forcing FAIL", async () => {
    const cwd = track(makeTargetProject({
      config: configWithVerify("    dependency_audit_command: null"),
    }));
    // Built via concatenation (not a literal contiguous secret-shaped string)
    // so GitHub push protection doesn't flag this test fixture as a real key —
    // the written file content is identical, so core/hooks/secret-scan.js's
    // "Generic API Key" pattern still matches it at scan time.
    const fixtureKeyValue = ["ABCDEFGHIJKLMNOPQRSTUVWXYZ", "abcdefghij0123"].join("");
    const secretLine = `const cfg = { api_key: "${fixtureKeyValue}" };\n`;
    fs.writeFileSync(path.join(cwd, "fixture-a.txt"), secretLine);
    fs.writeFileSync(path.join(cwd, "fixture-b.txt"), secretLine);
    fs.writeFileSync(path.join(cwd, "pipeline", "changed-files.txt"), "fixture-a.txt\nfixture-b.txt\n");

    const gatePath = seedGateRaw(cwd, "stage-04c", base04cGate({ status: "PASS", findings_count: 0 }));
    const r = await stampStage04c(cwd, gatePath);

    assert.equal(r.gate.findings_count, 2, "findings_count must be max(model=0, mechanical=2) = 2");
    assert.equal(r.gate.severity_breakdown.medium, 2);
    assert.equal(r.stamp.runs.secret_scan.findings.length, 2);
    // "Generic API Key" is a warning-severity secret-scan pattern (mapped to
    // medium here), not high/critical — it must not force must-address or FAIL.
    assert.equal(r.gate.must_address_before_peer_review.length, 0);
    assert.equal(r.gate.status, "PASS");
  });

  it("never lowers a model-reported findings_count that already exceeds the mechanical count", async () => {
    const cwd = track(makeTargetProject({
      config: configWithVerify("    dependency_audit_command: null"),
    }));
    const gatePath = seedGateRaw(cwd, "stage-04c", base04cGate({ findings_count: 5 }));
    const r = await stampStage04c(cwd, gatePath);
    assert.equal(r.gate.findings_count, 5);
  });
});

describe("verify/stamp: stampStage04c — dependency diff", () => {
  it("skips with a clear reason when no package-lock.json exists", async () => {
    const cwd = track(makeTargetProject({
      config: configWithVerify("    dependency_audit_command: null"),
    }));
    const gatePath = seedGateRaw(cwd, "stage-04c", base04cGate());
    const r = await stampStage04c(cwd, gatePath);
    assert.equal(r.stamp.runs.dependency_diff.ran, false);
    assert.match(r.stamp.runs.dependency_diff.reason, /no package-lock\.json/);
  });

  it("records a baseline snapshot on the first attempt (no previous stage-04c archive)", async () => {
    const cwd = track(makeTargetProject({
      config: configWithVerify("    dependency_audit_command: null"),
    }));
    fs.writeFileSync(path.join(cwd, "package-lock.json"), JSON.stringify({
      lockfileVersion: 3,
      packages: { "": {}, "node_modules/left-pad": { version: "1.0.0" } },
    }));
    const gatePath = seedGateRaw(cwd, "stage-04c", base04cGate());
    const r = await stampStage04c(cwd, gatePath);
    assert.equal(r.stamp.runs.dependency_diff.ran, true);
    assert.deepEqual(r.stamp.runs.dependency_diff.new_dependencies, []);
    assert.ok(r.stamp.runs.dependency_diff.snapshot["left-pad"]);
  });
});

describe("verify/stamp: stampStage04c — multi-tool stamp block shape", () => {
  it("every tool run record carries {ran, skipped, reason, findings}", async () => {
    const cwd = track(makeTargetProject({
      config: configWithVerify("    dependency_audit_command: null"),
    }));
    const gatePath = seedGateRaw(cwd, "stage-04c", base04cGate());
    const r = await stampStage04c(cwd, gatePath);
    for (const tool of ["dependency_audit", "secret_scan", "semgrep", "dependency_diff"]) {
      const run = r.stamp.runs[tool];
      assert.ok(run, `missing stamp.runs.${tool}`);
      assert.equal(typeof run.ran, "boolean", `${tool}.ran must be boolean`);
      assert.equal(typeof run.skipped, "boolean", `${tool}.skipped must be boolean`);
      assert.ok("reason" in run, `${tool} must carry a reason`);
      assert.ok(Array.isArray(run.findings), `${tool}.findings must be an array`);
    }
  });
});
