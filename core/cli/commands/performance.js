"use strict";

const path = require("node:path");
const { generateHelp } = require(path.join(__dirname, "..", "flags"));

const name = "performance";

const flags = {
  cwd:     { type: "string",  description: "Target project directory" },
  feature: { type: "string",  description: "Feature name (bounded isolation mode)" },
  json:    { type: "boolean", description: "JSON output" },
  help:    { type: "boolean", description: "Show this help" },
};

function usage() {
  return generateHelp("devteam performance critical-path [options]", flags)
    + "\nSubcommands:\n"
    + "  critical-path   Reconstruct run critical path from run-log.jsonl\n";
}

function run(positional, _flags) {
  if (_flags.help) { console.log(usage()); process.exit(0); }
  const subcommand = positional[0] || "critical-path";
  if (subcommand !== "critical-path") {
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
  const { analyzeProject, renderMarkdown } = require(path.join(__dirname, "..", "..", "performance", "critical-path"));
  const report = analyzeProject(cwd, { changeId });

  if (_flags.json) {
    console.log(JSON.stringify(report, null, 2));
    return;
  }
  process.stdout.write(renderMarkdown(report));
}

module.exports = { name, flags, run };
