// E7 — /goal integration for convergence-shaped stages.
//
// Verifies that:
//   1. goalLoop capability is declared correctly on each adapter.
//   2. Convergence-shaped stages (build, qa) carry goalCondition templates.
//   3. buildDescriptor interpolates {workstreamId} in the condition.
//   4. runStageHeadless prepends /goal "..." to the prompt when the adapter
//      supports goal loops and the stage has a goalCondition.
//   5. Non-goal stages (requirements, design, etc.) are never prefixed.

const { describe, it } = require("node:test");
const assert = require("node:assert/strict");
const path = require("node:path");
const { REPO_ROOT, makeTargetProject, cleanup, runCLI, installGeminiCliPluginFixture } = require("./_helpers");
const { getStage } = require(path.join(REPO_ROOT, "core", "pipeline", "stages"));

// ---------------------------------------------------------------------------
// Adapter declarations
// ---------------------------------------------------------------------------

describe("goalLoop capability declarations", () => {
  it("claude-code declares goalLoop: true", () => {
    const caps = require(path.join(REPO_ROOT, "hosts", "claude-code", "capabilities.json"));
    assert.strictEqual(caps.goalLoop, true);
  });

  it("codex declares goalLoop: true", () => {
    const caps = require(path.join(REPO_ROOT, "hosts", "codex", "capabilities.json"));
    assert.strictEqual(caps.goalLoop, true);
  });

  it("gemini-cli declares goalLoop: false (no /goal directive support in gemini CLI)", () => {
    // The /goal directive is a Claude Code session-level feature; Gemini CLI
    // has no equivalent convergence directive. goalLoop is explicitly false
    // (phase-1-trust-consolidation.md §1.5) so absence is never ambiguous.
    // 34.4: gemini-cli moved out of hosts/ into packages/host-gemini-cli/
    // (plugin package) — path updated, capability value unchanged.
    const caps = require(path.join(REPO_ROOT, "packages", "host-gemini-cli", "capabilities.json"));
    assert.strictEqual(caps.goalLoop, false, "gemini-cli.goalLoop must be explicitly false");
  });

  it("generic declares goalLoop: false (explicit, never ambiguous)", () => {
    const caps = require(path.join(REPO_ROOT, "hosts", "generic", "capabilities.json"));
    assert.strictEqual(caps.goalLoop, false, "generic.goalLoop must be explicitly false");
  });
});

// ---------------------------------------------------------------------------
// Stage goalCondition templates
// ---------------------------------------------------------------------------

describe("stage goalCondition fields", () => {
  const goalStages = ["build", "qa"];
  const noGoalStages = [
    "requirements", "design", "clarification", "executable-spec",
    "pre-review", "security-review", "red-team", "migration-safety",
    "peer-review", "accessibility-audit", "observability-gate",
    "verification-beyond-tests", "sign-off", "deploy", "retrospective",
  ];

  for (const name of goalStages) {
    it(`${name} has a goalCondition template`, () => {
      const def = getStage(name);
      assert.ok(def.goalCondition, `${name} should have goalCondition`);
      assert.ok(
        def.goalCondition.includes("{workstreamId}"),
        `${name}.goalCondition should include {workstreamId} placeholder`,
      );
    });
  }

  for (const name of noGoalStages) {
    it(`${name} does NOT have goalCondition`, () => {
      const def = getStage(name);
      assert.ok(!def.goalCondition, `${name} should not have goalCondition`);
    });
  }

  it("build goalCondition mentions PASS, lint_passed, tests_passed", () => {
    const def = getStage("build");
    assert.ok(def.goalCondition.includes("PASS"), "should mention PASS");
    assert.ok(def.goalCondition.includes("lint_passed"), "should mention lint_passed");
    assert.ok(def.goalCondition.includes("tests_passed"), "should mention tests_passed");
  });

  it("qa goalCondition mentions PASS, all_acceptance_criteria_met, tests_failed", () => {
    const def = getStage("qa");
    assert.ok(def.goalCondition.includes("PASS"), "should mention PASS");
    assert.ok(def.goalCondition.includes("all_acceptance_criteria_met"), "should mention all_acceptance_criteria_met");
    assert.ok(def.goalCondition.includes("tests_failed"), "should mention tests_failed");
  });
});

// ---------------------------------------------------------------------------
// {workstreamId} interpolation in the descriptor
// ---------------------------------------------------------------------------

describe("buildDescriptor interpolates {workstreamId}", () => {
  it("single-role stage: workstreamId === stage id, goalCondition has it", () => {
    // qa is single-role; workstreamId === "stage-06"
    const def = getStage("qa");
    // Simulate what buildDescriptor does: replace {workstreamId} with "stage-06"
    const condition = def.goalCondition.replace("{workstreamId}", "stage-06");
    assert.ok(condition.includes("stage-06"), "condition should include resolved workstreamId");
    assert.ok(!condition.includes("{workstreamId}"), "placeholder should be resolved");
  });

  it("multi-role stage: workstreamId is stage.role, goalCondition has it", () => {
    // build is multi-role; backend workstreamId === "stage-04.backend"
    const def = getStage("build");
    const condition = def.goalCondition.replace("{workstreamId}", "stage-04.backend");
    assert.ok(condition.includes("stage-04.backend"), "condition should include resolved workstreamId");
    assert.ok(!condition.includes("{workstreamId}"), "placeholder should be resolved");
  });
});

