#!/usr/bin/env node
// generate-cli-ref.js
//
// Emits docs/reference/cli.md — a full CLI reference for `devteam`, generated
// from the per-command flag schemas in core/cli/commands/.  Each section has a
// synopsis, one-line description, and a flag table derived from the schema.
// Commands appear in the same order as the bin/devteam registry.
//
// Output is fenced with <!-- generated: do not hand-edit --> markers;
// scripts/consistency.js verifies the committed file equals fresh output.
//
// Usage:
//   node scripts/generate-cli-ref.js          # print to stdout
//   node scripts/generate-cli-ref.js --write  # write docs/reference/cli.md

"use strict";

const fs   = require("node:fs");
const path = require("node:path");

const ROOT = path.resolve(__dirname, "..");
const CMD_DIR = path.join(ROOT, "core", "cli", "commands");

// Registry order mirrors bin/devteam — the single authoritative ordering.
// Synopsis and description live here; flags are loaded from the command modules.
const COMMANDS = [
  {
    name:        "stage",
    synopsis:    "devteam stage <name> [options]",
    description: "Render stage prompt(s) for <name>, or drive the host CLI non-interactively with --headless.",
  },
  {
    name:        "next",
    synopsis:    "devteam next [options]",
    description: "Inspect pipeline/gates/ and report what to do next: run a stage, merge, fix a FAIL, resolve an ESCALATE, or done.",
  },
  {
    name:        "run",
    synopsis:    "devteam run [options]",
    description: "Bounded autonomous driver with optional TTY watch mode: loop next → dispatch → merge until pipeline-complete, halting for anything that needs a human. Use --feature for new work; --repair for bug fixes.",
  },
  {
    name:        "prototype",
    synopsis:    "devteam prototype <start|build|note|promote> [id-or-title] [options]",
    description: "Pre-SDLC fast-learning workflow. Creates prototype packets, optionally runs the build prompt through a headless host, appends feedback, and writes a promotion handoff into a normal Stagecraft track.",
  },
  {
    name:        "commit",
    synopsis:    "devteam commit [options]",
    description: "Stage exactly the right pipeline artifacts for completed stages and generate a meaningful commit message. Tracks a cursor so repeated calls are idempotent.",
  },
  {
    name:        "compact",
    synopsis:    "devteam compact [options]",
    description: "Remove all devteam-managed marker sections from pipeline/context.md. Sections are regenerated on the next run when still needed. Use to prune context.md after a long pipeline run or before switching to bounded isolation.",
  },
  {
    name:        "validate",
    synopsis:    "devteam validate [options]",
    description: "Validate the most recent gate in pipeline/gates/. Exit codes: 0 PASS/WARN, 1 malformed, 2 FAIL, 3 ESCALATE.",
  },
  {
    name:        "verify-chain",
    synopsis:    "devteam verify-chain [options]",
    description: "Verify predecessor hashes and optional HMAC authentication across the stage-gate chain.",
  },
  {
    name:        "stamp-chain",
    synopsis:    "devteam stamp-chain [options]",
    description: "(Re)stamp the chain on all stage gates, in order. Use after a deliberate earlier-stage re-run.",
  },
  {
    name:        "merge",
    synopsis:    "devteam merge <stage-name> [options]",
    description: "Merge per-workstream gates into the stage gate.",
  },
  {
    name:        "derive-approvals",
    synopsis:    "devteam derive-approvals [<file>] [options]",
    description: "Re-run the approval-derivation hook on pipeline/code-review/by-*.md and rewrite per-area stage-05 gates.",
  },
  {
    name:        "restart",
    synopsis:    "devteam restart <stage> [options]",
    description: "Clear a stage's gate(s) so the pipeline can re-run it. With --cascade, also clears every subsequent stage.",
  },
  {
    name:        "ruling",
    synopsis:    "devteam ruling [options]",
    description: "Dispatch the Principal subagent for an ad-hoc ruling. The ruling lands in pipeline/context.md.",
  },
  {
    name:        "fix-escalation",
    synopsis:    "devteam fix-escalation [options]",
    description: "Implement the Principal ruling written by devteam ruling. Dispatches an applicator agent that reads PRINCIPAL-RULING entries.",
  },
  {
    name:        "preflight",
    synopsis:    "devteam preflight [options]",
    description: "Run mechanical pre-peer-review checks (stage-04e): committed-but-ignored files, broken test imports, deferred red-team items.",
  },
  {
    name:        "advise",
    synopsis:    "devteam advise [options]",
    description: "Inspect and triage follow-up items (DEFERRED, KNOWN-FLAKY, BRIEF-AMEND-NEEDED) before peer-review.",
  },
  {
    name:        "init",
    synopsis:    "devteam init --host <list> [options]",
    description: "Install host adapter(s) into the current project. Writes .devteam/config.yml and creates pipeline/gates/ workspace.",
  },
  {
    name:        "doctor",
    synopsis:    "devteam doctor [options]",
    description: "Pre-flight check: install integrity, target layout, config validity, adapter status, and host CLIs on PATH.",
  },
  {
    name:        "summary",
    synopsis:    "devteam summary [options]",
    description: "One-screen pipeline state report.",
  },
  {
    name:        "log",
    synopsis:    "devteam log [options]",
    description: "Chronological event timeline: every gate and artifact write in mtime order. --follow tails at 1-second poll.",
  },
  {
    name:        "report",
    synopsis:    "devteam report [options]",
    description: "Generate a self-contained HTML report of the most recent pipeline run. Embeds status, per-stage timing, dispatch counts, blocker log, and all pipeline documents. Written to pipeline/report.html and opened in the default browser. With --findings, generates a severity-ordered findings report instead, collected across every review artifact present (security-review, red-team, peer-review/critic, verification-beyond-tests, mutation, docs/audit/*.md) and labelled orchestrator-observed vs model-asserted — written to pipeline/findings-report.html.",
  },
  {
    name:        "performance",
    synopsis:    "devteam performance critical-path [options]",
    description: "Reconstruct run critical path from run-log.jsonl: dispatch wall, workstream compute, retry delay, telemetry coverage, and verification reuse candidates.",
  },
  {
    name:        "evidence",
    synopsis:    "devteam evidence <status|export|identity|accept-resolution|verify-attestation> [options]",
    description: "Assess evidence-gated capabilities offline, export consented aggregates or a per-run in-toto-shaped attestation, manage project identity, explicitly accept a successful fix/retry resolution, or offline-verify an attestation bundle.",
  },
  {
    name:        "ui",
    synopsis:    "devteam ui [options]",
    description: "Start a local web UI at http://127.0.0.1:3737/ showing pipeline state with live updates via SSE.",
  },
  {
    name:        "memory",
    synopsis:    "devteam memory <subcommand> [options]",
    description: "Persistent project memory. Subcommands: ingest, query, stats, clear, reindex, promote.",
  },
  {
    name:        "patterns",
    synopsis:    "devteam patterns <collect|list|review|promote|retire|demote|export|stats> [options]",
    description: "Project-local pattern learning. Collect sanitized observations, review candidates (flagging recurrence-heavy patterns for demotion), promote advisory guidance, retire or demote patterns, export promoted patterns as an Agent Skills SKILL.md, and inspect stats.",
  },
  {
    name:        "corpus",
    synopsis:    "devteam corpus stats [options]",
    description: "Summarize the run corpus (.devteam/corpus/dispatches.jsonl): total dispatches, per-stage pass rates, per-(role, host) dispatch counts — the D5/H3 evidence-gate questions in docs/BACKLOG.md.",
  },
  {
    name:        "evals",
    synopsis:    "devteam evals <gc|run|compare> [options]",
    description: "Eval flywheel. `gc` removes .devteam/evals/blobs/ entries no captured case's inputs/manifest.json references (cases are captured automatically on gate FAIL/ESCALATE and stamp overrides, plans/phase-33-eval-flywheel.md item 33.1). `run` replays captured cases against the CURRENT framework — --stub (default) scores structurally, free; --headless-host <h> dispatches for real and flags a resolved case that fails again as a regression (item 33.2). `compare --pack <A> --pack <B>` reports per-stage pass-rate deltas between two prompt_pack_version values from the run corpus, refusing a stage below --min-n dispatches on either pack (item 33.3).",
  },
  {
    name:        "architecture",
    synopsis:    "devteam architecture <subcommand> [options]",
    description: "Query the org-shared store for prior ADRs and lessons learned. Principal consults this before designing.",
  },
  {
    name:        "reproduce",
    synopsis:    "devteam reproduce <stage-id> [options]",
    description: "Report what was recorded for a stage (model version, temperature, seed, prompt hash) for replay.",
  },
  {
    name:        "verify",
    synopsis:    "devteam verify <stage-id> [options]",
    description: "Orchestrator-stamped verification: run configured or auto-discovered Node, pytest, and Go suites, then rewrite gate fields with observed reality.",
  },
  {
    name:        "replay",
    synopsis:    "devteam replay <stage-id> [options]",
    description: "Re-run a recorded stage with current config and diff the result against the original gate.",
  },
  {
    name:        "ci",
    synopsis:    "devteam ci <install|show> [options]",
    description: "Drop a CI workflow template into the target project (install), or print it to stdout (show).",
  },
  {
    name:        "spec",
    synopsis:    "devteam spec <verify|generate> [options]",
    description: "Drift-check brief.md ↔ spec.feature ↔ test-report.md (verify), or scaffold a spec.feature from brief ACs (generate).",
  },
  {
    name:        "consistency",
    synopsis:    "devteam consistency analyze [options]",
    description: "Cross-artifact drift check: brief → spec → reviews → red-team → test-report → gate field reality.",
  },
  {
    name:        "assess",
    synopsis:    "devteam assess [options] [files...]",
    description: "Infer the best pipeline track for the current change from file paths, content, and description heuristics.",
  },
  {
    name:        "standards",
    synopsis:    "devteam standards discover [options]",
    description: "Scan the project codebase and produce docs/project-conventions.md with detected tech stack, style, and tooling.",
  },
  {
    name:        "review-pr",
    synopsis:    "devteam review-pr <number|url> [options]",
    description: "Materialize an inbound GitHub PR (diff, changed files, title/body) into pipeline/review-input/ and dispatch stage-05 against it: a single reviewer in panel mode, reviewer then critic when review.mode: adversarial. Local-only by default; --post publishes the review as a PR comment after printing the exact payload and requiring interactive confirmation (or --yes in a non-interactive context) — refuses outright on a partial/incomplete review. Requires the gh CLI, authenticated (plans/phase-35-existing-codebase-mode.md item 35.2).",
  },
  {
    name:        "review",
    synopsis:    "devteam review <path> [options]",
    description: "Zero-install external review: no init, no config, nothing written to <path>. Creates (or reuses) a review workspace under ~/.stagecraft/reviews/<slug>/ and dispatches the track there with ctx.processCwd=<path>, ctx.cwd=<workspace>. Only --host acp mechanically prevents writes to <path> (hosts/acp/permissions.js); any other host prints a warning and refuses without --allow-unenforced-writes. Prints the 35.4 findings report path on completion. --list shows existing workspaces: subject path, last run date, last status.",
  },
  {
    name:        "stages",
    synopsis:    "devteam stages",
    description: "List known stage names.",
  },
  {
    name:        "hosts",
    synopsis:    "devteam hosts",
    description: "List installed host adapters.",
  },
  {
    name:        "help",
    synopsis:    "devteam help",
    description: "Show command list and quickstart.",
  },
];

