#!/usr/bin/env node
// routing-suggest.js — D5 adaptive routing.
//
// Reads per-(role, host) performance scores from scripts/performance.js,
// compares them against the current routing config in .devteam/config.yml,
// and proposes role-level routing changes that would (based on the data)
// improve pass-rate-per-dollar.
//
// Manual review by default — outputs a YAML diff for the user to apply.
// `--apply` rewrites .devteam/config.yml's `routing.roles` section in
// place after first asking for confirmation (skipped when --yes is set).
//
// Consistent with the audit's "verify before promoting" discipline: we
// don't silently rewire production routing on the basis of N=4 dispatches.
// Minimum-sample thresholds + tie semantics are documented below.

const fs = require("node:fs");
const path = require("node:path");
const yaml = require("js-yaml");
const { loadGatesFrom, filterSince } = require("./dashboard");
const { aggregatePerformance, summarize, formatDuration } = require("./performance");
const { formatUsd } = require("../core/pricing");
const { readCorpus, corpusRecordsToWorkstreams } = require("../core/corpus");

// Minimum dispatches per (role, host) pair before we'll consider it for a
// recommendation. With fewer samples, observed pass rates aren't reliable.
const MIN_DISPATCHES = 5;

// A challenger must beat the incumbent's pass-rate by at least this much
// (in absolute percentage points) before we'd flip the routing. Prevents
// recommendations on noisy near-ties.
const MIN_PASS_RATE_DELTA = 10;

function parseArgs(argv) {
  const args = {
    from: [process.cwd()],
    cwd: process.cwd(),
    since: null,
    intent: null,   // ADR-009 §Decision.7: filter to "repair" or "feature" runs only
    apply: false,
    yes: false,
    json: false,
    minDispatches: MIN_DISPATCHES,
    minDelta: MIN_PASS_RATE_DELTA,
  };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--from") args.from = argv[++i].split(",").map((s) => s.trim()).filter(Boolean);
    else if (a === "--cwd") args.cwd = argv[++i];
    else if (a === "--since") args.since = argv[++i];
    else if (a === "--intent") args.intent = argv[++i];
    else if (a === "--apply") args.apply = true;
    else if (a === "--yes" || a === "-y") args.yes = true;
    else if (a === "--json") args.json = true;
    else if (a === "--min-dispatches") args.minDispatches = Number(argv[++i]);
    else if (a === "--min-delta") args.minDelta = Number(argv[++i]);
    else if (a === "-h" || a === "--help") { args.help = true; }
  }
  return args;
}

// Score a (role, host) summary for routing decisions. Higher is better.
// Pass rate is always primary. Cost is the first tiebreaker; retry-adjusted
// latency is only a second tiebreaker. That keeps routing quality-first:
// a faster host cannot win unless it is quality-equivalent under policy.
function scoreFor(summary) {
  return {
    passRate: summary.pass_rate_first_try,
    costPerPass: summary.cost_per_pass_usd === null ? Infinity : summary.cost_per_pass_usd,
    retryAdjustedMs: summary.retry_adjusted_completion_ms === null ? Infinity : summary.retry_adjusted_completion_ms,
  };
}

// Compare two scores. Returns positive if a is better, negative if b is.
function compareScores(a, b) {
  if (a.passRate !== b.passRate) return a.passRate - b.passRate;
  // Lower cost_per_pass wins on a pass-rate tie.
  if (a.costPerPass !== b.costPerPass) return b.costPerPass - a.costPerPass;
  // Lower retry-adjusted completion time wins only after quality and cost tie.
  if (a.retryAdjustedMs === b.retryAdjustedMs) return 0;
  return b.retryAdjustedMs - a.retryAdjustedMs;
}

function routingMetrics(s) {
  return {
    host: s.host,
    dispatches: s.total_dispatches,
    pass_rate_first_try: s.pass_rate_first_try,
    cost_per_pass_usd: s.cost_per_pass_usd,
    mean_duration_ms: s.mean_duration_ms ?? null,
    p50_duration_ms: s.p50_duration_ms ?? null,
    p95_duration_ms: s.p95_duration_ms ?? null,
    retry_adjusted_completion_ms: s.retry_adjusted_completion_ms ?? null,
  };
}

function metricsText(s) {
  return `${s.pass_rate_first_try.toFixed(0)}% first-try, ` +
    `${formatUsd(s.cost_per_pass_usd)} per pass, ` +
    `p95 ${formatDuration(s.p95_duration_ms ?? null)}, ` +
    `retry-adjusted ${formatDuration(s.retry_adjusted_completion_ms ?? null)}`;
}

