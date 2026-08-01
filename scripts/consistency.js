#!/usr/bin/env node
// consistency.js — standalone cross-artifact lint.
//
// Runs checks that catch drift between stages.js, schemas, role briefs,
// rules docs, and adapters. Exits 0 if clean, 1 if any failures.
//
// Most of these checks also live in tests/contract.test.js — having
// them here too means a developer can spot-check without running
// the full test suite, and CI can fail fast on cross-artifact drift.
//
// Usage:
//   node scripts/consistency.js               # run all checks (with baseline)
//   node scripts/consistency.js --json        # machine-readable output
//   node scripts/consistency.js --no-baseline # show raw violations (no suppression)
//
// Baseline mode (2.1):
//   scripts/consistency-baseline.json lists known prose-vs-code violations
//   that pre-date the checker. Baselined findings are reported but do NOT
//   fail the run. Item 2.2 burns the baseline down; once it's empty the file
//   is deleted and the checker runs fully un-baselined.
//
// Baseline entry keys are stable across runs (file + checkClass + identifier)
// so unrelated edits don't churn the baseline.

"use strict";

const fs = require("node:fs");
const path = require("node:path");
const { spawnSync } = require("node:child_process");

const REPO_ROOT = path.resolve(__dirname, "..");
const { STAGES, TRACKS, STAGES_BY_TRACK, ORDERED_STAGE_NAMES, stageNames, FOLD_ONLY_STAGES } =
  require(path.join(REPO_ROOT, "core", "pipeline", "stages"));
const { listHosts, loadAdapter } = require(path.join(REPO_ROOT, "core", "router"));

// ---------------------------------------------------------------------------
// Failure collection — prose-vs-code checks use a separate array so baseline
// logic can handle them independently from the core contract checks.
// ---------------------------------------------------------------------------

const failures = [];
const passes = [];
// Prose-vs-code violations (subject to baseline suppression)
const proseViolations = [];
// Baselined violations reported as informational
const baselined = [];
// Advisories — non-blocking; printed but do not increment failure count.
const advisories = [];

function pass(name) { passes.push(name); }
function fail(name, detail) { failures.push({ name, detail }); }
function advisory(name, detail) { advisories.push({ name, detail }); }

// Record a prose-vs-code violation.
// checkClass: string identifying the check (e.g. "gate-filename").
// file: root-relative path to the file.
// line: 1-based line number (0 = file-level).
// detail: human-readable description.
// key: stable identifier for baseline matching (must NOT contain line number alone).
function proseViolation(checkClass, file, line, detail, key) {
  proseViolations.push({ checkClass, file, line, detail, key });
}

function exists(rel) { return fs.existsSync(path.join(REPO_ROOT, rel)); }
function readJSON(rel) { return JSON.parse(fs.readFileSync(path.join(REPO_ROOT, rel), "utf8")); }
function listDir(rel) { return fs.readdirSync(path.join(REPO_ROOT, rel)); }

// ---------------------------------------------------------------------------
// Baseline support (2.1): baseline lives in scripts/consistency-baseline.json.
// Each entry is a stable key string. Keyed on file+class+identifier so line
// number changes from unrelated edits do not churn the baseline.
// ---------------------------------------------------------------------------

const BASELINE_PATH = path.join(__dirname, "consistency-baseline.json");

function loadBaseline() {
  // CONSISTENCY_BASELINE_FILE env var overrides the default path.
  // Used in fixture-tree tests so they can inject a known-small baseline
  // without touching the real repo baseline file.
  const filePath = process.env.CONSISTENCY_BASELINE_FILE || BASELINE_PATH;
  if (!fs.existsSync(filePath)) return new Set();
  try {
    const raw = JSON.parse(fs.readFileSync(filePath, "utf8"));
    if (Array.isArray(raw)) return new Set(raw);
    if (raw && Array.isArray(raw.entries)) return new Set(raw.entries);
    return new Set();
  } catch { return new Set(); }
}

// ---------------------------------------------------------------------------
// Git-aware file enumeration (7.1)
//
// When a scan root has .git, we use `git ls-files -z` so only committed
// (tracked) files participate in blocking checks. Untracked-but-not-ignored
// files produce advisories instead of failures — a scratch file must not
// fail the lint. When .git is absent (fixture-tree mode), plain readdir is
// used unchanged.
// ---------------------------------------------------------------------------

function gitTrackedFiles(root) {
  if (!fs.existsSync(path.join(root, ".git"))) return null;
  const r = spawnSync("git", ["ls-files", "-z", "--full-name"], {
    cwd: root, encoding: "buffer", timeout: 10000,
  });
  if (r.status !== 0) return null;
  return new Set(r.stdout.toString("utf8").split("\0").filter(Boolean));
}

// ---------------------------------------------------------------------------
// Scan utilities
// ---------------------------------------------------------------------------

// Excluded relative dir suffixes. Applied relative to any scanRoot, not just
// REPO_ROOT, so fixture-tree tests work correctly.
const EXCLUDED_RELATIVE = [
  path.join("docs", "historical"),
  path.join("docs", "audit-archive"),
];

function isExcluded(absPath, scanRoot) {
  for (const rel of EXCLUDED_RELATIVE) {
    const ex = path.join(scanRoot, rel);
    if (absPath === ex || absPath.startsWith(ex + path.sep)) return true;
  }
  return false;
}

// Recursively scan a directory for .md files matching `re`.
// trackedSet: when non-null (git-aware mode), only process tracked files.
// Returns array of { file (relative to scanRoot), line, text, match }.
function scanDirRec(absDir, re, scanRoot, results, trackedSet) {
  let entries;
  try { entries = fs.readdirSync(absDir, { withFileTypes: true }); } catch { return; }
  for (const e of entries) {
    const abs = path.join(absDir, e.name);
    if (isExcluded(abs, scanRoot)) continue;
    if (e.isDirectory()) { scanDirRec(abs, re, scanRoot, results, trackedSet); continue; }
    if (!e.name.endsWith(".md")) continue;
    const rel = path.relative(scanRoot, abs).replace(/\\/g, "/");
    if (trackedSet !== null && !trackedSet.has(rel)) continue; // skip untracked
    let content;
    try { content = fs.readFileSync(abs, "utf8"); } catch { continue; }
    const lines = content.split(/\r?\n/);
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i];
      const r = new RegExp(re.source, re.flags.includes("g") ? re.flags : re.flags + "g");
      r.lastIndex = 0;
      let m;
      while ((m = r.exec(line)) !== null) {
        results.push({ file: rel, line: i + 1, text: line.trim(), match: m });
      }
    }
  }
}

// Scan relative dir names (joined with scanRoot) for matching .md content.
// scanRoot defaults to REPO_ROOT. Returns { file, line, text, match } array.
// trackedSet: when non-null (git-aware mode), only process tracked files.
function scanDirs(relDirs, re, scanRoot, trackedSet) {
  const root = scanRoot || REPO_ROOT;
  const results = [];
  for (const d of relDirs) {
    const absDir = path.join(root, d);
    if (!fs.existsSync(absDir)) continue;
    scanDirRec(absDir, re, root, results, trackedSet !== undefined ? trackedSet : null);
  }
  return results;
}

// ---------------------------------------------------------------------------
// Checks — original contract checks (preserved unchanged)
// ---------------------------------------------------------------------------

function checkStagesToSchemas() {
  for (const [name, def] of Object.entries(STAGES)) {
    if (!def) continue;
    const rel = `core/gates/schemas/${def.stage}.schema.json`;
    if (exists(rel)) pass(`stage "${name}" has schema ${rel}`);
    else fail(`stage "${name}"`, `missing schema at ${rel}`);
  }
}

function checkSchemasToStages() {
  const stageIds = new Set(Object.values(STAGES).filter(Boolean).map((d) => d.stage));
  for (const f of listDir("core/gates/schemas")) {
    if (!f.startsWith("stage-") || !f.endsWith(".schema.json")) continue;
    const id = f.replace(".schema.json", "");
    if (stageIds.has(id)) pass(`schema ${f} has matching stage`);
    else fail(`schema ${f}`, "no matching entry in STAGES");
  }
}

function checkStagesToRoles() {
  const seen = new Set();
  for (const def of Object.values(STAGES)) {
    if (!def) continue;
    for (const role of def.roles) seen.add(role);
  }
  for (const role of seen) {
    if (exists(`roles/${role}.md`)) pass(`role "${role}" has brief`);
    else fail(`role "${role}"`, `missing brief at roles/${role}.md`);
  }
}

