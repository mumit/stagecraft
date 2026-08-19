const { describe, it, afterEach } = require("node:test");
const assert = require("node:assert/strict");
const { EventEmitter } = require("node:events");
const path = require("node:path");
const { REPO_ROOT, makeTargetProject, seedGate, cleanup } = require("./_helpers");
const { startServer, buildState, loadGateFile, loadRoleBrief } =
  require(path.join(REPO_ROOT, "core", "ui", "server"));

let _dirs = [];
let _servers = [];
function track(cwd) { _dirs.push(cwd); return cwd; }
function trackServer(s) { _servers.push(s); return s; }

afterEach(async () => {
  for (const s of _servers) { try { await s.close(); } catch { /* */ } }
  _servers = [];
  _dirs.forEach(cleanup);
  _dirs = [];
});

async function get(url) {
  // Native fetch (Node 18+ has it).
  const r = await fetch(url);
  const text = await r.text();
  let json = null;
  try { json = JSON.parse(text); } catch { /* */ }
  return { status: r.status, headers: Object.fromEntries(r.headers.entries()), text, json };
}

describe("ui: buildState (pure)", () => {
  it("returns rows + tracks + hosts for a fresh project", () => {
    const cwd = track(makeTargetProject());
    const s = buildState(cwd);
    assert.ok(Array.isArray(s.rows));
    assert.ok(s.rows.length > 0);
    assert.ok(Array.isArray(s.tracks));
    assert.ok(s.tracks.includes("full"));
    assert.ok(Array.isArray(s.hosts));
  });

  it("reflects seeded gates", () => {
    const cwd = track(makeTargetProject());
    seedGate(cwd, "stage-01", { status: "PASS" });
    const s = buildState(cwd);
    const row = s.rows.find((r) => r.stage === "stage-01");
    assert.equal(row.state, "pass");
  });
});

describe("ui: loadGateFile + loadRoleBrief", () => {
  it("loads a known gate", () => {
    const cwd = track(makeTargetProject());
    seedGate(cwd, "stage-01", { status: "PASS", workstream: "pm", host: "claude-code" });
    const g = loadGateFile(cwd, "stage-01");
    assert.equal(g.status, "PASS");
    assert.equal(g.workstream, "pm");
  });

  it("returns null for missing gate", () => {
    const cwd = track(makeTargetProject());
    assert.equal(loadGateFile(cwd, "stage-99"), null);
  });

  it("rejects malicious stage IDs (path traversal)", () => {
    const cwd = track(makeTargetProject());
    assert.equal(loadGateFile(cwd, "../../etc/passwd"), null);
  });

  it("loads a real role brief", () => {
    const brief = loadRoleBrief("pm");
    assert.ok(brief && brief.length > 100);
  });

  it("returns null for invalid role name", () => {
    assert.equal(loadRoleBrief("../secret"), null);
  });
});

