// tests/ceremony-preview.test.js
//
// Tests for core/ceremony-preview.js — per-track ceremony cost preview
// (plans/phase-29-scale-adaptive-ceremony.md item 29.3).
//
// Coverage:
//   1. Static estimates for two tracks (loop, quick) from a fixture project
//      with no corpus history — unknown model, tokens shown, cost omitted.
//   2. Static estimate resolves a known model from < MIN_EMPIRICAL_RUNS
//      corpus records (per-(role,host) model lookup, independent of the
//      empirical-basis threshold) and computes a real cost range.
//   3. On-disk pipeline artifact sampling widens the token range once a
//      prior stage's artifact exists.
//   4. Empirical path: >= MIN_EMPIRICAL_RUNS runs of the same track in the
//      corpus switches estimate_basis to "empirical" and uses medians.
//   5. `devteam assess --json` / text surfaces ceremony_preview.

"use strict";

const { test, describe, afterEach } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const REPO_ROOT = path.resolve(__dirname, "..");
const { runCLI } = require("./_helpers");
const {
  MIN_EMPIRICAL_RUNS,
  ceremonyPreview,
  computeStaticEstimate,
  computeEmpiricalEstimate,
} = require(path.join(REPO_ROOT, "core", "ceremony-preview"));
const { loadConfig, clearConfigCache } = require(path.join(REPO_ROOT, "core", "config"));

let _dirs = [];
function makeCwd(configYaml) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "devteam-test-"));
  fs.mkdirSync(path.join(dir, ".devteam"), { recursive: true });
  fs.writeFileSync(
    path.join(dir, ".devteam", "config.yml"),
    configYaml || "routing:\n  default_host: generic\npipeline:\n  default_track: full\n",
  );
  _dirs.push(dir);
  return dir;
}
afterEach(() => {
  _dirs.forEach((d) => { try { fs.rmSync(d, { recursive: true, force: true }); } catch { /* */ } });
  _dirs = [];
  clearConfigCache();
});

function writeCorpus(cwd, records) {
  const dir = path.join(cwd, ".devteam", "corpus");
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(
    path.join(dir, "dispatches.jsonl"),
    records.map((r) => JSON.stringify(r)).join("\n") + "\n",
  );
}

// ─── 1. Static estimates, unknown model ───────────────────────────────────

describe("ceremony-preview: static basis, unknown model", () => {
  for (const trackName of ["loop", "quick"]) {
    test(`${trackName} track: static estimate with stage slots, dispatch count, and no invented dollars`, () => {
      const cwd = makeCwd();
      const config = loadConfig(cwd);
      const preview = ceremonyPreview(cwd, trackName, config);

      assert.equal(preview.estimate_basis, "static");
      assert.equal(preview.track, trackName);
      assert.ok(preview.stage_slots > 0, "stage_slots must be positive");
      assert.ok(preview.dispatch_count.max > 0, "dispatch_count.max must be positive");
      assert.ok(preview.dispatch_count.min <= preview.dispatch_count.max);
      assert.ok(preview.tokens.low > 0, "tokens.low must be positive");
      assert.ok(preview.tokens.high >= preview.tokens.low);
      // No corpus history anywhere → every (role, host) pair is unresolved,
      // so cost must be null, never a partial/invented dollar figure.
      assert.equal(preview.cost_usd, null);
      assert.ok(preview.unresolved_models.length > 0);
    });
  }

  test("loop track: exactly 4 dispatches (29.1 contract) reflected in the preview", () => {
    const cwd = makeCwd("routing:\n  default_host: generic\npipeline:\n  default_track: loop\n");
    const config = loadConfig(cwd);
    const preview = ceremonyPreview(cwd, "loop", config);
    assert.equal(preview.stage_slots, 4);
    assert.equal(preview.dispatch_count.min, 4);
    assert.equal(preview.dispatch_count.max, 4);
    assert.deepEqual(preview.conditional_stages, []);
  });

  test("full track: conditional stages (security-review, migration-safety) widen dispatch_count.max only", () => {
    const cwd = makeCwd();
    const config = loadConfig(cwd);
    const preview = computeStaticEstimate(cwd, "full", config);
    assert.deepEqual(preview.conditional_stages.sort(), ["stage-04b", "stage-04d"]);
    assert.ok(preview.dispatch_count.max > preview.dispatch_count.min);
  });
});

