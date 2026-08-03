"use strict";

const path = require("node:path");
const { generateHelp } = require(path.join(__dirname, "..", "flags"));
const { gc, EVALS_RELATIVE_DIR } = require(path.join(__dirname, "..", "..", "evals", "capture"));

const name = "evals";

const flags = {
  cwd:            { type: "string",  description: "Target project directory" },
  stub:           { type: "boolean", description: "run: structural-only replay (default; free, no model)" },
  "headless-host": { type: "string", description: "run: dispatch for real against this host's headless machinery" },
  filter:         { type: "string",  description: "run: only replay cases matching this stage id or case id" },
  "budget-usd":   { type: "number",  description: "run: required cost cap before a --headless-host sweep" },
  pack:           { type: "list",    description: "compare: prompt_pack_version to compare — pass twice (--pack A --pack B)" },
  "min-n":        { type: "number",  description: "compare: minimum dispatches required per cell before comparing (default 5)" },
  json:           { type: "boolean", description: "JSON output (run: JSONL, one line per case)" },
  help:           { type: "boolean", description: "Show this help" },
};

function usage() {
  return generateHelp("devteam evals <gc|run|compare> [options]", flags)
    + "\nSubcommands:\n"
    + "  gc       Remove blobs under .devteam/evals/blobs/ that no captured case's\n"
    + "           inputs/manifest.json references.\n"
    + "  run      Replay captured cases against the CURRENT framework (roles/rules/\n"
    + "           templates/layout) to catch framework regressions. --stub (default)\n"
    + "           re-renders each case's prompt and scores it structurally — free,\n"
    + "           no model. --headless-host <h> dispatches for real via the existing\n"
    + "           headless machinery; a case whose original failure was later\n"
    + "           RESOLVED must PASS now or it's reported as a regression (exit 1).\n"
    + "           Requires --budget-usd; prints a cost preview first.\n"
    + "  compare  Per-stage pass-rate deltas between two prompt_pack_version values\n"
    + "           (phase-33 item 33.3) from the run corpus. --pack <A> --pack <B>\n"
    + "           (repeat the flag, exactly two required). Refuses to compare a\n"
    + "           stage with fewer than --min-n (default 5) dispatches on either\n"
    + "           pack for that stage.\n"
    + "\n"
    + "Eval cases (plans/phase-33-eval-flywheel.md item 33.1) are captured\n"
    + "automatically on gate FAIL/ESCALATE and stamp overrides under\n"
    + `${EVALS_RELATIVE_DIR}/cases/, with readFirst-artifact snapshots\n`
    + "content-addressed and deduped into blobs/. `gc` reclaims blobs a case no\n"
    + "longer references (e.g. after manually deleting a case directory).\n";
}

function runGc(cwd, commandFlags) {
  const result = gc(cwd);
  if (commandFlags.json) {
    console.log(JSON.stringify(result, null, 2));
    return;
  }
  console.log(`Removed ${result.removed} unreferenced blob(s); kept ${result.kept} (${result.referenced} referenced).`);
}

function statusLabel(entry) {
  if (entry.mode === "headless-host") {
    if (entry.verdict === "regression") return "REGRESSION";
    if (entry.verdict === "pass") return "PASS";
    if (entry.verdict === "still-failing") return "still-failing";
    if (entry.verdict === "no-gate") return "no-gate";
    return "ERROR";
  }
  return entry.status === "ok" ? "OK" : entry.status.toUpperCase();
}

function renderTable(outcome) {
  const lines = [];
  if (outcome.refused) {
    const { renderCostPreviewText } = require(path.join(__dirname, "..", "..", "evals", "run"));
    for (const l of renderCostPreviewText(outcome.preview)) lines.push(l);
    lines.push(`refused: ${outcome.reason}`);
    return lines.join("\n");
  }
  if (outcome.preview) {
    const { renderCostPreviewText } = require(path.join(__dirname, "..", "..", "evals", "run"));
    for (const l of renderCostPreviewText(outcome.preview)) lines.push(l);
    lines.push("");
  }
  lines.push(`${outcome.matched}/${outcome.total} case(s) matched (mode: ${outcome.mode})`);
  for (const c of outcome.cases) {
    const label = statusLabel(c);
    const detail = c.findings && c.findings.length > 0 ? ` — ${c.findings.join("; ")}` : "";
    lines.push(`  [${label}] ${c.id} (${c.stage}${c.role ? `.${c.role}` : ""})${detail}`);
  }
  return lines.join("\n");
}

