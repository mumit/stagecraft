const { describe, it, afterEach } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { REPO_ROOT, makeTargetProject, seedGate, cleanup } = require("./_helpers");
const { runStage, runStageHeadless, mergeWorkstreamGates, buildDescriptor, summary, renderOmnigentDirectorPrompt, patchGateForUnpricedModel } =
  require(path.join(REPO_ROOT, "core", "orchestrator"));
const { listArchives } = require(path.join(REPO_ROOT, "core", "gates", "archive"));
const { STAGES, getStage } = require(path.join(REPO_ROOT, "core", "pipeline", "stages"));
const { isAllowed } = require(path.join(REPO_ROOT, "core", "guards", "write-audit"));

let _dirs = [];
function track(cwd) { _dirs.push(cwd); return cwd; }
afterEach(() => { _dirs.forEach(cleanup); _dirs = []; });

describe("orchestrator: runStage decomposition", () => {
  it("single-role stage produces one workstream", () => {
    const cwd = track(makeTargetProject());
    const r = runStage("requirements", { cwd, feature: "Test" });
    assert.equal(r.workstreams.length, 1);
    assert.equal(r.workstreams[0].role, "pm");
  });

  it("multi-role stage (build) produces 4 workstreams", () => {
    const cwd = track(makeTargetProject());
    const r = runStage("build", { cwd });
    assert.equal(r.workstreams.length, 4);
    const roles = r.workstreams.map((w) => w.role).sort();
    assert.deepEqual(roles, ["backend", "frontend", "platform", "qa"]);
  });

  it("stage prompts include bounded changed-file manifest facts", () => {
    const cwd = track(makeTargetProject());
    const git = require("node:child_process").spawnSync("git", ["init"], { cwd, encoding: "utf8" });
    assert.equal(git.status, 0, git.stderr);
    fs.mkdirSync(path.join(cwd, "src", "backend"), { recursive: true });
    fs.writeFileSync(path.join(cwd, "src", "backend", "hello.js"), "module.exports = 'hello';\n");
    const r = runStage("build", { cwd });
    const backend = r.workstreams.find((w) => w.role === "backend");
    assert.match(backend.prompt, /Changed-file manifest/);
    assert.match(backend.prompt, /src\/backend\/hello\.js/);
    assert.match(backend.prompt, /sha256:[0-9a-f]{64}/);
    assert.ok(backend.descriptor.contextManifest.files.some((file) => file.path === "src/backend/hello.js"));
  });

  it("each workstream carries its own descriptor with role-specific id", () => {
    const cwd = track(makeTargetProject());
    const r = runStage("build", { cwd });
    const backend = r.workstreams.find((w) => w.role === "backend");
    assert.equal(backend.descriptor.workstreamId, "stage-04.backend");
    const frontend = r.workstreams.find((w) => w.role === "frontend");
    assert.equal(frontend.descriptor.workstreamId, "stage-04.frontend");
  });

  it("throws on unknown stage name", () => {
    const cwd = track(makeTargetProject());
    assert.throws(() => runStage("bogus", { cwd }), /Unknown stage/);
  });
});

