// tests/prompt-layout.test.js
//
// Phase 32.1 (cache-first prompt assembly): stable-prefix prompt layout +
// provider cache breakpoints.
//
// Coverage:
//   1. splitReadFirst() / renderFrameworkPreamble() — core/adapters/render-helpers.js
//   2. Regression: two different stages, same run, same role config ->
//      layer 1 (framework preamble) and layer 2 (role brief) are
//      byte-identical, across every adapter that exposes
//      renderStagePromptLayers().
//   3. Layer 3 (learned context) and layer 4 (volatile tail) legitimately
//      differ across stages.
//   4. Meta-test: every dispatched stage's readFirst begins with
//      FRAMEWORK_READ_FIRST (guards drift between stages.js and the
//      hardcoded constant render-helpers.js splits on).
//   5. openai-compat cache_control emission fixture (invoke.js
//      buildCacheAwareContent), gated on hosts.openai-compat.caching.enabled.

"use strict";

const { test, describe } = require("node:test");
const assert = require("node:assert/strict");
const path = require("node:path");
const fs = require("node:fs");
const os = require("node:os");
const { REPO_ROOT } = require("./_helpers");

// 34.4: routed through ./_host-plugins so "gemini-cli" below keeps loading
// the real adapter code (now at packages/host-gemini-cli/), unchanged by
// its move out of hosts/.
const { loadAdapter } = require("./_host-plugins");
const { STAGES, ORDERED_STAGE_NAMES, FRAMEWORK_READ_FIRST } =
  require(path.join(REPO_ROOT, "core", "pipeline", "stages"));
const { splitReadFirst, renderFrameworkPreamble } =
  require(path.join(REPO_ROOT, "core", "adapters", "render-helpers"));

// ---------------------------------------------------------------------------
// 1. splitReadFirst / renderFrameworkPreamble unit coverage
// ---------------------------------------------------------------------------

test("splitReadFirst: splits the constant framework prefix from the stage-specific remainder", () => {
  const readFirst = [...FRAMEWORK_READ_FIRST, "pipeline/context.md", "pipeline/brief.md"];
  const { framework, rest } = splitReadFirst(readFirst);
  assert.deepEqual(framework, FRAMEWORK_READ_FIRST);
  assert.deepEqual(rest, ["pipeline/context.md", "pipeline/brief.md"]);
});

test("splitReadFirst: degrades gracefully when readFirst doesn't start with the framework prefix", () => {
  const { framework, rest } = splitReadFirst(["pipeline/context.md"]);
  assert.deepEqual(framework, []);
  assert.deepEqual(rest, ["pipeline/context.md"]);
});

test("splitReadFirst: handles a partial-match prefix (fixture-style readFirst)", () => {
  const { framework, rest } = splitReadFirst(["AGENTS.md", "pipeline/context.md"]);
  assert.deepEqual(framework, ["AGENTS.md"]);
  assert.deepEqual(rest, ["pipeline/context.md"]);
});

test("splitReadFirst: empty/missing readFirst returns empty splits, no throw", () => {
  assert.deepEqual(splitReadFirst(undefined), { framework: [], rest: [] });
  assert.deepEqual(splitReadFirst([]), { framework: [], rest: [] });
});

test("renderFrameworkPreamble: emits nothing when the descriptor has no framework prefix", () => {
  const lines = [];
  renderFrameworkPreamble(lines, { readFirst: ["pipeline/context.md"] });
  assert.deepEqual(lines, []);
});

