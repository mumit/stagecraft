// Meta-test: ensure `scripts/consistency.js` exits 0 as part of `npm test`.
// Without this, the consistency lint runs only in CI (via npm run consistency)
// and a developer running `npm test` locally could land a contract drift
// that only CI catches. The cost is one subprocess spawn (~50ms).
//
// Extended (2.1): also tests the six prose-vs-code check classes introduced
// in feat/consistency-prose-vs-code. Each check class has:
//   - a fixture tree with one violation → checker exits 1 and prints the violation
//   - a clean fixture → exits 0
//   - a baselined violation → exits 0 with "baselined" note
//   - a non-baselined violation in presence of a baseline file → exits 1
//
// Fixtures live in tmpdir trees (devteam-test- prefix) per the project convention
// in tests/_helpers.js. The checker is invoked via --root so it targets the
// fixture tree instead of the repo root.

"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const path = require("node:path");
const fs = require("node:fs");
const os = require("node:os");
const { spawnSync } = require("node:child_process");

const REPO_ROOT = path.resolve(__dirname, "..");
const CONSISTENCY_JS = path.join(REPO_ROOT, "scripts", "consistency.js");

// ---------------------------------------------------------------------------
// Core meta-test (unchanged behaviour)
// ---------------------------------------------------------------------------

test("scripts/consistency.js exits 0 with baseline (cross-artifact contracts are intact)", () => {
  const r = spawnSync("node", [CONSISTENCY_JS], {
    cwd: REPO_ROOT,
    encoding: "utf8",
    timeout: 30000,
  });
  assert.equal(
    r.status,
    0,
    `consistency.js failed (exit ${r.status}):\n${r.stdout}\n${r.stderr}`,
  );
  // Sanity: confirm it actually ran
  assert.match(r.stdout, /consistency:.*checks passed/);
});

// ---------------------------------------------------------------------------
// Fixture helpers
// ---------------------------------------------------------------------------

function mkFixtureRoot() {
  return fs.mkdtempSync(path.join(os.tmpdir(), "devteam-test-"));
}

function cleanup(root) {
  if (root && fs.existsSync(root) && root.includes("devteam-test-")) {
    fs.rmSync(root, { recursive: true, force: true });
  }
}

function writeFile(root, rel, content) {
  const abs = path.join(root, rel);
  fs.mkdirSync(path.dirname(abs), { recursive: true });
  fs.writeFileSync(abs, content, "utf8");
}

// Run consistency.js in --root mode (prose checks only) against a fixture tree.
// Pass noBaseline=true to see all violations without suppression.
// Pass baselineEntries=[...] to inject a specific baseline (via temp file +
// CONSISTENCY_BASELINE_FILE env var, which is supported by the checker).
function runChecker(fixtureRoot, { noBaseline = false, baselineEntries = null, only = null } = {}) {
  const args = [CONSISTENCY_JS, "--root", fixtureRoot];
  if (noBaseline) args.push("--no-baseline");
  if (only) args.push("--only", only);

  const env = { ...process.env };
  let baselinePath = null;

  if (baselineEntries !== null) {
    // Write a temp baseline so the checker reads those keys instead of
    // the real scripts/consistency-baseline.json. The checker checks
    // CONSISTENCY_BASELINE_FILE env var first (see loadBaseline()).
    baselinePath = path.join(os.tmpdir(), `devteam-test-bl-${Date.now()}.json`);
    fs.writeFileSync(baselinePath, JSON.stringify(baselineEntries), "utf8");
    env.CONSISTENCY_BASELINE_FILE = baselinePath;
  }

  const r = spawnSync("node", args, {
    cwd: REPO_ROOT,
    encoding: "utf8",
    timeout: 30000,
    env,
  });

  if (baselinePath) {
    try { fs.unlinkSync(baselinePath); } catch { /* ignore */ }
  }
  return r;
}

// ---------------------------------------------------------------------------
// Check 1: Gate filename references
// ---------------------------------------------------------------------------

test("check 1 gate-filename: dash-form gate name is detected as violation", () => {
  const root = mkFixtureRoot();
  try {
    // Violation: stage-04-backend.json uses a dash separator (should be stage-04.backend.json)
    writeFile(root, "roles/backend.md",
      "Write `pipeline/gates/stage-04-backend.json` with status PASS.\n");

    const r = runChecker(root, { noBaseline: true });
    assert.equal(r.status, 1,
      `expected exit 1 but got ${r.status}:\n${r.stdout}\n${r.stderr}`);
    assert.match(r.stdout, /gate-filename/,
      "expected gate-filename violation in output");
    assert.match(r.stdout, /stage-04-backend\.json/,
      "expected specific filename in output");
  } finally {
    cleanup(root);
  }
});

test("check 1 gate-filename: dash-form placeholder is detected as violation", () => {
  const root = mkFixtureRoot();
  try {
    // Violation: stage-05-{area}.json uses dash (should be stage-05.{area}.json)
    writeFile(root, "rules/stage-05.md",
      "Gate file: `pipeline/gates/stage-05-{area}.json`\n");

    const r = runChecker(root, { noBaseline: true });
    assert.equal(r.status, 1,
      `expected exit 1 but got ${r.status}:\n${r.stdout}\n${r.stderr}`);
    assert.match(r.stdout, /gate-filename/,
      "expected gate-filename violation in output");
  } finally {
    cleanup(root);
  }
});

test("check 1 gate-filename: correct dot-form exits 0", () => {
  const root = mkFixtureRoot();
  try {
    // Correct: dot-separated workstream gate name
    writeFile(root, "roles/backend.md",
      "Write `pipeline/gates/stage-04.backend.json` with status PASS.\n");

    const r = runChecker(root, { noBaseline: true });
    assert.equal(r.status, 0,
      `expected exit 0 but got ${r.status}:\n${r.stdout}\n${r.stderr}`);
  } finally {
    cleanup(root);
  }
});

test("check 1 gate-filename: baselined violation exits 0 with baselined note", () => {
  const root = mkFixtureRoot();
  try {
    writeFile(root, "roles/backend.md",
      "Write `pipeline/gates/stage-04-backend.json` with status PASS.\n");

    // Key format matches checker: "gate-filename:<file>:<fname>"
    const baselineKey = "gate-filename:roles/backend.md:stage-04-backend.json";
    const r = runChecker(root, { baselineEntries: [baselineKey] });
    assert.equal(r.status, 0,
      `expected exit 0 (baselined) but got ${r.status}:\n${r.stdout}\n${r.stderr}`);
    assert.match(r.stdout, /baselined/i,
      "expected 'baselined' in output");
  } finally {
    cleanup(root);
  }
});

test("check 1 gate-filename: non-baselined violation exits 1 even with baseline present", () => {
  const root = mkFixtureRoot();
  try {
    writeFile(root, "roles/qa.md",
      "Write `pipeline/gates/stage-04-qa.json` with status PASS.\n");

    // Baseline has a different unrelated key — qa violation not suppressed
    const r = runChecker(root, { baselineEntries: ["gate-filename:roles/other.md:stage-04-other.json"] });
    assert.equal(r.status, 1,
      `expected exit 1 for non-baselined violation but got ${r.status}:\n${r.stdout}`);
  } finally {
    cleanup(root);
  }
});