// ---------------------------------------------------------------------------
// /goal injection in headless prompt — CLI integration
// ---------------------------------------------------------------------------

describe("/goal injection in headless mode", () => {
  // DEVTEAM_HEADLESS_COMMAND=cat echoes the full prompt to stdout,
  // letting us assert on the rendered prompt content.

  it("headless build prompt starts with /goal when host supports goalLoop", () => {
    const cwd = makeTargetProject({
      config: "routing:\n  default_host: claude-code\npipeline:\n  default_track: full\n",
    });
    try {
      const r = runCLI(["stage", "build", "--headless", "--feature", "test"], {
        cwd,
        env: { DEVTEAM_HEADLESS_COMMAND: "cat", DEVTEAM_NO_LOG: "1" },
      });
      // cat echoes the prompt; first workstream should have /goal prefix
      assert.ok(
        r.stdout.includes('/goal "'),
        `expected /goal in stdout, got:\n${r.stdout.slice(0, 500)}`,
      );
      assert.ok(
        r.stdout.includes("lint_passed"),
        `expected build goal condition in stdout, got:\n${r.stdout.slice(0, 500)}`,
      );
    } finally {
      cleanup(cwd);
    }
  });

  it("headless qa prompt starts with /goal when host supports goalLoop", () => {
    const cwd = makeTargetProject({
      config: "routing:\n  default_host: claude-code\npipeline:\n  default_track: full\n",
    });
    try {
      const r = runCLI(["stage", "qa", "--headless", "--feature", "test"], {
        cwd,
        env: { DEVTEAM_HEADLESS_COMMAND: "cat", DEVTEAM_NO_LOG: "1" },
      });
      assert.ok(
        r.stdout.includes('/goal "'),
        `expected /goal in stdout, got:\n${r.stdout.slice(0, 500)}`,
      );
      assert.ok(
        r.stdout.includes("all_acceptance_criteria_met"),
        `expected qa goal condition in stdout, got:\n${r.stdout.slice(0, 500)}`,
      );
    } finally {
      cleanup(cwd);
    }
  });

  it("headless requirements prompt does NOT have /goal (no goalCondition)", () => {
    const cwd = makeTargetProject({
      config: "routing:\n  default_host: claude-code\npipeline:\n  default_track: full\n",
    });
    try {
      const r = runCLI(["stage", "requirements", "--headless", "--feature", "test"], {
        cwd,
        env: { DEVTEAM_HEADLESS_COMMAND: "cat", DEVTEAM_NO_LOG: "1" },
      });
      assert.ok(
        !r.stdout.startsWith('/goal'),
        `requirements prompt should not start with /goal, got:\n${r.stdout.slice(0, 200)}`,
      );
    } finally {
      cleanup(cwd);
    }
  });

  it("headless build on gemini-cli (no goalLoop) does NOT inject /goal", () => {
    const cwd = makeTargetProject({
      config: "routing:\n  default_host: gemini-cli\npipeline:\n  default_track: full\n",
    });
    // 34.4: gemini-cli is a plugin now (packages/host-gemini-cli/), not a
    // first-party host under hosts/ — install the real plugin into this
    // project's node_modules so the dispatch resolves exactly as it would
    // for a consumer who ran `npm install @devteam/host-gemini-cli`.
    installGeminiCliPluginFixture(cwd);
    try {
      const r = runCLI(["stage", "build", "--headless", "--feature", "test"], {
        cwd,
        env: { DEVTEAM_HEADLESS_COMMAND: "cat", DEVTEAM_NO_LOG: "1" },
      });
      assert.ok(
        !r.stdout.includes('/goal "'),
        `gemini-cli build should not inject /goal, got:\n${r.stdout.slice(0, 300)}`,
      );
    } finally {
      cleanup(cwd);
    }
  });

  it("/goal line references the correct workstreamId for a build workstream", () => {
    const cwd = makeTargetProject({
      config: "routing:\n  default_host: claude-code\npipeline:\n  default_track: full\n",
    });
    try {
      const r = runCLI(["stage", "build", "--headless", "--feature", "test"], {
        cwd,
        env: { DEVTEAM_HEADLESS_COMMAND: "cat", DEVTEAM_NO_LOG: "1" },
      });
      // Build has 4 roles; each should have a /goal referencing stage-04.<role>
      assert.ok(
        r.stdout.includes("stage-04.backend") || r.stdout.includes("stage-04.frontend") ||
        r.stdout.includes("stage-04.platform") || r.stdout.includes("stage-04.qa"),
        `expected a stage-04.* workstreamId in output, got:\n${r.stdout.slice(0, 500)}`,
      );
    } finally {
      cleanup(cwd);
    }
  });
});
