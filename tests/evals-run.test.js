// core/evals/run.js — eval flywheel replay harness (phase-33 item 33.2,
// plans/phase-33-eval-flywheel.md §33.2). Replays cases captured by
// core/evals/capture.js (33.1) against the CURRENT framework: --stub scores
// structurally (free, no model); --headless-host dispatches for real via
// the existing headless machinery and flags a resolved case that fails
// again as a regression.

const { describe, it, afterEach } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { REPO_ROOT, makeTargetProject, cleanup } = require("./_helpers");
const { runEvals, loadCases } = require(path.join(REPO_ROOT, "core", "evals", "run"));

const FIXTURE_CORPUS = path.join(REPO_ROOT, "tests", "fixtures", "evals");

let _dirs = [];
function track(cwd) { _dirs.push(cwd); return cwd; }
afterEach(() => { _dirs.forEach(cleanup); _dirs = []; });

// Copies the checked-in fixture corpus (tests/fixtures/evals/{cases,blobs})
// into <cwd>/.devteam/evals/ — the layout core/evals/capture.js writes.
function seedFixtureCorpus(cwd) {
  const dest = path.join(cwd, ".devteam", "evals");
  fs.mkdirSync(dest, { recursive: true });
  fs.cpSync(path.join(FIXTURE_CORPUS, "cases"), path.join(dest, "cases"), { recursive: true });
  fs.cpSync(path.join(FIXTURE_CORPUS, "blobs"), path.join(dest, "blobs"), { recursive: true });
}

function withHeadlessCommand(cmd, fn) {
  const previous = process.env.DEVTEAM_HEADLESS_COMMAND;
  process.env.DEVTEAM_HEADLESS_COMMAND = cmd;
  return Promise.resolve().then(fn).finally(() => {
    if (previous === undefined) delete process.env.DEVTEAM_HEADLESS_COMMAND;
    else process.env.DEVTEAM_HEADLESS_COMMAND = previous;
  });
}

// A scripted "headless host": reads the prompt from stdin, finds the gate
// path devteam told it to write ("Write to `<path>`"), and writes a gate
// with the given status — same shape a real host would produce, without a
// model. Mirrors the DEVTEAM_HEADLESS_COMMAND=cat convention used elsewhere
// (tests/headless.test.js, tests/evals-capture.test.js).
function scriptedGateWriter(cwd, status) {
  const scriptPath = path.join(cwd, "write-gate.js");
  fs.writeFileSync(scriptPath, `
    const fs = require("fs");
    const path = require("path");
    let input = "";
    process.stdin.on("data", (c) => { input += c; });
    process.stdin.on("end", () => {
      const m = input.match(/Write to \`([^\`]+)\`/);
      if (!m) { process.exit(1); return; }
      const gatePath = path.join(process.cwd(), m[1]);
      fs.mkdirSync(path.dirname(gatePath), { recursive: true });
      fs.writeFileSync(gatePath, JSON.stringify({ status: ${JSON.stringify(status)}, blockers: [], warnings: [] }, null, 2));
      process.exit(0);
    });
  `);
  return `"${process.execPath}" "${scriptPath}"`;
}

describe("evals/run: loadCases — fixture corpus", () => {
  it("reads the checked-in fixture corpus's two cases, one resolved", () => {
    const cwd = track(makeTargetProject());
    seedFixtureCorpus(cwd);
    const cases = loadCases(cwd);
    assert.equal(cases.length, 2);
    const byStage = Object.fromEntries(cases.map((c) => [c.caseJson.stage, c]));
    assert.equal(byStage["stage-04a"].resolved, false);
    assert.equal(byStage["stage-06"].resolved, true);
  });
});

