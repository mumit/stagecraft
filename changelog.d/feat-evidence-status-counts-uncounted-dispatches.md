- **`devteam evidence status` reports dispatches that routing readiness does not
  count.** Routing aggregates come from durable `dispatch-observation` events,
  which only the autonomous driver emits. A `devteam stage` dispatch reaches the
  same host with the same role, model and cost, and writes both a gate and a
  corpus row — but no durable event, so it contributes nothing to D5. Nothing
  said so: the count had been computed and exported since #442 and was simply
  never printed, so an operator collecting routing evidence by running stages
  directly saw `Evidence quality: complete for available sources` beside a
  stalled condition, with nothing connecting the two.
  Status now prints `Dispatches not counted: N recorded via devteam stage` and
  the one-line reason. `run_id` is the exact discriminator — corpus rows carry
  one when they came from a run and none when they did not.
  *Honest scope note:* the exclusion itself is unchanged and deliberate. A stage
  invocation is ad-hoc by design and can be re-run against unchanged code
  indefinitely; five repeats of one peer-review are five samples of a single
  input, not five independent observations, and counting them would let a shell
  loop open an evidence gate. That reasoning was never written down — it is now,
  in `plans/phase-17-durable-evidence-instrumentation.md` and `docs/BACKLOG.md`.
  The uncounted total is reported beside the quality line, not folded into it:
  the sources are healthy, the dispatches are simply outside the population D5
  measures.
- **Corrected a misleading comment on `countDispatchesOutsideRun`.** It claimed
  an absent corpus returns null ("not consulted, not zero"). It does not —
  `readCorpus` swallows the read error and returns `[]`, so absence counts as 0
  and the null branch is unreachable for a missing file. Behaviour is unchanged;
  the comment now describes what the code does, and a test pins it.
