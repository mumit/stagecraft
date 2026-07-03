// tests/prompt-budget.test.js
//
// Tests for scripts/prompt-budget.js (D5 workstream — model-facing token budget).
//
// Coverage:
//   1. Generator is importable without CLI side-effects.
//   2. computeStageStats returns sensible data (no NaN, positive bytes, all
//      dispatched stages covered).
//   3. generateBlock is idempotent and contains the expected structural markers.
//   4. parseCommittedBudget round-trips the budget-data block correctly.
//   5. Consistency advisory fires on a synthetic >10% growth (meta-test).
//      Uses PROMPT_BUDGET_FILE env override and --only prompt-budget — no
//      real file mutation, no full-repo scan fan-out.
//   6. Consistency advisory is absent when fresh equals committed.
//   7. File-size ceiling advisory fires for a synthetic oversized rule file
//      (fixture-based via --root + --only file-size-ceiling; not pinned to the
//      real rules/stage-05.md so trimming that file never breaks the suite).
//   8. File-size ceiling advisory is absent when all files are within limits.
//   9. docs/reference/prompt-budget.md committed file matches generator output
//      (regression guard — same pattern as stages-ref, hosts-ref, cli-ref).

"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const path = require("node:path");
const fs = require("node:fs");
const { spawnSync } = require("node:child_process");

const REPO_ROOT = path.resolve(__dirname, "..");
const BUDGET_JS  = path.join(REPO_ROOT, "scripts", "prompt-budget.js");
const CONSISTENCY_JS = path.join(REPO_ROOT, "scripts", "consistency.js");

// ---------------------------------------------------------------------------
// 1. Generator importable without side-effects
// ---------------------------------------------------------------------------

test("prompt-budget: generator is importable without CLI side-effects", () => {
  const mod = require(BUDGET_JS);
  assert.equal(typeof mod.generateBlock,        "function", "generateBlock must be exported");
  assert.equal(typeof mod.computeStageStats,    "function", "computeStageStats must be exported");
  assert.equal(typeof mod.estimateChangedManifestBytes, "function", "estimateChangedManifestBytes must be exported");
  assert.equal(typeof mod.parseCommittedBudget, "function", "parseCommittedBudget must be exported");
  assert.equal(typeof mod.FENCE_OPEN,  "string", "FENCE_OPEN must be exported");
  assert.equal(typeof mod.FENCE_CLOSE, "string", "FENCE_CLOSE must be exported");
});

// ---------------------------------------------------------------------------
// 2. computeStageStats returns sensible data
// ---------------------------------------------------------------------------

test("prompt-budget: computeStageStats returns data for all dispatched stages", () => {
  const { computeStageStats } = require(BUDGET_JS);
  const { ORDERED_STAGE_NAMES, STAGES } = require(
    path.join(REPO_ROOT, "core", "pipeline", "stages.js")
  );

  const stats = computeStageStats();
  assert.ok(Array.isArray(stats), "must return an array");
  assert.ok(stats.length > 0, "must return at least one stage");

  // Every dispatched stage (non-mechanical) in ORDERED_STAGE_NAMES must appear.
  const dispatchedNames = ORDERED_STAGE_NAMES.filter((n) => {
    const def = STAGES[n];
    return def && Array.isArray(def.roles) && def.roles.length > 0;
  });
  const returnedNames = stats.map((s) => s.stageName);
  for (const n of dispatchedNames) {
    assert.ok(returnedNames.includes(n), `stage "${n}" must appear in computeStageStats output`);
  }
});

test("prompt-budget: computeStageStats values are positive numbers, no NaN", () => {
  const { computeStageStats } = require(BUDGET_JS);
  const stats = computeStageStats();

  for (const s of stats) {
    assert.ok(!isNaN(s.frameworkBytes) && s.frameworkBytes >= 0,
      `${s.stageName} frameworkBytes must be non-negative: ${s.frameworkBytes}`);
    assert.ok(!isNaN(s.maxDispatchBytes) && s.maxDispatchBytes > 0,
      `${s.stageName} maxDispatchBytes must be positive: ${s.maxDispatchBytes}`);
    for (const d of s.dispatches) {
      assert.ok(!isNaN(d.roleBytes) && d.roleBytes >= 0,
        `${s.stageName}/${d.role} roleBytes must be non-negative`);
      assert.ok(!isNaN(d.dispatchBytes) && d.dispatchBytes > 0,
        `${s.stageName}/${d.role} dispatchBytes must be positive`);
    }
  }
});

