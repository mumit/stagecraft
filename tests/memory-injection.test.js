// Phase 30 item 30.4 — memory retrieval into stage prompts + auto-ingest at
// pipeline-complete. Uses DEVTEAM_EMBEDDING_PROVIDER=stub (see tests/
// memory.test.js) so the real transformers.js model isn't loaded here.

process.env.DEVTEAM_EMBEDDING_PROVIDER = "stub";

const { describe, it, afterEach } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { REPO_ROOT, makeTargetProject, seedGate, cleanup } = require("./_helpers");
const { priorKnowledgeForStage, MAX_BYTES } = require(path.join(REPO_ROOT, "core", "memory", "inject"));
const { renderPriorKnowledge } = require(path.join(REPO_ROOT, "core", "adapters", "render-helpers"));
const { buildDescriptor, runStage, runStageHeadless } = require(path.join(REPO_ROOT, "core", "orchestrator"));
const { getStage } = require(path.join(REPO_ROOT, "core", "pipeline", "stages"));
const { getEmbedder, resetCache } = require(path.join(REPO_ROOT, "core", "memory", "embed"));
const { JSONMemoryStore, makeRecord } = require(path.join(REPO_ROOT, "core", "memory", "store"));
const { run } = require(path.join(REPO_ROOT, "core", "driver"));

let _dirs = [];
function track(cwd) { _dirs.push(cwd); return cwd; }
afterEach(() => { _dirs.forEach(cleanup); _dirs = []; resetCache(); });

function seedMemoryDir(cwd) {
  fs.mkdirSync(path.join(cwd, ".devteam", "memory"), { recursive: true });
}

const HEADLESS_CONFIG = "routing:\n  default_host: claude-code\npipeline:\n  default_track: full\n";
const GENERIC_CONFIG = "routing:\n  default_host: generic\npipeline:\n  default_track: full\n";

// ---------------------------------------------------------------------------
// core/memory/inject.js — priorKnowledgeForStage() unit tests (queryFn seam
// gives full control over similarity scores so budget/order/floor behavior
// is deterministic, independent of the stub embedder's hash-based vectors).
// ---------------------------------------------------------------------------

describe("memory/inject: priorKnowledgeForStage — gating", () => {
  it("issues no query when queryText is blank", async () => {
    const cwd = track(makeTargetProject());
    seedMemoryDir(cwd);
    let called = false;
    const r = await priorKnowledgeForStage({
      cwd, config: { memory: { inject: true } }, queryText: "   ",
      queryFn: async () => { called = true; return []; },
    });
    assert.deepEqual(r, { priorKnowledge: [], warning: null });
    assert.equal(called, false);
  });

  it("issues no query when .devteam/memory/ doesn't exist (byte-identical-to-today path)", async () => {
    const cwd = track(makeTargetProject());
    let called = false;
    const r = await priorKnowledgeForStage({
      cwd, config: { memory: { inject: true } }, queryText: "add sms opt-in",
      queryFn: async () => { called = true; return []; },
    });
    assert.deepEqual(r, { priorKnowledge: [], warning: null });
    assert.equal(called, false);
  });

  it("issues no query when memory.inject is false, even with a store present", async () => {
    const cwd = track(makeTargetProject());
    seedMemoryDir(cwd);
    let called = false;
    const r = await priorKnowledgeForStage({
      cwd, config: { memory: { inject: false } }, queryText: "add sms opt-in",
      queryFn: async () => { called = true; return []; },
    });
    assert.deepEqual(r, { priorKnowledge: [], warning: null });
    assert.equal(called, false);
  });
});

