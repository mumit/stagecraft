const { describe, it, afterEach } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { REPO_ROOT, makeTargetProject, cleanup } = require("./_helpers");
const { loadConfig, clearConfigCache, resolveHost, resolveRoute, escalateModel, renderDefaultConfig, writeConfigIfAbsent, DEFAULTS, KNOWN_DEPLOY_ADAPTERS } =
  require(path.join(REPO_ROOT, "core", "config"));

let _tmpDirs = [];
function track(cwd) { _tmpDirs.push(cwd); return cwd; }
afterEach(() => { _tmpDirs.forEach(cleanup); _tmpDirs = []; });

describe("config: loadConfig", () => {
  it("returns DEFAULTS when no file exists", () => {
    const cwd = track(makeTargetProject({ config: false }));
    const c = loadConfig(cwd);
    assert.equal(c._source, "defaults");
    assert.equal(c.routing.default_host, DEFAULTS.routing.default_host);
  });

  it("parses a valid config", () => {
    const cwd = track(makeTargetProject({
      config: "routing:\n  default_host: claude-code\n  roles:\n    backend: codex\npipeline:\n  default_track: hotfix\n",
    }));
    const c = loadConfig(cwd);
    assert.equal(c._source, "file");
    assert.equal(c.routing.default_host, "claude-code");
    assert.equal(c.routing.roles.backend, "codex");
    assert.equal(c.pipeline.default_track, "hotfix");
    assert.equal(c.pipeline.require_signed_gates, false);
    assert.deepEqual(c.pipeline.force_stages, []);
    assert.deepEqual(c.routing.host_concurrency, {});
  });

  it("parses per-host concurrency limits", () => {
    const cwd = track(makeTargetProject({
      config: "routing:\n  default_host: claude-code\n  host_concurrency:\n    default: 2\n    codex: 1\n",
    }));
    const c = loadConfig(cwd);
    assert.equal(c.routing.host_concurrency.default, 2);
    assert.equal(c.routing.host_concurrency.codex, 1);
  });

  it("parses force_stages as an operator override list", () => {
    const cwd = track(makeTargetProject({
      config: "pipeline:\n  skip_stages:\n    - security-review\n  force_stages:\n    - security-review\n",
    }));
    const c = loadConfig(cwd);
    assert.deepEqual(c.pipeline.skip_stages, ["security-review"]);
    assert.deepEqual(c.pipeline.force_stages, ["security-review"]);
  });

  it("fills in defaults for missing fields", () => {
    const cwd = track(makeTargetProject({
      config: "routing:\n  default_host: codex\n",
    }));
    const c = loadConfig(cwd);
    assert.equal(c.pipeline.default_track, "full"); // default
    assert.deepEqual(c.routing.roles, {}); // default
  });

  it("enables signed-only gate policy only for explicit true", () => {
    const cwd = track(makeTargetProject({
      config: "pipeline:\n  require_signed_gates: true\n",
    }));
    assert.equal(loadConfig(cwd).pipeline.require_signed_gates, true);
  });

  // 29.1: pipeline.loop_build_role — the single workstream the `loop` track's
  // build + peer-review stages dispatch. See loopBuildRole() in
  // core/pipeline/stages.js for the validation/fallback that consumes this.
  it("defaults loop_build_role to backend when absent", () => {
    const cwd = track(makeTargetProject({ config: "routing:\n  default_host: generic\n" }));
    assert.equal(loadConfig(cwd).pipeline.loop_build_role, "backend");
    assert.equal(DEFAULTS.pipeline.loop_build_role, "backend");
  });

  it("parses an explicit loop_build_role override", () => {
    const cwd = track(makeTargetProject({
      config: "pipeline:\n  loop_build_role: frontend\n",
    }));
    assert.equal(loadConfig(cwd).pipeline.loop_build_role, "frontend");
  });

  // 32.5: pipeline.context_budget_bytes — byte budget for pipeline/context.md,
  // enforced by core/context-budget.js. See DEFAULTS.pipeline's comment.
  it("defaults context_budget_bytes to 8192 when absent", () => {
    const cwd = track(makeTargetProject({ config: "routing:\n  default_host: generic\n" }));
    assert.equal(loadConfig(cwd).pipeline.context_budget_bytes, 8192);
    assert.equal(DEFAULTS.pipeline.context_budget_bytes, 8192);
  });

  it("parses an explicit context_budget_bytes override", () => {
    const cwd = track(makeTargetProject({
      config: "pipeline:\n  context_budget_bytes: 4096\n",
    }));
    assert.equal(loadConfig(cwd).pipeline.context_budget_bytes, 4096);
  });

  it("falls back to the default for a non-positive or non-integer context_budget_bytes", () => {
    const cwd = track(makeTargetProject({
      config: "pipeline:\n  context_budget_bytes: -1\n",
    }));
    assert.equal(loadConfig(cwd).pipeline.context_budget_bytes, 8192);
  });

  // Phase 30 item 30.4 — memory.inject / inject_top_k / inject_similarity_floor.
  it("defaults memory.inject to true and inject_top_k to 3 when absent", () => {
    const cwd = track(makeTargetProject({ config: "routing:\n  default_host: generic\n" }));
    const c = loadConfig(cwd);
    assert.equal(c.memory.inject, true);
    assert.equal(c.memory.inject_top_k, 3);
    assert.equal(c.memory.inject_similarity_floor, 0);
    assert.equal(DEFAULTS.memory.inject, true);
    assert.equal(DEFAULTS.memory.inject_top_k, 3);
  });

  it("parses memory.inject: false and custom top_k/floor", () => {
    const cwd = track(makeTargetProject({
      config: "memory:\n  inject: false\n  inject_top_k: 5\n  inject_similarity_floor: 0.4\n",
    }));
    const c = loadConfig(cwd);
    assert.equal(c.memory.inject, false);
    assert.equal(c.memory.inject_top_k, 5);
    assert.equal(c.memory.inject_similarity_floor, 0.4);
  });

  it("falls back to default inject_top_k for a non-positive-integer override", () => {
    const cwd = track(makeTargetProject({
      config: "memory:\n  inject_top_k: 0\n",
    }));
    assert.equal(loadConfig(cwd).memory.inject_top_k, DEFAULTS.memory.inject_top_k);
  });

  // Phase-32 item 32.3: routing.tiers + routing.escalate_on_retry.
  it("defaults routing.tiers to {} and escalate_on_retry to false", () => {
    const cwd = track(makeTargetProject({ config: "routing:\n  default_host: generic\n" }));
    const c = loadConfig(cwd);
    assert.deepEqual(c.routing.tiers, {});
    assert.equal(c.routing.escalate_on_retry, false);
    assert.deepEqual(DEFAULTS.routing.tiers, {});
    assert.equal(DEFAULTS.routing.escalate_on_retry, false);
  });

  it("parses routing.tiers ladders and escalate_on_retry: true", () => {
    const cwd = track(makeTargetProject({
      config: "routing:\n  default_host: claude-code\n  escalate_on_retry: true\n  tiers:\n    claude-code:\n      - haiku\n      - sonnet\n      - opus\n    codex:\n      - gpt-5-mini\n      - gpt-5\n",
    }));
    const c = loadConfig(cwd);
    assert.equal(c.routing.escalate_on_retry, true);
    assert.deepEqual(c.routing.tiers["claude-code"], ["haiku", "sonnet", "opus"]);
    assert.deepEqual(c.routing.tiers.codex, ["gpt-5-mini", "gpt-5"]);
  });

  it("ignores a malformed routing.tiers (falls back to {})", () => {
    const cwd = track(makeTargetProject({ config: "routing:\n  tiers: not-an-object\n" }));
    assert.deepEqual(loadConfig(cwd).routing.tiers, {});
  });
});

