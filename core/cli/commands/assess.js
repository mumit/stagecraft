"use strict";

const fs = require("node:fs");
const path = require("node:path");
const { generateHelp } = require(path.join(__dirname, "..", "flags"));

const name = "assess";

const flags = {
  cwd:          { type: "string",  description: "Target project directory" },
  // `run` and `stage` both name this string --feature, and assess is usually
  // the first command an operator types after init — accepting only
  // --description here made the documented quickstart fail on an unknown-flag
  // exit. Both spellings resolve to the same dest key; --description stays
  // supported so existing scripts keep working.
  feature:      { type: "string",  key: "description", description: "Change description for heuristics" },
  description:  { type: "string",  description: "Alias for --feature" },
  json:         { type: "boolean", description: "JSON output" },
  apply:        { type: "boolean", description: "Write inferred track to .devteam/config.yml as custom_stages (project-wide)" },
  confirm:      { type: "boolean", description: "Write pipeline/track.json with source:human (operator-confirmed)" },
  "no-content": { type: "boolean", description: "Skip file content scan" },
  help:         { type: "boolean", description: "Show this help" },
};

// G6 — Infer the best track for the current change.
// Reads changed-files.txt from pipeline/ unless positional file args are given.
// Default: writes pipeline/track.json as the per-run inference record (ADR-006 §2).
// With --confirm: writes source:"human" in track.json (operator-confirmed).
// With --apply: writes pipeline.custom_stages to .devteam/config.yml (project-wide; unchanged).
function run(positional, _flags) {
  const { assess } = require(path.join(__dirname, "..", "..", "stage-shopping", "assess"));
  if (_flags.help) { console.log(generateHelp("devteam assess [options] [files...]", flags)); process.exit(0); }
  const cwd = _flags.cwd || process.cwd();

  // Resolve file list: positional args > pipeline/changed-files.txt
  let files = positional.length > 0 ? positional : [];
  if (files.length === 0) {
    const changedFilesPath = path.join(cwd, "pipeline", "changed-files.txt");
    if (fs.existsSync(changedFilesPath)) {
      files = fs.readFileSync(changedFilesPath, "utf8").split(/\r?\n/).filter(Boolean);
    }
  }
  // Stagecraft's own install is not the change being assessed. Filtering here
  // as well as in gitChangedFiles covers the paths a caller supplies directly
  // — `devteam assess $(git status --porcelain | ...)` is a documented habit,
  // and an unfiltered `.claude/` in that list promotes the track (core/paths.js).
  const { isFrameworkOwnedPath } = require(path.join(__dirname, "..", "..", "paths"));
  files = files.filter((file) => !isFrameworkOwnedPath(file));

  const description = _flags.description || "";
  const result = assess(description, files, { scanContent: !_flags.noContent });

  // 29.3: cost preview for the recommendation plus the primary assurance
  // choices. Advisory only; assessment still succeeds if previewing fails.
  const { loadConfig } = require(path.join(__dirname, "..", "..", "config"));
  const {
    ceremonyPreview,
    assuranceOptions,
    renderCeremonyPreviewText,
    renderAssuranceOptionsText,
  } = require(path.join(__dirname, "..", "..", "ceremony-preview"));
  let ceremony = null;
  let assurance = null;
  try {
    const config = loadConfig(cwd);
    assurance = assuranceOptions(cwd, config, result.recommendedTrack);
    ceremony = assurance.find((option) => option.track === result.recommendedTrack)
      || ceremonyPreview(cwd, result.recommendedTrack, config);
  } catch { /* preview is advisory — assess's track recommendation stands without it */ }

  if (_flags.json) {
    console.log(JSON.stringify({ ...result, ceremony_preview: ceremony, assurance_options: assurance }, null, 2));
  } else {
    const conf = { high: "high ✓", medium: "medium", low: "low" }[result.confidence] || result.confidence;
    console.log(`Recommended track: ${result.recommendedTrack}  (confidence: ${conf})`);
    console.log(`Stages (${result.stages.length}): ${result.stages.join(" → ")}`);
    if (result.candidateActiveRoles.length > 0) {
      console.log(`Build workstreams: ${result.candidateActiveRoles.join(", ")}`);
    }
    console.log("");
    console.log("Reasons:");
    for (const r of result.reasons) console.log(`  • ${r}`);
    if (result.securityRequired) console.log("  ⚠  security review required");
    if (result.migrationRequired) console.log("  ⚠  migration safety required");
    console.log("");
    if (ceremony) {
      for (const line of renderCeremonyPreviewText(ceremony)) console.log(line);
      console.log("");
    }
    if (assurance) {
      for (const line of renderAssuranceOptionsText(assurance)) console.log(line);
      console.log("");
    }
    if (_flags.apply) {
      console.log(`Applying: writing pipeline.custom_stages to .devteam/config.yml…`);
    } else {
      console.log("To apply this track, run with --apply or set pipeline.custom_stages in .devteam/config.yml:");
      console.log(`  pipeline:`);
      console.log(`    custom_stages: [${result.stages.map((s) => `"${s}"`).join(", ")}]`);
    }
  }

  // ADR-006 §2: default (no --apply) writes pipeline/track.json as the per-run
  // inference record. --confirm sets source:"human" (operator-confirmed).
  // --apply writes project-wide custom_stages (unchanged from before — no breaking change).
  if (!_flags.apply) {
    const trackJsonPath = path.join(cwd, "pipeline", "track.json");
    const version = require(path.join(__dirname, "..", "..", "..", "package.json")).version;
    const trackRecord = {
      track: result.recommendedTrack,
      source: _flags.confirm ? "human" : "inferred",
      confidence: result.confidence,
      reasons: result.reasons,
      assessed_at: new Date().toISOString(),
      assessed_by: `devteam assess ${version}`,
      candidate_active_roles: result.candidateActiveRoles,
    };
    try {
      fs.mkdirSync(path.dirname(trackJsonPath), { recursive: true });
      fs.writeFileSync(trackJsonPath, JSON.stringify(trackRecord, null, 2) + "\n", "utf8");
      if (!_flags.json) console.log(`  ✓ wrote pipeline/track.json (source: ${trackRecord.source})`);
    } catch (err) {
      if (!_flags.json) console.error(`  ✗ failed to write pipeline/track.json: ${err.message}`);
    }
  }

  if (_flags.apply) {
    const yaml = require("js-yaml");
    const { configPath: getConfigPath, clearConfigCache } = require(path.join(__dirname, "..", "..", "config"));
    const cfgPath = getConfigPath(cwd);
    let parsed = {};
    if (fs.existsSync(cfgPath)) {
      try { parsed = yaml.load(fs.readFileSync(cfgPath, "utf8")) || {}; } catch { parsed = {}; }
    } else {
      fs.mkdirSync(path.dirname(cfgPath), { recursive: true });
    }
    parsed.pipeline = parsed.pipeline || {};
    parsed.pipeline.custom_stages = result.stages;
    fs.writeFileSync(cfgPath, yaml.dump(parsed, { lineWidth: 120 }), "utf8");
    // Flush the per-cwd cache so any subsequent loadConfig() in this process
    // (e.g. a chained devteam stage call) sees the new custom_stages value.
    clearConfigCache();
    if (!_flags.json) console.log(`  ✓ wrote ${path.relative(cwd, cfgPath)}`);
  }
}

module.exports = { name, flags, run };
