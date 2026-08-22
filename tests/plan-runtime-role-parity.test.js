// The plan preview and the runtime must agree on which roles will dispatch.
//
// Two functions answer that question. core/pipeline/right-sizing.js's
// expectedRolesForStage builds the run-plan preview; core/orchestrator.js's
// inferActiveRoles decides what actually dispatches. Both filter a stage's
// roles down to the change's active workstreams -- but only inferActiveRoles
// refused an empty result, on the grounds that "an empty result ... would
// produce a zero-workstream plan that completes in 0ms and loops".
//
// So they disagreed, and the disagreement was reachable on the default track:
// `loop` pins build and peer-review to one role (loopBuildRole, default
// "backend"), so a frontend-only change filtered that role out and the plan
// reported ZERO build dispatches for a run that dispatches one.
//
// This is the fourth instance of one concept with several readers in this
// codebase -- after framework-owned paths (#431), observed cost/model
// precedence (#450), and nonNegativeNumber (#460).

const { describe, it, afterEach } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { makeTargetProject, seedGate, cleanup } = require("./_helpers");
const { expectedRolesForStage } = require("../core/pipeline/right-sizing");
const { STAGES, TRACKS } = require("../core/pipeline/stages");
const { next } = require("../core/orchestrator");

let dirs = [];
const track = (cwd) => { dirs.push(cwd); return cwd; };
afterEach(() => { dirs.forEach(cleanup); dirs = []; });

const cfg = (t) => ({ pipeline: { default_track: t }, routing: { default_host: "generic" } });

describe("expectedRolesForStage: never reports a stage as dispatching nothing", () => {
  it("keeps the unfiltered roles when the filter would empty them", () => {
    // loop's build is pinned to backend; the change touched only frontend.
    const roles = expectedRolesForStage(STAGES.build, "loop",
      { activeRoles: ["frontend"], config: cfg("loop") });
    assert.deepEqual(roles, ["backend"], "a stage that will dispatch must not preview as empty");
  });

  it("still filters when something survives", () => {
    const roles = expectedRolesForStage(STAGES.build, "full",
      { activeRoles: ["frontend"], config: cfg("full") });
    assert.deepEqual(roles, ["frontend"]);
  });

  it("returns every role when nothing was discovered", () => {
    const roles = expectedRolesForStage(STAGES.build, "full",
      { activeRoles: [], config: cfg("full") });
    assert.deepEqual(roles, ["backend", "frontend", "platform", "qa"]);
  });

  it("never returns an empty list for any track/active-role combination", () => {
    // The property, stated directly rather than by example.
    for (const t of TRACKS) {
      for (const stage of [STAGES.build, STAGES["peer-review"], STAGES.qa]) {
        if (!stage) continue;
        for (const active of [["frontend"], ["backend"], ["platform"], ["qa"], ["documentation"]]) {
          const roles = expectedRolesForStage(stage, t, { activeRoles: active, config: cfg(t) });
          assert.ok(Array.isArray(roles) && roles.length > 0,
            `${t}/${stage.stage} with active=${active[0]} previewed as empty`);
        }
      }
    }
  });
});

describe("plan preview and runtime agree on the dispatched roles", () => {
  it("loop with a frontend-only change: both say backend", () => {
    const cwd = track(makeTargetProject({
      config: "routing:\n  default_host: generic\npipeline:\n  default_track: loop\n",
    }));
    seedGate(cwd, "stage-01", { stage: "stage-01", status: "PASS", track: "loop", active_roles: ["frontend"] });

    const previewed = expectedRolesForStage(STAGES.build, "loop",
      { activeRoles: ["frontend"], config: cfg("loop") });
    const action = next({
      cwd, track: "loop", config: cfg("loop"),
      gatesDir: path.join(cwd, "pipeline", "gates"),
    });

    assert.equal(action.action, "run-stage");
    assert.equal(action.name, "build");
    assert.deepEqual(previewed, action.roles,
      "the run plan must not promise a different dispatch than the one that happens");
  });

  it("the materialized plan shows the build that will run", () => {
    const cwd = track(makeTargetProject({
      config: "routing:\n  default_host: generic\npipeline:\n  default_track: loop\n",
    }));
    seedGate(cwd, "stage-01", { stage: "stage-01", status: "PASS", track: "loop", active_roles: ["frontend"] });
    const { runCLI } = require("./_helpers");
    const r = runCLI(["run", "--feature", "adjust the button padding", "--track", "loop",
      "--budget-usd", "5", "--plan-only"], { cwd });
    assert.equal(r.status, 0, r.stderr);
    const plan = JSON.parse(fs.readFileSync(path.join(cwd, "pipeline", "run-plan.json"), "utf8"));
    const build = plan.stages.find((s) => s.name === "build");
    assert.ok(build.dispatches.length > 0, "the plan reported a build that dispatches nothing");
    assert.ok(plan.expected_workstreams > 1);
  });
});
