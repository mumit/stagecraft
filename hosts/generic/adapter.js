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

// Phase 32.1 (cache-first prompt assembly): renders the stage prompt as
// four ordered layers — (1) framework preamble/rules, (2) role brief
// (inlined verbatim — generic has no native subagent/read_file mechanism
// to fetch it separately), (3) learned context, (4) volatile tail — and
// reports the line-index boundaries between them. Layers 1-2 are
// byte-identical across every dispatch in a run using the same role.
// renderStagePrompt() below is a thin wrapper that returns the full
// joined string.
function renderStagePromptLayers(descriptor, ctx) {
  const roleBriefPath = path.join(__dirname, "..", "..", "roles", `${descriptor.role}.md`);
  const briefSnippet = fs.existsSync(roleBriefPath)
    ? fs.readFileSync(roleBriefPath, "utf8")
    : `(role brief missing at ${roleBriefPath})`;

  const { renderPatchBlock, renderContextDelta, renderContextManifest, renderFrameworkPreamble, renderKnownPatterns, renderPriorKnowledge, renderScopeLine, splitReadFirst, toolBudgetSection } = require("../../core/adapters/render-helpers");
  const lines = [];

  // --- Layer 1: framework preamble/rules (constant per version) ---
  renderFrameworkPreamble(lines, descriptor);
  const layer1End = lines.length;

  // --- Layer 2: role brief (constant per role) ---
  lines.push(`## Role brief (roles/${descriptor.role}.md)`);
  lines.push("");
  lines.push(briefSnippet);
  lines.push("");
  const layer2End = lines.length;

  // --- Layer 3: learned context (constant per run) ---
  renderKnownPatterns(lines, descriptor);
  renderPriorKnowledge(lines, descriptor);
  const layer3End = lines.length;

  // --- Layer 4: volatile tail (changes per dispatch) ---
  lines.push(`# Stage: ${descriptor.stage} — ${descriptor.name}`);
  lines.push(`Role: ${descriptor.role}`);
  lines.push(`Workstream: ${descriptor.workstreamId}`);
  lines.push(`Track: ${ctx.track}`);
  if (ctx.feature) lines.push(`Feature: ${ctx.feature}`);
  renderScopeLine(ctx, lines);
  renderPatchBlock(ctx, lines);
  lines.push("");
  lines.push(`## Objective`);
  lines.push(descriptor.objective);
  lines.push("");
  lines.push(`## Read first`);
  const { rest } = splitReadFirst(descriptor.readFirst);
  for (const f of rest) lines.push(`- ${f}`);
  lines.push("");
  renderContextManifest(lines, descriptor);
  renderContextDelta(lines, descriptor);
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
  const gateSkeleton = {
    stage: descriptor.stage,
    workstream: descriptor.role,
    status: "PASS",
    track: ctx.track,
    timestamp: "<ISO-8601>",
    blockers: [],
    warnings: [],
    ...descriptor.expectedGate,
  };
  // Phase-35 item 35.1: see render-helpers.js#appendGateFooter's why-comment.
  if (ctx.scope) gateSkeleton.scope = ctx.scope;
  lines.push(JSON.stringify(gateSkeleton, null, 2));
  lines.push("```");
  lines.push(`Orchestrator fills "orchestrator": "${ctx.orchestrator}" and "host": "generic" at validation time.`);

  return {
    lines,
    layers: [
      lines.slice(0, layer1End).join("\n"),
      lines.slice(layer1End, layer2End).join("\n"),
      lines.slice(layer2End, layer3End).join("\n"),
      lines.slice(layer3End).join("\n"),
    ],
  };
}

function renderStagePrompt(descriptor, ctx) {
  return renderStagePromptLayers(descriptor, ctx).lines.join("\n");
}

module.exports = {
  capabilities,
  install,
  uninstall,
  status,
  renderStagePrompt,
  renderStagePromptLayers,
};
