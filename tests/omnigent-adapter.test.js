const { describe, it } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { execFileSync } = require("node:child_process");
const { REPO_ROOT, makeTargetProject, cleanup, writeMutationScript } = require("./_helpers");

const adapter = require(path.join(REPO_ROOT, "hosts", "omnigent", "adapter.js"));

describe("omnigent adapter", () => {
  it("installs the Omnigent agent spec alongside markdown host assets", () => {
    const cwd = makeTargetProject();
    try {
      const result = adapter.install(cwd);
      const spec = path.join(cwd, ".omnigent", "stagecraft", "agent", "config.yaml");
      assert.ok(result.written.includes(spec), "install result should include agent/config.yaml");
      assert.ok(fs.existsSync(spec), "agent/config.yaml should exist");
      assert.match(fs.readFileSync(spec, "utf8"), /name: stagecraft_workstream/);
      assert.match(fs.readFileSync(spec, "utf8"), /type: omnigent/);
      assert.equal(adapter.status(cwd).ok, true);
    } finally {
      cleanup(cwd);
    }
  });

  it("builds an Omnigent one-shot command by passing the rendered prompt via --prompt", () => {
    const built = adapter.buildOmnigentArgs(
      "omnigent run .omnigent/stagecraft/agent --no-session",
      "stage prompt",
    );
    assert.equal(built.bin, "omnigent");
    assert.deepEqual(built.args, [
      "run",
      ".omnigent/stagecraft/agent",
      "--no-session",
      "--prompt",
      "stage prompt",
    ]);
  });

  it("uses --prompt transport by default for config-built launch profiles", () => {
    const cwd = makeTargetProject({
      config: "routing:\n  default_host: omnigent\npipeline:\n  default_track: full\n",
    });
    const original = process.env.DEVTEAM_HEADLESS_COMMAND;
    try {
      delete process.env.DEVTEAM_HEADLESS_COMMAND;
      const built = adapter.buildOmnigentInvocation("stage prompt", { cwd });
      assert.equal(built.bin, "omnigent");
      assert.deepEqual(built.args, [
        "run",
        ".omnigent/stagecraft/agent",
        "--no-session",
        "--prompt",
        "stage prompt",
      ]);
      assert.ok(
        fs.existsSync(path.join(cwd, ".omnigent", "stagecraft", "agent", "config.yaml")),
        "default invocation should ensure the Omnigent bundle exists",
      );
      assert.equal(built.promptTransport, "argument");
      assert.match(built.displayCommand, /--prompt <stage-prompt>/);
    } finally {
      if (original !== undefined) process.env.DEVTEAM_HEADLESS_COMMAND = original;
      else delete process.env.DEVTEAM_HEADLESS_COMMAND;
      cleanup(cwd);
    }
  });

  it("self-heals legacy default agent.yaml installs into an Omnigent bundle", () => {
    const cwd = makeTargetProject({
      config: "routing:\n  default_host: omnigent\npipeline:\n  default_track: full\n",
    });
    const legacy = path.join(cwd, ".omnigent", "stagecraft", "agent.yaml");
    const config = path.join(cwd, ".omnigent", "stagecraft", "agent", "config.yaml");
    const original = process.env.DEVTEAM_HEADLESS_COMMAND;
    try {
      fs.mkdirSync(path.dirname(legacy), { recursive: true });
      fs.writeFileSync(legacy, adapter.agentSpecText(), "utf8");
      delete process.env.DEVTEAM_HEADLESS_COMMAND;
      const built = adapter.buildOmnigentInvocation("stage prompt", { cwd });
      assert.deepEqual(built.args.slice(0, 2), ["run", ".omnigent/stagecraft/agent"]);
      assert.ok(fs.existsSync(config), "default invocation should write agent/config.yaml");
      assert.match(fs.readFileSync(config, "utf8"), /name: stagecraft_workstream/);
    } finally {
      if (original !== undefined) process.env.DEVTEAM_HEADLESS_COMMAND = original;
      else delete process.env.DEVTEAM_HEADLESS_COMMAND;
      cleanup(cwd);
    }
  });

  it("builds an Omnigent command from hosts.omnigent launch profile config", () => {
    const cwd = makeTargetProject({
      config: [
        "routing:",
        "  default_host: omnigent",
        "pipeline:",
        "  default_track: full",
        "hosts:",
        "  omnigent:",
        "    agent_spec_path: .omnigent/custom/agent.yaml",
        "    harness: claude-sdk",
        "    model: claude-sonnet-4",
        "    server_url: https://omnigent.internal",
        "    session_mode: session",
        "    prompt_transport: argument",
        "    extra_args:",
        "      - --profile",
        "      - team-alpha",
        "",
      ].join("\n"),
    });
    const original = process.env.DEVTEAM_HEADLESS_COMMAND;
    try {
      delete process.env.DEVTEAM_HEADLESS_COMMAND;
      const built = adapter.buildOmnigentInvocation("stage prompt", { cwd });
      assert.equal(built.bin, "omnigent");
      assert.deepEqual(built.args, [
        "run",
        ".omnigent/custom/agent.yaml",
        "--harness",
        "claude-sdk",
        "--model",
        "claude-sonnet-4",
        "--server-url",
        "https://omnigent.internal",
        "--profile",
        "team-alpha",
        "--prompt",
        "stage prompt",
      ]);
      assert.equal(built.profile.sessionMode, "session");
      assert.equal(built.promptTransport, "argument");
    } finally {
      if (original !== undefined) process.env.DEVTEAM_HEADLESS_COMMAND = original;
      else delete process.env.DEVTEAM_HEADLESS_COMMAND;
      cleanup(cwd);
    }
  });

  // Phase-32 item 32.3: routing.roles/routing.stages' {host, model} form
  // (descriptor.model) takes precedence over hosts.omnigent.model.
  it("32.3: descriptor.model overrides hosts.omnigent.model", () => {
    const cwd = makeTargetProject({
      config: [
        "routing:",
        "  default_host: omnigent",
        "pipeline:",
        "  default_track: full",
        "hosts:",
        "  omnigent:",
        "    model: claude-sonnet-4",
        "",
      ].join("\n"),
    });
    const original = process.env.DEVTEAM_HEADLESS_COMMAND;
    try {
      delete process.env.DEVTEAM_HEADLESS_COMMAND;
      const descriptor = { workstreamId: "stage-01", model: "routing/pinned-model" };
      const built = adapter.buildOmnigentInvocation("stage prompt", { cwd }, descriptor);
      assert.ok(built.args.includes("--model"));
      assert.equal(built.args[built.args.indexOf("--model") + 1], "routing/pinned-model");
    } finally {
      if (original !== undefined) process.env.DEVTEAM_HEADLESS_COMMAND = original;
      else delete process.env.DEVTEAM_HEADLESS_COMMAND;
      cleanup(cwd);
    }
  });

  it("32.3: falls back to hosts.omnigent.model when no descriptor.model is set (back-compat)", () => {
    const cwd = makeTargetProject({
      config: [
        "routing:",
        "  default_host: omnigent",
        "pipeline:",
        "  default_track: full",
        "hosts:",
        "  omnigent:",
        "    model: claude-sonnet-4",
        "",
      ].join("\n"),
    });
    const original = process.env.DEVTEAM_HEADLESS_COMMAND;
    try {
      delete process.env.DEVTEAM_HEADLESS_COMMAND;
      const built = adapter.buildOmnigentInvocation("stage prompt", { cwd }, { workstreamId: "stage-01" });
      assert.equal(built.args[built.args.indexOf("--model") + 1], "claude-sonnet-4");
    } finally {
      if (original !== undefined) process.env.DEVTEAM_HEADLESS_COMMAND = original;
      else delete process.env.DEVTEAM_HEADLESS_COMMAND;
      cleanup(cwd);
    }
  });

  it("supports stdin prompt transport without putting prompt text in arguments", () => {
    const cwd = makeTargetProject({
      config: [
        "routing:",
        "  default_host: omnigent",
        "pipeline:",
        "  default_track: full",
        "hosts:",
        "  omnigent:",
        "    prompt_transport: stdin",
        "",
      ].join("\n"),
    });
    const original = process.env.DEVTEAM_HEADLESS_COMMAND;
    try {
      delete process.env.DEVTEAM_HEADLESS_COMMAND;
      const built = adapter.buildOmnigentInvocation("stage prompt", { cwd });
      assert.deepEqual(built.args, [
        "run",
        ".omnigent/stagecraft/agent",
        "--no-session",
      ]);
      assert.equal(built.stdinText, "stage prompt");
      assert.match(built.displayCommand, /< <stage-prompt>/);
    } finally {
      if (original !== undefined) process.env.DEVTEAM_HEADLESS_COMMAND = original;
      else delete process.env.DEVTEAM_HEADLESS_COMMAND;
      cleanup(cwd);
    }
  });

  it("renders Stagecraft constraints into an Omnigent policy document", () => {
    const policy = adapter.buildStagecraftPolicy({
      stage: "stage-06",
      role: "qa",
      workstreamId: "stage-06",
      allowedWrites: ["pipeline/test-report.md", "pipeline/gates/stage-06.json"],
      requiredCapabilities: { shell: true, network: true },
      toolBudget: ["Read", "Write", "Bash"],
    });
    assert.equal(policy.schema_version, "stagecraft.omnigent.policy.v1");
    assert.deepEqual(policy.filesystem.allowed_writes, [
      "pipeline/test-report.md",
      "pipeline/gates/stage-06.json",
    ]);
    assert.equal(policy.sandbox.shell, "required");
    assert.equal(policy.sandbox.network, "required");
    assert.deepEqual(policy.tool_budget.allowed_tools, ["Read", "Write", "Bash"]);
    assert.equal(policy.stagecraft_backstop.allowed_writes, "post-hoc-audit");
  });

  it("attaches an Omnigent policy file when policy_mode is file", () => {
    const cwd = makeTargetProject({
      config: [
        "routing:",
        "  default_host: omnigent",
        "pipeline:",
        "  default_track: full",
        "hosts:",
        "  omnigent:",
        "    prompt_transport: argument",
        "    policy_mode: file",
        "",
      ].join("\n"),
    });
    const original = process.env.DEVTEAM_HEADLESS_COMMAND;
    try {
      delete process.env.DEVTEAM_HEADLESS_COMMAND;
      const built = adapter.buildOmnigentInvocation("stage prompt", { cwd }, {
        stage: "stage-04a",
        role: "principal",
        workstreamId: "stage-04a",
        allowedWrites: ["pipeline/pre-review.md"],
        requiredCapabilities: { shell: true },
        toolBudget: ["Read", "Bash"],
      });
      const policyFlagIndex = built.args.indexOf("--policy-file");
      assert.notEqual(policyFlagIndex, -1);
      const policyPath = built.args[policyFlagIndex + 1];
      assert.ok(fs.existsSync(policyPath), "policy file should exist");
      const policy = JSON.parse(fs.readFileSync(policyPath, "utf8"));
      assert.equal(policy.workstream, "stage-04a");
      assert.equal(policy.sandbox.shell, "required");
      assert.deepEqual(policy.filesystem.allowed_writes, ["pipeline/pre-review.md"]);
      assert.match(built.displayCommand, /--policy-file <stagecraft-policy-file>/);
      built.cleanupPolicy();
      assert.equal(fs.existsSync(policyPath), false);
    } finally {
      if (original !== undefined) process.env.DEVTEAM_HEADLESS_COMMAND = original;
      else delete process.env.DEVTEAM_HEADLESS_COMMAND;
      cleanup(cwd);
    }
  });

  it("does not attach a policy file when policy_mode is off", () => {
    const cwd = makeTargetProject({
      config: [
        "routing:",
        "  default_host: omnigent",
        "pipeline:",
        "  default_track: full",
        "hosts:",
        "  omnigent:",
        "    prompt_transport: argument",
        "    policy_mode: off",
        "",
      ].join("\n"),
    });
    const original = process.env.DEVTEAM_HEADLESS_COMMAND;
    try {
      delete process.env.DEVTEAM_HEADLESS_COMMAND;
      const built = adapter.buildOmnigentInvocation("stage prompt", { cwd }, {
        stage: "stage-04a",
        role: "principal",
        workstreamId: "stage-04a",
        allowedWrites: ["pipeline/pre-review.md"],
        requiredCapabilities: { shell: true },
        toolBudget: ["Read", "Bash"],
      });
      assert.equal(built.args.includes("--policy-file"), false);
      assert.equal(built.policyPath, undefined);
    } finally {
      if (original !== undefined) process.env.DEVTEAM_HEADLESS_COMMAND = original;
      else delete process.env.DEVTEAM_HEADLESS_COMMAND;
      cleanup(cwd);
    }
  });

  it("collects Omnigent session IDs and policy verdict counts from output", () => {
    const evidence = adapter.emptyOmnigentEvidence();
    adapter.collectOmnigentEvidence(evidence, [
      "Omnigent session_id: sess_abc-123",
      "conversation_id=conv.xyz",
      "policy verdict: allowed write",
      "policy verdict: denied shell",
      "policy warning: network not requested",
      "policy blocked tool call",
    ].join("\n"));
    assert.equal(evidence.session.session_id, "sess_abc-123");
    assert.equal(evidence.session.conversation_id, "conv.xyz");
    assert.deepEqual(evidence.policyVerdicts, {
      allow: 1,
      deny: 1,
      warn: 1,
      block: 1,
    });
  });

  it("writes adapter-private Omnigent evidence without gate-schema fields or prompt text", () => {
    const cwd = makeTargetProject();
    try {
      const evidence = adapter.emptyOmnigentEvidence();
      adapter.collectOmnigentEvidence(evidence, "session: sess_123\npolicy verdict: denied\n");
      const evidencePath = adapter.writeOmnigentEvidence(
        { cwd, changeId: null },
        { stage: "stage-04", role: "backend", workstreamId: "stage-04.backend" },
        evidence,
        path.join(cwd, "pipeline", "logs", "stage-04.backend.log"),
      );
      assert.ok(evidencePath.endsWith("stage-04.backend.omnigent.json"));
      const payload = JSON.parse(fs.readFileSync(evidencePath, "utf8"));
      assert.equal(payload.schema_version, "stagecraft.omnigent.evidence.v1");
      assert.equal(payload.session.session_id, "sess_123");
      assert.equal(payload.policy_verdicts.deny, 1);
      assert.equal(payload.privacy.prompt_retained, false);
      assert.equal(Object.hasOwn(payload, "gate"), false);
      assert.equal(JSON.stringify(payload).includes("stage prompt"), false);
    } finally {
      cleanup(cwd);
    }
  });

  it("supports explicit session resume launch profiles", () => {
    const built = adapter.buildOmnigentCommandFromProfile({
      agentSpecPath: ".omnigent/stagecraft/agent.yaml",
      sessionMode: "resume",
      sessionId: "sess_123",
      extraArgs: [],
    });
    assert.deepEqual(built.args, [
      "run",
      ".omnigent/stagecraft/agent.yaml",
      "--session",
      "sess_123",
    ]);
  });

  it("keeps DEVTEAM_HEADLESS_COMMAND as the highest-precedence override", () => {
    const cwd = makeTargetProject({
      config: [
        "routing:",
        "  default_host: omnigent",
        "pipeline:",
        "  default_track: full",
        "hosts:",
        "  omnigent:",
        "    harness: ignored",
        "    model: ignored",
        "",
      ].join("\n"),
    });
    const original = process.env.DEVTEAM_HEADLESS_COMMAND;
    try {
      process.env.DEVTEAM_HEADLESS_COMMAND = "omnigent run override.yaml --no-session --harness env";
      const built = adapter.buildOmnigentInvocation("stage prompt", { cwd });
      assert.equal(built.source, "env");
      assert.equal(built.promptTransport, "argument");
      assert.deepEqual(built.args, [
        "run",
        "override.yaml",
        "--no-session",
        "--harness",
        "env",
        "--prompt",
        "stage prompt",
      ]);
    } finally {
      if (original !== undefined) process.env.DEVTEAM_HEADLESS_COMMAND = original;
      else delete process.env.DEVTEAM_HEADLESS_COMMAND;
      cleanup(cwd);
    }
  });

  it("rejects unknown prompt transport modes", () => {
    const cwd = makeTargetProject({
      config: [
        "routing:",
        "  default_host: omnigent",
        "pipeline:",
        "  default_track: full",
        "hosts:",
        "  omnigent:",
        "    prompt_transport: telepathy",
        "",
      ].join("\n"),
    });
    try {
      assert.throws(
        () => adapter.resolveLaunchProfile({ cwd }),
        /prompt_transport must be one of/,
      );
    } finally {
      cleanup(cwd);
    }
  });

  it("rejects unknown policy modes", () => {
    const cwd = makeTargetProject({
      config: [
        "routing:",
        "  default_host: omnigent",
        "pipeline:",
        "  default_track: full",
        "hosts:",
        "  omnigent:",
        "    policy_mode: maybe",
        "",
      ].join("\n"),
    });
    try {
      assert.throws(
        () => adapter.resolveLaunchProfile({ cwd }),
        /policy_mode must be one of/,
      );
    } finally {
      cleanup(cwd);
    }
  });

  it("rejects extra_args that try to override prompt transport", () => {
    const cwd = makeTargetProject({
      config: [
        "routing:",
        "  default_host: omnigent",
        "pipeline:",
        "  default_track: full",
        "hosts:",
        "  omnigent:",
        "    extra_args:",
        "      - --prompt",
        "",
      ].join("\n"),
    });
    try {
      assert.throws(
        () => adapter.resolveLaunchProfile({ cwd }),
        /cannot override Stagecraft prompt transport/,
      );
    } finally {
      cleanup(cwd);
    }
  });

  it("ignores only Omnigent-managed Codex runtime-home writes during post-hoc audit", () => {
    assert.equal(
      adapter.isOmnigentRuntimeWrite(".codex-tmp/omnigent-codex-home-z6nyl4u1/.personality_migration"),
      true,
    );
    assert.equal(
      adapter.isOmnigentRuntimeWrite(".codex-tmp/omnigent-codex-home-z6nyl4u1/.tmp/plugins/.agents/skills/plugin-creator/SKILL.md"),
      true,
    );
    assert.equal(adapter.isOmnigentRuntimeWrite(".codex-tmp/other-home/.tmp/file"), false);
    assert.equal(adapter.isOmnigentRuntimeWrite("src/backend/server.js"), false);
  });

  it("renders prompts that point at Omnigent-installed role prompts", () => {
    const prompt = adapter.renderStagePrompt({
      stage: "stage-01",
      name: "requirements",
      role: "pm",
      rolesInStage: ["pm"],
      workstreamId: "stage-01",
      objective: "Write the brief.",
      readFirst: ["AGENTS.md"],
      allowedWrites: ["pipeline/brief.md", "pipeline/gates/stage-01.json"],
      artifact: "pipeline/brief.md",
      template: "brief-template.md",
      expectedGate: {},
    }, {
      track: "full",
      feature: "Omnigent adapter",
      cwd: REPO_ROOT,
      isolation: "in-place",
    });

    assert.match(prompt, /\.omnigent\/stagecraft\/roles\/pm\.md/);
    assert.match(prompt, /"host": "omnigent"/);
  });
});

