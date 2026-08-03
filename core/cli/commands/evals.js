"use strict";

const path = require("node:path");
const { generateHelp } = require(path.join(__dirname, "..", "flags"));
const { gc, EVALS_RELATIVE_DIR } = require(path.join(__dirname, "..", "..", "evals", "capture"));

const name = "evals";

const flags = {
  cwd:  { type: "string",  description: "Target project directory" },
  json: { type: "boolean", description: "JSON output" },
  help: { type: "boolean", description: "Show this help" },
};

function usage() {
  return generateHelp("devteam evals gc [options]", flags)
    + "\nSubcommands:\n"
    + "  gc   Remove blobs under .devteam/evals/blobs/ that no captured case's\n"
    + "       inputs/manifest.json references.\n"
    + "\n"
    + "Eval cases (plans/phase-33-eval-flywheel.md item 33.1) are captured\n"
    + "automatically on gate FAIL/ESCALATE and stamp overrides under\n"
    + `${EVALS_RELATIVE_DIR}/cases/, with readFirst-artifact snapshots\n`
    + "content-addressed and deduped into blobs/. `gc` reclaims blobs a case no\n"
    + "longer references (e.g. after manually deleting a case directory).\n";
}

function run(positional, commandFlags) {
  if (commandFlags.help) { console.log(usage()); process.exit(0); }
  const sub = positional[0];
  if (sub !== "gc") {
    console.error(`Unknown evals subcommand: ${sub || "(none)"}`);
    console.error("Usage: devteam evals gc [--json]");
    process.exit(2);
  }

  const cwd = path.resolve(commandFlags.cwd || process.cwd());
  const result = gc(cwd);

  if (commandFlags.json) {
    console.log(JSON.stringify(result, null, 2));
    return;
  }
  console.log(`Removed ${result.removed} unreferenced blob(s); kept ${result.kept} (${result.referenced} referenced).`);
}

module.exports = { name, flags, run };
