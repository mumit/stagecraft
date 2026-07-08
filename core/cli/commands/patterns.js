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
  reason: { type: "string", description: "Retirement reason" },
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

function renderPromoted(pattern) {
  const stats = pattern.stats || {};
  return [
    `${pattern.id}  [${pattern.tier} · ${pattern.domain}]`,
    `  injected=${stats.injected || 0} recurrence_after_injection=${stats.recurrence_after_injection || 0} noise=${stats.noise_reports || 0}`,
    `  prompt: ${pattern.prompt_text}`,
  ].join("\n");
}

function run(positional, commandFlags) {
  if (commandFlags.help) {
    console.log(generateHelp("devteam patterns <collect|list|review|promote|retire|stats> [options]", flags));
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
        console.log(renderPromoted(pattern));
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

  if (sub === "stats") {
    const result = patterns.stats({ cwd });
    if (commandFlags.json) { console.log(JSON.stringify(result, null, 2)); return; }
    console.log(`Observations: ${result.observations}`);
    console.log(`Candidates:    ${result.candidates}`);
    console.log(`Promoted:      ${result.promoted}`);
    console.log(`Retired:       ${result.retired}`);
    console.log(`Injected:      ${result.injected}`);
    console.log(`Recurrences:   ${result.recurrence_after_injection}`);
    console.log(`Noise reports: ${result.noise_reports}`);
    return;
  }

  console.error(`Unknown patterns subcommand: ${sub || "(none)"}`);
  console.error("Usage: devteam patterns <collect|list|review|promote|retire|stats>");
  process.exit(2);
}

module.exports = { name, flags, run };