function checkRoleWritesValid() {
  for (const [name, def] of Object.entries(STAGES)) {
    if (!def || !def.roleWrites) continue;
    for (const role of Object.keys(def.roleWrites)) {
      if (def.roles.includes(role)) {
        pass(`stage "${name}" roleWrites["${role}"] valid`);
      } else {
        fail(`stage "${name}" roleWrites`, `role "${role}" not in roles[${def.roles.join(", ")}]`);
      }
    }
  }
}

function checkSubagentOverrides() {
  for (const [name, def] of Object.entries(STAGES)) {
    if (!def || !def.subagent) continue;
    if (exists(`roles/${def.subagent}.md`)) {
      pass(`stage "${name}" subagent override "${def.subagent}" has brief`);
    } else {
      fail(`stage "${name}" subagent`, `override "${def.subagent}" has no brief at roles/${def.subagent}.md`);
    }
  }
}

function checkTracksReferenceKnownStages() {
  for (const [track, names] of Object.entries(STAGES_BY_TRACK)) {
    for (const n of names) {
      if (STAGES[n]) pass(`track "${track}" stage "${n}"`);
      else fail(`track "${track}"`, `lists unknown stage "${n}"`);
    }
  }
}

function checkOrderedStageNamesCoversAll() {
  // Mechanical stages (roles: []) are auto-run by the orchestrator as
  // pre-steps of other stages, not dispatched by `devteam next`. They
  // register in STAGES so their schemas are known but do NOT appear in
  // ORDERED_STAGE_NAMES or any track list.
  const mechanicalStages = new Set(
    Object.entries(STAGES)
      .filter(([, def]) => def && Array.isArray(def.roles) && def.roles.length === 0)
      .map(([name]) => name)
  );
  // 29.4: fold-only stages (e.g. "verification-sweep") exist solely as the
  // combined output of a compact_qa track's fold — they never appear on
  // "full", so they're excluded from this invariant the same way mechanical
  // stages are.
  const foldOnlyStages = new Set(FOLD_ONLY_STAGES);

  const stageSet = new Set(stageNames());
  const orderedSet = new Set(ORDERED_STAGE_NAMES);
  for (const n of stageSet) {
    if (mechanicalStages.has(n)) {
      pass(`ORDERED_STAGE_NAMES correctly omits mechanical stage "${n}"`);
    } else if (foldOnlyStages.has(n)) {
      pass(`ORDERED_STAGE_NAMES correctly omits fold-only stage "${n}"`);
    } else if (orderedSet.has(n)) {
      pass(`ORDERED_STAGE_NAMES contains "${n}"`);
    } else {
      fail(`ORDERED_STAGE_NAMES`, `missing stage "${n}"`);
    }
  }
  for (const n of orderedSet) {
    if (stageSet.has(n)) pass(`STAGES has "${n}" (referenced in ORDERED_STAGE_NAMES)`);
    else fail(`ORDERED_STAGE_NAMES`, `references unknown stage "${n}"`);
  }
}

function checkAdaptersExportContract() {
  const required = ["install", "renderStagePrompt", "status", "uninstall"];
  for (const h of listHosts()) {
    const adapter = loadAdapter(h);
    if (!adapter.capabilities) {
      fail(`adapter "${h}"`, "missing capabilities");
      continue;
    }
    if (adapter.capabilities.name !== h) {
      fail(`adapter "${h}"`, `capabilities.name mismatch (got "${adapter.capabilities.name}")`);
    }
    for (const m of required) {
      if (typeof adapter[m] === "function") pass(`adapter "${h}" exports ${m}()`);
      else fail(`adapter "${h}"`, `missing ${m}() function`);
    }
    if (adapter.capabilities.headless && typeof adapter.invoke !== "function") {
      fail(`adapter "${h}"`, "declares headless: true but no invoke()");
    } else if (adapter.capabilities.headless) {
      pass(`adapter "${h}" exports invoke() (headless: true)`);
    }
  }
}

function checkRequiredRulesPresent() {
  const required = ["gates.md", "gates-core.md", "pipeline.md", "escalation.md", "retrospective.md", "orchestrator.md"];
  for (const r of required) {
    if (exists(`rules/${r}`)) pass(`rules/${r} present`);
    else fail(`rules/${r}`, "missing");
  }
}

function checkSchemaIdsAndDraft() {
  for (const f of listDir("core/gates/schemas")) {
    if (!f.endsWith(".schema.json")) continue;
    const s = readJSON(`core/gates/schemas/${f}`);
    if (s.$schema === "https://json-schema.org/draft/2020-12/schema") pass(`${f} draft 2020-12`);
    else fail(f, `wrong $schema: ${s.$schema}`);
    if (s.$id && /^urn:stagecraft:schema:/.test(s.$id)) pass(`${f} $id is urn:stagecraft:schema:*`);
    else fail(f, `wrong $id: ${s.$id}`);
  }
}

function checkGateBaseSchemaIdentity() {
  const base = readJSON("core/gates/schemas/gate.schema.json");
  const expected = ["stage", "status", "orchestrator", "track", "timestamp", "blockers", "warnings"];
  for (const f of expected) {
    if (base.required.includes(f)) pass(`gate.schema requires "${f}"`);
    else fail("gate.schema", `missing required field "${f}"`);
  }
  if (base.required.includes("agent")) fail("gate.schema", "still requires legacy 'agent' field — should be removed");
  else pass("gate.schema does not require legacy 'agent'");
}

function checkAuditFeatureIntegrity() {
  const requiredFiles = [
    "skills/audit/SKILL.md",
    "roles/auditor.md",
    "hosts/claude-code/install/commands/audit.md",
    "hosts/claude-code/install/commands/audit-quick.md",
  ];
  for (const rel of requiredFiles) {
    if (exists(rel)) pass(`audit: ${rel} exists`);
    else fail("audit", `missing ${rel}`);
  }
  const phases = [
    "00-project-context", "01-architecture", "02-git-history",
    "03-compliance", "04-tests", "05-documentation",
    "06-security", "07-performance", "08-code-quality",
    "09-backlog", "10-roadmap",
  ];
  for (const phase of phases) {
    const rel = `templates/audit/${phase}-template.md`;
    if (exists(rel)) pass(`audit template: ${phase}-template.md exists`);
    else fail("audit", `missing template templates/audit/${phase}-template.md`);
  }
}

// ---------------------------------------------------------------------------
// Prose-vs-code checks (new in 2.1) — six check classes
// ---------------------------------------------------------------------------

