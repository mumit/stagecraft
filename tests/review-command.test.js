// tests/review-command.test.js
//
// Phase-36 item 36.4 (plans/phase-36-external-review-mode.md §36.4) —
// `devteam review <path>`, the zero-install entry point: no init, no config,
// nothing written to the subject.
//
// Coverage:
//   1. --list: empty case, and rendering an existing workspace's subject
//      path / last run date / last status (human + --json).
//   2. Host honesty: --host anything other than acp warns and refuses
//      without --allow-unenforced-writes; proceeds (still warning) with it.
//      No workspace is created on refusal.
//   3. THE TEST THAT MATTERS: end-to-end against a fixture subject repo with
//      the scripted ACP stub agent (tests/fixtures/acp-stub-review-agent.js)
//      — produces a findings report, the subject tree is byte-identical
//      before/after, and `devteam review --list` picks up the completed run.
//   4. --json output validated against the checked-in schemas
//      (core/review/schemas/review.schema.json,
//      core/review/schemas/review-list.schema.json).

"use strict";

const { describe, it, afterEach } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const crypto = require("node:crypto");
const { spawnSync } = require("node:child_process");

const { REPO_ROOT, cleanup, runCLI } = require("./_helpers");

const STUB_PATH = path.join(REPO_ROOT, "tests", "fixtures", "acp-stub-review-agent.js");

let _dirs = [];
function track(dir) { _dirs.push(dir); return dir; }
afterEach(() => { _dirs.forEach(cleanup); _dirs = []; });

function tmpdir(prefix) {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  return track(d);
}

function makeFixtureSubjectRepo() {
  const dir = tmpdir("devteam-test-subject-");
  spawnSync("git", ["init", "-q", "-b", "main"], { cwd: dir });
  spawnSync("git", ["config", "user.email", "test@example.com"], { cwd: dir });
  spawnSync("git", ["config", "user.name", "Test"], { cwd: dir });
  fs.writeFileSync(path.join(dir, "AGENTS.md"), "# fixture subject project\n");
  fs.writeFileSync(path.join(dir, ".gitignore"), "node_modules/\n");
  fs.mkdirSync(path.join(dir, "src"), { recursive: true });
  fs.writeFileSync(path.join(dir, "src", "index.js"), "module.exports = 1;\n");
  spawnSync("git", ["add", "-A"], { cwd: dir });
  spawnSync("git", ["commit", "-q", "-m", "init", "--no-gpg-sign"], { cwd: dir });
  return dir;
}

// File list + content hash, including dotfiles — .git is excluded (internal
// bookkeeping, not "the subject" the plan's promise is about).
function snapshotTree(dir) {
  const files = [];
  function walk(rel) {
    for (const entry of fs.readdirSync(path.join(dir, rel), { withFileTypes: true })) {
      if (rel === "" && entry.name === ".git") continue;
      const relPath = rel ? `${rel}/${entry.name}` : entry.name;
      if (entry.isDirectory()) walk(relPath);
      else files.push(relPath);
    }
  }
  walk("");
  files.sort();
  const hash = crypto.createHash("sha256");
  for (const f of files) {
    hash.update(f);
    hash.update(fs.readFileSync(path.join(dir, f)));
  }
  return { files, digest: hash.digest("hex") };
}

function baseEnv(reviewsDir, extra = {}) {
  return { STAGECRAFT_REVIEWS_DIR: reviewsDir, DEVTEAM_NO_LOG: "1", ...extra };
}

// ─── 1. --list ──────────────────────────────────────────────────────────────

