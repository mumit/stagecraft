# Stage 6d — Verification beyond tests (tracks: full)

Invoke: `verifier` agent. Runs AFTER stage-06 (QA) PASS — tests are the
floor, this stage raises the ceiling.
Input: `pipeline/brief.md`, `pipeline/design-spec.md`, `pipeline/spec.feature`,
`pipeline/test-report.md`, `pipeline/red-team-report.md`.
Output: `pipeline/verification-report.md`.
## Gate

Gate file: `pipeline/gates/stage-06d.json`.

```json
{
  "stage": "stage-06d",
  "status": "PASS | FAIL",
  "track": "full",
  "timestamp": "<ISO 8601>",
  "orchestrator": "devteam@<version>",
  "blockers": [],
  "warnings": [],
  "methods_attempted": ["property-based", "mutation"],
  "methods_skipped": [{ "method": "formal", "reason": "No safety invariants stated in design-spec" }],
  "candidates_inventoried": 12,
  "property_based": null,
  "mutation": null,
  "formal": null,
  "findings_count": 0,
  "blocking_findings": [],
  "non_blocking_findings": []
}
```

PASS when `blocking_findings` is empty. A counterexample from property-based testing,
a surviving mutant on a critical path, or a formal counterexample to a stated safety
property all produce blocking findings. When the changed code has no viable surface for
deep verification (e.g. pure UI styling), the agent sets `methods_skipped` with reasons
and gates PASS.

**Read-only on production code.** Writes only `pipeline/verification-report.md`,
`pipeline/gates/stage-06d.json`, `pipeline/context.md`, `src/tests/property/`, and
`pipeline/formal/` (verification artefacts).

See `skills/verification-beyond-tests/SKILL.md` for the full method catalogue:
property-based testing (fast-check / Hypothesis), mutation testing (Stryker), and
formal methods (TLA+, Alloy), plus the decision matrix for choosing methods given
the change surface.

**Orchestrator-verified (phase 35.3).** `methods_attempted[]` is no longer purely
model-asserted: for each bare method tag claimed here, the orchestrator tries to
produce real executable evidence (`core/verify/stamp.js#stampStage06d`) before the
gate is accepted. A claim with no executable evidence is downgraded to
`attempted_but_blocked:<method>` — write an honest `methods_skipped` entry instead
if a method genuinely doesn't apply, rather than claiming it and hoping. See
[docs/verification-beyond-tests.md](../docs/verification-beyond-tests.md#orchestrator-verified-stamping-stage-06d).
