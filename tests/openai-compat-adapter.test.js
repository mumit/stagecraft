// Unit tests for hosts/openai-compat/
//
// Coverage:
//   1. tools.js — buildTools, executeTool (write_file, read_file, list_files, bash)
//   2. tools.js — executeBash (success, failure, timeout, shell-syntax rejection)
//   3. invoke.js — resolveConfig (env vars + config.yml merge)
//   4. invoke.js — invoke() agentic loop (fetch mocked to avoid real API calls)
//   5. adapter.js — install/status/uninstall/renderStagePrompt via contract

const { describe, it, before, after, afterEach } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { execFileSync } = require("node:child_process");
const { REPO_ROOT } = require("./_helpers");

const toolsPath = path.join(REPO_ROOT, "hosts", "openai-compat", "tools.js");
const invokePath = path.join(REPO_ROOT, "hosts", "openai-compat", "invoke.js");
const adapterPath = path.join(REPO_ROOT, "hosts", "openai-compat", "adapter.js");

// ── helpers ────────────────────────────────────────────────────────────────

let _tmpdirs = [];
function tmpdir() {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), "devteam-openai-compat-"));
  _tmpdirs.push(d);
  return d;
}
function siblingOf(cwd) {
  const d = `${cwd}-sibling`;
  fs.mkdirSync(d, { recursive: true });
  _tmpdirs.push(d);
  return d;
}
afterEach(() => {
  for (const d of _tmpdirs) {
    try { fs.rmSync(d, { recursive: true, force: true }); } catch { /* cleanup */ }
  }
  _tmpdirs = [];
});

function makeProject(configYaml) {
  const cwd = tmpdir();
  fs.mkdirSync(path.join(cwd, ".devteam"), { recursive: true });
  fs.mkdirSync(path.join(cwd, "pipeline", "gates"), { recursive: true });
  if (configYaml) {
    fs.writeFileSync(path.join(cwd, ".devteam", "config.yml"), configYaml);
  }
  return cwd;
}

function fixtureDescriptor(overrides = {}) {
  return {
    stage: "stage-01",
    name: "requirements",
    role: "pm",
    rolesInStage: ["pm"],
    workstreamId: "stage-01",
    objective: "Write pipeline/brief.md with numbered acceptance criteria.",
    readFirst: ["pipeline/context.md"],
    allowedWrites: ["pipeline/brief.md", "pipeline/gates/stage-01.json"],
    artifact: "pipeline/brief.md",
    template: "brief-template.md",
    expectedGate: { acceptance_criteria_count: 0 },
    subagent: undefined,
    toolBudget: ["Read", "Write", "Glob"],
    ...overrides,
  };
}

function fixtureContext(cwd, overrides = {}) {
  return {
    track: "full",
    feature: "test feature",
    cwd,
    isolation: "in-place",
    changeId: null,
    ...overrides,
  };
}

// ── 1. tools.js ─────────────────────────────────────────────────────────────

