#!/usr/bin/env node
// generate-stages-ref.js
//
// Emits docs/reference/stages.md — a stage table (ID, name, roles,
// conditionalOn, gate file, artifact, template) grouped by pipeline phase,
// derived from STAGES/ORDERED_STAGE_NAMES in core/pipeline/stages.js.
// Output is fenced with <!-- generated: do not hand-edit --> markers;
// scripts/consistency.js verifies the committed file equals fresh output.
//
// Usage:
//   node scripts/generate-stages-ref.js          # print to stdout
//   node scripts/generate-stages-ref.js --write  # write docs/reference/stages.md

"use strict";

const fs   = require("node:fs");
const path = require("node:path");

const ROOT = path.resolve(__dirname, "..");

const { STAGES, ORDERED_STAGE_NAMES } = require(path.join(ROOT, "core", "pipeline", "stages.js"));

// ── Phase definitions (derived from stage-ID prefix ranges) ─────────────────
const PHASES = [
  {
    label: "Phase 1 — Planning",
    stageIds: ["stage-01", "stage-02", "stage-03", "stage-03b"],
  },
  {
    label: "Phase 2 — Build",
    stageIds: ["stage-04", "stage-04a", "stage-04b", "stage-04c", "stage-04d", "stage-04e"],
  },
  {
    label: "Phase 3 — Peer Review",
    stageIds: ["stage-05"],
  },
  {
    label: "Phase 4 — Verification",
    stageIds: ["stage-06", "stage-06b", "stage-06c", "stage-06d", "stage-06e"],
  },
  {
    label: "Phase 5 — Delivery",
    stageIds: ["stage-07", "stage-08", "stage-09"],
  },
];

// Build a lookup: stageId → stageName (the key in STAGES object)
function buildIdToNameMap() {
  const map = {};
  for (const [name, def] of Object.entries(STAGES)) {
    if (def) map[def.stage] = name;
  }
  return map;
}

// Derive the gate file pattern for a stage definition.
// Multi-role stages produce per-workstream gates + merged gate.
function gateFileFor(name, def) {
  const id = def.stage;
  // Mechanical stage (roles: []) — only the stage gate
  if (!def.roles || def.roles.length === 0) return `${id}.json`;
  // Multi-role with roleWrites → per-workstream gates
  if (def.roleWrites) {
    const roles = Object.keys(def.roleWrites).join(", ");
    return `${id}.json` + ` (merged); ${id}.{${roles}}.json (per-workstream)`;
  }
  // peer-review uses subagent but also has per-area workstream gates
  if (def.subagent && def.roles.length > 1) {
    const roles = [...def.roles, ...((def.optionalRoles) || [])].join(", ");
    return `${id}.json` + ` (merged); ${id}.{${roles}}.json (per-area)`;
  }
  return `${id}.json`;
}

// Format conditionalOn for display
function conditionalOnText(def) {
  if (!def.conditionalOn) return "—";
  const c = def.conditionalOn;
  return `${c.stage}.${c.field} = ${c.equals}`;
}

// Format roles for display, noting mechanical stages
function rolesText(def) {
  if (!def.roles || def.roles.length === 0) return "*(mechanical — no dispatch)*";
  const optional = Array.isArray(def.optionalRoles) && def.optionalRoles.length > 0
    ? `; optional: ${def.optionalRoles.join(", ")}`
    : "";
  if (def.subagent) return `${def.roles.join(", ")}${optional} *(dispatched as ${def.subagent})*`;
  return `${def.roles.join(", ")}${optional}`;
}

// Pad a string to at least `width` characters
function pad(s, width) {
  return s + " ".repeat(Math.max(0, width - s.length));
}

// ── Render ───────────────────────────────────────────────────────────────────
function renderTable() {
  const idToName = buildIdToNameMap();
  const lines = [];

  for (const phase of PHASES) {
    lines.push(`### ${phase.label}`);
    lines.push("");

    // Collect rows for stages in this phase
    const rows = [];
    const headers = ["Stage ID", "Name", "Roles", "Conditional on", "Gate file(s)", "Artifact", "Template"];

    for (const stageId of phase.stageIds) {
      const stageName = idToName[stageId];
      if (!stageName) continue; // stage not in STAGES (future-proof)
      const def = STAGES[stageName];
      if (!def) continue;

      rows.push([
        stageId,
        stageName,
        rolesText(def),
        conditionalOnText(def),
        gateFileFor(stageName, def),
        def.artifact || "—",
        def.template  || "—",
      ]);
    }

    if (rows.length === 0) {
      lines.push("*(no stages in this phase)*");
      lines.push("");
      continue;
    }

    // Compute column widths
    const widths = headers.map((h, i) =>
      Math.max(h.length, ...rows.map(r => r[i].length))
    );

    // Header row
    lines.push("| " + headers.map((h, i) => pad(h, widths[i])).join(" | ") + " |");
    lines.push("| " + widths.map(w => "-".repeat(w)).join(" | ") + " |");

    // Data rows
    for (const row of rows) {
      lines.push("| " + row.map((cell, i) => pad(cell, widths[i])).join(" | ") + " |");
    }
    lines.push("");
  }

  return lines.join("\n");
}

const FENCE_OPEN  = "<!-- generated: do not hand-edit -->";
const FENCE_CLOSE = "<!-- /generated -->";

// Stage count derived from ORDERED_STAGE_NAMES (excludes mechanical preflight)
const STAGE_COUNT = ORDERED_STAGE_NAMES.length;

function generateBlock() {
  const header = [
    FENCE_OPEN,
    `<!-- To regenerate: npm run docs:generate (source: core/pipeline/stages.js) -->`,
    "",
    `# Stage Reference`,
    "",
    `Derived from \`core/pipeline/stages.js\`. ${STAGE_COUNT} stages total (including all sub-stages).`,
    `Run \`npm run docs:generate\` to regenerate after editing stages.js.`,
    "",
    `**Conditional stages** only run when a specific field in a prior stage's gate is set.`,
    `**Mechanical stages** (roles: none) are auto-run by the orchestrator, not dispatched to an LLM.`,
    "",
    `**Gate file conventions:** workstream gates use a dot separator (\`stage-NN.role.json\`),`,
    `not a dash (\`stage-NN-role.json\`). See \`core/hooks/approval-derivation.js\` for the spec.`,
    "",
    renderTable(),
    FENCE_CLOSE,
  ].join("\n");
  return header;
}

// ── CLI ───────────────────────────────────────────────────────────────────
if (require.main === module) {
  const args = process.argv.slice(2);

  if (args.includes("--write")) {
    const outPath = path.join(ROOT, "docs", "reference", "stages.md");
    fs.mkdirSync(path.dirname(outPath), { recursive: true });
    fs.writeFileSync(outPath, generateBlock() + "\n");
    console.log("Wrote docs/reference/stages.md");
  } else {
    console.log(generateBlock());
  }
}

module.exports = { generateBlock, FENCE_OPEN, FENCE_CLOSE, STAGE_COUNT };
