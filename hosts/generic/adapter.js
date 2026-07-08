// Generic host adapter — no in-host integration.
//
// Renders the stage prompt as plain text the user can paste into any AI
// coding tool, or follow manually. Proves the host-adapter contract is
// genuinely host-neutral; the orchestrator drives it like any other host.

const fs = require("node:fs");
const path = require("node:path");

const capabilities = require("./capabilities.json");

function install() {
  return { written: [], skipped: [], warnings: ["generic adapter installs nothing"] };
}

function uninstall() {
  return;
}

function status() {
  return { ok: true, missing: [], stale: [], notes: ["generic adapter — nothing to verify"] };
}

function renderStagePrompt(descriptor, ctx) {
  const roleBriefPath = path.join(__dirname, "..", "..", "roles", `${descriptor.role}.md`);
  const briefSnippet = fs.existsSync(roleBriefPath)
    ? fs.readFileSync(roleBriefPath, "utf8")
    : `(role brief missing at ${roleBriefPath})`;

  const lines = [];
  lines.push(`# Stage: ${descriptor.stage} — ${descriptor.name}`);
  lines.push(`Role: ${descriptor.role}`);
  lines.push(`Workstream: ${descriptor.workstreamId}`);
  lines.push(`Track: ${ctx.track}`);
  if (ctx.feature) lines.push(`Feature: ${ctx.feature}`);
  const { renderPatchBlock, renderContextManifest, renderKnownPatterns, toolBudgetSection } = require("../../core/adapters/render-helpers");
  renderPatchBlock(ctx, lines);
  lines.push("");
  lines.push(`## Objective`);
  lines.push(descriptor.objective);
  lines.push("");
  lines.push(`## Read first`);
  for (const f of descriptor.readFirst) lines.push(`- ${f}`);
  lines.push("");
  renderContextManifest(lines, descriptor);
  renderKnownPatterns(lines, descriptor);
  lines.push(`## Allowed writes (advisory — host: generic enforces this in prompt only)`);
  for (const f of descriptor.allowedWrites) lines.push(`- ${f}`);
  lines.push("");
  const budgetSection = toolBudgetSection(descriptor.toolBudget, capabilities.enforces.tool_budget);
  if (budgetSection) { lines.push(budgetSection); lines.push(""); }
  lines.push(`## Artifact to produce`);
  lines.push(`- ${descriptor.artifact} (from template: ${descriptor.template})`);
  lines.push("");
  lines.push(`## Gate to write at pipeline/gates/${descriptor.workstreamId}.json`);
  lines.push("Required base fields (you write these):");
  lines.push("```json");
  lines.push(JSON.stringify({
    stage: descriptor.stage,
    workstream: descriptor.role,
    status: "PASS",
    track: ctx.track,
    timestamp: "<ISO-8601>",
    blockers: [],
    warnings: [],
    ...descriptor.expectedGate,
  }, null, 2));
  lines.push("```");
  lines.push(`Orchestrator fills "orchestrator": "${ctx.orchestrator}" and "host": "generic" at validation time.`);
  lines.push("");
  lines.push(`---`);
  lines.push(`## Role brief (roles/${descriptor.role}.md)`);
  lines.push("");
  lines.push(briefSnippet);
  return lines.join("\n");
}

module.exports = {
  capabilities,
  install,
  uninstall,
  status,
  renderStagePrompt,
};
