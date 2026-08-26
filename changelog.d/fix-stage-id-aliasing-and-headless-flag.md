- **`devteam stage` now accepts a stage's gate-id form (e.g. `stage-04`),
  matching `devteam restart`.** Escalation routing tables and Principal
  rulings commonly name a stage by its gate-id form (matching gate filenames
  / rules docs), not the friendly CLI name — `devteam stage stage-04
  --headless` failed with "Unknown stage stage-04" mid `fix-escalation` even
  though the semantically identical `devteam restart stage-04` already
  worked, because `devteam restart` special-cased id→name resolution
  locally and `devteam stage` had no equivalent. A new shared
  `resolveStageName(input)` helper in `core/pipeline/stages.js` — applied
  transparently through `getStage()` — is now the one implementation both
  commands (and `core/orchestrator.js`'s `runStage`) resolve through.

  Separately, the escalation-applicator's "Scope gap" routing example
  suggested `devteam restart requirements --cascade --headless`, but
  `devteam restart` has no `--headless` flag — `core/cli/flags.js` hard-exits
  on any unrecognized flag, so an applicator following the suggestion
  literally always failed and cleared nothing. `devteam restart` is
  synchronous/local (it only deletes gate files); it never needs
  `--headless`. The example now omits it.
