"use strict";

function boundedPositiveInt(value) {
  return Number.isInteger(value) && value > 0 ? Math.min(value, 64) : null;
}

function hostConcurrencyLimit(config, host) {
  const limits = config && config.routing && config.routing.host_concurrency;
  if (!limits || typeof limits !== "object" || Array.isArray(limits)) return Infinity;
  const hostLimit = boundedPositiveInt(limits[host]);
  if (hostLimit !== null) return hostLimit;
  const defaultLimit = boundedPositiveInt(limits.default);
  return defaultLimit !== null ? defaultLimit : Infinity;
}

async function mapByHostConcurrency(items, { key = (item) => item.host, limit = () => Infinity, onQueued } = {}, worker) {
  if (!Array.isArray(items)) return [];
  const results = new Array(items.length);
  const active = new Map();
  const queues = new Map();
  let completed = 0;
  let rejected = false;

  return new Promise((resolve, reject) => {
    const maybeDone = () => {
      if (!rejected && completed === items.length) resolve(results);
    };

    const drain = (host) => {
      if (rejected) return;
      const q = queues.get(host) || [];
      const max = limit(host);
      const cap = Number.isFinite(max) ? Math.max(1, max) : Infinity;
      while ((active.get(host) || 0) < cap && q.length > 0) {
        const entry = q.shift();
        active.set(host, (active.get(host) || 0) + 1);
        const queueMs = Math.max(0, Date.now() - entry.enqueuedAt);
        Promise.resolve()
          .then(() => worker(entry.item, entry.index, { queueMs, queueLimit: cap }))
          .then((result) => { results[entry.index] = result; })
          .catch((err) => {
            rejected = true;
            reject(err);
          })
          .finally(() => {
            active.set(host, Math.max(0, (active.get(host) || 1) - 1));
            completed += 1;
            drain(host);
            maybeDone();
          });
      }
    };

    if (items.length === 0) {
      resolve([]);
      return;
    }

    for (let index = 0; index < items.length; index += 1) {
      const item = items[index];
      const host = key(item) || "unknown";
      const queue = queues.get(host) || [];
      const queueLimit = limit(host);
      const entry = { item, index, enqueuedAt: Date.now() };
      queue.push(entry);
      queues.set(host, queue);
      if (typeof onQueued === "function") {
        onQueued(item, index, {
          queueDepth: queue.length,
          queueLimit: Number.isFinite(queueLimit) ? queueLimit : null,
        });
      }
    }

    for (const host of queues.keys()) drain(host);
  });
}

// ADR-017 (32.6): a wave dispatches multiple STAGES concurrently, not
// multiple workstreams of one stage. Reusing mapByHostConcurrency's default
// `key: item => item.host` for wave-level dispatch would let
// routing.host_concurrency — designed by ADR-015 to bound workstream fan-out
// WITHIN one stage — incorrectly throttle cross-stage wave concurrency too:
// two different wave members that happen to route to the same host would
// collide in the same host-only queue. Keying by (host, stage) instead gives
// each wave member its own queue. autonomy.max_parallel_stages is the only
// cap on wave-level concurrency (enforced at ready-set formation in
// core/orchestrator.js#_nextWaveImpl, before any item reaches this
// scheduler); routing.host_concurrency keeps capping concurrent workstreams
// inside a single member's own dispatch, unchanged — the two caps compose
// rather than one silently overriding the other.
function waveMemberKey(item) {
  return `${item.host || "unknown"}::${item.stage || "unknown"}`;
}

module.exports = { hostConcurrencyLimit, mapByHostConcurrency, waveMemberKey };
