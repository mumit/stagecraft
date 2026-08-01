const { describe, it, afterEach } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { REPO_ROOT, makeTargetProject, seedGate, cleanup, runCLI } = require("./_helpers");

const patterns = require(path.join(REPO_ROOT, "core", "patterns"));
const { buildDescriptor } = require(path.join(REPO_ROOT, "core", "orchestrator"));
const { getStage } = require(path.join(REPO_ROOT, "core", "pipeline", "stages"));
const generic = require(path.join(REPO_ROOT, "hosts", "generic", "adapter"));

let dirs = [];
function track(cwd) { dirs.push(cwd); return cwd; }
afterEach(() => { dirs.forEach(cleanup); dirs = []; });

function seedArchivedGate(cwd, fileName, gate) {
  const dir = path.join(cwd, "pipeline", "gates", "archive");
  fs.mkdirSync(dir, { recursive: true });
  const finalGate = {
    stage: gate.stage || "stage-06c",
    orchestrator: "devteam@test",
    track: "full",
    timestamp: "2026-05-26T20:00:00Z",
    blockers: [],
    warnings: [],
    status: "FAIL",
    ...gate,
  };
  fs.writeFileSync(path.join(dir, fileName), JSON.stringify(finalGate, null, 2));
}

describe("patterns: collection and promotion", () => {
  it("collects sanitized blocker, warning, and follow-up observations idempotently", () => {
    const cwd = track(makeTargetProject());
    fs.writeFileSync(path.join(cwd, "go.mod"), "module example.com/token\n\ngo 1.22\n", "utf8");
    seedGate(cwd, "stage-06c", {
      status: "FAIL",
      blockers: [{
        signal: "estimate_unhandled_exception",
        assigned_to: "backend",
        note: "No matching structured ERROR log event or exception handler was found in src/backend/main.go.",
      }],
      warnings: ["Tests passed, but only happy path was covered."],
      noted_for_followup: [{ id: "QA-EDGE-01", track_for: "lessons-learned", summary: "Prefer table-driven edge tests." }],
    });

    const first = patterns.collect({ cwd });
    const second = patterns.collect({ cwd });
    assert.equal(first.added, 3);
    assert.equal(second.added, 0);

    const observations = patterns.readObservations(cwd);
    assert.equal(observations.length, 3);
    assert.ok(observations.some((item) => item.tier === "blocker"));
    assert.ok(observations.some((item) => item.tier === "warning"));
    assert.ok(observations.some((item) => item.tier === "nudge"));
    const serialized = JSON.stringify(observations);
    assert.doesNotMatch(serialized, /src\/backend\/main\.go/);
    assert.doesNotMatch(serialized, /No matching structured ERROR log/);
  });

  it("collects archived failure gates created during auto-retry", () => {
    const cwd = track(makeTargetProject());
    seedGate(cwd, "stage-06c", { status: "PASS", blockers: [], warnings: [] });
    seedArchivedGate(cwd, "stage-06c.attempt-1.json", {
      stage: "stage-06c",
      blockers: [{ signal: "estimate_unhandled_exception", assigned_to: "backend" }],
    });
    fs.writeFileSync(path.join(cwd, "pipeline", "run-log.jsonl"), JSON.stringify({
      outcome: "fix-retry",
      stage: "stage-06c",
      target: "backend",
    }) + "\n");

    const result = patterns.collect({ cwd });
    assert.equal(result.added, 1);
    const observations = patterns.readObservations(cwd);
    assert.equal(observations.length, 1);
    assert.equal(observations[0].domain, "observability");
    assert.equal(observations[0].resolved_by_retry, true);
  });

  it("promotes reviewed text and selects it for a relevant backend descriptor", () => {
    const cwd = track(makeTargetProject());
    fs.writeFileSync(path.join(cwd, "go.mod"), "module example.com/token\n\ngo 1.22\n", "utf8");
    seedGate(cwd, "stage-06c", {
      status: "FAIL",
      blockers: [{ signal: "estimate_unhandled_exception", assigned_to: "backend" }],
    });
    patterns.collect({ cwd });
    const candidate = patterns.list({ cwd }).candidates[0];

    const promoted = patterns.promote({
      cwd,
      candidateId: candidate.id,
      text: "For Go backend services, add structured ERROR logging on failed request and exception paths before Stage 06c.",
    });
    assert.equal(promoted.status, "promoted");

    const descriptor = buildDescriptor(getStage("build"), "backend", { workstreamId: "stage-04.backend" });
    const selected = patterns.selectForDescriptor({
      cwd,
      descriptor,
      ctx: { cwd, feature: "add token estimator HTTP endpoint" },
    });
    assert.equal(selected.length, 1);
    assert.match(selected[0].prompt_text, /structured ERROR logging/);
  });

  it("rejects secret-shaped promoted prompt text", () => {
    const cwd = track(makeTargetProject());
    seedGate(cwd, "stage-06c", {
      status: "FAIL",
      blockers: [{ signal: "missing_log", assigned_to: "backend" }],
    });
    patterns.collect({ cwd });
    const candidate = patterns.list({ cwd }).candidates[0];
    assert.throws(
      () => patterns.promote({ cwd, candidateId: candidate.id, text: "Use token ghp_123456789012345678901234567890123456." }),
      /secret-shaped/,
    );
  });

  it("retired patterns are not selected for injection", () => {
    const cwd = track(makeTargetProject());
    seedGate(cwd, "stage-06c", {
      status: "FAIL",
      blockers: [{ signal: "missing_log", assigned_to: "backend" }],
    });
    patterns.collect({ cwd });
    const candidate = patterns.list({ cwd }).candidates[0];
    const promoted = patterns.promote({ cwd, candidateId: candidate.id });
    patterns.retire({ cwd, patternId: promoted.id });

    const descriptor = buildDescriptor(getStage("build"), "backend", { workstreamId: "stage-04.backend" });
    const selected = patterns.selectForDescriptor({ cwd, descriptor, ctx: { cwd, feature: "api endpoint" } });
    assert.equal(selected.length, 0);
  });

  it("collect() suppresses a retired pattern_key so it never re-enters candidates (30.1)", () => {
    const cwd = track(makeTargetProject());
    seedGate(cwd, "stage-06c", {
      status: "FAIL",
      blockers: [{ signal: "missing_log", assigned_to: "backend" }],
    });
    const first = patterns.collect({ cwd });
    assert.equal(first.suppressed, 0);
    assert.equal(first.candidates, 1);

    const candidate = patterns.list({ cwd }).candidates[0];
    const promoted = patterns.promote({ cwd, candidateId: candidate.id });
    patterns.retire({ cwd, patternId: promoted.id });

    // The underlying observations are untouched by retire() — a re-collect over
    // the same gate must not resurrect the retired pattern_key as a candidate.
    const second = patterns.collect({ cwd });
    assert.equal(second.candidates, 0, "retired pattern_key must not reappear as a candidate");
    assert.equal(second.suppressed, 1, "the suppressed candidate must be counted in the collect summary");

    const pendingPath = path.join(cwd, ".devteam", "patterns", "pending-review.json");
    const pending = JSON.parse(fs.readFileSync(pendingPath, "utf8"));
    assert.ok(
      !pending.candidates.some((c) => c.id === promoted.id),
      "pending-review.json must not list the retired pattern_key",
    );
  });
});

