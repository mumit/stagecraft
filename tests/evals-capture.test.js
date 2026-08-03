// core/evals/capture.js — eval flywheel capture (phase-33 item 33.1,
// plans/phase-33-eval-flywheel.md §33.1). Failed gates and stamp overrides
// become replayable cases under .devteam/evals/cases/, with readFirst
// artifacts content-addressed and deduped into .devteam/evals/blobs/.

const { describe, it, afterEach } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { REPO_ROOT, makeTargetProject, cleanup, runCLI } = require("./_helpers");
const { runStageHeadless } = require(path.join(REPO_ROOT, "core", "orchestrator"));
const { run: runDriver } = require(path.join(REPO_ROOT, "core", "driver"));
const { loadConfig } = require(path.join(REPO_ROOT, "core", "config"));
const { stampStage04a } = require(path.join(REPO_ROOT, "core", "verify", "stamp"));
const {
  captureEvalCase, linkResolutions, gc, casesDir, blobsDir,
} = require(path.join(REPO_ROOT, "core", "evals", "capture"));

let _dirs = [];
function track(cwd) { _dirs.push(cwd); return cwd; }
afterEach(() => { _dirs.forEach(cleanup); _dirs = []; });

// Shaped like a GitHub personal token (ghp_ + 36 alnum chars) — matches
// core/hooks/secret-scan.js SECRET_PATTERNS without being a real key.
const FAKE_SECRET = `ghp_${"A".repeat(36)}`;

function seedGate(cwd, name, gate) {
  const dir = path.join(cwd, "pipeline", "gates");
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, `${name}.json`), JSON.stringify(gate, null, 2) + "\n", "utf8");
  return path.join(dir, `${name}.json`);
}

function writeContext(cwd, content) {
  fs.mkdirSync(path.join(cwd, "pipeline"), { recursive: true });
  fs.writeFileSync(path.join(cwd, "pipeline", "context.md"), content, "utf8");
}

function listCaseDirs(cwd) {
  try { return fs.readdirSync(casesDir(cwd)); } catch { return []; }
}

function withHeadlessCommand(cmd, fn) {
  const previous = process.env.DEVTEAM_HEADLESS_COMMAND;
  process.env.DEVTEAM_HEADLESS_COMMAND = cmd;
  return Promise.resolve().then(fn).finally(() => {
    if (previous === undefined) delete process.env.DEVTEAM_HEADLESS_COMMAND;
    else process.env.DEVTEAM_HEADLESS_COMMAND = previous;
  });
}

