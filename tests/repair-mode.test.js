// Tests for --repair intent flag (ADR-009 Phase 1, plan item 10.1).
//
// All subprocess tests mirror CI env (CI=true DEVTEAM_HEADLESS_COMMAND=cat).
// Uses the adapter-contract pattern for PATCH MODE rendering verification.

"use strict";

const { describe, it, afterEach } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { REPO_ROOT, makeTargetProject, cleanup } = require("./_helpers");
const { run } = require(path.join(REPO_ROOT, "core", "driver"));

let _dirs = [];
function track(cwd) { _dirs.push(cwd); return cwd; }
afterEach(() => { _dirs.forEach(cleanup); _dirs = []; });

// ─── 1. Mutual exclusion ─────────────────────────────────────────────────────

describe("repair mode: --repair and --feature are mutually exclusive", () => {
  it("run() with both repair and feature rejects immediately (no dispatch)", async () => {
    const cwd = track(makeTargetProject());
    let dispatched = false;
    const s = await run({
      cwd,
      repair: "auth token not refreshing",
      feature: "add OAuth",
      next: () => { dispatched = true; return { action: "pipeline-complete", reason: "done" }; },
    });
    assert.equal(s.halted, true, "run must be halted");
    assert.equal(s.halt_action, "mutual-exclusion", "halt_action must be mutual-exclusion");
    assert.equal(dispatched, false, "next() must never be called");
  });
});

// ─── 2. Track defaults and overrides ─────────────────────────────────────────

describe("repair mode: track defaults and overrides (ADR-009 §Decision.1)", () => {
  it("--repair without --track defaults to hotfix depth", async () => {
    const cwd = track(makeTargetProject());
    const s = await run({
      cwd,
      repair: "button does not submit form",
      next: () => ({ action: "pipeline-complete", reason: "done" }),
    });
    // Verify hotfix depth via the saved run-state (driver bakes effectiveTrack in at run start).
    const state = JSON.parse(fs.readFileSync(path.join(cwd, "pipeline", "run-state.json"), "utf8"));
    assert.equal(state.track, "hotfix", "default repair track must be hotfix");
    assert.equal(state.intent, "repair", "intent must be 'repair' in run-state");
    assert.equal(s.completed, true);
  });

  it("--repair --track full overrides the hotfix default", async () => {
    const cwd = track(makeTargetProject());
    const s = await run({
      cwd,
      repair: "null pointer deref in checkout",
      track: "full",
      next: () => ({ action: "pipeline-complete", reason: "done" }),
    });
    const state = JSON.parse(fs.readFileSync(path.join(cwd, "pipeline", "run-state.json"), "utf8"));
    assert.equal(state.track, "full", "--repair --track full must store 'full'");
    assert.equal(s.completed, true);
  });
});

// ─── 3. Stoplist upgrade for auth/payments/migration symptoms ─────────────────

describe("repair mode: auth-symptom stoplist upgrade (ADR-009 §Decision.1)", () => {
  it("auth symptom upgrades track from hotfix to full", async () => {
    const cwd = track(makeTargetProject());
    const events = [];
    const s = await run({
      cwd,
      repair: "auth token not refreshing after logout",
      // inject a synthetic stoplist check so the test is hermetic (doesn't read git)
      checkStoplist: ({ description }) => {
        if (/auth/i.test(description)) return [{ name: "authentication", matched: "auth" }];
        return [];
      },
      next: () => ({ action: "pipeline-complete", reason: "done" }),
      onEvent: (ev) => events.push(ev),
    });
    const state = JSON.parse(fs.readFileSync(path.join(cwd, "pipeline", "run-state.json"), "utf8"));
    assert.equal(state.track, "full", "auth symptom must upgrade track to full");
    assert.equal(state.intent, "repair");
    // upgrade event must be emitted
    const upgradeEv = events.find((e) => e.type === "repair-stoplist-upgrade");
    assert.ok(upgradeEv, "repair-stoplist-upgrade event must be emitted");
    assert.equal(upgradeEv.track, "full");
    // run-log must contain the upgrade event
    const log = fs.readFileSync(path.join(cwd, "pipeline", "run-log.jsonl"), "utf8");
    const logEvents = log.trim().split("\n").map((l) => JSON.parse(l));
    const logUpgrade = logEvents.find((e) => e.outcome === "repair-stoplist-upgrade");
    assert.ok(logUpgrade, "run-log must carry repair-stoplist-upgrade outcome");
    assert.equal(logUpgrade.upgraded_to, "full");
    assert.ok(s.completed, "run must complete after upgrade");
  });

  it("non-sensitive symptom does NOT trigger the upgrade", async () => {
    const cwd = track(makeTargetProject());
    const s = await run({
      cwd,
      repair: "button label wraps on mobile",
      checkStoplist: () => [],
      next: () => ({ action: "pipeline-complete", reason: "done" }),
    });
    const state = JSON.parse(fs.readFileSync(path.join(cwd, "pipeline", "run-state.json"), "utf8"));
    assert.equal(state.track, "hotfix", "non-sensitive symptom must keep hotfix track");
    assert.ok(s.completed);
  });
});

