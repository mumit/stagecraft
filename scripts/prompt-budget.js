#!/usr/bin/env node
// prompt-budget.js — per-stage framework-file byte/token totals.
//
// "Framework files" are the always-loaded prose a model reads at every
// dispatch: AGENTS.md, rules/ files (via .devteam/rules/ install path),
// and the role brief. Project-dependent pipeline artifacts (pipeline/*)
// and optional runtime files are excluded — their sizes are unknown at
// analysis time and vary per project.
//
// Token estimate: bytes ÷ 4 (stated in the generated output). GPT/Claude
// tokenizers average ~3.5–4 bytes/token for English prose; 4 is the safe
// conservative floor.
//
// Usage:
//   node scripts/prompt-budget.js          # print to stdout
//   node scripts/prompt-budget.js --write  # write docs/reference/prompt-budget.md
//
// Output: docs/reference/prompt-budget.md
//   Fenced with <!-- generated: do not hand-edit --> markers.
//   Embeds a machine-readable <!-- budget-data ... --> block for CI advisory
//   comparisons in scripts/consistency.js.
//
// CI advisory: scripts/consistency.js checkPromptBudgetSync() reads the
//   committed file, regenerates fresh numbers, and warns (advisory severity)
//   when any stage's max-dispatch bytes grew >10%.

"use strict";

const fs   = require("node:fs");
const path = require("node:path");

const ROOT = path.resolve(__dirname, "..");

const { STAGES, ORDERED_STAGE_NAMES } =
  require(path.join(ROOT, "core", "pipeline", "stages.js"));
const { DEFAULT_LIMIT: DEFAULT_CHANGED_MANIFEST_LIMIT } =
  require(path.join(ROOT, "core", "context-manifest.js"));

// ---------------------------------------------------------------------------
// Framework file resolution
// ---------------------------------------------------------------------------

// Map a readFirst entry to a repo-relative path, or null if it should be
// excluded (pipeline artifacts, optional runtime files, unknowns).
function resolveFrameworkFile(item) {
  if (typeof item !== "string") return null; // { path, optional } objects
  if (item.startsWith("pipeline/")) return null; // project runtime artifacts
  if (item === "AGENTS.md") return "AGENTS.md";
  if (item.startsWith(".devteam/rules/")) {
    return item.replace(".devteam/rules/", "rules/");
  }
  // roles/ entries in readFirst would also be framework, but none appear
  // in current stages.js — roles are added per-dispatch, not in readFirst.
  return null;
}

// Byte size of a repo-relative path, or 0 when the file is absent.
function fileBytes(rel) {
  const abs = path.join(ROOT, rel);
  try { return fs.statSync(abs).size; } catch { return 0; }
}

// ---------------------------------------------------------------------------
// Core computation
// ---------------------------------------------------------------------------

// Returns an array of per-stage stats objects (sorted by ORDERED_STAGE_NAMES).
function computeStageStats() {
  const results = [];

  for (const stageName of ORDERED_STAGE_NAMES) {
    const def = STAGES[stageName];
    if (!def) continue;
    // Mechanical stages (roles: []) have no LLM dispatch; no framework budget.
    if (!Array.isArray(def.roles) || def.roles.length === 0) continue;

    // Collect unique framework files for this stage.
    const frameworkMap = new Map(); // relPath → bytes (deduped)
    for (const item of (def.readFirst || [])) {
      const rel = resolveFrameworkFile(item);
      if (!rel || frameworkMap.has(rel)) continue;
      const bytes = fileBytes(rel);
      frameworkMap.set(rel, bytes);
    }
    const frameworkFiles = [...frameworkMap.entries()].map(([file, bytes]) => ({ file, bytes }));
    const frameworkBytes = frameworkFiles.reduce((s, f) => s + f.bytes, 0);

    // Dispatched roles: stages with a `subagent` field dispatch using that
    // role's brief for every area (e.g. peer-review dispatches `reviewer`
    // for each area). Single-role stages have one dispatch.
    const dispatchRole = def.subagent || null;
    const rolesToDispatch = dispatchRole ? [dispatchRole] : def.roles;

    const dispatches = rolesToDispatch.map((role) => {
      const rel = `roles/${role}.md`;
      const bytes = fileBytes(rel);
      return { role, roleFile: rel, roleBytes: bytes, dispatchBytes: frameworkBytes + bytes };
    });

    const maxDispatchBytes = Math.max(...dispatches.map((d) => d.dispatchBytes));

    results.push({
      stageId:          def.stage,
      stageName,
      frameworkFiles,
      frameworkBytes,
      dispatches,
      maxDispatchBytes,
    });
  }

  return results;
}

