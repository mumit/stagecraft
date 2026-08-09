"use strict";

const { afterEach, describe, it } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { execFileSync } = require("node:child_process");

const { REPO_ROOT, cleanup } = require("./_helpers");
const {
  WorkstreamIsolation,
  shouldIsolateBuildWorkstreams,
} = require(path.join(REPO_ROOT, "core", "workstream-isolation"));
const { runStageHeadless } = require(path.join(REPO_ROOT, "core", "orchestrator"));

const dirs = [];
afterEach(() => {
  for (const dir of dirs) cleanup(dir);
  dirs.length = 0;
});

function project() {
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "stagecraft-isolation-"));
  dirs.push(cwd);
  execFileSync("git", ["init", "-q"], { cwd });
  execFileSync("git", ["config", "user.email", "tests@example.com"], { cwd });
  execFileSync("git", ["config", "user.name", "Stagecraft Tests"], { cwd });
  fs.mkdirSync(path.join(cwd, "src", "backend"), { recursive: true });
  fs.mkdirSync(path.join(cwd, "src", "frontend"), { recursive: true });
  fs.writeFileSync(path.join(cwd, ".gitignore"), ".devteam/worktrees/\npipeline/logs/\n", "utf8");
  fs.writeFileSync(path.join(cwd, "shared.txt"), "one\ntwo\nthree\n", "utf8");
  fs.writeFileSync(path.join(cwd, "src", "backend", "base.js"), "module.exports = 1;\n", "utf8");
  execFileSync("git", ["add", "."], { cwd });
  execFileSync("git", ["commit", "-qm", "baseline"], { cwd });
  fs.mkdirSync(path.join(cwd, "pipeline"), { recursive: true });
  fs.writeFileSync(path.join(cwd, "pipeline", "context.md"), "ignored operational context\n", "utf8");
  return cwd;
}

function workstream(id, allowedWrites) {
  return { role: id.split(".").at(-1), descriptor: { workstreamId: id, allowedWrites } };
}

