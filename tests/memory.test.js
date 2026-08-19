// Memory tests. Uses DEVTEAM_EMBEDDING_PROVIDER=stub so the real
// transformers.js model isn't loaded in CI — keeps the test suite
// fast and offline. The stub provider returns deterministic
// hash-based vectors; the storage + chunking + ingest + query
// machinery is exercised end-to-end with those.

process.env.DEVTEAM_EMBEDDING_PROVIDER = "stub";

const { describe, it, afterEach, before } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { REPO_ROOT, makeTargetProject, cleanup } = require("./_helpers");
const { chunkByHeading, extractTitle } = require(path.join(REPO_ROOT, "core", "memory", "chunker"));
const { JSONMemoryStore, sha1 } = require(path.join(REPO_ROOT, "core", "memory", "store"));
const memory = require(path.join(REPO_ROOT, "core", "memory"));
const {
  getEmbedder,
  resetCache,
  _setRequireHF,
  BUILTIN_MODEL,
  DEFAULT_DIM,
} = require(path.join(REPO_ROOT, "core", "memory", "embed"));

let _dirs = [];
function track(cwd) { _dirs.push(cwd); return cwd; }
afterEach(() => { _dirs.forEach(cleanup); _dirs = []; resetCache(); });

function writeArtifact(cwd, rel, body) {
  const p = path.join(cwd, rel);
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(p, body, "utf8");
}

const SAMPLE_BRIEF = `# Brief — SMS notification opt-in

## 1. Problem

Users currently get only email notifications. They want SMS for
time-sensitive events like login alerts and payment confirmations.

## 2. User stories

As a user, I can opt into SMS per event type from my account settings.

## 9. Observability requirements

Counter notifications_opt_in_changes_total{channel, event_type, direction}.
Log every opt-in change at INFO. Counter sms_sent_total{event_type, outcome}.
`;

const SAMPLE_DESIGN = `# Design — SMS opt-in service

## Service boundaries

A new NotificationService owns opt-in state in users.notification_preferences.

## Failure modes

If SMS provider is down, fall back to email and log a warning.
`;

// ---------------------------------------------------------------------------
// chunkByHeading
// ---------------------------------------------------------------------------

describe("memory: chunkByHeading", () => {
  it("splits at level-2 headings by default", () => {
    const chunks = chunkByHeading(SAMPLE_BRIEF);
    const headings = chunks.map((c) => c.heading);
    assert.ok(headings.includes("1. Problem"));
    assert.ok(headings.includes("9. Observability requirements"));
  });

  it("drops chunks shorter than minChars", () => {
    const text = "## A\nx\n## B\n" + "y".repeat(100);
    const chunks = chunkByHeading(text);
    assert.equal(chunks.length, 1);
    assert.equal(chunks[0].heading, "B");
  });

  it("handles documents with no headings as a single (preamble)", () => {
    const chunks = chunkByHeading("just some prose, no headings, " + "x".repeat(50));
    assert.equal(chunks.length, 1);
    assert.equal(chunks[0].heading, "(preamble)");
  });

  it("empty input → empty array", () => {
    assert.deepEqual(chunkByHeading(""), []);
    assert.deepEqual(chunkByHeading(null), []);
  });
});

describe("memory: extractTitle", () => {
  it("finds the first H1", () => {
    assert.equal(extractTitle("# Hello\n\n## World"), "Hello");
  });
  it("falls back when no H1", () => {
    assert.equal(extractTitle("no title here", "fallback"), "fallback");
  });
});

// ---------------------------------------------------------------------------
// Embedder (stub)
// ---------------------------------------------------------------------------

