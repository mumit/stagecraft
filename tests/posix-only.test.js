// Tests for the cross-platform command and executable-resolution surface.
//
// Coverage:
//   - findOnPath(bin, pathVar) in doctor.js: pure-Node PATH probe, no subprocess
//   - runHeadless accepts quoted DEVTEAM_HEADLESS_COMMAND
//   - dispatchToPrincipal accepts quoted DEVTEAM_HEADLESS_COMMAND

"use strict";

const { describe, it, afterEach } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { spawnSync } = require("node:child_process");
const { REPO_ROOT, makeTargetProject, cleanup } = require("./_helpers");

const { findOnPath } =
  require(path.join(REPO_ROOT, "core", "cli", "commands", "doctor"));
const { runHeadless } =
  require(path.join(REPO_ROOT, "core", "adapters", "headless"));
const { dispatchToPrincipal } =
  require(path.join(REPO_ROOT, "core", "escalation"));

let _dirs = [];
function track(cwd) { _dirs.push(cwd); return cwd; }
afterEach(() => { _dirs.forEach(cleanup); _dirs = []; });

// ---------------------------------------------------------------------------
// findOnPath — pure-Node PATH probe
// ---------------------------------------------------------------------------

describe("findOnPath", () => {
  it("finds a binary in a custom pathVar directory", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "devteam-test-"));
    _dirs.push(dir);
    const bin = path.join(dir, "my-fake-bin");
    fs.writeFileSync(bin, "#!/bin/sh\n");
    fs.chmodSync(bin, 0o755);
    const found = findOnPath("my-fake-bin", dir);
    assert.equal(found, bin);
  });

  it("returns null when the binary is not in pathVar", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "devteam-test-"));
    _dirs.push(dir);
    const found = findOnPath("definitely-not-a-real-binary-xyz", dir);
    assert.equal(found, null);
  });

  it("returns null for an empty pathVar", () => {
    const found = findOnPath("node", "");
    assert.equal(found, null);
  });

  it("finds a binary across multiple colon-separated dirs", () => {
    const dir1 = fs.mkdtempSync(path.join(os.tmpdir(), "devteam-test-"));
    const dir2 = fs.mkdtempSync(path.join(os.tmpdir(), "devteam-test-"));
    _dirs.push(dir1, dir2);
    const bin = path.join(dir2, "multi-dir-bin");
    fs.writeFileSync(bin, "#!/bin/sh\n");
    fs.chmodSync(bin, 0o755);
    const found = findOnPath("multi-dir-bin", `${dir1}${path.delimiter}${dir2}`);
    assert.equal(found, bin);
  });

  it("uses PATHEXT candidates on Windows", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "devteam-test-"));
    _dirs.push(dir);
    const bin = path.join(dir, "claude.EXE");
    fs.writeFileSync(bin, "");
    const found = findOnPath("claude", dir, {
      platform: "win32",
      pathExt: ".COM;.EXE;.BAT;.CMD",
    });
    assert.equal(found, bin);
  });

  it("splits Windows PATH entries with semicolons", () => {
    const dir1 = fs.mkdtempSync(path.join(os.tmpdir(), "devteam-test-"));
    const dir2 = fs.mkdtempSync(path.join(os.tmpdir(), "devteam-test-"));
    _dirs.push(dir1, dir2);
    const bin = path.join(dir2, "codex.CMD");
    fs.writeFileSync(bin, "");
    const found = findOnPath("codex", `${dir1};${dir2}`, {
      platform: "win32",
      pathExt: ".CMD",
    });
    assert.equal(found, bin);
  });

  it("checks explicit Windows extensions without requiring PATHEXT", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "devteam-test-"));
    _dirs.push(dir);
    const bin = path.join(dir, "tool.cmd");
    fs.writeFileSync(bin, "");
    const found = findOnPath("tool.cmd", dir, {
      platform: "win32",
      pathExt: ".EXE",
    });
    assert.equal(found, bin);
  });

  it("does not append Windows extensions on POSIX", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "devteam-test-"));
    _dirs.push(dir);
    const bin = path.join(dir, "node.EXE");
    fs.writeFileSync(bin, "");
    fs.chmodSync(bin, 0o755);
    const found = findOnPath("node", dir, {
      platform: "linux",
      pathExt: ".EXE",
    });
    assert.equal(found, null);
  });
});

// ---------------------------------------------------------------------------
// headless.js — quoted command support
// ---------------------------------------------------------------------------

