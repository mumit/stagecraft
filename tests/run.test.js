// Tests for the bounded autonomous driver (ADR-003 / H2 Phase 1 PR-A).
//
// Two styles:
//   1. Real next() + seedGate — for halt paths the driver reaches WITHOUT
//      dispatching (FAIL, escalation, consequence ceiling, budget, complete).
//   2. Injected next/runStageHeadless/merge — for the dispatch loop, so we can
//      drive any action sequence deterministically without spawning a host.

const { describe, it, afterEach } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { REPO_ROOT, makeTargetProject, seedGate, cleanup, runCLI } = require("./_helpers");
const { run } = require(path.join(REPO_ROOT, "core", "driver"));
const { orderedStageNamesForTrack } = require(path.join(REPO_ROOT, "core", "pipeline", "stages"));

let _dirs = [];
function track(cwd) { _dirs.push(cwd); return cwd; }
afterEach(() => { _dirs.forEach(cleanup); _dirs = []; });

// Seed every stage of the full track as PASS, optionally excluding some.
function seedAllPass(cwd, { exclude = [] } = {}) {
  for (const name of orderedStageNamesForTrack("full")) {
    if (exclude.includes(name)) continue;
    const def = require(path.join(REPO_ROOT, "core", "pipeline", "stages")).getStage(name);
    seedGate(cwd, def.stage, { status: "PASS" });
  }
}

describe("driver: halt paths (real next)", () => {
  it("auto-retries a code-defect FAIL, then escalates as convergence-exhausted", async () => {
    const cwd = track(makeTargetProject());
    seedGate(cwd, "stage-01", { status: "FAIL", blockers: ["bad criterion"] });
    // stage-01 (requirements) has no fix recipe → no gate cleared → gate stays FAIL.
    // After two retry archives the progress-based breaker detects identical blockers
    // and escalates as convergence-exhausted (same observable outcome as the old
    // count-based ceiling; which path fires is an implementation detail — 4.2 spec).
    const s = await run({ cwd });
    assert.equal(s.completed, false);
    assert.equal(s.halt_action, "resolve-escalation");
    assert.equal(s.halt_failure_class, "convergence-exhausted");
  });

  it("halts on an ESCALATE gate (judgment-gate)", async () => {
    const cwd = track(makeTargetProject());
    seedGate(cwd, "stage-01", { status: "ESCALATE", escalation_reason: "ambiguous" });
    const s = await run({ cwd });
    assert.equal(s.halt_action, "resolve-escalation");
    assert.equal(s.halt_failure_class, "judgment-gate");
  });

  it("reaches pipeline-complete when every stage PASSes", async () => {
    const cwd = track(makeTargetProject());
    seedAllPass(cwd);
    const s = await run({ cwd });
    assert.equal(s.completed, true);
    assert.equal(s.halted, false);
  });

  it("halts at the consequence ceiling before sign-off without a grant", async () => {
    const cwd = track(makeTargetProject());
    // Everything up to sign-off passes; sign-off/deploy/retro not yet run.
    seedAllPass(cwd, { exclude: ["sign-off", "deploy", "retrospective"] });
    const s = await run({ cwd });
    assert.equal(s.halt_action, "ceiling");
    assert.match(s.halt_reason, /sign-off/);
  });

  it("halts on budget cap before dispatching the next stage", async () => {
    const cwd = track(makeTargetProject());
    // stage-01 done with a cost; next() will point at design (stage-02).
    seedGate(cwd, "stage-01", { status: "PASS", cost_usd: 5 });
    const s = await run({ cwd, budgetUsd: 3 });
    assert.equal(s.halt_action, "budget");
    assert.ok(s.cost_usd >= 3);
  });

  it("writes run-state.json and run-log.jsonl, releases the lock", async () => {
    const cwd = track(makeTargetProject());
    seedGate(cwd, "stage-01", { status: "FAIL", blockers: ["x"] });
    await run({ cwd });
    assert.ok(fs.existsSync(path.join(cwd, "pipeline", "run-state.json")), "run-state written");
    assert.ok(fs.existsSync(path.join(cwd, "pipeline", "run-log.jsonl")), "run-log written");
    assert.ok(!fs.existsSync(path.join(cwd, "pipeline", "run.lock")), "lock released");
  });

  it("refuses to start when a live lock is held", async () => {
    const cwd = track(makeTargetProject());
    fs.mkdirSync(path.join(cwd, "pipeline"), { recursive: true });
    fs.writeFileSync(
      path.join(cwd, "pipeline", "run.lock"),
      JSON.stringify({ pid: process.pid, host: "test", started_at: "2026-06-09T00:00:00Z" }),
    );
    await assert.rejects(() => run({ cwd }), /locked by an active run/);
  });

  it("--force overrides a stale lock (dead pid)", async () => {
    const cwd = track(makeTargetProject());
    seedGate(cwd, "stage-01", { status: "FAIL", blockers: ["x"] });
    fs.mkdirSync(path.join(cwd, "pipeline"), { recursive: true });
    // pid 1 is almost certainly not ours and process.kill(1,0) → EPERM (alive),
    // so use --force to be deterministic regardless of pid liveness.
    fs.writeFileSync(path.join(cwd, "pipeline", "run.lock"), JSON.stringify({ pid: 999999999, host: "x", started_at: "old" }));
    const s = await run({ cwd, force: true });
    assert.equal(s.halted, true); // halts on the FAIL, but it STARTED
  });
});

