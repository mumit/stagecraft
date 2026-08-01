# Stage 4 — Build (3 Devs, parallel via git worktrees)

Each dev works in its own worktree:
  `git worktree add ../dev-team-backend feature/backend`
  `git worktree add ../dev-team-frontend feature/frontend`
  `git worktree add ../dev-team-platform feature/platform`

Invoke in parallel:
  `dev-backend`  → `src/backend/`  → `pipeline/pr-backend.md`
  `dev-frontend` → `src/frontend/` → `pipeline/pr-frontend.md`
  `dev-platform` → `src/infra/` + root toolchain config → `pipeline/pr-platform.md`

Gate file per workstream: `pipeline/gates/stage-04.{area}.json`
All three must have `"status": "PASS"` before proceeding.

Pre-review checks (stage-04a) run after the three build gates PASS and
before Stage 5 starts. See `stage-04a.md` (lint + dep review + SCA) and
`stage-04b.md` (security review, conditional).

## Local Verification

Before writing the workstream gate, run lint and tests **through the project's
package-manager scripts**, not raw binaries:

```
npm run lint   # not: eslint src/  — the script must work, not just the binary
npm test       # not: node --test  — same command Stage 4a will run mechanically
```

**Why this matters**: Stage 4a re-runs these commands mechanically and fails the
pipeline if they exit non-zero. Self-attesting `lint_passed: true` after running
the binary directly (e.g. `npx eslint@8 src/`) while the npm script is broken or
missing produces a false PASS here and a hard blocker at Stage 4a. Fix any broken
or missing scripts before reporting the gate as PASS. The orchestrator also stamps
your own `lint_passed`/`tests_passed` on this workstream's gate directly (before
Stage 4a), so a false claim here is caught immediately, not two stages later.

If no lint or test script is defined yet (e.g. `package.json` has not been
created), create one as part of this workstream's deliverables — that is a
missing artifact, not a reason to skip verification.

Root package-manager scripts and shared toolchain config (`package.json`,
lockfiles, ESLint/TypeScript config, Docker/compose files) are platform-owned
unless the design spec or a Principal ruling assigns them elsewhere. If
Stage 4a fails because `npm run lint` is missing, dispatch the platform build
workstream to add the script/config, then rerun pre-review.

## Gate

Workstream gate files: `pipeline/gates/stage-04.<area>.json` (one per role).
Merged stage gate: `pipeline/gates/stage-04.json`.

```json
{
  "stage": "stage-04",
  "status": "PASS",
  "track": "full",
  "timestamp": "<ISO 8601>",
  "orchestrator": "devteam@<version>",
  "workstream": "backend | frontend | platform | qa",
  "host": "claude-code",
  "blockers": [],
  "warnings": [],
  "area": "backend | frontend | platform",
  "files_changed": ["src/backend/foo.js"],
  "pr_summaries_written": ["pipeline/pr-backend.md"],
  "local_verification": ["npm run lint — 0 errors", "npm test — 42 passed"]
}
```

All workstream gates must have `"status": "PASS"` before Stage 4a begins.
