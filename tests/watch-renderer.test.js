"use strict";

const { describe, it, afterEach } = require("node:test");
const assert = require("node:assert/strict");
const { createWatchRenderer, duration, growthRate } = require("../core/cli/watch-renderer");
const { makeTargetProject, cleanup, runCLI } = require("./_helpers");

let dirs = [];
afterEach(() => { dirs.forEach(cleanup); dirs = []; });

function fakeStream(isTTY) {
  return {
    isTTY,
    output: "",
    write(value) { this.output += value; },
  };
}

describe("run --watch renderer", () => {
  it("renders rolling dispatch liveness and restores the cursor", () => {
    let current = 1000;
    let tick = null;
    let cleared = false;
    const stream = fakeStream(true);
    const watch = createWatchRenderer({
      stream,
      now: () => current,
      setInterval: (fn) => { tick = fn; return 7; },
      clearInterval: (id) => { assert.equal(id, 7); cleared = true; },
    });

    watch.start();
    watch.handle({ type: "heartbeat", stage: "requirements" });
    watch.handle({ type: "dispatch", name: "build", stage: "stage-04" });
    watch.handle({
      type: "workstream-started",
      name: "build",
      stage: "stage-04",
      role: "backend",
      host: "codex",
      workstream_id: "stage-04.backend",
      log_path: "pipeline/logs/stage-04.backend.log",
      gate_path: "pipeline/gates/stage-04.backend.json",
    });
    current = 62000;
    watch.handle({
      type: "dispatch-progress",
      stage: "build",
      interval_ms: 60000,
      log_growth_bytes_last_interval: 1024,
    });
    watch.handle({
      type: "workstream-finished",
      name: "build",
      stage: "stage-04",
      role: "backend",
      host: "codex",
      workstream_id: "stage-04.backend",
      exit_code: 0,
      duration_ms: 61000,
      log_path: "pipeline/logs/stage-04.backend.log",
      gate_path: "pipeline/gates/stage-04.backend.json",
    });
    tick();
    watch.handle({ type: "stall-detected", interval_ms: 60000, log_growth_bytes_last_interval: 0 });
    watch.finish();

    assert.equal(stream.output.includes("\x1b[?25l"), true, "hides the cursor while redrawing");
    assert.match(stream.output, /stage:\s+build/);
    assert.match(stream.output, /dispatch elapsed:\s+1m 1s/);
    assert.match(stream.output, /active:\s+backend@codex/);
    assert.match(stream.output, /last workstream:\s+backend@codex exit 0 1m 1s/);
    assert.match(stream.output, /transcript:\s+pipeline\/logs\/stage-04.backend.log/);
    assert.match(stream.output, /gate:\s+pipeline\/gates\/stage-04.backend.json/);
    assert.match(stream.output, /log growth:\s+1024 B\/min/);
    assert.match(stream.output, /heartbeat age:\s+1m 1s/);
    assert.match(stream.output, /stall detected:\s+yes/);
    assert.equal(stream.output.endsWith("\x1b[?25h"), true, "restores the cursor on completion");
    assert.equal(cleared, true);
  });

  it("is inactive and writes no ANSI output for non-TTY streams", () => {
    const stream = fakeStream(false);
    const watch = createWatchRenderer({ stream });
    assert.equal(watch.active, false);
    watch.start();
    watch.handle({ type: "dispatch", stage: "stage-04" });
    watch.finish();
    assert.equal(stream.output, "");
  });

  it("formats durations and growth rates deterministically", () => {
    assert.equal(duration(999), "999ms");
    assert.equal(duration(61000), "1m 1s");
    assert.equal(growthRate(512, 30000), "1024 B/min");
    assert.equal(growthRate(null, 30000), "-");
  });
});

describe("run --watch CLI", () => {
  it("falls back to line progress without ANSI when stderr is redirected", () => {
    const cwd = makeTargetProject();
    dirs.push(cwd);
    const result = runCLI(
      ["run", "--watch", "--budget-usd", "0", "--feature", "watch test"],
      { cwd },
    );
    assert.equal(result.status, 1);
    assert.match(result.stderr, /--watch requires an interactive terminal/);
    assert.equal(result.stderr.includes("\x1b["), false);
  });

  it("rejects --watch with --json", () => {
    const cwd = makeTargetProject();
    dirs.push(cwd);
    const result = runCLI(["run", "--watch", "--json", "--feature", "watch test"], { cwd });
    assert.equal(result.status, 2);
    assert.match(result.stderr, /--watch and --json are mutually exclusive/);
  });
});
