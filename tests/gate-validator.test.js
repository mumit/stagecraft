const { describe, it, afterEach } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { spawnSync } = require("node:child_process");
const { REPO_ROOT, makeTargetProject, seedGate, cleanup } = require("./_helpers");

const VALIDATOR = path.join(REPO_ROOT, "core", "gates", "validator.js");
const INJECT_ERROR_FIXTURE = path.join(REPO_ROOT, "tests", "fixtures", "validator-inject-error.js");

function runValidator(cwd, { strict = false, env } = {}) {
  const args = strict ? [VALIDATOR, "--strict"] : [VALIDATOR];
  const r = spawnSync("node", args, { cwd, encoding: "utf8", env: env || process.env });
  return { status: r.status, stdout: r.stdout || "", stderr: r.stderr || "" };
}

/**
 * Run the inject-error fixture, which reaches the unknown-internal-error path
 * by making autoInjectMetadata's writeFileSync throw a plain TypeError (no .code).
 *
 * @param {string} cwd - a project dir with pipeline/gates/ containing a gate missing `orchestrator`
 * @param {object} opts
 * @param {boolean} opts.strict - pass --strict to the fixture
 * @param {object}  opts.env    - override env (defaults to process.env minus CI)
 */
function runValidatorInjectError(cwd, { strict = false, env } = {}) {
  const args = strict ? [INJECT_ERROR_FIXTURE, cwd, "--strict"] : [INJECT_ERROR_FIXTURE, cwd];
  // Default env strips CI: the validator treats CI=true as strict mode, and
  // these tests run under GitHub Actions (which sets CI=true). Hook-mode
  // assertions must control that input, not inherit it from the runner.
  let childEnv = env;
  if (!childEnv) {
    childEnv = { ...process.env };
    delete childEnv.CI;
  }
  const r = spawnSync("node", args, { cwd, encoding: "utf8", env: childEnv });
  return { status: r.status, stdout: r.stdout || "", stderr: r.stderr || "" };
}

/**
 * Seed a gate that is missing the `orchestrator` field so autoInjectMetadata
 * will attempt to write it back (and the inject-error fixture intercepts that write).
 */
function seedGateNoOrchestrator(cwd, name) {
  const dir = path.join(cwd, "pipeline", "gates");
  fs.mkdirSync(dir, { recursive: true });
  const gate = {
    stage: name.replace(/\.json$/, ""),
    status: "PASS",
    host: "generic",
    track: "full",
    timestamp: "2026-05-26T20:00:00Z",
    blockers: [],
    warnings: [],
    // intentionally missing: orchestrator
  };
  const file = path.join(dir, name.endsWith(".json") ? name : `${name}.json`);
  fs.writeFileSync(file, JSON.stringify(gate, null, 2));
  return file;
}

let _dirs = [];
function track(cwd) { _dirs.push(cwd); return cwd; }
afterEach(() => { _dirs.forEach(cleanup); _dirs = []; });

describe("gate-validator: exit codes", () => {
  it("exits 0 when no gates directory", () => {
    const cwd = track(makeTargetProject({ gates: false }));
    assert.equal(runValidator(cwd).status, 0);
  });

  it("exits 0 when gates dir is empty", () => {
    const cwd = track(makeTargetProject());
    assert.equal(runValidator(cwd).status, 0);
  });

  it("PASS gate → exit 0", () => {
    const cwd = track(makeTargetProject());
    seedGate(cwd, "stage-01", { workstream: "pm", host: "claude-code", status: "PASS" });
    const r = runValidator(cwd);
    assert.equal(r.status, 0);
    assert.match(r.stdout, /✅ GATE PASS/);
  });

  it("WARN gate → exit 0 with warnings printed", () => {
    const cwd = track(makeTargetProject());
    seedGate(cwd, "stage-04", { status: "WARN", warnings: ["coverage at 82%"] });
    const r = runValidator(cwd);
    assert.equal(r.status, 0);
    assert.match(r.stdout, /GATE WARN/);
    assert.match(r.stdout, /coverage at 82%/);
  });

  it("FAIL gate → exit 2 with blockers", () => {
    const cwd = track(makeTargetProject());
    seedGate(cwd, "stage-01", { workstream: "pm", host: "claude-code", status: "FAIL", blockers: ["criterion 3 missing"] });
    const r = runValidator(cwd);
    assert.equal(r.status, 2);
    assert.match(r.stdout, /GATE FAIL/);
    assert.match(r.stdout, /criterion 3 missing/);
  });

  it("ESCALATE gate → exit 3", () => {
    const cwd = track(makeTargetProject());
    seedGate(cwd, "stage-01", { workstream: "pm", host: "claude-code", status: "ESCALATE", escalation_reason: "test escalation" });
    const r = runValidator(cwd);
    assert.equal(r.status, 3);
    assert.match(r.stdout, /ESCALATION REQUIRED/);
    assert.match(r.stdout, /test escalation/);
  });
});

