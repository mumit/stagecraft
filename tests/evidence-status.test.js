"use strict";

const { describe, it, afterEach } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { REPO_ROOT, makeTargetProject, cleanup, runCLI } = require("./_helpers");
const { readJsonLinesBounded, readGatesBounded, readEvidenceSources } = require(
  path.join(REPO_ROOT, "core", "evidence", "readers"),
);
const { analyzeEvidence, extractRouting, extractDurableRouting, extractResolutions } = require(
  path.join(REPO_ROOT, "core", "evidence", "analyzer"),
);
const {
  sourceEventRef, schemaFingerprint, pendingResolution,
} = require(path.join(REPO_ROOT, "core", "evidence", "resolutions"));

let dirs = [];
function track(cwd) { dirs.push(cwd); return cwd; }
afterEach(() => { dirs.forEach(cleanup); dirs = []; });

function writeLog(root, events) {
  fs.mkdirSync(root, { recursive: true });
  fs.writeFileSync(
    path.join(root, "run-log.jsonl"),
    events.map((event) => JSON.stringify(event)).join("\n") + "\n",
  );
}

function treeSnapshot(root) {
  const snapshot = {};
  function visit(dir) {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
      const full = path.join(dir, entry.name);
      const relative = path.relative(root, full).replace(/\\/g, "/");
      if (entry.isDirectory()) visit(full);
      else if (entry.isFile()) snapshot[relative] = fs.readFileSync(full, "base64");
      else snapshot[relative] = entry.isSymbolicLink() ? "symlink" : "other";
    }
  }
  visit(root);
  return snapshot;
}

