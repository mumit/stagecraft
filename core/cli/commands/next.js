"use strict";

const path = require("node:path");
const { generateHelp } = require(path.join(__dirname, "..", "flags"));
const { getOrchestrator } = require(path.join(__dirname, "..", "get-orchestrator"));
const _escalation = require(path.join(__dirname, "..", "..", "escalation"));
const loadPrincipalRulings = _escalation.loadPrincipalRulingLines;
const loadPrincipalOutputs = _escalation.loadPrincipalOutputs;

function normalizedText(value) {
  return String(value || "").toLowerCase().replace(/\s+/g, " ").trim();
}

function gateEscalationHints(gate) {
  const hints = [];
  for (const value of [
    gate?.stage,
    gate?.workstream,
    gate?.escalation_reason,
    gate?.decision_needed,
    ...(Array.isArray(gate?.blockers) ? gate.blockers : []),
  ]) {
    const text = normalizedText(value);
    if (text.length >= 12) hints.push(text);
  }
  return hints;
}

const WEAK_ESCALATION_TOKENS = new Set([
  "stage", "status", "gate", "gates", "pipeline", "context", "before",
  "after", "needs", "need", "decide", "whether", "must", "added", "add",
  "this", "that", "with", "from", "have", "has",
]);

function meaningfulTokens(values) {
  const tokens = new Set();
  for (const value of values) {
    for (const token of normalizedText(value).match(/[a-z0-9][a-z0-9-]{2,}/g) || []) {
      if (token.length < 4) continue;
      if (WEAK_ESCALATION_TOKENS.has(token)) continue;
      tokens.add(token);
    }
  }
  return tokens;
}

function principalOutputText(output) {
  if (!output) return "";
  if (output.type === "cannot-decide") {
    return `${output.reason_class || ""} ${output.question || ""}`;
  }
  if (output.type === "ruling") {
    return `${output.topic || ""} ${output.decision || ""} ${output.class || ""}`;
  }
  return String(output);
}

function currentEscalationOutputs(cwd, result, outputs) {
  if (!result || !result.gate || !Array.isArray(outputs) || outputs.length === 0) return [];
  let gate = null;
  try {
    const fs = require("node:fs");
    gate = JSON.parse(fs.readFileSync(path.resolve(cwd, result.gate), "utf8"));
  } catch {
    return [];
  }
  const stageHints = [result.name, result.stage, gate.stage]
    .map(normalizedText)
    .filter((text) => text.length >= 4);
  const contentHints = gateEscalationHints(gate).filter((text) => !stageHints.includes(text));
  const contentTokens = meaningfulTokens(contentHints);
  return outputs.filter((output) => {
    const text = normalizedText(principalOutputText(output));
    if (!text) return false;
    if (stageHints.some((hint) => text.includes(hint))) return true;
    if (contentHints.some((hint) => text.includes(hint) || hint.includes(text))) {
      return true;
    }
    let overlap = 0;
    for (const token of meaningfulTokens([text])) {
      if (contentTokens.has(token)) overlap += 1;
      if (overlap >= 2) return true;
    }
    return false;
  });
}

// Version of the `devteam next --json` action-object schema. Additive changes
// (new optional fields like failure_class) keep the major version; bump on any
// breaking change a programmatic consumer must handle.
// 1.1: added "fold-sign-off" action (item 1.2, phase-1-trust-consolidation).
// 1.2: added "record-local-deploy" action for Stage 7 deploy_requested:false.
const NEXT_SCHEMA_VERSION = "1.2";

const name = "next";

const flags = {
  cwd:           { type: "string",  description: "Target project directory" },
  feature:       { type: "string",  description: "Feature name (bounded isolation mode)" },
  track:         { type: "string",  description: "Override the pipeline track (default: read from run-state.json, then config)" },
  json:          { type: "boolean", description: "JSON output" },
  "skip-advise": { type: "boolean", description: "Suppress unresolved follow-up advisory warning" },
  help:          { type: "boolean", description: "Show this help" },
};