// Load flags from the command module. Returns {} if the module has no flags
// (e.g. stages, hosts, help).
function loadFlags(cmdName) {
  const modPath = path.join(CMD_DIR, cmdName + ".js");
  try {
    const mod = require(modPath);
    return mod.flags || {};
  } catch {
    return {};
  }
}

// Pad a string to at least `width` characters.
function pad(s, width) {
  return s + " ".repeat(Math.max(0, width - s.length));
}

// Render a flag table for the given flags schema.
// Excludes the `help` flag (it is universal and would clutter every table).
// Returns an empty string if there are no flags worth showing.
function renderFlagTable(flags) {
  const entries = Object.entries(flags).filter(([k]) => k !== "help");
  if (entries.length === 0) return "";

  const TYPE_DISPLAY = { boolean: "bool", string: "string", number: "number", list: "list" };
  const rows = entries.map(([flagName, def]) => [
    `--${flagName}`,
    TYPE_DISPLAY[def.type] || def.type,
    def.description || "",
  ]);

  const headers = ["Flag", "Type", "Description"];
  const widths = headers.map((h, i) =>
    Math.max(h.length, ...rows.map(r => r[i].length))
  );

  const lines = [];
  lines.push("| " + headers.map((h, i) => pad(h, widths[i])).join(" | ") + " |");
  lines.push("| " + widths.map(w => "-".repeat(w)).join(" | ") + " |");
  for (const row of rows) {
    lines.push("| " + row.map((cell, i) => pad(cell, widths[i])).join(" | ") + " |");
  }
  return lines.join("\n");
}

