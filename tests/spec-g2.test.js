// G2 — Closed-loop AC → exec spec → tests.
//
// Covers:
//   - Gherkin parser (core/spec/gherkin.js)
//   - AC extraction from brief.md (core/spec/verify.js)
//   - Drift detection across brief / spec / test-report
//   - Stage-03b shape, schema, ordering, track inclusion
//   - QA gate (stage-06) extended fields
//   - `devteam spec verify` + `devteam spec generate` CLI surface
//   - Adapter install picks up the new skill + role updates

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { makeTargetProject, cleanup, runCLI } = require("./_helpers");

const REPO_ROOT = path.resolve(__dirname, "..");
const { parse, acIdsFor } = require("../core/spec/gherkin");
const {
  extractAcsFromBrief,
  extractRcsFromDiagnosis,
  extractAcRefsFromTestReport,
  verifyTexts,
  verify,
  generateScaffold,
} = require("../core/spec/verify");

let _dirs = [];
function track(cwd) { _dirs.push(cwd); return cwd; }
test.afterEach?.(() => { _dirs.forEach(cleanup); _dirs = []; });

// -- Gherkin parser ----------------------------------------------------------

test("gherkin: parses Feature + Scenario + Given/When/Then", () => {
  const text = `
Feature: Sign in

  @AC-1
  Scenario: AC-1 — user can sign in with email + password
    Given a user with email alice@test.io exists
    When the user submits valid credentials
    Then a session cookie is set
`;
  const parsed = parse(text);
  assert.equal(parsed.features.length, 1);
  assert.equal(parsed.features[0].name, "Sign in");
  assert.equal(parsed.features[0].scenarios.length, 1);
  const sc = parsed.features[0].scenarios[0];
  assert.match(sc.name, /AC-1/);
  assert.equal(sc.steps.length, 3);
  assert.equal(sc.steps[0].keyword, "Given");
  assert.equal(sc.steps[1].keyword, "When");
  assert.equal(sc.steps[2].keyword, "Then");
});

test("gherkin: captures @tags on lines above the Scenario", () => {
  const text = `
Feature: x

  @smoke @AC-3
  Scenario: do the thing
    Then it works
`;
  const sc = parse(text).features[0].scenarios[0];
  assert.ok(sc.tags.includes("@smoke"));
  assert.ok(sc.tags.includes("@AC-3"));
});

test("gherkin: pulls inline @AC-N from a Scenario name as a fallback tag", () => {
  const text = `
Feature: x

  Scenario: @AC-7 — outline of behaviour
    Then ok
`;
  const sc = parse(text).features[0].scenarios[0];
  assert.ok(sc.tags.includes("@AC-7"));
});

test("gherkin: Scenario Outline counts as one scenario", () => {
  const text = `
Feature: x

  @AC-1
  Scenario Outline: parametric path for <user>
    Given a <user>
    Then ok
`;
  const sc = parse(text).features[0].scenarios[0];
  assert.match(sc.name, /parametric path/);
});

test("gherkin: tolerates files without a Feature: line", () => {
  const text = `
@AC-1
Scenario: bare scenario
  Then ok
`;
  const parsed = parse(text);
  assert.equal(parsed.features.length, 1);
  assert.equal(parsed.features[0].scenarios.length, 1);
});

test("gherkin: acIdsFor returns the union of tag + inline IDs", () => {
  const sc = {
    name: "AC-5 — happy path",
    tags: ["@smoke", "@AC-5"],
  };
  assert.deepEqual(acIdsFor(sc).sort(), ["AC-5"]);
});

test("gherkin: acIdsFor handles a scenario covering two ACs", () => {
  const sc = {
    name: "shared setup",
    tags: ["@AC-1", "@AC-2"],
  };
  assert.deepEqual(acIdsFor(sc).sort(), ["AC-1", "AC-2"]);
});

test("gherkin: acIdsFor recognizes repair-mode RC tags", () => {
  const sc = { name: "repair behavior", tags: ["@regression", "@RC-2"] };
  assert.deepEqual(acIdsFor(sc), ["RC-2"]);
});

// -- AC extraction -----------------------------------------------------------

test("extractAcsFromBrief: pulls AC-N from a bulleted list", () => {
  const text = `
# Brief

## Acceptance Criteria

- AC-1: User can sign in.
- AC-2 — Password reset link expires.
* AC-3. Invalid creds show generic error.
`;
  const { ids, byId } = extractAcsFromBrief(text);
  assert.deepEqual(ids, ["AC-1", "AC-2", "AC-3"]);
  assert.match(byId.get("AC-2").body, /Password reset/);
});

