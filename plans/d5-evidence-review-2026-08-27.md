# D5 Evidence Review — 2026-08-27

**Verdict: NO-GO.** `d5-continuous-routing` (#143) reports
`threshold-met-review-required` for the first time — all four portfolio
conditions are met — and it should still not be opened. The thresholds now
measure real telemetry, which is genuine progress; the *observations* behind
them are not yet independent enough to answer the question D5 asks.

Keep #143 open. The reasons are specific and each is addressable.

---

## 1. What changed since 2026-08-21

The [previous re-review](phase-41-evidence-review-2026-08-21.md) found cost
telemetry structurally impossible rather than merely sparse. Four fixes closed
that, all verified against real dispatches rather than fixtures:

| PR | What it unblocked |
|---|---|
| [#486](https://github.com/telus-labs/stagecraft/pull/486) | `gpt-5.6-sol` was priced at GPT-5.5's rates; cache reads were billed at full input price. A real codex dispatch went from an overstated **$0.75 to $0.19**. Also records `input_accounting`, because OpenAI counts cached tokens *inside* `input_tokens` and Anthropic counts them *outside* — reading one convention as the other moves a derived cost ~4× in either direction. |
| [#487](https://github.com/telus-labs/stagecraft/pull/487) | `review_fanout` entries never resolved a model. Fanout is the **only** mechanism that dispatches one role to two hosts — exactly what `comparable-roles` requires — so D5's two conditions were mutually unsatisfiable on codex: fanout for the comparison, a pinned model for the cost, and fanout dropped the model. |
| [#488](https://github.com/telus-labs/stagecraft/pull/488) | `evidence status` now reports dispatches routing readiness ignores. |
| ADR-027 (#480) | Verified end-to-end on codex, the strictly-enforcing host. |

**`projects-with-cost-telemetry` moved from 1/2 to 2/2.** That condition had
been shut since June, and it was closed by fixing telemetry — not by collecting
more of the broken kind, which is what the 2026-08-19 review recommended and
the 2026-08-21 re-review overturned.

---

## 2. The evidence

Two bundles, both exported 2026-08-27, both continuing their existing
`project_ref` (see §5 for a near-miss on that).

**attune** — `backend`, same role, both hosts:

| host | model | obs | cost obs | total |
|---|---|---:|---:|---:|
| `claude-code` | `claude-sonnet-5` | 9 | 9 | $2.8689 |
| `codex` | `gpt-5.6-sol` | 11 | 11 | $6.0838 |

**stagecraft-dogfooding** — same shape:

| host | model | obs | cost obs | total |
|---|---|---:|---:|---:|
| `claude-code` | `claude-sonnet-5` | 6 | 6 | $2.4649 |
| `codex` | `gpt-5.6-sol` | 6 | 6 | $3.5727 |

Both point the same direction: codex costs more than claude-code for identical
backend review work. That is a real routing signal and the first time either
project could express one.

---

## 3. Why this is still NO-GO

### 3.1 The two projects disagree by an order of magnitude

Per-dispatch cost for `backend`, computed over every costed observation in each
project's run log:

| project | codex | claude-code | ratio |
|---|---:|---:|---:|
| attune | $0.5531 | $0.3358 | **1.65×** |
| stagecraft-dogfooding | $0.8290 | $0.0458 | **18.1×** |

List price alone predicts ~1.33× (`gpt-5.6-sol` $4/$20 against
`claude-sonnet-5` $3/$15). attune's 1.65× is plausible as price plus modestly
higher token use. dogfooding's 18× is not a routing fact — at $0.046 per
dispatch its claude-code side is doing almost no work.

Two projects that disagree this far are not yet corroborating each other.

### 3.2 dogfooding's observations are a retry storm, not samples

| project | runs | dispatch observations | per run |
|---|---:|---:|---:|
| attune | 16 | 47 | 2.9 |
| stagecraft-dogfooding | 9 | 211 | **23.4** |

A `loop` run plans **5** dispatches. dogfooding averaged 23.4 and its log
carries a `max-iterations-halt`. The 196 backend observations there are
dominated by one or more runs retrying to the iteration cap — correlated
samples of a single failing input, which is precisely what the ≥5-per-(role,
host) threshold assumes it is not counting.

The exported bundle predates most of that storm (it captured 6+6). A re-export
today would inflate the counts with retry noise while looking *better* by the
threshold.

### 3.3 Almost nothing completed

Across both projects, **1 of 21 runs reached `complete`**. Halts recorded:
`structural-halt` ×9, `stoplist-halt` ×3, `max-iterations-halt` ×1. Routing
evidence drawn overwhelmingly from runs that did not finish tells you about
failure modes, not about which host to route to.

### 3.4 The features were synthetic near-duplicates

Every run used a description of the form *"… (evidence round N)"*, differing
only in the integer. That is collection staged to fill counters. It was done
knowingly and with the operator's agreement, and it is recorded here because a
future reader must not mistake it for organic usage.

### 3.5 Cost is measured; quality is not

D5 would re-route based on prior outcomes. The evidence supports *"codex costs
more"* and says nothing about whether either host reviewed better. There is no
quality dimension in the routing rows — no defect-detection rate, no
blocker-quality signal, no downstream rework measure. A router optimising the
only number it has will optimise for cheapness alone.

---

## 4. What would make this a GO

1. **Organic runs.** Real changes with distinct descriptions, not `round N`.
2. **Runs that finish.** A meaningful share reaching `complete`, so the compared
   dispatches represent completed work.
3. **Retry-aware counting.** Either cap per-run contribution to the threshold,
   or record the retry index on the observation so correlated samples are
   distinguishable. Without this, an iteration-capped run can open the gate by
   itself.
4. **A quality signal**, or an explicit written decision that D5 optimises cost
   alone at fixed quality.
5. **Cross-project agreement** within an order of magnitude on the same
   comparison.

Items 3 and 5 are the load-bearing ones. (3) is a product change and would
prevent this class of false-positive permanently.

---

## 5. Incidental findings

**attune's evidence identity had been re-minted.** Its local
`.devteam/evidence-project-id` derived to `sha256:d010a1c0…` while its real
history is under `sha256:a541b225…`. Exporting without checking would have
registered a *third* project, inflating every `N/2` portfolio threshold and
producing a false green on the very gate under review. The saved identity was
restored before export. `devteam evidence identity` prints the ref but cannot
warn about this: the [#455](https://github.com/telus-labs/stagecraft/pull/455)
warning fires on *minting*, not on a pre-existing mismatch against an external
bundle. **This is a silent failure that corrupts exactly the counts the gates
depend on**, and it deserves its own fix.

**Two issues filed** from this session:
[#489](https://github.com/telus-labs/stagecraft/issues/489) — a stale
`pipeline/brief.md` permanently gates lighter tracks under in-place isolation;
[#490](https://github.com/telus-labs/stagecraft/issues/490) — a quota-blocked
host is reported as "input is structurally unworkable", which also emits
`NO_GATE` observations into the corpus D5 reads.

---

## 6. Recommendation

Keep #143 open. Do not implement adaptive routing.

The correct next step is not more collection of this kind. It is item 3 above —
make the threshold robust to retries — followed by evidence from real work as
these projects are actually developed. The measurement problem is now solved;
the sampling problem is not.

Worth stating plainly, because the previous two reviews each corrected the one
before: **thresholds being met is not the same as the evidence being good.**
This review exists to say so while the numbers look green.