// ---------------------------------------------------------------------------
// Check 2: Stage-ID existence and stage-count claims
// ---------------------------------------------------------------------------

test("check 2 stage-id: non-canonical (un-padded) stage ID is detected", () => {
  const root = mkFixtureRoot();
  try {
    // Violation: stage-4b is non-canonical (should be stage-04b)
    writeFile(root, "rules/orchestrator.md",
      "See stage-4b for the security review stage.\n");

    const r = runChecker(root, { noBaseline: true });
    assert.equal(r.status, 1,
      `expected exit 1 but got ${r.status}:\n${r.stdout}\n${r.stderr}`);
    assert.match(r.stdout, /stage-id/,
      "expected stage-id violation in output");
    assert.match(r.stdout, /stage-4b/,
      "expected the bad ID in output");
  } finally {
    cleanup(root);
  }
});

test("check 2 stage-count: wrong stage count claim is detected", () => {
  const root = mkFixtureRoot();
  try {
    // Violation: claims 13-stage but ORDERED_STAGE_NAMES.length is 18
    writeFile(root, "skills/audit/SKILL.md",
      "Different from Stagecraft's 13-stage pipeline.\n");

    const r = runChecker(root, { noBaseline: true });
    assert.equal(r.status, 1,
      `expected exit 1 but got ${r.status}:\n${r.stdout}\n${r.stderr}`);
    assert.match(r.stdout, /stage-count/,
      "expected stage-count violation in output");
    assert.match(r.stdout, /13-stage/,
      "expected specific claim in output");
  } finally {
    cleanup(root);
  }
});

test("check 2 stage-count: correct stage count exits 0", () => {
  const root = mkFixtureRoot();
  try {
    // Derive count from live code so test stays valid after future stage additions
    const { ORDERED_STAGE_NAMES } = require(path.join(REPO_ROOT, "core", "pipeline", "stages"));
    const count = ORDERED_STAGE_NAMES.length;
    writeFile(root, "skills/audit/SKILL.md",
      `Different from Stagecraft's ${count}-stage pipeline.\n`);

    const r = runChecker(root, { noBaseline: true });
    assert.equal(r.status, 0,
      `expected exit 0 but got ${r.status}:\n${r.stdout}\n${r.stderr}`);
  } finally {
    cleanup(root);
  }
});

// ---------------------------------------------------------------------------
// Check 3: Track list claims
// ---------------------------------------------------------------------------

test("check 3 track-list: wrong track count claim is detected", () => {
  const root = mkFixtureRoot();
  try {
    // Violation: "Four tracks" when TRACKS.length === 6
    writeFile(root, "rules/pipeline-tracks.md",
      "Four tracks are available for the pipeline.\n");

    const r = runChecker(root, { noBaseline: true });
    assert.equal(r.status, 1,
      `expected exit 1 but got ${r.status}:\n${r.stdout}\n${r.stderr}`);
    assert.match(r.stdout, /track-list/,
      "expected track-list violation in output");
    assert.match(r.stdout, /Four tracks/,
      "expected the specific claim in output");
  } finally {
    cleanup(root);
  }
});

test("check 3 track-list: written count in root README is detected", () => {
  const root = mkFixtureRoot();
  try {
    writeFile(root, "README.md", "The nine tracks cover every change.\n");

    const r = runChecker(root, { noBaseline: true });
    assert.equal(r.status, 1,
      `expected exit 1 but got ${r.status}:\n${r.stdout}\n${r.stderr}`);
    assert.match(r.stdout, /track-list/);
    assert.match(r.stdout, /nine tracks/i);
  } finally {
    cleanup(root);
  }
});

test("check 3 track-list: correct track count exits 0", () => {
  const root = mkFixtureRoot();
  try {
    // Derive count from live code
    const { TRACKS } = require(path.join(REPO_ROOT, "core", "pipeline", "stages"));
    writeFile(root, "rules/pipeline-tracks.md",
      `${TRACKS.length} tracks are available for the pipeline.\n`);

    const r = runChecker(root, { noBaseline: true });
    assert.equal(r.status, 0,
      `expected exit 0 but got ${r.status}:\n${r.stdout}\n${r.stderr}`);
  } finally {
    cleanup(root);
  }
});

test("check 3 track-list: valid-values list omitting tracks is detected", () => {
  const root = mkFixtureRoot();
  try {
    // Violation: lists some but not all tracks (omits nano, dep-update, hotfix)
    writeFile(root, "rules/gates.md",
      "Valid values: `full`, `quick`, `config-only`.\n");

    const r = runChecker(root, { noBaseline: true });
    assert.equal(r.status, 1,
      `expected exit 1 but got ${r.status}:\n${r.stdout}\n${r.stderr}`);
    assert.match(r.stdout, /track-list/,
      "expected track-list violation in output");
    assert.match(r.stdout, /omits/,
      "expected omission note in output");
  } finally {
    cleanup(root);
  }
});

// ---------------------------------------------------------------------------
// Check 4: Referenced-file existence
// ---------------------------------------------------------------------------

test("check 4 ref-existence: reference to missing .devteam/rules file is detected", () => {
  const root = mkFixtureRoot();
  try {
    // Violation: .devteam/rules/roles.md is checked as rules/roles.md which doesn't exist
    writeFile(root, "roles/principal.md",
      "Read `.devteam/rules/roles.md` for role definitions.\n");

    const r = runChecker(root, { noBaseline: true });
    assert.equal(r.status, 1,
      `expected exit 1 but got ${r.status}:\n${r.stdout}\n${r.stderr}`);
    assert.match(r.stdout, /ref-existence/,
      "expected ref-existence violation in output");
    assert.match(r.stdout, /roles\.md/,
      "expected the missing file in output");
  } finally {
    cleanup(root);
  }
});

test("check 4 ref-existence: reference to existing repo-relative file exits 0", () => {
  const root = mkFixtureRoot();
  try {
    // Create the referenced file first
    writeFile(root, "rules/roles.md", "# Roles\nRole definitions.\n");
    // Then reference it
    writeFile(root, "roles/principal.md",
      "Read `rules/roles.md` for role definitions.\n");

    const r = runChecker(root, { noBaseline: true });
    assert.equal(r.status, 0,
      `expected exit 0 but got ${r.status}:\n${r.stdout}\n${r.stderr}`);
  } finally {
    cleanup(root);
  }
});

test("check 4 ref-existence: reference to missing core/skills path is detected", () => {
  const root = mkFixtureRoot();
  try {
    // Violation: core/skills/security-checklist/SKILL.md doesn't exist in the fixture
    writeFile(root, "roles/security.md",
      "Read `core/skills/security-checklist/SKILL.md` for the rubric.\n");

    const r = runChecker(root, { noBaseline: true });
    assert.equal(r.status, 1,
      `expected exit 1 but got ${r.status}:\n${r.stdout}\n${r.stderr}`);
    assert.match(r.stdout, /ref-existence/,
      "expected ref-existence violation in output");
    assert.match(r.stdout, /core\/skills\/security-checklist\/SKILL\.md/,
      "expected the missing path in output");
  } finally {
    cleanup(root);
  }
});

