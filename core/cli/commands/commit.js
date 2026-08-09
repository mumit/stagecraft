"use strict";

const fs   = require("node:fs");
const os   = require("node:os");
const path = require("node:path");
const readline = require("node:readline");
const { execFileSync } = require("node:child_process");

const { generateHelp } = require(path.join(__dirname, "..", "flags"));
const { pipelineRoot, gatesDir } = require(path.join(__dirname, "..", "..", "paths"));
const { STAGE_ARTIFACTS } = require(path.join(__dirname, "..", "..", "pipeline", "artifacts"));
const { CANONICAL_BLOCK } = require(path.join(__dirname, "..", "..", "gitignore"));

const name = "commit";

const flags = {
  all:       { type: "boolean", description: "Stage all gate-bearing stages regardless of cursor" },
  "dry-run": { type: "boolean", description: "Print what would be staged without committing" },
  message:   { type: "string",  description: "Override generated commit message" },
  json:      { type: "boolean", description: "Machine-readable output" },
  cwd:       { type: "string",  description: "Target project directory" },
  help:      { type: "boolean", description: "Show this help" },
};

// Parse volatile path patterns from the stagecraft gitignore block.
// Returns an array of patterns (strings) — each is a gitignore-style path.
function buildVolatilePatterns() {
  return CANONICAL_BLOCK.split("\n")
    .map((l) => l.trim())
    .filter((l) => l && !l.startsWith("#"));
}

// Convert a gitignore-style pattern to a regex for matching paths relative to cwd.
// Handles exact paths, directory prefixes (trailing "/"), and "*" wildcards.
function patternToRegex(pattern) {
  // Escape all special regex chars except backslash (which we'll handle last)
  let escaped = pattern.replace(/[.+?^${}()|[\]\\]/g, "\\$&");
  if (pattern.endsWith("/")) {
    // Directory: match anything that starts with this prefix
    return new RegExp("^" + escaped);
  }
  // Replace * with [^/]+ to match exactly one path component
  escaped = escaped.replace(/\*/g, "[^/]+");
  return new RegExp("^" + escaped + "$");
}

const VOLATILE_REGEXES = buildVolatilePatterns().map(patternToRegex);

function isVolatile(relPath) {
  const normalized = relPath.replace(/\\/g, "/");
  return VOLATILE_REGEXES.some((re) => re.test(normalized));
}

// Resolve artifact paths for a stageId. Returns an array of absolute paths
// relative to pipelineRoot. Handles plain files, directories (/), and globs (*).
function resolveArtifacts(stageId, pRoot, intent) {
  const patterns = STAGE_ARTIFACTS[stageId] || [];
  const resolved = [];

  for (let pattern of patterns) {
    // Repair-mode substitution: stage-01's brief.md → diagnosis.md
    if (stageId === "stage-01" && pattern === "brief.md" && intent === "repair") {
      pattern = "diagnosis.md";
    }

    if (pattern.endsWith("/")) {
      // Directory: collect all direct-child files
      const dir = path.join(pRoot, pattern.slice(0, -1));
      if (fs.existsSync(dir)) {
        try {
          for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
            if (entry.isFile()) resolved.push(path.join(dir, entry.name));
          }
        } catch { /* best-effort */ }
      }
    } else if (pattern.includes("*")) {
      // Glob: match files in pRoot against the pattern
      const re = new RegExp("^" + pattern.replace(/[.+?^${}()|[\]\\]/g, "\\$&").replace(/\*/g, "[^/]+") + "$");
      if (fs.existsSync(pRoot)) {
        try {
          for (const entry of fs.readdirSync(pRoot, { withFileTypes: true })) {
            if (entry.isFile() && re.test(entry.name)) {
              resolved.push(path.join(pRoot, entry.name));
            }
          }
        } catch { /* best-effort */ }
      }
    } else {
      // Exact file
      resolved.push(path.join(pRoot, pattern));
    }
  }

  return resolved;
}

