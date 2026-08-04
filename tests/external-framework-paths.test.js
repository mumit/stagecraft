// tests/external-framework-paths.test.js
//
// Phase 36.2 (plans/phase-36-external-review-mode.md §36.2): framework
// files (Stagecraft's own rules/role-briefs/templates) must resolve when a
// review workspace's stateRoot differs from the subject's codeRoot (36.1's
// two-root model, hosts/acp/adapter.js). AGENTS.md is deliberately excluded
// from "framework" — it stays subject-rooted, see core/pipeline/stages.js's
// why-comment on FRAMEWORK_ROOTED_READ_FIRST.
//
// Coverage:
//   1. buildDescriptor(): equal roots (ctx.processCwd unset, or equal to
//      cwd) is byte-identical to a run that never set processCwd at all.
//   2. buildDescriptor(): differing roots resolve framework readFirst
//      entries to an absolute, stateRoot-rooted path; AGENTS.md is left
//      alone (relative, unresolved); nothing points into codeRoot.
//   3. Rendered prompt (acp adapter, shared core/adapters/markdown-host.js
//      renderer): differing roots -> role brief + template pointers are
//      absolute and resolvable under stateRoot, and the full prompt
//      contains no path into the subject; equal roots -> prompt is
//      byte-identical to a run with ctx.processCwd unset (this item's
//      required regression, alongside the existing 32.1 cache-layer test in
//      tests/prompt-layout.test.js, which this change does not touch).

"use strict";

const { test, describe } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { REPO_ROOT } = require("./_helpers");
const { loadAdapter } = require("./_host-plugins");

const { buildDescriptor } = require(path.join(REPO_ROOT, "core", "orchestrator"));
const { getStage } = require(path.join(REPO_ROOT, "core", "pipeline", "stages"));

function mkTmp(prefix) {
  return fs.mkdtempSync(path.join(os.tmpdir(), `devteam-test-${prefix}-`));
}

describe("36.2: buildDescriptor readFirst root resolution", () => {
  test("equal roots (processCwd === cwd) is byte-identical to processCwd unset", () => {
    const cwd = mkTmp("equal-root");
    try {
      const stageDef = getStage("security-review");
      const withProcessCwd = buildDescriptor(stageDef, "security", { cwd, processCwd: cwd });
      const withoutProcessCwd = buildDescriptor(stageDef, "security", { cwd });
      assert.deepEqual(withProcessCwd.readFirst, withoutProcessCwd.readFirst);
    } finally {
      fs.rmSync(cwd, { recursive: true, force: true });
    }
  });

  test("differing roots: framework readFirst entries become absolute paths into stateRoot; AGENTS.md stays subject-relative", () => {
    const stateRoot = mkTmp("state-root");
    const codeRoot = mkTmp("code-root");
    try {
      const stageDef = getStage("security-review");
      const desc = buildDescriptor(stageDef, "security", { cwd: stateRoot, processCwd: codeRoot });

      const rulesPathSuffix = (name) => path.join(".devteam", "rules", name);
      const pipelineRule = desc.readFirst.find((p) => p.endsWith(rulesPathSuffix("pipeline.md")));
      const gatesRule = desc.readFirst.find((p) => p.endsWith(rulesPathSuffix("gates-core.md")));
      assert.ok(pipelineRule, `expected .devteam/rules/pipeline.md in readFirst, got ${JSON.stringify(desc.readFirst)}`);
      assert.ok(gatesRule, `expected .devteam/rules/gates-core.md in readFirst, got ${JSON.stringify(desc.readFirst)}`);

      for (const p of [pipelineRule, gatesRule]) {
        assert.ok(path.isAbsolute(p), `framework path must be absolute: ${p}`);
        assert.ok(p.startsWith(path.resolve(stateRoot)), `framework path must resolve into stateRoot: ${p}`);
        assert.ok(!p.startsWith(path.resolve(codeRoot)), `framework path must not point into the subject (codeRoot): ${p}`);
      }

      assert.ok(desc.readFirst.includes("AGENTS.md"), "AGENTS.md must stay subject-rooted (relative, unresolved)");
    } finally {
      fs.rmSync(stateRoot, { recursive: true, force: true });
      fs.rmSync(codeRoot, { recursive: true, force: true });
    }
  });
});

