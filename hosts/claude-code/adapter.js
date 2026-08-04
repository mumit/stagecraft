// Claude Code host adapter.
//
// install: renders roles/*.md into <target>/.claude/agents/<name>.md with
//          per-role Claude Code YAML frontmatter, and copies slash commands
//          from install/commands/ into <target>/.claude/commands/.
// renderStagePrompt: emits a Claude-Code-idiomatic stage prompt that
//          delegates to the subagent file installed above.
// status:  verifies installed files exist and are non-empty.
// uninstall: removes the files install() laid down.
// invoke:  drives core/adapters/headless.js's runHeadless() against
//          `claude --print --output-format stream-json --verbose`
//          (capabilities.headlessCommand); usageFormat: "claude-stream-json"
//          tells runHeadless to parse the stream for orchestrator-observed
//          token/cost telemetry (phase-28 item 28.1).

const fs = require("node:fs");
const path = require("node:path");

const capabilities = require("./capabilities.json");
const { runHeadless } = require("../../core/adapters/headless");
const { listRoles, toolBudgetFor, ROLES_DIR } = require("../../core/roles");
const baseInstall = require("../../core/adapters/base-install");
const RULES_DIR = baseInstall.RULES_DIR;
const SKILLS_DIR = baseInstall.SKILLS_DIR;
const COMMANDS_SRC = path.join(__dirname, "install", "commands");

