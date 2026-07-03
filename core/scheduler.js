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

module.exports = { hostConcurrencyLimit, mapByHostConcurrency };
