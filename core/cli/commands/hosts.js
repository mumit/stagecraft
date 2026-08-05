"use strict";

const path = require("node:path");
const { listHosts } = require(path.join(__dirname, "..", "..", "router"));
const { generateHelp } = require(path.join(__dirname, "..", "flags"));

const name = "hosts";
const flags = {
  help: { type: "boolean", description: "Show this help" },
};

function run(_positional, _flags) {
  if (_flags.help) { console.log(generateHelp("devteam hosts", flags)); process.exit(0); }
  const hosts = listHosts();
  if (hosts.length === 0) {
    console.log("(no host adapters installed under hosts/)");
    return;
  }
  for (const h of hosts) console.log(h);
}

module.exports = { name, flags, run };
