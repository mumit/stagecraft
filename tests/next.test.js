const { describe, it, afterEach } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { REPO_ROOT, makeTargetProject, seedGate, cleanup, runCLI } = require("./_helpers");
const { next } = require(path.join(REPO_ROOT, "core", "orchestrator"));
const { formatGateClear } = require(path.join(REPO_ROOT, "core", "pipeline", "fix-recipes"));

let _dirs = [];
function track(cwd) { _dirs.push(cwd); return cwd; }
afterEach(() => { _dirs.forEach(cleanup); _dirs = []; });

function clearsGate(commands, relPath) {
  return commands.some((cmd) =>
    cmd.startsWith("node -e ") &&
    cmd.includes("rmSync(process.argv[1]") &&
    cmd.endsWith(` ${relPath}`));
}

describe("next: walks through full track", () => {
  it("empty pipeline → run-stage requirements", () => {
    const cwd = track(makeTargetProject());
    const r = next({ cwd });
    assert.equal(r.action, "run-stage");
    assert.equal(r.name, "requirements");
  });

  it("after stage-01 PASS → run-stage design", () => {
    const cwd = track(makeTargetProject());
    seedGate(cwd, "stage-01", { status: "PASS" });
    const r = next({ cwd });
    assert.equal(r.action, "run-stage");
    assert.equal(r.name, "design");
  });

  it("multi-role partial → continue-stage with completed/remaining", () => {
    const cwd = track(makeTargetProject());
    for (const s of ["stage-01", "stage-02", "stage-03", "stage-03b"]) {
      seedGate(cwd, s, { status: "PASS" });
    }
    seedGate(cwd, "stage-04.backend", { workstream: "backend", host: "claude-code", status: "PASS" });
    seedGate(cwd, "stage-04.frontend", { workstream: "frontend", host: "claude-code", status: "PASS" });
    const r = next({ cwd });
    assert.equal(r.action, "continue-stage");
    assert.deepEqual(r.completed.sort(), ["backend", "frontend"]);
    assert.deepEqual(r.remaining.sort(), ["platform", "qa"]);
  });

  it("multi-role complete but not merged → merge action", () => {
    const cwd = track(makeTargetProject());
    for (const s of ["stage-01", "stage-02", "stage-03", "stage-03b"]) seedGate(cwd, s, { status: "PASS" });
    for (const role of ["backend", "frontend", "platform", "qa"]) {
      seedGate(cwd, `stage-04.${role}`, { workstream: role, host: "claude-code", status: "PASS" });
    }
    const r = next({ cwd });
    assert.equal(r.action, "merge");
    assert.equal(r.name, "build");
  });

  // Regression: a real `devteam run --track loop` on codex reported
  // "1/4 workstreams complete... remaining: frontend, platform, qa" for a
  // build stage that only ever dispatches a single workstream (backend) on
  // the loop track — remaining could never empty out, so the run stalled
  // forever. The completed/remaining computation used stageDef.roles (the
  // static 4-role matrix) instead of rolesForStage() (which correctly
  // narrows to ["backend"] on loop), a fix already applied for stage-05 but
  // not generalized to stage-04.
  it("loop track: build (stage-04) with only backend's gate present is 'merge', not 'continue-stage' waiting on frontend/platform/qa", () => {
    const cwd = track(makeTargetProject({
      config: "routing:\n  default_host: generic\npipeline:\n  default_track: loop\n",
    }));
    seedGate(cwd, "stage-01", { status: "PASS", track: "loop" });
    seedGate(cwd, "stage-04.backend", { workstream: "backend", host: "codex", track: "loop", status: "PASS" });
    const r = next({ cwd });
    assert.equal(r.action, "merge");
    assert.equal(r.name, "build");
  });

  it("FAIL gate → fix-and-retry with blockers", () => {
    const cwd = track(makeTargetProject());
    seedGate(cwd, "stage-01", { status: "FAIL", blockers: ["bad criterion"] });
    const r = next({ cwd });
    assert.equal(r.action, "fix-and-retry");
    assert.deepEqual(r.blockers, ["bad criterion"]);
  });

  it("ESCALATE gate → resolve-escalation", () => {
    const cwd = track(makeTargetProject());
    seedGate(cwd, "stage-01", { status: "ESCALATE", escalation_reason: "ambiguous spec" });
    const r = next({ cwd });
    assert.equal(r.action, "resolve-escalation");
    assert.match(r.reason, /ambiguous spec/);
  });

  it("CLI does not treat stale Principal rulings as resolving the current escalation", () => {
    const cwd = track(makeTargetProject());
    fs.mkdirSync(path.join(cwd, "pipeline"), { recursive: true });
    fs.writeFileSync(path.join(cwd, "pipeline", "context.md"), [
      "# Pipeline Context",
      "",
      "## Principal Rulings",
      "",
      "PRINCIPAL-RULING: package ownership → backend owns package.json [class: path-ownership]",
      "",
    ].join("\n"));
    seedGate(cwd, "stage-01", {
      status: "ESCALATE",
      escalation_reason: "sign-off needs docs for GET /hello",
      decision_needed: "decide whether docs must be added before sign-off",
      blockers: ["GET /hello has no README documentation"],
    });

    const r = runCLI(["next", "--skip-advise"], { cwd });
    assert.equal(r.status, 0);
    assert.match(r.stdout, /Existing Principal ruling\(s\) found \(1\), but none appears to match this requirements escalation/);
    assert.match(r.stdout, /devteam ruling --target-gate .*pipeline\/gates\/stage-01\.json/);
  });

  it("CLI treats a matching Principal ruling as ready for fix-escalation", () => {
    const cwd = track(makeTargetProject());
    fs.mkdirSync(path.join(cwd, "pipeline"), { recursive: true });
    fs.writeFileSync(path.join(cwd, "pipeline", "context.md"), [
      "# Pipeline Context",
      "",
      "## Principal Rulings",
      "",
      "PRINCIPAL-RULING: sign-off docs for GET /hello → add docs before sign-off [class: doc-only]",
      "",
    ].join("\n"));
    seedGate(cwd, "stage-01", {
      status: "ESCALATE",
      escalation_reason: "sign-off needs docs for GET /hello",
      decision_needed: "decide whether docs must be added before sign-off",
      blockers: ["GET /hello has no README documentation"],
    });

    const r = runCLI(["next", "--skip-advise"], { cwd });
    assert.equal(r.status, 0);
    assert.match(r.stdout, /Principal ruling is written \(1 current ruling\(s\), 1 total in pipeline\/context\.md\)/);
    assert.match(r.stdout, /devteam fix-escalation --headless/);
  });

  it("CLI does not treat stale Principal cannot-decide outputs as the current escalation", () => {
    const cwd = track(makeTargetProject());
    fs.mkdirSync(path.join(cwd, "pipeline"), { recursive: true });
    fs.writeFileSync(path.join(cwd, "pipeline", "context.md"), [
      "# Pipeline Context",
      "",
      "## Principal Rulings",
      "",
      "PRINCIPAL-CANNOT-DECIDE: authority → Should Stage 8 deploy be configured now?",
      "",
    ].join("\n"));
    seedGate(cwd, "stage-01", {
      status: "ESCALATE",
      escalation_reason: "sign-off needs docs for GET /hello",
      decision_needed: "decide whether docs must be added before sign-off",
      blockers: ["GET /hello has no README documentation"],
    });

    const r = runCLI(["next", "--skip-advise"], { cwd });
    assert.equal(r.status, 0);
    assert.doesNotMatch(r.stdout, /Principal cannot decide/);
    assert.match(r.stdout, /Existing Principal output\(s\) found \(1\), but none appears to match this requirements escalation/);
    assert.match(r.stdout, /devteam ruling --target-gate .*pipeline\/gates\/stage-01\.json/);
  });

  it("CLI lets a newer matching Principal ruling supersede an earlier cannot-decide", () => {
    const cwd = track(makeTargetProject());
    fs.mkdirSync(path.join(cwd, "pipeline"), { recursive: true });
    fs.writeFileSync(path.join(cwd, "pipeline", "context.md"), [
      "# Pipeline Context",
      "",
      "## Principal Rulings",
      "",
      "PRINCIPAL-CANNOT-DECIDE: authority → Should docs for GET /hello block sign-off?",
      "PRINCIPAL-RULING: sign-off docs for GET /hello → add README docs before sign-off [class: doc-only]",
      "",
    ].join("\n"));
    seedGate(cwd, "stage-01", {
      status: "ESCALATE",
      escalation_reason: "sign-off needs docs for GET /hello",
      decision_needed: "decide whether docs must be added before sign-off",
      blockers: ["GET /hello has no README documentation"],
    });

    const r = runCLI(["next", "--skip-advise"], { cwd });
    assert.equal(r.status, 0);
    assert.doesNotMatch(r.stdout, /Principal cannot decide/);
    assert.match(r.stdout, /Principal ruling is written \(1 current ruling\(s\), 1 total in pipeline\/context\.md\)/);
    assert.match(r.stdout, /devteam fix-escalation --headless/);
  });

  it("CLI does not treat a stale sign-off convergence ruling as current for peer-review", () => {
    const cwd = track(makeTargetProject());
    for (const s of ["stage-01", "stage-02", "stage-03", "stage-03b", "stage-04", "stage-04a",
                     "stage-04b", "stage-04c", "stage-04d", "stage-04e"]) {
      seedGate(cwd, s, { status: "PASS" });
    }
    fs.mkdirSync(path.join(cwd, "pipeline"), { recursive: true });
    fs.writeFileSync(path.join(cwd, "pipeline", "context.md"), [
      "# Pipeline Context",
      "",
      "## Principal Rulings",
      "",
      "PRINCIPAL-RULING: no-progress convergence for \"sign-off\": 3 blockers identical across attempts 1,2: 'Documentation gate is not satisfied: GET /hello has no README documentation.', 'Required runbook artifact pipeline/runbook.md was requested, but allowedWrites excludes that path.'; escalating for a ruling → Document endpoint and accept existing runbook artifact [class: doc-artifact-scope]",
      "",
    ].join("\n"));
    seedGate(cwd, "stage-05", {
      status: "ESCALATE",
      escalation_reason: "driver retry budget exhausted for \"peer-review\" (2/2); escalating",
      decision_needed: "Decide how to resolve the peer-review convergence failure.",
      blockers: ["qa review did not converge after retry budget was exhausted"],
    });

    const r = runCLI(["next", "--skip-advise"], { cwd });
    assert.equal(r.status, 0);
    assert.match(r.stdout, /Existing Principal ruling\(s\) found \(1\), but none appears to match this peer-review escalation/);
    assert.match(r.stdout, /devteam ruling --target-gate .*pipeline\/gates\/stage-05\.json/);
    assert.doesNotMatch(r.stdout, /Principal ruling is written/);
  });

  it("CLI still accepts a same-stage peer-review convergence ruling", () => {
    const cwd = track(makeTargetProject());
    for (const s of ["stage-01", "stage-02", "stage-03", "stage-03b", "stage-04", "stage-04a",
                     "stage-04b", "stage-04c", "stage-04d", "stage-04e"]) {
      seedGate(cwd, s, { status: "PASS" });
    }
    fs.mkdirSync(path.join(cwd, "pipeline"), { recursive: true });
    fs.writeFileSync(path.join(cwd, "pipeline", "context.md"), [
      "# Pipeline Context",
      "",
      "## Principal Rulings",
      "",
      "PRINCIPAL-RULING: peer-review retry budget exhausted → accept derived approvals and merge review [class: review-convergence]",
      "",
    ].join("\n"));
    seedGate(cwd, "stage-05", {
      status: "ESCALATE",
      escalation_reason: "driver retry budget exhausted for \"peer-review\" (2/2); escalating",
      decision_needed: "Decide how to resolve the peer-review convergence failure.",
      blockers: ["qa review did not converge after retry budget was exhausted"],
    });

    const r = runCLI(["next", "--skip-advise"], { cwd });
    assert.equal(r.status, 0);
    assert.match(r.stdout, /Principal ruling is written \(1 current ruling\(s\), 1 total in pipeline\/context\.md\)/);
    assert.match(r.stdout, /devteam fix-escalation --headless/);
  });

  // Regression: a real hello-world-codex-loop run escalated on pre-review
  // over a genuine Starlette CVE, but `devteam next` reported an unrelated,
  // stale "build" ruling as "current" — 1 current ruling(s), 1 total — so
  // `devteam fix-escalation` kept applying instructions about a completely
  // different (already-resolved) problem and never touched the real
  // blocker. Root cause: driver.js injects an identical boilerplate
  // decision_needed template ("Add fix instructions to pipeline/context.md
  // above devteam markers, then: devteam restart <stage> && devteam run")
  // on every convergence-exhausted escalation, and rules/escalation.md's
  // own documented `--topic` auto-derivation echoes that exact boilerplate
  // into the ruling's own topic text — so two convergence-exhausted
  // escalations for entirely different stages/topics always token-overlap
  // on pure instructional filler ("instructions", "above", "markers",
  // "then", "restart", "devteam") and get treated as matching regardless
  // of substance.
  it("CLI does not treat a stale convergence-exhausted ruling (for a different stage) as current, even though both share the driver's boilerplate decision_needed template", () => {
    const cwd = track(makeTargetProject());
    for (const s of ["stage-01", "stage-02", "stage-03", "stage-03b", "stage-04"]) {
      seedGate(cwd, s, { status: "PASS" });
    }
    fs.mkdirSync(path.join(cwd, "pipeline"), { recursive: true });
    fs.writeFileSync(path.join(cwd, "pipeline", "context.md"), [
      "# Pipeline Context",
      "",
      "## Principal Rulings",
      "",
      "PRINCIPAL-RULING: driver retry budget exhausted for \"build\" (2/2); escalating — "
      + "Add fix instructions to pipeline/context.md above devteam markers, then: devteam restart build && devteam run "
      + "→ Refresh stale build gates; downgrade host limitations [class: stale-concurrent-gate]",
      "",
    ].join("\n"));
    seedGate(cwd, "stage-04a", {
      workstream: "platform",
      status: "ESCALATE",
      escalation_reason: "driver retry budget exhausted for \"pre-review\" (2/2); escalating",
      decision_needed: "Add fix instructions to pipeline/context.md above devteam markers, then: devteam restart pre-review && devteam run",
      blockers: [
        "The pinned FastAPI 0.116.1 graph resolves to Starlette 0.47.3, which pip-audit reports as vulnerable; "
        + "PYSEC-2026-1942 / CVE-2025-62727 is High (CVSS 7.5), affects the application's FileResponse route, and "
        + "is fixed in Starlette 0.49.1. Upgrade to a mutually compatible pinned dependency set and rerun Stage 4a.",
      ],
    });

    const r = runCLI(["next", "--skip-advise"], { cwd });
    assert.equal(r.status, 0);
    assert.match(r.stdout, /Existing Principal ruling\(s\) found \(1\), but none appears to match this pre-review escalation/);
    assert.doesNotMatch(r.stdout, /Principal ruling is written/);
  });

  it("all stages PASS → pipeline-complete", () => {
    const cwd = track(makeTargetProject());
    // Seed a PASS gate for every stage in the full track so the test
    // stays robust as new stages are added to ORDERED_STAGE_NAMES.
    const { orderedStageNamesForTrack, getStage } = require("../core/pipeline/stages");
    for (const name of orderedStageNamesForTrack("full")) {
      const stageId = getStage(name).stage;
      seedGate(cwd, stageId, { status: "PASS" });
    }
    const r = next({ cwd });
    assert.equal(r.action, "pipeline-complete");
  });

  it("WARN gate treated as PASS-equivalent (advances)", () => {
    const cwd = track(makeTargetProject());
    seedGate(cwd, "stage-01", { status: "WARN", warnings: ["minor"] });
    const r = next({ cwd });
    assert.equal(r.action, "run-stage");
    assert.equal(r.name, "design");
  });
});