describe("runHeadless: quoted command support", () => {
  function makeAdapter({ headlessCommand = "true", name = "test-host" } = {}) {
    return {
      capabilities: { name, headlessCommand },
      renderStagePrompt: () => "prompt\n",
    };
  }

  function makeCtx() {
    const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "devteam-test-"));
    fs.mkdirSync(path.join(cwd, "pipeline", "gates"), { recursive: true });
    _dirs.push(cwd);
    return { track: "full", feature: "test", cwd, isolation: "in-place", log: false };
  }

  function makeDescriptor() {
    return { stage: "stage-01", workstreamId: "stage-01", allowedWrites: [] };
  }

  it("runs a headlessCommand with quoted args", async () => {
    const ctx = makeCtx();
    const oldEnv = process.env.DEVTEAM_HEADLESS_COMMAND;
    process.env.DEVTEAM_HEADLESS_COMMAND = `node -e "process.exit(9)"`;
    try {
      const r = await runHeadless(makeAdapter(), makeDescriptor(), ctx);
      assert.equal(r.exitCode, 9);
    } finally {
      if (oldEnv === undefined) delete process.env.DEVTEAM_HEADLESS_COMMAND;
      else process.env.DEVTEAM_HEADLESS_COMMAND = oldEnv;
    }
  });

  it("rejects malformed quoted headlessCommand syntax", async () => {
    const ctx = makeCtx();
    const oldEnv = process.env.DEVTEAM_HEADLESS_COMMAND;
    process.env.DEVTEAM_HEADLESS_COMMAND = `node -e "process.exit(9)`;
    try {
      await assert.rejects(
        () => runHeadless(makeAdapter(), makeDescriptor(), ctx),
        /unterminated double quote/,
      );
    } finally {
      if (oldEnv === undefined) delete process.env.DEVTEAM_HEADLESS_COMMAND;
      else process.env.DEVTEAM_HEADLESS_COMMAND = oldEnv;
    }
  });

  it("does not reject a plain command with no quotes", async () => {
    const ctx = makeCtx();
    const oldEnv = process.env.DEVTEAM_HEADLESS_COMMAND;
    process.env.DEVTEAM_HEADLESS_COMMAND = "true";
    try {
      const r = await runHeadless(makeAdapter(), makeDescriptor(), ctx);
      assert.equal(r.exitCode, 0);
    } finally {
      if (oldEnv === undefined) delete process.env.DEVTEAM_HEADLESS_COMMAND;
      else process.env.DEVTEAM_HEADLESS_COMMAND = oldEnv;
    }
  });
});

// ---------------------------------------------------------------------------
// escalation.js — quoted command support in dispatchToPrincipal
// ---------------------------------------------------------------------------

describe("dispatchToPrincipal: quoted command support", () => {
  it("runs a quoted DEVTEAM_HEADLESS_COMMAND", async () => {
    const cwd = track(makeTargetProject({
      config: "routing:\n  default_host: claude-code\npipeline:\n  default_track: full\n",
    }));
    const oldEnv = process.env.DEVTEAM_HEADLESS_COMMAND;
    process.env.DEVTEAM_HEADLESS_COMMAND = `node -e "process.exit(0)"`;
    try {
      const result = await dispatchToPrincipal(cwd, "prompt");
      assert.equal(result.exitCode, 0);
    } finally {
      if (oldEnv === undefined) delete process.env.DEVTEAM_HEADLESS_COMMAND;
      else process.env.DEVTEAM_HEADLESS_COMMAND = oldEnv;
    }
  });

  it("uses adapter prompt transport for Omnigent principal dispatch", async () => {
    const cwd = track(makeTargetProject({
      config: "routing:\n  default_host: omnigent\npipeline:\n  default_track: full\n",
    }));
    const harnessDir = track(fs.mkdtempSync(path.join(os.tmpdir(), "devteam-test-")));
    const recorder = path.join(harnessDir, "record-omnigent.js");
    const output = path.join(harnessDir, "invocation.json");
    fs.writeFileSync(recorder, [
      "const fs = require('node:fs');",
      "let stdin = '';",
      "process.stdin.setEncoding('utf8');",
      "process.stdin.on('data', (chunk) => { stdin += chunk; });",
      "process.stdin.on('end', () => {",
      "  fs.writeFileSync(process.argv[2], JSON.stringify({",
      "    args: process.argv.slice(3),",
      "    stdin,",
      "  }, null, 2) + '\\n');",
      "});",
      "",
    ].join("\n"), "utf8");

    const oldEnv = process.env.DEVTEAM_HEADLESS_COMMAND;
    process.env.DEVTEAM_HEADLESS_COMMAND = `${process.execPath} ${recorder} ${output}`;
    try {
      const result = await dispatchToPrincipal(cwd, "apply this ruling", {
        label: "escalation-applicator",
        allowedWrites: ["pipeline/gates/*.json"],
      });
      assert.equal(result.exitCode, 0);
      const invocation = JSON.parse(fs.readFileSync(output, "utf8"));
      assert.deepEqual(invocation.args, ["--prompt", "apply this ruling"]);
      assert.equal(invocation.stdin, "");
    } finally {
      if (oldEnv === undefined) delete process.env.DEVTEAM_HEADLESS_COMMAND;
      else process.env.DEVTEAM_HEADLESS_COMMAND = oldEnv;
    }
  });

  it("returns non-zero when adapter prompt transport reports unauthorized writes", async () => {
    const cwd = track(makeTargetProject({
      config: "routing:\n  default_host: omnigent\npipeline:\n  default_track: full\n",
    }));
    spawnSync("git", ["init"], { cwd, stdio: "ignore" });
    const writer = path.join(cwd, "write-outside.js");
    fs.writeFileSync(writer, [
      "const fs = require('node:fs');",
      "fs.writeFileSync('README.md', '# unauthorized\\n');",
      "",
    ].join("\n"), "utf8");

    const oldEnv = process.env.DEVTEAM_HEADLESS_COMMAND;
    process.env.DEVTEAM_HEADLESS_COMMAND = `${process.execPath} ${writer}`;
    try {
      const result = await dispatchToPrincipal(cwd, "apply this ruling", {
        label: "escalation-applicator",
        allowedWrites: ["pipeline/gates/*.json"],
      });
      assert.equal(result.exitCode, 1);
      assert.deepEqual(result.writeViolations, ["README.md"]);
      assert.equal(fs.existsSync(path.join(cwd, "README.md")), false);
    } finally {
      if (oldEnv === undefined) delete process.env.DEVTEAM_HEADLESS_COMMAND;
      else process.env.DEVTEAM_HEADLESS_COMMAND = oldEnv;
    }
  });
});