// Per-role frontmatter for Claude Code subagent files. The `name` field is
// the filename stem the agent is invoked under inside Claude Code.
// Tool budgets are sourced from core/roles.js (toolBudgetFor) — the tools
// field was removed from here in 6.1 so the budget stays in one host-neutral
// place.
//
// The KEYS of this object are role names. They must be a subset of the
// roles discovered by core/roles.js (which scans roles/*.md). If a brief
// exists in roles/ but has no ROLE_FRONTMATTER entry, install will warn
// and skip — claude-code can't render a subagent without frontmatter.
// Add an entry below to enable a new role under claude-code.
const ROLE_FRONTMATTER = {
  pm: {
    name: "pm",
    description: "Product Manager. Owns the brief, acceptance criteria, scope, sign-off, and stakeholder summaries. Represents the customer; does not make technical decisions.",
    model: "opus",
    permissionMode: "acceptEdits",
  },
  principal: {
    name: "principal",
    description: "Principal Engineer. Owns the design spec, ADRs, and technical rulings. Has veto power on architecture and on escalated code review conflicts.",
    model: "opus",
    permissionMode: "acceptEdits",
  },
  reviewer: {
    name: "reviewer",
    description: "Peer reviewer for Stage 5. READ-ONLY during a review invocation; writes only to pipeline/code-review/by-<area>.md (panel mode) or by-reviewer.md (adversarial mode, review.mode: adversarial). Does not edit source or write stage gates directly.",
    model: "sonnet",
    permissionMode: "acceptEdits",
  },
  critic: {
    name: "critic",
    description: "Adversarial critic for Stage 5 (review.mode: adversarial only). Dispatched AFTER the reviewer completes — attacks the review itself: missed findings, unsupported approvals, answers \"what would make this approval wrong?\". READ-ONLY on code; writes only pipeline/code-review/by-critic.md. Requires file:line evidence for every challenge. Route to a different host than the reviewer by default when ≥2 hosts are configured (routing.roles.critic overrides) — collusion counter-measure.",
    model: "opus",
    permissionMode: "acceptEdits",
  },
  security: {
    name: "security-engineer",
    description: "Security reviewer for changes touching auth, crypto, PII, payments, secrets, IaC, or new/upgraded external dependencies. Has veto power on Stage 4a security gates.",
    model: "opus",
    permissionMode: "acceptEdits",
  },
  backend: {
    name: "dev-backend",
    description: "Backend implementer. Owns src/backend/. Implements APIs, services, data layer; runs local verification; writes the backend workstream gate.",
    model: "sonnet",
    permissionMode: "acceptEdits",
  },
  frontend: {
    name: "dev-frontend",
    description: "Frontend implementer. Owns src/frontend/. Implements UI; runs local verification; writes the frontend workstream gate.",
    model: "sonnet",
    permissionMode: "acceptEdits",
  },
  platform: {
    name: "dev-platform",
    description: "Platform/infra implementer. Owns src/infra/, CI, pre-review (Stage 4a) lint/test/SCA, and Stage 8 deploy. Writes the platform workstream gate.",
    model: "sonnet",
    permissionMode: "acceptEdits",
  },
  qa: {
    name: "dev-qa",
    description: "QA. Owns src/tests/ and the Stage 6 test-execution gate. Maps each acceptance criterion to a test 1:1; does not own infra or deploy.",
    model: "sonnet",
    permissionMode: "acceptEdits",
  },
  auditor: {
    name: "auditor",
    description: "Codebase auditor. Read-only by design — analyzes architecture, health, security, performance, code quality; produces docs/audit/00–10 outputs and a prioritized roadmap. Used by the /audit and /audit-quick slash commands. Never writes source code.",
    model: "opus",
    permissionMode: "acceptEdits",
  },
  "red-team": {
    name: "red-team",
    description: "Adversarial reviewer for stage-04c. Read-only on code — finds concrete attack scenarios, hostile inputs, race conditions, abuse cases, scale failures, downstream effects, observability gaps the spec didn't cover. Writes pipeline/red-team-report.md + stage-04c gate. Distinct from security-engineer (narrower auth/crypto/PII remit, conditional, has veto) and reviewer (code review at stage-05). Route to a DIFFERENT host than the build agents for maximum independence.",
    model: "opus",
    permissionMode: "acceptEdits",
  },
  migrations: {
    name: "migrations",
    description: "Migration-safety reviewer for stage-04d (conditional on data-layer diffs). Read-only on code — evaluates schema delta, breaking-change classification, backfill strategy, dual-write strategy, rollback plan + tested status. Writes pipeline/migration-safety.md + stage-04d gate. Has VETO power: a migration without a tested rollback halts the pipeline regardless of peer-review. Distinct from security-engineer (auth/crypto/PII), red-team (general adversarial), reviewer (code-level). Route to a different host than the build agents.",
    model: "opus",
    permissionMode: "acceptEdits",
  },
  verifier: {
    name: "verifier",
    description: "Verification-beyond-tests reviewer for stage-06d (full track only, runs AFTER stage-06 PASS). Read-only on production code; writes property tests under src/tests/property/ and formal specs under pipeline/formal/. Applies property-based testing (fast-check / hypothesis / proptest), mutation testing (stryker / mutmut / mull), and/or formal verification (TLA+ / Alloy / Lean) to the changed code. Inventories candidates per code shape, picks methods, runs them, records counterexamples + surviving mutants + invariant violations as blocking findings. Distinct from qa (writes example tests, the floor), red-team (adversarial pre-build-acceptance), reviewer (code-level). Skill: verification-beyond-tests. Tests-pass becomes the floor; this role is the ceiling.",
    model: "opus",
    permissionMode: "acceptEdits",
  },
  reflector: {
    name: "reflector",
    description: "Phase-30 opt-in run-end pass (learning.reflector: true). Read-only — reads the run's gates, run-log.jsonl, and the promoted-pattern set (embedded in the dispatch prompt, not read live) and emits itemized pattern-candidate delta proposals as JSON. Never edits code or gates, never promotes a pattern; promotion stays the human `devteam patterns promote` flow. Cheap-model-appropriate: route to a different (lower-cost) host than the build agents.",
    model: "haiku",
    permissionMode: "acceptEdits",
  },
};

// toolBudgetFor is imported from core/roles.js (6.1: host-neutral source of
// truth). Re-exported below so callers that reference adapter.toolBudgetFor
// continue to work.