describe("memory: stub embedder", () => {
  it("defaults to dependency-free lexical retrieval", async () => {
    const before = process.env.DEVTEAM_EMBEDDING_PROVIDER;
    try {
      delete process.env.DEVTEAM_EMBEDDING_PROVIDER;
      resetCache();
      const e = await getEmbedder({ fresh: true });
      const related = await e.embed("cursor pagination for API results");
      const query = await e.embed("API pagination cursor");
      const unrelated = await e.embed("watercolor landscape painting");
      const dot = (a, b) => a.reduce((sum, value, i) => sum + value * b[i], 0);

      assert.equal(e.provider, "builtin");
      assert.equal(e.modelId, BUILTIN_MODEL);
      assert.equal(e.dimensions, DEFAULT_DIM);
      assert.ok(dot(related, query) > dot(related, unrelated));
    } finally {
      process.env.DEVTEAM_EMBEDDING_PROVIDER = before;
      resetCache();
    }
  });

  it("returns L2-normalized vectors of fixed dimension", async () => {
    const e = await getEmbedder();
    const v = await e.embed("hello world");
    assert.equal(v.length, e.dimensions);
    let n = 0;
    for (const x of v) n += x * x;
    assert.ok(Math.abs(n - 1) < 1e-6, `expected unit norm, got ${n}`);
  });

  it("is deterministic — same input → same vector", async () => {
    const e = await getEmbedder();
    const v1 = await e.embed("hello");
    const v2 = await e.embed("hello");
    assert.deepEqual(Array.from(v1), Array.from(v2));
  });

  it("embedBatch returns one vector per input", async () => {
    const e = await getEmbedder();
    const vs = await e.embedBatch(["a", "b", "c"]);
    assert.equal(vs.length, 3);
    assert.ok(vs.every((v) => v.length === e.dimensions));
  });

  it("rejects an unknown provider with an actionable error", () => {
    const before = process.env.DEVTEAM_EMBEDDING_PROVIDER;
    process.env.DEVTEAM_EMBEDDING_PROVIDER = "fakeprovider";
    resetCache();
    return getEmbedder().then(
      () => assert.fail("should have thrown"),
      (err) => {
        assert.match(err.message, /Unknown DEVTEAM_EMBEDDING_PROVIDER/);
        process.env.DEVTEAM_EMBEDDING_PROVIDER = before;
        resetCache();
      },
    );
  });

  it("names supported providers when a known remote provider is unavailable", async () => {
    const before = process.env.DEVTEAM_EMBEDDING_PROVIDER;
    try {
      for (const provider of ["openai", "cohere"]) {
        process.env.DEVTEAM_EMBEDDING_PROVIDER = provider;
        resetCache();
        await assert.rejects(
          () => getEmbedder(),
          (err) => {
            assert.match(err.message, new RegExp(`Unsupported embedding provider "${provider}"`));
            assert.match(err.message, /supported providers: builtin, local, stub/);
            assert.doesNotMatch(err.message, /planned for/);
            return true;
          },
        );
      }
    } finally {
      process.env.DEVTEAM_EMBEDDING_PROVIDER = before;
      resetCache();
    }
  });

  it("local provider with absent @huggingface/transformers throws actionable MODULE_NOT_FOUND error", async () => {
    const before = process.env.DEVTEAM_EMBEDDING_PROVIDER;
    process.env.DEVTEAM_EMBEDDING_PROVIDER = "local";
    resetCache();
    const missingErr = new Error("Cannot find module '@huggingface/transformers'");
    missingErr.code = "MODULE_NOT_FOUND";
    _setRequireHF(() => { throw missingErr; });
    try {
      await getEmbedder({ fresh: true });
      assert.fail("should have thrown");
    } catch (err) {
      assert.match(err.message, /npm install @huggingface\/transformers/);
      assert.match(err.message, /optional dependency/);
    } finally {
      _setRequireHF(() => require("@huggingface/transformers"));
      process.env.DEVTEAM_EMBEDDING_PROVIDER = before;
      resetCache();
    }
  });
});

// ---------------------------------------------------------------------------
// JSONMemoryStore
// ---------------------------------------------------------------------------

