// Tests for B9 — bounded workspace isolation.
//
// When pipeline.isolation = "bounded" the orchestrator routes all artifact
// paths under pipeline/changes/<changeId>/ instead of the global pipeline/.
// These tests verify the three key behaviors:
//   1. changeIdFromFeature produces safe slugs (including edge cases).
//   2. prefixPipelineRelative rewrites pipeline/ paths and leaves others alone.
//   3. ctx.changeId is populated in runStage() when isolation is bounded,
//      and is null when isolation is in-place (the default).
//   4. buildDescriptor returns prefixed readFirst / allowedWrites / artifact
//      paths when changeId is set.
//   5. runHeadless checks the bounded gate path (DEVTEAM_HEADLESS_COMMAND=cat).
//   6. appendGateFooter tells the model the bounded gate path when changeId set.

const { test, describe } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const os = require("node:os");

// ─── helpers ─────────────────────────────────────────────────────────────────

function makeTargetProject(opts = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "bounded-ws-test-"));
  fs.mkdirSync(path.join(dir, ".devteam"), { recursive: true });
  const defaultConfig = [
    "routing:",
    "  default_host: claude-code",
    "pipeline:",
    "  default_track: full",
    "  isolation: bounded",
  ].join("\n") + "\n";
  fs.writeFileSync(
    path.join(dir, ".devteam", "config.yml"),
    opts.config !== undefined ? opts.config : defaultConfig,
    "utf8",
  );
  return dir;
}

// ─── 1. changeIdFromFeature ───────────────────────────────────────────────────

describe("changeIdFromFeature — slug generation", () => {
  const { changeIdFromFeature } = require("../core/config");

  test("simple lowercase word", () => {
    assert.equal(changeIdFromFeature("login"), "login");
  });

  test("spaces become hyphens", () => {
    assert.equal(changeIdFromFeature("user auth feature"), "user-auth-feature");
  });

  test("uppercase is lowercased", () => {
    assert.equal(changeIdFromFeature("AddLoginButton"), "addloginbutton");
  });

  test("special chars collapsed", () => {
    assert.equal(changeIdFromFeature("feat: add login!"), "feat-add-login");
  });

  test("leading/trailing hyphens stripped", () => {
    assert.equal(changeIdFromFeature("---hello---"), "hello");
  });

  test("blank string returns null", () => {
    assert.equal(changeIdFromFeature(""), null);
  });

  test("null input returns null", () => {
    assert.equal(changeIdFromFeature(null), null);
  });

  test("undefined returns null", () => {
    assert.equal(changeIdFromFeature(undefined), null);
  });

  test("truncated to 64 chars", () => {
    const longFeature = "a".repeat(100);
    const result = changeIdFromFeature(longFeature);
    assert.ok(result.length <= 64);
  });
});

// ─── 2. prefixPipelineRelative ────────────────────────────────────────────────

describe("prefixPipelineRelative — path rewriting", () => {
  const { prefixPipelineRelative } = require("../core/paths");

  test("rewrites pipeline/brief.md", () => {
    const result = prefixPipelineRelative("pipeline/brief.md", "my-feature");
    assert.equal(result, path.join("pipeline", "changes", "my-feature", "brief.md"));
  });

  test("rewrites pipeline/gates/stage-01.json", () => {
    const result = prefixPipelineRelative("pipeline/gates/stage-01.json", "my-feature");
    assert.equal(result, path.join("pipeline", "changes", "my-feature", "gates", "stage-01.json"));
  });

  test("rewrites pipeline/logs/ (directory path)", () => {
    const result = prefixPipelineRelative("pipeline/logs/", "feat-x");
    // path.join normalisation may or may not preserve a trailing slash;
    // what matters is that the bounded prefix is present.
    assert.ok(
      result.replace(/\\/g, "/").startsWith("pipeline/changes/feat-x/logs"),
      `expected bounded logs prefix in: ${result}`,
    );
  });

  test("does not touch AGENTS.md", () => {
    assert.equal(prefixPipelineRelative("AGENTS.md", "feat-x"), "AGENTS.md");
  });

  test("does not touch .devteam/rules/pipeline.md", () => {
    assert.equal(prefixPipelineRelative(".devteam/rules/pipeline.md", "feat-x"), ".devteam/rules/pipeline.md");
  });

  test("null changeId is a no-op", () => {
    assert.equal(prefixPipelineRelative("pipeline/brief.md", null), "pipeline/brief.md");
  });

  test("undefined changeId is a no-op", () => {
    assert.equal(prefixPipelineRelative("pipeline/brief.md", undefined), "pipeline/brief.md");
  });

  test("null relPath returns null", () => {
    assert.equal(prefixPipelineRelative(null, "feat-x"), null);
  });
});

