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

// modelUsage keys are the model id(s) billed for this invocation.
//
// This used to require exactly one, on the assumption that a single `--print`
// dispatch uses a single model, and returned null otherwise "rather than
// guessing". That assumption is empirically false: claude-code 2.1.207 reports
// two models even for a trivial one-line prompt, because it routes auxiliary
// work (titles, quick classifications) to a cheaper model alongside the main
// turn. The result was that model_observed was null on essentially every
// claude-code dispatch, so every routing row in D5's evidence read
// `model=unknown` — which is not routing evidence at all.
//
// Choosing the highest-cost entry is not a guess. modelUsage carries per-model
// `costUSD`, and the model that did the dispatch's work is the one that cost
// the most; on a real run the auxiliary model is two orders of magnitude
// cheaper. `canonicalModel` is preferred over the raw key because the key can
// carry a dated suffix while the canonical form is what core/pricing.js and a
// human reading a routing table both want.
function modelFromResultMessage(obj) {
  const usage = obj.modelUsage && typeof obj.modelUsage === "object" ? obj.modelUsage : null;
  if (!usage) return null;
  const entries = Object.entries(usage).filter(([id, value]) => id && value && typeof value === "object");
  if (entries.length === 0) return null;
  if (entries.length === 1) return entries[0][1].canonicalModel || entries[0][0];
  const cost = (entry) => (typeof entry[1].costUSD === "number" && entry[1].costUSD >= 0 ? entry[1].costUSD : -1);
  // Ties and cost-less payloads fall back to declaration order, which keeps the
  // result deterministic rather than dependent on object-key iteration luck.
  const primary = entries.reduce((best, entry) => (cost(entry) > cost(best) ? entry : best), entries[0]);
  return primary[1].canonicalModel || primary[0];
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
        // cache_read_input_tokens / cache_creation_input_tokens are what make
        // phase-32.1's byte-stable prompt prefix measurable rather than
        // assumed: core/performance/calibration.js already computes a
        // cache hit rate from _orchestrator_observed.cached_tokens, and
        // claude-code — the host that carries the largest inlined prefix —
        // was the one host contributing no samples to it. Field names verified
        // against claude-code 2.1.207's own result message. Both are omitted
        // rather than zero-filled when absent, so an older CLI that does not
        // report them stays distinguishable from a real cache miss.
        const cacheRead = typeof obj.usage.cache_read_input_tokens === "number"
          ? obj.usage.cache_read_input_tokens : null;
        const cacheCreation = typeof obj.usage.cache_creation_input_tokens === "number"
          ? obj.usage.cache_creation_input_tokens : null;
        usage = {
          tokensIn: typeof obj.usage.input_tokens === "number" ? obj.usage.input_tokens : null,
          tokensOut: typeof obj.usage.output_tokens === "number" ? obj.usage.output_tokens : null,
          ...(cacheRead !== null ? { cachedTokens: cacheRead } : {}),
          ...(cacheCreation !== null ? { cacheCreationTokens: cacheCreation } : {}),
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