// ─── 4. Intent tag in run-state and run-log ───────────────────────────────────

describe("repair mode: intent tag in run-state and run-log (ADR-009 §Decision.7)", () => {
  it("repair run writes intent='repair' to run-state.json and run-log.jsonl base", async () => {
    const cwd = track(makeTargetProject());
    await run({
      cwd,
      repair: "spinner does not stop after successful submit",
      next: () => ({ action: "pipeline-complete", reason: "done" }),
    });
    // run-state
    const state = JSON.parse(fs.readFileSync(path.join(cwd, "pipeline", "run-state.json"), "utf8"));
    assert.equal(state.intent, "repair");
    assert.equal(state.repair, "spinner does not stop after successful submit");
    // run-log: every event has intent=repair in the base object
    const log = fs.readFileSync(path.join(cwd, "pipeline", "run-log.jsonl"), "utf8");
    const logEvents = log.trim().split("\n").map((l) => JSON.parse(l));
    const completeEv = logEvents.find((e) => e.outcome === "complete");
    assert.ok(completeEv, "run-log must contain a complete event");
    assert.equal(completeEv.intent, "repair", "run-log events must carry intent=repair");
  });

  it("feature run writes intent='feature' to run-state.json", async () => {
    const cwd = track(makeTargetProject());
    await run({
      cwd,
      feature: "add dark mode",
      next: () => ({ action: "pipeline-complete", reason: "done" }),
    });
    const state = JSON.parse(fs.readFileSync(path.join(cwd, "pipeline", "run-state.json"), "utf8"));
    assert.equal(state.intent, "feature");
    assert.equal(state.repair, undefined, "feature run must not have repair field");
  });

  it("resume carries prior_run_id correlating the predecessor run", async () => {
    const cwd = track(makeTargetProject());
    // First run — sets up run-state with a started_at.
    await run({
      cwd,
      repair: "modal not closing on Escape",
      next: () => ({ action: "pipeline-complete", reason: "done" }),
    });
    const firstState = JSON.parse(fs.readFileSync(path.join(cwd, "pipeline", "run-state.json"), "utf8"));
    const priorStartedAt = firstState.started_at;

    // Second run (resume) — must record prior_run_id linking to the first.
    // Simulate the run-lock being released (it was released by the first run finish).
    await run({
      cwd,
      repair: "modal not closing on Escape",
      resume: true,
      next: () => ({ action: "pipeline-complete", reason: "done" }),
    });
    const secondState = JSON.parse(fs.readFileSync(path.join(cwd, "pipeline", "run-state.json"), "utf8"));
    assert.equal(secondState.prior_run_id, priorStartedAt,
      "resumed run must record the prior run's started_at as prior_run_id");
    assert.notEqual(secondState.started_at, priorStartedAt,
      "resumed run must have a new started_at");
  });
});

// ─── 5. PATCH MODE rendering (adapter-contract pattern) ───────────────────────

