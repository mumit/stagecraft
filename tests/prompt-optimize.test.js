// scripts/prompt-optimize.js — GEPA-style offline prompt optimizer (phase-33
// item 33.4, plans/phase-33-eval-flywheel.md §33.4). Out-of-band script, not
// a `devteam` command: given a captured eval-case fixture corpus and a
// scripted headless host, it should diagnose failures via one frontier-model
// call per iteration, propose a revised target file, score the candidate,
// and emit a unified diff + evidence table — without ever writing the
// target file itself.

const { describe, it, afterEach } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { REPO_ROOT, makeTargetProject, cleanup } = require("./_helpers");
const {
  runOptimize,
  parseTarget,
  exercisedStageIds,
  paretoAdd,
  pickWinner,
  parseCandidateResponse,
  DIAGNOSIS_MARKER,
} = require(path.join(REPO_ROOT, "scripts", "prompt-optimize"));

const FIXTURE_CORPUS = path.join(REPO_ROOT, "tests", "fixtures", "evals");
// rules/gates-core.md sits in every stage's readFirst (including stage-04a
// and stage-06, the two fixture cases below) — a real, small, checked-in
// rule file this script only ever reads, never writes.
const TARGET = "rules/gates-core.md";

let _dirs = [];
function track(cwd) { _dirs.push(cwd); return cwd; }
afterEach(() => { _dirs.forEach(cleanup); _dirs = []; });

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

// A scripted "headless host" that answers BOTH kinds of prompts this script
// sends over the same DEVTEAM_HEADLESS_COMMAND: an ordinary stage-dispatch
// prompt (real-model subset — "Write to `<gatePath>`", answered PASS/FAIL)
// and a diagnosis prompt (marked with DIAGNOSIS_MARKER), answered with a
// scripted candidate JSON. Every diagnosis call appends a line to
// `<cwd>/diagnosis-calls.log` so tests can assert exact invocation counts
// (the iteration-bound test).
function scriptedHost(cwd, { targetPath, revisedContent, gateStatus = "PASS" }) {
  const scriptPath = path.join(cwd, "scripted-host.js");
  fs.writeFileSync(scriptPath, `
    const fs = require("fs");
    const path = require("path");
    let input = "";
    process.stdin.on("data", (c) => { input += c; });
    process.stdin.on("end", () => {
      if (input.includes(${JSON.stringify(DIAGNOSIS_MARKER)})) {
        fs.appendFileSync(path.join(${JSON.stringify(cwd)}, "diagnosis-calls.log"), "call\\n");
        process.stdout.write(JSON.stringify({
          target_path: ${JSON.stringify(targetPath)},
          diagnosis: "test diagnosis",
          revised_content: ${JSON.stringify(revisedContent)},
        }));
        process.exit(0);
        return;
      }
      const m = input.match(/Write to \`([^\`]+)\`/);
      if (!m) { process.exit(1); return; }
      const gatePath = path.join(process.cwd(), m[1]);
      fs.mkdirSync(path.dirname(gatePath), { recursive: true });
      fs.writeFileSync(gatePath, JSON.stringify({ status: ${JSON.stringify(gateStatus)}, blockers: [], warnings: [] }, null, 2));
      process.exit(0);
    });
  `);
  return `"${process.execPath}" "${scriptPath}"`;
}

function diagnosisCallCount(cwd) {
  const p = path.join(cwd, "diagnosis-calls.log");
  if (!fs.existsSync(p)) return 0;
  return fs.readFileSync(p, "utf8").split("\n").filter(Boolean).length;
}

describe("prompt-optimize: parseTarget / exercisedStageIds", () => {
  it("accepts a real rules/ file and resolves its exercised stages", () => {
    const target = parseTarget(TARGET);
    assert.equal(target.kind, "rule");
    assert.equal(target.name, "gates-core");
    const stages = exercisedStageIds(target);
    assert.ok(stages.includes("stage-04a"));
    assert.ok(stages.includes("stage-06"));
  });

  it("rejects a target that isn't roles/ or rules/", () => {
    assert.throws(() => parseTarget("AGENTS.md"), /must match roles/);
  });

  it("rejects a target file that doesn't exist", () => {
    assert.throws(() => parseTarget("roles/does-not-exist.md"), /does not exist/);
  });
});

describe("prompt-optimize: Pareto frontier", () => {
  it("keeps non-dominated candidates and prunes dominated ones", () => {
    let frontier = [];
    frontier = paretoAdd(frontier, { iteration: 1, pass_rate: 0.5, tokens_est: 100 });
    frontier = paretoAdd(frontier, { iteration: 2, pass_rate: 0.8, tokens_est: 120 }); // higher pass, higher cost — kept alongside
    frontier = paretoAdd(frontier, { iteration: 3, pass_rate: 0.9, tokens_est: 90 }); // dominates both
    assert.equal(frontier.length, 1);
    assert.equal(frontier[0].iteration, 3);
    assert.equal(pickWinner(frontier).iteration, 3);
  });

  it("never keeps a candidate with pass_rate: null", () => {
    const frontier = paretoAdd([], { iteration: 1, pass_rate: null, tokens_est: 10 });
    assert.equal(frontier.length, 0);
  });
});

