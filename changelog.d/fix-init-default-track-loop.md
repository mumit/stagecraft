- **`devteam init` writes `pipeline.default_track: loop`.** The generated config
  said `full`, contradicting ADR-016/ADR-018 (which already infer `loop` for a
  generic change) and `docs/tracks.md` (which tells operators to pick `loop` for
  day-to-day work). An operator following the quickstart without running
  `assess` paid 23–25 dispatches where 4 was the documented answer. Lighter
  tracks remain stoplist-guarded, so a change touching auth, payments, crypto,
  or migrations still refuses to run and points at `full`. *Honest scope note:*
  only the value written into a **new** project changed. A config file that
  names no `default_track` still resolves to `full` — picking a default for a
  fresh project and silently reducing rigor for an existing one that never
  chose are different decisions, and only the first is being made here.