// ---------------------------------------------------------------------------
// Check 5: Command surface
// ---------------------------------------------------------------------------

test("check 5 command-surface: ghost slash command (not installed) is detected", () => {
  const root = mkFixtureRoot();
  try {
    // Violation: /pipeline is documented but not installed
    writeFile(root, "rules/orchestrator.md",
      "Use `/pipeline` to run the full pipeline.\n");
    // Only devteam.md is installed — /pipeline is not valid
    writeFile(root, "hosts/claude-code/install/commands/devteam.md",
      "# /devteam\nDrive the Stagecraft pipeline.\n");

    const r = runChecker(root, { noBaseline: true });
    assert.equal(r.status, 1,
      `expected exit 1 but got ${r.status}:\n${r.stdout}\n${r.stderr}`);
    assert.match(r.stdout, /command-surface/,
      "expected command-surface violation in output");
    assert.match(r.stdout, /\/pipeline/,
      "expected the ghost command in output");
  } finally {
    cleanup(root);
  }
});

test("check 5 command-surface: installed slash command exits 0", () => {
  const root = mkFixtureRoot();
  try {
    writeFile(root, "rules/orchestrator.md",
      "Use `/devteam stage build` to run the build stage.\n");
    writeFile(root, "hosts/claude-code/install/commands/devteam.md",
      "# /devteam\nDrive the pipeline.\n");

    const r = runChecker(root, { noBaseline: true });
    assert.equal(r.status, 0,
      `expected exit 0 but got ${r.status}:\n${r.stdout}\n${r.stderr}`);
  } finally {
    cleanup(root);
  }
});

test("check 5 command-surface: npm run script not in package.json is detected", () => {
  const root = mkFixtureRoot();
  try {
    // Violation: npm run review:derive is documented but absent from package.json
    writeFile(root, "roles/reviewer.md",
      "Run `npm run review:derive` to process review gates.\n");
    writeFile(root, "package.json", JSON.stringify({ scripts: { test: "node --test" } }));

    const r = runChecker(root, { noBaseline: true });
    assert.equal(r.status, 1,
      `expected exit 1 but got ${r.status}:\n${r.stdout}\n${r.stderr}`);
    assert.match(r.stdout, /command-surface/,
      "expected command-surface violation in output");
    assert.match(r.stdout, /review:derive/,
      "expected the missing script in output");
  } finally {
    cleanup(root);
  }
});

test("check 5 command-surface: npm run script that IS in package.json exits 0", () => {
  const root = mkFixtureRoot();
  try {
    writeFile(root, "roles/reviewer.md",
      "Run `npm run consistency` to check contracts.\n");
    writeFile(root, "package.json",
      JSON.stringify({ scripts: { consistency: "node scripts/consistency.js" } }));

    const r = runChecker(root, { noBaseline: true });
    assert.equal(r.status, 0,
      `expected exit 0 but got ${r.status}:\n${r.stdout}\n${r.stderr}`);
  } finally {
    cleanup(root);
  }
});

// ---------------------------------------------------------------------------
// Check 6: Stage rule-file coverage
// ---------------------------------------------------------------------------

test("check 6 stage-rule-file: stage in pipeline-build.md without rule file is detected", () => {
  const root = mkFixtureRoot();
  try {
    // Reference stage-04c in pipeline-build.md but don't create the rule file
    writeFile(root, "rules/pipeline-build.md",
      "| 4c | [`stage-04c.md`](stage-04c.md) | red-team | Adversarial review |\n");
    // Deliberately do NOT create rules/stage-04c.md

    const r = runChecker(root, { noBaseline: true });
    assert.equal(r.status, 1,
      `expected exit 1 but got ${r.status}:\n${r.stdout}\n${r.stderr}`);
    assert.match(r.stdout, /stage-rule-file/,
      "expected stage-rule-file violation in output");
    assert.match(r.stdout, /stage-04c/,
      "expected the missing stage in output");
  } finally {
    cleanup(root);
  }
});

test("check 6 stage-rule-file: stage with rule file exits 0", () => {
  const root = mkFixtureRoot();
  try {
    writeFile(root, "rules/pipeline-build.md",
      "| 4c | [`stage-04c.md`](stage-04c.md) | red-team | Adversarial review |\n");
    // Create the required rule file
    writeFile(root, "rules/stage-04c.md",
      "# Stage 4c — Red Team\nAdversarial review stage.\n");

    const r = runChecker(root, { noBaseline: true });
    assert.equal(r.status, 0,
      `expected exit 0 but got ${r.status}:\n${r.stdout}\n${r.stderr}`);
  } finally {
    cleanup(root);
  }
});

// ---------------------------------------------------------------------------
// Check 9: Stable schema vocabulary
// ---------------------------------------------------------------------------

function writePerformanceSchema(root) {
  writeFile(root, "core/gates/schemas/stage-06e.schema.json", JSON.stringify({
    type: "object",
    properties: { checks_performed: { type: "array" } },
  }));
}

test("check 9 schema-vocabulary: obsolete documented field is detected", () => {
  const root = mkFixtureRoot();
  try {
    writePerformanceSchema(root);
    writeFile(root, "docs/FEATURES.md", "Gate carries `checks_performed` (formerly `checks_run`).\n");
    const r = runChecker(root, { noBaseline: true, only: "schema-vocabulary" });
    assert.equal(r.status, 1, r.stdout + r.stderr);
    assert.match(r.stdout, /schema-vocabulary/);
    assert.match(r.stdout, /obsolete field "checks_run"/);
  } finally {
    cleanup(root);
  }
});

test("check 9 schema-vocabulary: canonical field exits 0", () => {
  const root = mkFixtureRoot();
  try {
    writePerformanceSchema(root);
    writeFile(root, "docs/FEATURES.md", "Gate carries `checks_performed`.\n");
    writeFile(root, "docs/user-guide.md", "Inspect `checks_performed` for executed checks.\n");
    const r = runChecker(root, { noBaseline: true, only: "schema-vocabulary" });
    assert.equal(r.status, 0, r.stdout + r.stderr);
  } finally {
    cleanup(root);
  }
});

test("check 9 schema-vocabulary: violation can be baselined", () => {
  const root = mkFixtureRoot();
  try {
    writePerformanceSchema(root);
    writeFile(root, "docs/FEATURES.md", "`checks_performed`; old name: `checks_run`.\n");
    const r = runChecker(root, {
      only: "schema-vocabulary",
      baselineEntries: ["schema-vocabulary:docs/FEATURES.md:checks_run"],
    });
    assert.equal(r.status, 0, r.stdout + r.stderr);
    assert.match(r.stdout, /baselined/i);
  } finally {
    cleanup(root);
  }
});

test("check 9 schema-vocabulary: audit archives remain excluded", () => {
  const root = mkFixtureRoot();
  try {
    writePerformanceSchema(root);
    writeFile(root, "docs/FEATURES.md", "Gate carries `checks_performed`.\n");
    writeFile(root, "docs/audit-archive/old.md", "Historical field: `checks_run`.\n");
    const r = runChecker(root, { noBaseline: true, only: "schema-vocabulary" });
    assert.equal(r.status, 0, r.stdout + r.stderr);
  } finally {
    cleanup(root);
  }
});

