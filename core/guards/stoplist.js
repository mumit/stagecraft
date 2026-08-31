#!/usr/bin/env node

// Safety stoplist — categories of changes that must use the full track
// (--track full) regardless of size or area. Defined in
// .devteam/rules/pipeline.md Stage 0. The lighter tracks (quick, nano,
// config-only, dep-update, loop) must not be used to bypass this list, so
// devteam calls checkStoplist() before scaffolding any lighter-track run
// and refuses if a pattern matches.
//
// Patterns intentionally err toward false positives. Users with a genuine
// false positive can pass --force.

const fs = require("node:fs");
const crypto = require("node:crypto");
const path = require("node:path");
const { spawnSync } = require("node:child_process");
const { pipelineRoot } = require("../paths");

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

// Read the active run's brief so the pre-build check catches sensitive topics
// added by requirements in both in-place and feature-bounded runs.
function pipelineBrief(cwd, changeId = null) {
  const filePath = path.join(pipelineRoot(cwd, changeId), "brief.md");
  if (!fs.existsSync(filePath)) return "";
  try { return fs.readFileSync(filePath, "utf8"); } catch { return ""; }
}

// Collect every string we want to scan for stoplist patterns: the user's
// change description, pipeline/brief.md (written by requirements), any paths
// git or the pipeline knows about.
// Each candidate carries where it came from. The refusal used to quote the
// matched line and stop there, which is not enough to act on: the same
// sentence can be the change you just described or a brief left behind by a
// change that finished a week ago, and those want opposite responses. Under
// the default in-place isolation one brief serves every change, so a completed
// change's prose keeps gating lighter tracks until someone works out which
// artifact is responsible -- and nothing on screen said which. See issue #489.
const BRIEF_SOURCE = "pipeline/brief.md";

function gatherCandidates({ description, cwd, changeId = null }) {
  const list = [];
  if (description) list.push({ text: description, from: "the change description" });
  const brief = pipelineBrief(cwd, changeId);
  if (brief) list.push({ text: brief, from: BRIEF_SOURCE });
  for (const file of gitChangedFiles(cwd)) {
    list.push({ text: file, from: "a changed file path" });
  }
  for (const file of pipelineChangedFiles(cwd)) {
    list.push({ text: file, from: "pipeline/changed-files.txt" });
  }
  return list;
}

// Negation cues that, when they appear anywhere in the SAME sentence as a
// matched keyword, mean the sentence is explicitly excluding the topic
// rather than introducing it — e.g. "It does not include authentication,
// persistent storage, ..." (cue before the keyword) or "Payments
// integration is out of scope for this change." (cue after the keyword).
// A real hello-world-codex-loop brief triggered the stoplist purely because
// its own out-of-scope paragraph named "authentication" while disclaiming
// it. Patterns still intentionally err toward false positives for anything
// NOT explicitly negated this way.
const NEGATION_RE = /\b(no|not|n't|without|except|excludes?|excluding|out[-\s]of[-\s]scope|not[-\s]in[-\s]scope|never)\b/i;

// True when `matchIndex` in `str` falls in a sentence whose full text
// (start of sentence through end of sentence, not just up to the match)
// contains a negation cue — the cue can precede or follow the keyword.
function isNegatedAt(str, matchIndex) {
  const before = str.slice(0, matchIndex);
  const sentenceStart = Math.max(
    before.lastIndexOf(". "), before.lastIndexOf("! "),
    before.lastIndexOf("? "), before.lastIndexOf("\n"),
  );
  const after = str.slice(matchIndex);
  const relEnd = after.search(/[.!?]\s|\n|$/);
  const sentenceEnd = matchIndex + (relEnd === -1 ? after.length : relEnd);
  const sentence = str.slice(sentenceStart + 1, sentenceEnd);
  return NEGATION_RE.test(sentence);
}

// Find every (string, pattern) pair that matches. Returns a deduplicated
// array of { name, re, matched } objects, where matched is the first
// non-negated substring that triggered the pattern (a pattern that only
// ever appears negated in a string produces no match for that string).
// Accepts either a bare string or { text, from }. Both shapes are supported
// deliberately: this is exported and called directly with plain strings, and
// requiring every caller to change in order to improve one message would be
// the wrong trade.
function findStoplistMatches(strings, patterns = STOPLIST_PATTERNS) {
  const seen = new Set();
  const matches = [];
  for (const candidate of strings) {
    const str = typeof candidate === "string" ? candidate : (candidate && candidate.text);
    const from = (candidate && typeof candidate === "object" && candidate.from) || null;
    if (typeof str !== "string" || str.length === 0) continue;
    for (const pattern of patterns) {
      const flags = pattern.re.flags.includes("g") ? pattern.re.flags : pattern.re.flags + "g";
      const globalRe = new RegExp(pattern.re.source, flags);
      let m;
      let found = null;
      while ((m = globalRe.exec(str)) !== null) {
        if (!isNegatedAt(str, m.index)) { found = m; break; }
        if (m.index === globalRe.lastIndex) globalRe.lastIndex++; // guard against zero-length matches
      }
      if (!found) continue;
      const key = `${pattern.name}:${found[0].toLowerCase()}`;
      if (seen.has(key)) continue;
      seen.add(key);
      matches.push({ name: pattern.name, re: pattern.re, matched: found[0], source: str, from });
    }
  }
  return matches;
}

// Convenience entry point used by devteam. Returns an array of
// matches; an empty array means the lighter track is permissible.
function checkStoplist({ description, cwd, changeId = null } = {}) {
  const candidates = gatherCandidates({
    description,
    cwd: cwd || process.cwd(),
    changeId,
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
  lines.push("This change matches the safety stoplist. Re-run with --track full instead.");
  lines.push("Reasons:");
  for (const m of matches) {
    const where = m.from ? ` in ${m.from}` : "";
    lines.push(`  - ${m.name}: matched "${m.matched}"${where}:`);
    lines.push(`      ${matchingLine(m.source, m.matched)}`);
  }
  // Only when a brief is actually responsible. Under the default in-place
  // isolation one brief serves every change, so the usual cause is a brief left
  // behind by a change that already finished -- and archiving it is ordinary
  // housekeeping, not a bypass of the guard. Naming --force for that case would
  // teach operators to disable a safety check to clear stale state.
  if (matches.some((m) => m.from === BRIEF_SOURCE)) {
    lines.push("");
    lines.push(`If that ${BRIEF_SOURCE} belongs to a change you have already finished, it is`);
    lines.push("stale and still being scanned. Archive it and re-run:");
    lines.push(`  mv ${BRIEF_SOURCE} pipeline/archive/`);
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

function stoplistPolicyFingerprint() {
  const policy = {
    patterns: STOPLIST_PATTERNS.map(({ name, re }) => ({ name, source: re.source, flags: re.flags })),
    tracks: [...STOPLIST_TRACKS].sort(),
    negation: { source: NEGATION_RE.source, flags: NEGATION_RE.flags },
  };
  return crypto.createHash("sha256").update(JSON.stringify(policy)).digest("hex");
}

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
  stoplistPolicyFingerprint,
};