// Phase-32 item 32.3: routing.roles/routing.stages accept either the
// pre-32.3 bare host-name string, OR {host, model}. resolveRoute is the new
// entry point that surfaces both; resolveHost (tested above) must stay a
// byte-identical wrapper around resolveRoute(...).hostName.
describe("config: resolveRoute (32.3 object-form routing)", () => {
  it("string-form roles/stages resolve with model undefined (back-compat)", () => {
    const cfg = {
      routing: {
        default_host: "generic",
        roles: { backend: "codex" },
        stages: { "stage-08": "claude-code" },
      },
    };
    assert.deepEqual(resolveRoute(cfg, "stage-04", "backend"), { hostName: "codex", model: undefined });
    assert.deepEqual(resolveRoute(cfg, "stage-08", "platform"), { hostName: "claude-code", model: undefined });
    assert.deepEqual(resolveRoute(cfg, "stage-01", "pm"), { hostName: "generic", model: undefined });
  });

  it("object-form roles/stages resolve both host and model", () => {
    const cfg = {
      routing: {
        default_host: "generic",
        roles: { qa: { host: "claude-code", model: "claude-haiku-4-5-20251001" } },
        stages: { "stage-08": { host: "codex", model: "gpt-5-mini" } },
      },
    };
    assert.deepEqual(resolveRoute(cfg, "stage-06", "qa"), { hostName: "claude-code", model: "claude-haiku-4-5-20251001" });
    assert.deepEqual(resolveRoute(cfg, "stage-08", "backend"), { hostName: "codex", model: "gpt-5-mini" });
  });

  it("object-form stages still beats object-form roles", () => {
    const cfg = {
      routing: {
        default_host: "generic",
        roles: { backend: { host: "codex", model: "gpt-5-mini" } },
        stages: { "stage-08": { host: "claude-code", model: "opus" } },
      },
    };
    assert.deepEqual(resolveRoute(cfg, "stage-08", "backend"), { hostName: "claude-code", model: "opus" });
  });

  it("an object-form value missing `host` falls through to the next precedence level rather than throwing", () => {
    const cfg = {
      routing: {
        default_host: "generic",
        roles: { backend: { model: "gpt-5-mini" } }, // no host — malformed
        stages: {},
      },
    };
    assert.deepEqual(resolveRoute(cfg, "stage-04", "backend"), { hostName: "generic", model: undefined });
  });

  it("resolveHost stays a byte-identical wrapper for object-form routes", () => {
    const cfg = {
      routing: {
        default_host: "generic",
        roles: { backend: { host: "codex", model: "gpt-5-mini" } },
        stages: {},
      },
    };
    assert.equal(resolveHost(cfg, "stage-04", "backend"), "codex");
  });

  it("critic diversity (31.3) still works when the reviewer's route is object-form", () => {
    const cfg = {
      routing: {
        default_host: "generic",
        roles: { reviewer: { host: "codex", model: "gpt-5" } },
        stages: {},
      },
    };
    assert.deepEqual(resolveRoute(cfg, "stage-05", "critic"), { hostName: "generic", model: undefined });
  });
});

