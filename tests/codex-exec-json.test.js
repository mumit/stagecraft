// core/adapters/codex-exec-json.js — unit tests for the incremental
// `codex exec --json` extractor (phase-28 item 28.3,
// plans/phase-28-ground-truth-telemetry.md §28.3).

const { describe, it } = require("node:test");
const assert = require("node:assert/strict");
const path = require("node:path");
const { REPO_ROOT } = require("./_helpers");
const { createCodexJsonExtractor } = require(path.join(REPO_ROOT, "core", "adapters", "codex-exec-json"));

function line(obj) {
  return `${JSON.stringify(obj)}\n`;
}

describe("createCodexJsonExtractor — JSON mode", () => {
  it("extracts agent_message text and skips lifecycle/reasoning noise from the transcript", () => {
    const ex = createCodexJsonExtractor();
    let out = "";
    out += ex.push(line({ type: "thread.started", thread_id: "t1" }));
    out += ex.push(line({ type: "turn.started" }));
    out += ex.push(line({ type: "item.completed", item: { id: "1", type: "reasoning", text: "thinking..." } }));
    out += ex.push(line({ type: "item.completed", item: { id: "2", type: "agent_message", text: "Hello" } }));
    out += ex.end();
    assert.equal(out, "Hello\n");
  });

  it("captures usage from the turn.completed event", () => {
    const ex = createCodexJsonExtractor();
    ex.push(line({ type: "item.completed", item: { id: "1", type: "agent_message", text: "hi" } }));
    ex.push(line({ type: "turn.completed", usage: { input_tokens: 1234, cached_input_tokens: 100, output_tokens: 56 } }));
    const { usage, telemetry } = ex.result();
    assert.equal(telemetry, "observed");
    assert.deepEqual(usage, {
      tokensIn: 1234,
      tokensOut: 56,
      cachedTokens: 100,
      costUsd: null,
      model: null,
      source: "codex:exec-json",
    });
  });

  it("omits cachedTokens when cached_input_tokens is zero or absent", () => {
    const ex = createCodexJsonExtractor();
    ex.push(line({ type: "turn.completed", usage: { input_tokens: 10, output_tokens: 2 } }));
    const { usage } = ex.result();
    assert.equal("cachedTokens" in usage, false);
  });

  it("handles a JSON chunk split mid-line across multiple push() calls", () => {
    const ex = createCodexJsonExtractor();
    const full = line({ type: "item.completed", item: { id: "1", type: "agent_message", text: "split across chunks" } });
    const mid = Math.floor(full.length / 2);
    let out = "";
    out += ex.push(full.slice(0, mid));
    out += ex.push(full.slice(mid));
    out += ex.end();
    assert.equal(out, "split across chunks\n");
  });

  it("accepts Buffer chunks, not just strings", () => {
    const ex = createCodexJsonExtractor();
    let out = "";
    out += ex.push(Buffer.from(line({ type: "item.completed", item: { id: "1", type: "agent_message", text: "buffered" } }), "utf8"));
    out += ex.end();
    assert.equal(out, "buffered\n");
  });

  it("no turn.completed → usage stays null and telemetry is unavailable", () => {
    const ex = createCodexJsonExtractor();
    ex.push(line({ type: "turn.failed", error: { message: "boom" } }));
    const { usage, telemetry } = ex.result();
    assert.equal(usage, null);
    assert.equal(telemetry, "unavailable");
  });

  it("multiple turn.completed events: the last one wins", () => {
    const ex = createCodexJsonExtractor();
    ex.push(line({ type: "turn.completed", usage: { input_tokens: 1, output_tokens: 1 } }));
    ex.push(line({ type: "turn.completed", usage: { input_tokens: 2, output_tokens: 2 } }));
    const { usage } = ex.result();
    assert.equal(usage.tokensIn, 2);
    assert.equal(usage.tokensOut, 2);
  });
});

describe("createCodexJsonExtractor — degradation to raw passthrough", () => {
  it("plain-text output (non-JSON first line) is passed through verbatim", () => {
    const ex = createCodexJsonExtractor();
    let out = "";
    out += ex.push("plain text line one\n");
    out += ex.push("plain text line two\n");
    out += ex.end();
    assert.equal(out, "plain text line one\nplain text line two\n");
    assert.equal(ex.result().telemetry, "unavailable");
    assert.equal(ex.result().usage, null);
  });

  it("mode decision is made once from the first complete line, not re-evaluated per line", () => {
    const ex = createCodexJsonExtractor();
    let out = "";
    out += ex.push("not json at all\n");
    out += ex.push(line({ type: "turn.completed", usage: { input_tokens: 1, output_tokens: 1 } }));
    out += ex.end();
    assert.match(out, /not json at all/);
    assert.match(out, /"type":"turn.completed"/, "raw mode must not swallow the JSON-shaped line's text");
    assert.equal(ex.result().telemetry, "unavailable");
  });

  it("empty output never crashes and reports unavailable", () => {
    const ex = createCodexJsonExtractor();
    const out = ex.end();
    assert.equal(out, "");
    assert.equal(ex.result().telemetry, "unavailable");
  });
});