test("extractRcsFromDiagnosis: assigns RC-1 to a singular regression criterion", () => {
  const text = [
    "# Bug Diagnosis",
    "",
    "## Regression Criterion",
    "",
    "> Given a broken command, when repaired, then it exits zero.",
    "",
    "## Out of Scope",
    "",
    "Unrelated work.",
  ].join("\n");
  const result = extractRcsFromDiagnosis(text);
  assert.deepEqual(result.ids, ["RC-1"]);
  assert.match(result.byId.get("RC-1").body, /exits zero/);
});

test("extractRcsFromDiagnosis: preserves explicitly numbered RCs", () => {
  const result = extractRcsFromDiagnosis("- RC-1: first\n- RC-2 — second\n");
  assert.deepEqual(result.ids, ["RC-1", "RC-2"]);
});

test("extractAcsFromBrief: handles bold markdown **AC-N** format", () => {
  const text = `
## Acceptance Criteria

**AC-1** — POST /generate returns 200.
**AC-2** — POST with empty diff returns 400.
- **AC-3** — GET /healthz returns ok.
`;
  const { ids, byId } = extractAcsFromBrief(text);
  assert.deepEqual(ids, ["AC-1", "AC-2", "AC-3"]);
  assert.match(byId.get("AC-1").body, /POST \/generate/);
  assert.match(byId.get("AC-3").body, /GET \/healthz/);
});

test("extractAcsFromBrief: section-scoped — ignores AC references outside the Acceptance Criteria section", () => {
  // Mirrors the real pattern: PM uses **AC-N** in definitions AND in §9
  // observability notes. Only the §3 definitions should count.
  const text = `
# Brief

## §3 Acceptance Criteria

**AC-1** — Valid diff returns 200.
**AC-2** — Empty diff returns 400.
**AC-3** — Large diff returns 413.

## §4 Out of Scope

Nothing here.

## §9 Observability Requirements

- **AC-1/AC-7** (successful generation): log latency.
- **AC-2/AC-3** (validation errors): log rejection reason.
- **AC-3** (large diff): no extra logging.
`;
  const { ids, duplicates } = extractAcsFromBrief(text);
  assert.deepEqual(ids, ["AC-1", "AC-2", "AC-3"]);
  assert.equal(duplicates.length, 0, "observability references must not register as duplicate definitions");
});

test("extractAcsFromBrief: falls back to whole-document scan when no section header is found", () => {
  // Legacy / headerless briefs still work.
  const text = "- AC-1: a\n- AC-2: b\n- AC-3: c";
  const { ids } = extractAcsFromBrief(text);
  assert.deepEqual(ids, ["AC-1", "AC-2", "AC-3"]);
});

test("extractAcsFromBrief: handles §N-prefixed section headers (e.g. §3 Acceptance Criteria)", () => {
  const text = `
## §3 Acceptance Criteria

**AC-1** — something.
**AC-2** — another.

## §4 Out of Scope
`;
  const { ids } = extractAcsFromBrief(text);
  assert.deepEqual(ids, ["AC-1", "AC-2"]);
});

test("extractAcsFromBrief: handles N.-prefixed section headers (e.g. 3. Acceptance Criteria)", () => {
  // Briefs written by PM model sometimes use "## 3. Acceptance Criteria" rather
  // than "## §3 Acceptance Criteria". Without this, AC references in later sections
  // (e.g. "## 9. Observability") would be counted as duplicate definitions.
  const text = `
## 3. Acceptance Criteria

- **AC-1:** Something important.
- **AC-2:** Another thing.

---

## 9. Observability Requirements

- **AC-1 signal:** Tests run in CI on every push.
`;
  const { ids, duplicates } = extractAcsFromBrief(text);
  assert.deepEqual(ids, ["AC-1", "AC-2"]);
  assert.equal(duplicates.length, 0, "AC-1 signal in §9 must not register as duplicate");
});

