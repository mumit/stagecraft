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
    // Cache counters are omitted, not zero-filled, when the CLI does not report
    // them — an older claude must stay distinguishable from a real cache miss.
    assert.deepEqual(usage, {
      tokensIn: 1234, tokensOut: 56, costUsd: 0.0456, model: "claude-sonnet-5",
      inputAccounting: "exclusive",
    });
  });

  it("captures cache read and creation counters when the result message carries them", () => {
    // Field names verified against claude-code 2.1.207's own result message:
    //   usage: { input_tokens, cache_creation_input_tokens,
    //            cache_read_input_tokens, output_tokens, ... }
    const ex = createStreamJsonExtractor();
    ex.push(line({
      type: "result",
      subtype: "success",
      total_cost_usd: 0.02,
      result: "ok",
      usage: {
        input_tokens: 100,
        output_tokens: 20,
        cache_creation_input_tokens: 21000,
        cache_read_input_tokens: 18000,
      },
      modelUsage: { "claude-opus-5": {} },
    }));
    const { usage } = ex.result();
    assert.equal(usage.cachedTokens, 18000);
    assert.equal(usage.cacheCreationTokens, 21000);
  });

  it("distinguishes a reported zero-read from an unreported counter", () => {
    // A genuine cache miss reports 0 and must be recorded as 0; a CLI that
    // never reports the field must leave it absent. Conflating them would make
    // the hit rate in core/performance/calibration.js meaningless.
    const ex = createStreamJsonExtractor();
    ex.push(line({
      type: "result", subtype: "success", total_cost_usd: 0.02, result: "ok",
      usage: { input_tokens: 100, output_tokens: 20, cache_read_input_tokens: 0 },
      modelUsage: { "claude-opus-5": {} },
    }));
    const { usage } = ex.result();
    assert.equal(usage.cachedTokens, 0);
    assert.equal("cacheCreationTokens" in usage, false);
  });

  it("appends the final result's text to the transcript", () => {
    const ex = createStreamJsonExtractor();
    let out = "";
    out += ex.push(line({ type: "result", subtype: "success", total_cost_usd: 0.01, result: "final answer", usage: { input_tokens: 1, output_tokens: 1 }, modelUsage: { "claude-sonnet-5": {} } }));
    out += ex.end();
    assert.equal(out, "final answer\n");
  });

  it("records the primary model when modelUsage reports more than one", () => {
    // Superseded behavior: this asserted null, on the assumption that a single
    // --print dispatch uses a single model. claude-code 2.1.207 reports two
    // even for a one-line prompt, so that rule left model_observed null on
    // essentially every dispatch. Highest cost wins; ties fall back to
    // declaration order, which is why this expects the first key here.
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
    assert.equal(usage.model, "claude-sonnet-5");
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

// ─── multi-model dispatches (claude-code 2.1.207) ───────────────────────────

describe("modelFromResultMessage: claude-code reports more than one model", () => {
  // Captured live: a one-line `--print` prompt reported two models, because
  // auxiliary work is routed to a cheaper one alongside the main turn. The old
  // "exactly one or null" rule therefore left model_observed null on
  // essentially every dispatch, and every D5 routing row read model=unknown.
  const MULTI = {
    type: "result", subtype: "success", total_cost_usd: 0.0703, result: "ok",
    usage: { input_tokens: 2, output_tokens: 4 },
    modelUsage: {
      "claude-haiku-4-5-20251001": { inputTokens: 897, outputTokens: 12, costUSD: 0.000957, canonicalModel: "claude-haiku-4-5" },
      "claude-sonnet-5": { inputTokens: 2, outputTokens: 4, costUSD: 0.0693, canonicalModel: "claude-sonnet-5" },
    },
  };

  function modelFor(result) {
    const ex = createStreamJsonExtractor();
    ex.push(line(result));
    return ex.result().usage.model;
  }

  it("records the model that did the work, not null", () => {
    assert.equal(modelFor(MULTI), "claude-sonnet-5");
  });

  it("prefers canonicalModel over a dated key", () => {
    assert.equal(modelFor({
      ...MULTI,
      modelUsage: { "claude-opus-5-20260101": { costUSD: 1, canonicalModel: "claude-opus-5" } },
    }), "claude-opus-5");
  });

  it("falls back to the key when no canonical form is given", () => {
    assert.equal(modelFor({ ...MULTI, modelUsage: { "claude-opus-5": { costUSD: 1 } } }), "claude-opus-5");
  });

  it("is deterministic when costs tie or are missing", () => {
    // Declaration order, not object-key iteration luck.
    const tied = { ...MULTI, modelUsage: { "model-a": { costUSD: 0.5 }, "model-b": { costUSD: 0.5 } } };
    assert.equal(modelFor(tied), "model-a");
    const costless = { ...MULTI, modelUsage: { "model-a": {}, "model-b": {} } };
    assert.equal(modelFor(costless), "model-a");
  });

  it("returns null when the CLI reports no model usage at all", () => {
    assert.equal(modelFor({ ...MULTI, modelUsage: {} }), null);
    const { modelUsage: _drop, ...none } = MULTI;
    assert.equal(modelFor(none), null);
  });
});
