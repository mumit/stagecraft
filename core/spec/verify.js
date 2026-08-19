// verify.js — drift detection across a criteria source, spec.feature,
// and test-report.md. Feature runs use brief.md/AC-N; repair runs use
// diagnosis.md/RC-N. This is the engine behind:
//
//   - `devteam spec verify`            (CLI surface)
//   - stage-03b's gate computation     (orchestrator)
//   - stage-06's tighter mapping check (extends 1:1 criterion→test
//                                       with scenarios in the middle)
//
// The premise of G2: three artifacts must stay in sync, and any
// drift between them should be caught structurally rather than by
// hoping a human notices.
//
//   criteria source       spec.feature       test-report.md
//   ───────────────       ────────────       ──────────────
//   AC-1/RC-1: text  →    Scenario @ID   →   row referencing ID
//   AC-2/RC-2: text  →    Scenario @ID   →   row referencing ID
//   ...
//
// What's drift:
//   - AC in brief but no scenario in spec        → orphan_criteria
//   - Scenario in spec but no AC in brief        → orphan_scenarios
//   - AC in brief but no test row in report      → orphan_in_tests
//   - Test row referencing AC that isn't in brief→ unknown_in_tests
//
// What's NOT drift (by design):
//   - One AC mapped by multiple scenarios — sometimes a criterion
//     has multiple paths to verify; we record the count but don't
//     fail.
//   - A scenario that names multiple ACs (split across "and") —
//     valid for shared setup.
//   - Trailing whitespace, blank ACs, comment-only lines.
//
// The verifier is artifact-driven; it doesn't reach into the
// pipeline state. Give it paths or text strings and it produces a
// report. The CLI and the orchestrator both wrap it.

"use strict";

const fs = require("node:fs");
const path = require("node:path");
const { parse: parseGherkin, allScenarios, acIdsFor } = require("./gherkin");