test("extractAcsFromBrief: handles numbered list AC entries (e.g. 1. **AC-N — ...**:)", () => {
  // Regression: PM agent sometimes writes ACs as a numbered list with bold IDs
  // (e.g. "1. **AC-1 — HTTP endpoint exists**: ...") instead of dash bullets.
  // AC_LINE_RE must match both bullet styles.
  const text = `
## §3 Acceptance Criteria

1. **AC-1 — HTTP endpoint exists**: A POST endpoint returns 200.
2. **AC-2 — Conventional-commit format**: The message matches type(scope): subject.
3. AC-3 — Numbered bare: Missing diff returns 400.

## §9 Observability Requirements

- **AC-1, AC-2** signal: log latency.
`;
  const { ids, byId, duplicates } = extractAcsFromBrief(text);
  assert.deepEqual(ids, ["AC-1", "AC-2", "AC-3"]);
  assert.match(byId.get("AC-1").body, /POST endpoint/);
  assert.equal(duplicates.length, 0, "observability cross-references must not register as duplicates");
});

test("extractAcsFromBrief: flags duplicates", () => {
  const text = `
- AC-1: first
- AC-2: second
- AC-1: dup
`;
  const { ids, duplicates } = extractAcsFromBrief(text);
  assert.deepEqual(ids, ["AC-1", "AC-2"]);
  assert.equal(duplicates.length, 1);
  assert.equal(duplicates[0].id, "AC-1");
});

test("extractAcsFromBrief: does not extract AC-N from prose cross-references", () => {
  // Regression: brief says "existing AC-1 through AC-12" — when word-wrap lands
  // AC-12 at the start of a line inside the AC section, the separator-required
  // regex must reject it (no — or : immediately follows AC-12 in that context).
  const text = [
    "## Acceptance Criteria",
    "**AC-4** — Falls back to git diff --cached, preserving all existing",
    "behaviour unchanged (existing AC-1 through",
    "AC-12 from the initial build brief continue to apply).",
  ].join("\n");
  const { ids } = extractAcsFromBrief(text);
  assert.deepEqual(ids, ["AC-4"]);
});

test("extractAcRefsFromTestReport: picks up @AC-N and bare AC-N", () => {
  const text = `
| AC | Scenario | Test | Result |
|---|---|---|---|
| AC-1 | @AC-1 happy path | unit/foo.test.js | PASS |
| AC-2 | AC-2 — reset     | int/bar.test.js  | FAIL |
`;
  const refs = extractAcRefsFromTestReport(text);
  assert.ok(refs.has("AC-1"));
  assert.ok(refs.has("AC-2"));
});

// -- Drift detection ---------------------------------------------------------

test("verifyTexts: no drift when brief + spec are aligned", () => {
  const briefText = "- AC-1: a\n- AC-2: b";
  const specText = `
Feature: x
  @AC-1
  Scenario: AC-1 — a
    Then ok
  @AC-2
  Scenario: AC-2 — b
    Then ok
`;
  const r = verifyTexts({ briefText, specText });
  assert.equal(r.drift, false);
  assert.equal(r.orphan_criteria.length, 0);
  assert.equal(r.orphan_scenarios.length, 0);
});

test("verifyTexts: orphan AC (brief has it, spec doesn't)", () => {
  const briefText = "- AC-1: a\n- AC-2: b";
  const specText = `
Feature: x
  @AC-1
  Scenario: AC-1 — a
    Then ok
`;
  const r = verifyTexts({ briefText, specText });
  assert.equal(r.drift, true);
  assert.equal(r.orphan_criteria.length, 1);
  assert.equal(r.orphan_criteria[0].id, "AC-2");
});

test("verifyTexts: orphan scenario (spec has it, brief doesn't)", () => {
  const briefText = "- AC-1: a";
  const specText = `
Feature: x
  @AC-1
  Scenario: AC-1 — a
    Then ok
  @AC-9
  Scenario: AC-9 — sneaky
    Then ok
`;
  const r = verifyTexts({ briefText, specText });
  assert.equal(r.drift, true);
  // AC-9 references an AC not in the brief → orphan_scenario with missing_ac.
  const sneaky = r.orphan_scenarios.find((o) => o.missing_ac === "AC-9");
  assert.ok(sneaky, "expected AC-9 scenario to be reported as orphan");
});

test("verifyTexts: untagged scenario is also an orphan", () => {
  const briefText = "- AC-1: a";
  const specText = `
Feature: x
  @AC-1
  Scenario: AC-1 — a
    Then ok
  Scenario: untagged scenario
    Then ok
`;
  const r = verifyTexts({ briefText, specText });
  assert.equal(r.drift, true);
  assert.ok(r.orphan_scenarios.some((o) => o.name === "untagged scenario"));
});

test("verifyTexts: duplicate AC in brief is drift", () => {
  const briefText = "- AC-1: a\n- AC-1: dup\n";
  const r = verifyTexts({ briefText, specText: "Feature: x" });
  assert.equal(r.drift, true);
  assert.equal(r.duplicate_criteria.length, 1);
});

