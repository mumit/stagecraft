"use strict";

const { describe, it, afterEach } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const { REPO_ROOT, cleanup, runCLI } = require("./_helpers");
const { writeGitignoreBlock, CANONICAL_BLOCK, BLOCK_BEGIN, BLOCK_END } =
  require(path.join(REPO_ROOT, "core", "gitignore"));

let _dirs = [];
function track(cwd) { _dirs.push(cwd); return cwd; }
afterEach(() => { _dirs.forEach(cleanup); _dirs = []; });

function giPath(cwd) { return path.join(cwd, ".gitignore"); }

describe("writeGitignoreBlock", () => {
  it("creates .gitignore with block when file does not exist", () => {
    const cwd = track(fs.mkdtempSync(path.join(os.tmpdir(), "devteam-test-")));
    assert.ok(!fs.existsSync(giPath(cwd)));

    const result = writeGitignoreBlock(cwd);

    assert.equal(result, "wrote");
    const content = fs.readFileSync(giPath(cwd), "utf8");
    assert.ok(content.includes(BLOCK_BEGIN));
    assert.ok(content.includes(BLOCK_END));
    assert.ok(content.includes("pipeline/run.lock"));
    assert.ok(content.includes(".devteam/memory/"));
    assert.ok(content.includes(".devteam/worktrees/"));
    assert.ok(content.includes(".devteam/evidence-project-id"));
    assert.ok(!content.includes("pipeline/prototypes/"), "prototype packets are committable learning artifacts");
  });

  it("appends block to existing .gitignore with no block; preserves existing content", () => {
    const cwd = track(fs.mkdtempSync(path.join(os.tmpdir(), "devteam-test-")));
    const preexisting = "node_modules/\n.env\n";
    fs.writeFileSync(giPath(cwd), preexisting, "utf8");

    const result = writeGitignoreBlock(cwd);

    assert.equal(result, "wrote");
    const content = fs.readFileSync(giPath(cwd), "utf8");
    assert.ok(content.startsWith("node_modules/\n.env\n"), "pre-existing content must be preserved at the start");
    assert.ok(content.includes(BLOCK_BEGIN));
    assert.ok(content.includes("pipeline/run.lock"));
  });

  it("is a no-op when block already matches canonical", () => {
    const cwd = track(fs.mkdtempSync(path.join(os.tmpdir(), "devteam-test-")));
    fs.writeFileSync(giPath(cwd), CANONICAL_BLOCK + "\n", "utf8");

    const result = writeGitignoreBlock(cwd);

    assert.equal(result, "skipped");
    // content unchanged
    const content = fs.readFileSync(giPath(cwd), "utf8");
    assert.equal(content, CANONICAL_BLOCK + "\n");
  });

  it("replaces outdated block; preserves content before and after", () => {
    const cwd = track(fs.mkdtempSync(path.join(os.tmpdir(), "devteam-test-")));
    const oldBlock = `${BLOCK_BEGIN}\npipeline/logs/\n${BLOCK_END}`;
    const before = "node_modules/\n";
    const after = "\ndist/\n";
    fs.writeFileSync(giPath(cwd), before + oldBlock + after, "utf8");

    const result = writeGitignoreBlock(cwd);

    assert.equal(result, "updated");
    const content = fs.readFileSync(giPath(cwd), "utf8");
    assert.ok(content.startsWith(before), "content before block must be preserved");
    assert.ok(content.includes(after), "content after block must be preserved");
    assert.ok(content.includes("pipeline/run.lock"), "canonical entry must appear");
    assert.ok(!content.includes("pipeline/logs/\n# END"), "old minimal block must be replaced");
    // Exactly one begin/end pair
    assert.equal((content.match(new RegExp(BLOCK_BEGIN.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "g")) || []).length, 1);
  });

  it("overwrites user content inside delimiters (function owns the block interior)", () => {
    const cwd = track(fs.mkdtempSync(path.join(os.tmpdir(), "devteam-test-")));
    const blockWithUserContent = `${BLOCK_BEGIN}\nmy-custom-entry/\n${BLOCK_END}`;
    fs.writeFileSync(giPath(cwd), blockWithUserContent, "utf8");

    const result = writeGitignoreBlock(cwd);

    assert.equal(result, "updated");
    const content = fs.readFileSync(giPath(cwd), "utf8");
    assert.ok(!content.includes("my-custom-entry/"));
    assert.ok(content.includes("pipeline/run.lock"));
  });

  it("does not create a second block on repeated calls", () => {
    const cwd = track(fs.mkdtempSync(path.join(os.tmpdir(), "devteam-test-")));

    writeGitignoreBlock(cwd);
    const result2 = writeGitignoreBlock(cwd);

    assert.equal(result2, "skipped");
    const content = fs.readFileSync(giPath(cwd), "utf8");
    const matches = (content.match(/# BEGIN stagecraft/g) || []).length;
    assert.equal(matches, 1, "must have exactly one block");
  });
});

describe("devteam init writes gitignore block", () => {
  it("writes the block when initializing a new project dir", () => {
    const cwd = track(fs.mkdtempSync(path.join(os.tmpdir(), "devteam-test-")));
    const r = runCLI(["init", "--host", "generic", "--cwd", cwd]);
    assert.equal(r.status, 0, `init failed: ${r.stderr}`);
    const content = fs.readFileSync(giPath(cwd), "utf8");
    assert.ok(content.includes(BLOCK_BEGIN));
    assert.ok(content.includes("pipeline/run.lock"));
    assert.ok(r.stdout.includes(".gitignore (stagecraft block)"));
  });

  it("re-runs block write on --force; no duplicate block", () => {
    const cwd = track(fs.mkdtempSync(path.join(os.tmpdir(), "devteam-test-")));
    runCLI(["init", "--host", "generic", "--cwd", cwd]);
    const r2 = runCLI(["init", "--host", "generic", "--cwd", cwd, "--force"]);
    assert.equal(r2.status, 0);
    const content = fs.readFileSync(giPath(cwd), "utf8");
    const matches = (content.match(/# BEGIN stagecraft/g) || []).length;
    assert.equal(matches, 1);
  });

  it("updates an outdated block silently on reinit without --force", () => {
    const cwd = track(fs.mkdtempSync(path.join(os.tmpdir(), "devteam-test-")));
    const oldBlock = `${BLOCK_BEGIN}\npipeline/logs/\n${BLOCK_END}\n`;
    fs.writeFileSync(giPath(cwd), oldBlock, "utf8");
    const r = runCLI(["init", "--host", "generic", "--cwd", cwd]);
    assert.equal(r.status, 0);
    const content = fs.readFileSync(giPath(cwd), "utf8");
    assert.ok(content.includes("pipeline/run.lock"), "block should be updated to canonical");
    assert.ok(r.stdout.includes("updated .gitignore"));
  });
});
