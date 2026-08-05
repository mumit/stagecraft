// Agent Client Protocol (ACP) host adapter.
//
// ACP (agentclientprotocol.com; protocol version pinned in
// capabilities.json's `acpProtocolVersion`, verified against
// zed-industries/agent-client-protocol schema/v1/schema.json) standardizes
// the client/agent boundary Stagecraft otherwise hand-maintains per host —
// this adapter speaks ACP as the *client* over stdio to whatever agent
// command a project configures, so any ACP-compatible coding agent becomes
// a Stagecraft host with zero per-agent code (plans/phase-34-interop-
// auditable-sdlc.md §34.1).
//
// Dispatch = spawn the configured agent → initialize → session/new →
// session/prompt with the rendered stage prompt → stream session/update
// notifications into pipeline/logs/<workstreamId>.log → resolve once the
// prompt turn ends (stopReason) and the gate file is checked (the existing
// hooks:false poll fallback in core/orchestrator.js covers any residual
// race between "turn ended" and "gate file visible on disk").
//
// Enforcement: every ACP tool call is a `session/request_permission`
// round-trip BEFORE it executes (hosts/acp/permissions.js maps
// allowed-writes + a claude-code-parity dangerous-command stoplist onto
// allow/deny there) — capabilities.json declares allowed_writes and
// stoplist as "tool-call-time", making this the first non-claude-code host
// with call-time enforcement (claude-code's own tool-call-time enforcement
// is static per-project permission globs; ACP's is the live, per-dispatch
// descriptor.allowedWrites list — see hosts/acp/permissions.js header).
//
// Routing: `routing.roles.<role>: "acp:<agent-command>"` carries the launch
// command inline (core/config.js normalizeRouteValue) since there is no
// single default ACP binary the way there is for claude/codex/gemini.
// Precedence for resolving the actual command, highest first:
//   1. DEVTEAM_HEADLESS_COMMAND (universal test/emergency override)
//   2. descriptor.agentCommand (the "acp:<command>" routing form)
//   3. .devteam/config.yml hosts.acp.command (project-wide default)
//   4. capabilities.headlessCommand (reference default)

const fs = require("node:fs");
const path = require("node:path");
const { spawn } = require("node:child_process");

const { version: STAGECRAFT_VERSION } = require("../../package.json");
const capabilities = require("./capabilities.json");
const { AcpClient } = require("./jsonrpc");
const { evaluateToolCall, selectOption } = require("./permissions");
const { makeMarkdownHostAdapter } = require("../../core/adapters/markdown-host");
const { splitCommand } = require("../../core/command-line");
const { loadConfig } = require("../../core/config");
const { gatesDir, logsDir } = require("../../core/paths");
const { terminateChild } = require("../../core/process-kill");
const {
  createTranscriptWriter,
  rotateLog,
  DEFAULT_TIMEOUT_MS,
} = require("../../core/adapters/headless");

const shared = makeMarkdownHostAdapter(capabilities);
const ACP_PROTOCOL_VERSION = capabilities.acpProtocolVersion;

// Best-effort optional call — never lets a missing/unsupported method (or a
// slow one) hold up ending the turn.
function withTimeout(promise, ms) {
  return Promise.race([
    promise,
    new Promise((resolve) => setTimeout(resolve, ms)),
  ]);
}