describe("driver: dispatch loop (injected deps)", () => {
  it("records deterministic skip-stage transitions once and continues", async () => {
    const cwd = track(makeTargetProject());
    const events = [];
    const triggerInputs = {
      prerequisite_stage: "stage-04a",
      field: "security_review_required",
      expected: true,
      actual: false,
      force_stages: [],
    };
    const seq = [
      {
        action: "skip-stage",
        stage: "stage-04b",
        name: "security-review",
        skip_kind: "conditionalOn",
        trigger_inputs: triggerInputs,
        reason: "condition not met: stage-04a.security_review_required !== true",
      },
      { action: "pipeline-complete", reason: "done" },
    ];
    await run({
      cwd,
      budgetUsd: 10,
      next: () => seq.shift(),
      onEvent: (event) => events.push(event),
    });

    const emitted = events.find((event) => event.type === "skip-stage");
    assert.ok(emitted, "skip-stage event emitted");
    assert.equal(emitted.name, "security-review");
    assert.equal(emitted.skip_kind, "conditionalOn");

    const state = JSON.parse(fs.readFileSync(path.join(cwd, "pipeline", "run-state.json"), "utf8"));
    assert.deepEqual(state.skipped_stages, ["security-review"]);

    const log = fs.readFileSync(path.join(cwd, "pipeline", "run-log.jsonl"), "utf8")
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line));
    const skips = log.filter((entry) => entry.outcome === "skip-stage");
    assert.equal(skips.length, 1);
    assert.deepEqual(skips[0].trigger_inputs, triggerInputs);
  });

  it("advances run-stage → merge → complete", async () => {
    const cwd = track(makeTargetProject());
    const actions = [
      { action: "run-stage", stage: "stage-04", name: "build" },
      { action: "merge", stage: "stage-04", name: "build" },
      { action: "pipeline-complete", reason: "done" },
    ];
    let i = 0;
    const s = await run({
      cwd,
      next: () => actions[i++],
      runStageHeadless: async () => [{ role: "backend", gatePath: "x", durationMs: 1 }],
      mergeWorkstreamGates: () => ({ merged: true }),
    });
    assert.equal(s.completed, true);
    assert.deepEqual(s.stages_advanced, ["build"]);
  });

  it("records workstream lifecycle progress in callbacks, run log, and run state", async () => {
    const cwd = track(makeTargetProject());
    const gatePath = path.join(cwd, "pipeline", "gates", "stage-04.backend.json");
    const logPath = path.join(cwd, "pipeline", "logs", "stage-04.backend.log");
    const actions = [
      { action: "run-stage", stage: "stage-04", name: "build" },
      { action: "pipeline-complete", reason: "done" },
    ];
    const events = [];
    let index = 0;

    const s = await run({
      cwd,
      next: () => actions[index++],
      onEvent: (event) => events.push(event),
      runStageHeadless: async (_stageName, opts = {}) => {
        opts.onWorkstreamEvent({
          type: "workstream-started",
          stage: "stage-04",
          name: "build",
          role: "backend",
          host: "codex",
          workstream_id: "stage-04.backend",
          gate_path: gatePath,
          log_path: logPath,
        });
        opts.onWorkstreamEvent({
          type: "workstream-finished",
          stage: "stage-04",
          name: "build",
          role: "backend",
          host: "codex",
          workstream_id: "stage-04.backend",
          exit_code: 0,
          gate_path: gatePath,
          log_path: logPath,
          duration_ms: 17,
        });
        return [{ role: "backend", host: "codex", gatePath, logPath, exitCode: 0, durationMs: 17 }];
      },
    });

    assert.equal(s.completed, true);
    const started = events.find((event) => event.type === "workstream-started");
    const finished = events.find((event) => event.type === "workstream-finished");
    assert.equal(started.workstream_id, "stage-04.backend");
    assert.equal(started.gate_path, "pipeline/gates/stage-04.backend.json");
    assert.equal(started.log_path, "pipeline/logs/stage-04.backend.log");
    assert.equal(finished.exit_code, 0);
    assert.equal(finished.duration_ms, 17);

    const state = JSON.parse(fs.readFileSync(path.join(cwd, "pipeline", "run-state.json"), "utf8"));
    assert.deepEqual(state.active_workstreams, {});
    assert.equal(state.last_workstream.workstream_id, "stage-04.backend");
    assert.equal(state.last_workstream.log_path, "pipeline/logs/stage-04.backend.log");

    const logEvents = fs.readFileSync(path.join(cwd, "pipeline", "run-log.jsonl"), "utf8")
      .trim().split("\n").map((line) => JSON.parse(line));
    assert.ok(logEvents.some((event) => event.outcome === "workstream-started" && event.log_path === "pipeline/logs/stage-04.backend.log"));
    assert.ok(logEvents.some((event) => event.outcome === "workstream-finished" && event.duration_ms === 17));
  });

  it("records allowlisted per-workstream dispatch evidence in the durable run log", async () => {
    const cwd = track(makeTargetProject());
    const gatePath = path.join(cwd, "pipeline", "gates", "stage-04.backend.json");
    fs.writeFileSync(gatePath, JSON.stringify({
      stage: "stage-04",
      workstream: "backend",
      host: "codex",
      model: `ghp_${"A".repeat(36)}`,
      status: "PASS",
      cost_usd: 0.42,
      duration_ms: 125,
      blockers: ["free-form text must not enter dispatch evidence"],
    }));
    const actions = [
      { action: "run-stage", stage: "stage-04", name: "build" },
      { action: "pipeline-complete", reason: "done" },
    ];
    let index = 0;

    await run({
      cwd,
      next: () => actions[index++],
      runStageHeadless: async () => [{
        role: "backend", host: "codex", gatePath, exitCode: 0, durationMs: 130,
      }],
    });

    const events = fs.readFileSync(path.join(cwd, "pipeline", "run-log.jsonl"), "utf8")
      .trim().split("\n").map((line) => JSON.parse(line));
    const observation = events.find((event) => event.outcome === "dispatch-observation");
    assert.deepEqual({
      stage: observation.stage,
      role: observation.role,
      host: observation.host,
      model: observation.model,
      status: observation.status,
      cost_usd: observation.cost_usd,
      duration_ms: observation.duration_ms,
      gate_written: observation.gate_written,
    }, {
      stage: "stage-04",
      role: "backend",
      host: "codex",
      model: "other",
      status: "PASS",
      cost_usd: 0.42,
      duration_ms: 125,
      gate_written: true,
    });
    assert.doesNotMatch(JSON.stringify(observation), /free-form text/);
  });

  it("halts structural-input when a dispatch keeps writing no gate", async () => {
    const cwd = track(makeTargetProject());
    const s = await run({
      cwd,
      retryDelayMs: 0,
      sleep: () => Promise.resolve(),
      // next() keeps asking to run the same stage; dispatch never writes a gate
      // and exits non-zero → transient once, then structural-input → halt.
      next: () => ({ action: "run-stage", stage: "stage-01", name: "requirements" }),
      runStageHeadless: async () => [{ role: "pm", gatePath: null, exitCode: 1, durationMs: 1 }],
    });
    assert.equal(s.halt_action, "structural-input");
  });

  it("retries a transient dispatch failure, then succeeds", async () => {
    const cwd = track(makeTargetProject());
    const dispatches = [
      [{ role: "pm", gatePath: null, exitCode: 1, durationMs: 1 }], // transient miss
      [{ role: "pm", gatePath: "x", exitCode: 0, durationMs: 1 }],  // recovers
    ];
    const nextSeq = [
      { action: "run-stage", stage: "stage-01", name: "requirements" },
      { action: "run-stage", stage: "stage-01", name: "requirements" },
      { action: "pipeline-complete", reason: "done" },
    ];
    let d = 0, n = 0;
    const s = await run({
      cwd,
      retryDelayMs: 0,
      sleep: () => Promise.resolve(),
      next: () => nextSeq[n++],
      runStageHeadless: async () => dispatches[d++],
    });
    assert.equal(s.completed, true);
  });

  it("--allow-stage lets the driver dispatch a ceiling stage", async () => {
    const cwd = track(makeTargetProject());
    const actions = [
      { action: "run-stage", stage: "stage-07", name: "sign-off" },
      { action: "pipeline-complete", reason: "done" },
    ];
    let i = 0;
    const s = await run({
      cwd,
      allowStages: ["sign-off"],
      next: () => actions[i++],
      runStageHeadless: async () => [{ role: "pm", gatePath: "x", durationMs: 1 }],
    });
    assert.equal(s.completed, true);
    assert.ok(s.stages_advanced.includes("sign-off"));
  });

  it("--allow-stage accepts comma-separated values (e.g. sign-off,deploy)", async () => {
    const cwd = track(makeTargetProject());
    const actions = [
      { action: "run-stage", stage: "stage-07", name: "sign-off" },
      { action: "run-stage", stage: "stage-08", name: "deploy" },
      { action: "pipeline-complete", reason: "done" },
    ];
    let i = 0;
    const s = await run({
      cwd,
      allowStages: ["sign-off", "deploy"],
      next: () => actions[i++],
      runStageHeadless: async () => [{ role: "pm", gatePath: "x", durationMs: 1 }],
    });
    assert.equal(s.completed, true);
    assert.ok(s.stages_advanced.includes("sign-off"));
    assert.ok(s.stages_advanced.includes("deploy"));
  });

  it("stops at the --until boundary", async () => {
    const cwd = track(makeTargetProject());
    // until=design: a request to run a later stage (build) must halt.
    const s = await run({
      cwd,
      until: "design",
      next: () => ({ action: "run-stage", stage: "stage-04", name: "build" }),
      runStageHeadless: async () => [{ role: "backend", gatePath: "x", durationMs: 1 }],
    });
    assert.equal(s.halt_action, "until");
  });

  it("guards against runaway loops via maxIterations", async () => {
    const cwd = track(makeTargetProject());
    // merge always succeeds and never advances → would loop forever.
    const s = await run({
      cwd,
      maxIterations: 5,
      next: () => ({ action: "merge", stage: "stage-04", name: "build" }),
      mergeWorkstreamGates: () => ({ merged: true }),
    });
    assert.equal(s.halt_action, "max-iterations");
    assert.equal(s.iterations, 5);
  });
});