function frontmatterFor(role) {
  const fm = ROLE_FRONTMATTER[role];
  if (!fm) throw new Error(`No frontmatter defined for role "${role}" in claude-code adapter`);
  const toolsArray = toolBudgetFor(role);
  if (!toolsArray) throw new Error(`No tool budget defined for role "${role}" in core/roles.js`);
  const lines = ["---"];
  lines.push(`name: ${fm.name}`);
  lines.push(`description: >`);
  for (const wrapped of wrapText(fm.description, 72)) lines.push(`  ${wrapped}`);
  lines.push(`tools: ${toolsArray.join(", ")}`);
  lines.push(`model: ${fm.model}`);
  lines.push(`permissionMode: ${fm.permissionMode}`);
  lines.push("---");
  return { yaml: lines.join("\n"), filename: `${fm.name}.md` };
}

function wrapText(text, width) {
  const words = text.split(/\s+/);
  const lines = [];
  let line = "";
  for (const w of words) {
    if (line.length + w.length + 1 > width && line.length > 0) {
      lines.push(line);
      line = w;
    } else {
      line = line ? `${line} ${w}` : w;
    }
  }
  if (line) lines.push(line);
  return lines;
}

function installRoles(targetDir, opts) {
  const agentsDir = path.join(targetDir, capabilities.agentsDir);
  fs.mkdirSync(agentsDir, { recursive: true });
  const written = [];
  const skipped = [];
  const warnings = [];
  const rolesToInstall = opts.roles && opts.roles.length > 0
    ? opts.roles
    : Object.keys(ROLE_FRONTMATTER);

  // Sanity check: every brief in roles/ should have a ROLE_FRONTMATTER
  // entry, otherwise it's a silent claude-code-only gap (the role would
  // be installed under codex/gemini but not as a claude-code subagent).
  // Warn but don't fail — adding the brief without the frontmatter is a
  // legitimate intermediate state.
  if (!opts.roles) {
    const briefsWithoutFrontmatter = listRoles().filter((r) => !ROLE_FRONTMATTER[r]);
    for (const r of briefsWithoutFrontmatter) {
      warnings.push(
        `role "${r}" has a brief at roles/${r}.md but no ROLE_FRONTMATTER entry in hosts/claude-code/adapter.js — ` +
        `skipped on this host. Add an entry to enable the subagent.`,
      );
    }
  }

  for (const role of rolesToInstall) {
    const briefPath = path.join(ROLES_DIR, `${role}.md`);
    if (!fs.existsSync(briefPath)) {
      warnings.push(`role brief missing: ${briefPath}`);
      continue;
    }
    const { yaml, filename } = frontmatterFor(role);
    const out = path.join(agentsDir, filename);
    if (fs.existsSync(out) && !opts.force) {
      skipped.push(out);
      continue;
    }
    const body = fs.readFileSync(briefPath, "utf8");
    fs.writeFileSync(out, `${yaml}\n\n${body}`, "utf8");
    written.push(out);
  }
  return { written, skipped, warnings };
}

function installCommands(targetDir, opts) {
  const commandsDir = path.join(targetDir, capabilities.commandsDir);
  fs.mkdirSync(commandsDir, { recursive: true });
  const written = [];
  const skipped = [];
  if (!fs.existsSync(COMMANDS_SRC)) {
    return { written, skipped, warnings: [`no commands payload at ${COMMANDS_SRC}`] };
  }
  for (const f of fs.readdirSync(COMMANDS_SRC)) {
    const src = path.join(COMMANDS_SRC, f);
    const dest = path.join(commandsDir, f);
    if (fs.existsSync(dest) && !opts.force) {
      skipped.push(dest);
      continue;
    }
    fs.copyFileSync(src, dest);
    written.push(dest);
  }
  return { written, skipped, warnings: [] };
}