describe("evals/capture: captureEvalCase — unit", () => {
  it("writes a complete case directory for a FAIL gate, snapshotting readFirst into a content-addressed blob", () => {
    const cwd = track(makeTargetProject());
    writeContext(cwd, "# Context\nSome ordinary project context, no secrets here.\n");
    const gatePath = seedGate(cwd, "stage-01", {
      stage: "stage-01", status: "FAIL", host: "claude-code", track: "full",
      blockers: ["acceptance criteria incomplete"], warnings: [],
      orchestrator: "devteam@test", timestamp: "2026-08-01T00:00:00Z",
    });

    const result = captureEvalCase(cwd, {
      config: loadConfig(cwd),
      gatePath,
      stage: "stage-01",
      role: "pm",
      host: "claude-code",
      track: "full",
      runId: "run-1",
      promptHash: "deadbeef",
      readFirst: ["pipeline/context.md"],
    });

    assert.equal(result.ok, true);
    assert.ok(fs.existsSync(result.dir));
    const caseJson = JSON.parse(fs.readFileSync(path.join(result.dir, "case.json"), "utf8"));
    assert.equal(caseJson.stage, "stage-01");
    assert.equal(caseJson.role, "pm");
    assert.equal(caseJson.host, "claude-code");
    assert.equal(caseJson.track, "full");
    assert.equal(caseJson.run_id, "run-1");
    assert.equal(caseJson.prompt_hash, "deadbeef");
    assert.equal(caseJson.capture_reason, "gate-fail");
    assert.equal(caseJson.gate.status, "FAIL");
    assert.ok(caseJson.reproducibility, "C4 reproducibility fingerprint recorded");
    assert.ok(caseJson.framework_version);

    const manifest = JSON.parse(fs.readFileSync(path.join(result.dir, "inputs", "manifest.json"), "utf8"));
    assert.equal(manifest.length, 1);
    assert.equal(manifest[0].path, "pipeline/context.md");
    assert.ok(/^[0-9a-f]{64}$/.test(manifest[0].sha256));
    assert.ok(fs.existsSync(path.join(blobsDir(cwd), `${manifest[0].sha256}.blob`)));
  });

  // 33.3: prompt_pack_version round-trips from the gate into the eval case,
  // the same way the run corpus reads it (core/corpus.js recordDispatch) —
  // and is recorded as null, never omitted, when the gate doesn't carry one.
  it("records prompt_pack_version from the gate, and null when the gate doesn't carry one", () => {
    const cwd = track(makeTargetProject());
    const withVersion = seedGate(cwd, "stage-01", {
      stage: "stage-01", status: "FAIL", host: "claude-code", track: "full",
      blockers: ["nope"], warnings: [], prompt_pack_version: "abc123def456",
    });
    const r1 = captureEvalCase(cwd, { config: loadConfig(cwd), gatePath: withVersion, stage: "stage-01" });
    const case1 = JSON.parse(fs.readFileSync(path.join(r1.dir, "case.json"), "utf8"));
    assert.equal(case1.prompt_pack_version, "abc123def456");

    const noVersion = seedGate(cwd, "stage-02", {
      stage: "stage-02", status: "FAIL", host: "claude-code", track: "full",
      blockers: ["nope"], warnings: [],
    });
    const r2 = captureEvalCase(cwd, { config: loadConfig(cwd), gatePath: noVersion, stage: "stage-02" });
    const case2 = JSON.parse(fs.readFileSync(path.join(r2.dir, "case.json"), "utf8"));
    assert.equal(case2.prompt_pack_version, null);
  });

  it("captures on stamp status_overridden (model-lied class), recording capture_reason: stamp-override", async () => {
    const cwd = track(makeTargetProject({
      config: "routing:\n  default_host: generic\npipeline:\n  default_track: full\n  verify:\n    lint_command: \"false\"\n    test_command: \"true\"\n",
    }));
    const gatePath = seedGate(cwd, "stage-04a", {
      stage: "stage-04a", status: "PASS", orchestrator: "devteam@test", host: "generic",
      track: "full", timestamp: "2026-08-01T00:00:00Z", blockers: [], warnings: [],
      lint_passed: true, tests_passed: true, // model claimed PASS; lint actually fails
      dependency_review_passed: true, security_review_required: false,
    });
    const stamped = await stampStage04a(cwd, gatePath);
    assert.ok(stamped.gate._orchestrator_stamped.status_overridden, "sanity: stamp actually flipped status");

    const result = captureEvalCase(cwd, {
      config: loadConfig(cwd),
      gate: stamped.gate,
      gatePath,
      stage: "stage-04a",
      role: "platform",
    });
    assert.equal(result.ok, true);
    const caseJson = JSON.parse(fs.readFileSync(path.join(result.dir, "case.json"), "utf8"));
    assert.equal(caseJson.capture_reason, "stamp-override");
    assert.equal(caseJson.gate.status, "FAIL");
  });

  it("disabled (evals.capture: false) captures nothing", () => {
    const cwd = track(makeTargetProject({
      config: "routing:\n  default_host: generic\npipeline:\n  default_track: full\nevals:\n  capture: false\n",
    }));
    const gatePath = seedGate(cwd, "stage-01", {
      stage: "stage-01", status: "FAIL", host: "generic", track: "full",
      blockers: ["nope"], warnings: [], orchestrator: "devteam@test",
      timestamp: "2026-08-01T00:00:00Z",
    });
    const config = loadConfig(cwd);
    assert.equal(config.evals.capture, false, "sanity: config parsed the opt-out");

    const result = captureEvalCase(cwd, { config, gatePath, stage: "stage-01" });
    assert.equal(result.ok, false);
    assert.equal(result.reason, "disabled");
    assert.equal(listCaseDirs(cwd).length, 0);
  });

  it("excludes a readFirst file that scans positive for a planted secret — never writes it to a blob", () => {
    const cwd = track(makeTargetProject());
    writeContext(cwd, `# Context\ntoken leaked: ${FAKE_SECRET}\n`);
    const gatePath = seedGate(cwd, "stage-01", {
      stage: "stage-01", status: "FAIL", host: "generic", track: "full",
      blockers: [], warnings: [], orchestrator: "devteam@test",
      timestamp: "2026-08-01T00:00:00Z",
    });

    const result = captureEvalCase(cwd, {
      config: loadConfig(cwd), gatePath, stage: "stage-01", readFirst: ["pipeline/context.md"],
    });
    assert.equal(result.ok, true);
    const manifest = JSON.parse(fs.readFileSync(path.join(result.dir, "inputs", "manifest.json"), "utf8"));
    assert.equal(manifest.length, 1);
    assert.equal(manifest[0].excluded, "secret-detected");
    assert.equal(manifest[0].sha256, undefined);
    assert.deepEqual(fs.existsSync(blobsDir(cwd)) ? fs.readdirSync(blobsDir(cwd)) : [], []);
  });

  it("dedups: two cases snapshotting the same artifact content produce exactly one blob", () => {
    const cwd = track(makeTargetProject());
    writeContext(cwd, "# Context\nShared content across two failing stages.\n");
    const gatePath1 = seedGate(cwd, "stage-01", {
      stage: "stage-01", status: "FAIL", host: "generic", track: "full",
      blockers: [], warnings: [], orchestrator: "devteam@test", timestamp: "2026-08-01T00:00:00Z",
    });
    const gatePath2 = seedGate(cwd, "stage-02", {
      stage: "stage-02", status: "FAIL", host: "generic", track: "full",
      blockers: [], warnings: [], orchestrator: "devteam@test", timestamp: "2026-08-01T00:01:00Z",
    });
    const config = loadConfig(cwd);
    const r1 = captureEvalCase(cwd, { config, gatePath: gatePath1, stage: "stage-01", readFirst: ["pipeline/context.md"] });
    const r2 = captureEvalCase(cwd, { config, gatePath: gatePath2, stage: "stage-02", readFirst: ["pipeline/context.md"] });
    assert.equal(r1.ok, true);
    assert.equal(r2.ok, true);
    assert.notEqual(r1.dir, r2.dir);

    assert.equal(listCaseDirs(cwd).length, 2);
    const blobs = fs.readdirSync(blobsDir(cwd));
    assert.equal(blobs.length, 1, "identical artifact content across two cases dedups to one blob");

    const m1 = JSON.parse(fs.readFileSync(path.join(r1.dir, "inputs", "manifest.json"), "utf8"));
    const m2 = JSON.parse(fs.readFileSync(path.join(r2.dir, "inputs", "manifest.json"), "utf8"));
    assert.equal(m1[0].sha256, m2[0].sha256);
  });
});

