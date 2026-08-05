// Tests for phase-37 item 37.3
// (plans/phase-37-interface-and-token-efficiency.md §37.3) — the shared
// project-context guard (core/cli/project-guard.js) that stops read-only
// reporting commands from inventing a pipeline in a directory that was
// never `devteam init`-ed.

"use strict";

const { describe, it, afterEach } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { REPO_ROOT, makeTargetProject, cleanup, runCLI } = require("./_helpers");
const {
  GUARDED_COMMANDS,
  UNGUARDED_COMMANDS,
  isStagecraftProject,
  requireProjectContext,
} = require(path.join(REPO_ROOT, "core", "cli", "project-guard"));

let _dirs = [];
function track(cwd) { _dirs.push(cwd); return cwd; }
afterEach(() => { _dirs.forEach(cleanup); _dirs = []; });

function makeNonProjectDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), "devteam-test-project-guard-"));
}

// ── 1. isStagecraftProject — pure detection logic ─────────────────────────

describe("isStagecraftProject", () => {
  it("false for a directory with no .devteam/config.yml", () => {
    const cwd = track(makeNonProjectDir());
    assert.equal(isStagecraftProject(cwd), false);
  });

  it("true for a directory with .devteam/config.yml", () => {
    const cwd = track(makeTargetProject());
    assert.equal(isStagecraftProject(cwd), true);
  });
});

// ── 2. requireProjectContext — in-process, non-json (guards do not call
//    process.exit until we assert `assert.throws` sees it) ───────────────

describe("requireProjectContext", () => {
  it("is a no-op for an initialised project", () => {
    const cwd = track(makeTargetProject());
    assert.doesNotThrow(() => requireProjectContext(cwd, {}, "next"));
  });
});

// ── 3. CLI-level: guarded commands refuse in a non-project directory ──────

describe("guarded commands refuse outside a Stagecraft project", () => {
  for (const cmd of GUARDED_COMMANDS) {
    it(`${cmd} exits non-zero with an actionable message`, () => {
      const cwd = track(makeNonProjectDir());
      const r = runCLI([cmd], { cwd });
      assert.notEqual(r.status, 0, `expected non-zero exit for '${cmd}', got ${r.status}`);
      assert.match(r.stderr, /does not look like an initialised Stagecraft target project/);
      assert.match(r.stderr, /devteam init --host/);
    });
  }

  it("next --json returns a structured error, not a silent zero-state", () => {
    const cwd = track(makeNonProjectDir());
    const r = runCLI(["next", "--json"], { cwd });
    assert.notEqual(r.status, 0);
    const parsed = JSON.parse(r.stdout);
    assert.equal(parsed.error, "not-a-stagecraft-project");
    assert.equal(parsed.command, "next");
    assert.match(parsed.fix, /devteam init --host/);
  });

  it("summary --json returns a structured error, not a silent zero-state", () => {
    const cwd = track(makeNonProjectDir());
    const r = runCLI(["summary", "--json"], { cwd });
    assert.notEqual(r.status, 0);
    const parsed = JSON.parse(r.stdout);
    assert.equal(parsed.error, "not-a-stagecraft-project");
  });

  it("status --json returns a structured error, not a silent zero-state", () => {
    const cwd = track(makeNonProjectDir());
    const r = runCLI(["status", "--json"], { cwd });
    assert.notEqual(r.status, 0);
    const parsed = JSON.parse(r.stdout);
    assert.equal(parsed.error, "not-a-stagecraft-project");
  });

  it("guarded commands still work normally in an initialised project", () => {
    const cwd = track(makeTargetProject());
    const r = runCLI(["next"], { cwd });
    assert.equal(r.status, 0);
    assert.match(r.stdout, /run-stage/);
  });
});

// ── 4. Commands that legitimately run outside a project are unaffected ────

describe("unguarded commands still work outside a Stagecraft project", () => {
  it("devteam init still works in a non-project directory", () => {
    const cwd = track(makeNonProjectDir());
    const r = runCLI(["init", "--host", "claude-code"], { cwd });
    assert.equal(r.status, 0, `init failed: ${r.stderr}`);
    assert.ok(fs.existsSync(path.join(cwd, ".devteam", "config.yml")));
  });

  it("devteam review --list still works in a non-project directory (no dispatch)", () => {
    const cwd = track(makeNonProjectDir());
    const r = runCLI(["review", "--list", "--json"], { cwd });
    assert.equal(r.status, 0, `review --list failed: ${r.stderr}`);
    const parsed = JSON.parse(r.stdout);
    assert.ok(Array.isArray(parsed.workspaces));
  });

  it("devteam doctor still works in a non-project directory", () => {
    const cwd = track(makeNonProjectDir());
    const r = runCLI(["doctor"], { cwd });
    // doctor's job is to diagnose a project that may not exist; it must not
    // refuse the way GUARDED_COMMANDS do.
    assert.doesNotMatch(r.stderr, /does not look like an initialised Stagecraft target project/);
  });

  it("devteam hosts still works in a non-project directory", () => {
    const cwd = track(makeNonProjectDir());
    const r = runCLI(["hosts"], { cwd });
    assert.equal(r.status, 0);
  });

  it("devteam stages still works in a non-project directory", () => {
    const cwd = track(makeNonProjectDir());
    const r = runCLI(["stages"], { cwd });
    assert.equal(r.status, 0);
  });

  it("devteam help still works in a non-project directory", () => {
    const cwd = track(makeNonProjectDir());
    const r = runCLI(["help"], { cwd });
    assert.equal(r.status, 0);
  });
});

// ── 5. Meta-test: the guarded/unguarded split cannot drift silently ───────

describe("GUARDED_COMMANDS / UNGUARDED_COMMANDS split", () => {
  const commandsDir = path.join(REPO_ROOT, "core", "cli", "commands");

  it("the two lists are disjoint", () => {
    const overlap = GUARDED_COMMANDS.filter((c) => UNGUARDED_COMMANDS.includes(c));
    assert.deepEqual(overlap, [], `commands cannot be both guarded and unguarded: ${overlap.join(", ")}`);
  });

  it("every listed command has a corresponding command file", () => {
    for (const cmd of [...GUARDED_COMMANDS, ...UNGUARDED_COMMANDS]) {
      const f = path.join(commandsDir, `${cmd}.js`);
      assert.ok(fs.existsSync(f), `'${cmd}' listed but ${cmd}.js not found`);
    }
  });

  it("every GUARDED command actually calls the shared guard (wiring marker)", () => {
    for (const cmd of GUARDED_COMMANDS) {
      const src = fs.readFileSync(path.join(commandsDir, `${cmd}.js`), "utf8");
      assert.ok(
        src.includes("project-guard") && src.includes("requireProjectContext"),
        `'${cmd}' is listed as GUARDED but does not call requireProjectContext from project-guard`,
      );
    }
  });

  it("no UNGUARDED command calls the shared guard", () => {
    for (const cmd of UNGUARDED_COMMANDS) {
      const src = fs.readFileSync(path.join(commandsDir, `${cmd}.js`), "utf8");
      assert.ok(
        !src.includes("requireProjectContext"),
        `'${cmd}' is listed as UNGUARDED but calls requireProjectContext — remove it from UNGUARDED_COMMANDS or drop the call`,
      );
    }
  });
});
