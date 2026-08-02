#!/usr/bin/env node
// performance.js — per-role per-model performance aggregator.
//
// Reads pipeline/gates/ from one or more projects, expands merged stage
// gates into per-workstream entries, and aggregates by (role, host). For
// each pair, reports:
//
//   - total_dispatches
//   - pass_first_try (PASS status AND no retry_number, or retry_number=0)
//   - pass_rate_first_try (pass_first_try / total_dispatches × 100)
//   - mean_retries_to_pass (retry_number averaged across gates that PASSed)
//   - total_cost_usd / mean_cost_usd
//   - mean/p50/p95 duration_ms
//   - retry_adjusted_completion_ms
//   - cost_per_pass (total cost / count of passes — the unit cost of one
//     passing dispatch; useful for "which host is cheapest per success?")
//
// This is the data layer for D5 (adaptive routing). The output is
// designed to be read by humans AND by scripts/routing-suggest.js.

const { loadGatesFrom, filterSince } = require("./dashboard");
const { formatUsd } = require("../core/pricing");

function parseArgs(argv) {
  const args = { from: [process.cwd()], json: false, since: null };
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === "--from") args.from = argv[++i].split(",").map((s) => s.trim()).filter(Boolean);
    else if (argv[i] === "--json") args.json = true;
    else if (argv[i] === "--since") args.since = argv[++i];
    else if (argv[i] === "-h" || argv[i] === "--help") { args.help = true; }
  }
  return args;
}

// Flatten merged stage gates into per-workstream entries the same way the
// dashboard does. Each entry carries: stage, workstream (role), host,
// status, optionally retry_number / tokens / cost / duration.
function expandToWorkstreams(gates) {
  const expanded = [];
  for (const g of gates) {
    if (Array.isArray(g.workstreams) && g.workstreams.length > 0) {
      for (const w of g.workstreams) {
        expanded.push({ ...w, stage: g.stage, timestamp: g.timestamp });
      }
    } else if (g.workstream && g.host) {
      // Workstream gate (per-role file, not the merged stage gate).
      expanded.push(g);
    }
    // Else: stage-level gate with no workstreams[] (single-role stages,
    // e.g. stage-01.json with workstream:"pm"). Already covered above.
  }
  return expanded;
}

function emptyPerfRec() {
  return {
    total_dispatches: 0,
    pass: 0,
    pass_first_try: 0,
    warn: 0,
    fail: 0,
    escalate: 0,
    retry_numbers: [],   // raw retry numbers from PASSed gates
    cost_usd: 0,
    has_cost: 0,
    duration_ms: 0,
    durations: [],
    retry_adjusted_durations: [],
    has_duration: 0,
    models: new Set(),   // distinct models seen for this (role, host)
  };
}

function bump(rec, w) {
  rec.total_dispatches += 1;
  const status = w.status;
  if (status === "PASS") rec.pass += 1;
  else if (status === "WARN") rec.warn += 1;
  else if (status === "FAIL") rec.fail += 1;
  else if (status === "ESCALATE") rec.escalate += 1;

  // "First try" means retry_number is absent or 0. WARN counts as first-try
  // success too (it's PASS-with-warnings).
  const retry = typeof w.retry_number === "number" ? w.retry_number : 0;
  if ((status === "PASS" || status === "WARN") && retry === 0) {
    rec.pass_first_try += 1;
  }
  if (status === "PASS") {
    rec.retry_numbers.push(retry);
  }

  if (typeof w.cost_usd === "number") { rec.cost_usd += w.cost_usd; rec.has_cost += 1; }
  if (typeof w.duration_ms === "number") {
    rec.duration_ms += w.duration_ms;
    rec.durations.push(w.duration_ms);
    rec.has_duration += 1;
    if (status === "PASS" || status === "WARN") {
      rec.retry_adjusted_durations.push(w.duration_ms * (retry + 1));
    }
  }
  if (typeof w.model === "string") rec.models.add(w.model);
}

function aggregatePerformance(gates) {
  const expanded = expandToWorkstreams(gates);
  const groups = new Map();
  for (const w of expanded) {
    const role = w.workstream || "(no role)";
    const host = w.host || "(no host)";
    const key = `${role}@${host}`;
    if (!groups.has(key)) groups.set(key, { role, host, ...emptyPerfRec() });
    bump(groups.get(key), w);
  }
  return groups;
}

