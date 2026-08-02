// scripts/performance.js — per-(role, host) aggregation.

const test = require("node:test");
const assert = require("node:assert/strict");
const {
  expandToWorkstreams,
  aggregatePerformance,
  aggregatePerformanceByModel,
  summarize,
  renderMarkdown,
  renderJSON,
} = require("../scripts/performance");

test("expandToWorkstreams: flattens merged stage gates into workstream entries", () => {
  const gates = [
    {
      stage: "stage-04",
      status: "PASS",
      workstreams: [
        { workstream: "backend", host: "codex", status: "PASS" },
        { workstream: "frontend", host: "claude-code", status: "PASS" },
      ],
    },
    { stage: "stage-01", workstream: "pm", host: "claude-code", status: "PASS" },
  ];
  const w = expandToWorkstreams(gates);
  assert.equal(w.length, 3);
  assert.equal(w[0].workstream, "backend");
  assert.equal(w[1].workstream, "frontend");
  assert.equal(w[2].workstream, "pm");
});

test("expandToWorkstreams: skips stage gates that have no workstream attribution", () => {
  const gates = [
    { stage: "stage-09", status: "PASS" }, // retrospective; no workstream array, no workstream field
  ];
  const w = expandToWorkstreams(gates);
  assert.equal(w.length, 0);
});

test("aggregatePerformance: groups by (role, host) pair", () => {
  const gates = [
    { stage: "stage-04.backend", workstream: "backend", host: "codex", status: "PASS" },
    { stage: "stage-04.backend", workstream: "backend", host: "codex", status: "PASS" },
    { stage: "stage-04.backend", workstream: "backend", host: "claude-code", status: "FAIL" },
  ];
  const groups = aggregatePerformance(gates);
  assert.equal(groups.size, 2);
  const codex = groups.get("backend@codex");
  assert.equal(codex.total_dispatches, 2);
  assert.equal(codex.pass, 2);
  assert.equal(codex.fail, 0);
  const claude = groups.get("backend@claude-code");
  assert.equal(claude.total_dispatches, 1);
  assert.equal(claude.fail, 1);
});

test("aggregatePerformance: counts first-try pass (retry_number absent or 0)", () => {
  const gates = [
    { workstream: "pm", host: "claude-code", status: "PASS" }, // first try
    { workstream: "pm", host: "claude-code", status: "PASS", retry_number: 0 }, // first try
    { workstream: "pm", host: "claude-code", status: "PASS", retry_number: 1 }, // not first try
    { workstream: "pm", host: "claude-code", status: "WARN" }, // first-try WARN counts
  ];
  const r = aggregatePerformance(gates).get("pm@claude-code");
  assert.equal(r.total_dispatches, 4);
  assert.equal(r.pass_first_try, 3); // 2 PASS-retry-0 + 1 WARN
});

// Phase-32 item 32.3: (role, host, model) grouping, additive alongside
// aggregatePerformance's (role, host) grouping above.
test("32.3: aggregatePerformanceByModel groups by (role, host, model), unlike aggregatePerformance", () => {
  const gates = [
    { workstream: "qa", host: "claude-code", status: "PASS", model: "haiku" },
    { workstream: "qa", host: "claude-code", status: "PASS", model: "haiku" },
    { workstream: "qa", host: "claude-code", status: "FAIL", model: "opus" },
  ];
  // aggregatePerformance blends both models into one (role, host) bucket —
  // unchanged, byte-identical pre-32.3 behavior.
  const byHost = aggregatePerformance(gates);
  assert.equal(byHost.size, 1);
  assert.equal(byHost.get("qa@claude-code").total_dispatches, 3);

  // aggregatePerformanceByModel splits them.
  const byModel = aggregatePerformanceByModel(gates);
  assert.equal(byModel.size, 2);
  const haiku = byModel.get("qa@claude-code@haiku");
  assert.equal(haiku.total_dispatches, 2);
  assert.equal(haiku.pass, 2);
  assert.equal(haiku.model, "haiku");
  const opus = byModel.get("qa@claude-code@opus");
  assert.equal(opus.total_dispatches, 1);
  assert.equal(opus.fail, 1);
  assert.equal(opus.model, "opus");
});

test("32.3: aggregatePerformanceByModel buckets a missing model as (unspecified)", () => {
  const gates = [{ workstream: "qa", host: "gemini-cli", status: "PASS" }];
  const byModel = aggregatePerformanceByModel(gates);
  assert.equal(byModel.size, 1);
  assert.ok(byModel.has("qa@gemini-cli@(unspecified)"));
});

test("32.3: summarize() only includes `model` for aggregatePerformanceByModel records", () => {
  const gates = [{ workstream: "qa", host: "codex", status: "PASS", model: "gpt-5" }];
  const byHostSummary = summarize(aggregatePerformance(gates).get("qa@codex"));
  assert.equal("model" in byHostSummary, false, "(role, host) summary never gains a top-level model field");
  const byModelSummary = summarize(aggregatePerformanceByModel(gates).get("qa@codex@gpt-5"));
  assert.equal(byModelSummary.model, "gpt-5");
});