describe("driver: autonomous fix-and-retry (PR-B)", () => {
  it("clears the failing gate, writes context, re-dispatches, completes", async () => {
    const cwd = track(makeTargetProject());
    // Seed a workstream gate the fix recipe will clear.
    const victim = path.join(cwd, "pipeline", "gates", "stage-04.backend.json");
    fs.writeFileSync(victim, "{}");
    const nextSeq = [
      {
        action: "fix-and-retry", stage: "stage-04", name: "build", failure_class: "code-defect",
        blockers: ["backend test failing"],
        clear_gates: ["pipeline/gates/stage-04.backend.json"],
        fix_steps: [{ description: "rebuild backend", commands: ["rm pipeline/gates/stage-04.backend.json", "devteam stage build --headless"] }],
      },
      { action: "run-stage", stage: "stage-04", name: "build" },
      { action: "pipeline-complete", reason: "done" },
    ];
    let n = 0;
    const s = await run({
      cwd,
      next: () => nextSeq[n++],
      runStageHeadless: async () => [{ role: "backend", gatePath: "x", exitCode: 0, durationMs: 1 }],
    });
    assert.equal(s.completed, true);
    assert.ok(!fs.existsSync(victim), "failing workstream gate was cleared in-process");
    const ctx = fs.readFileSync(path.join(cwd, "pipeline", "context.md"), "utf8");
    assert.match(ctx, /devteam:run-blockers:begin/);
    assert.match(ctx, /backend test failing/);
  });

  it("honors the structured clear_gates from next() (no fix_steps needed)", async () => {
    const cwd = track(makeTargetProject());
    const victim = path.join(cwd, "pipeline", "gates", "stage-04.backend.json");
    fs.writeFileSync(victim, "{}");
    const nextSeq = [
      {
        action: "fix-and-retry", stage: "stage-04", name: "build", failure_class: "code-defect",
        blockers: ["backend test failing"],
        clear_gates: ["pipeline/gates/stage-04.backend.json"], // structured, no fix_steps
      },
      { action: "run-stage", stage: "stage-04", name: "build" },
      { action: "pipeline-complete", reason: "done" },
    ];
    let n = 0;
    const s = await run({
      cwd,
      next: () => nextSeq[n++],
      runStageHeadless: async () => [{ role: "backend", gatePath: "x", exitCode: 0, durationMs: 1 }],
    });
    assert.equal(s.completed, true);
    assert.ok(!fs.existsSync(victim), "structured clear_gates cleared the gate in-process");
  });

  it("targets the owning build workstream after a single-workstream fix-and-retry", async () => {
    const cwd = track(makeTargetProject());
    const victim = path.join(cwd, "pipeline", "gates", "stage-04.platform.json");
    fs.writeFileSync(victim, "{}");
    fs.writeFileSync(path.join(cwd, "Dockerfile"), "FROM node:18-alpine\n");
    const events = [];
    const dispatchOpts = [];
    const nextSeq = [
      {
        action: "fix-and-retry", stage: "stage-04", name: "build", failure_class: "code-defect",
        blockers: [{ text: "EOL base image", file: "Dockerfile" }],
        clear_gates: ["pipeline/gates/stage-04.platform.json", "pipeline/gates/stage-04.json"],
      },
      { action: "run-stage", stage: "stage-04", name: "build" },
      { action: "pipeline-complete", reason: "done" },
    ];
    let n = 0;
    const s = await run({
      cwd,
      next: () => nextSeq[n++],
      onEvent: (ev) => events.push(ev),
      runStageHeadless: async (_stageName, opts) => {
        dispatchOpts.push(opts);
        fs.writeFileSync(path.join(cwd, "Dockerfile"), "FROM node:22-alpine\n");
        return [{ role: "platform", gatePath: "x", exitCode: 0, durationMs: 1 }];
      },
      stallProbe: () => () => {},
    });

    assert.equal(s.completed, true);
    assert.deepEqual(dispatchOpts[0].workstream, ["platform"]);
    assert.deepEqual(dispatchOpts[0].patchItems, ["Fix Dockerfile: EOL base image"]);
    assert.ok(events.some((ev) =>
      ev.type === "fix-retry" &&
      ev.target &&
      ev.target.workstream === "platform" &&
      ev.target.patch_items === 1
    ));
    const state = JSON.parse(fs.readFileSync(path.join(cwd, "pipeline", "run-state.json"), "utf8"));
    assert.equal(state.targetedFix, null, "targeted fix hint is one-shot and cleared after dispatch");
  });

  it("halts targeted build fixes that pass without changing the blocker file", async () => {
    const cwd = track(makeTargetProject());
    const victim = path.join(cwd, "pipeline", "gates", "stage-04.platform.json");
    fs.writeFileSync(victim, "{}");
    fs.writeFileSync(path.join(cwd, "Dockerfile"), "FROM node:18-alpine\n");
    const events = [];
    const nextSeq = [
      {
        action: "fix-and-retry", stage: "stage-04", name: "build", failure_class: "code-defect",
        blockers: [{ text: "EOL base image", file: "Dockerfile" }],
        clear_gates: ["pipeline/gates/stage-04.platform.json", "pipeline/gates/stage-04.json"],
      },
      { action: "run-stage", stage: "stage-04", name: "build" },
      { action: "pipeline-complete", reason: "done" },
    ];
    let n = 0;
    const s = await run({
      cwd,
      next: () => nextSeq[n++],
      onEvent: (ev) => events.push(ev),
      runStageHeadless: async () => [{ role: "platform", gatePath: "x", exitCode: 0, durationMs: 1 }],
      stallProbe: () => () => {},
    });

    assert.equal(s.completed, false);
    assert.equal(s.halt_action, "resolve-escalation");
    assert.equal(s.halt_failure_class, "convergence-exhausted");
    assert.match(s.halt_reason, /targeted fix/);
    assert.match(s.halt_reason, /Dockerfile/);
    assert.ok(events.some((ev) =>
      ev.type === "halt" &&
      ev.failure_class === "convergence-exhausted" &&
      /Dockerfile/.test(ev.no_source_change_evidence)
    ));
  });

  it("detects source change when blocker file path includes :line suffix", async () => {
    // Regression: blockerFiles() used to push the raw "file:line" string, so
    // fs.readFileSync("Dockerfile:16") always threw ENOENT.  Both before- and
    // after-snapshots recorded { exists: false, hash: null }, causing a spurious
    // convergence-exhausted halt even when the fix agent modified the real file.
    const cwd = track(makeTargetProject());
    const victim = path.join(cwd, "pipeline", "gates", "stage-04.platform.json");
    fs.writeFileSync(victim, "{}");
    const dockerfilePath = path.join(cwd, "Dockerfile");
    fs.writeFileSync(dockerfilePath, "FROM node:18-alpine\n");
    let dispatches = 0;
    const nextSeq = [
      {
        action: "fix-and-retry", stage: "stage-04", name: "build", failure_class: "code-defect",
        blockers: [{ text: "devDeps shipped in image", file: "Dockerfile:16" }],
        clear_gates: ["pipeline/gates/stage-04.platform.json", "pipeline/gates/stage-04.json"],
      },
      { action: "run-stage", stage: "stage-04", name: "build" },
      { action: "pipeline-complete", reason: "done" },
    ];
    let n = 0;
    const s = await run({
      cwd,
      next: () => nextSeq[n++],
      onEvent: () => {},
      runStageHeadless: async () => {
        if (dispatches++ === 0) {
          fs.writeFileSync(dockerfilePath, "FROM node:18-alpine\nCOPY --chown=node . .\nUSER node\n");
        }
        return [{ role: "platform", gatePath: "x", exitCode: 0, durationMs: 1 }];
      },
      stallProbe: () => () => {},
    });

    assert.equal(s.completed, true, "should continue, not halt, when the real file was modified");
    assert.ok(!s.halted, "should not set halted flag");
  });

  it("does not target build when fix-and-retry clears multiple workstream gates", async () => {
    const cwd = track(makeTargetProject());
    fs.writeFileSync(path.join(cwd, "pipeline", "gates", "stage-04.backend.json"), "{}");
    fs.writeFileSync(path.join(cwd, "pipeline", "gates", "stage-04.frontend.json"), "{}");
    const dispatchOpts = [];
    const nextSeq = [
      {
        action: "fix-and-retry", stage: "stage-04", name: "build", failure_class: "code-defect",
        blockers: [{ text: "cross-cutting failure", file: "package.json" }],
        clear_gates: [
          "pipeline/gates/stage-04.backend.json",
          "pipeline/gates/stage-04.frontend.json",
          "pipeline/gates/stage-04.json",
        ],
      },
      { action: "run-stage", stage: "stage-04", name: "build" },
      { action: "pipeline-complete", reason: "done" },
    ];
    let n = 0;
    const s = await run({
      cwd,
      next: () => nextSeq[n++],
      runStageHeadless: async (_stageName, opts) => {
        dispatchOpts.push(opts);
        return [{ role: "backend", gatePath: "x", exitCode: 0, durationMs: 1 }];
      },
      stallProbe: () => () => {},
    });

    assert.equal(s.completed, true);
    assert.equal(dispatchOpts[0].workstream, undefined);
    assert.equal(dispatchOpts[0].patchItems, undefined);
  });

  it("targets a build workstream from stage-02 file_ownership when multiple gates are cleared", async () => {
    const cwd = track(makeTargetProject());
    seedGate(cwd, "stage-02", {
      status: "PASS",
      file_ownership: {
        "src/backend/**": "backend",
        "src/frontend/**": "frontend",
        "Dockerfile": "platform",
      },
    });
    fs.mkdirSync(path.join(cwd, "src", "backend"), { recursive: true });
    fs.writeFileSync(path.join(cwd, "src", "backend", "api.js"), "module.exports = {}\n");
    fs.writeFileSync(path.join(cwd, "pipeline", "gates", "stage-04.backend.json"), "{}");
    fs.writeFileSync(path.join(cwd, "pipeline", "gates", "stage-04.frontend.json"), "{}");
    fs.writeFileSync(path.join(cwd, "pipeline", "gates", "stage-04.json"), "{}");
    const dispatchOpts = [];
    const nextSeq = [
      {
        action: "fix-and-retry", stage: "stage-04", name: "build", failure_class: "code-defect",
        blockers: [{ text: "route handler still fails", file: "src/backend/api.js" }],
        clear_gates: [
          "pipeline/gates/stage-04.backend.json",
          "pipeline/gates/stage-04.frontend.json",
          "pipeline/gates/stage-04.json",
        ],
      },
      { action: "run-stage", stage: "stage-04", name: "build" },
      { action: "pipeline-complete", reason: "done" },
    ];
    let n = 0;
    const s = await run({
      cwd,
      next: () => nextSeq[n++],
      runStageHeadless: async (_stageName, opts) => {
        dispatchOpts.push(opts);
        fs.writeFileSync(path.join(cwd, "src", "backend", "api.js"), "module.exports = { ok: true }\n");
        return [{ role: "backend", gatePath: "x", exitCode: 0, durationMs: 1 }];
      },
      stallProbe: () => () => {},
    });

    assert.equal(s.completed, true);
    assert.deepEqual(dispatchOpts[0].workstream, ["backend"]);
    assert.deepEqual(dispatchOpts[0].patchItems, ["Fix src/backend/api.js: route handler still fails"]);
  });

  it("does not target build when file_ownership infers a workstream that was never dispatched by stage-04", async () => {
    // Regression: a post-build stage (e.g. accessibility-audit) can flag a file
    // whose ownership points to "frontend", but the project has no frontend
    // workstream — stage-04 only dispatched backend/platform/qa. The old code
    // inferred workstream: "frontend" anyway, dispatched a build that touched
    // nothing in index.html, and cycled until fix-retry budgets were exhausted.
    // The fix: only accept a file-ownership workstream when its gate was in clear_gates.
    const cwd = track(makeTargetProject());
    seedGate(cwd, "stage-02", {
      status: "PASS",
      file_ownership: {
        "src/frontend/**": "frontend",
        "src/backend/**": "backend",
      },
    });
    for (const ws of ["backend", "platform", "qa"]) {
      fs.writeFileSync(path.join(cwd, "pipeline", "gates", `stage-04.${ws}.json`), "{}");
    }
    const dispatchOpts = [];
    const nextSeq = [
      {
        action: "fix-and-retry", stage: "stage-06b", name: "accessibility-audit",
        failure_class: "code-defect",
        blockers: [{ text: "Missing ARIA on #error", file: "src/frontend/index.html" }],
        clear_gates: [
          "pipeline/gates/stage-04.backend.json",
          "pipeline/gates/stage-04.platform.json",
          "pipeline/gates/stage-04.qa.json",
          "pipeline/gates/stage-04.json",
          "pipeline/gates/stage-06b.json",
        ],
      },
      { action: "run-stage", stage: "stage-04", name: "build" },
      { action: "pipeline-complete", reason: "done" },
    ];
    let n = 0;
    const s = await run({
      cwd,
      next: () => nextSeq[n++],
      runStageHeadless: async (_stageName, opts) => {
        dispatchOpts.push(opts);
        return [{ role: "backend", gatePath: "x", exitCode: 0, durationMs: 1 }];
      },
      stallProbe: () => () => {},
    });

    assert.equal(s.completed, true);
    // No targeted workstream or patchItems — ghost "frontend" workstream was rejected
    assert.equal(dispatchOpts[0].workstream, undefined,
      "should not target a workstream that was never part of stage-04");
    assert.equal(dispatchOpts[0].patchItems, undefined);
  });

  it("does not target build when file_ownership maps blockers to multiple owners", async () => {
    const cwd = track(makeTargetProject());
    seedGate(cwd, "stage-02", {
      status: "PASS",
      file_ownership: {
        "src/backend/**": "backend",
        "src/frontend/**": "frontend",
      },
    });
    fs.writeFileSync(path.join(cwd, "pipeline", "gates", "stage-04.backend.json"), "{}");
    fs.writeFileSync(path.join(cwd, "pipeline", "gates", "stage-04.frontend.json"), "{}");
    fs.writeFileSync(path.join(cwd, "pipeline", "gates", "stage-04.json"), "{}");
    const dispatchOpts = [];
    const nextSeq = [
      {
        action: "fix-and-retry", stage: "stage-04", name: "build", failure_class: "code-defect",
        blockers: [
          { text: "API contract mismatch", file: "src/backend/api.js" },
          { text: "client call mismatch", file: "src/frontend/client.js" },
        ],
        clear_gates: [
          "pipeline/gates/stage-04.backend.json",
          "pipeline/gates/stage-04.frontend.json",
          "pipeline/gates/stage-04.json",
        ],
      },
      { action: "run-stage", stage: "stage-04", name: "build" },
      { action: "pipeline-complete", reason: "done" },
    ];
    let n = 0;
    const s = await run({
      cwd,
      next: () => nextSeq[n++],
      runStageHeadless: async (_stageName, opts) => {
        dispatchOpts.push(opts);
        return [{ role: "backend", gatePath: "x", exitCode: 0, durationMs: 1 }];
      },
      stallProbe: () => () => {},
    });

    assert.equal(s.completed, true);
    assert.equal(dispatchOpts[0].workstream, undefined);
    assert.equal(dispatchOpts[0].patchItems, undefined);
  });

  it("archives the failed attempt's gate before clearing it", async () => {
    const cwd = track(makeTargetProject());
    seedGate(cwd, "stage-04", { status: "FAIL", blockers: ["build broke"] });
    const nextSeq = [
      {
        action: "fix-and-retry", stage: "stage-04", name: "build", failure_class: "code-defect",
        blockers: ["build broke"],
        fix_steps: [{ description: "rebuild", commands: ["rm pipeline/gates/stage-04.json"] }],
      },
      { action: "run-stage", stage: "stage-04", name: "build" },
      { action: "pipeline-complete", reason: "done" },
    ];
    let n = 0;
    await run({
      cwd,
      next: () => nextSeq[n++],
      runStageHeadless: async () => [{ role: "backend", gatePath: "x", exitCode: 0, durationMs: 1 }],
    });
    const archived = path.join(cwd, "pipeline", "gates", "archive", "stage-04.attempt-1.json");
    assert.ok(fs.existsSync(archived), "the failed attempt's gate was archived before clearing");
    assert.deepEqual(JSON.parse(fs.readFileSync(archived, "utf8")).blockers, ["build broke"]);
  });

  it("halts (convergence-exhausted) after the driver retry ceiling", async () => {
    const cwd = track(makeTargetProject());
    const s = await run({
      cwd,
      // config default max_retries = 2; next() always reports the same code-defect.
      next: () => ({
        action: "fix-and-retry", stage: "stage-04", name: "build", failure_class: "code-defect",
        blockers: ["still failing"], fix_steps: [],
      }),
    });
    assert.equal(s.halt_action, "resolve-escalation");
    assert.equal(s.halt_failure_class, "convergence-exhausted");
  });

  it("writes ESCALATE to the gate file when convergence-exhausted fires", async () => {
    const cwd = track(makeTargetProject());
    // Pre-seed the stage gate so _writeConvergenceEscalate has something to update.
    seedGate(cwd, "stage-04", { status: "FAIL", blockers: ["still failing"] });
    await run({
      cwd,
      next: () => ({
        action: "fix-and-retry", stage: "stage-04", name: "build", failure_class: "code-defect",
        blockers: ["still failing"], fix_steps: [],
      }),
    });
    const gate = JSON.parse(fs.readFileSync(
      path.join(cwd, "pipeline", "gates", "stage-04.json"), "utf8"));
    assert.equal(gate.status, "ESCALATE", "gate must be rewritten to ESCALATE on convergence-exhausted");
    assert.ok(gate.escalation_reason, "escalation_reason must be populated");
    assert.ok(gate.decision_needed, "decision_needed must be populated");
    assert.match(gate.decision_needed, /devteam restart build/, "decision_needed must name the stage");
  });

  it("halts (structural-input) immediately when recipe targets gates that don't exist", async () => {
    const cwd = track(makeTargetProject());
    // clear_gates names a gate that is absent → clearGates returns []
    // → toClear.length > 0 AND cleared.length === 0 → no progress possible → halt immediately.
    const s = await run({
      cwd,
      next: () => ({
        action: "fix-and-retry", stage: "stage-05", name: "peer-review", failure_class: "code-defect",
        blockers: [],
        clear_gates: ["pipeline/gates/stage-05.json"],
      }),
    });
    assert.equal(s.halt_action, "fix-and-retry");
    assert.equal(s.halt_failure_class, "structural-input");
    assert.match(s.halt_reason, /no gate clears/);
  });

  it("still halts on non-code-defect fix-and-retry (state-corruption)", async () => {
    const cwd = track(makeTargetProject());
    const s = await run({
      cwd,
      next: () => ({ action: "fix-and-retry", stage: "stage-01", name: "requirements", failure_class: "state-corruption", blockers: ["unreadable"] }),
    });
    assert.equal(s.halt_action, "fix-and-retry");
    assert.equal(s.halt_failure_class, "state-corruption");
  });

  it("fix_steps alone (no clear_gates) does not clear gates — no rm-parsing fallback", async () => {
    // Verifies that fix-recipes migration is complete: clear_gates is the only
    // machine-readable source; the driver no longer parses rm strings from fix_steps.
    const cwd = track(makeTargetProject());
    const victim = path.join(cwd, "pipeline", "gates", "stage-04.json");
    fs.writeFileSync(victim, "{}");
    const s = await run({
      cwd,
      next: () => ({
        action: "fix-and-retry", stage: "stage-04", name: "build", failure_class: "code-defect",
        blockers: ["failing"],
        fix_steps: [{ description: "clear gate", commands: ["rm pipeline/gates/stage-04.json"] }],
        // no clear_gates — driver does not parse fix_steps for rm commands
      }),
    });
    assert.equal(s.halt_action, "resolve-escalation");
    assert.equal(s.halt_failure_class, "convergence-exhausted");
    assert.ok(fs.existsSync(victim), "fix_steps alone does not clear gates; clear_gates must be present");
  });

  it("halts (convergence-exhausted) after one auto-fix attempt when blocker file content is unchanged", async () => {
    // Simulates the hello-world case: red-team names Dockerfile as the blocker file.
    // The build agent re-runs (run-stage) without modifying Dockerfile.
    //
    // Sequence:  fix-and-retry (failure 1)
    //            → run-stage  (auto-fix build dispatched)
    //            → fix-and-retry (failure 2, different blocker text so detectNoProgress
    //                             does not fire — this specifically exercises detectNoSourceChange)
    //
    // Archive 1 is written from the seeded gate (failure 1 text).
    // Archive 2 is written from the gate the mock agent writes (failure 2 text).
    // detectNoProgress: different text across archives → does not fire.
    // detectNoSourceChange: Dockerfile hash identical → fires → halt.
    const cwd = track(makeTargetProject());
    fs.writeFileSync(path.join(cwd, "Dockerfile"), "FROM node:18-alpine\n");

    const gatePath = seedGate(cwd, "stage-04", {
      status: "FAIL",
      blockers: [{ text: "EOL base image (failure 1)", file: "Dockerfile" }],
    });

    const nextSeq = [
      // Failure 1: archive written from seeded gate, srcFingerprints baseline stored.
      {
        action: "fix-and-retry", stage: "stage-04", name: "build", failure_class: "code-defect",
        blockers: [{ text: "EOL base image (failure 1)", file: "Dockerfile" }],
        clear_gates: [],
      },
      // Auto-fix build dispatched.
      { action: "run-stage", stage: "stage-04", name: "build" },
      // Failure 2: different blocker text → detectNoProgress does not fire.
      {
        action: "fix-and-retry", stage: "stage-04", name: "build", failure_class: "code-defect",
        blockers: [{ text: "EOL base image (failure 2)", file: "Dockerfile" }],
        clear_gates: [],
      },
    ];
    let n = 0;
    const s = await run({
      cwd,
      next: () => nextSeq[n++],
      // Mock agent: rewrites gate with new blocker text but leaves Dockerfile untouched.
      runStageHeadless: async () => {
        fs.writeFileSync(gatePath, JSON.stringify({
          stage: "stage-04", status: "FAIL",
          blockers: [{ text: "EOL base image (failure 2)", file: "Dockerfile" }],
        }));
        return [{ role: "platform", gatePath, exitCode: 0, durationMs: 1 }];
      },
    });

    assert.equal(s.halt_failure_class, "convergence-exhausted");
    assert.match(s.halt_reason, /no-source-change/);
    assert.match(s.halt_reason, /Dockerfile/);
  });
});