describe("evals/capture: linkResolutions", () => {
  function runLogLine(entry) { return JSON.stringify({ ts: entry.ts, ...entry }) + "\n"; }

  it("links a resolution once a later fix-retry run-log event clears the stage's current gate", () => {
    const cwd = track(makeTargetProject());
    const gatePath = seedGate(cwd, "stage-04", {
      stage: "stage-04", status: "FAIL", host: "generic", track: "full",
      blockers: ["build broke"], warnings: [], orchestrator: "devteam@test",
      timestamp: "2026-08-01T00:00:00Z",
    });
    const config = loadConfig(cwd);
    const captured = captureEvalCase(cwd, { config, gatePath, stage: "stage-04" });
    assert.equal(captured.ok, true);
    const capturedAt = JSON.parse(fs.readFileSync(path.join(captured.dir, "case.json"), "utf8")).captured_at;
    const laterTs = new Date(new Date(capturedAt).getTime() + 5 * 60 * 1000).toISOString();

    // No fix-retry yet, gate still FAIL — nothing to link.
    assert.equal(linkResolutions(cwd, { changeId: null }).linked, 0);
    assert.equal(fs.existsSync(path.join(captured.dir, "resolution.json")), false);

    // A fix-retry lands in run-log.jsonl after the case was captured...
    fs.writeFileSync(
      path.join(cwd, "pipeline", "run-log.jsonl"),
      runLogLine({ ts: laterTs, stage: "stage-04", outcome: "fix-retry", attempt: 1, cleared_gates: 1, derivable: true }),
      "utf8",
    );
    // ...and the stage's current gate is still FAIL: still unresolved.
    assert.equal(linkResolutions(cwd, { changeId: null }).linked, 0);

    // Now the retry actually clears the gate.
    fs.writeFileSync(gatePath, JSON.stringify({
      stage: "stage-04", status: "PASS", host: "generic", track: "full",
      blockers: [], warnings: [], orchestrator: "devteam@test", timestamp: "2026-08-01T00:06:00Z",
    }, null, 2) + "\n", "utf8");

    const result = linkResolutions(cwd, { changeId: null });
    assert.equal(result.linked, 1);
    const resolution = JSON.parse(fs.readFileSync(path.join(captured.dir, "resolution.json"), "utf8"));
    assert.equal(resolution.stage, "stage-04");
    assert.equal(resolution.cleared_by_retry.attempt, 1);
    assert.equal(resolution.cleared_by_retry.cleared_gates, 1);

    // Idempotent: a case with resolution.json already written is skipped.
    assert.equal(linkResolutions(cwd, { changeId: null }).linked, 0);
  });
});