describe("evidence bounded readers", () => {
  it("streams valid log records and reports malformed and oversized lines", () => {
    const cwd = track(fs.mkdtempSync(path.join(os.tmpdir(), "devteam-test-")));
    const file = path.join(cwd, "run-log.jsonl");
    fs.writeFileSync(file, [
      JSON.stringify({ outcome: "run-start", intent: "feature" }),
      "not-json",
      JSON.stringify({ padding: "x".repeat(100) }),
      JSON.stringify({ outcome: "complete" }),
    ].join("\n") + "\n");

    const result = readJsonLinesBounded(file, { maxBytes: 10_000, maxLineBytes: 60 });
    assert.deepEqual(result.records.map((record) => record.outcome), ["run-start", "complete"]);
    assert.equal(result.quality.malformed_records, 1);
    assert.equal(result.quality.oversized_records, 1);
    assert.equal(result.quality.truncated_sources, 0);
  });

  it("reports truncation and refuses symlinked gate sources", { skip: process.platform === "win32" }, () => {
    const cwd = track(fs.mkdtempSync(path.join(os.tmpdir(), "devteam-test-")));
    const log = path.join(cwd, "run-log.jsonl");
    fs.writeFileSync(log, `${JSON.stringify({ outcome: "run-start", intent: "feature" })}\n`.repeat(20));
    const truncated = readJsonLinesBounded(log, { maxBytes: 40, maxLineBytes: 100 });
    assert.equal(truncated.quality.truncated_sources, 1);

    const gates = path.join(cwd, "gates");
    fs.mkdirSync(gates);
    const outside = path.join(cwd, "outside.json");
    fs.writeFileSync(outside, JSON.stringify({ stage: "stage-01" }));
    fs.symlinkSync(outside, path.join(gates, "stage-01.json"));
    const result = readGatesBounded(gates);
    assert.equal(result.records.length, 0);
    assert.equal(result.quality.symlink_sources, 1);

    fs.unlinkSync(path.join(gates, "stage-01.json"));
    const archiveTarget = path.join(cwd, "archive-target");
    fs.mkdirSync(archiveTarget);
    fs.writeFileSync(path.join(archiveTarget, "stage-04.attempt-1.json"), JSON.stringify({
      stage: "stage-04", status: "FAIL",
    }));
    fs.symlinkSync(archiveTarget, path.join(gates, "archive"));
    const directoryResult = readGatesBounded(gates);
    assert.equal(directoryResult.records.length, 0);
    assert.equal(directoryResult.quality.symlink_sources, 1);

    const pipelineTarget = path.join(cwd, "pipeline-target");
    fs.mkdirSync(pipelineTarget);
    const pipelineLink = path.join(cwd, "pipeline-link");
    fs.symlinkSync(pipelineTarget, pipelineLink);
    const rootResult = readEvidenceSources(pipelineLink);
    assert.equal(rootResult.events.length, 0);
    assert.equal(rootResult.quality.symlink_sources, 1);
  });

  it("preserves UTF-8 characters split across read chunks", () => {
    const cwd = track(fs.mkdtempSync(path.join(os.tmpdir(), "devteam-test-")));
    const file = path.join(cwd, "run-log.jsonl");
    const prefix = "{\"padding\":\"";
    const beforeCharacter = "\",\"value\":\"caf";
    const padding = "x".repeat((64 * 1024) - 1 - Buffer.byteLength(prefix + beforeCharacter));
    fs.writeFileSync(file, `${prefix}${padding}${beforeCharacter}é"}\n`);
    const result = readJsonLinesBounded(file, { maxBytes: 100_000, maxLineBytes: 100_000 });
    assert.equal(result.quality.malformed_records, 0);
    assert.equal(result.records[0].value, "café");
  });

  it("bounds gate size and count while reporting malformed input", () => {
    const cwd = track(fs.mkdtempSync(path.join(os.tmpdir(), "devteam-test-")));
    const gates = path.join(cwd, "gates");
    fs.mkdirSync(gates);
    fs.writeFileSync(path.join(gates, "stage-01.json"), "not-json");
    fs.writeFileSync(path.join(gates, "stage-02.json"), JSON.stringify({ padding: "x".repeat(200) }));
    fs.writeFileSync(path.join(gates, "stage-03.json"), JSON.stringify({ stage: "stage-03" }));

    const result = readGatesBounded(gates, { maxFiles: 2, maxGateBytes: 100 });
    assert.equal(result.records.length, 0);
    assert.equal(result.quality.malformed_records, 1);
    assert.equal(result.quality.oversized_records, 1);
    assert.equal(result.quality.truncated_sources, 1);
  });
});