describe("next: conditional dispatch", () => {
  it("stage-04b skipped when stage-04a.security_review_required is false", () => {
    const cwd = track(makeTargetProject());
    for (const s of ["stage-01","stage-02","stage-03","stage-03b","stage-04"]) seedGate(cwd, s, { status: "PASS" });
    seedGate(cwd, "stage-04a", { status: "PASS", security_review_required: false });
    const r = next({ cwd });
    // Skip security-review (conditional) and land on red-team (always-on
    // for full track). stage-04c sits between stage-04b and stage-05 since
    // G4 landed.
    assert.equal(r.name, "red-team", "expected to skip security-review and land on red-team");
  });

  it("auditSkips returns a typed skip-stage transition with trigger inputs", () => {
    const cwd = track(makeTargetProject());
    for (const s of ["stage-01","stage-02","stage-03","stage-03b","stage-04"]) seedGate(cwd, s, { status: "PASS" });
    seedGate(cwd, "stage-04a", { status: "PASS", security_review_required: false });
    const r = next({ cwd, auditSkips: true });
    assert.equal(r.action, "skip-stage");
    assert.equal(r.name, "security-review");
    assert.equal(r.skip_kind, "conditionalOn");
    assert.deepEqual(r.trigger_inputs, {
      prerequisite_stage: "stage-04a",
      field: "security_review_required",
      expected: true,
      actual: false,
      force_stages: [],
    });
  });

  it("auditSkips skips past stages already recorded in auditedSkips", () => {
    const cwd = track(makeTargetProject());
    for (const s of ["stage-01","stage-02","stage-03","stage-03b","stage-04"]) seedGate(cwd, s, { status: "PASS" });
    seedGate(cwd, "stage-04a", { status: "PASS", security_review_required: false });
    const r = next({ cwd, auditSkips: true, auditedSkips: ["security-review"] });
    assert.equal(r.name, "red-team");
  });

  it("stage-04b runs when stage-04a.security_review_required is true", () => {
    const cwd = track(makeTargetProject());
    for (const s of ["stage-01","stage-02","stage-03","stage-03b","stage-04"]) seedGate(cwd, s, { status: "PASS" });
    seedGate(cwd, "stage-04a", { status: "PASS", security_review_required: true });
    const r = next({ cwd });
    assert.equal(r.action, "run-stage");
    assert.equal(r.name, "security-review");
  });

  it("force_stages runs a conditional stage even when its condition is false", () => {
    const cwd = track(makeTargetProject({
      config: "pipeline:\n  force_stages:\n    - security-review\n",
    }));
    for (const s of ["stage-01","stage-02","stage-03","stage-03b","stage-04"]) seedGate(cwd, s, { status: "PASS" });
    seedGate(cwd, "stage-04a", { status: "PASS", security_review_required: false });
    const r = next({ cwd });
    assert.equal(r.action, "run-stage");
    assert.equal(r.name, "security-review");
  });
});

describe("next: configured skips", () => {
  it("auditSkips returns configured skip-stage before silently advancing", () => {
    const cwd = track(makeTargetProject({
      config: "pipeline:\n  skip_stages:\n    - design\n",
    }));
    seedGate(cwd, "stage-01", { status: "PASS" });
    const audited = next({ cwd, auditSkips: true });
    assert.equal(audited.action, "skip-stage");
    assert.equal(audited.name, "design");
    assert.equal(audited.skip_kind, "pipeline.skip_stages");
    assert.deepEqual(audited.trigger_inputs, {
      skip_stages: ["design"],
      force_stages: [],
    });

    const quiet = next({ cwd });
    assert.equal(quiet.name, "executable-spec");
  });

  it("force_stages overrides configured skip_stages", () => {
    const cwd = track(makeTargetProject({
      config: "pipeline:\n  skip_stages:\n    - design\n  force_stages:\n    - design\n",
    }));
    seedGate(cwd, "stage-01", { status: "PASS" });
    const r = next({ cwd, auditSkips: true });
    assert.equal(r.action, "run-stage");
    assert.equal(r.name, "design");
  });
});

describe("fix-recipes: gate clear command formatting", () => {
  it("formats gate clears as portable node commands", () => {
    assert.deepEqual(
      formatGateClear(["pipeline/gates/stage-04.json"]),
      ["node -e \"require('node:fs').rmSync(process.argv[1], { force: true })\" pipeline/gates/stage-04.json"],
    );
  });
});

describe("next: stage-04a (pre-review) fix steps", () => {
  function seedThroughBuild(cwd) {
    for (const s of ["stage-01", "stage-02", "stage-03", "stage-03b", "stage-04"]) {
      seedGate(cwd, s, { status: "PASS" });
    }
  }

  it("pre-review FAIL → fix steps include a stage-04a.json clear command", () => {
    const cwd = track(makeTargetProject());
    seedThroughBuild(cwd);
    seedGate(cwd, "stage-04a", {
      status: "FAIL",
      tests_passed: false,
      blockers: [{ id: "B1", summary: "3 failing unit tests", workstream: "backend" }],
    });

    const r = next({ cwd });
    assert.equal(r.action, "fix-and-retry");
    assert.equal(r.name, "pre-review");
    assert.ok(Array.isArray(r.fix_steps) && r.fix_steps.length > 0, "fix_steps present");

    const allCmds = r.fix_steps.flatMap(s => s.commands);
    assert.ok(
      clearsGate(allCmds, "pipeline/gates/stage-04a.json"),
      "fix steps must include a portable clear command for stage-04a.json so driver clears the failing pre-review gate"
    );
    assert.ok(
      allCmds.some(c => c.includes("devteam stage pre-review")),
      "fix steps must re-run pre-review"
    );
    assert.ok(
      allCmds.some(c => c.includes("devteam stage build") && c.includes("--patch") && c.includes("--from pre-review")),
      "fix steps must re-run build with patch context before pre-review"
    );
  });

  it("pre-review FAIL with no blockers → fix steps still include a stage-04a.json clear command", () => {
    const cwd = track(makeTargetProject());
    seedThroughBuild(cwd);
    seedGate(cwd, "stage-04a", { status: "FAIL" });

    const r = next({ cwd });
    assert.equal(r.action, "fix-and-retry");
    const allCmds = r.fix_steps.flatMap(s => s.commands);
    assert.ok(
      clearsGate(allCmds, "pipeline/gates/stage-04a.json"),
      "stage-04a.json clear command present even with no blockers"
    );
  });
});

