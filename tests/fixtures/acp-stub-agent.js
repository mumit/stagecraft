#!/usr/bin/env node
// Scripted ACP agent for tests/host-acp.test.js — no network, no real
// model. Speaks the ACP wire protocol (newline-delimited JSON-RPC 2.0)
// directly over stdio, independent of hosts/acp/jsonrpc.js, so a bug in
// the adapter's own framing code can't hide behind a shared implementation.
//
// Behavior is selected by env vars (set by the test, not argv, so the test
// controls it without touching the spawned argv the adapter builds):
//
//   ACP_STUB_MODE=normal              (default) requests permission to
//                                      edit ACP_STUB_ALLOWED_PATH, then on
//                                      allow writes ACP_STUB_GATE_JSON to
//                                      ACP_STUB_GATE_PATH.
//   ACP_STUB_MODE=out-of-scope-write  requests permission to edit
//                                      ACP_STUB_FORBIDDEN_PATH (expected to
//                                      be outside allowedWrites); records
//                                      the decision to ACP_STUB_DECISION_PATH
//                                      and never writes a gate.
//   ACP_STUB_MODE=dangerous-command   requests permission for an "execute"
//                                      tool call running `rm -rf /`; records
//                                      the decision to ACP_STUB_DECISION_PATH.
//   ACP_STUB_MODE=malformed           writes one garbage (non-JSON) line to
//                                      stdout after session/new, then idles.
//   ACP_STUB_MODE=hang                answers initialize/session/new but
//                                      never responds to session/prompt.

const readline = require("node:readline");
const fs = require("node:fs");

const MODE = process.env.ACP_STUB_MODE || "normal";

const rl = readline.createInterface({ input: process.stdin, terminal: false });
let nextId = 1;
const pending = new Map();

function send(obj) {
  process.stdout.write(JSON.stringify(obj) + "\n");
}

function request(method, params) {
  const id = nextId++;
  return new Promise((resolve, reject) => {
    pending.set(id, { resolve, reject });
    send({ jsonrpc: "2.0", id, method, params });
  });
}

function notify(method, params) {
  send({ jsonrpc: "2.0", method, params });
}

function respond(id, result) {
  send({ jsonrpc: "2.0", id, result });
}

const handlers = {
  initialize(params, id) {
    respond(id, {
      protocolVersion: params.protocolVersion,
      agentCapabilities: { loadSession: false, promptCapabilities: { image: false, audio: false } },
      agentInfo: { name: "stagecraft-acp-stub", version: "0.0.0-test" },
    });
  },

  "session/new"(params, id) {
    respond(id, { sessionId: "stub-session-1" });
  },

  async "session/prompt"(params, id) {
    notify("session/update", { sessionId: params.sessionId, update: { sessionUpdate: "agent_message_chunk", content: { type: "text", text: "stub agent working\n" } } });

    if (MODE === "hang") {
      return; // never respond — exercises the adapter's ctx.timeoutMs path
    }

    if (MODE === "malformed") {
      process.stdout.write("this is not json\n");
      return; // never respond either — the malformed line is the point
    }

    if (MODE === "out-of-scope-write" || MODE === "dangerous-command") {
      const toolCallId = "tc-1";
      const toolCall = MODE === "dangerous-command"
        ? { toolCallId, kind: "execute", title: "run rm -rf", status: "pending", rawInput: { command: "rm -rf /" } }
        : { toolCallId, kind: "edit", title: "edit forbidden file", status: "pending", locations: [{ path: process.env.ACP_STUB_FORBIDDEN_PATH }] };

      notify("session/update", { sessionId: params.sessionId, update: { sessionUpdate: "tool_call", ...toolCall } });
      const permResult = await request("session/request_permission", {
        sessionId: params.sessionId,
        toolCall,
        options: [
          { optionId: "allow", name: "Allow", kind: "allow_once" },
          { optionId: "reject", name: "Reject", kind: "reject_once" },
        ],
      });
      if (process.env.ACP_STUB_DECISION_PATH) {
        fs.writeFileSync(process.env.ACP_STUB_DECISION_PATH, JSON.stringify(permResult) + "\n", "utf8");
      }
      const allowed = permResult && permResult.outcome && permResult.outcome.outcome === "selected" && permResult.outcome.optionId === "allow";
      notify("session/update", { sessionId: params.sessionId, update: { sessionUpdate: "tool_call_update", toolCallId, status: allowed ? "completed" : "failed" } });
      respond(id, { stopReason: allowed ? "end_turn" : "refusal" });
      return;
    }

    // normal: request permission to edit an allowed file, then write the gate.
    const toolCallId = "tc-1";
    const toolCall = { toolCallId, kind: "edit", title: "edit allowed file", status: "pending", locations: [{ path: process.env.ACP_STUB_ALLOWED_PATH }] };
    notify("session/update", { sessionId: params.sessionId, update: { sessionUpdate: "tool_call", ...toolCall } });
    const permResult = await request("session/request_permission", {
      sessionId: params.sessionId,
      toolCall,
      options: [
        { optionId: "allow", name: "Allow", kind: "allow_once" },
        { optionId: "reject", name: "Reject", kind: "reject_once" },
      ],
    });
    const allowed = permResult && permResult.outcome && permResult.outcome.outcome === "selected" && permResult.outcome.optionId === "allow";
    notify("session/update", { sessionId: params.sessionId, update: { sessionUpdate: "tool_call_update", toolCallId, status: allowed ? "completed" : "failed" } });
    if (allowed && process.env.ACP_STUB_GATE_PATH) {
      fs.mkdirSync(require("node:path").dirname(process.env.ACP_STUB_GATE_PATH), { recursive: true });
      fs.writeFileSync(process.env.ACP_STUB_GATE_PATH, process.env.ACP_STUB_GATE_JSON || "{}", "utf8");
    }
    respond(id, { stopReason: "end_turn" });
  },

  "session/close"(params, id) {
    respond(id, {});
  },
};

rl.on("line", (line) => {
  if (!line.trim()) return;
  let msg;
  try {
    msg = JSON.parse(line);
  } catch {
    return; // ignore garbage sent to us; not under test here
  }

  // Response to a request WE sent (session/request_permission).
  if (msg.id !== undefined && msg.method === undefined) {
    const p = pending.get(msg.id);
    if (!p) return;
    pending.delete(msg.id);
    if (msg.error) p.reject(new Error(msg.error.message));
    else p.resolve(msg.result);
    return;
  }

  // Request from the client.
  if (msg.method !== undefined && msg.id !== undefined) {
    const handler = handlers[msg.method];
    if (handler) {
      Promise.resolve(handler(msg.params || {}, msg.id)).catch(() => {
        send({ jsonrpc: "2.0", id: msg.id, error: { code: -32603, message: "stub handler error" } });
      });
    } else {
      send({ jsonrpc: "2.0", id: msg.id, error: { code: -32601, message: `stub: no handler for ${msg.method}` } });
    }
  }
});

process.stdin.on("end", () => process.exit(0));
