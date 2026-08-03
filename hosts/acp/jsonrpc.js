// Minimal Agent Client Protocol (ACP) JSON-RPC 2.0 client.
//
// ACP (agentclientprotocol.com, protocol version 1 — pinned in
// capabilities.json's acpProtocolVersion) runs JSON-RPC 2.0 over the
// agent's stdio: newline-delimited messages, one per line, no embedded
// newlines, agent stdout carries ONLY protocol messages (stderr is for the
// agent's own logging — see hosts/acp/adapter.js, which tees it into the
// transcript log). Verified against the published schema
// (schema/v1/schema.json in zed-industries/agent-client-protocol) rather
// than prose docs alone, since the docs site omits transport framing.
//
// Stagecraft is always the ACP *client* here (hosts/acp/adapter.js drives
// an agent subprocess); this module is deliberately two-directional
// because ACP itself is: the client sends requests (initialize,
// session/new, session/prompt) and the agent sends requests back
// (session/request_permission) plus notifications (session/update). Each
// side of a request must be answered — including agent-sent requests we
// don't support (fs/*, terminal/*, given we declare no client capability
// for them) — an ACP agent that gets no response at all will wait forever.
//
// No npm dependency: the wire format is ~20 lines of framing over a
// handful of methods, and Stagecraft already hand-rolls comparable
// line-JSON extractors for claude-code/codex
// (core/adapters/claude-stream-json.js, codex-exec-json.js) rather than
// vendoring a client library for those.

class AcpClient {
  // handlers: { onNotification(method, params), onRequest(method, params) → Promise<result>,
  //             onMalformed({ line, error }) }
  constructor(child, handlers = {}) {
    this.child = child;
    this._onNotification = handlers.onNotification || (() => {});
    this._onRequest = handlers.onRequest || null;
    this._onMalformed = handlers.onMalformed || (() => {});
    this._nextId = 1;
    this._pending = new Map();
    this._buf = "";
    this._closed = false;

    child.stdout.on("data", (chunk) => this._onData(chunk));
    child.stdin.on("error", () => { /* agent closed stdin early */ });
    child.on("close", () => this._onClose());
  }

  _onData(chunk) {
    this._buf += chunk.toString("utf8");
    let idx;
    while ((idx = this._buf.indexOf("\n")) >= 0) {
      const line = this._buf.slice(0, idx);
      this._buf = this._buf.slice(idx + 1);
      if (line.trim().length > 0) this._handleLine(line);
    }
  }

  _handleLine(line) {
    let msg;
    try {
      msg = JSON.parse(line);
    } catch (err) {
      this._onMalformed({ line, error: err.message });
      return;
    }
    if (!msg || typeof msg !== "object") {
      this._onMalformed({ line, error: "message is not a JSON object" });
      return;
    }

    // Response to a request WE sent (initialize / session/new / session/prompt / ...).
    if (msg.id !== undefined && msg.method === undefined) {
      const pending = this._pending.get(msg.id);
      if (!pending) return; // unknown id (duplicate/late response) — ignore
      this._pending.delete(msg.id);
      if (msg.error) {
        pending.reject(new Error(`ACP error ${msg.error.code}: ${msg.error.message}`));
      } else {
        pending.resolve(msg.result);
      }
      return;
    }

    // Request FROM the agent (session/request_permission, fs/*, terminal/*).
    if (msg.method !== undefined && msg.id !== undefined) {
      this._handleIncomingRequest(msg);
      return;
    }

    // Notification FROM the agent (session/update).
    if (msg.method !== undefined) {
      this._onNotification(msg.method, msg.params);
      return;
    }

    this._onMalformed({ line, error: "unrecognized JSON-RPC message shape" });
  }

  async _handleIncomingRequest(msg) {
    try {
      if (!this._onRequest) throw new Error(`no request handler installed for "${msg.method}"`);
      const result = await this._onRequest(msg.method, msg.params);
      this._send({ jsonrpc: "2.0", id: msg.id, result: result === undefined ? {} : result });
    } catch (err) {
      // JSON-RPC -32601: Method not found — the closest standard code for
      // "the client declared no capability for this method" (fs/*,
      // terminal/*) as well as any handler-internal failure.
      this._send({ jsonrpc: "2.0", id: msg.id, error: { code: -32601, message: err.message } });
    }
  }

  _send(obj) {
    if (this._closed) return;
    try {
      this.child.stdin.write(JSON.stringify(obj) + "\n");
    } catch { /* stdin closed — agent already exiting */ }
  }

  request(method, params) {
    const id = this._nextId++;
    return new Promise((resolve, reject) => {
      this._pending.set(id, { resolve, reject });
      this._send({ jsonrpc: "2.0", id, method, params });
    });
  }

  notify(method, params) {
    this._send({ jsonrpc: "2.0", method, params });
  }

  _onClose() {
    this._closed = true;
    for (const { reject } of this._pending.values()) {
      reject(new Error("ACP agent process closed before responding"));
    }
    this._pending.clear();
  }
}

module.exports = { AcpClient };