describe("next: stage-04c (red-team) fix steps", () => {
  function seedThroughPreReview(cwd) {
    for (const s of ["stage-01", "stage-02", "stage-03", "stage-03b", "stage-04", "stage-04a"]) {
      seedGate(cwd, s, { status: "PASS" });
    }
  }

  it("red-team FAIL with workstream-less blockers → fix steps include a stage-04c.json clear command", () => {
    const cwd = track(makeTargetProject());
    seedThroughPreReview(cwd);
    // Blockers with file paths not matched by _wsFromText heuristics (e.g. src/collectors/)
    seedGate(cwd, "stage-04c", {
      status: "FAIL",
      must_address_before_peer_review: [
        { id: "RT-01", severity: "high", file: "src/collectors/aws-cloudtrail.js", summary: "Unbounded event accumulation — OOM risk" },
        { id: "RT-02", severity: "high", file: "src/grader/grader.js", summary: "Multi-source controls report false PASS" },
      ],
      blockers: [
        { id: "RT-01", severity: "high", file: "src/collectors/aws-cloudtrail.js", summary: "Unbounded event accumulation — OOM risk" },
      ],
    });

    const r = next({ cwd });
    assert.equal(r.action, "fix-and-retry");
    assert.equal(r.name, "red-team");
    assert.ok(Array.isArray(r.fix_steps) && r.fix_steps.length > 0, "fix_steps present");

    const allCmds = r.fix_steps.flatMap(s => s.commands);
    assert.ok(
      clearsGate(allCmds, "pipeline/gates/stage-04c.json"),
      "fix steps must include a portable clear command for stage-04c.json so driver clears the failing red-team gate"
    );
    assert.ok(
      allCmds.some(c => c.includes("devteam stage red-team")),
      "fix steps must re-run red-team"
    );
    // When wsSet is empty and no gate files on disk, must not emit <affected-ws> placeholder
    assert.ok(
      !allCmds.some(c => c.includes("<affected-ws>")),
      "fix steps must not emit unresolvable <affected-ws> placeholder"
    );
    assert.ok(
      allCmds.some(c => c.includes("devteam stage build") && c.includes("--patch") && c.includes("--from red-team")),
      "fix steps must re-run build with red-team context"
    );
  });

  it("red-team FAIL, disk scan finds build gates → fix steps include a stage-04.json clear command", () => {
    const cwd = track(makeTargetProject());
    seedThroughPreReview(cwd);
    // Seed build workstream gates on disk so the disk scan finds them (wsSet is empty
    // because the blocker file paths don't match _wsFromText heuristics)
    for (const ws of ["backend", "frontend", "platform", "qa"]) {
      seedGate(cwd, `stage-04.${ws}`, { workstream: ws, status: "PASS" });
    }
    seedGate(cwd, "stage-04", { status: "PASS" }); // merged gate
    seedGate(cwd, "stage-04c", {
      status: "FAIL",
      must_address_before_peer_review: [
        { id: "F-01", severity: "high", file: "src/evidence/hasher.js", summary: "Array-replacer strips nested props from hash" },
      ],
      blockers: [
        { id: "F-01", severity: "high", file: "src/evidence/hasher.js", summary: "Array-replacer strips nested props from hash" },
      ],
    });

    const r = next({ cwd });
    assert.equal(r.action, "fix-and-retry");
    assert.equal(r.name, "red-team");

    const allCmds = r.fix_steps.flatMap(s => s.commands);
    assert.ok(
      clearsGate(allCmds, "pipeline/gates/stage-04.json"),
      "fix steps must include a portable clear command for stage-04.json (merged) so driver clears it and next() dispatches build"
    );
    assert.ok(
      clearsGate(allCmds, "pipeline/gates/stage-04c.json"),
      "fix steps must include a portable clear command for stage-04c.json"
    );
    assert.ok(
      !allCmds.some(c => c.includes("<affected-ws>")),
      "no unresolvable placeholder"
    );
  });

  it("red-team FAIL with assigned_to blockers → fix steps clear the named workstream gates", () => {
    const cwd = track(makeTargetProject());
    seedThroughPreReview(cwd);
    seedGate(cwd, "stage-04c", {
      status: "FAIL",
      blockers: [
        { id: "RT-01", severity: "high", summary: "Auth bypass", assigned_to: "backend" },
      ],
    });
    // Seed the actual build workstream gate so disk scan has something to find
    seedGate(cwd, "stage-04.backend", { workstream: "backend", status: "PASS" });

    const r = next({ cwd });
    assert.equal(r.action, "fix-and-retry");
    const allCmds = r.fix_steps.flatMap(s => s.commands);
    assert.ok(
      clearsGate(allCmds, "pipeline/gates/stage-04.backend.json"),
      "fix steps include a portable clear command for the assigned_to workstream"
    );
    assert.ok(
      clearsGate(allCmds, "pipeline/gates/stage-04c.json"),
      "fix steps include a portable clear command for stage-04c.json"
    );
    assert.ok(
      !allCmds.some(c => c.includes("<affected-ws>")),
      "no placeholder in output"
    );
  });
});

// Regression: a real run had security-review (stage-04b) FAIL with
// affected_workstreams set (per rules/gates-core.md's general FAIL-gate
// convention) but no registered fix recipe — DEFAULT_DIAGNOSE cleared
// nothing, so next() never actually re-dispatched the review. The driver's
// own fix-and-retry bookkeeping (core/driver.js) still counted a "retry" and
// archived the untouched gate a second time; two archives of one real
// dispatch then read as identical, and detectNoProgress() escalated as
// "no-progress convergence ... 2 blockers identical across attempts 1,2"
// after exactly one genuine agent call. See core/pipeline/fix-recipes.js.
describe("next: stage-04b (security-review) fix steps", () => {
  function seedThroughPreReview(cwd) {
    for (const s of ["stage-01", "stage-02", "stage-03", "stage-03b", "stage-04"]) {
      seedGate(cwd, s, { status: "PASS" });
    }
    seedGate(cwd, "stage-04a", { status: "PASS", security_review_required: true });
  }

  it("security-review FAIL with affected_workstreams → fix steps clear the named build gates and re-run security-review", () => {
    const cwd = track(makeTargetProject());
    seedThroughPreReview(cwd);
    seedGate(cwd, "stage-04b", {
      status: "FAIL",
      security_approved: false,
      affected_workstreams: ["backend", "frontend", "platform"],
      blockers: [
        "The running HTTP server serves an outdated inline UI instead of the reviewed src/frontend assets.",
        "POST /generate has no documented trusted-network restriction, authentication boundary, rate limiting, or concurrency/budget control.",
      ],
    });

    const r = next({ cwd });
    assert.equal(r.action, "fix-and-retry");
    assert.equal(r.name, "security-review");
    assert.ok(Array.isArray(r.fix_steps) && r.fix_steps.length > 0, "fix_steps present");
    assert.ok(
      Array.isArray(r.clear_gates) && r.clear_gates.length > 0,
      "clear_gates present — an empty list here is the regression: next() would never re-dispatch the review"
    );

    const allCmds = r.fix_steps.flatMap(s => s.commands);
    for (const ws of ["backend", "frontend", "platform"]) {
      assert.ok(
        clearsGate(allCmds, `pipeline/gates/stage-04.${ws}.json`),
        `fix steps must clear the ${ws} build workstream gate named in affected_workstreams`
      );
    }
    assert.ok(
      clearsGate(allCmds, "pipeline/gates/stage-04b.json"),
      "fix steps must clear stage-04b.json itself so the review actually re-dispatches on retry"
    );
    assert.ok(
      allCmds.some(c => c.includes("devteam stage security-review")),
      "fix steps must re-run security-review"
    );
    assert.ok(
      allCmds.some(c => c.includes("devteam stage build") && c.includes("--patch") && c.includes("--from security-review")),
      "fix steps must re-run build with security-review's blockers as context"
    );
  });

  it("security-review FAIL with no affected_workstreams, disk scan finds build gates → fix steps clear them", () => {
    const cwd = track(makeTargetProject());
    seedThroughPreReview(cwd);
    for (const ws of ["backend", "frontend", "platform", "qa"]) {
      seedGate(cwd, `stage-04.${ws}`, { workstream: ws, status: "PASS" });
    }
    seedGate(cwd, "stage-04b", {
      status: "FAIL",
      security_approved: false,
      blockers: ["Some free-text finding with no workstream attribution"],
    });

    const r = next({ cwd });
    assert.equal(r.action, "fix-and-retry");
    const allCmds = r.fix_steps.flatMap(s => s.commands);
    assert.ok(
      clearsGate(allCmds, "pipeline/gates/stage-04.backend.json"),
      "disk scan finds the backend build gate when affected_workstreams is absent"
    );
    assert.ok(
      clearsGate(allCmds, "pipeline/gates/stage-04b.json"),
      "fix steps must clear stage-04b.json itself"
    );
  });
});

describe("next: stage-04d (migration-safety) fix steps", () => {
  function seedThroughRedTeam(cwd) {
    for (const s of ["stage-01", "stage-02", "stage-03", "stage-03b", "stage-04", "stage-04c"]) {
      seedGate(cwd, s, { status: "PASS" });
    }
    seedGate(cwd, "stage-04a", { status: "PASS", migration_safety_required: true });
  }

  it("migration-safety FAIL with affected_workstreams → fix steps clear the named build gate and re-run migration-safety", () => {
    const cwd = track(makeTargetProject());
    seedThroughRedTeam(cwd);
    seedGate(cwd, "stage-04d", {
      status: "FAIL",
      affected_workstreams: ["backend"],
      blockers: ["Migration script drops a column with no backward-compatible fallback."],
    });

    const r = next({ cwd });
    assert.equal(r.action, "fix-and-retry");
    assert.equal(r.name, "migration-safety");
    const allCmds = r.fix_steps.flatMap(s => s.commands);
    assert.ok(
      clearsGate(allCmds, "pipeline/gates/stage-04.backend.json"),
      "fix steps must clear the backend build workstream gate named in affected_workstreams"
    );
    assert.ok(
      clearsGate(allCmds, "pipeline/gates/stage-04d.json"),
      "fix steps must clear stage-04d.json itself so migration-safety actually re-dispatches on retry"
    );
    assert.ok(
      allCmds.some(c => c.includes("devteam stage migration-safety")),
      "fix steps must re-run migration-safety"
    );
    assert.ok(
      allCmds.some(c => c.includes("devteam stage build") && c.includes("--patch") && c.includes("--from migration-safety")),
      "fix steps must re-run build with migration-safety's blockers as context"
    );
  });
});

describe("next: malformed gate handling", () => {
  it("returns fix-and-retry with a clear error when a stage gate is malformed", () => {
    const cwd = track(makeTargetProject());
    const fs = require("node:fs");
    const gatePath = path.join(cwd, "pipeline", "gates", "stage-01.json");
    fs.writeFileSync(gatePath, '{"stage":"stage-01","status":"PA', "utf8"); // truncated mid-emit
    const r = next({ cwd });
    assert.equal(r.action, "fix-and-retry");
    assert.equal(r.name, "requirements");
    assert.ok(Array.isArray(r.blockers) && r.blockers.length > 0, "blockers populated");
    assert.match(r.blockers[0], /unreadable|malformed/i);
  });
});

describe("next: failure classification (H1)", () => {
  it("FAIL gate → failure_class code-defect", () => {
    const cwd = track(makeTargetProject());
    seedGate(cwd, "stage-01", { status: "FAIL", blockers: ["bad criterion"] });
    const r = next({ cwd });
    assert.equal(r.action, "fix-and-retry");
    assert.equal(r.failure_class, "code-defect");
  });

  it("ESCALATE gate → failure_class judgment-gate", () => {
    const cwd = track(makeTargetProject());
    seedGate(cwd, "stage-01", { status: "ESCALATE", escalation_reason: "ambiguous spec" });
    const r = next({ cwd });
    assert.equal(r.action, "resolve-escalation");
    assert.equal(r.failure_class, "judgment-gate");
  });

  it("malformed gate → failure_class state-corruption", () => {
    const cwd = track(makeTargetProject());
    const fs = require("node:fs");
    fs.writeFileSync(
      path.join(cwd, "pipeline", "gates", "stage-01.json"),
      '{"stage":"stage-01","status":"FA', "utf8",
    );
    const r = next({ cwd });
    assert.equal(r.action, "fix-and-retry");
    assert.equal(r.failure_class, "state-corruption");
  });

  it("PASS/WARN actions carry no failure_class", () => {
    const cwd = track(makeTargetProject());
    seedGate(cwd, "stage-01", { status: "PASS" });
    const r = next({ cwd }); // → run-stage design
    assert.equal(r.action, "run-stage");
    assert.equal(r.failure_class, undefined);
  });
});