describe("evals/capture: gc", () => {
  it("removes blobs no case's inputs/manifest.json references, keeps referenced ones", () => {
    const cwd = track(makeTargetProject());
    writeContext(cwd, "# Context\nreferenced content\n");
    const gatePath = seedGate(cwd, "stage-01", {
      stage: "stage-01", status: "FAIL", host: "generic", track: "full",
      blockers: [], warnings: [], orchestrator: "devteam@test", timestamp: "2026-08-01T00:00:00Z",
    });
    const config = loadConfig(cwd);
    const captured = captureEvalCase(cwd, { config, gatePath, stage: "stage-01", readFirst: ["pipeline/context.md"] });
    assert.equal(captured.ok, true);

    // Plant an orphan blob with no referencing case.
    fs.mkdirSync(blobsDir(cwd), { recursive: true });
    fs.writeFileSync(path.join(blobsDir(cwd), "0".repeat(64) + ".blob"), "orphan", "utf8");
    assert.equal(fs.readdirSync(blobsDir(cwd)).length, 2);

    const result = gc(cwd);
    assert.equal(result.removed, 1);
    assert.equal(result.kept, 1);
    const remaining = fs.readdirSync(blobsDir(cwd));
    assert.equal(remaining.length, 1);
    assert.notEqual(remaining[0], "0".repeat(64) + ".blob");
  });

  it("devteam evals gc (CLI) reports removed/kept counts as JSON", () => {
    const cwd = track(makeTargetProject());
    writeContext(cwd, "# Context\nreferenced via CLI\n");
    const gatePath = seedGate(cwd, "stage-01", {
      stage: "stage-01", status: "FAIL", host: "generic", track: "full",
      blockers: [], warnings: [], orchestrator: "devteam@test", timestamp: "2026-08-01T00:00:00Z",
    });
    captureEvalCase(cwd, { config: loadConfig(cwd), gatePath, stage: "stage-01", readFirst: ["pipeline/context.md"] });
    fs.mkdirSync(blobsDir(cwd), { recursive: true });
    fs.writeFileSync(path.join(blobsDir(cwd), "1".repeat(64) + ".blob"), "orphan", "utf8");

    const result = runCLI(["evals", "gc", "--json"], { cwd });
    assert.equal(result.status, 0);
    const parsed = JSON.parse(result.stdout);
    assert.equal(parsed.removed, 1);
    assert.equal(parsed.kept, 1);
  });
});