// Generate the commit message subject line from committed stage IDs.
function generateSubject(stageIds, intent) {
  const nums = stageIds
    .map((id) => {
      const m = id.match(/^stage-(\d+[a-z]?)$/);
      return m ? m[1] : null;
    })
    .filter(Boolean);

  if (nums.length === 0) return "pipeline: stages PASS";

  const prefix = intent === "repair" ? "pipeline(repair)" : "pipeline";
  if (nums.length === 1) return `${prefix}: stage ${nums[0]} PASS`;
  return `${prefix}: stages ${nums[0]}–${nums[nums.length - 1]} PASS`;
}

// Open $EDITOR on a temp file and return the edited content.
function editWithEditor(initial) {
  const editor = process.env.EDITOR || process.env.VISUAL || "vi";
  const tmp = path.join(os.tmpdir(), `devteam-commit-msg-${Date.now()}.txt`);
  fs.writeFileSync(tmp, initial, "utf8");
  try {
    execFileSync(editor, [tmp], { stdio: "inherit" });
    return fs.readFileSync(tmp, "utf8").trim();
  } finally {
    try { fs.unlinkSync(tmp); } catch { /* ignore */ }
  }
}

// Prompt the user for y/n/e confirmation. Calls back with the response.
function prompt(question, callback) {
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  rl.question(question, (answer) => {
    rl.close();
    callback(answer.trim().toLowerCase());
  });
}