describe("gate-validator: ADR-022 documentation scope", () => {
  it("rejects wildcard documentation authority before dispatch", () => {
    const cwd = track(makeTargetProject());
    seedGate(cwd, "stage-01", {
      stage: "stage-01",
      status: "PASS",
      track: "loop",
      acceptance_criteria_count: 1,
      out_of_scope_items: [],
      required_sections_complete: true,
      active_roles: ["documentation"],
      affected_files: ["docs/**"],
    });
    const result = runValidator(cwd);
    assert.equal(result.status, 1);
    assert.match(`${result.stdout}\n${result.stderr}`, /exact canonical repo-relative file paths/);
  });
});

describe("gate-validator: stage-08 cost gate", () => {
  it("rejects a PASS deploy gate when the cost estimate is missing", () => {
    const cwd = track(makeTargetProject());
    seedGate(cwd, "stage-08", {
      stage: "stage-08",
      status: "PASS",
      deploy_completed: true,
      smoke_tests_passed: true,
      rollback_executed: false,
    });

    const r = runValidator(cwd);
    assert.equal(r.status, 1);
    assert.match(r.stderr, /cost_delta_estimated/);
  });

  it("rejects a PASS deploy gate with a 10x cost increase and no override", () => {
    const cwd = track(makeTargetProject());
    seedGate(cwd, "stage-08", {
      stage: "stage-08",
      status: "PASS",
      deploy_completed: true,
      smoke_tests_passed: true,
      rollback_executed: false,
      cost_delta_estimated: true,
      cost_delta_multiplier: 10,
      cost_gate_override: false,
    });

    const r = runValidator(cwd);
    assert.equal(r.status, 1);
    assert.match(r.stderr, /cost_delta_multiplier >= 10/);
  });

  it("accepts a PASS deploy gate below the 10x threshold", () => {
    const cwd = track(makeTargetProject());
    seedGate(cwd, "stage-08", {
      stage: "stage-08",
      status: "PASS",
      deploy_completed: true,
      smoke_tests_passed: true,
      rollback_executed: false,
      cost_delta_estimated: true,
      cost_delta_multiplier: 2.5,
      cost_gate_override: false,
    });

    const r = runValidator(cwd);
    assert.equal(r.status, 0);
    assert.match(r.stdout, /GATE PASS/);
  });

  it("accepts a 10x deploy cost increase only with an override reason", () => {
    const cwd = track(makeTargetProject());
    seedGate(cwd, "stage-08", {
      stage: "stage-08",
      status: "PASS",
      deploy_completed: true,
      smoke_tests_passed: true,
      rollback_executed: false,
      cost_delta_estimated: true,
      cost_delta_multiplier: 12,
      cost_gate_override: true,
      cost_gate_override_reason: "Approved by platform lead in release review",
    });

    const r = runValidator(cwd);
    assert.equal(r.status, 0);
    assert.match(r.stdout, /GATE PASS/);
  });
});

