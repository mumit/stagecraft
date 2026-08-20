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
// Phase-35 item 35.1: render "Scope: <path>[, <path>...]" right after the
// Track/Feature header lines when --scope was passed (ctx.scope is a
// non-empty array; null otherwise — see core/orchestrator.js's runStage()).
// Absence is the normal case for every pre-35 track and must not alter their
// prompts (byte-identical regression, tests/prompt-layout.test.js).
function renderScopeLine(ctx, lines) {
  if (!ctx.scope || ctx.scope.length === 0) return;
  lines.push(`Scope: ${ctx.scope.join(", ")} — review only this path (these paths); the rest of the repo is out of scope for this review.`);
}

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

function renderApprovedAffectedFiles(lines, descriptor) {
  const files = descriptor.approvedAffectedFiles;
  if (!Array.isArray(files) || files.length === 0) return;
  lines.push("");
  lines.push("## Approved affected files (exact scope contract)");
  lines.push("");
  lines.push("Build, QA, and peer review share this Stage 1-approved list. Treat every path as exact; no parent directory, sibling, or wildcard is implied.");
  for (const file of files) lines.push(`- ${file}`);
}

// Caption for the "Allowed writes" section. The wording reflects
// how the host *actually* enforces the list at runtime — tool-call-
// time (hooks block writes) vs prompt-only (advisory; gate validator
// catches violations post-hoc) vs post-hoc-audit (similar). Each
// adapter declares its level in capabilities.enforces.allowed_writes;
// this helper just renders the right caption.
//
// `mechanism` names the tool-call-time gate itself — claude-code's is
// "hooks" (the historical, still-default wording); 34.1's ACP host is the
// first non-claude-code tool-call-time host and enforces via ACP's
// session/request_permission flow, not hooks, so it passes "permission
// requests" via capabilities.enforcementMechanismLabel (see
// core/adapters/markdown-host.js). Callers that omit it keep the
// pre-34.1 "hooks" wording byte-identical.
function allowedWritesCaption(enforcementLevel, hostDisplayName, mechanism = "hooks") {
  switch (enforcementLevel) {
    case "tool-call-time":
      return `## Allowed writes (enforced by ${hostDisplayName} ${mechanism} at tool-call time)`;
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

// Phase 36.2 (plans/phase-36-external-review-mode.md §36.2): resolve a
// stateRoot-owned relative path against the two-root model 36.1 introduced
// (hosts/acp/adapter.js's codeRoot/stateRoot split). `ctx.processCwd` is the
// subject (codeRoot) an agent's tool calls actually run against; `ctx.cwd` is
// where state lives (stateRoot) — 36.2 used this for *framework* reads (a
// rule file, role brief, or template — core/pipeline/stages.js's
// `isFrameworkReadFirstPath`, plus this same module's role-prompt/template
// lines); 36.4's fix-up (plans/phase-36-external-review-mode.md, out-of-scope
// finding #1) reuses it unchanged for the two *write* targets every dispatch
// names — appendGateFooter's gate path below and markdown-host.js's artifact
// line — since both are always stateRoot-owned (a gate or review artifact is
// never subject content) exactly like a framework read, just in the other
// direction. When codeRoot and stateRoot are the same directory (every
// non-review run today, and any future run where 34.1's ctx.processCwd is
// simply unset) this returns `relPath` completely unchanged — the
// single-root byte-identical regression every caller here requires. Only
// when they genuinely differ does a stateRoot-owned path need to become
// absolute: relative, it would resolve against the agent's own session cwd
// (the subject, in review mode), where it is not meant to land.
function resolveFrameworkPath(relPath, ctx) {
  if (!ctx) return relPath;
  const path = require("node:path");
  const codeRoot = ctx.processCwd || ctx.cwd;
  const stateRoot = ctx.cwd;
  if (!codeRoot || !stateRoot) return relPath;
  if (path.resolve(codeRoot) === path.resolve(stateRoot)) return relPath;
  return path.resolve(stateRoot, relPath);
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

// Phase 37.2 (plans/phase-37-interface-and-token-efficiency.md §37.2):
// prompts.inline_framework gates whether layers 1-2 inline framework/role-
// brief content or keep pointing at paths (the pre-37.2 behaviour). Read
// from `ctx.cwd` (stateRoot) the same way every other framework-config
// lookup does (e.g. hosts/openai-compat/invoke.js's resolveConfig). No
// `ctx.cwd` (a bare unit-test descriptor with no project) can't be inlined
// at all — there is no root to read files from — so it falls back to the
// pointer behaviour, which is also what makes tests/prompt-layout.test.js's
// ctx-less unit tests of this module keep their pre-37.2 assertions valid.
// core/adapters/headless.js's over-budget fallback needs to re-render a
// prompt with inlining forced off regardless of what .devteam/config.yml
// says — a per-call escape hatch, not a config change — so an explicit
// ctx.inlineFrameworkOverride === false short-circuits before the config
// lookup. Absent (the normal case), behaviour is unchanged.
function shouldInlineFramework(ctx) {
  if (ctx && ctx.inlineFrameworkOverride === false) return false;
  if (!ctx || !ctx.cwd) return false;
  try {
    const { loadConfig } = require("../config");
    return loadConfig(ctx.cwd).prompts.inline_framework !== false;
  } catch {
    return false;
  }
}

// Phase 37.2: read a framework-owned file's content for inlining, applying
// the same codeRoot/stateRoot direction as resolveFrameworkPath (framework
// content always lives under stateRoot). Returns null — never throws — when
// the file is absent, so a project mid-init or a stale role name degrades to
// a visible placeholder in the rendered prompt rather than crashing the
// dispatch.
function readFrameworkFileContent(relPath, ctx) {
  const fs = require("node:fs");
  const path = require("node:path");
  const resolved = resolveFrameworkPath(relPath, ctx);
  const abs = path.isAbsolute(resolved) ? resolved : path.join((ctx && ctx.cwd) || process.cwd(), resolved);
  try {
    return fs.readFileSync(abs, "utf8");
  } catch {
    return null;
  }
}

// Layer 1 renderer (phase 32.1): the framework preamble/rules section —
// byte-identical across every dispatch in a run regardless of stage or
// role, so it forms the cacheable prefix providers/CLIs can reuse. Call
// this first, before anything stage- or role-specific.
//
// Phase 37.2: with prompts.inline_framework (default true), the framework
// files' content is inlined here instead of just named — the whole point is
// that "every dispatch, every role" byte-identical block now carries the ~22
// KB the model used to re-read itself via 4+ tool-call round-trips, in a
// position a provider's prefix cache can reuse. The old path list survives
// as a short note either way, so a human reading a transcript can still find
// the source files.
function renderFrameworkPreamble(lines, descriptor, ctx) {
  const { framework } = splitReadFirst(descriptor.readFirst);
  if (framework.length === 0) return;
  if (!shouldInlineFramework(ctx)) {
    lines.push("## Framework (read first — every stage, every role)");
    for (const f of framework) lines.push(`- ${f}`);
    lines.push("");
    return;
  }
  lines.push("## Framework (inlined below — every stage, every role)");
  lines.push(`Source files, for reference in a transcript: ${framework.join(", ")}`);
  lines.push("");
  for (const f of framework) {
    lines.push(`### ${f}`);
    const content = readFrameworkFileContent(f, ctx);
    lines.push(content !== null ? content.trimEnd() : `(missing: ${f})`);
    lines.push("");
  }
}

// ADR-023: convergence-shaped stages (build, qa) declare a goalCondition — the
// exit criterion that says "keep going until this holds" rather than "take one
// pass". It used to be delivered as claude-code's `/goal "<condition>"` slash
// command, whose handler rejects input over 4,000 characters; since a real
// dispatch prompt never fits, the directive was always dropped and the
// condition reached no model at all. Stating it in the prompt body works on
// every host, at any prompt size, and costs ~100 bytes instead of the ~5 KB the
// fallback chain used to discard trying to make room for it.
//
// Advisory by design: this asks the model to converge. Actually re-dispatching
// a stage that did not is the driver's fix-and-retry loop (ADR-003), which is
// what has been doing that work all along.
function renderGoalCondition(lines, descriptor) {
  if (!descriptor || typeof descriptor.goalCondition !== "string") return;
  const condition = descriptor.goalCondition.trim();
  if (!condition) return;
  lines.push("## Done when");
  lines.push(`Keep working until this holds: ${condition}`);
  lines.push("Do not stop at a first attempt that leaves it unmet.");
  lines.push("");
}

// Phase 37.2: shared layer-2 (role brief) renderer. `pointerLine` is the
// host-specific sentence that names the role brief's path — kept unchanged
// either way, both because it is the "short note" the plan item asks for and
// because claude-code's phrasing of it also carries the Task-tool
// subagent-invocation instruction, which inlining must not remove. With
// prompts.inline_framework, the brief's content is appended verbatim right
// after it, making the whole layer byte-identical across dispatches of the
// same role and — same reasoning as renderFrameworkPreamble above — cacheable.
function renderRoleBriefBlock(lines, pointerLine, roleBriefRelPath, ctx) {
  lines.push(pointerLine);
  if (shouldInlineFramework(ctx)) {
    lines.push("");
    const content = readFrameworkFileContent(roleBriefRelPath, ctx);
    lines.push(content !== null ? content.trimEnd() : `(missing: ${roleBriefRelPath})`);
  }
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

function renderProjectKnowledgePack(lines, descriptor) {
  const facts = Array.isArray(descriptor.projectFacts) ? descriptor.projectFacts : [];
  const patterns = Array.isArray(descriptor.knownPatterns) ? descriptor.knownPatterns : [];
  const history = Array.isArray(descriptor.priorKnowledge) ? descriptor.priorKnowledge : [];
  if (facts.length === 0 && patterns.length === 0 && history.length === 0) return;

  lines.push("## Project Knowledge Pack");
  lines.push("Bounded, provenance-labeled project context. Detected facts describe the repository; promoted patterns are reviewed advisory guidance; retrieved history is background. Stage rules, allowed writes, and gate requirements remain authoritative.");
  if (facts.length > 0) {
    lines.push("");
    lines.push("### Detected conventions");
    for (const item of facts) lines.push(`- ${item.text} (source: ${item.source})`);
  }
  if (patterns.length > 0) {
    lines.push("");
    lines.push("### Reviewed patterns and outcome evidence");
    for (const item of patterns) {
      const evaluation = item.evaluation || {};
      const evidence = Number.isInteger(evaluation.injections)
        ? `; outcome: ${evaluation.status}; injected=${evaluation.injections}; recurred=${evaluation.recurrences}`
        : "";
      lines.push(`- ${item.prompt_text} [${item.tier || "warning"}${evidence}; source: pattern:${item.id}]`);
    }
  }
  if (history.length > 0) {
    lines.push("");
    lines.push("### Retrieved history");
    for (const item of history) lines.push(`- [${item.kind}] ${item.text} (source: ${item.source})`);
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
  const gatePathRel = prefixPipelineRelative(`pipeline/gates/${descriptor.workstreamId}.json`, descriptor.changeId || null);
  // 36.4 fix-up (plans/phase-36-external-review-mode.md, out-of-scope finding
  // #1): the gate always belongs under stateRoot (ctx.cwd), never the
  // subject — same direction as resolveFrameworkPath's framework reads, just
  // for a write target. Byte-identical to `gatePathRel` whenever
  // ctx.processCwd is unset or equals ctx.cwd (every run before review mode).
  const gatePath = resolveFrameworkPath(gatePathRel, ctx);
  // This is the last thing the model reads before the gate JSON skeleton —
  // maximum recency. It exists because a headless dispatch has been observed
  // ending its turn with only a prose clarifying question and no gate at
  // all (everything above reads as reference material unless told
  // otherwise): the orchestrator sees no gate and halts with a
  // structural-input error. See rules/gates-core.md's own "Non-interactive
  // execution" section for the full rationale; this line is the recency-
  // boosted reminder of the same rule.
  lines.push(`This dispatch is non-interactive — there is no human present to read a question. Perform the task above now and end your turn only after writing the gate below. If genuinely blocked, write it anyway with "status": "ESCALATE" and a detailed "escalation_reason" instead of asking a question and stopping.`);
  lines.push("");
  lines.push(`## Gate to write`);
  lines.push(`Write to \`${gatePath}\`. You provide:`);
  lines.push("```json");
  const gateSkeleton = {
    stage: descriptor.stage,
    workstream: descriptor.role,
    status: "PASS|WARN|FAIL|ESCALATE",
    track: ctx.track,
    timestamp: "<ISO-8601>",
    blockers: [],
    warnings: [],
    ...descriptor.expectedGate,
  };
  // Phase-35 item 35.1: --scope lands on the gate too, for audit — only when
  // passed, so every pre-35 gate skeleton (and prompt) stays byte-identical.
  if (ctx.scope) gateSkeleton.scope = ctx.scope;
  lines.push(JSON.stringify(gateSkeleton, null, 2));
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

module.exports = { allowedWritesCaption, appendGateFooter, readFrameworkFileContent, renderApprovedAffectedFiles, renderContextDelta, renderContextManifest, renderFrameworkPreamble, renderGoalCondition, renderKnownPatterns, renderPatchBlock, renderPriorKnowledge, renderProjectKnowledgePack, renderRoleBriefBlock, renderScopeLine, resolveFrameworkPath, shouldInlineFramework, splitReadFirst, toolBudgetSection };