// --- Check 1: Gate filename references ---
//
// Canonical gate filename formats (derived from approval-derivation.js:217):
//   Stage gate:           stage-NN[x].json
//   Workstream gate:      stage-NN[x].<area>.json      (DOT-separated)
//   Fanout gate:          stage-NN[x].<area>.<host>.json
//
// Violations: dash-separated forms like stage-04-backend.json (wrong separator),
// or gate names referencing non-canonical stage IDs.
//
// Scan: rules/, roles/, docs/runbooks/, skills/
function checkGateFilenameReferences(scanRoot, trackedSet) {
  const root = scanRoot || REPO_ROOT;
  const scanRelDirs = ["rules", "roles", "docs/runbooks", "skills"];

  // Match gate filename patterns anywhere in a line (inside paths, backticks, etc.).
  // Linear pattern: stage-NNx followed by a separator (- or .) and a non-empty
  // alphanumeric segment ending in .json.
  // Must NOT use catastrophic backtracking — use a simple non-quantifier-stacked form.
  // Matches: stage-04-backend.json, stage-04.backend.json, stage-05.area.host.json
  const gateRefRe = /(stage-\d+[a-z]?[-.][\w][\w.,-]*\.json)/gi;

  const canonicalStageIds = new Set(
    Object.values(STAGES).filter(Boolean).map((d) => d.stage)
  );

  // Also scan for dash-form patterns with template placeholders (stage-04-{area}.json,
  // stage-05-<area>.json) which the main regex doesn't match but are still violations.
  // We match: stage-NNx- followed by a brace/angle placeholder.
  // This is a separate simpler scan so we can skip the placeholder check.
  const dashPlaceholderRe = /(stage-\d+[a-z]?)-(?:\{[^}]+\}|<[^>]+>)\.json/gi;

  const hits = scanDirs(scanRelDirs, gateRefRe, root, trackedSet);
  const placeholderHits = scanDirs(scanRelDirs, dashPlaceholderRe, root, trackedSet);
  const seen = new Set();

  // Check dash-form with placeholders (stage-05-{area}.json)
  for (const hit of placeholderHits) {
    const raw = hit.match[0]; // full match
    // Extract the stage ID part before the dash-area
    const stageMatch = raw.match(/^(stage-\d+[a-z]?)-/i);
    if (!stageMatch) continue;
    const stageId = stageMatch[1].toLowerCase();
    const placeholder = raw.replace(stageId + "-", "").replace(".json", "");
    const corrected = `${stageId}.${placeholder}.json`;
    const key = `gate-filename:${hit.file}:${stageId}-placeholder.json`;
    if (!seen.has(key)) {
      seen.add(key);
      proseViolation("gate-filename", hit.file, hit.line,
        `dash-form gate pattern "${raw.match(/stage-[^}\s]*/)[0]}" — should use dot-separator: "${corrected}" (per approval-derivation.js:217)`,
        key);
    }
  }

  for (const hit of hits) {
    const rawMatch = hit.match[1];
    if (!rawMatch) continue;

    // Skip template placeholders: {area}, <area>, etc. — handled by dashPlaceholderRe above
    if (rawMatch.includes("{") || rawMatch.includes("<") || rawMatch.includes(">")) continue;

    // Extract the core filename (strip any path prefix before stage-)
    const filenameMatch = rawMatch.match(/(stage-\d+[a-z]?[-.][\w.-]*)$/i);
    if (!filenameMatch) continue;
    const fname = filenameMatch[1];
    if (!fname.endsWith(".json")) continue;

    // Dash form (VIOLATION): stage-NNx-area.json
    // Regex: starts with stage-NN[x], then a hyphen, then a word (not a digit run with no letter)
    const dashViolationRe = /^(stage-\d+[a-z]?)-([A-Za-z][\w-]*)\.json$/i;
    // Valid dot form: stage-NNx.something.json
    const validDotRe = /^(stage-\d+[a-z]?)\.[A-Za-z][\w.-]+\.json$/i;
    // Valid bare form: stage-NNx.json
    const validBareRe = /^(stage-\d+[a-z]?)\.json$/i;

    if (dashViolationRe.test(fname)) {
      const m = fname.match(dashViolationRe);
      const stageId = m[1].toLowerCase();
      const area = m[2];
      const key = `gate-filename:${hit.file}:${fname}`;
      if (!seen.has(key)) {
        seen.add(key);
        proseViolation("gate-filename", hit.file, hit.line,
          `dash-form gate name "${fname}" — should be "${stageId}.${area}.json" (dot-separated, per approval-derivation.js:217)`,
          key);
      }
    } else if (validDotRe.test(fname) || validBareRe.test(fname)) {
      const sid = (fname.match(/^(stage-\d+[a-z]?)/i) || [])[1];
      if (sid && !canonicalStageIds.has(sid.toLowerCase())) {
        const key = `gate-filename:${hit.file}:${fname}`;
        if (!seen.has(key)) {
          seen.add(key);
          proseViolation("gate-filename", hit.file, hit.line,
            `gate name "${fname}" references non-canonical stage ID "${sid}"`,
            key);
        }
      }
    }
  }
}

// --- Check 2: Stage-ID existence and N-stage count claims ---
//
// Every `stage-\d+[a-z]?` ID mentioned in prose must exist in STAGES.stage values.
// Canonical IDs are zero-padded (stage-04, stage-04b). Un-padded forms (stage-4)
// are violations. "N-stage" claims must match ORDERED_STAGE_NAMES.length.
//
// Scan: rules/, roles/, docs/, skills/
// Exclusions: docs/historical/, docs/audit-archive/ (wholesale)
function checkStageIdAndCountClaims(scanRoot, trackedSet) {
  const root = scanRoot || REPO_ROOT;
  const scanRelDirs = ["rules", "roles", "docs", "skills"];

  // True non-mechanical stage count per code (item 2.1 spec: derive from code)
  const TRUE_STAGE_COUNT = ORDERED_STAGE_NAMES.length; // currently 18

  const canonicalStageIds = new Set(
    Object.values(STAGES).filter(Boolean).map((d) => d.stage)
  );

  // Stage ID ref pattern. Match `stage-NN` or `stage-NNx` as whole tokens.
  // Avoid matching inside longer identifiers. Case-insensitive for robustness.
  // We capture the full `stage-NNx` token for case-normalised lookup.
  const stageIdRe = /\b(stage-\d+[a-z]?)\b/gi;

  // "N-stage" count claim: "13-stage pipeline", "18-stage workflow", etc.
  const stageCountRe = /\b(\d+)-stage\b/gi;

  const idHits = scanDirs(scanRelDirs, stageIdRe, root, trackedSet);
  const countHits = scanDirs(scanRelDirs, stageCountRe, root, trackedSet);

  const seenId = new Set();
  for (const hit of idHits) {
    const raw = hit.match[1];
    const id = raw.toLowerCase();
    if (!canonicalStageIds.has(id)) {
      // Deduplicate by file+id (same non-canonical ID appearing multiple times in a file)
      const key = `stage-id:${hit.file}:${id}`;
      if (!seenId.has(key)) {
        seenId.add(key);
        proseViolation("stage-id", hit.file, hit.line,
          `"${raw}" not found in STAGES — non-canonical or unknown stage ID (canonical: stage-NN or stage-NNx with zero-padding)`,
          key);
      }
    }
  }

  const seenCount = new Set();
  for (const hit of countHits) {
    const claimed = parseInt(hit.match[1], 10);
    if (claimed !== TRUE_STAGE_COUNT) {
      const key = `stage-count:${hit.file}:${hit.match[0].trim()}`;
      if (!seenCount.has(key)) {
        seenCount.add(key);
        proseViolation("stage-count", hit.file, hit.line,
          `"${hit.match[0].trim()}" disagrees with true stage count (${TRUE_STAGE_COUNT} per ORDERED_STAGE_NAMES)`,
          key);
      }
    }
  }
}

// --- Check 3: Track list claims ---
//
// (a) "N tracks" count claims must match TRACKS.length.
// (b) Enumerated "Valid values:" lists that mention some tracks but omit others.
//
// Scan: rules/, roles/, docs/
function checkTrackListClaims(scanRoot, trackedSet) {
  const root = scanRoot || REPO_ROOT;
  const scanRelDirs = ["rules", "roles", "docs"];
  const TRUE_TRACK_COUNT = TRACKS.length; // currently 6
  const TRACK_SET = new Set(TRACKS);

  // (a) "N tracks" or "Four tracks", "five tracks", etc.
  const trackCountRe = /\b(\d+|[Ff]our|[Ff]ive|[Ss]ix)\s+tracks?\b/g;

  // (b) "valid values: ..." lines or similar that enumerate tracks
  //     We look for lines that list some track names but not all, when at
  //     least two TRACKS names appear in the same sentence/line.
  const validValuesRe = /[Vv]alid(?:\s+values?)?[:\s]+([^\n]{5,})/g;

  // (a) Count claims
  const countHits = scanDirs(scanRelDirs, trackCountRe, root, trackedSet);
  const seenCount = new Set();
  for (const hit of countHits) {
    const raw = hit.match[1];
    let claimed;
    if (/^\d+$/.test(raw)) claimed = parseInt(raw, 10);
    else if (/four/i.test(raw)) claimed = 4;
    else if (/five/i.test(raw)) claimed = 5;
    else if (/six/i.test(raw)) claimed = 6;
    else continue;

    if (claimed !== TRUE_TRACK_COUNT) {
      const key = `track-count:${hit.file}:${hit.match[0].trim()}`;
      if (!seenCount.has(key)) {
        seenCount.add(key);
        proseViolation("track-list", hit.file, hit.line,
          `"${hit.match[0].trim()}" claims ${claimed} tracks but TRACKS has ${TRUE_TRACK_COUNT}: ${TRACKS.join(", ")}`,
          key);
      }
    }
  }

  // (b) Valid-values lists that omit tracks
  const validHits = scanDirs(scanRelDirs, validValuesRe, root, trackedSet);
  for (const hit of validHits) {
    const valueStr = hit.match[1];
    const mentioned = new Set();
    for (const tk of TRACKS) {
      // Check if this track name appears (as word or backtick-quoted token)
      if (new RegExp(`(^|[\\s,\`'"(])${tk}([\\s,\`'")])`, "").test(valueStr) ||
          valueStr.includes("`" + tk + "`")) {
        mentioned.add(tk);
      }
    }
    // Only flag if multiple tracks mentioned but some are missing
    if (mentioned.size >= 2 && mentioned.size < TRACK_SET.size) {
      const missing = TRACKS.filter((t) => !mentioned.has(t));
      const key = `track-list:${hit.file}:missing-${missing.join("+")}:L${hit.line}`;
      proseViolation("track-list", hit.file, hit.line,
        `track list mentions {${[...mentioned].join(", ")}} but omits: ${missing.join(", ")}`,
        key);
    }
  }
}

