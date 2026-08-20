// Tests for driver.js behaviours not already covered by run.test.js.

const { describe, it, afterEach } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { REPO_ROOT, makeTargetProject, seedGate, cleanup } = require("./_helpers");
const { run } = require(path.join(REPO_ROOT, "core", "driver"));

let _dirs = [];
function track(cwd) { _dirs.push(cwd); return cwd; }
afterEach(() => { _dirs.forEach(cleanup); _dirs = []; });

describe("driver: budget warning", () => {
  it("writes budget warning to stderr when neither dollar nor token budget is set", async () => {
    const cwd = track(makeTargetProject());
    // Seed stage-01 as ESCALATE so the run halts quickly without dispatching anything.
    seedGate(cwd, "stage-01", { status: "ESCALATE", escalation_reason: "test" });

    const chunks = [];
    const orig = process.stderr.write.bind(process.stderr);
    process.stderr.write = (chunk, ...rest) => {
      chunks.push(typeof chunk === "string" ? chunk : chunk.toString());
      return orig(chunk, ...rest);
    };

    try {
      await run({ cwd });
    } finally {
      process.stderr.write = orig;
    }

    const combined = chunks.join("");
    assert.ok(
      combined.includes("[devteam run] Warning: no usage cap set"),
      `Expected budget warning in stderr but got: ${combined}`
    );
    assert.ok(
      combined.includes("Use --budget-usd <amount> and/or --budget-tokens <count>"),
      `Expected second line of budget warning in stderr but got: ${combined}`
    );
  });

  it("does NOT write budget warning when budgetUsd is set", async () => {
    const cwd = track(makeTargetProject());
    seedGate(cwd, "stage-01", { status: "ESCALATE", escalation_reason: "test" });

    const chunks = [];
    const orig = process.stderr.write.bind(process.stderr);
    process.stderr.write = (chunk, ...rest) => {
      chunks.push(typeof chunk === "string" ? chunk : chunk.toString());
      return orig(chunk, ...rest);
    };

    try {
      await run({ cwd, budgetUsd: 10 });
    } finally {
      process.stderr.write = orig;
    }

    const combined = chunks.join("");
    assert.ok(
      !combined.includes("[devteam run] Warning: no usage cap set"),
      `Unexpected budget warning in stderr: ${combined}`
    );
  });

  it("does NOT write budget warning when budgetTokens is set", async () => {
    const cwd = track(makeTargetProject());
    seedGate(cwd, "stage-01", { status: "ESCALATE", escalation_reason: "test" });
    const chunks = [];
    const orig = process.stderr.write.bind(process.stderr);
    process.stderr.write = (chunk, ...rest) => {
      chunks.push(typeof chunk === "string" ? chunk : chunk.toString());
      return orig(chunk, ...rest);
    };
    try {
      await run({ cwd, budgetTokens: 1000 });
    } finally {
      process.stderr.write = orig;
    }
    assert.ok(!chunks.join("").includes("[devteam run] Warning: no usage cap set"));
  });
});

describe("driver: pattern auto-collection (phase-30 item 30.1)", () => {
  function pendingReviewPath(cwd) {
    return path.join(cwd, ".devteam", "patterns", "pending-review.json");
  }

  it("auto-collects on pipeline-complete with no manual `devteam patterns collect`", async () => {
    const cwd = track(makeTargetProject());
    seedGate(cwd, "stage-06c", {
      status: "FAIL",
      blockers: [{ signal: "missing_log", assigned_to: "backend" }],
    });

    const s = await run({ cwd, next: () => ({ action: "pipeline-complete", reason: "done" }) });

    assert.equal(s.completed, true);
    assert.ok(fs.existsSync(pendingReviewPath(cwd)), "pattern collection must run automatically at pipeline-complete");
    const pending = JSON.parse(fs.readFileSync(pendingReviewPath(cwd), "utf8"));
    assert.ok(pending.candidates.length > 0, "the seeded blocker must surface as a candidate without a manual collect step");
  });

  it("auto-collects on a halt that already has a gate on disk", async () => {
    const cwd = track(makeTargetProject());
    // Mirrors "driver: budget warning" — ESCALATE on stage-01 halts quickly via
    // resolve-escalation, with no next() dispatch required.
    seedGate(cwd, "stage-01", {
      status: "ESCALATE",
      escalation_reason: "test",
      blockers: [{ signal: "missing_log", assigned_to: "backend" }],
    });

    const s = await run({ cwd });

    assert.equal(s.halted, true);
    assert.ok(fs.existsSync(pendingReviewPath(cwd)), "a halt with a gate already on disk must still auto-collect");
    const pending = JSON.parse(fs.readFileSync(pendingReviewPath(cwd), "utf8"));
    assert.ok(pending.candidates.length > 0);
  });

  it("does not auto-collect on a halt before any gate ever existed", async () => {
    const cwd = track(makeTargetProject());

    // --repair and --feature together halt on mutual-exclusion before the
    // lock is even acquired — no stage ever ran, so there is nothing to collect.
    const s = await run({ cwd, repair: "x", feature: "y" });

    assert.equal(s.halt_action, "mutual-exclusion");
    assert.ok(!fs.existsSync(pendingReviewPath(cwd)), "a halt with no gate on disk must not invoke pattern collection");
  });

  it("a collect() failure is logged as pattern-collect-failed and never fails the run", async () => {
    const cwd = track(makeTargetProject());

    const s = await run({
      cwd,
      next: () => ({ action: "pipeline-complete", reason: "done" }),
      collectPatterns: () => { throw new Error("boom"); },
    });

    assert.equal(s.completed, true, "collect() throwing must not affect the run outcome");
    const lines = fs.readFileSync(path.join(cwd, "pipeline", "run-log.jsonl"), "utf8")
      .trim().split("\n").filter(Boolean).map((line) => JSON.parse(line));
    assert.ok(
      lines.some((e) => e.outcome === "pattern-collect-failed" && e.error === "boom"),
      "run-log.jsonl must record a pattern-collect-failed event with the error message",
    );
  });
});
