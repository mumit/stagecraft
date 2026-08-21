# Reproducibility (C4)

Stagecraft records exactly what produced each gate: model version, temperature, seed, max_tokens, a hash of the system prompt, a hash of the tool surface. The gate JSON tells you not just *that* a change was made, but *what configuration* made it.

This is the **C4** BACKLOG item. It pairs with **E6** (`devteam replay <stage>`, which re-runs a recorded gate and diffs against the original) and supports audits that require evidence of how a change was developed: SOC 2, EU AI Act, and internal compliance reviews.

- [What "reproducible" honestly means with LLMs](#what-reproducible-honestly-means-with-llms)
- [Execution-plan fingerprint](#execution-plan-fingerprint)
- [The recorded fields](#the-recorded-fields)
- [How fields land in the gate](#how-fields-land-in-the-gate)
- [Using the recorded fields](#using-the-recorded-fields)
- [Replay readiness levels](#replay-readiness-levels)
- [What this enables now vs later](#what-this-enables-now-vs-later)
- [Replay (E6)](#replay-e6)
- [Prompt-pack version (C4's consumer)](#prompt-pack-version-c4s-consumer)
- [Caveats](#caveats--be-honest-about-whats-recorded)
- [See also](#see-also)

## What "reproducible" honestly means with LLMs

Reproducibility here has a specific, bounded meaning.

What it is **not**:

- **Not strict determinism.** Even at `temperature: 0`, most LLM APIs are nondeterministic across serving updates. Vendors change underlying infrastructure; the same prompt today and tomorrow can produce different outputs without warning.
- **Not a guarantee.** Recording `seed: 42` only matters if the host honors seeded sampling. Anthropic's API does at temperature 0; not all hosts implement it consistently.

What it **is**:

- **Auditability.** The gate JSON alone answers "what model, what temperature, what prompt, what tools." No guessing, no chasing config history.
- **Drift detection.** Re-render the prompt today, hash it, compare to the gate's hash. Drift means the prompt changed: role brief edited, skill updated, or rules file revised.
- **Replay readiness.** With enough recorded fields, `devteam replay <stage-id>` re-invokes the host with the current config and diffs the result against the original. The model itself may still drift, but the *configuration* is preserved.

## Execution-plan fingerprint

Before any autonomous dispatch, `devteam run` writes `pipeline/run-plan.json`
([ADR-018](adr/018-materialized-run-plan-and-loop-default.md)). Its SHA-256
`plan_fingerprint` binds the stable run-level controls: resolved track and
provenance, configured stage selection, track-sized roles, and configured
host/model routes. `--resume` refuses to proceed when those controls drift.

This is distinct from the per-gate fingerprints below. The run-plan fingerprint
answers “is this still the execution plan I reviewed?” It does not hash prompts,
model output, or dynamic evidence. Right-sizing observations and conditional
stages are explicitly reevaluated as earlier stages produce code and gates; the
append-only run log records the resulting runtime decisions.

`--until` is recorded in the plan but deliberately left out of both
fingerprints. It is where the operator paused, not what the plan *is*: folding
it in would make the ordinary “run `--until build`, review, `--resume`” cycle
report policy drift and refuse to continue. The plan reports the boundary
alongside the counts instead — `until` names the last stage this invocation
will run, and `stages_after_until` says how many included stages it puts out of
reach, while `stages_included` keeps its meaning of what the track executes.

## The recorded fields

Optional additions to every gate, defined in `core/gates/schemas/gate.schema.json`:

| Field | What | Source |
|---|---|---|
| `model` | Adapter-namespaced model id (`claude-opus-4-7`) | D6 (cost telemetry) — already on the gate |
| `model_version` | Vendor's exact version (`claude-opus-4-7-20251104`) | Agent fills in |
| `temperature` | Sampling temperature used (number, 0–2) | Agent fills in |
| `seed` | RNG seed when supported by the host | Agent fills in |
| `max_tokens` | max_tokens parameter passed to the model | Agent fills in |
| `system_prompt_hash` | sha256 of the rendered system prompt (normalized) | **Computed and embedded by the adapter** when rendering — the agent stamps it verbatim |
| `tools_hash` | sha256 of the sorted, deduplicated tool-name list | Agent fills in if known |

All optional. Agents fill them in when they know; missing fields show up as `null` in fingerprints (distinguishable from "field was zero").

## How fields land in the gate

Three paths:

1. **Orchestrator-computed.** `system_prompt_hash` is computed by the adapter at prompt-render time. The hash is embedded directly in the gate skeleton hint the agent sees; the agent stamps it verbatim into the gate JSON.

2. **Agent-self-reports.** `model_version`, `temperature`, `seed`, `max_tokens`, `tools_hash` are filled in by the agent when it knows them. Claude Code subagents have access to their own `model:` frontmatter; headless invocations get them from the CLI flags they were invoked with.

3. **Post-hoc tools** (future). A `devteam gate-stamp` subcommand could parse host CLI logs (e.g. Claude's `--output-format json` response payload) and back-fill the recorded fields. Not yet built.

## Using the recorded fields

### `devteam reproduce <stage-id>`

The audit-facing tool. Reads `pipeline/gates/<stage-id>.json`, prints what was recorded, classifies replay readiness, and (if the stage is still defined) re-renders the current prompt to compare hashes.

```
$ devteam reproduce stage-04.backend
Reproducibility report — pipeline/gates/stage-04.backend.json

Recorded by orchestrator: devteam@0.4.0
Recorded at:              2026-05-15T14:32:11Z
Stage / workstream / host: stage-04 / backend / codex

Replay readiness: FULL — all reproducibility fields recorded

Recorded fields:
  model                claude-opus-4-7
  model_version        claude-opus-4-7-20251104
  temperature          0.0
  seed                 42
  max_tokens           8000
  system_prompt_hash   sha256:9f86d081…
  tools_hash           sha256:ef537f25…

Drift check (current rendered prompt vs gate hash):
  ⚠️  DRIFT — the rendered prompt has changed since this gate was written.
     gate:    sha256:9f86d081…
     current: sha256:abc12345…
     Likely causes: role brief, skill, or rules file edits.
```

JSON mode (`--json`) emits the same info as a structured object for tooling.

### `core/reproducibility.js` API

Programmatic use:

```js
const {
  hashSystemPrompt,
  hashTools,
  reproducibilityFingerprint,
  compareFingerprints,
  replayReadiness,
} = require("./core/reproducibility");

// Hash a prompt (the adapter does this for you in renderStagePrompt):
hashSystemPrompt(promptText)      // → "sha256:..."

// Hash a tools list (order- and duplicate-invariant):
hashTools(["Read", "Write", "Edit"])  // → "sha256:..."

// Reduce a gate to its reproducibility-relevant fields:
const fp = reproducibilityFingerprint(gate);

// Diff two fingerprints:
compareFingerprints(beforeFp, afterFp)
// → [{ field, before, after, kind: "drift" | "absent" | "match" }]

// Classify how reproducible a gate is:
replayReadiness(gate)
// → { level: "full" | "partial" | "incomplete", reason, missing_required, missing_helpful }
```

## Replay readiness levels

- **`full`** — every reproducibility field is recorded. Could plausibly replay the run from the gate alone.
- **`partial`** — required fields present (`model` + `system_prompt_hash`) but some helpful ones missing. Audit-complete; replay would be approximate.
- **`incomplete`** — at least one required field is missing. Pre-D6 gates fall here; gates whose agent forgot to stamp `system_prompt_hash` fall here.

## What this enables now vs later

**Now:**
- Audit: "what configuration produced this artifact?" The answer is in the gate.
- Drift detection: "would the same prompt render today?" `devteam reproduce` compares hashes.
- **Re-run with diff:** `devteam replay <stage-id>` re-invokes the host with current config and diffs the new gate against the original (see § Replay below).
- Compliance evidence: SOC 2 / EU AI Act ask for records of how AI decisions were made. The gate JSON + these tools together are that record.

**Soon (planned):**
- Config-side pinning: `.devteam/config.yml` `reproducibility.model_pins: { stage-04: claude-opus-4-7-20251104 }`. Adapter reads it and passes to the host. Not yet built (per-host adapter work).
- Cross-host hash stability: `system_prompt_hash` is host-specific today (each adapter renders slightly differently). A host-neutral prompt hash would let drift detection work across host migrations.

## Replay (E6)

`devteam replay <stage-id>` re-runs a recorded stage against the **current** configuration and writes the result to a non-clobbering path. What replay does and doesn't do:

**What replay does:**
- Reads the original gate at `pipeline/gates/<stage-id>.json`.
- Re-renders the prompt for that stage with the current role brief / skill / rules / templates / etc.
- Invokes the host CLI headlessly (uses the same mechanics as `--headless`).
- Writes the new gate to `pipeline/gates/replay/<stage-id>.<timestamp>.json` (subdirectory, so it doesn't pollute regular pipeline state).
- Restores the original gate to its canonical path (the headless run overwrote it during invocation).
- Diffs the two gates and prints what changed: status, blockers, cost / tokens / duration, reproducibility fields.

**What replay does NOT do:**
- Pin per-invocation params (temperature, seed, model_version) at the host CLI level. Different hosts expose those flags differently; that is separate work. Replay uses *current* config and the diff makes drift visible.
- Recover from upstream nondeterminism. The model itself may produce different output for the same prompt and same params when vendor serving changes.

**What replay tells you:**
- Whether this stage still produces similar output today — a smoke test against a recorded run.
- Combined with `devteam reproduce`'s drift check: exactly what is different between the original run and now.

### Usage

```bash
# Dry-run shows the plan + drift check WITHOUT invoking the host.
$ devteam replay stage-04.backend --dry-run

# Real replay:
$ devteam replay stage-04.backend

Replay plan — pipeline/gates/stage-04.backend.json
  Original gate:
    Recorded at:        2026-05-15T14:32:11Z
    Host:               codex
    Model:              gpt-5
    Temperature:        0.0
    Replay readiness:   FULL
  Replay configuration (CURRENT, not pinned):
    Host:               codex
  Prompt hash drift:  ⚠️  DRIFT
    original: sha256:9f86d081…
    current:  sha256:abc12345…
    The replay will use the CURRENT prompt — outputs may differ for
    prompt-level reasons, not just model nondeterminism.

[replay] invoking codex headlessly…
Replay complete → pipeline/gates/replay/stage-04.backend.2026-11-30T10-15-43-922Z.json

  Status:
    original → PASS
    replay   → PASS

  Reproducibility-field drift (2):
    model_version        drift    gpt-5-20251101 → gpt-5-20261030
    system_prompt_hash   drift    sha256:9f86d081… → sha256:abc12345…

  Cost / duration:
    cost_usd        0.64 → 0.71
    tokens_in       40000 → 41200
    duration_ms     95000 → 102000
```

### How replay decides "a new gate was written"

Replay captures the original gate file's mtime before invoking the host, then requires the mtime to advance after invocation. This catches the case where the host CLI exits 0 but writes nothing. Without the mtime check, the framework would mistake a no-op for success.

### `--dry-run` mode

`devteam replay <stage-id> --dry-run` prints the plan (original metadata, current host, prompt-hash drift) without invoking the host. Use it for:
- Quick audit checks before a real replay
- CI checks that surface drift without spending LLM dollars
- Previewing the plan before committing to a full replay

### Output paths

Original gate stays at `pipeline/gates/<stage-id>.json` (restored after the headless run overwrites it).
Replay gates land at `pipeline/gates/replay/<stage-id>.<iso-timestamp>.json`. The replay subdirectory is outside what the validator scans; replay gates do not participate in normal pipeline-state decisions.

## Prompt-pack version (C4's consumer)

`system_prompt_hash` (above) tells you a *single dispatch's* rendered prompt drifted. It says nothing about whether the drift was good or bad, and it's per-dispatch — there's no single value you can compare across a whole run, or across two different runs taken weeks apart, to ask "did the last round of role-brief edits actually help?"

`prompt_pack_version` (phase-33 item 33.3, [`plans/phase-33-eval-flywheel.md`](../plans/phase-33-eval-flywheel.md) §33.3) is that value: a short content-hash version of the whole prompt surface — every file under `roles/`, `rules/`, and `templates/` (stable sorted ordering), sha256'd and truncated to 12 hex chars ([`core/prompt-pack.js`](../core/prompt-pack.js)). It changes if and only if a role brief, rule file, or template changes; it's identical across every stage and role dispatched from the same framework checkout.

Unlike the reproducibility fields in the table above, `prompt_pack_version` is never model-asserted — it's orchestrator-computed, the same "add a distinct orchestrator-owned field, never let the model touch it" discipline as `_orchestrator_observed`. It lands on a gate two ways, mirroring `dispatched_tool_budget`'s dual-path convention:

- **Headless runs:** `core/orchestrator.js`'s `patchGateWithPromptPackVersion` patches it onto the workstream gate right after dispatch (and the merged stage gate carries its own copy too).
- **User-driven runs:** `core/gates/validator.js`'s `autoInjectMetadata` injects it into the SubagentStop hook's gate the same way it injects `orchestrator`/`host`.

It's recorded identically in three places, so the same value is queryable from wherever you're looking:

| Where | Field | Written by |
|---|---|---|
| Every gate | `prompt_pack_version` | `core/gates/schemas/gate.schema.json` (optional, additive) |
| Every run-corpus row | `prompt_pack_version` | `core/corpus.js` (28.5 — `.devteam/corpus/dispatches.jsonl`) |
| Every eval case | `prompt_pack_version` | `core/evals/capture.js` (33.1 — `.devteam/evals/cases/*/case.json`) |

### `devteam evals compare --pack <A> --pack <B>`

Turns "did the new principal brief help?" into a query instead of a feeling: per-stage pass-rate deltas between two pack versions, computed from the run corpus.

```
$ devteam evals compare --pack a1b2c3d4e5f6 --pack 32419bc9c408
Prompt-pack compare: a1b2c3d4e5f6 vs 32419bc9c408 (min-n: 5)
  stage-04         A: 6 dispatches, 83.3% pass   B: 9 dispatches, 88.9% pass   Δ +5.6pp
  stage-06         refused — fewer than 5 dispatches on 32419bc9c408 for this stage (a1b2c3d4e5f6: 7, 32419bc9c408: 2)
```

Honesty rule: a stage is refused (never assigned a delta) when either pack has fewer than `--min-n` dispatches for that stage — default 5, the same floor D5 uses elsewhere in the corpus (`core/corpus.js`#`computeStats`). `--json` emits the same comparison as structured data for tooling. This is local-only, like the rest of the corpus — there is no cross-project pack comparison.



- **Cached prompt segments.** Anthropic and OpenAI both support prompt caching; cached portions bill differently. `system_prompt_hash` covers the full prompt but does not reflect cache state. Two runs with identical hashes may have different cache hits and different cost profiles. Cost (D6) and prompt hash (C4) are independent dimensions.
- **Multimodal inputs.** If a stage's prompt includes images (G5, not yet shipped), the hash treats them as opaque base64. Re-encoding the same image differently would change the hash.
- **Tool surface drift.** `tools_hash` captures the *names* of available tools, sorted. Two hosts with the same tool names but different tool *implementations* hash identically. The hash reflects what the model could call, not how the call resolves.
- **Time of day, region, vendor serving state.** Not captured by any hash. These can affect output without leaving a trace. Framework-level reproducibility does not address vendor-side nondeterminism.

## See also

- [`core/reproducibility.js`](../core/reproducibility.js) — implementation.
- [`core/prompt-pack.js`](../core/prompt-pack.js) — `prompt_pack_version` content hash (33.3).
- [`core/evals/compare.js`](../core/evals/compare.js) — `devteam evals compare` (33.3).
- [`core/gates/schemas/gate.schema.json`](../core/gates/schemas/gate.schema.json) — the optional fields.
- [`docs/cost.md`](cost.md) — D6 cost telemetry, the sibling "recorded on the gate" feature.
- [`docs/observability.md`](observability.md) — OTel spans, the runtime-side complement.
- [`docs/BACKLOG.md`](BACKLOG.md) C4 — the BACKLOG entry this implements; E6 (replay) is the natural follow-up.
