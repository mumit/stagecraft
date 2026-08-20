// core/paths.js — the shared "this path is Stagecraft's own, not the change"
// predicate, and the three readers that must agree on it.
//
// The list used to be copy-pasted into each reader and all three drifted the
// same way (covering `.codex/` and no other host). These tests pin both the
// predicate and the fact that every reader routes through it.

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { REPO_ROOT } = require("./_helpers");

const { isFrameworkOwnedPath, FRAMEWORK_OWNED_PREFIXES } =
  require(path.join(REPO_ROOT, "core", "paths"));
const { isManifestInputPath } =
  require(path.join(REPO_ROOT, "core", "context-manifest"));

test("isFrameworkOwnedPath: Stagecraft's own state", () => {
  assert.equal(isFrameworkOwnedPath(".devteam/rules/pipeline.md"), true);
  assert.equal(isFrameworkOwnedPath("pipeline/brief.md"), true);
  assert.equal(isFrameworkOwnedPath(".git/HEAD"), true);
  assert.equal(isFrameworkOwnedPath(".devteam-tmp/x"), true);
});

test("isFrameworkOwnedPath: every host's installed surface", () => {
  assert.equal(isFrameworkOwnedPath(".claude/skills/implement/SKILL.md"), true);
  assert.equal(isFrameworkOwnedPath(".claude/agents/dev-backend.md"), true);
  assert.equal(isFrameworkOwnedPath(".codex/prompts/roles/backend.md"), true);
  assert.equal(isFrameworkOwnedPath(".agents/skills/red-team/SKILL.md"), true);
  assert.equal(isFrameworkOwnedPath(".acp/stagecraft/roles/qa.md"), true);
  assert.equal(isFrameworkOwnedPath(".omnigent/stagecraft/skills/audit/SKILL.md"), true);
  assert.equal(isFrameworkOwnedPath(".openai-compat/skills/audit/SKILL.md"), true);
});

test("isFrameworkOwnedPath: project files that merely look similar are kept", () => {
  assert.equal(isFrameworkOwnedPath("src/index.js"), false);
  assert.equal(isFrameworkOwnedPath("docs/adr/001.md"), false);
  // Segment-boundary matching: a project's own directory whose name starts
  // with a framework prefix must not be swallowed.
  assert.equal(isFrameworkOwnedPath(".claude-notes/design.md"), false);
  assert.equal(isFrameworkOwnedPath("src/agents/router.js"), false);
  assert.equal(isFrameworkOwnedPath("pipelines/deploy.yml"), false);
});

test("isFrameworkOwnedPath: normalizes separators and leading ./", () => {
  assert.equal(isFrameworkOwnedPath(".claude\\skills\\x\\SKILL.md"), true);
  assert.equal(isFrameworkOwnedPath("./.claude/skills/x/SKILL.md"), true);
  assert.equal(isFrameworkOwnedPath(""), false);
  assert.equal(isFrameworkOwnedPath(null), false);
});

test("drift guard: every host's declared install roots are covered", () => {
  // The list is static so core/paths.js stays a zero-dependency leaf the render
  // path and guards can both sit on. This is what keeps it honest when a host
  // is added.
  const hostsDir = path.join(REPO_ROOT, "hosts");
  const missing = [];
  for (const host of fs.readdirSync(hostsDir)) {
    const capFile = path.join(hostsDir, host, "capabilities.json");
    if (!fs.existsSync(capFile)) continue;
    const caps = JSON.parse(fs.readFileSync(capFile, "utf8"));
    for (const key of ["skillsDir", "rolePromptsDir"]) {
      const dir = caps[key];
      if (typeof dir !== "string" || !dir.startsWith(".")) continue;
      if (!isFrameworkOwnedPath(`${dir.replace(/\/+$/, "")}/example.md`)) {
        missing.push(`${host}.${key} → ${dir}`);
      }
    }
  }
  assert.deepEqual(
    missing, [],
    "host install roots missing from FRAMEWORK_OWNED_PREFIXES in core/paths.js:\n" + missing.join("\n"),
  );
});

test("every reader routes through the shared predicate", () => {
  // A reader that reimplements the list is how the three drifted last time.
  for (const prefix of FRAMEWORK_OWNED_PREFIXES) {
    const sample = `${prefix}example/file.md`;
    assert.equal(isManifestInputPath(sample), false, `changed-file manifest still admits ${sample}`);
  }

  const rightSizing = fs.readFileSync(
    path.join(REPO_ROOT, "core", "pipeline", "right-sizing.js"), "utf8");
  assert.match(rightSizing, /isFrameworkOwnedPath/,
    "right-sizing must use the shared predicate, not its own prefix list");
  assert.doesNotMatch(rightSizing, /startsWith\("\.codex\//,
    "right-sizing still carries a hand-rolled framework-prefix check");

  const assessCmd = fs.readFileSync(
    path.join(REPO_ROOT, "core", "cli", "commands", "assess.js"), "utf8");
  assert.match(assessCmd, /isFrameworkOwnedPath/,
    "devteam assess must filter framework paths out of its file list");
});