describe("orchestrator: buildDescriptor honors overrides", () => {
  it("roleWrites filter narrows allowedWrites per role", () => {
    const build = getStage("build");
    const backend = buildDescriptor(build, "backend");
    const frontend = buildDescriptor(build, "frontend");
    const platform = buildDescriptor(build, "platform");
    assert.ok(backend.allowedWrites.some((p) => p.includes("src/backend/")));
    assert.ok(!backend.allowedWrites.some((p) => p.includes("src/frontend/")),
      "backend should NOT see src/frontend/");
    assert.ok(frontend.allowedWrites.some((p) => p.includes("src/frontend/")));
    assert.ok(!frontend.allowedWrites.some((p) => p.includes("src/backend/")));
    assert.ok(
      isAllowed("package.json", platform.allowedWrites),
      "platform should own root package/toolchain config writes",
    );
    assert.ok(
      isAllowed("eslint.config.js", platform.allowedWrites),
      "platform should own lint config writes",
    );
  });

  it("falls back to stage-level allowedWrites when no roleWrites", () => {
    const req = getStage("requirements");
    const pm = buildDescriptor(req, "pm");
    assert.deepEqual(pm.allowedWrites, req.allowedWrites);
  });

  it("passes through stage.subagent override to descriptor", () => {
    const review = getStage("peer-review");
    const d = buildDescriptor(review, "backend");
    assert.equal(d.subagent, "reviewer");
  });

  it("single-role stages use bare workstreamId (no role suffix)", () => {
    const req = getStage("requirements");
    const d = buildDescriptor(req, "pm");
    assert.equal(d.workstreamId, "stage-01");
  });

  it("multi-role stages append role to workstreamId", () => {
    const build = getStage("build");
    const d = buildDescriptor(build, "platform");
    assert.equal(d.workstreamId, "stage-04.platform");
  });

  it("explicit --workstream can target a role suppressed by active_roles", () => {
    const cwd = track(makeTargetProject());
    seedGate(cwd, "stage-01", {
      active_roles: ["backend", "qa"],
      status: "PASS",
    });
    const r = runStage("build", { cwd, workstream: ["platform"] });
    assert.equal(r.workstreams.length, 1);
    assert.equal(r.workstreams[0].role, "platform");
    assert.equal(r.workstreams[0].descriptor.workstreamId, "stage-04.platform");
  });

  it("all LLM-dispatched stages allow their workstream gate path", () => {
    for (const [name, stageDef] of Object.entries(STAGES)) {
      for (const role of stageDef.roles) {
        const d = buildDescriptor(stageDef, role);
        const gatePath = `pipeline/gates/${d.workstreamId}.json`;
        assert.ok(
          isAllowed(gatePath, d.allowedWrites),
          `${name}/${role} must allow writing ${gatePath}`,
        );
      }
    }
  });

  it("single-role artifact-writing stages allow their declared artifact path", () => {
    for (const [name, stageDef] of Object.entries(STAGES)) {
      if (stageDef.roles.length !== 1 || !stageDef.artifact) continue;
      const [role] = stageDef.roles;
      const d = buildDescriptor(stageDef, role);
      assert.ok(
        isAllowed(d.artifact, d.allowedWrites),
        `${name}/${role} must allow writing artifact ${d.artifact}`,
      );
    }
  });
});