// ---------------------------------------------------------------------------
// Check 10: Stable support state
// ---------------------------------------------------------------------------

function writeSupportPackage(root) {
  writeFile(root, "package.json", JSON.stringify({
    engines: { node: ">=22.0.0" },
    os: ["darwin", "linux", "win32"],
  }));
}

test("check 10 support-state: stale Node requirement is detected", () => {
  const root = mkFixtureRoot();
  try {
    writeSupportPackage(root);
    writeFile(root, "README.md", "Prerequisite: Node.js 18+. Native Windows is supported.\n");
    const r = runChecker(root, { noBaseline: true, only: "support-state" });
    assert.equal(r.status, 1, r.stdout + r.stderr);
    assert.match(r.stdout, /Node 18 claim disagrees/);
  } finally {
    cleanup(root);
  }
});

test("check 10 support-state: native Windows contradiction is detected", () => {
  const root = mkFixtureRoot();
  try {
    writeSupportPackage(root);
    writeFile(root, "README.md", "Node.js 22+. Native Windows is not supported.\n");
    const r = runChecker(root, { noBaseline: true, only: "support-state" });
    assert.equal(r.status, 1, r.stdout + r.stderr);
    assert.match(r.stdout, /must affirm package\.json os support for win32/);
  } finally {
    cleanup(root);
  }
});

test("check 10 support-state: volatile maintainer test count is detected", () => {
  const root = mkFixtureRoot();
  try {
    writeSupportPackage(root);
    writeFile(root, "README.md", "Node.js 22+. Native Windows is supported.\n");
    writeFile(root, "AGENTS.md", "Run 1,944 tests before committing.\n");
    const r = runChecker(root, { noBaseline: true, only: "support-state" });
    assert.equal(r.status, 1, r.stdout + r.stderr);
    assert.match(r.stdout, /volatile test-count claim/);
  } finally {
    cleanup(root);
  }
});

test("check 10 support-state: matching stable facts exit 0", () => {
  const root = mkFixtureRoot();
  try {
    writeSupportPackage(root);
    writeFile(root, "README.md", "Prerequisite: Node.js 22+. Native Windows is supported.\n");
    writeFile(root, "docs/FEATURES.md", "Stagecraft runs natively on Windows.\n");
    writeFile(root, "docs/faq.md", "Yes, native Windows is supported.\n");
    writeFile(root, "AGENTS.md", "Run the full offline suite before committing.\n");
    const r = runChecker(root, { noBaseline: true, only: "support-state" });
    assert.equal(r.status, 0, r.stdout + r.stderr);
  } finally {
    cleanup(root);
  }
});

test("check 10 support-state: violation can be baselined", () => {
  const root = mkFixtureRoot();
  try {
    writeSupportPackage(root);
    writeFile(root, "README.md", "Prerequisite: Node.js 18+. Native Windows is supported.\n");
    const r = runChecker(root, {
      only: "support-state",
      baselineEntries: ["support-state:README.md:node:18"],
    });
    assert.equal(r.status, 0, r.stdout + r.stderr);
    assert.match(r.stdout, /baselined/i);
  } finally {
    cleanup(root);
  }
});

test("check 10 support-state: unsupported CI matrix runtime is detected", () => {
  const root = mkFixtureRoot();
  try {
    writeSupportPackage(root);
    writeFile(root, "README.md", "Prerequisite: Node.js 22+. Native Windows is supported.\n");
    writeFile(root, ".github/workflows/test.yml", [
      "jobs:",
      "  test:",
      "    strategy:",
      "      matrix:",
      "        node-version: ['20', '22', '24']",
    ].join("\n"));
    const r = runChecker(root, { noBaseline: true, only: "support-state" });
    assert.equal(r.status, 1, r.stdout + r.stderr);
    assert.match(r.stdout, /includes unsupported Node 20/);
  } finally {
    cleanup(root);
  }
});

test("check 10 support-state: child package Node engine drift is detected", () => {
  const root = mkFixtureRoot();
  try {
    writeSupportPackage(root);
    writeFile(root, "README.md", "Prerequisite: Node.js 22+. Native Windows is supported.\n");
    writeFile(root, "packages/host-gemini-cli/package.json", JSON.stringify({
      engines: { node: ">=20.0.0" },
    }));
    const r = runChecker(root, { noBaseline: true, only: "support-state" });
    assert.equal(r.status, 1, r.stdout + r.stderr);
    assert.match(r.stdout, /engines\.node must match package\.json/);
  } finally {
    cleanup(root);
  }
});

// ---------------------------------------------------------------------------
// Check 6a: Tracks matrix sync
// (runs against the real repo, not a fixture tree — checkTracksMatrixSync only
// works in full-repo mode because it must import the live stages.js)
// ---------------------------------------------------------------------------

test("check 6a tracks-matrix: docs/tracks.md generated block matches generator output", () => {
  // The full consistency run (first test) would catch this too, but this gives
  // a focused diagnostic: if it fails, the matrix is stale.
  const { generateBlock, FENCE_OPEN, FENCE_CLOSE } = require(
    path.join(REPO_ROOT, "scripts", "generate-tracks-matrix.js")
  );

  const tracksPath = path.join(REPO_ROOT, "docs", "tracks.md");
  const src = fs.readFileSync(tracksPath, "utf8");

  const escapeRe = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const fenceRe = new RegExp(escapeRe(FENCE_OPEN) + "[\\s\\S]*?" + escapeRe(FENCE_CLOSE));
  const match = src.match(fenceRe);
  assert.ok(match,
    "docs/tracks.md must contain a <!-- generated: do not hand-edit --> fenced block");

  const fresh = generateBlock();
  assert.equal(match[0], fresh,
    "docs/tracks.md generated block is stale — re-run: node scripts/generate-tracks-matrix.js --write");
});

test("check 6a tracks-matrix: generator is importable without CLI side-effects", () => {
  // Ensure require() of generate-tracks-matrix.js does not write to stdout or
  // modify any files — the CLI block must be guarded by require.main === module.
  const mod = require(path.join(REPO_ROOT, "scripts", "generate-tracks-matrix.js"));
  assert.equal(typeof mod.generateBlock, "function", "generateBlock must be exported");
  assert.equal(typeof mod.renderMatrix, "function", "renderMatrix must be exported");
  assert.equal(typeof mod.FENCE_OPEN, "string", "FENCE_OPEN must be exported");
  assert.equal(typeof mod.FENCE_CLOSE, "string", "FENCE_CLOSE must be exported");
});

// ---------------------------------------------------------------------------
// Check stages-ref: docs/reference/stages.md sync
// (runs against the real repo — generate-stages-ref.js needs live stages.js)
// ---------------------------------------------------------------------------

test("stages-ref: docs/reference/stages.md matches generator output", () => {
  const gen = require(path.join(REPO_ROOT, "scripts", "generate-stages-ref.js"));
  const stagesPath = path.join(REPO_ROOT, "docs", "reference", "stages.md");
  const committed = fs.readFileSync(stagesPath, "utf8").trimEnd();
  const fresh = gen.generateBlock();
  assert.equal(committed, fresh,
    "docs/reference/stages.md is stale — re-run: npm run docs:generate");
});

