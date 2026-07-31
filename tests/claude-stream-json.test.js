// core/adapters/claude-stream-json.js — unit tests for the incremental
// stream-json extractor (phase-28 item 28.1,
// plans/phase-28-ground-truth-telemetry.md §28.1).

const { describe, it } = require("node:test");
const assert = require("node:assert/strict");
const path = require("node:path");
const { REPO_ROOT } = require("./_helpers");
const { createStreamJsonExtractor } = require(path.join(REPO_ROOT, "core", "adapters", "claude-stream-json"));

function line(obj) {
  return `${JSON.stringify(obj)}\n`;
}

describe("createStreamJsonExtractor — JSON mode", () => {
  it("extracts assistant text and skips system/user noise from the transcript", () => {
    const ex = createStreamJsonExtractor();
    let out = "";
    out += ex.push(line({ type: "system", subtype: "init" }));
    out += ex.push(line({ type: "assistant", message: { content: [{ type: "text", text: "Hello" }] } }));
    out += ex.push(line({ type: "user", message: { content: [] } }));
    out += ex.end();
    assert.equal(out, "Hello\n");
  });

  it("captures usage/cost/model from the final result message", () => {
    const ex = createStreamJsonExtractor();
    ex.push(line({ type: "assistant", message: { content: [{ type: "text", text: "hi" }] } }));
    ex.push(line({
      type: "result",
      subtype: "success",
      total_cost_usd: 0.0456,
      result: "hi",
      usage: { input_tokens: 1234, output_tokens: 56 },
      modelUsage: { "claude-sonnet-5": {} },
    }));
    const { usage, telemetry } = ex.result();
    assert.equal(telemetry, "observed");
    assert.deepEqual(usage, { tokensIn: 1234, tokensOut: 56, costUsd: 0.0456, model: "claude-sonnet-5" });
  });

  it("appends the final result's text to the transcript", () => {
    const ex = createStreamJsonExtractor();
    let out = "";
    out += ex.push(line({ type: "result", subtype: "success", total_cost_usd: 0.01, result: "final answer", usage: { input_tokens: 1, output_tokens: 1 }, modelUsage: { "claude-sonnet-5": {} } }));
    out += ex.end();
    assert.equal(out, "final answer\n");
  });

  it("leaves model_observed unset when modelUsage reports more than one model", () => {
    const ex = createStreamJsonExtractor();
    ex.push(line({
      type: "result",
      subtype: "success",
      total_cost_usd: 0.02,
      result: "done",
      usage: { input_tokens: 10, output_tokens: 2 },
      modelUsage: { "claude-sonnet-5": {}, "claude-opus-4-7": {} },
    }));
    const { usage } = ex.result();
    assert.equal(usage.model, null);
  });

  it("handles a JSON chunk split mid-line across multiple push() calls", () => {
    const ex = createStreamJsonExtractor();
    const full = line({ type: "assistant", message: { content: [{ type: "text", text: "split across chunks" }] } });
    const mid = Math.floor(full.length / 2);
    let out = "";
    out += ex.push(full.slice(0, mid));
    out += ex.push(full.slice(mid));
    out += ex.end();
    assert.equal(out, "split across chunks\n");
  });

  it("accepts Buffer chunks, not just strings", () => {
    const ex = createStreamJsonExtractor();
    let out = "";
    out += ex.push(Buffer.from(line({ type: "assistant", message: { content: [{ type: "text", text: "buffered" }] } }), "utf8"));
    out += ex.end();
    assert.equal(out, "buffered\n");
  });

  it("no result message → usage stays null and telemetry is unavailable", () => {
    const ex = createStreamJsonExtractor();
    ex.push(line({ type: "assistant", message: { content: [{ type: "text", text: "no final result" }] } }));
    const { usage, telemetry } = ex.result();
    assert.equal(usage, null);
    assert.equal(telemetry, "unavailable");
  });

  it("multiple result messages: the last one wins", () => {
    const ex = createStreamJsonExtractor();
    ex.push(line({ type: "result", subtype: "success", total_cost_usd: 0.01, result: "first", usage: { input_tokens: 1, output_tokens: 1 }, modelUsage: { "claude-sonnet-5": {} } }));
    ex.push(line({ type: "result", subtype: "success", total_cost_usd: 0.02, result: "second", usage: { input_tokens: 2, output_tokens: 2 }, modelUsage: { "claude-opus-4-7": {} } }));
    const { usage } = ex.result();
    assert.equal(usage.costUsd, 0.02);
    assert.equal(usage.model, "claude-opus-4-7");
  });
});

describe("createStreamJsonExtractor — degradation to raw passthrough", () => {
  it("plain-text output (non-JSON first line) is passed through verbatim", () => {
    const ex = createStreamJsonExtractor();
    let out = "";
    out += ex.push("plain text line one\n");
    out += ex.push("plain text line two\n");
    out += ex.end();
    assert.equal(out, "plain text line one\nplain text line two\n");
    assert.equal(ex.result().telemetry, "unavailable");
    assert.equal(ex.result().usage, null);
  });

  it("mode decision is made once from the first complete line, not re-evaluated per line", () => {
    // First line is plain text; a later line that happens to look like JSON
    // must still be passed through raw, not parsed for usage.
    const ex = createStreamJsonExtractor();
    let out = "";
    out += ex.push("not json at all\n");
    out += ex.push(line({ type: "result", subtype: "success", total_cost_usd: 1, result: "x", usage: { input_tokens: 1, output_tokens: 1 }, modelUsage: {} }));
    out += ex.end();
    assert.match(out, /not json at all/);
    assert.match(out, /"type":"result"/, "raw mode must not swallow the JSON-shaped line's text");
    assert.equal(ex.result().telemetry, "unavailable");
  });

  it("empty output never crashes and reports unavailable", () => {
    const ex = createStreamJsonExtractor();
    const out = ex.end();
    assert.equal(out, "");
    assert.equal(ex.result().telemetry, "unavailable");
  });
});