function renderJsonl(outcome) {
  const lines = [];
  if (outcome.refused) {
    lines.push(JSON.stringify({ type: "refused", reason: outcome.reason, preview: outcome.preview }));
    return lines.join("\n");
  }
  for (const c of outcome.cases) lines.push(JSON.stringify({ type: "case", ...c }));
  lines.push(JSON.stringify({
    type: "summary", mode: outcome.mode, total: outcome.total, matched: outcome.matched,
    exit_code: outcome.exitCode, preview: outcome.preview || null,
  }));
  return lines.join("\n");
}

function runRun(cwd, commandFlags) {
  if (commandFlags.stub && commandFlags.headlessHost) {
    console.error("devteam evals run: --stub and --headless-host are mutually exclusive");
    process.exit(2);
  }
  const { runEvals } = require(path.join(__dirname, "..", "..", "evals", "run"));
  runEvals(cwd, {
    mode: commandFlags.headlessHost ? "headless-host" : "stub",
    headlessHost: commandFlags.headlessHost || null,
    filter: commandFlags.filter || null,
    budgetUsd: Number.isFinite(commandFlags.budgetUsd) ? commandFlags.budgetUsd : undefined,
  }).then((outcome) => {
    console.log(commandFlags.json ? renderJsonl(outcome) : renderTable(outcome));
    process.exit(outcome.exitCode);
  }).catch((err) => {
    console.error(`devteam evals run: ${err.message}`);
    process.exit(1);
  });
}

function formatPct(n) { return n === null ? "—" : `${n.toFixed(1)}%`; }

function renderCompareTable(outcome) {
  const lines = [];
  lines.push(`Prompt-pack compare: ${outcome.pack_a} vs ${outcome.pack_b} (min-n: ${outcome.min_n})`);
  if (outcome.stages.length === 0) {
    lines.push(`  no corpus dispatches recorded for either pack`);
    return lines.join("\n");
  }
  for (const s of outcome.stages) {
    if (s.refused) {
      lines.push(`  ${s.stage.padEnd(16)} refused — ${s.refused_reason}`);
      continue;
    }
    const deltaStr = s.delta === null ? "—" : `${s.delta >= 0 ? "+" : ""}${s.delta.toFixed(1)}pp`;
    lines.push(
      `  ${s.stage.padEnd(16)} A: ${s.pack_a.dispatches} dispatches, ${formatPct(s.pack_a.pass_rate)} pass` +
      `   B: ${s.pack_b.dispatches} dispatches, ${formatPct(s.pack_b.pass_rate)} pass   Δ ${deltaStr}`,
    );
  }
  return lines.join("\n");
}

function runCompare(cwd, commandFlags) {
  const packs = commandFlags.pack || [];
  if (packs.length !== 2) {
    console.error(`devteam evals compare: requires exactly two --pack values (got ${packs.length})`);
    console.error("Usage: devteam evals compare --pack <A> --pack <B> [--min-n <n>] [--json]");
    process.exit(2);
  }
  const { comparePacks } = require(path.join(__dirname, "..", "..", "evals", "compare"));
  const outcome = comparePacks(cwd, packs[0], packs[1], {
    minN: Number.isFinite(commandFlags.minN) ? commandFlags.minN : undefined,
  });
  console.log(commandFlags.json ? JSON.stringify(outcome, null, 2) : renderCompareTable(outcome));
}

function run(positional, commandFlags) {
  if (commandFlags.help) { console.log(usage()); process.exit(0); }
  const sub = positional[0];
  const cwd = path.resolve(commandFlags.cwd || process.cwd());

  if (sub === "gc") { runGc(cwd, commandFlags); return; }
  if (sub === "run") { runRun(cwd, commandFlags); return; }
  if (sub === "compare") { runCompare(cwd, commandFlags); return; }

  console.error(`Unknown evals subcommand: ${sub || "(none)"}`);
  console.error("Usage: devteam evals <gc|run|compare> [options]");
  process.exit(2);
}

module.exports = { name, flags, run };
