"use strict";

const path = require("node:path");
const { generateHelp } = require(path.join(__dirname, "..", "flags"));
const { loadConfig, checkBoundedFence } = require(path.join(__dirname, "..", "..", "config"));
const { resolveChangeId } = require(path.join(__dirname, "..", "resolve-change-id"));
const { pipelineRoot } = require(path.join(__dirname, "..", "..", "paths"));
const patterns = require(path.join(__dirname, "..", "..", "patterns"));

const name = "patterns";
const flags = {
  cwd: { type: "string", description: "Target project directory" },
  feature: { type: "string", description: "Feature name for bounded isolation" },
  json: { type: "boolean", description: "Emit JSON output" },
  text: { type: "string", description: "Prompt text for promote" },
  reason: { type: "string", description: "Retirement or demotion reason" },
  operator: { type: "string", description: "Override the recorded demote operator (default: OS user)" },
  help: { type: "boolean", description: "Show this help" },
};

function localContext(commandFlags) {
  const cwd = path.resolve(commandFlags.cwd || process.cwd());
  const config = loadConfig(cwd);
  checkBoundedFence(config, name);
  const changeId = resolveChangeId(commandFlags, config);
  return { cwd, pipelineRoot: pipelineRoot(cwd, changeId) };
}

function renderCandidate(candidate) {
  const bits = [
    candidate.tier,
    candidate.domain,
    `${candidate.observations} observation(s)`,
  ];
  if (candidate.resolved_by_retry) bits.push(`${candidate.resolved_by_retry} retry-resolved`);
  const scopes = [
    candidate.stages?.length ? `stages=${candidate.stages.join(",")}` : null,
    candidate.workstreams?.length ? `workstreams=${candidate.workstreams.join(",")}` : null,
    candidate.languages?.length ? `languages=${candidate.languages.join(",")}` : null,
  ].filter(Boolean).join(" ");
  return [
    `${candidate.id}  [${bits.join(" · ")}]`,
    scopes ? `  ${scopes}` : null,
    `  prompt: ${candidate.proposed_prompt_text}`,
  ].filter(Boolean).join("\n");
}

function renderPromoted(pattern, threshold) {
  const stats = pattern.stats || {};
  const recurrence = stats.recurrence_after_injection || 0;
  const lines = [
    `${pattern.id}  [${pattern.tier} · ${pattern.domain}]`,
    `  injected=${stats.injected || 0} recurrence_after_injection=${recurrence} noise=${stats.noise_reports || 0}`,
    `  prompt: ${pattern.prompt_text}`,
  ];
  // 30.2(c): flag — never auto-demote. `devteam patterns demote <id>` is the
  // only thing that moves a pattern back to candidate.
  if (recurrence >= threshold) {
    lines.push(`  ⚠ demotion candidate: recurrence_after_injection=${recurrence} ≥ ${threshold} — review with \`devteam patterns demote ${pattern.id}\``);
  }
  return lines.join("\n");
}

function renderDemoted(pattern) {
  const history = Array.isArray(pattern.demotion_history) ? pattern.demotion_history : [];
  const last = history[history.length - 1];
  const lines = [`${pattern.id}  [${pattern.tier} · ${pattern.domain}]`];
  if (last) {
    const counters = last.counters_at_demotion || {};
    lines.push(`  demoted by ${last.demoted_by} at ${last.demoted_at} — ${last.reason}`);
    lines.push(`  counters at demotion: injected=${counters.injected || 0} recurrence_after_injection=${counters.recurrence_after_injection || 0} noise=${counters.noise_reports || 0}`);
  }
  lines.push(`  prompt: ${pattern.prompt_text}`);
  return lines.join("\n");
}