// ── Render ───────────────────────────────────────────────────────────────────

function renderCommands() {
  const sections = [];

  for (const cmd of COMMANDS) {
    const flags = loadFlags(cmd.name);
    const flagTable = renderFlagTable(flags);
    const hasFlags = flagTable.length > 0;

    const lines = [
      `### \`${cmd.synopsis}\``,
      "",
      cmd.description,
      "",
    ];

    if (hasFlags) {
      lines.push(flagTable);
      lines.push("");
    }

    sections.push(lines.join("\n"));
  }

  return sections.join("\n");
}

const FENCE_OPEN  = "<!-- generated: do not hand-edit -->";
const FENCE_CLOSE = "<!-- /generated -->";

const CMD_COUNT = COMMANDS.length;

function generateBlock() {
  return [
    FENCE_OPEN,
    `<!-- To regenerate: npm run docs:generate (source: core/cli/commands/*.js) -->`,
    "",
    `# CLI Reference`,
    "",
    `Full \`devteam\` command reference. ${CMD_COUNT} commands.`,
    `Derived from the per-command flag schemas in \`core/cli/commands/\`.`,
    `Run \`npm run docs:generate\` to regenerate after adding or changing flags.`,
    "",
    `All flags are optional unless marked otherwise. \`--help\` is available on every command.`,
    "",
    `---`,
    "",
    renderCommands(),
    FENCE_CLOSE,
  ].join("\n");
}

// ── CLI ───────────────────────────────────────────────────────────────────────
if (require.main === module) {
  const args = process.argv.slice(2);

  if (args.includes("--write")) {
    const outPath = path.join(ROOT, "docs", "reference", "cli.md");
    fs.mkdirSync(path.dirname(outPath), { recursive: true });
    fs.writeFileSync(outPath, generateBlock() + "\n");
    console.log("Wrote docs/reference/cli.md");
  } else {
    console.log(generateBlock());
  }
}

module.exports = { generateBlock, FENCE_OPEN, FENCE_CLOSE, CMD_COUNT, COMMANDS };
