- **Principal role-brief prompts, escalation routing text, and direct stage
  dispatch now match the routed host instead of guessing.** A real
  `openai-compat` run had the dispatched Principal spend three failed
  `read_file` calls hunting for `.claude/agents/principal.md`,
  `.codex/prompts/roles/principal.md`, and `.gemini/prompts/roles/principal.md`
  — none of which exist under `openai-compat` — while its own correctly
  installed role brief sat untouched at
  `.openai-compat/prompts/roles/principal.md`. `renderPrincipalRulingPrompt`
  named exactly three hosts unconditionally; it now resolves the role-brief
  path for whichever host is actually routed to the `principal` role (or
  falls back to inline-brief wording for hosts with no separate file), the
  same way `renderStagePromptLayers` already does for stage prompts.

  Separately, the escalation-applicator prompt's routing table listed `qa` as
  both a bare stage name (stage-06, QA Testing) and a build workstream role
  with no disambiguation. A headless run ordered to fix a qa build blocker
  ran `devteam stage qa --headless` — dispatching stage-06 instead of
  `devteam stage build --workstream qa` — which advanced the pipeline right
  past a still-unresolved build escalation and left `devteam validate`
  reporting it as bypassed. The routing table now calls this out explicitly,
  mirroring the existing warning for the analogous `devteam restart qa`
  collision.

  `devteam stage <name>` also gained a guard: it now refuses to dispatch a
  stage strictly later than one still sitting on an unresolved `ESCALATE`
  gate, printing the escalating gate, its reason, and the exact commands to
  resolve it (`devteam ruling` → `devteam fix-escalation` → `devteam next`)
  instead of silently letting the pipeline skip past it. Scoped to `ESCALATE`
  only (not `FAIL`, so it doesn't interfere with the driver's own same-stage
  retry loop) and to strictly-later stages (so dispatching an earlier stage
  to fix the root cause of a later escalation — the documented recovery path
  — still works). `--force` bypasses it for intentional cases.