describe("openai-compat tools", () => {
  const { buildTools, executeTool, executeBash } = require(toolsPath);

  describe("buildTools", () => {
    it("returns all four tools when no toolBudget declared", () => {
      const tools = buildTools({ toolBudget: null });
      const names = tools.map((t) => t.function.name);
      assert.ok(names.includes("write_file"));
      assert.ok(names.includes("read_file"));
      assert.ok(names.includes("list_files"));
      assert.ok(names.includes("bash"));
    });

    it("read-only budget still includes write_file for gate production", () => {
      const tools = buildTools({ toolBudget: ["Read"] });
      const names = tools.map((t) => t.function.name);
      assert.ok(names.includes("write_file"), "write_file always present for gate output");
      assert.ok(names.includes("read_file"));
      assert.ok(names.includes("list_files"));
    });

    it("Write-only budget includes write_file and not read_file", () => {
      const tools = buildTools({ toolBudget: ["Write"] });
      const names = tools.map((t) => t.function.name);
      assert.ok(names.includes("write_file"));
      assert.ok(!names.includes("read_file"), "Write-only should not include read_file");
    });

    it("Glob maps to list_files without requiring explicit Read", () => {
      const tools = buildTools({ toolBudget: ["Glob"] });
      const names = tools.map((t) => t.function.name);
      assert.ok(names.includes("list_files"));
    });

    it("Bash budget includes bash tool", () => {
      const tools = buildTools({ toolBudget: ["Read", "Write", "Bash"] });
      const names = tools.map((t) => t.function.name);
      assert.ok(names.includes("bash"), "bash must be included when Bash is in toolBudget");
    });

    it("pm role budget (Read, Write, Glob) excludes bash", () => {
      const tools = buildTools({ toolBudget: ["Read", "Write", "Glob"] });
      const names = tools.map((t) => t.function.name);
      assert.ok(!names.includes("bash"), "pm/reviewer roles must not receive bash");
    });
  });

  describe("executeTool — write_file", () => {
    it("writes an allowed file and returns ok", async () => {
      const cwd = tmpdir();
      const result = await executeTool(
        {
          id: "tc1",
          function: {
            name: "write_file",
            arguments: JSON.stringify({ path: "pipeline/brief.md", content: "# Hello" }),
          },
        },
        cwd,
        ["pipeline/brief.md", "pipeline/gates/stage-01.json"],
      );
      assert.ok(result.startsWith("ok:"), `expected ok: prefix; got: ${result}`);
      assert.equal(
        fs.readFileSync(path.join(cwd, "pipeline", "brief.md"), "utf8"),
        "# Hello",
      );
    });

    it("rejects a path not in allowedWrites", async () => {
      const cwd = tmpdir();
      const result = await executeTool(
        {
          id: "tc2",
          function: {
            name: "write_file",
            arguments: JSON.stringify({ path: "src/evil.js", content: "bad" }),
          },
        },
        cwd,
        ["pipeline/brief.md"],
      );
      assert.ok(result.startsWith("error:"), `expected error; got: ${result}`);
      assert.ok(!fs.existsSync(path.join(cwd, "src", "evil.js")));
    });

    it("allows prototype packet files when the prototype directory is allowed", async () => {
      const cwd = tmpdir();
      const result = await executeTool(
        {
          id: "tc_proto1",
          function: {
            name: "write_file",
            arguments: JSON.stringify({
              path: "pipeline/prototypes/settings-flow/feedback.md",
              content: "# Feedback\n",
            }),
          },
        },
        cwd,
        ["pipeline/prototypes/settings-flow/"],
      );
      assert.ok(result.startsWith("ok:"), `expected ok: prefix; got: ${result}`);
      assert.equal(
        fs.readFileSync(path.join(cwd, "pipeline", "prototypes", "settings-flow", "feedback.md"), "utf8"),
        "# Feedback\n",
      );
    });

    it("prototype directory permission does not grant writes outside that packet", async () => {
      const cwd = tmpdir();
      const result = await executeTool(
        {
          id: "tc_proto2",
          function: {
            name: "write_file",
            arguments: JSON.stringify({ path: "pipeline/brief.md", content: "# Brief" }),
          },
        },
        cwd,
        ["pipeline/prototypes/settings-flow/"],
      );
      assert.ok(result.startsWith("error:"), `expected error; got: ${result}`);
      assert.ok(!fs.existsSync(path.join(cwd, "pipeline", "brief.md")));
    });

    it("rejects directory traversal", async () => {
      const cwd = tmpdir();
      const result = await executeTool(
        {
          id: "tc3",
          function: {
            name: "write_file",
            arguments: JSON.stringify({ path: "../../etc/passwd", content: "bad" }),
          },
        },
        cwd,
        ["../../etc/passwd"],
      );
      assert.ok(result.startsWith("error:"), `expected error for traversal; got: ${result}`);
    });

    it("rejects sibling-prefix paths outside the project root", async () => {
      const cwd = tmpdir();
      const sibling = siblingOf(cwd);
      const rel = path.relative(cwd, path.join(sibling, "escape.md"));
      const result = await executeTool(
        {
          id: "tc3b",
          function: {
            name: "write_file",
            arguments: JSON.stringify({ path: rel, content: "bad" }),
          },
        },
        cwd,
        [rel],
      );
      assert.ok(result.startsWith("error:"), `expected sibling escape error; got: ${result}`);
      assert.ok(!fs.existsSync(path.join(sibling, "escape.md")));
    });
  });

  describe("executeTool — read_file", () => {
    it("reads an existing file", async () => {
      const cwd = tmpdir();
      fs.writeFileSync(path.join(cwd, "hello.txt"), "world");
      const result = await executeTool(
        { id: "tc4", function: { name: "read_file", arguments: JSON.stringify({ path: "hello.txt" }) } },
        cwd,
        [],
      );
      assert.equal(result, "world");
    });

    it("returns error for missing file", async () => {
      const cwd = tmpdir();
      const result = await executeTool(
        { id: "tc5", function: { name: "read_file", arguments: JSON.stringify({ path: "missing.md" }) } },
        cwd,
        [],
      );
      assert.ok(result.startsWith("error:"));
    });

    it("rejects sibling-prefix reads outside the project root", async () => {
      const cwd = tmpdir();
      const sibling = siblingOf(cwd);
      const secret = path.join(sibling, "secret.txt");
      fs.writeFileSync(secret, "do-not-read", "utf8");
      const result = await executeTool(
        {
          id: "tc5b",
          function: {
            name: "read_file",
            arguments: JSON.stringify({ path: path.relative(cwd, secret) }),
          },
        },
        cwd,
        [],
      );
      assert.ok(result.startsWith("error:"), `expected sibling read denial; got: ${result}`);
      assert.ok(!result.includes("do-not-read"), "must not return sibling file content");
    });
  });

  describe("executeTool — list_files", () => {
    it("lists directory contents", async () => {
      const cwd = tmpdir();
      fs.writeFileSync(path.join(cwd, "a.txt"), "");
      fs.mkdirSync(path.join(cwd, "sub"));
      const result = await executeTool(
        { id: "tc6", function: { name: "list_files", arguments: JSON.stringify({ dir: "." }) } },
        cwd,
        [],
      );
      assert.ok(result.includes("a.txt"));
      assert.ok(result.includes("sub/"));
    });

    it("rejects sibling-prefix directory listings outside the project root", async () => {
      const cwd = tmpdir();
      const sibling = siblingOf(cwd);
      fs.writeFileSync(path.join(sibling, "secret.txt"), "x", "utf8");
      const result = await executeTool(
        {
          id: "tc6b",
          function: {
            name: "list_files",
            arguments: JSON.stringify({ dir: path.relative(cwd, sibling) }),
          },
        },
        cwd,
        [],
      );
      assert.ok(result.startsWith("error:"), `expected sibling list denial; got: ${result}`);
      assert.ok(!result.includes("secret.txt"), "must not list sibling directory contents");
    });
  });

  describe("executeTool — bash", () => {
    it("dispatches bash tool call to executeBash and returns output", async () => {
      const cwd = tmpdir();
      fs.writeFileSync(path.join(cwd, "ok.js"), "console.log('hello-from-bash');\n", "utf8");
      const result = await executeTool(
        {
          id: "tc_bash1",
          function: {
            name: "bash",
            arguments: JSON.stringify({ command: "node ok.js" }),
          },
        },
        cwd,
        [],
      );
      assert.ok(result.includes("exit_code: 0"), `expected exit_code: 0; got: ${result}`);
      assert.ok(result.includes("hello-from-bash"), `expected echo output; got: ${result}`);
    });

    it("returns non-zero exit code for failing commands", async () => {
      const cwd = tmpdir();
      fs.writeFileSync(path.join(cwd, "fail42.js"), "process.exit(42);\n", "utf8");
      const result = await executeTool(
        {
          id: "tc_bash2",
          function: {
            name: "bash",
            arguments: JSON.stringify({ command: "node fail42.js" }),
          },
        },
        cwd,
        [],
      );
      assert.ok(result.includes("exit_code: 42"), `expected exit_code: 42; got: ${result}`);
    });

    it("returns error when command argument is missing", async () => {
      const result = await executeTool(
        { id: "tc_bash3", function: { name: "bash", arguments: JSON.stringify({}) } },
        tmpdir(),
        [],
      );
      assert.ok(result.startsWith("error:"));
    });
  });

  describe("executeTool — unknown tool", () => {
    it("returns an error string", async () => {
      const result = await executeTool(
        { id: "tc7", function: { name: "run_command", arguments: JSON.stringify({ command: "ls" }) } },
        tmpdir(),
        [],
      );
      assert.ok(result.startsWith("error: unknown tool"));
    });
  });

  describe("executeBash", () => {
    it("returns exit_code 0 and stdout for successful command", async () => {
      const cwd = tmpdir();
      fs.writeFileSync(path.join(cwd, "ok.js"), "console.log('stagecraft');\n", "utf8");
      const result = await executeBash("node ok.js", cwd, null);
      assert.ok(result.includes("exit_code: 0"), `got: ${result}`);
      assert.ok(result.includes("stagecraft"), `expected echo output; got: ${result}`);
    });

    it("returns non-zero exit_code and stderr for failing command", async () => {
      const cwd = tmpdir();
      fs.writeFileSync(
        path.join(cwd, "fail.js"),
        "process.stderr.write('error-msg\\n'); process.exit(1);\n",
        "utf8",
      );
      const result = await executeBash("node fail.js", cwd, null);
      assert.ok(result.includes("exit_code: 1"), `got: ${result}`);
      assert.ok(result.includes("error-msg"), `expected stderr content; got: ${result}`);
    });

    it("returns error string when command times out", async () => {
      const cwd = tmpdir();
      const result = await executeBash("sleep 10", cwd, 50); // 50 ms timeout
      assert.ok(result.startsWith("error:"), `expected error string; got: ${result}`);
      assert.ok(result.includes("timed out"), `expected 'timed out' in message; got: ${result}`);
    });

    it("rejects shell background syntax", async () => {
      const cwd = tmpdir();
      const result = await executeBash("sleep 60 &\necho done", cwd, 5000);
      assert.ok(result.startsWith("error:"), `expected shell syntax rejection; got: ${result}`);
      assert.ok(result.includes("shell syntax is not supported"));
    });

    it("rejects shell redirect syntax", async () => {
      const cwd = tmpdir();
      const result = await executeBash("echo error-msg >&2", cwd, 1000);
      assert.ok(result.startsWith("error:"), `expected shell syntax rejection; got: ${result}`);
      assert.ok(result.includes("shell syntax is not supported"));
    });

    it("rejects non-allowlisted commands", async () => {
      const cwd = tmpdir();
      const result = await executeBash("python --version", cwd, 1000);
      assert.ok(result.startsWith("error:"), `expected allowlist rejection; got: ${result}`);
      assert.ok(result.includes("not allowlisted"));
    });

    it("blocks find against an absolute sibling-prefix path", async () => {
      const cwd = tmpdir();
      const sibling = siblingOf(cwd);
      fs.writeFileSync(path.join(sibling, "secret.txt"), "x", "utf8");
      const result = await executeBash(`find ${sibling} -maxdepth 1 -type f`, cwd, 1000);
      assert.ok(result.startsWith("error:"), `expected find outside root to be blocked; got: ${result}`);
      assert.ok(result.includes("outside the project directory"));
    });

    it("blocks find against a quoted absolute sibling-prefix path", async () => {
      const cwd = tmpdir();
      const sibling = siblingOf(cwd);
      fs.writeFileSync(path.join(sibling, "secret.txt"), "x", "utf8");
      const result = await executeBash(`find "${sibling}" -maxdepth 1 -type f`, cwd, 1000);
      assert.ok(result.startsWith("error:"), `expected quoted find outside root to be blocked; got: ${result}`);
      assert.ok(result.includes("outside the project directory"));
    });
  });
});

