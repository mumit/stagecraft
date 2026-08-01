"use strict";

// Stage ID → artifact paths relative to pipelineRoot(). (Phase 12.2, ADR-010)
//
// Gate files are NOT listed here — they are derived from stages.js and added
// unconditionally for PASS/WARN stages.
//
// Path conventions:
//   - Exact file: "brief.md"   → pipelineRoot/brief.md
//   - Directory:  "code-review/" → all direct-child files in that directory
//   - Glob:       "pr-*.md"    → files matching the pattern in pipelineRoot
//
// Stage-01 lists "brief.md"; in repair mode the caller substitutes "diagnosis.md"
// (read `intent` from run-state.json).
const STAGE_ARTIFACTS = {
  "stage-01": ["brief.md"],                    // requirements; repair → diagnosis.md
  "stage-02": ["design-spec.md"],              // design
  "stage-03": ["clarification-log.md"],        // clarification
  "stage-03b": ["spec.feature"],               // executable-spec / failing-first regression
  "stage-04": ["build-plan.md", "pr-*.md"],    // build; pr-*.md = per-role PR summaries
  "stage-04a": ["pre-review.md"],              // pre-review
  "stage-04b": ["security-review.md"],         // security-review (conditional on 04a flag)
  "stage-04c": ["red-team-report.md"],         // red-team
  "stage-04d": ["migration-safety.md"],        // migration-safety (conditional on 04a flag)
  "stage-04e": [],                             // preflight — gate-only (mechanical check)
  "stage-05": ["code-review/"],               // peer-review — directory of by-<reviewer>.md files
  "stage-06": ["test-report.md"],             // qa
  "stage-06b": ["accessibility-report.md"],   // accessibility-audit
  "stage-06c": ["observability-report.md"],   // observability-gate
  "stage-06d": ["verification-report.md"],    // verification-beyond-tests
  "stage-06e": ["performance-report.md"],     // performance-budget
  "stage-06x": ["verification-sweep-report.md", "axe-report.json", "lhci-result.json"], // verification-sweep (29.4 compact_qa fold)
  "stage-07": ["runbook.md"],                 // sign-off
  "stage-08": ["deploy-log.md"],              // deploy
  "stage-09": ["retrospective.md", "lessons-learned.md"], // retrospective
};

module.exports = { STAGE_ARTIFACTS };