test("verifyTexts: test-report side — orphan_in_tests + unknown_in_tests", () => {
  const briefText = "- AC-1: a\n- AC-2: b";
  const specText = `
Feature: x
  @AC-1
  Scenario: AC-1
    Then ok
  @AC-2
  Scenario: AC-2
    Then ok
`;
  const testText = "| AC-1 | x | y | PASS |\n| AC-9 | x | y | PASS |";
  const r = verifyTexts({ briefText, specText, testText });
  assert.equal(r.test_phase_complete, true);
  // AC-2 in brief but missing from tests:
  assert.ok(r.orphan_in_tests.some((o) => o.id === "AC-2"));
  // AC-9 in tests but not in brief:
  assert.ok(r.unknown_in_tests.some((u) => u.id === "AC-9"));
  assert.equal(r.drift, true);
});

test("verifyTexts: multi_mapped_criteria is informational unless --strict", () => {
  const briefText = "- AC-1: a";
  const specText = `
Feature: x
  @AC-1
  Scenario: AC-1 happy
    Then ok
  @AC-1
  Scenario: AC-1 edge
    Then ok
`;
  const r = verifyTexts({ briefText, specText });
  assert.equal(r.multi_mapped_criteria.length, 1);
  assert.equal(r.drift, false);
  const strict = verifyTexts({ briefText, specText, opts: { strictMapping: true } });
  assert.equal(strict.drift, true);
});

test("verifyTexts: skipTestPhase suppresses test-side drift even when test-report exists", () => {
  const briefText = "- AC-1: a\n- AC-2: b";
  const specText = `
Feature: x
  @AC-1
  Scenario: AC-1
    Then ok
  @AC-2
  Scenario: AC-2
    Then ok
`;
  // Stale test-report references an AC that no longer exists in the brief
  const testText = "| AC-1 | x | y | PASS |\n| AC-9 | x | y | PASS |";
  const withPhase = verifyTexts({ briefText, specText, testText });
  assert.equal(withPhase.drift, true, "without skipTestPhase, stale report causes drift");

  const skipped = verifyTexts({ briefText, specText, testText, opts: { skipTestPhase: true } });
  assert.equal(skipped.drift, false, "skipTestPhase suppresses test-side drift");
  assert.equal(skipped.orphan_in_tests.length, 0, "orphan_in_tests not populated when skipped");
  assert.equal(skipped.unknown_in_tests.length, 0, "unknown_in_tests not populated when skipped");
});

test("verifyTexts: missing test-report degrades gracefully (no false drift on test side)", () => {
  const briefText = "- AC-1: a";
  const specText = `
Feature: x
  @AC-1
  Scenario: AC-1
    Then ok
`;
  const r = verifyTexts({ briefText, specText });
  assert.equal(r.test_phase_complete, false);
  assert.equal(r.orphan_in_tests.length, 0);
  assert.equal(r.drift, false);
});

// -- generateScaffold --------------------------------------------------------

test("generateScaffold: one Scenario per AC, tagged @AC-N", () => {
  const briefText = "- AC-1: sign in\n- AC-2: reset password";
  const out = generateScaffold(briefText);
  assert.match(out, /^Feature:/m);
  assert.match(out, /@AC-1/);
  assert.match(out, /@AC-2/);
  assert.match(out, /Scenario: AC-1 — sign in/);
  assert.match(out, /Scenario: AC-2 — reset password/);
  assert.match(out, /Given <TODO/);
});

test("generateScaffold: zero ACs produces a hint, not a crash", () => {
  const out = generateScaffold("# brief\n\nblah");
  assert.match(out, /No AC-N entries/);
});

// -- file-based verify() -----------------------------------------------------

test("verify(cwd): handles a clean cwd (clean spec)", () => {
  const cwd = track(makeTargetProject());
  fs.mkdirSync(path.join(cwd, "pipeline"), { recursive: true });
  fs.writeFileSync(path.join(cwd, "pipeline", "brief.md"), "- AC-1: a\n- AC-2: b");
  fs.writeFileSync(path.join(cwd, "pipeline", "spec.feature"),
    "Feature: x\n  @AC-1\n  Scenario: AC-1\n    Then ok\n  @AC-2\n  Scenario: AC-2\n    Then ok\n");
  const r = verify(cwd);
  assert.equal(r.drift, false);
  assert.equal(r.artifacts.brief.exists, true);
  assert.equal(r.artifacts.spec.exists, true);
  assert.equal(r.artifacts.test_report.exists, false);
});

