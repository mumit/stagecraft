// Audit feature — structural integrity tests.
//
// Locks the contract that:
//   - The audit skill, role brief, slash commands, and 11 phase templates
//     all exist with the expected shape.
//   - Every host adapter's ROLES list includes "auditor".
//   - A fresh `devteam init` installs the audit surface for each host.

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { makeTargetProject, cleanup, runCLI, installGeminiCliPluginFixture } = require("./_helpers");

const REPO_ROOT = path.resolve(__dirname, "..");

let _dirs = [];
function track(cwd) { _dirs.push(cwd); return cwd; }
test.afterEach?.(() => { _dirs.forEach(cleanup); _dirs = []; });

// node --test 22+ exposes test.afterEach; older versions need a manual hook.
// Tests below clean their own tempdirs as a backstop.

test("skills/audit/SKILL.md exists with YAML frontmatter", () => {
  const p = path.join(REPO_ROOT, "skills", "audit", "SKILL.md");
  assert.ok(fs.existsSync(p), "skills/audit/SKILL.md is missing");
  const text = fs.readFileSync(p, "utf8");
  assert.match(text.slice(0, 5), /^---/, "skill must start with YAML frontmatter");
  assert.match(text, /^name: audit$/m, "skill frontmatter must declare name: audit");
  assert.match(text, /description:/m, "skill frontmatter must declare description");
});

