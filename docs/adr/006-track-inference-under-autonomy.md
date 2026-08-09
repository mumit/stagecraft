# ADR 006 — Track inference under autonomy

**Status:** Accepted; **Decision §1 superseded by [ADR-016](016-assess-by-default.md)** (2026-07-31) — see Addendum below. Decisions §2–4 (the `pipeline/track.json` schema, the warn/halt confidence guard, no-prompt) remain in force unchanged.
**Date:** 2026-06-11 (accepted 2026-06-15)
**Authors:** Mumit Khan (design), drafted with Claude Sonnet 4.6

## Context

Every `devteam run` invocation must commit to a **track** — the named subset of pipeline
stages that will execute. The current ten-track catalog ranges from `loop` (4 stages,
exactly 4 LLM dispatches) to `full` (18 stages, 15+ dispatches), with review and refactor
modes added after this ADR was accepted. Picking the wrong track is not a style error:

> "Wrong-track autonomy is a 10× cost error."
>  — docs/autonomous-execution-design.md §7

A `nano` run on a change that needed security review skips that review; the gate chain
records no security finding, and CI passes on a change it should have blocked. A `full`
run on a two-line typo fix burns 14 extra LLM dispatches — and, in a tight budget run
(`--budget-usd`), may exhaust the cap before the build stage. Both failure modes are
silent under the current resolution chain.

### Track resolution today

`core/driver.js:167` (`resolveTrack`):

```js
function resolveTrack(opts, config) {
  return opts.track
    || (Array.isArray(config.pipeline.custom_stages) ? config.pipeline.custom_stages : null)
    || config.pipeline.default_track
    || "full";
}
```

Priority: `--track` CLI flag → `custom_stages` in `.devteam/config.yml` → `default_track`
in config → `"full"`. No inference happens inside `devteam run`.

`devteam assess` (G6, `core/stage-shopping/assess.js`) performs rule-based track inference
from a change description and a file list, returning `recommendedTrack`, `confidence`
(`"high" | "medium" | "low"`), and `reasons[]`. With `--apply` it writes
`pipeline.custom_stages` to `.devteam/config.yml`. It is a **separate, explicit** step
today — it does not run inside `devteam run`.

### The safety floor — what Phase 1.1 already guarantees

Commit `6dd8d5a` (Phase 1 §1.1) enforces the stoplist on the autonomous path at two
checkpoints:

1. **Run-start:** before the first dispatch, `checkStoplist(description, cwd)` fires.
   If the description or any file in `pipeline/changed-files.txt` matches the stoplist
   (auth, credentials, crypto, PII, payments, migrations, feature-flags) on a lighter
   track (`STOPLIST_TRACKS = {quick, nano, config-only, dep-update}`), the driver halts
   with `halt_action: "stoplist"`.

2. **Pre-build (stage-04):** immediately before dispatching stage-04. This catches
   sensitive topics added by the requirements agent after run-start — a brief that was
   innocuous at init may introduce an auth pattern mid-run.

Full and hotfix tracks bypass the stoplist (they are the appropriate tracks for those
changes). `--force` opts out, as in the interactive path.

**The stoplist is the floor for this ADR.** What it cannot catch: a confidently-inferred
`dep-update` track that is really a `quick` change (dep file AND a feature flag toggle
both edited), or a `quick` run on a change that should have been `full` but whose file
list had no stoplist-triggering patterns. Those gaps are this ADR's domain.

### Why this is an open question

The design doc (§7) poses it directly: "Require explicit `--track`, or read from a
`pipeline/track.json` written at init?" The tension is:

- **Explicit `--track` always:** eliminates the entire class, at the cost of operator
  friction on every unattended run. CI pipelines that call `devteam run` must supply
  `--track`; a misconfigured pipeline that omits it silently picks "full" — which
  over-runs but does not miss stages.
- **Implicit assess inside `devteam run`:** maximises automation, but the inference
  decision is opaque (not auditable), happens at driver startup without operator review,
  and propagates a wrong track silently into the run-log.
- **`pipeline/track.json`:** a middle path — the inference is a separate, explicit step;
  the driver consumes the result as data, with visibility into how the track was arrived
  at. This is the option the design doc already names.

Three additional facts bound the design space:

