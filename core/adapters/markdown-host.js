// Shared adapter logic for markdown-prompt hosts (codex, gemini-cli).
//
// Both hosts install plain-markdown role prompts, share the same
// install/uninstall/status/renderStagePrompt shape, and differ only in
// their capabilities.json values (name, rolePromptsDir, etc.).
// makeMarkdownHostAdapter(capabilities) returns the four shared functions;
// each adapter supplies its own invoke() since it captures module.exports.

const fs = require("node:fs");
const path = require("node:path");

const { listRoles, ROLES_DIR } = require("../roles");
const baseInstall = require("./base-install");
const { renderPatchBlock, allowedWritesCaption, appendGateFooter, renderContextDelta, renderContextManifest, renderFrameworkPreamble, renderKnownPatterns, renderPriorKnowledge, renderRoleBriefBlock, renderScopeLine, resolveFrameworkPath, splitReadFirst, toolBudgetSection } = require("./render-helpers");

const RULES_DIR = baseInstall.RULES_DIR;
const SKILLS_DIR = baseInstall.SKILLS_DIR;
const TEMPLATES_DIR = baseInstall.TEMPLATES_DIR;

function makeMarkdownHostAdapter(capabilities) {
  const ROLES = listRoles();
  const hostName = capabilities.name;

  function collectTemplateFiles(srcDir, relDir = "") {
    const files = [];
    for (const f of fs.readdirSync(srcDir)) {
      const src = path.join(srcDir, f);
      const rel = relDir ? path.join(relDir, f) : f;
      if (fs.statSync(src).isDirectory()) files.push(...collectTemplateFiles(src, rel));
      else files.push(rel);
    }
    return files;
  }

  function installRoles(targetDir, opts) {
    const dir = path.join(targetDir, capabilities.rolePromptsDir);
    fs.mkdirSync(dir, { recursive: true });
    const written = [];
    const skipped = [];
    const warnings = [];
    const toInstall = opts.roles && opts.roles.length > 0 ? opts.roles : ROLES;

    for (const role of toInstall) {
      const src = path.join(ROLES_DIR, `${role}.md`);
      if (!fs.existsSync(src)) {
        warnings.push(`role brief missing: ${src}`);
        continue;
      }
      const dest = path.join(dir, `${role}.md`);
      if (fs.existsSync(dest) && !opts.force) {
        skipped.push(dest);
        continue;
      }
      fs.copyFileSync(src, dest);
      written.push(dest);
    }
    return { written, skipped, warnings };
  }

  function install(targetDir, opts = {}) {
    const o = { force: false, roles: [], isolation: "in-place", ...opts };
    const roles = installRoles(targetDir, o);
    const rules = baseInstall.installRules(targetDir, o);
    const templates = baseInstall.installTemplates(targetDir, o);
    const skills = baseInstall.installSkills(targetDir, capabilities.skillsDir, o);
    return {
      written: [...roles.written, ...rules.written, ...templates.written, ...skills.written],
      skipped: [...roles.skipped, ...rules.skipped, ...templates.skipped, ...skills.skipped],
      warnings: [...roles.warnings, ...rules.warnings, ...templates.warnings, ...skills.warnings],
    };
  }

  function uninstall(targetDir) {
    const rolesDir = path.join(targetDir, capabilities.rolePromptsDir);
    if (fs.existsSync(rolesDir)) {
      for (const role of ROLES) {
        const p = path.join(rolesDir, `${role}.md`);
        if (fs.existsSync(p)) fs.unlinkSync(p);
      }
    }
    baseInstall.uninstallRules(targetDir);
    baseInstall.uninstallTemplates(targetDir);
    baseInstall.uninstallSkills(targetDir, capabilities.skillsDir);
  }

  function status(targetDir) {
    const missing = [];
    const stale = [];
    for (const role of ROLES) {
      const p = path.join(targetDir, capabilities.rolePromptsDir, `${role}.md`);
      if (!fs.existsSync(p)) missing.push(p);
      else if (fs.statSync(p).size === 0) stale.push(p);
    }
    if (fs.existsSync(RULES_DIR)) {
      for (const f of fs.readdirSync(RULES_DIR)) {
        if (!f.endsWith(".md")) continue;
        const p = path.join(targetDir, ".devteam", "rules", f);
        if (!fs.existsSync(p)) missing.push(p);
      }
    }
    if (fs.existsSync(SKILLS_DIR)) {
      for (const skill of fs.readdirSync(SKILLS_DIR)) {
        const p = path.join(targetDir, capabilities.skillsDir, skill, "SKILL.md");
        if (!fs.existsSync(p)) missing.push(p);
      }
    }
    if (fs.existsSync(TEMPLATES_DIR)) {
      for (const f of collectTemplateFiles(TEMPLATES_DIR)) {
        const p = path.join(targetDir, ".devteam", "templates", f);
        if (!fs.existsSync(p)) missing.push(p);
      }
    }
    return {
      ok: missing.length === 0 && stale.length === 0,
      missing,
      stale,
      notes: missing.length === 0 ? [`${hostName} install looks healthy`] : [],
    };
  }

  // Phase 32.1 (cache-first prompt assembly): renders the stage prompt as
  // four ordered layers — (1) framework preamble/rules, (2) role brief
  // pointer, (3) learned context, (4) volatile tail — and reports the
  // line-index boundaries between them. Layers 1-2 are byte-identical
  // across every dispatch in a run (same role), which is what makes the
  // prefix cacheable by providers/CLIs automatically. renderStagePrompt()
  // below is a thin wrapper that returns the full joined string; hosts
  // that want to attach cache_control breakpoints (e.g. openai-compat
  // against Anthropic-compatible endpoints) call renderStagePromptLayers()
  // directly for the per-layer text.
  //
  // Phase 37.2: layers 1-2 now carry the framework/role-brief content itself
  // (prompts.inline_framework, default true), not just their paths — 32.1
  // made the prefix byte-identical but left it a 268-byte pointer block; the
  // ~22 KB the model used to re-read via tool calls every dispatch now sits
  // in this cacheable position instead. false reverts to the pre-37.2
  // pointer text.
  function renderStagePromptLayers(descriptor, ctx) {
    const promptRole = descriptor.subagent || descriptor.role;
    const rolePromptRelPath = `${capabilities.rolePromptsDir}/${promptRole}.md`;
    // 36.2: a role brief is always framework content — resolveFrameworkPath()
    // rewrites it to an absolute stateRoot path only when ctx.processCwd
    // (the subject) differs from ctx.cwd (the review workspace); every
    // other run gets this string back unchanged.
    const rolePromptPath = resolveFrameworkPath(rolePromptRelPath, ctx);
    const lines = [];

    // --- Layer 1: framework preamble/rules (constant per version) ---
    renderFrameworkPreamble(lines, descriptor, ctx);
    const layer1End = lines.length;

    // --- Layer 2: role brief (constant per role) ---
    // 37.2: prompts.inline_framework appends the brief's content right after
    // this pointer sentence — see renderRoleBriefBlock's why-comment.
    renderRoleBriefBlock(lines, `Read the role prompt at \`${rolePromptPath}\` before acting on this stage.`, rolePromptRelPath, ctx);
    const layer2End = lines.length;

    // --- Layer 3: learned context (constant per run) ---
    renderKnownPatterns(lines, descriptor);
    renderPriorKnowledge(lines, descriptor);
    const layer3End = lines.length;

    // --- Layer 4: volatile tail (changes per dispatch) ---
    lines.push(`# Stage ${descriptor.stage} — ${descriptor.name}`);
    lines.push(`Workstream: ${descriptor.workstreamId} (role: ${descriptor.role}, host: ${hostName})`);
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
    lines.push(allowedWritesCaption(
      capabilities.enforces.allowed_writes,
      capabilities.displayName || hostName,
      capabilities.enforcementMechanismLabel,
    ));
    for (const f of descriptor.allowedWrites) lines.push(`- ${f}`);
    if (descriptor.allowedWrites.some((f) => f.includes("<"))) {
      lines.push("(Note: `<name>` tokens above are placeholders — substitute your actual value.");
      lines.push(" For example, write to `pipeline/code-review/by-qa.md`, NOT `pipeline/code-review/by-<reviewer>.md`.)");
    }
    lines.push("");
    const budgetSection = toolBudgetSection(descriptor.toolBudget, capabilities.enforces.tool_budget);
    if (budgetSection) { lines.push(budgetSection); lines.push(""); }
    lines.push(`## Artifact`);
    const templateRelPath = `.devteam/templates/${descriptor.template}`;
    // Existence is always checked under stateRoot (ctx.cwd) — a review
    // workspace's own template copy (36.3), same as today's single-root case.
    const templateExists = ctx.cwd && fs.existsSync(path.join(ctx.cwd, templateRelPath));
    // 36.2: templates are framework content too — see rolePromptPath above.
    const templateRel = resolveFrameworkPath(templateRelPath, ctx);
    // 36.4 fix-up (plans/phase-36-external-review-mode.md, out-of-scope
    // finding #1): the artifact is always written under stateRoot, never the
    // subject — resolveFrameworkPath's own doc comment covers why reusing it
    // here for a write target (not a framework read) is still correct.
    // descriptor.artifact may carry a literal `<name>` placeholder
    // (peer-review's `pipeline/code-review/by-<reviewer>.md`) — path.resolve
    // treats that as an ordinary path segment, so the placeholder survives
    // unchanged inside the now-absolute path; the "substitute your actual
    // value" note below still applies verbatim.
    const artifactPath = resolveFrameworkPath(descriptor.artifact, ctx);
    lines.push(templateExists
      ? `Produce \`${artifactPath}\` using \`${templateRel}\`.`
      : `Produce \`${artifactPath}\`.`);
    lines.push("");
    appendGateFooter(lines, descriptor, ctx, hostName);

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

  return { install, uninstall, status, renderStagePrompt, renderStagePromptLayers };
}

module.exports = { makeMarkdownHostAdapter };