// Phase-32 item 32.3: (role, host, model) grouping — additive alongside
// aggregatePerformance's (role, host) grouping above (which is unchanged,
// so every pre-32.3 caller/test keeps its exact shape). Feeds
// scripts/routing-suggest.js's per-tier cost-delta section: for a role
// dispatched to the same host under two different pinned models (a "tier"
// swap), this is what lets the report show a cost/pass-rate delta between
// them instead of blending both models into one (role, host) bucket.
function aggregatePerformanceByModel(gates) {
  const expanded = expandToWorkstreams(gates);
  const groups = new Map();
  for (const w of expanded) {
    const role = w.workstream || "(no role)";
    const host = w.host || "(no host)";
    const model = w.model || "(unspecified)";
    const key = `${role}@${host}@${model}`;
    if (!groups.has(key)) groups.set(key, { role, host, model, ...emptyPerfRec() });
    bump(groups.get(key), w);
  }
  return groups;
}

function mean(xs) {
  if (!xs || xs.length === 0) return null;
  return xs.reduce((s, x) => s + x, 0) / xs.length;
}

function percentile(xs, p) {
  if (!xs || xs.length === 0) return null;
  const sorted = [...xs].sort((a, b) => a - b);
  const idx = Math.ceil((p / 100) * sorted.length) - 1;
  return sorted[Math.max(0, Math.min(sorted.length - 1, idx))];
}

function summarize(rec) {
  const passRateFirstTry = rec.total_dispatches > 0
    ? (rec.pass_first_try / rec.total_dispatches) * 100
    : 0;
  const meanRetries = mean(rec.retry_numbers);
  const meanCost = rec.has_cost > 0 ? rec.cost_usd / rec.has_cost : null;
  const meanDuration = rec.has_duration > 0 ? rec.duration_ms / rec.has_duration : null;
  const retryAdjustedCompletion = mean(rec.retry_adjusted_durations);
  // cost_per_pass — divide total cost by count of PASS+WARN (anything
  // that successfully ended a workstream).
  const successCount = rec.pass + rec.warn;
  const costPerPass = successCount > 0 && rec.has_cost > 0
    ? rec.cost_usd / successCount
    : null;
  return {
    role: rec.role,
    host: rec.host,
    // 32.3: only present on aggregatePerformanceByModel() records — the
    // (role, host) aggregate above never sets rec.model.
    ...(rec.model !== undefined ? { model: rec.model } : {}),
    total_dispatches: rec.total_dispatches,
    pass: rec.pass,
    warn: rec.warn,
    fail: rec.fail,
    escalate: rec.escalate,
    pass_rate_first_try: passRateFirstTry,
    mean_retries_to_pass: meanRetries,
    total_cost_usd: rec.cost_usd,
    mean_cost_usd: meanCost,
    cost_per_pass_usd: costPerPass,
    mean_duration_ms: meanDuration,
    p50_duration_ms: percentile(rec.durations, 50),
    p95_duration_ms: percentile(rec.durations, 95),
    retry_adjusted_completion_ms: retryAdjustedCompletion,
    models: [...rec.models],
  };
}

function formatDuration(ms) {
  if (ms === null || ms === undefined) return "—";
  if (ms < 1000) return `${Math.round(ms)}ms`;
  if (ms < 60_000) return `${(ms / 1000).toFixed(1)}s`;
  return `${(ms / 60_000).toFixed(1)}m`;
}

