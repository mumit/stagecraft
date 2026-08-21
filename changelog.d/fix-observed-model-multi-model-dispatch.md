- **claude-code dispatches now record which model served them.**
  `modelFromResultMessage` required `modelUsage` to name exactly one model and
  returned `null` otherwise, "rather than guessing". That assumption is
  empirically false: claude-code 2.1.207 reports **two** models even for a
  one-line `--print` prompt, because it routes auxiliary work (titles, quick
  classifications) to a cheaper model alongside the main turn. So
  `model_observed` was `null` on essentially every claude-code dispatch, and
  every routing row in D5's evidence read `model=unknown` — which is not
  routing evidence at all. Verified against a real `loop` run on a 615-file
  Python project: 4/4 dispatches had cost, 0/4 had a model.
  The parser now records the **highest-cost** entry, preferring its
  `canonicalModel` over a dated key. That is not a guess — `modelUsage` carries
  per-model `costUSD`, and on a real dispatch the auxiliary model is two orders
  of magnitude cheaper ($0.0010 haiku vs $0.0693 sonnet). Ties and cost-less
  payloads fall back to declaration order so the result is deterministic.
  *Honest scope note:* a superseded test asserted the old null-on-multiple
  behavior and is updated, not weakened. Historical records are unchanged —
  a model id that was never captured cannot be reconstructed.