// ─── 2. Static estimate resolves a known model below the empirical threshold ───

describe("ceremony-preview: static basis with a resolvable model", () => {
  test("a single corpus record for a (role, host) pair prices that dispatch without promoting to empirical", () => {
    const cwd = makeCwd("routing:\n  default_host: generic\npipeline:\n  default_track: loop\n");
    // Only 1 record — far below MIN_EMPIRICAL_RUNS — but it names a priced
    // model for every (role, host) pair the loop track dispatches.
    writeCorpus(cwd, [
      { ts: "2026-07-01T00:00:00Z", run_id: "r1", stage: "stage-01", role: "pm", host: "generic", model_observed: "claude-opus-4-7", track: "loop" },
      { ts: "2026-07-01T00:00:01Z", run_id: "r1", stage: "stage-04", role: "backend", host: "generic", model_observed: "claude-sonnet-4-6", track: "loop" },
      { ts: "2026-07-01T00:00:02Z", run_id: "r1", stage: "stage-06", role: "qa", host: "generic", model_observed: "claude-sonnet-4-6", track: "loop" },
    ]);
    const config = loadConfig(cwd);
    const preview = ceremonyPreview(cwd, "loop", config);

    assert.equal(preview.estimate_basis, "static", "1 run must not cross the empirical threshold");
    assert.deepEqual(preview.unresolved_models, []);
    assert.ok(preview.cost_usd, "cost_usd must be populated once every dispatch's model is known");
    assert.ok(preview.cost_usd.low > 0);
    assert.ok(preview.cost_usd.high >= preview.cost_usd.low);
  });

  test("unknown-model path: partial corpus coverage still omits cost entirely (never a partial dollar figure)", () => {
    const cwd = makeCwd("routing:\n  default_host: generic\npipeline:\n  default_track: loop\n");
    // Model known for pm@generic only — backend/qa remain unresolved.
    writeCorpus(cwd, [
      { ts: "2026-07-01T00:00:00Z", run_id: "r1", stage: "stage-01", role: "pm", host: "generic", model_observed: "claude-opus-4-7", track: "loop" },
    ]);
    const config = loadConfig(cwd);
    const preview = ceremonyPreview(cwd, "loop", config);

    assert.equal(preview.cost_usd, null, "cost must never be shown as complete when some dispatches are unpriced");
    assert.ok(preview.unresolved_models.includes("backend@generic"));
    assert.ok(preview.unresolved_models.includes("qa@generic"));
    assert.ok(preview.tokens.low > 0, "tokens must still be reported");
  });
});

// ─── 3. Artifact sampling widens the token range ──────────────────────────

describe("ceremony-preview: on-disk pipeline artifact sampling", () => {
  test("an existing pipeline/brief.md widens tokens.high for stages that read it", () => {
    const cwd = makeCwd("routing:\n  default_host: generic\npipeline:\n  default_track: loop\n");
    const config = loadConfig(cwd);
    const fresh = computeStaticEstimate(cwd, "loop", config);
    assert.equal(fresh.tokens.low, fresh.tokens.high, "no pipeline artifacts on disk yet → low == high");

    fs.mkdirSync(path.join(cwd, "pipeline"), { recursive: true });
    fs.writeFileSync(path.join(cwd, "pipeline", "brief.md"), "# Brief\n".padEnd(4000, "x"));
    const withArtifact = computeStaticEstimate(cwd, "loop", config);
    assert.ok(withArtifact.tokens.high > fresh.tokens.high, "sampled brief.md bytes must widen the high bound");
    assert.equal(withArtifact.tokens.low, fresh.tokens.low, "low bound stays the framework-only floor");
  });
});

// ─── 4. Empirical basis ────────────────────────────────────────────────────

