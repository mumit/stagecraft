- **`--until` naming a stage the track does not contain no longer removes the
  boundary.** Dispatch reads `untilIndex < 0` as "no limit", and
  `order.indexOf()` returns `-1` for any unknown stage — so `--until buidl`, or
  a stage borrowed from another track (`--track loop --until red-team`), did not
  stop the run early. It ran the whole track through to `deploy` while the
  operator believed they had stopped at `build`, and said nothing. The flag is
  now rejected before the lock is acquired, so a bad boundary leaves no lockfile
  behind, and the error lists the resolved track's stages in order.
- **`pipeline/run-plan.json` records the stopping boundary.** ADR-018 calls the
  plan "an inspectable execution contract", but `--until` was read into
  `untilIndex` in the dispatch loop and never reached the plan built ~350 lines
  later: `--until build` on `full` still reported all 13 stages as included, and
  two plans differing only by `--until` were byte-identical. The plan now
  carries `until` and `stages_after_until`.
  *Honest scope note:* both are deliberately excluded from `execution_fingerprint`
  **and** `plan_fingerprint`. `--until` is where the operator paused, not what
  the plan is; fingerprinting it would make the ordinary "run `--until build`,
  review, `--resume`" cycle report policy drift and refuse to continue.
  `stages_included` therefore keeps its existing meaning — what the track
  executes — and the boundary is reported beside it rather than folded into it.
  Reasoning recorded in `docs/reproducibility.md`.
- **`devteam run --plan-only` exits 0.** It was exiting 1, so it could not be
  used as a CI preflight without `|| true`, even though the exit-code rule
  directly above the check already covered it ("stopped at a boundary the
  operator configured").
- **`--until`'s CLI help matches its behavior.** It advertised "Stop before this
  stage" for a boundary that is inclusive — the named stage runs.