describe("evals/run: --stub structural scoring", () => {
  it("scores every fixture case OK against the current framework, exit 0", async () => {
    const cwd = track(makeTargetProject());
    seedFixtureCorpus(cwd);
    const outcome = await runEvals(cwd, { mode: "stub" });
    assert.equal(outcome.exitCode, 0);
    assert.equal(outcome.cases.length, 2);
    for (const c of outcome.cases) {
      assert.equal(c.status, "ok", JSON.stringify(c));
      assert.equal(c.mode, "stub");
      assert.ok(typeof c.prompt_hash === "string" && c.prompt_hash.length === 64);
      // The case's own prompt_hash was captured against different (fixture-
      // seeded) inputs and ctx — drift is expected and merely reported.
      assert.equal(c.prompt_hash_drift, true);
    }
  });

  it("--filter narrows to cases matching a stage id", async () => {
    const cwd = track(makeTargetProject());
    seedFixtureCorpus(cwd);
    const outcome = await runEvals(cwd, { mode: "stub", filter: "stage-06" });
    assert.equal(outcome.total, 2);
    assert.equal(outcome.matched, 1);
    assert.equal(outcome.cases[0].stage, "stage-06");
  });

  it("flags structural-fail (and exit 1) when a stage no longer exists in core/pipeline/stages.js", async () => {
    const cwd = track(makeTargetProject());
    seedFixtureCorpus(cwd);
    const cases = loadCases(cwd);
    const stage04a = cases.find((c) => c.caseJson.stage === "stage-04a");
    const raw = JSON.parse(fs.readFileSync(path.join(stage04a.dir, "case.json"), "utf8"));
    raw.stage = "stage-99-removed";
    fs.writeFileSync(path.join(stage04a.dir, "case.json"), JSON.stringify(raw, null, 2));

    const outcome = await runEvals(cwd, { mode: "stub", filter: stage04a.id });
    assert.equal(outcome.exitCode, 1);
    assert.equal(outcome.cases[0].status, "error");
    assert.match(outcome.cases[0].findings[0], /no longer exists/);
  });
});

describe("evals/run: --headless-host real dispatch + regression detection", () => {
  it("refuses a --headless-host sweep without --budget-usd, printing a cost preview", async () => {
    const cwd = track(makeTargetProject());
    seedFixtureCorpus(cwd);
    const outcome = await runEvals(cwd, { mode: "headless-host", headlessHost: "claude-code" });
    assert.equal(outcome.refused, true);
    assert.equal(outcome.exitCode, 1);
    assert.match(outcome.reason, /--budget-usd/);
    assert.ok(outcome.preview && typeof outcome.preview.dispatch_count === "number");
  });

  it("a resolved case that now dispatches to PASS scores verdict: pass, exit 0", async () => {
    const cwd = track(makeTargetProject());
    seedFixtureCorpus(cwd);
    await withHeadlessCommand(scriptedGateWriter(cwd, "PASS"), async () => {
      const outcome = await runEvals(cwd, {
        mode: "headless-host", headlessHost: "claude-code", filter: "stage-06", budgetUsd: 5,
      });
      assert.equal(outcome.exitCode, 0);
      assert.equal(outcome.cases.length, 1);
      assert.equal(outcome.cases[0].verdict, "pass");
      assert.equal(outcome.cases[0].gate_status, "PASS");
    });
  });

  it("seeded re-break: a resolved case that still dispatches to FAIL is a regression, exit 1", async () => {
    const cwd = track(makeTargetProject());
    seedFixtureCorpus(cwd);
    await withHeadlessCommand(scriptedGateWriter(cwd, "FAIL"), async () => {
      const outcome = await runEvals(cwd, {
        mode: "headless-host", headlessHost: "claude-code", filter: "stage-06", budgetUsd: 5,
      });
      assert.equal(outcome.exitCode, 1);
      assert.equal(outcome.cases[0].verdict, "regression");
      assert.equal(outcome.cases[0].gate_status, "FAIL");
    });
  });

  it("an unresolved case that still dispatches to FAIL is reported but does not fail the sweep", async () => {
    const cwd = track(makeTargetProject());
    seedFixtureCorpus(cwd);
    await withHeadlessCommand(scriptedGateWriter(cwd, "FAIL"), async () => {
      const outcome = await runEvals(cwd, {
        mode: "headless-host", headlessHost: "claude-code", filter: "stage-04a", budgetUsd: 5,
      });
      assert.equal(outcome.exitCode, 0);
      assert.equal(outcome.cases[0].verdict, "still-failing");
    });
  });
});
