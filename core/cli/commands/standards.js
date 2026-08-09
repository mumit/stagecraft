"use strict";

const fs = require("node:fs");
const path = require("node:path");
const { generateHelp } = require(path.join(__dirname, "..", "flags"));

const name = "standards";

const flags = {
  cwd:       { type: "string",  description: "Target project directory" },
  json:      { type: "boolean", description: "JSON output" },
  "dry-run": { type: "boolean", description: "Print report without writing" },
  force:     { type: "boolean", description: "Overwrite existing docs/project-conventions.md" },
  help:      { type: "boolean", description: "Show this help" },
};

// Usage: devteam standards discover [--cwd <dir>] [--json] [--dry-run] [--force]
//
// Scans the project codebase (pure static analysis) and writes
// docs/project-conventions.md. --dry-run prints the report without writing.
// --json emits the structured discovery result as JSON to stdout.
// --force overwrites an existing docs/project-conventions.md.
function run(positional, _flags) {
  if (_flags.help) { console.log(generateHelp("devteam standards discover [options]", flags)); process.exit(0); }
  const sub = positional[0];
  const cwd = _flags.cwd || process.cwd();

  if (sub === "discover") {
    const { discover, formatReport } = require(
      path.join(__dirname, "..", "..", "standards", "discover"));
    const result = discover(cwd);

    if (_flags.json) {
      console.log(JSON.stringify(result, null, 2));
      return;
    }

    const report = formatReport(result);

    if (_flags.dryRun) {
      console.log(report);
      return;
    }

    const outPath = path.join(cwd, "docs", "project-conventions.md");
    if (fs.existsSync(outPath) && !_flags.force) {
      console.error(`${path.relative(cwd, outPath)} already exists. Use --force to overwrite.`);
      process.exit(1);
    }
    fs.mkdirSync(path.dirname(outPath), { recursive: true });
    fs.writeFileSync(outPath, report, "utf8");
    const knowledge = require(path.join(__dirname, "..", "..", "knowledge-pack")).writeProjectFacts(cwd, result);
    console.log(`✓ wrote ${path.relative(cwd, outPath)}`);
    console.log(`✓ refreshed ${path.relative(cwd, knowledge.file)} (${knowledge.facts.length} bounded fact(s))`);
    console.log(`  Stage prompts include these facts automatically in the Project Knowledge Pack.`);
    return;
  }

  console.error("Usage: devteam standards discover [--cwd <dir>] [--json] [--dry-run] [--force]");
  process.exit(2);
}

module.exports = { name, flags, run };
