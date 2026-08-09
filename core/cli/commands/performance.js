"use strict";

const path = require("node:path");
const { generateHelp } = require(path.join(__dirname, "..", "flags"));

const name = "performance";

const flags = {
  cwd:     { type: "string",  description: "Target project directory" },
  feature: { type: "string",  description: "Feature name (bounded isolation mode)" },
  input:   { type: "list",    description: "Additional local project root for calibration (repeatable)" },
  fit:     { type: "string",  description: "Track fit feedback: too-light, right, or too-heavy" },
  reason:  { type: "string",  description: "Bounded fit reason code" },
  json:    { type: "boolean", description: "JSON output" },
  help:    { type: "boolean", description: "Show this help" },
};

function usage() {
  return generateHelp("devteam performance <subcommand> [options]", flags)
    + "\nSubcommands:\n"
    + "  critical-path   Reconstruct one run critical path from run-log.jsonl\n"
    + "  calibration     Aggregate p50/p95, cost, cache, knowledge, and Phase 41 readiness\n"
    + "  feedback        Record bounded track-fit feedback (requires --fit)\n";
}

function run(positional, _flags) {
  if (_flags.help) { console.log(usage()); process.exit(0); }
  const subcommand = positional[0] || "critical-path";
  if (!["critical-path", "calibration", "feedback"].includes(subcommand)) {
    console.error(`devteam performance: unknown subcommand "${subcommand}"`);
    console.error("Run `devteam performance --help` for usage.");
    process.exit(2);
  }

  const cwd = _flags.cwd || process.cwd();
  const { loadConfig, checkBoundedFence } = require(path.join(__dirname, "..", "..", "config"));
  const config = loadConfig(cwd);
  checkBoundedFence(config, "performance");
  const { resolveChangeId } = require(path.join(__dirname, "..", "resolve-change-id"));
  const changeId = resolveChangeId(_flags, config);
  if (subcommand === "feedback") {
    const { recordTrackFeedback } = require(path.join(__dirname, "..", "..", "performance", "calibration"));
    try {
      const fs = require("node:fs");
      const { pipelineRoot } = require(path.join(__dirname, "..", "..", "paths"));
      let plan = null;
      try { plan = JSON.parse(fs.readFileSync(path.join(pipelineRoot(cwd, changeId), "run-plan.json"), "utf8")); } catch { /* feedback still works before a run plan */ }
      const riskClass = plan?.assess_inline?.risk_level || plan?.assess_inline?.risk || null;
      const record = recordTrackFeedback(cwd, {
        fit: _flags.fit, reason: _flags.reason || "other", changeId,
        track: plan?.track || null, trackSource: plan?.track_source || null, riskClass,
      });
      if (_flags.json) console.log(JSON.stringify(record, null, 2));
      else console.log(`Recorded track fit: ${record.fit} (${record.reason})`);
    } catch (err) {
      console.error(`devteam performance feedback: ${err.message}`);
      process.exit(2);
    }
    return;
  }
  if (subcommand === "calibration") {
    const { analyzeProjects, renderMarkdown } = require(path.join(__dirname, "..", "..", "performance", "calibration"));
    const projects = [cwd, ...(_flags.input || [])];
    const report = analyzeProjects([...new Set(projects.map((project) => path.resolve(project)))], { changeId });
    if (_flags.json) console.log(JSON.stringify(report, null, 2));
    else process.stdout.write(renderMarkdown(report));
    return;
  }
  const { analyzeProject, renderMarkdown } = require(path.join(__dirname, "..", "..", "performance", "critical-path"));
  const report = analyzeProject(cwd, { changeId });

  if (_flags.json) {
    console.log(JSON.stringify(report, null, 2));
    return;
  }
  process.stdout.write(renderMarkdown(report));
}

module.exports = { name, flags, run };