// Helper: write an archive gate directly into pipeline/gates/archive/.
function seedNextArchive(cwd, stageId, attempt, gate) {
  const dir = path.join(cwd, "pipeline", "gates", "archive");
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(
    path.join(dir, `${stageId}.attempt-${attempt}.json`),
    JSON.stringify({ stage: stageId, blockers: [], ...gate }, null, 2),
  );
}

describe("next: convergence ceiling (H1 + 4.2 progress-based)", () => {
  it("FAIL with no archives (no prior retries) → still fix-and-retry", () => {
    // archive count = 0, well below default ceiling of 2; no progress comparison possible.
    const cwd = track(makeTargetProject());
    seedGate(cwd, "stage-01", { status: "FAIL", blockers: ["x"] });
    const r = next({ cwd });
    assert.equal(r.action, "fix-and-retry");
    assert.equal(r.failure_class, "code-defect");
  });

  it("FAIL at the archive-count ceiling (2 archives, default max_retries=2) → resolve-escalation", () => {
    // Uses archive count (agent-independent) instead of model-written retry_number.
    // Two archives with DIFFERENT blockers → progress was made, so progress check
    // does not trip; the count ceiling is what escalates.
    const cwd = track(makeTargetProject());
    seedNextArchive(cwd, "stage-01", 1, { blockers: ["original"] });
    seedNextArchive(cwd, "stage-01", 2, { blockers: ["improved"] }); // different → progress made
    seedGate(cwd, "stage-01", { status: "FAIL", blockers: ["improved"] });
    const r = next({ cwd });
    assert.equal(r.action, "resolve-escalation");
    assert.equal(r.failure_class, "convergence-exhausted");
    assert.match(r.reason, /retry budget exhausted/i);
    assert.ok(!r.no_progress_evidence, "evidence absent — breaker tripped by count, not by stuck blockers");
  });

  it("respects autonomy.max_retries override from config (max_retries=0)", () => {
    // archive count 0 >= ceiling 0 → escalate on first FAIL with no prior retries.
    const cwd = track(makeTargetProject({
      config: "routing:\n  default_host: generic\npipeline:\n  default_track: full\nautonomy:\n  max_retries: 0\n",
    }));
    seedGate(cwd, "stage-01", { status: "FAIL", blockers: ["x"] });
    const r = next({ cwd });
    assert.equal(r.action, "resolve-escalation");
    assert.equal(r.failure_class, "convergence-exhausted");
  });

  it("falsified gate.retry_number is ignored — archive count is authoritative", () => {
    // Agent writes retry_number: 99 to try to exhaust the ceiling, but the real
    // archive count is 0 (no retries have happened) → next() still returns fix-and-retry.
    const cwd = track(makeTargetProject());
    seedGate(cwd, "stage-01", { status: "FAIL", blockers: ["x"], retry_number: 99, this_attempt_differs_by: "lied" });
    const r = next({ cwd });
    assert.equal(r.action, "fix-and-retry", "falsified retry_number must not trigger escalation");
    assert.equal(r.failure_class, "code-defect");
  });

  it("progress-based breaker trips when blockers are identical across last two archives", () => {
    const cwd = track(makeTargetProject());
    seedNextArchive(cwd, "stage-01", 1, { blockers: ["stuck blocker"] });
    seedNextArchive(cwd, "stage-01", 2, { blockers: ["stuck blocker"] }); // identical!
    seedGate(cwd, "stage-01", { status: "FAIL", blockers: ["stuck blocker"] });
    const r = next({ cwd });
    assert.equal(r.action, "resolve-escalation");
    assert.equal(r.failure_class, "convergence-exhausted");
    assert.ok(r.no_progress_evidence, "no_progress_evidence must be present");
    assert.match(r.no_progress_evidence, /stuck blocker/);
    assert.match(r.no_progress_evidence, /1,2/); // attempt numbers
    assert.match(r.reason, /no-progress convergence/i);
  });

  it("progress-based breaker does not trip when blockers differ across archives", () => {
    // Even if archiveCount < ceiling, progress was made → fix-and-retry.
    const cwd = track(makeTargetProject());
    seedNextArchive(cwd, "stage-01", 1, { blockers: ["original"] });
    seedNextArchive(cwd, "stage-01", 2, { blockers: ["different"] }); // progress!
    seedGate(cwd, "stage-01", { status: "FAIL", blockers: ["different"] });
    // archiveCount=2 >= maxRetries(2) → count ceiling trips (not progress check)
    // To test JUST the no-trip case, use 1 archive with below-ceiling count:
    const cwd2 = track(makeTargetProject());
    seedNextArchive(cwd2, "stage-01", 1, { blockers: ["original"] });
    seedGate(cwd2, "stage-01", { status: "FAIL", blockers: ["changed"] });
    // archiveCount=1 < 2, and no two archives to compare → fix-and-retry
    const r = next({ cwd: cwd2 });
    assert.equal(r.action, "fix-and-retry");
    assert.ok(!r.no_progress_evidence);
  });
});

// Regression: stage-04 (build) dispatches backend/frontend/platform/qa in
// parallel against a shared (non-worktree-isolated) checkout by default. qa
// typically finishes fastest since its job is to test what its siblings
// produce, so it can legitimately race ahead and FAIL/ESCALATE against a
// checkout backend/frontend/platform haven't finished writing to yet. A real
// run hit exactly this: qa escalated blaming backend/frontend/platform for
// missing implementation files, backend and platform went on to PASS 25
// minutes later, but a `continue-stage` resume with --skip-completed treated
// qa's stale gate as done purely because the file existed — the escalation
// rode along into the merged gate even though the workstreams it blamed had
// since passed. These tests cover the fix: a workstream only counts as
// "completed" when its gate is PASS/WARN, and a FAIL/ESCALATE workstream gets
// re-dispatched (within its own convergence ceiling) rather than treated as
// terminal.
describe("next: multi-role workstream FAIL/ESCALATE is not treated as completed (stale-gate resume)", () => {
  it("qa ESCALATE with siblings PASS → continue-stage, qa in remaining not completed", () => {
    const cwd = track(makeTargetProject());
    for (const s of ["stage-01", "stage-02", "stage-03", "stage-03b"]) {
      seedGate(cwd, s, { status: "PASS" });
    }
    seedGate(cwd, "stage-04.backend", { workstream: "backend", host: "claude-code", status: "PASS" });
    seedGate(cwd, "stage-04.frontend", { workstream: "frontend", host: "claude-code", status: "PASS" });
    seedGate(cwd, "stage-04.platform", { workstream: "platform", host: "claude-code", status: "PASS" });
    seedGate(cwd, "stage-04.qa", {
      workstream: "qa", host: "claude-code", status: "ESCALATE",
      blockers: ["The checkout contains no package.json, src/, ... so QA cannot author or execute tests."],
      escalation_reason: "Implementation-owned inputs from backend, frontend, and platform are absent.",
    });
    const r = next({ cwd });
    assert.equal(r.action, "continue-stage");
    assert.deepEqual(r.completed.sort(), ["backend", "frontend", "platform"]);
    assert.deepEqual(r.remaining, ["qa"]);
  });

  it("frontend FAIL (orchestrator-verified npm test failure) with siblings PASS → continue-stage, frontend in remaining", () => {
    const cwd = track(makeTargetProject());
    for (const s of ["stage-01", "stage-02", "stage-03", "stage-03b"]) {
      seedGate(cwd, s, { status: "PASS" });
    }
    seedGate(cwd, "stage-04.backend", { workstream: "backend", host: "claude-code", status: "PASS" });
    seedGate(cwd, "stage-04.platform", { workstream: "platform", host: "claude-code", status: "PASS" });
    seedGate(cwd, "stage-04.qa", { workstream: "qa", host: "claude-code", status: "PASS" });
    seedGate(cwd, "stage-04.frontend", {
      workstream: "frontend", host: "claude-code", status: "FAIL",
      blockers: ["test command failed [node] (exit 1): npm test"],
    });
    const r = next({ cwd });
    assert.equal(r.action, "continue-stage");
    assert.deepEqual(r.completed.sort(), ["backend", "platform", "qa"]);
    assert.deepEqual(r.remaining, ["frontend"]);
  });

  it("below the per-workstream ceiling, a FAIL/ESCALATE workstream still gets one more chance (continue-stage), not immediate escalation", () => {
    const cwd = track(makeTargetProject());
    for (const s of ["stage-01", "stage-02", "stage-03", "stage-03b"]) {
      seedGate(cwd, s, { status: "PASS" });
    }
    seedGate(cwd, "stage-04.backend", { workstream: "backend", host: "claude-code", status: "PASS" });
    seedGate(cwd, "stage-04.frontend", { workstream: "frontend", host: "claude-code", status: "PASS" });
    seedGate(cwd, "stage-04.platform", { workstream: "platform", host: "claude-code", status: "PASS" });
    // One prior archived attempt (below default max_retries=2), no repeat
    // blockers to compare against yet → no-progress check can't trip either.
    seedNextArchive(cwd, "stage-04.qa", 1, { blockers: ["original qa blocker"] });
    seedGate(cwd, "stage-04.qa", { workstream: "qa", host: "claude-code", status: "FAIL", blockers: ["different qa blocker"] });
    const r = next({ cwd });
    assert.equal(r.action, "continue-stage");
    assert.deepEqual(r.remaining, ["qa"]);
  });

  it("per-workstream convergence ceiling: archive count at max_retries → resolve-escalation scoped to that workstream", () => {
    const cwd = track(makeTargetProject());
    for (const s of ["stage-01", "stage-02", "stage-03", "stage-03b"]) {
      seedGate(cwd, s, { status: "PASS" });
    }
    seedGate(cwd, "stage-04.backend", { workstream: "backend", host: "claude-code", status: "PASS" });
    seedGate(cwd, "stage-04.frontend", { workstream: "frontend", host: "claude-code", status: "PASS" });
    seedGate(cwd, "stage-04.platform", { workstream: "platform", host: "claude-code", status: "PASS" });
    // Two archives with different blockers → progress was made, so the
    // no-progress breaker does not trip; the count ceiling is what escalates.
    seedNextArchive(cwd, "stage-04.qa", 1, { blockers: ["original"] });
    seedNextArchive(cwd, "stage-04.qa", 2, { blockers: ["improved"] });
    seedGate(cwd, "stage-04.qa", { workstream: "qa", host: "claude-code", status: "FAIL", blockers: ["improved"] });
    const r = next({ cwd });
    assert.equal(r.action, "resolve-escalation");
    assert.equal(r.failure_class, "convergence-exhausted");
    assert.match(r.reason, /qa/);
    assert.match(r.reason, /retry budget exhausted/i);
    assert.match(r.gate, /stage-04\.qa\.json$/);
  });

  it("per-workstream convergence ceiling: identical blockers across last two archives (no-progress) → resolve-escalation even below count ceiling", () => {
    const cwd = track(makeTargetProject());
    for (const s of ["stage-01", "stage-02", "stage-03", "stage-03b"]) {
      seedGate(cwd, s, { status: "PASS" });
    }
    seedGate(cwd, "stage-04.backend", { workstream: "backend", host: "claude-code", status: "PASS" });
    seedGate(cwd, "stage-04.frontend", { workstream: "frontend", host: "claude-code", status: "PASS" });
    seedGate(cwd, "stage-04.platform", { workstream: "platform", host: "claude-code", status: "PASS" });
    seedNextArchive(cwd, "stage-04.qa", 1, { blockers: ["stuck qa blocker"] });
    seedNextArchive(cwd, "stage-04.qa", 2, { blockers: ["stuck qa blocker"] }); // identical!
    seedGate(cwd, "stage-04.qa", { workstream: "qa", host: "claude-code", status: "ESCALATE", blockers: ["stuck qa blocker"] });
    const r = next({ cwd });
    assert.equal(r.action, "resolve-escalation");
    assert.equal(r.failure_class, "convergence-exhausted");
    assert.ok(r.no_progress_evidence, "no_progress_evidence must be present");
    assert.match(r.no_progress_evidence, /stuck qa blocker/);
    assert.match(r.reason, /qa/);
    assert.match(r.reason, /no-progress convergence/i);
    assert.match(r.gate, /stage-04\.qa\.json$/);
  });

  it("a stuck workstream does not block a sibling that has already recovered — only the stuck role's gate path is escalated", () => {
    // backend is PASS (recovered); qa is the one at the no-progress ceiling.
    // The escalation must be scoped to qa's own gate, not the merged stage
    // gate or backend's gate.
    const cwd = track(makeTargetProject());
    for (const s of ["stage-01", "stage-02", "stage-03", "stage-03b"]) {
      seedGate(cwd, s, { status: "PASS" });
    }
    seedGate(cwd, "stage-04.backend", { workstream: "backend", host: "claude-code", status: "PASS" });
    seedGate(cwd, "stage-04.platform", { workstream: "platform", host: "claude-code", status: "PASS" });
    seedGate(cwd, "stage-04.frontend", { workstream: "frontend", host: "claude-code", status: "PASS" });
    seedNextArchive(cwd, "stage-04.qa", 1, { blockers: ["stuck"] });
    seedNextArchive(cwd, "stage-04.qa", 2, { blockers: ["stuck"] });
    seedGate(cwd, "stage-04.qa", { workstream: "qa", host: "claude-code", status: "FAIL", blockers: ["stuck"] });
    const r = next({ cwd });
    assert.equal(r.action, "resolve-escalation");
    assert.match(r.gate, /stage-04\.qa\.json$/);
    assert.doesNotMatch(r.gate, /backend|platform|frontend/);
  });
});