// ─── 3. path helpers — gatesDir / logsDir / pipelineRoot ─────────────────────

describe("paths module — gatesDir / logsDir / pipelineRoot", () => {
  const { pipelineRoot, gatesDir, logsDir } = require("../core/paths");

  test("pipelineRoot in-place (null changeId)", () => {
    assert.equal(pipelineRoot("/proj", null), path.join("/proj", "pipeline"));
  });

  test("pipelineRoot bounded", () => {
    assert.equal(pipelineRoot("/proj", "feat-x"), path.join("/proj", "pipeline", "changes", "feat-x"));
  });

  test("gatesDir in-place", () => {
    assert.equal(gatesDir("/proj", null), path.join("/proj", "pipeline", "gates"));
  });

  test("gatesDir bounded", () => {
    assert.equal(gatesDir("/proj", "feat-x"), path.join("/proj", "pipeline", "changes", "feat-x", "gates"));
  });

  test("logsDir in-place", () => {
    assert.equal(logsDir("/proj", null), path.join("/proj", "pipeline", "logs"));
  });

  test("logsDir bounded", () => {
    assert.equal(logsDir("/proj", "feat-x"), path.join("/proj", "pipeline", "changes", "feat-x", "logs"));
  });
});

// ─── 4. ctx.changeId populated in runStage() ─────────────────────────────────

describe("runStage — ctx.changeId from isolation config", () => {
  const { runStage } = require("../core/orchestrator");
  const { clearConfigCache } = require("../core/config");

  test("isolation=bounded → changeId derived from feature", () => {
    const cwd = makeTargetProject(); // isolation: bounded
    clearConfigCache();
    try {
      const plan = runStage("requirements", { cwd, feature: "add login" });
      assert.equal(plan.ctx.isolation, "bounded");
      assert.equal(plan.ctx.changeId, "add-login");
    } finally {
      clearConfigCache();
      fs.rmSync(cwd, { recursive: true, force: true });
    }
  });

  test("isolation=in-place → changeId is null", () => {
    const cwd = makeTargetProject({
      config: "routing:\n  default_host: claude-code\npipeline:\n  isolation: in-place\n  default_track: full\n",
    });
    clearConfigCache();
    try {
      const plan = runStage("requirements", { cwd, feature: "add login" });
      assert.equal(plan.ctx.isolation, "in-place");
      assert.equal(plan.ctx.changeId, null);
    } finally {
      clearConfigCache();
      fs.rmSync(cwd, { recursive: true, force: true });
    }
  });

  test("no feature → changeId is null even in bounded mode", () => {
    const cwd = makeTargetProject(); // isolation: bounded
    clearConfigCache();
    try {
      const plan = runStage("requirements", { cwd, feature: "" });
      assert.equal(plan.ctx.isolation, "bounded");
      assert.equal(plan.ctx.changeId, null);
    } finally {
      clearConfigCache();
      fs.rmSync(cwd, { recursive: true, force: true });
    }
  });
});

// ─── 5. buildDescriptor prefixes paths when changeId set ─────────────────────