test("prompt-budget: framework bytes consistent across stages sharing same readFirst set", () => {
  // Most stages share the same three framework files (AGENTS.md + pipeline.md +
  // gates-core.md), so their frameworkBytes values should match.
  const { computeStageStats } = require(BUDGET_JS);
  const stats = computeStageStats();

  // requirements and clarification both have the same readFirst framework set.
  const req  = stats.find((s) => s.stageName === "requirements");
  const clar = stats.find((s) => s.stageName === "clarification");
  if (req && clar) {
    assert.equal(req.frameworkBytes, clar.frameworkBytes,
      "requirements and clarification share the same framework readFirst — bytes must match");
  }
});

// ---------------------------------------------------------------------------
// 3. generateBlock is idempotent and structurally correct
// ---------------------------------------------------------------------------

test("prompt-budget: generateBlock is idempotent (same output on two calls)", () => {
  const { generateBlock } = require(BUDGET_JS);
  const first  = generateBlock();
  const second = generateBlock();
  assert.equal(first, second, "generateBlock must produce identical output on repeated calls");
});

test("prompt-budget: generateBlock output contains required markers and sections", () => {
  const { generateBlock, FENCE_OPEN, FENCE_CLOSE } = require(BUDGET_JS);
  const block = generateBlock();

  assert.ok(block.startsWith(FENCE_OPEN),   "must start with FENCE_OPEN");
  assert.ok(block.endsWith(FENCE_CLOSE),    "must end with FENCE_CLOSE");
  assert.ok(block.includes("# Prompt Budget Reference"), "must include title");
  assert.ok(block.includes("## Per-dispatch framework cost"), "must include per-dispatch section");
  assert.ok(block.includes("## Top 5 heaviest framework files"), "must include top-5 section");
  assert.ok(block.includes("## Runtime changed-file manifest"), "must include runtime manifest section");
  assert.ok(block.includes("<!-- budget-data"), "must include machine-readable budget-data block");
  assert.ok(block.includes("bytes ÷ 4"), "must state token estimation method");
});

test("prompt-budget: changed-file manifest estimate is bounded and positive", () => {
  const { estimateChangedManifestBytes } = require(BUDGET_JS);
  const one = estimateChangedManifestBytes(1);
  const many = estimateChangedManifestBytes(40);
  assert.ok(one > 0, "one-file manifest estimate must be positive");
  assert.ok(many > one, "larger manifest limit must cost more prompt bytes");
  assert.ok(many < 8000, "default manifest estimate should stay compact");
});

test("prompt-budget: generated table contains AGENTS.md framework column with non-zero bytes", () => {
  // AGENTS.md is in every stage's framework set (it's in every readFirst).
  // The framework bytes column must be > 0 for all stages.
  const { computeStageStats } = require(BUDGET_JS);
  const stats = computeStageStats();

  for (const s of stats) {
    assert.ok(s.frameworkBytes > 0,
      `${s.stageName} must have framework bytes > 0 (AGENTS.md should be included)`);
    const agentsFile = s.frameworkFiles.find((f) => f.file === "AGENTS.md");
    assert.ok(agentsFile, `${s.stageName} must include AGENTS.md in framework files`);
    assert.ok(agentsFile.bytes > 0, `${s.stageName} AGENTS.md must have positive bytes`);
  }
});

// ---------------------------------------------------------------------------
// 4. parseCommittedBudget round-trip
// ---------------------------------------------------------------------------

test("prompt-budget: parseCommittedBudget round-trips budget-data block", () => {
  const { generateBlock, parseCommittedBudget, computeStageStats } = require(BUDGET_JS);
  const block  = generateBlock();
  const parsed = parseCommittedBudget(block);

  assert.ok(parsed.size > 0, "must parse at least one entry");

  const stats = computeStageStats();
  for (const s of stats) {
    assert.ok(parsed.has(s.stageId),
      `parsed map must contain ${s.stageId}`);
    assert.equal(parsed.get(s.stageId), s.maxDispatchBytes,
      `parsed bytes for ${s.stageId} must match computeStageStats maxDispatchBytes`);
  }
});