describe("driver: auto-rule escalation (Phase 2 PR-C2)", () => {
  // Helper: write a Principal output line into context.md (what runRuling does).
  function writeOutput(cwd, line) {
    const p = path.join(cwd, "pipeline", "context.md");
    fs.mkdirSync(path.dirname(p), { recursive: true });
    fs.appendFileSync(p, (fs.existsSync(p) ? "" : "## Principal Rulings\n\n") + line + "\n");
  }
  const escalation = { action: "resolve-escalation", stage: "stage-05", name: "peer-review", failure_class: "judgment-gate", gate: "x", reason: "reviewers split" };

  it("halts by default (no grant) without dispatching the Principal", async () => {
    const cwd = track(makeTargetProject());
    let dispatched = false;
    const s = await run({
      cwd,
      next: () => escalation,
      runRuling: async () => { dispatched = true; return { exitCode: 0 }; },
    });
    assert.equal(s.halt_action, "resolve-escalation");
    assert.equal(dispatched, false, "Principal must not be dispatched without a grant");
  });

  it("auto-applies a granted ruling and resumes", async () => {
    const cwd = track(makeTargetProject());
    const nextSeq = [escalation, { action: "pipeline-complete", reason: "done" }];
    let n = 0, applied = false;
    const s = await run({
      cwd,
      autoRule: ["formatting-only"],
      next: () => nextSeq[n++],
      runRuling: async () => { writeOutput(cwd, "PRINCIPAL-RULING: lint → accept defaults [class: formatting-only]"); return { exitCode: 0 }; },
      runFixEscalation: async () => { applied = true; return { exitCode: 0 }; },
    });
    assert.equal(s.completed, true);
    assert.equal(applied, true);
  });

  it("halts on a cannot-decide even with a grant", async () => {
    const cwd = track(makeTargetProject());
    const s = await run({
      cwd,
      autoRule: ["formatting-only"],
      next: () => escalation,
      runRuling: async () => { writeOutput(cwd, "PRINCIPAL-CANNOT-DECIDE: authority → who approves the scope cut?"); return { exitCode: 0 }; },
    });
    assert.equal(s.halt_failure_class, "cannot-decide");
    assert.equal(s.cannot_decide.reason_class, "authority");
  });

  it("halts when the ruling class is not granted", async () => {
    const cwd = track(makeTargetProject());
    const s = await run({
      cwd,
      autoRule: ["doc-only"],
      next: () => escalation,
      runRuling: async () => { writeOutput(cwd, "PRINCIPAL-RULING: auth → use JWT [class: security-tradeoff]"); return { exitCode: 0 }; },
    });
    assert.equal(s.halt_action, "resolve-escalation");
    assert.match(s.halt_reason, /not in the --auto-rule grant/);
  });

  it("never auto-rules at the consequence ceiling, even when granted", async () => {
    const cwd = track(makeTargetProject());
    let dispatched = false;
    const s = await run({
      cwd,
      autoRule: ["deploy-ok"],
      next: () => ({ action: "resolve-escalation", stage: "stage-08", name: "deploy", failure_class: "judgment-gate", gate: "x", reason: "deploy escalation" }),
      runRuling: async () => { dispatched = true; return { exitCode: 0 }; },
    });
    assert.equal(s.halt_action, "resolve-escalation");
    assert.equal(dispatched, false);
  });

  it("halts after one auto-rule attempt if the escalation persists", async () => {
    const cwd = track(makeTargetProject());
    let rulings = 0;
    const s = await run({
      cwd,
      autoRule: ["formatting-only"],
      next: () => escalation, // never clears
      runRuling: async () => { rulings++; writeOutput(cwd, "PRINCIPAL-RULING: x → y [class: formatting-only]"); return { exitCode: 0 }; },
      runFixEscalation: async () => ({ exitCode: 0 }),
    });
    assert.equal(s.halted, true);
    assert.equal(rulings, 1, "Principal dispatched at most once for the same escalation");
  });

  it("binds authority provenance (resolved_by) onto the escalating gate (PR-D2)", async () => {
    const cwd = track(makeTargetProject());
    const gp = seedGate(cwd, "stage-05", { status: "ESCALATE", escalation_reason: "split" });
    const nextSeq = [
      { action: "resolve-escalation", stage: "stage-05", name: "peer-review", failure_class: "judgment-gate", gate: gp, reason: "split" },
      { action: "pipeline-complete", reason: "done" },
    ];
    let n = 0;
    await run({
      cwd,
      autoRule: ["formatting-only"],
      next: () => nextSeq[n++],
      runRuling: async () => { writeOutput(cwd, "PRINCIPAL-RULING: lint → accept defaults [class: formatting-only]"); return { exitCode: 0 }; },
      runFixEscalation: async () => ({ exitCode: 0 }),
    });
    const g = JSON.parse(fs.readFileSync(gp, "utf8"));
    assert.equal(g.resolved_by.authority, "auto-rule:formatting-only");
    assert.equal(g.resolved_by.grant_class, "formatting-only");
    assert.match(g.resolved_by.ruling, /accept defaults/);
  });
});

