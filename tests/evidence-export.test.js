"use strict";

const { describe, it, afterEach } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { REPO_ROOT, makeTargetProject, cleanup, runCLI } = require("./_helpers");
const { analyzeEvidence } = require(path.join(REPO_ROOT, "core", "evidence", "analyzer"));
const {
  createBundle, payloadDigest, readBundle, validateBundle, writeBundle,
} = require(path.join(REPO_ROOT, "core", "evidence", "bundle"));
const {
  projectRef, readIdentity, getOrCreateIdentity, rotateIdentity, deleteIdentity,
} = require(path.join(REPO_ROOT, "core", "evidence", "identity"));
const { analyzePortfolio } = require(path.join(REPO_ROOT, "core", "evidence", "portfolio"));
const {
  schemaFingerprint, sourceEventRef,
} = require(path.join(REPO_ROOT, "core", "evidence", "resolutions"));

let dirs = [];
function track(cwd) { dirs.push(cwd); return cwd; }
afterEach(() => { dirs.forEach(cleanup); dirs = []; });

function evidenceReport(options = {}) {
  const events = [];
  const runs = options.runs || 5;
  for (let index = 0; index < runs; index++) {
    events.push({ outcome: "run-start", intent: "repair" });
    const source = {
      outcome: "fix-retry", stage: "stage-04", failure_class: "code-defect",
      attempt: index + 1, cleared_gates: index < 4 ? 1 : 0, derivable: index < 4,
    };
    events.push(source);
    events.push({
      outcome: "resolution-accepted",
      source_event_sha256: sourceEventRef(source),
      stage: "stage-04",
      failure_class: "code-defect",
      schema_fingerprint: schemaFingerprint("stage-04"),
      derivable: index < 4,
    });
    for (const host of ["codex", "claude-code"]) {
      events.push({
        outcome: "dispatch-observation", stage: "stage-04", role: "backend", host,
        model: `${host}-model`, status: "PASS", gate_written: true, timed_out: false,
        cost_usd: 0.2, duration_ms: 100, prompt_bytes: 4000,
      });
    }
    if (index < 3) {
      events.push({ outcome: "auto-ruled", grant_class: "formatting-only" });
      events.push({ outcome: "stall-detected", stage: "stage-04", stall_class: "observed" });
    }
    if (index === 0) events.push({ outcome: "ceiling-halt" });
    events.push({ outcome: "complete" });
  }
  const gates = [];
  for (const host of ["codex", "claude-code"]) {
    for (let index = 0; index < 5; index++) {
      gates.push({
        source: "archive", source_id: `${host}-${index}`,
        gate: {
          stage: "stage-04", workstream: "backend", host, model: `${host}-model`,
          status: "PASS", cost_usd: 0.2, duration_ms: 100,
        },
      });
    }
  }
  return analyzeEvidence({
    events, gates,
    quality: { log_present: true, gate_files: gates.length },
    dispatchesOutsideRun: options.dispatchesOutsideRun ?? null,
  });
}

function writeFixtureBundle(cwd, name, rawId, report = evidenceReport()) {
  const file = path.join(cwd, name);
  writeBundle(file, createBundle(report, projectRef(rawId), {
    stagecraftVersion: "0.7.0", generatedDate: "2026-06-18",
  }));
  return file;
}

