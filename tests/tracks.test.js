const { describe, it } = require("node:test");
const assert = require("node:assert/strict");
const path = require("node:path");
const { REPO_ROOT } = require("./_helpers");
const { TRACKS, STAGES_BY_TRACK, orderedStageNames, orderedStageNamesForTrack, isStageInTrack, rolesForStage, requiredApprovalsFor, getStage } =
  require(path.join(REPO_ROOT, "core", "pipeline", "stages"));

describe("tracks: TRACKS ↔ STAGES_BY_TRACK", () => {
  it("every track in TRACKS has an entry", () => {
    for (const t of TRACKS) {
      assert.ok(Array.isArray(STAGES_BY_TRACK[t]), `track ${t} missing from STAGES_BY_TRACK`);
      assert.ok(STAGES_BY_TRACK[t].length > 0, `track ${t} has no stages`);
    }
  });

  it("full track equals the full ordered list", () => {
    assert.deepEqual(orderedStageNamesForTrack("full"), orderedStageNames());
  });

  it("nano is the smallest track (build + scoped peer-review + qa)", () => {
    // Audit Tier-2: nano previously skipped peer-review entirely (just
    // build+qa). Even trivial changes get one reviewer + one approval;
    // see PEER_REVIEW_SIZING.nano in core/pipeline/stages.js.
    assert.deepEqual(orderedStageNamesForTrack("nano"), ["build", "peer-review", "qa"]);
  });

  it("quick skips design and clarification", () => {
    const stages = orderedStageNamesForTrack("quick");
    assert.ok(!stages.includes("design"));
    assert.ok(!stages.includes("clarification"));
    assert.ok(stages.includes("build"));
    assert.ok(stages.includes("qa"));
  });

  it("hotfix omits requirements, design, clarification", () => {
    const stages = orderedStageNamesForTrack("hotfix");
    assert.ok(!stages.includes("requirements"));
    assert.ok(!stages.includes("design"));
    assert.ok(!stages.includes("clarification"));
    assert.ok(stages.includes("build"));
    assert.ok(stages.includes("retrospective"));
  });

  it("config-only and hotfix include the conditional security-review", () => {
    assert.ok(orderedStageNamesForTrack("config-only").includes("security-review"));
    assert.ok(orderedStageNamesForTrack("hotfix").includes("security-review"));
  });

  it("nano / quick / dep-update do NOT include security-review", () => {
    assert.ok(!orderedStageNamesForTrack("nano").includes("security-review"));
    assert.ok(!orderedStageNamesForTrack("quick").includes("security-review"));
    assert.ok(!orderedStageNamesForTrack("dep-update").includes("security-review"));
  });

  it("full + hotfix include red-team (always-on adversarial review)", () => {
    assert.ok(orderedStageNamesForTrack("full").includes("red-team"));
    assert.ok(orderedStageNamesForTrack("hotfix").includes("red-team"));
  });

  it("nano / quick / config-only / dep-update do NOT include red-team", () => {
    assert.ok(!orderedStageNamesForTrack("nano").includes("red-team"));
    assert.ok(!orderedStageNamesForTrack("quick").includes("red-team"));
    assert.ok(!orderedStageNamesForTrack("config-only").includes("red-team"));
    assert.ok(!orderedStageNamesForTrack("dep-update").includes("red-team"));
  });

  it("red-team sits between security-review and peer-review when both present", () => {
    const full = orderedStageNamesForTrack("full");
    const sr = full.indexOf("security-review");
    const rt = full.indexOf("red-team");
    const pr = full.indexOf("peer-review");
    assert.ok(sr < rt && rt < pr, `expected security-review(${sr}) < red-team(${rt}) < peer-review(${pr})`);
  });

  it("full + hotfix + config-only include migration-safety (conditional on data-layer diffs)", () => {
    for (const t of ["full", "hotfix", "config-only"]) {
      assert.ok(orderedStageNamesForTrack(t).includes("migration-safety"), `${t} should include migration-safety`);
    }
  });

  it("quick / nano / dep-update do NOT include migration-safety", () => {
    for (const t of ["quick", "nano", "dep-update"]) {
      assert.ok(!orderedStageNamesForTrack(t).includes("migration-safety"), `${t} should NOT include migration-safety`);
    }
  });

  it("migration-safety sits between red-team and peer-review when both present", () => {
    const full = orderedStageNamesForTrack("full");
    const rt = full.indexOf("red-team");
    const ms = full.indexOf("migration-safety");
    const pr = full.indexOf("peer-review");
    assert.ok(rt < ms && ms < pr, `expected red-team(${rt}) < migration-safety(${ms}) < peer-review(${pr})`);
  });

  it("full + quick include executable-spec (G2 — AC→Scenario→test bridge)", () => {
    assert.ok(orderedStageNamesForTrack("full").includes("executable-spec"));
    assert.ok(orderedStageNamesForTrack("quick").includes("executable-spec"));
  });

  it("hotfix / nano / config-only / dep-update do NOT include executable-spec", () => {
    for (const t of ["hotfix", "nano", "config-only", "dep-update"]) {
      assert.ok(!orderedStageNamesForTrack(t).includes("executable-spec"), `${t} should NOT include executable-spec`);
    }
  });

  it("executable-spec sits after clarification and before build (on tracks that include both)", () => {
    const full = orderedStageNamesForTrack("full");
    const cl = full.indexOf("clarification");
    const es = full.indexOf("executable-spec");
    const bu = full.indexOf("build");
    assert.ok(cl < es && es < bu, `expected clarification(${cl}) < executable-spec(${es}) < build(${bu})`);
  });

  it("full includes verification-beyond-tests (G7 — property/mutation/formal); other tracks exclude it", () => {
    assert.ok(orderedStageNamesForTrack("full").includes("verification-beyond-tests"));
    for (const t of ["quick", "nano", "hotfix", "config-only", "dep-update"]) {
      assert.ok(!orderedStageNamesForTrack(t).includes("verification-beyond-tests"), `${t} should NOT include verification-beyond-tests`);
    }
  });

  it("verification-beyond-tests sits after observability-gate and before sign-off", () => {
    const full = orderedStageNamesForTrack("full");
    const ob = full.indexOf("observability-gate");
    const vb = full.indexOf("verification-beyond-tests");
    const so = full.indexOf("sign-off");
    assert.ok(ob < vb && vb < so, `expected observability-gate(${ob}) < verification-beyond-tests(${vb}) < sign-off(${so})`);
  });

  it("orderedStageNamesForTrack(unknown) throws with a helpful message", () => {
    assert.throws(() => orderedStageNamesForTrack("bogus"), /Unknown track/);
  });

  // 29.1: the `loop` track — brief -> build -> verify -> review. Note the
  // declared order: qa (stage-06) before peer-review (stage-05), the
  // reverse of every other track's numeric order.
  it("loop is the 4-slot track: requirements, build, qa, peer-review (in that order)", () => {
    assert.deepEqual(orderedStageNamesForTrack("loop"), ["requirements", "build", "qa", "peer-review"]);
  });

  it("loop omits design, clarification, executable-spec, pre-review, red-team, sign-off, deploy, retrospective", () => {
    const stages = orderedStageNamesForTrack("loop");
    for (const excluded of ["design", "clarification", "executable-spec", "pre-review", "red-team", "sign-off", "deploy", "retrospective"]) {
      assert.ok(!stages.includes(excluded), `loop should NOT include ${excluded}`);
    }
  });
});