test("renderFrameworkPreamble: emits the framework heading + file list", () => {
  const lines = [];
  renderFrameworkPreamble(lines, { readFirst: FRAMEWORK_READ_FIRST });
  const text = lines.join("\n");
  assert.match(text, /^## Framework \(read first — every stage, every role\)/);
  for (const f of FRAMEWORK_READ_FIRST) {
    assert.ok(text.includes(`- ${f}`), `expected "${f}" in framework preamble`);
  }
});

// ---------------------------------------------------------------------------
// 4. Meta-test: every dispatched stage's readFirst starts with FRAMEWORK_READ_FIRST
// ---------------------------------------------------------------------------

test("every dispatched stage's readFirst begins with FRAMEWORK_READ_FIRST", () => {
  for (const name of ORDERED_STAGE_NAMES) {
    const def = STAGES[name];
    if (!def) continue;
    if (!Array.isArray(def.roles) || def.roles.length === 0) continue; // mechanical stage, no dispatch
    if (!Array.isArray(def.readFirst) || def.readFirst.length === 0) continue;
    const prefix = def.readFirst.slice(0, FRAMEWORK_READ_FIRST.length);
    assert.deepEqual(prefix, FRAMEWORK_READ_FIRST,
      `stage "${name}" readFirst must start with FRAMEWORK_READ_FIRST — got ${JSON.stringify(def.readFirst)}`);
  }
});

// ---------------------------------------------------------------------------
// 2 & 3. Regression: layer 1-2 byte-identical prefix across two different
// stages in the same run with the same role; layers 3-4 legitimately differ.
// ---------------------------------------------------------------------------

const LAYERED_HOSTS = ["claude-code", "codex", "gemini-cli", "openai-compat", "antigravity", "generic"];

function descriptorFor(stageName, role, extra = {}) {
  const def = STAGES[stageName];
  return {
    stage: def.stage,
    name: stageName,
    role,
    workstreamId: `${def.stage}.${role}`,
    objective: def.objective,
    readFirst: def.readFirst,
    allowedWrites: def.allowedWrites,
    artifact: def.artifact,
    template: def.template,
    expectedGate: def.gate,
    subagent: def.subagent,
    knownPatterns: [],
    priorKnowledge: [],
    ...extra,
  };
}

for (const host of LAYERED_HOSTS) {
  test(`${host}: layers 1-2 are byte-identical across two different stages, same run, same role`, () => {
    const adapter = loadAdapter(host);
    assert.equal(typeof adapter.renderStagePromptLayers, "function",
      `${host} must expose renderStagePromptLayers for the cache-first layout contract`);

    const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "devteam-test-prompt-layout-"));
    try {
      const ctx = { track: "full", feature: "add HTTP endpoint", orchestrator: "devteam@test", cwd };

      // "build" and "pre-review" both dispatch the "backend" role and both
      // list the full FRAMEWORK_READ_FIRST prefix — a same-run, same-role,
      // different-stage pair.
      const descA = descriptorFor("build", "backend");
      const descB = descriptorFor("pre-review", "backend");

      const rendA = adapter.renderStagePromptLayers(descA, ctx);
      const rendB = adapter.renderStagePromptLayers(descB, ctx);

      assert.equal(rendA.layers[0], rendB.layers[0],
        `${host}: layer 1 (framework preamble) must be byte-identical across stages`);
      assert.equal(rendA.layers[1], rendB.layers[1],
        `${host}: layer 2 (role brief) must be byte-identical across stages`);
      assert.ok(rendA.layers[0].length > 0, `${host}: layer 1 must be non-empty for a real stage descriptor`);

      // Layer 4 (volatile tail) legitimately differs — different stage name,
      // workstreamId, objective, and readFirst remainder.
      assert.notEqual(rendA.layers[3], rendB.layers[3],
        `${host}: layer 4 (volatile tail) should differ between different stages`);

      // The full joined prompt still starts with layer 1 (when non-empty).
      const full = adapter.renderStagePrompt(descA, ctx);
      assert.ok(full.startsWith(rendA.layers[0]),
        `${host}: renderStagePrompt() output must begin with layer 1`);
    } finally {
      fs.rmSync(cwd, { recursive: true, force: true });
    }
  });

  test(`${host}: layer 3 (learned context) reflects descriptor.knownPatterns/priorKnowledge`, () => {
    const adapter = loadAdapter(host);
    const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "devteam-test-prompt-layout-"));
    try {
      const ctx = { track: "full", feature: "x", orchestrator: "devteam@test", cwd };
      const withoutContext = descriptorFor("build", "backend");
      const withContext = descriptorFor("build", "backend", {
        knownPatterns: [{ prompt_text: "Document user-visible HTTP endpoints.", tier: "advisory" }],
      });

      const rendNone = adapter.renderStagePromptLayers(withoutContext, ctx);
      const rendSome = adapter.renderStagePromptLayers(withContext, ctx);

      assert.equal(rendNone.layers[2], "", `${host}: layer 3 must be empty with no learned context`);
      assert.match(rendSome.layers[2], /Project Knowledge Pack/);
      assert.match(rendSome.layers[2], /Document user-visible HTTP endpoints/);
    } finally {
      fs.rmSync(cwd, { recursive: true, force: true });
    }
  });
}