**Fact 1 — The `assess` heuristic is good but not infallible.** "High" confidence is
reserved for unambiguous file signals (all changed files are dep manifests, or all are
non-code config). But `config-only` can still contain a feature-flag migration; `dep-update`
will always trigger the security heuristic (any `package.json` change does). The heuristic
is a starting point, not a ruling.

**Fact 2 — Track is not retroactively changeable.** Once the driver has advanced past a
stage, it has recorded gates for that track. Changing the track mid-run would require
replanning the remaining stage order and is not supported. The track choice is a one-shot
decision at run-start.

**Fact 3 — The gate chain already records the track.** The merged stage gate carries
`"track"` as a top-level field (written by `mergeWorkstreamGates`, read by `next()`).
The `run-log.jsonl` records `track` in the `run-start` event. An inferred track that is
wrong leaves an audit trail; it does not disappear. But a bad audit trail is worse than
no audit trail: it is evidence of a mistake, not a record that prevented it.

---

## Decision

> **Revision note (2026-06-15, critical review — accepted with three adjustments).** The
> core decision below stands (no internal inference; `pipeline/track.json` as the explicit
> provenance record; stoplist-floor / confidence-ceiling). Three changes from the original
> draft, carried into the Phase-11 execution plan:
>
> 1. **Mode switch is explicit, not `CI=true`.** §3 keyed halt-vs-warn on the ambient
>    `CI` env var. But `core/gates/validator.js` already keys strict-mode on
>    `CI === "true"`, and `core/verify/runner.js` *sets* `CI=1` on child processes — so
>    `CI` is overloaded and side-effect-laden. Track-confidence enforcement instead keys on
>    an explicit `autonomy.require_confirmed_track` config flag (default off), so unrelated
>    tooling running under `CI` does not silently change track behavior. CI pipelines opt in
>    by setting the flag, not by inheriting an ambient var.
> 2. **No breaking change to `assess --apply`.** §2/Q1 proposed `--apply` write
>    `track.json` instead of `custom_stages`. Instead: **`devteam assess` (default) writes
>    the per-run `pipeline/track.json`** (it is a per-run inference record — the natural
>    default output), and **`--apply` keeps its existing project-wide `custom_stages`
>    meaning, unchanged.** Clean per-run vs project-wide split, zero migration.
> 3. **No interactive prompt.** §3's low-confidence `[y/N]` pause contradicts the driver's
>    no-prompts posture. Low confidence (when `require_confirmed_track` is set) is a typed
>    `unconfirmed-track` **halt** requiring `--track` or `--force`, consistent with every
>    other halt. The warn-only behavior stays for the non-enforced default.
>
> Q5 (standing-grant composition) is parked: **ADR-005 is Deferred**, so the two-ADR
> boundary is revisited if and when ADR-005 is drafted.

### 1. `devteam run` MUST NOT infer a track by calling `assess` internally

Implicit inference inside the driver is the failure mode, not the feature. `devteam assess`
is a separate, explicit, operator-visible step. The driver's `resolveTrack` function is
not extended to call `assess`; calling `assess` and acting on its result without surfacing
the inference to an operator is exactly "wrong-track autonomy."

**The boundary:** the operator runs `devteam assess` (or a CI step does), the driver
consumes the result. These are different commands, with different authority.

### 2. Introduce `pipeline/track.json` as the per-run track record

A new optional file at `pipeline/track.json` (under `pipelineRoot()`, so bounded-isolation
runs scope it correctly) captures the track decision with provenance:

```jsonc
{
  "track": "quick",
  "source": "inferred",          // "human" | "inferred"
  "confidence": "high",          // "high" | "medium" | "low" — present when source=inferred
  "reasons": ["description matches quick-change keywords"],
  "assessed_at": "2026-06-11T14:00:00Z",
  "assessed_by": "devteam assess 0.6.0"
}
```

When `source: "human"`, the operator wrote or confirmed the track themselves (via
`--track`, via editing the file directly, or via `devteam assess --confirm`). When
`source: "inferred"`, the track came from `devteam assess` without a human-confirmation
step.

`devteam assess --apply` writes this file (not `custom_stages` in config — that continues
to work as the project-wide default, distinct from a per-run decision). `devteam run`
picks up `pipeline/track.json` as a new step in `resolveTrack` (between `--track` and
`custom_stages`):

