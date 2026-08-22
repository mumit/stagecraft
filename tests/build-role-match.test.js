// ADR-026: a track that pins its build to one role, against a change that is
// somewhere else.
//
// loop (29.1) and -- since ADR-025 -- nano and refactor build and review with a
// single static role that never consults what changed. A frontend change on any
// of the three is built by an agent reading roles/backend.md: a different brief,
// different conventions, and work that passes its gates while being wrong in
// ways the gates do not measure.

const { describe, it, afterEach } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { makeTargetProject, cleanup, runCLI } = require("./_helpers");
const { buildRoleMismatch, buildRoleMismatchMessage } = require("../core/pipeline/build-role-match");

let dirs = [];
const track = (cwd) => { dirs.push(cwd); return cwd; };
afterEach(() => { dirs.forEach(cleanup); dirs = []; });

const cfg = { pipeline: {} };
const check = (t, activeRoles, config = cfg) => buildRoleMismatch({ track: t, config, activeRoles });

describe("buildRoleMismatch: what counts as a mismatch", () => {
  it("reports every track that pins its build, not just loop", () => {
    // ADR-025 took this from one track to three. Scoping the check to loop
    // would leave the two it just added uncovered.
    for (const t of ["loop", "nano", "refactor"]) {
      const m = check(t, ["frontend"]);
      assert.ok(m, `${t} should report a mismatch`);
      assert.equal(m.pinned_role, "backend");
      assert.deepEqual(m.discovered_roles, ["frontend"]);
    }
  });

  it("says nothing for a track that derives its build from the change", () => {
    for (const t of ["quick", "full", "hotfix", "config-only", "dep-update"]) {
      assert.equal(check(t, ["frontend"]), null, `${t} derives its matrix; nothing to report`);
    }
  });

  it("says nothing when the pinned role is one of the areas that changed", () => {
    assert.equal(check("loop", ["backend"]), null);
    assert.equal(check("loop", ["backend", "frontend"]), null,
      "the pinned role is present, so the work has an owner");
  });

  it("says nothing on a clean tree", () => {
    // This is the ordinary state at preflight for a new feature -- nothing has
    // been written yet. Warning here would fire on every run.
    assert.equal(check("loop", []), null);
  });

  it("ignores the documentation role, which has its own scoping path", () => {
    assert.equal(check("loop", ["documentation"]), null);
    assert.ok(check("loop", ["documentation", "frontend"]), "a real workstream still reports");
  });

  it("follows pipeline.loop_build_role", () => {
    const configured = { pipeline: { loop_build_role: "frontend" } };
    assert.equal(check("loop", ["frontend"], configured), null, "the pin now matches");
    assert.ok(check("loop", ["backend"], configured), "and mismatches the other way");
  });

  it("says nothing for a custom track", () => {
    assert.equal(check(["build", "qa"], ["frontend"]), null);
  });
});

describe("buildRoleMismatchMessage: the remedy has to be real", () => {
  it("names loop's config knob for loop", () => {
    const msg = buildRoleMismatchMessage(check("loop", ["frontend"]));
    assert.match(msg, /Set pipeline\.loop_build_role to 'frontend'/);
  });

  it("does not offer loop_build_role as nano's or refactor's fix", () => {
    // Their role comes from PEER_REVIEW_SIZING, which is static and has no
    // config override. Naming a knob that does not apply is worse than none.
    for (const t of ["nano", "refactor"]) {
      const msg = buildRoleMismatchMessage(check(t, ["frontend"]));
      assert.doesNotMatch(msg, /Set pipeline\.loop_build_role/);
      assert.match(msg, /derives its build matrix from the change/);
    }
  });
});

describe("the driver reports it", () => {
  const project = (extra = "") => {
    const cwd = track(makeTargetProject({
      config: `routing:\n  default_host: generic\npipeline:\n  default_track: full\n${extra}`,
      files: { "src/frontend/App.jsx": "export default function A() { return null; }\n" },
    }));
    return cwd;
  };
  const plan = (cwd, args = []) => runCLI(["run", "--feature", "adjust the button padding",
    "--track", "loop", "--budget-usd", "5", "--plan-only", ...args], { cwd });

  it("warns by default and still produces a plan", () => {
    const cwd = project();
    const r = plan(cwd);
    assert.equal(r.status, 0, "a warning must not fail the run");
    assert.match(r.stderr, /wrong specialist/);
    assert.ok(fs.existsSync(path.join(cwd, "pipeline", "run-plan.json")));
  });

  it("halts when the project opts in", () => {
    const r = plan(project("autonomy:\n  require_matching_build_role: true\n"));
    assert.equal(r.status, 1);
    assert.match(r.stderr, /build-role-mismatch|wrong specialist/);
  });

  it("--force bypasses it", () => {
    const r = plan(project("autonomy:\n  require_matching_build_role: true\n"), ["--force"]);
    assert.equal(r.status, 0);
    assert.doesNotMatch(r.stderr, /wrong specialist/);
  });

  it("records the decision in the run log either way", () => {
    const cwd = project();
    plan(cwd);
    const log = fs.readFileSync(path.join(cwd, "pipeline", "run-log.jsonl"), "utf8");
    const row = log.trim().split("\n").map(JSON.parse)
      .find((e) => e.outcome === "build-role-mismatch");
    assert.ok(row, "the mismatch must be auditable, not only printed");
    assert.equal(row.warned, true);
    assert.equal(row.pinned_role, "backend");
    assert.deepEqual(row.discovered_roles, ["frontend"]);
  });
});
