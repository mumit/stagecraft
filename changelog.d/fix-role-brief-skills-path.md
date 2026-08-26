- **Installed role briefs now point at each host's real skill location
  instead of a bare, host-agnostic path.** `roles/qa.md` (and `auditor.md`,
  `platform.md`, `security.md`) reference skills via a bare `` `skills/<name>/
  SKILL.md` `` path in their source, but every host installs the actual
  skill files under its own `capabilities.skillsDir` (`.claude/skills/`,
  `.openai-compat/skills/`, ...) — never bare `skills/` at the project root.
  A real `openai-compat` headless run had the dispatched QA agent's
  installed brief still pointing at the bare path: `installRoles()` in both
  `core/adapters/markdown-host.js` (5 hosts) and
  `hosts/claude-code/adapter.js` copied the brief text verbatim with zero
  rewriting, so every `read_file` for `skills/qa-test-authoring/SKILL.md`
  and `skills/qa-test-execution/SKILL.md` hit ENOENT even though the files
  were correctly installed at `.openai-compat/skills/qa-test-*/SKILL.md`.

  A new `withSkillsDir(body, skillsDir)` helper (`core/roles.js`) rewrites
  the bare path to the host's real `skillsDir` at install time; wired into
  both `installRoles()` implementations. `skillsDir` is null for hosts with
  no skills install step (generic) — those briefs are left unchanged, since
  there's nothing to point at instead.