// --- Check 4: Referenced-file existence ---
//
// Relative path references in rules/roles/skills/runbooks that point to files
// that should exist in the repo must actually exist. We only check paths with
// known-repo prefixes (rules/, roles/, core/, skills/, .devteam/rules/, *.sh).
//
// Target-project runtime paths (pipeline/*) and implementation paths (src/)
// are excluded — they exist in target projects, not this repo.
//
// Scan: rules/, roles/, skills/, docs/runbooks/
function checkReferencedFileExistence(scanRoot, trackedSet) {
  const root = scanRoot || REPO_ROOT;
  const scanRelDirs = ["rules", "roles", "skills", "docs/runbooks"];

  // Backtick-quoted file paths
  const backtickRe = /`([^`\s]+\.(md|sh|json|feature|yml|yaml))`/g;
  // Markdown links to .md files: [text](path.md) or [text](path.md#anchor)
  const mdLinkRe = /\[(?:[^\]]+)\]\(([^)\s]+\.md(?:#[^)]*)?)\)/g;

  // Prefixes that indicate a repo-relative path we can validate
  const REPO_PREFIXES = [
    "rules/", "roles/", "core/", "skills/", "docs/", "hosts/",
    "templates/", "scripts/",
  ];
  // .devteam/ paths: installed copies of rules/ files; validate source exists
  const DEVTEAM_RULES_PREFIX = ".devteam/rules/";

  function shouldCheck(ref) {
    if (!ref) return false;
    if (ref.startsWith("http://") || ref.startsWith("https://")) return false;
    if (ref.startsWith("#")) return false;       // anchor-only
    if (ref.startsWith("pipeline/")) return false; // target-project runtime
    if (ref.startsWith("src/")) return false;    // implementation
    if (ref.includes("{") || ref.includes("<") || ref.includes(">")) return false; // placeholders
    if (ref.startsWith(DEVTEAM_RULES_PREFIX)) return true; // check source path
    if (ref.endsWith(".sh")) return true;
    return REPO_PREFIXES.some((p) => ref.startsWith(p));
  }

  function resolveRef(ref) {
    // .devteam/rules/foo.md → check rules/foo.md (the source)
    if (ref.startsWith(DEVTEAM_RULES_PREFIX)) {
      const sourceRel = ref.replace(DEVTEAM_RULES_PREFIX, "rules/").split("#")[0];
      return sourceRel;
    }
    return ref.split("#")[0];
  }

  const seenViolations = new Set();

  function checkRef(ref, file, lineNum) {
    if (!shouldCheck(ref)) return;
    const checkPath = resolveRef(ref);
    const abs = path.join(root, checkPath);
    if (!fs.existsSync(abs)) {
      const key = `ref-existence:${file}:${checkPath}`;
      if (!seenViolations.has(key)) {
        seenViolations.add(key);
        proseViolation("ref-existence", file, lineNum,
          `references "${ref}" but file does not exist`, key);
      }
    }
  }

  const btHits = scanDirs(scanRelDirs, backtickRe, root, trackedSet);
  for (const hit of btHits) checkRef(hit.match[1], hit.file, hit.line);

  const mdHits = scanDirs(scanRelDirs, mdLinkRe, root, trackedSet);
  for (const hit of mdHits) checkRef(hit.match[1], hit.file, hit.line);
}

// --- Check 5: Command surface ---
//
// (a) Slash commands documented in rules/ must be installed by an adapter.
//     claude-code installs: devteam.md, audit.md, audit-quick.md
//     → valid slash commands: /devteam, /audit, /audit-quick.
//     Rule: /devteam is always valid (it's the core installed command).
//
// (b) `npm run <script>` references in rules/roles/runbooks that describe
//     the stagecraft framework's own commands must exist in package.json.
//
// Scan: rules/, roles/, docs/runbooks/
function checkCommandSurface(scanRoot, trackedSet) {
  const root = scanRoot || REPO_ROOT;
  const scanRelDirs = ["rules", "roles", "docs/runbooks"];

  // (a) Installed slash commands
  const commandsDir = path.join(root, "hosts", "claude-code", "install", "commands");
  const installedCmds = new Set(["/devteam"]); // always installed
  if (fs.existsSync(commandsDir)) {
    for (const f of fs.readdirSync(commandsDir)) {
      if (f.endsWith(".md")) installedCmds.add("/" + f.replace(".md", ""));
    }
  }

  // Match slash commands: standalone `/cmd` in backticks or as list items
  // Must start with / followed by lowercase letter
  const slashRe = /`(\/[a-z][a-z0-9-]*)(?:\s[^`]*)?`/g;

  const slashHits = scanDirs(scanRelDirs, slashRe, root, trackedSet);
  const seenSlash = new Set();
  for (const hit of slashHits) {
    const cmd = hit.match[1];
    if (!cmd) continue;
    if (installedCmds.has(cmd)) continue;
    // /devteam subcommands (e.g. `/devteam stage`) are valid — only the prefix matters
    const key = `slash-cmd:${hit.file}:${cmd}`;
    if (!seenSlash.has(key)) {
      seenSlash.add(key);
      proseViolation("command-surface", hit.file, hit.line,
        `slash command "${cmd}" is documented but not installed by any adapter`,
        key);
    }
  }

  // (b) `npm run <script>` — check against package.json in the root
  let pkgScripts = {};
  try {
    const pkg = JSON.parse(fs.readFileSync(path.join(root, "package.json"), "utf8"));
    pkgScripts = pkg.scripts || {};
  } catch { /* no package.json — skip */ }

  const npmRunRe = /`npm run ([\w:.-]+)`/g;
  const npmRunHits = scanDirs(scanRelDirs, npmRunRe, root, trackedSet);
  const seenNpm = new Set();
  for (const hit of npmRunHits) {
    const scriptName = hit.match[1];
    if (!pkgScripts[scriptName]) {
      const key = `npm-run:${hit.file}:${scriptName}`;
      if (!seenNpm.has(key)) {
        seenNpm.add(key);
        proseViolation("command-surface", hit.file, hit.line,
          `"npm run ${scriptName}" is documented but not found in package.json scripts`,
          key);
      }
    }
  }
}

// --- Check: CI template STAGECRAFT_REF vs package.json major.minor ---
//
// The CI template pins STAGECRAFT_REF so users get a stable, known-good
// version. After each release that ref must be updated or the template
// silently points at an old release. This check enforces that the ref
// in the template matches the current package.json major.minor.
//
// Only the major.minor must match (not patch); we allow any patch suffix
// so a hotfix release doesn't require changing the template immediately.
function checkCiTemplateRefVersion() {
  const templatePath = path.join(REPO_ROOT, "templates", "ci", "github-actions", "stagecraft-pr-checks.yml");
  if (!fs.existsSync(templatePath)) {
    fail("ci-template-ref", `template not found: ${templatePath}`);
    return;
  }
  const pkg = JSON.parse(fs.readFileSync(path.join(REPO_ROOT, "package.json"), "utf8"));
  const [major, minor] = pkg.version.split(".");
  const expectedPrefix = `v${major}.${minor}.`;

  const text = fs.readFileSync(templatePath, "utf8");
  const m = text.match(/^\s*STAGECRAFT_REF:\s+v?(\S+)/m);
  if (!m) {
    fail("ci-template-ref", "templates/ci/github-actions/stagecraft-pr-checks.yml: STAGECRAFT_REF line not found");
    return;
  }
  const refVal = m[1].startsWith("v") ? m[1] : `v${m[1]}`;
  if (!refVal.startsWith(expectedPrefix)) {
    fail("ci-template-ref",
      `templates/ci/github-actions/stagecraft-pr-checks.yml: STAGECRAFT_REF is "${refVal}" but package.json is ${pkg.version} — expected a v${major}.${minor}.x ref`);
  } else {
    pass(`ci-template-ref: STAGECRAFT_REF ${refVal} matches package.json ${pkg.version}`);
  }
}

// --- Check 6a: Tracks matrix sync ---
//
// docs/tracks.md contains a fenced block delimited by
//   <!-- generated: do not hand-edit -->  and  <!-- /generated -->
// that is produced by scripts/generate-tracks-matrix.js.
//
// This check verifies that the committed block equals what the generator
// would produce right now.  It catches manual edits to the matrix and
// ensures that any change to STAGES_BY_TRACK is reflected in the doc.
//
// Only runs in full-repo mode (not fixture-tree mode) because the generator
// imports core/pipeline/stages.js directly and needs the live repo.
function checkTracksMatrixSync() {
  const tracksPath = path.join(REPO_ROOT, "docs", "tracks.md");
  if (!fs.existsSync(tracksPath)) {
    fail("tracks-matrix", "docs/tracks.md not found");
    return;
  }
  const src = fs.readFileSync(tracksPath, "utf8");

  let generator;
  try {
    generator = require(path.join(REPO_ROOT, "scripts", "generate-tracks-matrix.js"));
  } catch (err) {
    fail("tracks-matrix", `could not load generate-tracks-matrix.js: ${err.message}`);
    return;
  }

  const { FENCE_OPEN, FENCE_CLOSE, generateBlock } = generator;
  const fenceRe = new RegExp(
    escapeRe(FENCE_OPEN) + "[\\s\\S]*?" + escapeRe(FENCE_CLOSE)
  );
  const match = src.match(fenceRe);
  if (!match) {
    fail("tracks-matrix",
      `docs/tracks.md does not contain a generated matrix block (expected <!-- generated: do not hand-edit --> fences)`);
    return;
  }

  const committed = match[0];
  const fresh = generateBlock();
  if (committed === fresh) {
    pass("tracks-matrix: docs/tracks.md generated block is up to date");
  } else {
    fail("tracks-matrix",
      "docs/tracks.md generated matrix block is stale — re-run: node scripts/generate-tracks-matrix.js --write");
  }
}

// --- Check 6b-ext: docs/reference/stages.md sync ---
//
// docs/reference/stages.md is entirely generated by scripts/generate-stages-ref.js.
// The whole file is the fenced block. This check verifies that the committed
// file equals what the generator would produce now, catching both manual edits
// and drift after stages.js changes.
//
// Only runs in full-repo mode.
function checkStagesRefSync() {
  const stagesRefPath = path.join(REPO_ROOT, "docs", "reference", "stages.md");
  if (!fs.existsSync(stagesRefPath)) {
    fail("stages-ref", "docs/reference/stages.md not found — run: npm run docs:generate");
    return;
  }
  const committed = fs.readFileSync(stagesRefPath, "utf8").trimEnd();

  let generator;
  try {
    generator = require(path.join(REPO_ROOT, "scripts", "generate-stages-ref.js"));
  } catch (err) {
    fail("stages-ref", `could not load generate-stages-ref.js: ${err.message}`);
    return;
  }

  const fresh = generator.generateBlock();
  if (committed === fresh) {
    pass("stages-ref: docs/reference/stages.md is up to date");
  } else {
    fail("stages-ref",
      "docs/reference/stages.md is stale — re-run: npm run docs:generate");
  }
}

// --- Check 6c-ext: docs/reference/hosts.md sync ---
//
// docs/reference/hosts.md is entirely generated by scripts/generate-hosts-ref.js
// from hosts/*/capabilities.json. This check verifies that the committed file
// equals what the generator would produce, catching both manual edits and drift
// after capabilities.json changes.
//
// Only runs in full-repo mode.
function checkHostsRefSync() {
  const hostsRefPath = path.join(REPO_ROOT, "docs", "reference", "hosts.md");
  if (!fs.existsSync(hostsRefPath)) {
    fail("hosts-ref", "docs/reference/hosts.md not found — run: npm run docs:generate");
    return;
  }
  const committed = fs.readFileSync(hostsRefPath, "utf8").trimEnd();

  let generator;
  try {
    generator = require(path.join(REPO_ROOT, "scripts", "generate-hosts-ref.js"));
  } catch (err) {
    fail("hosts-ref", `could not load generate-hosts-ref.js: ${err.message}`);
    return;
  }

  const fresh = generator.generateBlock();
  if (committed === fresh) {
    pass("hosts-ref: docs/reference/hosts.md is up to date");
  } else {
    fail("hosts-ref",
      "docs/reference/hosts.md is stale — re-run: npm run docs:generate");
  }
}

// --- Check 6d-ext: docs/reference/cli.md sync ---
//
// docs/reference/cli.md is entirely generated by scripts/generate-cli-ref.js
// from the per-command flag schemas in core/cli/commands/.  This check verifies
// that the committed file equals what the generator would produce now, catching
// both manual edits and drift after flag schema changes.
//
// Only runs in full-repo mode.
function checkCliRefSync() {
  const cliRefPath = path.join(REPO_ROOT, "docs", "reference", "cli.md");
  if (!fs.existsSync(cliRefPath)) {
    fail("cli-ref", "docs/reference/cli.md not found — run: npm run docs:generate");
    return;
  }
  const committed = fs.readFileSync(cliRefPath, "utf8").trimEnd();

  let generator;
  try {
    generator = require(path.join(REPO_ROOT, "scripts", "generate-cli-ref.js"));
  } catch (err) {
    fail("cli-ref", `could not load generate-cli-ref.js: ${err.message}`);
    return;
  }

  const fresh = generator.generateBlock();
  if (committed === fresh) {
    pass("cli-ref: docs/reference/cli.md is up to date");
  } else {
    fail("cli-ref",
      "docs/reference/cli.md is stale — re-run: npm run docs:generate");
  }
}

// --- Advisory: docs/reference/prompt-budget.md sync and budget-growth check ---
//
// Entirely advisory (non-blocking per D5 spec). Two advisory classes:
//
//  1. Staleness advisory — committed file ≠ fresh generator output.
//     (Unlike stages-ref/hosts-ref/cli-ref which are blocking failures, the
//     prompt-budget is informational; staleness is warned, not failed.)
//
//  2. Budget-growth advisory — any stage's fresh max-dispatch bytes are >10%
//     larger than the numbers stored in the committed file. Fires when rules/
//     or roles/ grew since the last `npm run docs:generate` run.
//     Useful in PRs where a reviewer sees "stage-04 grew 15%" before merge.
//
// Only runs in full-repo mode — the generator imports core/pipeline/stages.js
// and reads rules/ + roles/ from the live repo.
function checkPromptBudgetSync() {
  // PROMPT_BUDGET_FILE env var overrides the default path, mirroring the
  // CONSISTENCY_BASELINE_FILE pattern. Used in meta-tests to supply a synthetic
  // budget without touching the real docs/reference/prompt-budget.md.
  const budgetPath = process.env.PROMPT_BUDGET_FILE ||
    path.join(REPO_ROOT, "docs", "reference", "prompt-budget.md");
  if (!fs.existsSync(budgetPath)) {
    advisory("prompt-budget", "docs/reference/prompt-budget.md not found — run: npm run docs:generate");
    return;
  }

  let generator;
  try {
    generator = require(path.join(REPO_ROOT, "scripts", "prompt-budget.js"));
  } catch (err) {
    advisory("prompt-budget", `could not load prompt-budget.js: ${err.message}`);
    return;
  }

  const committed = fs.readFileSync(budgetPath, "utf8");
  const fresh = generator.generateBlock();

  // 1. Staleness advisory (non-blocking — note the difference from stages-ref
  // which uses fail()). The growth check below still runs on the committed
  // numbers so reviewers get the "grew >10%" signal even before regenerating.
  if (committed.trimEnd() !== fresh) {
    advisory("prompt-budget",
      "docs/reference/prompt-budget.md is stale — re-run: npm run docs:generate");
  } else {
    pass("prompt-budget: docs/reference/prompt-budget.md is up to date");
  }

  // 2. Budget-growth advisory: compare committed baseline against fresh numbers.
  // "Committed" here is whatever is stored in the file (possibly stale, giving
  // the growth signal relative to the last regeneration baseline).
  const committedMap = generator.parseCommittedBudget(committed);
  if (committedMap.size === 0) return;

  const freshStats = generator.computeStageStats();
  for (const s of freshStats) {
    const baseline = committedMap.get(s.stageId);
    if (baseline == null || baseline === 0) continue;
    if (s.maxDispatchBytes > baseline * 1.10) {
      advisory("prompt-budget",
        `${s.stageId} (${s.stageName}) max-dispatch grew >10%: ${baseline} B → ${s.maxDispatchBytes} B ` +
        `(${Math.round((s.maxDispatchBytes / baseline - 1) * 100)}% increase) — ` +
        `consider trimming rules/ or roles/ before merging`);
    }
  }
}

// --- Advisory: EXAMPLE.md freshness stamp ---
//
// EXAMPLE.md is a captured pipeline run — it silently rots as the pipeline
// evolves. This check reads the "captured at vX.Y" stamp near the top and
// warns when the stamp is more than one minor behind package.json (D6.1).
//
// Only an advisory (non-blocking) because the doc is still correct for most
// readers; the intent is to prompt re-capture at each minor release.
//
// Only runs in full-repo mode.
function checkExampleMdFreshnessStamp() {
  const examplePath = path.join(REPO_ROOT, "EXAMPLE.md");
  if (!fs.existsSync(examplePath)) {
    advisory("example-freshness", "EXAMPLE.md not found");
    return;
  }
  const content = fs.readFileSync(examplePath, "utf8");
  const stampMatch = content.match(/captured at v(\d+)\.(\d+)/i);
  if (!stampMatch) {
    advisory("example-freshness",
      "EXAMPLE.md has no freshness stamp — add \"captured at vX.Y\" near the top (D6.1)");
    return;
  }

  const pkg = JSON.parse(fs.readFileSync(path.join(REPO_ROOT, "package.json"), "utf8"));
  const pkgMatch = pkg.version.match(/^(\d+)\.(\d+)/);
  if (!pkgMatch) return; // malformed version — skip advisory

  const stampMajor = parseInt(stampMatch[1], 10);
  const stampMinor = parseInt(stampMatch[2], 10);
  const pkgMajor   = parseInt(pkgMatch[1], 10);
  const pkgMinor   = parseInt(pkgMatch[2], 10);

  const minorsBehind = (pkgMajor === stampMajor) ? (pkgMinor - stampMinor) : Infinity;

  if (minorsBehind > 1) {
    advisory("example-freshness",
      `EXAMPLE.md stamp is v${stampMajor}.${stampMinor} but package.json is ${pkg.version} ` +
      `(>1 minor behind) — re-capture the example run and update the stamp`);
  } else {
    pass(`example-freshness: EXAMPLE.md stamp v${stampMajor}.${stampMinor} is current (≤1 minor behind ${pkg.version})`);
  }
}

// --- Advisory: per-file size ceilings ---
//
// Emits non-blocking advisories when files exceed their size ceilings:
//   role brief  ≤ 16 KB (chosen from current healthy files; platform.md at 15.6 KB is largest)
//   stage rule  ≤  8 KB (stage-05.md at ~9.9 KB already exceeds this — recorded, not edited)
//   AGENTS.md   ≤ 10 KB (currently 4.1 KB — comfortable headroom)
//
// Never edits the files. Violations are advisory only.
//
// Accepts optional scanRoot for fixture-tree testing via --root + --only file-size-ceiling.
function checkFileSizeCeilings(scanRoot) {
  const root = scanRoot || REPO_ROOT;
  const ROLE_CEILING   = 16 * 1024; // 16 KB
  const STAGE_CEILING  =  8 * 1024; //  8 KB
  const AGENTS_CEILING = 10 * 1024; // 10 KB

  // Check AGENTS.md
  const agentsPath = path.join(root, "AGENTS.md");
  if (fs.existsSync(agentsPath)) {
    const bytes = fs.statSync(agentsPath).size;
    if (bytes > AGENTS_CEILING) {
      advisory("file-size-ceiling",
        `AGENTS.md is ${bytes} B — exceeds ${AGENTS_CEILING} B (10 KB) advisory ceiling`);
    } else {
      pass(`file-size-ceiling: AGENTS.md ${bytes} B ≤ ${AGENTS_CEILING} B`);
    }
  }

  // Check roles/*.md
  const rolesDir = path.join(root, "roles");
  if (fs.existsSync(rolesDir)) {
    for (const f of fs.readdirSync(rolesDir)) {
      if (!f.endsWith(".md")) continue;
      const abs  = path.join(rolesDir, f);
      const bytes = fs.statSync(abs).size;
      if (bytes > ROLE_CEILING) {
        advisory("file-size-ceiling",
          `roles/${f} is ${bytes} B — exceeds ${ROLE_CEILING} B (16 KB) role-brief advisory ceiling`);
      } else {
        pass(`file-size-ceiling: roles/${f} ${bytes} B ≤ ${ROLE_CEILING} B`);
      }
    }
  }

  // Check rules/stage-*.md
  const rulesDir = path.join(root, "rules");
  if (fs.existsSync(rulesDir)) {
    for (const f of fs.readdirSync(rulesDir)) {
      if (!f.startsWith("stage-") || !f.endsWith(".md")) continue;
      const abs  = path.join(rulesDir, f);
      const bytes = fs.statSync(abs).size;
      if (bytes > STAGE_CEILING) {
        advisory("file-size-ceiling",
          `rules/${f} is ${bytes} B — exceeds ${STAGE_CEILING} B (8 KB) stage-rule advisory ceiling`);
      } else {
        pass(`file-size-ceiling: rules/${f} ${bytes} B ≤ ${STAGE_CEILING} B`);
      }
    }
  }
}

function escapeRe(s) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

// --- Check 6b (was 6): Stage rule-file coverage ---
//
// Every non-mechanical stage in the build range (stage-04 through stage-08)
// that is in STAGES, and every stage indexed in rules/pipeline-build.md,
// must have a corresponding rules/stage-NN[x].md rule file.
//
// Currently missing: stage-04c, stage-04d, stage-06d, stage-06e.
function checkStageRuleFileCoverage(scanRoot) {
  const root = scanRoot || REPO_ROOT;
  const isFixtureMode = root !== REPO_ROOT;

  // In repo mode, also check all non-mechanical stages in the build range from
  // live STAGES. In fixture-tree mode, skip this: the fixture only has the stages
  // it explicitly defines; requiring all live STAGES would force every fixture to
  // create dozens of stub rule files just to pass unrelated tests.
  const allStageIds = new Set();
  if (!isFixtureMode) {
    const buildRangeRe = /^stage-0[4-8]/;
    for (const def of Object.values(STAGES)) {
      if (def && buildRangeRe.test(def.stage) && def.roles.length > 0) {
        allStageIds.add(def.stage);
      }
    }
  }

  // Always: collect stage IDs referenced in the (fixture or repo) pipeline-build.md
  const pipelineBuildPath = path.join(root, "rules", "pipeline-build.md");
  if (fs.existsSync(pipelineBuildPath)) {
    const content = fs.readFileSync(pipelineBuildPath, "utf8");
    // Match markdown links like [stage-04.md](stage-04.md) or [`stage-04.md`](stage-04.md)
    // (the backtick-wrapped form is used in the real pipeline-build.md index table)
    const linkRe = /\[`?(stage-\d+[a-z]?)\.md`?\]\(stage-\d+[a-z]?\.md\)/g;
    let m;
    while ((m = linkRe.exec(content)) !== null) allStageIds.add(m[1]);
  }

  for (const stageId of allStageIds) {
    const ruleFile = `rules/${stageId}.md`;
    if (!fs.existsSync(path.join(root, ruleFile))) {
      const key = `stage-rule-file:${stageId}`;
      proseViolation("stage-rule-file", "rules/pipeline-build.md", 0,
        `stage "${stageId}" is in STAGES (build range) but has no rule file at ${ruleFile}`,
        key);
    }
  }
}

// --- Check 7: docs/README.md orphan detection (D2) ---
//
// Every .md file under docs/ (excluding historical/, audit-archive/, reference/,
// and audit/ which holds generated output) must be reachable from docs/README.md.
// A file is "reachable" if:
//   (a) docs/README.md contains a markdown link whose target matches its relative
//       path from docs/, OR
//   (b) the file lives in a subdirectory that has a README.md which IS directly
//       linked from docs/README.md (directory-index coverage).
//
// The check is a no-op when docs/ does not exist or has no non-excluded .md
// files, so it is safe to run against fixture trees that have no docs/ at all.
function checkDocsIndexCoverage(scanRoot, trackedSet) {
  const root = scanRoot || REPO_ROOT;
  const docsDir = path.join(root, "docs");
  if (!fs.existsSync(docsDir)) return;

  // In git-aware mode, compute tracked set for this root (unless already provided).
  // trackedSet is passed from runProseChecks so git ls-files runs once per invocation.
  const ts = trackedSet !== undefined ? trackedSet : gitTrackedFiles(root);

  // Subdirectory names (direct children of docs/) that are fully excluded.
  const EXCLUDED_TOP_DIRS = ["historical", "audit-archive", "reference", "audit"];

  // Collect .md files under docs/: tracked → blocking, untracked non-ignored → advisory.
  const docFiles = []; // paths relative to docsDir, using "/" separators
  function scanDocs(dir) {
    let entries;
    try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
    for (const e of entries) {
      const abs = path.join(dir, e.name);
      const relFromDocs = path.relative(docsDir, abs).replace(/\\/g, "/");
      const topDir = relFromDocs.split("/")[0];
      if (EXCLUDED_TOP_DIRS.includes(topDir)) continue;
      if (e.isDirectory()) { scanDocs(abs); continue; }
      if (!e.name.endsWith(".md")) continue;
      if (relFromDocs === "README.md") continue; // index doesn't need to list itself
      if (ts !== null) {
        const rootRel = path.relative(root, abs).replace(/\\/g, "/");
        if (!ts.has(rootRel)) {
          // Untracked: advisory only (commit the file or add it to .gitignore first).
          advisory("docs-index",
            `docs/${relFromDocs} is untracked — would violate docs-index if committed ` +
            `(link it in docs/README.md then git add it, or add it to .gitignore)`);
          continue;
        }
      }
      docFiles.push(relFromDocs);
    }
  }
  scanDocs(docsDir);

  if (docFiles.length === 0) return; // nothing to check

  // Read docs/README.md.
  const docsReadmePath = path.join(docsDir, "README.md");
  if (!fs.existsSync(docsReadmePath)) {
    fail("docs-index", "docs/README.md does not exist but docs/ contains .md files");
    return;
  }
  const docsReadmeContent = fs.readFileSync(docsReadmePath, "utf8");

  // Extract relative link targets from docs/README.md.
  // Strip URL fragments (#...) and title strings ("...") from the target.
  const linkedTargets = new Set();
  const linkRe = /\]\(([^)]+)\)/g;
  let m;
  while ((m = linkRe.exec(docsReadmeContent)) !== null) {
    let target = m[1].trim();
    const hashIdx = target.indexOf("#");
    if (hashIdx >= 0) target = target.substring(0, hashIdx).trim();
    const spaceIdx = target.indexOf(" ");
    if (spaceIdx >= 0) target = target.substring(0, spaceIdx).trim();
    if (!target || target.startsWith("http") || target.startsWith("../") || target.startsWith("#")) continue;
    linkedTargets.add(target);
  }

  for (const relFile of docFiles) {
    // (a) Direct link.
    if (linkedTargets.has(relFile)) {
      pass(`docs/README.md links to docs/${relFile}`);
      continue;
    }

    // (b) Parent-directory README.md is linked (directory-index coverage).
    const parts = relFile.split("/");
    if (parts.length > 1) {
      const parentDir = parts[0];
      const parentReadmeLink = `${parentDir}/README.md`;
      if (linkedTargets.has(parentReadmeLink)) {
        pass(`docs/README.md covers docs/${relFile} via directory index ${parentReadmeLink}`);
        continue;
      }
    }

    proseViolation(
      "docs-index",
      "docs/README.md",
      0,
      `docs/${relFile} is not linked from docs/README.md (orphan doc — add it to the appropriate reader-path section)`,
      `docs-index:${relFile}`
    );
  }
}

