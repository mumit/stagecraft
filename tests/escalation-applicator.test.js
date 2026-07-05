// tests/escalation-applicator.test.js
//
// Tests for the mtime-based build-gate verification added to driver.js
// as part of issue #248 (peer-review cycling fix, Layer 3).
//
// The driver's resolve-escalation path now:
//   1. Snapshots build workstream gate mtimes before the applicator runs.
//   2. After a successful applicator exit, checks whether a build gate was
//      updated when the ruling's decision mentions dispatching a build workstream.
//   3. Halts with halt_failure_class "applicator-did-not-dispatch-build" when
//      no build gate was updated.
//   4. Resets state.autoRule[stageName] to 0 after a confirmed build dispatch
//      so a subsequent escalation gets a fresh one-shot grant.

const { describe, it, afterEach } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { REPO_ROOT, makeTargetProject, seedGate, cleanup } = require("./_helpers");
const { run } = require(path.join(REPO_ROOT, "core", "driver"));
const {
  guardConvergenceGateResolution,
  renderEscalationApplicatorPrompt,
  runFixEscalation,
} = require(path.join(REPO_ROOT, "core", "escalation"));

let _dirs = [];
function track(cwd) { _dirs.push(cwd); return cwd; }
afterEach(() => { _dirs.forEach(cleanup); _dirs = []; });

// Writes a PRINCIPAL-RULING line that mentions dispatching a build workstream.
// The driver checks latest.decision against /dispatch\s+(backend|...)\s+build\s+workstream/i.
function writeDispatchBuildRuling(cwd, role = "backend") {
  const p = path.join(cwd, "pipeline", "context.md");
  fs.mkdirSync(path.dirname(p), { recursive: true });
  const line = `PRINCIPAL-RULING: peer-review → dispatch ${role} build workstream [class: code-fix]`;
  fs.appendFileSync(p, (fs.existsSync(p) ? "" : "## Principal Rulings\n\n") + line + "\n");
}

// Writes a PRINCIPAL-RULING line that does NOT mention a build workstream dispatch.
// (e.g. a gate correction ruling)
function writeGateCorrectionRuling(cwd) {
  const p = path.join(cwd, "pipeline", "context.md");
  fs.mkdirSync(path.dirname(p), { recursive: true });
  const line = "PRINCIPAL-RULING: peer-review → fix gate shape, re-run merge [class: formatting-only]";
  fs.appendFileSync(p, (fs.existsSync(p) ? "" : "## Principal Rulings\n\n") + line + "\n");
}

const peerReviewEscalation = {
  action: "resolve-escalation",
  stage: "stage-05",
  name: "peer-review",
  failure_class: "judgment-gate",
  gate: null,
  reason: "reviewers split",
};

