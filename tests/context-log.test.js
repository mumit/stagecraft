// Phase 32.5(b) precondition: pipeline/context.md marker section writes/
// strips must be recorded as run-log.jsonl events so the per-workstream
// delta section can be derived from history. Covers core/context-log.js
// directly, plus the two real writers instrumented so far: the validator's
// red-team/QA blocker injectors and the driver's seedDeployContext.
const { describe, it, afterEach } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { spawnSync } = require("node:child_process");
const { REPO_ROOT, makeTargetProject, seedGate, cleanup } = require("./_helpers");
const { logContextSectionEvent } = require("../core/context-log");
const { seedDeployContext } = require("../core/driver");

const VALIDATOR = path.join(REPO_ROOT, "core", "gates", "validator.js");

let _dirs = [];
function track(cwd) { _dirs.push(cwd); return cwd; }
afterEach(() => { for (const d of _dirs.splice(0)) cleanup(d); });

function runValidator(cwd) {
  return spawnSync("node", [VALIDATOR], { cwd, encoding: "utf8", env: process.env });
}

function readRunLogEvents(cwd) {
  const p = path.join(cwd, "pipeline", "run-log.jsonl");
  if (!fs.existsSync(p)) return [];
  return fs.readFileSync(p, "utf8")
    .split("\n")
    .filter(Boolean)
    .map((l) => JSON.parse(l));
}

describe("context-log: logContextSectionEvent", () => {
  it("appends a context-section-change event to pipeline/run-log.jsonl", () => {
    const cwd = track(fs.mkdtempSync(path.join(os.tmpdir(), "devteam-test-")));
    fs.mkdirSync(path.join(cwd, "pipeline"), { recursive: true });
    logContextSectionEvent(cwd, null, { action: "added", section: "right-sizing" });
    const events = readRunLogEvents(cwd);
    assert.equal(events.length, 1);
    assert.equal(events[0].event, "context-section-change");
    assert.equal(events[0].action, "added");
    assert.equal(events[0].section, "right-sizing");
    assert.equal(typeof events[0].ts, "string");
  });

  it("is fire-and-forget: never throws even when the run-log path cannot be created", () => {
    // Point cwd at a path whose "pipeline" segment is a file, not a directory,
    // so mkdirSync(..., {recursive:true}) fails inside the function.
    const cwd = track(fs.mkdtempSync(path.join(os.tmpdir(), "devteam-test-")));
    fs.writeFileSync(path.join(cwd, "pipeline"), "not a directory");
    assert.doesNotThrow(() => {
      logContextSectionEvent(cwd, null, { action: "added", section: "right-sizing" });
    });
  });

  it("records changeId-scoped events under pipeline/changes/<id>/run-log.jsonl", () => {
    const cwd = track(fs.mkdtempSync(path.join(os.tmpdir(), "devteam-test-")));
    logContextSectionEvent(cwd, "feat-x", { action: "added", section: "deploy-target" });
    const p = path.join(cwd, "pipeline", "changes", "feat-x", "run-log.jsonl");
    assert.ok(fs.existsSync(p));
  });
});

describe("context-log: real writers record events", () => {
  function makeProjectWithContext(cwd, contextContent = "# Context\n\nProject notes.\n") {
    fs.mkdirSync(path.join(cwd, "pipeline"), { recursive: true });
    fs.writeFileSync(path.join(cwd, "pipeline", "context.md"), contextContent);
  }

  it("validator records an 'added' event when qa-build-blockers is injected", () => {
    const cwd = track(makeTargetProject());
    makeProjectWithContext(cwd);
    seedGate(cwd, "stage-04.qa", {
      stage: "stage-04", workstream: "qa", status: "FAIL",
      blockers: ["express.static points to public/ which doesn't exist"],
    });
    runValidator(cwd);
    const events = readRunLogEvents(cwd).filter((e) => e.event === "context-section-change");
    assert.equal(events.length, 1);
    assert.equal(events[0].action, "added");
    assert.equal(events[0].section, "qa-build-blockers");
    assert.equal(events[0].stage, "stage-04");
  });

  it("validator records a 'removed' event when red-team-blockers resolves to PASS", () => {
    const cwd = track(makeTargetProject());
    makeProjectWithContext(cwd,
      "<!-- devteam:red-team-blockers:begin -->\nold blocker\n<!-- devteam:red-team-blockers:end -->\n\n# Context\n");
    seedGate(cwd, "stage-04c", { stage: "stage-04c", status: "PASS" });
    runValidator(cwd);
    const events = readRunLogEvents(cwd).filter((e) => e.event === "context-section-change");
    assert.equal(events.length, 1);
    assert.equal(events[0].action, "removed");
    assert.equal(events[0].section, "red-team-blockers");
  });

  it("does not record an event when there is nothing to inject or strip", () => {
    const cwd = track(makeTargetProject());
    makeProjectWithContext(cwd);
    seedGate(cwd, "stage-04.qa", { stage: "stage-04", workstream: "qa", status: "PASS", blockers: [] });
    runValidator(cwd);
    const events = readRunLogEvents(cwd).filter((e) => e.event === "context-section-change");
    assert.equal(events.length, 0);
  });

  it("driver's seedDeployContext records an 'added' event", () => {
    const cwd = track(fs.mkdtempSync(path.join(os.tmpdir(), "devteam-test-")));
    const wrote = seedDeployContext(cwd, { deploy: { adapter: "npm" } }, null);
    assert.equal(wrote, true);
    const events = readRunLogEvents(cwd).filter((e) => e.event === "context-section-change");
    assert.equal(events.length, 1);
    assert.equal(events[0].action, "added");
    assert.equal(events[0].section, "deploy-target");
  });
});