function run(positional, commandFlags) {
  if (commandFlags.help) {
    console.log(generateHelp("devteam patterns <collect|list|review|promote|retire|demote|stats> [options]", flags));
    process.exit(0);
  }
  const sub = positional[0];
  const { cwd, pipelineRoot: root } = localContext(commandFlags);

  if (sub === "collect") {
    const result = patterns.collect({ cwd, pipelineRoot: root });
    if (commandFlags.json) { console.log(JSON.stringify(result, null, 2)); return; }
    console.log(`Collected ${result.added} new pattern observation(s) (${result.total} total).`);
    console.log(`Candidates: ${result.candidates}`);
    console.log(`Store: ${path.relative(cwd, result.dir) || result.dir}`);
    return;
  }

  if (sub === "list" || sub === "review") {
    const state = patterns.list({ cwd });
    if (commandFlags.json) { console.log(JSON.stringify(state, null, 2)); return; }
    const threshold = loadConfig(cwd).patterns.demotion_recurrence_threshold;
    if (state.candidates.length === 0) {
      console.log("No pattern candidates yet. Run `devteam patterns collect` after a pipeline run.");
    } else {
      console.log("Pattern candidates:");
      for (const candidate of state.candidates) {
        console.log("");
        console.log(renderCandidate(candidate));
      }
    }
    if (state.promoted.length > 0) {
      console.log("");
      console.log("Promoted patterns:");
      for (const pattern of state.promoted) {
        console.log("");
        console.log(renderPromoted(pattern, threshold));
      }
    }
    if (state.demoted.length > 0) {
      console.log("");
      console.log("Demoted patterns (back to candidate — re-promote with `devteam patterns promote <id>`):");
      for (const pattern of state.demoted) {
        console.log("");
        console.log(renderDemoted(pattern));
      }
    }
    return;
  }

  if (sub === "promote") {
    const candidateId = positional[1];
    try {
      const record = patterns.promote({ cwd, candidateId, text: commandFlags.text });
      if (commandFlags.json) { console.log(JSON.stringify(record, null, 2)); return; }
      console.log(`Promoted ${record.id}.`);
      console.log(`Prompt: ${record.prompt_text}`);
    } catch (err) {
      console.error(`devteam patterns promote: ${err.message}`);
      process.exit(1);
    }
    return;
  }

  if (sub === "retire") {
    const patternId = positional[1];
    try {
      const record = patterns.retire({ cwd, patternId, reason: commandFlags.reason });
      if (commandFlags.json) { console.log(JSON.stringify(record, null, 2)); return; }
      console.log(`Retired ${record.id}.`);
    } catch (err) {
      console.error(`devteam patterns retire: ${err.message}`);
      process.exit(1);
    }
    return;
  }

  if (sub === "demote") {
    const patternId = positional[1];
    try {
      const record = patterns.demote({ cwd, patternId, operator: commandFlags.operator, reason: commandFlags.reason });
      if (commandFlags.json) { console.log(JSON.stringify(record, null, 2)); return; }
      const last = record.demotion_history[record.demotion_history.length - 1];
      console.log(`Demoted ${record.id} back to candidate.`);
      console.log(`  by: ${last.demoted_by}  at: ${last.demoted_at}  reason: ${last.reason}`);
      const counters = last.counters_at_demotion;
      console.log(`  counters at demotion: injected=${counters.injected || 0} recurrence_after_injection=${counters.recurrence_after_injection || 0} noise=${counters.noise_reports || 0}`);
    } catch (err) {
      console.error(`devteam patterns demote: ${err.message}`);
      process.exit(1);
    }
    return;
  }

  if (sub === "stats") {
    const result = patterns.stats({ cwd });
    if (commandFlags.json) { console.log(JSON.stringify(result, null, 2)); return; }
    console.log(`Observations: ${result.observations}`);
    console.log(`Candidates:    ${result.candidates}`);
    console.log(`Promoted:      ${result.promoted}`);
    console.log(`Retired:       ${result.retired}`);
    console.log(`Demoted:       ${result.demoted}`);
    console.log(`Injected:      ${result.injected}`);
    console.log(`Recurrences:   ${result.recurrence_after_injection}`);
    console.log(`Noise reports: ${result.noise_reports}`);
    return;
  }

  console.error(`Unknown patterns subcommand: ${sub || "(none)"}`);
  console.error("Usage: devteam patterns <collect|list|review|promote|retire|demote|stats>");
  process.exit(2);
}

module.exports = { name, flags, run };