// review-only and review-pr have no build stage — retrying *any* of their
// stages can never change the (unchanged, un-owned) code under review, so a
// FAIL is terminal for every stage in these tracks, not just peer-review.
// Every other track keeps the normal fix-and-retry/resolve-escalation
// behavior (asserted below via "full") since they have a build stage each
// stage's feedback can act on.
describe("next: peer-review FAIL in a track with no build stage is terminal, not escalated", () => {
  it("review-only: stage-05 FAIL → pipeline-complete, not resolve-escalation", () => {
    const cwd = track(makeTargetProject());
    seedGate(cwd, "stage-04b", { status: "PASS" }); // security-review
    seedGate(cwd, "stage-04c", { status: "PASS" }); // red-team
    seedGate(cwd, "stage-05", { status: "FAIL", blockers: ["backend not approved"] });
    const r = next({ cwd, track: "review-only" });
    assert.equal(r.action, "pipeline-complete");
    assert.match(r.reason, /no stage requires further action/);
  });

  it("review-only: stage-05 status ESCALATE (a reviewer wrote it directly, propagated by mergeWorkstreamGates) → also pipeline-complete", () => {
    // The real-world case: an individual reviewer that recognizes
    // non-convergence writes ESCALATE into its own workstream gate rather
    // than a plain FAIL — mergeWorkstreamGates propagates that to the merged
    // gate's status (any ESCALATE among the workstreams wins). Same
    // situation as a plain FAIL here, same terminal treatment.
    const cwd = track(makeTargetProject());
    seedGate(cwd, "stage-04b", { status: "PASS" });
    seedGate(cwd, "stage-04c", { status: "PASS" });
    seedGate(cwd, "stage-05", {
      status: "ESCALATE",
      blockers: ["backend not approved"],
      escalation_reason: "driver retry budget exhausted for \"peer-review\" (2/2); escalating",
    });
    const r = next({ cwd, track: "review-only" });
    assert.equal(r.action, "pipeline-complete");
  });

  it("review-only: still terminal even past the retry-budget archive count — never reaches resolve-escalation either way", () => {
    const cwd = track(makeTargetProject());
    seedGate(cwd, "stage-04b", { status: "PASS" });
    seedGate(cwd, "stage-04c", { status: "PASS" });
    seedNextArchive(cwd, "stage-05", 1, { blockers: ["backend not approved"] });
    seedNextArchive(cwd, "stage-05", 2, { blockers: ["backend not approved"] });
    seedGate(cwd, "stage-05", { status: "FAIL", blockers: ["backend not approved"] });
    const r = next({ cwd, track: "review-only" });
    assert.equal(r.action, "pipeline-complete");
  });

  it("review-pr: single-stage track, stage-05 FAIL → pipeline-complete", () => {
    const cwd = track(makeTargetProject());
    seedGate(cwd, "stage-05", { status: "FAIL", blockers: ["reviewer disagreement"] });
    const r = next({ cwd, track: "review-pr" });
    assert.equal(r.action, "pipeline-complete");
  });

  it("the gate file itself is untouched — still genuinely FAIL for a direct reader like devteam validate", () => {
    const cwd = track(makeTargetProject());
    seedGate(cwd, "stage-04b", { status: "PASS" });
    seedGate(cwd, "stage-04c", { status: "PASS" });
    const gatePath = seedGate(cwd, "stage-05", { status: "FAIL", blockers: ["backend not approved"] });
    next({ cwd, track: "review-only" });
    const onDisk = JSON.parse(fs.readFileSync(gatePath, "utf8"));
    assert.equal(onDisk.status, "FAIL");
    assert.deepEqual(onDisk.blockers, ["backend not approved"]);
  });

  it("full track (has a build stage): the same stage-05 FAIL still fix-and-retries / escalates as before — this fix does not change normal build-workflow tracks", () => {
    const cwd = track(makeTargetProject());
    for (const s of ["stage-01", "stage-02", "stage-03", "stage-03b", "stage-04", "stage-04a", "stage-04b", "stage-04c", "stage-04d"]) {
      seedGate(cwd, s, { status: "PASS" });
    }
    seedGate(cwd, "stage-05", { status: "FAIL", blockers: ["x"] });
    const r = next({ cwd, track: "full" });
    assert.equal(r.action, "fix-and-retry");

    const cwd2 = track(makeTargetProject());
    for (const s of ["stage-01", "stage-02", "stage-03", "stage-03b", "stage-04", "stage-04a", "stage-04b", "stage-04c", "stage-04d"]) {
      seedGate(cwd2, s, { status: "PASS" });
    }
    seedNextArchive(cwd2, "stage-05", 1, { blockers: ["x"] });
    seedNextArchive(cwd2, "stage-05", 2, { blockers: ["x"] });
    seedGate(cwd2, "stage-05", { status: "FAIL", blockers: ["x"] });
    const r2 = next({ cwd: cwd2, track: "full" });
    assert.equal(r2.action, "resolve-escalation");
    assert.equal(r2.failure_class, "convergence-exhausted");

    const cwd3 = track(makeTargetProject());
    for (const s of ["stage-01", "stage-02", "stage-03", "stage-03b", "stage-04", "stage-04a", "stage-04b", "stage-04c", "stage-04d"]) {
      seedGate(cwd3, s, { status: "PASS" });
    }
    seedGate(cwd3, "stage-05", { status: "ESCALATE", blockers: ["x"], escalation_reason: "judgment call" });
    const r3 = next({ cwd: cwd3, track: "full" });
    assert.equal(r3.action, "resolve-escalation");
    assert.equal(r3.failure_class, "judgment-gate");
  });

  // Regression: a real `devteam review` run against an external repo hit
  // this exact wall on red-team (stage-04c), not peer-review — the earlier
  // version of this fix checked `stageDef.stage === "stage-05"` specifically
  // and missed every other stage in review-only/review-pr. Same reasoning,
  // same fix, generalized to `!stageList.includes("build")` regardless of
  // which stage hit it.
  it("review-only: stage-04c (red-team) FAIL is terminal too — advances to the next stage instead of resolve-escalation", () => {
    const cwd = track(makeTargetProject());
    seedGate(cwd, "stage-04b", { status: "PASS" }); // security-review
    seedGate(cwd, "stage-04c", { status: "FAIL", blockers: ["RT-01", "RT-02"] }); // red-team
    const r = next({ cwd, track: "review-only" });
    // Not resolve-escalation, and not pipeline-complete either — peer-review
    // (the next stage in the list) hasn't run yet, so next() correctly
    // advances to it rather than declaring the whole pipeline done.
    assert.equal(r.action, "run-stage");
    assert.equal(r.name, "peer-review");
  });

  it("review-only: stage-04c (red-team) ESCALATE — matches the real-world halt message verbatim, same terminal treatment", () => {
    const cwd = track(makeTargetProject());
    seedGate(cwd, "stage-04b", { status: "PASS" });
    seedGate(cwd, "stage-04c", {
      status: "ESCALATE",
      blockers: ["RT-01", "RT-02"],
      escalation_reason: "Same must-fix findings (RT-01, RT-02) failed identically on retry 2 against unchanged source (HEAD still c4ea51e7, git status clean) with no build stage on the review-only track able to apply a fix between dispatches.",
    });
    const r = next({ cwd, track: "review-only" });
    assert.notEqual(r.action, "resolve-escalation");
  });

  it("review-only: stage-04b (security-review) FAIL is also terminal", () => {
    const cwd = track(makeTargetProject());
    seedGate(cwd, "stage-04b", { status: "FAIL", blockers: ["SEC-01"] });
    const r = next({ cwd, track: "review-only" });
    assert.notEqual(r.action, "resolve-escalation");
  });

  it("review-only: red-team terminal + peer-review PASS → pipeline-complete overall", () => {
    const cwd = track(makeTargetProject());
    seedGate(cwd, "stage-04b", { status: "PASS" });
    seedGate(cwd, "stage-04c", { status: "FAIL", blockers: ["RT-01", "RT-02"] });
    seedGate(cwd, "stage-05", { status: "PASS" });
    const r = next({ cwd, track: "review-only" });
    assert.equal(r.action, "pipeline-complete");
  });

  it("full track: red-team FAIL still fix-and-retries as before — the generalization does not change normal build-workflow tracks", () => {
    const cwd = track(makeTargetProject());
    for (const s of ["stage-01", "stage-02", "stage-03", "stage-03b", "stage-04", "stage-04a"]) {
      seedGate(cwd, s, { status: "PASS" });
    }
    seedGate(cwd, "stage-04b", { status: "PASS" });
    seedGate(cwd, "stage-04c", { status: "FAIL", blockers: ["RT-01"] });
    const r = next({ cwd, track: "full" });
    assert.equal(r.action, "fix-and-retry");
  });
});

describe("next --json (H1)", () => {
  it("emits schema_version and carries failure_class through to JSON", () => {
    const cwd = track(makeTargetProject());
    seedGate(cwd, "stage-01", { status: "FAIL", blockers: ["bad criterion"] });
    const { status, stdout } = runCLI(["next", "--json"], { cwd });
    assert.equal(status, 0);
    const obj = JSON.parse(stdout);
    assert.equal(obj.schema_version, "1.2"); // bumped when record-local-deploy action added
    assert.equal(obj.action, "fix-and-retry");
    assert.equal(obj.failure_class, "code-defect");
  });
});