describe("evidence identity", () => {
  it("creates a stable ignored identity, rotates it, and deletes it without exposing raw entropy", () => {
    const cwd = track(makeTargetProject());
    const created = getOrCreateIdentity(cwd);
    assert.equal(created.created, true);
    assert.match(created.project_ref, /^sha256:[0-9a-f]{64}$/);
    const raw = fs.readFileSync(path.join(cwd, ".devteam", "evidence-project-id"), "utf8").trim();
    assert.doesNotMatch(created.project_ref, new RegExp(raw));
    assert.equal(getOrCreateIdentity(cwd).project_ref, created.project_ref);
    assert.match(fs.readFileSync(path.join(cwd, ".gitignore"), "utf8"), /\.devteam\/evidence-project-id/);
    if (process.platform !== "win32") {
      assert.equal(fs.statSync(path.join(cwd, ".devteam", "evidence-project-id")).mode & 0o777, 0o600);
    }
    const rotated = rotateIdentity(cwd);
    assert.notEqual(rotated.project_ref, created.project_ref);
    assert.equal(deleteIdentity(cwd).deleted, true);
    assert.deepEqual(readIdentity(cwd), { exists: false, project_ref: null });
  });

  it("rejects malformed and symlinked identity files", { skip: process.platform === "win32" }, () => {
    const cwd = track(makeTargetProject());
    const file = path.join(cwd, ".devteam", "evidence-project-id");
    fs.writeFileSync(file, "not-an-id\n");
    assert.throws(() => readIdentity(cwd), /malformed/);
    fs.unlinkSync(file);
    const outside = path.join(cwd, "outside-id");
    fs.writeFileSync(outside, "a".repeat(32));
    fs.symlinkSync(outside, file);
    assert.throws(() => readIdentity(cwd), /non-symlink/);
  });

  it("requires confirmation for mutations and never prints the raw identity", () => {
    const cwd = track(makeTargetProject());
    getOrCreateIdentity(cwd);
    const raw = fs.readFileSync(path.join(cwd, ".devteam", "evidence-project-id"), "utf8").trim();
    const refused = runCLI(["evidence", "identity", "--rotate", "--cwd", cwd]);
    assert.equal(refused.status, 1);
    assert.match(refused.stderr, /require --yes/);
    const status = runCLI(["evidence", "identity", "--json", "--cwd", cwd]);
    assert.equal(status.status, 0, status.stderr);
    assert.doesNotMatch(status.stdout, new RegExp(raw));
    assert.deepEqual(Object.keys(JSON.parse(status.stdout)).sort(), ["exists", "project_ref"]);
  });
});

