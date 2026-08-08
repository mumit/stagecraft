// Tests for C1 — post-hoc write-audit enforcement.
//
// write-audit.js has three exports:
//   snapshotWritables(cwd) — reads git status, returns { paths: Set, ok: bool }
//   auditWrites(before, after, allowedWrites) — diffs snapshots, returns violations
//   isAllowed(filePath, allowedWrites) — pure predicate
//
// Tests are organized into:
//   1. isAllowed — pure function, no side effects
//   2. auditWrites — constructed snapshots (no git needed)
//   3. snapshotWritables — real git repo in a temp dir
//   4. capabilities.json — codex and gemini-cli declare post-hoc-audit
//   5. allowedWritesCaption — correct wording for post-hoc-audit level
//   6. Integration: runHeadless returns writeViolations field

const { test, describe } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const os = require("node:os");
const { execFileSync } = require("node:child_process");

const { isAllowed, auditWrites, snapshotWritables, isIgnoredRuntimeArtifact } = require("../core/guards/write-audit");
const { writeMutationScript } = require("./_helpers");

// ─── 1. isAllowed ─────────────────────────────────────────────────────────────

describe("isAllowed — exact and directory matching", () => {
  test("exact file match", () => {
    assert.ok(isAllowed("pipeline/brief.md", ["pipeline/brief.md"]));
  });

  test("exact file match with multiple entries", () => {
    assert.ok(isAllowed("pipeline/brief.md", ["pipeline/context.md", "pipeline/brief.md"]));
  });

  test("directory prefix match (trailing slash)", () => {
    assert.ok(isAllowed("pipeline/adr/001-design.md", ["pipeline/adr/"]));
  });

  test("directory prefix matches nested path", () => {
    assert.ok(isAllowed("pipeline/adr/sub/note.md", ["pipeline/adr/"]));
  });

  test("directory entry with the bare dir path", () => {
    assert.ok(isAllowed("pipeline/adr", ["pipeline/adr/"]));
  });

  test("rejects non-matching path", () => {
    assert.ok(!isAllowed("src/hack.js", ["pipeline/brief.md"]));
  });

  test("rejects partial prefix that is not a directory boundary", () => {
    // "pipeline/br" should not match "pipeline/brief.md"
    assert.ok(!isAllowed("pipeline/brief.md", ["pipeline/br/"]));
  });

  test("empty allowedWrites returns false", () => {
    assert.ok(!isAllowed("pipeline/brief.md", []));
  });

  test("null allowedWrites returns false", () => {
    assert.ok(!isAllowed("pipeline/brief.md", null));
  });

  test("backslash paths normalized (Windows compat)", () => {
    assert.ok(isAllowed("pipeline\\brief.md", ["pipeline/brief.md"]));
  });

  test("backslash in allowedWrites normalized", () => {
    assert.ok(isAllowed("pipeline/brief.md", ["pipeline\\brief.md"]));
  });
});