function run(positional, _flags) {
  if (_flags.help) { console.log(generateHelp("devteam next [options]", flags)); process.exit(0); }
  const { next } = getOrchestrator();
  const cwd = _flags.cwd || process.cwd();
  const { loadConfig, checkBoundedFence } = require(path.join(__dirname, "..", "..", "config"));
  const config = loadConfig(cwd);
  checkBoundedFence(config, "next");
  const { resolveChangeId } = require(path.join(__dirname, "..", "resolve-change-id"));
  const changeId = resolveChangeId(_flags, config);
  const { pipelineRoot } = require(path.join(__dirname, "..", "..", "paths"));
  const fs = require("node:fs");

  // Resolve the active track: explicit --track flag > persisted run-state.json > config/orchestrator default.
  // run-state.json is written by `devteam run` at start-of-run and is the shared source of truth
  // for which track is in progress. Without this, `devteam next` always falls back to the full
  // track, misreporting stages that don't exist on lighter tracks (e.g. quick, nano).
  let resolvedTrack = _flags.track || null;
  if (!resolvedTrack) {
    try {
      const rsPath = path.join(pipelineRoot(cwd, changeId), "run-state.json");
      if (fs.existsSync(rsPath)) {
        const rs = JSON.parse(fs.readFileSync(rsPath, "utf8"));
        if (rs.track && typeof rs.track === "string") resolvedTrack = rs.track;
      }
    } catch { /* non-fatal — fall through to orchestrator default */ }
  }

  // Advisory check — non-blocking; warn when unresolved BLOCKER-risk follow-up items exist
  if (!_flags.json && !_flags.skipAdvise) {
    try {
      const { runAdvise } = require(path.join(__dirname, "..", "..", "advise"));
      const { items } = runAdvise(cwd, { checkOnly: true });
      const pending = items.filter(
        (r) => !r.addressed && (r.classification === "QA_BLOCKER" || r.classification === "PEER_REVIEW_RISK" || r.classification === "A11Y_FIX")
      );
      if (pending.length > 0) {
        process.stderr.write(
          `⚠  ${pending.length} unresolved follow-up item(s) may block downstream stages` +
          ` — run \`devteam advise\` for options\n`
        );
      }
    } catch {
      // Advisory check failure must never break `devteam next`
    }
  }

  let result = next({ cwd, changeId, track: resolvedTrack || undefined });

  // fold-sign-off: orchestrator detected a clean AC→test mapping; write the
  // gate here (caller's responsibility) then re-run next() so the user sees
  // the real next step in one command. (item 1.2, phase-1-trust-consolidation)
  if (result.action === "fold-sign-off") {
    const fs = require("node:fs");
    fs.mkdirSync(require("node:path").dirname(result.gate_path), { recursive: true });
    fs.writeFileSync(result.gate_path, JSON.stringify(result.gate_content, null, 2) + "\n", "utf8");
    if (!_flags.json) {
      process.stderr.write(
        `[devteam] stage 7 auto-folded: stage 6 satisfied the AC→test contract (${result.acCount} criteria mapped)\n`,
      );
    }
    if (_flags.json) {
      console.log(JSON.stringify({ schema_version: NEXT_SCHEMA_VERSION, ...result }, null, 2));
      return;
    }
    // Re-run next() so the user sees what comes after sign-off in one command.
    result = next({ cwd, changeId });
  }

  if (result.action === "record-local-deploy") {
    const fs = require("node:fs");
    const path = require("node:path");
    fs.mkdirSync(path.dirname(result.deploy_log_path), { recursive: true });
    fs.writeFileSync(result.deploy_log_path, result.deploy_log_content, "utf8");
    fs.mkdirSync(path.dirname(result.gate_path), { recursive: true });
    fs.writeFileSync(result.gate_path, JSON.stringify(result.gate_content, null, 2) + "\n", "utf8");
    if (!_flags.json) {
      process.stderr.write("[devteam] stage 8 recorded: stage 7 requested no external deploy; wrote local deploy gate\n");
    }
    if (_flags.json) {
      console.log(JSON.stringify({ schema_version: NEXT_SCHEMA_VERSION, ...result }, null, 2));
      return;
    }
    result = next({ cwd, changeId });
  }

  if (_flags.json) {
    // schema_version lets a programmatic caller (e.g. an autonomous driver)
    // validate the action shape it parses. Bump on any breaking change to the
    // action object: new required field, renamed/removed field, or a new
    // action value a consumer must handle. failure_class was additive (1.0);
    // fold-sign-off action added in 1.1; record-local-deploy in 1.2.
    console.log(JSON.stringify({ schema_version: NEXT_SCHEMA_VERSION, ...result }, null, 2));
    return;
  }
  const icon = {
    "run-stage": "▶️",
    "continue-stage": "⏳",
    "merge": "🔀",
    "fix-and-retry": "❌",
    "resolve-escalation": "🚨",
    "pipeline-complete": "🎉",
  }[result.action] || "•";
  const fcTag = result.failure_class ? `  [${result.failure_class}]` : "";
  console.log(`${icon} ${result.action}${result.name ? ` — ${result.name} (${result.stage})` : ""}${fcTag}`);
  console.log(`   ${result.reason}`);
  if (result.completed) console.log(`   completed: ${result.completed.join(", ")}`);
  if (result.remaining) console.log(`   remaining: ${result.remaining.join(", ")}`);
  if (result.blockers && result.blockers.length) {
    console.log(`   blockers:`);
    for (const b of result.blockers) console.log(`     - ${typeof b === "object" ? (b.message || JSON.stringify(b)) : b}`);
  }
  if (result.fix_steps && result.fix_steps.length) {
    console.log(`\n   Fix steps:`);
    result.fix_steps.forEach((step, i) => {
      console.log(`   ${i + 1}. ${step.description}`);
      for (const cmd of step.commands) console.log(`        $ ${cmd}`);
    });
    console.log();
  } else if (result.command && result.action !== "resolve-escalation") {
    // resolve-escalation always has a result.command ("devteam ruling ...") but
    // the Escalation resolution block below gives the correct next step based on
    // the actual current state (ruling written vs. not). Printing both produces
    // contradictory instructions when a ruling already exists.
    console.log(`   → ${result.command}`);
  }
  // G3: if the pipeline just completed and the operator hasn't created the
  // production-feedback file yet, mention it once as an optional follow-up.
  if (result.action === "pipeline-complete") {
    const fs = require("node:fs");
    const { pipelineRoot } = require(path.join(__dirname, "..", "..", "paths"));
    const feedbackFile = require("node:path").join(pipelineRoot(cwd, changeId), "production-feedback.md");
    if (!fs.existsSync(feedbackFile)) {
      console.log(`   Tip: copy .devteam/templates/production-feedback-template.md → pipeline/production-feedback.md after deploy to close the brief→production SLO loop (optional).`);
    }
  }
  if (result.action === "resolve-escalation") {
    const _cwd = _flags.cwd || process.cwd();
    const _rulings = loadPrincipalRulings(_cwd);
    const _outputs = loadPrincipalOutputs(_cwd);
    const _currentOutputs = currentEscalationOutputs(_cwd, result, _outputs);
    const _latestCurrent = _currentOutputs[_currentOutputs.length - 1];
    const _currentRulings = _currentOutputs.filter((output) => output.type === "ruling");
    console.log(`\n   Escalation resolution:`);
    if (_latestCurrent?.type === "cannot-decide") {
      // The Principal declined to rule — a human must answer. Surface the typed
      // question so the operator knows exactly what (and why) is needed.
      const cd = _latestCurrent;
      console.log(`   ⚖  Principal cannot decide (${cd.reason_class}) — a human decision is required:`);
      console.log(`      ${cd.question}`);
      console.log(`   After deciding, encode it as a PRINCIPAL-RULING line in pipeline/context.md, then:`);
      console.log(`        devteam fix-escalation [--headless]`);
    } else if (_latestCurrent?.type === "ruling") {
      console.log(`   Principal ruling is written (${_currentRulings.length} current ruling(s), ${_rulings.length} total in pipeline/context.md).`);
      console.log(`   → devteam fix-escalation --headless`);
    } else if (_rulings.length > 0 || _outputs.length > 0) {
      if (_rulings.length > 0) {
        console.log(`   Existing Principal ruling(s) found (${_rulings.length}), but none appears to match this ${result.name || result.stage} escalation.`);
      } else {
        console.log(`   Existing Principal output(s) found (${_outputs.length}), but none appears to match this ${result.name || result.stage} escalation.`);
      }
      console.log(`   1. Read the gate: cat ${result.gate}`);
      console.log(`      Check escalation_reason and decision_needed.`);
      console.log(`   2. Get a Principal ruling for this escalation:`);
      console.log(`        devteam ruling --target-gate ${result.gate} [--headless]`);
      console.log(`   3. Apply the ruling:`);
      console.log(`        devteam fix-escalation [--headless]`);
    } else {
      console.log(`   1. Read the gate: cat ${result.gate}`);
      console.log(`      Check escalation_reason and decision_needed.`);
      console.log(`   2. Get a Principal ruling (topic is auto-derived from gate):`);
      console.log(`        devteam ruling --target-gate ${result.gate} [--headless]`);
      console.log(`   3. Apply the ruling (implements gates/stages automatically):`);
      console.log(`        devteam fix-escalation [--headless]`);
    }
  }
}

module.exports = { name, flags, run };