describe("gate-validator: stage-07 documentation gate", () => {
  it("rejects a PASS sign-off gate when docs fields are missing", () => {
    const cwd = track(makeTargetProject());
    seedGate(cwd, "stage-07", {
      stage: "stage-07",
      status: "PASS",
      pm_signoff: true,
      deploy_requested: true,
      runbook_referenced: true,
    });

    const r = runValidator(cwd);
    assert.equal(r.status, 1);
    assert.match(r.stderr, /docs_surface_affected/);
  });

  it("rejects a user-visible PASS sign-off gate when docs are not updated", () => {
    const cwd = track(makeTargetProject());
    seedGate(cwd, "stage-07", {
      stage: "stage-07",
      status: "PASS",
      pm_signoff: true,
      deploy_requested: true,
      runbook_referenced: true,
      docs_surface_affected: true,
      docs_updated: false,
      docs_skipped_reason: null,
    });

    const r = runValidator(cwd);
    assert.equal(r.status, 1);
    assert.match(r.stderr, /docs_updated: true/);
  });

  it("accepts an internal-only PASS sign-off gate with a skip reason", () => {
    const cwd = track(makeTargetProject());
    seedGate(cwd, "stage-07", {
      stage: "stage-07",
      status: "PASS",
      pm_signoff: true,
      deploy_requested: true,
      runbook_referenced: true,
      docs_surface_affected: false,
      docs_updated: null,
      docs_skipped_reason: "internal refactor, no user-visible surface changed",
    });

    const r = runValidator(cwd);
    assert.equal(r.status, 0);
    assert.match(r.stdout, /GATE PASS/);
  });

  it("allows a FAIL sign-off gate to carry unresolved docs blockers", () => {
    const cwd = track(makeTargetProject());
    seedGate(cwd, "stage-07", {
      stage: "stage-07",
      status: "FAIL",
      pm_signoff: false,
      deploy_requested: false,
      runbook_referenced: true,
      docs_surface_affected: true,
      docs_updated: false,
      docs_skipped_reason: null,
      blockers: ["README must document the new CLI flag"],
    });

    const r = runValidator(cwd);
    assert.equal(r.status, 2);
    assert.match(r.stdout, /README must document/);
  });
});

describe("gate-validator: contract F required fields", () => {
  it("auto-injects orchestrator when missing and passes", () => {
    const cwd = track(makeTargetProject());
    const file = path.join(cwd, "pipeline", "gates", "stage-01.json");
    fs.writeFileSync(file, JSON.stringify({
      stage: "stage-01", status: "PASS",
      // missing: orchestrator — validator should inject it
      track: "full", timestamp: "2026-05-26T00:00:00Z",
      blockers: [], warnings: [],
    }));
    const r = runValidator(cwd);
    assert.equal(r.status, 0);
    assert.match(r.stdout, /auto-injected metadata/);
    const patched = JSON.parse(fs.readFileSync(file, "utf8"));
    assert.match(patched.orchestrator, /^devteam@/);
  });

  it("accepts a workstream gate with workstream + host", () => {
    const cwd = track(makeTargetProject());
    seedGate(cwd, "stage-04.backend", { workstream: "backend", host: "codex", status: "PASS" });
    assert.equal(runValidator(cwd).status, 0);
  });

  it("auto-injects host from routing.default_host when missing", () => {
    const cwd = track(makeTargetProject({
      config: "routing:\n  default_host: codex\npipeline:\n  default_track: full\n",
    }));
    const file = path.join(cwd, "pipeline", "gates", "stage-01.json");
    fs.writeFileSync(file, JSON.stringify({
      stage: "stage-01", status: "PASS",
      orchestrator: "devteam@test",
      // missing: host — validator should pick it up from config.routing.default_host
      track: "full", timestamp: "2026-05-26T00:00:00Z",
      blockers: [], warnings: [],
    }));
    const r = runValidator(cwd);
    assert.equal(r.status, 0);
    const patched = JSON.parse(fs.readFileSync(file, "utf8"));
    assert.equal(patched.host, "codex");
  });

  it("auto-inject defaults host to 'generic' when no config present", () => {
    const cwd = track(makeTargetProject({ config: false }));
    fs.mkdirSync(path.join(cwd, "pipeline", "gates"), { recursive: true });
    const file = path.join(cwd, "pipeline", "gates", "stage-01.json");
    fs.writeFileSync(file, JSON.stringify({
      stage: "stage-01", status: "PASS",
      orchestrator: "devteam@test",
      track: "full", timestamp: "2026-05-26T00:00:00Z",
      blockers: [], warnings: [],
    }));
    const r = runValidator(cwd);
    assert.equal(r.status, 0);
    const patched = JSON.parse(fs.readFileSync(file, "utf8"));
    assert.equal(patched.host, "generic");
  });
});

