"use strict";

const path = require("node:path");
const { stageNames } = require(path.join(__dirname, "..", "..", "pipeline", "stages"));
const { generateHelp } = require(path.join(__dirname, "..", "flags"));

const name = "stages";
const flags = {
  help: { type: "boolean", description: "Show this help" },
};

function run(_positional, _flags) {
  if (_flags.help) { console.log(generateHelp("devteam stages", flags)); process.exit(0); }
  for (const n of stageNames()) console.log(n);
}

module.exports = { name, flags, run };