// --- Check 8: Role-brief / tool-budget compatibility ---
//
// Every `devteam`/shell command in a role brief's procedure must be
// compatible with that role's declared tool budget from core/roles.js.
// A role that lacks Bash cannot run shell commands — any backtick-quoted
// `devteam <subcommand>` in the brief is an incompatibility that will
// silently fail under native enforcement (e.g. claude-code subagents).
//
// The source of truth for budgets is core/roles.js (ROLE_TOOLS), moved
// there in item 6.1 to make budgets host-neutral and checkable here.
//
// Scan: roles/*.md (only role briefs, not rules/ — rules describe the
// pipeline, not what a specific role is asked to do).
function checkRoleBriefToolBudgetCompatibility(scanRoot, trackedSet) {
  const root = scanRoot || REPO_ROOT;
  const { toolBudgetFor } = require(path.join(REPO_ROOT, "core", "roles"));
  const rolesDir = path.join(root, "roles");
  if (!fs.existsSync(rolesDir)) return;

  // Match imperative instructions to run devteam subcommands: "Run `devteam ...`"
  // (case-insensitive "run"). Informational references like
  // "Note: `devteam spec verify` is run by the pipeline" do NOT match — they
  // lack the leading verb and therefore don't instruct the role to invoke the
  // command. This precision prevents false positives on context notes.
  const shellCmdRe = /\brun\s+`(devteam\s+\S[^`]*)`/gi;

  for (const file of fs.readdirSync(rolesDir)) {
    if (!file.endsWith(".md") || file === "README.md") continue;
    const relPath = ("roles/" + file).replace(/\\/g, "/");
    if (trackedSet !== null && trackedSet !== undefined && !trackedSet.has(relPath)) continue;
    const roleName = file.replace(/\.md$/, "");
    const budget = toolBudgetFor(roleName);
    // Unknown role or role with Bash — nothing to flag.
    if (!budget || budget.includes("Bash")) continue;

    const content = fs.readFileSync(path.join(rolesDir, file), "utf8");
    const lines = content.split(/\r?\n/);
    const seen = new Set();
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i];
      let m;
      shellCmdRe.lastIndex = 0;
      while ((m = shellCmdRe.exec(line)) !== null) {
        const cmd = m[1].trim();
        // Stable key: role + first two tokens of command (subcommand name).
        const tokens = cmd.split(/\s+/).slice(0, 2).join("-");
        const key = `role-budget-brief:roles/${file}:${tokens}`;
        if (!seen.has(key)) {
          seen.add(key);
          proseViolation(
            "role-budget-brief",
            path.join("roles", file),
            i + 1,
            `role "${roleName}" (budget: ${budget.join(", ")}) instructs running \`${cmd}\` but has no Bash capability — move execution to the orchestrator or remove the instruction`,
            key
          );
        }
      }
    }
  }
}

