// Tests for `devteam status` (ADR-007 §5, Tier 1).
// Reads run-state.json + tail of run-log.jsonl; reports liveness fields.

const { describe, it, afterEach } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { makeTargetProject, cleanup, runCLI } = require("./_helpers");

let _dirs = [];
function track(cwd) { _dirs.push(cwd); return cwd; }
afterEach(() => { _dirs.forEach(cleanup); _dirs = []; });

function writeRunState(cwd, state) {
  const p = path.join(cwd, "pipeline", "run-state.json");
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(p, JSON.stringify(state, null, 2));
}

function writeRunLog(cwd, events) {
  const p = path.join(cwd, "pipeline", "run-log.jsonl");
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(p, events.map((e) => JSON.stringify(e)).join("\n") + "\n");
}

describe("devteam status — no-run state", () => {
  it("reports no-run when neither run-state.json nor run-log.jsonl exists", () => {
    const cwd = track(makeTargetProject());
    const { status, stdout } = runCLI(["status", "--json", "--cwd", cwd], {
      env: { CI: "true", DEVTEAM_NO_LOG: "1" },
    });
    assert.equal(status, 0, "status command must exit 0 even for no-run");
    const out = JSON.parse(stdout);
    assert.equal(out.status, "no-run");
    assert.equal(out.iterations, 0);
    assert.equal(out.stall_detected, false);
  });
});

describe("devteam status — running state", () => {
  it("reports running with heartbeat age from fixture log", () => {
    const cwd = track(makeTargetProject());
    const now = Date.now();
    // Write a run-state and a log with a heartbeat event 30 seconds ago.
    writeRunState(cwd, {
      track: "full",
      intent: "feature",
      iterations: 3,
      last_action: "run-stage",
      current_stage: "build",
      started_at: new Date(now - 120000).toISOString(),
    });
    const heartbeatTs = new Date(now - 30000).toISOString();
    const lastEventTs = new Date(now - 5000).toISOString();
    writeRunLog(cwd, [
      { ts: new Date(now - 60000).toISOString(), outcome: "heartbeat", iteration: 2, stage: "requirements", action: null },
      { ts: heartbeatTs, outcome: "heartbeat", iteration: 3, stage: "build", action: "run-stage" },
      { ts: lastEventTs, outcome: "dispatched", iteration: 3, stage: "build", action: "run-stage" },
    ]);

    const { status, stdout } = runCLI(["status", "--json", "--cwd", cwd], {
      env: { CI: "true", DEVTEAM_NO_LOG: "1" },
    });
    assert.equal(status, 0);
    const out = JSON.parse(stdout);
    assert.equal(out.status, "running");
    assert.equal(out.current_stage, "build");
    assert.equal(out.last_action, "run-stage");
    assert.equal(out.iterations, 3);
    assert.deepEqual(out.active_workstreams, []);
    assert.equal(out.last_workstream, null);
    // last_heartbeat_age_ms should be approximately 30000ms (within 5s tolerance).
    assert.ok(out.last_heartbeat_age_ms != null, "last_heartbeat_age_ms must be set");
    assert.ok(out.last_heartbeat_age_ms >= 25000 && out.last_heartbeat_age_ms < 40000,
      `last_heartbeat_age_ms (${out.last_heartbeat_age_ms}) should be ~30000ms`);
    // last_event_age_ms should be approximately 5000ms.
    assert.ok(out.last_event_age_ms != null, "last_event_age_ms must be set");
    assert.ok(out.last_event_age_ms >= 1000 && out.last_event_age_ms < 15000,
      `last_event_age_ms (${out.last_event_age_ms}) should be ~5000ms`);
    assert.equal(out.stall_detected, false, "no stall-detected in log");
  });

  it("reports stall_detected=true when the most recent dispatch event is stall-detected", () => {
    const cwd = track(makeTargetProject());
    const now = Date.now();
    writeRunState(cwd, {
      track: "full",
      intent: "feature",
      iterations: 5,
      last_action: "run-stage",
      current_stage: "build",
      started_at: new Date(now - 600000).toISOString(),
    });
    writeRunLog(cwd, [
      { ts: new Date(now - 300000).toISOString(), outcome: "dispatched", iteration: 4, stage: "requirements" },
      { ts: new Date(now - 60000).toISOString(), outcome: "heartbeat", iteration: 5, stage: "build", action: "run-stage" },
      { ts: new Date(now - 10000).toISOString(), outcome: "stall-detected", iteration: 5, stage: "build", stall_class: "observed" },
    ]);

    const { status, stdout } = runCLI(["status", "--json", "--cwd", cwd], {
      env: { CI: "true", DEVTEAM_NO_LOG: "1" },
    });
    assert.equal(status, 0);
    const out = JSON.parse(stdout);
    assert.equal(out.stall_detected, true, "stall_detected must be true when stall-detected is the last dispatch event");
  });

  it("reports stall_detected=false when a dispatched event follows a stall-detected", () => {
    const cwd = track(makeTargetProject());
    const now = Date.now();
    writeRunState(cwd, {
      track: "full",
      intent: "feature",
      iterations: 6,
      last_action: "run-stage",
      current_stage: "peer-review",
      started_at: new Date(now - 700000).toISOString(),
    });
    writeRunLog(cwd, [
      { ts: new Date(now - 120000).toISOString(), outcome: "stall-detected", iteration: 5, stage: "build", stall_class: "observed" },
      { ts: new Date(now - 60000).toISOString(), outcome: "dispatched", iteration: 6, stage: "peer-review" },
      { ts: new Date(now - 5000).toISOString(), outcome: "heartbeat", iteration: 6, stage: "peer-review", action: "run-stage" },
    ]);

    const { status, stdout } = runCLI(["status", "--json", "--cwd", cwd], {
      env: { CI: "true", DEVTEAM_NO_LOG: "1" },
    });
    assert.equal(status, 0);
    const out = JSON.parse(stdout);
    assert.equal(out.stall_detected, false, "dispatched following stall-detected clears stall status");
  });

  it("reports active and last workstream details", () => {
    const cwd = track(makeTargetProject());
    const now = Date.now();
    writeRunState(cwd, {
      track: "full",
      intent: "feature",
      iterations: 7,
      last_action: "run-stage",
      current_stage: "build",
      active_workstreams: {
        "stage-04.backend": {
          stage: "stage-04",
          name: "build",
          role: "backend",
          host: "codex",
          workstream_id: "stage-04.backend",
          gate_path: "pipeline/gates/stage-04.backend.json",
          log_path: "pipeline/logs/stage-04.backend.log",
          started_at: new Date(now - 45000).toISOString(),
        },
      },
      last_workstream: {
        stage: "stage-04",
        name: "build",
        role: "frontend",
        host: "omnigent",
        workstream_id: "stage-04.frontend",
        gate_path: "pipeline/gates/stage-04.frontend.json",
        log_path: "pipeline/logs/stage-04.frontend.log",
        duration_ms: 1234,
        exit_code: 0,
        finished_at: new Date(now - 10000).toISOString(),
      },
      started_at: new Date(now - 700000).toISOString(),
    });
    writeRunLog(cwd, [
      { ts: new Date(now - 5000).toISOString(), outcome: "heartbeat", iteration: 7, stage: "build", action: "run-stage" },
    ]);

    const json = runCLI(["status", "--json", "--cwd", cwd], {
      env: { CI: "true", DEVTEAM_NO_LOG: "1" },
    });
    assert.equal(json.status, 0);
    const out = JSON.parse(json.stdout);
    assert.equal(out.active_workstreams.length, 1);
    assert.equal(out.active_workstreams[0].workstream_id, "stage-04.backend");
    assert.equal(out.last_workstream.workstream_id, "stage-04.frontend");

    const human = runCLI(["status", "--verbose", "--cwd", cwd], {
      env: { CI: "true", DEVTEAM_NO_LOG: "1" },
    });
    assert.equal(human.status, 0);
    assert.match(human.stdout, /active_streams:\s+1/);
    assert.match(human.stdout, /backend@codex/);
    assert.match(human.stdout, /frontend@omnigent/);
    assert.match(human.stdout, /pipeline\/logs\/stage-04.backend.log/);
  });
});

