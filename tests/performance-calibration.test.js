"use strict";

const { describe, it, afterEach } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { makeTargetProject, cleanup } = require("./_helpers");
const { appendDispatchRecord } = require("../core/corpus");
const { analyzeProjects, percentile, recordTrackFeedback } = require("../core/performance/calibration");

const directories = [];
afterEach(() => directories.splice(0).forEach(cleanup));

function seedProject(projectIndex) {
  const cwd = makeTargetProject();
  directories.push(cwd);
  const events = [];
  for (let index = 0; index < 5; index += 1) {
    const second = projectIndex * 20 + index * 3;
    const ts = (offset) => new Date(Date.UTC(2026, 7, 8, 0, 0, second + offset)).toISOString();
    events.push(
      { ts: ts(0), outcome: "run-start", intent: "repair" },
      { ts: ts(0), outcome: "run-plan", track_source: index === 0 ? "human" : "inferred" },
      { ts: ts(0), outcome: "dispatch-started", iteration: 1, stage: "stage-04", name: "build", queue_ms: index },
      { ts: ts(1), outcome: "dispatched", iteration: 1, stage: "stage-04", name: "build", duration_ms: 1000 + index * 100 },
      { ts: ts(1), outcome: "fix-retry", stage: "stage-04" },
      { ts: ts(2), outcome: "complete" },
    );
    if ((projectIndex === 0 && index < 2) || (projectIndex === 1 && index === 0)) {
      events.push({
        ts: ts(2), outcome: "resolution-accepted", failure_class: "code-defect",
        schema_fingerprint: "sha256:same", derivable: true,
      });
    }
    appendDispatchRecord(cwd, {
      ts: ts(1), run_id: `p${projectIndex}-run${index}`, stage: "stage-04",
      role: "backend", host: "codex", track: "loop", duration_ms: 1000 + index * 100,
      queue_ms: index, gate_status: "PASS", cost_usd: 0.1, cost_basis: "observed",
      cached_tokens: index === 0 ? 0 : 500, knowledge_items: 2, prior_knowledge_items: 1,
    });
  }
  fs.mkdirSync(path.join(cwd, "pipeline"), { recursive: true });
  fs.writeFileSync(path.join(cwd, "pipeline", "run-log.jsonl"), events.map(JSON.stringify).join("\n") + "\n");
  recordTrackFeedback(cwd, { fit: projectIndex === 0 ? "right" : "too-heavy", reason: "latency" });
  return cwd;
}

describe("performance calibration", () => {
  it("uses nearest-rank percentiles with explicit sample counts", () => {
    assert.equal(percentile([1, 2, 3, 4], 0.5), 2);
    assert.equal(percentile([1, 2, 3, 4], 0.95), 4);
    assert.equal(percentile([], 0.5), null);
  });

  it("aggregates two projects without exposing paths and opens only earned Phase 41 review gates", () => {
    const first = seedProject(0);
    const second = seedProject(1);
    const report = analyzeProjects([first, second], { generatedAt: "2026-08-08T01:00:00.000Z" });
    assert.equal(report.sample_size.projects, 2);
    assert.equal(report.sample_size.runs, 10);
    assert.equal(report.sample_size.dispatches, 10);
    assert.equal(report.latency_ms.critical_path.samples, 10);
    assert.equal(report.cost.observed_samples, 10);
    assert.equal(report.cost.successful_run_samples, 10);
    assert.ok(Math.abs(report.cost.per_successful_run_usd - 0.1) < 1e-12);
    assert.equal(report.cache.hits, 8);
    assert.equal(report.knowledge_selection.samples, 10);
    assert.equal(report.phase41.routing_ready, true);
    assert.equal(report.phase41.h3_candidate_ready, true);
    assert.equal(report.track_fit.human_override_rate, 0.2);
    const serialized = JSON.stringify(report);
    assert.equal(serialized.includes(first), false);
    assert.equal(serialized.includes(second), false);
  });

  it("rejects free-form fit values and reason codes", () => {
    const cwd = seedProject(0);
    assert.throws(() => recordTrackFeedback(cwd, { fit: "maybe", reason: "latency" }), /invalid fit/);
    assert.throws(() => recordTrackFeedback(cwd, { fit: "right", reason: "my private note" }), /invalid reason/);
  });

  it("reads durable events and feedback from a bounded feature root", () => {
    const cwd = makeTargetProject({ config: "routing:\n  default_host: antigravity\npipeline:\n  isolation: bounded\n" });
    directories.push(cwd);
    const changeId = "change-abc";
    const root = path.join(cwd, "pipeline", "changes", changeId);
    fs.mkdirSync(root, { recursive: true });
    fs.writeFileSync(path.join(root, "run-log.jsonl"), [
      { ts: "2026-08-08T00:00:00Z", outcome: "run-start" },
      { ts: "2026-08-08T00:00:01Z", outcome: "complete" },
    ].map(JSON.stringify).join("\n") + "\n");
    recordTrackFeedback(cwd, { fit: "right", reason: "other", changeId });
    const report = analyzeProjects([cwd], { changeId, generatedAt: "2026-08-08T01:00:00Z" });
    assert.equal(report.sample_size.runs, 1);
    assert.equal(report.track_fit.samples, 1);
  });
});