describe("driver: stoplist enforcement on autonomous path (Phase 1 § 1.1)", () => {
  // quick track + stoplist-matching description → halts before any dispatch,
  // run-log carries the stoplist-halt event.
  it("halts before dispatch on a quick track with a stoplist-matching description", async () => {
    const cwd = track(makeTargetProject());
    let dispatched = false;
    const s = await run({
      cwd,
      track: "quick",
      description: "add password storage for user credentials",
      next: () => { dispatched = true; return { action: "pipeline-complete", reason: "done" }; },
    });
    assert.equal(s.halted, true, "run must be halted");
    assert.equal(s.halt_action, "stoplist", "halt_action must be 'stoplist'");
    assert.equal(dispatched, false, "next() must never be called — halt before loop");
    // run-log must contain the stoplist-halt event
    const log = fs.readFileSync(path.join(cwd, "pipeline", "run-log.jsonl"), "utf8");
    const events = log.trim().split("\n").map((l) => JSON.parse(l));
    const haltEvent = events.find((e) => e.outcome === "stoplist-halt");
    assert.ok(haltEvent, "run-log.jsonl must contain a stoplist-halt event");
    assert.equal(haltEvent.track, "quick");
  });

  // Same brief with full track → no stoplist halt (full bypass is by design).
  it("does not halt on a full track even with a stoplist-matching description", async () => {
    const cwd = track(makeTargetProject());
    const s = await run({
      cwd,
      track: "full",
      description: "add password storage for user credentials",
      // One iteration then done — no need for real stages.
      next: () => ({ action: "pipeline-complete", reason: "done" }),
    });
    assert.equal(s.completed, true, "full track must not be stopped by the stoplist");
    assert.notEqual(s.halt_action, "stoplist");
  });

  // Brief written mid-run (by the requirements agent) triggers pre-build halt.
  // Inject a runStageHeadless fake that writes a stoplist-matching brief.md
  // during the requirements stage; the driver must halt before dispatching build
  // (stage-04) at check-point 2.
  it("halts before build when the requirements agent writes a stoplist-matching brief", async () => {
    const cwd = track(makeTargetProject());
    // Sequence: requirements (stage-01) → build (stage-04).
    // The fake runStageHeadless writes a stoplist-matching brief.md when it
    // dispatches requirements, simulating the agent producing a brief mid-run.
    const actions = [
      { action: "run-stage", stage: "stage-01", name: "requirements" },
      { action: "run-stage", stage: "stage-04", name: "build" },
      { action: "pipeline-complete", reason: "done" },
    ];
    let i = 0;
    let buildDispatched = false;
    const s = await run({
      cwd,
      track: "quick",
      // No description at run-start (so check-point 1 sees nothing).
      description: "",
      next: () => actions[i++],
      runStageHeadless: async (stageName) => {
        if (stageName === "requirements") {
          // Simulate the requirements agent writing a sensitive brief.
          fs.mkdirSync(path.join(cwd, "pipeline"), { recursive: true });
          fs.writeFileSync(
            path.join(cwd, "pipeline", "brief.md"),
            "# Feature brief\nImplement password storage and authentication flow.",
          );
        }
        if (stageName === "build") buildDispatched = true;
        return [{ role: "pm", gatePath: "x", exitCode: 0, durationMs: 1 }];
      },
    });
    assert.equal(s.halted, true, "run must be halted");
    assert.equal(s.halt_action, "stoplist", "halt_action must be 'stoplist'");
    assert.equal(buildDispatched, false, "build must not be dispatched after stoplist match");
    // run-log must carry the pre-build halt event
    const log = fs.readFileSync(path.join(cwd, "pipeline", "run-log.jsonl"), "utf8");
    const events = log.trim().split("\n").map((l) => JSON.parse(l));
    const haltEvent = events.find((e) => e.outcome === "stoplist-halt" && e.label === "pre-build");
    assert.ok(haltEvent, "run-log must contain a pre-build stoplist-halt event");
  });
});

// ─── Fix 1.7.3: budget cap must account for unmerged workstream gate costs ─
// Regression for: totalCostUsd() sums only merged stage gates (stage-NN.json),
// so a multi-role stage's per-workstream costs (stage-NN.<role>.json) are
// invisible until the merge happens. After the fix, totalCostUsd() must include
// workstream gate costs when no merged gate exists for that stage yet, and must
// NOT double-count once the merged gate exists.
// (plans/phase-1-trust-consolidation.md item 1.7 fix 3)
describe("driver: budget cap accounts for unmerged workstream gate costs (fix 1.7.3)", () => {
  it("halts on budget before next dispatch when only workstream gates exist and their sum exceeds the cap", async () => {
    const cwd = track(makeTargetProject());
    // stage-01 merged gate passes (cost: $1)
    seedGate(cwd, "stage-01", { status: "PASS", cost_usd: 1 });
    // stage-04 has workstream gates but no merged gate yet; combined cost = $5
    const gatesDir = path.join(cwd, "pipeline", "gates");
    fs.writeFileSync(
      path.join(gatesDir, "stage-04.backend.json"),
      JSON.stringify({ stage: "stage-04", status: "PASS", cost_usd: 3 }),
    );
    fs.writeFileSync(
      path.join(gatesDir, "stage-04.frontend.json"),
      JSON.stringify({ stage: "stage-04", status: "PASS", cost_usd: 2 }),
    );
    // Budget cap is $4; total spend visible = $1 (merged) + $5 (workstream) = $6.
    // Before the fix, totalCostUsd only counted $1 (the merged gate), so the cap
    // would not trigger. After the fix it must trigger.
    //
    // Inject both next() (always returns run-stage for design) and a
    // runStageHeadless stub so the test never attempts a real dispatch.
    // Without the budget fix, the budget check passes ($1 < $4) and the test
    // would reach runStageHeadless. With the fix, it halts before dispatch.
    const s = await run({
      cwd,
      budgetUsd: 4,
      next: () => ({ action: "run-stage", stage: "stage-02", name: "design", reason: "test" }),
      runStageHeadless: () => { throw new Error("should not dispatch — budget must halt first"); },
    });
    assert.equal(s.halt_action, "budget",
      "budget halt must fire when unmerged workstream gate costs are included in total");
    assert.ok(s.cost_usd >= 4,
      `reported cost (${s.cost_usd}) must be >= cap (4) when workstream gates are counted`);
  });

  it("does NOT double-count workstream costs when a merged gate already exists for the same stage", async () => {
    const cwd = track(makeTargetProject());
    // stage-01 merged gate with cost $2 (rolled up from workstreams).
    seedGate(cwd, "stage-01", { status: "PASS", cost_usd: 2 });
    // Workstream gates also present (they should NOT be added again because the merged gate exists).
    const gatesDir = path.join(cwd, "pipeline", "gates");
    fs.writeFileSync(
      path.join(gatesDir, "stage-01.backend.json"),
      JSON.stringify({ stage: "stage-01", status: "PASS", cost_usd: 1 }),
    );
    fs.writeFileSync(
      path.join(gatesDir, "stage-01.frontend.json"),
      JSON.stringify({ stage: "stage-01", status: "PASS", cost_usd: 1 }),
    );
    // Budget cap $3; if we double-count → $4 → halt; if we don't → $2 → no halt.
    const s = await run({
      cwd,
      budgetUsd: 3,
      next: () => ({ action: "pipeline-complete", reason: "test" }),
    });
    // With no double-counting, total = $2 < $3 cap → should NOT halt on budget.
    assert.equal(s.completed, true, "pipeline should complete without budget halt when no double-counting occurs");
    assert.equal(s.halted, false, "should not be halted");
  });
});