function renderSettingsLocal() {
  // Use "devteam hook <name>" so the command resolves at execution time via
  // the installed devteam binary — not the absolute path baked in at init time.
  // This makes settings.local.json portable across machines and clones.
  const validateCmd = "devteam hook validate";
  const approvalCmd = "devteam hook approval-derivation";
  const secretScanCmd = "devteam hook secret-scan";
  return {
    hooks: {
      Stop: [{ hooks: [{ type: "command", command: validateCmd }] }],
      SubagentStop: [{ hooks: [{ type: "command", command: validateCmd }] }],
      PreToolUse: [
        { matcher: "Write|Edit", hooks: [{ type: "command", command: secretScanCmd }] },
      ],
      PostToolUse: [
        { matcher: "Write|Edit", hooks: [{ type: "command", command: approvalCmd }] },
      ],
    },
    permissions: {
      allow: [
        "Bash(devteam *)",
        "Bash(npm run *)",
        "Bash(npm test *)",
        "Write(src/**)",
        "Write(pipeline/**)",
        "Write(.claude/agents/**)",
      ],
      deny: [
        "Bash(rm -rf *)",
        "Bash(git push --force *)",
        "Bash(git push -f *)",
      ],
    },
  };
}

function installSettings(targetDir, opts) {
  const dir = path.join(targetDir, ".claude");
  fs.mkdirSync(dir, { recursive: true });
  const dest = path.join(dir, "settings.local.json");
  if (fs.existsSync(dest) && !opts.force) {
    return { written: [], skipped: [dest], warnings: [] };
  }
  fs.writeFileSync(dest, JSON.stringify(renderSettingsLocal(), null, 2) + "\n", "utf8");
  return { written: [dest], skipped: [], warnings: [] };
}

function install(targetDir, opts = {}) {
  const o = { force: false, roles: [], isolation: "in-place", ...opts };
  const roles = installRoles(targetDir, o);
  const commands = installCommands(targetDir, o);
  const rules = baseInstall.installRules(targetDir, o);
  const skills = baseInstall.installSkills(targetDir, capabilities.skillsDir, o);
  const settings = installSettings(targetDir, o);
  return {
    written: [...roles.written, ...commands.written, ...rules.written, ...skills.written, ...settings.written],
    skipped: [...roles.skipped, ...commands.skipped, ...rules.skipped, ...skills.skipped, ...settings.skipped],
    warnings: [...roles.warnings, ...commands.warnings, ...rules.warnings, ...skills.warnings, ...settings.warnings],
  };
}

function uninstall(targetDir) {
  const agentsDir = path.join(targetDir, capabilities.agentsDir);
  if (fs.existsSync(agentsDir)) {
    for (const role of Object.keys(ROLE_FRONTMATTER)) {
      const { filename } = frontmatterFor(role);
      const p = path.join(agentsDir, filename);
      if (fs.existsSync(p)) fs.unlinkSync(p);
    }
  }
  const commandsDir = path.join(targetDir, capabilities.commandsDir);
  if (fs.existsSync(commandsDir) && fs.existsSync(COMMANDS_SRC)) {
    for (const f of fs.readdirSync(COMMANDS_SRC)) {
      const p = path.join(commandsDir, f);
      if (fs.existsSync(p)) fs.unlinkSync(p);
    }
  }
  baseInstall.uninstallRules(targetDir);
  const settings = path.join(targetDir, ".claude", "settings.local.json");
  if (fs.existsSync(settings)) fs.unlinkSync(settings);
  baseInstall.uninstallSkills(targetDir, capabilities.skillsDir);
}

