"use strict";

const { describe, it, afterEach } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { applyProposal, createProposal, loadProposal, parseReplacementOutput, rejectProposal } = require("../core/artifact-proposals");
const { refinementTurn, renderRefinementPrompt } = require("../core/coordinator");
const { makeTargetProject, seedGate, runCLI } = require("./_helpers");

const dirs = [];
afterEach(() => dirs.splice(0).forEach((dir) => fs.rmSync(dir, { recursive: true, force: true })));

function fixture() {
  const cwd = makeTargetProject({ config: "routing:\n  default_host: antigravity\npipeline:\n  default_track: full\n" });
  dirs.push(cwd);
  fs.mkdirSync(path.join(cwd, "pipeline"), { recursive: true });
  fs.writeFileSync(path.join(cwd, "pipeline", "brief.md"), "# Brief\n\n- AC-1: old\n");
  fs.writeFileSync(path.join(cwd, "pipeline", "design-spec.md"), "# Design\n\nOld.\n");
  seedGate(cwd, "stage-01", { status: "PASS" });
  seedGate(cwd, "stage-02", { status: "PASS" });
  seedGate(cwd, "stage-04", { status: "PASS" });
  return cwd;
}

describe("approval-bound artifact proposals", () => {
  it("stores an exact diff and deterministically invalidates requirements gates only on apply", () => {
    const cwd = fixture();
    const replacement = "# Brief\n\n- AC-1: new and testable\n";
    const proposal = createProposal({ cwd, kind: "requirements", replacement, host: "codex", model: "m" });
    assert.equal(fs.readFileSync(path.join(cwd, "pipeline", "brief.md"), "utf8").includes("old"), true);
    assert.match(proposal.diff, /-- AC-1: old/);
    assert.match(proposal.diff, /\+- AC-1: new and testable/);
    assert.deepEqual(proposal.affected_gates, [
      "pipeline/gates/stage-01.json", "pipeline/gates/stage-02.json", "pipeline/gates/stage-04.json",
    ]);
    const applied = applyProposal(cwd, null, proposal.id);
    assert.equal(applied.status, "applied");
    assert.equal(fs.readFileSync(path.join(cwd, "pipeline", "brief.md"), "utf8"), replacement);
    assert.equal(fs.existsSync(path.join(cwd, "pipeline", "gates", "stage-01.json")), false);
    assert.equal(fs.existsSync(path.join(cwd, "pipeline", "gates", "stage-04.json")), false);
    const events = fs.readFileSync(path.join(cwd, "pipeline", "proposals", "events.jsonl"), "utf8")
      .trim().split("\n").map(JSON.parse);
    assert.deepEqual(events.map((event) => event.event), ["created", "applied"]);
    assert.equal(JSON.stringify(events).includes("new and testable"), false);
  });

  it("leaves upstream requirements evidence standing for a design refinement", () => {
    const cwd = fixture();
    const proposal = createProposal({ cwd, kind: "design", replacement: "# Design\n\nNew.\n" });
    assert.deepEqual(proposal.affected_gates, ["pipeline/gates/stage-02.json", "pipeline/gates/stage-04.json"]);
    applyProposal(cwd, null, proposal.id);
    assert.equal(fs.existsSync(path.join(cwd, "pipeline", "gates", "stage-01.json")), true);
  });

  it("marks concurrent artifact or gate-set drift stale instead of rebasing itself", () => {
    const cwd = fixture();
    const proposal = createProposal({ cwd, kind: "requirements", replacement: "# Brief\n\nNew.\n" });
    fs.appendFileSync(path.join(cwd, "pipeline", "brief.md"), "concurrent edit\n");
    assert.throws(() => applyProposal(cwd, null, proposal.id), /stale because .* changed/);
    assert.equal(loadProposal(cwd, null, proposal.id).proposal.status, "stale");
  });

  it("accepts only the versioned replacement envelope and rejects secret-like output", () => {
    assert.equal(parseReplacementOutput(JSON.stringify({ schema: "stagecraft.artifact-proposal/v1", content: "ok\n" })), "ok\n");
    assert.throws(() => parseReplacementOutput(JSON.stringify({ schema: "stagecraft.artifact-proposal/v1", content: "ok", path: "/tmp/x" })), /unsupported fields/);
    assert.throws(() => parseReplacementOutput(JSON.stringify({ schema: "stagecraft.artifact-proposal/v1", content: `sk-${"x".repeat(24)}` })), /secret-like/);
  });

  it("reject records a bounded reason without changing the artifact", () => {
    const cwd = fixture();
    const proposal = createProposal({ cwd, kind: "design", replacement: "# Design\n\nNo.\n" });
    const rejected = rejectProposal(cwd, null, proposal.id);
    assert.equal(rejected.status, "rejected");
    assert.equal(fs.readFileSync(path.join(cwd, "pipeline", "design-spec.md"), "utf8"), "# Design\n\nOld.\n");
  });
});

describe("coordinator refinement boundary", () => {
  it("renders a proposal-only, no-tool prompt", () => {
    const prompt = renderRefinementPrompt({ kind: "requirements", artifact: "# Brief\n", instruction: "clarify AC-1", context: { project_facts: ["Node.js"] } });
    assert.match(prompt, /proposal-only/);
    assert.match(prompt, /do not use tools/);
    assert.match(prompt, /complete replacement artifact/);
    assert.match(prompt, /bounded_project_context/);
  });

  it("captures a proposal in a disposable workspace without applying it", async () => {
    const cwd = fixture();
    const scriptDir = fs.mkdtempSync(path.join(os.tmpdir(), "refinement-stub-"));
    dirs.push(scriptDir);
    const script = path.join(scriptDir, "answer.js");
    fs.writeFileSync(script, `process.stdin.resume(); process.stdin.on('end', () => process.stdout.write(JSON.stringify({schema:'stagecraft.artifact-proposal/v1',content:'# Brief\\n\\n- AC-1: refined\\n'})));`);
    const previous = process.env.DEVTEAM_HEADLESS_COMMAND;
    process.env.DEVTEAM_HEADLESS_COMMAND = `"${process.execPath}" "${script}"`;
    try {
      const result = await refinementTurn({ cwd, kind: "requirements", instruction: "clarify AC-1" });
      assert.equal(result.proposal.status, "pending");
      assert.equal(fs.readFileSync(path.join(cwd, "pipeline", "brief.md"), "utf8").includes("old"), true);
      assert.equal(JSON.stringify(result.proposal).includes("clarify AC-1"), false);
    } finally {
      if (previous === undefined) delete process.env.DEVTEAM_HEADLESS_COMMAND;
      else process.env.DEVTEAM_HEADLESS_COMMAND = previous;
    }
  });

  it("supports inspect and explicit apply through the CLI", () => {
    const cwd = fixture();
    const proposal = createProposal({ cwd, kind: "design", replacement: "# Design\n\nApplied.\n" });
    const inspect = runCLI(["chat", "--proposal", proposal.id], { cwd });
    assert.equal(inspect.status, 0, inspect.stderr);
    assert.match(inspect.stdout, /affected gates/i);
    const apply = runCLI(["chat", "--proposal", proposal.id, "--apply"], { cwd });
    assert.equal(apply.status, 0, apply.stderr);
    assert.match(apply.stdout, /applied/);
  });
});