describe("orchestrator: mergeWorkstreamGates aggregation", () => {
  function seedFour(cwd, statuses, warnings = []) {
    const roles = ["backend", "frontend", "platform", "qa"];
    roles.forEach((role, i) => {
      seedGate(cwd, `stage-04.${role}`, {
        stage: "stage-04",
        workstream: role,
        host: "claude-code",
        status: statuses[i],
        warnings: warnings[i] || [],
      });
    });
  }

  it("PASS + PASS + PASS + PASS → PASS", () => {
    const cwd = track(makeTargetProject());
    seedFour(cwd, ["PASS", "PASS", "PASS", "PASS"]);
    const r = mergeWorkstreamGates("build", { cwd });
    assert.equal(r.merged, true);
    assert.equal(r.gate.status, "PASS");
    assert.equal(r.gate.workstreams.length, 4);
  });

  it("PASS + WARN → WARN", () => {
    const cwd = track(makeTargetProject());
    seedFour(cwd, ["PASS", "WARN", "PASS", "PASS"], [[], ["coverage low"], [], []]);
    const r = mergeWorkstreamGates("build", { cwd });
    assert.equal(r.gate.status, "WARN");
    assert.deepEqual(r.gate.warnings, ["coverage low"]);
  });

  it("PASS + FAIL → FAIL", () => {
    const cwd = track(makeTargetProject());
    seedFour(cwd, ["PASS", "FAIL", "PASS", "PASS"]);
    const r = mergeWorkstreamGates("build", { cwd });
    assert.equal(r.gate.status, "FAIL");
  });

  it("FAIL + ESCALATE → ESCALATE (highest severity wins)", () => {
    const cwd = track(makeTargetProject());
    seedFour(cwd, ["FAIL", "ESCALATE", "PASS", "PASS"]);
    const r = mergeWorkstreamGates("build", { cwd });
    assert.equal(r.gate.status, "ESCALATE");
  });

  it("skips merge for single-role stages", () => {
    const cwd = track(makeTargetProject());
    const r = mergeWorkstreamGates("requirements", { cwd });
    assert.equal(r.merged, false);
    assert.match(r.reason, /single-(role|workstream)/);
  });

  it("reports missing workstreams without merging", () => {
    const cwd = track(makeTargetProject());
    seedGate(cwd, "stage-04.backend", { workstream: "backend", host: "claude-code", status: "PASS" });
    // missing frontend, platform, qa
    const r = mergeWorkstreamGates("build", { cwd });
    assert.equal(r.merged, false);
    assert.match(r.reason, /missing workstream gate/);
  });

  it("reports a clear error when a workstream gate is malformed JSON (no crash)", () => {
    const cwd = track(makeTargetProject());
    const fs = require("node:fs");
    // Seed three valid + one truncated
    seedGate(cwd, "stage-04.frontend", { workstream: "frontend", host: "claude-code", status: "PASS" });
    seedGate(cwd, "stage-04.platform", { workstream: "platform", host: "claude-code", status: "PASS" });
    seedGate(cwd, "stage-04.qa", { workstream: "qa", host: "claude-code", status: "PASS" });
    fs.writeFileSync(
      path.join(cwd, "pipeline", "gates", "stage-04.backend.json"),
      '{"stage":"stage-04","workstream":"back', // truncated mid-emit
      "utf8",
    );
    const r = mergeWorkstreamGates("build", { cwd });
    assert.equal(r.merged, false);
    assert.match(r.reason, /unreadable workstream gate/);
    assert.match(r.reason, /backend/);
  });

  it("track-less workstream gates inherit the resolved pipeline track", () => {
    // When a workstream gate omits the track field (e.g. model forgot to include
    // it), the merged gate must carry the pipeline-resolved track rather than
    // shipping track:undefined which the validator would flag.
    const cwd = track(makeTargetProject());
    const roles = ["backend", "frontend", "platform", "qa"];
    roles.forEach((role) => {
      const gate = {
        stage: "stage-04",
        workstream: role,
        host: "claude-code",
        status: "PASS",
        blockers: [],
        warnings: [],
        orchestrator: "devteam@test",
        timestamp: "2026-05-26T20:00:00Z",
        // deliberately omit track
      };
      fs.writeFileSync(
        path.join(cwd, "pipeline", "gates", `stage-04.${role}.json`),
        JSON.stringify(gate, null, 2),
        "utf8",
      );
    });
    const r = mergeWorkstreamGates("build", { cwd, track: "quick" });
    assert.equal(r.merged, true);
    assert.equal(r.gate.track, "quick", `merged gate should carry resolved track; got: ${r.gate.track}`);
  });
});

