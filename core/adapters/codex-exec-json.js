// Incremental parser for `codex exec --json` (phase-28 item 28.3,
// plans/phase-28-ground-truth-telemetry.md §28.3).
//
// Feeds raw stdout chunks in and returns readable text to tee into the
// transcript log — never the raw JSONL. Also captures the final
// "turn.completed" event's `usage` for orchestrator-observed telemetry.
//
// codex exec --json event shapes (codex-cli 0.135.0, confirmed against a
// live invocation plus openai/codex issue threads — see
// plans/phase-28-ground-truth-telemetry.md §28.3 report):
//   {"type":"thread.started","thread_id":...}
//   {"type":"turn.started"}
//   {"type":"item.completed","item":{"type":"agent_message","text":"..."}}
//   {"type":"turn.completed","usage":{"input_tokens":N,"cached_input_tokens":N,"output_tokens":N}}
//   {"type":"turn.failed","error":{"message":"..."}}
//   {"type":"error","message":"..."}
// Unlike claude's stream-json, codex reports neither a model id nor a
// dollar cost in this stream — costUsd/model stay null rather than guessed.
//
// Degradation contract: identical to claude-stream-json.js — mode is
// decided once from the first complete line; a non-JSON first line (older
// codex CLI without --json, or any command that ignores the flag) falls
// back to raw passthrough and usage stays null.

function textForJsonLine(line, setUsage) {
  let obj;
  try {
    obj = JSON.parse(line);
  } catch {
    return ""; // one malformed line in an otherwise-JSON stream; skip it
  }
  if (obj.type === "item.completed" && obj.item && obj.item.type === "agent_message") {
    return typeof obj.item.text === "string" ? `${obj.item.text}\n` : "";
  }
  if (obj.type === "turn.completed" && obj.usage) {
    setUsage({
      tokensIn: typeof obj.usage.input_tokens === "number" ? obj.usage.input_tokens : null,
      tokensOut: typeof obj.usage.output_tokens === "number" ? obj.usage.output_tokens : null,
      ...(typeof obj.usage.cached_input_tokens === "number" && obj.usage.cached_input_tokens > 0
        ? { cachedTokens: obj.usage.cached_input_tokens }
        : {}),
      costUsd: null,
      model: null,
      // OpenAI documents ordinary = input_tokens - cached - cache_write, so cached is a subset of the input total reported above.
      inputAccounting: "inclusive",
      source: "codex:exec-json",
    });
    return "";
  }
  return ""; // thread.started/turn.started/turn.failed/error/item.started/etc.
}

function createCodexJsonExtractor() {
  let buffer = "";
  let mode = null; // null (undetermined) | "json" | "raw"
  let usage = null;
  const setUsage = (u) => { usage = u; };

  function consumeCompleteLines(lines) {
    let out = "";
    for (const line of lines) {
      if (line.length === 0) continue;
      out += textForJsonLine(line, setUsage);
    }
    return out;
  }

  return {
    push(chunk) {
      buffer += chunk.toString("utf8");
      if (mode === "raw") {
        const out = buffer;
        buffer = "";
        return out;
      }
      const lines = buffer.split("\n");
      buffer = lines.pop(); // last element may be an incomplete line
      if (mode === null) {
        if (lines.length === 0) return ""; // no complete line yet — keep buffering
        let obj;
        try {
          obj = JSON.parse(lines[0]);
        } catch {
          obj = undefined;
        }
        mode = obj && typeof obj === "object" ? "json" : "raw";
        if (mode === "raw") {
          const out = lines.map((l) => `${l}\n`).join("") + buffer;
          buffer = "";
          return out;
        }
      }
      return consumeCompleteLines(lines);
    },
    end() {
      if (mode !== "json") {
        const out = buffer;
        buffer = "";
        return out;
      }
      const out = buffer.length > 0 ? textForJsonLine(buffer, setUsage) : "";
      buffer = "";
      return out;
    },
    // { usage: {tokensIn, tokensOut, cachedTokens?, costUsd, model, source} | null,
    //   telemetry: "observed" | "unavailable" }
    result() {
      return { usage, telemetry: usage ? "observed" : "unavailable" };
    },
  };
}

module.exports = { createCodexJsonExtractor };
