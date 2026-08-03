// Phase 32.5(a): pipeline/context.md diet — budget-triggered auto-compaction
// of resolved marker sections into archived one-line digests.
const { describe, it, afterEach } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { enforceContextBudget, RESOLVABLE_SECTIONS } = require("../core/context-budget");

let _dirs = [];
function track(cwd) { _dirs.push(cwd); return cwd; }
afterEach(() => { for (const d of _dirs.splice(0)) cleanup(d); });
function cleanup(cwd) {
  if (cwd && fs.existsSync(cwd) && cwd.includes("devteam-test-")) fs.rmSync(cwd, { recursive: true, force: true });
}

function makeProject(cwd, { contextMd, config, gates } = {}) {
  fs.mkdirSync(path.join(cwd, ".devteam"), { recursive: true });
  fs.writeFileSync(
    path.join(cwd, ".devteam", "config.yml"),
    config || "routing:\n  default_host: generic\npipeline:\n  default_track: full\n",
  );
  fs.mkdirSync(path.join(cwd, "pipeline", "gates"), { recursive: true });
  if (contextMd !== undefined) {
    fs.writeFileSync(path.join(cwd, "pipeline", "context.md"), contextMd);
  }
  for (const [name, gate] of Object.entries(gates || {})) {
    fs.writeFileSync(path.join(cwd, "pipeline", "gates", name), JSON.stringify(gate));
  }
}

function section(name, body) {
  return `<!-- devteam:${name}:begin -->\n${body}\n<!-- devteam:${name}:end -->`;
}