describe("config: escalateModel (32.3)", () => {
  const cfg = {
    routing: {
      default_host: "generic",
      tiers: {
        "claude-code": ["claude-haiku-4-5-20251001", "sonnet", "opus"],
        codex: ["gpt-5-mini", "gpt-5"],
      },
    },
  };

  it("bumps one tier up the host's ladder", () => {
    assert.equal(escalateModel(cfg, "claude-code", "claude-haiku-4-5-20251001"), "sonnet");
    assert.equal(escalateModel(cfg, "codex", "gpt-5-mini"), "gpt-5");
  });

  it("returns null when already at the top tier", () => {
    assert.equal(escalateModel(cfg, "claude-code", "opus"), null);
    assert.equal(escalateModel(cfg, "codex", "gpt-5"), null);
  });

  it("returns null when the host has no configured ladder", () => {
    assert.equal(escalateModel(cfg, "gemini-cli", "gemini-2.5-pro"), null);
  });

  it("returns null when the current model isn't on the ladder (never throws)", () => {
    assert.equal(escalateModel(cfg, "claude-code", "some-unlisted-model"), null);
  });
});

describe("config: resolveHost precedence", () => {
  const cfg = {
    routing: {
      default_host: "generic",
      roles: { backend: "codex", qa: "claude-code" },
      stages: { "stage-08": "claude-code" },
    },
  };

  it("default_host wins when nothing else matches", () => {
    assert.equal(resolveHost(cfg, "stage-01", "pm"), "generic");
  });

  it("role override beats default", () => {
    assert.equal(resolveHost(cfg, "stage-04", "backend"), "codex");
    assert.equal(resolveHost(cfg, "stage-06", "qa"), "claude-code");
  });

  it("stage override beats role override", () => {
    // stage-08 is in stages override; even if role were matched, stage wins
    assert.equal(resolveHost(cfg, "stage-08", "platform"), "claude-code");
    assert.equal(resolveHost(cfg, "stage-08", "backend"), "claude-code");
  });
});

