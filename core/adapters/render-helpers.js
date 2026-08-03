// Shared rendering helpers used by every host adapter's
// renderStagePrompt. Audit Tier-3: the gate-skeleton + cost telemetry
// + C4 reproducibility lines were copy-pasted across three adapters
// (claude-code, codex, gemini-cli) — ~30 lines of structurally
// identical text per adapter, ~90 lines of duplication total. This
// module is the single source.
//
// The contract: each adapter assembles its own header / objective /
// readFirst / allowedWrites lines (those vary per host because of
// enforcement-level wording), then calls appendGateFooter() to
// append the parts that are genuinely shared.
//
// Phase 1 item 1.5: renderPatchBlock(ctx) centralises the PATCH MODE
// rendering that was previously duplicated in claude-code and generic.
// All four adapters (claude-code, generic, codex, gemini-cli) call it.

// Render the PATCH MODE block into `lines` when ctx.patchItems is
// present and non-empty. Call this after the track/feature header lines
// and before the host-specific objective/readFirst body.
//
// Wording is canonical from the claude-code adapter (phase-1-trust-
// consolidation.md §1.5 designates it as the source of truth).
//
// Returns nothing; mutates `lines` in place (same contract as
// appendGateFooter). The caller pushes nothing if patchItems is absent
// — absence is the normal case and must not alter any other output.
function renderPatchBlock(ctx, lines) {
  if (!ctx.patchItems || ctx.patchItems.length === 0) return;
  lines.push("");
  lines.push("## ⚠️  PATCH MODE — targeted fix only");
  lines.push("");
  lines.push("This is a scoped re-run. Fix ONLY the items listed below.");
  lines.push("Do not regenerate, refactor, or touch any file not named in these items.");
  lines.push("Update test files only if an item explicitly requires it.");
  lines.push("");
  for (const item of ctx.patchItems) {
    if (typeof item === "string") {
      lines.push(`- ${item}`);
    } else {
      const id  = item.id       ? `**${item.id}**` : "";
      const sev = item.severity ? ` [${item.severity}]` : "";
      lines.push(`- ${id}${sev}: ${item.summary || JSON.stringify(item)}`);
    }
  }
}

// Caption for the "Allowed writes" section. The wording reflects
// how the host *actually* enforces the list at runtime — tool-call-
// time (hooks block writes) vs prompt-only (advisory; gate validator
// catches violations post-hoc) vs post-hoc-audit (similar). Each
// adapter declares its level in capabilities.enforces.allowed_writes;
// this helper just renders the right caption.
function allowedWritesCaption(enforcementLevel, hostDisplayName) {
  switch (enforcementLevel) {
    case "tool-call-time":
      return `## Allowed writes (enforced by ${hostDisplayName} hooks at tool-call time)`;
    case "post-hoc-audit":
      return `## Allowed writes (enforced post-hoc by the orchestrator write-audit: unauthorized writes flip the gate to FAIL)`;
    case "prompt-only":
    default:
      return `## Allowed writes (advisory — ${hostDisplayName} enforces this in prompt only; gate validator catches violations post-hoc)`;
  }
}

// G10: render the tool budget advisory section for prompt-only hosts.
// Returns null when no action is needed (no budget declared, or the host
// enforces natively — claude-code subagent tool pinning makes a prompt
// instruction redundant and potentially confusing).
//
// For prompt-only hosts, the section uses intent language (not just tool
// names) so a model unfamiliar with Claude Code tool names can still apply
// the spirit of the restriction. The declared tool names are included for
// audit legibility and as vocabulary hints.
function toolBudgetSection(toolBudget, enforcementLevel) {
  if (!toolBudget || toolBudget.length === 0) return null;
  if (enforcementLevel === "native") return null;

  const listed = toolBudget.join(", ");
  const restrictions = [];
  if (!toolBudget.includes("Bash")) restrictions.push("avoid shell execution");
  if (!toolBudget.some((t) => ["Write", "Edit"].includes(t))) {
    restrictions.push("do not write or edit files");
  } else if (!toolBudget.includes("Edit")) {
    restrictions.push("prefer Write over Edit for new content; do not patch existing files");
  }
  const restrictText = restrictions.length > 0 ? ` — ${restrictions.join("; ")}` : "";
  return [
    `## Tool surface (advisory — ${enforcementLevel} on this host)`,
    `Your role has a declared tool budget. Prefer: ${listed}${restrictText}.`,
    `(Declared budget: ${listed}. Native enforcement is only available on claude-code.)`,
  ].join("\n");
}

