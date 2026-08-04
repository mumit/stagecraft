#!/usr/bin/env node
// Scripted ACP agent for tests/review-command.test.js (phase-36 item 36.4,
// plans/phase-36-external-review-mode.md §36.4) — no network, no real model.
//
// Unlike tests/fixtures/acp-stub-agent.js (which needs one fixed
// ACP_STUB_GATE_PATH per process, fine for a single runStageHeadless() call),
// `devteam review` drives the WHOLE review-only track — three stages, one of
// them (peer-review) fanned out across four role workstreams — in one
// process, spawning this stub once per workstream with the same env. So this
// stub derives what to write from the rendered prompt itself rather than a
// fixed env var:
//
//   "Workstream: <id> (role: <role>, host: ...)"  -> workstreamId, role
//   "Produce `<path>`."                            -> artifact path to write
//   "Write to `<path>`. You provide:"              -> gate path to write
//
// Both paths are relative to the review workspace (ctx.cwd / stateRoot), but
// this process's session cwd is the SUBJECT (ctx.processCwd / codeRoot,
// review mode's whole point) — see the honest scope note in
// tests/review-command.test.js about that gap for a *real* (non-scripted)
// agent. This stub sidesteps it the same way tests/fixtures/acp-stub-agent.js
// sidesteps path ambiguity generally: the test harness tells it the
// workspace's absolute path directly, via ACP_STUB_WORKSPACE_ROOT, rather
// than deriving it from context a real agent wouldn't have either.
//
// Gate content is a minimal PASS skeleton per stage id (mirrors
// tests/review-workspace.test.js's passGateFor()) — this stub is testing the
// orchestration plumbing (roots, permissions, findings collection), not
// approval-derivation hooks or red-team heuristics.

const readline = require("node:readline");
const fs = require("node:fs");
const path = require("node:path");

const WORKSPACE_ROOT = process.env.ACP_STUB_WORKSPACE_ROOT;
if (!WORKSPACE_ROOT) {
  process.stderr.write("acp-stub-review-agent: ACP_STUB_WORKSPACE_ROOT is required\n");
  process.exit(1);
}

const rl = readline.createInterface({ input: process.stdin, terminal: false });
let nextId = 1;
const pending = new Map();

function send(obj) { process.stdout.write(`${JSON.stringify(obj)}\n`); }
function request(method, params) {
  const id = nextId++;
  return new Promise((resolve, reject) => {
    pending.set(id, { resolve, reject });
    send({ jsonrpc: "2.0", id, method, params });
  });
}
function notify(method, params) { send({ jsonrpc: "2.0", method, params }); }
function respond(id, result) { send({ jsonrpc: "2.0", id, result }); }

function extractFirstMatch(text, re) {
  const m = re.exec(text);
  return m ? m[1] : null;
}

// Same shapes tests/review-workspace.test.js's passGateFor() uses, minus the
// workstream-count-1-vs-many distinction (not relevant to gate content).
function gateSkeletonFor(stageId, role) {
  const base = {
    stage: stageId,
    status: "PASS",
    orchestrator: "devteam@test-stub",
    host: "acp",
    track: "review-only",
    timestamp: new Date().toISOString(),
    blockers: [],
    warnings: [],
    workstream: role,
  };
  if (stageId === "stage-04b") {
    return { ...base, security_approved: true, veto: false, triggering_conditions: [] };
  }
  if (stageId === "stage-04c") {
    return {
      ...base,
      surfaces_walked: [],
      findings_count: 0,
      severity_breakdown: { critical: 0, high: 0, medium: 0, low: 0 },
      must_address_before_peer_review: [],
      noted_for_followup: [],
    };
  }
  if (stageId === "stage-05") {
    return {
      ...base,
      review_shape: "matrix",
      required_approvals: 2,
      approvals: [role],
      changes_requested: [],
      escalated_to_principal: false,
    };
  }
  return base;
}

const handlers = {
  initialize(params, id) {
    respond(id, {
      protocolVersion: params.protocolVersion,
      agentCapabilities: { loadSession: false, promptCapabilities: { image: false, audio: false } },
      agentInfo: { name: "stagecraft-acp-stub-review", version: "0.0.0-test" },
    });
  },

  "session/new"(params, id) {
    respond(id, { sessionId: "stub-review-session" });
  },

  async "session/prompt"(params, id) {
    const text = (params.prompt || []).map((b) => b.text || "").join("\n");

    const workstreamId = extractFirstMatch(text, /^Workstream: (\S+) \(role: (\S+), host: \S+\)$/m);
    const role = (/^Workstream: \S+ \(role: (\S+), host: \S+\)$/m.exec(text) || [])[1] || "unknown";
    // descriptor.artifact ships placeholder tokens like `<reviewer>` literally
    // (core/adapters/render-helpers.js's "Note: <name> tokens are
    // placeholders — substitute your actual value" instruction) — a real
    // agent substitutes them by hand; this stub does the same.
    const artifactRelRaw = extractFirstMatch(text, /^Produce `([^`]+)`.*\.$/m);
    const artifactRel = artifactRelRaw ? artifactRelRaw.replace(/<[^>]+>/g, role) : null;
    const gateRel = extractFirstMatch(text, /^Write to `([^`]+)`\. You provide:$/m);

    if (!workstreamId || !gateRel) {
      respond(id, { stopReason: "refusal" });
      return;
    }

    const artifactAbs = artifactRel ? path.join(WORKSPACE_ROOT, artifactRel) : null;
    const toolCallId = "tc-1";
    const toolCall = {
      toolCallId, kind: "edit", title: "edit artifact",
      status: "pending",
      locations: [{ path: artifactAbs || path.join(WORKSPACE_ROOT, gateRel) }],
    };
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

    if (allowed) {
      const stageId = workstreamId.split(".")[0];
      if (artifactAbs) {
        fs.mkdirSync(path.dirname(artifactAbs), { recursive: true });
        // stage-05's merge step independently re-derives approval state from
        // this file's "## Review of <area>" + "REVIEW:" markers
        // (core/hooks/approval-derivation.js's parseReviewFile()) and FAILs
        // the gate if the workstream gate's approval claim isn't backed by
        // one — trust boundary, item 10: the gate is a claim, this file (or
        // rather, what the orchestrator re-parses from it) is what's
        // verified. Every other stage's artifact has no such re-derivation.
        const content = stageId === "stage-05"
          ? `## Review of ${role}\n\nREVIEW: APPROVED\n`
          : `# stub artifact for ${workstreamId}\n\nNo findings.\n`;
        fs.writeFileSync(artifactAbs, content, "utf8");
      }
      const gateAbs = path.join(WORKSPACE_ROOT, gateRel);
      fs.mkdirSync(path.dirname(gateAbs), { recursive: true });
      fs.writeFileSync(gateAbs, JSON.stringify(gateSkeletonFor(stageId, role), null, 2), "utf8");
    }

    respond(id, { stopReason: allowed ? "end_turn" : "refusal" });
  },

  "session/close"(params, id) { respond(id, {}); },
};

rl.on("line", (line) => {
  if (!line.trim()) return;
  let msg;
  try { msg = JSON.parse(line); } catch { return; }

  if (msg.id !== undefined && msg.method === undefined) {
    const p = pending.get(msg.id);
    if (!p) return;
    pending.delete(msg.id);
    if (msg.error) p.reject(new Error(msg.error.message));
    else p.resolve(msg.result);
    return;
  }

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
