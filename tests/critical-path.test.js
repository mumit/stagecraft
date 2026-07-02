"use strict";

const { describe, it, afterEach } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const {
  analyzeEvents,
  collectVerificationReuseCandidates,
  renderMarkdown,
} = require("../core/performance/critical-path");
const { makeTargetProject, cleanup, runCLI } = require("./_helpers");

let dirs = [];
afterEach(() => { dirs.forEach(cleanup); dirs = []; });

function track(cwd) { dirs.push(cwd); return cwd; }

function writeRunLog(cwd, events) {
  const file = path.join(cwd, "pipeline", "run-log.jsonl");
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, events.map((event) => JSON.stringify(event)).join("\n") + "\n");
}

describe("critical-path analyzer", () => {
  it("computes dispatch wall, workstream compute, and parallel savings", () => {
    const events = [
      { ts: "2026-07-02T00:00:00.000Z", outcome: "run-start" },
      { ts: "2026-07-02T00:00:01.000Z", outcome: "dispatch-started", iteration: 1, stage: "stage-04", name: "build", action: "run-stage", queue_ms: 0 },
      { ts: "2026-07-02T00:00:01.000Z", outcome: "workstream-started", iteration: 1, stage: "stage-04", name: "build", action: "run-stage", role: "backend", host: "codex", workstream_id: "stage-04.backend" },
      { ts: "2026-07-02T00:00:01.000Z", outcome: "workstream-started", iteration: 1, stage: "stage-04", name: "build", action: "run-stage", role: "frontend", host: "claude-code", workstream_id: "stage-04.frontend" },
      { ts: "2026-07-02T00:00:01.060Z", outcome: "workstream-finished", iteration: 1, stage: "stage-04", name: "build", action: "run-stage", role: "backend", host: "codex", workstream_id: "stage-04.backend", duration_ms: 60, exit_code: 0 },
      { ts: "2026-07-02T00:00:01.100Z", outcome: "workstream-finished", iteration: 1, stage: "stage-04", name: "build", action: "run-stage", role: "frontend", host: "claude-code", workstream_id: "stage-04.frontend", duration_ms: 100, exit_code: 0 },
      { ts: "2026-07-02T00:00:01.100Z", outcome: "dispatched", iteration: 1, stage: "stage-04", name: "build", action: "run-stage", duration_ms: 100, workstreams: 2 },
      { ts: "2026-07-02T00:00:01.200Z", outcome: "complete", iteration: 2 },
    ];

    const report = analyzeEvents(events, { generatedAt: "2026-07-02T00:00:02.000Z" });
    assert.equal(report.status, "ok");
    assert.equal(report.dispatch_wall_ms, 100);
    assert.equal(report.workstream_compute_ms, 160);
    assert.equal(report.parallel_savings_ms, 60);
    assert.equal(report.telemetry_coverage.dispatch_duration, 1);
    assert.equal(report.telemetry_coverage.workstream_duration, 1);
    assert.equal(report.dispatches[0].queue_ms, 0);
  });

  it("reports missing durations rather than inventing precision", () => {
    const report = analyzeEvents([
      { ts: "2026-07-02T00:00:00.000Z", outcome: "run-start" },
      { ts: "2026-07-02T00:00:01.000Z", outcome: "workstream-finished", iteration: 1, stage: "stage-04", name: "build", role: "backend" },
    ]);

    assert.equal(report.dispatches[0].duration_ms, null);
    assert.ok(report.missing_duration_reasons.some((item) => /dispatch missing/.test(item.reason)));
    assert.ok(report.missing_duration_reasons.some((item) => /workstream-finished/.test(item.reason)));
  });

  it("includes retry delay and merge duration in the reported critical path", () => {
    const report = analyzeEvents([
      { ts: "2026-07-02T00:00:00.000Z", outcome: "run-start" },
      { ts: "2026-07-02T00:00:01.000Z", outcome: "dispatch-started", iteration: 1, stage: "stage-04", name: "build", action: "run-stage" },
      { ts: "2026-07-02T00:00:01.100Z", outcome: "dispatched", iteration: 1, stage: "stage-04", name: "build", action: "run-stage", duration_ms: 100, workstreams: 1 },
      { ts: "2026-07-02T00:00:01.101Z", outcome: "transient-retry", iteration: 1, stage: "stage-04", name: "build", action: "run-stage", delay_ms: 30000 },
      { ts: "2026-07-02T00:00:31.200Z", outcome: "merge-started", iteration: 2, stage: "stage-04", name: "build", action: "merge" },
      { ts: "2026-07-02T00:00:31.225Z", outcome: "merge-finished", iteration: 2, stage: "stage-04", name: "build", action: "merge", duration_ms: 25, merged: true },
    ]);

    assert.equal(report.dispatch_wall_ms, 100);
    assert.equal(report.retry_delay_ms, 30000);
    assert.equal(report.merge_wall_ms, 25);
    assert.equal(report.reported_critical_path_ms, 30125);
    assert.equal(report.merges[0].duration_ms, 25);
  });

  it("detects repeated orchestrator-stamped verification commands", () => {
    const cwd = track(makeTargetProject());
    const gatesDir = path.join(cwd, "pipeline", "gates");
    fs.mkdirSync(gatesDir, { recursive: true });
    for (const stage of ["stage-04a", "stage-06"]) {
      fs.writeFileSync(path.join(gatesDir, `${stage}.json`), JSON.stringify({
        stage,
        workstream: "qa",
        status: "PASS",
        _orchestrator_stamped: {
          runs: {
            test: { command: "npm test", duration_ms: stage === "stage-04a" ? 100 : 150 },
          },
        },
      }, null, 2));
    }

    const candidates = collectVerificationReuseCandidates(cwd);
    assert.equal(candidates.length, 1);
    assert.equal(candidates[0].command, "npm test");
    assert.equal(candidates[0].occurrences, 2);
    assert.equal(candidates[0].estimated_reuse_savings_ms, 100);
  });

  it("renders a human summary", () => {
    const md = renderMarkdown(analyzeEvents([
      { ts: "2026-07-02T00:00:00.000Z", outcome: "run-start" },
      { ts: "2026-07-02T00:00:01.000Z", outcome: "dispatch-started", iteration: 1, stage: "stage-01", name: "requirements", action: "run-stage" },
      { ts: "2026-07-02T00:00:01.050Z", outcome: "dispatched", iteration: 1, stage: "stage-01", name: "requirements", action: "run-stage", duration_ms: 50, workstreams: 1 },
    ], { generatedAt: "2026-07-02T00:00:02.000Z" }));
    assert.match(md, /critical path/i);
    assert.match(md, /requirements/);
    assert.match(md, /Telemetry Coverage/);
  });
});