describe("context-budget: enforceContextBudget", () => {
  it("does nothing when context.md is under budget", () => {
    const cwd = track(fs.mkdtempSync(path.join(os.tmpdir(), "devteam-test-")));
    const content = section("right-sizing", "small") + "\n";
    makeProject(cwd, { contextMd: content, gates: { "stage-01.json": { status: "PASS" } } });
    enforceContextBudget(cwd, null, { now: new Date("2026-08-02T00:00:00.000Z") });
    assert.equal(fs.readFileSync(path.join(cwd, "pipeline", "context.md"), "utf8"), content);
    assert.equal(fs.existsSync(path.join(cwd, "pipeline", "context-archive")), false);
  });

  it("compacts an oversize RESOLVED section to a one-line digest with an archive round-trip", () => {
    const cwd = track(fs.mkdtempSync(path.join(os.tmpdir(), "devteam-test-")));
    const bigBody = "x".repeat(9000);
    const content = section("right-sizing", bigBody) + "\n# Context\n";
    makeProject(cwd, {
      contextMd: content,
      config: "routing:\n  default_host: generic\npipeline:\n  default_track: full\n  context_budget_bytes: 500\n",
      gates: { "stage-01.json": { status: "PASS" } },
    });
    const now = new Date("2026-08-02T12:00:00.000Z");
    enforceContextBudget(cwd, null, { now });

    const after = fs.readFileSync(path.join(cwd, "pipeline", "context.md"), "utf8");
    assert.match(after, /devteam:right-sizing:begin/, "marker pair survives so future upserts still target it");
    assert.match(after, /_Compacted 2026-08-02T12:00:00\.000Z/);
    assert.match(after, /pipeline\/context-archive\/2026-08-02T12-00-00-000Z-right-sizing\.md/);
    assert.match(after, /# Context/, "surrounding content survives");
    assert.doesNotMatch(after, /x{100}/, "original oversize body is gone from context.md");

    const archived = fs.readFileSync(
      path.join(cwd, "pipeline", "context-archive", "2026-08-02T12-00-00-000Z-right-sizing.md"),
      "utf8",
    );
    assert.match(archived, /devteam:right-sizing:begin/);
    assert.match(archived, new RegExp(bigBody));
  });

  it("never auto-compacts an unresolved (still-active) section, even far over budget", () => {
    const cwd = track(fs.mkdtempSync(path.join(os.tmpdir(), "devteam-test-")));
    const bigBody = "y".repeat(9000);
    const content = section("right-sizing", bigBody) + "\n";
    makeProject(cwd, {
      contextMd: content,
      config: "routing:\n  default_host: generic\npipeline:\n  default_track: full\n  context_budget_bytes: 500\n",
      gates: { "stage-01.json": { status: "FAIL" } }, // not PASS/WARN — unresolved
    });
    enforceContextBudget(cwd, null, { now: new Date("2026-08-02T00:00:00.000Z") });
    const after = fs.readFileSync(path.join(cwd, "pipeline", "context.md"), "utf8");
    assert.equal(after, content, "active section must survive byte-for-byte");
    assert.equal(fs.existsSync(path.join(cwd, "pipeline", "context-archive")), false);
  });

  it("never auto-compacts a section this module has no resolution rule for (e.g. run-blockers)", () => {
    const cwd = track(fs.mkdtempSync(path.join(os.tmpdir(), "devteam-test-")));
    assert.equal("run-blockers" in RESOLVABLE_SECTIONS, false);
    const bigBody = "z".repeat(9000);
    const content = section("run-blockers", bigBody) + "\n";
    makeProject(cwd, {
      contextMd: content,
      config: "routing:\n  default_host: generic\npipeline:\n  default_track: full\n  context_budget_bytes: 500\n",
    });
    enforceContextBudget(cwd, null, { now: new Date("2026-08-02T00:00:00.000Z") });
    assert.equal(fs.readFileSync(path.join(cwd, "pipeline", "context.md"), "utf8"), content);
  });

  it("compacts multiple resolved sections in document order until under budget", () => {
    const cwd = track(fs.mkdtempSync(path.join(os.tmpdir(), "devteam-test-")));
    const content =
      section("right-sizing", "a".repeat(5000)) + "\n" +
      section("deploy-target", "b".repeat(5000)) + "\n";
    makeProject(cwd, {
      contextMd: content,
      config: "routing:\n  default_host: generic\npipeline:\n  default_track: full\n  context_budget_bytes: 1000\n",
      gates: {
        "stage-01.json": { status: "PASS" },
        "stage-08.json": { status: "WARN" },
      },
    });
    enforceContextBudget(cwd, null, { now: new Date("2026-08-02T00:00:00.000Z") });
    const after = fs.readFileSync(path.join(cwd, "pipeline", "context.md"), "utf8");
    assert.match(after, /_Compacted.*right-sizing\.md/);
    assert.match(after, /_Compacted.*deploy-target\.md/);
    assert.ok(Buffer.byteLength(after, "utf8") < 1000);
  });

  it("is idempotent: does not re-archive an already-compacted section", () => {
    const cwd = track(fs.mkdtempSync(path.join(os.tmpdir(), "devteam-test-")));
    const content = section("right-sizing", "c".repeat(9000)) + "\n";
    makeProject(cwd, {
      contextMd: content,
      config: "routing:\n  default_host: generic\npipeline:\n  default_track: full\n  context_budget_bytes: 500\n",
      gates: { "stage-01.json": { status: "PASS" } },
    });
    enforceContextBudget(cwd, null, { now: new Date("2026-08-02T00:00:00.000Z") });
    const afterFirst = fs.readFileSync(path.join(cwd, "pipeline", "context.md"), "utf8");
    enforceContextBudget(cwd, null, { now: new Date("2026-08-02T01:00:00.000Z") });
    const afterSecond = fs.readFileSync(path.join(cwd, "pipeline", "context.md"), "utf8");
    assert.equal(afterFirst, afterSecond);
    const archiveFiles = fs.readdirSync(path.join(cwd, "pipeline", "context-archive"));
    assert.equal(archiveFiles.length, 1);
  });

  it("does nothing when context.md does not exist", () => {
    const cwd = track(fs.mkdtempSync(path.join(os.tmpdir(), "devteam-test-")));
    makeProject(cwd, { gates: { "stage-01.json": { status: "PASS" } } });
    assert.doesNotThrow(() => enforceContextBudget(cwd, null));
  });
});
