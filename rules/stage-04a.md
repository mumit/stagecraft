# Stage 4a — Pre-review gate (lint + dep review + SCA)

Invoke: `dev-platform` agent.
Scope: lint, dependency vulnerability scan, license
allowlist check, security and migration-safety trigger heuristics.
Output: `pipeline/gates/stage-04a.json`.
Gate key: `"status": "PASS"` with `"lint_passed": true`,
`"tests_passed": true`, and no `high`/`critical` SCA findings.

See `roles/platform.md` §"On a Pre-Review Task" for the
exact commands. On failure, the owning dev (identified from the failing
check) is re-invoked to fix. Stage 5 does not start until this gate
passes.

## Gate

Gate file: `pipeline/gates/stage-04a.json`.

```json
{
  "stage": "stage-04a",
  "status": "PASS | FAIL",
  "track": "full",
  "timestamp": "<ISO 8601>",
  "orchestrator": "devteam@<version>",
  "workstream": "platform",
  "host": "claude-code",
  "blockers": [],
  "warnings": [],
  "lint_passed": true,
  "type_check_passed": true,
  "tests_passed": true,
  "sca_findings": { "high": 0, "critical": 0 },
  "dependency_review_passed": true,
  "license_check_passed": true,
  "license_findings": [],
  "security_review_required": false,
  "migration_safety_required": false
}
```

`license_check_passed` is orchestrator-stamped for Node projects (C3):
- `true` — no denied licenses found across installed `node_modules/`.
- `false` — at least one package carries a strong-copyleft license (GPL-*, LGPL-*, AGPL-*);
  a `blockers[]` entry names the offending packages. The model's claim is overridden.
- `"unverified-by-orchestrator"` — the project has no `package.json` (non-Node stack)
  or `node_modules/` is not installed; the orchestrator cannot verify the scan
  mechanically. A `warnings[]` entry explains why. The model's assertion stands but
  is explicitly labeled unverified.

`policy: "warned"` entries (UNLICENSED, SSPL, BUSL, unknown) do not block — they
appear in `warnings[]`. `license_findings` only records non-allowed packages.
Packages on the default permissive list (MIT, Apache-2.0, BSD-*, ISC, CC0-1.0,
0BSD, Unlicense) are omitted. Projects may extend the allowed list via
`.devteam/config.yml` `license.extra_allowed[]`.

`dependency_review_passed` is **model-asserted by design**: vulnerability scanning
(npm audit, pip-audit, cargo-audit) requires toolchain availability and a current
advisory database that the orchestrator cannot access offline. The orchestrator
verifies license compliance mechanically; CVE scan results are reported by the
platform agent and confirmed in human review at Stage 5.

Security and migration content heuristics scan added lines from the working-tree,
staged, or most recent build commit diff. Path triggers remain conservative and
always apply. Untracked/non-Git files fall back to a full-file scan. This keeps a
historical bcrypt example or DDL snippet from launching a conditional review when
an unrelated line in the same file changes, without suppressing newly added risk.