describe("config: renderDefaultConfig + writeConfigIfAbsent", () => {
  it("renders parseable YAML for single host", () => {
    const text = renderDefaultConfig(["claude-code"]);
    assert.match(text, /default_host: claude-code/);
    assert.match(text, /default_track: full/);
    assert.match(text, /require_signed_gates: false/);
    assert.match(text, /force_stages: \[\]/);
    assert.match(text, /receipts: true/);
  });

  it("renders multi-host hints", () => {
    const text = renderDefaultConfig(["claude-code", "codex"]);
    assert.match(text, /default_host: claude-code/);
    assert.match(text, /multi-host/);
    assert.match(text, /codex/);
  });

  it("throws on empty host list", () => {
    assert.throws(() => renderDefaultConfig([]));
  });

  it("writeConfigIfAbsent is idempotent without --force", () => {
    const cwd = track(makeTargetProject({ config: false }));
    const r1 = writeConfigIfAbsent(cwd, ["claude-code"]);
    assert.equal(r1.written, true);
    const r2 = writeConfigIfAbsent(cwd, ["claude-code"]);
    assert.equal(r2.written, false);
    assert.equal(r2.reason, "exists");
  });

  it("writeConfigIfAbsent --force overrides", () => {
    const cwd = track(makeTargetProject({ config: false }));
    writeConfigIfAbsent(cwd, ["claude-code"]);
    const r2 = writeConfigIfAbsent(cwd, ["codex"], { force: true });
    assert.equal(r2.written, true);
    const content = fs.readFileSync(r2.path, "utf8");
    assert.match(content, /default_host: codex/);
  });

  it("renders gizmos deploy section with environment, smoke_test_path, and app hint", () => {
    const text = renderDefaultConfig(["claude-code"], { adapter: "gizmos" });
    assert.match(text, /deploy:/);
    assert.match(text, /adapter: gizmos/);
    assert.match(text, /environment: production/);
    assert.match(text, /smoke_test_path: \/healthz/);
    assert.match(text, /gizmos:/);
    assert.match(text, /app: my-app/);
    assert.ok(!text.match(/^ {2}environment:/m) || text.includes("environment: production"), "environment must be present");
  });

  it("renders cloud-run deploy section with environment, smoke_test_path, and cloud_run hints", () => {
    const text = renderDefaultConfig(["claude-code"], { adapter: "cloud-run" });
    assert.match(text, /adapter: cloud-run/);
    assert.match(text, /environment: production/);
    assert.match(text, /smoke_test_path: \/healthz/);
    assert.match(text, /cloud_run:/);
    assert.match(text, /project: my-project/);
    assert.match(text, /region: us-central1/);
  });

  it("renders kubernetes deploy section with kubernetes subkeys; no environment or smoke_test_path", () => {
    const text = renderDefaultConfig(["claude-code"], { adapter: "kubernetes" });
    assert.match(text, /adapter: kubernetes/);
    assert.match(text, /kubernetes:/);
    assert.match(text, /strategy: manifests/);
    assert.match(text, /namespace:/);
    assert.ok(!text.includes("smoke_test_path"), "kubernetes must not include smoke_test_path");
    assert.ok(!text.includes("environment: production"), "kubernetes must not include environment");
    assert.ok(!text.includes("gizmos:"), "must not include gizmos hints");
    assert.ok(!text.includes("cloud_run:"), "must not include cloud_run hints");
  });

  it("renders docker-compose deploy section with docker_compose subkeys; no environment or smoke_test_path", () => {
    const text = renderDefaultConfig(["claude-code"], { adapter: "docker-compose" });
    assert.match(text, /adapter: docker-compose/);
    assert.match(text, /docker_compose:/);
    assert.match(text, /compose_file:/);
    assert.ok(!text.includes("smoke_test_path"), "docker-compose must not include smoke_test_path");
    assert.ok(!text.includes("environment: production"), "docker-compose must not include environment");
  });

  it("renders terraform deploy section with terraform subkeys", () => {
    const text = renderDefaultConfig(["claude-code"], { adapter: "terraform" });
    assert.match(text, /adapter: terraform/);
    assert.match(text, /terraform:/);
    assert.match(text, /working_dir:/);
    assert.match(text, /workspace:/);
    assert.ok(!text.includes("smoke_test_path"), "terraform must not include smoke_test_path");
  });

  it("renders custom deploy section with custom subkeys", () => {
    const text = renderDefaultConfig(["claude-code"], { adapter: "custom" });
    assert.match(text, /adapter: custom/);
    assert.match(text, /custom:/);
    assert.match(text, /script:/);
    assert.ok(!text.includes("smoke_test_path"), "custom must not include smoke_test_path");
  });

  it("omits deploy section when no adapter specified", () => {
    const text = renderDefaultConfig(["claude-code"]);
    assert.ok(!text.includes("deploy:"), "must not include deploy section without adapter");
  });

  it("writeConfigIfAbsent writes deploy section when adapter opt is set", () => {
    const cwd = track(makeTargetProject({ config: false }));
    const r = writeConfigIfAbsent(cwd, ["claude-code"], { adapter: "gizmos" });
    assert.equal(r.written, true);
    const content = fs.readFileSync(r.path, "utf8");
    assert.match(content, /adapter: gizmos/);
    assert.match(content, /gizmos:/);
    assert.match(content, /app:/);
    assert.match(content, /TODO/);
  });

  it("KNOWN_DEPLOY_ADAPTERS includes gizmos and cloud-run", () => {
    assert.ok(KNOWN_DEPLOY_ADAPTERS.includes("gizmos"));
    assert.ok(KNOWN_DEPLOY_ADAPTERS.includes("cloud-run"));
    assert.ok(KNOWN_DEPLOY_ADAPTERS.includes("docker-compose"));
    assert.ok(KNOWN_DEPLOY_ADAPTERS.includes("custom"));
  });
});

