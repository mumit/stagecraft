- **`/status` in `devteam chat` says why the run stopped.** It printed
  `next().reason` under the label `why`, so a run that died on its first
  dispatch reported `run: failed; stage requirements` immediately followed by
  `why: stage not started` — two contradictory lines — while the actual reason
  sat in the snapshot unprinted. `next()` describes what to do next, not what
  went wrong.
  `why` is now the halt or failure reason, and `next()`'s reasoning is labelled
  `note` so the two questions stay distinct. This is the human-facing half of
  the fix that gave the model the same evidence; a run-state predating that
  change reports the outcome as not recorded rather than silently omitting the
  line.
  *Honest scope note:* `next()` itself still reports "stage not started" after a
  failed dispatch — the stage genuinely has no gate, which is the right answer to
  the question `next()` is asked. Only the labelling and the added stop reason
  change here; no snapshot field and no `next()` behavior is altered.