// --- Check 9: Stable schema vocabulary ---
//
// Only vocabulary with a durable, machine-readable schema authority belongs
// here. Historical/audit archives remain excluded by scanDirs().
function checkSchemaVocabulary(scanRoot, trackedSet) {
  const root = scanRoot || REPO_ROOT;
  const contracts = [{
    schema: "core/gates/schemas/stage-06e.schema.json",
    field: "checks_performed",
    obsolete: ["checks_run"],
    docs: ["docs/FEATURES.md", "docs/user-guide.md"],
  }];

  for (const contract of contracts) {
    const schemaPath = path.join(root, contract.schema);
    if (!fs.existsSync(schemaPath)) continue;
    let schema;
    try { schema = JSON.parse(fs.readFileSync(schemaPath, "utf8")); } catch { continue; }
    if (!schema.properties || !Object.hasOwn(schema.properties, contract.field)) {
      proseViolation(
        "schema-vocabulary",
        contract.schema,
        0,
        `canonical field "${contract.field}" is missing from the schema`,
        `schema-vocabulary:${contract.schema}:missing:${contract.field}`,
      );
      continue;
    }

    for (const rel of contract.docs) {
      const abs = path.join(root, rel);
      if (!fs.existsSync(abs)) continue;
      if (trackedSet !== null && trackedSet !== undefined && !trackedSet.has(rel)) continue;
      const content = fs.readFileSync(abs, "utf8");
      if (content.includes(contract.field)) {
        pass(`${rel} uses canonical schema field "${contract.field}"`);
      } else {
        proseViolation(
          "schema-vocabulary",
          rel,
          0,
          `must document canonical field "${contract.field}" from ${contract.schema}`,
          `schema-vocabulary:${rel}:missing:${contract.field}`,
        );
      }
    }

    for (const oldField of contract.obsolete) {
      const matches = scanDirs(["docs"], new RegExp(`\\b${oldField}\\b`), root, trackedSet);
      for (const m of matches) {
        if (m.file.startsWith("docs/audit/")) continue;
        proseViolation(
          "schema-vocabulary",
          m.file,
          m.line,
          `obsolete field "${oldField}"; schema uses "${contract.field}"`,
          `schema-vocabulary:${m.file}:${oldField}`,
        );
      }
    }
  }
}