describe("isAllowed — glob and placeholder matching", () => {
  test("* wildcard matches within a single segment", () => {
    assert.ok(isAllowed("pipeline/gates/stage-05.qa.json", ["pipeline/gates/stage-05.*.json"]));
  });

  test("* wildcard does not match across path separators", () => {
    assert.ok(!isAllowed("pipeline/gates/deep/stage-05.qa.json", ["pipeline/gates/stage-05.*.json"]));
  });

  test("<placeholder> matches any segment value", () => {
    assert.ok(isAllowed("pipeline/code-review/by-qa.md", ["pipeline/code-review/by-<reviewer>.md"]));
    assert.ok(isAllowed("pipeline/code-review/by-backend.md", ["pipeline/code-review/by-<reviewer>.md"]));
    assert.ok(isAllowed("pipeline/code-review/by-frontend.md", ["pipeline/code-review/by-<reviewer>.md"]));
  });

  test("<placeholder> does not match path that crosses a separator", () => {
    assert.ok(!isAllowed("pipeline/code-review/sub/by-qa.md", ["pipeline/code-review/by-<reviewer>.md"]));
  });

  test("exact match still wins when no wildcards present", () => {
    assert.ok(isAllowed("pipeline/gates/stage-05.json", ["pipeline/gates/stage-05.json"]));
    assert.ok(!isAllowed("pipeline/gates/stage-05.qa.json", ["pipeline/gates/stage-05.json"]));
  });

  test("auditWrites passes with <placeholder> pattern in allowedWrites", () => {
    const before = makeSnap([]);
    const after = makeSnap(["pipeline/code-review/by-qa.md", "pipeline/code-review/by-backend.md"]);
    const { violations } = auditWrites(before, after, ["pipeline/code-review/by-<reviewer>.md"]);
    assert.equal(violations.length, 0, `unexpected violations: ${violations.join(", ")}`);
  });

  test("auditWrites flags unauthorized file despite <placeholder> pattern", () => {
    const before = makeSnap([]);
    const after = makeSnap(["pipeline/code-review/by-qa.md", "src/hack.js"]);
    const { violations } = auditWrites(before, after, ["pipeline/code-review/by-<reviewer>.md"]);
    assert.deepEqual(violations, ["src/hack.js"]);
  });

  test("auditWrites passes with *.json glob pattern", () => {
    const before = makeSnap([]);
    const after = makeSnap(["pipeline/gates/stage-05.qa.json", "pipeline/gates/stage-05.backend.json"]);
    const { violations } = auditWrites(before, after, ["pipeline/gates/stage-05.*.json", "pipeline/gates/stage-05.json"]);
    assert.equal(violations.length, 0, `unexpected violations: ${violations.join(", ")}`);
  });
});

// ─── 2. auditWrites ───────────────────────────────────────────────────────────

function makeSnap(paths) {
  return { paths: new Set(paths), ok: true };
}
const failSnap = { paths: new Set(), ok: false };

describe("auditWrites — diff and violation detection", () => {
  test("clean write — allowed file added", () => {
    const before = makeSnap([]);
    const after = makeSnap(["pipeline/brief.md"]);
    const { violations, audited } = auditWrites(before, after, ["pipeline/brief.md"]);
    assert.ok(audited);
    assert.equal(violations.length, 0);
  });

  test("violation — unauthorized file added", () => {
    const before = makeSnap([]);
    const after = makeSnap(["src/hack.js"]);
    const { violations, audited } = auditWrites(before, after, ["pipeline/brief.md"]);
    assert.ok(audited);
    assert.deepEqual(violations, ["src/hack.js"]);
  });

  test("mixed — one allowed, one violation", () => {
    const before = makeSnap([]);
    const after = makeSnap(["pipeline/brief.md", "src/hack.js"]);
    const { violations } = auditWrites(before, after, ["pipeline/brief.md"]);
    assert.deepEqual(violations, ["src/hack.js"]);
  });

  test("pre-existing dirty file excluded from violations", () => {
    // pipeline/brief.md was already dirty before invoke; not a new write
    const before = makeSnap(["pipeline/brief.md"]);
    const after = makeSnap(["pipeline/brief.md"]);
    const { violations } = auditWrites(before, after, []);
    assert.equal(violations.length, 0);
  });

  test("pre-existing dirty file plus new violation", () => {
    const before = makeSnap(["pipeline/brief.md"]);
    const after = makeSnap(["pipeline/brief.md", "src/hack.js"]);
    const { violations } = auditWrites(before, after, ["pipeline/brief.md"]);
    assert.deepEqual(violations, ["src/hack.js"]);
  });

  test("directory-allowed write passes", () => {
    const before = makeSnap([]);
    const after = makeSnap(["pipeline/adr/001.md"]);
    const { violations } = auditWrites(before, after, ["pipeline/adr/"]);
    assert.equal(violations.length, 0);
  });

  test("audited=false when before snapshot failed", () => {
    const { audited, violations } = auditWrites(failSnap, makeSnap(["foo.js"]), ["pipeline/"]);
    assert.ok(!audited);
    assert.equal(violations.length, 0);
  });

  test("audited=false when after snapshot failed", () => {
    const { audited } = auditWrites(makeSnap([]), failSnap, ["pipeline/"]);
    assert.ok(!audited);
  });

  test("newPaths contains all newly written paths", () => {
    const before = makeSnap(["pipeline/brief.md"]);
    const after = makeSnap(["pipeline/brief.md", "pipeline/context.md", "src/hack.js"]);
    const { newPaths } = auditWrites(before, after, ["pipeline/"]);
    assert.ok(newPaths.includes("pipeline/context.md"));
    assert.ok(newPaths.includes("src/hack.js"));
    assert.ok(!newPaths.includes("pipeline/brief.md"));
  });

  test("python bytecode cache files are ignored as runtime artifacts", () => {
    const before = makeSnap([]);
    const after = makeSnap([
      "src/backend/__pycache__/__init__.cpython-314.pyc",
      "src/backend/__pycache__/estimator.cpython-314.pyc",
    ]);
    const { violations, ignoredPaths, newPaths } = auditWrites(before, after, ["pipeline/code-review/by-qa.md"]);
    assert.deepEqual(violations, []);
    assert.deepEqual(ignoredPaths.sort(), [
      "src/backend/__pycache__/__init__.cpython-314.pyc",
      "src/backend/__pycache__/estimator.cpython-314.pyc",
    ].sort());
    assert.equal(newPaths.length, 2);
  });

  test("ignored runtime artifacts do not hide real unauthorized source writes", () => {
    const before = makeSnap([]);
    const after = makeSnap([
      "src/backend/__pycache__/estimator.cpython-314.pyc",
      "src/backend/estimator.py",
    ]);
    const { violations, ignoredPaths } = auditWrites(before, after, ["pipeline/code-review/by-qa.md"]);
    assert.deepEqual(ignoredPaths, ["src/backend/__pycache__/estimator.cpython-314.pyc"]);
    assert.deepEqual(violations, ["src/backend/estimator.py"]);
  });
});

