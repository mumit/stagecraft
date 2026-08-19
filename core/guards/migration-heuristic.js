#!/usr/bin/env node
// migration-heuristic.js — does this diff touch the data layer?
//
// Same shape as security-heuristic.js. Returns the list of changed
// files matching common data-layer patterns. Stage 4a (pre-review)
// runs this and sets `migration_safety_required: true` in its gate
// when matches are found; that triggers the conditional `stage-04d`
// (migration safety) review.
//
// Patterns cover:
//   - Migration directory conventions across major ORMs
//   - Schema definition files
//   - File names suggesting DDL or schema changes
// AND DDL-content scanning (ALTER TABLE / CREATE TABLE / DROP TABLE)
// when given file CONTENTS (matchContent) rather than just paths.

const fs = require("node:fs");
const path = require("node:path");
const { readChangedContent } = require("./changed-content");

// Path-pattern matches. Conservative — false positives here cost a
// stage-04d review run, false negatives skip safety on a real
// migration. Bias toward firing.
const PATH_PATTERNS = [
  /(^|\/)migrations?\//i,           // migrations/  /  src/migrations/  /  db/migrations/
  /(^|\/)db\//i,                    // db/
  /(^|\/)database\//i,              // database/
  /(^|\/)prisma\/(schema\.prisma|migrations)/i,  // Prisma
  /(^|\/)schema\.(sql|prisma|rb|graphql)$/i,     // schema files
  /alembic\.ini$/i,                 // SQLAlchemy/Alembic
  /knexfile\./i,                    // Knex
  /(^|\/)ddl\//i,                   // bare DDL dirs
  /(^|\/)sequelize\//i,             // Sequelize migrations dir
  /\.sql$/i,                        // any .sql file in the diff
  /(^|\/)migrate(\.|\/|$)/i,        // CLI / module entries
];

// DDL-content patterns. Only invoked if file contents are provided
// (via matchContent below). The same file might be JavaScript or TS
// that *contains* a CREATE TABLE — we want those flagged too.
const DDL_PATTERNS = [
  /\bALTER\s+TABLE\b/i,
  /\bCREATE\s+TABLE\b/i,
  /\bDROP\s+TABLE\b/i,
  /\bADD\s+COLUMN\b/i,
  /\bDROP\s+COLUMN\b/i,
  /\bRENAME\s+(TABLE|COLUMN)\b/i,
  /\bCREATE\s+(UNIQUE\s+)?INDEX\b/i,
  /\bDROP\s+INDEX\b/i,
];

function changedPathsFromArgs(args) {
  if (args.length > 0) return args;
  const diffFile = path.join(process.cwd(), "pipeline", "changed-files.txt");
  if (!fs.existsSync(diffFile)) return [];
  return fs.readFileSync(diffFile, "utf8").split(/\r?\n/).filter(Boolean);
}

// Returns the subset of paths matching the data-layer path patterns.
// Pure — no filesystem reads, no content scan. Use this for the
// fast path (stage-04a's heuristic only needs path-level matching).
function needsMigrationSafety(paths, patterns = PATH_PATTERNS) {
  return paths.filter((filePath) => patterns.some((pattern) => pattern.test(filePath)));
}

// Optional deeper check: scan file contents for DDL fragments. Use
// when the caller has the diff and wants to catch DDL hidden inside
// non-obvious paths (.ts files, fixture files, etc.). Returns the
// list of files whose CONTENT matched a DDL pattern.
function matchContent(files, readFn = readChangedContent) {
  const matches = [];
  for (const f of files) {
    let body;
    try { body = readFn(f); } catch { continue; }
    if (typeof body !== "string") continue;
    if (DDL_PATTERNS.some((p) => p.test(body))) matches.push(f);
  }
  return matches;
}

function main() {
  const paths = changedPathsFromArgs(process.argv.slice(2));
  const pathMatches = needsMigrationSafety(paths);

  // If the caller passed paths AND those paths exist, optionally
  // content-scan the non-path-matching ones for DDL inside.
  const remaining = paths.filter((p) => !pathMatches.includes(p));
  const ddlMatches = matchContent(remaining);

  const all = [...pathMatches, ...ddlMatches];

  if (all.length === 0) {
    console.log("MIGRATION_SAFETY: skip");
    return 0;
  }

  console.log("MIGRATION_SAFETY: required");
  for (const match of pathMatches) console.log(`- path: ${match}`);
  for (const match of ddlMatches) console.log(`- ddl-in-file: ${match}`);
  return 2;
}

if (require.main === module) {
  process.exit(main());
}

module.exports = { needsMigrationSafety, matchContent, PATH_PATTERNS, DDL_PATTERNS };