// G3: production feedback seam — pipeline-complete CLI suggestion.
describe("next: pipeline-complete G3 production-feedback suggestion", () => {
  function seedAllStages(cwd) {
    const { orderedStageNamesForTrack, getStage } = require("../core/pipeline/stages");
    for (const name of orderedStageNamesForTrack("full")) {
      const stageId = getStage(name).stage;
      seedGate(cwd, stageId, { status: "PASS" });
    }
  }

  it("emits suggestion when pipeline-complete and production-feedback.md is absent", () => {
    const cwd = track(makeTargetProject());
    seedAllStages(cwd);
    const { status, stdout } = runCLI(["next"], { cwd });
    assert.equal(status, 0);
    assert.ok(stdout.includes("pipeline-complete"), "should be pipeline-complete");
    assert.ok(
      stdout.includes("production-feedback"),
      "should mention production-feedback file when absent",
    );
  });

  it("does not emit suggestion when production-feedback.md is present", () => {
    const cwd = track(makeTargetProject());
    seedAllStages(cwd);
    // Create the production-feedback file so the suggestion is suppressed.
    const fs = require("node:fs");
    const pfDir = require("node:path").join(cwd, "pipeline");
    fs.mkdirSync(pfDir, { recursive: true });
    fs.writeFileSync(require("node:path").join(pfDir, "production-feedback.md"), "# Production Feedback\n");
    const { status, stdout } = runCLI(["next"], { cwd });
    assert.equal(status, 0);
    assert.ok(stdout.includes("pipeline-complete"), "should be pipeline-complete");
    assert.ok(
      !stdout.includes("production-feedback"),
      "should NOT mention production-feedback file when it already exists",
    );
  });
});

describe("next: track filtering", () => {
  it("nano track starts at build (skips requirements/design/clarification)", () => {
    const cwd = track(makeTargetProject({
      config: "routing:\n  default_host: generic\npipeline:\n  default_track: nano\n",
    }));
    const r = next({ cwd });
    assert.equal(r.action, "run-stage");
    assert.equal(r.name, "build");
  });

  it("nano completes after build + peer-review + qa", () => {
    const cwd = track(makeTargetProject({
      config: "routing:\n  default_host: generic\npipeline:\n  default_track: nano\n",
    }));
    seedGate(cwd, "stage-04", { status: "PASS" });
    seedGate(cwd, "stage-05", { status: "PASS" });
    seedGate(cwd, "stage-06", { status: "PASS" });
    const r = next({ cwd });
    assert.equal(r.action, "pipeline-complete");
  });

  it("nano dispatches a single peer-review workstream, not 4", () => {
    const cwd = track(makeTargetProject({
      config: "routing:\n  default_host: generic\npipeline:\n  default_track: nano\n",
    }));
    const { runStage } = require("../core/orchestrator");
    const r = runStage("peer-review", { cwd, track: "nano" });
    assert.equal(r.workstreams.length, 1, "nano peer-review should fan out to 1 workstream");
    assert.equal(r.workstreams[0].role, "backend", "scoped reviewer is the backend slot");
  });

  // Issue #220: next() with explicit track skips full-only stages
  it("quick track skips design (full-only): after requirements PASS → executable-spec", () => {
    const cwd = track(makeTargetProject());
    seedGate(cwd, "stage-01", { status: "PASS" });
    // Without track, full track → next is design (stage-02)
    const rFull = next({ cwd });
    assert.equal(rFull.name, "design", "sanity: full track goes to design after requirements");
    // With quick track → design is not on the track; next is executable-spec (stage-03b)
    const rQuick = next({ cwd, track: "quick" });
    assert.equal(rQuick.action, "run-stage");
    assert.equal(rQuick.name, "executable-spec", "quick track skips design and goes to executable-spec");
  });

  // Issue #220: CLI reads persisted track from run-state.json
  it("devteam next --json reads track from run-state.json when no --track flag", () => {
    const cwd = track(makeTargetProject());
    seedGate(cwd, "stage-01", { status: "PASS" });
    // Persist "quick" as the active track (written by `devteam run --track quick`)
    const rsPath = require("node:path").join(cwd, "pipeline", "run-state.json");
    require("node:fs").writeFileSync(rsPath, JSON.stringify({ track: "quick" }), "utf8");
    const r = runCLI(["next", "--json"], { cwd });
    assert.equal(r.status, 0, `expected exit 0, got ${r.status}\n${r.stderr}`);
    const out = JSON.parse(r.stdout);
    assert.equal(out.action, "run-stage");
    assert.equal(out.name, "executable-spec", "persisted quick track skips design");
  });

  // Issue #220: explicit --track flag overrides persisted run-state.json track
  it("devteam next --track quick overrides full track in run-state.json", () => {
    const cwd = track(makeTargetProject());
    seedGate(cwd, "stage-01", { status: "PASS" });
    // run-state.json says "full" but operator passes --track quick
    const rsPath = require("node:path").join(cwd, "pipeline", "run-state.json");
    require("node:fs").writeFileSync(rsPath, JSON.stringify({ track: "full" }), "utf8");
    const r = runCLI(["next", "--track", "quick", "--json"], { cwd });
    assert.equal(r.status, 0, `expected exit 0, got ${r.status}\n${r.stderr}`);
    const out = JSON.parse(r.stdout);
    assert.equal(out.action, "run-stage");
    assert.equal(out.name, "executable-spec", "--track flag overrides run-state.json");
  });
});

describe("next: stage-05 per-area fix steps", () => {
  function seedPreReviewStages(cwd) {
    for (const s of ["stage-01", "stage-02", "stage-03", "stage-03b", "stage-04", "stage-04a",
                     "stage-04b", "stage-04c", "stage-04d", "stage-04e"]) {
      seedGate(cwd, s, { status: "PASS" });
    }
  }

  it("INSUFFICIENT_APPROVALS area → clear + re-run reviewer commands in fix_steps", () => {
    const cwd = track(makeTargetProject());
    seedPreReviewStages(cwd);
    // platform area: reviewer wrote wrong areas, quorum not reached
    seedGate(cwd, "stage-05.platform", {
      stage: "stage-05", workstream: "platform", status: "FAIL",
      failure_reason: "INSUFFICIENT_APPROVALS",
      approvals: [], required_approvals: 2, changes_requested: [], blockers: [],
    });
    // qa area: same problem
    seedGate(cwd, "stage-05.qa", {
      stage: "stage-05", workstream: "qa", status: "FAIL",
      failure_reason: "INSUFFICIENT_APPROVALS",
      approvals: ["dev-platform"], required_approvals: 2, changes_requested: [], blockers: [],
    });
    // backend area: approved (should be left alone)
    seedGate(cwd, "stage-05.backend", {
      stage: "stage-05", workstream: "backend", status: "PASS",
      approvals: ["dev-backend", "dev-platform"], required_approvals: 2,
    });
    // merged gate: FAIL
    seedGate(cwd, "stage-05", {
      status: "FAIL", changes_requested: [], approvals: [],
    });

    const r = next({ cwd });
    assert.equal(r.action, "fix-and-retry");
    assert.equal(r.name, "peer-review");
    assert.ok(Array.isArray(r.fix_steps) && r.fix_steps.length > 0, "fix_steps present");

    const allCmds = r.fix_steps.flatMap(s => s.commands);
    // Must include clear commands for the incomplete areas
    assert.ok(clearsGate(allCmds, "pipeline/gates/stage-05.platform.json"),
      "clear platform gate");
    assert.ok(clearsGate(allCmds, "pipeline/gates/stage-05.qa.json"),
      "clear qa gate");
    // Must include targeted peer-review re-run commands
    assert.ok(allCmds.some(c => c.includes("devteam stage peer-review --workstream platform")),
      "re-run platform reviewer");
    assert.ok(allCmds.some(c => c.includes("devteam stage peer-review --workstream qa")),
      "re-run qa reviewer");
    // Must include merge step
    assert.ok(allCmds.some(c => c.includes("devteam merge peer-review")), "merge step");
    // Must NOT include generic peer-review command
    assert.ok(!allCmds.some(c => c === "devteam stage peer-review --headless"),
      "no generic peer-review command");
    // Must NOT include a clear command for backend (it passed)
    assert.ok(!allCmds.some(c => c.includes("stage-05.backend.json")),
      "backend gate untouched");
  });

  it("CHANGES_REQUESTED area → build + clear + re-review commands in fix_steps", () => {
    const cwd = track(makeTargetProject());
    seedPreReviewStages(cwd);
    // frontend area: reviewer requested code changes
    seedGate(cwd, "stage-05.frontend", {
      stage: "stage-05", workstream: "frontend", status: "FAIL",
      failure_reason: "CHANGES_REQUESTED",
      approvals: [], required_approvals: 2,
      changes_requested: [{ reviewer: "dev-frontend", timestamp: "2026-06-09T10:00:00Z" }],
      blockers: [{ reviewer: "dev-frontend", text: "missing input validation" }],
    });
    // backend area: passed
    seedGate(cwd, "stage-05.backend", {
      stage: "stage-05", workstream: "backend", status: "PASS",
      approvals: ["dev-backend", "dev-platform"], required_approvals: 2,
    });
    // merged gate
    seedGate(cwd, "stage-05", { status: "FAIL" });

    const r = next({ cwd });
    assert.equal(r.action, "fix-and-retry");
    const allCmds = r.fix_steps.flatMap(s => s.commands);

    // Must include build stage gate clears so the driver backtracks to build
    assert.ok(clearsGate(allCmds, "pipeline/gates/stage-04.frontend.json"),
      "clear build workstream gate — driver must re-enter build to fix the code");
    assert.ok(clearsGate(allCmds, "pipeline/gates/stage-04.json"),
      "clear merged build gate — without this next() still sees build PASS and skips it");
    // Must include build re-run with --patch --from peer-review so the agent implements
    // the required changes rather than just verifying existing code
    assert.ok(allCmds.some(c => c.includes("devteam stage build --workstream frontend") && c.includes("--patch --from peer-review")),
      "rebuild frontend with --patch --from peer-review");
    assert.ok(allCmds.some(c => c.includes("devteam merge build")), "merge build");
    // Must include clear + re-review for the area with changes requested
    assert.ok(clearsGate(allCmds, "pipeline/gates/stage-05.frontend.json"),
      "clear frontend gate");
    assert.ok(allCmds.some(c => c.includes("devteam stage peer-review --workstream frontend")),
      "re-run frontend reviewer");
    assert.ok(allCmds.some(c => c.includes("devteam merge peer-review")), "merge peer-review");
    // Description should mention the blocker text
    const descs = r.fix_steps.map(s => s.description).join(" ");
    assert.ok(descs.includes("missing input validation"), "blocker text in description");
  });

  it("mixed areas (CHANGES_REQUESTED + INSUFFICIENT_APPROVALS) → both sets of commands", () => {
    const cwd = track(makeTargetProject());
    seedPreReviewStages(cwd);
    seedGate(cwd, "stage-05.backend", {
      stage: "stage-05", workstream: "backend", status: "FAIL",
      failure_reason: "CHANGES_REQUESTED",
      approvals: [], required_approvals: 2,
      changes_requested: [{ reviewer: "dev-backend", timestamp: "2026-06-09T10:00:00Z" }],
      blockers: [{ reviewer: "dev-backend", text: "add regression test" }],
    });
    seedGate(cwd, "stage-05.platform", {
      stage: "stage-05", workstream: "platform", status: "FAIL",
      failure_reason: "INSUFFICIENT_APPROVALS",
      approvals: [], required_approvals: 2, changes_requested: [], blockers: [],
    });
    seedGate(cwd, "stage-05", { status: "FAIL" });

    const r = next({ cwd });
    const allCmds = r.fix_steps.flatMap(s => s.commands);

    assert.ok(allCmds.some(c => c.includes("devteam stage build --workstream backend")),
      "rebuild backend");
    assert.ok(clearsGate(allCmds, "pipeline/gates/stage-05.platform.json"),
      "clear platform (incomplete matrix)");
    assert.ok(allCmds.some(c => c.includes("devteam stage peer-review --workstream platform")),
      "re-run platform reviewer");
    assert.ok(clearsGate(allCmds, "pipeline/gates/stage-05.backend.json"),
      "clear backend (changes requested)");
    assert.ok(allCmds.some(c => c.includes("devteam stage peer-review --workstream backend")),
      "re-run backend reviewer");
    assert.ok(allCmds.some(c => c.includes("devteam merge peer-review")), "merge peer-review");
  });

  it("no per-area gates on disk → falls back to merged-gate logic", () => {
    const cwd = track(makeTargetProject());
    seedPreReviewStages(cwd);
    // Only the merged gate exists — no stage-05.*.json files
    seedGate(cwd, "stage-05", {
      status: "FAIL",
      changes_requested: [{ reviewer: "dev-backend", workstream: "backend" }],
      approvals: [], required_approvals: 2,
      blockers: ["missing test coverage"],
    });

    const r = next({ cwd });
    assert.equal(r.action, "fix-and-retry");
    // Falls through to the merged-gate fallback path
    const allCmds = r.fix_steps.flatMap(s => s.commands);
    assert.ok(allCmds.some(c => c.includes("devteam stage peer-review")), "generic fallback present");
  });

  it("some per-area gates missing → fix steps name missing workstream + clear merged gate", () => {
    const cwd = track(makeTargetProject());
    seedPreReviewStages(cwd);
    // backend, platform, qa wrote PASS gates; frontend produced nothing
    seedGate(cwd, "stage-05.backend",  { stage: "stage-05", workstream: "backend",  status: "PASS", approvals: ["dev-platform", "dev-qa"] });
    seedGate(cwd, "stage-05.platform", { stage: "stage-05", workstream: "platform", status: "PASS", approvals: ["dev-backend", "dev-frontend"] });
    seedGate(cwd, "stage-05.qa",       { stage: "stage-05", workstream: "qa",       status: "PASS", approvals: ["dev-backend", "dev-platform"] });
    // stage-05.frontend.json is absent — frontend workstream timed out or crashed
    seedGate(cwd, "stage-05", { status: "FAIL", failure_reason: "INSUFFICIENT_APPROVALS", approvals: [], changes_requested: [] });

    const r = next({ cwd });
    assert.equal(r.action, "fix-and-retry");
    const allCmds = r.fix_steps.flatMap(s => s.commands);
    assert.ok(clearsGate(allCmds, "pipeline/gates/stage-05.json"),
      "clears merged gate so driver triggers continue-stage for missing workstream");
    assert.ok(allCmds.some(c => c.includes("devteam stage peer-review --workstream frontend")),
      "re-run missing frontend reviewer");
    assert.ok(allCmds.some(c => c.includes("devteam merge peer-review")), "re-merge after re-run");
  });

  it("merged gate FAIL with no blockers and no missing gates → surfaces failure_reason", () => {
    const cwd = track(makeTargetProject());
    seedPreReviewStages(cwd);
    // All per-area gates PASS, but merged is FAIL with an exotic failure_reason
    seedGate(cwd, "stage-05.backend",  { stage: "stage-05", workstream: "backend",  status: "PASS", approvals: ["dev-platform"] });
    seedGate(cwd, "stage-05.frontend", { stage: "stage-05", workstream: "frontend", status: "PASS", approvals: ["dev-backend"] });
    seedGate(cwd, "stage-05.platform", { stage: "stage-05", workstream: "platform", status: "PASS", approvals: ["dev-frontend"] });
    seedGate(cwd, "stage-05.qa",       { stage: "stage-05", workstream: "qa",       status: "PASS", approvals: ["dev-backend"] });
    seedGate(cwd, "stage-05", {
      status: "FAIL", failure_reason: "SCHEMA_INVALID",
      changes_requested: [], approvals: [], required_approvals: 0,
    });

    const r = next({ cwd });
    assert.equal(r.action, "fix-and-retry");
    const allCmds = r.fix_steps.flatMap(s => s.commands);
    // Must produce at least a clear + re-merge so the driver can clear and loop
    assert.ok(clearsGate(allCmds, "pipeline/gates/stage-05.json"), "clears merged gate");
    assert.ok(allCmds.some(c => c.includes("devteam merge peer-review")), "re-merge");
    // Description must mention the failure_reason
    const allDescs = r.fix_steps.map(s => s.description).join(" ");
    assert.ok(allDescs.includes("SCHEMA_INVALID"), "surfaces failure_reason in description");
  });
});