describe("devteam status — completed/halted states", () => {
  it("reports completed when last log event is complete", () => {
    const cwd = track(makeTargetProject());
    const now = Date.now();
    writeRunState(cwd, { track: "full", intent: "feature", iterations: 12, started_at: new Date(now - 1000000).toISOString() });
    writeRunLog(cwd, [
      { ts: new Date(now - 2000).toISOString(), outcome: "heartbeat", iteration: 12, stage: "retrospective", action: "run-stage" },
      { ts: new Date(now - 1000).toISOString(), outcome: "complete", iteration: 12 },
    ]);

    const { status, stdout } = runCLI(["status", "--json", "--cwd", cwd], {
      env: { CI: "true", DEVTEAM_NO_LOG: "1" },
    });
    assert.equal(status, 0);
    const out = JSON.parse(stdout);
    assert.equal(out.status, "completed");
    assert.equal(out.stall_detected, false);
  });

  it("human-readable output includes all key fields", () => {
    const cwd = track(makeTargetProject());
    const now = Date.now();
    writeRunState(cwd, {
      track: "full",
      intent: "feature",
      iterations: 4,
      last_action: "run-stage",
      current_stage: "design",
      started_at: new Date(now - 200000).toISOString(),
    });
    writeRunLog(cwd, [
      { ts: new Date(now - 10000).toISOString(), outcome: "heartbeat", iteration: 4, stage: "design", action: "run-stage" },
    ]);

    const { status, stdout } = runCLI(["status", "--cwd", cwd], {
      env: { CI: "true", DEVTEAM_NO_LOG: "1" },
    });
    assert.equal(status, 0);
    assert.match(stdout, /status:/, "human output must include status label");
    assert.match(stdout, /design/, "human output must include current_stage");
    assert.match(stdout, /iterations:/, "human output must include iterations");
  });
});