// Phase 32.1 (cache-first prompt assembly): split a descriptor's readFirst
// into the constant layer-1 "framework" prefix (core/pipeline/stages.js's
// FRAMEWORK_READ_FIRST — AGENTS.md + the two always-loaded rule files) and
// the stage-specific remainder (pipeline/*.md project artifacts, which grow
// and change over a run). Matches positionally so a descriptor whose
// readFirst doesn't start with the framework set (e.g. a test fixture)
// degrades gracefully to an empty framework split rather than throwing.
function splitReadFirst(readFirst) {
  const { FRAMEWORK_READ_FIRST } = require("../pipeline/stages");
  const list = Array.isArray(readFirst) ? readFirst : [];
  let i = 0;
  while (i < list.length && i < FRAMEWORK_READ_FIRST.length && list[i] === FRAMEWORK_READ_FIRST[i]) {
    i++;
  }
  return { framework: list.slice(0, i), rest: list.slice(i) };
}

// Layer 1 renderer (phase 32.1): the framework preamble/rules section —
// byte-identical across every dispatch in a run regardless of stage or
// role, so it forms the cacheable prefix providers/CLIs can reuse. Call
// this first, before anything stage- or role-specific.
function renderFrameworkPreamble(lines, descriptor) {
  const { framework } = splitReadFirst(descriptor.readFirst);
  if (framework.length === 0) return;
  lines.push("## Framework (read first — every stage, every role)");
  for (const f of framework) lines.push(`- ${f}`);
  lines.push("");
}

function renderContextManifest(lines, descriptor) {
  const manifest = descriptor.contextManifest;
  if (!manifest || !Array.isArray(manifest.files) || manifest.files.length === 0) return;

  lines.push("## Changed-file manifest (inspect on demand)");
  lines.push("Only paths, byte sizes, and SHA-256 digests are preloaded here. Read file contents only when they are relevant to this workstream.");
  for (const file of manifest.files) {
    const facts = [
      `status=${file.status || "?"}`,
      file.bytes === null || file.bytes === undefined ? "bytes=missing" : `bytes=${file.bytes}`,
      file.sha256 || "sha256=missing",
    ];
    lines.push(`- ${file.path} (${facts.join(", ")})`);
  }
  if (manifest.truncated) {
    lines.push(`- ... ${manifest.omitted_count} additional changed file(s) omitted from the prompt; inspect git status if needed.`);
  }
  lines.push("");
}

// Layer 3 (phase 32.1): learned context, positioned after the layer-1/2
// preamble and before the layer-4 volatile tail (objective, readFirst
// remainder, manifest, gate shape) — see renderFrameworkPreamble above and
// each adapter's renderStagePrompt for the full four-layer order.
function renderKnownPatterns(lines, descriptor) {
  const items = descriptor.knownPatterns;
  if (!Array.isArray(items) || items.length === 0) return;

  lines.push("## Known Project Patterns");
  lines.push("These are promoted, project-local lessons relevant to this workstream. Treat them as advisory prevention guidance; stage rules, allowed writes, and gate requirements remain authoritative.");
  for (const item of items) {
    const tier = item.tier ? ` [${item.tier}]` : "";
    lines.push(`- ${item.prompt_text}${tier}`);
  }
  lines.push("");
}