function optionalString(value) {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

// Resolution order documented in the file header. Every step is a plain
// string command; splitCommand() (below, in invoke()) turns it into an
// executable + argv.
function resolveAgentCommand(descriptor, ctx) {
  const override = optionalString(process.env.DEVTEAM_HEADLESS_COMMAND);
  if (override) return override;
  const routed = optionalString(descriptor && descriptor.agentCommand);
  if (routed) return routed;
  let raw = {};
  try {
    raw = loadConfig(ctx.cwd || process.cwd())?._raw?.hosts?.acp || {};
  } catch {
    raw = {};
  }
  const configured = optionalString(raw.command);
  if (configured) return configured;
  return capabilities.headlessCommand;
}

// Render one line of human-readable transcript text for a session/update
// notification. Returns null for update kinds not worth teeing into the
// log verbatim (e.g. "plan" — structural, not prose). ContentBlock shapes
// per the ACP schema: agent_message_chunk/agent_thought_chunk/
// user_message_chunk flatten ContentChunk (a `content` field carrying one
// ContentBlock); tool_call/tool_call_update flatten ToolCall/ToolCallUpdate
// directly onto the update object.
function formatSessionUpdate(update) {
  if (!update || typeof update !== "object") return null;
  switch (update.sessionUpdate) {
    case "agent_message_chunk":
    case "agent_thought_chunk":
    case "user_message_chunk": {
      const block = update.content;
      if (block && block.type === "text" && typeof block.text === "string") return block.text;
      return null;
    }
    case "tool_call":
      return `\n[tool_call ${update.kind || "other"}] ${update.title || update.toolCallId || ""} (${update.status || "pending"})\n`;
    case "tool_call_update":
      return update.status
        ? `[tool_call_update] ${update.toolCallId || ""} → ${update.status}\n`
        : null;
    default:
      return null;
  }
}

// Tool calls arrive in pieces: `session/update` "tool_call" carries the
// full initial shape, "tool_call_update" carries only changed fields, and
// the toolCall embedded in a `session/request_permission` request is typed
// as a partial ToolCallUpdate too (only toolCallId is guaranteed). Track
// what we've seen per session so a permission decision always evaluates
// against the fullest picture available, regardless of which message
// happened to carry which field.
function mergeToolCallInfo(knownToolCalls, update) {
  if (!update || !update.toolCallId) return;
  const prior = knownToolCalls.get(update.toolCallId) || {};
  const merged = { ...prior };
  for (const [key, value] of Object.entries(update)) {
    if (value !== null && value !== undefined) merged[key] = value;
  }
  knownToolCalls.set(update.toolCallId, merged);
}

async function handlePermissionRequest(params, descriptor, roots, knownToolCalls, appendLog) {
  const requested = (params && params.toolCall) || {};
  const known = (requested.toolCallId && knownToolCalls.get(requested.toolCallId)) || {};
  const toolCall = { ...known, ...requested };
  const options = Array.isArray(params && params.options) ? params.options : [];

  const { deny, reason } = evaluateToolCall(toolCall, descriptor, roots);
  const chosen = selectOption(options, deny);
  appendLog(
    `[devteam] permission-request kind=${toolCall.kind || "?"} ` +
    `title=${JSON.stringify(toolCall.title || "")} decision=${deny ? "DENY" : "ALLOW"}` +
    `${reason ? ` (${reason})` : ""}${!chosen ? " [no matching option — cancelling]" : ""}\n`,
  );
  if (!chosen) return { outcome: { outcome: "cancelled" } };
  return { outcome: { outcome: "selected", optionId: chosen.optionId } };
}

function invoke(descriptor, ctx, preRenderedPrompt) {
  const prompt = preRenderedPrompt || shared.renderStagePrompt(descriptor, ctx);
  const cmdString = resolveAgentCommand(descriptor, ctx);
  let bin, args;
  try {
    ({ bin, args } = splitCommand(cmdString, "headlessCommand"));
  } catch (err) {
    return Promise.reject(new Error(`invalid ACP headlessCommand "${cmdString}": ${err.message}`));
  }

  const processCwd = ctx.processCwd || ctx.cwd;
  const sessionCwd = path.resolve(processCwd);
  const gatePath = path.join(gatesDir(ctx.cwd, ctx.changeId), `${descriptor.workstreamId}.json`);

  // Two-root permission model (36.1, plans/phase-36-external-review-mode.md
  // §36.1). ctx.externalReviewMode is not set by any orchestrator path yet
  // (36.3/36.4 wire the review workspace that sets it) — until then this is
  // always "normal" mode, codeRoot === stateRoot === processCwd, which is
  // byte-identical to the single-cwd behaviour this replaces.
  let reviewExecAllowlist = [];
  try {
    const raw = loadConfig(ctx.cwd || process.cwd())?._raw?.hosts?.acp || {};
    reviewExecAllowlist = Array.isArray(raw.review?.exec_allowlist) ? raw.review.exec_allowlist : [];
  } catch {
    reviewExecAllowlist = [];
  }
  // 36.5: ctx.noCodeRoot is the explicit opt-in for "this review genuinely
  // has no subject on disk" (a PR diff, not a checkout) — codeRoot must be a
  // real `null` here, not `processCwd`'s own `ctx.processCwd || ctx.cwd`
  // fallback, or permissions.js's `findWriteViolation` would see codeRoot ===
  // stateRoot and deny every write as "inside the subject". When
  // ctx.processCwd is merely omitted (ctx.noCodeRoot unset), codeRoot stays
  // processCwd (== ctx.cwd) — the existing fail-closed-by-default behavior
  // for a review-mode dispatch that forgot to set up a real code/state split.
  const permissionRoots = {
    codeRoot: ctx.noCodeRoot === true ? null : processCwd,
    stateRoot: ctx.cwd,
    mode: ctx.externalReviewMode === true ? "review" : "normal",
    execAllowlist: reviewExecAllowlist,
  };
  const start = Date.now();
  const timeoutMs = typeof ctx.timeoutMs === "number" ? ctx.timeoutMs : DEFAULT_TIMEOUT_MS;

  const logDisabled = process.env.DEVTEAM_NO_LOG === "1" || ctx.log === false;
  const liveTee = ctx.tee === true ||
    process.env.DEVTEAM_HEADLESS_TEE === "1" ||
    process.env.DEVTEAM_VERBOSE === "1";

  let logPath = null;
  let logWriter = null;
  let logEnded = false;
  if (!logDisabled) {
    try {
      const logsDirPath = logsDir(ctx.cwd, ctx.changeId);
      fs.mkdirSync(logsDirPath, { recursive: true });
      logPath = path.join(logsDirPath, `${descriptor.workstreamId}.log`);
      const rawHistory = process.env.DEVTEAM_LOG_HISTORY;
      const maxHistory = (rawHistory !== undefined && Number.isFinite(parseInt(rawHistory, 10)) && parseInt(rawHistory, 10) >= 0)
        ? parseInt(rawHistory, 10)
        : 3;
      rotateLog(logPath, maxHistory);
      logWriter = createTranscriptWriter(logPath, [
        `# Stage transcript: ${descriptor.workstreamId}`,
        "# Host: acp",
        `# Command: ${[bin, ...args].join(" ")}`,
        `# Started: ${new Date().toISOString()}`,
        "# ---",
        "",
        "",
      ].join("\n"));
    } catch {
      logPath = null;
      logWriter = null;
    }
  }
  function appendLog(text) {
    if (text == null) return;
    if (liveTee) {
      try { process.stdout.write(text); } catch { /* closed pipe */ }
    }
    logWriter?.append(text);
  }
  function endLog(reason) {
    if (!logPath || logEnded) return;
    logEnded = true;
    logWriter?.end(`\n# ---\n# Ended: ${new Date().toISOString()}\n# Exit: ${reason}\n`);
  }

  return new Promise((resolve, reject) => {
    let child;
    try {
      child = spawn(bin, args, { cwd: processCwd, stdio: ["pipe", "pipe", "pipe"] });
    } catch (err) {
      reject(new Error(`acp invoke failed to spawn "${bin}": ${err.message}`));
      return;
    }

    let timedOut = false;
    let protocolError = null;
    let stopReason = null;
    let timer = null;
    if (timeoutMs > 0) {
      timer = setTimeout(() => {
        timedOut = true;
        terminateChild(child, { graceMs: 5000 });
      }, timeoutMs);
      timer.unref();
    }
    function clearTimer() {
      if (timer) { clearTimeout(timer); timer = null; }
    }

    // Per spec, the agent MAY write UTF-8 logging text to stderr (stdout
    // carries ONLY protocol messages) — tee it into the same transcript.
    if (logWriter !== null) {
      child.stderr.on("data", (chunk) => appendLog(chunk.toString("utf8")));
    }

    const knownToolCalls = new Map();
    const client = new AcpClient(child, {
      onNotification(method, params) {
        if (method !== "session/update") return;
        const update = params && params.update;
        if (update && (update.sessionUpdate === "tool_call" || update.sessionUpdate === "tool_call_update")) {
          mergeToolCallInfo(knownToolCalls, update);
        }
        appendLog(formatSessionUpdate(update));
      },
      async onRequest(method, params) {
        if (method === "session/request_permission") {
          return handlePermissionRequest(params, descriptor, permissionRoots, knownToolCalls, appendLog);
        }
        // We declared clientCapabilities.fs = {readTextFile:false,
        // writeTextFile:false} and terminal:false — an agent that calls
        // fs/* or terminal/* anyway gets a clean "not supported" instead
        // of Stagecraft silently acting as a file-IO/terminal proxy.
        throw new Error(`method not supported by this client: ${method}`);
      },
      onMalformed(info) {
        if (!protocolError) protocolError = info;
        appendLog(`[devteam] malformed ACP message, terminating session: ${info.error}\n`);
        terminateChild(child, { graceMs: 2000 });
      },
    });

    child.on("error", (err) => {
      clearTimer();
      endLog(`spawn error: ${err.message}`);
      reject(new Error(
        `acp invoke failed to spawn "${bin}": ${err.message}. Is the configured ACP agent installed and on PATH?`,
      ));
    });

    child.on("close", (exitCode) => {
      clearTimer();
      endLog(timedOut ? "TIMED OUT" : protocolError ? `PROTOCOL ERROR: ${protocolError.error}` : String(exitCode));

      // Derive peer-review gates from any by-*.md files written during this
      // session. ACP declared clientCapabilities.fs = {readTextFile:false,
      // writeTextFile:false} at initialize, so it has no claude-code-style
      // PostToolUse hook either — same gap core/adapters/headless.js already
      // closes for hooks:false CLI hosts (codex, openai-compat). Without
      // this, an ACP-routed peer-review dispatch has no automatic path from
      // a by-<role>.md review file to a derived stage-05.<role>.json gate
      // (36.4 fix-up, out-of-scope finding #2,
      // plans/phase-36-external-review-mode.md). Idempotent.
      if (!timedOut) {
        const codeReviewDir = path.join(ctx.cwd, "pipeline", "code-review");
        if (fs.existsSync(codeReviewDir)) {
          const { deriveForProject } = require("../../core/hooks/approval-derivation");
          for (const f of fs.readdirSync(codeReviewDir)) {
            if (/^by-[\w-]+\.md$/.test(f)) {
              const abs = path.join(codeReviewDir, f);
              if (fs.statSync(abs).mtimeMs >= start) {
                deriveForProject(abs, ctx.cwd);
              }
            }
          }
        }
      }

      const gateExists = fs.existsSync(gatePath);
      let isStub = false;
      if (gateExists) {
        try {
          const parsed = JSON.parse(fs.readFileSync(gatePath, "utf8"));
          isStub = parsed._stub === true;
        } catch { /* unreadable; validator will report it */ }
      }
      resolve({
        exitCode: timedOut ? null : exitCode,
        gatePath: gateExists && !isStub ? gatePath : null,
        stubGate: isStub,
        logPath,
        durationMs: Date.now() - start,
        timedOut,
        writeViolations: [],
        ...(protocolError ? { protocolError: protocolError.error } : {}),
        ...(stopReason ? { stopReason } : {}),
      });
    });

    // Drive the ACP session lifecycle: initialize → session/new →
    // session/prompt (one turn) → best-effort session/close → end.
    (async () => {
      try {
        await client.request("initialize", {
          protocolVersion: ACP_PROTOCOL_VERSION,
          clientCapabilities: { fs: { readTextFile: false, writeTextFile: false }, terminal: false },
          clientInfo: { name: "stagecraft", version: STAGECRAFT_VERSION },
        });
        const session = await client.request("session/new", { cwd: sessionCwd, mcpServers: [] });
        const promptResult = await client.request("session/prompt", {
          sessionId: session.sessionId,
          prompt: [{ type: "text", text: prompt }],
        });
        stopReason = (promptResult && promptResult.stopReason) || null;
        try {
          await withTimeout(client.request("session/close", { sessionId: session.sessionId }), 2000);
        } catch { /* optional method — not every agent implements it */ }
      } catch (err) {
        if (!protocolError) protocolError = { error: err.message };
      } finally {
        try { child.stdin.end(); } catch { /* already closed */ }
        terminateChild(child, { graceMs: 5000 });
      }
    })();
  });
}

module.exports = {
  capabilities,
  install: shared.install,
  uninstall: shared.uninstall,
  status: shared.status,
  renderStagePrompt: shared.renderStagePrompt,
  renderStagePromptLayers: shared.renderStagePromptLayers,
  invoke,
  resolveAgentCommand,
  formatSessionUpdate,
  mergeToolCallInfo,
  handlePermissionRequest,
};
