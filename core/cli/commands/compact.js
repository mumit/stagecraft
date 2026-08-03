"use strict";

const fs   = require("node:fs");
const path = require("node:path");

const { generateHelp } = require(path.join(__dirname, "..", "flags"));
const { pipelineRoot }  = require(path.join(__dirname, "..", "..", "paths"));
const { parseSections } = require(path.join(__dirname, "..", "..", "markers"));

const name = "compact";

const flags = {
  "dry-run": { type: "boolean", description: "Show what would be removed without modifying context.md" },
  json:      { type: "boolean", description: "Machine-readable output" },
  cwd:       { type: "string",  description: "Target project directory" },
  help:      { type: "boolean", description: "Show this help" },
};

// Remove all devteam marker sections from content.
// Strips in reverse order so earlier offsets stay valid.
// Collapses runs of 3+ blank lines left behind by removal.
function compact(content) {
  const sections = parseSections(content);
  if (sections.length === 0) return { result: content, removed: [] };

  let result = content;
  for (let i = sections.length - 1; i >= 0; i--) {
    const { start, end } = sections[i];
    const before = result.slice(0, start);
    const after  = result.slice(end).replace(/^\n+/, "\n");
    result = before + after;
  }
  result = result.replace(/\n{3,}/g, "\n\n");

  return { result, removed: sections.map((s) => s.sectionName) };
}

function run(positional, _flags) {
  if (_flags.help) {
    console.log(generateHelp("devteam compact [options]", flags));
    process.exit(0);
  }

  const cwd      = _flags.cwd || process.cwd();
  const isDryRun = Boolean(_flags.dryRun);
  const jsonMode = Boolean(_flags.json);

  // compact always targets the global pipeline/context.md — not change-scoped.
  const ctxPath = path.join(pipelineRoot(cwd, null), "context.md");

  if (!fs.existsSync(ctxPath)) {
    const msg = "pipeline/context.md not found — nothing to compact";
    if (jsonMode) {
      console.log(JSON.stringify({ dry_run: isDryRun, removed: [], compacted: false, reason: msg }));
    } else {
      console.log(msg);
    }
    process.exit(0);
  }

  const before = fs.readFileSync(ctxPath, "utf8");
  const { result, removed } = compact(before);

  if (removed.length === 0) {
    const msg = "no devteam-managed sections found — context.md is already compact";
    if (jsonMode) {
      console.log(JSON.stringify({ dry_run: isDryRun, removed: [], compacted: false, reason: msg }));
    } else {
      console.log(msg);
    }
    process.exit(0);
  }

  const linesBefore = before.split("\n").length;
  const linesAfter  = result.split("\n").length;

  if (jsonMode && isDryRun) {
    console.log(JSON.stringify({
      dry_run:      true,
      removed,
      compacted:    false,
      lines_before: linesBefore,
      lines_after:  linesAfter,
    }));
    process.exit(0);
  }

  if (!jsonMode) {
    console.log(`Sections to remove (${removed.length}):`);
    for (const s of removed) console.log(`  devteam:${s}`);
    console.log(`\n${linesBefore} → ${linesAfter} lines`);
  }

  if (isDryRun) {
    if (!jsonMode) console.log("\n(dry run — context.md not modified)");
    process.exit(0);
  }

  fs.writeFileSync(ctxPath, result, "utf8");

  if (jsonMode) {
    console.log(JSON.stringify({
      dry_run:      false,
      removed,
      compacted:    true,
      lines_before: linesBefore,
      lines_after:  linesAfter,
    }));
  } else {
    console.log("\ncontext.md compacted.");
  }
}

module.exports = { name, flags, run };