describe("devteam performance critical-path", () => {
  it("returns no-run JSON when run-log.jsonl is absent", () => {
    const cwd = track(makeTargetProject());
    const result = runCLI(["performance", "critical-path", "--json", "--cwd", cwd], {
      env: { CI: "true", DEVTEAM_NO_LOG: "1" },
    });
    assert.equal(result.status, 0);
    const out = JSON.parse(result.stdout);
    assert.equal(out.schema_version, "critical-path.v1");
    assert.equal(out.status, "no-run");
  });

  it("reads run-log.jsonl and prints the critical-path report", () => {
    const cwd = track(makeTargetProject());
    writeRunLog(cwd, [
      { ts: "2026-07-02T00:00:00.000Z", outcome: "run-start" },
      { ts: "2026-07-02T00:00:01.000Z", outcome: "dispatch-started", iteration: 1, stage: "stage-01", name: "requirements", action: "run-stage" },
      { ts: "2026-07-02T00:00:01.050Z", outcome: "dispatched", iteration: 1, stage: "stage-01", name: "requirements", action: "run-stage", duration_ms: 50, workstreams: 1 },
    ]);
    const result = runCLI(["performance", "critical-path", "--cwd", cwd], {
      env: { CI: "true", DEVTEAM_NO_LOG: "1" },
    });
    assert.equal(result.status, 0);
    assert.match(result.stdout, /devteam performance/);
    assert.match(result.stdout, /requirements/);
  });

  it("uses --feature to read bounded run logs", () => {
    const cwd = track(makeTargetProject({
      config: "routing:\n  default_host: generic\npipeline:\n  default_track: full\n  isolation: bounded\n",
    }));
    const changeDir = path.join(cwd, "pipeline", "changes", "bounded-critical-path");
    fs.mkdirSync(changeDir, { recursive: true });
    fs.writeFileSync(path.join(changeDir, "run-log.jsonl"), [
      { ts: "2026-07-02T00:00:00.000Z", outcome: "run-start" },
      { ts: "2026-07-02T00:00:01.000Z", outcome: "dispatch-started", iteration: 1, stage: "stage-01", name: "requirements", action: "run-stage" },
      { ts: "2026-07-02T00:00:01.050Z", outcome: "dispatched", iteration: 1, stage: "stage-01", name: "requirements", action: "run-stage", duration_ms: 50, workstreams: 1 },
    ].map((event) => JSON.stringify(event)).join("\n") + "\n");

    const result = runCLI(["performance", "critical-path", "--json", "--feature", "bounded critical path", "--cwd", cwd], {
      env: { CI: "true", DEVTEAM_NO_LOG: "1" },
    });
    assert.equal(result.status, 0);
    const out = JSON.parse(result.stdout);
    assert.equal(out.status, "ok");
    assert.equal(out.source, "pipeline/changes/bounded-critical-path/run-log.jsonl");
  });
});