// Build a per-role recommendation table. For each role observed:
//   - winner: the (role, host) with the best score, given MIN_DISPATCHES
//   - alternates: other (role, host) pairs with enough data
//   - reason: why the winner wins (or null when no recommendation)
function buildRecommendations(summaries, currentRouting, opts) {
  const byRole = new Map();
  for (const s of summaries) {
    if (!byRole.has(s.role)) byRole.set(s.role, []);
    byRole.get(s.role).push(s);
  }

  const recs = [];
  for (const [role, perRole] of byRole) {
    const eligible = perRole.filter((s) => s.total_dispatches >= opts.minDispatches);
    if (eligible.length === 0) {
      recs.push({
        role,
        current_host: currentRouting.roles?.[role] || currentRouting.default_host || null,
        suggested_host: null,
        reason: `insufficient data — no host has ≥${opts.minDispatches} dispatches for role "${role}"`,
        alternates: perRole.map((s) => ({ host: s.host, dispatches: s.total_dispatches })),
      });
      continue;
    }
    const ranked = [...eligible].sort((a, b) => compareScores(scoreFor(b), scoreFor(a)));
    const winner = ranked[0];
    const current = currentRouting.roles?.[role] || currentRouting.default_host || null;
    const incumbent = ranked.find((s) => s.host === current);

    // No change recommended if the winner is already the current host.
    if (winner.host === current) {
      recs.push({
        role,
        current_host: current,
        suggested_host: current,
        reason: `current host "${current}" is already the best performer at this role (${winner.pass_rate_first_try.toFixed(0)}% first-try)`,
        alternates: ranked.slice(1).map((s) => ({
          host: s.host,
          pass_rate_first_try: s.pass_rate_first_try,
          cost_per_pass_usd: s.cost_per_pass_usd,
          p95_duration_ms: s.p95_duration_ms ?? null,
          retry_adjusted_completion_ms: s.retry_adjusted_completion_ms ?? null,
        })),
      });
      continue;
    }

    // Apply the pass-rate delta threshold. If the winner doesn't beat the
    // incumbent by enough, don't recommend the change.
    if (incumbent) {
      const delta = winner.pass_rate_first_try - incumbent.pass_rate_first_try;
      if (delta < opts.minDelta) {
        recs.push({
          role,
          current_host: current,
          suggested_host: null,
          reason: `no clear winner — best (${winner.host}) only ${delta.toFixed(0)}pp better than current (${current}); requires ≥${opts.minDelta}pp delta`,
          alternates: ranked.map((s) => ({
            host: s.host,
            pass_rate_first_try: s.pass_rate_first_try,
            cost_per_pass_usd: s.cost_per_pass_usd,
            p95_duration_ms: s.p95_duration_ms ?? null,
            retry_adjusted_completion_ms: s.retry_adjusted_completion_ms ?? null,
          })),
        });
        continue;
      }
    }

    // Recommend the swap.
    const incumbentDesc = incumbent
      ? `vs incumbent ${current} at ${metricsText(incumbent)}`
      : `(current host "${current}" had no recorded dispatches; first-time recommendation)`;
    recs.push({
      role,
      current_host: current,
      suggested_host: winner.host,
      reason: `${winner.host} has ${metricsText(winner)}, ${incumbentDesc}`,
      data: {
        winner: routingMetrics(winner),
        incumbent: incumbent ? routingMetrics(incumbent) : null,
      },
      alternates: ranked.slice(2).map((s) => ({
        host: s.host,
        pass_rate_first_try: s.pass_rate_first_try,
        cost_per_pass_usd: s.cost_per_pass_usd,
        p95_duration_ms: s.p95_duration_ms ?? null,
        retry_adjusted_completion_ms: s.retry_adjusted_completion_ms ?? null,
      })),
    });
  }

  return recs;
}

function loadCurrentConfig(cwd) {
  const cfgPath = path.join(cwd, ".devteam", "config.yml");
  if (!fs.existsSync(cfgPath)) return { path: cfgPath, routing: {}, raw: "" };
  const raw = fs.readFileSync(cfgPath, "utf8");
  const parsed = yaml.load(raw) || {};
  return { path: cfgPath, routing: parsed.routing || {}, raw, full: parsed };
}

