# ADR 023 — Convergence conditions belong in the prompt, not a host slash command

**Status:** Accepted
**Date:** 2026-08-20
**Authors:** Stagecraft maintainers

## Context

[BACKLOG E7](../BACKLOG.md) shipped in v0.6.0: `build` (stage-04) and `qa`
(stage-06) declare a `goalCondition`, and hosts that declare
`capabilities.goalLoop: true` receive `/goal "<condition>"` prepended to the
headless prompt so the host loops until the objective is met rather than
running a fixed number of turns.

Claude Code's `/goal` handler rejects input over 4,000 characters. In `--print`
mode the whole piped stdin is one message, so the limit applies to the combined
prompt, not to the condition. Verified against claude-code 2.1.207 on
2026-08-20:

```
$ claude --print < over-limit.txt
Goal condition is limited to 4000 characters (got 5886)
$ echo $?
0
```

Note the exit code: a rejected dispatch **succeeds**, with no model call, no
gate written, and nothing on stderr.

`core/orchestrator.js` guards against that with a three-step fallback — drop
`patchItems`, then drop the inlined framework, then drop the `/goal` directive
itself. A dispatch prompt with the framework inlined is roughly 21 KB, so step
one never suffices and step two always runs. What that buys is measured below,
dispatching through `DEVTEAM_HEADLESS_COMMAND=cat` so the log holds the exact
bytes the host CLI would have received:

| Dirty files | Bytes sent | Inlined framework | `/goal` survives |
|---:|---:|:---:|:---:|
| 3 | 3,848 | ✗ dropped | ✓ |
| 12 | 4,742 | ✗ dropped | ✗ |
| 30 | 6,758 | ✗ dropped | ✗ |

Two things follow, and only the first is unconditional.

**The inlined framework is discarded on every `build` and `qa` dispatch.**
[Phase 37](../../plans/phase-37-interface-and-token-efficiency.md) item 37.2
exists to put ~22 KB of framework prose in a byte-stable, cacheable prompt
prefix so the model stops re-reading it through tool calls. On the two stages
where that matters most, it is thrown away before every dispatch — and
`patchItems`, the blocker guidance a fix-and-retry depends on, goes with it.

**Whether the directive then survives depends on how many files happen to be
dirty.** At 3 changed files it fits; at 12 it does not. The same change,
committed or not, converges or does not. That is not a policy anyone chose.

So `/goal` is not free and is not reliable. It costs the framework
unconditionally and delivers convergence sometimes.

### `codex` never supported `/goal` at all

`hosts/codex/capabilities.json` declares `goalLoop: true`, but `/goal` is a
Claude Code session feature. `codex exec --help` documents its argument only as
"Initial instructions for the agent"; there is no slash-command layer, so a
surviving directive is literal text the model reads as prose.

The same file carries `promptCharLimit: 4000` — Claude Code's `/goal` handler
limit. Prompts reach every host through stdin (`core/adapters/headless.js`), so
no host has an argv ceiling. codex has therefore been paying the full
content-dropping cost on `build` and `qa` for a constraint that does not exist
on that host, in exchange for a directive it cannot act on.

## Decision

Stagecraft states convergence conditions in the prompt body and stops composing
host slash commands.

1. `build` and `qa` render their resolved `goalCondition` as a bounded
   host-neutral `## Done when` section in the prompt itself.
2. `capabilities.goalLoop` is removed from the adapter contract. No host
   declares it; the orchestrator composes no directive.
3. `capabilities.promptCharLimit` is removed. It described one slash command's
   handler, not a host property, and every prompt is piped to stdin.
4. The three-step shrink fallback and its `shrinkComposedPrompt` helper are
   removed. With nothing composing a ceiling there is nothing to shrink, so
   the inlined framework and `patchItems` reach every dispatch again.

`goalCondition` stays in `core/pipeline/stages.js` unchanged. It was always the
right thing to say; only the delivery mechanism was wrong.

## Consequences

**`build` and `qa` get their full prompt back — which makes them ~6x bigger.**
The two stages that were losing the framework and their retry guidance are the
two that needed them most. Measured on the dispatch path:

| Dirty files | main | this ADR |
|---:|---:|---:|
| 3 | 3,956 B, no framework, `/goal` present | 22,271 B, framework inlined, condition present |
| 12 | 4,850 B, no framework, no `/goal` | 23,273 B, framework inlined, condition present |

That increase is the *intended* behavior of phase-37 item 37.2, which was being
silently defeated here: inline ~22 KB once in a byte-stable, cacheable prefix
rather than have the model re-read those files through four-plus tool
round-trips. This ADR restores that decision on the two stages it was not
reaching; it does not re-litigate it.

Whether the 37.2 trade actually pays is a separate open question — it depends on
prefix caching engaging, and `openai-compat` is the one host where Stagecraft
controls the breakpoints and has them off by default. That measurement belongs
with the prompt-composition work in
[`plans/builder-review-2026-08.md`](../../plans/builder-review-2026-08.md) §F4,
and it should be taken *after* this lands, since before this the framework was
never in the build/qa prompt to cache.

**Convergence stops depending on repo dirtiness.** Every dispatch now carries
the condition, whatever the manifest looks like.

**Every host receives it, not two.** E7's scope was the two hosts declaring
`goalLoop`; the prompt body reaches all seven, including antigravity, ACP,
generic, omnigent, and openai-compat.

**One prompt render per dispatch instead of three.**

**Convergence becomes advisory rather than host-enforced.** `/goal` asked the
host's own control loop to iterate; a prompt line asks the model to. This is a
real reduction in enforcement — but it applies to a mechanism that was already
firing unpredictably, and the driver's fix-and-retry loop (ADR-003) is what
actually re-dispatches a stage whose gate does not pass. That has always been
the enforcing mechanism.

**A host that grows a real convergence directive can have one again.** The
adapter contract is the place to add it, with a size budget the composed prompt
can actually satisfy.

**`devteam evals run` loses its `/goal` composition**, which mirrored the
dispatch path. It now mirrors the new one.

## Alternatives considered

**Keep `/goal` and shrink harder.** Rejected. Reaching 4,000 characters already
costs the whole framework; going further means discarding the role brief and
the changed-file manifest. The prompt would fit and say nothing useful.

**Keep `/goal` only when the composed prompt fits after dropping nothing.**
Rejected. On a real project the with-framework prompt is ~21 KB, so this is
equivalent to removing the directive — with a dead branch left behind.

**Accept the current behavior as a deliberate trade.** Rejected. Trading ~18 KB
of framework context for a 4,000-char directive would be a defensible thing to
decide, but it was never decided; it is a side effect of a limit discovered
after E7 shipped. And the trade only sometimes buys the directive.

**Drop `goalCondition` entirely.** Rejected. The exit criterion is correct and
worth stating; only the transport was broken.

**Set `goalLoop: false` on both hosts and change nothing else.** Rejected as a
half-measure. It stops the fallbacks, but leaves `goalCondition` dead in the
stage table, `promptCharLimit` misdescribing a host property, and a documented
feature that silently does nothing.