describe("orchestrator: runStageHeadless --skip-completed", () => {
  // Minimal stub adapter: capabilities.headless=true, invoke() writes a gate
  // and exits 0. DEVTEAM_HEADLESS_COMMAND=true is set per-test to avoid
  // touching a real host binary.
  function makeHeadlessConfig(host = "claude-code") {
    return `routing:\n  default_host: ${host}\npipeline:\n  default_track: full\n`;
  }

  it("skips a workstream whose gate file already exists", async () => {
    const cwd = track(makeTargetProject({ config: makeHeadlessConfig() }));
    // Pre-seed frontend gate so it looks "completed"
    seedGate(cwd, "stage-04.frontend", {
      stage: "stage-04", workstream: "frontend", status: "PASS",
    });

    let dispatched = [];
    const plan = runStage("build", { cwd });
    // Simulate skip-completed check without actually invoking headless CLIs
    for (const ws of plan.workstreams) {
      const gateFile = require("node:path").join(cwd, "pipeline", "gates", `${ws.descriptor.workstreamId}.json`);
      if (!require("node:fs").existsSync(gateFile)) {
        dispatched.push(ws.role);
      }
    }

    assert.ok(!dispatched.includes("frontend"), "frontend should be skipped");
    assert.ok(dispatched.includes("backend"),   "backend should be dispatched");
    assert.ok(dispatched.includes("platform"),  "platform should be dispatched");
    assert.ok(dispatched.includes("qa"),        "qa should be dispatched");
  });

  it("dispatches all workstreams when no gates exist and skip-completed is not set", () => {
    const cwd = track(makeTargetProject());
    const plan = runStage("build", { cwd });
    assert.equal(plan.workstreams.length, 4);
    // None skipped — all four present in plan
    const roles = plan.workstreams.map((w) => w.role).sort();
    assert.deepEqual(roles, ["backend", "frontend", "platform", "qa"]);
  });

  it("emits queued and queue timing events under host concurrency limits", async () => {
    const cwd = track(makeTargetProject({
      config: [
        "routing:",
        "  default_host: claude-code",
        "  host_concurrency:",
        "    claude-code: 1",
        "pipeline:",
        "  default_track: full",
        "",
      ].join("\n"),
    }));
    for (const role of ["backend", "frontend", "platform", "qa"]) {
      seedGate(cwd, `stage-04.${role}`, {
        stage: "stage-04", workstream: role, status: "PASS",
      });
    }
    const events = [];
    const result = await runStageHeadless("build", {
      cwd,
      skipCompleted: true,
      onWorkstreamEvent: (event) => events.push(event),
    });

    assert.equal(result.results.length, 4);
    assert.equal(events.filter((event) => event.type === "workstream-queued").length, 4);
    assert.equal(events.filter((event) => event.type === "workstream-finished").length, 4);
    assert.ok(events.some((event) => event.queue_limit === 1));
    assert.ok(result.results.every((item) => typeof item.queueMs === "number"));
  });
});

// ─── Fix 1.7.1: summary() must not crash on a status-less gate ────────────
// Regression for: gate.status.toLowerCase() throws TypeError when status is
// absent. Fixed by (gate.status || "unknown").toLowerCase() in orchestrator.js.
// (plans/phase-1-trust-consolidation.md item 1.7 fix 1)
describe("orchestrator: summary() — status-less gate", () => {
  it("summary() returns unknown state when merged gate file contains {} (no status field)", () => {
    const cwd = track(makeTargetProject());
    // Write a gate file that is valid JSON but has no `status` field.
    const gatesDir = path.join(cwd, "pipeline", "gates");
    fs.mkdirSync(gatesDir, { recursive: true });
    fs.writeFileSync(path.join(gatesDir, "stage-01.json"), JSON.stringify({}));

    // Must not throw — before the fix, gate.status.toLowerCase() would throw TypeError.
    let result;
    assert.doesNotThrow(() => { result = summary({ cwd }); });

    const row = result.rows.find((r) => r.stage === "stage-01");
    assert.ok(row, "stage-01 row should be present");
    assert.equal(row.state, "unknown", "status-less gate should render as 'unknown'");
  });

  it("summary() returns unknown state for a workstream entry missing status in the workstreams[] array", () => {
    const cwd = track(makeTargetProject());
    // A merged gate with a workstreams array containing an entry with no status field.
    const gatesDir = path.join(cwd, "pipeline", "gates");
    fs.mkdirSync(gatesDir, { recursive: true });
    const gate = {
      stage: "stage-04",
      status: "PASS",
      workstreams: [
        { workstream: "backend", host: "claude-code" },   // no status — crash before fix
        { workstream: "frontend", host: "claude-code", status: "PASS" },
      ],
    };
    fs.writeFileSync(path.join(gatesDir, "stage-04.json"), JSON.stringify(gate));

    let result;
    assert.doesNotThrow(() => { result = summary({ cwd }); });

    const row = result.rows.find((r) => r.stage === "stage-04");
    assert.ok(row, "stage-04 row should be present");
    assert.ok(Array.isArray(row.workstreams), "workstreams array should be present");
    const backendWs = row.workstreams.find((w) => w.role === "backend");
    assert.equal(backendWs.state, "unknown", "workstream without status should render as 'unknown'");
    const frontendWs = row.workstreams.find((w) => w.role === "frontend");
    assert.equal(frontendWs.state, "pass", "workstream with PASS status should render as 'pass'");
  });
});

