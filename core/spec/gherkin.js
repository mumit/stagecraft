// gherkin.js — minimal Gherkin reader for executable-spec verification.
//
// G2 uses Gherkin as the bridge between feature acceptance criteria or
// repair regression criteria and QA's tests. We don't execute the Gherkin — execution would
// require step-definition wiring per project. We only need enough
// structure to verify the chain:
//
//   AC-N/RC-N source  →  Scenario in spec.feature  →  test in
//                                                      test-report.md
//
// What this parser recognizes:
//   - `Feature: <name>` — at most one per file (we accept multiple
//     but verify.js treats them all as one bag of scenarios).
//   - `Scenario: <name>` or `Scenario Outline: <name>` — produces one
//     scenario record. Outlines collapse to a single scenario for
//     mapping purposes (the Examples table doesn't generate distinct
//     IDs in the brief).
//   - `Given/When/Then/And/But <step>` — captured as text steps. We
//     do NOT validate that every Given is followed by a When etc;
//     that's a separate (optional) lint.
//   - Tags `@tag` above a Scenario — captured to support optional
//     `@AC-1` style cross-referencing when the scenario name itself
//     doesn't carry the AC ID.
//   - Comments (`#`) and blank lines — ignored.
//
// Out of scope:
//   - Doc strings (""" ... """), data tables, Examples tables, Rule:
//     blocks. Real-world specs use them, and we tolerate their
//     presence (they're skipped), but verification only looks at
//     scenario names + tags.
//   - Internationalization (Funktion:, Szenario:, ...). English only.

"use strict";

const fs = require("node:fs");

const SCENARIO_RE   = /^\s*Scenario(?:\s+Outline)?:\s*(.+?)\s*$/;
const FEATURE_RE    = /^\s*Feature:\s*(.+?)\s*$/;
const STEP_RE       = /^\s*(Given|When|Then|And|But)\s+(.+?)\s*$/;
const TAG_LINE_RE   = /^\s*(@\S+(?:\s+@\S+)*)\s*$/;
const COMMENT_RE    = /^\s*#/;
const BLANK_RE      = /^\s*$/;
// Embedded `@AC-3` / `@RC-1` tokens in a scenario *name*. Allowed as fallback when the
// author doesn't use proper tag lines.
const INLINE_CRITERION_TAG_RE = /@((?:AC|RC)-\d+)/g;

// Parse Gherkin source text into a structured representation.
// Returns: { features: [{ name, scenarios: [{ name, tags, steps,
//                                              line }] }] }
// If no Feature: line is found but Scenarios exist, they are
// attached to a synthetic feature with empty name (some specs omit
// the Feature: header when the file itself is named after the
// feature). verify.js treats this as legal.
function parse(text) {
  const lines = text.split(/\r?\n/);
  const features = [];
  let currentFeature = null;
  let pendingTags = [];
  let currentScenario = null;

  function flushScenario() {
    if (currentScenario) {
      currentScenario = null;
    }
  }

  function ensureFeature() {
    if (!currentFeature) {
      currentFeature = { name: "", scenarios: [] };
      features.push(currentFeature);
    }
    return currentFeature;
  }

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];

    if (COMMENT_RE.test(line) || BLANK_RE.test(line)) continue;

    let m;
    if ((m = line.match(FEATURE_RE))) {
      flushScenario();
      pendingTags = [];
      currentFeature = { name: m[1], scenarios: [] };
      features.push(currentFeature);
      continue;
    }

    if ((m = line.match(SCENARIO_RE))) {
      flushScenario();
      const feature = ensureFeature();
      const name = m[1];
      // Pull @AC-N/@RC-N tokens from the scenario name as fallback tags.
      const inlineAcs = [];
      let acMatch;
      INLINE_CRITERION_TAG_RE.lastIndex = 0;
      while ((acMatch = INLINE_CRITERION_TAG_RE.exec(name))) {
        inlineAcs.push("@" + acMatch[1]);
      }
      currentScenario = {
        name,
        tags: [...pendingTags, ...inlineAcs],
        steps: [],
        line: i + 1,
      };
      feature.scenarios.push(currentScenario);
      pendingTags = [];
      continue;
    }

    if ((m = line.match(STEP_RE))) {
      if (currentScenario) {
        currentScenario.steps.push({ keyword: m[1], text: m[2] });
      }
      continue;
    }

    if ((m = line.match(TAG_LINE_RE))) {
      // Multiple tags on one line: `@smoke @AC-3`
      const tags = m[1].split(/\s+/).filter(Boolean);
      pendingTags.push(...tags);
      continue;
    }

    // Unknown line — pendingTags carry forward until a Scenario
    // consumes them OR another keyword resets them. Don't reset on
    // arbitrary content; that would lose tags split by a description
    // line under a Feature: block.
  }

  return { features };
}

function parseFile(filePath) {
  const text = fs.readFileSync(filePath, "utf8");
  return parse(text);
}

// Flatten every scenario across every feature into a single array.
// Mapping logic doesn't care which Feature: block a scenario lives
// under — only that the scenario exists.
function allScenarios(spec) {
  const out = [];
  for (const f of spec.features) {
    for (const s of f.scenarios) out.push(s);
  }
  return out;
}

// Extract criterion IDs referenced by a scenario. Feature-mode criteria use
// AC-N; repair-mode regression criteria use RC-N.
// Returns an array (often one element, occasionally many — one
// scenario may cover several criteria).
function acIdsFor(scenario) {
  const ids = new Set();
  for (const tag of scenario.tags || []) {
    const m = tag.match(/^@?((?:AC|RC)-\d+)$/);
    if (m) ids.add(m[1]);
  }
  const name = scenario.name || "";
  let m;
  const re = /\b(?:AC|RC)-\d+\b/g;
  while ((m = re.exec(name))) ids.add(m[0]);
  return Array.from(ids);
}

module.exports = { parse, parseFile, allScenarios, acIdsFor };
