const { afterEach, describe, it } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { REPO_ROOT } = require("./_helpers");
const { listHosts, loadAdapter, resolveAdapter } = require(path.join(REPO_ROOT, "core", "router"));

const ORIGINAL_CWD = process.cwd();

afterEach(() => {
  process.chdir(ORIGINAL_CWD);
});

function writeExternalAdapterFixture(hostName) {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "stagecraft-router-"));
  const packageDir = path.join(tmp, "node_modules", "@devteam", `host-${hostName}`);
  fs.mkdirSync(packageDir, { recursive: true });
  fs.writeFileSync(
    path.join(packageDir, "adapter.js"),
    `module.exports = {
  capabilities: { name: ${JSON.stringify(hostName)}, headless: false },
  install() { return { written: [], skipped: [], warnings: [] }; },
  renderStagePrompt() { return "external adapter prompt"; },
  status() { return { ok: true, missing: [], stale: [], notes: [] }; },
  uninstall() {},
};\n`,
  );
  return tmp;
}

describe("router: listHosts", () => {
  it("includes claude-code, codex, generic", () => {
    const hosts = listHosts();
    assert.ok(hosts.includes("claude-code"));
    assert.ok(hosts.includes("codex"));
    assert.ok(hosts.includes("generic"));
  });

  it("includes external @devteam/host-* adapters installed under node_modules", () => {
    const tmp = writeExternalAdapterFixture("acme");
    process.chdir(tmp);

    assert.ok(listHosts().includes("acme"));
  });
});

describe("router: loadAdapter", () => {
  it("loads a known adapter", () => {
    const a = loadAdapter("generic");
    assert.equal(typeof a.install, "function");
    assert.equal(typeof a.renderStagePrompt, "function");
    assert.ok(a.capabilities);
  });

  it("throws a helpful error for an unknown adapter", () => {
    assert.throws(() => loadAdapter("nope"), /No adapter found for host "nope"/);
  });

  it("loads an external @devteam/host-* adapter", () => {
    const tmp = writeExternalAdapterFixture("acme-load");
    process.chdir(tmp);

    const adapter = loadAdapter("acme-load");
    assert.equal(adapter.capabilities.name, "acme-load");
    assert.equal(adapter.renderStagePrompt(), "external adapter prompt");
  });
});

describe("router: resolveAdapter", () => {
  const cfg = {
    routing: {
      default_host: "generic",
      roles: { backend: "codex" },
      stages: { "stage-08": "claude-code" },
    },
  };

  it("respects stage > role > default precedence", () => {
    const a = resolveAdapter(cfg, "stage-04", "backend");
    assert.equal(a.hostName, "codex");
    const b = resolveAdapter(cfg, "stage-08", "platform");
    assert.equal(b.hostName, "claude-code");
    const c = resolveAdapter(cfg, "stage-01", "pm");
    assert.equal(c.hostName, "generic");
  });

  it("throws when the resolved adapter doesn't exist", () => {
    const broken = { routing: { default_host: "imaginary-host", roles: {}, stages: {} } };
    assert.throws(() => resolveAdapter(broken, "stage-01", "pm"), /No adapter found/);
  });

  // 32.3: routing.roles/routing.stages may be {host, model} instead of a
  // bare host string. resolveAdapter surfaces the resolved model alongside
  // hostName/adapter; string-form entries keep model undefined.
  it("32.3: resolves {host, model} object-form routes and surfaces model", () => {
    const cfgWithModel = {
      routing: {
        default_host: "generic",
        roles: { backend: { host: "codex", model: "gpt-5-mini" } },
        stages: { "stage-08": { host: "claude-code", model: "claude-haiku-4-5-20251001" } },
      },
    };
    const a = resolveAdapter(cfgWithModel, "stage-04", "backend");
    assert.equal(a.hostName, "codex");
    assert.equal(a.model, "gpt-5-mini");
    const b = resolveAdapter(cfgWithModel, "stage-08", "platform");
    assert.equal(b.hostName, "claude-code");
    assert.equal(b.model, "claude-haiku-4-5-20251001");
  });

  it("32.3: string-form routes keep model undefined (back-compat)", () => {
    const a = resolveAdapter(cfg, "stage-04", "backend");
    assert.equal(a.hostName, "codex");
    assert.equal(a.model, undefined);
  });

  // Phase-34 item 34.1: "acp:<command>" routes surface both the resolved
  // host ("acp") and the inline launch command as agentCommand, alongside
  // the loaded adapter — same "rides alongside the adapter" shape as
  // model (32.3) above.
  it("34.1: resolves \"acp:<command>\" routes and surfaces agentCommand", () => {
    const cfgWithAcp = {
      routing: {
        default_host: "generic",
        roles: { backend: "acp:claude-agent-acp --experimental" },
        stages: {},
      },
    };
    const a = resolveAdapter(cfgWithAcp, "stage-04", "backend");
    assert.equal(a.hostName, "acp");
    assert.equal(a.agentCommand, "claude-agent-acp --experimental");
    assert.equal(a.adapter.capabilities.name, "acp");
  });

  it("34.1: string-form and object-form routes without acp: keep agentCommand undefined", () => {
    const a = resolveAdapter(cfg, "stage-04", "backend");
    assert.equal(a.agentCommand, undefined);
  });

  it("resolves routing to an external @devteam/host-* adapter", () => {
    const tmp = writeExternalAdapterFixture("acme-route");
    process.chdir(tmp);

    const routed = resolveAdapter(
      { routing: { default_host: "acme-route", roles: {}, stages: {} } },
      "stage-01",
      "pm",
    );
    assert.equal(routed.hostName, "acme-route");
    assert.equal(routed.adapter.capabilities.name, "acme-route");
  });
});