// ---------------------------------------------------------------------------
// 6. Phase 37.2: prompts.inline_framework — inlined content is the
//    byte-identical cacheable prefix; false reverts to the pre-37.2
//    path-pointer rendering, byte-identical to before this item.
// ---------------------------------------------------------------------------

for (const host of LAYERED_HOSTS) {
  test(`${host}: prompts.inline_framework (default true) makes the byte-identical prefix cover the full inlined framework+role-brief block`, () => {
    const adapter = loadAdapter(host);
    const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "devteam-test-inline-framework-"));
    try {
      // Deliberately large, distinctive framework content — proves layers
      // 1-2 carry actual bytes now, not just a path pointer.
      fs.writeFileSync(path.join(cwd, "AGENTS.md"), "# Project\n" + "Context line.\n".repeat(50));
      fs.mkdirSync(path.join(cwd, ".devteam", "rules"), { recursive: true });
      fs.writeFileSync(path.join(cwd, ".devteam", "rules", "pipeline.md"), "# Pipeline rules\n" + "Rule line.\n".repeat(50));
      fs.writeFileSync(path.join(cwd, ".devteam", "rules", "gates-core.md"), "# Gates rules\n" + "Gate line.\n".repeat(50));
      if (typeof adapter.install === "function") adapter.install(cwd, {});

      const ctx = { track: "full", feature: "add HTTP endpoint", orchestrator: "devteam@test", cwd };
      // "build" and "pre-review" both dispatch "backend" — same-run,
      // same-role, different-stage pair, same as the byte-identical test above.
      const descA = descriptorFor("build", "backend");
      const descB = descriptorFor("pre-review", "backend");

      const rendA = adapter.renderStagePromptLayers(descA, ctx);
      const rendB = adapter.renderStagePromptLayers(descB, ctx);
      assert.equal(rendA.layers[0], rendB.layers[0], `${host}: inlined layer 1 must stay byte-identical`);
      assert.equal(rendA.layers[1], rendB.layers[1], `${host}: inlined layer 2 must stay byte-identical`);

      const promptA = adapter.renderStagePrompt(descA, ctx);
      const promptB = adapter.renderStagePrompt(descB, ctx);
      let shared = 0;
      const min = Math.min(promptA.length, promptB.length);
      while (shared < min && promptA[shared] === promptB[shared]) shared++;

      // The acceptance bar is a length assertion, not a substring match: the
      // measured shared prefix must cover at least the full inlined layer1+2
      // block renderStagePromptLayers itself reports as the boundary (it can
      // run a little longer — "build" is stage-04, "pre-review" is stage-04a,
      // so "# Stage stage-04" coincidentally matches a few bytes into layer 4).
      const expectedPrefixLen = rendA.layers[0].length + rendA.layers[1].length;
      assert.ok(shared >= expectedPrefixLen,
        `${host}: shared-prefix length must cover the full inlined layer1+layer2 block (${expectedPrefixLen} B), got ${shared} B`);
      // Pre-37.2 measured pointer-only prefix was ~213 B (plans/phase-37 §37.2
      // verify-first); the inlined fixture above is far larger than that.
      assert.ok(shared > 1000,
        `${host}: inlined prefix (${shared} B) must be far larger than the pre-37.2 pointer-only prefix (~213 B)`);
    } finally {
      fs.rmSync(cwd, { recursive: true, force: true });
    }
  });

  test(`${host}: prompts.inline_framework:false keeps the pre-37.2 path-pointer rendering byte-identical`, () => {
    const adapter = loadAdapter(host);
    const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "devteam-test-inline-framework-off-"));
    try {
      fs.mkdirSync(path.join(cwd, ".devteam"), { recursive: true });
      fs.writeFileSync(path.join(cwd, ".devteam", "config.yml"), "prompts:\n  inline_framework: false\n");
      const ctx = { track: "full", feature: "x", orchestrator: "devteam@test", cwd };

      const rend = adapter.renderStagePromptLayers(descriptorFor("build", "backend"), ctx);

      assert.equal(
        rend.layers[0],
        ["## Framework (read first — every stage, every role)", "- AGENTS.md", "- .devteam/rules/pipeline.md", "- .devteam/rules/gates-core.md", ""].join("\n"),
        `${host}: layer 1 must stay the pre-37.2 path-pointer text when inline_framework is false`,
      );

      if (host !== "generic") {
        // generic has always inlined the role brief unconditionally — it has
        // no native subagent/read_file mechanism to point at instead (see
        // hosts/generic/adapter.js). inline_framework only ever gated its
        // layer 1; layer 2 there is exempt from this pointer-mode check.
        assert.equal(rend.layers[1].split("\n").length, 2,
          `${host}: layer 2 must stay a single pointer line + blank line when inline_framework is false, got:\n${rend.layers[1]}`);
      }
    } finally {
      fs.rmSync(cwd, { recursive: true, force: true });
    }
  });
}