describe("orchestrator: --workstream filter (Fix 3.7.6)", () => {
  // The filter must be applied BEFORE prompt rendering and shared by both
  // headless and non-headless modes. Defined once in runStage (orchestrator).

  it("non-headless: --workstream backend returns only backend workstream", () => {
    const cwd = track(makeTargetProject());
    const r = runStage("build", { cwd, workstream: ["backend"] });
    assert.equal(r.workstreams.length, 1);
    assert.equal(r.workstreams[0].role, "backend");
    // roles[] reflects filtered set
    assert.deepEqual(r.roles, ["backend"]);
  });

  it("non-headless: --workstream frontend,qa returns two workstreams", () => {
    const cwd = track(makeTargetProject());
    const r = runStage("build", { cwd, workstream: ["frontend", "qa"] });
    assert.equal(r.workstreams.length, 2);
    const roles = r.workstreams.map((w) => w.role).sort();
    assert.deepEqual(roles, ["frontend", "qa"]);
  });

  it("non-headless: --workstream with unknown role throws", () => {
    const cwd = track(makeTargetProject());
    assert.throws(
      () => runStage("build", { cwd, workstream: ["nonexistent"] }),
      /--workstream filter matched no roles/,
    );
  });

  it("non-headless: no --workstream returns all workstreams (unfiltered)", () => {
    const cwd = track(makeTargetProject());
    const r = runStage("build", { cwd });
    assert.equal(r.workstreams.length, 4);
  });

  it("fanout: --workstream backend selects all fanout instances of backend", () => {
    // Role-prefix match rule: for fanout, ws.role is the bare role name even
    // when workstreamId = "stage-05.backend.claude-code". All fanout instances
    // of a role are selected by filtering on ws.role.
    const cwd = track(makeTargetProject({
      config: `routing:
  default_host: generic
  review_fanout: [claude-code, codex]
pipeline:
  default_track: full
`,
    }));
    const r = runStage("peer-review", { cwd, workstream: ["backend"] });
    // 2 fanout hosts × 1 role = 2 workstreams
    assert.equal(r.workstreams.length, 2);
    assert.ok(r.workstreams.every((w) => w.role === "backend"));
    // Both fanout hosts present
    const hosts = r.workstreams.map((w) => w.host).sort();
    assert.deepEqual(hosts, ["claude-code", "codex"]);
  });

  it("both modes produce identical workstream sets for the same filter", () => {
    // Non-headless (runStage) and headless (runStageHeadless) use the same
    // filter in runStage, so this test exercises the shared path.
    const cwd = track(makeTargetProject());
    const r = runStage("build", { cwd, workstream: ["platform"] });
    assert.equal(r.workstreams.length, 1);
    assert.equal(r.workstreams[0].role, "platform");
    assert.equal(r.workstreams[0].descriptor.workstreamId, "stage-04.platform");
  });
});