// ---------------------------------------------------------------------------
// Rendering helpers
// ---------------------------------------------------------------------------

function pad(s, w) { return String(s) + " ".repeat(Math.max(0, w - String(s).length)); }
function fmtBytes(n) { return n.toLocaleString("en-US"); }
function tokEst(bytes) { return Math.ceil(bytes / 4); }

function estimateChangedManifestBytes(limit = DEFAULT_CHANGED_MANIFEST_LIMIT) {
  const header = [
    "## Changed-file manifest (inspect on demand)",
    "Only paths, byte sizes, and SHA-256 digests are preloaded here. Read file contents only when they are relevant to this workstream.",
    "",
  ].join("\n");
  const sampleLine = "- src/example/changed-file-name-with-scope.js (status=M, bytes=12345, sha256:".length
    + 64
    + ")\n".length;
  const truncation = "- ... 999 additional changed file(s) omitted from the prompt; inspect git status if needed.\n".length;
  return header.length + (sampleLine * limit) + truncation;
}

// ---------------------------------------------------------------------------
// Generated block
// ---------------------------------------------------------------------------

const FENCE_OPEN  = "<!-- generated: do not hand-edit -->";
const FENCE_CLOSE = "<!-- /generated -->";

function generateBlock() {
  const stages = computeStageStats();

  // Build the per-stage table.
  // For multi-role stages show one row per dispatch (role) so the reader
  // can see which role brief is the budget driver.
  const tableRows = [];
  for (const s of stages) {
    for (const d of s.dispatches) {
      tableRows.push([
        s.stageId,
        s.stageName,
        d.role,
        fmtBytes(s.frameworkBytes),
        fmtBytes(d.roleBytes),
        fmtBytes(d.dispatchBytes),
        String(tokEst(d.dispatchBytes)),
      ]);
    }
  }

  const headers = ["Stage", "Name", "Role", "Framework B", "Role brief B", "Dispatch B", "Tokens~"];
  const colWidths = headers.map((h, i) =>
    Math.max(h.length, ...tableRows.map((r) => r[i].length))
  );

  const headerLine = "| " + headers.map((h, i) => pad(h, colWidths[i])).join(" | ") + " |";
  const sepLine    = "| " + colWidths.map((w) => "-".repeat(w)).join(" | ") + " |";
  const dataLines  = tableRows.map((row) =>
    "| " + row.map((cell, i) => pad(cell, colWidths[i])).join(" | ") + " |"
  );

  // Top-5 heaviest framework files (deduplicated across all stages).
  const fileMap = new Map();
  for (const s of stages) {
    for (const f of s.frameworkFiles) {
      if (!fileMap.has(f.file) || fileMap.get(f.file) < f.bytes) {
        fileMap.set(f.file, f.bytes);
      }
    }
    // Also include each unique role brief.
    for (const d of s.dispatches) {
      if (!fileMap.has(d.roleFile) || fileMap.get(d.roleFile) < d.roleBytes) {
        fileMap.set(d.roleFile, d.roleBytes);
      }
    }
  }
  const top5 = [...fileMap.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, 5)
    .map(([file, bytes]) => [file, fmtBytes(bytes), String(tokEst(bytes))]);

  const t5Headers  = ["File", "Bytes", "Tokens~"];
  const t5Widths   = t5Headers.map((h, i) =>
    Math.max(h.length, ...top5.map((r) => r[i].length))
  );
  const t5Header   = "| " + t5Headers.map((h, i) => pad(h, t5Widths[i])).join(" | ") + " |";
  const t5Sep      = "| " + t5Widths.map((w) => "-".repeat(w)).join(" | ") + " |";
  const t5Lines    = top5.map((row) =>
    "| " + row.map((cell, i) => pad(cell, t5Widths[i])).join(" | ") + " |"
  );

  // Machine-readable budget-data block consumed by consistency.js advisory.
  // Format: one line per stage — "<stageId>,<maxDispatchBytes>"
  const budgetDataLines = stages.map((s) => `${s.stageId},${s.maxDispatchBytes}`);
  const budgetDataBlock = `<!-- budget-data\n${budgetDataLines.join("\n")}\n-->`;
  const manifestBytes = estimateChangedManifestBytes();

  const BT = "`"; // backtick — avoids template-literal escaping issues
  return [
    FENCE_OPEN,
    "<!-- To regenerate: npm run docs:generate (source: core/pipeline/stages.js + rules/ + roles/) -->",
    "",
    "# Prompt Budget Reference",
    "",
    `Framework prose loaded by every model dispatch — derived from ${BT}readFirst${BT} arrays in`,
    `${BT}core/pipeline/stages.js${BT}. **Token estimate: bytes ÷ 4** (conservative floor; GPT/Claude`,
    "tokenizers average ~3.5–4 bytes/token for English prose).",
    "",
    `**Included:** ${BT}AGENTS.md${BT}, ${BT}rules/${BT} files mapped from ${BT}.devteam/rules/${BT}, and the role brief`,
    "for each dispatched role.",
    `**Excluded:** ${BT}pipeline/*${BT} artifacts (project-dependent, unknown at analysis time).`,
    "",
    `Run ${BT}npm run docs:generate${BT} to regenerate after editing stages.js, rules/, or roles/.`,
    "",
    "## Per-dispatch framework cost",
    "",
    "Multi-role stages appear once per dispatched role. The CI advisory",
    `(${BT}npm run consistency${BT}) warns when any stage's max-dispatch bytes grow >10%.`,
    "",
    headerLine,
    sepLine,
    ...dataLines,
    "",
    `## Top 5 heaviest framework files`,
    "",
    t5Header,
    t5Sep,
    ...t5Lines,
    "",
    "## Advisory file-size ceilings",
    "",
    `${BT}scripts/consistency.js${BT} emits advisories when these ceilings are exceeded.`,
    "Advisories are non-blocking (they print but do not fail CI).",
    "",
    `| File class         | Ceiling |`,
    `| ------------------ | ------- |`,
    `| Role brief         | 16 KB   |`,
    `| Stage rule file    | 8 KB    |`,
    `| AGENTS.md          | 10 KB   |`,
    "",
    "## Runtime changed-file manifest",
    "",
    "Each dispatch may also include a compact changed-file manifest with paths, byte sizes,",
    "and SHA-256 digests only. It is intentionally excluded from the framework growth guard",
    "because it is project/runtime dependent, but it is bounded and measurable.",
    "",
    `| Limit | Estimated bytes | Tokens~ |`,
    `| ----- | --------------- | ------- |`,
    `| ${DEFAULT_CHANGED_MANIFEST_LIMIT} files | ${fmtBytes(manifestBytes)} | ${tokEst(manifestBytes)} |`,
    "",
    "This replaces eager changed-file content loading: agents inspect file bodies on demand",
    "when the manifest shows a relevant path or digest change.",
    "",
    budgetDataBlock,
    FENCE_CLOSE,
  ].join("\n");
}

