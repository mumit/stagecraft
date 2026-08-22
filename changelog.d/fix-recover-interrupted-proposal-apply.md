- **An interrupted `devteam chat --proposal <id> --apply` no longer costs the
  operator the proposal and a gate.** Apply moves the gates a refinement
  invalidates into `pipeline/proposals/.apply-<id>/`, rewrites the artifact,
  then removes the directory. If the process died in between, the rollback
  deliberately preserved that directory rather than risk losing the gates — but
  nothing put them back, and the damage compounded: the next apply computed the
  invalidation set from a `gates/` directory now missing those files, found a
  smaller set than the proposal recorded, and marked the proposal **permanently
  stale** — reporting "its invalidation set changed" while the operator's gate
  sat inside a dotted directory nothing mentions. The pipeline read as though
  the stage that produced it had never run.
  Recovery now runs before status or staleness is judged, restores the gates,
  and appends a `recovered` event. A gate that exists now is never overwritten
  by one an interrupted transaction set aside — a live file is always newer.
  *Honest scope note:* only files named like gates are moved. Anything else is
  left in place, the directory with it, and reported by name — previously a
  leftover directory surfaced as a bare `EEXIST: file already exists, mkdir`
  against an absolute path, which said nothing about what it was or how to
  recover. A proposal already marked stale by the old behavior stays stale; the
  gates come back, but the proposal itself cannot be un-staled, and rebasing it
  is exactly what this workflow refuses to do.