describe("memory: JSONMemoryStore", () => {
  it("upsertDoc replaces all chunks for a source", () => {
    const cwd = track(makeTargetProject({ gates: false }));
    const store = new JSONMemoryStore({ cwd });
    const mkRec = (heading) => ({
      id: sha1(`x.md|${heading}`), doc_id: sha1("x.md"), kind: "brief",
      source: "x.md", title: "X", heading, text: "...", embedding: [0.1, 0.2],
      timestamp: "t", embedder: { modelId: "stub", dim: 2 },
    });
    store.upsertDoc("x.md", "brief", [mkRec("A"), mkRec("B")]);
    let s = store.stats();
    assert.equal(s.chunks, 2);
    // Re-upsert with a different chunk set → old chunks gone
    store.upsertDoc("x.md", "brief", [mkRec("C")]);
    s = store.stats();
    assert.equal(s.chunks, 1);
    assert.equal(s.by_kind.brief.chunks, 1);
  });

  it("deleteDoc removes all chunks for a source across shards", () => {
    const cwd = track(makeTargetProject({ gates: false }));
    const store = new JSONMemoryStore({ cwd });
    const docId = sha1("a.md");
    store._saveShard("brief", [
      { id: "1", doc_id: docId, kind: "brief", source: "a.md", embedding: [0] },
      { id: "2", doc_id: sha1("b.md"), kind: "brief", source: "b.md", embedding: [0] },
    ]);
    assert.equal(store.deleteDoc("a.md"), 1);
    assert.equal(store.stats().chunks, 1);
  });

  it("clear wipes all shards but preserves the dir", () => {
    const cwd = track(makeTargetProject({ gates: false }));
    const store = new JSONMemoryStore({ cwd });
    store.upsertDoc("x.md", "brief", [{
      id: "1", doc_id: sha1("x.md"), kind: "brief", source: "x.md",
      embedding: [0], title: "x", heading: "h", text: "t", timestamp: "t",
      embedder: { modelId: "stub", dim: 1 },
    }]);
    assert.equal(store.stats().chunks, 1);
    store.clear();
    assert.equal(store.stats().chunks, 0);
  });
});

// ---------------------------------------------------------------------------
// End-to-end: ingest + query
// ---------------------------------------------------------------------------

describe("memory: ingest + query end-to-end", () => {
  it("ingests pipeline/brief.md and finds it via query", async () => {
    const cwd = track(makeTargetProject({ gates: false }));
    writeArtifact(cwd, "pipeline/brief.md", SAMPLE_BRIEF);
    const r = await memory.ingest({ cwd });
    assert.equal(r.artifacts, 1);
    assert.ok(r.chunks >= 2);
    // Query for something that should match the observability section
    const results = await memory.query("observability metrics for sms", { cwd, limit: 3 });
    assert.ok(results.length > 0);
    // All results should come from the brief we ingested
    assert.ok(results.every((res) => res.source === "pipeline/brief.md"));
  });

  it("indexes multiple artifact types with the right `kind`", async () => {
    const cwd = track(makeTargetProject({ gates: false }));
    writeArtifact(cwd, "pipeline/brief.md", SAMPLE_BRIEF);
    writeArtifact(cwd, "pipeline/design-spec.md", SAMPLE_DESIGN);
    writeArtifact(cwd, "pipeline/adr/001-pick-twilio.md", `# ADR 001 — Pick Twilio

## Decision
Use Twilio.

## Context
Cheapest SMS provider for our volume.`);
    await memory.ingest({ cwd });
    const s = memory.stats({ cwd });
    assert.equal(s.documents, 3);
    assert.ok(s.by_kind.brief);
    assert.ok(s.by_kind["design-spec"]);
    assert.ok(s.by_kind.adr);
  });

  it("respects the stagecraft-no-memory marker", async () => {
    const cwd = track(makeTargetProject({ gates: false }));
    writeArtifact(cwd, "pipeline/brief.md", "<!-- stagecraft-no-memory -->\n# Brief\n## 1. Problem\n" + "x".repeat(60));
    const r = await memory.ingest({ cwd });
    assert.equal(r.artifacts, 0);
    assert.ok(r.skipped.some((s) => s.includes("brief.md")));
  });

  it("kind filter narrows results", async () => {
    const cwd = track(makeTargetProject({ gates: false }));
    writeArtifact(cwd, "pipeline/brief.md", SAMPLE_BRIEF);
    writeArtifact(cwd, "pipeline/design-spec.md", SAMPLE_DESIGN);
    await memory.ingest({ cwd });
    const all = await memory.query("opt-in", { cwd, limit: 10 });
    const briefsOnly = await memory.query("opt-in", { cwd, limit: 10, kind: "brief" });
    assert.ok(all.length >= briefsOnly.length);
    assert.ok(briefsOnly.every((r) => r.kind === "brief"));
  });

  it("stats reports embedder + counts", async () => {
    const cwd = track(makeTargetProject({ gates: false }));
    writeArtifact(cwd, "pipeline/brief.md", SAMPLE_BRIEF);
    await memory.ingest({ cwd });
    const s = memory.stats({ cwd });
    assert.ok(s.embedder);
    assert.equal(s.embedder.modelId, "stub");
    assert.equal(s.documents, 1);
    assert.ok(s.chunks > 0);
  });

  it("clear wipes the store", async () => {
    const cwd = track(makeTargetProject({ gates: false }));
    writeArtifact(cwd, "pipeline/brief.md", SAMPLE_BRIEF);
    await memory.ingest({ cwd });
    assert.ok(memory.stats({ cwd }).chunks > 0);
    memory.clear({ cwd });
    assert.equal(memory.stats({ cwd }).chunks, 0);
  });

  it("re-ingesting the same artifact does NOT duplicate chunks", async () => {
    const cwd = track(makeTargetProject({ gates: false }));
    writeArtifact(cwd, "pipeline/brief.md", SAMPLE_BRIEF);
    const r1 = await memory.ingest({ cwd });
    const r2 = await memory.ingest({ cwd });
    assert.equal(r1.chunks, r2.chunks);
    assert.equal(memory.stats({ cwd }).chunks, r1.chunks);
  });

  it("reindex clears then re-ingests", async () => {
    const cwd = track(makeTargetProject({ gates: false }));
    writeArtifact(cwd, "pipeline/brief.md", SAMPLE_BRIEF);
    await memory.ingest({ cwd });
    const before = memory.stats({ cwd }).chunks;
    const r = await memory.reindex({ cwd });
    assert.equal(r.chunks, before);
    assert.equal(memory.stats({ cwd }).chunks, before);
  });

  it("query results are ranked by similarity (highest first)", async () => {
    const cwd = track(makeTargetProject({ gates: false }));
    writeArtifact(cwd, "pipeline/brief.md", SAMPLE_BRIEF);
    await memory.ingest({ cwd });
    const results = await memory.query("test query", { cwd, limit: 10 });
    for (let i = 1; i < results.length; i++) {
      assert.ok(results[i - 1].similarity >= results[i].similarity);
    }
  });
});