describe("repair mode: PATCH MODE block rendered in repair build (ADR-009 §Decision.2)", () => {
  const PATCH_SENTINEL = "## ⚠️  PATCH MODE — targeted fix only";

  it("repair build dispatches runStageHeadless with patchItems set to the symptom", async () => {
    const cwd = track(makeTargetProject());
    const symptom = "dropdown selection resets on blur";
    let capturedPatchItems;
    await run({
      cwd,
      repair: symptom,
      next: () => ({ action: "run-stage", stage: "stage-04", name: "build" }),
      runStageHeadless: async (_name, opts) => {
        capturedPatchItems = opts.patchItems;
        // Return success after one dispatch so the loop exits
        return [{ role: "backend", gatePath: "x", exitCode: 0, durationMs: 1 }];
      },
      // stop after one dispatch
      maxIterations: 1,
    });
    assert.ok(Array.isArray(capturedPatchItems), "patchItems must be an array");
    assert.equal(capturedPatchItems.length, 1);
    assert.equal(capturedPatchItems[0], symptom, "patchItems[0] must be the symptom string");
  });

  it("feature build dispatches runStageHeadless WITHOUT patchItems", async () => {
    const cwd = track(makeTargetProject());
    let capturedPatchItems;
    await run({
      cwd,
      feature: "add search bar",
      next: () => ({ action: "run-stage", stage: "stage-04", name: "build" }),
      runStageHeadless: async (_name, opts) => {
        capturedPatchItems = opts.patchItems;
        return [{ role: "backend", gatePath: "x", exitCode: 0, durationMs: 1 }];
      },
      maxIterations: 1,
    });
    assert.ok(!capturedPatchItems, "feature build must not have patchItems");
  });

  it("renderPatchBlock includes symptom text in the PATCH MODE block", () => {
    // Unit-level check: adapter-contract pattern (not a subprocess test).
    const { renderPatchBlock } = require(path.join(REPO_ROOT, "core", "adapters", "render-helpers"));
    const symptom = "404 on /api/profile after logout";
    const lines = [];
    renderPatchBlock({ patchItems: [symptom] }, lines);
    const block = lines.join("\n");
    assert.ok(block.includes(PATCH_SENTINEL), "PATCH MODE sentinel must appear");
    assert.ok(block.includes(symptom), "symptom text must appear in the PATCH MODE block");
  });
});

// ─── 6. Structural scope gate ─────────────────────────────────────────────────

describe("repair mode: structural scope gate (ADR-009 §Decision.3)", () => {
  it("scope gate FAILs a build that writes outside the affected-files list", async () => {
    const cwd = track(makeTargetProject());
    const affectedFiles = ["src/auth.js"];
    const events = [];
    const s = await run({
      cwd,
      repair: "auth token stale after refresh",
      affectedFiles,
      // inject: scope gate finds an out-of-scope file
      checkScopeGate: (_cwd, _af) => ["src/payments.js"],
      next: () => ({ action: "run-stage", stage: "stage-04", name: "build" }),
      runStageHeadless: async () => [{ role: "backend", gatePath: "x", exitCode: 0, durationMs: 1 }],
      onEvent: (ev) => events.push(ev),
    });
    assert.equal(s.halted, true, "run must be halted by scope gate");
    assert.equal(s.halt_action, "scope-gate", "halt_action must be scope-gate");
    assert.ok(s.halt_reason.includes("src/payments.js"), "halt_reason must name the out-of-scope file");
    assert.deepEqual(s.out_of_scope, ["src/payments.js"]);
    // run-log must carry the scope-gate-fail event
    const log = fs.readFileSync(path.join(cwd, "pipeline", "run-log.jsonl"), "utf8");
    const logEvents = log.trim().split("\n").map((l) => JSON.parse(l));
    const failEv = logEvents.find((e) => e.outcome === "scope-gate-fail");
    assert.ok(failEv, "run-log must contain a scope-gate-fail event");
    assert.deepEqual(failEv.out_of_scope, ["src/payments.js"]);
  });

  it("scope gate PASSES when build stays within the affected-files list", async () => {
    const cwd = track(makeTargetProject());
    const affectedFiles = ["src/auth.js"];
    const nextSeq = [
      { action: "run-stage", stage: "stage-04", name: "build" },
      { action: "pipeline-complete", reason: "done" },
    ];
    let ni = 0;
    const s = await run({
      cwd,
      repair: "auth token stale after refresh",
      affectedFiles,
      // inject: scope gate finds no violations
      checkScopeGate: () => [],
      next: () => nextSeq[ni++] || { action: "pipeline-complete", reason: "done" },
      runStageHeadless: async () => [{ role: "backend", gatePath: "x", exitCode: 0, durationMs: 1 }],
    });
    assert.notEqual(s.halt_action, "scope-gate", "scope gate must not fire when build is within scope");
    assert.equal(s.completed, true, "run must complete when build is within scope");
  });

  it("scope gate is inert when no affectedFiles list is provided (10.1 baseline)", async () => {
    const cwd = track(makeTargetProject());
    const s = await run({
      cwd,
      repair: "button label alignment off",
      // no affectedFiles — gate must be inert
      next: () => ({ action: "run-stage", stage: "stage-04", name: "build" }),
      runStageHeadless: async () => [{ role: "backend", gatePath: "x", exitCode: 0, durationMs: 1 }],
      maxIterations: 1,
    });
    assert.notEqual(s.halt_action, "scope-gate", "scope gate must be inert without affectedFiles");
  });
});

