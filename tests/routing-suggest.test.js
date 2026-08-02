// scripts/routing-suggest.js — D5 adaptive routing logic.

const test = require("node:test");
const assert = require("node:assert/strict");
const {
  buildRecommendations,
  buildTierDeltas,
  renderRecommendations,
  renderTierDeltas,
  compareScores,
  MIN_DISPATCHES,
  MIN_PASS_RATE_DELTA,
} = require("../scripts/routing-suggest");

function summary(role, host, opts = {}) {
  return {
    role,
    host,
    total_dispatches: opts.dispatches ?? 10,
    pass: opts.pass ?? 9,
    warn: opts.warn ?? 0,
    fail: opts.fail ?? 1,
    escalate: opts.escalate ?? 0,
    pass_rate_first_try: opts.passRate ?? 90,
    mean_retries_to_pass: opts.meanRetries ?? 0,
    total_cost_usd: opts.totalCost ?? 1.0,
    mean_cost_usd: opts.meanCost ?? 0.1,
    cost_per_pass_usd: opts.costPerPass ?? 0.11,
    mean_duration_ms: opts.meanDuration ?? 10000,
    p50_duration_ms: opts.p50Duration ?? opts.meanDuration ?? 10000,
    p95_duration_ms: opts.p95Duration ?? opts.meanDuration ?? 10000,
    retry_adjusted_completion_ms: opts.retryAdjusted ?? opts.meanDuration ?? 10000,
    models: opts.models ?? [],
  };
}

test("compareScores: higher pass rate wins", () => {
  const a = { passRate: 90, costPerPass: 0.10 };
  const b = { passRate: 70, costPerPass: 0.05 };
  assert.ok(compareScores(a, b) > 0);
});

test("compareScores: tie on pass rate breaks on lower cost-per-pass", () => {
  const a = { passRate: 80, costPerPass: 0.05, retryAdjustedMs: 30000 };
  const b = { passRate: 80, costPerPass: 0.10, retryAdjustedMs: 1000 };
  assert.ok(compareScores(a, b) > 0);
});

test("compareScores: latency breaks ties only after pass rate and cost", () => {
  const fast = { passRate: 80, costPerPass: 0.10, retryAdjustedMs: 1000 };
  const slow = { passRate: 80, costPerPass: 0.10, retryAdjustedMs: 30000 };
  const betterQuality = { passRate: 90, costPerPass: 0.50, retryAdjustedMs: 60000 };
  assert.ok(compareScores(fast, slow) > 0);
  assert.ok(compareScores(fast, betterQuality) < 0);
});

test("buildRecommendations: suggests a swap when a better-performing host is available", () => {
  const summaries = [
    summary("backend", "claude-code", { dispatches: 10, passRate: 60, costPerPass: 0.30 }),
    summary("backend", "codex",        { dispatches: 12, passRate: 85, costPerPass: 0.08 }),
  ];
  const recs = buildRecommendations(summaries, { roles: { backend: "claude-code" } }, {
    minDispatches: MIN_DISPATCHES, minDelta: MIN_PASS_RATE_DELTA,
  });
  assert.equal(recs.length, 1);
  const r = recs[0];
  assert.equal(r.role, "backend");
  assert.equal(r.current_host, "claude-code");
  assert.equal(r.suggested_host, "codex");
  assert.match(r.reason, /codex has 85% first-try/);
  assert.match(r.reason, /p95/);
  assert.equal(r.data.winner.p95_duration_ms, 10000);
  assert.equal(r.data.winner.retry_adjusted_completion_ms, 10000);
});

test("buildRecommendations: no change when winner is already current host", () => {
  const summaries = [
    summary("backend", "codex",        { dispatches: 12, passRate: 85, costPerPass: 0.08 }),
    summary("backend", "claude-code",  { dispatches: 10, passRate: 60, costPerPass: 0.30 }),
  ];
  const recs = buildRecommendations(summaries, { roles: { backend: "codex" } }, {
    minDispatches: MIN_DISPATCHES, minDelta: MIN_PASS_RATE_DELTA,
  });
  const r = recs[0];
  assert.equal(r.suggested_host, "codex"); // unchanged
  assert.equal(r.suggested_host, r.current_host);
  assert.match(r.reason, /already the best performer/);
});

test("buildRecommendations: refuses to recommend when pass-rate delta is below threshold", () => {
  const summaries = [
    summary("backend", "claude-code", { dispatches: 10, passRate: 80, costPerPass: 0.10 }),
    summary("backend", "codex",        { dispatches: 12, passRate: 85, costPerPass: 0.08 }),
    // codex is better, but only by 5pp — under the default 10pp threshold.
  ];
  const recs = buildRecommendations(summaries, { roles: { backend: "claude-code" } }, {
    minDispatches: MIN_DISPATCHES, minDelta: MIN_PASS_RATE_DELTA,
  });
  const r = recs[0];
  assert.equal(r.suggested_host, null);
  assert.match(r.reason, /no clear winner/);
});