describe("next: stage-06b (accessibility-audit) fix steps", () => {
  function seedThroughBuild(cwd) {
    for (const s of ["stage-01", "stage-02", "stage-03", "stage-03b", "stage-04", "stage-04a",
                     "stage-04b", "stage-04c", "stage-04d", "stage-05", "stage-06"]) {
      seedGate(cwd, s, { status: "PASS" });
    }
  }

  it("A11Y items in noted_for_followup → devteam advise --apply <noted-id>=A", () => {
    const cwd = track(makeTargetProject());
    seedThroughBuild(cwd);
    // The build-QA workstream noted accessibility issues in its gate (realistic id pattern).
    seedGate(cwd, "stage-04.qa", {
      workstream: "qa", status: "PASS",
      noted_for_followup: [
        { id: "QA-A11Y-01", summary: "Missing aria-live on #results — accessibility gap", severity: "serious" },
        { id: "QA-A11Y-02", summary: "WCAG 2.1 SC 1.3.1: label missing for= attribute", severity: "moderate" },
      ],
    });
    seedGate(cwd, "stage-06b", { status: "FAIL", blockers: [
      { id: "A11Y-01", element: "#results div", description: "Missing aria-live.", assigned_to: "frontend" },
    ]});

    const r = next({ cwd });
    assert.equal(r.action, "fix-and-retry");
    assert.equal(r.name, "accessibility-audit");
    assert.ok(Array.isArray(r.fix_steps) && r.fix_steps.length > 0, "fix_steps present");

    const allCmds = r.fix_steps.flatMap(s => s.commands);
    // Must use the noted_for_followup IDs (QA-A11Y-*), not the blocker IDs (A11Y-*)
    assert.ok(allCmds.some(c => c.includes("devteam advise --apply")
      && c.includes("QA-A11Y-01=A") && c.includes("QA-A11Y-02=A")),
      "uses noted_for_followup IDs, not blocker IDs");
    assert.ok(!allCmds.some(c => c.includes("A11Y-01=A") && !c.includes("QA-")),
      "does not use raw blocker ID A11Y-01");
    // advise handles gate reset and re-run internally
    assert.ok(!clearsGate(allCmds, "pipeline/gates/stage-06b.json"),
      "no manual gate clear");
    assert.ok(!allCmds.some(c => c.includes("devteam stage accessibility-audit")),
      "no separate re-run");
  });

  it("A11Y blockers with assigned_to: frontend → clear frontend build gate, not backend (#106 regression)", () => {
    // The blocker carries assigned_to: "frontend" — provenance routing must
    // send the fix to the frontend workstream, not the hardcoded backend.
    const cwd = track(makeTargetProject());
    seedThroughBuild(cwd);
    seedGate(cwd, "stage-06b", {
      status: "FAIL",
      blockers: [{ id: "A11Y-01", description: "Missing aria-live.", assigned_to: "frontend" }],
    });
    // No noted_for_followup with A11Y keywords in any prior stage

    const r = next({ cwd });
    assert.equal(r.action, "fix-and-retry");
    // clear_gates must include the frontend build gate (from provenance) and the audit gate
    assert.ok(Array.isArray(r.clear_gates) && r.clear_gates.length > 0, "clear_gates is non-empty");
    assert.ok(r.clear_gates.some(g => g.includes("stage-04.frontend")), "clears frontend build gate (provenance)");
    assert.ok(!r.clear_gates.some(g => g.includes("stage-04.backend")), "does not clear backend (wrong workstream)");
    assert.ok(r.clear_gates.some(g => g.includes("stage-06b")), "clears the audit gate itself");
    const allCmds = r.fix_steps.flatMap(s => s.commands);
    assert.ok(allCmds.some(c => c.includes("--workstream frontend")), "routes to frontend workstream");
    assert.ok(allCmds.some(c => c.includes("accessibility-audit")), "re-runs the audit");
    assert.ok(!allCmds.some(c => c === "devteam advise"), "does not fall back to interactive advise");
  });

  it("cosmetic noted_for_followup in stage-06b itself but not in prior stages → clear-and-redispatch (soc2 scenario)", () => {
    // The accessibility auditor wrote advisory A11Y-NOTE-* items into stage-06b's
    // own noted_for_followup. The actual blockers are color-contrast violations.
    // The recipe must exclude the failing gate's own noted_for_followup (which
    // would match the A11Y regex but cannot be resolved by devteam advise).
    const cwd = track(makeTargetProject());
    seedThroughBuild(cwd);
    seedGate(cwd, "stage-06b", {
      status: "FAIL",
      blockers: [
        "[A11Y-01] Color contrast: .badge-pass — white (#fff) on green (#2d9e45) = 3.45:1, requires 4.5:1 (WCAG 1.4.3 AA).",
        "[A11Y-02] Color contrast: .jn JSON number token — orange (#e06c00) on code background (#f8f8f8) = 3.13:1.",
      ],
      noted_for_followup: [
        { id: "A11Y-NOTE-01", text: "Series disclosure triangles hidden via CSS — consider a ::before affordance.", effort: "XS" },
        { id: "A11Y-NOTE-02", text: "Source status icon spans could use aria-hidden='true'.", effort: "XS" },
      ],
    });

    const r = next({ cwd });
    assert.equal(r.action, "fix-and-retry");
    // Must NOT use the auditor's own advisory IDs via devteam advise
    const allCmds = r.fix_steps.flatMap(s => s.commands);
    assert.ok(!allCmds.some(c => c.includes("A11Y-NOTE-01=A")), "does not apply cosmetic advisory item");
    assert.ok(!allCmds.some(c => c.includes("A11Y-NOTE-02=A")), "does not apply cosmetic advisory item");
    // Must use clear-and-redispatch for the color-contrast blockers.
    // String blockers carry no workstream provenance so the recipe falls back to
    // clearing all build workstream gates (the safe last resort).
    assert.ok(r.clear_gates.some(g => g.includes("stage-04.")), "clears at least one build workstream gate");
    assert.ok(r.clear_gates.some(g => g.includes("stage-06b")), "clears the audit gate");
    assert.ok(allCmds.some(c => c.includes("accessibility-audit") && c.includes("stage build")),
      "re-dispatches build with accessibility-audit context");
  });

  it("multi-workstream A11Y blockers route to each attributed workstream (provenance)", () => {
    // Two blockers: one frontend-owned, one backend-owned.
    // The recipe must clear both workstream gates, not just one.
    const cwd = track(makeTargetProject());
    seedThroughBuild(cwd);
    seedGate(cwd, "stage-06b", {
      status: "FAIL",
      blockers: [
        { id: "A11Y-01", description: "Missing aria-live on modal.", assigned_to: "frontend" },
        { id: "A11Y-02", description: "WCAG contrast: server-rendered badge.", assigned_to: "backend" },
      ],
    });

    const r = next({ cwd });
    assert.equal(r.action, "fix-and-retry");
    assert.ok(r.clear_gates.some(g => g.includes("stage-04.frontend")), "clears frontend gate");
    assert.ok(r.clear_gates.some(g => g.includes("stage-04.backend")), "clears backend gate");
    assert.ok(r.clear_gates.some(g => g.includes("stage-06b")), "clears the audit gate");
    const allCmds = r.fix_steps.flatMap(s => s.commands);
    // Multiple workstreams → general build dispatch (no single --workstream flag)
    assert.ok(allCmds.some(c => c.includes("stage build") && c.includes("accessibility-audit")),
      "dispatches build with accessibility-audit context");
    assert.ok(!allCmds.some(c => c === "devteam advise"), "does not fall back to interactive advise");
  });

  it("no A11Y blockers at all → falls back to plain devteam advise", () => {
    const cwd = track(makeTargetProject());
    seedThroughBuild(cwd);
    // Gate has a non-A11Y blocker (e.g. audit tooling error) and no noted_for_followup
    seedGate(cwd, "stage-06b", {
      status: "FAIL",
      blockers: ["audit tool failed to generate HTML report — check output directory permissions"],
    });

    const r = next({ cwd });
    assert.equal(r.action, "fix-and-retry");
    const allCmds = r.fix_steps.flatMap(s => s.commands);
    assert.ok(allCmds.some(c => c === "devteam advise"), "falls back to plain devteam advise");
    assert.ok(!allCmds.some(c => c.includes("--apply")), "no --apply without noted_for_followup ids");
    assert.ok(!r.clear_gates || r.clear_gates.length === 0, "no clear_gates for non-A11Y failures");
  });
});