// ── 2. invoke.js — resolveConfig ────────────────────────────────────────────

describe("openai-compat resolveConfig", () => {
  const { resolveConfig } = require(invokePath);

  it("falls back to OPENAI_COMPAT_* env vars when no config.yml present", () => {
    const cwd = makeProject(null); // no config file
    const origUrl = process.env.OPENAI_COMPAT_BASE_URL;
    const origKey = process.env.OPENAI_COMPAT_API_KEY;
    const origModel = process.env.OPENAI_COMPAT_MODEL;
    try {
      process.env.OPENAI_COMPAT_BASE_URL = "https://test.api/v1";
      process.env.OPENAI_COMPAT_API_KEY = "sk-test-key";
      process.env.OPENAI_COMPAT_MODEL = "test/model";
      const cfg = resolveConfig({ cwd }, "pm");
      assert.equal(cfg.baseUrl, "https://test.api/v1");
      assert.equal(cfg.apiKey, "sk-test-key");
      assert.equal(cfg.model, "test/model");
    } finally {
      if (origUrl !== undefined) process.env.OPENAI_COMPAT_BASE_URL = origUrl;
      else delete process.env.OPENAI_COMPAT_BASE_URL;
      if (origKey !== undefined) process.env.OPENAI_COMPAT_API_KEY = origKey;
      else delete process.env.OPENAI_COMPAT_API_KEY;
      if (origModel !== undefined) process.env.OPENAI_COMPAT_MODEL = origModel;
      else delete process.env.OPENAI_COMPAT_MODEL;
    }
  });

  it("reads base_url, api_key_env, and per-role model from config.yml", () => {
    const cwd = makeProject(`
routing:
  default_host: openai-compat
pipeline:
  default_track: full
hosts:
  openai-compat:
    base_url: https://openrouter.ai/api/v1
    api_key_env: OPENROUTER_API_KEY
    models:
      default: moonshotai/kimi-k2.7-code
      pm: deepseek/deepseek-v4-pro
`);
    const origKey = process.env.OPENROUTER_API_KEY;
    try {
      process.env.OPENROUTER_API_KEY = "sk-or-test";
      const cfg = resolveConfig({ cwd }, "pm");
      assert.equal(cfg.baseUrl, "https://openrouter.ai/api/v1");
      assert.equal(cfg.apiKey, "sk-or-test");
      assert.equal(cfg.model, "deepseek/deepseek-v4-pro");
    } finally {
      if (origKey !== undefined) process.env.OPENROUTER_API_KEY = origKey;
      else delete process.env.OPENROUTER_API_KEY;
    }
  });

  it("falls back to models.default when no per-role model configured", () => {
    const cwd = makeProject(`
routing:
  default_host: openai-compat
pipeline:
  default_track: full
hosts:
  openai-compat:
    base_url: https://openrouter.ai/api/v1
    api_key_env: OPENROUTER_API_KEY
    models:
      default: moonshotai/kimi-k2.7-code
`);
    const origKey = process.env.OPENROUTER_API_KEY;
    try {
      process.env.OPENROUTER_API_KEY = "sk-or-test";
      const cfg = resolveConfig({ cwd }, "backend");
      assert.equal(cfg.model, "moonshotai/kimi-k2.7-code");
    } finally {
      if (origKey !== undefined) process.env.OPENROUTER_API_KEY = origKey;
      else delete process.env.OPENROUTER_API_KEY;
    }
  });
});