```
--track  >  pipeline/track.json  >  custom_stages  >  default_track  >  "full"
```

### 3. `devteam run` warns on inferred tracks in interactive mode; halts in CI mode on low confidence

`resolveTrack` becomes track-source-aware. On startup:

| `source` | `confidence` | Mode | `devteam run` behavior |
|---|---|---|---|
| `"human"` | any | any | proceed silently |
| `"inferred"` | `"high"` | interactive | warn once: "Track 'X' was auto-inferred (high confidence). Pass `--track` to silence." |
| `"inferred"` | `"medium"` | interactive | warn once: "Track 'X' was auto-inferred (medium confidence). Verify with `devteam assess`." |
| `"inferred"` | `"low"` | interactive | warn + pause prompt: "Track 'X' inferred at low confidence. Continue? [y/N]" |
| `"inferred"` | `"high"` | CI (`CI=true`) | proceed (high confidence is the CI-safe bar) |
| `"inferred"` | `"medium"` or `"low"` | CI | **halt** with `halt_action: "unconfirmed-track"`, `halt_reason: "Track 'X' was inferred at medium/low confidence. Set pipeline/track.json source to 'human' or pass --track."` |

**Rationale for the CI distinction:** in interactive use, a human can read the warning and
abort. In CI an unattended run with a medium/low-confidence inferred track may commit 30
minutes of LLM spend before a reviewer notices. The CI check is a pre-flight gate, not a
mid-run abort.

**`--track` overrides everything** and writes no warning (the operator made an explicit
decision). `--force` bypasses the unconfirmed-track halt, consistent with all other
`--force` uses.

### 4. The stoplist remains the floor; this ADR is the ceiling

Nothing in this ADR relaxes the Phase 1.1 stoplist. If both `pipeline/track.json` and
the stoplist are present, both checks run: the track record governs *which* stages execute;
the stoplist governs *whether* a lighter track is safe at all.

The relationship is explicit in the startup sequence:

```
resolveTrack()          → which stages to run
checkStoplist()         → is this track safe for this change?
checkTrackConfidence()  → was the track confirmed or merely inferred?
```

All three pass before the driver enters its main loop.

---

## Consequences

**Positive:**

- **Eliminates implicit, opaque inference.** The track decision is always a file or a
  flag, not a side effect of some unreachable internal call. `run-log.jsonl` records
  `track`, `track_source`, and `track_confidence` in the `run-start` event — a future
  audit can see not just *what* track ran, but *how* the track was chosen.
- **Interoperability with CI without breaking the interactive path.** CI pipelines can
  run `devteam assess --apply` then `devteam run` and get a halting guard at medium/low
  confidence — a pattern that is safe by default and explicit in intent.
- **No new gate schema migration.** The run-log event and the startup warning are new; the
  `pipeline/track.json` file is a new artifact but not a gate file, so no C6 chain
  extension is needed.
- **Composes with ADR-005 (standing grants).** A standing grant can assert `--track`
  (or a confirmed `pipeline/track.json`) as a precondition, so a standing-grant run
  always has an explicit track — the two ADRs are compatible without additional machinery.

**Negative / costs:**

- **Operator friction for CI pipelines that did not previously need `devteam assess`.** A
  CI pipeline that calls `devteam run --track quick` today continues to work unchanged.
  One that relies on `custom_stages` from config also continues to work. The new friction
  applies only to pipelines that call `devteam run` with no track at all and expect
  auto-inference — which is a footgun this ADR intentionally prevents.
- **`devteam assess --apply` writes `pipeline/track.json`, not `custom_stages`.** This
  is a behaviour change from the current `--apply` (which writes `custom_stages` to
  `.devteam/config.yml`). Pipelines that depend on `--apply` writing config must update
  to the new behaviour. The old `custom_stages` path continues to work as the project-wide
  default; `pipeline/track.json` is the per-run override.
- **A new file in `pipeline/`** adds to the per-run artifact surface. It is small and
  human-readable. It should be gitignored alongside `run-state.json` and `run-log.jsonl`
  (or committed when the team wants to capture the track decision as part of the change
  record — either is valid).
