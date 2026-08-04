// Phase 34.4 (completes 28.6) — gemini-cli retired from a first-party host
// to the @devteam/host-gemini-cli plugin package (packages/host-gemini-cli/),
// resolved through the existing A4 pluggable-adapter mechanism in
// core/router.js. This file covers the two states a project can be in:
//
//   1. Plugin NOT installed (the new default for any project that hasn't
//      opted in) — `devteam init --host gemini-cli` must fail with the
//      exact install instruction, not a generic "unknown host" message.
//   2. Plugin installed (`npm install @devteam/host-gemini-cli`, simulated
//      here by copying the real package into a tmpdir project's
//      node_modules) — resolution round-trips through listHosts(),
//      loadAdapter(), and a real `devteam init` exactly as it would for any
//      other external @devteam/host-* package (see tests/router.test.js for
//      the generic contract this relies on).
//
// The adapter's own contract (install/status/uninstall/renderStagePrompt
// shape) is covered in packages/host-gemini-cli/tests/adapter.test.js, run
// from its new location per the item's acceptance criteria.

const { describe, it } = require("node:test");
const assert = require("node:assert/strict");
const path = require("node:path");
const {
  REPO_ROOT, makeTargetProject, cleanup, runCLI, installGeminiCliPluginFixture,
} = require("./_helpers");
const { listHosts, loadAdapter } = require(path.join(REPO_ROOT, "core", "router"));

describe("gemini-cli plugin retirement: not installed", () => {
  it("`devteam init --host gemini-cli` fails with the exact install instruction", () => {
    const cwd = makeTargetProject();
    try {
      const r = runCLI(["init", "--host", "gemini-cli"], { cwd });
      assert.notEqual(r.status, 0, "init should not succeed without the plugin installed");
      assert.ok(
        r.stderr.includes("npm install @devteam/host-gemini-cli"),
        `stderr must give the exact install command, got:\n${r.stderr}`,
      );
      assert.ok(
        r.stderr.includes("no longer first-party"),
        `stderr should explain gemini-cli moved, got:\n${r.stderr}`,
      );
    } finally {
      cleanup(cwd);
    }
  });

  it("listHosts() does not include gemini-cli when the plugin isn't installed", () => {
    assert.ok(!listHosts().includes("gemini-cli"));
  });

  it("loadAdapter(\"gemini-cli\") throws a helpful error naming the plugin package", () => {
    assert.throws(
      () => loadAdapter("gemini-cli"),
      /No adapter found for host "gemini-cli"/,
    );
  });
});

describe("gemini-cli plugin retirement: installed (plugin-path resolution round-trip)", () => {
  it("`devteam init --host gemini-cli` succeeds once the plugin package is present", () => {
    const cwd = makeTargetProject();
    try {
      installGeminiCliPluginFixture(cwd);
      const r = runCLI(["init", "--host", "gemini-cli"], { cwd });
      assert.equal(r.status, 0, r.stderr);
      assert.ok(r.stdout.includes("Installing host adapter: gemini-cli"), r.stdout);
    } finally {
      cleanup(cwd);
    }
  });

  it("`devteam doctor` reports gemini-cli as available once the plugin is installed", () => {
    const cwd = makeTargetProject({
      config: "routing:\n  default_host: gemini-cli\npipeline:\n  default_track: full\n",
    });
    try {
      installGeminiCliPluginFixture(cwd);
      runCLI(["init", "--host", "gemini-cli"], { cwd });
      // core/router.js's moduleSearchRoots() checks process.cwd() at call
      // time — the subprocess's actual OS cwd, not just the --cwd flag
      // value doctor.js reads for target-project paths. Pass { cwd } here
      // (unlike the plain-string-config doctor tests in tests/doctor.test.js,
      // which never need external-adapter resolution) so the child process
      // actually runs from the tmpdir and finds the symlinked plugin.
      const r = runCLI(["doctor", "--cwd", cwd], { cwd });
      assert.ok(r.stdout.includes("gemini-cli is deprecated upstream"), r.stdout);
      assert.ok(!r.stdout.includes("moved to a plugin package"), r.stdout);
    } finally {
      cleanup(cwd);
    }
  });
});