describe("ui: HTTP server", () => {
  it("serves index.html on /", async () => {
    const cwd = track(makeTargetProject());
    const s = trackServer(await startServer({ port: 0, cwd }));
    const r = await get(s.url);
    assert.equal(r.status, 200);
    assert.match(r.text, /<title>devteam<\/title>/);
    assert.match(r.headers["content-security-policy"] || "", /default-src 'self'/);
    assert.match(r.headers["content-security-policy"] || "", /object-src 'none'/);
    assert.equal(r.headers["x-content-type-options"], "nosniff");
  });

  it("serves the static app.js bundle", async () => {
    const cwd = track(makeTargetProject());
    const s = trackServer(await startServer({ port: 0, cwd }));
    const r = await get(`${s.url}app.js`);
    assert.equal(r.status, 200);
    assert.match(r.text, /fetchState/);
  });

  it("GET /api/state returns the live state", async () => {
    const cwd = track(makeTargetProject());
    seedGate(cwd, "stage-01", { status: "PASS" });
    const s = trackServer(await startServer({ port: 0, cwd }));
    const r = await get(`${s.url}api/state`);
    assert.equal(r.status, 200);
    assert.equal(r.json.cwd, cwd);
    const row = r.json.rows.find((x) => x.stage === "stage-01");
    assert.equal(row.state, "pass");
  });

  it("GET /api/gate/<stage> returns the gate JSON", async () => {
    const cwd = track(makeTargetProject());
    seedGate(cwd, "stage-04.backend", { workstream: "backend", host: "codex", status: "PASS" });
    const s = trackServer(await startServer({ port: 0, cwd }));
    const r = await get(`${s.url}api/gate/stage-04.backend`);
    assert.equal(r.status, 200);
    assert.equal(r.json.workstream, "backend");
  });

  it("GET /api/gate/<bogus> returns 404", async () => {
    const cwd = track(makeTargetProject());
    const s = trackServer(await startServer({ port: 0, cwd }));
    const r = await get(`${s.url}api/gate/stage-99`);
    assert.equal(r.status, 404);
  });

  it("GET /api/role/<name> returns the brief as markdown", async () => {
    const cwd = track(makeTargetProject());
    const s = trackServer(await startServer({ port: 0, cwd }));
    const r = await get(`${s.url}api/role/pm`);
    assert.equal(r.status, 200);
    assert.match(r.headers["content-type"] || "", /markdown/);
    assert.ok(r.text.length > 100);
  });

  it("keeps serving when the gate watcher emits an asynchronous EMFILE error", async () => {
    const cwd = track(makeTargetProject());
    const watcher = new EventEmitter();
    let watcherClosed = false;
    watcher.close = () => { watcherClosed = true; };
    let resolveWatchError;
    const watchError = new Promise((resolve) => { resolveWatchError = resolve; });
    const s = trackServer(await startServer({
      port: 0,
      cwd,
      watchFn() {
        queueMicrotask(() => {
          const error = new Error("too many open files, watch");
          error.code = "EMFILE";
          watcher.emit("error", error);
        });
        return watcher;
      },
      onWatchError(error) { resolveWatchError(error); },
    }));

    const error = await watchError;
    assert.equal(error.code, "EMFILE");
    assert.equal(watcherClosed, true);
    const response = await get(s.url);
    assert.equal(response.status, 200);
    assert.match(response.text, /<title>devteam<\/title>/);
  });

  it("rejects path traversal attempts on /static/", async () => {
    const cwd = track(makeTargetProject());
    const s = trackServer(await startServer({ port: 0, cwd }));
    const r = await get(`${s.url}../../../etc/passwd`);
    assert.ok(r.status === 403 || r.status === 404);
  });
});

describe("ui: non-loopback bind guard", () => {
  const ORIG = process.env.STAGECRAFT_UI_ALLOW_REMOTE;
  afterEach(() => {
    if (ORIG === undefined) delete process.env.STAGECRAFT_UI_ALLOW_REMOTE;
    else process.env.STAGECRAFT_UI_ALLOW_REMOTE = ORIG;
  });

  it("allows loopback bind without opt-in (127.0.0.1)", async () => {
    delete process.env.STAGECRAFT_UI_ALLOW_REMOTE;
    const cwd = track(makeTargetProject());
    const s = trackServer(await startServer({ port: 0, cwd, host: "127.0.0.1" }));
    assert.match(s.url, /127\.0\.0\.1/);
  });

  it("allows loopback bind without opt-in (localhost)", async () => {
    delete process.env.STAGECRAFT_UI_ALLOW_REMOTE;
    const cwd = track(makeTargetProject());
    const s = trackServer(await startServer({ port: 0, cwd, host: "localhost" }));
    assert.ok(s.url.startsWith("http://"));
  });

  it("refuses non-loopback bind without STAGECRAFT_UI_ALLOW_REMOTE=1", async () => {
    delete process.env.STAGECRAFT_UI_ALLOW_REMOTE;
    const cwd = track(makeTargetProject());
    await assert.rejects(
      () => startServer({ port: 0, cwd, host: "0.0.0.0" }),
      (err) => {
        assert.equal(err.code, "EREMOTEBIND");
        assert.match(err.message, /non-loopback/);
        assert.match(err.message, /STAGECRAFT_UI_ALLOW_REMOTE/);
        return true;
      },
    );
  });

  it("allows non-loopback bind when STAGECRAFT_UI_ALLOW_REMOTE=1", async () => {
    process.env.STAGECRAFT_UI_ALLOW_REMOTE = "1";
    const cwd = track(makeTargetProject());
    // 0.0.0.0 binds to all interfaces — the server should start; we don't
    // need to actually fetch through it for this test.
    const s = trackServer(await startServer({ port: 0, cwd, host: "0.0.0.0" }));
    assert.ok(s.url.startsWith("http://"));
  });

  it("clears the heartbeat interval when the server closes", async () => {
    const cwd = track(makeTargetProject());
    const timer = { unrefCalled: false, unref() { this.unrefCalled = true; } };
    let cleared = null;
    const s = trackServer(await startServer({
      port: 0,
      cwd,
      setIntervalFn(fn, ms) {
        assert.equal(typeof fn, "function");
        assert.equal(ms, 15000);
        return timer;
      },
      clearIntervalFn(value) { cleared = value; },
    }));
    assert.equal(timer.unrefCalled, true);
    await s.close();
    _servers = _servers.filter((server) => server !== s);
    assert.equal(cleared, timer);
  });
});