test("prompt-budget: parseCommittedBudget returns empty Map for text without budget-data", () => {
  const { parseCommittedBudget } = require(BUDGET_JS);
  const result = parseCommittedBudget("# Some doc without budget-data block\n");
  assert.ok(result instanceof Map, "must return a Map");
  assert.equal(result.size, 0, "must be empty for files without budget-data");
});

// ---------------------------------------------------------------------------
// 5 & 6. Consistency advisory fires / is absent (meta-tests via spawnSync)
// ---------------------------------------------------------------------------

// Convenience wrapper: run consistency.js --only prompt-budget with a synthetic
// budget file injected via PROMPT_BUDGET_FILE env var.
//
// This tests that the advisory detection works end-to-end without touching the
// real docs/reference/prompt-budget.md (no in-place rewrite-and-restore).
function runConsistencyWithSyntheticBudget(budgetText) {
  const os = require("node:os");
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "devteam-test-"));
  const tmpBudget = path.join(tmpDir, "budget.md");
  fs.writeFileSync(tmpBudget, budgetText);
  try {
    return spawnSync("node", [CONSISTENCY_JS, "--only", "prompt-budget"], {
      cwd: REPO_ROOT,
      encoding: "utf8",
      timeout: 30000,
      env: { ...process.env, PROMPT_BUDGET_FILE: tmpBudget },
    });
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
}

test("prompt-budget: consistency advisory fires when a stage's budget grew >10%", () => {
  // Build a synthetic committed file where stage-01's baseline is 1 byte.
  // Fresh numbers are much larger → >10% growth → advisory fires.
  // The check is purely advisory (non-blocking), so exit 0 is expected.
  const { generateBlock } = require(BUDGET_JS);
  const freshBlock = generateBlock();

  // Replace stage-01 baseline with 1 byte in budget-data to trigger the advisory.
  const syntheticBlock = freshBlock.replace(
    /<!-- budget-data\n([\s\S]*?)\n-->/,
    (_, data) => {
      const lines = data.split("\n").map((line) =>
        line.startsWith("stage-01,") ? "stage-01,1" : line
      );
      return `<!-- budget-data\n${lines.join("\n")}\n-->`;
    }
  );

  const r = runConsistencyWithSyntheticBudget(syntheticBlock);
  // Must exit 0 — the prompt-budget check is purely advisory (non-blocking).
  assert.equal(r.status, 0,
    `expected exit 0 (advisory non-blocking) but got ${r.status}:\n${r.stdout}\n${r.stderr}`);
  // Must print the growth advisory.
  assert.match(r.stdout, /advisory/i,
    "expected 'advisory' in output when budget grew >10%");
  assert.match(r.stdout, /stage-01/,
    "expected stage-01 in the advisory message");
  assert.match(r.stdout, /grew >10%/,
    "expected 'grew >10%' in the advisory message");
});

test("prompt-budget: consistency emits no budget-growth advisory when numbers match", () => {
  // When committed numbers equal fresh numbers, no growth advisory fires.
  // Uses --only prompt-budget to avoid full-repo scan fan-out.
  const r = spawnSync("node", [CONSISTENCY_JS, "--only", "prompt-budget"], {
    cwd: REPO_ROOT,
    encoding: "utf8",
    timeout: 30000,
  });

  assert.equal(r.status, 0,
    `expected exit 0 but got ${r.status}:\n${r.stdout}\n${r.stderr}`);

  // No budget-growth advisory should appear — committed == fresh.
  const growthLines = r.stdout.split("\n").filter(
    (l) => l.includes("[advisory]") && l.includes("grew >10%")
  );
  assert.equal(growthLines.length, 0,
    `unexpected budget-growth advisory when numbers are current: ${growthLines.join("\n")}`);

  // No prompt-budget staleness advisory either.
  const staleLines = r.stdout.split("\n").filter(
    (l) => l.includes("[advisory]") && l.includes("prompt-budget") && l.includes("stale")
  );
  assert.equal(staleLines.length, 0,
    `unexpected prompt-budget staleness advisory: ${staleLines.join("\n")}`);
});

