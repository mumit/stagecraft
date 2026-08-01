# Stage 6x — Verification sweep (compact-QA fold; tracks: quick)

29.4 — combined dispatch for `compact_qa`-flagged tracks. Folds whichever of
accessibility-audit (6b), observability-gate (6c), verification-beyond-tests (6d),
and performance-budget (6e) the track includes into one dispatch instead of one
per stage. Full and hotfix are untouched — they aren't flagged `compact_qa`, so
they keep running 6b/6c/6d/6e as separate stages with their own gates.

Invoke: `qa` agent. Runs AFTER stage-06 (QA) PASS.
Input: `pipeline/brief.md`, `pipeline/design-spec.md`, `pipeline/test-report.md`.
Output: `pipeline/verification-sweep-report.md`.

On `quick`, exactly two sections apply: **accessibility** and **performance**
(the same coverage `quick` had before folding — see `rules/stage-06b.md` and
`rules/stage-06e.md` for the section-specific procedure and PASS/FAIL bar).
Leave `observability` and `verification_beyond_tests` null; do not list them
in `sections_included` on this track.

## Gate

Gate file: `pipeline/gates/stage-06x.json`.

```json
{
  "stage": "stage-06x",
  "status": "PASS | FAIL",
  "track": "quick",
  "timestamp": "<ISO 8601>",
  "orchestrator": "devteam@<version>",
  "blockers": [],
  "warnings": [],
  "sections_included": ["accessibility", "performance"],
  "accessibility": {
    "audit_method": "axe-core | pa11y | lighthouse | manual",
    "wcag_level": "AA",
    "violations": { "critical": 0, "serious": 0, "moderate": 0, "minor": 0 },
    "components_audited": [],
    "audit_skipped_reason": null
  },
  "observability": null,
  "verification_beyond_tests": null,
  "performance": {
    "checks_performed": ["lighthouse", "bundle", "load_test"],
    "lighthouse": null,
    "bundle": null,
    "load_test": null,
    "budget_exceeded": false,
    "skipped_reason": null
  }
}
```

Each populated section uses the identical shape as its standalone schema
(`stage-06b`/`stage-06c`/`stage-06d`/`stage-06e`) — this is a track-shape
change, not a new gate vocabulary. FAIL the whole gate if any included
section would itself FAIL standalone (any accessibility critical/serious
violation, any exceeded performance budget).