describe("orchestrator: experimental Omnigent director", () => {
  function omnigentConfig() {
    return `routing:
  default_host: omnigent
pipeline:
  default_track: full
`;
  }

  function makeDirectorStub(roles) {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "stagecraft-director-stub-"));
    _dirs.push(dir);
    const script = path.join(dir, "director-stub.js");
    const record = path.join(dir, "invocation.json");
    fs.writeFileSync(script, `const fs = require("node:fs");
const path = require("node:path");
const record = process.argv[2];
const args = process.argv.slice(3);
const gatesDir = path.join(process.cwd(), "pipeline", "gates");
fs.mkdirSync(gatesDir, { recursive: true });
for (const role of ${JSON.stringify(roles)}) {
  fs.writeFileSync(path.join(gatesDir, \`stage-04.\${role}.json\`), JSON.stringify({
    stage: "stage-04",
    workstream: role,
    host: "omnigent",
    status: "PASS",
    track: "full",
    blockers: [],
    warnings: [],
    orchestrator: "devteam@test",
    timestamp: "2026-07-02T00:00:00.000Z"
  }, null, 2) + "\\n");
}
fs.writeFileSync(record, JSON.stringify({ args }, null, 2) + "\\n");
`, "utf8");
    return { script, record };
  }

  it("renders a director prompt with every child gate and original workstream prompt", () => {
    const cwd = track(makeTargetProject({ config: omnigentConfig() }));
    const plan = runStage("build", { cwd, feature: "add health endpoint" });
    const prompt = renderOmnigentDirectorPrompt(plan);

    assert.match(prompt, /Omnigent Director Experiment/);
    assert.match(prompt, /Feature: add health endpoint/);
    assert.match(prompt, /pipeline\/gates\/stage-04\.backend\.json/);
    assert.match(prompt, /pipeline\/gates\/stage-04\.frontend\.json/);
    assert.match(prompt, /pipeline\/gates\/stage-04\.platform\.json/);
    assert.match(prompt, /pipeline\/gates\/stage-04\.qa\.json/);
    assert.match(prompt, /Do not write a director gate/);
    assert.match(prompt, /### backend \(stage-04\.backend\)/);
    assert.match(prompt, /Workstream: stage-04\.qa/);
  });

  it("invokes Omnigent once and maps generated child gates back to workstreams", async () => {
    const cwd = track(makeTargetProject({ config: omnigentConfig() }));
    const { script, record } = makeDirectorStub(["backend", "frontend", "platform", "qa"]);
    const previous = process.env.DEVTEAM_HEADLESS_COMMAND;
    const events = [];
    process.env.DEVTEAM_HEADLESS_COMMAND = `${process.execPath} ${script} ${record}`;
    try {
      const result = await runStageHeadless("build", {
        cwd,
        feature: "add hello world endpoint",
        experimentalOmnigentDirector: true,
        onWorkstreamEvent: (event) => events.push(event),
      });

      assert.equal(result.experimentalDirector, "omnigent");
      assert.equal(result.results.length, 4);
      assert.ok(result.results.every((r) => r.exitCode === 0));
      assert.ok(result.results.every((r) => r.director === true));
      assert.ok(result.results.every((r) => r.directorWorkstreamId === "stage-04.omnigent-director"));
      assert.ok(result.results.every((r) => r.gatePath && fs.existsSync(r.gatePath)));

      const invocation = JSON.parse(fs.readFileSync(record, "utf8"));
      assert.equal(invocation.args[0], "--prompt");
      assert.match(invocation.args[1], /Omnigent Director Experiment/);
      assert.match(invocation.args[1], /stage-04\.backend/);
      assert.match(invocation.args[1], /stage-04\.qa/);
      assert.equal(events.filter((event) => event.type === "workstream-started").length, 4);
      assert.equal(events.filter((event) => event.type === "workstream-finished").length, 4);
      assert.ok(events.every((event) => event.director === true));
      assert.ok(events.every((event) => event.prompt_bytes > 0));
      assert.ok(events.every((event) => typeof event.context_manifest_files === "number"));
      assert.ok(events.some((event) => event.workstream_id === "stage-04.backend" && event.gate_path.endsWith("stage-04.backend.json")));
      assert.ok(events.some((event) => event.workstream_id === "stage-04.qa" && event.log_path.endsWith("stage-04.omnigent-director.log")));
    } finally {
      if (previous === undefined) delete process.env.DEVTEAM_HEADLESS_COMMAND;
      else process.env.DEVTEAM_HEADLESS_COMMAND = previous;
    }
  });

  it("rejects director mode for single-workstream stages", async () => {
    const cwd = track(makeTargetProject({ config: omnigentConfig() }));

    await assert.rejects(
      () => runStageHeadless("requirements", { cwd, experimentalOmnigentDirector: true }),
      /requires a multi-workstream stage/,
    );
  });

  it("rejects director mode when any planned workstream routes away from Omnigent", async () => {
    const cwd = track(makeTargetProject({
      config: `routing:
  default_host: omnigent
  roles:
    qa: codex
pipeline:
  default_track: full
`,
    }));

    await assert.rejects(
      () => runStageHeadless("build", { cwd, experimentalOmnigentDirector: true }),
      /qa:codex/,
    );
  });
});