describe("evals/capture: wired into runStageHeadless (orchestrator integration)", () => {
  function makeFailStub(dir, stageFile) {
    const script = path.join(dir, "fail-stub.js");
    fs.writeFileSync(script, `const fs = require("node:fs");
const path = require("node:path");
const gateFile = path.join(process.cwd(), "pipeline", "gates", "${stageFile}");
fs.writeFileSync(gateFile, JSON.stringify({
  stage: "${stageFile.replace(/\\.json$/, "")}", host: "claude-code", status: "FAIL", track: "full",
  blockers: ["acceptance criteria incomplete"], warnings: [], orchestrator: "devteam@test",
  timestamp: "2026-08-01T00:00:00.000Z"
}, null, 2) + "\\n");
`, "utf8");
    return script;
  }

  it("a stubbed FAIL dispatch produces a complete eval case directory", async () => {
    const cwd = track(makeTargetProject({
      config: "routing:\n  default_host: claude-code\npipeline:\n  default_track: full\n",
    }));
    writeContext(cwd, "# Context\nplain project context\n");
    const script = makeFailStub(cwd, "stage-01.json");
    await withHeadlessCommand(`${process.execPath} ${script}`, async () => {
      await runStageHeadless("requirements", { cwd, runId: "run-xyz" });
    });

    const names = listCaseDirs(cwd);
    assert.equal(names.length, 1, "exactly one eval case captured");
    const caseDir = path.join(casesDir(cwd), names[0]);
    const caseJson = JSON.parse(fs.readFileSync(path.join(caseDir, "case.json"), "utf8"));
    assert.equal(caseJson.stage, "stage-01");
    assert.equal(caseJson.role, "pm");
    assert.equal(caseJson.host, "claude-code");
    assert.equal(caseJson.run_id, "run-xyz");
    assert.equal(caseJson.capture_reason, "gate-fail");
    assert.match(caseJson.prompt_hash, /^[0-9a-f]{64}$/);

    const manifest = JSON.parse(fs.readFileSync(path.join(caseDir, "inputs", "manifest.json"), "utf8"));
    assert.ok(manifest.some((m) => m.path === "pipeline/context.md" && /^[0-9a-f]{64}$/.test(m.sha256)));
  });

  it("does not capture a PASSing single-role dispatch", async () => {
    const cwd = track(makeTargetProject({
      config: "routing:\n  default_host: claude-code\npipeline:\n  default_track: full\n",
    }));
    const script = path.join(cwd, "pass-stub.js");
    fs.writeFileSync(script, `const fs = require("node:fs");
const path = require("node:path");
const gateFile = path.join(process.cwd(), "pipeline", "gates", "stage-01.json");
fs.writeFileSync(gateFile, JSON.stringify({
  stage: "stage-01", host: "claude-code", status: "PASS", track: "full",
  blockers: [], warnings: [], orchestrator: "devteam@test",
  timestamp: "2026-08-01T00:00:00.000Z"
}, null, 2) + "\\n");
`, "utf8");
    await withHeadlessCommand(`${process.execPath} ${script}`, async () => {
      await runStageHeadless("requirements", { cwd });
    });
    assert.equal(listCaseDirs(cwd).length, 0);
  });
});

describe("evals/capture: wired into driver.js merge branch", () => {
  it("captures the merged gate for a multi-workstream stage that FAILed", async () => {
    const cwd = track(makeTargetProject());
    const gatesPath = path.join(cwd, "pipeline", "gates", "stage-04.json");
    fs.mkdirSync(path.dirname(gatesPath), { recursive: true });
    const mergedGate = {
      stage: "stage-04", status: "FAIL", host: "claude-code", track: "full",
      blockers: ["backend workstream failed"], warnings: [],
      orchestrator: "devteam@test", timestamp: "2026-08-01T00:00:00Z",
      workstreams: [{ workstream: "backend", status: "FAIL" }],
    };
    fs.writeFileSync(gatesPath, JSON.stringify(mergedGate, null, 2) + "\n", "utf8");

    // Drive exactly one merge (fake mergeWorkstreamGates so no real fan-out
    // dispatch is needed) then halt — driver-transition.test.js's pattern for
    // pinning a single injected action sequence.
    const actions = [
      { action: "merge", stage: "stage-04", name: "build" },
      { action: "resolve-escalation", stage: "stage-04", name: "build", failure_class: "convergence-exhausted", reason: "test halt after merge capture" },
    ];
    let idx = 0;
    const summary = await runDriver({
      cwd,
      next: () => actions[idx++],
      mergeWorkstreamGates: () => ({ merged: true, file: gatesPath, gate: mergedGate }),
    });
    assert.equal(summary.halted, true);

    const names = listCaseDirs(cwd);
    assert.equal(names.length, 1, "exactly one eval case captured for the merged FAIL gate");
    const caseJson = JSON.parse(fs.readFileSync(path.join(casesDir(cwd), names[0], "case.json"), "utf8"));
    assert.equal(caseJson.stage, "stage-04");
    assert.equal(caseJson.gate.status, "FAIL");
  });
});
