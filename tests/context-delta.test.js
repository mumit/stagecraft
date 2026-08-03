// Phase 32.5(b): per-workstream "what changed in pipeline/context.md since
// your last dispatch," derived purely from run-log.jsonl history.
const { describe, it, afterEach } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { computeContextDelta } = require("../core/context-delta");

let _dirs = [];
function track(cwd) { _dirs.push(cwd); return cwd; }
afterEach(() => { for (const d of _dirs.splice(0)) fs.rmSync(d, { recursive: true, force: true }); });

function writeRunLog(cwd, events) {
  fs.mkdirSync(path.join(cwd, "pipeline"), { recursive: true });
  fs.writeFileSync(
    path.join(cwd, "pipeline", "run-log.jsonl"),
    events.map((e) => JSON.stringify(e)).join("\n") + "\n",
  );
}

describe("context-delta: computeContextDelta", () => {
  it("returns null when run-log.jsonl does not exist (first-ever dispatch)", () => {
    const cwd = track(fs.mkdtempSync(path.join(os.tmpdir(), "devteam-test-")));
    const delta = computeContextDelta({ cwd, changeId: null, workstreamId: "stage-04.backend" });
    assert.equal(delta, null);
  });

  it("returns null when this workstream has never been dispatched before", () => {
    const cwd = track(fs.mkdtempSync(path.join(os.tmpdir(), "devteam-test-")));
    writeRunLog(cwd, [
      { ts: "2026-08-01T00:00:00.000Z", type: "workstream-started", workstream_id: "stage-04.frontend" },
    ]);
    const delta = computeContextDelta({ cwd, changeId: null, workstreamId: "stage-04.backend" });
    assert.equal(delta, null);
  });

  it("collects added/removed/compacted sections after this workstream's previous dispatch", () => {
    const cwd = track(fs.mkdtempSync(path.join(os.tmpdir(), "devteam-test-")));
    writeRunLog(cwd, [
      { ts: "2026-08-01T00:00:00.000Z", type: "workstream-started", workstream_id: "stage-04.backend" },
      { ts: "2026-08-01T00:01:00.000Z", event: "context-section-change", action: "added", section: "run-blockers" },
      { ts: "2026-08-01T00:02:00.000Z", event: "context-section-change", action: "removed", section: "red-team-blockers" },
      { ts: "2026-08-01T00:03:00.000Z", event: "context-section-change", action: "compacted", section: "right-sizing" },
    ]);
    const delta = computeContextDelta({ cwd, changeId: null, workstreamId: "stage-04.backend" });
    assert.deepEqual(delta.added, ["run-blockers"]);
    assert.deepEqual(delta.removed, ["red-team-blockers"]);
    assert.deepEqual(delta.compacted, ["right-sizing"]);
  });

  it("ignores context-section-change events at or before the previous dispatch timestamp", () => {
    const cwd = track(fs.mkdtempSync(path.join(os.tmpdir(), "devteam-test-")));
    writeRunLog(cwd, [
      { ts: "2026-08-01T00:00:00.000Z", event: "context-section-change", action: "added", section: "before-dispatch" },
      { ts: "2026-08-01T00:01:00.000Z", type: "workstream-started", workstream_id: "stage-04.backend" },
      { ts: "2026-08-01T00:01:00.000Z", event: "context-section-change", action: "added", section: "same-instant" },
      { ts: "2026-08-01T00:02:00.000Z", event: "context-section-change", action: "added", section: "after-dispatch" },
    ]);
    const delta = computeContextDelta({ cwd, changeId: null, workstreamId: "stage-04.backend" });
    assert.deepEqual(delta.added, ["after-dispatch"]);
  });

  it("is correct across a retry sequence — only counts changes since the MOST RECENT prior dispatch", () => {
    const cwd = track(fs.mkdtempSync(path.join(os.tmpdir(), "devteam-test-")));
    writeRunLog(cwd, [
      // First dispatch (attempt 1)
      { ts: "2026-08-01T00:00:00.000Z", type: "workstream-started", workstream_id: "stage-04.backend" },
      { ts: "2026-08-01T00:01:00.000Z", event: "context-section-change", action: "added", section: "run-blockers" },
      // Retry: second dispatch (attempt 2) — after this, the attempt-1 delta is stale
      { ts: "2026-08-01T00:02:00.000Z", type: "workstream-started", workstream_id: "stage-04.backend" },
      { ts: "2026-08-01T00:03:00.000Z", event: "context-section-change", action: "removed", section: "run-blockers" },
      { ts: "2026-08-01T00:04:00.000Z", event: "context-section-change", action: "added", section: "right-sizing" },
    ]);
    const delta = computeContextDelta({ cwd, changeId: null, workstreamId: "stage-04.backend" });
    // Only events after the 00:02:00 (attempt-2) dispatch count.
    assert.deepEqual(delta.added, ["right-sizing"]);
    assert.deepEqual(delta.removed, ["run-blockers"]);
  });

  it("does not mix events from other workstreams into the delta", () => {
    const cwd = track(fs.mkdtempSync(path.join(os.tmpdir(), "devteam-test-")));
    writeRunLog(cwd, [
      { ts: "2026-08-01T00:00:00.000Z", type: "workstream-started", workstream_id: "stage-04.backend" },
      { ts: "2026-08-01T00:01:00.000Z", type: "workstream-started", workstream_id: "stage-04.frontend" },
      { ts: "2026-08-01T00:02:00.000Z", event: "context-section-change", action: "added", section: "right-sizing" },
    ]);
    const delta = computeContextDelta({ cwd, changeId: null, workstreamId: "stage-04.backend" });
    assert.deepEqual(delta.added, ["right-sizing"], "delta is global-to-context.md, not per-workstream, but the SINCE anchor is workstream-specific");
  });

  it("resolves run-log.jsonl under pipeline/changes/<id>/ when changeId is set", () => {
    const cwd = track(fs.mkdtempSync(path.join(os.tmpdir(), "devteam-test-")));
    fs.mkdirSync(path.join(cwd, "pipeline", "changes", "feat-x"), { recursive: true });
    fs.writeFileSync(
      path.join(cwd, "pipeline", "changes", "feat-x", "run-log.jsonl"),
      [
        { ts: "2026-08-01T00:00:00.000Z", type: "workstream-started", workstream_id: "stage-04.backend" },
        { ts: "2026-08-01T00:01:00.000Z", event: "context-section-change", action: "added", section: "right-sizing" },
      ].map((e) => JSON.stringify(e)).join("\n") + "\n",
    );
    const delta = computeContextDelta({ cwd, changeId: "feat-x", workstreamId: "stage-04.backend" });
    assert.deepEqual(delta.added, ["right-sizing"]);
  });

  it("skips malformed lines instead of throwing", () => {
    const cwd = track(fs.mkdtempSync(path.join(os.tmpdir(), "devteam-test-")));
    fs.mkdirSync(path.join(cwd, "pipeline"), { recursive: true });
    fs.writeFileSync(
      path.join(cwd, "pipeline", "run-log.jsonl"),
      '{"ts":"2026-08-01T00:00:00.000Z","type":"workstream-started","workstream_id":"stage-04.backend"}\n' +
      "not valid json\n" +
      '{"ts":"2026-08-01T00:01:00.000Z","event":"context-section-change","action":"added","section":"right-sizing"}\n',
    );
    const delta = computeContextDelta({ cwd, changeId: null, workstreamId: "stage-04.backend" });
    assert.deepEqual(delta.added, ["right-sizing"]);
  });
});