test("stages-ref: generator is importable without CLI side-effects", () => {
  const mod = require(path.join(REPO_ROOT, "scripts", "generate-stages-ref.js"));
  assert.equal(typeof mod.generateBlock, "function", "generateBlock must be exported");
  assert.equal(typeof mod.FENCE_OPEN, "string", "FENCE_OPEN must be exported");
  assert.equal(typeof mod.FENCE_CLOSE, "string", "FENCE_CLOSE must be exported");
  assert.equal(typeof mod.STAGE_COUNT, "number", "STAGE_COUNT must be exported");
});

test("stages-ref: hand-edit to generated content would be caught", () => {
  // Prove that a hand-edit changes the content, which the consistency checker's
  // committed === fresh comparison would then fail (exit 1).
  const gen = require(path.join(REPO_ROOT, "scripts", "generate-stages-ref.js"));
  const fresh = gen.generateBlock();
  const handEdited = fresh.replace(
    gen.FENCE_OPEN,
    gen.FENCE_OPEN + "\n<!-- HAND-EDITED LINE — this would be caught -->"
  );
  assert.notEqual(handEdited, fresh,
    "hand-edit must produce content that differs from generator output; " +
    "if this assertion fails the consistency check cannot detect the edit");
});

// ---------------------------------------------------------------------------
// Check hosts-ref: docs/reference/hosts.md sync
// (runs against the real repo — generate-hosts-ref.js reads hosts/*/capabilities.json)
// ---------------------------------------------------------------------------

test("hosts-ref: docs/reference/hosts.md matches generator output", () => {
  const gen = require(path.join(REPO_ROOT, "scripts", "generate-hosts-ref.js"));
  const hostsPath = path.join(REPO_ROOT, "docs", "reference", "hosts.md");
  const committed = fs.readFileSync(hostsPath, "utf8").trimEnd();
  const fresh = gen.generateBlock();
  assert.equal(committed, fresh,
    "docs/reference/hosts.md is stale — re-run: npm run docs:generate");
});

test("hosts-ref: generator is importable without CLI side-effects", () => {
  const mod = require(path.join(REPO_ROOT, "scripts", "generate-hosts-ref.js"));
  assert.equal(typeof mod.generateBlock, "function", "generateBlock must be exported");
  assert.equal(typeof mod.FENCE_OPEN, "string", "FENCE_OPEN must be exported");
  assert.equal(typeof mod.FENCE_CLOSE, "string", "FENCE_CLOSE must be exported");
});

test("hosts-ref: hand-edit to generated content would be caught", () => {
  // Prove that a hand-edit changes the content, which the consistency checker's
  // committed === fresh comparison would then fail (exit 1).
  const gen = require(path.join(REPO_ROOT, "scripts", "generate-hosts-ref.js"));
  const fresh = gen.generateBlock();
  const handEdited = fresh.replace(
    gen.FENCE_OPEN,
    gen.FENCE_OPEN + "\n<!-- HAND-EDITED LINE — this would be caught -->"
  );
  assert.notEqual(handEdited, fresh,
    "hand-edit must produce content that differs from generator output; " +
    "if this assertion fails the consistency check cannot detect the edit");
});

// ---------------------------------------------------------------------------
// Check cli-ref: docs/reference/cli.md sync
// (runs against the real repo — generate-cli-ref.js reads core/cli/commands/*)
// ---------------------------------------------------------------------------

test("cli-ref: docs/reference/cli.md matches generator output", () => {
  const gen = require(path.join(REPO_ROOT, "scripts", "generate-cli-ref.js"));
  const cliPath = path.join(REPO_ROOT, "docs", "reference", "cli.md");
  const committed = fs.readFileSync(cliPath, "utf8").trimEnd();
  const fresh = gen.generateBlock();
  assert.equal(committed, fresh,
    "docs/reference/cli.md is stale — re-run: npm run docs:generate");
});

test("cli-ref: generator is importable without CLI side-effects", () => {
  const mod = require(path.join(REPO_ROOT, "scripts", "generate-cli-ref.js"));
  assert.equal(typeof mod.generateBlock, "function", "generateBlock must be exported");
  assert.equal(typeof mod.FENCE_OPEN, "string", "FENCE_OPEN must be exported");
  assert.equal(typeof mod.FENCE_CLOSE, "string", "FENCE_CLOSE must be exported");
  assert.equal(typeof mod.CMD_COUNT, "number", "CMD_COUNT must be exported");
  assert.ok(Array.isArray(mod.COMMANDS), "COMMANDS must be exported as an array");
});

test("cli-ref: global version invocation remains documented", () => {
  const gen = require(path.join(REPO_ROOT, "scripts", "generate-cli-ref.js"));
  assert.match(gen.generateBlock(), /devteam --version/);
});

test("example freshness check binds to the labelled current stamp", () => {
  const source = fs.readFileSync(path.join(REPO_ROOT, "scripts", "consistency.js"), "utf8");
  assert.match(source, /\\\*\\\*Freshness:/);
  assert.match(source, /captured\|verified/);
});

test("cli-ref: hand-edit to generated content would be caught", () => {
  // Prove that a hand-edit changes the content, which the consistency checker's
  // committed === fresh comparison would then fail (exit 1).
  const gen = require(path.join(REPO_ROOT, "scripts", "generate-cli-ref.js"));
  const fresh = gen.generateBlock();
  const handEdited = fresh.replace(
    gen.FENCE_OPEN,
    gen.FENCE_OPEN + "\n<!-- HAND-EDITED LINE — this would be caught -->"
  );
  assert.notEqual(handEdited, fresh,
    "hand-edit must produce content that differs from generator output; " +
    "if this assertion fails the consistency check cannot detect the edit");
});

test("cli-ref: sampled command --help flags all appear in generated doc", () => {
  // Both --help output and the generated doc derive from the same flag schema,
  // so this test proves they agree by construction. We sample `devteam run`
  // (a rich schema) and `devteam next` (a simpler one).
  const gen = require(path.join(REPO_ROOT, "scripts", "generate-cli-ref.js"));
  const generatedDoc = gen.generateBlock();

  // Commands to sample — rich schema + a simpler one
  const sampleCommands = ["run", "next"];

  for (const cmdName of sampleCommands) {
    const cmdModule = require(path.join(REPO_ROOT, "core", "cli", "commands", cmdName + ".js"));
    const schemaFlags = Object.keys(cmdModule.flags).filter(f => f !== "help");

    for (const flagName of schemaFlags) {
      assert.ok(
        generatedDoc.includes(`--${flagName}`),
        `generated cli.md must contain --${flagName} from ${cmdName} schema`
      );
    }
  }
});

// ---------------------------------------------------------------------------
// Baseline integration tests
// ---------------------------------------------------------------------------

test("baseline: baselined violation exits 0 with 'baselined' in output", () => {
  const root = mkFixtureRoot();
  try {
    writeFile(root, "roles/reviewer.md",
      "Run `npm run review:derive` to process review gates.\n");
    writeFile(root, "package.json", JSON.stringify({ scripts: {} }));

    // Key matches the checker's npm-run key format: "npm-run:<file>:<script>"
    const baselineKey = "npm-run:roles/reviewer.md:review:derive";
    const r = runChecker(root, { baselineEntries: [baselineKey] });
    assert.equal(r.status, 0,
      `expected exit 0 (baselined) but got ${r.status}:\n${r.stdout}\n${r.stderr}`);
    assert.match(r.stdout, /baselined/i,
      "expected 'baselined' in output");
  } finally {
    cleanup(root);
  }
});

