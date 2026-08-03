"use strict";

const fs = require("node:fs");
const path = require("node:path");

const BLOCK_BEGIN = "# BEGIN stagecraft — managed by devteam init; do not edit manually";
const BLOCK_END = "# END stagecraft";

// Verbatim from ADR-010 §canonical block. This is the single source of truth.
const CANONICAL_BLOCK = `${BLOCK_BEGIN}
pipeline/run.lock
pipeline/run-state.json
pipeline/run-log.jsonl
pipeline/logs/
pipeline/gates/archive/
pipeline/gates/replay/
pipeline/dispatches/
pipeline/memory/
pipeline/lint-output.txt
pipeline/pre-review-output.txt
pipeline/changed-files.txt
pipeline/changes/*/run.lock
pipeline/changes/*/run-state.json
pipeline/changes/*/run-log.jsonl
pipeline/changes/*/logs/
pipeline/changes/*/gates/archive/
pipeline/changes/*/gates/replay/
pipeline/changes/*/dispatches/
pipeline/changes/*/memory/
pipeline/changes/*/lint-output.txt
pipeline/changes/*/pre-review-output.txt
pipeline/changes/*/changed-files.txt
.devteam/memory/
.devteam/patterns/
.devteam/evidence-project-id
.devteam/corpus/
.devteam/evals/
${BLOCK_END}`;

/**
 * Writes or updates the managed stagecraft block in <projectRoot>/.gitignore.
 * Returns "wrote", "updated", or "skipped" to indicate what happened.
 * - "wrote":   .gitignore did not exist or had no block; file written.
 * - "updated": block existed but differed from canonical; block replaced.
 * - "skipped": block already matches canonical; file untouched.
 */
function writeGitignoreBlock(projectRoot) {
  const giPath = path.join(projectRoot, ".gitignore");
  const existing = fs.existsSync(giPath) ? fs.readFileSync(giPath, "utf8") : "";

  const beginIdx = existing.indexOf(BLOCK_BEGIN);
  const endIdx   = existing.indexOf(BLOCK_END);

  if (beginIdx !== -1 && endIdx !== -1 && endIdx > beginIdx) {
    // Block exists — extract current block content (inclusive of delimiters)
    const currentBlock = existing.slice(beginIdx, endIdx + BLOCK_END.length);
    if (currentBlock === CANONICAL_BLOCK) return "skipped";

    // Block differs (outdated format or manual edits inside) — replace it
    const before = existing.slice(0, beginIdx);
    const after  = existing.slice(endIdx + BLOCK_END.length);
    fs.writeFileSync(giPath, before + CANONICAL_BLOCK + after, "utf8");
    return "updated";
  }

  // No block present — append (with leading newline separator if file has content)
  const separator = (existing.length > 0 && !existing.endsWith("\n\n")) ? "\n" : "";
  fs.writeFileSync(giPath, existing + separator + CANONICAL_BLOCK + "\n", "utf8");
  return "wrote";
}

const DOGFOOD_BLOCK_BEGIN = "# BEGIN stagecraft-dogfood — managed by devteam init --profile dogfood; do not edit manually";
const DOGFOOD_BLOCK_END   = "# END stagecraft-dogfood";

const CANONICAL_DOGFOOD_BLOCK = `${DOGFOOD_BLOCK_BEGIN}
pipeline/brief.md
pipeline/context.md
pipeline/spec.feature
pipeline/runbook.md
pipeline/test-report.md
pipeline/code-review/
pipeline/changes/*/brief.md
pipeline/changes/*/context.md
pipeline/changes/*/spec.feature
pipeline/changes/*/runbook.md
pipeline/changes/*/test-report.md
pipeline/changes/*/code-review/
${DOGFOOD_BLOCK_END}`;

/**
 * Writes or updates the supplemental dogfood gitignore block.
 * Returns "wrote", "updated", or "skipped".
 */
function writeDogfoodGitignoreBlock(projectRoot) {
  const giPath = path.join(projectRoot, ".gitignore");
  const existing = fs.existsSync(giPath) ? fs.readFileSync(giPath, "utf8") : "";

  const beginIdx = existing.indexOf(DOGFOOD_BLOCK_BEGIN);
  const endIdx   = existing.indexOf(DOGFOOD_BLOCK_END);

  if (beginIdx !== -1 && endIdx !== -1 && endIdx > beginIdx) {
    const currentBlock = existing.slice(beginIdx, endIdx + DOGFOOD_BLOCK_END.length);
    if (currentBlock === CANONICAL_DOGFOOD_BLOCK) return "skipped";
    const before = existing.slice(0, beginIdx);
    const after  = existing.slice(endIdx + DOGFOOD_BLOCK_END.length);
    fs.writeFileSync(giPath, before + CANONICAL_DOGFOOD_BLOCK + after, "utf8");
    return "updated";
  }

  const separator = (existing.length > 0 && !existing.endsWith("\n\n")) ? "\n" : "";
  fs.writeFileSync(giPath, existing + separator + CANONICAL_DOGFOOD_BLOCK + "\n", "utf8");
  return "wrote";
}

module.exports = { writeGitignoreBlock, writeDogfoodGitignoreBlock, CANONICAL_BLOCK, BLOCK_BEGIN, BLOCK_END, CANONICAL_DOGFOOD_BLOCK, DOGFOOD_BLOCK_BEGIN, DOGFOOD_BLOCK_END };
