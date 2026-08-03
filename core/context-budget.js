// core/context-budget.js — pipeline/context.md diet
// (plans/phase-32-performance-parallelism.md item 32.5(a)).
//
// [verify-first] confirmed: context.md grows via devteam:* marker sections
// written by core/gates/validator.js and core/driver.js and is never pruned
// except by the fully-manual `devteam compact` (core/cli/commands/compact.js,
// which strips every section unconditionally). Every stage's readFirst
// points at the whole file (core/pipeline/stages.js), so an unbounded
// context.md costs every subsequent dispatch, not just the one that grew it.
//
// enforceContextBudget() is called by every marker writer right after it
// writes (see core/gates/validator.js's inject*Blockers, core/driver.js's
// writeRunBlockers/seedRightSizingContext/seedDeployContext). When
// context.md exceeds pipeline.context_budget_bytes, the oldest RESOLVED
// marker section (in document order — no per-section write timestamp exists
// to sort by) is replaced with a one-line digest pointing at its full text,
// archived under pipeline/context-archive/. A section is "resolved" only if
// this module has a mapping from its name to the stage gate whose PASS/WARN
// means the section's guidance is no longer actionable (RESOLVABLE_SECTIONS
// below); every other section — including devteam:run-blockers, which has
// no single owning gate and is already upserted (never accumulates
// duplicates) — is always treated as active and is never auto-compacted,
// however far over budget the file remains. Archiving is append-only:
// existing archive files are never overwritten or deleted.
//
// Fire-and-forget contract: a failure here must never block the marker
// write that triggered it.

"use strict";

const fs = require("node:fs");
const path = require("node:path");
const { pipelineRoot, gatesDir } = require("./paths");
const { loadConfig } = require("./config");
const { parseSections } = require("./markers");
const { logContextSectionEvent } = require("./context-log");

// section name -> gate file (relative to gatesDir) whose PASS/WARN status
// means the section is resolved and eligible for auto-compaction.
const RESOLVABLE_SECTIONS = {
  "right-sizing": "stage-01.json",
  "deploy-target": "stage-08.json",
  "red-team-blockers": "stage-04c.json",
  "qa-build-blockers": "stage-04.qa.json",
};

const DIGEST_MARKER = "_Compacted ";

function isAlreadyCompacted(sectionBody) {
  return sectionBody.includes(DIGEST_MARKER);
}

function sectionResolved(cwd, changeId, sectionName) {
  const gateFile = RESOLVABLE_SECTIONS[sectionName];
  if (!gateFile) return false;
  try {
    const gate = JSON.parse(fs.readFileSync(path.join(gatesDir(cwd, changeId), gateFile), "utf8"));
    return gate.status === "PASS" || gate.status === "WARN";
  } catch {
    return false;
  }
}

// Filesystem-safe, sortable, deterministic-for-a-given-`now` timestamp.
function archiveTimestamp(now) {
  return now.toISOString().replace(/[:.]/g, "-");
}

// Append-only: never overwrite an existing archive file. Collisions (same
// section compacted twice within the same clock millisecond) fall back to a
// numeric suffix rather than clobbering the earlier archive.
function reserveArchivePath(archiveDir, sectionName, now) {
  const ts = archiveTimestamp(now);
  let file = path.join(archiveDir, `${ts}-${sectionName}.md`);
  let n = 2;
  while (fs.existsSync(file)) {
    file = path.join(archiveDir, `${ts}-${n}-${sectionName}.md`);
    n++;
  }
  return file;
}

/**
 * Compact the first (document-order) resolved, not-yet-compacted section.
 * Returns { content, sectionName } on success, or null if nothing is eligible.
 */
function compactOneSection(cwd, changeId, content, now) {
  for (const s of parseSections(content)) {
    const body = content.slice(s.start, s.end);
    if (isAlreadyCompacted(body)) continue;
    if (!sectionResolved(cwd, changeId, s.sectionName)) continue;

    const archiveDir = path.join(pipelineRoot(cwd, changeId), "context-archive");
    fs.mkdirSync(archiveDir, { recursive: true });
    const archiveFile = reserveArchivePath(archiveDir, s.sectionName, now);
    fs.writeFileSync(archiveFile, body.endsWith("\n") ? body : body + "\n", "utf8");

    const relArchive = path.relative(cwd, archiveFile).split(path.sep).join("/");
    const digest = [
      `<!-- devteam:${s.sectionName}:begin -->`,
      `${DIGEST_MARKER}${now.toISOString()} — archived to \`${relArchive}\`.`,
      `<!-- devteam:${s.sectionName}:end -->`,
    ].join("\n");

    return {
      content: content.slice(0, s.start) + digest + content.slice(s.end),
      sectionName: s.sectionName,
    };
  }
  return null;
}

/**
 * Enforce pipeline.context_budget_bytes against pipeline/context.md.
 * @param {string} cwd
 * @param {string|null} changeId
 * @param {object} [opts]
 * @param {Date} [opts.now] — injected clock for deterministic archive names in tests
 */
function enforceContextBudget(cwd, changeId, opts = {}) {
  try {
    const contextPath = path.join(pipelineRoot(cwd, changeId), "context.md");
    if (!fs.existsSync(contextPath)) return;

    let budget;
    try {
      budget = loadConfig(cwd).pipeline.context_budget_bytes;
    } catch {
      budget = 8192;
    }

    let content = fs.readFileSync(contextPath, "utf8");
    // Bounded loop: one compaction can only ever shrink the file, and there
    // are finitely many sections, so this always terminates well under 100.
    for (let guard = 0; Buffer.byteLength(content, "utf8") > budget && guard < 100; guard++) {
      const result = compactOneSection(cwd, changeId, content, opts.now || new Date());
      if (!result) break; // nothing left eligible — active sections survive over budget
      content = result.content;
      fs.writeFileSync(contextPath, content, "utf8");
      logContextSectionEvent(cwd, changeId, { action: "compacted", section: result.sectionName });
    }
  } catch {
    // best-effort — must never block the caller
  }
}

module.exports = { enforceContextBudget, RESOLVABLE_SECTIONS };