describe("escalation applicator: convergence gate backstop", () => {
  it("restores a convergence-exhausted gate if applicator downgrades it with blockers unresolved", () => {
    const cwd = track(makeTargetProject());
    const gatePath = seedGate(cwd, "stage-04a", {
      stage: "stage-04a",
      workstream: "platform",
      status: "ESCALATE",
      lint_passed: false,
      blockers: ["`npm run lint` cannot execute because package.json has no lint script"],
      escalation_reason: "driver retry budget exhausted for \"pre-review\" (2/2); escalating",
      decision_needed: "Add fix instructions, then restart pre-review",
    });
    const before = JSON.parse(fs.readFileSync(gatePath, "utf8"));
    fs.writeFileSync(gatePath, JSON.stringify({
      ...before,
      status: "WARN",
      escalation_reason: undefined,
      decision_needed: undefined,
    }, null, 2) + "\n");

    const violation = guardConvergenceGateResolution(gatePath, before);
    const restored = JSON.parse(fs.readFileSync(gatePath, "utf8"));
    assert.equal(violation.code, "invalid-convergence-resolution");
    assert.equal(restored.status, "ESCALATE");
    assert.equal(restored.escalation_reason, before.escalation_reason);
    assert.deepEqual(restored.blockers, before.blockers);
  });

  it("tells applicators that missing lint scripts are platform build fixes, not gate corrections", () => {
    const cwd = track(makeTargetProject());
    const gatePath = seedGate(cwd, "stage-04a", {
      stage: "stage-04a",
      workstream: "platform",
      status: "ESCALATE",
      blockers: ["`npm run lint` cannot execute because `package.json` does not define a `lint` script."],
      escalation_reason: "driver retry budget exhausted for \"pre-review\" (2/2); escalating",
    });
    const prompt = renderEscalationApplicatorPrompt(cwd, [
      "PRINCIPAL-RULING: Root config ownership belongs to platform → `package.json` and lockfiles are platform-owned [class: file-ownership]",
    ], gatePath);
    assert.match(prompt, /missing `npm run lint` script is a platform build fix/i);
    assert.match(prompt, /devteam stage build --workstream platform --headless/);
    assert.match(prompt, /Do not resolve convergence exhaustion/i);
  });

  it("allows documentation-only rulings to write README.md through fix-escalation", async () => {
    const cwd = track(makeTargetProject({
      config: "routing:\n  default_host: omnigent\npipeline:\n  default_track: full\n",
    }));
    const p = path.join(cwd, "pipeline", "context.md");
    fs.mkdirSync(path.dirname(p), { recursive: true });
    fs.writeFileSync(p, [
      "## Principal Rulings",
      "",
      "PRINCIPAL-RULING: sign-off docs → document GET /hello in README.md [class: doc-only]",
      "",
    ].join("\n"));
    const writer = path.join(cwd, "write-doc.js");
    fs.writeFileSync(writer, [
      "const fs = require('node:fs');",
      "fs.writeFileSync('README.md', '# Hello API\\n\\nGET /hello returns Hello, world!\\n');",
      "",
    ].join("\n"));

    const oldEnv = process.env.DEVTEAM_HEADLESS_COMMAND;
    process.env.DEVTEAM_HEADLESS_COMMAND = `${process.execPath} ${writer}`;
    try {
      const result = await runFixEscalation(cwd);
      assert.equal(result.exitCode, 0);
      assert.match(fs.readFileSync(path.join(cwd, "README.md"), "utf8"), /GET \/hello/);
    } finally {
      if (oldEnv === undefined) delete process.env.DEVTEAM_HEADLESS_COMMAND;
      else process.env.DEVTEAM_HEADLESS_COMMAND = oldEnv;
    }
  });
});

describe("driver: applicator-did-not-dispatch-build halt", () => {
  it("halts with applicator-did-not-dispatch-build when ruling orders build but no gate updated", async () => {
    const cwd = track(makeTargetProject());

    const s = await run({
      cwd,
      autoRule: ["code-fix"],
      next: () => peerReviewEscalation,
      runRuling: async () => {
        writeDispatchBuildRuling(cwd, "backend");
        return { exitCode: 0 };
      },
      // Applicator does nothing — no build gate is written or updated
      runFixEscalation: async () => ({ exitCode: 0 }),
    });

    assert.equal(s.halted, true);
    assert.equal(s.halt_failure_class, "applicator-did-not-dispatch-build",
      `expected applicator-did-not-dispatch-build; got: ${s.halt_failure_class}`);
    assert.ok(
      s.halt_reason.includes("did not dispatch a build workstream"),
      `expected build dispatch mention in halt_reason: ${s.halt_reason}`
    );
  });

  it("continues (no halt) when ruling orders build and applicator writes a new build gate", async () => {
    const cwd = track(makeTargetProject());
    const gDir = path.join(cwd, "pipeline", "gates");

    const nextSeq = [
      peerReviewEscalation,
      { action: "pipeline-complete", reason: "done" },
    ];
    let n = 0;

    const s = await run({
      cwd,
      autoRule: ["code-fix"],
      next: () => nextSeq[n++],
      runRuling: async () => {
        writeDispatchBuildRuling(cwd, "backend");
        return { exitCode: 0 };
      },
      runFixEscalation: async () => {
        // Simulate the applicator creating a new build gate
        fs.mkdirSync(gDir, { recursive: true });
        fs.writeFileSync(
          path.join(gDir, "stage-04.backend.json"),
          JSON.stringify({ stage: "stage-04.backend", status: "PASS", blockers: [], warnings: [] }, null, 2) + "\n"
        );
        return { exitCode: 0 };
      },
    });

    assert.equal(s.completed, true, `expected completed; got: ${JSON.stringify({ halted: s.halted, halt_reason: s.halt_reason })}`);
    assert.equal(s.halted, false);
  });

  it("also detects an updated (not newly created) build gate as valid dispatch", async () => {
    const cwd = track(makeTargetProject());
    const gDir = path.join(cwd, "pipeline", "gates");
    // Pre-create a build gate so the applicator will UPDATE (not create) it
    seedGate(cwd, "stage-04.backend", { status: "FAIL", blockers: ["original"] });

    const nextSeq = [
      peerReviewEscalation,
      { action: "pipeline-complete", reason: "done" },
    ];
    let n = 0;

    const s = await run({
      cwd,
      autoRule: ["code-fix"],
      next: () => nextSeq[n++],
      runRuling: async () => {
        writeDispatchBuildRuling(cwd, "backend");
        return { exitCode: 0 };
      },
      runFixEscalation: async () => {
        // Small delay to ensure mtime advances (1ms is enough on most filesystems)
        await new Promise(r => setTimeout(r, 10));
        // Update the existing gate
        fs.writeFileSync(
          path.join(gDir, "stage-04.backend.json"),
          JSON.stringify({ stage: "stage-04.backend", status: "PASS", blockers: [], warnings: [] }, null, 2) + "\n"
        );
        return { exitCode: 0 };
      },
    });

    assert.equal(s.completed, true, `expected completed: ${JSON.stringify({ halted: s.halted, halt_reason: s.halt_reason })}`);
  });
});

