"use strict";

const path = require("node:path");
const { generateHelp } = require(path.join(__dirname, "..", "flags"));
const { getOrchestrator } = require(path.join(__dirname, "..", "get-orchestrator"));

const name = "summary";

const flags = {
  cwd:  { type: "string",  description: "Target project directory" },
  json: { type: "boolean", description: "JSON output" },
  help: { type: "boolean", description: "Show this help" },
};

function run(positional, _flags) {
  if (_flags.help) { console.log(generateHelp("devteam summary [options]", flags)); process.exit(0); }
  const cwd = _flags.cwd || process.cwd();
  const { requireProjectContext } = require(path.join(__dirname, "..", "project-guard"));
  requireProjectContext(cwd, _flags, "summary");
  const { summary } = getOrchestrator();
  const result = summary({ cwd });
  if (_flags.json) {
    console.log(JSON.stringify(result, null, 2));
    return;
  }
  const icons = { pass: "✅", warn: "⚠️ ", fail: "❌", escalate: "🚨",
                  partial: "⏳", skipped: "⏸ ", pending: "○ " };
  console.log(`Pipeline state — track: ${result.track}`);
  console.log("".padEnd(50, "─"));
  for (const row of result.rows) {
    const icon = icons[row.state] || "•";
    const left = `${icon} ${row.name.padEnd(20)}${row.stage}`;
    if (row.state === "skipped") {
      console.log(`${left}  (skipped — ${row.reason || "condition not met"})`);
      continue;
    }
    console.log(`${left}  ${row.state.toUpperCase()}`);
    if (row.workstreams) {
      for (const w of row.workstreams) {
        const wicon = icons[w.state] || "•";
        console.log(`    ${wicon} ${(w.role || "").padEnd(14)}${(w.host ? `(${w.host})` : "").padEnd(20)} ${w.state.toUpperCase()}`);
      }
      if (row.remaining && row.remaining.length > 0) {
        console.log(`    pending workstreams: ${row.remaining.join(", ")}`);
      }
    }
    if (row.blockers) for (const b of row.blockers) console.log(`    ❌ ${b}`);
    if (row.warnings) for (const w of row.warnings) console.log(`    ⚠️  ${w}`);
  }
}

module.exports = { name, flags, run };
