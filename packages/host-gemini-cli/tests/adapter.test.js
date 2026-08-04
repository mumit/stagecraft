// Contract tests for the gemini-cli host adapter, run from its new home
// (phase 34.4 — moved out of hosts/ into this plugin package; see
// packages/host-gemini-cli/README.md for why). Behavior is unchanged from
// when it lived under hosts/gemini-cli/ — these tests pin the same
// contract the main repo's tests/adapter-contract.test.js and friends
// pinned before the move (some of those files still exercise this adapter
// too, via tests/_host-plugins.js, for cross-host comparisons; this file is
// the adapter's own dedicated coverage).
//
// Run standalone with `npm test` in this directory, or as part of the main
// repo's `npm test` (root package.json's test script globs
// packages/*/tests/*.test.js alongside tests/*.test.js).

"use strict";

const { describe, it, afterEach } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const adapter = require("../adapter.js");
const capabilities = require("../capabilities.json");

let _dirs = [];
function tmpdir() {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), "host-gemini-cli-test-"));
  _dirs.push(d);
  return d;
}
afterEach(() => {
  for (const d of _dirs) try { fs.rmSync(d, { recursive: true, force: true }); } catch { /* ignore */ }
  _dirs = [];
});

describe("capabilities.json", () => {
  it("declares name: gemini-cli", () => {
    assert.equal(capabilities.name, "gemini-cli");
  });

  it("declares goalLoop: false (no /goal directive support in gemini CLI)", () => {
    // The /goal directive is a Claude Code session-level feature; Gemini
    // CLI has no equivalent convergence directive (phase-1-trust-
    // consolidation.md §1.5) — explicitly false so absence is never
    // ambiguous.
    assert.strictEqual(capabilities.goalLoop, false);
  });

  it("declares enforces.allowed_writes: post-hoc-audit", () => {
    assert.equal(capabilities.enforces.allowed_writes, "post-hoc-audit");
  });

  it("declares enforces.stoplist: prompt-only", () => {
    assert.equal(capabilities.enforces.stoplist, "prompt-only");
  });

  it("declares enforces.shell and enforces.network: true", () => {
    assert.equal(capabilities.enforces.shell, true);
    assert.equal(capabilities.enforces.network, true);
  });

  it("declares telemetry: estimated (no native usage capture)", () => {
    assert.equal(capabilities.telemetry, "estimated");
  });

  it("declares headless: true with a headlessCommand", () => {
    assert.equal(capabilities.headless, true);
    assert.equal(typeof capabilities.headlessCommand, "string");
    assert.ok(capabilities.headlessCommand.length > 0);
  });
});

describe("adapter contract shape", () => {
  it("exports the required methods", () => {
    for (const m of ["install", "renderStagePrompt", "status", "uninstall"]) {
      assert.equal(typeof adapter[m], "function", `missing ${m}()`);
    }
  });

  it("exports invoke() (capabilities.headless === true requires it)", () => {
    assert.equal(typeof adapter.invoke, "function");
  });

  it("capabilities object matches capabilities.json", () => {
    assert.equal(adapter.capabilities.name, "gemini-cli");
  });
});

describe("install / status / uninstall round-trip", () => {
  it("install writes files, status reports ok:true, uninstall removes them", () => {
    const d = tmpdir();
    const r = adapter.install(d, { isolation: "in-place" });
    assert.ok(r.written.length > 0, "install should write at least one file");

    const status = adapter.status(d);
    assert.equal(status.ok, true, `status not ok after install: ${JSON.stringify(status.missing)}`);

    adapter.uninstall(d);
    const afterUninstall = adapter.status(d);
    assert.equal(afterUninstall.ok, false, "status should report missing files after uninstall");
  });

  it("re-install is idempotent (no throw, status stays ok)", () => {
    const d = tmpdir();
    adapter.install(d, { isolation: "in-place" });
    assert.doesNotThrow(() => adapter.install(d, { isolation: "in-place" }));
    assert.equal(adapter.status(d).ok, true);
  });
});

describe("renderStagePrompt", () => {
  function fixtureDescriptor() {
    return {
      stage: "stage-01",
      name: "requirements",
      role: "pm",
      rolesInStage: ["pm"],
      workstreamId: "stage-01",
      objective: "Write the brief.",
      readFirst: ["AGENTS.md"],
      artifact: "pipeline/brief.md",
      template: "brief-template.md",
      allowedWrites: ["pipeline/brief.md"],
    };
  }

  function fixtureContext(cwd) {
    return {
      track: "full",
      feature: "adapter contract test feature",
      cwd,
      isolation: "in-place",
      orchestrator: "devteam@contract-test",
    };
  }

  it("renders a non-empty prompt containing the workstreamId and role prompt path", () => {
    const d = tmpdir();
    const prompt = adapter.renderStagePrompt(fixtureDescriptor(), fixtureContext(d));
    assert.equal(typeof prompt, "string");
    assert.ok(prompt.length > 0);
    assert.ok(prompt.includes("stage-01"));
    assert.ok(prompt.includes(`${capabilities.rolePromptsDir}/pm.md`));
  });

  it("stamps its own host name in the gate footer", () => {
    const d = tmpdir();
    const prompt = adapter.renderStagePrompt(fixtureDescriptor(), fixtureContext(d));
    assert.match(prompt, /"host": "gemini-cli"/);
  });
});