function renderRecommendations(recs) {
  const out = [];
  out.push("# devteam routing suggest");
  out.push("");
  out.push(`Generated: ${new Date().toISOString()}`);
  out.push("");

  const actionable = recs.filter((r) => r.suggested_host && r.suggested_host !== r.current_host);
  const stable = recs.filter((r) => r.suggested_host === r.current_host);
  const insufficient = recs.filter((r) => r.suggested_host === null);

  if (actionable.length === 0) {
    out.push(`## No changes recommended`);
    out.push("");
    if (stable.length > 0) out.push(`${stable.length} role(s) already routed to their best-performing host.`);
    if (insufficient.length > 0) out.push(`${insufficient.length} role(s) have insufficient data.`);
    out.push("");
  } else {
    out.push(`## Suggested changes (${actionable.length})`);
    out.push("");
    for (const r of actionable) {
      out.push(`### ${r.role}: ${r.current_host || "(unset)"} → **${r.suggested_host}**`);
      out.push("");
      out.push(`Rationale: ${r.reason}`);
      out.push("");
      if (r.alternates.length > 0) {
        out.push(`Other alternates with sufficient data:`);
        for (const alt of r.alternates) {
          out.push(`- ${alt.host}: ${alt.pass_rate_first_try.toFixed(0)}% first-try, ${formatUsd(alt.cost_per_pass_usd)} per pass, p95 ${formatDuration(alt.p95_duration_ms ?? null)}, retry-adjusted ${formatDuration(alt.retry_adjusted_completion_ms ?? null)}`);
        }
        out.push("");
      }
    }

    out.push(`## YAML patch for .devteam/config.yml`);
    out.push("");
    out.push("```yaml");
    out.push("routing:");
    out.push("  roles:");
    for (const r of actionable) {
      out.push(`    ${r.role}: ${r.suggested_host}    # was: ${r.current_host || "(unset)"}`);
    }
    out.push("```");
    out.push("");
    out.push(`Apply with: \`npm run routing:suggest -- --apply\` (will prompt before writing).`);
    out.push("");
  }

  if (stable.length > 0) {
    out.push(`## Already optimal (${stable.length})`);
    out.push("");
    for (const r of stable) {
      out.push(`- **${r.role}** → ${r.current_host}: ${r.reason}`);
    }
    out.push("");
  }

  if (insufficient.length > 0) {
    out.push(`## Insufficient data (${insufficient.length})`);
    out.push("");
    for (const r of insufficient) {
      out.push(`- **${r.role}**: ${r.reason}`);
    }
    out.push("");
  }

  return out.join("\n");
}

function applyChanges(cwd, recs, yes) {
  const cfg = loadCurrentConfig(cwd);
  const actionable = recs.filter((r) => r.suggested_host && r.suggested_host !== r.current_host);
  if (actionable.length === 0) {
    process.stdout.write("No changes to apply.\n");
    return 0;
  }

  process.stdout.write(`About to update ${cfg.path}:\n`);
  for (const r of actionable) {
    process.stdout.write(`  routing.roles.${r.role}: ${r.current_host || "(unset)"} → ${r.suggested_host}\n`);
  }
  if (!yes) {
    process.stdout.write(`\nProceed? (y/N) `);
    // Simple synchronous read — only used when --apply without --yes.
    const buf = Buffer.alloc(8);
    let n = 0;
    try { n = fs.readSync(0, buf, 0, 8, null); } catch { /* no stdin */ }
    const answer = (buf.toString("utf8", 0, n) || "").trim().toLowerCase();
    if (answer !== "y" && answer !== "yes") {
      process.stdout.write("Aborted.\n");
      return 1;
    }
  }

  // Merge into the config object and write it back. We preserve all
  // fields outside of routing.roles by editing the parsed config.
  const next = cfg.full ? { ...cfg.full } : {};
  next.routing = next.routing ? { ...next.routing } : {};
  next.routing.roles = next.routing.roles ? { ...next.routing.roles } : {};
  for (const r of actionable) {
    next.routing.roles[r.role] = r.suggested_host;
  }
  const newYaml = yaml.dump(next, { lineWidth: 100 });
  fs.writeFileSync(cfg.path, newYaml, "utf8");
  process.stdout.write(`\nUpdated ${cfg.path} (${actionable.length} role(s) rerouted).\n`);
  return 0;
}