describe("git-worktree build isolation", () => {
  it("starts every role from the same tracked, untracked, and ignored baseline", () => {
    const cwd = project();
    fs.writeFileSync(path.join(cwd, "untracked.txt"), "visible\n", "utf8");
    fs.writeFileSync(path.join(cwd, "shared.txt"), "dirty baseline\n", "utf8");
    const streams = [
      workstream("stage-04.backend", ["src/backend/"]),
      workstream("stage-04.frontend", ["src/frontend/"]),
    ];
    const isolation = new WorkstreamIsolation({ cwd, stage: "stage-04", workstreams: streams }).prepareAll();
    try {
      for (const ws of streams) {
        const workspace = isolation.entryFor(ws).workspace;
        assert.equal(fs.readFileSync(path.join(workspace, "shared.txt"), "utf8"), "dirty baseline\n");
        assert.equal(fs.readFileSync(path.join(workspace, "untracked.txt"), "utf8"), "visible\n");
        assert.equal(
          fs.readFileSync(path.join(workspace, "pipeline", "context.md"), "utf8"),
          "ignored operational context\n",
        );
      }
    } finally {
      isolation.cleanupAll();
    }
  });

  it("reconciles authorized writes and refuses unauthorized ones", () => {
    const cwd = project();
    const ws = workstream("stage-04.backend", ["src/backend/", "pipeline/gates/stage-04.backend.json"]);
    const isolation = new WorkstreamIsolation({ cwd, stage: "stage-04", workstreams: [ws] }).prepareAll();
    const workspace = isolation.entryFor(ws).workspace;
    fs.writeFileSync(path.join(workspace, "src", "backend", "feature.js"), "module.exports = 2;\n", "utf8");
    fs.mkdirSync(path.join(workspace, "src", "frontend"), { recursive: true });
    fs.writeFileSync(path.join(workspace, "src", "frontend", "escape.js"), "not allowed\n", "utf8");
    const gate = path.join(workspace, "pipeline", "gates", "stage-04.backend.json");
    fs.mkdirSync(path.dirname(gate), { recursive: true });
    fs.writeFileSync(gate, "{}\n", "utf8");
    const patched = [];
    const result = isolation.reconcile(ws, {
      gatePath: gate,
      logPath: null,
      patchGate: (_gatePath, findings) => patched.push(...findings.violations),
    });
    isolation.cleanupAll();

    assert.equal(fs.readFileSync(path.join(cwd, "src", "backend", "feature.js"), "utf8"), "module.exports = 2;\n");
    assert.equal(fs.existsSync(path.join(cwd, "src", "frontend", "escape.js")), false);
    assert.deepEqual(result.violations, ["src/frontend/escape.js"]);
    assert.deepEqual(patched, ["src/frontend/escape.js"]);
  });

  it("three-way merges non-overlapping edits to a shared authorized file", () => {
    const cwd = project();
    const first = workstream("stage-04.backend", ["shared.txt"]);
    const second = workstream("stage-04.platform", ["shared.txt"]);
    const isolation = new WorkstreamIsolation({ cwd, stage: "stage-04", workstreams: [first, second] }).prepareAll();
    const firstFile = path.join(isolation.entryFor(first).workspace, "shared.txt");
    const secondFile = path.join(isolation.entryFor(second).workspace, "shared.txt");
    fs.writeFileSync(firstFile, "ONE\ntwo\nthree\n", "utf8");
    fs.writeFileSync(secondFile, "one\ntwo\nTHREE\n", "utf8");

    assert.deepEqual(isolation.reconcile(first, { gatePath: null, logPath: null }).conflicts, []);
    assert.deepEqual(isolation.reconcile(second, { gatePath: null, logPath: null }).conflicts, []);
    isolation.cleanupAll();
    assert.equal(fs.readFileSync(path.join(cwd, "shared.txt"), "utf8"), "ONE\ntwo\nTHREE\n");
  });

  it("reports overlapping edits instead of taking the last writer", () => {
    const cwd = project();
    const first = workstream("stage-04.backend", ["shared.txt"]);
    const second = workstream("stage-04.platform", ["shared.txt"]);
    const isolation = new WorkstreamIsolation({ cwd, stage: "stage-04", workstreams: [first, second] }).prepareAll();
    fs.writeFileSync(path.join(isolation.entryFor(first).workspace, "shared.txt"), "backend\ntwo\nthree\n", "utf8");
    fs.writeFileSync(path.join(isolation.entryFor(second).workspace, "shared.txt"), "platform\ntwo\nthree\n", "utf8");

    isolation.reconcile(first, { gatePath: null, logPath: null });
    const result = isolation.reconcile(second, { gatePath: null, logPath: null });
    isolation.cleanupAll();
    assert.deepEqual(result.conflicts, ["shared.txt"]);
    assert.equal(fs.readFileSync(path.join(cwd, "shared.txt"), "utf8"), "backend\ntwo\nthree\n");
  });

  it("does not reconcile a new symlink that escapes the isolated workspace", () => {
    const cwd = project();
    const ws = workstream("stage-04.backend", ["src/backend/"]);
    const isolation = new WorkstreamIsolation({ cwd, stage: "stage-04", workstreams: [ws] }).prepareAll();
    const link = path.join(isolation.entryFor(ws).workspace, "src", "backend", "escape");
    fs.symlinkSync("../../../../outside", link);
    const result = isolation.reconcile(ws, { gatePath: null, logPath: null });
    isolation.cleanupAll();
    assert.deepEqual(result.violations, ["src/backend/escape"]);
    assert.equal(fs.existsSync(path.join(cwd, "src", "backend", "escape")), false);
  });
});

describe("shouldIsolateBuildWorkstreams", () => {
  it("is opt-in and limited to parallel build roles", () => {
    const config = { pipeline: { workstream_isolation: "git-worktree" } };
    assert.equal(shouldIsolateBuildWorkstreams(config, { stage: "stage-04", workstreams: [{}, {}] }), true);
    assert.equal(shouldIsolateBuildWorkstreams(config, { stage: "stage-04", workstreams: [{}] }), false);
    assert.equal(shouldIsolateBuildWorkstreams(config, { stage: "stage-05", workstreams: [{}, {}] }), false);
    assert.equal(shouldIsolateBuildWorkstreams({ pipeline: {} }, { stage: "stage-04", workstreams: [{}, {}] }), false);
  });
});

