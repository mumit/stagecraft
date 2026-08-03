// Eval flywheel — prompt-pack compare (phase-33 item 33.3,
// plans/phase-33-eval-flywheel.md §33.3).
//
// `devteam evals compare --pack <A> --pack <B>` answers "did the new
// principal brief help?" as a query over the run corpus (28.5,
// core/corpus.js) rather than a feeling: per-stage pass-rate deltas between
// two prompt_pack_version values (core/prompt-pack.js), with dispatch
// counts. Honesty-gated by a minimum dispatch count per cell (default 5,
// the same floor D5 uses in core/corpus.js#computeStats) — a stage with
// fewer than min-n dispatches on either pack is reported as refused, never
// silently compared on too little evidence.
//
// This is C4 reproducibility's missing consumer (docs/reproducibility.md):
// system_prompt_hash/prompt_pack_version tell you THAT the surface changed;
// this is what turns that into a pass-rate answer.

"use strict";

const { readCorpus } = require("../corpus");

const DEFAULT_MIN_N = 5;

// PASS/WARN both count as "passed" — same convention core/corpus.js's
// computeStats uses for stage pass_rate.
function groupByStage(records, packVersion) {
  const byStage = new Map();
  for (const r of records) {
    if (r.prompt_pack_version !== packVersion) continue;
    const stage = r.stage || "(unknown)";
    if (!byStage.has(stage)) byStage.set(stage, { total: 0, pass: 0 });
    const entry = byStage.get(stage);
    entry.total += 1;
    if (r.gate_status === "PASS" || r.gate_status === "WARN") entry.pass += 1;
  }
  return byStage;
}

/**
 * Compare per-stage pass rates between two prompt_pack_version values in
 * this project's run corpus (.devteam/corpus/dispatches.jsonl).
 *
 * opts: { minN } — minimum dispatch count required on EACH pack for a stage
 * to be compared (default 5). A stage below the floor on either side is
 * reported with refused: true and contributes no pass-rate delta.
 */
function comparePacks(cwd, packA, packB, opts = {}) {
  const minN = typeof opts.minN === "number" && opts.minN > 0 ? opts.minN : DEFAULT_MIN_N;
  const records = readCorpus(cwd);

  const aByStage = groupByStage(records, packA);
  const bByStage = groupByStage(records, packB);
  const stages = [...new Set([...aByStage.keys(), ...bByStage.keys()])].sort();

  const rows = stages.map((stage) => {
    const a = aByStage.get(stage) || { total: 0, pass: 0 };
    const b = bByStage.get(stage) || { total: 0, pass: 0 };
    const refused = a.total < minN || b.total < minN;
    const passRateA = a.total > 0 ? (a.pass / a.total) * 100 : null;
    const passRateB = b.total > 0 ? (b.pass / b.total) * 100 : null;
    return {
      stage,
      pack_a: { version: packA, dispatches: a.total, pass_rate: passRateA },
      pack_b: { version: packB, dispatches: b.total, pass_rate: passRateB },
      delta: (!refused && passRateA !== null && passRateB !== null) ? passRateB - passRateA : null,
      refused,
      refused_reason: refused
        ? `fewer than ${minN} dispatches on ${a.total < minN ? packA : packB} for this stage (${packA}: ${a.total}, ${packB}: ${b.total})`
        : null,
    };
  });

  return {
    pack_a: packA,
    pack_b: packB,
    min_n: minN,
    total_dispatches_a: [...aByStage.values()].reduce((s, e) => s + e.total, 0),
    total_dispatches_b: [...bByStage.values()].reduce((s, e) => s + e.total, 0),
    stages: rows,
  };
}

module.exports = { comparePacks, DEFAULT_MIN_N };