describe("evidence analyzer", () => {
  it("aggregates runs, recovery, rulings, stalls, and readiness without free-form text", () => {
    const secret = "sk-secret-free-form-value";
    const report = analyzeEvidence({
      events: [
        { outcome: "run-start", intent: "feature", reason: secret },
        { outcome: "fix-retry", stage: "stage-04", failure_class: "code-defect", blockers: [secret] },
        { outcome: "auto-ruled", grant_class: "formatting-only", ruling: secret },
        { outcome: "stall-detected", stage: "stage-04", stall_class: "observed", reason: secret },
        { outcome: "complete" },
        { outcome: "run-start", intent: "repair" },
        { outcome: "convergence-halt", stage: "stage-04", failure_class: "code-defect" },
      ],
      gates: [],
      quality: { malformed_records: 0 },
    });

    assert.equal(report.scope.run_count, 2);
    assert.equal(report.scope.complete_run_count, 1);
    assert.equal(report.scope.repair_run_count, 1);
    assert.deepEqual(report.recovery[0], {
      stage: "stage-04", failure_class: "code-defect", observations: 2, runs: 2,
    });
    assert.equal(report.rulings[0].ruling_class, "formatting-only");
    assert.equal(report.stalls[0].stall_class, "observed");
    assert.equal(report.readiness[0].portfolio_status, "not-assessable");
    assert.match(JSON.stringify(report), /no-accepted-resolutions/);
    assert.doesNotMatch(JSON.stringify(report), new RegExp(secret));
  });

  it("aggregates hash-bound accepted resolutions once and measures derivability", () => {
    const source = {
      ts: "2026-06-19T00:00:00Z",
      outcome: "fix-retry",
      stage: "stage-04",
      failure_class: "code-defect",
      cleared_gates: 1,
      derivable: true,
    };
    const accepted = {
      outcome: "resolution-accepted",
      source_event_sha256: sourceEventRef(source),
      stage: source.stage,
      failure_class: source.failure_class,
      schema_fingerprint: schemaFingerprint(source.stage),
      derivable: true,
    };
    const report = analyzeEvidence({
      events: [{ outcome: "run-start", intent: "repair" }, source, accepted, accepted],
    });
    assert.deepEqual(extractResolutions([source, accepted, accepted]), [{
      stage: "stage-04",
      failure_class: "code-defect",
      schema_fingerprint: schemaFingerprint("stage-04"),
      observations: 1,
      derivable: 1,
    }]);
    const h3 = report.readiness.find((item) => item.capability === "h3-recipe-suggestions");
    assert.equal(h3.local_conditions.find((item) => item.id === "accepted-resolution-signal").met, true);
    assert.equal(h3.local_conditions.find(
      (item) => item.id === "derivable-accepted-resolutions-percent",
    ).value, 100);
    assert.deepEqual(extractResolutions([accepted]), []);
    assert.deepEqual(extractResolutions([source, { ...accepted, derivable: false }]), []);
  });

  it("selects the latest unaccepted fix/retry and preserves legacy derivability", () => {
    const first = { outcome: "fix-retry", stage: "stage-04", failure_class: "code-defect", cleared_gates: 1 };
    const second = { outcome: "fix-retry", stage: "stage-06", failure_class: "code-defect", cleared_gates: 0 };
    const pending = pendingResolution([first, second]);
    assert.equal(pending.stage, "stage-06");
    assert.equal(pending.derivable, false);
    assert.equal(pendingResolution([first, second, {
      outcome: "resolution-accepted",
      source_event_sha256: sourceEventRef(second),
    }]).stage, "stage-04");
  });

  it("does not double-count merged and direct current workstream gates", () => {
    const routing = extractRouting([
      {
        source: "current",
        source_id: "stage-04.json",
        gate: {
          stage: "stage-04",
          status: "PASS",
          workstreams: [{ workstream: "backend", host: "codex", status: "PASS" }],
        },
      },
      {
        source: "current",
        source_id: "stage-04.backend.json",
        gate: {
          stage: "stage-04", workstream: "backend", host: "codex", model: "gpt-5",
          status: "PASS", cost_usd: 0.25,
        },
      },
    ]);
    assert.equal(routing.length, 1);
    assert.equal(routing[0].gate_observations, 1);
    assert.equal(routing[0].cost_observations, 1);
  });

  it("prefers durable dispatch history and opens only the durable-history condition", () => {
    const events = [{ outcome: "run-start", intent: "feature" }];
    for (const host of ["codex", "claude-code"]) {
      for (let index = 0; index < 5; index++) {
        events.push({
          outcome: "dispatch-observation",
          stage: "stage-04",
          role: "backend",
          host,
          model: `${host}-model`,
          status: "PASS",
          cost_usd: 0.1,
          duration_ms: 100,
          prompt_bytes: 2048,
          reason: "excluded free-form value",
        });
      }
    }
    events.push({ outcome: "complete" });
    const report = analyzeEvidence({
      events,
      gates: [{
        source: "current",
        source_id: "stage-04.backend.json",
        gate: {
          stage: "stage-04", workstream: "backend", host: "legacy-host",
          model: "legacy-model", status: "FAIL",
        },
      }],
    });

    assert.equal(extractDurableRouting(events).length, 2);
    assert.equal(report.routing.length, 2);
    assert.ok(report.routing.every((row) => row.prompt_observations === 5));
    assert.ok(report.routing.every((row) => row.total_prompt_bytes === 10240));
    assert.ok(report.routing.every((row) => row.host !== "legacy-host"));
    const routingReadiness = report.readiness.find(
      (item) => item.capability === "d5-continuous-routing",
    );
    assert.equal(routingReadiness.local_conditions.find(
      (item) => item.id === "comparable-roles",
    ).met, true);
    assert.equal(routingReadiness.local_conditions.find(
      (item) => item.id === "cost-covered-observations",
    ).value, 10);
    assert.equal(routingReadiness.local_conditions.find(
      (item) => item.id === "durable-dispatch-history",
    ).value, 10);
    assert.doesNotMatch(JSON.stringify(report), /excluded free-form value/);
  });

  it("keeps legacy gate snapshots visible without treating them as durable history", () => {
    const report = analyzeEvidence({
      events: [{ outcome: "run-start", intent: "feature" }],
      gates: [{
        source: "current",
        source_id: "stage-04.backend.json",
        gate: {
          stage: "stage-04", workstream: "backend", host: "codex",
          model: "gpt-5", status: "PASS", cost_usd: 0.2,
        },
      }],
    });
    assert.equal(report.routing.length, 1);
    const condition = report.readiness.find(
      (item) => item.capability === "d5-continuous-routing",
    ).local_conditions.find((item) => item.id === "durable-dispatch-history");
    assert.deepEqual(condition, {
      id: "durable-dispatch-history",
      value: 0,
      threshold: 1,
      met: false,
      reason_code: "durable-dispatch-history-unavailable",
    });
  });
});