describe("prompt-optimize: parseCandidateResponse diff-scope guard", () => {
  it("accepts a response whose target_path matches exactly", () => {
    const out = parseCandidateResponse(
      JSON.stringify({ target_path: TARGET, diagnosis: "d", revised_content: "x" }), TARGET,
    );
    assert.equal(out.ok, true);
    assert.equal(out.revisedContent, "x");
  });

  it("rejects a response proposing a different file", () => {
    const out = parseCandidateResponse(
      JSON.stringify({ target_path: "roles/other.md", diagnosis: "d", revised_content: "x" }), TARGET,
    );
    assert.equal(out.ok, false);
    assert.equal(out.scopeViolation, true);
    assert.match(out.reason, /diff-scope guard/);
  });

  it("rejects malformed JSON", () => {
    const out = parseCandidateResponse("not json", TARGET);
    assert.equal(out.ok, false);
  });
});

describe("prompt-optimize: --budget-usd is mandatory", () => {
  it("refuses without --budget-usd, before any dispatch", async () => {
    const cwd = track(makeTargetProject());
    seedFixtureCorpus(cwd);
    // A command that would fail loudly if ever invoked — proves refusal
    // happens before any dispatch.
    const result = await withHeadlessCommand("node -e \"process.exit(7)\"", () =>
      runOptimize(cwd, { target: TARGET, model: "claude-code" }));
    assert.equal(result.ok, false);
    assert.equal(result.exitCode, 1);
    assert.match(result.reason, /--budget-usd/);
    assert.equal(fs.existsSync(path.join(cwd, ".devteam", "evals", "optimize")), false);
  });

  it("refuses on a non-positive --budget-usd", async () => {
    const cwd = track(makeTargetProject());
    seedFixtureCorpus(cwd);
    const result = await runOptimize(cwd, { target: TARGET, model: "claude-code", budgetUsd: 0 });
    assert.equal(result.ok, false);
    assert.match(result.reason, /--budget-usd/);
  });
});

describe("prompt-optimize: end-to-end with a scripted model + fixture corpus", () => {
  it("produces a diff touching only the target file, plus an evidence table, and never writes the target file", async () => {
    const cwd = track(makeTargetProject());
    seedFixtureCorpus(cwd);
    const originalContent = fs.readFileSync(path.join(REPO_ROOT, TARGET), "utf8");
    const cmd = scriptedHost(cwd, {
      targetPath: TARGET,
      revisedContent: "# Revised gates-core\n\nBe stricter about blockers.\n",
    });

    const result = await withHeadlessCommand(cmd, () =>
      runOptimize(cwd, { target: TARGET, model: "claude-code", budgetUsd: 50, iterations: 1, sample: 2 }));

    assert.equal(result.ok, true);
    assert.equal(result.exitCode, 0);
    assert.ok(result.report.winner);
    assert.ok(typeof result.report.diff === "string" && result.report.diff.length > 0);
    assert.match(result.report.diff, /a\/rules\/gates-core\.md/);
    assert.match(result.report.diff, /b\/rules\/gates-core\.md/);
    // Only the target file appears anywhere in the diff.
    const otherFileMentions = result.report.diff.match(/[ab]\/(roles|rules)\/[\w.-]+\.md/g) || [];
    assert.ok(otherFileMentions.every((m) => m.endsWith("rules/gates-core.md")));

    assert.equal(result.report.structural_baseline.ok, true);
    assert.equal(result.report.cases_matched, 2);
    assert.ok(result.report.baseline && typeof result.report.baseline.pass_rate === "number");
    assert.ok(fs.existsSync(result.reportPath));

    // Never wrote the real repo file.
    assert.equal(fs.readFileSync(path.join(REPO_ROOT, TARGET), "utf8"), originalContent);
  });

  it("respects the --sample bound on real-model dispatch count", async () => {
    const cwd = track(makeTargetProject());
    seedFixtureCorpus(cwd);
    const cmd = scriptedHost(cwd, { targetPath: TARGET, revisedContent: "# small\n" });
    const result = await withHeadlessCommand(cmd, () =>
      runOptimize(cwd, { target: TARGET, model: "claude-code", budgetUsd: 50, iterations: 1, sample: 1 }));
    assert.equal(result.ok, true);
    assert.equal(result.report.baseline.dispatched, 1);
  });
});

describe("prompt-optimize: diff-scope guard end-to-end", () => {
  it("rejects a candidate proposing a different target_path — no diff, no candidate kept", async () => {
    const cwd = track(makeTargetProject());
    seedFixtureCorpus(cwd);
    const cmd = scriptedHost(cwd, {
      targetPath: "roles/some-other-role.md", // wrong on purpose
      revisedContent: "# sneaky\n",
    });

    const result = await withHeadlessCommand(cmd, () =>
      runOptimize(cwd, { target: TARGET, model: "claude-code", budgetUsd: 50, iterations: 2, sample: 1 }));

    assert.equal(result.ok, true); // the run completes; it just found nothing viable
    assert.equal(result.exitCode, 1);
    assert.equal(result.report.winner, null);
    assert.equal(result.report.diff, null);
    assert.equal(result.report.frontier.length, 0);
    assert.ok(result.report.rejected.length >= 1);
    assert.match(result.report.rejected[0].reason, /diff-scope guard/);
  });
});

describe("prompt-optimize: iteration bound", () => {
  it("calls the diagnosis model exactly --iterations times, never more", async () => {
    const cwd = track(makeTargetProject());
    seedFixtureCorpus(cwd);
    const cmd = scriptedHost(cwd, { targetPath: TARGET, revisedContent: "# candidate\n" });

    const result = await withHeadlessCommand(cmd, () =>
      runOptimize(cwd, { target: TARGET, model: "claude-code", budgetUsd: 50, iterations: 3, sample: 1 }));

    assert.equal(result.ok, true);
    assert.equal(diagnosisCallCount(cwd), 3);
  });
});
