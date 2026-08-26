"use strict";

const fs = require("node:fs");
const path = require("node:path");
const { generateHelp } = require(path.join(__dirname, "..", "flags"));

const name = "restart";

const flags = {
  cwd:            { type: "string",  description: "Target project directory" },
  feature:        { type: "string",  description: "Feature name (bounded isolation mode)" },
  cascade:        { type: "boolean", description: "Also clear every stage after this one" },
  "keep-context": { type: "boolean", description: "Preserve injected blocker sections in context.md" },
  "dry-run":      { type: "boolean", description: "Print what would be deleted without acting" },
  track:          { type: "string",  description: "Override the pipeline track (for cascade)" },
  help:           { type: "boolean", description: "Show this help" },
};

function stripMarkedSection(filePath, beginMarker, endMarker) {
  if (!fs.existsSync(filePath)) return false;
  const { stripSection } = require(path.join(__dirname, "..", "..", "markers"));
  const content = fs.readFileSync(filePath, "utf8");
  const next = stripSection(content, beginMarker, endMarker);
  if (next === content) return false;
  fs.writeFileSync(filePath, next, "utf8");
  return true;
}

// `devteam restart <stage> [--cascade] [--keep-context] [--dry-run]`
// Clears a stage's gate(s) so the pipeline can re-run it. By default,
// also strips any injected blocker sections in pipeline/context.md
// that originated from this stage. Tier-4: this is what users reach
// for after an ESCALATE or FAIL when they want to re-do work from a
// specific point.
function run(positional, _flags) {
  if (_flags.help) { console.log(generateHelp("devteam restart <stage> [options]", flags)); process.exit(0); }
  const stageInput = positional[0];
  if (!stageInput) {
    console.error(generateHelp("devteam restart <stage> [options]", flags));
    console.error("");
    console.error("  <stage>  Stage name (e.g. 'peer-review') or stage id (e.g. 'stage-05').");
    console.error("After restart, run `devteam next` to see the new starting point.");
    process.exit(2);
  }

  const cwd = _flags.cwd || process.cwd();
  const { loadConfig, checkBoundedFence } = require(path.join(__dirname, "..", "..", "config"));
  const config = loadConfig(cwd);
  checkBoundedFence(config, "restart");
  const { resolveChangeId } = require(path.join(__dirname, "..", "resolve-change-id"));
  const changeId = resolveChangeId(_flags, config);
  const { gatesDir: getGatesDir, pipelineRoot } = require(path.join(__dirname, "..", "..", "paths"));
  const gatesDir = getGatesDir(cwd, changeId);
  if (!fs.existsSync(gatesDir)) {
    console.error(`No pipeline/gates/ at ${cwd} — nothing to restart.`);
    process.exit(1);
  }

  // Resolve <stage> to a stage definition. Accept either the friendly
  // name ('peer-review') or the gate-id ('stage-05'); errored input is
  // user-actionable.
  const { STAGES, getStage, resolveStageName, orderedStageNamesForTrack } = require(path.join(__dirname, "..", "..", "pipeline", "stages"));
  const stageName = resolveStageName(stageInput);
  const stageDef = stageName ? STAGES[stageName] : null;
  if (!stageDef) {
    console.error(`Unknown stage "${stageInput}".`);
    console.error(`Known stages: ${Object.keys(STAGES).join(", ")}`);
    process.exit(2);
  }

  // Collect files to delete. The named stage's merged gate + any
  // per-workstream gates. With --cascade, also every later stage's gates.
  const track = _flags.track || config.pipeline.default_track || "full";
  const trackStages = orderedStageNamesForTrack(track);
  const startIdx = trackStages.indexOf(stageName);
  // If the stage isn't on the active track, we still allow restart of
  // just that stage's files (no cascade target list). Cascade only
  // makes sense within the active track.
  const stageNamesToClear = (_flags.cascade && startIdx >= 0)
    ? trackStages.slice(startIdx)
    : [stageName];
  const stagesToClear = stageNamesToClear.map((n) => getStage(n));

  const { listArchives } = require(path.join(__dirname, "..", "..", "gates", "archive"));
  const { STAGE_ARTIFACTS } = require(path.join(__dirname, "..", "..", "pipeline", "artifacts"));
  const pRoot = pipelineRoot(cwd, changeId);

  // Resolve an artifact pattern (exact file, "dir/", or "glob-*.md") to
  // the list of existing absolute paths under pipelineRoot.
  function resolveArtifact(pattern) {
    if (pattern.endsWith("/")) {
      const dir = path.join(pRoot, pattern);
      if (!fs.existsSync(dir)) return [];
      return fs.readdirSync(dir).map((f) => path.join(dir, f));
    }
    if (pattern.includes("*")) {
      if (!fs.existsSync(pRoot)) return [];
      const re = new RegExp("^" + pattern.replace(/[\\^$.|?+()[\]{}]/g, "\\$&").replace(/\*/g, ".*") + "$");
      return fs.readdirSync(pRoot).filter((f) => re.test(f)).map((f) => path.join(pRoot, f));
    }
    const full = path.join(pRoot, pattern);
    return fs.existsSync(full) ? [full] : [];
  }

  const toDelete = [];
  for (const def of stagesToClear) {
    const merged = path.join(gatesDir, `${def.stage}.json`);
    if (fs.existsSync(merged)) toDelete.push(merged);
    for (const role of def.roles) {
      const ws = path.join(gatesDir, `${def.stage}.${role}.json`);
      if (fs.existsSync(ws)) toDelete.push(ws);
    }
    // 5.2: collect archived attempts via the shared listArchives path so stale
    // archives never outlive the failure sequence they describe. Same archive.js
    // module used by the driver's re-entry (fix-and-retry) and recovery (PASS)
    // pruning paths — this is the shared choke point the plan requires.
    for (const { file } of listArchives(gatesDir, def.stage)) {
      toDelete.push(file);
    }
    for (const pattern of (STAGE_ARTIFACTS[def.stage] || [])) {
      toDelete.push(...resolveArtifact(pattern));
    }
  }

  // Decide which injected sections to strip. Each known injection
  // is owned by a specific stage; we only strip when the stage being
  // restarted owns the section. context.md lives under pipelineRoot so
  // bounded runs strip from the right file (same invariant as driver.js).
  const contextPath = path.join(pRoot, "context.md");
  const toStrip = [];
  if (!_flags.keepContext) {
    const stripCandidates = [
      { stageId: "stage-04c", section: "red-team-blockers" },
      { stageId: "stage-04",  section: "qa-build-blockers", workstream: "qa" },
    ];
    const clearedIds = new Set(stagesToClear.map((d) => d.stage));
    // The qa-build-blockers are injected by stage-04.qa specifically, but
    // restart of stage-04 (the whole build stage) clears qa too; restart
    // of just qa via stage-04.qa input isn't a separate pathway today.
    for (const c of stripCandidates) {
      if (clearedIds.has(c.stageId)) toStrip.push(c.section);
    }
  }

  // Report and act.
  if (_flags.dryRun) {
    console.log(`Would restart: ${stageName} (${stageDef.stage})${_flags.cascade ? " — with cascade" : ""}`);
    console.log("Would delete:");
    if (toDelete.length === 0) console.log("  (no files for these stages)");
    for (const f of toDelete) console.log(`  rm ${path.relative(cwd, f)}`);
    if (toStrip.length > 0) {
      console.log(`Would strip from pipeline/context.md:`);
      for (const s of toStrip) console.log(`  - ${s} section`);
    }
    console.log("");
    console.log("Re-run without --dry-run to apply. Then `devteam next` to see what runs first.");
    return;
  }

  for (const f of toDelete) {
    fs.unlinkSync(f);
    console.log(`Removed ${path.relative(cwd, f)}`);
  }
  // Reset the driver's retry budget for cleared stages so `devteam run`
  // doesn't immediately re-halt after a convergence-exhausted restart.
  const rsPath = path.join(pRoot, "run-state.json");
  if (fs.existsSync(rsPath)) {
    try {
      const rs = JSON.parse(fs.readFileSync(rsPath, "utf8"));
      if (rs.fixRetries) {
        for (const n of stageNamesToClear) delete rs.fixRetries[n];
        fs.writeFileSync(rsPath, JSON.stringify(rs, null, 2) + "\n", "utf8");
      }
    } catch { /* non-fatal — run-state may not exist on a fresh pipeline */ }
  }

  for (const section of toStrip) {
    const stripped = stripMarkedSection(
      contextPath,
      `<!-- devteam:${section}:begin -->`,
      `<!-- devteam:${section}:end -->`,
    );
    if (stripped) console.log(`Stripped ${section} section from pipeline/context.md`);
  }
  if (toDelete.length === 0 && toStrip.length === 0) {
    console.log(`Nothing to clear: stage ${stageName} has no gates and no injected blockers.`);
  } else {
    console.log("");
    console.log(`Restarted ${stageName}${_flags.cascade ? " + downstream" : ""}. Next: \`devteam next\`.`);
  }
}

module.exports = { name, flags, run };
