- **`devteam spec verify` distinguishes "not in this track" from drift (Phase
  42.4).** `executable-spec` is absent from `loop`, `nano`, `refactor`, and every
  review track, so `pipeline/spec.feature` is something nothing was ever going
  to produce there — yet verification reported `❌ MISSING` and counted it as
  drift, indistinguishable from a spec that should exist and does not. It now
  resolves the project's active track and exits 0 with a `not-applicable`
  verdict, naming the track and where that decision came from. A new `--track`
  flag verifies against a specific track, and `--json` carries `track`,
  `track_source`, and `applicable`.
  Track resolution reuses the existing `resolveActiveTrack`
  (`core/pipeline/active-track.js`) that `verify`, `verify-chain`,
  `stamp-chain`, and `stage` already share, so verification reports against the
  track that would actually execute — including a materialized `run-plan.json`,
  which outranks the mutable config default. *Honest scope note:* `full` and
  `quick` behavior is unchanged, and an unrecognized track name still reports
  drift rather than passing, so a typo in `default_track` cannot become a silent
  pass.