test("roles/auditor.md exists and is read-only by design", () => {
  const p = path.join(REPO_ROOT, "roles", "auditor.md");
  assert.ok(fs.existsSync(p), "roles/auditor.md is missing");
  const text = fs.readFileSync(p, "utf8");
  assert.match(text, /Auditor Role Brief/i);
  assert.match(text, /read-only/i, "auditor role brief must spell out read-only");
  assert.doesNotMatch(text, /\bWrites:\s*\n\s*-\s*src\//i, "auditor must not list src/ as writable");
});

test("claude-code host has /audit and /audit-quick slash commands", () => {
  const audit = path.join(REPO_ROOT, "hosts", "claude-code", "install", "commands", "audit.md");
  const quick = path.join(REPO_ROOT, "hosts", "claude-code", "install", "commands", "audit-quick.md");
  assert.ok(fs.existsSync(audit), "claude-code /audit command is missing");
  assert.ok(fs.existsSync(quick), "claude-code /audit-quick command is missing");
  for (const p of [audit, quick]) {
    const text = fs.readFileSync(p, "utf8");
    assert.match(text.slice(0, 5), /^---/, `${path.basename(p)} must start with YAML frontmatter`);
    assert.match(text, /skills\/audit\/SKILL\.md/, `${path.basename(p)} must reference the audit skill`);
  }
});

test("templates/audit/ has all 11 phase templates (00 through 10)", () => {
  const dir = path.join(REPO_ROOT, "templates", "audit");
  assert.ok(fs.existsSync(dir), "templates/audit/ directory missing");
  const expected = [
    "00-project-context-template.md",
    "01-architecture-template.md",
    "02-git-history-template.md",
    "03-compliance-template.md",
    "04-tests-template.md",
    "05-documentation-template.md",
    "06-security-template.md",
    "07-performance-template.md",
    "08-code-quality-template.md",
    "09-backlog-template.md",
    "10-roadmap-template.md",
  ];
  for (const name of expected) {
    const p = path.join(dir, name);
    assert.ok(fs.existsSync(p), `templates/audit/${name} is missing`);
    const text = fs.readFileSync(p, "utf8");
    assert.match(text, /^# /, `${name} must start with a level-1 heading`);
  }
});

test("the canonical role list (core/roles.listRoles) includes 'auditor'", () => {
  // P2-2 of the self-audit moved the role list to core/roles.js (scanned
  // from roles/*.md). Verify the auditor role is picked up there — and
  // verify each adapter routes through it instead of carrying its own
  // hardcoded list.
  const { listRoles } = require("../core/roles");
  assert.ok(listRoles().includes("auditor"), "core/roles.listRoles() must include 'auditor'");

  // claude-code still maintains ROLE_FRONTMATTER (with per-role model /
  // tools metadata) — verify auditor has an entry there too.
  const claude = fs.readFileSync(path.join(REPO_ROOT, "hosts/claude-code/adapter.js"), "utf8");
  assert.match(claude, /auditor:\s*\{/, "claude-code/adapter.js must have ROLE_FRONTMATTER entry for auditor");

  // codex + gemini-cli delegate to core/adapters/markdown-host which owns
  // the core/roles import — verify the shared base uses it (guarantees both
  // adapters pick up auditor automatically after the 6.5.3 dedup).
  const base = fs.readFileSync(path.join(REPO_ROOT, "core/adapters/markdown-host.js"), "utf8");
  assert.match(
    base,
    /listRoles/,
    "core/adapters/markdown-host.js must call listRoles() from core/roles instead of a hardcoded ROLES array",
  );
  // 34.4: gemini-cli moved to packages/host-gemini-cli/ (plugin package).
  for (const rel of ["hosts/codex/adapter.js", "packages/host-gemini-cli/adapter.js"]) {
    const text = fs.readFileSync(path.join(REPO_ROOT, rel), "utf8");
    assert.match(
      text,
      /require\(['"][^'"]*adapters\/markdown-host['"]\)/,
      `${rel} must delegate to core/adapters/markdown-host (which owns the core/roles import)`,
    );
  }
});

test("`devteam init --host claude-code` installs the full audit surface", () => {
  const cwd = track(makeTargetProject());
  const r = runCLI(["init", "--host", "claude-code"], { cwd });
  assert.equal(r.status, 0);
  for (const rel of [
    ".claude/skills/audit/SKILL.md",
    ".claude/commands/audit.md",
    ".claude/commands/audit-quick.md",
    ".claude/agents/auditor.md",
  ]) {
    assert.ok(
      fs.existsSync(path.join(cwd, rel)),
      `claude-code init did not lay down ${rel}`,
    );
  }
});

test("`devteam init --host codex` installs audit skill + auditor role (no slash commands)", () => {
  const cwd = track(makeTargetProject());
  const r = runCLI(["init", "--host", "codex"], { cwd });
  assert.equal(r.status, 0);
  assert.ok(fs.existsSync(path.join(cwd, ".codex/skills/audit/SKILL.md")));
  assert.ok(fs.existsSync(path.join(cwd, ".codex/prompts/roles/auditor.md")));
  // Codex has no slashCommands capability — no commands installed.
  assert.equal(fs.existsSync(path.join(cwd, ".codex/commands/audit.md")), false);
});

// 34.4: gemini-cli moved to the @devteam/host-gemini-cli plugin package
// (packages/host-gemini-cli/) — installing the real plugin into this
// project's node_modules (mirroring `npm install @devteam/host-gemini-cli`)
// proves the audit surface still installs correctly through the plugin
// path, not just from the now-removed hosts/gemini-cli/. The "plugin not
// installed" error path is covered separately in
// tests/gemini-cli-plugin.test.js.
test("`devteam init --host gemini-cli` installs audit skill + auditor role (via plugin package)", () => {
  const cwd = track(makeTargetProject());
  installGeminiCliPluginFixture(cwd);
  const r = runCLI(["init", "--host", "gemini-cli"], { cwd });
  assert.equal(r.status, 0);
  assert.ok(fs.existsSync(path.join(cwd, ".gemini/skills/audit/SKILL.md")));
  assert.ok(fs.existsSync(path.join(cwd, ".gemini/prompts/roles/auditor.md")));
});

test("the audit skill defines all four phases (0 through 3) and 11 outputs", () => {
  const text = fs.readFileSync(path.join(REPO_ROOT, "skills", "audit", "SKILL.md"), "utf8");
  // Four phases.
  for (const phase of ["Phase 0 — Bootstrap", "Phase 1 — Health Assessment", "Phase 2 — Deep Analysis", "Phase 3 — Roadmap"]) {
    assert.match(text, new RegExp(phase.replace(/ /g, "\\s+")), `audit skill missing "${phase}"`);
  }
  // Eleven outputs.
  const outputs = [
    "00-project-context.md", "01-architecture.md", "02-git-history.md",
    "03-compliance.md", "04-tests.md", "05-documentation.md",
    "06-security.md", "07-performance.md", "08-code-quality.md",
    "09-backlog.md", "10-roadmap.md",
  ];
  for (const f of outputs) {
    // Literal substring check — these filenames don't need regex matching
    // and the previous `new RegExp(f.replace(/\./g, "\\."))` form was
    // flagged by CodeQL js/incomplete-sanitization (it only escaped dots,
    // not backslashes or other regex metacharacters). The filenames are
    // hardcoded literals so the regex risk was structural rather than
    // active, but `.includes` makes the test simpler and the linter quiet.
    assert.ok(text.includes(f), `audit skill doesn't reference ${f}`);
  }
});

test("the audit skill requires verified_by evidence for Phase 1 and Phase 2 findings", () => {
  const text = fs.readFileSync(path.join(REPO_ROOT, "skills", "audit", "SKILL.md"), "utf8");
  assert.match(text, /## Finding evidence contract/);
  assert.match(text, /Every Phase 1 and Phase 2 finding must include a `verified_by` field/);
  assert.match(text, /No promotion without proof/);
  assert.match(text, /findings above LOW confidence without direct `verified_by` evidence are invalid/);
  assert.match(text, /Unverified findings stay LOW/);
  assert.match(text, /set `verified_by: not verified/i);
  assert.match(text, /## Phase 1[\s\S]*`verified_by` evidence/);
  assert.match(text, /## Phase 2[\s\S]*Every Phase 2 finding must include the `verified_by` field/);
});

test("Phase 1 and Phase 2 audit templates include verification evidence slots", () => {
  const dir = path.join(REPO_ROOT, "templates", "audit");
  for (const name of [
    "03-compliance-template.md",
    "04-tests-template.md",
    "05-documentation-template.md",
    "06-security-template.md",
    "07-performance-template.md",
    "08-code-quality-template.md",
  ]) {
    const text = fs.readFileSync(path.join(dir, name), "utf8");
    assert.match(text, /Verified by/i, `${name} must include a verification evidence slot`);
  }
});
