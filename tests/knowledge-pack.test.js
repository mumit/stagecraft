"use strict";

const { describe, it, afterEach } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const { REPO_ROOT, makeTargetProject, cleanup } = require("./_helpers");
const {
  MAX_BYTES,
  factsFromDiscovery,
  projectKnowledgePath,
  writeProjectFacts,
  loadProjectFacts,
  loadCurrentProjectFacts,
} = require(path.join(REPO_ROOT, "core", "knowledge-pack"));
const { runStage } = require(path.join(REPO_ROOT, "core", "orchestrator"));

const dirs = [];
afterEach(() => {
  while (dirs.length > 0) cleanup(dirs.pop());
});

function discovery(overrides = {}) {
  return {
    timestamp: "2026-08-08T00:00:00.000Z",
    tech_stack: { languages: ["TypeScript"], frameworks: ["React"], package_manager: "npm", bundler: "Vite" },
    module_system: "esm",
    naming: { file_style: "kebab-case" },
    tooling: { typescript: true, eslint: true, prettier: false },
    test_config: { framework: "Vitest", pattern: "**/*.test.{js,ts,jsx,tsx}", co_located: true },
    verification_commands: ["npm test", "npm run lint"],
    ...overrides,
  };
}

describe("project knowledge facts", () => {
  it("distills static discovery into bounded, non-prose facts", () => {
    const facts = factsFromDiscovery(discovery());
    assert.ok(facts.some((item) => item.text.includes("TypeScript")));
    assert.ok(facts.some((item) => item.text.includes("npm test")));
    assert.ok(facts.every((item) => item.source === "static-discovery"));
    assert.ok(facts.reduce((sum, item) => sum + Buffer.byteLength(item.text), 0) <= MAX_BYTES);
  });

  it("writes and reloads the versioned operational pack", () => {
    const cwd = makeTargetProject();
    dirs.push(cwd);
    const result = writeProjectFacts(cwd, discovery());
    assert.equal(result.file, projectKnowledgePath(cwd));
    assert.equal(loadProjectFacts(cwd).length, result.facts.length);
  });

  it("degrades malformed or unknown-version packs to no facts", () => {
    const cwd = makeTargetProject();
    dirs.push(cwd);
    const file = projectKnowledgePath(cwd);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, JSON.stringify({ schema_version: "999", facts: [{ text: "ignore" }] }));
    assert.deepEqual(loadProjectFacts(cwd), []);
  });

  it("refreshes when a project manifest changes", () => {
    const cwd = makeTargetProject();
    dirs.push(cwd);
    fs.writeFileSync(path.join(cwd, "package.json"), JSON.stringify({ scripts: { test: "node --test" } }));
    writeProjectFacts(cwd, discovery({ verification_commands: ["npm test"] }));
    fs.writeFileSync(path.join(cwd, "package.json"), JSON.stringify({ scripts: { test: "node --test", lint: "eslint ." } }));

    const refreshed = loadCurrentProjectFacts(cwd, { persist: true });
    assert.ok(refreshed.some((item) => item.text.includes("npm run lint")));
  });
});

describe("orchestrator knowledge-pack integration", () => {
  it("injects conventions automatically without making preview planning write operational state", () => {
    const cwd = makeTargetProject({
      config: "routing:\n  default_host: generic\npipeline:\n  default_track: full\n",
    });
    dirs.push(cwd);
    fs.writeFileSync(path.join(cwd, "package.json"), JSON.stringify({
      type: "commonjs",
      scripts: { test: "node --test", lint: "eslint ." },
    }));

    const plan = runStage("requirements", { cwd });
    assert.ok(!fs.existsSync(projectKnowledgePath(cwd)));
    assert.match(plan.workstreams[0].prompt, /## Project Knowledge Pack/);
    assert.match(plan.workstreams[0].prompt, /### Detected conventions/);
    assert.match(plan.workstreams[0].prompt, /Verify with.*npm test/);
  });
});