describe("orchestrator: mergeWorkstreamGates unpriced model warning (Fix 3.7.7)", () => {
  const roles = ["backend", "frontend", "platform", "qa"];

  function seedBuild(cwd, overrides = {}) {
    roles.forEach((role) => {
      seedGate(cwd, `stage-04.${role}`, {
        stage: "stage-04",
        workstream: role,
        host: "future-host",
        status: "PASS",
        ...overrides,
      });
    });
  }

  it("gate with tokens for unknown model → warning present in merged gate", () => {
    const cwd = track(makeTargetProject());
    seedBuild(cwd, { model: "future-model-9", tokens_in: 5000, tokens_out: 2000 });
    const r = mergeWorkstreamGates("build", { cwd });
    assert.equal(r.merged, true);
    // At least one warning per unpriced workstream
    assert.ok(r.gate.warnings.some((w) => w.includes("unpriced model future-model-9")));
    assert.ok(r.gate.warnings.some((w) => w.includes("budget enforcement incomplete")));
  });

  it("gate with tokens for unknown model → totals unchanged (not silently zeroed)", () => {
    const cwd = track(makeTargetProject());
    seedBuild(cwd, { model: "future-model-9", tokens_in: 5000, tokens_out: 2000 });
    const r = mergeWorkstreamGates("build", { cwd });
    // Token totals are still summed correctly
    assert.equal(r.gate.tokens_in, 5000 * roles.length);
    assert.equal(r.gate.tokens_out, 2000 * roles.length);
    // No cost_usd emitted when model is unpriced (not silently zero)
    assert.equal(r.gate.cost_usd, undefined);
  });

  it("gate with tokens for known model → no unpriced warning", () => {
    const cwd = track(makeTargetProject());
    seedBuild(cwd, { model: "claude-sonnet-4-6", tokens_in: 5000, tokens_out: 2000, cost_usd: 0.05 });
    const r = mergeWorkstreamGates("build", { cwd });
    const unpricedWarnings = r.gate.warnings.filter((w) => w.includes("unpriced model"));
    assert.equal(unpricedWarnings.length, 0);
  });

  it("gate with no model field → no warning (only model-named tokens are flagged)", () => {
    const cwd = track(makeTargetProject());
    seedBuild(cwd, { tokens_in: 5000, tokens_out: 2000 });
    const r = mergeWorkstreamGates("build", { cwd });
    const unpricedWarnings = r.gate.warnings.filter((w) => w.includes("unpriced model"));
    assert.equal(unpricedWarnings.length, 0);
  });

  // ─── 5.2: prune-on-PASS via mergeWorkstreamGates ────────────────────────────

  it("(5.2) mergeWorkstreamGates prunes archives when merged gate reaches PASS", () => {
    const cwd = track(makeTargetProject());
    // Seed per-workstream gates that all PASS (simulating recovery after prior failures).
    seedBuild(cwd);
    // Seed archives for stage-04 from previous failures.
    const gd = path.join(cwd, "pipeline", "gates");
    const archiveDir = path.join(gd, "archive");
    fs.mkdirSync(archiveDir, { recursive: true });
    for (const n of [1, 2]) {
      fs.writeFileSync(
        path.join(archiveDir, `stage-04.attempt-${n}.json`),
        JSON.stringify({ stage: "stage-04", blockers: ["tests were failing"], status: "FAIL" }),
      );
    }
    assert.equal(listArchives(gd, "stage-04").length, 2, "archives exist before merge");

    const r = mergeWorkstreamGates("build", { cwd });
    assert.equal(r.gate.status, "PASS");
    assert.equal(listArchives(gd, "stage-04").length, 0, "archives pruned after PASS merge");
  });

  it("(5.2) mergeWorkstreamGates does NOT prune archives when merged gate is FAIL", () => {
    const cwd = track(makeTargetProject());
    seedBuild(cwd, { status: "FAIL" });
    const gd = path.join(cwd, "pipeline", "gates");
    const archiveDir = path.join(gd, "archive");
    fs.mkdirSync(archiveDir, { recursive: true });
    fs.writeFileSync(
      path.join(archiveDir, "stage-04.attempt-1.json"),
      JSON.stringify({ stage: "stage-04", blockers: ["x"], status: "FAIL" }),
    );
    mergeWorkstreamGates("build", { cwd });
    assert.equal(listArchives(gd, "stage-04").length, 1, "archives preserved on FAIL merge");
  });
});

