const { describe, it } = require("node:test");
const assert = require("node:assert/strict");
const path = require("node:path");
const { REPO_ROOT } = require("./_helpers");
const {
  hostConcurrencyLimit,
  mapByHostConcurrency,
} = require(path.join(REPO_ROOT, "core", "scheduler"));

function sleep(ms) { return new Promise((resolve) => setTimeout(resolve, ms)); }

describe("scheduler: host concurrency", () => {
  it("resolves host-specific, default, and unbounded limits", () => {
    const config = { routing: { host_concurrency: { default: 3, codex: 1, bad: 0 } } };
    assert.equal(hostConcurrencyLimit(config, "codex"), 1);
    assert.equal(hostConcurrencyLimit(config, "claude-code"), 3);
    assert.equal(hostConcurrencyLimit(config, "bad"), 3);
    assert.equal(hostConcurrencyLimit({}, "codex"), Infinity);
  });

  it("preserves result order while limiting only same-host work", async () => {
    const items = [
      { host: "codex", id: "a" },
      { host: "codex", id: "b" },
      { host: "claude-code", id: "c" },
    ];
    const running = {};
    const maxRunning = {};
    const queued = [];
    const results = await mapByHostConcurrency(items, {
      limit: (host) => host === "codex" ? 1 : Infinity,
      onQueued: (item, _index, queue) => queued.push({ id: item.id, queueDepth: queue.queueDepth }),
    }, async (item, _index, queue) => {
      running[item.host] = (running[item.host] || 0) + 1;
      maxRunning[item.host] = Math.max(maxRunning[item.host] || 0, running[item.host]);
      await sleep(item.id === "a" ? 20 : 1);
      running[item.host] -= 1;
      return { id: item.id, queueMs: queue.queueMs };
    });

    assert.deepEqual(results.map((item) => item.id), ["a", "b", "c"]);
    assert.equal(maxRunning.codex, 1);
    assert.equal(maxRunning["claude-code"], 1);
    assert.deepEqual(queued.map((item) => item.queueDepth), [1, 2, 1]);
    assert.ok(results[1].queueMs >= 1);
  });
});