describe("openai-compat post-hoc audit exemptions", () => {
  it("exempts orchestrator writes in in-place and bounded isolation only", () => {
    const cwd = makeProject(null);
    const { isOrchestratorWrite } = require(invokePath);

    assert.equal(
      isOrchestratorWrite(fixtureContext(cwd), "pipeline/run-log.jsonl"),
      true,
    );
    assert.equal(
      isOrchestratorWrite(fixtureContext(cwd), "pipeline/logs/stage-01.log"),
      true,
    );

    const boundedCtx = fixtureContext(cwd, { isolation: "bounded", changeId: "hello-world" });
    assert.equal(
      isOrchestratorWrite(boundedCtx, "pipeline/changes/hello-world/run-state.json"),
      true,
    );
    assert.equal(
      isOrchestratorWrite(boundedCtx, "pipeline/changes/hello-world/logs/stage-04.backend.log"),
      true,
    );
    assert.equal(isOrchestratorWrite(boundedCtx, "pipeline/run-state.json"), false);
    assert.equal(isOrchestratorWrite(boundedCtx, "src/backend/server.js"), false);
  });
});

// ── 3. invoke.js — invoke() agentic loop (fetch mocked) ────────────────────

describe("openai-compat invoke() agentic loop", () => {
  // We replace the global fetch with a controlled stub for these tests.
  // Each test pushes responses into a queue; the stub dequeues one per call.
  let fetchQueue = [];
  let origFetch;

  before(() => {
    origFetch = global.fetch;
    global.fetch = async (_url, _opts) => {
      if (fetchQueue.length === 0) throw new Error("fetch stub: no more queued responses");
      const next = fetchQueue.shift();
      if (next instanceof Error) throw next;
      return {
        ok: true,
        json: async () => next,
        text: async () => JSON.stringify(next),
      };
    };
  });

  after(() => {
    global.fetch = origFetch;
  });

  afterEach(() => {
    fetchQueue = [];
  });

  function makeApiResponse(content, toolCalls) {
    const message = { role: "assistant", content: content || null };
    if (toolCalls) message.tool_calls = toolCalls;
    return {
      choices: [{
        finish_reason: toolCalls ? "tool_calls" : "stop",
        message,
      }],
    };
  }

  it("writes a gate file when model outputs it via write_file tool", async () => {
    const cwd = makeProject(`
routing:
  default_host: openai-compat
pipeline:
  default_track: full
hosts:
  openai-compat:
    base_url: https://openrouter.ai/api/v1
    api_key_env: OPENAI_COMPAT_TEST_KEY
    models:
      default: test/model
`);
    process.env.OPENAI_COMPAT_TEST_KEY = "sk-stub";

    const gateContent = JSON.stringify({
      stage: "stage-01",
      status: "PASS",
      blockers: [],
      warnings: [],
      timestamp: "2026-01-01T00:00:00Z",
    });

    // First call: model calls write_file for brief.md
    // Second call: model calls write_file for the gate
    // Third call: model says stop
    fetchQueue.push(makeApiResponse(null, [{
      id: "tc_brief",
      function: { name: "write_file", arguments: JSON.stringify({ path: "pipeline/brief.md", content: "# Brief" }) },
    }]));
    fetchQueue.push(makeApiResponse(null, [{
      id: "tc_gate",
      function: { name: "write_file", arguments: JSON.stringify({ path: "pipeline/gates/stage-01.json", content: gateContent }) },
    }]));
    fetchQueue.push(makeApiResponse("Done.", null));

    const { invoke } = require(invokePath);
    const desc = fixtureDescriptor();
    const ctx = fixtureContext(cwd);

    const result = await invoke(desc, ctx, "test prompt");

    assert.ok(result.gatePath, "invoke must return a gatePath when gate is written");
    assert.ok(fs.existsSync(path.join(cwd, "pipeline", "brief.md")));
    assert.equal(result.exitCode, 0);
    assert.equal(result.timedOut, false);
    assert.ok(Array.isArray(result.writeViolations));

    delete process.env.OPENAI_COMPAT_TEST_KEY;
  });

  it("throws when no API key is configured", async () => {
    const cwd = makeProject(null);
    const savedKey = process.env.OPENAI_COMPAT_API_KEY;
    delete process.env.OPENAI_COMPAT_API_KEY;
    delete process.env.OPENAI_COMPAT_MODEL;

    const { invoke } = require(invokePath);
    await assert.rejects(
      () => invoke(fixtureDescriptor(), fixtureContext(cwd), "prompt"),
      /no API key/,
    );

    if (savedKey !== undefined) process.env.OPENAI_COMPAT_API_KEY = savedKey;
  });

  it("throws when no model is configured", async () => {
    const cwd = makeProject(null);
    const savedKey = process.env.OPENAI_COMPAT_API_KEY;
    const savedModel = process.env.OPENAI_COMPAT_MODEL;
    process.env.OPENAI_COMPAT_API_KEY = "sk-test";
    delete process.env.OPENAI_COMPAT_MODEL;

    const { invoke } = require(invokePath);
    await assert.rejects(
      () => invoke(fixtureDescriptor(), fixtureContext(cwd), "prompt"),
      /no model/,
    );

    if (savedKey !== undefined) process.env.OPENAI_COMPAT_API_KEY = savedKey;
    else delete process.env.OPENAI_COMPAT_API_KEY;
    if (savedModel !== undefined) process.env.OPENAI_COMPAT_MODEL = savedModel;
  });

  it("reports write violations when a file is written outside allowedWrites during invocation", async () => {
    const cwd = makeProject(`
routing:
  default_host: openai-compat
pipeline:
  default_track: full
hosts:
  openai-compat:
    base_url: https://openrouter.ai/api/v1
    api_key_env: OPENAI_COMPAT_TEST2_KEY
    models:
      default: test/model
`);

    // snapshotWritables uses `git status` — initialize a repo so the audit runs.
    execFileSync("git", ["init"], { cwd });
    execFileSync("git", ["config", "user.email", "t@t.com"], { cwd });
    execFileSync("git", ["config", "user.name", "T"], { cwd });
    execFileSync("git", ["commit", "--allow-empty", "-m", "init"], { cwd });

    process.env.OPENAI_COMPAT_TEST2_KEY = "sk-stub2";

    // Simulate a side-channel write during model execution: the fetch stub
    // creates an unauthorized file on the first call, then returns a stop response.
    // The post-hoc write audit (snapshotWritables diff) should catch this.
    let firstCall = true;
    global.fetch = async () => {
      if (firstCall) {
        firstCall = false;
        fs.writeFileSync(path.join(cwd, "unauthorized.js"), "evil");
      }
      return {
        ok: true,
        json: async () => makeApiResponse("Done — no tools used.", null),
      };
    };

    const { invoke } = require(invokePath);
    const desc = fixtureDescriptor({ allowedWrites: ["pipeline/brief.md", "pipeline/gates/stage-01.json"] });
    const result = await invoke(desc, fixtureContext(cwd), "test prompt");

    assert.ok(
      result.writeViolations.some((v) => v.includes("unauthorized.js")),
      `expected unauthorized.js in violations; got: ${JSON.stringify(result.writeViolations)}`,
    );

    delete process.env.OPENAI_COMPAT_TEST2_KEY;
  });
});

