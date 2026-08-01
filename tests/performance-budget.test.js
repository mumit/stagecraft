// B2 — Performance budget stage (stage-06e) structural tests.
//
// Covers:
//   1. Stage definition — stage id, role, objective, gate skeleton
//   2. Gate schema — valid gates pass, required fields enforced
//   3. Track inclusion — full + quick + hotfix include it; nano / config-only / dep-update do not
//   4. Stage ordering — performance-budget sits after verification-beyond-tests and before sign-off
//   5. requiredCapabilities.shell — must be true (needs CLI tools)
//   6. Skill file exists with correct frontmatter
//   7. Template file exists
//   8. Journal — stage-06e log line includes budget status

const { describe, it } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { REPO_ROOT, makeTargetProject, cleanup, seedGate } = require("./_helpers");

const {
  STAGES,
  STAGES_BY_TRACK,
  orderedStageNamesForTrack,
  isStageInTrack,
  getStage,
} = require(path.join(REPO_ROOT, "core", "pipeline", "stages"));

const { buildEvents, summarizeGate } = require(path.join(REPO_ROOT, "core", "log", "journal"));

function loadSchema(name) {
  return JSON.parse(fs.readFileSync(
    path.join(REPO_ROOT, "core", "gates", "schemas", `${name}.schema.json`), "utf8",
  ));
}

// ─── 1. Stage definition ──────────────────────────────────────────────────────

describe("performance-budget stage definition", () => {
  it("stage exists in STAGES with id stage-06e", () => {
    const s = STAGES["performance-budget"];
    assert.ok(s, "performance-budget missing from STAGES");
    assert.equal(s.stage, "stage-06e");
  });

  it("role is qa", () => {
    const s = getStage("performance-budget");
    assert.deepEqual(s.roles, ["qa"]);
  });

  it("gate skeleton includes checks_performed, lighthouse, bundle, load_test, budget_exceeded, skipped_reason", () => {
    const s = getStage("performance-budget");
    assert.ok(Array.isArray(s.gate.checks_performed));
    assert.equal(s.gate.lighthouse, null);
    assert.equal(s.gate.bundle, null);
    assert.equal(s.gate.load_test, null);
    assert.equal(s.gate.budget_exceeded, false);
    assert.equal(s.gate.skipped_reason, null);
  });

  it("artifact is pipeline/performance-report.md", () => {
    assert.equal(getStage("performance-budget").artifact, "pipeline/performance-report.md");
  });

  it("allowedWrites includes performance-report.md and stage-06e.json", () => {
    const { allowedWrites } = getStage("performance-budget");
    assert.ok(allowedWrites.includes("pipeline/performance-report.md"));
    assert.ok(allowedWrites.some((p) => p.includes("stage-06e.json")));
  });

  it("requiredCapabilities.shell is true (needs CLI tools)", () => {
    const s = getStage("performance-budget");
    assert.equal(s.requiredCapabilities?.shell, true);
  });
});

// ─── 2. Gate schema ───────────────────────────────────────────────────────────