describe("driver: progress-based convergence (4.2)", () => {
  // Write minimal run-state so the driver can be resumed with pre-seeded fixRetries.
  function seedRunState(cwd, fixRetries) {
    const p = path.join(cwd, "pipeline", "run-state.json");
    fs.mkdirSync(path.dirname(p), { recursive: true });
    fs.writeFileSync(p, JSON.stringify({
      track: "full",
      iterations: Object.values(fixRetries)[0] || 0,
      retries: {},
      started_at: new Date().toISOString(),
      fixRetries,
      autoRule: {},
      transient: {},
    }, null, 2));
  }

  // Write an archive gate directly into pipeline/gates/archive/.
  function seedArchive(cwd, stageId, attempt, gate) {
    const dir = path.join(cwd, "pipeline", "gates", "archive");
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(
      path.join(dir, `${stageId}.attempt-${attempt}.json`),
      JSON.stringify({ stage: stageId, blockers: [], ...gate }, null, 2),
    );
  }

  it("trips the progress-based breaker when archived blockers are identical (same blocker unchanged)", async () => {
    // Setup: one prior archive at attempt-1 with the same stuck blocker.
    // The driver archives the current gate at attempt-2 → identical → halt.
    const cwd = track(makeTargetProject());
    seedRunState(cwd, { build: 1 });
    seedArchive(cwd, "stage-04", 1, { blockers: ["unit tests still failing"] });
    seedGate(cwd, "stage-04", { status: "FAIL", blockers: ["unit tests still failing"] });

    const s = await run({
      cwd,
      resume: true,
      next: () => ({
        action: "fix-and-retry", stage: "stage-04", name: "build",
        failure_class: "code-defect",
        blockers: ["unit tests still failing"],
      }),
    });

    assert.equal(s.halt_action, "resolve-escalation");
    assert.equal(s.halt_failure_class, "convergence-exhausted");
    assert.ok(s.no_progress_evidence, "no_progress_evidence must be set in summary");
    assert.match(s.no_progress_evidence, /unit tests still failing/);
    assert.match(s.no_progress_evidence, /1,2/);
    assert.match(s.halt_reason, /no-progress convergence/);

    // run-log must carry the no_progress_evidence for operator inspection.
    const log = fs.readFileSync(path.join(cwd, "pipeline", "run-log.jsonl"), "utf8");
    const events = log.trim().split("\n").map((l) => JSON.parse(l));
    const haltEvent = events.find((e) => e.outcome === "convergence-halt");
    assert.ok(haltEvent, "run-log must contain a convergence-halt event");
    assert.ok(haltEvent.no_progress_evidence, "run-log convergence-halt must carry no_progress_evidence");
  });

  it("does NOT trip the progress-based breaker when blockers changed between archives", async () => {
    // Setup: attempt-1 had different blockers → progress was made → no-progress check passes.
    // The count ceiling (attempts=2 >= maxRetries=2) triggers the halt instead.
    const cwd = track(makeTargetProject());
    seedRunState(cwd, { build: 1 });
    seedArchive(cwd, "stage-04", 1, { blockers: ["original blocker"] });
    seedGate(cwd, "stage-04", { status: "FAIL", blockers: ["new blocker"] }); // different!

    const s = await run({
      cwd,
      resume: true,
      next: () => ({
        action: "fix-and-retry", stage: "stage-04", name: "build",
        failure_class: "code-defect",
        blockers: ["new blocker"],
      }),
    });

    assert.equal(s.halt_action, "resolve-escalation");
    assert.equal(s.halt_failure_class, "convergence-exhausted");
    assert.ok(!s.no_progress_evidence, "no_progress_evidence must be absent — halt was count-based");
    assert.match(s.halt_reason, /retry budget exhausted/);
  });

  // ─── 5.2 regression tests ──────────────────────────────────────────────────
  //
  // Both tests must FAIL on main (before 5.2 changes) and pass with the fix.
  // (a) Stage failed twice → recovered → re-entered via downstream recipe → no
  //     instant convergence-exhausted (archives pruned by prune-on-re-entry).
  // (b) Fresh non-resume run + stale attempt-2/3 archives with identical blockers
  //     → no false no-progress halt (stale-archive guard in convergence.js).

  it("(5.2a) re-entry via downstream recipe prunes stale archives — first new failure is fix-and-retry not convergence-exhausted", async () => {
    const cwd = track(makeTargetProject());

    // Seed stage-04 archives from 2 previous failures with identical blockers.
    // Without 5.2, these survive a downstream recipe's gate clear and cause
    // detectNoProgress to trip on the very first new failure (attempt-1 compared
    // to stale-2 → same blockers → noProgress=true → convergence-exhausted).
    const archiveDir = path.join(cwd, "pipeline", "gates", "archive");
    fs.mkdirSync(archiveDir, { recursive: true });
    for (const n of [1, 2]) {
      fs.writeFileSync(
        path.join(archiveDir, `stage-04.attempt-${n}.json`),
        JSON.stringify({ stage: "stage-04", blockers: ["tests failing"], status: "FAIL" }),
      );
    }
    // Stage-04 gate is PASS (it recovered after those failures).
    seedGate(cwd, "stage-04", { status: "PASS" });

    // Downstream recipe clears stage-04.json (triggering prune-on-re-entry).
    // Then stage-04 fails for the first time in the new sequence.
    const seq = [
      {
        action: "fix-and-retry",
        stage: "stage-06d",
        name: "verification-beyond-tests",
        failure_class: "code-defect",
        blockers: ["e2e failed"],
        clear_gates: ["pipeline/gates/stage-04.json"],
      },
      // Stage-04 fails again (first attempt in the new re-entry sequence).
      // No clear_gates → driver increments retry counter and loops without halting.
      {
        action: "fix-and-retry",
        stage: "stage-04",
        name: "build",
        failure_class: "code-defect",
        blockers: ["tests failing"], // same text as stale archives!
      },
      { action: "pipeline-complete", reason: "done" },
    ];
    let si = 0;
    const s = await run({ cwd, next: () => seq[si++] });

    // With 5.2: prune-on-re-entry deletes stale archives when stage-04 gate is cleared
    //   → detectNoProgress sees no archives for stage-04 → noProgress=false → fix-and-retry
    //   → pipeline completes.
    // Without 5.2: stale archives survive → detectNoProgress compares old-1 and old-2
    //   → identical blockers → convergence-exhausted → halt.
    assert.equal(s.completed, true,
      "stale archives must be pruned on re-entry — first new failure must not hit convergence-exhausted");
  });

  it("(5.2b) stale archives from a previous run don't produce a false no-progress halt on a fresh run", async () => {
    const cwd = track(makeTargetProject());

    // Seed stage-04 with a current FAIL gate.
    seedGate(cwd, "stage-04", { status: "FAIL", blockers: ["tests failing"] });

    // Seed stale archives from a PREVIOUS run — identical blockers, attempt-2 and
    // attempt-3 — with mtime set to 1 hour ago to simulate a previous run. A fresh
    // driver run resets fixRetries to 0 and archives at attempt-1 (new mtime = now),
    // but the stale 2/3 survive if pruning was missed.
    const archiveDir = path.join(cwd, "pipeline", "gates", "archive");
    fs.mkdirSync(archiveDir, { recursive: true });
    const pastTime = new Date(Date.now() - 3_600_000); // 1 hour ago
    for (const n of [2, 3]) {
      const p = path.join(archiveDir, `stage-04.attempt-${n}.json`);
      fs.writeFileSync(p, JSON.stringify({ stage: "stage-04", blockers: ["tests failing"], status: "FAIL" }));
      fs.utimesSync(p, pastTime, pastTime);
    }

    const seq = [
      // Fresh driver archives attempt-1 (mtime=now), then clears stage-04.json.
      {
        action: "fix-and-retry",
        stage: "stage-04",
        name: "build",
        failure_class: "code-defect",
        blockers: ["tests failing"],
        clear_gates: ["pipeline/gates/stage-04.json"],
      },
      { action: "pipeline-complete", reason: "done" },
    ];
    let si = 0;
    const s = await run({ cwd, next: () => seq[si++] });

    // With 5.2: _currentSequenceArchives guard filters stale-2 and stale-3 (old mtime)
    //   → detectNoProgress sees only new attempt-1 → noProgress=false → fix-and-retry loops
    //   → pipeline completes.
    // Without 5.2: no guard → detectNoProgress compares stale-2 and stale-3
    //   → identical blockers → noProgress=true → convergence-exhausted → halt.
    assert.equal(s.completed, true,
      "stale archives from a previous run must not produce a false no-progress halt");
  });

  it("no_progress_evidence is absent on a count-based convergence-exhausted halt (max_retries=0)", async () => {
    // With max_retries=0, the count ceiling fires before any archiving occurs,
    // so there are no two archives to compare → no_progress_evidence must be absent.
    const cwd = track(makeTargetProject({
      config: "routing:\n  default_host: generic\npipeline:\n  default_track: full\nautonomy:\n  max_retries: 0\n",
    }));
    seedGate(cwd, "stage-01", { status: "FAIL", blockers: ["x"] });
    const s = await run({ cwd });
    assert.equal(s.halt_failure_class, "convergence-exhausted");
    assert.ok(!s.no_progress_evidence, "count-based halt must not set no_progress_evidence");
  });
});

// ─── ADR-007 Tier 1: heartbeat + observe-only stall probe ─────────────────

