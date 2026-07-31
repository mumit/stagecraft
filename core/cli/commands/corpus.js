"use strict";

const path = require("node:path");
const { generateHelp } = require(path.join(__dirname, "..", "flags"));
const { computeStats, CORPUS_RELATIVE_DIR, CORPUS_FILE_NAME } = require(path.join(__dirname, "..", "..", "corpus"));

const name = "corpus";

const flags = {
  cwd:  { type: "string",  description: "Target project directory" },
  json: { type: "boolean", description: "JSON output" },
  help: { type: "boolean", description: "Show this help" },
};

function usage() {
  return generateHelp("devteam corpus stats [options]", flags)
    + "\nSubcommands:\n"
    + "  stats   Summarize .devteam/corpus/dispatches.jsonl: total dispatches,\n"
    + "          per-stage pass rates, per-(role, host) dispatch counts.\n"
    + "\n"
    + "The run corpus is one sanitized JSONL record per headless dispatch\n"
    + "(plans/phase-28-ground-truth-telemetry.md item 28.5). `stats` answers the\n"
    + "D5/H3 evidence-gate questions in docs/BACKLOG.md for THIS project — cross-\n"
    + "project aggregation is out of scope (corpus is local-only, never uploaded).\n";
}

function formatPct(n) { return `${n.toFixed(0)}%`; }

function renderText(stats) {
  const out = [];
  out.push(`Run corpus: ${path.join(CORPUS_RELATIVE_DIR, CORPUS_FILE_NAME)}`);
  out.push(`Total dispatches: ${stats.total_dispatches}`);
  out.push("");

  out.push("Per-stage pass rates:");
  if (stats.stages.length === 0) {
    out.push("  (no dispatches recorded yet)");
  } else {
    for (const s of stats.stages) {
      out.push(
        `  ${s.stage.padEnd(16)} ${String(s.total).padStart(4)} dispatches  ` +
        `${formatPct(s.pass_rate).padStart(4)} pass  ` +
        `(PASS ${s.pass}, WARN ${s.warn}, FAIL ${s.fail}, ESCALATE ${s.escalate}, no-gate ${s.no_gate})`,
      );
    }
  }
  out.push("");

  out.push(`Per-(role, host) dispatch counts (D5 evidence: ≥${stats.d5_min_dispatches} needed per pair, this project only):`);
  if (stats.role_host.length === 0) {
    out.push("  (no dispatches recorded yet)");
  } else {
    for (const rh of stats.role_host) {
      const marker = rh.meets_d5_threshold ? " ✓ meets D5 threshold" : "";
      out.push(`  ${rh.role}@${rh.host}`.padEnd(32) + `${rh.dispatches} dispatches${marker}`);
    }
  }
  out.push("");
  out.push(
    "D5/H3 (docs/BACKLOG.md) also require ≥ 2 real projects. Run this command\n" +
    "against each project's .devteam/corpus/ and combine manually — the corpus\n" +
    "itself is project-local and never aggregated across projects automatically.",
  );
  return out.join("\n") + "\n";
}

function run(positional, commandFlags) {
  if (commandFlags.help) { console.log(usage()); process.exit(0); }
  const sub = positional[0];
  if (sub !== "stats") {
    console.error(`Unknown corpus subcommand: ${sub || "(none)"}`);
    console.error("Usage: devteam corpus stats [--json]");
    process.exit(2);
  }

  const cwd = path.resolve(commandFlags.cwd || process.cwd());
  const stats = computeStats(cwd);

  if (commandFlags.json) {
    console.log(JSON.stringify(stats, null, 2));
    return;
  }
  process.stdout.write(renderText(stats));
}

module.exports = { name, flags, run };