describe("patterns: CLI and prompt rendering", () => {
  it("devteam patterns collect/review/promote/stats works end-to-end", () => {
    const cwd = track(makeTargetProject());
    seedGate(cwd, "stage-07", {
      status: "FAIL",
      blockers: ["GET /hello endpoint has no README documentation."],
    });
    const collect = runCLI(["patterns", "collect"], { cwd });
    assert.equal(collect.status, 0, collect.stderr);
    assert.match(collect.stdout, /Collected 1 new pattern observation/);

    const review = runCLI(["patterns", "review"], { cwd });
    assert.equal(review.status, 0, review.stderr);
    assert.match(review.stdout, /Pattern candidates/);
    const id = review.stdout.match(/^([a-z0-9-]+)\s+\[/m)[1];

    const promote = runCLI(["patterns", "promote", id, "--text", "Document user-visible HTTP endpoints during implementation."], { cwd });
    assert.equal(promote.status, 0, promote.stderr);
    assert.match(promote.stdout, new RegExp(`Promoted ${id}`));

    const stats = runCLI(["patterns", "stats"], { cwd });
    assert.equal(stats.status, 0, stats.stderr);
    assert.match(stats.stdout, /Promoted:\s+1/);
  });

  it("rendered prompts include promoted known project patterns", () => {
    const cwd = track(makeTargetProject());
    seedGate(cwd, "stage-06c", {
      status: "FAIL",
      blockers: [{ signal: "missing_log", assigned_to: "backend" }],
    });
    patterns.collect({ cwd });
    const candidate = patterns.list({ cwd }).candidates[0];
    patterns.promote({ cwd, candidateId: candidate.id, text: "Add structured backend error logs before the observability gate." });

    const descriptor = buildDescriptor(getStage("build"), "backend", { workstreamId: "stage-04.backend" });
    descriptor.knownPatterns = patterns.selectForDescriptor({ cwd, descriptor, ctx: { cwd, feature: "add HTTP endpoint" } });
    const prompt = generic.renderStagePrompt(descriptor, { cwd, track: "full", orchestrator: "test", feature: "add HTTP endpoint" });
    assert.match(prompt, /Known Project Patterns/);
    assert.match(prompt, /structured backend error logs/);
  });
});
