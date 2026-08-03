// core/prompt-pack.js — content-hash version of the prompt surface
// (phase-33 item 33.3, plans/phase-33-eval-flywheel.md §33.3).

const { describe, it, afterEach } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { REPO_ROOT, cleanup } = require("./_helpers");
const { computePromptPackVersion, SURFACE_DIRS, HASH_LENGTH } =
  require(path.join(REPO_ROOT, "core", "prompt-pack"));

let _dirs = [];
function track(dir) { _dirs.push(dir); return dir; }
afterEach(() => { _dirs.forEach(cleanup); _dirs = []; });

// Build a minimal fixture repo root with only the three surface dirs, so
// tests never depend on (or mutate) this repo's own roles/rules/templates.
function makeFixtureRoot(files) {
  const root = track(fs.mkdtempSync(path.join(os.tmpdir(), "devteam-test-prompt-pack-")));
  for (const [rel, content] of Object.entries(files)) {
    const abs = path.join(root, rel);
    fs.mkdirSync(path.dirname(abs), { recursive: true });
    fs.writeFileSync(abs, content);
  }
  return root;
}

describe("computePromptPackVersion", () => {
  it("is a stable, deterministic short hex id", () => {
    const root = makeFixtureRoot({ "roles/pm.md": "You are the PM.\n" });
    const v1 = computePromptPackVersion(root);
    const v2 = computePromptPackVersion(root);
    assert.equal(v1, v2);
    assert.match(v1, new RegExp(`^[0-9a-f]{${HASH_LENGTH}}$`));
  });

  it("SURFACE_DIRS is exactly roles/rules/templates", () => {
    assert.deepEqual([...SURFACE_DIRS].sort(), ["roles", "rules", "templates"]);
  });

  it("changes when a role brief's content changes", () => {
    const root = makeFixtureRoot({ "roles/pm.md": "Version A\n" });
    const before = computePromptPackVersion(root);
    fs.writeFileSync(path.join(root, "roles", "pm.md"), "Version B\n");
    const after = computePromptPackVersion(root);
    assert.notEqual(before, after);
  });

  it("changes when a rule file's content changes", () => {
    const root = makeFixtureRoot({ "rules/gates-core.md": "Rule A\n" });
    const before = computePromptPackVersion(root);
    fs.writeFileSync(path.join(root, "rules", "gates-core.md"), "Rule B\n");
    const after = computePromptPackVersion(root);
    assert.notEqual(before, after);
  });

  it("changes when a template's content changes", () => {
    const root = makeFixtureRoot({ "templates/brief-template.md": "Template A\n" });
    const before = computePromptPackVersion(root);
    fs.writeFileSync(path.join(root, "templates", "brief-template.md"), "Template B\n");
    const after = computePromptPackVersion(root);
    assert.notEqual(before, after);
  });

  it("changes on a file rename with identical content (path is part of the hash)", () => {
    const root = makeFixtureRoot({ "roles/pm.md": "Same content\n" });
    const before = computePromptPackVersion(root);
    fs.renameSync(path.join(root, "roles", "pm.md"), path.join(root, "roles", "pm2.md"));
    const after = computePromptPackVersion(root);
    assert.notEqual(before, after);
  });

  it("changes when a file is added under a surface dir", () => {
    const root = makeFixtureRoot({ "roles/pm.md": "PM brief\n" });
    const before = computePromptPackVersion(root);
    fs.writeFileSync(path.join(root, "roles", "backend.md"), "Backend brief\n");
    const after = computePromptPackVersion(root);
    assert.notEqual(before, after);
  });

  it("is unaffected by files outside roles/rules/templates", () => {
    const root = makeFixtureRoot({ "roles/pm.md": "PM brief\n" });
    const before = computePromptPackVersion(root);
    fs.writeFileSync(path.join(root, "package.json"), JSON.stringify({ version: "9.9.9" }));
    fs.mkdirSync(path.join(root, "pipeline"), { recursive: true });
    fs.writeFileSync(path.join(root, "pipeline", "brief.md"), "not part of the prompt surface\n");
    const after = computePromptPackVersion(root);
    assert.equal(before, after);
  });

  it("is unaffected by nested subdirectory files elsewhere unless under a surface dir", () => {
    const root = makeFixtureRoot({
      "roles/pm.md": "PM brief\n",
      "templates/ci/github-actions/workflow.yml": "name: ci\n",
    });
    const before = computePromptPackVersion(root);
    fs.writeFileSync(path.join(root, "templates", "ci", "github-actions", "workflow.yml"), "name: ci-changed\n");
    const after = computePromptPackVersion(root);
    assert.notEqual(before, after, "nested files under templates/ must contribute to the hash");
  });

  it("does not throw when a surface dir is absent", () => {
    const root = makeFixtureRoot({ "roles/pm.md": "PM brief\n" }); // no rules/, no templates/
    assert.doesNotThrow(() => computePromptPackVersion(root));
  });

  it("matches when computed twice against this repo's real roles/rules/templates", () => {
    // Sanity check against the actual framework checkout (default repoRoot).
    const a = computePromptPackVersion();
    const b = computePromptPackVersion();
    assert.equal(a, b);
    assert.match(a, new RegExp(`^[0-9a-f]{${HASH_LENGTH}}$`));
  });
});