describe("stage-06e gate schema", () => {
  it("schema file exists and parses", () => {
    const schema = loadSchema("stage-06e");
    assert.equal(schema.$id, "urn:stagecraft:schema:stage-06e");
  });

  it("schema declares the required fields for B2", () => {
    const schema = loadSchema("stage-06e");
    for (const field of ["checks_performed", "budget_exceeded"]) {
      assert.ok(Array.isArray(schema.required) && schema.required.includes(field),
        `schema.required must include "${field}"`);
    }
    // Base gate fields must also be required
    for (const field of ["stage", "status", "orchestrator", "track", "timestamp", "blockers", "warnings"]) {
      assert.ok(schema.required.includes(field), `schema.required must include base field "${field}"`);
    }
  });

  it("schema defines lighthouse, bundle, load_test, skipped_reason properties", () => {
    const schema = loadSchema("stage-06e");
    assert.ok(schema.properties.lighthouse, "schema must define lighthouse property");
    assert.ok(schema.properties.bundle, "schema must define bundle property");
    assert.ok(schema.properties.load_test, "schema must define load_test property");
    assert.ok(schema.properties.skipped_reason, "schema must define skipped_reason property");
    assert.ok(schema.properties.budget_exceeded, "schema must define budget_exceeded property");
    assert.ok(schema.properties.checks_performed, "schema must define checks_performed property");
  });

  it("checks_performed items are restricted to known check types", () => {
    const schema = loadSchema("stage-06e");
    const items = schema.properties.checks_performed.items;
    assert.ok(items, "checks_performed should have items definition");
    // Should enumerate valid check types
    assert.ok(items.enum.includes("lighthouse"), "enum must include lighthouse");
    assert.ok(items.enum.includes("bundle"), "enum must include bundle");
    assert.ok(items.enum.includes("load-test"), "enum must include load-test");
  });

  it("budget_exceeded is typed as boolean", () => {
    const schema = loadSchema("stage-06e");
    assert.equal(schema.properties.budget_exceeded.type, "boolean");
  });

  it("lighthouse.score has minimum 0, maximum 1", () => {
    const schema = loadSchema("stage-06e");
    const score = schema.properties.lighthouse.properties.score;
    assert.equal(score.minimum, 0);
    assert.equal(score.maximum, 1);
  });

  it("load_test.error_rate has minimum 0, maximum 1", () => {
    const schema = loadSchema("stage-06e");
    const er = schema.properties.load_test.properties.error_rate;
    assert.equal(er.minimum, 0);
    assert.equal(er.maximum, 1);
  });
});

// ─── 3. Track inclusion ───────────────────────────────────────────────────────

describe("performance-budget track inclusion", () => {
  it("included in full, hotfix", () => {
    for (const t of ["full", "hotfix"]) {
      assert.ok(isStageInTrack("performance-budget", t), `performance-budget should be in ${t}`);
    }
  });

  // 29.4: quick is flagged compact_qa, so performance-budget no longer
  // dispatches standalone there — it's folded into "verification-sweep"
  // alongside accessibility-audit. STAGES_BY_TRACK still lists it (that's
  // the declarative "quick needs this coverage" answer, unchanged); only
  // the dispatch-time ordering (orderedStageNamesForTrack) folds it.
  it("folded into verification-sweep on quick (29.4 compact_qa)", () => {
    assert.ok(STAGES_BY_TRACK.quick.includes("performance-budget"), "quick's declarative stage list should still include performance-budget");
    assert.ok(!isStageInTrack("performance-budget", "quick"), "performance-budget should not dispatch standalone on quick post-fold");
    assert.ok(isStageInTrack("verification-sweep", "quick"), "verification-sweep should dispatch on quick");
  });

  it("excluded from nano, config-only, dep-update", () => {
    for (const t of ["nano", "config-only", "dep-update"]) {
      assert.ok(!isStageInTrack("performance-budget", t), `performance-budget should NOT be in ${t}`);
    }
  });

  it("full track includes performance-budget", () => {
    assert.ok(orderedStageNamesForTrack("full").includes("performance-budget"));
  });
});

// ─── 4. Stage ordering ────────────────────────────────────────────────────────

describe("performance-budget stage ordering", () => {
  it("performance-budget sits after verification-beyond-tests and before sign-off in full", () => {
    const full = orderedStageNamesForTrack("full");
    const vb = full.indexOf("verification-beyond-tests");
    const pb = full.indexOf("performance-budget");
    const so = full.indexOf("sign-off");
    assert.ok(vb >= 0, "verification-beyond-tests should be in full");
    assert.ok(pb >= 0, "performance-budget should be in full");
    assert.ok(so >= 0, "sign-off should be in full");
    assert.ok(vb < pb, `verification-beyond-tests(${vb}) should come before performance-budget(${pb})`);
    assert.ok(pb < so, `performance-budget(${pb}) should come before sign-off(${so})`);
  });

  // 29.4: performance-budget's slot on quick is now the folded
  // "verification-sweep" stage (see "folded into verification-sweep on
  // quick" above) — check its position instead of the standalone stage.
  it("verification-sweep (folded performance-budget slot) sits after qa and before sign-off in quick", () => {
    const quick = orderedStageNamesForTrack("quick");
    const qa = quick.indexOf("qa");
    const vs = quick.indexOf("verification-sweep");
    const so = quick.indexOf("sign-off");
    assert.ok(qa < vs, `qa(${qa}) should come before verification-sweep(${vs})`);
    assert.ok(vs < so, `verification-sweep(${vs}) should come before sign-off(${so})`);
  });

  it("performance-budget sits after observability-gate and before sign-off in hotfix", () => {
    const hotfix = orderedStageNamesForTrack("hotfix");
    const ob = hotfix.indexOf("observability-gate");
    const pb = hotfix.indexOf("performance-budget");
    const so = hotfix.indexOf("sign-off");
    assert.ok(ob < pb, `observability-gate(${ob}) should come before performance-budget(${pb})`);
    assert.ok(pb < so, `performance-budget(${pb}) should come before sign-off(${so})`);
  });
});

