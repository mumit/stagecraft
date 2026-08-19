---
name: platform-pre-review
description: "Platform Developer: Stage 4a pre-review task. Run lint, type-check, SCA, license check, security trigger, and hygiene checks. Produce pipeline/gates/stage-04a.json."
---

# Platform Pre-Review Task (Stage 4a)

Use this skill when you are the Platform Developer executing the Stage 4a
pre-review gate — after all Stage 4 build gates pass and before Stage 5
peer review starts.

## Procedure

1. `npm run lint` (or the project's equivalent) — must exit 0.
2. The project's type-check command if one is configured (e.g. `tsc --noEmit` for TypeScript projects) — must exit 0.
3. Dependency vulnerability scan: `npm audit --audit-level=high` (or
   `pip-audit`, `bundler-audit`, etc. per stack). Any `high` or
   `critical` finding halts.
4. **License compatibility check.** For every new or changed direct dependency
   (compare `package.json` / `requirements.txt` / `Cargo.toml` before and
   after the PR), determine its declared SPDX license and classify it:

   - **Allowed** (record nothing): MIT, Apache-2.0, BSD-2-Clause, BSD-3-Clause,
     ISC, CC0-1.0, 0BSD, Unlicense, CC-BY-4.0, Python-2.0, PSF-2.0.
   - **Warned** (record with `policy: "warned"`): UNLICENSED, unknown,
     proprietary, SSPL-1.0, BUSL-1.1. These require a human review before
     merge; record in `license_findings[]` and add a `warnings[]` entry.
   - **Denied** (record with `policy: "denied"`): any GPL-2.0, GPL-3.0,
     LGPL-2.0, LGPL-2.1, LGPL-3.0, AGPL-3.0, or strong-copyleft variant.
     Copyleft licenses require distributing source and are incompatible with
     most commercial projects unless a legal exception is documented. A denied
     finding sets `license_check_passed: false` and adds a `blockers[]` entry.

   **How to check:**
   ```bash
   # Node.js — use npx if license-checker is not installed globally
   npx license-checker --direct --json 2>/dev/null | jq 'to_entries[] | {package: .key, license: .value.licenses}'
   # Python
   pip-licenses --format=json --with-license-file 2>/dev/null
   # Rust
   cargo license --json 2>/dev/null
   ```
   If no automated tool is available, manually inspect each new dependency's
   `LICENSE` file or package metadata. When the license field is missing or
   ambiguous, classify as `warned`.

   If the project has a `.devteam/config.yml` `license.extra_allowed` list,
   include those SPDX identifiers as allowed. Example config override:
   ```yaml
   license:
     extra_allowed: ["LGPL-2.1"]  # approved by legal on 2026-05-01
   ```

   Record only non-allowed packages in `license_findings[]`. Set
   `license_check_passed: true` when no findings have `policy: "denied"`;
   set it `false` if any do.
5. Apply the trigger heuristics:

   ```bash
   node core/guards/security-heuristic.js <changed-files>
   node core/guards/migration-heuristic.js <changed-files>
   ```

   Both scanners always apply path rules, then inspect added lines rather than
   the full historical body of an edited file. Record
   `"security_review_required": true | false` and
   `"migration_safety_required": true | false` in the Stage 4a gate.

6. **Platform hygiene checks** — these catch problems that reviewers consistently
   flag in Stage 5 and that have clear, mechanical fixes:

   a. **Runtime engine constraint.** If any ADR specifies a minimum runtime
      version (e.g., "Node.js LTS v22+"), verify `package.json` carries a
      matching `"engines"` field:
      ```json
      { "engines": { "node": ">=22" } }
      ```
      Missing or wrong `engines` when an ADR requires it → BLOCKER in the
      Stage 4a gate; the ADR is unenforceable without it.

   b. **Test coverage output in `.gitignore`.** If the project's test runner is
      configured to write a coverage directory (`collectCoverage`, `coverageDirectory`,
      or equivalent), verify `.gitignore` excludes it. A coverage directory not
      in `.gitignore` will be committed by accident and diverge across branches.
      Missing `.gitignore` entry → BLOCKER.

   c. **Duplicate config files.** If the same tool has config at more than one
      path (e.g., both `.eslintrc.js` at root and `src/infra/eslint.config.js`),
      both must be documented and cross-referenced, or one must be deleted. An
      undocumented duplicate with diverging settings silently affects different
      parts of the codebase differently. Undocumented duplicate → BLOCKER.

   d. **`package.json bin` target exists and is owned.** If `package.json` has a
      `bin` field, verify the target file path exists in the project AND that it
      is listed under exactly one workstream's area in the design spec's
      `## File Ownership` table. A `bin` target pointing to a file not in any
      workstream's `files_written[]` is a dead entry — record as BLOCKER.

Capture output to `pipeline/lint-output.txt` and `pipeline/pre-review-output.txt`.
Write `pipeline/gates/stage-04a.json`:

```json
{
  "stage": "stage-04a",
  "status": "PASS" | "FAIL",
  "workstream": "platform",
  "timestamp": "<ISO>",
  "track": "<track>",
  "lint_passed": true,
  "tests_passed": true,
  "type_check_passed": true,
  "sca_findings": { "high": 0, "critical": 0 },
  "dependency_review_passed": true,
  "license_check_passed": true,
  "license_findings": [],
  "security_review_required": false,
  "blockers": [],
  "warnings": []
}
```

**Orchestrator-stamped fields.** The orchestrator runs the configured lint
and test commands itself after this stage and overwrites `lint_passed` and
`tests_passed` based on what it actually observes (exit code 0 vs non-zero).
The stamp records the result in `_orchestrator_stamped` for audit. If
your assertion disagrees with what the orchestrator observes (e.g., you
wrote `lint_passed: true` but the lint command returns non-zero), the
orchestrator's truth wins and the gate's status flips to FAIL. Be
honest in your initial write — `devteam verify stage-04a` will catch a
lie, and the audit trail will record both your claim and the override.

If any check fails, the owning dev is invoked to fix. Stage 5 peer review
does not start until this gate passes.

Rationale: a reviewer reading code that doesn't even lint is wasting tokens
on problems the toolchain already knows about.