describe("driver: heartbeat events (ADR-007 §2)", () => {
  it("emits a heartbeat event in run-log.jsonl at the start of every iteration", async () => {
    const cwd = track(makeTargetProject());
    const actions = [
      { action: "run-stage", stage: "stage-01", name: "requirements" },
      { action: "run-stage", stage: "stage-04", name: "build" },
      { action: "pipeline-complete", reason: "done" },
    ];
    let i = 0;
    await run({
      cwd,
      next: () => actions[i++],
      runStageHeadless: async () => [{ role: "pm", gatePath: "x", exitCode: 0, durationMs: 1 }],
      // Noop stall probe so dispatch tests don't depend on fs probing.
      stallProbe: () => () => {},
    });
    const logLines = fs.readFileSync(path.join(cwd, "pipeline", "run-log.jsonl"), "utf8")
      .trim().split("\n").map((l) => JSON.parse(l));
    const heartbeats = logLines.filter((e) => e.outcome === "heartbeat");
    // 3 iterations → 3 heartbeats (before each next() call).
    assert.equal(heartbeats.length, 3, "one heartbeat per iteration");
    // Heartbeat shape: has iteration, stage, action, run_state_path, cost_usd_so_far.
    for (const hb of heartbeats) {
      assert.ok(typeof hb.iteration === "number", "heartbeat.iteration must be a number");
      assert.ok("stage" in hb, "heartbeat must have a stage field");
      assert.ok("action" in hb, "heartbeat must have an action field");
      assert.ok("run_state_path" in hb, "heartbeat must have run_state_path");
    }
  });

  it("onEvent receives heartbeat on every iteration", async () => {
    const cwd = track(makeTargetProject());
    const events = [];
    const actions = [
      { action: "run-stage", stage: "stage-01", name: "requirements" },
      { action: "pipeline-complete", reason: "done" },
    ];
    let i = 0;
    await run({
      cwd,
      next: () => actions[i++],
      runStageHeadless: async () => [{ role: "pm", gatePath: "x", exitCode: 0, durationMs: 1 }],
      onEvent: (ev) => events.push(ev),
      stallProbe: () => () => {},
    });
    const hbEvents = events.filter((e) => e.type === "heartbeat");
    assert.equal(hbEvents.length, 2, "two heartbeat onEvent calls for 2 iterations");
    assert.ok(hbEvents.every((e) => typeof e.iteration === "number"), "heartbeat events have iteration");
  });
});

describe("driver: observe-only stall probe (ADR-007 §3, Tier 1)", () => {
  it("emits stall-detected in run-log.jsonl when injected probe fires (does NOT kill dispatch)", async () => {
    const cwd = track(makeTargetProject());
    const actions = [
      { action: "run-stage", stage: "stage-04", name: "build" },
      { action: "pipeline-complete", reason: "done" },
    ];
    let i = 0;

    // Inject a stallProbe that fires a stall event synchronously via logEvent callback.
    // This simulates a flat log+gate past the threshold (injected clock).
    let dispatchCompleted = false;
    let probeCancelCalled = false;
    const fakeStallProbe = (_stageName, _stageId, _cwd, _changeId, _t0, probeOpts) => {
      // Fire stall-detected immediately via the logEvent callback.
      if (probeOpts.logEvent) {
        probeOpts.logEvent({
          outcome: "stall-detected",
          iteration: probeOpts.iteration,
          stage: _stageName,
          action: probeOpts.action,
          stall_threshold_ms: 300000,
          log_growth_bytes_last_interval: 0,
          gate_updated: false,
          dispatch_elapsed_ms: 10000,
          stall_class: "observed",
        });
      }
      if (probeOpts.onEvent) {
        probeOpts.onEvent({
          type: "stall-detected",
          stage: _stageName,
          stall_class: "observed",
        });
      }
      return () => { probeCancelCalled = true; };
    };

    const s = await run({
      cwd,
      next: () => actions[i++],
      runStageHeadless: async () => {
        dispatchCompleted = true;
        return [{ role: "backend", gatePath: "x", exitCode: 0, durationMs: 1 }];
      },
      stallProbe: fakeStallProbe,
    });

    // Dispatch must complete normally — probe never kills.
    assert.equal(s.completed, true, "stall-detected must not kill the dispatch");
    assert.equal(dispatchCompleted, true, "dispatch must complete even when stall is detected");

    // stall-detected event must be in run-log.jsonl.
    const logLines = fs.readFileSync(path.join(cwd, "pipeline", "run-log.jsonl"), "utf8")
      .trim().split("\n").map((l) => JSON.parse(l));
    const stallEvent = logLines.find((e) => e.outcome === "stall-detected");
    assert.ok(stallEvent, "stall-detected must appear in run-log.jsonl");
    assert.equal(stallEvent.stall_class, "observed", "stall_class must be 'observed' in Tier 1");
    assert.equal(stallEvent.stage, "build");

    // Cancel must be called when dispatch settles (no stale events after stage moves on).
    assert.equal(probeCancelCalled, true, "cancel() must be called when dispatch settles");
  });

  it("probe cancel is called even when dispatch throws (no leaked stall timers)", async () => {
    const cwd = track(makeTargetProject());
    let cancelCalled = false;
    await run({
      cwd,
      next: () => ({ action: "run-stage", stage: "stage-01", name: "requirements" }),
      runStageHeadless: async () => {
        throw new Error("dispatch failed unexpectedly");
      },
      stallProbe: () => () => { cancelCalled = true; },
    }).catch(() => null);
    // Whether or not the driver surfaces the error, cancel must have been called.
    assert.equal(cancelCalled, true, "cancel() must be called via finally even when dispatch throws");
  });

  it("stall-detected event appears in onEvent stream", async () => {
    const cwd = track(makeTargetProject());
    const events = [];
    const actions = [
      { action: "run-stage", stage: "stage-04", name: "build" },
      { action: "pipeline-complete", reason: "done" },
    ];
    let i = 0;

    await run({
      cwd,
      next: () => actions[i++],
      runStageHeadless: async () => [{ role: "backend", gatePath: "x", exitCode: 0, durationMs: 1 }],
      onEvent: (ev) => events.push(ev),
      stallProbe: (_name, _id, _cwd, _changeId, _t0, probeOpts) => {
        if (probeOpts.onEvent) {
          probeOpts.onEvent({ type: "stall-detected", stage: _name, stall_class: "observed" });
        }
        return () => {};
      },
    });

    const stallEv = events.find((e) => e.type === "stall-detected");
    assert.ok(stallEv, "stall-detected must appear in onEvent stream");
    assert.equal(stallEv.stall_class, "observed");
  });
});

// ─── ADR-008 Phase 11.2: advisory sweep + --fail-on-advisory ─────────────────

describe("driver: post-completion advisory sweep (ADR-008 Phase 11.2)", () => {
  it("pipeline-complete with QA_BLOCKER noted_for_followup → advisory_blockers_count + breakdown in summary", async () => {
    // Item with an AC ref and no spec.feature → classifyItem returns QA_BLOCKER.
    const cwd = track(makeTargetProject());
    seedAllPass(cwd);
    const gateFile = path.join(cwd, "pipeline", "gates", "stage-04.json");
    const gate = JSON.parse(fs.readFileSync(gateFile, "utf8"));
    gate.noted_for_followup = [{ id: "RT-01", text: "AC-5: missing coverage in auth flow" }];
    fs.writeFileSync(gateFile, JSON.stringify(gate, null, 2));

    const s = await run({ cwd });
    assert.equal(s.completed, true);
    assert.equal(s.advisory_blockers_count, 1, "advisory_blockers_count must reflect the QA_BLOCKER item");
    assert.equal((s.advisory_breakdown || {}).QA_BLOCKER, 1, "breakdown must count QA_BLOCKER");
  });

  it("clean pipeline (no noted_for_followup) → advisory_blockers_count = 0", async () => {
    const cwd = track(makeTargetProject());
    seedAllPass(cwd);
    const s = await run({ cwd });
    assert.equal(s.completed, true);
    assert.equal(s.advisory_blockers_count || 0, 0, "advisory_blockers_count must be 0 on a clean pipeline");
  });
});

describe("run CLI: advisory loud line + --fail-on-advisory exit code (ADR-008)", () => {
  // Tests run the CLI as a subprocess so exit codes and stderr output are observable.
  // All stages are pre-seeded PASS so no dispatch occurs — these complete quickly.

  it("run reads --feature-file before enforcing repair/feature mutual exclusion", () => {
    const cwd = track(makeTargetProject());
    const featureFile = path.join(cwd, "feature-brief.md");
    fs.writeFileSync(featureFile, "Feature from file\n");

    const r = runCLI(["run", "--cwd", cwd, "--feature-file", featureFile, "--repair", "bug"]);
    assert.equal(r.status, 1);
    assert.match(r.stderr, /--repair and --feature are mutually exclusive/);
  });

  it("run rejects --feature with --feature-file", () => {
    const cwd = track(makeTargetProject());
    const featureFile = path.join(cwd, "feature-brief.md");
    fs.writeFileSync(featureFile, "Feature from file\n");

    const r = runCLI(["run", "--cwd", cwd, "--feature", "inline", "--feature-file", featureFile]);
    assert.equal(r.status, 2);
    assert.match(r.stderr, /--feature and --feature-file are mutually exclusive/);
  });

  it("QA_BLOCKER noted_for_followup → default exit 0, loud line on stderr, advisory_blockers_count in --json", () => {
    const cwd = track(makeTargetProject());
    seedAllPass(cwd);
    const gateFile = path.join(cwd, "pipeline", "gates", "stage-04.json");
    const gate = JSON.parse(fs.readFileSync(gateFile, "utf8"));
    gate.noted_for_followup = [{ id: "RT-01", text: "AC-5: missing coverage" }];
    fs.writeFileSync(gateFile, JSON.stringify(gate, null, 2));

    const r = runCLI(["run", "--cwd", cwd, "--json"]);
    assert.equal(r.status, 0, "default exit must be 0 even when advisory blockers exist");
    const json = JSON.parse(r.stdout);
    assert.ok((json.advisory_blockers_count || 0) > 0, "advisory_blockers_count must appear in --json output");
    assert.match(r.stderr, /advisory blocker\(s\) remain/, "loud advisory line must appear on stderr");
  });

  it("QA_BLOCKER item + --fail-on-advisory → exit 3", () => {
    const cwd = track(makeTargetProject());
    seedAllPass(cwd);
    const gateFile = path.join(cwd, "pipeline", "gates", "stage-04.json");
    const gate = JSON.parse(fs.readFileSync(gateFile, "utf8"));
    gate.noted_for_followup = [{ id: "RT-01", text: "AC-5: missing coverage" }];
    fs.writeFileSync(gateFile, JSON.stringify(gate, null, 2));

    const r = runCLI(["run", "--cwd", cwd, "--fail-on-advisory"]);
    assert.equal(r.status, 3, "--fail-on-advisory must exit 3 when QA_BLOCKER items remain");
  });

  it("only PEER_REVIEW_RISK + --fail-on-advisory (default threshold) → exit 0", () => {
    // PEER_REVIEW_RISK is below the default threshold (QA_BLOCKER + A11Y_FIX only).
    const cwd = track(makeTargetProject());
    seedAllPass(cwd);
    const gateFile = path.join(cwd, "pipeline", "gates", "stage-04.json");
    const gate = JSON.parse(fs.readFileSync(gateFile, "utf8"));
    gate.noted_for_followup = [{ id: "RT-02", text: "risky security change", severity: "high" }];
    fs.writeFileSync(gateFile, JSON.stringify(gate, null, 2));

    const r = runCLI(["run", "--cwd", cwd, "--fail-on-advisory"]);
    assert.equal(r.status, 0, "--fail-on-advisory default threshold must not exit 3 for PEER_REVIEW_RISK only");
  });

  it("only PEER_REVIEW_RISK + --fail-on-advisory=all → exit 3", () => {
    // =all adds PEER_REVIEW_RISK to the threshold.
    const cwd = track(makeTargetProject());
    seedAllPass(cwd);
    const gateFile = path.join(cwd, "pipeline", "gates", "stage-04.json");
    const gate = JSON.parse(fs.readFileSync(gateFile, "utf8"));
    gate.noted_for_followup = [{ id: "RT-02", text: "risky security change", severity: "high" }];
    fs.writeFileSync(gateFile, JSON.stringify(gate, null, 2));

    const r = runCLI(["run", "--cwd", cwd, "--fail-on-advisory=all"]);
    assert.equal(r.status, 3, "--fail-on-advisory=all must exit 3 when PEER_REVIEW_RISK items remain");
  });

  it("clean pipeline → exit 0, no loud advisory line", () => {
    const cwd = track(makeTargetProject());
    seedAllPass(cwd);
    const r = runCLI(["run", "--cwd", cwd, "--json"]);
    assert.equal(r.status, 0, "clean pipeline must exit 0");
    const json = JSON.parse(r.stdout);
    assert.equal(json.advisory_blockers_count || 0, 0, "advisory_blockers_count must be 0 for a clean pipeline");
    assert.ok(!r.stderr.includes("advisory blocker"), "no loud advisory line for a clean pipeline");
  });
});