test("verify(cwd): missing spec.feature flags drift + missing_artifact error", () => {
  const cwd = track(makeTargetProject());
  fs.mkdirSync(path.join(cwd, "pipeline"), { recursive: true });
  fs.writeFileSync(path.join(cwd, "pipeline", "brief.md"), "- AC-1: a");
  const r = verify(cwd);
  assert.equal(r.drift, true);
  assert.ok(r.errors.some((e) => e.kind === "missing_artifact" && /spec\.feature$/.test(e.path)));
});

// -- Stage definition --------------------------------------------------------

test("core/pipeline/stages.js has executable-spec at stage-03b", () => {
  const { STAGES, getStage } =
    require(path.join(REPO_ROOT, "core", "pipeline", "stages"));
  assert.ok(STAGES["executable-spec"], "no executable-spec stage");
  const s = getStage("executable-spec");
  assert.equal(s.stage, "stage-03b");
  assert.deepEqual(s.roles, ["pm"]);
  assert.equal(s.artifact, "pipeline/spec.feature");
  assert.equal(s.template, "spec-template.feature");
  // Gate skeleton has expected fields:
  for (const f of [
    "criteria_count", "scenarios_count", "criteria_to_scenario_mapping",
    "all_criteria_mapped", "orphan_scenarios", "orphan_criteria", "drift",
  ]) {
    assert.ok(f in s.gate, `gate skeleton missing "${f}"`);
  }
});

test("executable-spec is ordered between clarification and build", () => {
  const { ORDERED_STAGE_NAMES } = require(path.join(REPO_ROOT, "core", "pipeline", "stages"));
  const cl = ORDERED_STAGE_NAMES.indexOf("clarification");
  const es = ORDERED_STAGE_NAMES.indexOf("executable-spec");
  const bu = ORDERED_STAGE_NAMES.indexOf("build");
  assert.ok(cl >= 0 && es >= 0 && bu >= 0);
  assert.ok(cl < es && es < bu, `expected clarification(${cl}) < executable-spec(${es}) < build(${bu})`);
});

test("executable-spec is in full + quick tracks; absent from hotfix/nano/config-only/dep-update", () => {
  const { orderedStageNamesForTrack } = require(path.join(REPO_ROOT, "core", "pipeline", "stages"));
  for (const t of ["full", "quick"]) {
    assert.ok(orderedStageNamesForTrack(t).includes("executable-spec"), `${t} should include executable-spec`);
  }
  for (const t of ["hotfix", "nano", "config-only", "dep-update"]) {
    assert.ok(!orderedStageNamesForTrack(t).includes("executable-spec"), `${t} should NOT include executable-spec`);
  }
});

test("stage-03b schema declares the G2 required fields", () => {
  const p = path.join(REPO_ROOT, "core", "gates", "schemas", "stage-03b.schema.json");
  assert.ok(fs.existsSync(p));
  const s = JSON.parse(fs.readFileSync(p, "utf8"));
  assert.equal(s.$id, "urn:stagecraft:schema:stage-03b");
  for (const f of [
    "criteria_count", "scenarios_count", "criteria_to_scenario_mapping",
    "all_criteria_mapped", "orphan_scenarios", "orphan_criteria", "drift",
  ]) {
    assert.ok(s.required.includes(f), `stage-03b schema must require "${f}"`);
  }
});

test("stage-06 schema gained the scenario coverage fields", () => {
  const p = path.join(REPO_ROOT, "core", "gates", "schemas", "stage-06.schema.json");
  const s = JSON.parse(fs.readFileSync(p, "utf8"));
  for (const f of ["scenarios_total", "scenarios_covered", "all_scenarios_have_tests"]) {
    assert.ok(s.properties[f], `stage-06 must declare property "${f}"`);
  }
});

// -- Template + skill + role -------------------------------------------------

test("templates/spec-template.feature exists with @AC-1 + Scenario", () => {
  const p = path.join(REPO_ROOT, "templates", "spec-template.feature");
  assert.ok(fs.existsSync(p));
  const text = fs.readFileSync(p, "utf8");
  assert.match(text, /Feature:/);
  assert.match(text, /@AC-1/);
  assert.match(text, /Scenario: AC-1/);
});