// Extracts numbered AC IDs from a brief.md body. The canonical form
// is a line starting with `AC-N` (case-insensitive), e.g.:
//
//   - AC-1: Users can sign in with email + password.
//   - AC-2 — Password reset link expires in 15 minutes.
//   * AC-3. Invalid credentials show a generic error.
//
// We tolerate these surroundings (bullet markers, optional bold
// markdown wrapping, optional colon/dash, indentation) because real
// briefs have stylistic variation. We require ACs to be uniquely
// numbered — duplicates surface as a dedicated drift type.
//
// Supported formats:
//   - AC-1: Users can sign in.         (dash bullet + bare)
//   - **AC-2** — Password reset.       (dash bullet + bold)
//   **AC-3**: Invalid creds.           (bold, no bullet)
//   AC-4 — Something else.             (bare, no bullet)
//   1. **AC-5** — Numbered list.       (numbered list + bold)
//   1. AC-6: Numbered list bare.       (numbered list + bare)
//   **AC-7** `[deploy-deferred]` — ... (inline backtick annotation before separator)
const AC_LINE_RE = /^\s*(?:\d+\.\s+|[-*+]\s+)?\*{0,2}(AC-\d+)\b\*{0,2}(?:\s+`[^`]+`)?\s*[.:\-—]\s*(.+?)\s*$/;
const RC_LINE_RE = /^\s*(?:\d+\.\s+|[-*+]\s+)?\*{0,2}(RC-\d+)\b\*{0,2}\s*[.:\-—]\s*(.+?)\s*$/;

// When a brief uses a dedicated "Acceptance Criteria" section header,
// extraction is scoped to that section. This prevents AC references in
// other sections (e.g. Observability, SLO notes) from registering as
// duplicate definitions. Falls back to whole-document scan when no
// header is found (backwards-compatible with headerless briefs).
//
// The optional prefix handles common numbering styles:
//   ## Acceptance Criteria            (no prefix)
//   ## §3 Acceptance Criteria         (§N prefix)
//   ## 3. Acceptance Criteria         (N. prefix)
//   ## 3 Acceptance Criteria          (N prefix)
const AC_SECTION_RE = /^\s*#{1,6}\s+(?:\S+\s+)?acceptance\s+criteria\b/i;
const ANY_HEADER_RE = /^\s*#{1,6}\s+/;

function extractAcsFromBrief(text) {
  const ids = [];
  const byId = new Map();
  const duplicates = [];
  const lines = text.split(/\r?\n/);
  let inSection = false;
  let sectionFound = false;
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (AC_SECTION_RE.test(line)) {
      inSection = true;
      sectionFound = true;
      continue; // header line itself never contains an AC definition
    }
    if (sectionFound && ANY_HEADER_RE.test(line)) {
      inSection = false;
      continue; // next section started; header line is not a definition
    }
    if (sectionFound && !inSection) continue; // between sections — skip
    const m = line.match(AC_LINE_RE);
    if (!m) continue;
    const id = m[1];
    const body = (m[2] || "").trim();
    if (byId.has(id)) {
      duplicates.push({ id, line: i + 1 });
      continue;
    }
    byId.set(id, { id, body, line: i + 1 });
    ids.push(id);
  }
  return { ids, byId, duplicates };
}

function extractRcsFromDiagnosis(text) {
  const ids = [];
  const byId = new Map();
  const duplicates = [];
  const lines = String(text || "").split(/\r?\n/);

  for (let i = 0; i < lines.length; i++) {
    const match = lines[i].match(RC_LINE_RE);
    if (!match) continue;
    const id = match[1];
    if (byId.has(id)) {
      duplicates.push({ id, line: i + 1 });
      continue;
    }
    byId.set(id, { id, body: match[2].trim(), line: i + 1 });
    ids.push(id);
  }

  if (ids.length === 0) {
    const heading = lines.findIndex((line) => /^\s*##\s+Regression\s+Criterion\b/i.test(line));
    if (heading >= 0) {
      const bodyLines = [];
      for (let i = heading + 1; i < lines.length && !/^\s*##\s+/.test(lines[i]); i++) {
        const value = lines[i].replace(/^\s*>\s?/, "").trim();
        if (value) bodyLines.push(value);
      }
      if (bodyLines.length > 0) {
        const body = bodyLines.join(" ");
        ids.push("RC-1");
        byId.set("RC-1", { id: "RC-1", body, line: heading + 2 });
      }
    }
  }

  return { ids, byId, duplicates };
}

// Extracts criterion IDs referenced anywhere in a test-report.md body.
// Looks for tagged or bare AC-N/RC-N tokens; either form
// counts as a reference. Returns a Map<id, lineNumbers[]> so a
// duplicate/test-count can be reported.
function extractAcRefsFromTestReport(text) {
  const refs = new Map();
  const lines = text.split(/\r?\n/);
  const RE = /\b(?:AC|RC)-\d+\b/g;
  for (let i = 0; i < lines.length; i++) {
    let m;
    RE.lastIndex = 0;
    while ((m = RE.exec(lines[i]))) {
      const id = m[0];
      if (!refs.has(id)) refs.set(id, []);
      refs.get(id).push(i + 1);
    }
  }
  return refs;
}

// Read an artifact relative to cwd, returning "" if missing. Verify
// treats "missing" and "empty" the same — both produce the
// "everything is an orphan" drift report.
function readArtifact(filePath) {
  if (!fs.existsSync(filePath)) return null;
  return fs.readFileSync(filePath, "utf8");
}

// Compute the drift report from three (already-loaded) artifact
// bodies. `briefText` is the legacy API name for either criteria source;
// it and `specText` are required for any useful
// output; `testText` is optional — if absent (e.g. before QA has
// written test-report.md), the test-side checks degrade to "not
// yet computed" rather than erroring.
function verifyTexts({ briefText, specText, testText, opts = {} }) {
  const report = {
    criteria: [],
    scenarios: [],
    test_refs: [],
    orphan_criteria: [],       // in criteria source, no scenario
    orphan_scenarios: [],      // in spec, no known criterion
    orphan_in_tests: [],       // in criteria source, no test row reference
    unknown_in_tests: [],      // test row references an unknown criterion
    duplicate_criteria: [],    // same criterion ID appears twice
    multi_mapped_criteria: [], // criterion with > 1 scenario (informational)
    drift: false,
    test_phase_complete: testText != null && testText.trim().length > 0,
  };

  // -- Criteria ------------------------------------------------------
  let briefIds = [];
  const briefById = new Map();
  if (briefText != null) {
    const extractor = opts.criteriaSource === "diagnosis" ? extractRcsFromDiagnosis : extractAcsFromBrief;
    const { ids, byId, duplicates } = extractor(briefText);
    briefIds = ids;
    for (const [k, v] of byId.entries()) briefById.set(k, v);
    for (const d of duplicates) report.duplicate_criteria.push(d);
    report.criteria = ids;
  }

  // -- Scenarios -----------------------------------------------------
  const scenarioById = new Map(); // criterion ID -> Scenario[]
  const criterionIdsByScenario = new Map();
  let scenarios = [];
  if (specText != null) {
    const parsed = parseGherkin(specText);
    scenarios = allScenarios(parsed);
    for (const sc of scenarios) {
      let ids = acIdsFor(sc);
      if (
        ids.length === 0 &&
        opts.criteriaSource === "diagnosis" &&
        briefIds.length === 1 &&
        scenarios.length === 1 &&
        (sc.tags || []).includes("@regression")
      ) {
        ids = [briefIds[0]];
      }
      criterionIdsByScenario.set(sc, ids);
      if (ids.length === 0) {
        report.orphan_scenarios.push({ name: sc.name, line: sc.line });
        continue;
      }
      for (const id of ids) {
        if (!scenarioById.has(id)) scenarioById.set(id, []);
        scenarioById.get(id).push({ name: sc.name, line: sc.line });
      }
    }
    report.scenarios = scenarios.map((s) => ({
      name: s.name,
      tags: s.tags,
      ac_ids: criterionIdsByScenario.get(s) || [],
      line: s.line,
    }));
  }

  // -- Criteria→spec drift -------------------------------------------
  for (const id of briefIds) {
    if (!scenarioById.has(id)) {
      report.orphan_criteria.push({
        id,
        body: briefById.get(id)?.body || "",
        line: briefById.get(id)?.line || 0,
      });
    } else if (scenarioById.get(id).length > 1) {
      report.multi_mapped_criteria.push({
        id,
        scenarios: scenarioById.get(id).map((s) => s.name),
      });
    }
  }

  // -- Spec→criteria drift (orphan_scenarios catches the rest) -------
  for (const [id, list] of scenarioById.entries()) {
    if (!briefById.has(id)) {
      for (const sc of list) {
        report.orphan_scenarios.push({ name: sc.name, line: sc.line, missing_ac: id });
      }
    }
  }

  // -- Test-report side ----------------------------------------------
  if (report.test_phase_complete && !opts.skipTestPhase) {
    const testRefs = extractAcRefsFromTestReport(testText);
    report.test_refs = Array.from(testRefs.keys());
    for (const id of briefIds) {
      if (!testRefs.has(id)) {
        report.orphan_in_tests.push({ id });
      }
    }
    for (const id of testRefs.keys()) {
      if (!briefById.has(id)) {
        report.unknown_in_tests.push({ id, lines: testRefs.get(id) });
      }
    }
  }

  report.drift =
    report.orphan_criteria.length > 0 ||
    report.orphan_scenarios.length > 0 ||
    report.orphan_in_tests.length > 0 ||
    report.unknown_in_tests.length > 0 ||
    report.duplicate_criteria.length > 0;

  // multi_mapped_criteria is informational; opt-in flag can promote
  // it to drift (some teams want strict 1:1).
  if (opts.strictMapping && report.multi_mapped_criteria.length > 0) {
    report.drift = true;
  }

  return report;
}

// File-path wrapper for the common case. Returns the same drift
// report shape, with file-not-found promoted to "this artifact is
// missing" markers in the report.
//
// opts.pipelineDir overrides the default `cwd/pipeline` root so that
// bounded-mode callers (B9, item 5.4) can point at the per-change subtree.
function verify(cwd, opts = {}) {
  const pipelineDir = opts.pipelineDir || path.join(cwd, "pipeline");
  const briefPath = path.join(pipelineDir, "brief.md");
  const diagnosisPath = path.join(pipelineDir, "diagnosis.md");
  const specPath  = path.join(pipelineDir, "spec.feature");
  const testPath  = path.join(pipelineDir, "test-report.md");

  const briefText = readArtifact(briefPath);
  const diagnosisText = readArtifact(diagnosisPath);
  const specText  = readArtifact(specPath);
  const testText  = readArtifact(testPath);

  const criteriaSource = briefText != null ? "brief" : diagnosisText != null ? "diagnosis" : "brief";
  const criteriaText = briefText != null ? briefText : diagnosisText;
  const report = verifyTexts({
    briefText: criteriaText,
    specText,
    testText,
    opts: { ...opts, criteriaSource },
  });
  report.criteria_source = criteriaSource;

  // Augment with file-status markers — the CLI uses these to
  // distinguish "no spec yet" from "spec exists but has drift".
  report.artifacts = {
    brief:        { path: briefPath, exists: briefText != null },
    diagnosis:    { path: diagnosisPath, exists: diagnosisText != null },
    criteria:     criteriaSource === "brief"
      ? { path: briefPath, exists: briefText != null }
      : { path: diagnosisPath, exists: diagnosisText != null },
    spec:         { path: specPath,  exists: specText  != null },
    test_report:  { path: testPath,  exists: testText  != null },
  };

  // If both criteria sources are missing we can't compute anything
  // meaningful — surface that as a single drift flag rather than
  // returning misleading "everything is an orphan" data.
  if (criteriaText == null) {
    report.drift = true;
    report.errors = [{ kind: "missing_artifact", path: briefPath, alternatives: [diagnosisPath] }];
  } else if (specText == null) {
    // Spec missing but a criteria source is present — every criterion is orphan
    // criteria, which is exactly what the report already captures.
    // Add the marker so the CLI can render a nicer message.
    report.errors = (report.errors || []).concat([{ kind: "missing_artifact", path: specPath }]);
    report.drift = true;
  }

  return report;
}

// Generate a Gherkin scaffold from a brief's ACs. One Scenario per
// AC-N, tagged with `@AC-N` for unambiguous mapping. Steps are
// stubbed with TODOs so the spec author still has to think; we
// deliberately don't try to translate AC text into Given/When/Then
// — that translation is exactly what the spec author is for.
function generateScaffold(briefText, opts = {}) {
  const { ids, byId } = extractAcsFromBrief(briefText);
  const featureName = opts.featureName || "Feature under development";
  const lines = [];
  lines.push(`Feature: ${featureName}`);
  lines.push("");
  if (ids.length === 0) {
    lines.push("  # No AC-N entries found in brief.md.");
    lines.push("  # Number your acceptance criteria as AC-1, AC-2, ... in");
    lines.push("  # pipeline/brief.md, then re-run `devteam spec generate`.");
    lines.push("");
    return lines.join("\n");
  }
  for (const id of ids) {
    const body = (byId.get(id) || {}).body || "";
    lines.push(`  @${id}`);
    lines.push(`  Scenario: ${id} — ${body}`);
    lines.push(`    Given <TODO: precondition for ${id}>`);
    lines.push(`    When  <TODO: action being verified>`);
    lines.push(`    Then  <TODO: observable outcome>`);
    lines.push("");
  }
  return lines.join("\n");
}

module.exports = {
  extractAcsFromBrief,
  extractRcsFromDiagnosis,
  extractAcRefsFromTestReport,
  verify,
  verifyTexts,
  generateScaffold,
};
