# Cost telemetry

Stagecraft records per-workstream LLM usage in gate JSON and aggregates it in reports. Native adapters capture usage where hosts expose it; other adapters can add a clearly marked prompt-byte estimate. Agent-authored telemetry remains optional and is never trusted for token-budget enforcement.

This is the **D6** BACKLOG item. It is the data foundation for D4 (per-role per-model performance scores) and D5 (adaptive routing). On its own it answers "where did our LLM spend go this sprint?"

- [Quick start](#quick-start)
- [Pre-run cost planning](#pre-run-cost-planning)
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

## Pre-run cost planning

`devteam assess` shows the recommended track and a side-by-side comparison of
the three primary assurance choices: `loop`, `quick`, and `full`. Its JSON
output exposes the recommendation as `ceremony_preview` and the comparison as
`assurance_options`.

Before a run has enough comparable history, the planner estimates prompt input
from framework and on-disk pipeline artifacts. It resolves a model in this
order:

1. the explicit `{host, model}` pin for the stage or role;
2. the most recently observed model for the unpinned `(role, host)` pair;
3. unresolved — no dollar figure is shown.

Each static dispatch includes `model_source: "configured"`, `"observed"`, or
`null`. Static `tokens_scope` is `estimated-input` and `cost_scope` is
`input-only-floor`: output generation is excluded because its volume cannot be
known before execution. This is useful for comparing ceremony but is not a
budget ceiling. Use `devteam run --budget-usd <amount>` and/or
`devteam run --budget-tokens <count>` as runtime halt thresholds. Both check
cumulative usage before the next dispatch and can overshoot by one dispatch.
The token cap accepts orchestrator-observed counts plus explicitly flagged
prompt-byte estimates, includes retries and resumes from the append-only run
corpus, and ignores model-authored token claims. It is provider-neutral local
accounting, not a prediction of a subscription quota. `cached_tokens` is a
subset of input tokens and is not added again.

After at least five completed runs of the exact track, the preview switches to
an empirical median with `tokens_scope` and `cost_scope` set to
`observed-total`. All figures remain estimates rather than provider invoices.

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
2. **Adapter post-processes (claude-code — phase-28 item 28.1; openai-compat — item 28.2; codex — item 28.3).** The claude-code headless command requests `--output-format stream-json --verbose`; `core/adapters/headless.js` parses the stream for the final result message's `usage.input_tokens` / `usage.output_tokens` / `total_cost_usd` / model id. codex's headless command requests `--json`; the same `core/adapters/headless.js` parses the resulting JSONL for the `turn.completed` event's `usage.input_tokens` / `usage.cached_input_tokens` / `usage.output_tokens` — codex's stream reports neither a model id nor a dollar cost, so `model_observed`/`cost_usd` stay `null` rather than guessed — in that case the orchestrator derives `cost_usd_derived` from the observed tokens and `core/pricing.js`, priced by `model_observed` when the host gave one and otherwise by the routing-resolved pin, recording which id was used in `cost_model`. The derived figure never occupies `cost_usd`: a product of observed tokens and a table Stagecraft maintains is a weaker evidence class than a cost the host reported, and merging them would launder an estimate into an observation. With no model id, or no pricing entry for it, both fields are simply absent. openai-compat has no CLI to parse — `hosts/openai-compat/invoke.js` instead sums `usage.prompt_tokens` / `usage.completion_tokens` / `usage.prompt_tokens_details.cached_tokens` from every chat-completion response across the tool loop, and computes `cost_usd` itself via `core/pricing.js` `computeCostUsd` (unknown model → `cost_usd: null`, never a guess — unlike claude-code, the API never reports its own bill). Either way, `core/orchestrator.js`'s shared `patchGateForObservedUsage` writes the result onto the workstream gate under `_orchestrator_observed` — a distinct block from the fields in the table above, never overwriting the model's self-report. `_orchestrator_observed` fields are: `tokens_in`, `tokens_out`, `cached_tokens` (openai-compat and codex only, omitted when zero), `cost_usd`, `cost_usd_derived` and `cost_model` (both present only when the host reported tokens but no cost and a price was resolvable), `model_observed`, `source` (`"claude-code:stream-json"`, `"codex:exec-json"`, or `"openai-compat:usage"`), `at`. If usage can't be observed (older claude/codex CLI ignoring the output flag; an openai-compat response with no `usage` field), the dispatch degrades to today's plain-text/self-report behavior with no `_orchestrator_observed` block — a telemetry miss never fails a dispatch.
3. **Orchestrator estimate, for hosts with no native capture (gemini-cli, antigravity, generic, omnigent — items 28.3/28.6).** Each host's `capabilities.json` now declares `telemetry: "native"` or `telemetry: "estimated"` (enforced by `tests/adapter-contract.test.js`; see `docs/reference/hosts.md`). When a dispatch's host declares `telemetry: "estimated"` and no native usage was observed, `core/orchestrator.js`'s `patchGateForEstimatedUsage` writes `_orchestrator_observed: { tokens_estimated: true, tokens_in_estimate, source: "orchestrator:prompt-bytes-estimate", at }` — `tokens_in_estimate` is `promptBytes / 4` (bytes actually sent to the host, from the prompt-telemetry already tracked per dispatch), rounded. The field is deliberately never named `tokens_in`, and `tokens_estimated: true` always accompanies it, so a consumer that reads `_orchestrator_observed.tokens_in` without checking the flag gets nothing rather than a silently-blended estimate. gemini-cli's backend stopped serving requests 2026-06-18 (see phase-28's "why this phase" note and item 28.6/Antigravity) — investing in a native JSON parser for a host being replaced was explicitly deferred; see the phase-28 item 28.3 PR report for the investigation notes on `codex exec --json` and `gemini -o json`/`-o stream-json`.
4. **Stage-merge rollup** (orchestrator). When `devteam merge <stage>` aggregates per-workstream gates, it sums any cost fields present and emits stage-level `tokens_in` / `tokens_out` / `cost_usd` / `duration_ms` totals on the merged gate. Per-workstream detail is preserved inside the `workstreams[]` array. The rollup remains a presentation of agent-authored fields; runtime budget code reads the authoritative workstream observations directly so it neither trusts that rollup nor double-counts merged and workstream gates.

**Trust boundary.** `_orchestrator_observed` records what the orchestrator itself parsed from the host CLI's own JSON output (claude-code, codex) or accumulated from the API's own `usage` object (openai-compat) — an observation, not a claim. `tokens_estimated: true` marks the orchestrator's bytes ÷ 4 estimate instead. The top-level `model`/`tokens_in`/`tokens_out`/`cost_usd` fields remain agent-authored and unverified. Runtime dollar accounting prefers a host-reported cost, then a token-derived one, then the model's claim, and reports which through `cost_basis` (`observed` / `derived` / `model-asserted` / `mixed`); runtime token budgeting accepts only observed or explicitly estimated orchestrator data and exposes `token_basis` plus `token_coverage_complete` so incomplete coverage is visible.

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
- **GEPA-style offline prompt optimization (phase-33 item 33.4)** — `scripts/prompt-optimize.js` (out-of-band, experimental, human-gated; never a `devteam` command). Given `--target roles/<role>.md|rules/<name>.md` and a mandatory `--budget-usd`, reflects on captured eval-case failures with a frontier model, scores each proposal structurally and against a budget-capped real-model subset, and prints a diff for human review — it never writes the target file or auto-applies anything. Cost tracking here reuses the same "estimate, never a bill" posture as `evals run`'s cost preview (byte-sampled, priced off the most recently observed model for the role/host pair).

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
- **Cached input tokens** are provider-dependent. Codex and openai-compat record `cached_tokens` when reported; Claude Code does not currently break cache creation/read tokens out of its observed `tokens_in`. Cached tokens remain a subset of input and are never added again to token-budget totals. Local openai-compat cost calculation still prices full input at the uncached rate; Claude Code's observed dollar cost comes from the CLI and already reflects provider billing.
- **No latency-cost decomposition.** A slow stage and an expensive stage are different things. `duration_ms` and `cost_usd` are both reported, but with no derived "$/min" metric. The dashboard table includes both columns so you can interpret as needed.
- **`routing.escalate_on_retry` can raise cost on a stage that was already going to retry.** The point is bounded: it bumps exactly one tier, once, per fix-and-retry dispatch — it never compounds across multiple retries of the same stage (each retry re-escalates from the *route's* pinned model, not from wherever the previous retry landed). Still, budget-conscious configs should watch `_orchestrator_escalated` in the corpus if `--budget-usd` enforcement matters to you; escalation isn't yet folded into pre-dispatch budget checks (same gap noted above for D7/28.4's cost-preference work).

## See also

- [`core/pricing.js`](../core/pricing.js) — the pricing table.
- [`scripts/dashboard.js`](../scripts/dashboard.js) — `--view cost` aggregation.
- [`docs/BACKLOG.md`](BACKLOG.md) — D4 (performance scores) and D5 (adaptive routing).
- [`docs/observability.md`](observability.md) — OTel tracing (separate observability layer).