// Filter gates by intent (ADR-009 §Decision.7 — advisory only).
// When --intent is set, restrict routing analysis to gates from runs with
// that intent, so repair-vs-feature routing differences can be compared.
// Gates without an intent field are excluded when a filter is active.
function filterByIntent(gates, intent) {
  if (!intent) return gates;
  return gates.filter((g) => g.intent === intent);
}

// Phase-28 item 28.5: .devteam/corpus/dispatches.jsonl is a durable,
// per-project dispatch history — every headless dispatch, not just the
// ones whose gate files are still on disk (gates get archived/pruned;
// the corpus doesn't). corpusRecordsToWorkstreams() shapes each record
// to match the per-workstream objects expandToWorkstreams() already
// understands, so it drops straight into the same aggregation as gate
// archives. Corpus records don't carry an `intent` field (out of scope
// for 28.5), so they're naturally excluded by filterByIntent when
// --intent is set — they only contribute to intent-unfiltered runs.
function loadCorpusFrom(root) {
  return corpusRecordsToWorkstreams(readCorpus(root));
}

function usage() {
  console.log(`routing-suggest — D5 adaptive routing recommendations

Usage:
  node scripts/routing-suggest.js                       Print suggestions only.
  node scripts/routing-suggest.js --from p1,p2,...      Read from multiple projects.
  node scripts/routing-suggest.js --since YYYY-MM-DD    Time-window filter.
  node scripts/routing-suggest.js --intent repair|feature  Filter to one intent (ADR-009 advisory).
  node scripts/routing-suggest.js --json                JSON output.
  node scripts/routing-suggest.js --apply               Rewrite .devteam/config.yml after prompt.
  node scripts/routing-suggest.js --apply --yes         Apply without prompting.
  node scripts/routing-suggest.js --min-dispatches N    Min dispatches required (default ${MIN_DISPATCHES}).
  node scripts/routing-suggest.js --min-delta N         Min pass-rate delta in pp (default ${MIN_PASS_RATE_DELTA}).

How it works:
  - Reads pipeline/gates/ AND .devteam/corpus/dispatches.jsonl (phase-28
    item 28.5) from each --from project (default: cwd) — the corpus
    covers dispatches whose gate files have since been archived/pruned.
  - Aggregates per-(role, host) pass-rate-first-try, cost-per-pass,
    p50/p95 duration, and retry-adjusted completion time.
  - For each role: if a different host has ≥ --min-dispatches AND beats
    the current host by ≥ --min-delta percentage points, suggest the swap.
  - Output: a YAML diff (default) or JSON. --apply rewrites the config
    file in place after confirmation. Latency is evidence and tie-breaker
    only; routing never trades away first-try quality outside this policy.

Intent filtering (ADR-009 §Decision.7 — advisory only):
  --intent repair limits analysis to gates from repair-mode runs.
  --intent feature limits to feature runs. Gates without an intent field
  are excluded when a filter is active (this includes all corpus-sourced
  records — the corpus schema doesn't carry intent). Compare the two
  outputs to spot whether routing preferences differ by intent.

This is the D5 BACKLOG item. Pairs with D6 (cost telemetry) + D4
(performance scores). Manual review is the default; --apply is the
opt-in for the brave.
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
    all.push(...loadCorpusFrom(src));
  }
  all = filterSince(all, args.since);
  all = filterByIntent(all, args.intent);
  for (const w of warnings) process.stderr.write(`[routing-suggest] ⚠️  ${w}\n`);
  if (args.intent) process.stderr.write(`[routing-suggest] intent filter: ${args.intent}\n`);

  const summaries = [...aggregatePerformance(all).values()].map(summarize);
  const cfg = loadCurrentConfig(args.cwd);
  const recs = buildRecommendations(summaries, cfg.routing, {
    minDispatches: args.minDispatches,
    minDelta: args.minDelta,
  });

  if (args.apply) {
    return process.exit(applyChanges(args.cwd, recs, args.yes));
  }

  if (args.json) {
    console.log(JSON.stringify({
      generated_at: new Date().toISOString(),
      sources: args.from,
      since: args.since,
      min_dispatches: args.minDispatches,
      min_delta: args.minDelta,
      current_routing: cfg.routing,
      recommendations: recs,
    }, null, 2));
  } else {
    console.log(renderRecommendations(recs));
  }
}

if (require.main === module) main();

module.exports = {
  buildRecommendations,
  renderRecommendations,
  scoreFor,
  compareScores,
  loadCurrentConfig,
  filterByIntent,
  loadCorpusFrom,
  MIN_DISPATCHES,
  MIN_PASS_RATE_DELTA,
};