function run(positional, _flags) {
  if (_flags.help) {
    console.log(generateHelp("devteam commit [options]", flags));
    process.exit(0);
  }

  const cwd = _flags.cwd || process.cwd();
  const changeId = null;               // Phase 12.2: in-place mode only
  const pRoot = pipelineRoot(cwd, changeId);
  const gDir  = gatesDir(cwd, changeId);
  const isDryRun = Boolean(_flags.dryRun);
  const jsonMode = Boolean(_flags.json);
  const all = Boolean(_flags.all);

  // Read run-state.json
  const runStatePath = path.join(pRoot, "run-state.json");
  let runState = null;
  try {
    runState = JSON.parse(fs.readFileSync(runStatePath, "utf8"));
  } catch {
    console.error("devteam commit: cannot read pipeline/run-state.json — has devteam run been invoked?");
    process.exit(1);
  }

  // Migration: ensure fields exist (old run-states may lack them)
  const stagesAdvanced = runState.stages_advanced || [];
  const cursor = (runState.last_committed_stage_index === undefined)
    ? null
    : runState.last_committed_stage_index;
  const intent = runState.intent || "feature";

  // Determine which stages to commit
  let toCommit;
  if (all) {
    toCommit = stagesAdvanced.slice();
  } else {
    const startIdx = cursor === null ? 0 : cursor + 1;
    toCommit = stagesAdvanced.slice(startIdx);
  }

  if (toCommit.length === 0) {
    const msg = "nothing to commit (all stages already committed)";
    if (jsonMode) {
      console.log(JSON.stringify({ dry_run: isDryRun, files: [], message: null, committed: false, reason: msg }, null, 2));
    } else {
      console.log(msg);
    }
    process.exit(0);
  }

  // Build the list of files to stage
  // ADR-018: the materialized run plan is durable execution provenance, not
  // volatile driver state. Include it once at least one stage is being
  // committed; old runs without the artifact remain compatible via the
  // existence filter below.
  const filesToStage = [path.join(pRoot, "run-plan.json")];

  for (const stageId of toCommit) {
    // Gate file — include if gate status is PASS or WARN
    const gateFile = path.join(gDir, `${stageId}.json`);
    if (fs.existsSync(gateFile)) {
      try {
        const gate = JSON.parse(fs.readFileSync(gateFile, "utf8"));
        if (gate.status === "PASS" || gate.status === "WARN") {
          filesToStage.push(gateFile);
        }
      } catch { /* unreadable gate — skip */ }
    }

    // Artifact files
    for (const absPath of resolveArtifacts(stageId, pRoot, intent)) {
      filesToStage.push(absPath);
    }
  }

  // Deduplicate, filter to existing, and exclude volatile files
  const cwdNorm = cwd.replace(/\\/g, "/").replace(/\/?$/, "/");
  const seen = new Set();
  const staged = [];
  for (const absPath of filesToStage) {
    const norm = absPath.replace(/\\/g, "/");
    if (seen.has(norm)) continue;
    seen.add(norm);
    if (!fs.existsSync(absPath)) continue;
    // Compute path relative to cwd for volatile check
    const rel = norm.startsWith(cwdNorm) ? norm.slice(cwdNorm.length) : norm;
    if (isVolatile(rel)) continue;
    staged.push(absPath);
  }

  if (staged.length === 0) {
    const msg = "nothing to commit (no stageable files found for the selected stages)";
    if (jsonMode) {
      console.log(JSON.stringify({ dry_run: isDryRun, files: [], message: null, committed: false, reason: msg }, null, 2));
    } else {
      console.log(msg);
    }
    process.exit(0);
  }

  // Generate commit message
  let commitMsg = _flags.message || generateSubject(toCommit, intent);
  const trailer = `Co-Authored-By: Stagecraft (Claude Sonnet 4.6) <stagecraft@mumit.org>`;
  const fullMsg = `${commitMsg}\n\n[${toCommit.length} stage${toCommit.length === 1 ? "" : "s"}]\n\n${trailer}`;

  if (jsonMode && isDryRun) {
    console.log(JSON.stringify({
      dry_run: true,
      files: staged.map((p) => path.relative(cwd, p)),
      message: fullMsg,
      committed: false,
    }, null, 2));
    process.exit(0);
  }

  // Print staged file list and proposed message
  if (!jsonMode) {
    console.log("Files to stage:");
    for (const f of staged) console.log(`  ${path.relative(cwd, f)}`);
    console.log("\nCommit message:");
    console.log(fullMsg.split("\n").map((l) => `  ${l}`).join("\n"));
    console.log();
  }

  if (isDryRun) {
    if (!jsonMode) console.log("(dry run — nothing committed)");
    process.exit(0);
  }

  // Interactive confirmation
  const doCommit = (msg) => {
    try {
      // git add by name, never -A
      execFileSync("git", ["add", "--", ...staged], { cwd, stdio: "inherit" });
      execFileSync("git", ["commit", "-m", msg], { cwd, stdio: "inherit" });
    } catch (err) {
      console.error(`devteam commit: git error — ${err.message}`);
      process.exit(1);
    }

    // Update last_committed_stage_index in run-state.json
    // The new cursor is the index of the last committed stage in stages_advanced.
    let newCursor = cursor;
    if (all) {
      newCursor = stagesAdvanced.length - 1;
    } else {
      // toCommit starts at (cursor === null ? 0 : cursor + 1) and goes to end
      newCursor = stagesAdvanced.length - 1;
    }

    try {
      runState.last_committed_stage_index = newCursor;
      fs.writeFileSync(runStatePath, JSON.stringify(runState, null, 2));
    } catch { /* best-effort */ }

    if (jsonMode) {
      let commitHash = "";
      try {
        const { execSync } = require("node:child_process");
        commitHash = execSync("git rev-parse --short HEAD", { cwd }).toString().trim();
      } catch { /* ignore */ }
      console.log(JSON.stringify({
        dry_run: false,
        files: staged.map((p) => path.relative(cwd, p)),
        message: msg,
        committed: true,
        commit_hash: commitHash,
      }, null, 2));
    }
    process.exit(0);
  };

  prompt("Commit? [y/n/e] ", (answer) => {
    if (answer === "y") {
      doCommit(fullMsg);
    } else if (answer === "e") {
      const edited = editWithEditor(fullMsg);
      if (!edited) {
        console.log("Aborted (empty message).");
        process.exit(0);
      }
      doCommit(edited);
    } else {
      console.log("Aborted.");
      process.exit(0);
    }
  });
}