describe("evidence bundle", () => {
  it("publishes a strict v1 JSON Schema for every object boundary", () => {
    const schema = JSON.parse(fs.readFileSync(path.join(
      REPO_ROOT, "core", "evidence", "schemas", "evidence-export.schema.json",
    ), "utf8"));
    assert.equal(schema.$schema, "https://json-schema.org/draft/2020-12/schema");
    assert.equal(schema.additionalProperties, false);
    for (const [name, definition] of Object.entries(schema.$defs)) {
      if (definition.type === "object") {
        assert.equal(definition.additionalProperties, false, `${name} must be closed`);
      }
    }
  });

  it("suppresses sparse dimensional rows, retains dense rows, and validates its digest", () => {
    const sparse = analyzeEvidence({
      gates: [{
        source: "current", source_id: "one",
        gate: { stage: "stage-04", workstream: "backend", host: "codex", model: "gpt-5", status: "PASS" },
      }],
    });
    const sparseBundle = createBundle(sparse, projectRef("1".repeat(32)));
    assert.equal(sparseBundle.routing.length, 0);
    assert.equal(sparseBundle.suppressed_observations, 1);
    const denseBundle = createBundle(evidenceReport(), projectRef("2".repeat(32)));
    assert.equal(denseBundle.routing.length, 2);
    assert.ok(denseBundle.routing.every((row) => row.prompt_observations === 5));
    assert.ok(denseBundle.routing.every((row) => row.total_prompt_bytes === 20000));
    assert.equal(denseBundle.resolutions[0].observations, 5);
    assert.equal(denseBundle.resolutions[0].derivable, 4);
    assert.deepEqual(validateBundle(denseBundle, { verifyDigest: true }), []);
    const { payload_sha256: _digest, ...payload } = denseBundle;
    assert.equal(denseBundle.payload_sha256, payloadDigest(payload));
  });

  it("rejects added fields, tampering, oversized files, and symlinks", { skip: process.platform === "win32" }, () => {
    const cwd = track(makeTargetProject());
    const valid = createBundle(evidenceReport(), projectRef("3".repeat(32)));
    const added = { ...valid, raw_records: [] };
    assert.match(validateBundle(added, { verifyDigest: true }).join(" "), /unexpected/);
    const file = path.join(cwd, "bundle.json");
    fs.writeFileSync(file, JSON.stringify({ ...valid, suppressed_observations: 99 }));
    assert.throws(() => readBundle(file), /digest mismatch/);
    fs.writeFileSync(file, "x".repeat(1_000_001));
    assert.throws(() => readBundle(file), /exceeds/);
    fs.unlinkSync(file);
    const target = path.join(cwd, "target.json");
    fs.writeFileSync(target, JSON.stringify(valid));
    fs.symlinkSync(target, file);
    assert.throws(() => readBundle(file), /non-symlink/);
  });

  it("continues to validate and analyze pre-Phase-18 schema 1.0 bundles", () => {
    const cwd = track(makeTargetProject());
    const current = createBundle(evidenceReport(), projectRef("9".repeat(32)));
    const { payload_sha256: _digest, ...legacyPayload } = current;
    delete legacyPayload.resolutions;
    delete legacyPayload.quality.durable_dispatch_observations;
    const legacy = { ...legacyPayload, payload_sha256: payloadDigest(legacyPayload) };
    assert.deepEqual(validateBundle(legacy, { verifyDigest: true }), []);
    const file = path.join(cwd, "legacy-v1.json");
    fs.writeFileSync(file, JSON.stringify(legacy));
    const report = analyzePortfolio([file]);
    assert.deepEqual(report.resolutions, []);
    assert.equal(report.quality.durable_dispatch_observations, 0);
  });

  it("uses exclusive writes and refuses a symlinked destination parent", { skip: process.platform === "win32" }, () => {
    const cwd = track(makeTargetProject());
    const bundle = createBundle(evidenceReport(), projectRef("4".repeat(32)));
    const file = path.join(cwd, "bundle.json");
    fs.writeFileSync(file, "keep");
    assert.throws(() => writeBundle(file, bundle), /already exists/);
    assert.equal(fs.readFileSync(file, "utf8"), "keep");
    const real = path.join(cwd, "real");
    const link = path.join(cwd, "linked");
    fs.mkdirSync(real);
    fs.symlinkSync(real, link);
    assert.throws(() => writeBundle(path.join(link, "bundle.json"), bundle), /parent.*non-symlink/);
    assert.throws(() => writeBundle(path.join(cwd, "invalid.json"), { ...bundle, generated_date: "2026-02-30" }), /invalid evidence bundle/);
    assert.equal(fs.existsSync(path.join(cwd, "invalid.json")), false);
  });

  it("exports only after consent and excludes hostile free-form input", () => {
    const cwd = track(makeTargetProject());
    const out = path.join(cwd, "evidence.json");
    const secret = `ghp_${"A".repeat(36)}`;
    fs.writeFileSync(path.join(cwd, "pipeline", "run-log.jsonl"), [
      { outcome: "run-start", intent: "repair", reason: secret },
      { outcome: "fix-retry", stage: "stage-04", failure_class: "code-defect", blockers: [secret] },
      { outcome: "complete", response: secret },
    ].map(JSON.stringify).join("\n") + "\n");
    const refused = runCLI(["evidence", "export", "--out", out, "--cwd", cwd]);
    assert.equal(refused.status, 1);
    assert.equal(fs.existsSync(out), false);
    const result = runCLI(["evidence", "export", "--out", out, "--consent", "--cwd", cwd]);
    assert.equal(result.status, 0, result.stderr);
    const serialized = fs.readFileSync(out, "utf8");
    assert.doesNotMatch(serialized, new RegExp(secret));
    assert.deepEqual(validateBundle(JSON.parse(serialized), { verifyDigest: true }), []);
    const second = runCLI(["evidence", "export", "--out", out, "--consent", "--cwd", cwd]);
    assert.equal(second.status, 1);
    assert.match(second.stderr, /already exists/);
  });
});

