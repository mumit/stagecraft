// Headless invoke for the openai-compat host adapter.
//
// Unlike the claude-code / codex / gemini-cli adapters, this adapter has no
// CLI to spawn. Instead it drives the model directly via the OpenAI
// Chat Completions HTTP API, using function-calling to give the model
// file I/O capability (write_file, read_file, list_files).
//
// Configuration is resolved in priority order:
//   1. .devteam/config.yml → hosts.openai-compat.*
//   2. Environment variables (OPENAI_COMPAT_BASE_URL, _API_KEY, _MODEL)
//
// Per-role model selection (config.yml):
//   hosts:
//     openai-compat:
//       base_url: https://api.openai.com/v1
//       api_key_env: OPENAI_API_KEY         # env var holding the key
//       models:
//         default: gpt-4.1-mini
//         principal: gpt-4.1
//         security: gpt-4.1

const fs = require("node:fs");
const path = require("node:path");
const { gatesDir, logsDir, pipelineRoot } = require("../../core/paths");
const { loadConfig } = require("../../core/config");
const { snapshotWritables, auditWrites } = require("../../core/guards/write-audit");
const { computeCostUsd } = require("../../core/pricing");
const { buildTools, executeTool } = require("./tools");

const MAX_TOOL_ITERATIONS = 40;
const DEFAULT_TIMEOUT_MS = 10 * 60 * 1000;
const DEFAULT_MAX_TOKENS = 32768; // generous cap; models with lower hard limits self-cap via the API

// Resolve the three required config values for a given role.
function resolveConfig(ctx, role) {
  let cfg = {};
  try {
    const full = loadConfig(ctx.cwd);
    cfg = full?._raw?.hosts?.["openai-compat"] ?? {};
  } catch { /* config absent — fall back to env vars */ }

  const baseUrl =
    cfg.base_url ||
    process.env.OPENAI_COMPAT_BASE_URL ||
    "https://openrouter.ai/api/v1";

  const apiKeyEnv = cfg.api_key_env || "OPENAI_COMPAT_API_KEY";
  const apiKey = process.env[apiKeyEnv] || process.env.OPENAI_COMPAT_API_KEY;

  const models = cfg.models || {};
  const model =
    models[role] ||
    models.default ||
    process.env.OPENAI_COMPAT_MODEL;

  // Verbose: set hosts.openai-compat.verbose: true in config.yml or DEVTEAM_VERBOSE=1.
  // Quiet (default): only writes, bash failures, and errors are logged.
  const verbose = cfg.verbose === true || process.env.DEVTEAM_VERBOSE === "1";

  return { baseUrl, apiKey, model, verbose };
}

// Single HTTP call to the chat-completions endpoint.
async function callAPI(url, apiKey, model, messages, tools, timeoutMs) {
  const body = {
    model,
    messages,
    max_tokens: DEFAULT_MAX_TOKENS,
  };
  if (tools && tools.length > 0) {
    body.tools = tools;
    body.tool_choice = "auto";
  }

  const response = await fetch(url, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "Authorization": `Bearer ${apiKey}`,
      "HTTP-Referer": "https://github.com/telus-labs/stagecraft",
      "X-Title": "stagecraft/openai-compat",
    },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(timeoutMs),
  });

  if (!response.ok) {
    const text = await response.text().catch(() => "(unreadable body)");
    throw new Error(`API error ${response.status} from ${url}: ${text}`);
  }

  return response.json();
}

