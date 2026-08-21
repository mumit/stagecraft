"use strict";

// Slice 3 of the P2-2 run() decomposition — see core/driver-safety.js and
// core/driver-runend.js for the earlier slices.
//
// One question: given the resolved track, the run's intent, and the operator's
// flags, which stages will this run execute, and is the --until boundary one
// the run can actually honor?
//
// It is pure. Nothing here touches the filesystem, the lock, or run state; the
// only injected dependency is the stoplist check, which run() already made
// injectable for deterministic tests. Every value it returns is treated as
// const by run() from the moment it is computed, which is what makes the
// extraction safe: none of them is reassigned anywhere in the loop below.

const { orderedStageNamesForTrack } = require("./pipeline/stages");
const { checkStoplist: defaultCheckStoplist } = require("./guards/stoplist");

// resolveStageOrder — the whole pre-lock stage-order decision.
//
//   track           resolved track (string, or an array for custom_stages)
//   intent          "feature" | "repair"
//   cwd             passed through to the stoplist check
//   repairAt        --repair-at escape hatch (suppresses the diagnosis prepend)
//   opts            { repair, force, until }
//   checkStoplist   injectable for tests
//
// Returns { effectiveTrack, repairStoplistMatches, order, untilIndex }.
// The diagnosis-prepend decision is deliberately not returned: it is a step in
// computing `order`, and `order[0] === "requirements"` already states its
// outcome. Returning it too would create a second way to ask the same question.
//
// Throws when --until names no stage in the resolved order. That check lives
// here rather than at the call site so the order and the boundary validated
// against it cannot drift apart.
function resolveStageOrder({
  track,
  intent,
  cwd,
  repairAt = null,
  opts = {},
  checkStoplist = defaultCheckStoplist,
}) {
  // ADR-009 §Decision.1: repair stoplist upgrade — hotfix bypasses
  // STOPLIST_TRACKS by design, but auth/payments/migration symptoms must still
  // force the track to full. The caller runs this before acquiring the lock so
  // the upgrade is visible in the initial run-state write. --force opts out,
  // same as the regular stoplist.
  let effectiveTrack = track;
  let repairStoplistMatches = [];
  if (opts.repair && !opts.force && effectiveTrack !== "full") {
    repairStoplistMatches = checkStoplist({ description: opts.repair, cwd });
    if (repairStoplistMatches.length > 0) effectiveTrack = "full";
  }

  // ADR-009 Phase 2: repair without escape hatch prepends "requirements"
  // (diagnosis) to the stage list so next() routes through it before build. The
  // escape hatch (--repair-at) seeds the affected-files list directly and writes
  // a synthetic stage-01 gate — no LLM diagnosis needed, so no prepend.
  // "requirements" is filtered out first to guard against double-prepend if the
  // user specifies a full track that already includes it.
  //
  // ADR-009 Phase 3: repair intent always includes "executable-spec"
  // (stage-03b), providing failing-first reproduction discipline even on hotfix
  // depth (which normally skips it — hotfix has no requirements stage and
  // therefore no brief). Inject executable-spec immediately before "build" in
  // the filtered base list so the PM authors the regression scenario before the
  // build writes the failing test.
  const repairNeedsDiagnosis = intent === "repair" && !repairAt;
  let order;
  if (intent === "repair") {
    const base = orderedStageNamesForTrack(effectiveTrack)
      .filter((n) => n !== "requirements" && n !== "executable-spec");
    const buildIdx = base.indexOf("build");
    const withSpec = buildIdx >= 0
      ? [...base.slice(0, buildIdx), "executable-spec", ...base.slice(buildIdx)]
      : ["executable-spec", ...base];
    order = repairNeedsDiagnosis ? ["requirements", ...withSpec] : withSpec;
  } else {
    order = orderedStageNamesForTrack(effectiveTrack);
  }

  // A boundary the run cannot recognize is worse than no boundary: dispatch
  // treats untilIndex < 0 as "no limit" (core/driver-dispatch.js), so a typo or
  // a stage that belongs to a different track used to run the *whole* track --
  // deploy included -- while the operator believed they had stopped at build.
  // The caller raises this before the lock is acquired so a rejected flag
  // leaves nothing behind.
  const untilIndex = opts.until ? order.indexOf(opts.until) : -1;
  if (opts.until && untilIndex < 0) {
    const label = Array.isArray(effectiveTrack) ? "custom" : effectiveTrack;
    throw new Error(
      `--until ${opts.until} is not a stage in the '${label}' track. ` +
      `Stages, in order: ${order.join(", ")}`,
    );
  }

  return { effectiveTrack, repairStoplistMatches, order, untilIndex };
}

module.exports = { resolveStageOrder };
