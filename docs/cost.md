# Cost telemetry

Stagecraft records per-workstream LLM cost in the gate JSON and aggregates it in the dashboard. Cost data is **opt-in per gate**: when the model or agent knows its own token usage, it writes it into the gate; downstream tooling rolls up dollars from there.

This is the **D6** BACKLOG item. It is the data foundation for D4 (per-role per-model performance scores) and D5 (adaptive routing). On its own it answers "where did our LLM spend go this sprint?"

- [Quick start](#quick-start)
- [How cost gets into the gate](#how-cost-gets-into-the-gate)
- [Pricing table](#pricing-table)
- [What cost data unlocks (D4 + D5)](#what-cost-data-unlocks-d4--d5)
- [Limitations](#limitations)
- [See also](#see-also)

## Quick start

```bash
# After running a pipeline (or many):
npm run dashboard:cost                               # cost rolled up by host
node scripts/dashboard.js --view cost --by role      # cost by role
node scripts/dashboard.js --view cost --by stage     # cost by stage
node scripts/dashboard.js --view cost --from p1,p2   # multi-project rollup
node scripts/dashboard.js --view cost --json         # machine-readable
```

Output:

```
# devteam dashboard — cost view

Generated: 2026-05-29T...
Sources: `/path/to/project`
Grouping: host

## Overall
Workstreams counted: 14
With cost data: 12 / 14
Total cost: **$2.47**
Total tokens: 1,240,500 in + 87,300 out
Total duration: 24.3m

## By host

| Host | # | Cost | Tokens in | Tokens out | Duration | Cost/run |
|---|---:|---:|---:|---:|---:|---:|
| claude-code | 8 | $1.94 | 920,400 | 65,800 | 18.7m | $0.243 |
| codex       | 4 | $0.42 | 240,100 | 18,500 |  4.1m | $0.105 |
| gemini-cli  | 2 | $0.11 |  80,000 |  3,000 |  1.5m | $0.055 |
```

## How cost gets into the gate

Cost is opt-in. The gate JSON gains five optional fields:

| Field | Type | Source |
|---|---|---|
| `model` | string | Specific model id, e.g. `claude-opus-4-7` (distinct from `host`). |
| `tokens_in` | number | Input tokens (prompt + history). |
| `tokens_out` | number | Output tokens generated. |
| `duration_ms` | number | Wall-clock for this dispatch. |
| `cost_usd` | number | Computed from the above + `core/pricing.js`. |

Three ways the fields land:

1. **Agent self-reports.** The renderStagePrompt for each host now includes an "Optional cost telemetry" note asking the agent to include `model` / `tokens_in` / `tokens_out` / `duration_ms` if it knows them. Claude exposes these in its CLI output; the agent can read them and write them into the gate.
2. **Adapter post-processes** (future work). The headless invoke path could parse `--output-format json` from the host CLI and write the fields into the gate as a post-step. Not implemented today; the agent-self-report path covers the same data.
3. **Stage-merge rollup** (orchestrator). When `devteam merge <stage>` aggregates per-workstream gates, it sums any cost fields present and emits stage-level `tokens_in` / `tokens_out` / `cost_usd` / `duration_ms` totals on the merged gate. Per-workstream detail is preserved inside the `workstreams[]` array.

## Pricing table

`core/pricing.js` carries a hardcoded $/Mtok table for known models. Today it covers:

- **Claude 4 family** — Opus, Sonnet, Haiku
- **OpenAI** — GPT-5, GPT-4o, o1 (and their mini variants)
- **Gemini 2.5** — Pro, Flash

Lookup is exact-match first, then prefix-match, so a dated model id like `claude-opus-4-7-20250515` resolves to the `claude-opus-4-7` row. Unknown models compute `cost_usd: null` (tokens still aggregate).

**The pricing is an estimate, not an invoice.** Prices change; update `core/pricing.js` periodically. Authoritative billing lives in each provider's dashboard.

## What cost data unlocks (D4 + D5)

D6 is the data layer; **D4 and D5 are now built** and turn the data into decisions:

- **D4 — Per-role per-model performance scores** (`npm run performance` / `scripts/performance.js`). For each `(role, host)` pair, computes first-try pass rate, mean retries, mean cost, **cost per pass** (unit cost of a successful dispatch), p50/p95 duration, and retry-adjusted completion time. Headlines pairwise comparisons when 2+ hosts are seen for a role.
- **D5 — Adaptive routing** (`npm run routing:suggest` / `scripts/routing-suggest.js`). Reads the same gates, compares against the current `.devteam/config.yml`, proposes role-level routing changes. Minimum dispatch threshold (5 default) + minimum pass-rate delta (10pp default) prevent recommendations on noisy data. Latency breaks ties only after first-try quality and cost; `--apply` rewrites the config after a confirmation prompt.

Together they answer which model performs best at which role, based on measurement rather than assumption. Try it:

```bash
# Look at performance so far:
npm run performance

# See what routing changes are recommended:
npm run routing:suggest

# Apply them (will prompt first):
npm run routing:suggest -- --apply

# Apply without prompting (CI usage):
npm run routing:suggest -- --apply --yes
```

## Limitations

- **Token reporting is uneven** across host CLIs. Claude Code exposes precise counts via `--print --output-format json`; Codex and Gemini are less consistent. The simpler model in agent-self-reports gives us the data without per-host parsing complexity.
- **Pricing drift.** The pricing table needs periodic updates. If prices change between updates, `cost_usd` figures are off by the drift.
- **Cached input tokens** (Claude's prompt caching, GPT's similar feature) aren't tracked separately. The reported `tokens_in` includes everything; cost calculations don't apply cache discounts. Treat as upper bound.
- **No latency-cost decomposition.** A slow stage and an expensive stage are different things. `duration_ms` and `cost_usd` are both reported, but with no derived "$/min" metric. The dashboard table includes both columns so you can interpret as needed.

## See also

- [`core/pricing.js`](../core/pricing.js) — the pricing table.
- [`scripts/dashboard.js`](../scripts/dashboard.js) — `--view cost` aggregation.
- [`docs/BACKLOG.md`](BACKLOG.md) — D4 (performance scores) and D5 (adaptive routing).
- [`docs/observability.md`](observability.md) — OTel tracing (separate observability layer).
