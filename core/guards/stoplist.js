#!/usr/bin/env node

// Safety stoplist — categories of changes that must use the full /pipeline
// track regardless of size or area. Defined in .devteam/rules/pipeline.md
// Stage 0. The lighter tracks (/quick, /nano, /config-only, /dep-update)
// must not be used to bypass this list, so devteam calls
// checkStoplist() before scaffolding any lighter-track run and refuses if a
// pattern matches.
//
// Patterns intentionally err toward false positives. Users with a genuine
// false positive can pass --force.

const fs = require("node:fs");
const path = require("node:path");
const { spawnSync } = require("node:child_process");

const STOPLIST_PATTERNS = [
  {
    name: "authentication",
    re: /\b(auth|authn|authz|authentication|authorization|login|logout|signin|signup|signout|oauth|jwt|sso|session)\b/i,
  },
  {
    name: "credentials",
    re: /\b(password|passwd|secret|credential|api[-_\s]?key|bearer[-_\s]?token)\b/i,
  },
  {
    name: "cryptography",
    re: /\b(crypto\w*|encrypt\w*|decrypt\w*|cipher\w*|hmac|hash(?:ing|ed)?)\b/i,
  },
  {
    name: "pii-and-regulated-data",
    re: /\b(pii|gdpr|ccpa|hipaa|pci(?:[-_\s]?dss)?|ssn)\b/i,
  },
  {
    name: "payments",
    re: /\b(payment\w*|billing|credit[-_\s]?card)\b/i,
  },
  {
    name: "migrations",
    re: /\b(migration|migrations|migrate|schema[-_\s]?change|alter[-_\s]+table|drop[-_\s]+(?:table|column))\b/i,
  },
  {
    name: "feature-flags",
    re: /\b(feature[-_\s]?flag|feature[-_\s]?toggle|growthbook|launchdarkly|optimizely)\b/i,
  },
];

// Run `git diff --name-only HEAD` in the given cwd. Returns an array of
// changed-file paths, or [] if the directory is not a git repository.
function gitChangedFiles(cwd) {
  const result = spawnSync("git", ["diff", "--name-only", "HEAD"], {
    cwd,
    encoding: "utf8",
  });
  if (!result || result.status !== 0) return [];
  return result.stdout.split(/\r?\n/).filter(Boolean);
}

// Read pipeline/changed-files.txt if present.
// B9 exemption: changed-files.txt is a git-diff artifact written at the global
// pipeline/ level regardless of isolation mode — it describes the changeset, not
// a bounded artifact.
function pipelineChangedFiles(cwd) {
  const filePath = path.join(cwd, "pipeline", "changed-files.txt");
  if (!fs.existsSync(filePath)) return [];
  return fs.readFileSync(filePath, "utf8").split(/\r?\n/).filter(Boolean);
}

// Read pipeline/brief.md if present, so the pre-build check in the autonomous
// driver catches sensitive topics added by the requirements agent (Phase 1 § 1.1).
// B9 exemption: the stoplist check in the driver always uses cwd (the project root)
// and reads the in-place brief.md. In bounded mode the brief would be at
// pipeline/changes/<id>/brief.md; this is a known limitation — the driver's
// runStoplistCheck can be extended to pass changeId when this matters in practice.
function pipelineBrief(cwd) {
  const filePath = path.join(cwd, "pipeline", "brief.md");
  if (!fs.existsSync(filePath)) return "";
  try { return fs.readFileSync(filePath, "utf8"); } catch { return ""; }
}

// Collect every string we want to scan for stoplist patterns: the user's
// change description, pipeline/brief.md (written by requirements), any paths
// git or the pipeline knows about.
function gatherCandidates({ description, cwd }) {
  const list = [];
  if (description) list.push(description);
  const brief = pipelineBrief(cwd);
  if (brief) list.push(brief);
  list.push(...gitChangedFiles(cwd));
  list.push(...pipelineChangedFiles(cwd));
  return list;
}

// Find every (string, pattern) pair that matches. Returns a deduplicated
// array of { name, re, matched } objects, where matched is the first
// substring that triggered the pattern.
function findStoplistMatches(strings, patterns = STOPLIST_PATTERNS) {
  const seen = new Set();
  const matches = [];
  for (const str of strings) {
    if (typeof str !== "string" || str.length === 0) continue;
    for (const pattern of patterns) {
      const m = str.match(pattern.re);
      if (!m) continue;
      const key = `${pattern.name}:${m[0].toLowerCase()}`;
      if (seen.has(key)) continue;
      seen.add(key);
      matches.push({ name: pattern.name, re: pattern.re, matched: m[0], source: str });
    }
  }
  return matches;
}

// Convenience entry point used by devteam. Returns an array of
// matches; an empty array means the lighter track is permissible.
function checkStoplist({ description, cwd } = {}) {
  const candidates = gatherCandidates({
    description,
    cwd: cwd || process.cwd(),
  });
  return findStoplistMatches(candidates);
}

// Extract the line from source that contains the matched token.
function matchingLine(source, matched) {
  const line = source.split(/\r?\n/).find((l) => l.includes(matched)) || source.slice(0, 120);
  return line.length > 120 ? line.slice(0, 117) + "…" : line;
}

// Format matches for display to the user. Returns a multi-line string.
function explainMatches(matches) {
  const lines = [];
  lines.push("This change matches the safety stoplist. Use /pipeline instead.");
  lines.push("Reasons:");
  for (const m of matches) {
    lines.push(`  - ${m.name}: matched "${m.matched}" in: ${matchingLine(m.source, m.matched)}`);
  }
  lines.push("");
  lines.push("If this is a false positive, re-run with --force to bypass.");
  lines.push("Stoplist defined in .devteam/rules/pipeline.md §Stage 0.");
  return lines.join("\n");
}

// Tracks where the stoplist applies. Full and hotfix bypass the stoplist by
// design: full runs the complete pipeline anyway (its own safety story); hotfix
// has a tightly-scoped, manually-reviewed path. Lighter tracks must clear the
// stoplist unless --force is passed. `loop` (29.1) is the lightest track of
// all — the consequence ceiling applies to it exactly like the other lighter
// tracks, so it's guarded here too.
// Single source of truth — imported by both bin/devteam (interactive path) and
// core/driver.js (autonomous path) so both enforce the same set. (Phase 1 § 1.1)
const STOPLIST_TRACKS = new Set(["quick", "nano", "config-only", "dep-update", "loop"]);

if (require.main === module) {
  const description = process.argv.slice(2).filter((a) => a !== "--force").join(" ");
  const matches = checkStoplist({ description, cwd: process.cwd() });
  if (matches.length > 0) {
    console.error(explainMatches(matches));
    process.exit(2);
  }
  console.log("STOPLIST: clear");
  process.exit(0);
}

module.exports = {
  STOPLIST_PATTERNS,
  STOPLIST_TRACKS,
  gatherCandidates,
  findStoplistMatches,
  checkStoplist,
  explainMatches,
};