// ─── 5. Skill and template files ─────────────────────────────────────────────

describe("performance-budget skill and template", () => {
  it("SKILL.md exists under skills/performance-budget/", () => {
    const p = path.join(REPO_ROOT, "skills", "performance-budget", "SKILL.md");
    assert.ok(fs.existsSync(p), `Missing skill: ${p}`);
  });

  it("SKILL.md starts with YAML frontmatter declaring the skill name", () => {
    const content = fs.readFileSync(path.join(REPO_ROOT, "skills", "performance-budget", "SKILL.md"), "utf8");
    assert.ok(content.startsWith("---\n"), "SKILL.md should start with YAML front matter");
    assert.ok(content.includes("name: performance-budget"), "SKILL.md should declare name: performance-budget");
  });

  it("performance-report-template.md exists under templates/", () => {
    const p = path.join(REPO_ROOT, "templates", "performance-report-template.md");
    assert.ok(fs.existsSync(p), `Missing template: ${p}`);
  });

  it("performance-report-template.md contains Lighthouse, Bundle, and Load test sections", () => {
    const content = fs.readFileSync(path.join(REPO_ROOT, "templates", "performance-report-template.md"), "utf8");
    assert.ok(content.includes("Lighthouse"), "template should have Lighthouse section");
    assert.ok(content.includes("Bundle"), "template should have Bundle section");
    assert.ok(content.includes("Load test") || content.includes("Load Test"), "template should have Load test section");
  });
});

// ─── 6. Journal log line ─────────────────────────────────────────────────────

describe("journal stage-06e log line", () => {
  it("log line includes budget status for a PASS gate", () => {
    const cwd = makeTargetProject();
    try {
      seedGate(cwd, "stage-06e.json", {
        stage: "stage-06e",
        status: "PASS",
        checks_performed: ["lighthouse", "bundle"],
        lighthouse: { score: 0.91, lcp_ms: 1800 },
        bundle: { total_size_kb: 312, delta_kb: 8 },
        load_test: null,
        budget_exceeded: false,
        skipped_reason: null,
      });
      const events = buildEvents(cwd);
      const event = events.find((e) => e.kind === "gate" && e.gate.stage === "stage-06e");
      assert.ok(event, "journal should have an event for stage-06e");
      const { extras } = summarizeGate(event.gate);
      assert.ok(extras.includes("budgets met"), `extras should say "budgets met", got: "${extras}"`);
    } finally {
      cleanup(cwd);
    }
  });

  it("log line includes budget status for a FAIL gate", () => {
    const cwd = makeTargetProject();
    try {
      seedGate(cwd, "stage-06e.json", {
        stage: "stage-06e",
        status: "FAIL",
        checks_performed: ["lighthouse"],
        lighthouse: { score: 0.62 },
        bundle: null,
        load_test: null,
        budget_exceeded: true,
        skipped_reason: null,
        blockers: ["[performance] LCP 3200ms > 2500ms budget"],
      });
      const events = buildEvents(cwd);
      const event = events.find((e) => e.kind === "gate" && e.gate.stage === "stage-06e");
      assert.ok(event, "journal should have an event for stage-06e");
      const { extras } = summarizeGate(event.gate);
      assert.ok(extras.includes("budget exceeded"), `extras should say "budget exceeded", got: "${extras}"`);
    } finally {
      cleanup(cwd);
    }
  });
});