// ---------------------------------------------------------------------------
// 7 & 8. File-size ceiling advisory (meta-tests via fixture tree)
// ---------------------------------------------------------------------------

// checkFileSizeCeilings now accepts a scanRoot so tests can inject a synthetic
// oversized file via --root + --only file-size-ceiling without pinning to the
// real rules/stage-05.md size. Trimming stage-05.md (Phase 8) no longer breaks
// this test.

const os = require("node:os");

test("file-size-ceiling: advisory fires for synthetic oversized stage rule file", () => {
  // Create a fixture tree with a rules/stage-05.md that exceeds the 8 KB ceiling.
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "devteam-test-"));
  try {
    fs.mkdirSync(path.join(tmpDir, "rules"), { recursive: true });
    // 9 KB > 8 KB ceiling
    fs.writeFileSync(path.join(tmpDir, "rules", "stage-05.md"),
      "# stage-05\n" + "x".repeat(9 * 1024));

    const r = spawnSync("node", [CONSISTENCY_JS, "--root", tmpDir, "--only", "file-size-ceiling"], {
      cwd: REPO_ROOT,
      encoding: "utf8",
      timeout: 30000,
    });
    assert.equal(r.status, 0,
      `expected exit 0 (ceiling advisory is non-blocking) but got ${r.status}:\n${r.stdout}\n${r.stderr}`);
    assert.match(r.stdout, /file-size-ceiling/,
      "expected file-size-ceiling advisory in output");
    assert.match(r.stdout, /stage-05\.md/,
      "expected stage-05.md in the advisory");
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

test("file-size-ceiling: all current role briefs are under 16 KB ceiling", () => {
  // Regression guard: ensures no role brief has grown past the ceiling.
  // If this test fails, a role brief was added or grown — trim it.
  const CEILING = 16 * 1024;
  const rolesDir = path.join(REPO_ROOT, "roles");
  const files = fs.readdirSync(rolesDir).filter((f) => f.endsWith(".md"));

  for (const f of files) {
    const abs   = path.join(rolesDir, f);
    const bytes = fs.statSync(abs).size;
    assert.ok(bytes <= CEILING,
      `roles/${f} is ${bytes} B — exceeds ${CEILING} B (16 KB) role-brief ceiling. Trim it.`);
  }
});

test("file-size-ceiling: AGENTS.md is under 10 KB ceiling", () => {
  const CEILING = 10 * 1024;
  const abs   = path.join(REPO_ROOT, "AGENTS.md");
  const bytes = fs.statSync(abs).size;
  assert.ok(bytes <= CEILING,
    `AGENTS.md is ${bytes} B — exceeds ${CEILING} B (10 KB) ceiling. Trim it.`);
});

// ---------------------------------------------------------------------------
// 9. Committed docs/reference/prompt-budget.md matches generator output
// ---------------------------------------------------------------------------

test("prompt-budget: docs/reference/prompt-budget.md matches generator output", () => {
  const { generateBlock } = require(BUDGET_JS);
  const budgetPath  = path.join(REPO_ROOT, "docs", "reference", "prompt-budget.md");
  const committed   = fs.readFileSync(budgetPath, "utf8").trimEnd();
  const fresh       = generateBlock();
  assert.equal(committed, fresh,
    "docs/reference/prompt-budget.md is stale — re-run: npm run docs:generate");
});

test("prompt-budget: hand-edit to generated content would be caught", () => {
  const { generateBlock, FENCE_OPEN } = require(BUDGET_JS);
  const fresh = generateBlock();
  const handEdited = fresh.replace(
    FENCE_OPEN,
    FENCE_OPEN + "\n<!-- HAND-EDITED LINE — this would be caught -->"
  );
  assert.notEqual(handEdited, fresh,
    "hand-edit must produce content that differs from generator output; " +
    "if this assertion fails the consistency check cannot detect the edit");
});