describe("config: clearConfigCache invalidates in-process reads", () => {
  it("assess --apply then loadConfig sees new custom_stages (same process)", () => {
    // Regression: loadConfig memoizes per-cwd. After writing config (as
    // assess --apply does), a subsequent loadConfig in the same process must
    // see the new value. clearConfigCache() must be called after the write.
    const cwd = track(makeTargetProject({
      config: "routing:\n  default_host: generic\npipeline:\n  default_track: full\n",
    }));
    const before = loadConfig(cwd);
    assert.equal(before.pipeline.custom_stages, null);

    // Simulate what assess --apply does: write custom_stages then clear cache.
    const yaml = require("js-yaml");
    const cfgPath = path.join(cwd, ".devteam", "config.yml");
    const parsed = yaml.load(fs.readFileSync(cfgPath, "utf8")) || {};
    parsed.pipeline = parsed.pipeline || {};
    parsed.pipeline.custom_stages = ["requirements", "build"];
    fs.writeFileSync(cfgPath, yaml.dump(parsed), "utf8");
    clearConfigCache();

    const after = loadConfig(cwd);
    assert.deepEqual(after.pipeline.custom_stages, ["requirements", "build"]);
  });

  it("without clearConfigCache, loadConfig returns stale cached value", () => {
    // Confirms the bug: without clearing, the old value is returned.
    const cwd = track(makeTargetProject({
      config: "routing:\n  default_host: generic\npipeline:\n  default_track: full\n",
    }));
    const before = loadConfig(cwd);
    assert.equal(before.pipeline.custom_stages, null);

    const yaml = require("js-yaml");
    const cfgPath = path.join(cwd, ".devteam", "config.yml");
    const parsed = yaml.load(fs.readFileSync(cfgPath, "utf8")) || {};
    parsed.pipeline = parsed.pipeline || {};
    parsed.pipeline.custom_stages = ["requirements", "build"];
    fs.writeFileSync(cfgPath, yaml.dump(parsed), "utf8");
    // No clearConfigCache() — stale cache remains.

    const stale = loadConfig(cwd);
    assert.equal(stale.pipeline.custom_stages, null, "stale cache should still return null");
    clearConfigCache(); // clean up for subsequent tests
  });
});
