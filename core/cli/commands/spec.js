"use strict";

const fs = require("node:fs");
const path = require("node:path");
const { generateHelp } = require(path.join(__dirname, "..", "flags"));

const name = "spec";

const flags = {
  cwd:     { type: "string",  description: "Target project directory" },
  strict:  { type: "boolean", description: "Also fail on multi-mapped criteria" },
  track:   { type: "string",  description: "Track to verify against (default: the project's active track)" },
  json:    { type: "boolean", description: "JSON output" },
  force:   { type: "boolean", description: "Overwrite existing spec.feature" },
  feature: { type: "string",  description: "Feature name for scaffold" },
  help:    { type: "boolean", description: "Show this help" },
};

// G2 — `devteam spec <verify|generate>`. Bridges feature ACs or repair RCs ↔
// Gherkin scenarios ↔ test-report rows. Generate remains feature-only.
function run(positional, _flags) {
  if (_flags.help) { console.log(generateHelp("devteam spec <verify|generate> [options]", flags)); process.exit(0); }
  const sub = positional[0];
  const cwd = _flags.cwd || process.cwd();
  const { loadConfig, checkBoundedFence } = require(path.join(__dirname, "..", "..", "config"));
  const config = loadConfig(cwd);
  checkBoundedFence(config, "spec");
  const { resolveChangeId } = require(path.join(__dirname, "..", "resolve-change-id"));
  const changeId = resolveChangeId(_flags, config);
  const { pipelineRoot } = require(path.join(__dirname, "..", "..", "paths"));
  const pipelineDir = pipelineRoot(cwd, changeId);
  const FRAMEWORK_ROOT = path.join(__dirname, "..", "..", "..");

  if (sub === "verify") {
    const { verify } = require(path.join(FRAMEWORK_ROOT, "core", "spec", "verify"));
    const report = verify(cwd, { strictMapping: !!_flags.strict, pipelineDir });

    // 42.4: an artifact a stage never produces is not drift. `executable-spec`
    // is absent from loop, nano, refactor, and every review track, so on those
    // a missing spec.feature was reported as "❌ MISSING" and counted toward
    // drift — indistinguishable from a spec that should exist and does not.
    //
    // resolveActiveTrack is the same resolver `verify`, `verify-chain`,
    // `stamp-chain`, and `stage` use, so this reports against the track that
    // would actually execute — including a materialized run plan, which
    // outranks the mutable config default.
    //
    // An unknown track name still reports drift: suppressing it there would
    // turn a typo in default_track into a silent pass.
    const { resolveActiveTrack, trackLabel } =
      require(path.join(FRAMEWORK_ROOT, "core", "pipeline", "active-track"));
    const { isStageInTrack, TRACKS } = require(path.join(FRAMEWORK_ROOT, "core", "pipeline", "stages"));
    const active = resolveActiveTrack(cwd, config, _flags.track, changeId);
    const knownTrack = Array.isArray(active.track) || TRACKS.includes(active.track);
    const applicable = !knownTrack || isStageInTrack("executable-spec", active.track);
    report.track = trackLabel(active.track);
    report.track_source = active.source;
    report.applicable = applicable;
    if (!applicable) {
      report.status = "not-applicable";
      report.drift = false;
    }

    if (_flags.json) {
      console.log(JSON.stringify(report, null, 2));
      process.exit(report.drift ? 1 : 0);
    }

    if (!applicable) {
      console.log(`Executable spec verification — ${cwd}`);
      console.log("");
      console.log(`  not-applicable — the "executable-spec" stage is not in track "${report.track}" (${active.source}).`);
      console.log("  Nothing is expected to produce pipeline/spec.feature here, so there is no drift to report.");
      console.log("");
      console.log("  Verify against a track that includes it with: devteam spec verify --track full");
      process.exit(0);
    }

    const criteriaArtifact = report.artifacts.criteria;
    const criteriaLabel = report.criteria_source === "diagnosis" ? "diagnosis.md" : "brief.md";
    const criteriaRel = path.relative(cwd, criteriaArtifact.path);
    const specRel  = path.relative(cwd, report.artifacts.spec.path);
    const testRel  = path.relative(cwd, report.artifacts.test_report.path);
    console.log(`Executable spec verification — ${cwd}`);
    console.log("");
    console.log(`  ${criteriaLabel.padEnd(15)}${criteriaArtifact.exists ? "✅" : "❌ MISSING"}  ${criteriaRel}`);
    console.log(`  spec.feature:   ${report.artifacts.spec.exists  ? "✅" : "❌ MISSING"}  ${specRel}`);
    console.log(`  test-report.md: ${report.artifacts.test_report.exists ? "✅" : "—  (not yet written)"}  ${testRel}`);
    console.log("");
    console.log(`  ${report.criteria_source === "diagnosis" ? "Regression criteria in diagnosis" : "Acceptance criteria in brief"}: ${report.criteria.length}`);
    console.log(`  Scenarios in spec.feature:       ${report.scenarios.length}`);
    if (report.test_phase_complete) {
      console.log(`  Criterion refs in test-report:   ${report.test_refs.length}`);
    }
    console.log("");

    let issues = 0;
    if (report.orphan_criteria.length > 0) {
      issues++;
      console.log(`  ❌ ${report.orphan_criteria.length} orphan criterion/criteria (criterion in source, no scenario in spec):`);
      for (const oc of report.orphan_criteria) {
        console.log(`     - ${oc.id}: ${oc.body || "(no text)"}`);
      }
    }
    if (report.orphan_scenarios.length > 0) {
      issues++;
      console.log(`  ❌ ${report.orphan_scenarios.length} orphan scenario(s) (no criterion tag or unknown criterion):`);
      for (const os of report.orphan_scenarios) {
        const tail = os.missing_ac ? ` (refs ${os.missing_ac}, not in criteria source)` : ` (no @AC-N or @RC-N tag)`;
        console.log(`     - "${os.name}" (line ${os.line})${tail}`);
      }
    }
    if (report.duplicate_criteria.length > 0) {
      issues++;
      console.log(`  ❌ ${report.duplicate_criteria.length} duplicate criterion numbering:`);
      for (const dc of report.duplicate_criteria) {
        console.log(`     - ${dc.id} appears again at line ${dc.line}`);
      }
    }
    if (report.test_phase_complete) {
      if (report.orphan_in_tests.length > 0) {
        issues++;
        console.log(`  ❌ ${report.orphan_in_tests.length} criterion/criteria not referenced by test-report:`);
        for (const oi of report.orphan_in_tests) console.log(`     - ${oi.id}`);
      }
      if (report.unknown_in_tests.length > 0) {
        issues++;
        console.log(`  ❌ ${report.unknown_in_tests.length} unknown criterion reference(s) in test-report:`);
        for (const ui of report.unknown_in_tests) {
          console.log(`     - ${ui.id} (lines: ${ui.lines.join(", ")})`);
        }
      }
    }
    if (report.multi_mapped_criteria.length > 0) {
      const tag = _flags.strict ? "❌" : "ℹ️ ";
      console.log(`  ${tag} ${report.multi_mapped_criteria.length} criterion/criteria mapped by multiple scenarios:`);
      for (const mm of report.multi_mapped_criteria) {
        console.log(`     - ${mm.id} → ${mm.scenarios.length} scenarios`);
      }
      if (_flags.strict) issues++;
    }

    if (issues === 0) {
      console.log("  ✅ No drift detected.");
      process.exit(0);
    }
    console.log("");
    console.log(`Drift: ${issues} issue${issues === 1 ? "" : "s"}.`);
    process.exit(1);
  }

  if (sub === "generate") {
    const { generateScaffold, extractAcsFromBrief } = require(path.join(FRAMEWORK_ROOT, "core", "spec", "verify"));
    const briefPath = path.join(pipelineDir, "brief.md");
    const specPath  = path.join(pipelineDir, "spec.feature");
    if (!fs.existsSync(briefPath)) {
      console.error(`No brief at ${path.relative(cwd, briefPath)}. Run stage-01 (requirements) first.`);
      process.exit(1);
    }
    if (fs.existsSync(specPath) && !_flags.force) {
      console.error(`Spec already exists at ${path.relative(cwd, specPath)}. Use --force to overwrite.`);
      process.exit(1);
    }
    const briefText = fs.readFileSync(briefPath, "utf8");
    const scaffold = generateScaffold(briefText, { featureName: _flags.feature });
    fs.mkdirSync(path.dirname(specPath), { recursive: true });
    fs.writeFileSync(specPath, scaffold);
    const { ids } = extractAcsFromBrief(briefText);
    console.log(`✅ Wrote ${path.relative(cwd, specPath)} with ${ids.length} scenario(s).`);
    if (ids.length === 0) {
      console.log("");
      console.log("  ⚠️  No AC-N entries found in brief.md. Number your acceptance criteria");
      console.log("      as AC-1, AC-2, ... and re-run `devteam spec generate --force`.");
    } else {
      console.log("");
      console.log("Next steps:");
      console.log("  1. Edit spec.feature — fill in Given/When/Then for each scenario.");
      console.log("  2. Run `devteam spec verify` to confirm zero drift.");
      console.log("  3. Write pipeline/gates/stage-03b.json with the mapping + PASS.");
    }
    return;
  }

  console.error(`Unknown spec subcommand: ${sub || "(none)"}`);
  console.error("Usage:");
  console.error("  devteam spec verify [--strict] [--json]");
  console.error("  devteam spec generate [--feature \"<name>\"] [--force]");
  console.error("");
  console.error("verify   — drift-check brief.md/diagnosis.md ↔ spec.feature ↔ test-report.md");
  console.error("generate — scaffold pipeline/spec.feature from brief.md's AC-N list");
  process.exit(2);
}

module.exports = { name, flags, run };