test("templates/brief-template.md uses numbered AC-N entries", () => {
  const text = fs.readFileSync(path.join(REPO_ROOT, "templates", "brief-template.md"), "utf8");
  assert.match(text, /AC-1/);
  assert.match(text, /AC-2/);
});

test("templates/test-report-template.md uses 4-column AC | Scenario | Test | Result table", () => {
  const text = fs.readFileSync(path.join(REPO_ROOT, "templates", "test-report-template.md"), "utf8");
  assert.match(text, /\| AC \| Scenario \| Test \| Result \|/);
});

test("skills/spec-authoring/SKILL.md exists with G2 phases", () => {
  const p = path.join(REPO_ROOT, "skills", "spec-authoring", "SKILL.md");
  assert.ok(fs.existsSync(p));
  const text = fs.readFileSync(p, "utf8");
  assert.match(text.slice(0, 5), /^---/);
  assert.match(text, /^name: spec-authoring$/m);
  for (const phase of [
    "Phase 1", "Phase 2", "Phase 3", "Phase 4", "Phase 5",
  ]) {
    assert.match(text, new RegExp(phase));
  }
});

test("roles/pm.md describes the executable-spec stage", () => {
  const text = fs.readFileSync(path.join(REPO_ROOT, "roles", "pm.md"), "utf8");
  assert.match(text, /Executable-Spec Request/);
  assert.match(text, /stage-03b/);
  assert.match(text, /spec\.feature/);
});

test("qa-test-authoring skill mentions spec.feature as the canonical behaviour list", () => {
  // spec.feature instructions moved from roles/qa.md to skills/qa-test-authoring/SKILL.md (8.3)
  const text = fs.readFileSync(path.join(REPO_ROOT, "skills", "qa-test-authoring", "SKILL.md"), "utf8");
  assert.match(text, /spec\.feature/);
});

// -- CLI ----------------------------------------------------------------------

test("`devteam spec` with no args prints usage", () => {
  const r = runCLI(["spec"]);
  assert.notEqual(r.status, 0);
  assert.match(r.stderr, /devteam spec verify/);
  assert.match(r.stderr, /devteam spec generate/);
});

test("`devteam spec verify` on a clean target exits 0", () => {
  const cwd = track(makeTargetProject());
  fs.mkdirSync(path.join(cwd, "pipeline"), { recursive: true });
  fs.writeFileSync(path.join(cwd, "pipeline", "brief.md"), "- AC-1: a\n- AC-2: b");
  fs.writeFileSync(path.join(cwd, "pipeline", "spec.feature"),
    "Feature: x\n  @AC-1\n  Scenario: AC-1\n    Then ok\n  @AC-2\n  Scenario: AC-2\n    Then ok\n");
  const r = runCLI(["spec", "verify"], { cwd });
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /No drift detected/);
});

test("`devteam spec verify` exits non-zero on orphan AC", () => {
  const cwd = track(makeTargetProject());
  fs.mkdirSync(path.join(cwd, "pipeline"), { recursive: true });
  fs.writeFileSync(path.join(cwd, "pipeline", "brief.md"), "- AC-1: a\n- AC-2: b");
  fs.writeFileSync(path.join(cwd, "pipeline", "spec.feature"),
    "Feature: x\n  @AC-1\n  Scenario: AC-1\n    Then ok\n");
  const r = runCLI(["spec", "verify"], { cwd });
  assert.notEqual(r.status, 0);
  assert.match(r.stdout, /orphan criterion/);
});

test("`devteam spec verify --json` emits a machine-readable report", () => {
  const cwd = track(makeTargetProject());
  fs.mkdirSync(path.join(cwd, "pipeline"), { recursive: true });
  fs.writeFileSync(path.join(cwd, "pipeline", "brief.md"), "- AC-1: a");
  fs.writeFileSync(path.join(cwd, "pipeline", "spec.feature"),
    "Feature: x\n  @AC-1\n  Scenario: AC-1\n    Then ok\n");
  const r = runCLI(["spec", "verify", "--json"], { cwd });
  assert.equal(r.status, 0);
  const parsed = JSON.parse(r.stdout);
  assert.equal(parsed.drift, false);
  assert.deepEqual(parsed.criteria, ["AC-1"]);
});

