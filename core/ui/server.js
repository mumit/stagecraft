// Local HTTP server for the devteam pipeline UI.
// Single-file dependency-free server: routes, static asset serving,
// SSE event stream, fs.watch on pipeline/gates/.
//
// Public:
//   startServer(opts) → { url, server, close() }
//     opts.port    — default 3737 (override via --port or PORT env)
//     opts.cwd     — pipeline target directory; default process.cwd()
//     opts.host    — bind host; default "127.0.0.1" (loopback only)
//     opts.open    — if true, attempt to open the URL in the browser
//
// Non-loopback bind requires explicit opt-in via the
// STAGECRAFT_UI_ALLOW_REMOTE=1 env var. The UI has no auth, no rate
// limits, and exposes full pipeline state — binding to 0.0.0.0 or any
// LAN-routable address makes that state available to anyone on the
// network. The guard exists to make sure a remote bind is a conscious
// choice, not a typo.

const http = require("node:http");
const fs = require("node:fs");
const path = require("node:path");
const { spawn } = require("node:child_process");

const STATIC_DIR = path.join(__dirname, "static");
const MIME = {
  ".html": "text/html; charset=utf-8",
  ".js":   "application/javascript; charset=utf-8",
  ".css":  "text/css; charset=utf-8",
  ".json": "application/json",
  ".svg":  "image/svg+xml",
  ".ico":  "image/x-icon",
};
const SECURITY_HEADERS = {
  "content-security-policy": "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; connect-src 'self'; img-src 'self' data:; object-src 'none'; base-uri 'none'; frame-ancestors 'none'",
  "referrer-policy": "no-referrer",
  "x-content-type-options": "nosniff",
};

function sendJSON(res, status, body) {
  res.writeHead(status, { ...SECURITY_HEADERS, "content-type": "application/json", "cache-control": "no-store" });
  res.end(JSON.stringify(body, null, 2));
}

function sendText(res, status, body, mime = "text/plain; charset=utf-8") {
  res.writeHead(status, { ...SECURITY_HEADERS, "content-type": mime, "cache-control": "no-store" });
  res.end(body);
}

function serveStatic(req, res) {
  const file = req.url === "/" ? "/index.html" : req.url;
  const safe = path.normalize(file).replace(/^[/\\]+/, "");
  if (safe.includes("..")) { sendText(res, 403, "Forbidden"); return; }
  const full = path.join(STATIC_DIR, safe);
  if (!fs.existsSync(full) || !fs.statSync(full).isFile()) {
    sendText(res, 404, "Not Found");
    return;
  }
  const mime = MIME[path.extname(full)] || "application/octet-stream";
  res.writeHead(200, { ...SECURITY_HEADERS, "content-type": mime, "cache-control": "no-store" });
  fs.createReadStream(full).pipe(res);
}

function buildState(cwd) {
  const { summary } = require("../orchestrator");
  const { listHosts } = require("../router");
  const { loadConfig } = require("../config");
  const { TRACKS } = require("../pipeline/stages");
  const s = summary({ cwd });
  return {
    cwd,
    track: s.track,
    rows: s.rows,
    hosts: listHosts(),
    tracks: TRACKS,
    config: loadConfig(cwd),
    timestamp: new Date().toISOString(),
  };
}

function loadGateFile(cwd, stageId) {
  // stageId can be "stage-04" (merged) or "stage-04.backend" (workstream)
  if (!/^stage-[a-z0-9.-]+$/i.test(stageId)) return null;
  // B9 exemption: the UI server serves the in-place pipeline view; bounded-mode
  // support (e.g. accepting ?changeId= query param) is a future UI enhancement.
  const file = path.join(cwd, "pipeline", "gates", `${stageId}.json`);
  if (!fs.existsSync(file)) return null;
  try { return JSON.parse(fs.readFileSync(file, "utf8")); } catch { return null; }
}