// --- Check 10: Stable runtime/platform support facts ---
//
// package.json is the machine-readable authority for minimum Node and supported
// operating systems. Exact test totals are deliberately not an authority: they
// change too often to belong in current maintainer entry points.
function checkSupportState(scanRoot, trackedSet) {
  const root = scanRoot || REPO_ROOT;
  const pkgPath = path.join(root, "package.json");
  if (!fs.existsSync(pkgPath)) return;
  let pkg;
  try { pkg = JSON.parse(fs.readFileSync(pkgPath, "utf8")); } catch { return; }

  const nodeMatch = String(pkg.engines?.node || "").match(/(\d+)/);
  const minNode = nodeMatch ? Number(nodeMatch[1]) : null;
  const nodeDocs = ["README.md", "docs/guides/dogfooding.md"];
  for (const rel of nodeDocs) {
    const abs = path.join(root, rel);
    if (!minNode || !fs.existsSync(abs)) continue;
    if (trackedSet !== null && trackedSet !== undefined && !trackedSet.has(rel)) continue;
    const content = fs.readFileSync(abs, "utf8");
    const claims = [...content.matchAll(/Node(?:\.js)?\s*(?:(?:≥|>=)\s*(\d+)|(\d+)\+)/gi)];
    if (claims.length === 0) {
      proseViolation(
        "support-state",
        rel,
        0,
        `must document the package.json minimum Node version (${pkg.engines.node})`,
        `support-state:${rel}:node-missing`,
      );
    }
    for (const claim of claims) {
      const claimedMajor = Number(claim[1] || claim[2]);
      if (claimedMajor === minNode) continue;
      const line = content.slice(0, claim.index).split(/\r?\n/).length;
      proseViolation(
        "support-state",
        rel,
        line,
        `Node ${claimedMajor} claim disagrees with package.json engines.node (${pkg.engines.node})`,
        `support-state:${rel}:node:${claimedMajor}`,
      );
    }
  }

  if (Array.isArray(pkg.os) && pkg.os.includes("win32")) {
    const windowsDocs = [
      ["README.md", /native Windows (?:are|is) supported/i],
      ["docs/FEATURES.md", /runs natively on Windows/i],
      ["docs/faq.md", /(?:supports native Windows|native Windows is supported)/i],
    ];
    for (const [rel, affirmation] of windowsDocs) {
      const abs = path.join(root, rel);
      if (!fs.existsSync(abs)) continue;
      if (trackedSet !== null && trackedSet !== undefined && !trackedSet.has(rel)) continue;
      const content = fs.readFileSync(abs, "utf8");
      if (affirmation.test(content)) {
        pass(`${rel} affirms native Windows support`);
        continue;
      }
      proseViolation(
        "support-state",
        rel,
        0,
        "must affirm package.json os support for win32",
        `support-state:${rel}:win32-missing`,
      );
    }
  }

  const countDocs = ["AGENTS.md", "CONTRIBUTING.md", "plans/README.md"];
  for (const rel of countDocs) {
    const abs = path.join(root, rel);
    if (!fs.existsSync(abs)) continue;
    if (trackedSet !== null && trackedSet !== undefined && !trackedSet.has(rel)) continue;
    const content = fs.readFileSync(abs, "utf8");
    const match = content.match(/(?:~\s*)?\d[\d, ]*\s+tests\b/i);
    if (!match) {
      pass(`${rel} avoids a volatile exact test count`);
      continue;
    }
    const line = content.slice(0, match.index).split(/\r?\n/).length;
    proseViolation(
      "support-state",
      rel,
      line,
      `volatile test-count claim "${match[0].trim()}"; describe the suite without an exact total`,
      `support-state:${rel}:volatile-test-count`,
    );
  }
}

