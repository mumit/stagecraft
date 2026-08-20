- **`devteam assess` accepts `--feature`.** `run` and `stage` both name this
  string `--feature`, but `assess` — usually the first command typed after
  `init` — accepted only `--description` and exited 2 on the spelling the
  quickstart teaches. Both now resolve to the same value; `--description`
  remains supported so existing scripts keep working.
- **`devteam run --plan-only`.** ADR-018 calls `pipeline/run-plan.json` an
  inspectable execution contract, but inspecting it meant starting the run it
  governs. `--plan-only` halts immediately after the plan is built,
  fingerprinted, and persisted, before any stage dispatches, and reports
  `halt_action: "plan-only"` with the plan path. Because it halts after the
  same build/persist path a real run uses, the previewed plan *is* the plan
  that would execute rather than a parallel estimate that can drift from it.
  The halt leaves the ordinary interrupted-before-first-dispatch state, so
  `devteam run --resume` executes the reviewed plan unchanged. *Honest scope
  note:* it is not a read-only preview — it acquires the run lock and writes
  `run-plan.json`, `run-state.json`, and `track.json` exactly as a real run
  does. It also does not mask an `unconfirmed-track` halt: a track the operator
  was meant to confirm still surfaces as its own typed halt first.