test("`devteam spec verify --strict` validates a repair-mode diagnosis contract", () => {
  const cwd = track(makeTargetProject());
  fs.writeFileSync(path.join(cwd, "pipeline", "diagnosis.md"), [
    "# Bug Diagnosis",
    "",
    "## Regression Criterion",
    "",
    "> Given a package version, when devteam --version runs, then it prints that version.",
  ].join("\n"));
  fs.writeFileSync(path.join(cwd, "pipeline", "spec.feature"), [
    "Feature: Report the version",
    "",
    "  @regression @hotfix",
    "  Scenario: devteam --version reports the package version",
    "    Then the version is printed",
  ].join("\n"));
  fs.writeFileSync(path.join(cwd, "pipeline", "test-report.md"), [
    "# Test Report",
    "",
    "| Criterion | Test | Result |",
    "|---|---|---|",
    "| RC-1 | version CLI test | PASS |",
  ].join("\n"));

  const result = runCLI(["spec", "verify", "--strict", "--json"], { cwd });
  assert.equal(result.status, 0, result.stderr || result.stdout);
  const report = JSON.parse(result.stdout);
  assert.equal(report.criteria_source, "diagnosis");
  assert.deepEqual(report.criteria, ["RC-1"]);
  assert.deepEqual(report.scenarios[0].ac_ids, ["RC-1"]);
  assert.deepEqual(report.test_refs, ["RC-1"]);
  assert.equal(report.drift, false);
});

test("`devteam spec generate` scaffolds spec.feature from brief.md", () => {
  const cwd = track(makeTargetProject());
  fs.mkdirSync(path.join(cwd, "pipeline"), { recursive: true });
  fs.writeFileSync(path.join(cwd, "pipeline", "brief.md"), "- AC-1: a\n- AC-2: b");
  const r = runCLI(["spec", "generate"], { cwd });
  assert.equal(r.status, 0, r.stderr);
  const text = fs.readFileSync(path.join(cwd, "pipeline", "spec.feature"), "utf8");
  assert.match(text, /@AC-1/);
  assert.match(text, /@AC-2/);
  assert.match(r.stdout, /2 scenario\(s\)/);
});

test("`devteam spec generate` refuses to overwrite without --force", () => {
  const cwd = track(makeTargetProject());
  fs.mkdirSync(path.join(cwd, "pipeline"), { recursive: true });
  fs.writeFileSync(path.join(cwd, "pipeline", "brief.md"), "- AC-1: a");
  fs.writeFileSync(path.join(cwd, "pipeline", "spec.feature"), "Feature: existing\n");
  const r = runCLI(["spec", "generate"], { cwd });
  assert.notEqual(r.status, 0);
  assert.match(r.stderr, /Use --force/);
});

test("`devteam spec generate --force` overwrites", () => {
  const cwd = track(makeTargetProject());
  fs.mkdirSync(path.join(cwd, "pipeline"), { recursive: true });
  fs.writeFileSync(path.join(cwd, "pipeline", "brief.md"), "- AC-1: a");
  fs.writeFileSync(path.join(cwd, "pipeline", "spec.feature"), "Feature: existing\n");
  const r = runCLI(["spec", "generate", "--force"], { cwd });
  assert.equal(r.status, 0);
  const text = fs.readFileSync(path.join(cwd, "pipeline", "spec.feature"), "utf8");
  assert.match(text, /@AC-1/);
});

// -- Install roundtrip + stage rendering -------------------------------------

test("`devteam init --host claude-code` installs the spec-authoring skill", () => {
  const cwd = track(makeTargetProject());
  const r = runCLI(["init", "--host", "claude-code"], { cwd });
  assert.equal(r.status, 0);
  assert.ok(fs.existsSync(path.join(cwd, ".claude/skills/spec-authoring/SKILL.md")));
});

test("`devteam stage executable-spec` renders a prompt referencing spec.feature", () => {
  const cwd = track(makeTargetProject());
  runCLI(["init", "--host", "claude-code"], { cwd });
  const r = runCLI(["stage", "executable-spec", "--feature", "test"], { cwd });
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /workstream: pm/);
  assert.match(r.stdout, /spec\.feature/);
  assert.match(r.stdout, /spec-template\.feature/);
});

// ─── 42.4: `spec verify` distinguishes not-applicable from drift ─────────────

test("spec verify: a track without executable-spec reports not-applicable, not drift", () => {
  // executable-spec is absent from loop, so pipeline/spec.feature is not
  // something anything was ever going to produce. Reporting it as "MISSING"
  // drift made a correct project look broken.
  const cwd = makeTargetProject({ config: "pipeline:\n  default_track: loop\n" });
  try {
    fs.writeFileSync(path.join(cwd, "pipeline", "brief.md"), "# Brief\n\n- AC-1: it works\n");
    const r = runCLI(["spec", "verify", "--json"], { cwd });
    assert.equal(r.status, 0, "not-applicable must not exit non-zero");
    const report = JSON.parse(r.stdout);
    assert.equal(report.applicable, false);
    assert.equal(report.status, "not-applicable");
    assert.equal(report.drift, false);
    assert.equal(report.track, "loop");
    assert.equal(report.track_source, "config");
  } finally { cleanup(cwd); }
});

