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
// Both paths render as absolute stateRoot paths in review mode
// (core/adapters/render-helpers.js's resolveFrameworkPath, reused for these
// two write targets as of the 36.4 fix-up — previously they were relative,
// which would have resolved against this process's session cwd, the SUBJECT
// per ctx.processCwd/codeRoot, review mode's whole point). ACP_STUB_WORKSPACE_ROOT
// is kept as a fallback (resolveAgainstWorkspace() below) for a relative
// path, matching how tests/fixtures/acp-stub-agent.js is told the workspace
// path directly rather than deriving it — belt-and-suspenders, not load-
// bearing for this fix.
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

// PEER_REVIEW_SIZING.full's four review areas (core/pipeline/stages.js) —
// review-only falls through to this sizing (see stages.js's why-comment on
// the "review-only" track entry).
const PEER_REVIEW_AREAS = ["backend", "frontend", "platform", "qa"];

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
  // No stage-05 branch: that gate is derived (core/hooks/approval-derivation.js
  // via the 36.4 fix-up in hosts/acp/adapter.js), never written directly —
  // see the "session/prompt" handler below.
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
    const artifactRaw = extractFirstMatch(text, /^Produce `([^`]+)`.*\.$/m);
    const artifactPath = artifactRaw ? artifactRaw.replace(/<[^>]+>/g, role) : null;
    const gatePathRaw = extractFirstMatch(text, /^Write to `([^`]+)`\. You provide:$/m);

    if (!workstreamId || !gatePathRaw) {
      respond(id, { stopReason: "refusal" });
      return;
    }

    // 36.4's write-target fix-up (core/adapters/render-helpers.js's
    // resolveFrameworkPath, reused for the gate/artifact lines) means these
    // are already absolute stateRoot paths in review mode — resolveAgainstWorkspace
    // only matters as a fallback for a relative single-root prompt (not this
    // stub's use case, but cheap to keep correct either way).
    function resolveAgainstWorkspace(p) {
      return path.isAbsolute(p) ? p : path.join(WORKSPACE_ROOT, p);
    }
    const artifactAbs = artifactPath ? resolveAgainstWorkspace(artifactPath) : null;
    const gateAbs = resolveAgainstWorkspace(gatePathRaw);
    const toolCallId = "tc-1";
    const toolCall = {
      toolCallId, kind: "edit", title: "edit artifact",
      status: "pending",
      locations: [{ path: artifactAbs || gateAbs }],
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
        // stage-05's gate is never written directly below — since the 36.4
        // fix-up (out-of-scope finding #2), hosts/acp/adapter.js derives it
        // itself from this file's "## Review of <area>" + "REVIEW:" markers
        // (core/hooks/approval-derivation.js#deriveForProject), the same way
        // core/adapters/headless.js already does for codex/openai-compat.
        // Every other stage's artifact has no such derivation and gets a
        // gate written directly below, same as before.
        // deriveForProject() skips a "## Review of <area>" section when
        // <area> === the reviewer's own workstream role ("Reviewers must
        // come from a different area", .devteam/rules/pipeline.md §Stage
        // 5) — self-review would never derive a gate at all. So each
        // reviewer here reviews every OTHER area, giving each of the 4
        // areas 3 external approvals (>= PEER_REVIEW_SIZING.full's
        // required_approvals=2).
        const content = stageId === "stage-05"
          ? PEER_REVIEW_AREAS.filter((a) => a !== role).map((a) => `## Review of ${a}\n\nREVIEW: APPROVED\n`).join("\n")
          : `# stub artifact for ${workstreamId}\n\nNo findings.\n`;
        fs.writeFileSync(artifactAbs, content, "utf8");
      }
      if (stageId !== "stage-05") {
        fs.mkdirSync(path.dirname(gateAbs), { recursive: true });
        fs.writeFileSync(gateAbs, JSON.stringify(gateSkeletonFor(stageId, role), null, 2), "utf8");
      }
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