describe("tracks: loop build/peer-review sizing (29.1)", () => {
  it("build (stage-04) on loop dispatches a single role, default backend", () => {
    const buildDef = getStage("build");
    assert.deepEqual(rolesForStage(buildDef, "loop"), ["backend"]);
  });

  it("build (stage-04) on loop honors pipeline.loop_build_role config override", () => {
    const buildDef = getStage("build");
    const config = { pipeline: { loop_build_role: "frontend" } };
    assert.deepEqual(rolesForStage(buildDef, "loop", config), ["frontend"]);
  });

  it("build (stage-04) on loop falls back to backend for an unrecognized config value", () => {
    const buildDef = getStage("build");
    const config = { pipeline: { loop_build_role: "not-a-real-role" } };
    assert.deepEqual(rolesForStage(buildDef, "loop", config), ["backend"]);
  });

  it("peer-review (stage-05) on loop dispatches a single reviewer matching loopBuildRole", () => {
    const reviewDef = getStage("peer-review");
    assert.deepEqual(rolesForStage(reviewDef, "loop"), ["backend"]);
    const config = { pipeline: { loop_build_role: "platform" } };
    assert.deepEqual(rolesForStage(reviewDef, "loop", config), ["platform"]);
  });

  it("peer-review (stage-05) on loop requires exactly 1 approval", () => {
    const reviewDef = getStage("peer-review");
    assert.equal(requiredApprovalsFor(reviewDef, "loop"), 1);
  });

  it("build (stage-04) on every OTHER track is unaffected (still the four-role matrix)", () => {
    const buildDef = getStage("build");
    for (const t of ["full", "quick", "nano", "config-only", "dep-update", "hotfix"]) {
      assert.deepEqual(rolesForStage(buildDef, t), ["backend", "frontend", "platform", "qa"], `build roles changed for track ${t}`);
    }
  });
});

describe("tracks: VALID_TRACKS in gate-validator derives from canonical TRACKS", () => {
  it("validator exports VALID_TRACKS equal to the canonical TRACKS array", () => {
    // Before fix: validator.js has its own inline literal and does not export
    // VALID_TRACKS — this assertion fails because VALID_TRACKS is undefined.
    // After fix: validator imports TRACKS from stages.js, derives the Set from
    // it, and exports it so this test can verify the two are identical.
    const { VALID_TRACKS } = require(path.join(REPO_ROOT, "core", "gates", "validator.js"));
    assert.ok(VALID_TRACKS instanceof Set,
      "validator.js must export VALID_TRACKS as a Set (derived from stages.js TRACKS)");
    assert.deepEqual(
      [...VALID_TRACKS].sort(),
      [...TRACKS].sort(),
      "validator VALID_TRACKS must be exactly the canonical TRACKS from stages.js",
    );
  });
});

describe("tracks: isStageInTrack", () => {
  it("design is in full and quick — wait actually only full", () => {
    assert.equal(isStageInTrack("design", "full"), true);
    assert.equal(isStageInTrack("design", "quick"), false);
    assert.equal(isStageInTrack("design", "nano"), false);
  });

  it("build is in every track", () => {
    for (const t of TRACKS) {
      assert.equal(isStageInTrack("build", t), true, `build missing from ${t}`);
    }
  });

  it("retrospective is in full, quick, hotfix only", () => {
    assert.equal(isStageInTrack("retrospective", "full"), true);
    assert.equal(isStageInTrack("retrospective", "quick"), true);
    assert.equal(isStageInTrack("retrospective", "hotfix"), true);
    assert.equal(isStageInTrack("retrospective", "nano"), false);
    assert.equal(isStageInTrack("retrospective", "config-only"), false);
    assert.equal(isStageInTrack("retrospective", "dep-update"), false);
  });
});