// ─── 7. 10.2: Diagnosis as stage-01 (ADR-009 Phase 2) ────────────────────────

describe("repair mode 10.2: stage-01 produces a diagnosis artifact when intent=repair (ADR-009 Phase 2)", () => {
  it("buildDescriptor swaps stage-01 to diagnosis shape when intent=repair (unit)", () => {
    const { buildDescriptor } = require(path.join(REPO_ROOT, "core", "orchestrator"));
    const { getStage } = require(path.join(REPO_ROOT, "core", "pipeline", "stages"));
    const stageDef = getStage("requirements");
    const descriptor = buildDescriptor(stageDef, "pm", { intent: "repair" });
    assert.ok(descriptor.artifact.endsWith("diagnosis.md"),
      `artifact must be diagnosis.md, got: ${descriptor.artifact}`);
    assert.ok(descriptor.objective.includes("Diagnose"),
      "objective must mention 'Diagnose'");
    assert.ok(Array.isArray(descriptor.expectedGate.affected_files),
      "gate must have affected_files array");
    assert.ok("root_cause" in descriptor.expectedGate, "gate must have root_cause");
    assert.ok("proposed_fix" in descriptor.expectedGate, "gate must have proposed_fix");
    assert.ok("regression_criterion" in descriptor.expectedGate, "gate must have regression_criterion");
    // ESCALATE semantics — diagnosis is always a judgment gate.
    assert.ok("escalation_reason" in descriptor.expectedGate,
      "gate must have escalation_reason (ESCALATE shape)");
    assert.ok("decision_needed" in descriptor.expectedGate,
      "gate must have decision_needed (ESCALATE shape)");
  });

  it("buildDescriptor keeps base stage-01 shape when intent=feature (unit)", () => {
    const { buildDescriptor } = require(path.join(REPO_ROOT, "core", "orchestrator"));
    const { getStage } = require(path.join(REPO_ROOT, "core", "pipeline", "stages"));
    const stageDef = getStage("requirements");
    const descriptor = buildDescriptor(stageDef, "pm", { intent: "feature" });
    assert.ok(descriptor.artifact.endsWith("brief.md"),
      `artifact must be brief.md, got: ${descriptor.artifact}`);
    assert.deepEqual(descriptor.expectedGate.affected_files, [],
      "feature gate keeps an inert affected_files list for optional documentation ownership");
    assert.ok(!("escalation_reason" in descriptor.expectedGate),
      "feature gate must not have ESCALATE fields");
  });

  it("scope gate activates from diagnosis gate affected_files without opts.affectedFiles (FAILS on main without 10.2)", async () => {
    const cwd = track(makeTargetProject());
    // Pre-write a PASS stage-01 (diagnosis) gate with affected_files.
    // The driver reads this before dispatching build to activate the scope gate.
    const gateDir = path.join(cwd, "pipeline", "gates");
    fs.mkdirSync(gateDir, { recursive: true });
    fs.writeFileSync(path.join(gateDir, "stage-01.json"), JSON.stringify({
      stage: "stage-01", status: "PASS", workstream: "pm",
      root_cause: "auth drops token on refresh",
      proposed_fix: "add null guard in refreshToken()",
      affected_files: ["src/auth.js"],
      regression_criterion: "token is returned after expiry",
      diagnosis_confirmed: true,
    }, null, 2));
    const s = await run({
      cwd,
      repair: "auth token stale after refresh",
      // No opts.affectedFiles — 10.2 activates the scope gate via state.affectedFiles
      checkScopeGate: (_cwd, _af) => ["src/payments.js"],
      next: () => ({ action: "run-stage", stage: "stage-04", name: "build" }),
      runStageHeadless: async () => [{ role: "backend", gatePath: "x", exitCode: 0, durationMs: 1 }],
      maxIterations: 1,
    });
    assert.equal(s.halt_action, "scope-gate",
      "scope gate must fire when diagnosis gate provides affected_files (10.2 activation)");
  });

  it("diagnosis ESCALATE gate halts without --auto-rule (judgment-gate halt)", async () => {
    const cwd = track(makeTargetProject());
    const s = await run({
      cwd,
      repair: "button not submitting",
      // no autoRule — grantSet empty → halts immediately at resolve-escalation
      next: () => ({
        action: "resolve-escalation",
        name: "requirements",
        stage: "stage-01",
        gate: path.join(cwd, "pipeline", "gates", "stage-01.json"),
        failure_class: "judgment-gate",
        reason: "diagnosis requires human or --auto-rule diagnosis-approved approval",
      }),
      maxIterations: 1,
    });
    assert.equal(s.halted, true, "run must be halted");
    assert.equal(s.halt_action, "resolve-escalation", "halt_action must be resolve-escalation");
    assert.equal(s.halt_failure_class, "judgment-gate", "halt_failure_class must be judgment-gate");
  });

  it("--auto-rule diagnosis-approved proceeds past the diagnosis judgment gate", async () => {
    const cwd = track(makeTargetProject());
    const nextSeq = [
      {
        action: "resolve-escalation",
        name: "requirements",
        stage: "stage-01",
        gate: path.join(cwd, "pipeline", "gates", "x.json"),
        failure_class: "judgment-gate",
        reason: "diagnosis requires approval",
      },
      { action: "pipeline-complete", reason: "done" },
    ];
    let ni = 0;
    const s = await run({
      cwd,
      repair: "button not submitting",
      autoRule: ["diagnosis-approved"],
      runRuling: async (_cwd) => {
        // Append a PRINCIPAL-RULING line so loadPrincipalOutputs finds the grant.
        fs.mkdirSync(path.join(_cwd, "pipeline"), { recursive: true });
        fs.appendFileSync(
          path.join(_cwd, "pipeline", "context.md"),
          "\nPRINCIPAL-RULING: diagnosis → proceed [class: diagnosis-approved]\n",
        );
        return { exitCode: 0 };
      },
      runFixEscalation: async () => null,
      next: () => nextSeq[ni++] || { action: "pipeline-complete", reason: "done" },
    });
    assert.equal(s.completed, true,
      "run must complete after auto-ruling the diagnosis judgment gate");
  });

  it("--repair-at seeds affectedFiles from file:line and skips the diagnosis dispatch", async () => {
    const cwd = track(makeTargetProject());
    const events = [];
    let requirementsDispatched = false;
    const s = await run({
      cwd,
      repair: "null pointer in checkout",
      repairAt: "src/checkout.js:42",
      next: () => ({ action: "pipeline-complete", reason: "done" }),
      runStageHeadless: async (name) => {
        if (name === "requirements") requirementsDispatched = true;
        return [{ role: "pm", gatePath: "x", exitCode: 0, durationMs: 1 }];
      },
      onEvent: (ev) => events.push(ev),
    });
    assert.equal(requirementsDispatched, false,
      "requirements (diagnosis) must not be dispatched when --repair-at is used");
    const state = JSON.parse(fs.readFileSync(path.join(cwd, "pipeline", "run-state.json"), "utf8"));
    assert.deepEqual(state.affectedFiles, ["src/checkout.js"],
      "affectedFiles must be seeded from the --repair-at location");
    const log = fs.readFileSync(path.join(cwd, "pipeline", "run-log.jsonl"), "utf8");
    const logEvents = log.trim().split("\n").map((l) => JSON.parse(l));
    const seededEv = logEvents.find((e) => e.outcome === "repair-at-seeded");
    assert.ok(seededEv, "run-log must carry repair-at-seeded event");
    assert.deepEqual(seededEv.affected_files, ["src/checkout.js"]);
    const gateFile = path.join(cwd, "pipeline", "gates", "stage-01.json");
    assert.ok(fs.existsSync(gateFile), "synthetic stage-01 gate must be written");
    const gate = JSON.parse(fs.readFileSync(gateFile, "utf8"));
    assert.equal(gate.status, "PASS", "synthetic gate must be PASS");
    assert.equal(gate.seeded_by, "--repair-at", "synthetic gate must record seeded_by");
    assert.deepEqual(gate.affected_files, ["src/checkout.js"]);
    assert.ok(s.completed, "run must complete");
  });
});