// ── 3b. invoke.js — usage/cost telemetry accumulation (phase-28 item 28.2) ──

describe("openai-compat invoke() usage telemetry (phase-28 item 28.2)", () => {
  const { computeCostUsd } = require(path.join(REPO_ROOT, "core", "pricing"));

  let fetchQueue = [];
  let origFetch;

  before(() => {
    origFetch = global.fetch;
    global.fetch = async () => {
      if (fetchQueue.length === 0) throw new Error("fetch stub: no more queued responses");
      const next = fetchQueue.shift();
      return { ok: true, json: async () => next, text: async () => JSON.stringify(next) };
    };
  });

  after(() => { global.fetch = origFetch; });
  afterEach(() => { fetchQueue = []; });

  function toolCallResponse(usage) {
    return {
      usage,
      choices: [{
        finish_reason: "tool_calls",
        message: {
          role: "assistant",
          content: null,
          tool_calls: [{
            id: "tc_gate",
            function: {
              name: "write_file",
              arguments: JSON.stringify({
                path: "pipeline/gates/stage-01.json",
                content: JSON.stringify({
                  stage: "stage-01", status: "PASS", blockers: [], warnings: [],
                  timestamp: "2026-01-01T00:00:00Z",
                }),
              }),
            },
          }],
        },
      }],
    };
  }

  function stopResponse(usage) {
    return {
      usage,
      choices: [{ finish_reason: "stop", message: { role: "assistant", content: "Done." } }],
    };
  }

  function projectFor(apiKeyEnv, model) {
    const cwd = makeProject(`
routing:
  default_host: openai-compat
pipeline:
  default_track: full
hosts:
  openai-compat:
    base_url: https://openrouter.ai/api/v1
    api_key_env: ${apiKeyEnv}
    models:
      default: ${model}
`);
    process.env[apiKeyEnv] = "sk-usage-stub";
    return cwd;
  }

  it("sums prompt/completion/cached tokens across a multi-turn tool loop and computes cost_usd from the pricing table", async () => {
    const apiKeyEnv = "OPENAI_COMPAT_USAGE_KEY";
    const cwd = projectFor(apiKeyEnv, "gpt-4o-mini");

    // Turn 1: model calls a tool; usage reports cached tokens.
    fetchQueue.push(toolCallResponse({
      prompt_tokens: 100,
      completion_tokens: 20,
      prompt_tokens_details: { cached_tokens: 10 },
    }));
    // Turn 2: model writes the gate and stops; no cached tokens this turn.
    fetchQueue.push(stopResponse({ prompt_tokens: 150, completion_tokens: 30 }));

    const { invoke } = require(invokePath);
    const result = await invoke(fixtureDescriptor(), fixtureContext(cwd), "test prompt");

    assert.equal(result.telemetry, "observed");
    assert.ok(result.usage, "usage must be present when the API reported it");
    assert.equal(result.usage.tokensIn, 250, "prompt_tokens summed across both turns");
    assert.equal(result.usage.tokensOut, 50, "completion_tokens summed across both turns");
    assert.equal(result.usage.cachedTokens, 10, "cached_tokens summed across turns that reported it");
    assert.equal(result.usage.model, "gpt-4o-mini");
    assert.equal(result.usage.source, "openai-compat:usage");
    const expectedCost = computeCostUsd({ model: "gpt-4o-mini", tokens_in: 250, tokens_out: 50 });
    assert.equal(result.usage.costUsd, expectedCost);
    assert.ok(expectedCost > 0, "sanity: gpt-4o-mini is a priced model");

    delete process.env[apiKeyEnv];
  });

  it("degrades to telemetry: 'unavailable' when the API never reports usage", async () => {
    const apiKeyEnv = "OPENAI_COMPAT_NO_USAGE_KEY";
    const cwd = projectFor(apiKeyEnv, "gpt-4o-mini");

    fetchQueue.push(stopResponse(undefined));

    const { invoke } = require(invokePath);
    const result = await invoke(fixtureDescriptor(), fixtureContext(cwd), "test prompt");

    assert.equal(result.telemetry, "unavailable");
    assert.equal(result.usage, null);

    delete process.env[apiKeyEnv];
  });

  it("reports cost_usd: null for an unpriced model, without guessing", async () => {
    const apiKeyEnv = "OPENAI_COMPAT_UNPRICED_KEY";
    const cwd = projectFor(apiKeyEnv, "totally-fake-model-xyz");

    fetchQueue.push(stopResponse({ prompt_tokens: 100, completion_tokens: 10 }));

    const { invoke } = require(invokePath);
    const result = await invoke(fixtureDescriptor(), fixtureContext(cwd), "test prompt");

    assert.equal(result.telemetry, "observed");
    assert.equal(result.usage.tokensIn, 100);
    assert.equal(result.usage.tokensOut, 10);
    assert.equal(result.usage.costUsd, null, "unknown model must never produce a guessed cost");

    delete process.env[apiKeyEnv];
  });
});