// ─── ADR-006 Phase 11.3: track provenance + confidence guard ──────────────────

describe("driver: track provenance — resolveTrack + run-start event (ADR-006)", () => {
  it("no pipeline/track.json → falls through to config default_track", async () => {
    const cwd = track(makeTargetProject());
    // No track.json; config has default_track: full. Pipeline-complete immediately.
    const s = await run({
      cwd,
      next: () => ({ action: "pipeline-complete", reason: "done" }),
    });
    assert.equal(s.completed, true);
    // run-log must contain a run-start event with source: config or default
    const log = fs.readFileSync(path.join(cwd, "pipeline", "run-log.jsonl"), "utf8");
    const events = log.trim().split("\n").map((l) => JSON.parse(l));
    const runStart = events.find((e) => e.outcome === "run-start");
    assert.ok(runStart, "run-start event must be present in run-log.jsonl");
    assert.ok(runStart.track_source !== "inferred", "source must not be inferred when no track.json");
  });

  it("pipeline/track.json present → driver picks up track and source", async () => {
    const cwd = track(makeTargetProject());
    fs.mkdirSync(path.join(cwd, "pipeline"), { recursive: true });
    fs.writeFileSync(
      path.join(cwd, "pipeline", "track.json"),
      JSON.stringify({ track: "quick", source: "inferred", confidence: "high" }),
    );
    const s = await run({
      cwd,
      next: () => ({ action: "pipeline-complete", reason: "done" }),
    });
    assert.equal(s.completed, true);
    const log = fs.readFileSync(path.join(cwd, "pipeline", "run-log.jsonl"), "utf8");
    const events = log.trim().split("\n").map((l) => JSON.parse(l));
    const runStart = events.find((e) => e.outcome === "run-start");
    assert.ok(runStart, "run-start event must be present");
    assert.equal(runStart.track_source, "inferred");
    assert.equal(runStart.track_confidence, "high");
  });
});

describe("driver: checkTrackConfidence guard (ADR-006 §3/4)", () => {
  it("require_confirmed_track off (default) → inferred/medium proceeds with warn (no halt)", async () => {
    const cwd = track(makeTargetProject());
    fs.mkdirSync(path.join(cwd, "pipeline"), { recursive: true });
    fs.writeFileSync(
      path.join(cwd, "pipeline", "track.json"),
      JSON.stringify({ track: "quick", source: "inferred", confidence: "medium" }),
    );
    const events = [];
    const s = await run({
      cwd,
      next: () => ({ action: "pipeline-complete", reason: "done" }),
      onEvent: (ev) => events.push(ev),
    });
    assert.equal(s.completed, true, "must not halt when flag is off");
    assert.ok(!s.halted, "must not be halted");
    const checkEv = events.find((e) => e.type === "track-confidence-check");
    assert.ok(checkEv, "track-confidence-check event must be emitted");
    assert.equal(checkEv.warned, true, "must warn, not halt");
  });

  it("require_confirmed_track on + inferred/medium → unconfirmed-track halt (no prompt)", async () => {
    const cwd = track(makeTargetProject({
      config: "routing:\n  default_host: generic\npipeline:\n  default_track: full\nautonomy:\n  require_confirmed_track: true\n",
    }));
    fs.mkdirSync(path.join(cwd, "pipeline"), { recursive: true });
    fs.writeFileSync(
      path.join(cwd, "pipeline", "track.json"),
      JSON.stringify({ track: "quick", source: "inferred", confidence: "medium" }),
    );
    const s = await run({
      cwd,
      next: () => { throw new Error("next() must not be called — should halt before the loop"); },
    });
    assert.equal(s.halted, true, "must halt");
    assert.equal(s.halt_action, "unconfirmed-track");
    assert.equal(s.halt_failure_class, "unconfirmed-track");
    assert.match(s.halt_reason, /inferred at medium confidence/);
    assert.match(s.halt_reason, /--track/);
  });

  it("require_confirmed_track on + inferred/low → unconfirmed-track halt", async () => {
    const cwd = track(makeTargetProject({
      config: "routing:\n  default_host: generic\npipeline:\n  default_track: full\nautonomy:\n  require_confirmed_track: true\n",
    }));
    fs.mkdirSync(path.join(cwd, "pipeline"), { recursive: true });
    fs.writeFileSync(
      path.join(cwd, "pipeline", "track.json"),
      JSON.stringify({ track: "full", source: "inferred", confidence: "low" }),
    );
    const s = await run({ cwd });
    assert.equal(s.halt_action, "unconfirmed-track");
  });

  it("require_confirmed_track on + inferred/high → proceeds (high is CI-safe bar)", async () => {
    const cwd = track(makeTargetProject({
      config: "routing:\n  default_host: generic\npipeline:\n  default_track: full\nautonomy:\n  require_confirmed_track: true\n",
    }));
    fs.mkdirSync(path.join(cwd, "pipeline"), { recursive: true });
    fs.writeFileSync(
      path.join(cwd, "pipeline", "track.json"),
      JSON.stringify({ track: "quick", source: "inferred", confidence: "high" }),
    );
    const s = await run({
      cwd,
      next: () => ({ action: "pipeline-complete", reason: "done" }),
    });
    assert.equal(s.completed, true, "high-confidence inferred must proceed even with flag on");
    assert.ok(!s.halted);
  });

  it("require_confirmed_track on + human source → proceeds silently (no halt, no warn)", async () => {
    const cwd = track(makeTargetProject({
      config: "routing:\n  default_host: generic\npipeline:\n  default_track: full\nautonomy:\n  require_confirmed_track: true\n",
    }));
    fs.mkdirSync(path.join(cwd, "pipeline"), { recursive: true });
    fs.writeFileSync(
      path.join(cwd, "pipeline", "track.json"),
      JSON.stringify({ track: "quick", source: "human", confidence: "medium" }),
    );
    const events = [];
    const s = await run({
      cwd,
      next: () => ({ action: "pipeline-complete", reason: "done" }),
      onEvent: (ev) => events.push(ev),
    });
    assert.equal(s.completed, true, "human source must always proceed");
    const checkEv = events.find((e) => e.type === "track-confidence-check");
    assert.ok(!checkEv, "no track-confidence-check event for human source");
  });

  it("require_confirmed_track on + --force → bypasses unconfirmed-track halt", async () => {
    const cwd = track(makeTargetProject({
      config: "routing:\n  default_host: generic\npipeline:\n  default_track: full\nautonomy:\n  require_confirmed_track: true\n",
    }));
    fs.mkdirSync(path.join(cwd, "pipeline"), { recursive: true });
    fs.writeFileSync(
      path.join(cwd, "pipeline", "track.json"),
      JSON.stringify({ track: "quick", source: "inferred", confidence: "medium" }),
    );
    const s = await run({
      cwd,
      force: true,
      next: () => ({ action: "pipeline-complete", reason: "done" }),
    });
    assert.equal(s.completed, true, "--force must bypass the unconfirmed-track halt");
    assert.ok(!s.halted);
  });

  it("run-start event carries track_source + track_confidence", async () => {
    const cwd = track(makeTargetProject());
    fs.mkdirSync(path.join(cwd, "pipeline"), { recursive: true });
    fs.writeFileSync(
      path.join(cwd, "pipeline", "track.json"),
      JSON.stringify({ track: "hotfix", source: "human", confidence: null }),
    );
    await run({
      cwd,
      next: () => ({ action: "pipeline-complete", reason: "done" }),
    });
    const log = fs.readFileSync(path.join(cwd, "pipeline", "run-log.jsonl"), "utf8");
    const events = log.trim().split("\n").map((l) => JSON.parse(l));
    const runStart = events.find((e) => e.outcome === "run-start");
    assert.ok(runStart, "run-start event must appear in run-log.jsonl");
    assert.equal(runStart.track_source, "human");
    assert.ok("track_confidence" in runStart, "track_confidence field must be present");
  });
});