// ─── 8. 10.3: Failing-first reproduction — stage-03b + tri-state ─────────────

describe("repair mode 10.3: executable-spec (stage-03b) in repair order (ADR-009 Phase 3)", () => {
  it("hotfix track baseline: executable-spec is NOT in hotfix stage list", () => {
    const { isStageInTrack } = require(path.join(REPO_ROOT, "core", "pipeline", "stages"));
    assert.equal(
      isStageInTrack("executable-spec", "hotfix"),
      false,
      "hotfix track must NOT include executable-spec (baseline for Phase 3 verify-first)",
    );
  });

  it("repair intent on hotfix includes executable-spec in the effective stage order", async () => {
    // The driver passes the repair-aware order array as `track` to next(); capture
    // it to verify executable-spec is injected even though hotfix omits it.
    const cwd = track(makeTargetProject());
    let capturedOrder = null;
    await run({
      cwd,
      repair: "dropdown resets on blur",
      next: ({ track: t }) => {
        if (!capturedOrder && Array.isArray(t)) capturedOrder = t;
        return { action: "pipeline-complete", reason: "done" };
      },
    });
    assert.ok(Array.isArray(capturedOrder), "repair run must pass order array as track to next()");
    assert.ok(
      capturedOrder.includes("executable-spec"),
      "repair-on-hotfix order must include executable-spec",
    );
  });

  it("repair intent on hotfix places executable-spec immediately before build", async () => {
    const cwd = track(makeTargetProject());
    let capturedOrder = null;
    await run({
      cwd,
      repair: "null pointer in pagination",
      next: ({ track: t }) => {
        if (!capturedOrder && Array.isArray(t)) capturedOrder = t;
        return { action: "pipeline-complete", reason: "done" };
      },
    });
    assert.ok(Array.isArray(capturedOrder));
    const specIdx = capturedOrder.indexOf("executable-spec");
    const buildIdx = capturedOrder.indexOf("build");
    assert.ok(specIdx >= 0, "executable-spec must be in order");
    assert.ok(buildIdx >= 0, "build must be in order");
    assert.equal(specIdx + 1, buildIdx, "executable-spec must immediately precede build");
  });

  it("repair-on-full track also includes executable-spec (already present, no double-inject)", async () => {
    const cwd = track(makeTargetProject());
    let capturedOrder = null;
    await run({
      cwd,
      repair: "broken pagination on search results",
      track: "full",
      next: ({ track: t }) => {
        if (!capturedOrder && Array.isArray(t)) capturedOrder = t;
        return { action: "pipeline-complete", reason: "done" };
      },
    });
    assert.ok(Array.isArray(capturedOrder));
    const specCount = capturedOrder.filter((n) => n === "executable-spec").length;
    assert.equal(specCount, 1, "executable-spec must appear exactly once in the order (no double-inject)");
  });

  it("--repair-at escape hatch still includes executable-spec in the stage order", async () => {
    const cwd = track(makeTargetProject());
    let capturedOrder = null;
    await run({
      cwd,
      repair: "null pointer in checkout",
      repairAt: "src/checkout.js:42",
      next: ({ track: t }) => {
        if (!capturedOrder && Array.isArray(t)) capturedOrder = t;
        return { action: "pipeline-complete", reason: "done" };
      },
    });
    assert.ok(Array.isArray(capturedOrder));
    assert.ok(
      capturedOrder.includes("executable-spec"),
      "--repair-at must still include executable-spec (reproduction discipline without diagnosis dispatch)",
    );
  });
});

