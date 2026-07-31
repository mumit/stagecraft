// Incremental parser for `claude --print --output-format stream-json --verbose`
// (phase-28 item 28.1, plans/phase-28-ground-truth-telemetry.md §28.1).
//
// Feeds raw stdout chunks in and returns readable text to tee into the
// transcript log — never the raw JSONL, which would make
// pipeline/logs/<workstreamId>.log unreadable. Also captures the final
// "result" message's usage/cost/model for orchestrator-observed telemetry.
//
// Degradation contract: mode is decided ONCE from the first complete line.
// If it doesn't parse as JSON (older claude CLI, or any command that
// ignores --output-format and prints plain text), every subsequent chunk
// is passed through verbatim and usage stays null — the orchestrator sets
// telemetry: "unavailable" and dispatch proceeds exactly as before this
// item landed.

function extractAssistantText(message) {
  if (!message || !Array.isArray(message.content)) return "";
  return message.content
    .filter((block) => block && block.type === "text" && typeof block.text === "string")
    .map((block) => block.text)
    .join("");
}

// modelUsage keys are the model id(s) billed for this invocation. A single
// `--print` dispatch is expected to use exactly one model; if the CLI ever
// reports more than one, leave model_observed unset rather than guessing.
function modelFromResultMessage(obj) {
  const keys = obj.modelUsage && typeof obj.modelUsage === "object" ? Object.keys(obj.modelUsage) : [];
  return keys.length === 1 ? keys[0] : null;
}

function createStreamJsonExtractor() {
  let buffer = "";
  let mode = null; // null (undetermined) | "json" | "raw"
  let usage = null;

  function textForJsonLine(line) {
    let obj;
    try {
      obj = JSON.parse(line);
    } catch {
      return ""; // one malformed line in an otherwise-JSON stream; skip it
    }
    if (obj.type === "assistant") {
      const text = extractAssistantText(obj.message);
      return text ? `${text}\n` : "";
    }
    if (obj.type === "result") {
      if (typeof obj.total_cost_usd === "number" && obj.usage) {
        usage = {
          tokensIn: typeof obj.usage.input_tokens === "number" ? obj.usage.input_tokens : null,
          tokensOut: typeof obj.usage.output_tokens === "number" ? obj.usage.output_tokens : null,
          costUsd: obj.total_cost_usd,
          model: modelFromResultMessage(obj),
        };
      }
      return typeof obj.result === "string" ? `${obj.result}\n` : "";
    }
    return ""; // system/user/etc. — not part of the readable transcript
  }

  function consumeCompleteLines(lines) {
    let out = "";
    for (const line of lines) {
      if (line.length === 0) continue;
      out += textForJsonLine(line);
    }
    return out;
  }

  return {
    // Feed a raw stdout chunk (Buffer or string). Returns the text to
    // append to the transcript log (and mirror live, if enabled).
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
    // Call once the child's stdout closes to flush any trailing partial line.
    end() {
      if (mode !== "json") {
        const out = buffer;
        buffer = "";
        return out;
      }
      const out = buffer.length > 0 ? textForJsonLine(buffer) : "";
      buffer = "";
      return out;
    },
    // { usage: {tokensIn, tokensOut, costUsd, model} | null, telemetry: "observed" | "unavailable" }
    result() {
      return { usage, telemetry: usage ? "observed" : "unavailable" };
    },
  };
}

module.exports = { createStreamJsonExtractor };