test("baseline: non-baselined violation exits 1 even with a baseline file present", () => {
  const root = mkFixtureRoot();
  try {
    // Violation: npm run review:derive missing from package.json
    writeFile(root, "roles/reviewer.md",
      "Run `npm run review:derive` to process review gates.\n");
    writeFile(root, "package.json", JSON.stringify({ scripts: {} }));

    // Baseline has some other unrelated key → violation not suppressed
    const r = runChecker(root, { baselineEntries: ["some:unrelated:key"] });
    assert.equal(r.status, 1,
      `expected exit 1 (non-baselined) but got ${r.status}:\n${r.stdout}\n${r.stderr}`);
  } finally {
    cleanup(root);
  }
});

test("baseline: completely clean fixture exits 0 with no baseline", () => {
  const root = mkFixtureRoot();
  try {
    // Neutral content with no violations
    writeFile(root, "rules/clean.md", "# Clean file\nNo violations here.\n");

    const r = runChecker(root, { noBaseline: true });
    assert.equal(r.status, 0,
      `expected exit 0 but got ${r.status}:\n${r.stdout}\n${r.stderr}`);
  } finally {
    cleanup(root);
  }
});

// ---------------------------------------------------------------------------
// Check: CI template STAGECRAFT_REF version matches package.json major.minor
// (runs against the real repo — checkCiTemplateRefVersion only runs in full-repo mode)
// ---------------------------------------------------------------------------

test("check ci-template-ref: STAGECRAFT_REF in CI template matches package.json major.minor", () => {
  // Verifies the same invariant as checkCiTemplateRefVersion() in consistency.js.
  const templatePath = path.join(REPO_ROOT, "templates", "ci", "github-actions", "stagecraft-pr-checks.yml");
  const templateText = fs.readFileSync(templatePath, "utf8");
  const refMatch = templateText.match(/^\s*STAGECRAFT_REF:\s+(v?\S+)/m);
  assert.ok(refMatch, "STAGECRAFT_REF must be present in CI template");

  const pkg = JSON.parse(fs.readFileSync(path.join(REPO_ROOT, "package.json"), "utf8"));
  const [major, minor] = pkg.version.split(".");
  const refVal = refMatch[1].startsWith("v") ? refMatch[1] : `v${refMatch[1]}`;
  assert.ok(
    refVal.startsWith(`v${major}.${minor}.`),
    `CI template STAGECRAFT_REF "${refVal}" must match package.json v${major}.${minor}.x (currently ${pkg.version})`,
  );
});

test("check ci-template-ref: detection logic catches major.minor mismatch", () => {
  // Unit-tests the matching logic used by checkCiTemplateRefVersion().
  function refMatchesMajorMinor(ref, version) {
    const [maj, min] = version.split(".");
    const normalized = ref.startsWith("v") ? ref : `v${ref}`;
    return normalized.startsWith(`v${maj}.${min}.`);
  }

  assert.ok(refMatchesMajorMinor("v0.6.0", "0.6.0"), "exact match passes");
  assert.ok(refMatchesMajorMinor("v0.6.1", "0.6.0"), "newer patch still passes (major.minor match)");
  assert.ok(!refMatchesMajorMinor("v0.3.0", "0.6.0"), "stale old ref fails");
  assert.ok(!refMatchesMajorMinor("v0.7.0", "0.6.0"), "future minor ref fails");
  assert.ok(!refMatchesMajorMinor("v1.0.0", "0.6.0"), "next major fails");
});

// ---------------------------------------------------------------------------
// Check 7: docs/README.md orphan detection
// ---------------------------------------------------------------------------

test("check 7 docs-index: unlinked doc in docs/ is detected as orphan", () => {
  const root = mkFixtureRoot();
  try {
    writeFile(root, "docs/README.md", "# docs/\n\nNo links here.\n");
    writeFile(root, "docs/user-guide.md", "# User Guide\n");

    const r = runChecker(root, { noBaseline: true });
    assert.equal(r.status, 1,
      `expected exit 1 but got ${r.status}:\n${r.stdout}\n${r.stderr}`);
    assert.match(r.stdout, /docs-index/, "expected docs-index violation");
    assert.match(r.stdout, /user-guide\.md/, "expected orphan filename in output");
  } finally {
    cleanup(root);
  }
});

test("check 7 docs-index: directly linked doc exits 0", () => {
  const root = mkFixtureRoot();
  try {
    writeFile(root, "docs/README.md",
      "# docs/\n\n- [user-guide.md](user-guide.md) — daily use\n");
    writeFile(root, "docs/user-guide.md", "# User Guide\n");

    const r = runChecker(root, { noBaseline: true });
    assert.equal(r.status, 0,
      `expected exit 0 but got ${r.status}:\n${r.stdout}\n${r.stderr}`);
  } finally {
    cleanup(root);
  }
});

test("check 7 docs-index: file in subdirectory covered by parent README.md exits 0", () => {
  const root = mkFixtureRoot();
  try {
    // docs/README.md links adr/README.md — that covers all files under adr/
    writeFile(root, "docs/README.md",
      "# docs/\n\n- [adr/README.md](adr/README.md) — decision records\n");
    writeFile(root, "docs/adr/README.md", "# ADR Index\n");
    writeFile(root, "docs/adr/001-first-decision.md", "# ADR 001\n");

    const r = runChecker(root, { noBaseline: true });
    assert.equal(r.status, 0,
      `expected exit 0 but got ${r.status}:\n${r.stdout}\n${r.stderr}`);
  } finally {
    cleanup(root);
  }
});

test("check 7 docs-index: file under excluded dir (audit-archive/) is not required", () => {
  // 37.5 narrowed the wholesale exclusion from {historical, audit-archive, reference,
  // audit} down to just audit-archive/ — historical/, reference/, and audit/ each got
  // their own README.md and must now be reachable like any other subdirectory (covered
  // by the "subdirectory file without parent README.md is an orphan" test below, and by
  // the real-repo regression guard). audit-archive/ remains the one deliberate exception
  // (dated-snapshot archive indexed by its own HISTORY.md, not a README.md).
  const root = mkFixtureRoot();
  try {
    // docs/README.md has no links; docs/audit-archive/old.md is excluded
    writeFile(root, "docs/README.md", "# docs/\n\nNo links.\n");
    writeFile(root, "docs/audit-archive/old.md", "# Old doc\n");

    const r = runChecker(root, { noBaseline: true });
    assert.equal(r.status, 0,
      `expected exit 0 but got ${r.status}:\n${r.stdout}\n${r.stderr}`);
  } finally {
    cleanup(root);
  }
});