describe("next: stage-06c (observability-gate) fix steps", () => {
  function seedThroughQa(cwd) {
    for (const s of ["stage-01", "stage-02", "stage-03", "stage-03b", "stage-04", "stage-04a",
                     "stage-04b", "stage-04c", "stage-04d", "stage-05", "stage-06",
                     "stage-06b"]) {
      seedGate(cwd, s, { status: "PASS" });
    }
  }

  it("backend-owned structured log blocker routes to backend build and re-runs observability", () => {
    const cwd = track(makeTargetProject());
    seedThroughQa(cwd);
    seedGate(cwd, "stage-06c", {
      status: "FAIL",
      blockers: [{
        signal: "estimate_unhandled_exception",
        assigned_to: "backend",
        ref: "pipeline/design-spec.md Observability / Required structured logs",
        note: "No matching structured ERROR log event or exception handler was found in src/backend/main.py.",
      }],
    });

    const r = next({ cwd });
    assert.equal(r.action, "fix-and-retry");
    assert.equal(r.name, "observability-gate");
    assert.ok(Array.isArray(r.clear_gates) && r.clear_gates.length > 0, "clear_gates is non-empty");
    assert.ok(r.clear_gates.some(g => g.includes("stage-04.backend")), "clears backend build gate");
    assert.ok(!r.clear_gates.some(g => g.includes("stage-04.frontend")), "does not clear unrelated frontend gate");
    assert.ok(r.clear_gates.some(g => g.includes("stage-06c")), "clears the observability gate");

    const allCmds = r.fix_steps.flatMap(s => s.commands);
    assert.ok(
      allCmds.some(c => c.includes("devteam stage build --workstream backend")
        && c.includes("--patch")
        && c.includes("--from observability-gate")),
      "routes repair through backend build with observability context"
    );
    assert.ok(allCmds.some(c => c.includes("devteam merge build")), "merges build");
    assert.ok(allCmds.some(c => c.includes("devteam stage observability-gate")), "re-runs observability gate");
  });

  it("unattributed observability blocker clears all build workstreams as a safe fallback", () => {
    const cwd = track(makeTargetProject());
    seedThroughQa(cwd);
    seedGate(cwd, "stage-06c", {
      status: "FAIL",
      blockers: ["Required structured ERROR log event is missing from the exception path."],
    });

    const r = next({ cwd });
    assert.equal(r.action, "fix-and-retry");
    assert.ok(r.clear_gates.some(g => g.includes("stage-04.backend")), "clears backend gate");
    assert.ok(r.clear_gates.some(g => g.includes("stage-04.frontend")), "clears frontend gate");
    assert.ok(r.clear_gates.some(g => g.includes("stage-04.platform")), "clears platform gate");
    assert.ok(r.clear_gates.some(g => g.includes("stage-04.qa")), "clears qa gate");
    assert.ok(r.clear_gates.some(g => g.includes("stage-06c")), "clears the observability gate");

    const allCmds = r.fix_steps.flatMap(s => s.commands);
    assert.ok(
      allCmds.some(c => c.includes("devteam stage build")
        && c.includes("--patch")
        && c.includes("--from observability-gate")
        && !c.includes("--workstream")),
      "dispatches build globally when ownership is unknown"
    );
  });
});

describe("next: stage-06d (verification-beyond-tests) fix steps", () => {
  function seedThroughQa(cwd) {
    for (const s of ["stage-01", "stage-02", "stage-03", "stage-03b", "stage-04", "stage-04a",
                     "stage-04b", "stage-04c", "stage-04d", "stage-05", "stage-06",
                     "stage-06b", "stage-06c"]) {
      seedGate(cwd, s, { status: "PASS" });
    }
  }

  it("blocker with Fix: file path → targeted build + clear gate + re-run commands", () => {
    const cwd = track(makeTargetProject());
    seedThroughQa(cwd);
    seedGate(cwd, "stage-06d", {
      status: "FAIL",
      blockers: [
        "P11: Infinity exchange rate produces cost_cad=Infinity. Fix: src/backend/server.js:10 — change isNaN guard to (isNaN(_rawRate) || !isFinite(_rawRate))",
      ],
    });

    const r = next({ cwd });
    assert.equal(r.action, "fix-and-retry");
    assert.equal(r.name, "verification-beyond-tests");
    assert.ok(Array.isArray(r.fix_steps) && r.fix_steps.length > 0, "fix_steps present");

    const descs = r.fix_steps.map(s => s.description).join(" ");
    const allCmds = r.fix_steps.flatMap(s => s.commands);

    // File path surfaces in description
    assert.ok(descs.includes("src/backend/server.js:10"), "file path in description");
    // Workstream derived from src/backend/ path; must include --patch so build agent implements fix
    assert.ok(
      allCmds.some(c => c.includes("devteam stage build --workstream backend") && c.includes("--patch")),
      "backend build command includes --patch"
    );
    assert.ok(allCmds.some(c => c.includes("devteam merge build")), "merge build");
    // Gate cleared before re-run
    assert.ok(clearsGate(allCmds, "pipeline/gates/stage-06d.json"),
      "clear stage-06d gate");
    assert.ok(allCmds.some(c => c.includes("devteam stage verification-beyond-tests")),
      "re-run verification command");
  });

  it("blocker without Fix: clause → dispatches build globally + re-runs verification", () => {
    const cwd = track(makeTargetProject());
    seedThroughQa(cwd);
    seedGate(cwd, "stage-06d", {
      status: "FAIL",
      blockers: ["Surviving mutant on critical path — manual investigation required"],
    });

    const r = next({ cwd });
    assert.equal(r.action, "fix-and-retry");
    const allCmds = r.fix_steps.flatMap(s => s.commands);
    assert.ok(allCmds.some(c => c.includes("devteam stage verification-beyond-tests")),
      "re-run verification always present");
    // When workstream not identified, driver dispatches build globally with --patch context
    assert.ok(allCmds.some(c => c.includes("devteam stage build") && c.includes("--patch")),
      "build dispatched globally when workstream not identified");
    assert.ok(clearsGate(allCmds, "pipeline/gates/stage-04.json"),
      "merged build gate cleared so next() dispatches build not a merge");
    assert.ok(clearsGate(allCmds, "pipeline/gates/stage-06d.json"),
      "verification gate cleared before re-run");
  });

  it("string blocker with code Fix: clause (not a file path) → dispatches build globally", () => {
    // Real case: F-VER-01 blocker is a string with 'Fix: if (value instanceof Date) ...'
    // FIX_FILE_RE extracts 'if' which is not a file path; _wsFromText finds nothing.
    const cwd = track(makeTargetProject());
    seedThroughQa(cwd);
    seedGate(cwd, "stage-06d", {
      status: "FAIL",
      blockers: [
        "F-VER-01: hash() throws RangeError for new Date(NaN) — sortKeysDeep:11 missing isNaN guard. "
        + "Real path: AWS IAM CreateDate -> invalid Date -> hash() throws -> builder.js:29 -> run() crashes. "
        + "Fix: if (value instanceof Date) return isNaN(value.getTime()) ? null : value.toISOString();",
      ],
    });

    const r = next({ cwd });
    assert.equal(r.action, "fix-and-retry");
    const allCmds = r.fix_steps.flatMap(s => s.commands);
    assert.ok(
      allCmds.some(c => c.includes("devteam stage build") && c.includes("--patch")),
      "build dispatched with --patch so agent implements the fix from context.md"
    );
    assert.ok(
      clearsGate(allCmds, "pipeline/gates/stage-04.json"),
      "merged build gate cleared so next() dispatches build"
    );
    assert.ok(
      clearsGate(allCmds, "pipeline/gates/stage-06d.json"),
      "verification gate cleared"
    );
    assert.ok(
      allCmds.some(c => c.includes("devteam stage verification-beyond-tests")),
      "verification re-run after build"
    );
  });
});

describe("next: structured clear_gates", () => {
  it("registry: every stage in STAGES resolves to a recipe with a diagnose function", () => {
    const { STAGES } = require("../core/pipeline/stages");
    const { getRecipe } = require("../core/pipeline/fix-recipes");
    for (const [name, stageDef] of Object.entries(STAGES)) {
      if (!stageDef) continue;
      const recipe = getRecipe(stageDef.stage);
      assert.ok(recipe, `getRecipe("${stageDef.stage}") must return an object (stage: ${name})`);
      assert.equal(typeof recipe.diagnose, "function",
        `recipe for "${stageDef.stage}" must have a diagnose() function (stage: ${name})`);
      // Smoke-call with a minimal FAIL gate — must not throw.
      const result = recipe.diagnose({ status: "FAIL", blockers: [], workstreams: [] }, { gatesDir: null, stageDef });
      assert.ok(result, `diagnose() for "${stageDef.stage}" must return a result`);
      assert.ok(Array.isArray(result.clear_gates),
        `diagnose() for "${stageDef.stage}" must return clear_gates array`);
    }
  });

  it("next() attaches structured clear_gates on a recipe-bearing FAIL", () => {
    const cwd = track(makeTargetProject());
    for (const s of ["stage-01", "stage-02", "stage-03", "stage-03b"]) seedGate(cwd, s, { status: "PASS" });
    seedGate(cwd, "stage-04", { status: "FAIL", blockers: ["build broke"] });
    const r = next({ cwd });
    assert.equal(r.action, "fix-and-retry");
    assert.equal(r.name, "build");
    assert.ok(Array.isArray(r.clear_gates), "clear_gates present");
    assert.ok(r.clear_gates.includes("pipeline/gates/stage-04.json"),
      `expected stage-04.json in clear_gates, got ${JSON.stringify(r.clear_gates)}`);
  });
});