describe("orchestrator isolated build integration", () => {
  it("runs each headless role in its own cwd and reconciles all role-owned outputs", async () => {
    const cwd = project();
    fs.mkdirSync(path.join(cwd, ".devteam"), { recursive: true });
    fs.writeFileSync(path.join(cwd, ".devteam", "config.yml"), [
      "routing:",
      "  default_host: claude-code",
      "pipeline:",
      "  default_track: full",
      "  workstream_isolation: git-worktree",
      "prompts:",
      "  inline_framework: false",
      "",
    ].join("\n"), "utf8");
    fs.writeFileSync(path.join(cwd, "package.json"), JSON.stringify({
      scripts: {
        lint: "node -e \"process.exit(0)\"",
        test: "node -e \"process.exit(0)\"",
      },
    }, null, 2) + "\n", "utf8");
    const script = path.join(cwd, "isolated-agent.js");
    fs.writeFileSync(script, `
const fs = require("node:fs");
const path = require("node:path");
process.stdin.resume();
process.stdin.on("end", () => {
  const role = path.basename(process.cwd()).split(".").at(-1);
  const roleDir = { backend: "src/backend", frontend: "src/frontend", platform: "src/infra", qa: "src/tests" }[role];
  fs.mkdirSync(roleDir, { recursive: true });
  fs.writeFileSync(path.join(roleDir, "from-" + role + ".txt"), process.cwd() + "\\n");
  if (role === "backend" || role === "platform") {
    fs.writeFileSync("package.json", JSON.stringify({
      owner: role,
      scripts: { lint: "node -e 'process.exit(0)'", test: "node -e 'process.exit(0)'" },
    }, null, 2) + "\\n");
  }
  fs.mkdirSync("pipeline/gates", { recursive: true });
  fs.writeFileSync("pipeline/gates/stage-04." + role + ".json", JSON.stringify({
    stage: "stage-04", workstream: role, host: "claude-code", status: "PASS",
    track: "full", blockers: [], warnings: [], orchestrator: "devteam@test",
    timestamp: new Date().toISOString(), lint_passed: true, tests_passed: true,
  }, null, 2) + "\\n");
});
`, "utf8");
    const previousCommand = process.env.DEVTEAM_HEADLESS_COMMAND;
    const previousNoLog = process.env.DEVTEAM_NO_LOG;
    process.env.DEVTEAM_HEADLESS_COMMAND = `${process.execPath} ${script}`;
    process.env.DEVTEAM_NO_LOG = "1";
    try {
      const result = await runStageHeadless("build", { cwd });
      assert.equal(result.results.length, 4);
      for (const role of ["backend", "frontend", "platform", "qa"]) {
        const roleDir = { backend: "src/backend", frontend: "src/frontend", platform: "src/infra", qa: "src/tests" }[role];
        const content = fs.readFileSync(path.join(cwd, roleDir, `from-${role}.txt`), "utf8");
        assert.match(content, new RegExp(`stage-04\\.${role}`));
        assert.ok(fs.existsSync(path.join(cwd, "pipeline", "gates", `stage-04.${role}.json`)));
        const gateText = fs.readFileSync(path.join(cwd, "pipeline", "gates", `stage-04.${role}.json`), "utf8");
        assert.doesNotMatch(gateText, /\.devteam\/worktrees/);
      }
      assert.ok(fs.readdirSync(path.join(cwd, "pipeline", "verification-receipts")).length > 0);
      const sharedFileGates = ["backend", "platform"].map((role) => JSON.parse(
        fs.readFileSync(path.join(cwd, "pipeline", "gates", `stage-04.${role}.json`), "utf8"),
      ));
      assert.equal(sharedFileGates.filter((gate) => gate.status === "FAIL").length, 1);
      assert.ok(sharedFileGates.some((gate) => gate.blockers.some((b) => b.includes("reconciliation conflict: package.json"))));
      assert.equal(fs.readdirSync(path.join(cwd, ".devteam", "worktrees")).length, 0);
    } finally {
      if (previousCommand === undefined) delete process.env.DEVTEAM_HEADLESS_COMMAND;
      else process.env.DEVTEAM_HEADLESS_COMMAND = previousCommand;
      if (previousNoLog === undefined) delete process.env.DEVTEAM_NO_LOG;
      else process.env.DEVTEAM_NO_LOG = previousNoLog;
    }
  });
});