- **The `"low"` confidence interactive pause** is a new interactive prompt in a flow that
  previously had none. Operators running in scripts (not CI=true but also not interactive)
  may be surprised. The pause should detect a non-TTY stdin and default to halt rather
  than block indefinitely.

**What now needs to be true:**

- `core/driver.js:resolveTrack` is extended to read `pipeline/track.json` and return
  `{ track, source, confidence }` (the current callers only use the track; the new fields
  drive the startup checks without requiring callers to change).
- A new `checkTrackConfidence({ track, source, confidence }, { ci, force })` function
  (in `core/guards/` or inline in the driver startup) implements the warn/halt matrix
  above and logs a `run-log.jsonl` `track-confidence-check` event.
- `devteam assess --apply` writes `pipeline/track.json` (not `custom_stages`) and accepts
  a `--confirm` flag that sets `source: "human"`.
- The `run-start` event in `run-log.jsonl` gains `track_source` and `track_confidence`
  fields.
- Docs: `docs/tracks.md` (new "Track record" section), `docs/runbooks/autonomous-run.md`
  (pre-run checklist gains `devteam assess --apply` as the recommended init step),
  `docs/ci.md` (CI pipeline example adds the assess step).

---

## Alternatives considered

1. **Always require `--track`; remove the config fallback chain.** Maximally safe. Rejected:
   the `custom_stages` / `default_track` config fallbacks are legitimate for teams with a
   stable, project-wide track that never needs per-run inference. Requiring `--track` every
   time breaks that use case. The human-confirmed `pipeline/track.json` achieves the same
   guarantee without removing the config path.

2. **Let `devteam run` call `assess` internally and trust `"high"` confidence automatically.**
   Removes the need for `devteam assess` as a separate step. Rejected: the inference is then
   invisible — no file records it, no operator reviewed it, and the run-log tracks only the
   resulting track name, not its provenance. The stoplist would catch the worst cases, but
   a silent high-confidence mis-inference (e.g. all YAML files → config-only when one of
   them is a database migration config) would advance past stages that should have fired.
   "Ship the contract, not the magic" applies here as much as to ADR-004.

3. **Warn on inferred tracks in CI too, never halt.** Softer; still surfaces the issue.
   Rejected: a non-blocking warning in a 30-minute unattended run is not a guard — it is
   a note in the log that nobody will read until after money is spent. The halt at
   medium/low confidence in CI is precisely the guard that makes the feature safe for the
   "unattended, nobody watching" case the driver was built for.

4. **Trust `assess` unconditionally and use the stoplist as the only guard.** The stoplist
   is the existing floor and covers catastrophic mis-inference. But it does not cover
   wrong-direction mis-inference in the non-stoplist space: a `quick` run on a full-rigor
   change that happens not to mention auth or payments. The stoplist and the confidence
   guard are complementary, not redundant.

5. **Add a `devteam confirm-track` command that writes `source: "human"` to
   `pipeline/track.json`.** A plausible UX refinement — `devteam assess` infers and writes,
   `devteam confirm-track` flips the source field, `devteam run` proceeds silently. Deferred:
   `devteam assess --confirm` achieves the same intent without a new command. Open to review.

6. **Encode track confidence on the gate chain (C6).** Record `track_source` and
   `track_confidence` on every stage gate so a tamper-evident chain includes proof of how
   the track was chosen. Deferred: the run-log event is sufficient for auditing today; gate
   chain extension requires schema work and C6 re-stamping. Revisit if an audit requirement
   specifically demands per-gate track provenance.

---

## Implementation status

**Phase 11.3 shipped** (branch `feat/track-provenance`, 2026-06-15). All Tier-1/accepted scope delivered:

- `devteam assess` writes `pipeline/track.json` by default; `--confirm` sets `source: "human"`; `--apply` continues writing `custom_stages` (no breaking change)
- `resolveTrack` returns `{track, source, confidence}`; reads `pipeline/track.json` in full precedence chain
- `checkTrackConfidence` guard keyed on `autonomy.require_confirmed_track` (not `CI=true`)
- `run-start` event + `track-confidence-check` event in `run-log.jsonl`
- Docs: `docs/tracks.md`, `docs/runbooks/autonomous-run.md`, `docs/ci.md`