describe("36.2: rendered prompt (acp host) framework-path resolution", () => {
  test("equal roots: rendered prompt is byte-identical whether or not ctx.processCwd is set", () => {
    const adapter = loadAdapter("acp");
    const cwd = mkTmp("acp-equal");
    try {
      const stageDef = getStage("security-review");
      const descriptor = buildDescriptor(stageDef, "security", { cwd });
      const ctxNoProcessCwd = { track: "review-only", orchestrator: "devteam@test", cwd };
      const ctxEqualProcessCwd = { ...ctxNoProcessCwd, processCwd: cwd };

      const a = adapter.renderStagePrompt(descriptor, ctxNoProcessCwd);
      const b = adapter.renderStagePrompt(descriptor, ctxEqualProcessCwd);
      assert.equal(a, b, "equal-root prompts must be byte-identical regardless of whether processCwd is explicitly set");
    } finally {
      fs.rmSync(cwd, { recursive: true, force: true });
    }
  });

  test("differing roots: role brief and template pointers are absolute, resolvable, and never point into the subject", () => {
    const adapter = loadAdapter("acp");
    const stateRoot = mkTmp("acp-state");
    const codeRoot = mkTmp("acp-code");
    try {
      // Simulate 36.3's review workspace: it carries its own copy of the
      // role brief + template this descriptor needs.
      fs.mkdirSync(path.join(stateRoot, ".acp", "stagecraft", "roles"), { recursive: true });
      fs.writeFileSync(path.join(stateRoot, ".acp", "stagecraft", "roles", "security.md"), "# security role brief\n");
      fs.mkdirSync(path.join(stateRoot, ".devteam", "templates"), { recursive: true });
      fs.writeFileSync(path.join(stateRoot, ".devteam", "templates", "review-template.md"), "# review template\n");

      // A same-named file under codeRoot proves resolution favors stateRoot,
      // not "wherever the agent's cwd happens to be."
      fs.mkdirSync(path.join(codeRoot, ".acp", "stagecraft", "roles"), { recursive: true });
      fs.writeFileSync(path.join(codeRoot, ".acp", "stagecraft", "roles", "security.md"), "# WRONG -- subject copy, must not be referenced\n");

      const stageDef = getStage("security-review");
      const descriptor = buildDescriptor(stageDef, "security", { cwd: stateRoot, processCwd: codeRoot });
      const ctx = { track: "review-only", orchestrator: "devteam@test", cwd: stateRoot, processCwd: codeRoot };

      const prompt = adapter.renderStagePrompt(descriptor, ctx);

      const briefMatch = prompt.match(/Read the role prompt at `([^`]+)`/);
      assert.ok(briefMatch, "expected a role-prompt pointer line in the rendered prompt");
      const briefPath = briefMatch[1];
      assert.ok(path.isAbsolute(briefPath), `role brief pointer must be absolute: ${briefPath}`);
      assert.ok(fs.existsSync(briefPath), `role brief pointer must be resolvable: ${briefPath}`);
      assert.ok(briefPath.startsWith(path.resolve(stateRoot)), `role brief pointer must resolve into stateRoot: ${briefPath}`);
      assert.ok(!briefPath.startsWith(path.resolve(codeRoot)), `role brief pointer must not point into the subject: ${briefPath}`);

      const templateMatch = prompt.match(/using `([^`]+)`/);
      assert.ok(templateMatch, "expected a template pointer line in the rendered prompt");
      const templatePath = templateMatch[1];
      assert.ok(path.isAbsolute(templatePath), `template pointer must be absolute: ${templatePath}`);
      assert.ok(fs.existsSync(templatePath), `template pointer must be resolvable: ${templatePath}`);
      assert.ok(templatePath.startsWith(path.resolve(stateRoot)), `template pointer must resolve into stateRoot: ${templatePath}`);

      assert.ok(!prompt.includes(path.resolve(codeRoot)), "rendered prompt must not reference any absolute path into the subject");
    } finally {
      fs.rmSync(stateRoot, { recursive: true, force: true });
      fs.rmSync(codeRoot, { recursive: true, force: true });
    }
  });
});
