// Tests for G1: multi-model adversarial peer review (review_fanout).

const { describe, it, afterEach } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { spawnSync } = require("node:child_process");
const { REPO_ROOT, makeTargetProject, seedGate, cleanup } = require("./_helpers");
const { computeDispatchPlan, mergeWorkstreamGates, runStage } =
  require(path.join(REPO_ROOT, "core", "orchestrator"));
const { getStage } = require(path.join(REPO_ROOT, "core", "pipeline", "stages"));
const { hostFromPath, KNOWN_HOSTS } =
  require(path.join(REPO_ROOT, "core", "hooks", "approval-derivation"));

let _dirs = [];
function track(cwd) { _dirs.push(cwd); return cwd; }
afterEach(() => { _dirs.forEach(cleanup); _dirs = []; });

describe("fanout: computeDispatchPlan", () => {
  it("returns one entry per role when fanout is empty", () => {
    const plan = computeDispatchPlan(getStage("peer-review"), { routing: { review_fanout: [] } });
    assert.equal(plan.length, 4); // backend, frontend, platform, qa
    assert.ok(plan.every((p) => p.fanout === false));
    assert.ok(plan.every((p) => p.hostName === null));
  });

  it("returns N×M entries when fanout is set on peer-review", () => {
    const plan = computeDispatchPlan(getStage("peer-review"), {
      routing: { review_fanout: ["claude-code", "codex", "gemini-cli"] },
    });
    assert.equal(plan.length, 12); // 4 areas × 3 hosts
    assert.ok(plan.every((p) => p.fanout === true));
    // Every (area, host) combo present
    const seen = new Set(plan.map((p) => `${p.role}.${p.hostName}`));
    for (const area of ["backend", "frontend", "platform", "qa"]) {
      for (const host of ["claude-code", "codex", "gemini-cli"]) {
        assert.ok(seen.has(`${area}.${host}`), `missing ${area}.${host}`);
      }
    }
  });

  it("uses 3-segment workstreamId for fanout entries", () => {
    const plan = computeDispatchPlan(getStage("peer-review"), {
      routing: { review_fanout: ["claude-code", "codex"] },
    });
    assert.ok(plan.every((p) => /^stage-05\.\w+\.[\w-]+$/.test(p.workstreamId)));
    const sample = plan.find((p) => p.role === "backend" && p.hostName === "claude-code");
    assert.equal(sample.workstreamId, "stage-05.backend.claude-code");
    assert.equal(sample.gateFile, "stage-05.backend.claude-code.json");
  });

  it("fanout doesn't apply to non-peer-review stages", () => {
    // Even with review_fanout set, stage-04 (build) should dispatch normally
    const plan = computeDispatchPlan(getStage("build"), {
      routing: { review_fanout: ["claude-code", "codex", "gemini-cli"] },
    });
    assert.equal(plan.length, 4); // 4 build roles, NOT 12
    assert.ok(plan.every((p) => p.fanout === false));
  });

  it("single-role stages produce a single entry", () => {
    const plan = computeDispatchPlan(getStage("requirements"), { routing: { review_fanout: [] } });
    assert.equal(plan.length, 1);
    assert.equal(plan[0].workstreamId, "stage-01");
  });
});

describe("fanout: runStage dispatches all combos in parallel", () => {
  // 34.4: this test dispatches for real (runStage resolves + renders via
  // each host's actual adapter), unlike the computeDispatchPlan/
  // mergeWorkstreamGates tests above and below which only need host name
  // strings. gemini-cli moved to a plugin package not installed under
  // node_modules in this dev checkout, so antigravity (also first-party,
  // also headless) stands in as the third host — the fanout mechanics
  // under test don't depend on which specific hosts are used.
  it("produces 12 prompts for 3-host fanout × 4 areas", () => {
    const cwd = track(makeTargetProject({
      config: `routing:
  default_host: generic
  review_fanout: [claude-code, codex, antigravity]
pipeline:
  default_track: full
`,
    }));
    const r = runStage("peer-review", { cwd });
    assert.equal(r.workstreams.length, 12);
    // Each workstream should know its host
    const hosts = new Set(r.workstreams.map((w) => w.host));
    assert.equal(hosts.size, 3);
    assert.ok(hosts.has("claude-code"));
    assert.ok(hosts.has("codex"));
    assert.ok(hosts.has("antigravity"));
    // Every workstream has a 3-segment id
    assert.ok(r.workstreams.every((w) => /^stage-05\.\w+\.[\w-]+$/.test(w.descriptor.workstreamId)));
  });

  it("without fanout, peer-review behaves as before (4 prompts, all on default_host)", () => {
    const cwd = track(makeTargetProject());
    const r = runStage("peer-review", { cwd });
    assert.equal(r.workstreams.length, 4);
    // Generic-default config
    assert.ok(r.workstreams.every((w) => w.host === "generic"));
    assert.ok(r.workstreams.every((w) => /^stage-05\.\w+$/.test(w.descriptor.workstreamId)));
  });
});