describe("36.4: devteam review --list", () => {
  it("renders the empty case without error", () => {
    const reviewsDir = tmpdir("devteam-test-reviews-");
    const r = runCLI(["review", "--list"], { env: baseEnv(reviewsDir) });
    assert.equal(r.status, 0, r.stderr);
    assert.match(r.stdout, /No review workspaces yet/);
  });

  it("--list --json emits an empty workspaces[] for the empty case", () => {
    const reviewsDir = tmpdir("devteam-test-reviews-");
    const r = runCLI(["review", "--list", "--json"], { env: baseEnv(reviewsDir) });
    assert.equal(r.status, 0, r.stderr);
    const data = JSON.parse(r.stdout);
    assert.deepEqual(data.workspaces, []);
    assert.equal(data.reviews_root, reviewsDir);
  });

  it("lists a workspace's subject path once created, before any run (last_status null)", () => {
    const reviewsDir = tmpdir("devteam-test-reviews-");
    const subject = makeFixtureSubjectRepo();
    const { createReviewWorkspace, resolveWorkspacePath } = require(path.join(REPO_ROOT, "core", "review-workspace"));
    process.env.STAGECRAFT_REVIEWS_DIR = reviewsDir;
    try {
      createReviewWorkspace({ subjectPath: subject, workspacePath: resolveWorkspacePath(subject), host: "acp", track: "review-only" });
    } finally {
      delete process.env.STAGECRAFT_REVIEWS_DIR;
    }

    const r = runCLI(["review", "--list", "--json"], { env: baseEnv(reviewsDir) });
    assert.equal(r.status, 0, r.stderr);
    const data = JSON.parse(r.stdout);
    assert.equal(data.workspaces.length, 1);
    assert.equal(data.workspaces[0].subject_path, path.resolve(subject));
    assert.equal(data.workspaces[0].last_run_at, null);
    assert.equal(data.workspaces[0].last_status, null);

    const human = runCLI(["review", "--list"], { env: baseEnv(reviewsDir) });
    assert.match(human.stdout, /subject:\s+/);
    assert.match(human.stdout, /last run:\s+\(never\)/);
  });
});

// ─── 2. Host honesty ────────────────────────────────────────────────────────

describe("36.4: host honesty — only --host acp mechanically prevents subject writes", () => {
  it("refuses a non-acp host without --allow-unenforced-writes, and creates no workspace", () => {
    const reviewsDir = tmpdir("devteam-test-reviews-");
    const subject = makeFixtureSubjectRepo();
    const r = runCLI(["review", subject, "--host", "codex"], { env: baseEnv(reviewsDir) });
    assert.equal(r.status, 1, r.stdout + r.stderr);
    assert.match(r.stderr, /cannot mechanically prevent writes/);
    assert.match(r.stderr, /--allow-unenforced-writes/);
    assert.ok(fs.existsSync(reviewsDir) === false || fs.readdirSync(reviewsDir).length === 0, "no workspace should have been created on refusal");
  });

  it("still prints the warning but proceeds past the refusal gate with --allow-unenforced-writes", () => {
    const reviewsDir = tmpdir("devteam-test-reviews-");
    const subject = makeFixtureSubjectRepo();
    // DEVTEAM_HEADLESS_COMMAND=cat never writes a gate; the run will
    // eventually convergence-halt as structural. We only care that it got
    // PAST the host-honesty refusal (proved by the workspace existing and
    // the different stderr wording), not that the whole track completes.
    const r = runCLI(["review", subject, "--host", "codex", "--allow-unenforced-writes", "--json"], {
      env: baseEnv(reviewsDir, { DEVTEAM_HEADLESS_COMMAND: "cat" }),
    });
    assert.match(r.stderr, /Proceeding on --allow-unenforced-writes/);
    assert.ok(!/Pass --allow-unenforced-writes to proceed/.test(r.stderr));
    assert.ok(fs.existsSync(reviewsDir) && fs.readdirSync(reviewsDir).length === 1, "a workspace must have been created once past the honesty gate");
  });

  it("acp needs no acknowledgement flag and prints no host-honesty warning", () => {
    const reviewsDir = tmpdir("devteam-test-reviews-");
    const subject = makeFixtureSubjectRepo();
    const r = runCLI(["review", subject, "--host", "acp", "--json"], {
      env: baseEnv(reviewsDir, { DEVTEAM_HEADLESS_COMMAND: "cat" }),
    });
    assert.ok(!/cannot mechanically prevent writes/.test(r.stderr));
  });
});

// ─── 3. THE TEST THAT MATTERS ───────────────────────────────────────────────