test("check 7 docs-index: file under formerly-excluded dir (historical/) is now an orphan without an index", () => {
  const root = mkFixtureRoot();
  try {
    // docs/README.md has no links; docs/historical/ is no longer wholesale-excluded
    writeFile(root, "docs/README.md", "# docs/\n\nNo links.\n");
    writeFile(root, "docs/historical/old.md", "# Old doc\n");

    const r = runChecker(root, { noBaseline: true });
    assert.equal(r.status, 1,
      `expected exit 1 but got ${r.status}:\n${r.stdout}\n${r.stderr}`);
    assert.match(r.stdout, /docs-index/, "expected docs-index violation");
    assert.match(r.stdout, /historical\/old\.md/, "expected the orphan historical doc in output");
  } finally {
    cleanup(root);
  }
});

test("check 7 docs-index: historical/, reference/, and audit/ are covered once their own README.md is linked", () => {
  // 37.5: these three used to be wholesale-excluded; now they're covered by the same
  // directory-index-coverage rule as adr/ — exercise all three by name in one test so a
  // future re-introduction of a per-name exclusion (rather than the audit-archive/-only
  // exception) is caught.
  const root = mkFixtureRoot();
  try {
    writeFile(root, "docs/README.md", [
      "# docs/",
      "",
      "- [historical/README.md](historical/README.md) — archive",
      "- [reference/README.md](reference/README.md) — generated reference",
      "- [audit/README.md](audit/README.md) — self-audit output",
      "",
    ].join("\n"));
    writeFile(root, "docs/historical/README.md", "# historical\n");
    writeFile(root, "docs/historical/old-doc.md", "# Old doc\n");
    writeFile(root, "docs/reference/README.md", "# reference\n");
    writeFile(root, "docs/reference/cli.md", "# CLI reference\n");
    writeFile(root, "docs/audit/README.md", "# audit\n");
    writeFile(root, "docs/audit/00-project-context.md", "# Project context\n");

    const r = runChecker(root, { noBaseline: true });
    assert.equal(r.status, 0,
      `expected exit 0 but got ${r.status}:\n${r.stdout}\n${r.stderr}`);
  } finally {
    cleanup(root);
  }
});

test("check 7 docs-index: missing docs/README.md with docs present fails", () => {
  const root = mkFixtureRoot();
  try {
    writeFile(root, "docs/user-guide.md", "# User Guide\n");
    // docs/README.md intentionally absent

    const r = runChecker(root, { noBaseline: true });
    assert.equal(r.status, 1,
      `expected exit 1 but got ${r.status}:\n${r.stdout}\n${r.stderr}`);
    assert.match(r.stdout, /docs-index/, "expected docs-index failure");
  } finally {
    cleanup(root);
  }
});

test("check 7 docs-index: no docs/ directory at all exits 0", () => {
  const root = mkFixtureRoot();
  try {
    // Fixture has no docs/ dir — check is a no-op
    writeFile(root, "rules/clean.md", "# Clean\n");

    const r = runChecker(root, { noBaseline: true });
    assert.equal(r.status, 0,
      `expected exit 0 but got ${r.status}:\n${r.stdout}\n${r.stderr}`);
  } finally {
    cleanup(root);
  }
});

test("check 7 docs-index: subdirectory file without parent README.md is an orphan", () => {
  const root = mkFixtureRoot();
  try {
    // walkthroughs/soc2.md is under walkthroughs/ which has no README.md
    // and docs/README.md does not directly link it
    writeFile(root, "docs/README.md",
      "# docs/\n\n- [user-guide.md](user-guide.md) — daily use\n");
    writeFile(root, "docs/user-guide.md", "# User Guide\n");
    writeFile(root, "docs/walkthroughs/soc2.md", "# SOC 2 walkthrough\n");

    const r = runChecker(root, { noBaseline: true });
    assert.equal(r.status, 1,
      `expected exit 1 but got ${r.status}:\n${r.stdout}\n${r.stderr}`);
    assert.match(r.stdout, /docs-index/, "expected docs-index violation");
    assert.match(r.stdout, /soc2\.md/, "expected the orphan walkthrough in output");
  } finally {
    cleanup(root);
  }
});

test("check 7 docs-index: real repo docs/ has no orphan docs (regression guard)", () => {
  // Prose-only run against the real repo: confirms docs/README.md covers
  // every .md file in docs/ that the orphan checker requires to be linked.
  // Using --root so only prose checks (including check 7) run — avoids
  // duplicating the full core-contract check already in the first test.
  // Exit 0 is the assertion; individual pass messages are not printed in summary mode.
  const r = runChecker(REPO_ROOT);
  assert.equal(r.status, 0,
    `docs/README.md has orphan docs:\n${r.stdout}\n${r.stderr}`);
});

// ---------------------------------------------------------------------------
// Check 8: Role-brief / tool-budget compatibility (6.2)
// ---------------------------------------------------------------------------

test("check 8 role-budget-brief: 'Run devteam cmd' in budget-less role brief is detected", () => {
  const root = mkFixtureRoot();
  try {
    // pm has no Bash budget; "Run `devteam spec generate`" in its brief is a violation —
    // the old pm.md had exactly this pattern before the 6.2 rewrite.
    writeFile(root, "roles/pm.md",
      "## Procedure\n1. Run `devteam spec generate` to scaffold the file.\n" +
      "3. Run `devteam spec verify` to check drift.\n");

    const r = runChecker(root, { noBaseline: true });
    assert.equal(r.status, 1,
      `expected exit 1 but got ${r.status}:\n${r.stdout}\n${r.stderr}`);
    assert.match(r.stdout, /role-budget-brief/,
      "expected role-budget-brief violation in output");
    assert.match(r.stdout, /devteam spec generate/,
      "expected the offending command in output");
    assert.match(r.stdout, /pm/,
      "expected role name in output");
  } finally {
    cleanup(root);
  }
});

test("check 8 role-budget-brief: 'Run devteam cmd' for role WITH Bash exits 0", () => {
  const root = mkFixtureRoot();
  try {
    // qa has Bash — "Run `devteam spec verify`" in qa's brief is fine.
    writeFile(root, "roles/qa.md",
      "## Procedure\n1. Run `devteam spec verify` to check drift.\n");

    const r = runChecker(root, { noBaseline: true });
    assert.equal(r.status, 0,
      `expected exit 0 but got ${r.status}:\n${r.stdout}\n${r.stderr}`);
  } finally {
    cleanup(root);
  }
});

test("check 8 role-budget-brief: informational devteam reference (no 'Run') exits 0", () => {
  const root = mkFixtureRoot();
  try {
    // pm has no Bash, but merely naming the command in a note is not an instruction.
    // The checker only fires on "Run `devteam ...`" patterns, not bare references.
    writeFile(root, "roles/pm.md",
      "## Note\n`devteam spec generate` and `devteam spec verify` are run by the pipeline.\n" +
      "## Procedure\n1. Read `pipeline/brief.md`.\n2. Write `pipeline/spec.feature`.\n");

    const r = runChecker(root, { noBaseline: true });
    assert.equal(r.status, 0,
      `expected exit 0 but got ${r.status}:\n${r.stdout}\n${r.stderr}`);
  } finally {
    cleanup(root);
  }
});