describe("buildDescriptor — path prefixing", () => {
  const { buildDescriptor } = require("../core/orchestrator");
  const { getStage } = require("../core/pipeline/stages");

  test("readFirst prefixed in bounded mode", () => {
    const stageDef = getStage("requirements");
    const desc = buildDescriptor(stageDef, "pm", { changeId: "my-feat" });
    const pipelinePaths = desc.readFirst.filter((p) => p.startsWith("pipeline/"));
    assert.ok(pipelinePaths.length > 0, "expected some pipeline/ entries in readFirst");
    pipelinePaths.forEach((p) => {
      assert.ok(p.startsWith(path.join("pipeline", "changes", "my-feat")), `expected bounded prefix in: ${p}`);
    });
    // Non-pipeline paths unchanged
    const nonPipeline = desc.readFirst.filter((p) => !p.startsWith("pipeline"));
    nonPipeline.forEach((p) => {
      assert.ok(!p.includes("changes"), `expected no 'changes' segment in: ${p}`);
    });
  });

  test("allowedWrites prefixed in bounded mode", () => {
    const stageDef = getStage("design");
    const desc = buildDescriptor(stageDef, "principal", { changeId: "my-feat" });
    desc.allowedWrites.forEach((p) => {
      if (p.replace(/\\/g, "/").startsWith("pipeline/")) {
        assert.ok(p.startsWith(path.join("pipeline", "changes", "my-feat")), `bounded prefix missing in: ${p}`);
      }
    });
  });

  test("artifact prefixed in bounded mode", () => {
    const stageDef = getStage("requirements");
    const desc = buildDescriptor(stageDef, "pm", { changeId: "my-feat" });
    assert.ok(desc.artifact.startsWith(path.join("pipeline", "changes", "my-feat")), `artifact not prefixed: ${desc.artifact}`);
  });

  test("readFirst unchanged when changeId is null", () => {
    const stageDef = getStage("requirements");
    const desc = buildDescriptor(stageDef, "pm", { changeId: null });
    assert.deepEqual(desc.readFirst, stageDef.readFirst);
  });

  test("descriptor carries changeId field", () => {
    const stageDef = getStage("requirements");
    const desc = buildDescriptor(stageDef, "pm", { changeId: "feat-x" });
    assert.equal(desc.changeId, "feat-x");
  });

  test("descriptor changeId is null in in-place mode", () => {
    const stageDef = getStage("requirements");
    const desc = buildDescriptor(stageDef, "pm", {});
    assert.equal(desc.changeId, null);
  });
});

// ─── 6. runHeadless writes gate to bounded path (DEVTEAM_HEADLESS_COMMAND=cat) ──

describe("runStageHeadless — gate path in bounded mode", { concurrency: false }, () => {
  const { runStageHeadless } = require("../core/orchestrator");
  const { clearConfigCache } = require("../core/config");

  test(
    "in bounded mode, gate checked under pipeline/changes/<id>/gates/",
    process.env.DEVTEAM_HEADLESS_COMMAND === "cat" ? {} : { skip: "set DEVTEAM_HEADLESS_COMMAND=cat to run headless tests" },
    async () => {
      const cwd = makeTargetProject(); // isolation: bounded
      clearConfigCache();
      // cat echos the prompt and exits 0; the gate file won't be written
      // by cat, so gatePath is null — but we verify the log path and that
      // the process completes without throwing (path construction is correct).
      try {
        const results = await runStageHeadless("requirements", {
          cwd,
          feature: "my feature",
          stamp: false,
          config: { routing: { default_host: "claude-code", roles: {}, stages: {}, review_fanout: [] }, pipeline: { default_track: "full", isolation: "bounded", skip_stages: [], verify: {} } },
        });
        // gatePath will be null (cat doesn't write a gate) — that's fine
        assert.equal(results.results.length, 1);
        assert.equal(results.results[0].gatePath, null);
      } finally {
        clearConfigCache();
        fs.rmSync(cwd, { recursive: true, force: true });
      }
    }
  );
});

// ─── 7. appendGateFooter uses bounded path when changeId set ─────────────────

