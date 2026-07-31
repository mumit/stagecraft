# Phase 28 — Ground Truth: Token/Cost Telemetry, Run Corpus, Host Continuity

Status: **proposed** (from [landscape-review-2026-07.md](landscape-review-2026-07.md) §3.1, §3.7).
Prompts: [prompts/roadmap-2026-prompts.md](prompts/roadmap-2026-prompts.md) §28.

## Why this phase is first

Four capability gates (D5 adaptive routing, H3 recipe factory, ADR-005 standing grants,
ADR-007 Tier 2) are shut for lack of real-run telemetry — and the telemetry is missing
because **no adapter captures token usage** even where the host offers it. Meanwhile
`--budget-usd` enforces against model-self-reported `cost_usd`, which is a trust
inversion in a framework whose thesis is "never trust the model's claims."
Everything in phases 30/32/33 consumes this data. Separately, Gemini CLI (a shipped host)
stopped serving requests 2026-06-18 in favor of Antigravity CLI — a live adapter break.

## Work items

### 28.1 claude-code adapter: orchestrator-observed usage

[verify-first] Claim: `hosts/claude-code/` builds its headless command with
`claude --dangerously-skip-permissions --print` and no `--output-format`, so usage
metadata is discarded (see `core/adapters/headless.js` and the adapter's
`headlessCommand`).

Implement: request JSON output (`--output-format stream-json --verbose` or the current
equivalent per `claude --help`), parse the final result message for
`usage.input_tokens` / `usage.output_tokens` / `total_cost_usd` / model id, and surface
them on the workstream result object returned by `runHeadless`. The orchestrator (not
the adapter) writes `tokens_in`, `tokens_out`, `cost_usd`, `model_observed` into the
gate under an `_orchestrator_observed` block — same pattern as `core/verify/stamp.js`
`_orchestrator_stamped`: model-asserted fields are preserved, observed fields win.
Keep plain-text transcript logging to `pipeline/logs/` working (parse JSON stream,
tee the text content).

Fallback: if JSON parsing fails, keep today's behavior and set
`telemetry: "unavailable"` — never fail a dispatch over telemetry.

- Acceptance: a stubbed stream-json fixture produces a gate with observed tokens/cost;
  a plain-text stub degrades gracefully; `tests/` cover both.
- Verify: `npm test`, `CI=true DEVTEAM_HEADLESS_COMMAND=cat npm test`, `npx eslint .`,
  `npm run consistency`.

### 28.2 openai-compat adapter: record `usage` from every API turn

[verify-first] Claim: `hosts/openai-compat/invoke.js` receives the API `usage` object
on each completion and never reads it.

Implement: accumulate `prompt_tokens` / `completion_tokens` (and
`prompt_tokens_details.cached_tokens` when present) across all iterations of the tool
loop; return totals on the invoke result; orchestrator writes the same
`_orchestrator_observed` block as 28.1. Compute `cost_usd` via `core/pricing.js`
(`computeCostUsd`), leaving `null` for unknown models rather than guessing.

- Acceptance: the existing openai-compat test suite (stub server) asserts summed usage
  across a multi-turn tool loop, including the cached-token field.

### 28.3 codex + gemini/antigravity: usage capture where offered, estimates otherwise

Investigate `codex exec` JSON output flags (e.g. `--json`) and capture usage if
available; same for the antigravity/gemini binary. Where the host CLI offers no usage,
record `tokens_estimated: true` with a bytes→tokens estimate (promptBytes/4 heuristic,
labelled as such) so downstream consumers can filter estimated rows. Never mix
estimated and observed values without the flag.

- Acceptance: capability docs in each host's `capabilities.json` gain a
  `telemetry: "native" | "estimated"` field; adapter-contract test updated.

### 28.4 Budget enforcement uses observed cost

[verify-first] Claim: `driver.totalCostUsd()` (core/driver.js) sums `gate.cost_usd`
written by the model.

Implement: prefer `_orchestrator_observed.cost_usd` when present, fall back to
model-asserted with a one-time run-log warning (`cost_basis: "model-asserted"`).
`devteam status` and `devteam report` display the basis. The `--budget-usd` pre-dispatch
check and halt logic are otherwise unchanged (ADR-003 refinement of decision #8 stands).

- Acceptance: driver tests cover mixed gates (observed + asserted); report shows basis.

### 28.5 Run corpus: one sanitized record per dispatch

The substrate for D5/H3/GEPA/evals. After every headless dispatch, append one JSON line
to `.devteam/corpus/dispatches.jsonl` (project-local, gitignored by the managed block):

`{ts, run_id, stage, role, host, model_observed, track, prompt_hash, prompt_bytes,
tokens_in, tokens_out, cost_usd, cost_basis, duration_ms, queue_ms, gate_status,
blockers: [sanitized], retry_of, framework_version}`

Reuse the secret-scan sanitizer from `core/patterns.js` collection for blocker text.
Corpus writes are fire-and-forget (never fail a run). Add `devteam corpus stats`
(count, per-stage pass rates, per-(role,host) dispatch counts — i.e., exactly the
evidence the D5/H3 gates ask for). Wire `scripts/routing-suggest.js` to read the corpus
as a first-class source alongside gates.

- Acceptance: a full stubbed run produces N corpus lines for N dispatches; stats command
  reports the evidence-gate counters; a secret planted in a blocker never reaches disk.

### 28.6 Antigravity CLI host continuity

Gemini CLI stopped serving requests 2026-06-18. Add `hosts/antigravity/` as a sibling of
`hosts/gemini-cli/` (both thin shells over `makeMarkdownHostAdapter`), with the correct
binary name, headless invocation, and skills-directory layout per Antigravity plugin
docs. `devteam doctor` warns when routing targets `gemini-cli` and the binary is absent
or EOL, suggesting `antigravity`. Keep `gemini-cli` installed-but-deprecated for one
release; document the migration in `docs/user-guide.md`.

- Acceptance: `devteam init --host antigravity` installs; contract tests pass for the new
  adapter; doctor emits the deprecation notice on a gemini-cli-routed project.

## Out of scope

Adaptive routing behavior changes (D5 stays evidence-gated — this phase produces the
evidence), corpus upload/sharing (privacy model unchanged: local-only), pricing-table
automation.

## Success signal

100% of headless dispatches on claude-code and openai-compat carry orchestrator-observed
token counts; `devteam corpus stats` can answer the D5 evidence question ("≥5 dispatches
per (role,host) across ≥2 projects?") from data instead of "zero telemetry."
