// core/driver-runend.js — the run-end side-effect phase extracted from run().
//
// Characterization tests pinning the seam: the four passes are fire-and-forget,
// their firing conditions differ, and none of them may affect the run summary.
// These exist so the next decomposition slice has something to break.

const { describe, it } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const REPO_ROOT = path.resolve(__dirname, "..");
const { runEndEffects } = require(path.join(REPO_ROOT, "core", "driver-runend"));

function harness(overrides = {}) {
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "devteam-test-runend-"));
  const events = [];
  const calls = { patterns: 0, reflector: 0, memory: 0 };
  const ctx = {
    cwd,
    changeId: null,
    summary: { completed: true, halted: false },
    config: { learning: { reflector: false }, memory: { inject: true }, evals: { capture: false } },
    gateOnDisk: true,
    logEvent: (entry) => events.push(entry),
    pipelineRoot: path.join(cwd, "pipeline"),
    collectPatterns: () => { calls.patterns += 1; },
    runReflector: async () => { calls.reflector += 1; },
    ingestMemory: async () => { calls.memory += 1; return { artifacts: 2, chunks: 7 }; },
    ...overrides,
  };
  return { ctx, events, calls, cleanup: () => fs.rmSync(cwd, { recursive: true, force: true }) };
}

const outcomes = (events) => events.map((e) => e.outcome);

describe("driver-runend: pattern auto-collection", () => {
  it("runs on a clean completion", async () => {
    const h = harness();
    try {
      await runEndEffects(h.ctx);
      assert.equal(h.calls.patterns, 1);
    } finally { h.cleanup(); }
  });

  it("runs on a halt that left a gate behind", async () => {
    const h = harness({ summary: { completed: false, halted: true }, gateOnDisk: true });
    try {
      await runEndEffects(h.ctx);
      assert.equal(h.calls.patterns, 1);
    } finally { h.cleanup(); }
  });

  it("does not run on a halt that never wrote a gate", async () => {
    // e.g. --repair/--feature mutual exclusion, or a pre-flight stoplist match:
    // there is nothing to collect from.
    const h = harness({ summary: { completed: false, halted: true }, gateOnDisk: false });
    try {
      await runEndEffects(h.ctx);
      assert.equal(h.calls.patterns, 0);
    } finally { h.cleanup(); }
  });

  it("logs and swallows a collection failure", async () => {
    const h = harness({ collectPatterns: () => { throw new Error("boom"); } });
    try {
      await runEndEffects(h.ctx);
      assert.deepEqual(outcomes(h.events), ["pattern-collect-failed"]);
    } finally { h.cleanup(); }
  });
});

describe("driver-runend: reflector", () => {
  it("stays off unless learning.reflector is exactly true", async () => {
    for (const reflector of [false, undefined, "true", 1]) {
      const h = harness({ config: { learning: { reflector }, memory: { inject: false }, evals: { capture: false } } });
      try {
        await runEndEffects(h.ctx);
        assert.equal(h.calls.reflector, 0, `reflector ran for ${JSON.stringify(reflector)}`);
      } finally { h.cleanup(); }
    }
  });

  it("never runs on a halt, even when enabled — halted evidence is incomplete", async () => {
    const h = harness({
      summary: { completed: false, halted: true },
      config: { learning: { reflector: true }, memory: { inject: false }, evals: { capture: false } },
    });
    try {
      await runEndEffects(h.ctx);
      assert.equal(h.calls.reflector, 0);
    } finally { h.cleanup(); }
  });

  it("logs and swallows a dispatch failure", async () => {
    const h = harness({
      config: { learning: { reflector: true }, memory: { inject: false }, evals: { capture: false } },
      runReflector: async () => { throw new Error("host down"); },
    });
    try {
      await runEndEffects(h.ctx);
      assert.ok(outcomes(h.events).includes("reflector-dispatch-failed"));
    } finally { h.cleanup(); }
  });
});

describe("driver-runend: memory auto-ingest", () => {
  it("requires an existing .devteam/memory — never opts a project in", async () => {
    const h = harness();
    try {
      await runEndEffects(h.ctx);
      assert.equal(h.calls.memory, 0, "a project that never ingested must see no embedder load");
    } finally { h.cleanup(); }
  });

  it("runs once the project has opted in, and reports what it indexed", async () => {
    const h = harness();
    try {
      fs.mkdirSync(path.join(h.ctx.cwd, ".devteam", "memory"), { recursive: true });
      await runEndEffects(h.ctx);
      assert.equal(h.calls.memory, 1);
      const ingest = h.events.find((e) => e.outcome === "memory-ingest");
      assert.deepEqual({ artifacts: ingest.artifacts, chunks: ingest.chunks }, { artifacts: 2, chunks: 7 });
    } finally { h.cleanup(); }
  });

  it("memory.inject false is the single off switch for both sides of the loop", async () => {
    const h = harness({ config: { learning: { reflector: false }, memory: { inject: false }, evals: { capture: false } } });
    try {
      fs.mkdirSync(path.join(h.ctx.cwd, ".devteam", "memory"), { recursive: true });
      await runEndEffects(h.ctx);
      assert.equal(h.calls.memory, 0);
    } finally { h.cleanup(); }
  });

  it("logs and swallows an ingest failure", async () => {
    const h = harness({ ingestMemory: async () => { throw new Error("no embedder"); } });
    try {
      fs.mkdirSync(path.join(h.ctx.cwd, ".devteam", "memory"), { recursive: true });
      await runEndEffects(h.ctx);
      assert.ok(outcomes(h.events).includes("memory-ingest-failed"));
    } finally { h.cleanup(); }
  });
});

describe("driver-runend: the phase never affects the run's outcome", () => {
  it("leaves summary untouched even when every pass throws", async () => {
    const h = harness({
      config: { learning: { reflector: true }, memory: { inject: true }, evals: { capture: false } },
      collectPatterns: () => { throw new Error("a"); },
      runReflector: async () => { throw new Error("b"); },
      ingestMemory: async () => { throw new Error("c"); },
    });
    try {
      fs.mkdirSync(path.join(h.ctx.cwd, ".devteam", "memory"), { recursive: true });
      const before = JSON.stringify(h.ctx.summary);
      await runEndEffects(h.ctx);
      assert.equal(JSON.stringify(h.ctx.summary), before, "summary is decided before this phase runs");
      assert.deepEqual(outcomes(h.events).sort(),
        ["memory-ingest-failed", "pattern-collect-failed", "reflector-dispatch-failed"]);
    } finally { h.cleanup(); }
  });

  it("resolves rather than rejecting when a pass throws", async () => {
    const h = harness({ collectPatterns: () => { throw new Error("boom"); } });
    try {
      await assert.doesNotReject(() => runEndEffects(h.ctx));
    } finally { h.cleanup(); }
  });
});