test("spec verify: a track that requires executable-spec keeps the G2 failure", () => {
  const cwd = makeTargetProject({ config: "pipeline:\n  default_track: full\n" });
  try {
    fs.writeFileSync(path.join(cwd, "pipeline", "brief.md"), "# Brief\n\n- AC-1: it works\n");
    const r = runCLI(["spec", "verify", "--json"], { cwd });
    assert.equal(r.status, 1, "a required stage with no spec is still drift");
    const report = JSON.parse(r.stdout);
    assert.equal(report.applicable, true);
    assert.equal(report.drift, true);
    assert.equal(report.orphan_criteria.length, 1);
  } finally { cleanup(cwd); }
});

test("spec verify: --track overrides the project's configured track", () => {
  const cwd = makeTargetProject({ config: "pipeline:\n  default_track: loop\n" });
  try {
    fs.writeFileSync(path.join(cwd, "pipeline", "brief.md"), "# Brief\n\n- AC-1: it works\n");
    const r = runCLI(["spec", "verify", "--track", "full", "--json"], { cwd });
    assert.equal(r.status, 1);
    const report = JSON.parse(r.stdout);
    assert.equal(report.track, "full");
    assert.equal(report.track_source, "explicit");
    assert.equal(report.applicable, true);
  } finally { cleanup(cwd); }
});

test("spec verify: pipeline/track.json outranks the config default", () => {
  // The per-run record `devteam assess` writes is what `devteam run` obeys, so
  // verification has to read the same chain or it reports on a different track
  // than the one that will execute.
  const cwd = makeTargetProject({ config: "pipeline:\n  default_track: loop\n" });
  try {
    fs.writeFileSync(path.join(cwd, "pipeline", "brief.md"), "# Brief\n\n- AC-1: it works\n");
    fs.writeFileSync(
      path.join(cwd, "pipeline", "track.json"),
      JSON.stringify({ track: "full", source: "human", confidence: "high" }),
    );
    const r = runCLI(["spec", "verify", "--json"], { cwd });
    assert.equal(r.status, 1, "track.json says full, so the stage is required");
    const report = JSON.parse(r.stdout);
    assert.equal(report.track, "full");
    assert.equal(report.track_source, "track-record");
  } finally { cleanup(cwd); }
});

test("spec verify: an unknown track name still reports drift rather than passing", () => {
  // Suppressing drift for a track we cannot resolve would turn a typo in
  // default_track into a silent pass.
  const cwd = makeTargetProject({ config: "pipeline:\n  default_track: full\n" });
  try {
    fs.writeFileSync(path.join(cwd, "pipeline", "brief.md"), "# Brief\n\n- AC-1: it works\n");
    const r = runCLI(["spec", "verify", "--track", "not-a-real-track", "--json"], { cwd });
    assert.equal(r.status, 1);
    const report = JSON.parse(r.stdout);
    assert.equal(report.applicable, true, "unknown track must not be read as not-applicable");
  } finally { cleanup(cwd); }
});

test("spec verify: a materialized run plan outranks track.json and config", () => {
  // run-plan.json is the highest tier in resolveActiveTrack — the track a run
  // actually froze. Verification has to honour it or it reports against a
  // different track than the one executing.
  const cwd = makeTargetProject({ config: "pipeline:\n  default_track: loop\n" });
  try {
    fs.writeFileSync(path.join(cwd, "pipeline", "brief.md"), "# Brief\n\n- AC-1: it works\n");
    fs.writeFileSync(path.join(cwd, "pipeline", "track.json"), JSON.stringify({ track: "loop" }));
    fs.writeFileSync(path.join(cwd, "pipeline", "run-plan.json"), JSON.stringify({ track: "full" }));
    const r = runCLI(["spec", "verify", "--json"], { cwd });
    const report = JSON.parse(r.stdout);
    assert.equal(report.track, "full");
    assert.equal(report.track_source, "run-plan");
    assert.equal(report.applicable, true, "full requires executable-spec");
    assert.equal(r.status, 1);
  } finally { cleanup(cwd); }
});