The open questions below remain open (none blocked the implementation). ADR-007 Tier 2 (11.4) remains parked pending `stall-detected` data.

## Addendum (2026-07-31) — Decision §1 superseded by ADR-016

Phase 29.2 (`plans/phase-29-scale-adaptive-ceremony.md`) reverses **Decision §1 only**
("`devteam run` MUST NOT infer a track by calling `assess` internally"). The market
evidence gathered for the Phase 29 landscape review (heavyweight-pipeline backlash;
"assess is a manual step operators skip") shifted the tradeoff: opacity was the
original objection to internal inference, and the fix for opacity is an auditable
file, not a ban on inference. [ADR-016](016-assess-by-default.md) keeps that file —
`devteam run` now writes `pipeline/track.json` itself when it infers inline, so the
decision is still a file an operator can read, diff, or override, exactly as this ADR
required; it just no longer requires a separate `devteam assess` invocation to
produce it. Decisions §2 (file schema), §3 (warn/halt confidence matrix), and §4
(stoplist-is-the-floor) are unchanged and still govern the inferred result. See
ADR-016 for the full rationale and the boundary between the two ADRs.

## Implementation sketch (post-ADR; no code in this draft)

Files, sized as one PR (ADR-driven change to a single cross-cutting concern):

1. `core/driver.js` — extend `resolveTrack` to read `pipeline/track.json` and return
   `{ track, source, confidence }`; add `checkTrackConfidence` startup step before the
   main loop; extend the `run-start` run-log event with `track_source`, `track_confidence`.
2. `core/cli/commands/assess.js` — `--apply` writes `pipeline/track.json` instead of (or
   in addition to) `custom_stages`; add `--confirm` flag to write `source: "human"`.
3. `tests/run.test.js` — cases: no `pipeline/track.json` (falls through to config/default),
   inferred high confidence CI (proceeds), inferred medium confidence CI (halts with
   `unconfirmed-track`), human source any confidence (no warn), `--force` bypasses halt.
4. `tests/assess.test.js` (or `tests/stage-shopping.test.js`) — `--apply` writes
   `pipeline/track.json`; `--confirm` sets `source: "human"`.
5. `docs/tracks.md` — new "Track record (`pipeline/track.json`)" section.
6. `docs/runbooks/autonomous-run.md` — add `devteam assess --apply` to the pre-run
   checklist; document the `CI=true` + medium/low halt.
7. `docs/ci.md` — update the GitHub Actions example to include the assess step before `run`.

---

## Questions for a human reviewer to rule on

1. **`devteam assess --apply` migration.** Should `--apply` write `pipeline/track.json`
   *instead of* `custom_stages`, or write *both*? Writing both preserves backward
   compatibility for pipelines that read `custom_stages`; writing only `pipeline/track.json`
   makes the per-run vs. project-wide distinction clean. The ADR recommends "instead of"
   for per-run calls, but "both" is safer for a rolling adoption.

2. **Interactive pause at low confidence.** The proposed behaviour (pause prompt on a TTY,
   halt on non-TTY) adds an interactive prompt to a CLI that has avoided them. Is this the
   right affordance, or should low confidence always halt (i.e. treat it the same as
   CI=true) and require `--force` to override? The latter is stricter but consistent.

3. **`pipeline/track.json` gitignore policy.** Should the `devteam init` template add
   `pipeline/track.json` to `.gitignore`, or leave it uncommitted by default without
   explicit gitignore? Teams that want to record the track decision as part of the change
   artifact should be able to commit it; teams that treat `pipeline/` as ephemeral build
   output should ignore it. There is no universal right answer — this is a convention
   decision.

4. **`devteam confirm-track` as a separate command.** The ADR proposes `devteam assess
   --confirm` for the human-confirmation step. Is that the right surface, or does the UX
   benefit from a dedicated `devteam confirm-track` command with its own `--help` and
   discoverability in `devteam help`?

5. **Standing grant interaction (ADR-005 dependency).** If ADR-005 adopts standing grants
   that include a track assertion, should a standing-grant run be allowed to set
   `source: "human"` on `pipeline/track.json` (treating the grant as the human authority
   record), or must a human always confirm the track separately? This is the boundary
   between the two ADRs — a ruling here gates whether they compose cleanly.