// ── 4. adapter.js — contract checks ──────────────────────────────────────────

describe("openai-compat adapter contract", () => {
  const adapter = require(adapterPath);

  it("exports capabilities with name = openai-compat", () => {
    assert.equal(adapter.capabilities.name, "openai-compat");
  });

  it("declares httpNative: true (no headlessCommand needed)", () => {
    assert.equal(adapter.capabilities.httpNative, true);
    assert.equal(adapter.capabilities.headless, true);
    assert.equal(adapter.capabilities.headlessCommand, undefined);
  });

  it("exports all required methods", () => {
    for (const m of ["install", "uninstall", "status", "renderStagePrompt", "invoke"]) {
      assert.equal(typeof adapter[m], "function", `missing ${m}`);
    }
  });

  it("install + status round-trip passes", () => {
    const d = tmpdir();
    adapter.install(d, { isolation: "in-place" });
    const s = adapter.status(d);
    assert.equal(s.ok, true, `status after install: ${JSON.stringify(s.missing)}`);
  });

  it("status reports ok:false on uninstalled dir", () => {
    const d = tmpdir();
    const s = adapter.status(d);
    assert.equal(s.ok, false);
    assert.ok(s.missing.length > 0);
  });

  it("uninstall removes install payload", () => {
    const d = tmpdir();
    const { written } = adapter.install(d, { isolation: "in-place" });
    assert.ok(written.length > 0);
    adapter.uninstall(d);
    const s = adapter.status(d);
    assert.equal(s.ok, false);
  });

  it("renderStagePrompt includes workstreamId", () => {
    const d = tmpdir();
    const prompt = adapter.renderStagePrompt(fixtureDescriptor(), fixtureContext(d));
    assert.equal(typeof prompt, "string");
    assert.ok(prompt.includes("stage-01"), "prompt must reference the workstreamId");
  });

  it("renderStagePrompt includes PATCH MODE block when patchItems present", () => {
    const d = tmpdir();
    const ctx = { ...fixtureContext(d), patchItems: [{ id: "BUG-1", severity: "high", summary: "fix x" }] };
    const prompt = adapter.renderStagePrompt(fixtureDescriptor(), ctx);
    assert.ok(prompt.includes("PATCH MODE"), "must include PATCH MODE block");
    assert.ok(prompt.includes("BUG-1"));
  });

  it("renderStagePrompt does NOT include PATCH MODE when patchItems absent", () => {
    const d = tmpdir();
    const prompt = adapter.renderStagePrompt(fixtureDescriptor(), fixtureContext(d));
    assert.ok(!prompt.includes("PATCH MODE"));
  });
});