// ---------------------------------------------------------------------------
// Prose-vs-code dispatch — run all checks that work against fixture trees.
// checkTracksMatrixSync() is NOT here; it only runs in full-repo mode
// (it requires core/pipeline/stages.js and scripts/generate-tracks-matrix.js
// from the repo root, so it cannot work against a fixture tree).
// ---------------------------------------------------------------------------

function runProseChecks(scanRoot, onlyFilter) {
  const root = scanRoot || REPO_ROOT;
  // Compute git-tracked set once so each check doesn't spawn its own git process.
  const trackedSet = gitTrackedFiles(root);
  // shouldRun: when --only is set, only the named check class runs.
  function shouldRun(cls) { return !onlyFilter || onlyFilter === cls; }

  if (shouldRun("gate-filename")) checkGateFilenameReferences(scanRoot, trackedSet);
  // stage-id and stage-count share one function; run if either class is requested.
  if (shouldRun("stage-id") || shouldRun("stage-count")) checkStageIdAndCountClaims(scanRoot, trackedSet);
  if (shouldRun("track-list")) checkTrackListClaims(scanRoot, trackedSet);
  if (shouldRun("ref-existence")) checkReferencedFileExistence(scanRoot, trackedSet);
  if (shouldRun("command-surface")) checkCommandSurface(scanRoot, trackedSet);
  if (shouldRun("stage-rule-file")) checkStageRuleFileCoverage(scanRoot);
  if (shouldRun("docs-index")) checkDocsIndexCoverage(scanRoot, trackedSet);
  if (shouldRun("role-budget-brief")) checkRoleBriefToolBudgetCompatibility(scanRoot, trackedSet);
  if (shouldRun("file-size-ceiling")) checkFileSizeCeilings(scanRoot);
  if (shouldRun("schema-vocabulary")) checkSchemaVocabulary(scanRoot, trackedSet);
  if (shouldRun("support-state")) checkSupportState(scanRoot, trackedSet);
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

function main(opts) {
  // Support both programmatic invocation (opts.args) and CLI (process.argv)
  const args = (opts && opts.args) ? opts.args : process.argv.slice(2);
  const json = args.includes("--json");
  const noBaseline = args.includes("--no-baseline");

  // --root <path> allows tests to run the checker against fixture trees or git repos
  const rootIdx = args.indexOf("--root");
  const customRoot = rootIdx >= 0 ? args[rootIdx + 1] : null;

  // --only <check-class> runs a single check class (used by meta-tests to avoid
  // fan-out: each class test invokes only its own class, not the full suite).
  const onlyIdx = args.indexOf("--only");
  const onlyFilter = onlyIdx >= 0 ? args[onlyIdx + 1] : null;

  function shouldRunFullRepo(cls) {
    return !onlyFilter || onlyFilter === cls;
  }

  if (customRoot) {
    // Fixture-tree or git-repo mode: run prose checks (core checks need the live repo).
    runProseChecks(customRoot, onlyFilter);
  } else {
    // Full run: core checks (only when no --only filter) + prose checks against real repo.
    if (!onlyFilter) {
      checkStagesToSchemas();
      checkSchemasToStages();
      checkStagesToRoles();
      checkRoleWritesValid();
      checkSubagentOverrides();
      checkTracksReferenceKnownStages();
      checkOrderedStageNamesCoversAll();
      checkAdaptersExportContract();
      checkRequiredRulesPresent();
      checkSchemaIdsAndDraft();
      checkGateBaseSchemaIdentity();
      checkAuditFeatureIntegrity();
      checkTracksMatrixSync();
      checkStagesRefSync();
      checkHostsRefSync();
      checkCliRefSync();
      checkCiTemplateRefVersion();
    }
    if (shouldRunFullRepo("prompt-budget")) checkPromptBudgetSync();
    if (!onlyFilter) checkExampleMdFreshnessStamp();
    runProseChecks(null, onlyFilter);
  }

  // Apply baseline suppression: baselined keys don't fail the run
  const baselineSet = noBaseline ? new Set() : loadBaseline();
  const newViolations = [];
  for (const v of proseViolations) {
    if (baselineSet.has(v.key)) {
      baselined.push(v);
    } else {
      newViolations.push(v);
    }
  }

  const totalFails = failures.length + newViolations.length;

  if (json) {
    const allFails = [
      ...failures,
      ...newViolations.map((v) => ({
        name: `${v.checkClass}:${v.file}:${v.line}`,
        detail: v.detail,
      })),
    ];
    console.log(JSON.stringify({
      passes: passes.length,
      failures: allFails,
      advisories,
      baselined: baselined.length,
      proseViolations: noBaseline ? proseViolations : newViolations,
    }, null, 2));
  } else {
    if (totalFails === 0 && baselined.length === 0 && advisories.length === 0) {
      console.log(`✅ consistency: ${passes.length} checks passed`);
    } else if (totalFails === 0) {
      const suffix = [
        baselined.length > 0 ? `${baselined.length} baselined` : "",
        advisories.length > 0 ? `${advisories.length} advisory` : "",
      ].filter(Boolean).join(", ");
      console.log(`✅ consistency: ${passes.length} checks passed${suffix ? `, ${suffix}` : ""}`);
      for (const v of baselined) {
        console.log(`  ⏭ [baselined] ${v.file}:${v.line}: (${v.checkClass}) ${v.detail}`);
      }
      for (const a of advisories) {
        console.log(`  ⚠ [advisory] ${a.name}: ${a.detail}`);
      }
    } else {
      const suffix = advisories.length > 0 ? `, ${advisories.length} advisory` : "";
      console.log(`❌ consistency: ${totalFails} failure(s), ${passes.length} pass(es)${baselined.length > 0 ? `, ${baselined.length} baselined` : ""}${suffix}`);
      for (const f of failures) {
        console.log(`  ✗ ${f.name}: ${f.detail}`);
      }
      for (const v of newViolations) {
        console.log(`  ✗ ${v.file}:${v.line}: (${v.checkClass}) ${v.detail}`);
      }
      if (baselined.length > 0) {
        console.log(`  — baselined violations (suppressed, not failing):`);
        for (const v of baselined) {
          console.log(`    ⏭ ${v.file}:${v.line}: (${v.checkClass}) ${v.detail}`);
        }
      }
      for (const a of advisories) {
        console.log(`  ⚠ [advisory] ${a.name}: ${a.detail}`);
      }
    }
  }

  const exitCode = totalFails === 0 ? 0 : 1;
  if (require.main === module) process.exit(exitCode);
  return exitCode;
}

module.exports = { main, advisory, advisories };

if (require.main === module) main();