// ---------------------------------------------------------------------------
// D3 — org-shared memory (cross-project lessons + ADRs)
// ---------------------------------------------------------------------------

describe("memory: org-shared store (D3)", () => {
  // Each test gets its own org dir to avoid polluting the real ~/.stagecraft/.
  let origOrgDir;
  let testOrgDirs = [];
  function withOrgDir() {
    const d = fs.mkdtempSync(path.join(require("node:os").tmpdir(), "stagecraft-org-"));
    testOrgDirs.push(d);
    process.env.STAGECRAFT_ORG_MEMORY_DIR = d;
    // Reset the require cache so the module re-reads ORG_MEMORY_DIR.
    delete require.cache[require.resolve(path.join(REPO_ROOT, "core", "memory"))];
    return require(path.join(REPO_ROOT, "core", "memory"));
  }
  before(() => { origOrgDir = process.env.STAGECRAFT_ORG_MEMORY_DIR; });
  afterEach(() => {
    for (const d of testOrgDirs) { try { fs.rmSync(d, { recursive: true, force: true }); } catch { /* */ } }
    testOrgDirs = [];
    if (origOrgDir === undefined) delete process.env.STAGECRAFT_ORG_MEMORY_DIR;
    else process.env.STAGECRAFT_ORG_MEMORY_DIR = origOrgDir;
    delete require.cache[require.resolve(path.join(REPO_ROOT, "core", "memory"))];
  });

  it("promote(): default kinds copy adr + lessons-learned from a project to the org store", async () => {
    const mem = withOrgDir();
    const cwd = track(makeTargetProject({ gates: false }));
    writeArtifact(cwd, "pipeline/adr/001-pick-twilio.md",
      "# ADR 001 — Pick Twilio\n\n## Context\n\nWe evaluated SMS providers including Twilio, MessageBird, and AWS SNS. Each has tradeoffs across price, deliverability, and developer experience.\n\n## Decision\n\nUse Twilio for v1 because it has the cleanest API and the best deliverability in our target geos. Revisit when volume justifies a custom carrier integration.\n");
    writeArtifact(cwd, "pipeline/lessons-learned.md",
      "# Lessons learned\n\n## L001 — Brief §9 wording\n\n**Reinforced:** 2 (last: 2026-05-01)\n**Rule:** when the brief uses 'notify', clarify channel (email / SMS / push / inline) before Stage 2 design.\n**Why:** ambiguous 'notify' wording caused two clarification rounds at Stage 3 last sprint.\n**How to apply:** PM raises a CLARIFY: line in pipeline/context.md if 'notify' appears without a channel qualifier.\n");
    await mem.ingest({ cwd });

    const r = mem.promote({ cwd });
    assert.ok(r.promoted.adr > 0, `expected ADR chunks promoted, got ${JSON.stringify(r)}`);
    assert.ok(r.promoted["lessons-learned"] > 0, `expected lessons-learned chunks promoted, got ${JSON.stringify(r)}`);
    assert.equal(r.error, undefined);

    // Org-store stats reflect the promoted content.
    const s = mem.statsOrg();
    assert.ok(s.documents > 0);
    assert.ok(s.by_kind.adr.documents >= 1);
    assert.ok(s.by_kind["lessons-learned"].documents >= 1);
  });

  it("promote() with explicit kinds copies only those", async () => {
    const mem = withOrgDir();
    const cwd = track(makeTargetProject({ gates: false }));
    writeArtifact(cwd, "pipeline/adr/001-x.md",
      "# ADR 001 — Async retry policy\n\n## Decision\n\nUse exponential backoff with jitter for all retry loops; cap at 5 attempts; record retries in OTel spans for visibility.\n");
    writeArtifact(cwd, "pipeline/lessons-learned.md",
      "# Lessons\n\n## L001 — Schema migrations\n\n**Reinforced:** 0\n**Rule:** dual-write before backfill on any column rename.\n**Why:** rollbacks during deploy are impossible if writes are already going to the new column only.\n");
    await mem.ingest({ cwd });
    const r = mem.promote({ cwd, kinds: ["adr"] });
    assert.ok(r.promoted.adr > 0);
    assert.equal(r.promoted["lessons-learned"], undefined);
  });

  it("queryOrg() returns records from the org store with project_cwd tagging", async () => {
    const mem = withOrgDir();
    const cwd = track(makeTargetProject({ gates: false }));
    writeArtifact(cwd, "pipeline/adr/001-pagination.md",
      "# ADR 001 — Pagination style\n\n## Context\n\nWe need to pick offset vs cursor pagination for all new list endpoints across the product. Offset is simpler but breaks under deep pagination at scale.\n\n## Decision\n\nCursor-based across all new APIs. Cursors are opaque base64-encoded structs; clients treat them as tokens.\n");
    await mem.ingest({ cwd });
    mem.promote({ cwd });

    const results = await mem.queryOrg("pagination decision", { limit: 5 });
    assert.ok(results.length > 0, "expected org query to return results");
    assert.ok(results[0].project_cwd, "org records must carry project_cwd attribution");
    assert.equal(results[0].project_cwd, cwd);
  });

  it("promote() is idempotent — re-promoting the same project does not duplicate", async () => {
    const mem = withOrgDir();
    const cwd = track(makeTargetProject({ gates: false }));
    writeArtifact(cwd, "pipeline/adr/001-x.md",
      "# ADR 001 — Test ADR\n\n## Decision\n\nUse the convention X consistently across the codebase to avoid drift between teams.\n");
    await mem.ingest({ cwd });
    mem.promote({ cwd });
    const after1 = mem.statsOrg().chunks;
    mem.promote({ cwd });
    const after2 = mem.statsOrg().chunks;
    assert.equal(after1, after2, "idempotent promote should not duplicate chunks");
  });

  it("statsOrg / clearOrg manage the org store independently of per-project", async () => {
    const mem = withOrgDir();
    const cwd = track(makeTargetProject({ gates: false }));
    writeArtifact(cwd, "pipeline/adr/001-x.md",
      "# ADR 001\n\n## Decision\n\nThis is a placeholder ADR with enough body to make the chunker happy and keep tests deterministic across embedder backends.\n");
    await mem.ingest({ cwd });
    mem.promote({ cwd });
    assert.ok(mem.statsOrg().chunks > 0);
    mem.clearOrg();
    assert.equal(mem.statsOrg().chunks, 0);
    // Project store is untouched.
    assert.ok(mem.stats({ cwd }).chunks > 0);
  });

  it("promote() reports nothing-to-do when no records of the requested kind exist", async () => {
    const mem = withOrgDir();
    const cwd = track(makeTargetProject({ gates: false }));
    // No ADRs ingested.
    writeArtifact(cwd, "pipeline/brief.md", SAMPLE_BRIEF);
    await mem.ingest({ cwd });
    const r = mem.promote({ cwd, kinds: ["adr"] });
    assert.deepEqual(r.skipped, ["adr"]);
    assert.deepEqual(r.promoted, {});
  });
});