describe("isIgnoredRuntimeArtifact", () => {
  test("matches common Python/test cache paths", () => {
    assert.ok(isIgnoredRuntimeArtifact("src/backend/__pycache__/estimator.cpython-314.pyc"));
    assert.ok(isIgnoredRuntimeArtifact("src/backend/__pycache__/estimator.pyo"));
    assert.ok(isIgnoredRuntimeArtifact(".pytest_cache/v/cache/nodeids"));
    assert.ok(isIgnoredRuntimeArtifact("service/.mypy_cache/3.14/module.meta.json"));
    assert.ok(isIgnoredRuntimeArtifact("service/.ruff_cache/0.8.0/12345"));
  });

  test("does not match source or non-cache paths", () => {
    assert.ok(!isIgnoredRuntimeArtifact("src/backend/estimator.py"));
    assert.ok(!isIgnoredRuntimeArtifact("src/backend/cache/result.pyc"));
    assert.ok(!isIgnoredRuntimeArtifact("pipeline/code-review/by-qa.md"));
  });

  // Regression: a real build flagged platform's gate FAIL over
  // "[write-audit] unauthorized write: pipeline/verification-receipts/<hash>.json"
  // — a file platform never touched. It's written by the orchestrator's own
  // post-dispatch stamping step (core/verify/runner.js#writeReceipt), never
  // by the dispatched agent, and the directory is shared across every
  // workstream's own stamp step rather than scoped per-role, so a
  // concurrently- or previously-stamped sibling workstream's receipt can
  // show up in a different workstream's own before/after diff.
  test("matches pipeline/verification-receipts/ (orchestrator's own stamping bookkeeping, not an agent write)", () => {
    assert.ok(isIgnoredRuntimeArtifact("pipeline/verification-receipts/a8ed22fa9860e76c1be2deefaef2a53c0cda213dd9495b46807209663df516f6.json"));
  });
});

// ─── 3. snapshotWritables — real git temp repo ────────────────────────────────