// Programmatic commit for --auto-commit: same file-selection logic as the CLI
// command but skips the interactive prompt. Returns a result object instead of
// calling process.exit so the caller (driver / run command) can handle errors.
//
// Returns:
//   { committed: true,  files, commitHash }  — success
//   { committed: false, files: [], reason: "nothing-to-commit" }  — nothing staged
//   { committed: false, files, reason: string, error: Error }     — git failure
function runCommit(cwd) {
  const changeId = null; // Phase 12.2: in-place mode only
  const pRoot    = pipelineRoot(cwd, changeId);
  const gDir     = gatesDir(cwd, changeId);
  const runStateFilePath = path.join(pRoot, "run-state.json");

  let runState;
  try {
    runState = JSON.parse(fs.readFileSync(runStateFilePath, "utf8"));
  } catch {
    return { committed: false, files: [], reason: "cannot read pipeline/run-state.json" };
  }

  const stagesAdvanced = runState.stages_advanced || [];
  const cursor = ("last_committed_stage_index" in runState)
    ? runState.last_committed_stage_index
    : null;
  const intent = runState.intent || "feature";

  // Stage everything after the cursor (same as CLI without --all).
  const startIdx = cursor === null ? 0 : cursor + 1;
  const toCommit = stagesAdvanced.slice(startIdx);

  if (toCommit.length === 0) {
    return { committed: false, files: [], reason: "nothing-to-commit" };
  }

  // Build file list (mirrors the CLI run() logic exactly).
  const filesToStage = [path.join(pRoot, "run-plan.json")];
  for (const stageId of toCommit) {
    const gateFile = path.join(gDir, `${stageId}.json`);
    if (fs.existsSync(gateFile)) {
      try {
        const gate = JSON.parse(fs.readFileSync(gateFile, "utf8"));
        if (gate.status === "PASS" || gate.status === "WARN") {
          filesToStage.push(gateFile);
        }
      } catch { /* unreadable gate — skip */ }
    }
    for (const absPath of resolveArtifacts(stageId, pRoot, intent)) {
      filesToStage.push(absPath);
    }
  }

  const cwdNorm = cwd.replace(/\\/g, "/").replace(/\/?$/, "/");
  const seen    = new Set();
  const staged  = [];
  for (const absPath of filesToStage) {
    const norm = absPath.replace(/\\/g, "/");
    if (seen.has(norm)) continue;
    seen.add(norm);
    if (!fs.existsSync(absPath)) continue;
    const rel = norm.startsWith(cwdNorm) ? norm.slice(cwdNorm.length) : norm;
    if (isVolatile(rel)) continue;
    staged.push(absPath);
  }

  if (staged.length === 0) {
    return { committed: false, files: [], reason: "nothing-to-commit" };
  }

  const subject  = generateSubject(toCommit, intent);
  const trailer  = `Co-Authored-By: Stagecraft (Claude Sonnet 4.6) <stagecraft@mumit.org>`;
  const fullMsg  = `${subject}\n\n[${toCommit.length} stage${toCommit.length === 1 ? "" : "s"}]\n\n${trailer}`;
  const relFiles = staged.map((p) => path.relative(cwd, p));

  try {
    execFileSync("git", ["add", "--", ...staged], { cwd, stdio: "pipe" });
    execFileSync("git", ["commit", "-m", fullMsg],  { cwd, stdio: "pipe" });
  } catch (err) {
    return { committed: false, files: relFiles, reason: err.message, error: err };
  }

  // Advance cursor to last committed stage.
  try {
    runState.last_committed_stage_index = stagesAdvanced.length - 1;
    fs.writeFileSync(runStateFilePath, JSON.stringify(runState, null, 2));
  } catch { /* best-effort */ }

  let commitHash = "";
  try {
    const { execSync } = require("node:child_process");
    commitHash = execSync("git rev-parse --short HEAD", { cwd }).toString().trim();
  } catch { /* ignore */ }

  return { committed: true, files: relFiles, commitHash };
}

module.exports = { name, flags, run, runCommit };