test("summarize: computes pass_rate_first_try and mean retries", () => {
  const gates = [
    { workstream: "backend", host: "codex", status: "PASS", retry_number: 0 },
    { workstream: "backend", host: "codex", status: "PASS", retry_number: 0 },
    { workstream: "backend", host: "codex", status: "PASS", retry_number: 2 },
    { workstream: "backend", host: "codex", status: "FAIL" },
  ];
  const groups = aggregatePerformance(gates);
  const s = summarize(groups.get("backend@codex"));
  assert.equal(s.total_dispatches, 4);
  assert.equal(s.pass, 3);
  assert.equal(s.fail, 1);
  assert.equal(s.pass_rate_first_try, 50); // 2 of 4 dispatches were first-try pass
  // Mean retries on PASSed gates: (0 + 0 + 2) / 3 ≈ 0.666...
  assert.ok(Math.abs(s.mean_retries_to_pass - (2 / 3)) < 0.01);
});

test("summarize: computes cost aggregates when gates carry cost data", () => {
  const gates = [
    {
      workstream: "backend", host: "codex", status: "PASS",
      tokens_in: 10000, tokens_out: 2000, cost_usd: 0.10, duration_ms: 12000, model: "gpt-5",
    },
    {
      workstream: "backend", host: "codex", status: "PASS",
      tokens_in: 8000, tokens_out: 1500, cost_usd: 0.08, duration_ms: 10000, model: "gpt-5",
    },
    {
      workstream: "backend", host: "codex", status: "FAIL",
      tokens_in: 5000, tokens_out: 1000, cost_usd: 0.05, duration_ms: 6000, model: "gpt-5",
    },
  ];
  const s = summarize(aggregatePerformance(gates).get("backend@codex"));
  assert.equal(s.total_dispatches, 3);
  assert.ok(Math.abs(s.total_cost_usd - 0.23) < 0.001);
  assert.ok(Math.abs(s.mean_cost_usd - (0.23 / 3)) < 0.001);
  // cost_per_pass = total / (pass+warn) = 0.23 / 2 = 0.115
  assert.ok(Math.abs(s.cost_per_pass_usd - 0.115) < 0.001);
  assert.equal(s.mean_duration_ms, 28000 / 3);
  assert.equal(s.p50_duration_ms, 10000);
  assert.equal(s.p95_duration_ms, 12000);
  assert.equal(s.retry_adjusted_completion_ms, 11000);
  assert.deepEqual(s.models, ["gpt-5"]);
});

test("summarize: handles gates without cost data (cost fields are null, count still accrues)", () => {
  const gates = [
    { workstream: "pm", host: "claude-code", status: "PASS" }, // no cost data
    { workstream: "pm", host: "claude-code", status: "PASS" },
  ];
  const s = summarize(aggregatePerformance(gates).get("pm@claude-code"));
  assert.equal(s.total_dispatches, 2);
  assert.equal(s.mean_cost_usd, null);
  assert.equal(s.cost_per_pass_usd, null);
  assert.equal(s.mean_duration_ms, null);
});

test("renderMarkdown: includes the headline pairwise comparison when 2+ hosts seen for a role", () => {
  const gates = [
    { workstream: "backend", host: "codex", status: "PASS", retry_number: 0, cost_usd: 0.05 },
    { workstream: "backend", host: "codex", status: "PASS", retry_number: 0, cost_usd: 0.05 },
    { workstream: "backend", host: "claude-code", status: "FAIL", cost_usd: 0.30 },
    { workstream: "backend", host: "claude-code", status: "PASS", retry_number: 1, cost_usd: 0.25 },
  ];
  const summaries = [...aggregatePerformance(gates).values()].map(summarize);
  const md = renderMarkdown({ from: ["x"], since: null }, summaries);
  assert.match(md, /Headline pairwise comparisons/);
  // codex won (100% first-try, $0.05) vs claude-code (0% first-try, $0.55 cost/pass)
  assert.match(md, /\*\*backend\*\*: codex/);
});

test("renderMarkdown: empty data prints a guidance message", () => {
  const md = renderMarkdown({ from: ["x"], since: null }, []);
  assert.match(md, /No workstream dispatches found/);
});

test("renderJSON: shape is { generated_at, sources, since, rows }", () => {
  const summaries = [
    { role: "pm", host: "claude-code", total_dispatches: 5, pass_rate_first_try: 80 },
  ];
  const json = renderJSON({ from: ["x"], since: null }, summaries);
  const parsed = JSON.parse(json);
  assert.deepEqual(parsed.sources, ["x"]);
  assert.equal(parsed.rows.length, 1);
  assert.equal(parsed.rows[0].role, "pm");
});