describe("36.4: end-to-end against a fixture repo with the scripted ACP stub agent", () => {
  it("produces a findings report and leaves the subject tree byte-identical, and --list reflects the completed run", () => {
    const reviewsDir = tmpdir("devteam-test-reviews-");
    const subject = makeFixtureSubjectRepo();
    const before = snapshotTree(subject);

    const { resolveWorkspacePath } = require(path.join(REPO_ROOT, "core", "review-workspace"));
    process.env.STAGECRAFT_REVIEWS_DIR = reviewsDir;
    let workspacePath;
    try {
      workspacePath = resolveWorkspacePath(subject);
    } finally {
      delete process.env.STAGECRAFT_REVIEWS_DIR;
    }

    const r = runCLI(["review", subject, "--json"], {
      env: baseEnv(reviewsDir, {
        DEVTEAM_HEADLESS_COMMAND: `node "${STUB_PATH}"`,
        ACP_STUB_WORKSPACE_ROOT: workspacePath,
      }),
    });
    assert.equal(r.status, 0, `devteam review failed: ${r.stdout}\n---\n${r.stderr}`);

    const data = JSON.parse(r.stdout);
    assert.equal(data.completed, true, JSON.stringify(data));
    assert.equal(data.review_mode_enforced, true);
    assert.equal(data.workspace, workspacePath);
    assert.ok(data.findings_report && fs.existsSync(data.findings_report.path), "findings report file must exist");
    assert.equal(data.findings_report.total, 0, "the stub's gates carry no findings");

    // Every gate/log/artifact lands under the workspace, never the subject.
    assert.ok(!fs.existsSync(path.join(subject, "pipeline")), "no pipeline/ directory was ever created in the subject");
    assert.ok(fs.existsSync(path.join(workspacePath, "pipeline", "gates", "stage-04b.json")));
    assert.ok(fs.existsSync(path.join(workspacePath, "pipeline", "gates", "stage-04c.json")));
    assert.ok(fs.existsSync(path.join(workspacePath, "pipeline", "gates", "stage-05.json")));

    // THE core promise: the subject tree is completely unchanged.
    const after = snapshotTree(subject);
    assert.deepEqual(after.files, before.files, "no file added or removed in the subject");
    assert.equal(after.digest, before.digest, "no file content changed in the subject (incl. .gitignore/AGENTS.md)");

    // --list now shows this workspace as completed.
    const listResult = runCLI(["review", "--list", "--json"], { env: baseEnv(reviewsDir) });
    const listData = JSON.parse(listResult.stdout);
    assert.equal(listData.workspaces.length, 1);
    assert.equal(listData.workspaces[0].subject_path, path.resolve(subject));
    assert.equal(listData.workspaces[0].last_status, "completed");
    assert.ok(listData.workspaces[0].last_run_at, "last_run_at must be recorded");
  });
});

// ─── 4. --json shape matches the checked-in schemas ────────────────────────

describe("36.4: --json output matches the checked-in schemas", () => {
  it("devteam review --json satisfies review.schema.json's required shape", () => {
    const reviewsDir = tmpdir("devteam-test-reviews-");
    const subject = makeFixtureSubjectRepo();
    const { resolveWorkspacePath } = require(path.join(REPO_ROOT, "core", "review-workspace"));
    process.env.STAGECRAFT_REVIEWS_DIR = reviewsDir;
    let workspacePath;
    try {
      workspacePath = resolveWorkspacePath(subject);
    } finally {
      delete process.env.STAGECRAFT_REVIEWS_DIR;
    }

    const r = runCLI(["review", subject, "--json"], {
      env: baseEnv(reviewsDir, {
        DEVTEAM_HEADLESS_COMMAND: `node "${STUB_PATH}"`,
        ACP_STUB_WORKSPACE_ROOT: workspacePath,
      }),
    });
    assert.equal(r.status, 0, r.stderr);
    const data = JSON.parse(r.stdout);

    const schema = JSON.parse(fs.readFileSync(
      path.join(REPO_ROOT, "core", "review", "schemas", "review.schema.json"), "utf8",
    ));
    assert.equal(schema.$id, "urn:stagecraft:schema:review");
    for (const key of schema.required) assert.ok(key in data, `top-level output missing required "${key}"`);
    for (const key of schema.properties.subject.required) assert.ok(key in data.subject, `subject missing required "${key}"`);
    for (const key of schema.properties.findings_report.anyOf[0].required) {
      assert.ok(key in data.findings_report, `findings_report missing required "${key}"`);
    }
  });

  it("devteam review --list --json satisfies review-list.schema.json's required shape", () => {
    const reviewsDir = tmpdir("devteam-test-reviews-");
    makeFixtureSubjectRepo(); // unused directly; just exercising the schema shape below
    const r = runCLI(["review", "--list", "--json"], { env: baseEnv(reviewsDir) });
    assert.equal(r.status, 0, r.stderr);
    const data = JSON.parse(r.stdout);

    const schema = JSON.parse(fs.readFileSync(
      path.join(REPO_ROOT, "core", "review", "schemas", "review-list.schema.json"), "utf8",
    ));
    assert.equal(schema.$id, "urn:stagecraft:schema:review-list");
    for (const key of schema.required) assert.ok(key in data, `top-level output missing required "${key}"`);
  });
});