describe("memory/inject: priorKnowledgeForStage — filtering, attribution, budget", () => {
  it("filters results below the configured similarity floor and attributes kind+source", async () => {
    const cwd = track(makeTargetProject());
    seedMemoryDir(cwd);
    const r = await priorKnowledgeForStage({
      cwd,
      config: { memory: { inject_similarity_floor: 0.5 } },
      queryText: "sms opt-in",
      queryFn: async () => [
        { kind: "brief", source: "pipeline/brief.md", text: "high match", similarity: 0.9, id: "a" },
        { kind: "adr", source: "pipeline/adr/1.md", text: "low match", similarity: 0.1, id: "b" },
      ],
    });
    assert.equal(r.warning, null);
    assert.equal(r.priorKnowledge.length, 1);
    assert.deepEqual(r.priorKnowledge[0], { kind: "brief", source: "pipeline/brief.md", text: "high match" });
  });

  it("budgets to <= MAX_BYTES total, favors highest similarity, and truncation order is deterministic", async () => {
    const cwd = track(makeTargetProject());
    seedMemoryDir(cwd);
    const big = "x".repeat(280);
    const entries = [
      { kind: "brief", source: "a.md", text: big, similarity: 0.9, id: "a" },
      { kind: "brief", source: "b.md", text: big, similarity: 0.8, id: "b" },
      { kind: "brief", source: "c.md", text: big, similarity: 0.7, id: "c" },
      { kind: "brief", source: "d.md", text: big, similarity: 0.6, id: "d" },
      { kind: "brief", source: "e.md", text: big, similarity: 0.5, id: "e" },
    ];
    const runOnce = () => priorKnowledgeForStage({
      cwd, config: { memory: {} }, queryText: "topic", topK: 5, floor: 0,
      queryFn: async () => entries,
    });
    const r1 = await runOnce();
    const r2 = await runOnce();
    const totalBytes = r1.priorKnowledge.reduce((s, e) => s + Buffer.byteLength(e.text, "utf8"), 0);
    assert.ok(totalBytes <= MAX_BYTES, `expected <= ${MAX_BYTES} bytes, got ${totalBytes}`);
    assert.ok(r1.priorKnowledge.length < entries.length, "expected at least one entry dropped by the byte budget");
    assert.deepEqual(r1.priorKnowledge, r2.priorKnowledge, "truncation order must be deterministic across identical calls");
    assert.equal(r1.priorKnowledge[0].source, "a.md", "highest-similarity entry must survive budgeting first");
  });

  it("stage-02 additionally queries the org store; other stages don't", async () => {
    const cwd = track(makeTargetProject());
    seedMemoryDir(cwd);
    let orgCalled = false;
    const r = await priorKnowledgeForStage({
      cwd, config: { memory: {} }, stageDef: getStage("design"), queryText: "topic",
      queryFn: async () => [],
      queryOrgFn: async () => { orgCalled = true; return [{ kind: "adr", source: "x", text: "y", similarity: 1, id: "z" }]; },
    });
    assert.equal(orgCalled, true);
    assert.equal(r.priorKnowledge.length, 1);
    assert.equal(r.priorKnowledge[0].kind, "adr");

    orgCalled = false;
    const r2 = await priorKnowledgeForStage({
      cwd, config: { memory: {} }, stageDef: getStage("requirements"), queryText: "topic",
      queryFn: async () => [], queryOrgFn: async () => { orgCalled = true; return []; },
    });
    assert.equal(orgCalled, false);
    assert.deepEqual(r2.priorKnowledge, []);
  });

  it("degrades to exactly one warning and an empty result when the query rejects (optional embedder dep absent)", async () => {
    const cwd = track(makeTargetProject());
    seedMemoryDir(cwd);
    const r = await priorKnowledgeForStage({
      cwd, config: { memory: {} }, queryText: "topic",
      queryFn: async () => { throw new Error("devteam memory's local embeddings need the optional dependency"); },
    });
    assert.deepEqual(r.priorKnowledge, []);
    assert.match(r.warning, /optional dependency/);
  });
});

// ---------------------------------------------------------------------------
// render-helpers.js — renderPriorKnowledge() mirrors renderKnownPatterns()
// ---------------------------------------------------------------------------