// ---------------------------------------------------------------------------
// 5. openai-compat cache_control emission fixture
// ---------------------------------------------------------------------------

describe("openai-compat: cache_control breakpoints (32.1)", () => {
  const { buildCacheAwareContent } = require(path.join(REPO_ROOT, "hosts", "openai-compat", "invoke"));

  test("buildCacheAwareContent: emits cache_control on non-empty layers 1-3, none on layer 4", () => {
    const layers = ["framework text", "role brief text", "learned context text", "volatile tail text"];
    const blocks = buildCacheAwareContent(layers);
    assert.equal(blocks.length, 4);
    assert.deepEqual(blocks[0], { type: "text", text: "framework text", cache_control: { type: "ephemeral" } });
    assert.deepEqual(blocks[1], { type: "text", text: "role brief text", cache_control: { type: "ephemeral" } });
    assert.deepEqual(blocks[2], { type: "text", text: "learned context text", cache_control: { type: "ephemeral" } });
    assert.deepEqual(blocks[3], { type: "text", text: "volatile tail text" });
    assert.ok(!("cache_control" in blocks[3]), "layer 4 (volatile tail) must never carry a cache breakpoint");
  });

  test("buildCacheAwareContent: drops empty layers (e.g. no learned context yet) but preserves cacheability by original layer index", () => {
    const layers = ["framework text", "role brief text", "", "volatile tail text"];
    const blocks = buildCacheAwareContent(layers);
    assert.equal(blocks.length, 3, "empty layer 3 must be dropped, not emitted as an empty block");
    assert.ok(blocks.every((b) => b.text.length > 0));
    assert.ok(blocks[0].cache_control && blocks[1].cache_control, "layers 1-2 remain cacheable");
    assert.ok(!blocks[2].cache_control, "layer 4 remains non-cacheable even after layer 3 is dropped");
  });

  test("invoke(): preserves cache_control blocks on the orchestrator's pre-rendered prompt path", async () => {
    const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "devteam-test-cache-control-"));
    const origFetch = global.fetch;
    try {
      fs.mkdirSync(path.join(cwd, ".devteam"), { recursive: true });
      fs.mkdirSync(path.join(cwd, "pipeline", "gates"), { recursive: true });
      fs.writeFileSync(path.join(cwd, ".devteam", "config.yml"), `
routing:
  default_host: openai-compat
pipeline:
  default_track: full
hosts:
  openai-compat:
    base_url: https://example.invalid/v1
    api_key_env: PROMPT_LAYOUT_TEST_KEY
    models:
      default: test/model
    caching:
      enabled: true
`);
      process.env.PROMPT_LAYOUT_TEST_KEY = "sk-stub";

      let capturedBody = null;
      global.fetch = async (_url, opts) => {
        capturedBody = JSON.parse(opts.body);
        return {
          ok: true,
          json: async () => ({
            choices: [{ finish_reason: "stop", message: { role: "assistant", content: "Done." } }],
          }),
          text: async () => "{}",
        };
      };

      const { invoke } = require(path.join(REPO_ROOT, "hosts", "openai-compat", "invoke"));
      const adapter = require(path.join(REPO_ROOT, "hosts", "openai-compat", "adapter"));
      const descriptor = descriptorFor("build", "backend", { workstreamId: "stage-04.backend" });
      const ctx = { track: "full", feature: "x", cwd, isolation: "in-place", changeId: null };

      // runStageHeadless always supplies this third argument. Before this
      // regression fix, doing so flattened the layers and disabled every
      // explicit cache_control marker despite caching.enabled being true.
      const preRenderedPrompt = adapter.renderStagePrompt(descriptor, ctx);
      await invoke(descriptor, ctx, preRenderedPrompt);

      assert.ok(capturedBody, "fetch must have been called");
      assert.ok(Array.isArray(capturedBody.messages[0].content),
        "content must be an array of blocks when caching is enabled");
      const blocks = capturedBody.messages[0].content;
      assert.ok(blocks.length >= 1);
      assert.ok(blocks.some((b) => b.cache_control), "at least one block must carry a cache_control breakpoint");
      assert.ok(!blocks[blocks.length - 1].cache_control,
        "the last block (volatile tail) must never carry a cache_control breakpoint");
    } finally {
      global.fetch = origFetch;
      delete process.env.PROMPT_LAYOUT_TEST_KEY;
      fs.rmSync(cwd, { recursive: true, force: true });
    }
  });

  test("contentForInvocation: keeps a transformed pre-rendered prompt as a plain string", () => {
    const { contentForInvocation } = require(path.join(REPO_ROOT, "hosts", "openai-compat", "invoke"));
    const adapter = require(path.join(REPO_ROOT, "hosts", "openai-compat", "adapter"));
    const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "devteam-test-cache-transform-"));
    try {
      const descriptor = descriptorFor("build", "backend", { workstreamId: "stage-04.backend" });
      const ctx = { track: "full", feature: "x", cwd, isolation: "in-place", changeId: null };
      const transformed = `provider-directive\n${adapter.renderStagePrompt(descriptor, ctx)}`;
      assert.equal(contentForInvocation(adapter, descriptor, ctx, transformed, true), transformed,
        "cache recovery must never discard an orchestrator prompt transformation");
    } finally {
      fs.rmSync(cwd, { recursive: true, force: true });
    }
  });

  test("invoke(): a stubbed cache-aware endpoint reports cached_tokens > 0 on the second dispatch of the same role (37.2)", async () => {
    const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "devteam-test-cached-tokens-"));
    const origFetch = global.fetch;
    try {
      fs.mkdirSync(path.join(cwd, ".devteam"), { recursive: true });
      fs.mkdirSync(path.join(cwd, "pipeline", "gates"), { recursive: true });
      fs.writeFileSync(path.join(cwd, ".devteam", "config.yml"), `
routing:
  default_host: openai-compat
pipeline:
  default_track: full
hosts:
  openai-compat:
    base_url: https://example.invalid/v1
    api_key_env: PROMPT_LAYOUT_TEST_CACHED_TOKENS_KEY
    models:
      default: test/model
    caching:
      enabled: true
`);
      process.env.PROMPT_LAYOUT_TEST_CACHED_TOKENS_KEY = "sk-stub";

      // Simulates an Anthropic-style prompt-caching endpoint: the first
      // dispatch reports nothing cached (cold cache); the second dispatch of
      // the same role — byte-identical layers 1-2 prefix, per 37.2 — reports
      // the whole prefix back as cached_tokens.
      let callCount = 0;
      global.fetch = async () => {
        callCount++;
        const cachedTokens = callCount === 1 ? 0 : 4000;
        return {
          ok: true,
          json: async () => ({
            choices: [{ finish_reason: "stop", message: { role: "assistant", content: "Done." } }],
            usage: { prompt_tokens: 5000, completion_tokens: 20, prompt_tokens_details: { cached_tokens: cachedTokens } },
          }),
          text: async () => "{}",
        };
      };

      const { invoke } = require(path.join(REPO_ROOT, "hosts", "openai-compat", "invoke"));
      // "build" and "pre-review" both dispatch "backend" — same role,
      // different stage, same as the byte-identical prefix tests above.
      const descA = descriptorFor("build", "backend", { workstreamId: "stage-04.backend" });
      const descB = descriptorFor("pre-review", "backend", { workstreamId: "stage-04a.backend" });
      const ctx = { track: "full", feature: "x", cwd, isolation: "in-place", changeId: null };

      const first = await invoke(descA, ctx, null);
      const second = await invoke(descB, ctx, null);

      assert.equal(first.usage.cachedTokens, undefined, "first (cold) dispatch reports no cached tokens");
      assert.ok(second.usage.cachedTokens > 0, "second dispatch of the same role must report cached_tokens > 0");
    } finally {
      global.fetch = origFetch;
      delete process.env.PROMPT_LAYOUT_TEST_CACHED_TOKENS_KEY;
      fs.rmSync(cwd, { recursive: true, force: true });
    }
  });

  test("invoke(): plain string content (unchanged) when caching is disabled (default)", async () => {
    const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "devteam-test-cache-control-off-"));
    const origFetch = global.fetch;
    try {
      fs.mkdirSync(path.join(cwd, ".devteam"), { recursive: true });
      fs.mkdirSync(path.join(cwd, "pipeline", "gates"), { recursive: true });
      fs.writeFileSync(path.join(cwd, ".devteam", "config.yml"), `
routing:
  default_host: openai-compat
pipeline:
  default_track: full
hosts:
  openai-compat:
    base_url: https://example.invalid/v1
    api_key_env: PROMPT_LAYOUT_TEST_KEY_OFF
    models:
      default: test/model
`);
      process.env.PROMPT_LAYOUT_TEST_KEY_OFF = "sk-stub";

      let capturedBody = null;
      global.fetch = async (_url, opts) => {
        capturedBody = JSON.parse(opts.body);
        return {
          ok: true,
          json: async () => ({
            choices: [{ finish_reason: "stop", message: { role: "assistant", content: "Done." } }],
          }),
          text: async () => "{}",
        };
      };

      const { invoke } = require(path.join(REPO_ROOT, "hosts", "openai-compat", "invoke"));
      const descriptor = descriptorFor("build", "backend", { workstreamId: "stage-04.backend" });
      const ctx = { track: "full", feature: "x", cwd, isolation: "in-place", changeId: null };

      await invoke(descriptor, ctx, null);

      assert.ok(capturedBody, "fetch must have been called");
      assert.equal(typeof capturedBody.messages[0].content, "string",
        "content must remain a plain string when caching.enabled is not set");
    } finally {
      global.fetch = origFetch;
      delete process.env.PROMPT_LAYOUT_TEST_KEY_OFF;
      fs.rmSync(cwd, { recursive: true, force: true });
    }
  });
});