describe("gate-validator: QA build blocker injection", () => {
  function makeProjectWithContext(cwd, contextContent = "# Context\n\nProject notes.\n") {
    fs.mkdirSync(path.join(cwd, "pipeline"), { recursive: true });
    fs.writeFileSync(path.join(cwd, "pipeline", "context.md"), contextContent);
  }

  it("injects QA blockers into context.md when stage-04.qa FAILs", () => {
    const cwd = track(makeTargetProject());
    makeProjectWithContext(cwd);
    seedGate(cwd, "stage-04.qa", {
      stage: "stage-04", workstream: "qa", status: "FAIL",
      blockers: ["express.static points to public/ which doesn't exist", "Dockerfile CMD references wrong path"],
    });
    runValidator(cwd);
    const ctx = fs.readFileSync(path.join(cwd, "pipeline", "context.md"), "utf8");
    assert.match(ctx, /qa-build-blockers:begin/);
    assert.match(ctx, /QA Build Failures/);
    assert.match(ctx, /express\.static points to public\//);
    assert.match(ctx, /Dockerfile CMD references wrong path/);
    assert.match(ctx, /--skip-completed/);
  });

  it("replaces existing qa-build-blockers block on subsequent FAIL (idempotent)", () => {
    const cwd = track(makeTargetProject());
    makeProjectWithContext(cwd,
      "<!-- devteam:qa-build-blockers:begin -->\n## IMMEDIATE: QA Build Failures\n\n- old bug\n\n<!-- devteam:qa-build-blockers:end -->\n\n# Context\n");
    seedGate(cwd, "stage-04.qa", {
      stage: "stage-04", workstream: "qa", status: "FAIL",
      blockers: ["new bug"],
    });
    runValidator(cwd);
    const ctx = fs.readFileSync(path.join(cwd, "pipeline", "context.md"), "utf8");
    assert.match(ctx, /new bug/);
    assert.doesNotMatch(ctx, /old bug/);
    assert.equal((ctx.match(/qa-build-blockers:begin/g) || []).length, 1, "only one begin marker");
  });

  it("repairs orphaned qa-build-blockers begin marker without losing context", () => {
    const cwd = track(makeTargetProject());
    makeProjectWithContext(cwd,
      "# Context\n\n" +
      "Before orphan.\n\n" +
      "<!-- devteam:qa-build-blockers:begin -->\n" +
      "orphaned stale blocker text\n\n" +
      "After orphan that should survive.\n");
    seedGate(cwd, "stage-04.qa", {
      stage: "stage-04", workstream: "qa", status: "FAIL",
      blockers: ["new bug"],
    });
    runValidator(cwd);
    const ctx = fs.readFileSync(path.join(cwd, "pipeline", "context.md"), "utf8");
    assert.match(ctx, /QA Build Failures/);
    assert.match(ctx, /new bug/);
    assert.match(ctx, /Before orphan/);
    assert.match(ctx, /orphaned stale blocker text/);
    assert.match(ctx, /After orphan that should survive/);
    assert.equal((ctx.match(/qa-build-blockers:begin/g) || []).length, 1, "only one begin marker");
    assert.equal((ctx.match(/qa-build-blockers:end/g) || []).length, 1, "only one end marker");
  });

  it("does not inject when status is PASS", () => {
    const cwd = track(makeTargetProject());
    makeProjectWithContext(cwd);
    seedGate(cwd, "stage-04.qa", {
      stage: "stage-04", workstream: "qa", status: "PASS", blockers: [],
    });
    runValidator(cwd);
    const ctx = fs.readFileSync(path.join(cwd, "pipeline", "context.md"), "utf8");
    assert.doesNotMatch(ctx, /qa-build-blockers/);
  });

  it("does not inject for a non-QA build gate that FAILs", () => {
    const cwd = track(makeTargetProject());
    makeProjectWithContext(cwd);
    seedGate(cwd, "stage-04.backend", {
      stage: "stage-04", workstream: "backend", status: "FAIL",
      blockers: ["some backend failure"],
    });
    runValidator(cwd);
    const ctx = fs.readFileSync(path.join(cwd, "pipeline", "context.md"), "utf8");
    assert.doesNotMatch(ctx, /qa-build-blockers/);
  });

  it("does not inject when context.md does not exist", () => {
    const cwd = track(makeTargetProject());
    // No context.md created — injection must silently no-op
    seedGate(cwd, "stage-04.qa", {
      stage: "stage-04", workstream: "qa", status: "FAIL",
      blockers: ["some bug"],
    });
    assert.doesNotThrow(() => runValidator(cwd));
    assert.ok(!fs.existsSync(path.join(cwd, "pipeline", "context.md")));
  });

  it("logs the injection to stdout", () => {
    const cwd = track(makeTargetProject());
    makeProjectWithContext(cwd);
    seedGate(cwd, "stage-04.qa", {
      stage: "stage-04", workstream: "qa", status: "FAIL",
      blockers: ["bug one", "bug two"],
    });
    const r = runValidator(cwd);
    assert.match(r.stdout, /QA build blockers \(2\) written to pipeline\/context\.md/);
  });
});

describe("gate-validator: red-team blocker injection", () => {
  function makeProjectWithContext(cwd, contextContent = "# Context\n\nProject notes.\n") {
    fs.mkdirSync(path.join(cwd, "pipeline"), { recursive: true });
    fs.writeFileSync(path.join(cwd, "pipeline", "context.md"), contextContent);
  }

  it("repairs orphaned red-team begin marker without losing context", () => {
    const cwd = track(makeTargetProject());
    makeProjectWithContext(cwd,
      "# Context\n\n" +
      "Before orphan.\n\n" +
      "<!-- devteam:red-team-blockers:begin -->\n" +
      "orphaned stale finding\n\n" +
      "After orphan that should survive.\n");
    seedGate(cwd, "stage-04c", {
      stage: "stage-04c",
      status: "FAIL",
      must_address_before_peer_review: [
        { id: "RT-01", severity: "high", likelihood: "likely", summary: "new finding" },
      ],
    });
    runValidator(cwd);
    const ctx = fs.readFileSync(path.join(cwd, "pipeline", "context.md"), "utf8");
    assert.match(ctx, /Red-Team Blockers/);
    assert.match(ctx, /RT-01/);
    assert.match(ctx, /new finding/);
    assert.match(ctx, /Before orphan/);
    assert.match(ctx, /orphaned stale finding/);
    assert.match(ctx, /After orphan that should survive/);
    assert.equal((ctx.match(/red-team-blockers:begin/g) || []).length, 1, "only one begin marker");
    assert.equal((ctx.match(/red-team-blockers:end/g) || []).length, 1, "only one end marker");
  });
});

describe("gate-validator: blocker section cleanup on resolve", () => {
  function makeProjectWithContext(cwd, contextContent = "# Context\n\nProject notes.\n") {
    fs.mkdirSync(path.join(cwd, "pipeline"), { recursive: true });
    fs.writeFileSync(path.join(cwd, "pipeline", "context.md"), contextContent);
  }

  it("strips the qa-build-blockers section when stage-04.qa becomes PASS", () => {
    const cwd = track(makeTargetProject());
    // Simulate a prior FAIL that injected blockers, plus normal context content.
    makeProjectWithContext(cwd,
      "<!-- devteam:qa-build-blockers:begin -->\n" +
      "## IMMEDIATE: QA Build Failures — Fix Before Re-Running QA\n\n" +
      "- old bug\n\n" +
      "<!-- devteam:qa-build-blockers:end -->\n\n" +
      "# Context\n\nProject notes that should survive.\n");
    seedGate(cwd, "stage-04.qa", {
      stage: "stage-04", workstream: "qa", status: "PASS", blockers: [],
    });
    runValidator(cwd);
    const ctx = fs.readFileSync(path.join(cwd, "pipeline", "context.md"), "utf8");
    assert.doesNotMatch(ctx, /qa-build-blockers/, "marker section must be gone");
    assert.doesNotMatch(ctx, /IMMEDIATE: QA Build Failures/, "heading must be gone");
    assert.doesNotMatch(ctx, /old bug/, "stale blocker must be gone");
    assert.match(ctx, /# Context/, "rest of context.md must survive");
    assert.match(ctx, /Project notes that should survive/);
  });

  it("strips the red-team-blockers section when stage-04c becomes PASS", () => {
    const cwd = track(makeTargetProject());
    makeProjectWithContext(cwd,
      "<!-- devteam:red-team-blockers:begin -->\n" +
      "## IMMEDIATE: Red-Team Blockers — Fix Before Peer Review\n\n" +
      "- **R-1** [high/likely]: cited race condition\n\n" +
      "<!-- devteam:red-team-blockers:end -->\n\n" +
      "# Context\n");
    seedGate(cwd, "stage-04c", { stage: "stage-04c", status: "PASS" });
    runValidator(cwd);
    const ctx = fs.readFileSync(path.join(cwd, "pipeline", "context.md"), "utf8");
    assert.doesNotMatch(ctx, /red-team-blockers/);
    assert.doesNotMatch(ctx, /Red-Team Blockers/);
    assert.match(ctx, /# Context/);
  });

  it("strips on WARN as well as PASS (resolved-with-warnings counts as resolved)", () => {
    const cwd = track(makeTargetProject());
    makeProjectWithContext(cwd,
      "<!-- devteam:red-team-blockers:begin -->\nold blocker\n<!-- devteam:red-team-blockers:end -->\n\n# Context\n");
    seedGate(cwd, "stage-04c", { stage: "stage-04c", status: "WARN", warnings: ["minor"] });
    runValidator(cwd);
    const ctx = fs.readFileSync(path.join(cwd, "pipeline", "context.md"), "utf8");
    assert.doesNotMatch(ctx, /red-team-blockers/);
  });

  it("is a no-op when context.md has no injected section", () => {
    const cwd = track(makeTargetProject());
    makeProjectWithContext(cwd, "# Context\n\nProject notes only.\n");
    seedGate(cwd, "stage-04c", { stage: "stage-04c", status: "PASS" });
    runValidator(cwd);
    const ctx = fs.readFileSync(path.join(cwd, "pipeline", "context.md"), "utf8");
    assert.equal(ctx, "# Context\n\nProject notes only.\n");
  });

  it("is a no-op when context.md does not exist", () => {
    const cwd = track(makeTargetProject());
    // No context.md
    seedGate(cwd, "stage-04c", { stage: "stage-04c", status: "PASS" });
    assert.doesNotThrow(() => runValidator(cwd));
  });

  it("does not strip when the gate's stage is unrelated (e.g. stage-04.backend PASS)", () => {
    const cwd = track(makeTargetProject());
    makeProjectWithContext(cwd,
      "<!-- devteam:qa-build-blockers:begin -->\nQA bug\n<!-- devteam:qa-build-blockers:end -->\n\n# Context\n");
    seedGate(cwd, "stage-04.backend", {
      stage: "stage-04", workstream: "backend", status: "PASS",
    });
    runValidator(cwd);
    const ctx = fs.readFileSync(path.join(cwd, "pipeline", "context.md"), "utf8");
    assert.match(ctx, /qa-build-blockers:begin/, "QA blockers must NOT be cleared by an unrelated backend PASS");
  });

  it("logs the strip to stdout", () => {
    const cwd = track(makeTargetProject());
    makeProjectWithContext(cwd,
      "<!-- devteam:qa-build-blockers:begin -->\nstale\n<!-- devteam:qa-build-blockers:end -->\n");
    seedGate(cwd, "stage-04.qa", {
      stage: "stage-04", workstream: "qa", status: "PASS", blockers: [],
    });
    const r = runValidator(cwd);
    assert.match(r.stdout, /QA build-blockers section cleared/);
  });
});

describe("gate-validator: bypassed escalation halts", () => {
  it("an old ESCALATE with a newer gate after it exits 3", () => {
    const cwd = track(makeTargetProject());
    // Write old ESCALATE
    const oldFile = seedGate(cwd, "stage-02", {
      stage: "stage-02", status: "ESCALATE", escalation_reason: "old halt",
    });
    // Backdate it so it's older than the newer gate
    const past = new Date(Date.now() - 60_000);
    fs.utimesSync(oldFile, past, past);
    // Write a newer PASS
    seedGate(cwd, "stage-03", { status: "PASS" });
    const r = runValidator(cwd);
    assert.equal(r.status, 3);
    assert.match(r.stdout, /BYPASSED ESCALATION/);
  });

  it("mtime manipulation does not change the bypassed-escalation verdict", () => {
    // Ordering is now based on gate timestamps, not filesystem mtime.
    // Touching / git-checking-out a gate file cannot move it in the sort order.
    const cwd = track(makeTargetProject());
    // Write an ESCALATE gate with an earlier timestamp → it happened first.
    const escalateFile = seedGate(cwd, "stage-02", {
      stage: "stage-02", status: "ESCALATE", escalation_reason: "bypass test",
      timestamp: "2026-01-01T10:00:00Z",
    });
    // Write a PASS gate with a later timestamp → it was written after the escalation.
    seedGate(cwd, "stage-03", {
      status: "PASS",
      timestamp: "2026-01-01T11:00:00Z",
    });
    // Manipulate mtime: pretend the ESCALATE file is brand-new (future timestamp).
    // With mtime-based ordering, this would make stage-02 appear "newest" → not
    // detected as bypassed. With content-derived ordering, the gate's own
    // timestamp field is used and mtime is irrelevant.
    const future = new Date(Date.now() + 3_600_000);
    fs.utimesSync(escalateFile, future, future);
    const r = runValidator(cwd);
    // Verdict must still be "bypassed escalation", not "live escalation"
    assert.equal(r.status, 3);
    assert.match(r.stdout, /BYPASSED ESCALATION/);
  });
});

describe("gate-validator: --strict mode and validator-errors.log", () => {
  // These tests use the inject-error fixture which patches fs.writeFileSync
  // to throw a plain TypeError inside autoInjectMetadata — the cleanest
  // injection point that reaches runMain()'s unknown-error catch without
  // triggering the ENOENT or HALT_FS_CODES branches.

  it("hook mode (default) → exits 0 when internal error occurs (fail-open for interactive sessions)", () => {
    const cwd = track(makeTargetProject());
    seedGateNoOrchestrator(cwd, "stage-01.json");
    const r = runValidatorInjectError(cwd);
    assert.equal(r.status, 0, `expected exit 0 in hook mode, got ${r.status}. stderr: ${r.stderr}`);
    assert.match(r.stdout, /internal error.*treating as PASS/);
  });

  it("hook mode → appends error to pipeline/validator-errors.log so failures are discoverable", () => {
    const cwd = track(makeTargetProject());
    seedGateNoOrchestrator(cwd, "stage-01.json");
    runValidatorInjectError(cwd);
    const logPath = path.join(cwd, "pipeline", "validator-errors.log");
    assert.ok(fs.existsSync(logPath), "validator-errors.log must be created");
    const content = fs.readFileSync(logPath, "utf8");
    // Must contain a timestamp and the error message.
    assert.match(content, /\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}/);
    assert.match(content, /injected-internal-error/);
  });

  it("--strict → exits 1 when internal error occurs (fail-closed for CI)", () => {
    const cwd = track(makeTargetProject());
    seedGateNoOrchestrator(cwd, "stage-01.json");
    const r = runValidatorInjectError(cwd, { strict: true });
    assert.equal(r.status, 1, `expected exit 1 in --strict mode, got ${r.status}`);
    assert.match(r.stderr, /internal error.*--strict.*CI mode/);
  });

  it("CI=true → exits 1 when internal error occurs (equivalent to --strict)", () => {
    const cwd = track(makeTargetProject());
    seedGateNoOrchestrator(cwd, "stage-01.json");
    const r = runValidatorInjectError(cwd, { env: { ...process.env, CI: "true" } });
    assert.equal(r.status, 1, `expected exit 1 with CI=true, got ${r.status}`);
    assert.match(r.stderr, /internal error.*--strict.*CI mode/);
  });

  it("--strict does not affect normal PASS (strict mode only changes the unknown-error path)", () => {
    const cwd = track(makeTargetProject());
    seedGate(cwd, "stage-01", { status: "PASS" });
    const r = runValidator(cwd, { strict: true });
    assert.equal(r.status, 0, `expected exit 0 for PASS gate in --strict mode`);
    assert.match(r.stdout, /GATE PASS/);
  });

  it("--strict does not affect FAIL gate (still exits 2)", () => {
    const cwd = track(makeTargetProject());
    seedGate(cwd, "stage-01", { status: "FAIL", blockers: ["something failed"] });
    const r = runValidator(cwd, { strict: true });
    assert.equal(r.status, 2, `expected exit 2 for FAIL gate in --strict mode`);
  });
});

// G10: validator auto-injects dispatched_tool_budget on user-driven workstream
// gates (gates that have a workstream field but no dispatched_tool_budget).
// The headless path stamps it from descriptor.toolBudget; the validator covers
// the interactive path where models write gates without the field.
describe("gate-validator: dispatched_tool_budget auto-injection (G10)", () => {
  it("injects dispatched_tool_budget for a known workstream role on claude-code", () => {
    // Seed a workstream gate for the reviewer role (known to have a tool budget).
    const cwd = track(makeTargetProject());
    const dir = path.join(cwd, "pipeline", "gates");
    fs.mkdirSync(dir, { recursive: true });
    const gate = {
      stage: "stage-05",
      status: "PASS",
      host: "claude-code",
      workstream: "reviewer",
      track: "full",
      timestamp: new Date().toISOString(),
      blockers: [],
      warnings: [],
    };
    const gateFile = path.join(dir, "stage-05.reviewer.json");
    fs.writeFileSync(gateFile, JSON.stringify(gate, null, 2));

    runValidator(cwd); // must not throw

    const after = JSON.parse(fs.readFileSync(gateFile, "utf8"));
    assert.ok("dispatched_tool_budget" in after,
      "validator must inject dispatched_tool_budget for a workstream gate missing it");
    assert.ok(Array.isArray(after.dispatched_tool_budget),
      "dispatched_tool_budget must be an array for a known role");
    assert.ok(after.dispatched_tool_budget.length > 0,
      "reviewer has a declared tool budget — dispatched_tool_budget must be non-empty");
    // Reviewer must not have Bash (per ADR-004 §1 table).
    assert.ok(!after.dispatched_tool_budget.includes("Bash"),
      "reviewer budget must not include Bash (read-only constraint)");
  });

  it("does not overwrite a dispatched_tool_budget already present in the gate", () => {
    const cwd = track(makeTargetProject());
    const dir = path.join(cwd, "pipeline", "gates");
    fs.mkdirSync(dir, { recursive: true });
    const preStamped = ["Read", "Glob"];
    const gate = {
      stage: "stage-05",
      status: "PASS",
      host: "claude-code",
      workstream: "reviewer",
      track: "full",
      timestamp: new Date().toISOString(),
      blockers: [],
      warnings: [],
      dispatched_tool_budget: preStamped,
    };
    const gateFile = path.join(dir, "stage-05.reviewer.json");
    fs.writeFileSync(gateFile, JSON.stringify(gate, null, 2));

    runValidator(cwd);

    const after = JSON.parse(fs.readFileSync(gateFile, "utf8"));
    assert.deepEqual(after.dispatched_tool_budget, preStamped,
      "validator must not overwrite a dispatched_tool_budget that the orchestrator already stamped");
  });

  it("injects dispatched_tool_budget from core/roles for any host (including generic)", () => {
    const cwd = track(makeTargetProject());
    const dir = path.join(cwd, "pipeline", "gates");
    fs.mkdirSync(dir, { recursive: true });
    // After 6.1, the validator uses core/roles.toolBudgetFor (host-neutral),
    // so even a gate written against the generic host gets the budget injected.
    const gate = {
      stage: "stage-01",
      status: "PASS",
      host: "generic",
      workstream: "pm",
      track: "full",
      timestamp: new Date().toISOString(),
      blockers: [],
      warnings: [],
    };
    const gateFile = path.join(dir, "stage-01.pm.json");
    fs.writeFileSync(gateFile, JSON.stringify(gate, null, 2));

    runValidator(cwd);

    const after = JSON.parse(fs.readFileSync(gateFile, "utf8"));
    assert.ok("dispatched_tool_budget" in after,
      "validator must inject dispatched_tool_budget via core/roles even for the generic host");
    assert.ok(Array.isArray(after.dispatched_tool_budget),
      "dispatched_tool_budget must be an array for the pm role");
    assert.ok(after.dispatched_tool_budget.length > 0,
      "pm has a declared tool budget — dispatched_tool_budget must be non-empty");
    assert.ok(!after.dispatched_tool_budget.includes("Bash"),
      "pm budget must not include Bash (non-technical role constraint)");
    assert.ok(after.status === "PASS",
      "validator must not change status when injecting tool-budget");
  });
});

// 33.3: the validator auto-injects prompt_pack_version for user-driven gates
// (the interactive-hook path) — the headless path stamps it via
// core/orchestrator.js#patchGateWithPromptPackVersion, same dual-path
// convention as dispatched_tool_budget above.
describe("gate-validator: prompt_pack_version auto-injection (33.3)", () => {
  it("injects prompt_pack_version matching core/prompt-pack.js's computed value", () => {
    const { computePromptPackVersion } = require(path.join(REPO_ROOT, "core", "prompt-pack"));
    const cwd = track(makeTargetProject());
    const gateFile = seedGate(cwd, "stage-01", { status: "PASS" });

    runValidator(cwd);

    const after = JSON.parse(fs.readFileSync(gateFile, "utf8"));
    assert.equal(after.prompt_pack_version, computePromptPackVersion(),
      "validator must inject prompt_pack_version matching core/prompt-pack.js");
  });

  it("does not overwrite a prompt_pack_version already present in the gate", () => {
    const cwd = track(makeTargetProject());
    const gateFile = seedGate(cwd, "stage-01", { status: "PASS", prompt_pack_version: "deadbeef0000" });

    runValidator(cwd);

    const after = JSON.parse(fs.readFileSync(gateFile, "utf8"));
    assert.equal(after.prompt_pack_version, "deadbeef0000",
      "validator must not overwrite a prompt_pack_version already stamped");
  });
});