describe("devteam evidence status", () => {
  it("reports an empty project successfully", () => {
    const cwd = track(makeTargetProject());
    const result = runCLI(["evidence", "status", "--json", "--cwd", cwd]);
    assert.equal(result.status, 0, result.stderr);
    const report = JSON.parse(result.stdout);
    assert.equal(report.schema_version, "1.0");
    assert.equal(report.scope.run_count, 0);
    assert.equal(report.readiness.length, 4);
    const human = runCLI(["evidence", "status", "--cwd", cwd]);
    assert.match(human.stdout, /no evidence sources found/);
  });

  it("is read-only and excludes hostile free-form values", () => {
    const cwd = track(makeTargetProject());
    const secret = `ghp_${"A".repeat(36)}`;
    writeLog(path.join(cwd, "pipeline"), [
      { outcome: "run-start", intent: "feature", reason: secret },
      { outcome: "fix-retry", stage: "stage-04", failure_class: "code-defect", blockers: [secret] },
      { outcome: "complete", reason: secret },
    ]);
    fs.writeFileSync(path.join(cwd, "pipeline", "gates", "stage-04.backend.json"), JSON.stringify({
      stage: "stage-04",
      workstream: "backend",
      host: "codex",
      model: secret,
      status: "FAIL",
      blockers: [secret],
      warnings: [secret],
    }));
    const before = treeSnapshot(cwd);

    const result = runCLI(["evidence", "status", "--json", "--cwd", cwd]);

    assert.equal(result.status, 0, result.stderr);
    assert.doesNotMatch(result.stdout, new RegExp(secret));
    assert.deepEqual(treeSnapshot(cwd), before);
    const report = JSON.parse(result.stdout);
    assert.equal(report.routing[0].model, "other");
  });

  it("selects a bounded pipeline root from --feature", () => {
    const cwd = track(makeTargetProject({
      config: "routing:\n  default_host: generic\npipeline:\n  default_track: full\n  isolation: bounded\n",
    }));
    writeLog(path.join(cwd, "pipeline", "changes", "checkout-retry"), [
      { outcome: "run-start", intent: "repair" },
      { outcome: "complete" },
    ]);
    const result = runCLI([
      "evidence", "status", "--json", "--cwd", cwd, "--feature", "Checkout retry",
    ]);
    assert.equal(result.status, 0, result.stderr);
    const report = JSON.parse(result.stdout);
    assert.equal(report.scope.run_count, 1);
    assert.equal(report.scope.repair_run_count, 1);
  });

  it("lists the command in global help and rejects unknown subcommands", () => {
    // 37.4: default `devteam help` is now the grouped one-screen view (just
    // the command name, no subcommands); the "evidence status" subcommand
    // detail moved to `devteam help --all`.
    const help = runCLI(["help"]);
    assert.match(help.stdout, /evidence/);
    const fullHelp = runCLI(["help", "--all"]);
    assert.match(fullHelp.stdout, /evidence status/);
    const bad = runCLI(["evidence", "unknown"]);
    assert.equal(bad.status, 2);
    assert.match(bad.stderr, /Usage: devteam evidence/);
  });

  it("requires explicit confirmation and a current PASS gate before accepting", () => {
    const cwd = track(makeTargetProject());
    writeLog(path.join(cwd, "pipeline"), [
      { outcome: "run-start", intent: "repair" },
      { outcome: "fix-retry", stage: "stage-04", failure_class: "code-defect", derivable: true },
    ]);
    const refused = runCLI(["evidence", "accept-resolution", "--cwd", cwd]);
    assert.equal(refused.status, 1);
    assert.match(refused.stderr, /requires --yes/);
    fs.writeFileSync(path.join(cwd, "pipeline", "gates", "stage-04.json"), JSON.stringify({
      stage: "stage-04", status: "FAIL",
    }));
    const failed = runCLI(["evidence", "accept-resolution", "--yes", "--cwd", cwd]);
    assert.equal(failed.status, 1);
    assert.match(failed.stderr, /must be PASS/);
    fs.writeFileSync(path.join(cwd, "pipeline", "gates", "stage-04.json"), JSON.stringify({
      stage: "stage-06", status: "PASS",
    }));
    const mismatched = runCLI(["evidence", "accept-resolution", "--yes", "--cwd", cwd]);
    assert.equal(mismatched.status, 1);
    assert.match(mismatched.stderr, /identity does not match/);
  });

  it("records one privacy-safe acceptance and refuses duplicate reuse", () => {
    const cwd = track(makeTargetProject());
    const secret = `ghp_${"A".repeat(36)}`;
    writeLog(path.join(cwd, "pipeline"), [
      { outcome: "run-start", intent: "repair", reason: secret },
      {
        outcome: "fix-retry", stage: "stage-04", failure_class: "code-defect",
        derivable: true, blockers: [secret],
      },
      { outcome: "complete" },
    ]);
    fs.writeFileSync(path.join(cwd, "pipeline", "gates", "stage-04.json"), JSON.stringify({
      stage: "stage-04", status: "PASS",
    }));
    const accepted = runCLI([
      "evidence", "accept-resolution", "--yes", "--json", "--cwd", cwd,
    ]);
    assert.equal(accepted.status, 0, accepted.stderr);
    const output = JSON.parse(accepted.stdout);
    assert.equal(output.derivable, true);
    assert.match(output.schema_fingerprint, /^sha256:[0-9a-f]{64}$/);
    const log = fs.readFileSync(path.join(cwd, "pipeline", "run-log.jsonl"), "utf8");
    const acceptance = log.trim().split("\n").map(JSON.parse).at(-1);
    assert.deepEqual(Object.keys(acceptance).sort(), [
      "derivable", "failure_class", "outcome", "schema_fingerprint", "source_event_sha256", "stage", "ts",
    ]);
    assert.doesNotMatch(JSON.stringify(acceptance), new RegExp(secret));
    const duplicate = runCLI(["evidence", "accept-resolution", "--yes", "--cwd", cwd]);
    assert.equal(duplicate.status, 1);
    assert.match(duplicate.stderr, /no unaccepted/);
  });

  it("writes acceptance into the selected bounded pipeline only", () => {
    const cwd = track(makeTargetProject({
      config: "pipeline:\n  default_track: full\n  isolation: bounded\n",
    }));
    const root = path.join(cwd, "pipeline", "changes", "checkout-retry");
    writeLog(root, [
      { outcome: "run-start", intent: "repair" },
      { outcome: "fix-retry", stage: "stage-04", failure_class: "code-defect", derivable: true },
    ]);
    fs.mkdirSync(path.join(root, "gates"), { recursive: true });
    fs.writeFileSync(path.join(root, "gates", "stage-04.json"), JSON.stringify({
      stage: "stage-04", status: "PASS",
    }));
    const result = runCLI([
      "evidence", "accept-resolution", "--yes", "--cwd", cwd, "--feature", "Checkout retry",
    ]);
    assert.equal(result.status, 0, result.stderr);
    assert.match(fs.readFileSync(path.join(root, "run-log.jsonl"), "utf8"), /resolution-accepted/);
    assert.equal(fs.existsSync(path.join(cwd, "pipeline", "run-log.jsonl")), false);
  });
});

