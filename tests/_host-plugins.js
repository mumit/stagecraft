// Wraps core/router.loadAdapter so tests that exercise "gemini-cli" as a
// real, working adapter (not just a routed host-name string) keep loading
// the actual adapter code after phase 34.4 moved it out of hosts/ into the
// @devteam/host-gemini-cli plugin package (packages/host-gemini-cli/). The
// adapter's behavior is unchanged — only its location moved — so tests that
// pin cross-host contract behavior (render-helpers de-dup, PATCH MODE,
// tool-budget advisory rendering) should keep exercising the real code via
// direct require, without needing the plugin installed under node_modules
// in this dev checkout (that's the retirement's whole point — see
// tests/gemini-cli-plugin.test.js for the "not installed" error path).
//
// Use this instead of requiring core/router directly ONLY in test files
// that reference "gemini-cli" by name in an in-process (non-subprocess)
// adapter call. Tests that dispatch through a subprocess (runCLI/runStage
// against a tmpdir project) go through the real router and need the fixture
// installed via installGeminiCliPluginFixture (tests/_helpers.js) instead.

"use strict";

const path = require("node:path");
const { REPO_ROOT } = require("./_helpers");
const router = require(path.join(REPO_ROOT, "core", "router"));

const PLUGIN_ADAPTER_PATHS = {
  "gemini-cli": path.join(REPO_ROOT, "packages", "host-gemini-cli", "adapter.js"),
};

function loadAdapter(host) {
  if (PLUGIN_ADAPTER_PATHS[host]) return require(PLUGIN_ADAPTER_PATHS[host]);
  return router.loadAdapter(host);
}

module.exports = { ...router, loadAdapter };
