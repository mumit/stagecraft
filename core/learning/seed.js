"use strict";

// Cold-start pattern seeding (builder review F-series, Wave 3).
//
// Gate-derived collection only ever learns from pain: every observation starts
// as a blocker, a warning, or a follow-up. So a brand-new project's Project
// Knowledge Pack carries a few lines of stack trivia, and an agent rediscovers
// the house conventions by failing a gate first — even when the repository has
// had those conventions written down for years.
//
// This reads what is already there. CONTRIBUTING.md, AGENTS.md, and the
// project-conventions report are exactly what a senior engineer absorbs in
// week one, and they exist as text before Stagecraft ever runs.
//
// Deliberate limits, so this cannot become a back door into the prompt:
//   - it produces CANDIDATES only, into the same review queue gate-derived
//     ones land in. Nothing is promoted, and nothing reaches a prompt, without
//     the existing human `devteam patterns promote`.
//   - only normative statements are extracted. A sentence with no "must",
//     "never", "always", "prefer", "avoid" or similar is documentation, not a
//     convention, and is skipped.
//   - every extracted line is secret-scanned before it is stored.
//   - counts and lengths are bounded, so a large handbook cannot flood the
//     queue or the eventual prompt budget.

const fs = require("node:fs");
const path = require("node:path");
const { scanContent } = require("../hooks/secret-scan");

// Files a project's conventions actually live in. Deliberately a short,
// explicit list rather than a docs/ crawl: the point is high-signal house
// rules, not everything the repository has ever written down.
const SOURCE_FILES = [
  "AGENTS.md",
  "CONTRIBUTING.md",
  "CLAUDE.md",
  path.join("docs", "project-conventions.md"),
  path.join("docs", "CONVENTIONS.md"),
];

const MAX_FILE_BYTES = 256 * 1024;
const MAX_STATEMENTS = 40;
const MIN_LENGTH = 24;
const MAX_LENGTH = 240;

// A convention tells you what to do. Prose describes. This is the whole
// difference between a useful seed and a paraphrase of the README.
const NORMATIVE = /\b(must|never|always|do not|don't|should|prefer|avoid|require[sd]?|forbidden|mandatory)\b/i;

// Structure that survives unit assembly but is not guidance.
const SKIP = [
  /^\s*\d+\.\s*$/,      // bare list markers
  /^\s*\|/,             // table rows
];

function stripMarkdown(line) {
  return line
    .replace(/^\s*[-*+]\s+/, "")           // list bullet
    .replace(/^\s*\d+\.\s+/, "")           // ordered bullet
    .replace(/\[([^\]]+)\]\([^)]*\)/g, "$1") // links → their text
    // Backticks and asterisks only. Underscores are emphasis in markdown but
    // are also part of identifiers, and a conventions feature that turns
    // `request_id` into "requestid" is worse than no formatting cleanup.
    .replace(/[*`]/g, "")
    .replace(/\s+/g, " ")
    .trim();
}

function usableStatement(raw) {
  if (SKIP.some((re) => re.test(raw))) return null;
  const text = stripMarkdown(raw);
  if (text.length < MIN_LENGTH || text.length > MAX_LENGTH) return null;
  if (!NORMATIVE.test(text)) return null;
  // A statement carrying a secret-shaped value never enters the store, the
  // same bar `devteam patterns promote` applies to operator-authored text.
  if (scanContent(text).length > 0) return null;
  return text;
}

function readSource(cwd, rel) {
  const file = path.join(cwd, rel);
  try {
    const stat = fs.lstatSync(file);
    if (!stat.isFile() || stat.isSymbolicLink() || stat.size > MAX_FILE_BYTES) return null;
    return fs.readFileSync(file, "utf8");
  } catch {
    return null;
  }
}

// Markdown wraps prose across lines, so a per-line scan produces fragments
// ("that should not require a Stagecraft fork."). Rebuild logical units first:
// a bullet plus its indented continuations, or a paragraph, terminated by a
// blank line, a new bullet, a heading, or a fence.
function logicalUnits(content) {
  const units = [];
  let buffer = [];
  let inFence = false;
  const flush = () => {
    if (buffer.length > 0) units.push(buffer.join(" "));
    buffer = [];
  };
  for (const raw of content.split(/\r?\n/)) {
    if (/^\s*```/.test(raw)) { flush(); inFence = !inFence; continue; }
    if (inFence) continue;
    if (!raw.trim()) { flush(); continue; }
    if (/^#{1,6}\s/.test(raw) || /^\s*[|>]/.test(raw)) { flush(); continue; }
    const startsItem = /^\s*([-*+]|\d+\.)\s+/.test(raw);
    if (startsItem) flush();
    buffer.push(raw.trim());
  }
  flush();
  return units;
}

// Extract normative statements from a project's own convention documents.
// Returns [{ text, source }] — `source` is the repo-relative file, so a
// reviewer can see where a proposal came from before promoting it.
function extractConventions(cwd, opts = {}) {
  const sources = Array.isArray(opts.sources) && opts.sources.length > 0 ? opts.sources : SOURCE_FILES;
  const limit = Number.isInteger(opts.limit) && opts.limit > 0 ? opts.limit : MAX_STATEMENTS;
  const seen = new Set();
  const found = [];
  for (const rel of sources) {
    const content = readSource(cwd, rel);
    if (content === null) continue;
    for (const raw of logicalUnits(content)) {
      if (found.length >= limit) return found;
      const text = usableStatement(raw);
      if (!text) continue;
      const key = text.toLowerCase();
      if (seen.has(key)) continue; // the same rule restated in two documents
      seen.add(key);
      found.push({ text, source: rel.split(path.sep).join("/") });
    }
  }
  return found;
}

module.exports = {
  SOURCE_FILES,
  MAX_STATEMENTS,
  MIN_LENGTH,
  MAX_LENGTH,
  extractConventions,
};