function loadRoleBrief(role) {
  if (!/^[a-z][a-z0-9-]*$/i.test(role)) return null;
  const file = path.join(__dirname, "..", "..", "roles", `${role}.md`);
  if (!fs.existsSync(file)) return null;
  return fs.readFileSync(file, "utf8");
}

// ---------------------------------------------------------------------------
// SSE event broker
// ---------------------------------------------------------------------------

function makeBroker() {
  const clients = new Set();
  function broadcast(event, data) {
    const payload = `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
    for (const res of clients) {
      try { res.write(payload); } catch { /* peer dropped */ }
    }
  }
  function addClient(res) {
    res.writeHead(200, {
      "content-type": "text/event-stream",
      "cache-control": "no-store",
      "connection": "keep-alive",
    });
    res.write(": connected\n\n");
    clients.add(res);
    res.on("close", () => clients.delete(res));
  }
  function size() { return clients.size; }
  function closeAll() { for (const c of clients) try { c.end(); } catch { /* */ } clients.clear(); }
  return { broadcast, addClient, size, closeAll };
}

function watchGates(cwd, broker, opts = {}) {
  // B9 exemption: watches the in-place gates dir only (see loadGateFile comment).
  const gatesDir = path.join(cwd, "pipeline", "gates");
  if (!fs.existsSync(gatesDir)) {
    fs.mkdirSync(gatesDir, { recursive: true });
  }
  let debounceTimer = null;
  function fire() {
    clearTimeout(debounceTimer);
    debounceTimer = setTimeout(() => {
      broker.broadcast("state", buildState(cwd));
    }, 100);
  }
  const watchFn = opts.watchFn || fs.watch;
  const onError = opts.onError || ((err) => {
    process.stderr.write(`[devteam ui] could not watch ${gatesDir}: ${err.message}\n`);
  });
  let watcher = null;
  let closed = false;
  function close() {
    if (closed) return;
    closed = true;
    clearTimeout(debounceTimer);
    if (!watcher) return;
    if (typeof watcher.removeListener === "function") watcher.removeListener("error", handleError);
    try { watcher.close(); } catch { /* */ }
  }
  function handleError(err) {
    if (closed) return;
    onError(err);
    close();
  }
  try {
    watcher = watchFn(gatesDir, { persistent: false }, fire);
    // Resource exhaustion such as EMFILE can arrive asynchronously after
    // fs.watch() returns. Without an error listener Node treats it as an
    // uncaught exception and takes down an otherwise healthy local UI server.
    if (watcher && typeof watcher.on === "function") watcher.on("error", handleError);
  } catch (err) {
    onError(err);
    closed = true;
  }
  return close;
}

// ---------------------------------------------------------------------------
// HTTP server
// ---------------------------------------------------------------------------

// Hostnames that are unambiguously loopback. Anything else is treated as
// "potentially routable" and requires explicit opt-in via STAGECRAFT_UI_ALLOW_REMOTE=1.
const LOOPBACK_HOSTS = new Set(["127.0.0.1", "::1", "localhost"]);

function isLoopback(host) {
  if (!host) return true; // undefined → server picks loopback default
  return LOOPBACK_HOSTS.has(host);
}

function startServer(opts = {}) {
  // `port: 0` is the conventional "let the OS pick a free port" value used
  // by tests. Treat it as an explicit choice, not falsy fallback bait.
  const port = typeof opts.port === "number"
    ? opts.port
    : (Number(process.env.PORT) || 3737);
  const host = opts.host || "127.0.0.1";
  const cwd = opts.cwd || process.cwd();
  const broker = makeBroker();

  if (!isLoopback(host)) {
    if (process.env.STAGECRAFT_UI_ALLOW_REMOTE !== "1") {
      const err = new Error(
        `refusing to bind UI to non-loopback host "${host}" — the UI has no auth and exposes full pipeline state.\n` +
        `If this is intentional, set STAGECRAFT_UI_ALLOW_REMOTE=1 and re-run. Otherwise use 127.0.0.1.`,
      );
      err.code = "EREMOTEBIND";
      return Promise.reject(err);
    }
    process.stderr.write(
      `\n⚠️  [devteam ui] binding to non-loopback host "${host}". ` +
      `Pipeline state will be reachable to anyone who can connect to ${host}:${port}. ` +
      `The UI has no auth.\n\n`,
    );
  }

  const server = http.createServer((req, res) => {
    const url = req.url || "/";
    try {
      if (url === "/api/state") {
        sendJSON(res, 200, buildState(cwd));
        return;
      }
      if (url === "/api/next") {
        try {
          const { next } = require("../orchestrator");
          sendJSON(res, 200, next({ cwd }));
        } catch (err) {
          sendJSON(res, 500, { error: err.message });
        }
        return;
      }
      if (url.startsWith("/api/gate/")) {
        const stageId = url.slice("/api/gate/".length);
        const gate = loadGateFile(cwd, stageId);
        if (!gate) { sendJSON(res, 404, { error: `no gate for ${stageId}` }); return; }
        sendJSON(res, 200, gate);
        return;
      }
      if (url.startsWith("/api/role/")) {
        const role = url.slice("/api/role/".length);
        const brief = loadRoleBrief(role);
        if (!brief) { sendJSON(res, 404, { error: `no role brief for ${role}` }); return; }
        sendText(res, 200, brief, "text/markdown; charset=utf-8");
        return;
      }
      if (url === "/api/events") {
        broker.addClient(res);
        return;
      }
      serveStatic(req, res);
    } catch (err) {
      sendJSON(res, 500, { error: err.message });
    }
  });

  const stopWatch = watchGates(cwd, broker, {
    watchFn: opts.watchFn,
    onError: opts.onWatchError,
  });
  // Initial heartbeat so any newly-connected client sees state without
  // waiting for the first gate change.
  const setIntervalFn = opts.setIntervalFn || setInterval;
  const clearIntervalFn = opts.clearIntervalFn || clearInterval;
  const heartbeatTimer = setIntervalFn(
    () => broker.broadcast("heartbeat", { ts: Date.now() }),
    15000,
  );
  if (heartbeatTimer && typeof heartbeatTimer.unref === "function") heartbeatTimer.unref();
  const stopHeartbeat = () => clearIntervalFn(heartbeatTimer);

  return new Promise((resolve, reject) => {
    server.on("error", (err) => {
      stopWatch();
      stopHeartbeat();
      broker.closeAll();
      reject(err);
    });
    server.listen(port, host, () => {
      const actual = server.address();
      const url = `http://${actual.address}:${actual.port}/`;
      if (opts.open) tryOpen(url);
      resolve({
        url,
        server,
        close() {
          stopWatch();
          stopHeartbeat();
          broker.closeAll();
          return new Promise((r) => server.close(r));
        },
      });
    });
  });
}

function tryOpen(url) {
  // Use spawn with array args, NOT exec with shell-string interpolation —
  // even though the URL is bound by server.address() today (not user
  // input), the exec(cmd) shape is exactly the shell-injection pattern
  // CodeQL's js/shell-command-injection-from-environment rule flags.
  // Defense in depth against future URL-source changes.
  const [cmd, ...args] =
    process.platform === "darwin" ? ["open", url]
    : process.platform === "win32" ? ["cmd", "/c", "start", "", url]
    : ["xdg-open", url];
  try {
    const child = spawn(cmd, args, { detached: true, stdio: "ignore" });
    child.unref();
    // Ignore errors silently — opening the browser is a convenience, not
    // a contract. If the OS doesn't have `open`/`xdg-open`, that's fine.
    child.on("error", () => { /* not fatal */ });
  } catch { /* not fatal */ }
}

module.exports = { startServer, buildState, loadGateFile, loadRoleBrief };