// Phase-36 external review mode: invoke()'s own write-audit snapshotted only
// ctx.cwd (the review workspace), never ctx.processCwd (the subject) — the
// same gap fixed in core/adapters/headless.js, mirrored here for Omnigent's
// separate dispatch path. See that file's why-comment for the full
// rationale.
describe("omnigent adapter — subject-write detection in review mode", () => {
  it("flags a write into the subject even though the workspace isn't a git repo", async () => {
    const workspaceDir = makeTargetProject({
      config: "routing:\n  default_host: omnigent\npipeline:\n  default_track: review-only\n",
    });
    const subjectDir = fs.mkdtempSync(path.join(os.tmpdir(), "devteam-test-omnigent-subject-"));
    const originalCmd = process.env.DEVTEAM_HEADLESS_COMMAND;
    try {
      execFileSync("git", ["init"], { cwd: subjectDir });
      execFileSync("git", ["config", "user.email", "t@t.com"], { cwd: subjectDir });
      execFileSync("git", ["config", "user.name", "T"], { cwd: subjectDir });
      fs.writeFileSync(path.join(subjectDir, "README.md"), "hi");
      execFileSync("git", ["add", "README.md"], { cwd: subjectDir });
      execFileSync("git", ["commit", "-m", "init"], { cwd: subjectDir });

      // buildOmnigentInvocation's env-override branch spawns this with
      // ["--prompt", "<rendered prompt>"] appended, and the child's cwd is
      // ctx.processCwd (subjectDir) — the script ignores argv either way.
      const scriptPath = writeMutationScript(workspaceDir);
      process.env.DEVTEAM_HEADLESS_COMMAND = `${process.execPath} ${scriptPath}`;

      const descriptor = {
        stage: "stage-01", role: "pm", rolesInStage: ["pm"], workstreamId: "stage-01",
        objective: "test", readFirst: [], allowedWrites: ["pipeline/brief.md"],
        artifact: "pipeline/brief.md", template: null, goalCondition: null, expectedGate: {}, changeId: null,
      };
      const ctx = {
        cwd: workspaceDir, processCwd: subjectDir, externalReviewMode: true,
        track: "review-only", orchestrator: "test", changeId: null, log: false,
      };
      const r = await adapter.invoke(descriptor, ctx);
      assert.deepEqual(r.writeViolations, ["subject:mutated.txt"],
        "expected exactly one subject-prefixed violation for the subject write");
    } finally {
      if (originalCmd !== undefined) process.env.DEVTEAM_HEADLESS_COMMAND = originalCmd;
      else delete process.env.DEVTEAM_HEADLESS_COMMAND;
      cleanup(workspaceDir);
      fs.rmSync(subjectDir, { recursive: true, force: true });
    }
  });

  it("does not flag a subject write when externalReviewMode is unset", async () => {
    const workspaceDir = makeTargetProject({
      config: "routing:\n  default_host: omnigent\npipeline:\n  default_track: full\n",
    });
    const targetDir = fs.mkdtempSync(path.join(os.tmpdir(), "devteam-test-omnigent-target-"));
    const originalCmd = process.env.DEVTEAM_HEADLESS_COMMAND;
    try {
      execFileSync("git", ["init"], { cwd: targetDir });
      execFileSync("git", ["config", "user.email", "t@t.com"], { cwd: targetDir });
      execFileSync("git", ["config", "user.name", "T"], { cwd: targetDir });
      fs.writeFileSync(path.join(targetDir, "README.md"), "hi");
      execFileSync("git", ["add", "README.md"], { cwd: targetDir });
      execFileSync("git", ["commit", "-m", "init"], { cwd: targetDir });

      const scriptPath = writeMutationScript(workspaceDir);
      process.env.DEVTEAM_HEADLESS_COMMAND = `${process.execPath} ${scriptPath}`;

      const descriptor = {
        stage: "stage-01", role: "pm", rolesInStage: ["pm"], workstreamId: "stage-01",
        objective: "test", readFirst: [], allowedWrites: ["pipeline/brief.md"],
        artifact: "pipeline/brief.md", template: null, goalCondition: null, expectedGate: {}, changeId: null,
      };
      const ctx = {
        cwd: workspaceDir, processCwd: targetDir, // externalReviewMode deliberately absent
        track: "full", orchestrator: "test", changeId: null, log: false,
      };
      const r = await adapter.invoke(descriptor, ctx);
      assert.deepEqual(r.writeViolations, [], "no subject audit should run without externalReviewMode");
    } finally {
      if (originalCmd !== undefined) process.env.DEVTEAM_HEADLESS_COMMAND = originalCmd;
      else delete process.env.DEVTEAM_HEADLESS_COMMAND;
      cleanup(workspaceDir);
      fs.rmSync(targetDir, { recursive: true, force: true });
    }
  });
});
