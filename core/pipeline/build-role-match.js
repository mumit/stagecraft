"use strict";

// ADR-026: does the track's pinned build role match where the change actually is?
//
// `loop` (29.1) and, since ADR-025, `nano` and `refactor` pin their build stage
// to a single role rather than deriving it from the change. That pin is what
// makes those tracks cheap and predictable -- exactly one build workstream,
// whatever the change looks like -- and it is also blind: neither
// loopBuildRole() nor PEER_REVIEW_SIZING consults what changed, so a frontend
// change is built and reviewed by an agent loaded with roles/backend.md.
//
// This is pure and returns a description, not a verdict. Whether a mismatch
// warns or halts is the driver's decision (autonomy.require_matching_build_role),
// the same split ADR-006's track-confidence check uses.

const { rolesForStage, STAGES, LOOP_BUILD_WORKSTREAMS } = require("./stages");

// buildRoleMismatch -- null when there is nothing to report.
//
//   track         resolved track (array for custom_stages -> never pinned)
//   config        for loopBuildRole's pipeline.loop_build_role override
//   activeRoles   discovered workstream roles for this change
//
// A mismatch needs all three, so the warning means something when it fires:
//   - the track's build resolves to exactly one role;
//   - discovery found at least one *build workstream* role. `documentation` is
//     excluded deliberately -- it has its own scoping path
//     (rolesWithDocumentationScope) and a docs-only change is not a
//     wrong-specialist problem;
//   - the pinned role is not among them.
//
// A clean tree discovers nothing and returns null. That case matters more than
// it looks: a run plan is materialized at preflight, before any stage has
// written anything, so on a new feature the tree is clean and there is no
// evidence of where the work will land. Warning there would fire on every
// ordinary run.
function buildRoleMismatch({ track, config, activeRoles = [] }) {
  if (Array.isArray(track)) return null;
  const buildDef = STAGES.build;
  if (!buildDef) return null;
  const pinned = rolesForStage(buildDef, track, config);
  if (pinned.length !== 1) return null;

  const workstreams = new Set(LOOP_BUILD_WORKSTREAMS);
  const discovered = [...new Set(activeRoles)].filter((role) => workstreams.has(role));
  if (discovered.length === 0) return null;
  if (discovered.includes(pinned[0])) return null;

  return { track, pinned_role: pinned[0], discovered_roles: discovered };
}

// The operator-facing sentence. The remedy differs by track and saying the
// wrong one is worse than saying none: pipeline.loop_build_role is loop's knob
// only. nano and refactor take their build role from PEER_REVIEW_SIZING, which
// is static and has no config override, so their only remedy is the track.
function buildRoleMismatchMessage({ track, pinned_role: pinnedRole, discovered_roles: discovered }) {
  const where = discovered.map((r) => `'${r}'`).join(", ");
  const remedy = track === "loop"
    ? `Set pipeline.loop_build_role to '${discovered[0]}', or use a track that derives its `
      + "build matrix from the change (quick, full)."
    : `Use a track that derives its build matrix from the change (quick, full), or 'loop' with `
      + `pipeline.loop_build_role: ${discovered[0]}.`;
  return `track '${track}' builds and reviews with the '${pinnedRole}' role, but this change is in `
    + `${where}. The work would be done by the wrong specialist. ${remedy}`;
}

module.exports = { buildRoleMismatch, buildRoleMismatchMessage };