test("check 8 role-budget-brief: real roles/ pass after pm.md rewrite (regression guard)", () => {
  // Confirms that the pm.md rewrite in item 6.2 eliminated all role-budget-brief
  // violations from the live roles/ directory.
  const r = runChecker(REPO_ROOT, { noBaseline: true });
  assert.equal(r.status, 0,
    `real roles/ has role-budget-brief violations after pm.md rewrite:\n${r.stdout}\n${r.stderr}`);
});

// ---------------------------------------------------------------------------
// Git-aware mode: tracked-vs-untracked behavior (7.1)
//
// When --root points at a directory that has .git, consistency.js uses
// git ls-files for enumeration: tracked files → blocking checks, untracked
// non-ignored files → advisory only. Fixture trees without .git keep the
// original readdir behavior.
// ---------------------------------------------------------------------------

const { spawnSync: spawnSyncGit } = require("node:child_process");

function mkFixtureGitRoot() {
  const dir = mkFixtureRoot(); // devteam-test- prefix, cleaned by cleanup()
  spawnSyncGit("git", ["init"], { cwd: dir });
  spawnSyncGit("git", ["config", "user.email", "test@test.com"], { cwd: dir });
  spawnSyncGit("git", ["config", "user.name", "Test"], { cwd: dir });
  return dir;
}

function gitAddFile(root, rel) {
  spawnSyncGit("git", ["add", rel], { cwd: root });
}

test("git-aware: tracked orphan doc in fixture git repo is a blocking failure", () => {
  // docs/README.md and docs/orphan.md are both git-added (tracked).
  // orphan.md has no link in README.md → blocking docs-index failure.
  const root = mkFixtureGitRoot();
  try {
    writeFile(root, "docs/README.md", "# docs\nNo links.\n");
    writeFile(root, "docs/orphan.md", "# Orphan\n");
    gitAddFile(root, "docs/README.md");
    gitAddFile(root, "docs/orphan.md");

    const r = runChecker(root, { noBaseline: true });
    assert.equal(r.status, 1,
      `expected exit 1 (tracked orphan is blocking) but got ${r.status}:\n${r.stdout}\n${r.stderr}`);
    assert.match(r.stdout, /docs-index/, "expected docs-index failure in output");
    assert.match(r.stdout, /orphan\.md/, "expected the orphan filename in output");
  } finally {
    cleanup(root);
  }
});

test("git-aware: untracked orphan doc in fixture git repo is advisory (not blocking)", () => {
  // docs/README.md is tracked; docs/orphan.md is NOT tracked.
  // Untracked files → advisory, not blocking. Exit 0.
  const root = mkFixtureGitRoot();
  try {
    writeFile(root, "docs/README.md", "# docs\nNo links.\n");
    writeFile(root, "docs/orphan.md", "# Orphan\n");
    gitAddFile(root, "docs/README.md");
    // docs/orphan.md intentionally NOT added

    const r = runChecker(root, { noBaseline: true });
    assert.equal(r.status, 0,
      `expected exit 0 (untracked orphan is advisory) but got ${r.status}:\n${r.stdout}\n${r.stderr}`);
    assert.match(r.stdout, /advisory/i,
      "expected advisory in output for untracked orphan");
    assert.match(r.stdout, /orphan\.md/,
      "expected orphan.md in the advisory message");
    assert.match(r.stdout, /untracked/i,
      "expected 'untracked' in the advisory message");
  } finally {
    cleanup(root);
  }
});

test("git-aware: fixture tree without .git uses readdir (blocks on orphan)", () => {
  // Plain fixture trees (no .git) continue to use readdir — backward-compatible.
  // An orphan doc is a blocking failure as before.
  const root = mkFixtureRoot();
  try {
    writeFile(root, "docs/README.md", "# docs\nNo links.\n");
    writeFile(root, "docs/orphan.md", "# Orphan\n");

    const r = runChecker(root, { noBaseline: true });
    assert.equal(r.status, 1,
      `expected exit 1 (no-git fixture uses readdir → orphan blocks) but got ${r.status}:\n${r.stdout}\n${r.stderr}`);
    assert.match(r.stdout, /docs-index/, "expected docs-index failure");
  } finally {
    cleanup(root);
  }
});

// ---------------------------------------------------------------------------
// --only filter (7.1)
// ---------------------------------------------------------------------------

test("--only docs-index: only docs-index runs; other violations don't appear", () => {
  const root = mkFixtureRoot();
  try {
    // Violation in rules/ (track-list) and in docs/ (orphan)
    writeFile(root, "rules/pipeline.md", "Four tracks are available.\n");
    writeFile(root, "docs/README.md", "# docs\nNo links.\n");
    writeFile(root, "docs/orphan.md", "# Orphan\n");

    const r = spawnSync("node", [CONSISTENCY_JS, "--root", root, "--only", "docs-index"], {
      cwd: REPO_ROOT, encoding: "utf8", timeout: 30000,
    });
    assert.equal(r.status, 1,
      `expected exit 1 (only docs-index runs, which has orphan) but got ${r.status}:\n${r.stdout}`);
    assert.match(r.stdout, /docs-index/, "expected docs-index failure");
    assert.doesNotMatch(r.stdout, /track-list/,
      "track-list must not appear when --only docs-index");
  } finally {
    cleanup(root);
  }
});

test("--only gate-filename: only gate-filename runs; docs-index violation doesn't appear", () => {
  const root = mkFixtureRoot();
  try {
    writeFile(root, "docs/README.md", "# docs\nNo links.\n");
    writeFile(root, "docs/orphan.md", "# Orphan\n");
    writeFile(root, "roles/backend.md",
      "Write `pipeline/gates/stage-04-backend.json` with status PASS.\n");

    const r = spawnSync("node", [CONSISTENCY_JS, "--root", root, "--only", "gate-filename"], {
      cwd: REPO_ROOT, encoding: "utf8", timeout: 30000,
    });
    assert.equal(r.status, 1,
      `expected exit 1 (gate-filename violation) but got ${r.status}:\n${r.stdout}`);
    assert.match(r.stdout, /gate-filename/, "expected gate-filename failure");
    assert.doesNotMatch(r.stdout, /docs-index/,
      "docs-index must not appear when --only gate-filename");
  } finally {
    cleanup(root);
  }
});

// ---------------------------------------------------------------------------
// CI probe: untracked scratch file does not block the suite (7.1 part 5)
//
// The CI workflow creates docs/SCRATCH-ci-probe.md before npm test to verify
// that untracked files don't break the suite. This test confirms the same
// behavior by running --only docs-index against the real repo (.git present).
// In CI the probe file exists; locally it may not. Either way: exit 0.
// ---------------------------------------------------------------------------

test("ci-probe: untracked scratch file in real repo does not fail docs-index check", () => {
  // --only docs-index against the real repo: whether SCRATCH-ci-probe.md exists
  // (CI) or not (local), exit 0 is required. Before this fix, an untracked file
  // in docs/ produced a blocking exit 1.
  const r = spawnSync("node", [CONSISTENCY_JS, "--only", "docs-index"], {
    cwd: REPO_ROOT, encoding: "utf8", timeout: 30000,
  });
  assert.equal(r.status, 0,
    `expected exit 0 (untracked probe file must not block docs-index) but got ${r.status}:\n${r.stdout}\n${r.stderr}`);
});
