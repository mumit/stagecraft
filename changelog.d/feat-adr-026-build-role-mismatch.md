- **A track that pins its build role now says so when the change is somewhere
  else** ([ADR-026](../docs/adr/026-pinned-build-role-mismatch.md)). `loop`
  (29.1) and, since [ADR-025](../docs/adr/025-scope-build-not-just-review.md),
  `nano` and `refactor` build and review with a single static role that never
  consults what changed — so a frontend-only change on any of the three was
  built by an agent reading `roles/backend.md` and reviewed by the same role.
  Measured on a repository with one frontend file dirty, `loop`, `nano`, and
  `refactor` all dispatched `["backend"]` where `quick` and `full` dispatched
  `["frontend"]`.
  `devteam run` now reports the mismatch before the first dispatch: a warning by
  default, a `build-role-mismatch` halt under
  `autonomy.require_matching_build_role: true`, and `--force` bypasses — the
  same escalation shape [ADR-006](../docs/adr/006-track-confidence.md)'s
  track-confidence check uses. All three outcomes are recorded in
  `pipeline/run-log.jsonl`.
  The message names a remedy that actually exists for the track it fires on:
  `pipeline.loop_build_role` for `loop`, and a different track for `nano` and
  `refactor`, whose role comes from a static table with no config override.
  *Honest scope note:* no dispatch behavior changes and no track gets cheaper or
  more expensive — this reports a condition rather than fixing it. Deriving the
  pinned role from the change is the obvious alternative and is deliberately not
  done here: `loop`'s contract is one build workstream predictably, and deriving
  it means a two-area change either dispatches two or picks one arbitrarily.
  That belongs in its own ADR with dispatch evidence from real runs. Warning
  rather than halting by default is also deliberate — halting would break every
  project running `loop` against a frontend change today, without notice.
