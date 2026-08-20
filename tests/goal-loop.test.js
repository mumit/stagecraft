// E7 / ADR-023 — convergence conditions for build and qa.
//
// E7 originally delivered the condition as claude-code's `/goal "<condition>"`
// slash command. Its handler rejects input over 4,000 characters and a real
// dispatch prompt never fits, so the directive was always dropped and the
// condition reached no model at all. ADR-023 moved it into the prompt body.
//
// Verifies that:
//   1. Convergence-shaped stages (build, qa) still carry goalCondition templates.
//   2. buildDescriptor interpolates {workstreamId} in the condition.
//   3. The resolved condition is rendered into the prompt body, on every host.
//   4. Non-convergence stages never carry one.
//   5. No host slash command is composed, and no capability claims one.

const { describe, it } = require("node:test");
const assert = require("node:assert/strict");
const path = require("node:path");
const { REPO_ROOT, makeTargetProject, cleanup, runCLI } = require("./_helpers");
const { getStage } = require(path.join(REPO_ROOT, "core", "pipeline", "stages"));

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
// ADR-023: the condition is delivered in the prompt body
// ---------------------------------------------------------------------------

// Hosts that can actually run `stage --headless` (generic declares
// headless: false; it is covered by the every-adapter render test below).
const HEADLESS_HOSTS = ["claude-code", "codex", "antigravity"];

function headlessPrompt(cwd, stage) {
  // DEVTEAM_HEADLESS_COMMAND=cat echoes the full prompt to stdout, so this is
  // the exact byte stream the host CLI would have received.
  return runCLI(["stage", stage, "--headless", "--feature", "test"], {
    cwd,
    env: { DEVTEAM_HEADLESS_COMMAND: "cat", DEVTEAM_NO_LOG: "1" },
  }).stdout;
}

describe("goal condition reaches the prompt body", () => {
  for (const host of HEADLESS_HOSTS) {
    it(`build prompt states the condition on ${host}`, () => {
      const cwd = makeTargetProject({
        config: `routing:\n  default_host: ${host}\npipeline:\n  default_track: full\n`,
      });
      try {
        const out = headlessPrompt(cwd, "build");
        assert.match(out, /## Done when/, `no Done-when section for ${host}`);
        assert.match(out, /lint_passed/, `build condition missing for ${host}`);
      } finally {
        cleanup(cwd);
      }
    });
  }

  it("qa prompt states the qa condition", () => {
    const cwd = makeTargetProject({
      config: "routing:\n  default_host: claude-code\npipeline:\n  default_track: full\n",
    });
    try {
      const out = headlessPrompt(cwd, "qa");
      assert.match(out, /## Done when/);
      assert.match(out, /all_acceptance_criteria_met/);
    } finally {
      cleanup(cwd);
    }
  });

  it("the rendered condition carries the resolved workstreamId, not the placeholder", () => {
    const cwd = makeTargetProject({
      config: "routing:\n  default_host: claude-code\npipeline:\n  default_track: full\n",
    });
    try {
      const out = headlessPrompt(cwd, "build");
      assert.match(out, /stage-04\.backend/);
      assert.doesNotMatch(out, /\{workstreamId\}/);
    } finally {
      cleanup(cwd);
    }
  });

  it("a non-convergence stage gets no Done-when section", () => {
    const cwd = makeTargetProject({
      config: "routing:\n  default_host: claude-code\npipeline:\n  default_track: full\n",
    });
    try {
      assert.doesNotMatch(headlessPrompt(cwd, "requirements"), /## Done when/);
    } finally {
      cleanup(cwd);
    }
  });
});

describe("ADR-023: no host slash command is composed", () => {
  for (const host of HEADLESS_HOSTS) {
    it(`${host} receives no /goal directive`, () => {
      const cwd = makeTargetProject({
        config: `routing:\n  default_host: ${host}\npipeline:\n  default_track: full\n`,
      });
      try {
        assert.doesNotMatch(headlessPrompt(cwd, "build"), /\/goal "/,
          `${host} still receives a /goal prefix`);
      } finally {
        cleanup(cwd);
      }
    });
  }

  it("no adapter declares goalLoop or promptCharLimit any more", () => {
    // Both described claude-code's /goal handler rather than a host property.
    // Leaving either in place would reintroduce the shrink fallbacks that
    // stripped the inlined framework and patchItems from build and qa.
    const fs = require("node:fs");
    const roots = [path.join(REPO_ROOT, "hosts"), path.join(REPO_ROOT, "packages")];
    const offenders = [];
    for (const root of roots) {
      if (!fs.existsSync(root)) continue;
      for (const entry of fs.readdirSync(root)) {
        const capFile = path.join(root, entry, "capabilities.json");
        if (!fs.existsSync(capFile)) continue;
        const caps = JSON.parse(fs.readFileSync(capFile, "utf8"));
        for (const key of ["goalLoop", "promptCharLimit"]) {
          if (key in caps) offenders.push(`${entry}.${key}`);
        }
      }
    }
    assert.deepEqual(offenders, []);
  });
});

describe("ADR-023 regression: build and qa keep their full prompt", () => {
  // The bug this ADR fixes: to make room for a /goal prefix that could never
  // fit, the shrink chain dropped patchItems and the inlined framework from
  // exactly these two stages. Both must survive now.
  it("build keeps the inlined framework and its patch items", () => {
    const cwd = makeTargetProject({
      config: "routing:\n  default_host: claude-code\npipeline:\n  default_track: full\n",
    });
    try {
      const out = runCLI(
        ["stage", "build", "--headless", "--feature", "test", "--patch", "--from", "qa"],
        { cwd, env: { DEVTEAM_HEADLESS_COMMAND: "cat", DEVTEAM_NO_LOG: "1" } },
      ).stdout;
      assert.match(out, /## Framework \(inlined below/, "inlined framework was dropped");
      assert.match(out, /## Done when/, "condition missing");
    } finally {
      cleanup(cwd);
    }
  });
});

describe("every adapter renders the condition, not just the headless ones", () => {
  // Stronger than the CLI tests above: exercises each adapter's own
  // renderStagePrompt directly, so a host with its own renderer (claude-code,
  // generic) cannot quietly skip the section.
  const fs = require("node:fs");
  const descriptor = {
    stage: "stage-04", name: "build", workstreamId: "stage-04.backend", role: "backend",
    objective: "Implement it.",
    goalCondition: 'pipeline/gates/stage-04.backend.json exists with status: "PASS", lint_passed: true',
    readFirst: ["AGENTS.md"], allowedWrites: ["src/"], artifact: "a.md", template: "t.md",
    toolBudget: null,
  };

  const adapterDirs = [];
  for (const root of [path.join(REPO_ROOT, "hosts"), path.join(REPO_ROOT, "packages")]) {
    if (!fs.existsSync(root)) continue;
    for (const entry of fs.readdirSync(root)) {
      if (fs.existsSync(path.join(root, entry, "adapter.js"))) adapterDirs.push([entry, path.join(root, entry, "adapter.js")]);
    }
  }

  for (const [name, file] of adapterDirs) {
    it(`${name} renders the Done-when section`, () => {
      const adapter = require(file);
      if (typeof adapter.renderStagePrompt !== "function") return;
      const out = adapter.renderStagePrompt(descriptor, {
        cwd: REPO_ROOT, track: "full", feature: "f", orchestrator: "test",
      });
      assert.match(out, /## Done when/, `${name} drops the convergence condition`);
      assert.match(out, /lint_passed/, `${name} drops the condition text`);
      assert.doesNotMatch(out, /\/goal "/, `${name} still composes a /goal directive`);
    });
  }
});
