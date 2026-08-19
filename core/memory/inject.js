// core/memory/inject.js
//
// Phase 30 item 30.4 — retrieval into stage prompts (the read side of the
// closed loop; auto-ingest at pipeline-complete, the write side, is wired
// into core/driver.js).
//
// buildDescriptor() and runStage() (core/orchestrator.js) are synchronous —
// dozens of existing call sites (37 direct runStage() calls and 25+
// buildDescriptor() calls across tests, plus three preview-only CLI
// commands: `devteam stage` without --headless, `devteam reproduce`,
// `devteam replay`) assume a plain synchronous return. Querying memory
// has an async provider contract (builtin, an optional transformer provider,
// or the DEVTEAM_EMBEDDING_PROVIDER=stub test seam). So retrieval happens
// *before* the synchronous descriptor-building pipeline, in
// runStageHeadless() (core/orchestrator.js) — the one dispatch path that
// was already async — and the result is threaded through as a plain opts
// field (opts.priorKnowledge) that buildDescriptor() attaches and
// renderPriorKnowledge() (core/adapters/render-helpers.js) renders,
// entirely synchronously. See docs/memory.md "Prompt injection" for the
// user-facing note that the interactive preview path doesn't get this.
//
// Never throws: any retrieval failure (no store, opted out, optional
// embedder dependency absent, embedder error) degrades to an empty result
// plus at most one warning string for the caller to print.

"use strict";

const fs = require("node:fs");
const path = require("node:path");

// Same total as core/patterns.js DEFAULT_BUDGET.maxBytes discipline, scaled
// down for this section — see plans/phase-30-closed-learning-loop.md 30.4.
const MAX_BYTES = 1200;
// Per-entry snippet cap so one large indexed chunk can't eat the whole
// budget by itself (mirrors the snippet trim in core/cli/commands/
// architecture.js's lookup rendering).
const SNIPPET_CHARS = 300;

function storeExists(cwd) {
  return fs.existsSync(path.join(cwd, ".devteam", "memory"));
}

function isOptedIn(config) {
  return !config || !config.memory || config.memory.inject !== false;
}

function snippet(text) {
  return String(text || "").replace(/\s+/g, " ").trim().slice(0, SNIPPET_CHARS);
}

// Greedy accumulate-skip-oversized budget — same discipline as
// core/patterns.js selectForDescriptor(): try items in (pre-sorted) order,
// skip ones that would overflow, keep going. Deterministic because the
// caller sorts by similarity (then id) before calling this.
function applyBudget(items, maxBytes) {
  const out = [];
  let bytes = 0;
  for (const item of items) {
    const nextBytes = bytes + Buffer.byteLength(item.text, "utf8");
    if (nextBytes > maxBytes && out.length > 0) continue;
    bytes = nextBytes;
    out.push(item);
  }
  return out;
}

async function queryOne({ cwd, text, topK, org, queryFn, queryOrgFn }) {
  if (org) return (queryOrgFn || require("./index").queryOrg)(text, { limit: topK, kind: "adr" });
  return (queryFn || require("./index").query)(text, { cwd, limit: topK });
}

function toEntry(r) {
  return { kind: r.kind, source: r.source, text: snippet(r.text), similarity: r.similarity, id: r.id };
}

/**
 * Retrieve and budget attributed history entries for one stage's Project Knowledge Pack.
 * dispatch.
 *
 * @param {object} opts
 * @param {string} opts.cwd
 * @param {object} opts.config        loaded config (core/config.js)
 * @param {object} [opts.stageDef]    stage definition; stage-02 additionally
 *                                    queries the org store for ADRs
 * @param {string} opts.queryText     feature/brief text to query against;
 *                                    empty/blank text short-circuits to
 *                                    an empty result with no queries issued
 * @param {number} [opts.topK]        overrides config.memory.inject_top_k
 * @param {number} [opts.floor]       overrides config.memory.inject_similarity_floor
 * @param {function} [opts.queryFn]    test seam — overrides core/memory/index.js's query()
 * @param {function} [opts.queryOrgFn] test seam — overrides core/memory/index.js's queryOrg()
 * @returns {Promise<{priorKnowledge: Array<{kind,source,text}>, warning: string|null}>}
 */
async function priorKnowledgeForStage(opts = {}) {
  const { cwd, config, stageDef, queryText, queryFn, queryOrgFn } = opts;
  if (!queryText || !queryText.trim()) return { priorKnowledge: [], warning: null };
  if (!storeExists(cwd) || !isOptedIn(config)) return { priorKnowledge: [], warning: null };

  const topK = Number.isInteger(opts.topK) ? opts.topK : (config?.memory?.inject_top_k ?? 3);
  const floor = typeof opts.floor === "number" ? opts.floor : (config?.memory?.inject_similarity_floor ?? 0);

  let results;
  try {
    results = await queryOne({ cwd, text: queryText, topK, org: false, queryFn, queryOrgFn });
  } catch (err) {
    return { priorKnowledge: [], warning: `[memory] prior-knowledge retrieval skipped: ${err.message}` };
  }
  let all = results.filter((r) => r.similarity >= floor).map(toEntry);

  // 30.4: stage-02 (design) additionally queries the org store for ADRs —
  // the automatic counterpart to the principal role brief's manual
  // `devteam architecture lookup` suggestion (roles/principal.md).
  if (stageDef && stageDef.stage === "stage-02") {
    try {
      const orgResults = await queryOne({ cwd, text: queryText, topK, org: true, queryFn, queryOrgFn });
      all = all.concat(orgResults.filter((r) => r.similarity >= floor).map(toEntry));
    } catch {
      // Org store absent/unreadable doesn't invalidate the project-store
      // results already gathered above; only a project-store failure warns.
    }
  }

  all.sort((a, b) => (b.similarity - a.similarity) || String(a.id).localeCompare(String(b.id)));
  const bounded = applyBudget(all, MAX_BYTES).map(({ kind, source, text }) => ({ kind, source, text }));
  return { priorKnowledge: bounded, warning: null };
}

module.exports = { priorKnowledgeForStage, MAX_BYTES };