describe("fanout: mergeWorkstreamGates aggregates 3-segment gates", () => {
  function seedFanout(cwd, statuses) {
    // statuses is { "<area>.<host>": "PASS|WARN|FAIL|ESCALATE" }
    for (const [k, status] of Object.entries(statuses)) {
      const [area, host] = k.split(".");
      seedGate(cwd, `stage-05.${area}.${host}`, {
        stage: "stage-05",
        workstream: area,
        host,
        status,
      });
    }
  }

  it("PASS across 12 fanout gates → merged PASS", () => {
    const cwd = track(makeTargetProject({
      config: `routing:
  default_host: generic
  review_fanout: [claude-code, codex, gemini-cli]
pipeline:
  default_track: full
`,
    }));
    const statuses = {};
    for (const a of ["backend", "frontend", "platform", "qa"]) {
      for (const h of ["claude-code", "codex", "gemini-cli"]) {
        statuses[`${a}.${h}`] = "PASS";
      }
    }
    seedFanout(cwd, statuses);
    const r = mergeWorkstreamGates("peer-review", { cwd });
    assert.equal(r.merged, true);
    assert.equal(r.gate.status, "PASS");
    assert.equal(r.gate.workstreams.length, 12);
  });

  it("one FAIL among 12 → merged FAIL (pessimistic policy)", () => {
    const cwd = track(makeTargetProject({
      config: `routing:
  default_host: generic
  review_fanout: [claude-code, codex, gemini-cli]
pipeline:
  default_track: full
`,
    }));
    const statuses = {};
    for (const a of ["backend", "frontend", "platform", "qa"]) {
      for (const h of ["claude-code", "codex", "gemini-cli"]) {
        statuses[`${a}.${h}`] = "PASS";
      }
    }
    statuses["backend.codex"] = "FAIL";
    seedFanout(cwd, statuses);
    const r = mergeWorkstreamGates("peer-review", { cwd });
    assert.equal(r.gate.status, "FAIL");
  });

  it("missing fanout gate → merge not yet ready", () => {
    const cwd = track(makeTargetProject({
      config: `routing:
  default_host: generic
  review_fanout: [claude-code, codex]
pipeline:
  default_track: full
`,
    }));
    // Only 7 of the expected 8 gates
    seedFanout(cwd, {
      "backend.claude-code":  "PASS", "backend.codex":  "PASS",
      "frontend.claude-code": "PASS", "frontend.codex": "PASS",
      "platform.claude-code": "PASS", "platform.codex": "PASS",
      "qa.claude-code":       "PASS",
      // missing: qa.codex
    });
    const r = mergeWorkstreamGates("peer-review", { cwd });
    assert.equal(r.merged, false);
    assert.match(r.reason, /missing workstream gate.*qa\.codex/);
  });
});

describe("fanout: approval-derivation hostFromPath", () => {
  it("detects host-based filenames", () => {
    assert.equal(hostFromPath("/p/by-claude-code.md"), "claude-code");
    assert.equal(hostFromPath("/p/by-codex.md"), "codex");
    assert.equal(hostFromPath("/p/by-gemini-cli.md"), "gemini-cli");
  });

  it("returns null for role-based filenames", () => {
    assert.equal(hostFromPath("/p/by-backend.md"), null);
    assert.equal(hostFromPath("/p/by-security.md"), null);
  });

  it("returns null for unknown hosts", () => {
    assert.equal(hostFromPath("/p/by-someotherhost.md"), null);
  });

  it("KNOWN_HOSTS includes all installed adapter names", () => {
    for (const h of ["claude-code", "codex", "gemini-cli", "generic"]) {
      assert.ok(KNOWN_HOSTS.has(h), `KNOWN_HOSTS missing ${h}`);
    }
  });
});

describe("fanout: approval-derivation end-to-end with host-based files", () => {
  const HOOK = path.join(REPO_ROOT, "core", "hooks", "approval-derivation.js");
  function runHook(cwd) {
    const r = spawnSync("node", [HOOK], { cwd, encoding: "utf8" });
    return { status: r.status, stdout: r.stdout || "", stderr: r.stderr || "" };
  }

  it("by-codex.md writes stage-05.<area>.codex.json (fanout naming)", () => {
    const cwd = track(makeTargetProject({
      config: `routing:
  default_host: generic
  review_fanout: [claude-code, codex]
pipeline:
  default_track: full
`,
    }));
    fs.mkdirSync(path.join(cwd, "pipeline", "code-review"), { recursive: true });
    fs.writeFileSync(
      path.join(cwd, "pipeline", "code-review", "by-codex.md"),
      "## Review of backend\nLGTM\nREVIEW: APPROVED\n\n## Review of frontend\nLGTM\nREVIEW: APPROVED\n",
    );
    runHook(cwd);
    // We expect host-suffixed gates
    assert.ok(fs.existsSync(path.join(cwd, "pipeline", "gates", "stage-05.backend.codex.json")));
    assert.ok(fs.existsSync(path.join(cwd, "pipeline", "gates", "stage-05.frontend.codex.json")));
    // And NOT the canonical bare-area gate
    assert.ok(!fs.existsSync(path.join(cwd, "pipeline", "gates", "stage-05.backend.json")));
  });

  it("by-backend.md (role-based) still writes canonical stage-05.<area>.json", () => {
    const cwd = track(makeTargetProject());
    fs.mkdirSync(path.join(cwd, "pipeline", "code-review"), { recursive: true });
    fs.writeFileSync(
      path.join(cwd, "pipeline", "code-review", "by-backend.md"),
      "## Review of frontend\nLGTM\nREVIEW: APPROVED\n",
    );
    runHook(cwd);
    assert.ok(fs.existsSync(path.join(cwd, "pipeline", "gates", "stage-05.frontend.json")));
    // No host-suffixed gate written
    const files = fs.readdirSync(path.join(cwd, "pipeline", "gates"));
    assert.ok(!files.some((f) => f.includes(".claude-code.")));
  });
});
