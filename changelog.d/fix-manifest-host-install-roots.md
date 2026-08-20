- **Stagecraft's own install is no longer mistaken for the change under review.**
  Three separate readers — the changed-file manifest, right-sizing's role
  inference, and the file list `devteam assess` scores a track from — each
  carried their own copy of the "framework-owned path" prefix list, and all
  three had drifted the same way: they covered `.codex/` and no other host. A
  project initialized with any other host reported the framework's own install
  as the operator's diff until those files were committed. The list now lives
  once in `core/paths.js` as `FRAMEWORK_OWNED_PREFIXES` /
  `isFrameworkOwnedPath()`, covers every host surface (`.claude/`, `.acp/`,
  `.agents/`, `.omnigent/`, `.openai-compat/` alongside the existing entries),
  and matches on a full path segment so a project's own `.claude-notes/` or
  `src/agents/` is never swallowed.
- **Track inference no longer promotes a trivial change because of the
  framework's own filenames.** The leak above was not just prompt noise in
  `assess`: `.claude/skills/qa-test-authoring/SKILL.md` matches the security
  heuristic's `/auth/i` on the word "authoring", so the first run in a fresh
  claude-code project was promoted from `loop` (4 dispatches) to `full` (20+)
  and reported "security review required" for files Stagecraft had just written
  itself. On a sample project the assessed file count drops from 75 to 4 and the
  recommendation returns to `loop`. *Honest scope note:* only the path filter
  changed — the security heuristic itself is untouched, and a genuinely
  security-relevant project file such as `src/auth/session.js` still promotes to
  `full`, as does a changed `package.json`. A new drift-guard test reads every
  `hosts/*/capabilities.json` and fails when a declared `skillsDir` or
  `rolePromptsDir` root is missing from the shared list.