describe("orchestrator: patchGateForUnpricedModel — single-role path (Fix 6.5.1)", () => {
  it("unpriced model + tokens_in → warning added to gate", () => {
    const cwd = track(makeTargetProject());
    const gateFile = seedGate(cwd, "stage-01", {
      stage: "stage-01",
      model: "future-model-x",
      tokens_in: 3000,
      tokens_out: 1200,
      status: "PASS",
    });
    patchGateForUnpricedModel(gateFile);
    const gate = JSON.parse(fs.readFileSync(gateFile, "utf8"));
    assert.ok(gate.warnings.some((w) => w.includes("unpriced model future-model-x")));
    assert.ok(gate.warnings.some((w) => w.includes("budget enforcement incomplete")));
    // Totals must be unchanged
    assert.equal(gate.tokens_in, 3000);
    assert.equal(gate.tokens_out, 1200);
  });

  it("known model → no warning added", () => {
    const cwd = track(makeTargetProject());
    const gateFile = seedGate(cwd, "stage-01", {
      model: "claude-sonnet-4-6",
      tokens_in: 3000,
      tokens_out: 1200,
      status: "PASS",
    });
    patchGateForUnpricedModel(gateFile);
    const gate = JSON.parse(fs.readFileSync(gateFile, "utf8"));
    const unpricedWarnings = gate.warnings.filter((w) => w.includes("unpriced model"));
    assert.equal(unpricedWarnings.length, 0);
  });

  it("missing model field → no warning (only model-named tokens flagged)", () => {
    const cwd = track(makeTargetProject());
    const gateFile = seedGate(cwd, "stage-01", { tokens_in: 3000, status: "PASS" });
    patchGateForUnpricedModel(gateFile);
    const gate = JSON.parse(fs.readFileSync(gateFile, "utf8"));
    const unpricedWarnings = gate.warnings.filter((w) => w.includes("unpriced model"));
    assert.equal(unpricedWarnings.length, 0);
  });

  it("idempotent — calling twice does not duplicate the warning", () => {
    const cwd = track(makeTargetProject());
    const gateFile = seedGate(cwd, "stage-01", {
      model: "future-model-x",
      tokens_in: 3000,
      status: "PASS",
    });
    patchGateForUnpricedModel(gateFile);
    patchGateForUnpricedModel(gateFile);
    const gate = JSON.parse(fs.readFileSync(gateFile, "utf8"));
    const count = gate.warnings.filter((w) => w.includes("unpriced model future-model-x")).length;
    assert.equal(count, 1);
  });
});