describe("snapshotWritables — real git repo", { concurrency: false }, () => {
  function makeGitRepo() {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "write-audit-test-"));
    execFileSync("git", ["init"], { cwd: dir });
    execFileSync("git", ["config", "user.email", "test@test.com"], { cwd: dir });
    execFileSync("git", ["config", "user.name", "Test"], { cwd: dir });
    // Initial commit so git status works
    fs.writeFileSync(path.join(dir, "README.md"), "hi", "utf8");
    execFileSync("git", ["add", "README.md"], { cwd: dir });
    execFileSync("git", ["commit", "-m", "init"], { cwd: dir });
    return dir;
  }

  test("clean repo gives empty set", () => {
    const dir = makeGitRepo();
    try {
      const snap = snapshotWritables(dir);
      assert.ok(snap.ok);
      assert.equal(snap.paths.size, 0);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  test("untracked file appears in snapshot", () => {
    const dir = makeGitRepo();
    try {
      // Create an untracked file at the repo root so git status shows it.
      // Writing inside an untracked subdir would make git show only the dir.
      fs.writeFileSync(path.join(dir, "untracked.txt"), "x", "utf8");
      const snap = snapshotWritables(dir);
      assert.ok(snap.ok);
      assert.ok(snap.paths.size > 0, "expected at least one untracked path");
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  test("modified tracked file appears in snapshot", () => {
    const dir = makeGitRepo();
    try {
      fs.appendFileSync(path.join(dir, "README.md"), "\nmore", "utf8");
      const snap = snapshotWritables(dir);
      assert.ok(snap.ok);
      assert.ok(snap.paths.has("README.md"), `expected README.md in paths: ${[...snap.paths].join(", ")}`);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  test("ok=false for non-git directory", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "not-git-"));
    try {
      const snap = snapshotWritables(dir);
      assert.ok(!snap.ok);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  test("path with space is captured without surrounding quotes", () => {
    const dir = makeGitRepo();
    try {
      fs.writeFileSync(path.join(dir, "file with space.js"), "content", "utf8");
      const snap = snapshotWritables(dir);
      assert.ok(snap.ok);
      assert.ok(
        snap.paths.has("file with space.js"),
        `expected unquoted path; got: ${[...snap.paths].join(", ")}`,
      );
      assert.ok(
        !snap.paths.has('"file with space.js"'),
        "should not capture the quoted variant",
      );
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  test("file with space in allowedWrites produces no violation", () => {
    const dir = makeGitRepo();
    try {
      const before = snapshotWritables(dir);
      fs.writeFileSync(path.join(dir, "file with space.js"), "content", "utf8");
      const after = snapshotWritables(dir);
      const { violations, audited } = auditWrites(before, after, ["file with space.js"]);
      assert.ok(audited);
      assert.equal(violations.length, 0, `unexpected violations: ${violations.join(", ")}`);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  test("untracked subdirectory is expanded to individual file paths", () => {
    // Reproduces the real-world case: devteam init creates pipeline/ but never
    // commits it, so pipeline/ is invisible to git (empty dirs are ignored).
    // Once the model writes files into it, git --porcelain reports "?? pipeline/"
    // as a single entry. snapshotWritables must expand that to individual paths.
    const dir = makeGitRepo();
    try {
      fs.mkdirSync(path.join(dir, "pipeline", "gates"), { recursive: true });
      fs.writeFileSync(path.join(dir, "pipeline", "brief.md"), "# Brief", "utf8");
      fs.writeFileSync(path.join(dir, "pipeline", "context.md"), "ctx", "utf8");
      fs.writeFileSync(path.join(dir, "pipeline", "gates", "stage-01.json"), "{}", "utf8");
      const snap = snapshotWritables(dir);
      assert.ok(snap.ok);
      assert.ok(
        snap.paths.has("pipeline/brief.md"),
        `expected pipeline/brief.md expanded from dir entry; got: ${[...snap.paths].join(", ")}`,
      );
      assert.ok(snap.paths.has("pipeline/context.md"), "expected pipeline/context.md");
      assert.ok(snap.paths.has("pipeline/gates/stage-01.json"), "expected nested file");
      assert.ok(!snap.paths.has("pipeline/"), 'aggregate "pipeline/" entry must not remain');
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  test("no false-positive violation when all files in untracked dir are in allowedWrites", () => {
    // End-to-end regression for the bug: stage-01 gate flipped to FAIL because
    // auditWrites saw "pipeline/" and isAllowed("pipeline/", file-entries) = false.
    const dir = makeGitRepo();
    try {
      const before = snapshotWritables(dir);
      fs.mkdirSync(path.join(dir, "pipeline", "gates"), { recursive: true });
      fs.writeFileSync(path.join(dir, "pipeline", "brief.md"), "# Brief", "utf8");
      fs.writeFileSync(path.join(dir, "pipeline", "context.md"), "ctx", "utf8");
      fs.writeFileSync(path.join(dir, "pipeline", "gates", "stage-01.json"), "{}", "utf8");
      const after = snapshotWritables(dir);
      const { violations, audited } = auditWrites(before, after, [
        "pipeline/brief.md",
        "pipeline/context.md",
        "pipeline/gates/stage-01.json",
      ]);
      assert.ok(audited);
      assert.equal(violations.length, 0, `unexpected violations: ${violations.join(", ")}`);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  test("unauthorized file inside untracked dir still produces a violation", () => {
    // Security check: even when pipeline/ is reported as a dir entry, an
    // unauthorized file inside it must not slip through the audit.
    const dir = makeGitRepo();
    try {
      const before = snapshotWritables(dir);
      fs.mkdirSync(path.join(dir, "pipeline", "gates"), { recursive: true });
      fs.writeFileSync(path.join(dir, "pipeline", "brief.md"), "# Brief", "utf8");
      fs.writeFileSync(path.join(dir, "pipeline", "evil.md"), "bad", "utf8"); // NOT in allowedWrites
      const after = snapshotWritables(dir);
      const { violations, audited } = auditWrites(before, after, ["pipeline/brief.md"]);
      assert.ok(audited);
      assert.ok(
        violations.some((v) => v.includes("evil.md")),
        `expected evil.md in violations; got: ${violations.join(", ")}`,
      );
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});

// ─── 4. capabilities.json — codex and gemini-cli declare post-hoc-audit ───────
//
// 34.4: gemini-cli's own capabilities coverage moved to
// packages/host-gemini-cli/tests/adapter.test.js (it's no longer under
// hosts/ — see that directory's README.md for why).

describe("adapter capabilities — post-hoc-audit declared", () => {
  function loadCap(host) {
    return JSON.parse(fs.readFileSync(
      path.join(__dirname, "..", "hosts", host, "capabilities.json"),
      "utf8",
    ));
  }

  test("codex.enforces.allowed_writes = post-hoc-audit", () => {
    assert.equal(loadCap("codex").enforces.allowed_writes, "post-hoc-audit");
  });

  test("omnigent.enforces.allowed_writes = post-hoc-audit", () => {
    assert.equal(loadCap("omnigent").enforces.allowed_writes, "post-hoc-audit");
  });

  test("claude-code.enforces.allowed_writes = tool-call-time (unchanged)", () => {
    assert.equal(loadCap("claude-code").enforces.allowed_writes, "tool-call-time");
  });

  test("generic.enforces.allowed_writes = prompt-only (unchanged)", () => {
    assert.equal(loadCap("generic").enforces.allowed_writes, "prompt-only");
  });
});

// ─── 5. allowedWritesCaption — correct wording per enforcement level ──────────

describe("allowedWritesCaption — post-hoc-audit wording", () => {
  const { allowedWritesCaption } = require("../core/adapters/render-helpers");

  test("post-hoc-audit mentions orchestrator write-audit", () => {
    const caption = allowedWritesCaption("post-hoc-audit", "Codex CLI");
    assert.ok(caption.includes("write-audit") || caption.includes("post-hoc"), `caption: ${caption}`);
    assert.ok(caption.includes("FAIL"), `expected FAIL mention in caption: ${caption}`);
  });

  test("tool-call-time mentions hooks", () => {
    const caption = allowedWritesCaption("tool-call-time", "Claude Code");
    assert.ok(caption.includes("hooks"), `caption: ${caption}`);
  });

  test("prompt-only mentions advisory", () => {
    const caption = allowedWritesCaption("prompt-only", "Generic");
    assert.ok(caption.toLowerCase().includes("advisory"), `caption: ${caption}`);
  });
});

// ─── 6. Integration: runHeadless returns writeViolations field ────────────────

describe("runHeadless — writeViolations field in result", { concurrency: false }, () => {
  // Only run when DEVTEAM_HEADLESS_COMMAND=cat (no-op spawn that doesn't write files)
  // We test that the field is present and is an array (even when empty).
  test(
    "result includes writeViolations array (claude-code, no audit)",
    process.env.DEVTEAM_HEADLESS_COMMAND === "cat" ? {} : { skip: "set DEVTEAM_HEADLESS_COMMAND=cat" },
    async () => {
      const { runHeadless } = require("../core/adapters/headless");
      const { loadAdapter } = require("../core/router");
      const dir = fs.mkdtempSync(path.join(os.tmpdir(), "wa-integration-"));
      try {
        fs.mkdirSync(path.join(dir, "pipeline", "gates"), { recursive: true });
        const adapter = loadAdapter("claude-code");
        const descriptor = {
          stage: "stage-01", role: "pm", rolesInStage: ["pm"], workstreamId: "stage-01",
          objective: "test", readFirst: [], allowedWrites: ["pipeline/brief.md"],
          artifact: "pipeline/brief.md", template: null, goalCondition: null, expectedGate: {}, changeId: null,
        };
        const ctx = { cwd: dir, track: "full", orchestrator: "test", changeId: null, log: false };
        const r = await runHeadless(adapter, descriptor, ctx);
        assert.ok(Array.isArray(r.writeViolations), "expected writeViolations to be an array");
        // claude-code uses tool-call-time, so no audit runs — should be empty
        assert.equal(r.writeViolations.length, 0);
      } finally {
        fs.rmSync(dir, { recursive: true, force: true });
      }
    }
  );

  test(
    "result includes writeViolations array (codex, post-hoc-audit)",
    process.env.DEVTEAM_HEADLESS_COMMAND === "cat" ? {} : { skip: "set DEVTEAM_HEADLESS_COMMAND=cat" },
    async () => {
      const { runHeadless } = require("../core/adapters/headless");
      const { loadAdapter } = require("../core/router");
      const dir = fs.mkdtempSync(path.join(os.tmpdir(), "wa-integration-codex-"));
      try {
        // git init so snapshotWritables works
        execFileSync("git", ["init"], { cwd: dir });
        execFileSync("git", ["config", "user.email", "t@t.com"], { cwd: dir });
        execFileSync("git", ["config", "user.name", "T"], { cwd: dir });
        fs.writeFileSync(path.join(dir, "README.md"), "hi");
        execFileSync("git", ["add", "README.md"], { cwd: dir });
        execFileSync("git", ["commit", "-m", "init"], { cwd: dir });
        fs.mkdirSync(path.join(dir, "pipeline", "gates"), { recursive: true });

        const adapter = loadAdapter("codex");
        const descriptor = {
          stage: "stage-01", role: "pm", rolesInStage: ["pm"], workstreamId: "stage-01",
          objective: "test", readFirst: [], allowedWrites: ["pipeline/brief.md", "pipeline/gates/stage-01.json"],
          artifact: "pipeline/brief.md", template: null, goalCondition: null, expectedGate: {}, changeId: null,
        };
        const ctx = { cwd: dir, track: "full", orchestrator: "test", changeId: null };
        // cat doesn't write model-authored files. The headless transcript under
        // pipeline/logs/ is orchestrator-owned and must not trip write-audit.
        const r = await runHeadless(adapter, descriptor, ctx);
        assert.ok(Array.isArray(r.writeViolations), "expected writeViolations to be an array");
        assert.equal(r.writeViolations.length, 0, `unexpected violations: ${r.writeViolations.join(", ")}`);
        assert.ok(
          fs.existsSync(path.join(dir, "pipeline", "logs", "stage-01.log")),
          "test should exercise default transcript logging",
        );
      } finally {
        fs.rmSync(dir, { recursive: true, force: true });
      }
    }
  );
});

// ─── 7. Integration: subject-write detection in review mode (phase-36) ───────
//
// Prior to this fix, runHeadless's post-hoc audit snapshotted ctx.cwd (the
// review workspace) both before and after dispatch — never ctx.processCwd
// (the subject under review) — so it structurally could not see a write into
// the subject at all. These tests exercise the second, independent
// snapshot/audit pass added against ctx.processCwd when ctx.externalReviewMode
// is true. Unconditionally overrides DEVTEAM_HEADLESS_COMMAND itself (rather
// than gating on an ambient "cat" value), so it runs the same way under
// `npm test` and `CI=true DEVTEAM_HEADLESS_COMMAND=cat npm test`.

describe("runHeadless — subject-write detection in review mode", { concurrency: false }, () => {
  test("a write into the subject is flagged, even though the workspace isn't a git repo", async () => {
    const { runHeadless } = require("../core/adapters/headless");
    const { loadAdapter } = require("../core/router");

    // Workspace: plain tempdir, deliberately NOT a git repo — matches
    // core/review-workspace.js#createReviewWorkspace, which never git-inits
    // the workspace it creates.
    const workspaceDir = fs.mkdtempSync(path.join(os.tmpdir(), "devteam-test-review-ws-"));
    // Subject: a real git repo, one clean commit — matches the common case
    // of "the repo being reviewed".
    const subjectDir = fs.mkdtempSync(path.join(os.tmpdir(), "devteam-test-review-subject-"));
    const originalCmd = process.env.DEVTEAM_HEADLESS_COMMAND;
    try {
      fs.mkdirSync(path.join(workspaceDir, "pipeline", "gates"), { recursive: true });
      execFileSync("git", ["init"], { cwd: subjectDir });
      execFileSync("git", ["config", "user.email", "t@t.com"], { cwd: subjectDir });
      execFileSync("git", ["config", "user.name", "T"], { cwd: subjectDir });
      fs.writeFileSync(path.join(subjectDir, "README.md"), "hi");
      execFileSync("git", ["add", "README.md"], { cwd: subjectDir });
      execFileSync("git", ["commit", "-m", "init"], { cwd: subjectDir });

      // The spawned child's cwd is ctx.processCwd (subjectDir) — see
      // core/adapters/headless.js's spawn() call — so this script's relative
      // write lands in the subject, exactly as a reviewing agent's would.
      const scriptPath = writeMutationScript(workspaceDir);
      process.env.DEVTEAM_HEADLESS_COMMAND = `${process.execPath} ${scriptPath}`;

      const adapter = loadAdapter("codex");
      const descriptor = {
        stage: "stage-01", role: "pm", rolesInStage: ["pm"], workstreamId: "stage-01",
        objective: "test", readFirst: [], allowedWrites: ["pipeline/brief.md"],
        artifact: "pipeline/brief.md", template: null, goalCondition: null, expectedGate: {}, changeId: null,
      };
      const ctx = {
        cwd: workspaceDir, processCwd: subjectDir, externalReviewMode: true,
        track: "review-only", orchestrator: "test", changeId: null, log: false,
      };
      const r = await runHeadless(adapter, descriptor, ctx);
      assert.deepEqual(r.writeViolations, ["subject:mutated.txt"],
        "expected exactly one subject-prefixed violation for the subject write");
    } finally {
      if (originalCmd !== undefined) process.env.DEVTEAM_HEADLESS_COMMAND = originalCmd;
      else delete process.env.DEVTEAM_HEADLESS_COMMAND;
      fs.rmSync(workspaceDir, { recursive: true, force: true });
      fs.rmSync(subjectDir, { recursive: true, force: true });
    }
  });

  test("a subject write is NOT flagged when externalReviewMode is unset (prototype-mode parity)", async () => {
    const { runHeadless } = require("../core/adapters/headless");
    const { loadAdapter } = require("../core/router");

    // Prototype mode (core/cli/commands/prototype.js) sets ctx.processCwd to
    // a workspace WITHOUT ever setting ctx.externalReviewMode — the subject
    // audit above must not fire for that shape, or every prototype build
    // would get spuriously flagged.
    const workspaceDir = fs.mkdtempSync(path.join(os.tmpdir(), "devteam-test-proto-ws-"));
    const targetDir = fs.mkdtempSync(path.join(os.tmpdir(), "devteam-test-proto-target-"));
    const originalCmd = process.env.DEVTEAM_HEADLESS_COMMAND;
    try {
      fs.mkdirSync(path.join(workspaceDir, "pipeline", "gates"), { recursive: true });
      execFileSync("git", ["init"], { cwd: targetDir });
      execFileSync("git", ["config", "user.email", "t@t.com"], { cwd: targetDir });
      execFileSync("git", ["config", "user.name", "T"], { cwd: targetDir });
      fs.writeFileSync(path.join(targetDir, "README.md"), "hi");
      execFileSync("git", ["add", "README.md"], { cwd: targetDir });
      execFileSync("git", ["commit", "-m", "init"], { cwd: targetDir });

      const scriptPath = writeMutationScript(workspaceDir);
      process.env.DEVTEAM_HEADLESS_COMMAND = `${process.execPath} ${scriptPath}`;

      const adapter = loadAdapter("codex");
      const descriptor = {
        stage: "stage-01", role: "pm", rolesInStage: ["pm"], workstreamId: "stage-01",
        objective: "test", readFirst: [], allowedWrites: ["pipeline/brief.md"],
        artifact: "pipeline/brief.md", template: null, goalCondition: null, expectedGate: {}, changeId: null,
      };
      const ctx = {
        cwd: workspaceDir, processCwd: targetDir, // externalReviewMode deliberately absent
        track: "full", orchestrator: "test", changeId: null, log: false,
      };
      const r = await runHeadless(adapter, descriptor, ctx);
      assert.deepEqual(r.writeViolations, [], "no subject audit should run without externalReviewMode");
    } finally {
      if (originalCmd !== undefined) process.env.DEVTEAM_HEADLESS_COMMAND = originalCmd;
      else delete process.env.DEVTEAM_HEADLESS_COMMAND;
      fs.rmSync(workspaceDir, { recursive: true, force: true });
      fs.rmSync(targetDir, { recursive: true, force: true });
    }
  });

  test("processCwd equal to cwd does not double-audit an allowed write", async () => {
    const { runHeadless } = require("../core/adapters/headless");
    const { loadAdapter } = require("../core/router");

    // Guards the `subjectRoot !== path.resolve(ctx.cwd)` check: without it,
    // an allowed write would still get flagged by the subject pass (which
    // uses an empty allowedWrites on purpose) whenever codeRoot and stateRoot
    // happen to be the same directory.
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "devteam-test-samedir-"));
    const originalCmd = process.env.DEVTEAM_HEADLESS_COMMAND;
    try {
      execFileSync("git", ["init"], { cwd: dir });
      execFileSync("git", ["config", "user.email", "t@t.com"], { cwd: dir });
      execFileSync("git", ["config", "user.name", "T"], { cwd: dir });
      fs.writeFileSync(path.join(dir, "README.md"), "hi");
      execFileSync("git", ["add", "README.md"], { cwd: dir });
      execFileSync("git", ["commit", "-m", "init"], { cwd: dir });
      fs.mkdirSync(path.join(dir, "pipeline", "gates"), { recursive: true });

      const scriptPath = writeMutationScript(dir, "pipeline/brief.md");
      process.env.DEVTEAM_HEADLESS_COMMAND = `${process.execPath} ${scriptPath}`;

      const adapter = loadAdapter("codex");
      const descriptor = {
        stage: "stage-01", role: "pm", rolesInStage: ["pm"], workstreamId: "stage-01",
        objective: "test", readFirst: [], allowedWrites: ["pipeline/brief.md"],
        artifact: "pipeline/brief.md", template: null, goalCondition: null, expectedGate: {}, changeId: null,
      };
      const ctx = {
        cwd: dir, processCwd: dir, externalReviewMode: true,
        track: "review-only", orchestrator: "test", changeId: null, log: false,
      };
      const r = await runHeadless(adapter, descriptor, ctx);
      assert.deepEqual(r.writeViolations, [], "an allowed write must not be flagged twice when codeRoot === stateRoot");
    } finally {
      if (originalCmd !== undefined) process.env.DEVTEAM_HEADLESS_COMMAND = originalCmd;
      else delete process.env.DEVTEAM_HEADLESS_COMMAND;
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});
