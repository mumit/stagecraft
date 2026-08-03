// core/evals/compare.js + `devteam evals compare` — per-stage pass-rate
// deltas between two prompt_pack_version values (phase-33 item 33.3,
// plans/phase-33-eval-flywheel.md §33.3).

const { describe, it, afterEach } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { REPO_ROOT, makeTargetProject, cleanup, runCLI } = require("./_helpers");
const { comparePacks, DEFAULT_MIN_N } = require(path.join(REPO_ROOT, "core", "evals", "compare"));

let _dirs = [];
function track(cwd) { _dirs.push(cwd); return cwd; }
afterEach(() => { _dirs.forEach(cleanup); _dirs = []; });

function seedCorpus(cwd, records) {
  const dir = path.join(cwd, ".devteam", "corpus");
  fs.mkdirSync(dir, { recursive: true });
  const lines = records.map((r) => JSON.stringify(r)).join("\n") + "\n";
  fs.writeFileSync(path.join(dir, "dispatches.jsonl"), lines, "utf8");
}

// n dispatch records for (stage, pack), with `passN` of them PASS and the
// rest FAIL.
function dispatches(stage, pack, n, passN) {
  const out = [];
  for (let i = 0; i < n; i++) {
    out.push({ stage, prompt_pack_version: pack, gate_status: i < passN ? "PASS" : "FAIL" });
  }
  return out;
}

describe("comparePacks", () => {
  it("reports a per-stage pass-rate delta when both packs meet min-n", () => {
    const cwd = track(makeTargetProject());
    seedCorpus(cwd, [
      ...dispatches("stage-04", "pack-a", 6, 5), // 83.3%
      ...dispatches("stage-04", "pack-b", 5, 5), // 100%
    ]);

    const outcome = comparePacks(cwd, "pack-a", "pack-b");
    assert.equal(outcome.min_n, DEFAULT_MIN_N);
    const s = outcome.stages.find((r) => r.stage === "stage-04");
    assert.equal(s.refused, false);
    assert.equal(s.pack_a.dispatches, 6);
    assert.equal(s.pack_b.dispatches, 5);
    assert.ok(Math.abs(s.pack_a.pass_rate - (5 / 6) * 100) < 1e-9);
    assert.equal(s.pack_b.pass_rate, 100);
    assert.ok(Math.abs(s.delta - ((100) - (5 / 6) * 100)) < 1e-9);
  });

  it("refuses a stage below min-n on either pack (honesty rule)", () => {
    const cwd = track(makeTargetProject());
    seedCorpus(cwd, [
      ...dispatches("stage-06", "pack-a", 7, 4),
      ...dispatches("stage-06", "pack-b", 2, 2), // below default min-n of 5
    ]);

    const outcome = comparePacks(cwd, "pack-a", "pack-b");
    const s = outcome.stages.find((r) => r.stage === "stage-06");
    assert.equal(s.refused, true);
    assert.equal(s.delta, null);
    assert.match(s.refused_reason, /fewer than 5 dispatches/);
    assert.match(s.refused_reason, /pack-b/);
  });

  it("honors a custom --min-n", () => {
    const cwd = track(makeTargetProject());
    seedCorpus(cwd, [
      ...dispatches("stage-06", "pack-a", 3, 3),
      ...dispatches("stage-06", "pack-b", 3, 1),
    ]);

    const refusedByDefault = comparePacks(cwd, "pack-a", "pack-b");
    assert.equal(refusedByDefault.stages[0].refused, true);

    const allowed = comparePacks(cwd, "pack-a", "pack-b", { minN: 3 });
    assert.equal(allowed.min_n, 3);
    assert.equal(allowed.stages[0].refused, false);
    assert.equal(allowed.stages[0].delta, allowed.stages[0].pack_b.pass_rate - allowed.stages[0].pack_a.pass_rate);
  });

  it("only compares stages that appear for at least one of the two packs", () => {
    const cwd = track(makeTargetProject());
    seedCorpus(cwd, [
      ...dispatches("stage-01", "pack-a", 6, 6),
      ...dispatches("stage-04", "pack-c", 6, 6), // neither pack-a nor pack-b
    ]);

    const outcome = comparePacks(cwd, "pack-a", "pack-b");
    assert.deepEqual(outcome.stages.map((s) => s.stage), ["stage-01"]);
  });

  it("empty corpus produces zero stages, never throws", () => {
    const cwd = track(makeTargetProject());
    const outcome = comparePacks(cwd, "pack-a", "pack-b");
    assert.deepEqual(outcome.stages, []);
    assert.equal(outcome.total_dispatches_a, 0);
    assert.equal(outcome.total_dispatches_b, 0);
  });
});

describe("devteam evals compare (CLI)", () => {
  it("requires exactly two --pack values", () => {
    const cwd = track(makeTargetProject());
    const r = runCLI(["evals", "compare", "--pack", "only-one"], { cwd });
    assert.equal(r.status, 2);
    assert.match(r.stderr, /requires exactly two --pack values/);
  });

  it("--json emits the same comparison as comparePacks", () => {
    const cwd = track(makeTargetProject());
    seedCorpus(cwd, [
      ...dispatches("stage-04", "pack-a", 6, 6),
      ...dispatches("stage-04", "pack-b", 6, 3),
    ]);
    const r = runCLI(["evals", "compare", "--pack", "pack-a", "--pack", "pack-b", "--json"], { cwd });
    assert.equal(r.status, 0, r.stderr);
    const outcome = JSON.parse(r.stdout);
    assert.equal(outcome.pack_a, "pack-a");
    assert.equal(outcome.pack_b, "pack-b");
    assert.equal(outcome.stages[0].refused, false);
    assert.equal(outcome.stages[0].pack_b.pass_rate, 50);
  });

  it("text mode prints a refused stage with its reason", () => {
    const cwd = track(makeTargetProject());
    seedCorpus(cwd, [
      ...dispatches("stage-06", "pack-a", 1, 1),
      ...dispatches("stage-06", "pack-b", 1, 1),
    ]);
    const r = runCLI(["evals", "compare", "--pack", "pack-a", "--pack", "pack-b"], { cwd });
    assert.equal(r.status, 0, r.stderr);
    assert.match(r.stdout, /refused/);
    assert.match(r.stdout, /fewer than 5 dispatches/);
  });
});