function status(targetDir) {
  const missing = [];
  const stale = [];
  for (const role of Object.keys(ROLE_FRONTMATTER)) {
    const { filename } = frontmatterFor(role);
    const p = path.join(targetDir, capabilities.agentsDir, filename);
    if (!fs.existsSync(p)) missing.push(p);
    else if (fs.statSync(p).size === 0) stale.push(p);
  }
  const cmd = path.join(targetDir, capabilities.commandsDir, "devteam.md");
  if (!fs.existsSync(cmd)) missing.push(cmd);
  if (fs.existsSync(RULES_DIR)) {
    for (const f of fs.readdirSync(RULES_DIR)) {
      if (!f.endsWith(".md")) continue;
      const p = path.join(targetDir, ".devteam", "rules", f);
      if (!fs.existsSync(p)) missing.push(p);
    }
  }
  const settings = path.join(targetDir, ".claude", "settings.local.json");
  if (!fs.existsSync(settings)) missing.push(settings);
  if (fs.existsSync(SKILLS_DIR)) {
    for (const skill of fs.readdirSync(SKILLS_DIR)) {
      const p = path.join(targetDir, capabilities.skillsDir, skill, "SKILL.md");
      if (!fs.existsSync(p)) missing.push(p);
    }
  }
  return {
    ok: missing.length === 0 && stale.length === 0,
    missing,
    stale,
    notes: missing.length === 0 ? ["claude-code install looks healthy"] : [],
  };
}

// Phase 32.1 (cache-first prompt assembly): renders the stage prompt as
// four ordered layers — (1) framework preamble/rules, (2) role brief
// pointer, (3) learned context, (4) volatile tail — and reports the
// line-index boundaries between them. Layers 1-2 are byte-identical
// across every dispatch in a run using the same role, which is what makes
// the prefix cacheable by the claude-code CLI/API automatically.
// renderStagePrompt() below is a thin wrapper that returns the full joined
// string.
function renderStagePromptLayers(descriptor, ctx) {
  // descriptor.subagent (when set) overrides the role-to-agent mapping —
  // used by stages like peer-review where every workstream-area dispatches
  // to the same reviewer subagent.
  const fm = descriptor.subagent
    ? ROLE_FRONTMATTER[descriptor.subagent]
    : ROLE_FRONTMATTER[descriptor.role];
  const agentName = fm ? fm.name : (descriptor.subagent || descriptor.role);
  const { renderPatchBlock, allowedWritesCaption, appendGateFooter, renderContextDelta, renderContextManifest, renderFrameworkPreamble, renderKnownPatterns, renderPriorKnowledge, renderScopeLine, splitReadFirst } = require("../../core/adapters/render-helpers");
  const lines = [];

  // --- Layer 1: framework preamble/rules (constant per version) ---
  renderFrameworkPreamble(lines, descriptor);
  const layer1End = lines.length;

  // --- Layer 2: role brief (constant per role) ---
  lines.push(`Use the **${agentName}** subagent (\`.claude/agents/${agentName}.md\`) for this workstream.`);
  lines.push("");
  const layer2End = lines.length;

  // --- Layer 3: learned context (constant per run) ---
  renderKnownPatterns(lines, descriptor);
  renderPriorKnowledge(lines, descriptor);
  const layer3End = lines.length;

  // --- Layer 4: volatile tail (changes per dispatch) ---
  lines.push(`# Stage ${descriptor.stage} — ${descriptor.name}`);
  lines.push(`Workstream: ${descriptor.workstreamId} (role: ${descriptor.role}, host: claude-code)`);
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
  lines.push(allowedWritesCaption(capabilities.enforces.allowed_writes, capabilities.displayName));
  for (const f of descriptor.allowedWrites) lines.push(`- ${f}`);
  lines.push("");
  lines.push(`## Artifact`);
  lines.push(`Produce \`${descriptor.artifact}\` using \`templates/${descriptor.template}\`.`);
  lines.push("");
  appendGateFooter(lines, descriptor, ctx, "claude-code");

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

function invoke(descriptor, ctx, preRenderedPrompt) {
  return runHeadless(module.exports, descriptor, ctx, preRenderedPrompt);
}

module.exports = {
  capabilities,
  install,
  uninstall,
  status,
  renderStagePrompt,
  renderStagePromptLayers,
  invoke,
  toolBudgetFor,
  renderSettingsLocal,
};