describe("render-helpers: renderPriorKnowledge", () => {
  it("renders nothing when priorKnowledge is empty or absent", () => {
    const lines = ["existing line"];
    renderPriorKnowledge(lines, {});
    assert.deepEqual(lines, ["existing line"]);
    renderPriorKnowledge(lines, { priorKnowledge: [] });
    assert.deepEqual(lines, ["existing line"]);
  });

  it("renders a heading and one attributed bullet per entry", () => {
    const lines = [];
    renderPriorKnowledge(lines, {
      priorKnowledge: [
        { kind: "adr", source: "pipeline/adr/001.md", text: "Use cursor pagination." },
        { kind: "brief", source: "pipeline/brief.md", text: "Users want SMS opt-in." },
      ],
    });
    const out = lines.join("\n");
    assert.match(out, /## Prior Project Knowledge/);
    assert.match(out, /- \[adr\] Use cursor pagination\. \(source: pipeline\/adr\/001\.md\)/);
    assert.match(out, /- \[brief\] Users want SMS opt-in\. \(source: pipeline\/brief\.md\)/);
  });
});

// ---------------------------------------------------------------------------
// buildDescriptor()/runStage() threading
// ---------------------------------------------------------------------------

describe("orchestrator: buildDescriptor priorKnowledge field", () => {
  it("defaults to an empty array when opts.priorKnowledge is absent", () => {
    const d = buildDescriptor(getStage("requirements"), "pm");
    assert.deepEqual(d.priorKnowledge, []);
  });

  it("attaches opts.priorKnowledge verbatim", () => {
    const pk = [{ kind: "brief", source: "x.md", text: "hello" }];
    const d = buildDescriptor(getStage("requirements"), "pm", { priorKnowledge: pk });
    assert.deepEqual(d.priorKnowledge, pk);
  });
});

describe("orchestrator: runStage renders priorKnowledge into every workstream's prompt", () => {
  it("prompt is byte-identical to today when priorKnowledge is absent", () => {
    const cwd = track(makeTargetProject({ config: GENERIC_CONFIG }));
    const plan1 = runStage("requirements", { cwd });
    const plan2 = runStage("requirements", { cwd });
    assert.equal(plan1.workstreams[0].prompt, plan2.workstreams[0].prompt);
    assert.doesNotMatch(plan1.workstreams[0].prompt, /Prior Project Knowledge/);
  });

  it("renders the section, within budget, on every workstream of a multi-role stage", () => {
    const cwd = track(makeTargetProject({ config: GENERIC_CONFIG }));
    const pk = [{ kind: "brief", source: "pipeline/brief.md", text: "Prior notes about SMS opt-in." }];
    const plan = runStage("build", { cwd, priorKnowledge: pk });
    assert.ok(plan.workstreams.length > 1, "build is a multi-role stage");
    for (const ws of plan.workstreams) {
      assert.match(ws.prompt, /## Prior Project Knowledge/);
      assert.match(ws.prompt, /\[brief\] Prior notes about SMS opt-in\. \(source: pipeline\/brief\.md\)/);
    }
  });
});

// ---------------------------------------------------------------------------
// runStageHeadless() wiring — end-to-end through a real store + the real
// query()/queryOrg() (embeddings hand-seeded for determinism: the query
// vector and the stored vector are made identical, guaranteeing similarity
// 1.0 regardless of the stub embedder's hash semantics — same technique
// tests/memory.test.js's "JSONMemoryStore" describe block uses for direct
// low-level record control).
// ---------------------------------------------------------------------------

describe("orchestrator: runStageHeadless resolves priorKnowledge via core/memory/inject.js", () => {
  it("attaches a seeded project-store record with correct attribution", async () => {
    const cwd = track(makeTargetProject({ config: HEADLESS_CONFIG }));
    const feature = "Add SMS opt-in for time-sensitive login alerts";
    const embedder = await getEmbedder();
    const vec = await embedder.embed(feature);
    const store = new JSONMemoryStore({ cwd });
    store.saveMeta({ schemaVersion: 1, embedder: { modelId: embedder.modelId, dim: embedder.dimensions } });
    const rec = makeRecord({
      source: "pipeline/brief.md", kind: "brief", title: "Brief — SMS opt-in",
      heading: "1. Problem", text: "Users want SMS for time-sensitive events.",
      embedding: vec, embedderInfo: embedder,
    });
    store.upsertDoc("pipeline/brief.md", "brief", [rec]);

    // --skip-completed avoids a real headless CLI spawn entirely.
    seedGate(cwd, "stage-01", { stage: "stage-01", workstream: "pm", status: "PASS" });
    const result = await runStageHeadless("requirements", { cwd, feature, skipCompleted: true });

    assert.equal(result.results.length, 1);
    const pk = result.results[0].descriptor.priorKnowledge;
    assert.equal(pk.length, 1);
    assert.equal(pk[0].kind, "brief");
    assert.equal(pk[0].source, "pipeline/brief.md");
    assert.match(pk[0].text, /SMS/);
  });

  it("stays empty when no store exists — byte-identical to today", async () => {
    const cwd = track(makeTargetProject({ config: HEADLESS_CONFIG }));
    seedGate(cwd, "stage-01", { stage: "stage-01", workstream: "pm", status: "PASS" });
    const result = await runStageHeadless("requirements", { cwd, feature: "add login", skipCompleted: true });
    assert.deepEqual(result.results[0].descriptor.priorKnowledge, []);
  });

  it("stage-02 (design) additionally surfaces an org-store ADR — automatic architecture lookup", async () => {
    const cwd = track(makeTargetProject({ config: HEADLESS_CONFIG }));
    seedMemoryDir(cwd); // project store must exist for retrieval to run at all
    const orgDir = fs.mkdtempSync(path.join(os.tmpdir(), "stagecraft-org-"));
    const prevOrgDir = process.env.STAGECRAFT_ORG_MEMORY_DIR;
    process.env.STAGECRAFT_ORG_MEMORY_DIR = orgDir;
    delete require.cache[require.resolve(path.join(REPO_ROOT, "core", "memory"))];
    const mem = require(path.join(REPO_ROOT, "core", "memory"));
    try {
      const feature = "pagination style for list endpoints";
      const embedder = await getEmbedder();
      const vec = await embedder.embed(feature);
      const orgStore = mem.newOrgStore();
      const rec = makeRecord({
        source: "other-project#pipeline/adr/001.md", kind: "adr", title: "ADR — pagination",
        heading: "Decision", text: "Use cursor pagination.", embedding: vec, embedderInfo: embedder,
      });
      orgStore.upsertDoc(rec.source, "adr", [rec]);

      seedGate(cwd, "stage-02", { stage: "stage-02", workstream: "principal", status: "PASS" });
      const result = await runStageHeadless("design", { cwd, feature, skipCompleted: true });
      const pk = result.results[0].descriptor.priorKnowledge;
      assert.ok(pk.some((e) => e.kind === "adr" && e.source.includes("adr/001.md")),
        `expected an org ADR entry, got ${JSON.stringify(pk)}`);
    } finally {
      fs.rmSync(orgDir, { recursive: true, force: true });
      if (prevOrgDir === undefined) delete process.env.STAGECRAFT_ORG_MEMORY_DIR;
      else process.env.STAGECRAFT_ORG_MEMORY_DIR = prevOrgDir;
      delete require.cache[require.resolve(path.join(REPO_ROOT, "core", "memory"))];
    }
  });
});

// ---------------------------------------------------------------------------
// core/driver.js — auto-ingest at pipeline-complete
// ---------------------------------------------------------------------------

function readRunLogOutcomes(cwd) {
  const p = path.join(cwd, "pipeline", "run-log.jsonl");
  if (!fs.existsSync(p)) return [];
  return fs.readFileSync(p, "utf8").trim().split("\n").filter(Boolean).map((line) => JSON.parse(line).outcome);
}

function completeRunOpts(cwd, overrides = {}) {
  return {
    cwd,
    budgetUsd: 10,
    next: () => ({ action: "pipeline-complete", reason: "done" }),
    stallProbe: () => () => {},
    ...overrides,
  };
}

describe("driver: auto-ingest at pipeline-complete (30.4 write side)", () => {
  it("does not ingest when .devteam/memory/ doesn't exist", async () => {
    const cwd = track(makeTargetProject());
    let called = false;
    const summary = await run(completeRunOpts(cwd, { ingestMemory: async () => { called = true; return { artifacts: 0, chunks: 0 }; } }));
    assert.equal(summary.completed, true);
    assert.equal(called, false);
    assert.ok(!readRunLogOutcomes(cwd).includes("memory-ingest"));
  });

  it("ingests once when .devteam/memory/ already exists", async () => {
    const cwd = track(makeTargetProject());
    seedMemoryDir(cwd);
    let calledWith = null;
    const summary = await run(completeRunOpts(cwd, {
      ingestMemory: async (opts) => { calledWith = opts; return { artifacts: 2, chunks: 5 }; },
    }));
    assert.equal(summary.completed, true);
    assert.deepEqual(calledWith, { cwd });
    assert.ok(readRunLogOutcomes(cwd).includes("memory-ingest"));
  });

  it("does not ingest when memory.inject: false, even with a store present", async () => {
    const cwd = track(makeTargetProject({
      config: "routing:\n  default_host: generic\npipeline:\n  default_track: full\nmemory:\n  inject: false\n",
    }));
    seedMemoryDir(cwd);
    let called = false;
    const summary = await run(completeRunOpts(cwd, { ingestMemory: async () => { called = true; return { artifacts: 0, chunks: 0 }; } }));
    assert.equal(summary.completed, true);
    assert.equal(called, false);
  });

  it("an ingest failure is logged, never thrown, and never fails the run", async () => {
    const cwd = track(makeTargetProject());
    seedMemoryDir(cwd);
    const summary = await run(completeRunOpts(cwd, {
      ingestMemory: async () => { throw new Error("@huggingface/transformers not installed"); },
    }));
    assert.equal(summary.completed, true);
    assert.ok(readRunLogOutcomes(cwd).includes("memory-ingest-failed"));
  });
});