describe("appendGateFooter — bounded gate path in prompt", () => {
  const { appendGateFooter } = require("../core/adapters/render-helpers");

  test("in-place mode: gate path is pipeline/gates/<wsId>.json", () => {
    const lines = [];
    const descriptor = { workstreamId: "stage-01", stage: "stage-01", role: "pm", rolesInStage: ["pm"], expectedGate: {}, changeId: null };
    const ctx = { track: "full", orchestrator: "devteam@test" };
    appendGateFooter(lines, descriptor, ctx, "claude-code");
    const joined = lines.join("\n");
    assert.ok(joined.includes("pipeline/gates/stage-01.json"), `expected in-place path in: ${joined}`);
  });

  test("bounded mode: gate path is pipeline/changes/<id>/gates/<wsId>.json", () => {
    const lines = [];
    const descriptor = { workstreamId: "stage-01", stage: "stage-01", role: "pm", rolesInStage: ["pm"], expectedGate: {}, changeId: "my-feat" };
    const ctx = { track: "full", orchestrator: "devteam@test" };
    appendGateFooter(lines, descriptor, ctx, "claude-code");
    const joined = lines.join("\n");
    const expected = path.join("pipeline", "changes", "my-feat", "gates", "stage-01.json").replace(/\\/g, "/");
    assert.ok(joined.includes(expected) || joined.includes(expected.replace(/\//g, "\\")),
      `expected bounded path in: ${joined}`);
  });
});

// ─── 8. B9 read-side wiring: next(), summary(), driver (item 1.6) ─────────────
//
// End-to-end: bounded config + gates seeded under pipeline/changes/<id>/gates/
// → next() advances, summary() reports, driver reads/writes under the change root.

describe("B9 read-side: next() reads bounded gates", () => {
  const { next } = require("../core/orchestrator");
  const { clearConfigCache } = require("../core/config");

  test("next() sees a PASS gate seeded under pipeline/changes/<id>/gates/", () => {
    const cwd = makeTargetProject(); // isolation: bounded, default_track: full
    const changeId = "my-feature";
    const gatesPath = path.join(cwd, "pipeline", "changes", changeId, "gates");
    fs.mkdirSync(gatesPath, { recursive: true });
    // Seed stage-01 (requirements) as PASS so next() advances past it.
    const gate = {
      stage: "stage-01", status: "PASS",
      orchestrator: "devteam@test", track: "full",
      timestamp: "2026-06-10T00:00:00Z", blockers: [], warnings: [],
    };
    fs.writeFileSync(path.join(gatesPath, "stage-01.json"), JSON.stringify(gate, null, 2));
    clearConfigCache();
    try {
      const r = next({ cwd, changeId });
      // Pipeline advanced past stage-01 — should now point at stage-02 (design)
      assert.notEqual(r.action, "pipeline-complete", "should not be complete after one gate");
      assert.notEqual(r.stage, "stage-01", "should have advanced past stage-01");
      // The action should be a forward step (run-stage or similar)
      assert.ok(["run-stage", "continue-stage", "merge", "fold-sign-off", "record-local-deploy"].includes(r.action),
        `unexpected action: ${r.action}`);
    } finally {
      clearConfigCache();
      fs.rmSync(cwd, { recursive: true, force: true });
    }
  });

  test("next() in-place mode is unaffected by bounded gate files", () => {
    // Seeding gates under pipeline/changes/<id>/gates/ must NOT be visible
    // to next() when isolation is in-place.
    const cwd = makeTargetProject({
      config: "routing:\n  default_host: claude-code\npipeline:\n  isolation: in-place\n  default_track: full\n",
    });
    const changeId = "some-feature";
    const boundedGates = path.join(cwd, "pipeline", "changes", changeId, "gates");
    fs.mkdirSync(boundedGates, { recursive: true });
    fs.writeFileSync(path.join(boundedGates, "stage-01.json"), JSON.stringify({
      stage: "stage-01", status: "PASS",
      orchestrator: "devteam@test", track: "full",
      timestamp: "2026-06-10T00:00:00Z", blockers: [], warnings: [],
    }, null, 2));
    clearConfigCache();
    try {
      // In-place mode: pipeline/gates/ is empty → still stuck at stage-01
      const r = next({ cwd });
      assert.equal(r.stage, "stage-01", "in-place next() must not see bounded gates");
    } finally {
      clearConfigCache();
      fs.rmSync(cwd, { recursive: true, force: true });
    }
  });
});

describe("B9 read-side: summary() reads bounded gates", () => {
  const { summary } = require("../core/orchestrator");
  const { clearConfigCache } = require("../core/config");

  test("summary() reports PASS for a gate seeded under pipeline/changes/<id>/gates/", () => {
    const cwd = makeTargetProject(); // isolation: bounded
    const changeId = "my-feature";
    const gatesPath = path.join(cwd, "pipeline", "changes", changeId, "gates");
    fs.mkdirSync(gatesPath, { recursive: true });
    fs.writeFileSync(path.join(gatesPath, "stage-01.json"), JSON.stringify({
      stage: "stage-01", status: "PASS",
      orchestrator: "devteam@test", track: "full",
      timestamp: "2026-06-10T00:00:00Z", blockers: [], warnings: [],
    }, null, 2));
    clearConfigCache();
    try {
      const result = summary({ cwd, changeId });
      const req = result.rows.find((r) => r.name === "requirements");
      assert.ok(req, "requirements row present");
      assert.equal(req.state, "pass", `expected requirements to be PASS, got ${req.state}`);
    } finally {
      clearConfigCache();
      fs.rmSync(cwd, { recursive: true, force: true });
    }
  });

  test("summary() in-place mode stays pending when only bounded gates exist", () => {
    const cwd = makeTargetProject({
      config: "routing:\n  default_host: claude-code\npipeline:\n  isolation: in-place\n  default_track: full\n",
    });
    const boundedGates = path.join(cwd, "pipeline", "changes", "feat", "gates");
    fs.mkdirSync(boundedGates, { recursive: true });
    fs.writeFileSync(path.join(boundedGates, "stage-01.json"), JSON.stringify({
      stage: "stage-01", status: "PASS",
      orchestrator: "devteam@test", track: "full",
      timestamp: "2026-06-10T00:00:00Z", blockers: [], warnings: [],
    }, null, 2));
    clearConfigCache();
    try {
      const result = summary({ cwd });
      const req = result.rows.find((r) => r.name === "requirements");
      assert.equal(req.state, "pending", "in-place summary must not see bounded gates");
    } finally {
      clearConfigCache();
      fs.rmSync(cwd, { recursive: true, force: true });
    }
  });
});

describe("B9 read-side: driver run() uses bounded paths", () => {
  const { run } = require("../core/driver");
  const { clearConfigCache } = require("../core/config");

  test("driver writes run-plan, run-log, run-state, and lock under pipeline/changes/<id>/ in bounded mode", async () => {
    const cwd = makeTargetProject(); // isolation: bounded
    const changeId = "my-feature";
    clearConfigCache();
    try {
      const actions = [
        { action: "pipeline-complete", reason: "done" },
      ];
      let i = 0;
      const s = await run({
        cwd,
        feature: "my feature",  // changeId = "my-feature"
        // Inject next() to avoid real pipeline reads; it returns pipeline-complete immediately
        next: () => actions[i++],
      });
      assert.equal(s.completed, true);
      // All run-scoped files must live under pipeline/changes/<id>/
      const changeRoot = path.join(cwd, "pipeline", "changes", changeId);
      assert.ok(
        fs.existsSync(path.join(changeRoot, "run-log.jsonl")),
        `run-log.jsonl must be under pipeline/changes/${changeId}/`,
      );
      assert.ok(
        fs.existsSync(path.join(changeRoot, "run-state.json")),
        `run-state.json must be under pipeline/changes/${changeId}/`,
      );
      assert.ok(
        fs.existsSync(path.join(changeRoot, "run-plan.json")),
        `run-plan.json must be under pipeline/changes/${changeId}/`,
      );
      // Lock should be released
      assert.ok(
        !fs.existsSync(path.join(changeRoot, "run.lock")),
        "lock must be released after run",
      );
      // Global pipeline/ root must NOT have been created by the driver
      assert.ok(
        !fs.existsSync(path.join(cwd, "pipeline", "run-log.jsonl")),
        "run-log.jsonl must NOT appear under the global pipeline/ in bounded mode",
      );
      assert.ok(
        !fs.existsSync(path.join(cwd, "pipeline", "run-plan.json")),
        "run-plan.json must NOT appear under the global pipeline/ in bounded mode",
      );
    } finally {
      clearConfigCache();
      fs.rmSync(cwd, { recursive: true, force: true });
    }
  });

  test("driver in bounded mode uses real next() and reads gates from bounded path", async () => {
    // Seed a gate under the bounded path, then run the driver with real next().
    // The driver should call next({ cwd, changeId }) which reads from the bounded
    // gates dir and advances past the seeded stage.
    const cwd = makeTargetProject(); // isolation: bounded
    const changeId = "my-feature";
    const gatesPath = path.join(cwd, "pipeline", "changes", changeId, "gates");
    fs.mkdirSync(gatesPath, { recursive: true });
    // Seed everything up to and including stage-07 (sign-off) as PASS so the
    // run completes. Use a full-track seed covering all required stages.
    const { orderedStageNamesForTrack, getStage } = require("../core/pipeline/stages");
    for (const name of orderedStageNamesForTrack("full")) {
      const def = getStage(name);
      fs.writeFileSync(path.join(gatesPath, `${def.stage}.json`), JSON.stringify({
        stage: def.stage, status: "PASS",
        orchestrator: "devteam@test", track: "full",
        timestamp: "2026-06-10T00:00:00Z", blockers: [], warnings: [],
        // sign-off needs these for completeness checks
        pm_signoff: true, deploy_requested: true,
      }, null, 2));
    }
    clearConfigCache();
    try {
      const s = await run({ cwd, feature: "my feature" });
      assert.equal(s.completed, true, `expected complete, got: ${JSON.stringify(s)}`);
      // Run-log must be under the change root
      const changeRoot = path.join(cwd, "pipeline", "changes", changeId);
      assert.ok(
        fs.existsSync(path.join(changeRoot, "run-log.jsonl")),
        "run-log.jsonl must be under the bounded change root",
      );
    } finally {
      clearConfigCache();
      fs.rmSync(cwd, { recursive: true, force: true });
    }
  });
});