test("buildRecommendations: insufficient data when no host has enough dispatches", () => {
  const summaries = [
    summary("backend", "claude-code", { dispatches: 2, passRate: 90 }),
    summary("backend", "codex",        { dispatches: 3, passRate: 100 }),
  ];
  const recs = buildRecommendations(summaries, { roles: { backend: "claude-code" } }, {
    minDispatches: MIN_DISPATCHES, minDelta: MIN_PASS_RATE_DELTA,
  });
  const r = recs[0];
  assert.equal(r.suggested_host, null);
  assert.match(r.reason, /insufficient data/);
});

test("buildRecommendations: respects custom thresholds", () => {
  const summaries = [
    summary("backend", "claude-code", { dispatches: 10, passRate: 80, costPerPass: 0.10 }),
    summary("backend", "codex",        { dispatches: 12, passRate: 85, costPerPass: 0.08 }),
  ];
  // Lower the delta threshold to 4pp — now codex's 5pp lead is enough.
  const recs = buildRecommendations(summaries, { roles: { backend: "claude-code" } }, {
    minDispatches: 5, minDelta: 4,
  });
  assert.equal(recs[0].suggested_host, "codex");
});

test("buildRecommendations: handles role with no routing.roles entry (uses default_host)", () => {
  const summaries = [
    summary("backend", "claude-code", { dispatches: 8, passRate: 50 }),
    summary("backend", "codex",        { dispatches: 8, passRate: 90, costPerPass: 0.05 }),
  ];
  const recs = buildRecommendations(summaries, { default_host: "claude-code", roles: {} }, {
    minDispatches: 5, minDelta: 10,
  });
  assert.equal(recs[0].current_host, "claude-code");
  assert.equal(recs[0].suggested_host, "codex");
});

test("renderRecommendations: includes YAML patch block when there are actionable changes", () => {
  const recs = [
    {
      role: "backend",
      current_host: "claude-code",
      suggested_host: "codex",
      reason: "test",
      data: {},
      alternates: [],
    },
  ];
  const md = renderRecommendations(recs);
  assert.match(md, /Suggested changes \(1\)/);
  assert.match(md, /```yaml/);
  assert.match(md, /backend: codex/);
  assert.match(md, /was: claude-code/);
});

test("renderRecommendations: 'no changes recommended' when actionable list is empty", () => {
  const recs = [
    { role: "backend", current_host: "codex", suggested_host: "codex", reason: "already best", alternates: [] },
  ];
  const md = renderRecommendations(recs);
  assert.match(md, /No changes recommended/);
  assert.match(md, /Already optimal/);
});

// Phase-32 item 32.3: per-(role, host, model) cost deltas.
function modelSummary(role, host, model, opts = {}) {
  return { ...summary(role, host, opts), model };
}

test("32.3: buildTierDeltas skips roles with fewer than 2 eligible (host, model) pairs", () => {
  const summaries = [modelSummary("qa", "claude-code", "haiku", { dispatches: 10 })];
  const deltas = buildTierDeltas(summaries, { minDispatches: MIN_DISPATCHES });
  assert.equal(deltas.length, 0);
});

test("32.3: buildTierDeltas reports deltas vs the cheapest tier, sorted cheapest-first", () => {
  const summaries = [
    modelSummary("qa", "claude-code", "opus", { dispatches: 10, costPerPass: 0.50, passRate: 95 }),
    modelSummary("qa", "claude-code", "haiku", { dispatches: 10, costPerPass: 0.05, passRate: 80 }),
  ];
  const deltas = buildTierDeltas(summaries, { minDispatches: MIN_DISPATCHES });
  assert.equal(deltas.length, 1);
  assert.equal(deltas[0].role, "qa");
  assert.equal(deltas[0].tiers.length, 2);
  // cheapest first
  assert.equal(deltas[0].tiers[0].model, "haiku");
  assert.equal(deltas[0].tiers[0].cost_delta_vs_cheapest_usd, 0);
  assert.equal(deltas[0].tiers[1].model, "opus");
  assert.ok(Math.abs(deltas[0].tiers[1].cost_delta_vs_cheapest_usd - 0.45) < 1e-9);
});

test("32.3: buildTierDeltas excludes pairs below the --min-dispatches floor", () => {
  const summaries = [
    modelSummary("qa", "claude-code", "opus", { dispatches: 10 }),
    modelSummary("qa", "claude-code", "haiku", { dispatches: 2 }), // below floor
  ];
  const deltas = buildTierDeltas(summaries, { minDispatches: 5 });
  assert.equal(deltas.length, 0, "only one eligible pair remains — nothing to compare");
});

test("32.3: renderTierDeltas is empty when there are no deltas, and renders a table otherwise", () => {
  assert.deepEqual(renderTierDeltas([]), []);
  const deltas = buildTierDeltas([
    modelSummary("qa", "claude-code", "opus", { dispatches: 10, costPerPass: 0.50 }),
    modelSummary("qa", "claude-code", "haiku", { dispatches: 10, costPerPass: 0.05 }),
  ], { minDispatches: MIN_DISPATCHES });
  const lines = renderTierDeltas(deltas);
  const text = lines.join("\n");
  assert.match(text, /Per-tier cost deltas/);
  assert.match(text, /### qa/);
  assert.match(text, /haiku/);
  assert.match(text, /opus/);
});