describe("repair mode 10.3: executable-spec repairOverride shape (ADR-009 Phase 3)", () => {
  it("buildDescriptor for executable-spec in repair mode uses failing-first objective", () => {
    const { buildDescriptor } = require(path.join(REPO_ROOT, "core", "orchestrator"));
    const { getStage } = require(path.join(REPO_ROOT, "core", "pipeline", "stages"));
    const stageDef = getStage("executable-spec");
    const descriptor = buildDescriptor(stageDef, "pm", { intent: "repair" });
    assert.ok(
      descriptor.objective.toLowerCase().includes("failing-first") ||
      descriptor.objective.toLowerCase().includes("red before"),
      `repair objective must mention failing-first or red before; got: ${descriptor.objective}`,
    );
    assert.ok(
      "reproduced" in descriptor.expectedGate,
      "repair gate must include reproduced field",
    );
  });

  it("buildDescriptor for executable-spec in feature mode keeps standard objective (no reproduced)", () => {
    const { buildDescriptor } = require(path.join(REPO_ROOT, "core", "orchestrator"));
    const { getStage } = require(path.join(REPO_ROOT, "core", "pipeline", "stages"));
    const stageDef = getStage("executable-spec");
    const descriptor = buildDescriptor(stageDef, "pm", { intent: "feature" });
    assert.ok(
      !("reproduced" in descriptor.expectedGate),
      "feature gate must not have reproduced field",
    );
  });
});
