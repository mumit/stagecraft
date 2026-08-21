// Unit coverage for the slice-3 extraction (core/driver-stage-order.js).
//
// The prologue characterization suite already proves the extraction preserved
// run()'s observable behavior. These tests cover the branches that suite can
// only reach indirectly -- repair-at, --force, custom tracks -- and pin the
// ADR-009 stage-order rules at the level they are actually decided.

const { describe, it } = require("node:test");
const assert = require("node:assert/strict");
const { resolveStageOrder } = require("../core/driver-stage-order");

const noStoplist = () => [];
const alwaysStoplist = () => [{ term: "auth", file: "x" }];

function resolve(over = {}) {
  return resolveStageOrder({
    track: "loop", intent: "feature", cwd: "/tmp/x",
    checkStoplist: noStoplist, opts: {}, ...over,
  });
}

describe("resolveStageOrder: feature intent", () => {
  it("returns the track's own order untouched", () => {
    const { order, effectiveTrack } = resolve();
    assert.equal(effectiveTrack, "loop");
    assert.deepEqual(order, ["requirements", "build", "qa", "peer-review"]);
  });

  it("never consults the stoplist", () => {
    let called = false;
    resolve({ checkStoplist: () => { called = true; return []; } });
    assert.equal(called, false);
  });
});

describe("resolveStageOrder: repair intent (ADR-009)", () => {
  it("prepends requirements for diagnosis and inserts executable-spec before build", () => {
    const { order } = resolve({ intent: "repair", track: "hotfix", opts: { repair: "boom" } });
    assert.equal(order[0], "requirements", "diagnosis runs first");
    assert.ok(order.indexOf("executable-spec") < order.indexOf("build"),
      "the regression scenario is authored before the build writes the failing test");
  });

  it("--repair-at skips the diagnosis prepend but keeps executable-spec", () => {
    const { order } = resolve({
      intent: "repair", track: "hotfix", repairAt: "src/a.js", opts: { repair: "boom" },
    });
    assert.equal(order.includes("requirements"), false);
    assert.ok(order.indexOf("executable-spec") < order.indexOf("build"));
  });

  it("does not double-prepend when the track already contains requirements", () => {
    const { order } = resolve({ intent: "repair", track: "full", opts: { repair: "boom" } });
    assert.equal(order.filter((n) => n === "requirements").length, 1);
    assert.equal(order.filter((n) => n === "executable-spec").length, 1);
  });

  it("puts executable-spec first on a track with no build stage", () => {
    // review-only and review-pr have no build to insert before, so the
    // reproduction discipline still applies -- it just leads the order.
    const { order } = resolve({
      intent: "repair", track: "review-only", repairAt: "src/a.js",
      opts: { repair: "boom" },
    });
    assert.equal(order[0], "executable-spec");
    assert.deepEqual(order, ["executable-spec", "security-review", "red-team", "peer-review"]);
  });

  it("upgrades to full when the symptom hits the stoplist", () => {
    const r = resolve({
      intent: "repair", track: "hotfix",
      opts: { repair: "login throws" }, checkStoplist: alwaysStoplist,
    });
    assert.equal(r.effectiveTrack, "full");
    assert.equal(r.repairStoplistMatches.length, 1);
  });

  it("--force opts out of the upgrade", () => {
    const r = resolve({
      intent: "repair", track: "hotfix",
      opts: { repair: "login throws", force: true }, checkStoplist: alwaysStoplist,
    });
    assert.equal(r.effectiveTrack, "hotfix");
    assert.deepEqual(r.repairStoplistMatches, []);
  });

  it("skips the check entirely when the track is already full", () => {
    let called = false;
    const r = resolve({
      intent: "repair", track: "full", opts: { repair: "login throws" },
      checkStoplist: () => { called = true; return [{ term: "auth" }]; },
    });
    assert.equal(called, false, "no upgrade is possible, so no check is run");
    assert.equal(r.effectiveTrack, "full");
  });
});

describe("resolveStageOrder: the --until boundary", () => {
  it("is -1 when not requested", () => {
    assert.equal(resolve().untilIndex, -1);
  });

  it("indexes into the resolved order", () => {
    const { order, untilIndex } = resolve({ opts: { until: "build" } });
    assert.equal(untilIndex, order.indexOf("build"));
    assert.ok(untilIndex >= 0);
  });

  it("throws on a stage the track does not contain, naming the track and its stages", () => {
    assert.throws(() => resolve({ opts: { until: "red-team" } }), (err) => {
      assert.match(err.message, /--until red-team is not a stage in the 'loop' track/);
      assert.match(err.message, /Stages, in order: requirements, build, qa, peer-review/);
      return true;
    });
  });

  it("throws on a stage that exists nowhere", () => {
    assert.throws(() => resolve({ opts: { until: "nonsense" } }), /not a stage in the 'loop' track/);
  });

  it("validates against the repair order, not the bare track order", () => {
    // executable-spec is not in hotfix, but a repair run injects it -- so it is
    // a legitimate boundary here and must not be rejected.
    const { untilIndex } = resolve({
      intent: "repair", track: "hotfix",
      opts: { repair: "boom", until: "executable-spec" },
    });
    assert.ok(untilIndex >= 0);
  });

  it("labels a custom track 'custom' in the error", () => {
    assert.throws(
      () => resolve({ track: ["build", "qa"], opts: { until: "deploy" } }),
      /not a stage in the 'custom' track/,
    );
  });
});