// ─── 42.5: one logical feature run is one denominator entry ─────────────────

describe("evidence: logical run identity across resumes", () => {
  const { analyzeEvidence } = require(path.join(REPO_ROOT, "core", "evidence", "analyzer"));

  const lineage = [
    { outcome: "run-start", intent: "feature", logical_run_id: "T0" },
    { outcome: "fix-retry", stage: "stage-04", failure_class: "code-defect" },
    { outcome: "run-start", intent: "feature", logical_run_id: "T0" },
    { outcome: "fix-retry", stage: "stage-06", failure_class: "code-defect" },
    { outcome: "run-start", intent: "feature", logical_run_id: "T0" },
    { outcome: "complete" },
  ];

  it("counts one change driven through two resumes as one run", () => {
    // The conflation the 2026-08-19 Phase 41 review hit: run_id is the
    // invocation, and every --resume mints a new one, so a single logical
    // change inflated the denominator readiness logic divides by.
    const report = analyzeEvidence({ events: lineage, gates: [], quality: {} });
    assert.equal(report.scope.run_count, 1, "three invocations, one logical change");
    assert.equal(report.scope.complete_run_count, 1);
    assert.equal(report.quality.orphan_events, 0);
  });

  it("still separates genuinely distinct changes", () => {
    const report = analyzeEvidence({
      events: [...lineage,
        { outcome: "run-start", intent: "feature", logical_run_id: "T9" },
        { outcome: "complete" }],
      gates: [], quality: {},
    });
    assert.equal(report.scope.run_count, 2);
    assert.equal(report.scope.complete_run_count, 2);
  });

  it("keeps the intent of the run that opened the lineage", () => {
    const report = analyzeEvidence({
      events: [
        { outcome: "run-start", intent: "repair", logical_run_id: "T1" },
        { outcome: "run-start", intent: "repair", logical_run_id: "T1" },
        { outcome: "complete" },
      ],
      gates: [], quality: {},
    });
    assert.equal(report.scope.repair_run_count, 1);
  });

  it("a log predating the field behaves exactly as before", () => {
    // Backward compatibility is the whole reason this groups rather than
    // rewrites: an older run-log has no lineage to group by.
    const legacy = lineage.map(({ logical_run_id, ...rest }) => rest); // eslint-disable-line no-unused-vars
    const report = analyzeEvidence({ events: legacy, gates: [], quality: {} });
    assert.equal(report.scope.run_count, 3, "one run per run-start, as before");
    assert.equal(report.scope.complete_run_count, 1);
  });

  it("never copies the lineage id into the report", () => {
    // logical_run_id is a local timestamp. run-log.jsonl is gitignored
    // operational state; the exported surface stays a count, per the privacy
    // boundary in docs/evidence.md (timestamps are never copied).
    const report = analyzeEvidence({ events: lineage, gates: [], quality: {} });
    assert.equal(JSON.stringify(report).includes("T0"), false);
  });
});
