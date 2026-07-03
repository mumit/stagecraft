const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { spawnSync } = require("node:child_process");
const { REPO_ROOT } = require("./_helpers");

const {
  collectChangedFileManifest,
  isManifestInputPath,
  parsePorcelainStatus,
} = require(path.join(REPO_ROOT, "core", "context-manifest"));

function tmpdir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), "devteam-context-manifest-"));
}

function git(cwd, args) {
  const result = spawnSync("git", args, { cwd, encoding: "utf8" });
  assert.equal(result.status, 0, `git ${args.join(" ")} failed:\n${result.stderr}`);
}

test("context-manifest: excludes process-only paths", () => {
  assert.equal(isManifestInputPath("src/app.js"), true);
  assert.equal(isManifestInputPath("pipeline/brief.md"), false);
  assert.equal(isManifestInputPath(".codex-tmp/runtime/file"), false);
  assert.equal(isManifestInputPath(".devteam/rules/pipeline.md"), false);
});

test("context-manifest: parses porcelain paths and rename targets", () => {
  const parsed = parsePorcelainStatus(" M src/app.js\0?? test/new.test.js\0R  src/old.js\0src/new.js\0");
  assert.deepEqual(parsed.map((f) => f.path), ["src/app.js", "test/new.test.js", "src/new.js"]);
  assert.equal(parsed[2].previous_path, "src/old.js");
});

test("context-manifest: collects path, status, byte size, and digest without contents", () => {
  const cwd = tmpdir();
  try {
    git(cwd, ["init"]);
    fs.mkdirSync(path.join(cwd, "src"), { recursive: true });
    fs.writeFileSync(path.join(cwd, "src", "app.js"), "console.log('secret-ish implementation');\n");
    fs.writeFileSync(path.join(cwd, "pipeline.md"), "root file\n");

    const manifest = collectChangedFileManifest(cwd);
    assert.equal(manifest.ok, true);
    assert.equal(manifest.truncated, false);
    assert.deepEqual(manifest.files.map((f) => f.path).sort(), ["pipeline.md", "src/app.js"]);
    const app = manifest.files.find((f) => f.path === "src/app.js");
    assert.equal(app.status, "??");
    assert.equal(app.bytes, "console.log('secret-ish implementation');\n".length);
    assert.match(app.sha256, /^sha256:[0-9a-f]{64}$/);
    assert.equal(JSON.stringify(manifest).includes("secret-ish"), false);
  } finally {
    fs.rmSync(cwd, { recursive: true, force: true });
  }
});

test("context-manifest: caps large manifests", () => {
  const cwd = tmpdir();
  try {
    git(cwd, ["init"]);
    fs.writeFileSync(path.join(cwd, "a.txt"), "a");
    fs.writeFileSync(path.join(cwd, "b.txt"), "b");
    const manifest = collectChangedFileManifest(cwd, { limit: 1 });
    assert.equal(manifest.files.length, 1);
    assert.equal(manifest.truncated, true);
    assert.equal(manifest.omitted_count, 1);
  } finally {
    fs.rmSync(cwd, { recursive: true, force: true });
  }
});