describe("ceremony-preview: empirical basis (phase-28 corpus)", () => {
  test(`>= ${MIN_EMPIRICAL_RUNS} runs of the same track switches to empirical medians`, () => {
    const cwd = makeCwd("routing:\n  default_host: generic\npipeline:\n  default_track: loop\n");
    const records = [];
    const runCosts = [];
    for (let run = 1; run <= MIN_EMPIRICAL_RUNS + 1; run++) {
      const totalCost = 0.10 + run * 0.01;
      runCosts.push(totalCost);
      records.push({
        ts: `2026-07-0${run}T00:00:00Z`, run_id: `run-${run}`, stage: "stage-01",
        role: "pm", host: "generic", model_observed: "claude-opus-4-7", track: "loop",
        tokens_in: 1000, tokens_out: 200, cost_usd: totalCost / 2,
      });
      records.push({
        ts: `2026-07-0${run}T00:00:01Z`, run_id: `run-${run}`, stage: "stage-04",
        role: "backend", host: "generic", model_observed: "claude-sonnet-4-6", track: "loop",
        tokens_in: 800, tokens_out: 150, cost_usd: totalCost / 2,
      });
    }
    writeCorpus(cwd, records);
    const config = loadConfig(cwd);
    const preview = ceremonyPreview(cwd, "loop", config);

    assert.equal(preview.estimate_basis, "empirical");
    assert.equal(preview.sample_size, MIN_EMPIRICAL_RUNS + 1);
    assert.equal(preview.dispatch_count.min, 2);
    assert.equal(preview.dispatch_count.max, 2);
    assert.ok(preview.cost_usd, "empirical cost must be populated when every dispatch in every run has a cost");
    assert.equal(preview.cost_usd.low, preview.cost_usd.high, "empirical estimate reports a single median, not a range");

    const sortedCosts = [...runCosts].sort((a, b) => a - b);
    const mid = Math.floor(sortedCosts.length / 2);
    const expectedMedian = sortedCosts.length % 2 === 0
      ? (sortedCosts[mid - 1] + sortedCosts[mid]) / 2
      : sortedCosts[mid];
    assert.ok(Math.abs(preview.cost_usd.low - expectedMedian) < 1e-9);
  });

  test("< MIN_EMPIRICAL_RUNS runs of the track falls back to static", () => {
    const cwd = makeCwd("routing:\n  default_host: generic\npipeline:\n  default_track: loop\n");
    const records = [];
    for (let run = 1; run < MIN_EMPIRICAL_RUNS; run++) {
      records.push({ ts: `2026-07-0${run}T00:00:00Z`, run_id: `run-${run}`, stage: "stage-01", role: "pm", host: "generic", model_observed: "claude-opus-4-7", track: "loop", tokens_in: 1000, tokens_out: 200, cost_usd: 0.05 });
    }
    writeCorpus(cwd, records);
    assert.equal(computeEmpiricalEstimate(cwd, "loop"), null);
  });

  test("runs of a different track don't count toward this track's empirical threshold", () => {
    const cwd = makeCwd("routing:\n  default_host: generic\npipeline:\n  default_track: loop\n");
    const records = [];
    for (let run = 1; run <= MIN_EMPIRICAL_RUNS + 2; run++) {
      records.push({ ts: `2026-07-0${run}T00:00:00Z`, run_id: `run-${run}`, stage: "stage-01", role: "pm", host: "generic", model_observed: "claude-opus-4-7", track: "quick", tokens_in: 1000, tokens_out: 200, cost_usd: 0.05 });
    }
    writeCorpus(cwd, records);
    assert.equal(computeEmpiricalEstimate(cwd, "loop"), null);
  });
});

// ─── 5. CLI surfacing (devteam assess) ─────────────────────────────────────

describe("devteam assess: ceremony_preview surfacing", () => {
  test("--json includes a ceremony_preview object", () => {
    const cwd = makeCwd("routing:\n  default_host: generic\npipeline:\n  default_track: full\n");
    const r = runCLI(["assess", "--cwd", cwd, "--json", "--description", "small fix to login button", "src/frontend/button.js"]);
    assert.equal(r.status, 0, r.stderr);
    const result = JSON.parse(r.stdout);
    assert.ok(result.ceremony_preview, "ceremony_preview must be present in --json output");
    assert.equal(result.ceremony_preview.track, result.recommendedTrack);
    assert.match(result.ceremony_preview.estimate_basis, /^(static|empirical)$/);
  });

  test("text output prints a labelled 'Ceremony estimate' line", () => {
    const cwd = makeCwd("routing:\n  default_host: generic\npipeline:\n  default_track: full\n");
    const r = runCLI(["assess", "--cwd", cwd, "--description", "small fix to login button", "src/frontend/button.js"]);
    assert.equal(r.status, 0, r.stderr);
    assert.match(r.stdout, /Ceremony estimate \(static\): \d+ stage slot\(s\), \d+ dispatch\(es\), ~[\d,]+ tokens/);
  });
});
