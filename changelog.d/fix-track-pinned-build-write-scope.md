- **A track-pinned build role can now write the paths Stage 1 actually approved,
  not just its static `roleWrites` prefix**
  ([ADR-027](../docs/adr/027-track-pinned-build-role-write-scope.md)). `loop`,
  `nano`, and `refactor` pin `stage-04` to one build role whose write scope is a
  static, monorepo-shaped convention (`src/backend/`, `src/frontend/`, ...). A
  project laid out differently — say, `src/server.js` and `public/index.html`
  at the repo root — could have a PM-approved `affected_files` list the pinned
  role was never authorized to write, so a host that actually enforces
  `allowedWrites` (openai-compat, codex, omnigent) rejected the build's own
  approved work and halted at `resolve-escalation`. Principal ruling couldn't
  resolve it either: none of its existing remedies can change what a role is
  authorized to write, so redispatching the same role reproduced the identical
  rejection every cycle.
  The pinned role's `allowedWrites` and `approvedAffectedFiles` now additively
  include the current PASS Stage 1 gate's `affected_files`, the same exact-path
  contract [ADR-022](../docs/adr/022-exact-file-documentation-workstream.md)
  already uses for the `documentation` role, generalized via
  `isTrackPinnedBuildRole()`. Retry routing (`core/retry-ownership.js`) mirrors
  the same widening so a retry doesn't reject a path the first dispatch could
  already write. Principal ruling also gains a named "scope gap" remedy —
  restart requirements with the missing paths, re-approve, then re-run build —
  for the residual case the widening doesn't cover.
  *Honest scope note:* `quick`, `full`, and `dep-update` are explicitly out of
  scope and remain exposed to the same class of mismatch. The gate
  (`isTrackPinnedBuildRole`) fires only for the two branches that structurally
  pin the build to one role with no sibling dispatch ever running for the same
  feature — not for a track where a single active role is an artifact of what a
  given dispatch's dirty-tree snapshot happened to narrow down to. Widening
  there would leak write authority across roles that never agreed to share it.
