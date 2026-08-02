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

Phase-32 item 32.3 adds a sixth, orchestrator-set field: `model_requested` — the model `routing.roles`/`routing.stages`' `{host, model}` form resolved for this dispatch *before* it ran. Unlike the five fields above (all model-asserted, written by the agent), `model_requested` is orchestrator truth, stamped the same way `_orchestrator_observed` is (read-modify-write on the gate right after dispatch, fire-and-forget). It's what was requested, not what ran (`model`) or what was actually observed serving it (`_orchestrator_observed.model_observed`) — all three can differ, e.g. a routing pin that a host-native fallback silently overrode. A fix-and-retry that escalated a pinned model one tier (`routing.escalate_on_retry`) additionally records `_orchestrator_escalated: {from_model, to_model, reason, at}` on the gate.

Three ways the fields land:

1. **Agent self-reports.** The renderStagePrompt for each host now includes an "Optional cost telemetry" note asking the agent to include `model` / `tokens_in` / `tokens_out` / `duration_ms` if it knows them. Claude exposes these in its CLI output; the agent can read them and write them into the gate. This is a model claim, not an orchestrator observation — see the trust-boundary note below.
2. **Adapter post-processes (claude-code — phase-28 item 28.1; openai-compat — item 28.2; codex — item 28.3).** The claude-code headless command requests `--output-format stream-json --verbose`; `core/adapters/headless.js` parses the stream for the final result message's `usage.input_tokens` / `usage.output_tokens` / `total_cost_usd` / model id. codex's headless command requests `--json`; the same `core/adapters/headless.js` parses the resulting JSONL for the `turn.completed` event's `usage.input_tokens` / `usage.cached_input_tokens` / `usage.output_tokens` — codex's stream reports neither a model id nor a dollar cost, so `model_observed`/`cost_usd` stay `null` rather than guessed. openai-compat has no CLI to parse — `hosts/openai-compat/invoke.js` instead sums `usage.prompt_tokens` / `usage.completion_tokens` / `usage.prompt_tokens_details.cached_tokens` from every chat-completion response across the tool loop, and computes `cost_usd` itself via `core/pricing.js` `computeCostUsd` (unknown model → `cost_usd: null`, never a guess — unlike claude-code, the API never reports its own bill). Either way, `core/orchestrator.js`'s shared `patchGateForObservedUsage` writes the result onto the workstream gate under `_orchestrator_observed` — a distinct block from the fields in the table above, never overwriting the model's self-report. `_orchestrator_observed` fields are: `tokens_in`, `tokens_out`, `cached_tokens` (openai-compat and codex only, omitted when zero), `cost_usd`, `model_observed`, `source` (`"claude-code:stream-json"`, `"codex:exec-json"`, or `"openai-compat:usage"`), `at`. If usage can't be observed (older claude/codex CLI ignoring the output flag; an openai-compat response with no `usage` field), the dispatch degrades to today's plain-text/self-report behavior with no `_orchestrator_observed` block — a telemetry miss never fails a dispatch.
3. **Orchestrator estimate, for hosts with no native capture (gemini-cli, antigravity, generic, omnigent — items 28.3/28.6).** Each host's `capabilities.json` now declares `telemetry: "native"` or `telemetry: "estimated"` (enforced by `tests/adapter-contract.test.js`; see `docs/reference/hosts.md`). When a dispatch's host declares `telemetry: "estimated"` and no native usage was observed, `core/orchestrator.js`'s `patchGateForEstimatedUsage` writes `_orchestrator_observed: { tokens_estimated: true, tokens_in_estimate, source: "orchestrator:prompt-bytes-estimate", at }` — `tokens_in_estimate` is `promptBytes / 4` (bytes actually sent to the host, from the prompt-telemetry already tracked per dispatch), rounded. The field is deliberately never named `tokens_in`, and `tokens_estimated: true` always accompanies it, so a consumer that reads `_orchestrator_observed.tokens_in` without checking the flag gets nothing rather than a silently-blended estimate. gemini-cli's backend stopped serving requests 2026-06-18 (see phase-28's "why this phase" note and item 28.6/Antigravity) — investing in a native JSON parser for a host being replaced was explicitly deferred; see the phase-28 item 28.3 PR report for the investigation notes on `codex exec --json` and `gemini -o json`/`-o stream-json`.
4. **Stage-merge rollup** (orchestrator). When `devteam merge <stage>` aggregates per-workstream gates, it sums any cost fields present and emits stage-level `tokens_in` / `tokens_out` / `cost_usd` / `duration_ms` totals on the merged gate. Per-workstream detail is preserved inside the `workstreams[]` array. The rollup sums the model-asserted fields in the table above; it does not yet fold in `_orchestrator_observed` (that's item 28.4 — budget enforcement preferring observed cost).

**Trust boundary.** `_orchestrator_observed` records what the orchestrator itself parsed from the host CLI's own JSON output (claude-code, codex) or accumulated from the API's own `usage` object (openai-compat) — an observation, not a claim. `tokens_estimated: true` gates flip this: that block is the orchestrator's own guess (bytes ÷ 4), not an observation — treat it as strictly lower-confidence than either the model's self-report or a real `_orchestrator_observed` capture, and never average it in with either. The top-level `model`/`tokens_in`/`tokens_out`/`cost_usd` fields above remain whatever the agent wrote into the gate, self-reported and unverified. Nothing today prefers one over the other automatically (that's item 28.4); until then, treat `_orchestrator_observed` (without `tokens_estimated`) as the more trustworthy source when both are present on a claude-code, codex, or openai-compat gate.

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
- **Per-tier cost deltas (phase-32 item 32.3)**, additive to D4/D5: `scripts/performance.js`'s `aggregatePerformanceByModel` groups by `(role, host, model)` instead of just `(role, host)` — feeding `scripts/routing-suggest.js`'s "Per-tier cost deltas" report section, which shows cost-per-pass and pass-rate for every distinct model a role has run under (host held fixed), sorted cheapest-first with a `$` delta against the cheapest tier. Reported only when a role has ≥2 qualifying `(host, model)` pairs — nothing to compare against otherwise. Advisory only, like the rest of this report: no config change is ever proposed from it, unlike the host-level recommendation above. This is the evidence to check before committing to a `routing.tiers` preset (see `docs/user-guide.md`'s "frontier plans, cheap executes" example) project-wide — it tells you whether the cheap tier is actually cheaper *per pass* (not just per token) once retries are accounted for.

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

- **Token reporting is uneven** across host CLIs. Claude Code exposes precise counts via `--print --output-format stream-json --verbose`, now orchestrator-parsed into `_orchestrator_observed` (item 28.1); openai-compat sums the API's own `usage` object across the tool loop (item 28.2); codex exposes the same via `--json`'s `turn.completed` event, though without a model id or dollar cost (item 28.3). gemini-cli offers `-o json`/`-o stream-json` with token stats in principle, but its backend has stopped serving requests since 2026-06-18 and the host is being retired in favor of Antigravity (item 28.6) — a native parser was not built for it; Antigravity CLI (`agy`) itself also has an `--output-format json`/`stream-json` flag that a future item could parse, but item 28.6 only shipped the adapter, not a usage parser. Both, and any other host declaring `telemetry: "estimated"` (generic, omnigent), get a `promptBytes / 4` estimate instead, clearly flagged with `tokens_estimated: true` / `tokens_in_estimate` so it's never confused with an observed value.
- **Pricing drift.** The pricing table needs periodic updates. If prices change between updates, `cost_usd` figures are off by the drift. `_orchestrator_observed.cost_usd` sidesteps this for claude-code — it's the CLI's own billed `total_cost_usd`, not a token × pricing-table computation. openai-compat has no equivalent self-reported bill, so its `_orchestrator_observed.cost_usd` IS a token × pricing-table computation and inherits this drift risk directly (and is `null` for any model not in `core/pricing.js`).
- **Cached input tokens** (Claude's prompt caching, GPT's similar feature) aren't tracked separately. The reported `tokens_in` includes everything; cost calculations don't apply cache discounts. Treat as upper bound. This still applies to `_orchestrator_observed.tokens_in` — for claude-code it's `usage.input_tokens` from the CLI's result message, not broken out from `cache_creation_input_tokens`/`cache_read_input_tokens`; for openai-compat, `_orchestrator_observed.cached_tokens` records the summed `prompt_tokens_details.cached_tokens` separately, but `cost_usd` still prices the full `tokens_in` at the uncached rate — no cache discount is applied. `_orchestrator_observed.cost_usd` for claude-code is the CLI's actual billed cost and already reflects any cache discount.
- **No latency-cost decomposition.** A slow stage and an expensive stage are different things. `duration_ms` and `cost_usd` are both reported, but with no derived "$/min" metric. The dashboard table includes both columns so you can interpret as needed.
- **`routing.escalate_on_retry` can raise cost on a stage that was already going to retry.** The point is bounded: it bumps exactly one tier, once, per fix-and-retry dispatch — it never compounds across multiple retries of the same stage (each retry re-escalates from the *route's* pinned model, not from wherever the previous retry landed). Still, budget-conscious configs should watch `_orchestrator_escalated` in the corpus if `--budget-usd` enforcement matters to you; escalation isn't yet folded into pre-dispatch budget checks (same gap noted above for D7/28.4's cost-preference work).

## See also

- [`core/pricing.js`](../core/pricing.js) — the pricing table.
- [`scripts/dashboard.js`](../scripts/dashboard.js) — `--view cost` aggregation.
- [`docs/BACKLOG.md`](BACKLOG.md) — D4 (performance scores) and D5 (adaptive routing).
- [`docs/observability.md`](observability.md) — OTel tracing (separate observability layer).