async function invoke(descriptor, ctx, preRenderedPrompt) {
  const role = descriptor.role;
  const { baseUrl, apiKey, model, verbose } = resolveConfig(ctx, role);

  if (!apiKey) {
    throw new Error(
      "openai-compat: no API key found. Set OPENAI_COMPAT_API_KEY (or api_key_env in " +
      ".devteam/config.yml hosts.openai-compat).",
    );
  }
  if (!model) {
    throw new Error(
      "openai-compat: no model configured. Set OPENAI_COMPAT_MODEL (or " +
      "hosts.openai-compat.models in .devteam/config.yml).",
    );
  }

  const adapter = require("./adapter");
  const prompt = preRenderedPrompt || adapter.renderStagePrompt(descriptor, ctx);
  const url = `${baseUrl.replace(/\/$/, "")}/chat/completions`;
  const timeoutMs =
    typeof ctx.timeoutMs === "number" && ctx.timeoutMs > 0
      ? ctx.timeoutMs
      : DEFAULT_TIMEOUT_MS;

  const tools = buildTools(descriptor);
  const messages = [{ role: "user", content: prompt }];

  process.stderr.write(
    verbose
      ? `[devteam] openai-compat: ${role} → ${model} at ${baseUrl}\n`
      : `[devteam] openai-compat: ${role} → ${model}\n`,
  );

  const beforeSnapshot = snapshotWritables(ctx.cwd);
  const start = Date.now();
  let iterations = 0;

  // Phase-28 item 28.2: accumulate `usage` across every turn of the tool
  // loop — a multi-turn dispatch bills once per completion, not once per
  // dispatch. cachedTokens comes from prompt_tokens_details.cached_tokens
  // (OpenAI-style prompt caching); not every provider reports it.
  let observedPromptTokens = 0;
  let observedCompletionTokens = 0;
  let observedCachedTokens = 0;
  let sawUsage = false;
  let observedModel = null;

  while (iterations < MAX_TOOL_ITERATIONS) {
    iterations++;
    let json;
    try {
      json = await callAPI(url, apiKey, model, messages, tools, timeoutMs);
    } catch (err) {
      throw new Error(`openai-compat invoke failed (iteration ${iterations}): ${err.message}`);
    }

    if (json.usage) {
      sawUsage = true;
      if (typeof json.usage.prompt_tokens === "number") observedPromptTokens += json.usage.prompt_tokens;
      if (typeof json.usage.completion_tokens === "number") observedCompletionTokens += json.usage.completion_tokens;
      const cached = json.usage.prompt_tokens_details?.cached_tokens;
      if (typeof cached === "number") observedCachedTokens += cached;
    }
    if (typeof json.model === "string") observedModel = json.model;

    const choice = json.choices?.[0];
    if (!choice) throw new Error("openai-compat: API returned no choices");

    const assistantMsg = choice.message;
    messages.push(assistantMsg);

    // Stream assistant text to stdout in verbose mode only.
    if (assistantMsg.content) {
      if (verbose) {
        process.stdout.write(assistantMsg.content);
        if (!assistantMsg.content.endsWith("\n")) process.stdout.write("\n");
      }
    }

    const finishReason = choice.finish_reason;
    const toolCalls = assistantMsg.tool_calls;

    if (!toolCalls || toolCalls.length === 0 || finishReason === "stop") {
      // Model is done.
      break;
    }

    // If max_tokens was hit the model's tool-call arguments may be truncated
    // (invalid JSON). Warn loudly — executeTool will return an error string,
    // but the model likely can't recover from half-written arguments.
    if (finishReason === "length") {
      process.stderr.write(
        `[devteam] openai-compat: warn: max_tokens hit at iteration ${iterations} — ` +
        `tool-call arguments may be truncated. Consider raising max_tokens in invoke.js or shortening the prompt.\n`,
      );
    }

    // Execute each tool call and collect results.
    const toolResults = [];
    for (const tc of toolCalls) {
      const result = await executeTool(tc, ctx.cwd, descriptor.allowedWrites || []);
      const tcName = tc.function?.name ?? "unknown";
      let parsedArgs;
      try { parsedArgs = JSON.parse(tc.function?.arguments || "{}"); } catch { parsedArgs = {}; }

      if (verbose) {
        // Verbose: log every tool call with a result summary.
        let argSummary;
        if (tcName === "write_file" || tcName === "read_file") argSummary = parsedArgs.path;
        else if (tcName === "list_files") argSummary = parsedArgs.dir ?? ".";
        else if (tcName === "bash") argSummary = (parsedArgs.command ?? "").slice(0, 80);
        else argSummary = "...";
        const resultSummary = result.startsWith("error:")
          ? result
          : result.slice(0, 100) + (result.length > 100 ? "…" : "");
        process.stderr.write(`[devteam] openai-compat: tool ${tcName}(${argSummary}) → ${resultSummary}\n`);
      } else {
        // Quiet: writes always; bash non-zero exits; any error result.
        if (tcName === "write_file") {
          process.stderr.write(`[devteam] openai-compat: ✎ ${parsedArgs.path ?? "?"}\n`);
        } else if (result.startsWith("error:")) {
          process.stderr.write(`[devteam] openai-compat: ⚠ ${tcName}(${parsedArgs.path ?? parsedArgs.dir ?? (parsedArgs.command ?? "").slice(0, 60) ?? "?"}) → ${result}\n`);
        } else if (tcName === "bash" && !result.startsWith("exit_code: 0\n")) {
          const resultSummary = result.slice(0, 300) + (result.length > 300 ? "…" : "");
          process.stderr.write(`[devteam] openai-compat: ✗ bash(${(parsedArgs.command ?? "").slice(0, 60)}) → ${resultSummary}\n`);
        }
        // read_file, list_files, bash exit 0 → silent in quiet mode
      }
      toolResults.push({
        role: "tool",
        tool_call_id: tc.id,
        content: result,
      });
    }
    messages.push(...toolResults);
  }

  if (iterations >= MAX_TOOL_ITERATIONS) {
    process.stderr.write(
      `[devteam] openai-compat: warn: hit ${MAX_TOOL_ITERATIONS}-iteration cap for ${descriptor.workstreamId}\n`,
    );
  }

  // Derive peer-review gates from any by-*.md files written during this
  // session. The PostToolUse hook that normally does this never fires for
  // httpNative hosts (hooks: false). Idempotent when no review files exist.
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

  // Post-hoc write audit. Orchestrator-internal files (heartbeats, state
  // transitions, advisory lock, transcript logs) are written between snapshots
  // but are never model-written — exempt them so they don't flip the gate to
  // FAIL in either in-place or bounded isolation.
  const afterSnapshot = snapshotWritables(ctx.cwd);
  const { violations: rawViolations } = auditWrites(
    beforeSnapshot,
    afterSnapshot,
    descriptor.allowedWrites || [],
  );
  const violations = rawViolations.filter((v) => !isOrchestratorWrite(ctx, v));
  // Logging deferred to orchestrator so sibling-workstream false positives
  // (parallel stage writes captured in this snapshot window) can be filtered
  // before any ⛔ line is emitted.

  const gatePath = path.join(
    gatesDir(ctx.cwd, ctx.changeId),
    `${descriptor.workstreamId}.json`,
  );
  const gateExists = fs.existsSync(gatePath);
  let isStub = false;
  if (gateExists) {
    try {
      const parsed = JSON.parse(fs.readFileSync(gatePath, "utf8"));
      isStub = parsed._stub === true;
    } catch { /* unreadable; treat as real gate */ }
  }

  // Phase-28 item 28.2: same usage/telemetry contract as claude-code's
  // stream-json extractor (core/adapters/claude-stream-json.js) — usage is
  // null and telemetry is "unavailable" when the API never reported usage,
  // so the orchestrator's generic `if (r.usage)` gate patch (core/orchestrator.js)
  // skips a mutation rather than writing zeros. Unlike claude-code, the API
  // never reports its own bill — cost_usd is computed from the pricing table,
  // and is null for unpriced models rather than a guess.
  const usage = sawUsage
    ? {
        tokensIn: observedPromptTokens,
        tokensOut: observedCompletionTokens,
        ...(observedCachedTokens > 0 ? { cachedTokens: observedCachedTokens } : {}),
        costUsd: computeCostUsd({
          model: observedModel || model,
          tokens_in: observedPromptTokens,
          tokens_out: observedCompletionTokens,
        }),
        model: observedModel || model,
        source: "openai-compat:usage",
      }
    : null;

  return {
    exitCode: 0,
    gatePath: gateExists && !isStub ? gatePath : null,
    stubGate: isStub,
    logPath: null,
    durationMs: Date.now() - start,
    timedOut: false,
    writeViolations: violations,
    usage,
    telemetry: usage ? "observed" : "unavailable",
  };
}

function isOrchestratorWrite(ctx, relPath) {
  const relPipelineRoot = path.relative(ctx.cwd, pipelineRoot(ctx.cwd, ctx.changeId)).replace(/\\/g, "/");
  const relLogsDir = path.relative(ctx.cwd, logsDir(ctx.cwd, ctx.changeId)).replace(/\\/g, "/");
  const normalized = String(relPath || "").replace(/\\/g, "/");
  return normalized === path.posix.join(relPipelineRoot, "run-log.jsonl") ||
    normalized === path.posix.join(relPipelineRoot, "run-state.json") ||
    normalized === path.posix.join(relPipelineRoot, "run.lock") ||
    normalized.startsWith(`${relLogsDir}/`);
}

module.exports = { invoke, resolveConfig, callAPI, isOrchestratorWrite };
