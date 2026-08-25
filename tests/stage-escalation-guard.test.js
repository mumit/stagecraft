// `devteam stage <name>` — guard against dispatching a stage strictly later
// than one still sitting on an unresolved ESCALATE gate.
//
// Regression: a real headless run had the escalation-applicator agent run
// `devteam stage qa --headless` (bare `qa` = stage-06, QA Testing) to "fix"
// a qa build blocker while stage-04 (build) was still ESCALATE. The command
// is a direct dispatch — it bypasses `next()`'s recommendation entirely — so
// it happily ran stage-06, produced a new FAIL gate there, and `devteam
// validate` reported stage-04's escalation as BYPASSED. This guard makes
// that specific move (skip forward past an unresolved judgment call) a hard
// refusal instead of a silent, hard-to-notice pipeline corruption.

const { describe, it, afterEach } = require("node:test");
const assert = require("node:assert/strict");
const path = require("node:path");
const { spawnSync } = require("node:child_process");
const { BIN, makeTargetProject, seedGate, cleanup } = require("./_helpers");

let _dirs = [];
function track(cwd) { _dirs.push(cwd); return cwd; }
afterEach(() => { _dirs.forEach(cleanup); _dirs = []; });

function run(args, opts = {}) {
  const r = spawnSync("node", [BIN, ...args], {
    cwd: opts.cwd, encoding: "utf8",
  });
  return { status: r.status, stdout: r.stdout || "", stderr: r.stderr || "" };
}

// stage-06 (qa) requires the "shell" capability; the fixture's default
// "generic" host doesn't have it and fails for an unrelated reason before
// the guard even matters. claude-code does.
function makeProject() {
  return makeTargetProject({
    config: "routing:\n  default_host: claude-code\npipeline:\n  default_track: full\n",
  });
}

// `next()` walks the pipeline from stage-01 and stops at the first
// incomplete stage — it never even looks at stage-04 unless everything
// before it is already PASS. Seed those first so the fixture actually
// reaches the stage-04 ESCALATE, matching a real mid-pipeline run.
function seedEscalatedBuild(cwd) {
  for (const name of ["stage-01", "stage-02", "stage-03", "stage-03b"]) {
    seedGate(cwd, name, { stage: name, status: "PASS" });
  }
  return seedGate(cwd, "stage-04", {
    stage: "stage-04",
    status: "ESCALATE",
    escalation_reason: "qa build workstream: flaky suite, needs a ruling",
  });
}

describe("devteam stage: refuses to skip past an earlier unresolved ESCALATE", () => {
  it("blocks bare `devteam stage qa` (stage-06) while build (stage-04) is ESCALATE", () => {
    const cwd = track(makeProject());
    const gate = seedEscalatedBuild(cwd);
    const r = run(["stage", "qa"], { cwd });
    assert.equal(r.status, 2);
    assert.match(r.stderr, /refusing to dispatch 'qa'/);
    assert.match(r.stderr, /stage-04 has an unresolved ESCALATE gate/);
    assert.match(r.stderr, new RegExp(path.basename(gate).replace(".", "\\.")));
    assert.match(r.stderr, /devteam ruling/);
    assert.match(r.stderr, /devteam fix-escalation/);
    assert.match(r.stderr, /--force/);
  });

  it("does not block re-dispatching the SAME escalating stage (the repair path)", () => {
    const cwd = track(makeProject());
    seedEscalatedBuild(cwd);
    const r = run(["stage", "build"], { cwd });
    assert.equal(r.status, 0);
    assert.doesNotMatch(r.stderr, /refusing to dispatch/);
  });

  it("does not block dispatching an EARLIER stage than the one escalating", () => {
    const cwd = track(makeProject());
    seedEscalatedBuild(cwd);
    const r = run(["stage", "requirements"], { cwd });
    assert.equal(r.status, 0);
    assert.doesNotMatch(r.stderr, /refusing to dispatch/);
  });

  it("--force bypasses the guard", () => {
    const cwd = track(makeProject());
    seedEscalatedBuild(cwd);
    const r = run(["stage", "qa", "--force"], { cwd });
    assert.equal(r.status, 0);
    assert.doesNotMatch(r.stderr, /refusing to dispatch/);
  });

  it("does nothing when there is no unresolved escalation", () => {
    const cwd = track(makeProject());
    const r = run(["stage", "qa"], { cwd });
    assert.equal(r.status, 0);
    assert.doesNotMatch(r.stderr, /refusing to dispatch/);
  });
});
