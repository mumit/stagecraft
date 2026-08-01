#!/usr/bin/env node
// generate-tracks-matrix.js
//
// Emits the "What each track runs" matrix for docs/tracks.md from
// STAGES_BY_TRACK in core/pipeline/stages.js.  The output is fenced with
// "<!-- generated: do not hand-edit -->" markers; scripts/consistency.js
// verifies that the committed block equals what this script would produce.
//
// Usage:
//   node scripts/generate-tracks-matrix.js          # print to stdout
//   node scripts/generate-tracks-matrix.js --write  # write to docs/tracks.md in-place

"use strict";

const fs   = require("node:fs");
const path = require("node:path");

const ROOT = path.resolve(__dirname, "..");

const { STAGES_BY_TRACK } = require(path.join(ROOT, "core", "pipeline", "stages.js"));

// ── Column abbreviations ────────────────────────────────────────────────────
// A two-or-three character label per stage for the matrix columns.
const ABBREVS = {
  "requirements":           "req",
  "design":                 "des",
  "clarification":          "cla",
  "executable-spec":        "3b",
  "build":                  "bld",
  "pre-review":             "4a",
  "security-review":        "4b",
  "red-team":               "4c",
  "migration-safety":       "4d",
  "preflight":              "4e",
  "peer-review":            "5",
  "qa":                     "qa",
  "accessibility-audit":    "6b",
  "observability-gate":     "6c",
  "verification-beyond-tests": "6d",
  "performance-budget":     "6e",
  "sign-off":               "7",
  "deploy":                 "8",
  "retrospective":          "9",
};

// ── Full ordered stage list (source of truth from stages.js) ─────────────────
// We use ORDERED_STAGE_NAMES plus preflight (which is in STAGES but skipped in
// orderedStageNames because roles:[]).
const { ORDERED_STAGE_NAMES } = require(path.join(ROOT, "core", "pipeline", "stages.js"));

// Build the complete column list from ORDERED_STAGE_NAMES.
// "preflight" (stage-04e) is excluded: it is not in STAGES_BY_TRACK for any
// track because it runs automatically as part of "devteam stage peer-review",
// not as an independent LLM dispatch. Including it would produce an all-blank
// column that is more confusing than helpful.
const seen = new Set();
const COLS = ORDERED_STAGE_NAMES.filter(n => { if (seen.has(n)) return false; seen.add(n); return true; });

const TRACKS = Object.keys(STAGES_BY_TRACK);

// ── Symbol logic ─────────────────────────────────────────────────────────────
function symbol(track, stageName) {
  const list = STAGES_BY_TRACK[track] || [];
  if (!list.includes(stageName)) return " ";

  // Conditional stages
  if (stageName === "security-review" || stageName === "migration-safety") {
    return "✓⁺";
  }

  // Nano peer-review is scoped (single reviewer). Loop's build and
  // peer-review are both scoped to a single config-overridable workstream
  // (29.1).
  if (stageName === "peer-review" && (track === "nano" || track === "loop")) {
    return "✓ˢ";
  }
  if (stageName === "build" && track === "loop") {
    return "✓ˢ";
  }

  // Preflight is a script (no LLM dispatch), mark with ✓ᵐ
  if (stageName === "preflight") {
    return "✓ᵐ";
  }

  return "✓";
}

// ── Build column header widths ─────────────────────────────────────────────
function abbrFor(name) { return ABBREVS[name] || name.slice(0, 3); }

const MAX_TRACK_LEN = Math.max(...TRACKS.map(t => t.length));
const COL_PAD = 4; // padding per column cell

// ── Render ─────────────────────────────────────────────────────────────────
function renderMatrix() {
  const lines = [];

  // Header row
  const headerCells = COLS.map(n => abbrFor(n).padEnd(COL_PAD));
  lines.push((" ".repeat(MAX_TRACK_LEN + 3)) + headerCells.join(""));

  // One row per track
  for (const track of TRACKS) {
    const cells = COLS.map(n => symbol(track, n).padEnd(COL_PAD));
    const prefix = track.padEnd(MAX_TRACK_LEN + 3);
    lines.push(prefix + cells.join(""));
  }

  // Legend
  lines.push("");
  lines.push("   Legend:");
  lines.push("   ✓⁺ = conditional stage — only runs when stage-04a triggers it");
  lines.push("       (security-review: security_review_required; migration-safety: migration_safety_required)");
  lines.push("   ✓ˢ = scoped to a single workstream — nano peer-review (single reviewer,");
  lines.push("       required_approvals=1); loop build + peer-review (single config-overridable");
  lines.push("       role, default backend). See PEER_REVIEW_SIZING / loopBuildRole in");
  lines.push("       core/pipeline/stages.js.");
  lines.push("   ✓ᵐ = mechanical script (preflight/stage-04e), not an LLM dispatch.");
  lines.push("   3b = executable-spec (Gherkin scenarios from acceptance criteria)");
  lines.push("   4a = pre-review (lint + dep review + SCA + trigger heuristics)");
  lines.push("   4b = security review (conditional; veto power)");
  lines.push("   4c = red-team adversarial review");
  lines.push("   4d = migration-safety review (conditional; veto power)");
  lines.push("   4e = preflight mechanical checks");
  lines.push("   6b = accessibility audit (axe-core / pa11y / lighthouse)");
  lines.push("   6c = observability gate (verify brief §9 signals ship)");
  lines.push("   6d = verification beyond tests (property-based / mutation / formal; full only)");
  lines.push("   6e = performance budget (Lighthouse / bundle / load test)");

  return lines.join("\n");
}

const FENCE_OPEN  = "<!-- generated: do not hand-edit -->";
const FENCE_CLOSE = "<!-- /generated -->";

function generateBlock() {
  return `${FENCE_OPEN}\n\`\`\`\n${renderMatrix()}\n\`\`\`\n${FENCE_CLOSE}`;
}

// ── CLI ───────────────────────────────────────────────────────────────────
if (require.main === module) {
  const args = process.argv.slice(2);

  if (args.includes("--write")) {
    const tracksPath = path.join(ROOT, "docs", "tracks.md");
    const src = fs.readFileSync(tracksPath, "utf8");
    const fenceRe = new RegExp(
      `${escapeRe(FENCE_OPEN)}[\\s\\S]*?${escapeRe(FENCE_CLOSE)}`, "g"
    );
    const block = generateBlock();
    const updated = fenceRe.test(src)
      ? src.replace(fenceRe, block)
      : src.replace(
          /^## What each track runs\s*\n```[\s\S]*?```/m,
          `## What each track runs\n\n${block}`
        );
    if (updated === src) {
      console.error("ERROR: could not find the matrix block to replace in docs/tracks.md");
      process.exit(1);
    }
    fs.writeFileSync(tracksPath, updated);
    console.log("Updated docs/tracks.md");
  } else {
    console.log(generateBlock());
  }
}

function escapeRe(s) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

module.exports = { generateBlock, renderMatrix, FENCE_OPEN, FENCE_CLOSE };