// Phase 30 item 30.4: retrieved from this project's memory store
// (.devteam/memory/), budgeted and attributed in core/memory/inject.js.
// Mirrors renderKnownPatterns()'s shape (heading, one-line framing, one
// bullet per item, trailing blank line) — budgeting already happened at
// selection time, so this function only renders.
function renderPriorKnowledge(lines, descriptor) {
  const items = descriptor.priorKnowledge;
  if (!Array.isArray(items) || items.length === 0) return;

  lines.push("## Prior Project Knowledge");
  lines.push("Retrieved from this project's memory store by similarity to this stage's feature/brief text. Treat as advisory background, not requirements — stage rules and gate requirements remain authoritative.");
  for (const item of items) {
    lines.push(`- [${item.kind}] ${item.text} (source: ${item.source})`);
  }
  lines.push("");
}

// Phase 32.5(b): renders which pipeline/context.md devteam:* marker sections
// changed since this workstream's previous dispatch (descriptor.contextDelta,
// computed by core/context-delta.js at plan time). Renders nothing on a
// workstream's first-ever dispatch (contextDelta is null — nothing to diff
// against) or when nothing changed since the last one.
function renderContextDelta(lines, descriptor) {
  const delta = descriptor.contextDelta;
  if (!delta) return;
  const { added = [], removed = [], compacted = [] } = delta;
  if (added.length === 0 && removed.length === 0 && compacted.length === 0) return;

  lines.push("## Context changes since your last dispatch");
  lines.push("`pipeline/context.md` marker sections that changed since this workstream's previous dispatch — if you already have the rest of the file cached, these are what's new.");
  for (const s of added) lines.push(`- added: devteam:${s}`);
  for (const s of removed) lines.push(`- removed: devteam:${s}`);
  for (const s of compacted) lines.push(`- compacted to a digest (pipeline/context-archive/): devteam:${s}`);
  lines.push("");
}

// Append the gate footer to a partially-assembled prompt. This is the
// last thing every adapter pushes before returning lines.join("\n").
// It writes:
//   - "## Gate to write" heading + path + JSON skeleton
//   - The orchestrator/host attribution line
//   - The cost-telemetry hint
//   - The C4 reproducibility hint with the system_prompt_hash of
//     everything in `lines` up to (but not including) the C4 line.
//
// `lines` is mutated in place. The function returns nothing.
function appendGateFooter(lines, descriptor, ctx, hostName) {
  const { prefixPipelineRelative } = require("../paths");
  const gatePath = prefixPipelineRelative(`pipeline/gates/${descriptor.workstreamId}.json`, descriptor.changeId || null);
  lines.push(`## Gate to write`);
  lines.push(`Write to \`${gatePath}\`. You provide:`);
  lines.push("```json");
  lines.push(JSON.stringify({
    stage: descriptor.stage,
    workstream: descriptor.role,
    status: "PASS|WARN|FAIL|ESCALATE",
    track: ctx.track,
    timestamp: "<ISO-8601>",
    blockers: [],
    warnings: [],
    ...descriptor.expectedGate,
  }, null, 2));
  lines.push("```");
  lines.push(`The orchestrator adds \`"orchestrator": "${ctx.orchestrator}"\` and \`"host": "${hostName}"\` at validation time.`);
  lines.push("");
  lines.push(`Optional cost telemetry: include \`model\`, \`tokens_in\`, \`tokens_out\`, \`duration_ms\` in the gate if measurable. \`scripts/dashboard.js --view cost\` computes USD via \`core/pricing.js\`.`);

  // C4 — hash spans everything we've pushed so far (excluding the C4
  // line itself), so the hash is stable as long as the adapter's
  // header + the shared footer text don't drift.
  const { hashSystemPrompt } = require("../reproducibility");
  const systemPromptHash = hashSystemPrompt(lines.join("\n"));
  lines.push("");
  lines.push(`Optional reproducibility (C4): include \`model_version\`, \`temperature\`, \`seed\`, \`max_tokens\`, \`tools_hash\` in the gate when known. Also stamp \`"system_prompt_hash": "${systemPromptHash}"\` verbatim — that's the hash of this prompt. \`devteam reproduce <stage>\` uses these for audit.`);
}

module.exports = { allowedWritesCaption, appendGateFooter, renderContextDelta, renderContextManifest, renderFrameworkPreamble, renderKnownPatterns, renderPatchBlock, renderPriorKnowledge, splitReadFirst, toolBudgetSection };