describe("portfolio evidence", () => {
  it("evaluates two external project bundles and deduplicates exact repeats", () => {
    const cwd = track(makeTargetProject());
    const first = writeFixtureBundle(cwd, "first.json", "5".repeat(32));
    const second = writeFixtureBundle(cwd, "second.json", "6".repeat(32));
    const report = analyzePortfolio([first, second, first]);
    assert.equal(report.scope.project_count, 2);
    assert.equal(report.scope.duplicate_bundles, 1);
    assert.equal(report.readiness.length, 4);
    assert.equal(report.readiness[0].conditions.find((item) => item.id === "recurring-failure-projects").met, true);
    assert.equal(report.readiness[0].conditions.find(
      (item) => item.id === "accepted-recurring-failure-projects",
    ).met, true);
    assert.equal(report.readiness[0].conditions.find(
      (item) => item.id === "derivable-accepted-resolutions-percent",
    ).value, 80);
    assert.equal(report.readiness[0].status, "threshold-met-review-required");
    assert.equal(report.readiness[1].conditions.find(
      (item) => item.id === "projects-with-durable-dispatch-history",
    ).met, true);
    assert.equal(report.readiness[1].status, "threshold-met-review-required");
    assert.equal(report.readiness[3].status, "not-ready");
    const cli = runCLI(["evidence", "status", "--json", "--bundle", first, "--bundle", second]);
    assert.equal(cli.status, 0, cli.stderr);
    assert.equal(JSON.parse(cli.stdout).mode, "portfolio");
  });

  it("rejects conflicting snapshots for one project reference", () => {
    const cwd = track(makeTargetProject());
    const first = writeFixtureBundle(cwd, "first.json", "7".repeat(32));
    const second = writeFixtureBundle(cwd, "second.json", "7".repeat(32), evidenceReport({ runs: 6 }));
    assert.throws(() => analyzePortfolio([first, second]), /conflicting bundles/);
  });

  it("keeps evidence implementation offline by construction", () => {
    for (const relative of [
      "core/evidence/bundle.js", "core/evidence/identity.js", "core/evidence/portfolio.js",
      "core/cli/commands/evidence.js",
    ]) {
      const source = fs.readFileSync(path.join(REPO_ROOT, relative), "utf8");
      assert.doesNotMatch(source, /node:(?:http|https|net)|\bfetch\s*\(/);
    }
  });
});

// ─── 42.5: dispatches_outside_run is optional and backward-compatible ────────

describe("evidence export: dispatches_outside_run (42.5)", () => {
  it("carries the count into the bundle when the corpus was consulted", () => {
    const bundle = createBundle(evidenceReport({ dispatchesOutsideRun: 3 }), projectRef("a".repeat(32)));
    assert.equal(bundle.quality.dispatches_outside_run, 3);
    assert.deepEqual(validateBundle(bundle, { verifyDigest: true }), []);
  });

  it("omits the key when the corpus was not consulted, and still validates", () => {
    // Absent is not zero — "none outside a run" must stay distinct from
    // "this export could not tell".
    const bundle = createBundle(evidenceReport(), projectRef("b".repeat(32)));
    assert.equal("dispatches_outside_run" in bundle.quality, false);
    assert.deepEqual(validateBundle(bundle, { verifyDigest: true }), []);
  });

  it("a bundle predating the field validates unchanged", () => {
    const current = createBundle(evidenceReport({ dispatchesOutsideRun: 2 }), projectRef("c".repeat(32)));
    const { payload_sha256: _digest, ...payload } = current;
    delete payload.quality.dispatches_outside_run;
    const legacy = { ...payload, payload_sha256: payloadDigest(payload) };
    assert.deepEqual(validateBundle(legacy, { verifyDigest: true }), []);
  });

  it("rejects a non-numeric value", () => {
    const current = createBundle(evidenceReport(), projectRef("d".repeat(32)));
    const { payload_sha256: _digest, ...payload } = current;
    payload.quality.dispatches_outside_run = "three";
    const bad = { ...payload, payload_sha256: payloadDigest(payload) };
    assert.ok(validateBundle(bad, { verifyDigest: true }).length > 0);
  });
});