describe("driver: mtime check skipped when ruling does not mention build dispatch", () => {
  it("does not halt when ruling is a gate correction (no build dispatch phrase) and no gate is written", async () => {
    const cwd = track(makeTargetProject());
    const nextSeq = [
      peerReviewEscalation,
      { action: "pipeline-complete", reason: "done" },
    ];
    let n = 0;

    const s = await run({
      cwd,
      autoRule: ["formatting-only"],
      next: () => nextSeq[n++],
      runRuling: async () => {
        writeGateCorrectionRuling(cwd);
        return { exitCode: 0 };
      },
      // Applicator does nothing — but the ruling didn't order build dispatch
      runFixEscalation: async () => ({ exitCode: 0 }),
    });

    // No build gate updated, but since ruling doesn't mention build dispatch,
    // the mtime check is skipped and the run continues to completion.
    assert.equal(s.completed, true,
      `expected completed since mtime check should be skipped; got: ${JSON.stringify({ halted: s.halted, halt_reason: s.halt_reason })}`);
  });
});

describe("driver: autoRule counter reset after confirmed build dispatch", () => {
  it("resets autoRule counter so a second peer-review escalation gets a fresh grant", async () => {
    const cwd = track(makeTargetProject());
    const gDir = path.join(cwd, "pipeline", "gates");

    // First call: resolve-escalation (build dispatch ruling, applicator writes gate)
    // Second call: resolve-escalation again (simulates peer-review escalating a second time)
    // Third call: pipeline-complete
    // Without the autoRule reset, the second escalation would hit alreadyTried and halt.
    // With the reset, it gets a fresh grant and completes.
    const nextSeq = [
      peerReviewEscalation,
      peerReviewEscalation, // second escalation for same stage
      { action: "pipeline-complete", reason: "done" },
    ];
    let n = 0;
    let rulingCalls = 0;

    const s = await run({
      cwd,
      autoRule: ["code-fix"],
      next: () => nextSeq[n++],
      runRuling: async () => {
        rulingCalls++;
        writeDispatchBuildRuling(cwd, "backend");
        return { exitCode: 0 };
      },
      runFixEscalation: async () => {
        // Write a new build gate so the mtime check passes
        fs.mkdirSync(gDir, { recursive: true });
        const gatePath = path.join(gDir, "stage-04.backend.json");
        await new Promise(r => setTimeout(r, 10));
        fs.writeFileSync(
          gatePath,
          JSON.stringify({ stage: "stage-04.backend", status: "PASS", blockers: [], warnings: [], ts: Date.now() }, null, 2) + "\n"
        );
        return { exitCode: 0 };
      },
    });

    assert.equal(s.completed, true,
      `expected completed after autoRule reset; got: ${JSON.stringify({ halted: s.halted, halt_reason: s.halt_reason })}`);
    assert.equal(rulingCalls, 2,
      `Principal should be dispatched twice (once per escalation); got: ${rulingCalls}`);
  });
});