// ---------------------------------------------------------------------------
// Machine-readable data parser (for consistency.js advisory)
// ---------------------------------------------------------------------------

// Parse a committed prompt-budget.md and return Map<stageId, maxDispatchBytes>.
// Returns an empty Map when the file has no budget-data block.
function parseCommittedBudget(text) {
  const m = text.match(/<!-- budget-data\n([\s\S]*?)\n-->/);
  if (!m) return new Map();
  const map = new Map();
  for (const line of m[1].split("\n")) {
    const parts = line.split(",");
    if (parts.length === 2) {
      const [stageId, bytes] = parts;
      const n = parseInt(bytes, 10);
      if (!isNaN(n)) map.set(stageId.trim(), n);
    }
  }
  return map;
}

// ---------------------------------------------------------------------------
// CLI
// ---------------------------------------------------------------------------

if (require.main === module) {
  const args = process.argv.slice(2);

  if (args.includes("--write")) {
    const outPath = path.join(ROOT, "docs", "reference", "prompt-budget.md");
    fs.mkdirSync(path.dirname(outPath), { recursive: true });
    fs.writeFileSync(outPath, generateBlock() + "\n");
    console.log("Wrote docs/reference/prompt-budget.md");
  } else {
    console.log(generateBlock());
  }
}

module.exports = {
  computeStageStats,
  estimateChangedManifestBytes,
  generateBlock,
  parseCommittedBudget,
  FENCE_OPEN,
  FENCE_CLOSE,
};
