- **`devteam evidence export` warns when it mints an identity for a project that
  already has evidence.** `.devteam/evidence-project-id` ties a project's
  bundles together across checkouts and is gitignored by design, so a clone, a
  cleaned `.devteam/`, or an identity restored one command too late silently
  gets a *fresh* id. `getOrCreateIdentity` has always returned `created: true`
  and nothing surfaced it — so bundles exported under the new ref read as a
  second, independent project, inflating every `N / 2` readiness threshold and
  quietly breaking the Phase 41 rule against treating one project's bundles as
  two. Export now warns on stderr when it mints an id for a project that already
  has dispatch records, gate files, or a run log, naming what it found and how
  to restore. *Honest scope note:* advisory and non-blocking, and it fires on the
  *combination* rather than on minting alone — minting is correct for a genuinely
  new project, which is the common case, and warning on that would train
  operators to ignore it. The warning goes to stderr so `--json` stdout stays
  machine-readable, and a probe failure never blocks an export. No `--import`
  subcommand was added: restoring is a file copy, and a command for it would make
  identity *reassignment* convenient, which the pseudonymous bundle model wants
  to stay deliberate.