function renderMarkdown(args, summaries) {
  const out = [];
  out.push(`# devteam performance — per-(role, host)\n`);
  out.push(`Generated: ${new Date().toISOString()}`);
  out.push(`Sources: ${args.from.map((s) => `\`${s}\``).join(", ")}`);
  if (args.since) out.push(`Since: ${args.since}`);
  out.push("");

  if (summaries.length === 0) {
    out.push(`_No workstream dispatches found. Run some pipeline stages first, or pass \`--from <project>\` if the data lives elsewhere._`);
    return out.join("\n") + "\n";
  }

  out.push(`## Performance by (role, host) pair`);
  out.push("");
  out.push(`| Role | Host | Dispatches | First-try pass | Mean retries | Mean cost | Cost/pass | Mean duration | p95 duration | Retry-adjusted completion |`);
  out.push(`|---|---|---:|---:|---:|---:|---:|---:|---:|---:|`);
  // Sort by role then by descending dispatch count so the most-used
  // (role, host) pair for each role shows up first.
  const sorted = [...summaries].sort((a, b) => {
    if (a.role !== b.role) return a.role.localeCompare(b.role);
    return b.total_dispatches - a.total_dispatches;
  });
  for (const s of sorted) {
    const passRate = `${s.pass_rate_first_try.toFixed(0)}%`;
    const retries = s.mean_retries_to_pass === null ? "—" : s.mean_retries_to_pass.toFixed(2);
    const meanCost = formatUsd(s.mean_cost_usd);
    const costPerPass = formatUsd(s.cost_per_pass_usd);
    out.push(`| ${s.role} | ${s.host} | ${s.total_dispatches} | ${passRate} | ${retries} | ${meanCost} | ${costPerPass} | ${formatDuration(s.mean_duration_ms)} | ${formatDuration(s.p95_duration_ms)} | ${formatDuration(s.retry_adjusted_completion_ms)} |`);
  }
  out.push("");

  // Highlights — for each role with 2+ hosts seen, name the best.
  const byRole = new Map();
  for (const s of summaries) {
    if (!byRole.has(s.role)) byRole.set(s.role, []);
    byRole.get(s.role).push(s);
  }
  const headlines = [];
  for (const [role, perRole] of byRole) {
    if (perRole.length < 2) continue;
    // "Best" = highest first-try pass rate, tiebreaker by cost_per_pass.
    const sorted = [...perRole].sort((a, b) => {
      if (b.pass_rate_first_try !== a.pass_rate_first_try) {
        return b.pass_rate_first_try - a.pass_rate_first_try;
      }
      const aCost = a.cost_per_pass_usd === null ? Infinity : a.cost_per_pass_usd;
      const bCost = b.cost_per_pass_usd === null ? Infinity : b.cost_per_pass_usd;
      return aCost - bCost;
    });
    const best = sorted[0];
    const second = sorted[1];
    headlines.push(
      `- **${role}**: ${best.host} (${best.pass_rate_first_try.toFixed(0)}% first-try, ` +
      `${formatUsd(best.cost_per_pass_usd)} per pass, p95 ${formatDuration(best.p95_duration_ms)}) ` +
      `vs ${second.host} (${second.pass_rate_first_try.toFixed(0)}%, ` +
      `${formatUsd(second.cost_per_pass_usd)}, p95 ${formatDuration(second.p95_duration_ms)}).`,
    );
  }
  if (headlines.length > 0) {
    out.push(`## Headline pairwise comparisons`);
    out.push("");
    for (const h of headlines) out.push(h);
    out.push("");
    out.push(`Run \`npm run routing:suggest\` (D5) to convert these into a config diff for \`.devteam/config.yml\`.`);
  }

  return out.join("\n") + "\n";
}

function renderJSON(args, summaries) {
  return JSON.stringify({
    generated_at: new Date().toISOString(),
    sources: args.from,
    since: args.since,
    rows: summaries,
  }, null, 2);
}

function usage() {
  console.log(`performance — per-(role, host) historical performance from pipeline/gates/

Usage:
  node scripts/performance.js                       Read cwd/pipeline/gates/.
  node scripts/performance.js --from p1,p2,...      Multi-project rollup.
  node scripts/performance.js --since YYYY-MM-DD    Time-window filter.
  node scripts/performance.js --json                Machine-readable output.

Output: per-(role, host) dispatch count, first-try pass rate, mean
retries to pass, mean cost (USD), cost per successful pass, mean/p50/p95
duration, and retry-adjusted completion time. The cost figures require gates
to carry tokens_in / tokens_out / model (see D6 / docs/cost.md); gates without
those fields are counted but don't contribute to cost aggregates.

This is the data layer for D5 — \`scripts/routing-suggest.js\` reads
the same gates and proposes routing-config changes based on these scores.
`);
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.help) { usage(); return; }

  let all = [];
  const warnings = [];
  for (const src of args.from) {
    const loaded = loadGatesFrom(src);
    all.push(...loaded.gates);
    if (loaded.warning) warnings.push(loaded.warning);
  }
  all = filterSince(all, args.since);

  for (const w of warnings) process.stderr.write(`[performance] ⚠️  ${w}\n`);

  const groups = aggregatePerformance(all);
  const summaries = [...groups.values()].map(summarize);

  if (args.json) console.log(renderJSON(args, summaries));
  else console.log(renderMarkdown(args, summaries));
}

if (require.main === module) main();

module.exports = {
  expandToWorkstreams,
  aggregatePerformance,
  aggregatePerformanceByModel,
  summarize,
  renderMarkdown,
  renderJSON,
  percentile,
  formatDuration,
};