// ── 5. invoke.js — bash tool in agentic loop ─────────────────────────────────
//
// Separate describe so the fetch stub doesn't interfere with suite 3's queue.

describe("openai-compat invoke() — bash tool", () => {
  let origFetch;

  before(() => { origFetch = global.fetch; });
  after(() => { global.fetch = origFetch; });

  function makeApiResponse(content, toolCalls) {
    const message = { role: "assistant", content: content || null };
    if (toolCalls) message.tool_calls = toolCalls;
    return {
      choices: [{
        finish_reason: toolCalls ? "tool_calls" : "stop",
        message,
      }],
    };
  }

  it("executes a bash tool call in the agentic loop", async () => {
    const cwd = makeProject(`
routing:
  default_host: openai-compat
pipeline:
  default_track: full
hosts:
  openai-compat:
    base_url: https://openrouter.ai/api/v1
    api_key_env: OPENAI_COMPAT_BASH_TEST_KEY
    models:
      default: test/model
`);
    process.env.OPENAI_COMPAT_BASH_TEST_KEY = "sk-bash-stub";
    fs.writeFileSync(
      path.join(cwd, "make-sentinel.js"),
      "require('node:fs').writeFileSync('bash-sentinel.txt', 'bash-ran\\n');\n",
      "utf8",
    );

    const gateContent = JSON.stringify({
      stage: "stage-04a",
      status: "PASS",
      blockers: [],
      warnings: [],
      timestamp: "2026-01-01T00:00:00Z",
    });

    let callCount = 0;
    global.fetch = async () => {
      callCount++;
      if (callCount === 1) {
        // Model runs an allowlisted command to create a sentinel file.
        return {
          ok: true,
          json: async () => makeApiResponse(null, [{
            id: "tc_bash_loop",
            function: {
              name: "bash",
              arguments: JSON.stringify({ command: "node make-sentinel.js" }),
            },
          }]),
        };
      }
      if (callCount === 2) {
        // Model writes the gate
        return {
          ok: true,
          json: async () => makeApiResponse(null, [{
            id: "tc_gate",
            function: {
              name: "write_file",
              arguments: JSON.stringify({ path: "pipeline/gates/stage-04a.json", content: gateContent }),
            },
          }]),
        };
      }
      // Model stops
      return { ok: true, json: async () => makeApiResponse("Done.", null) };
    };

    const { invoke } = require(invokePath);
    const desc = fixtureDescriptor({
      stage: "stage-04a",
      workstreamId: "stage-04a",
      toolBudget: ["Read", "Write", "Bash"],
      allowedWrites: ["pipeline/gates/stage-04a.json"],
    });

    const result = await invoke(desc, fixtureContext(cwd), "test prompt");

    assert.ok(
      fs.existsSync(path.join(cwd, "bash-sentinel.txt")),
      "bash command must have executed and created the sentinel file",
    );
    assert.ok(result.gatePath, "gate must be written after bash call");
    assert.equal(result.exitCode, 0);

    delete process.env.OPENAI_COMPAT_BASH_TEST_KEY;
  });
});
