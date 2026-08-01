// Stage definitions for the stagecraft pipeline.
//
// Each stage carries `roles: string[]` (1+). The orchestrator decomposes
// multi-role stages into one workstream dispatch per role; single-role
// stages produce a single dispatch (same code path).
//
// Numbering: 1=requirements, 2=design, 3=clarify, 4=build, 4a=pre-review,
// 4b=security review, 5=peer-review (per-area), 6=tests, 7=sign-off,
// 8=deploy, 9=retro.
//
// Paths are host-neutral. Host adapters rewrite `readFirst` at
// renderStagePrompt time (e.g. AGENTS.md → CLAUDE.md for Claude Code).
// `gate` is the stage-specific skeleton shown to the LLM in the stage
// prompt; base fields (stage, status, orchestrator, track, timestamp,
// blockers, warnings) are filled by the orchestrator at write time.

const STAGES = {
  requirements: {
    stage: "stage-01",
    roles: ["pm"],
    objective: "Turn the feature request into requirements, acceptance criteria, and scope boundaries.",
    readFirst: ["AGENTS.md", ".devteam/rules/pipeline.md", ".devteam/rules/gates-core.md", "pipeline/context.md"],
    allowedWrites: ["pipeline/brief.md", "pipeline/gates/stage-01.json", "pipeline/context.md"],
    artifact: "pipeline/brief.md",
    template: "brief-template.md",
    gate: {
      acceptance_criteria_count: 0,
      out_of_scope_items: [],
      required_sections_complete: false,
      // null = all roles active; explicit list suppresses excluded workstreams
      // from both build (stage-04) and peer-review (stage-05) dispatch.
      active_roles: null,
    },
    // 29.1: the `loop` track swaps in a one-screen brief (intent, AC-N list,
    // affected files) instead of the full requirements template. Same stage,
    // same gate shape — only the artifact template changes. Keyed by track
    // name so buildDescriptor() can merge it the same way repairOverride merges
    // on intent.
    trackOverrides: {
      loop: {
        template: "loop-brief-template.md",
      },
    },
    // ADR-009 Phase 2: when intent === "repair", stage-01 produces a DIAGNOSIS
    // instead of a feature brief — same stage, same gate path, fix-aware artifact.
    // The gate is always ESCALATE (judgment gate) until approved via the typed
    // escalation contract (--auto-rule diagnosis-approved or standing grant).
    repairOverride: {
      objective: "Diagnose the reported bug: identify the root cause with specific file:line references, propose a targeted fix, enumerate every file the fix must touch (the structural scope contract for the build), and define a regression criterion the executable-spec stage can translate into a runnable test.",
      readFirst: ["AGENTS.md", ".devteam/rules/pipeline.md", ".devteam/rules/gates-core.md", "pipeline/context.md"],
      allowedWrites: ["pipeline/diagnosis.md", "pipeline/gates/stage-01.json", "pipeline/context.md"],
      artifact: "pipeline/diagnosis.md",
      template: "diagnosis-template.md",
      gate: {
        root_cause: "",
        proposed_fix: "",
        affected_files: [],
        regression_criterion: "",
        diagnosis_confirmed: false,
        // ESCALATE semantics: the diagnosis is always a judgment gate.
        // The driver advances past it via --auto-rule diagnosis-approved
        // (autonomous) or a human ruling (interactive).
        escalation_reason: "Diagnosis requires human (or --auto-rule diagnosis-approved) confirmation before the build proceeds",
        decision_needed: "Is the root cause correct, the fix targeted, and the affected-files list complete?",
      },
    },
  },
  design: {
    stage: "stage-02",
    roles: ["principal"],
    // G8 — architectural continuity. Principal queries org-shared
    // memory for prior ADRs before designing. The role brief
    // (roles/principal.md) walks the procedure; the gate records
    // which ADRs were consulted (adrs_consulted) and which were
    // explicitly superseded (adrs_superseded) so future audits can
    // verify the architecture didn't silently drift.
    objective: "Convert approved requirements into an implementable architecture and explicit decisions. Consult org-shared ADRs from prior projects before drafting; honor or explicitly supersede prior commitments.",
    readFirst: ["AGENTS.md", ".devteam/rules/pipeline.md", ".devteam/rules/gates-core.md", "pipeline/context.md", "pipeline/brief.md"],
    allowedWrites: ["pipeline/design-spec.md", "pipeline/adr/", "pipeline/design-review-notes.md", "pipeline/gates/stage-02.json", "pipeline/context.md"],
    artifact: "pipeline/design-spec.md",
    template: "design-spec-template.md",
    gate: {
      arch_approved: false,
      pm_approved: false,
      adr_count: 0,
      adrs_consulted: [],
      adrs_superseded: [],
      file_ownership: {},
    },
  },
  clarification: {
    stage: "stage-03",
    roles: ["pm"],
    objective: "Resolve open questions from requirements and design before implementation starts.",
    readFirst: ["AGENTS.md", ".devteam/rules/pipeline.md", ".devteam/rules/gates-core.md", "pipeline/context.md", "pipeline/brief.md", "pipeline/design-spec.md"],
    allowedWrites: ["pipeline/clarification-log.md", "pipeline/gates/stage-03.json", "pipeline/context.md"],
    artifact: "pipeline/clarification-log.md",
    template: "clarification-template.md",
    gate: {
      open_questions_count: 0,
      answered_questions_count: 0,
      scope_changed: false,
    },
  },
  // G2 — closed-loop AC → exec spec → tests. Authored by PM after
  // clarification but before build. The artifact (pipeline/spec.feature)
  // is the canonical bridge between brief.md acceptance criteria and
  // QA's tests: every AC-N in brief.md maps to one Scenario tagged
  // @AC-N in the .feature file, and QA's stage-06 mapping must in
  // turn map each Scenario to a test. Drift between the three is
  // detected by `devteam spec verify` and surfaced via the gate's
  // `drift` field. The stage shares the `pm` role rather than
  // introducing a new one — the same brain that authored ACs is the
  // right brain to translate them into scenarios.
  "executable-spec": {
    stage: "stage-03b",
    roles: ["pm"],
    objective: "Translate the brief's numbered acceptance criteria into Gherkin scenarios (one Scenario per AC-N, tagged @AC-N). Verify zero drift between brief.md, spec.feature, and any test references. The .feature file becomes the canonical contract that QA's tests must map to.",
    readFirst: ["AGENTS.md", ".devteam/rules/pipeline.md", ".devteam/rules/gates-core.md", "pipeline/context.md", "pipeline/brief.md", "pipeline/design-spec.md", "pipeline/clarification-log.md"],
    allowedWrites: ["pipeline/spec.feature", "pipeline/gates/stage-03b.json", "pipeline/context.md"],
    artifact: "pipeline/spec.feature",
    template: "spec-template.feature",
    gate: {
      criteria_count: 0,
      scenarios_count: 0,
      criteria_to_scenario_mapping: [],
      all_criteria_mapped: false,
      orphan_scenarios: [],
      orphan_criteria: [],
      drift: false,
    },
    // ADR-009 Phase 3: when intent === "repair", stage-03b becomes a failing-first
    // reproduction gate. The PM authors a regression scenario that is RED before
    // the build applies the fix and GREEN after. Bugs that cannot be expressed as
    // a runnable test (external API / nondeterminism / data dependency) are stamped
    // with the tri-state `reproduced: "unverifiable: <reason>"` — never silent-pass.
    // The build stage writes the failing test code first, then the fix; stamp.js
    // verifies green-after at stage-04a time and finalizes `reproduced` on this gate.
    repairOverride: {
      objective: "Author a failing-first regression scenario for the reported bug. Write a Gherkin Scenario that exercises the defect so the build's regression test will be RED before the fix and GREEN after. Read pipeline/diagnosis.md for the regression criterion. Set gate.reproduced = true when you can write a runnable test, false when you cannot reproduce the defect at all, or \"unverifiable: <reason>\" when the bug cannot be expressed as an automated test (external API / nondeterminism / data dependency). Never omit the reproduced field. The build stage will write the failing test code first, then the fix.",
      readFirst: ["AGENTS.md", ".devteam/rules/pipeline.md", ".devteam/rules/gates-core.md", "pipeline/context.md", "pipeline/diagnosis.md"],
      gate: {
        criteria_count: 0,
        scenarios_count: 0,
        criteria_to_scenario_mapping: [],
        all_criteria_mapped: false,
        orphan_scenarios: [],
        orphan_criteria: [],
        drift: false,
        // Tri-state: true = reproducible, false = cannot reproduce,
        // "unverifiable: <reason>" = automated test impossible.
        // Orchestrator stamp at stage-04a finalizes this from observed test results.
        reproduced: false,
      },
    },
  },
  build: {
    stage: "stage-04",
    roles: ["backend", "frontend", "platform", "qa"],
    objective: "Implement the approved design in role-owned workstreams and record local verification.",
    readFirst: ["AGENTS.md", ".devteam/rules/pipeline.md", ".devteam/rules/gates-core.md", "pipeline/context.md", "pipeline/brief.md", "pipeline/design-spec.md"],
    allowedWrites: ["src/backend/", "src/frontend/", "src/infra/", "src/tests/", "pipeline/pr-*.md", "pipeline/build-plan.md", "pipeline/gates/stage-04.*.json", "pipeline/gates/stage-04.json", "package.json", "package-lock.json", "Dockerfile", "docker-compose.yml", "docker-compose.yaml", "eslint.config.js", "eslint.config.mjs", ".eslintrc.cjs", ".eslintrc.js", ".eslintrc.mjs", ".eslintrc.json", "tsconfig.json", "tsconfig.test.json", "tsconfig.*.json"],
    roleWrites: {
      backend:  ["src/backend/", "src/tests/", "pipeline/pr-backend.md",  "pipeline/build-plan.md", "pipeline/gates/stage-04.backend.json", "package.json", "package-lock.json", "Dockerfile", "docker-compose.yml", "docker-compose.yaml", "eslint.config.js", "eslint.config.mjs", ".eslintrc.cjs", ".eslintrc.js", ".eslintrc.mjs", ".eslintrc.json", "tsconfig.json", "tsconfig.test.json", "tsconfig.*.json"],
      frontend: ["src/frontend/",               "pipeline/pr-frontend.md", "pipeline/build-plan.md", "pipeline/gates/stage-04.frontend.json"],
      platform: ["src/infra/",                  "pipeline/pr-platform.md", "pipeline/build-plan.md", "pipeline/gates/stage-04.platform.json", "package.json", "package-lock.json", "Dockerfile", "docker-compose.yml", "docker-compose.yaml", "eslint.config.js", "eslint.config.mjs", ".eslintrc.cjs", ".eslintrc.js", ".eslintrc.mjs", ".eslintrc.json", "tsconfig.json", "tsconfig.test.json", "tsconfig.*.json"],
      qa:       ["src/tests/",                  "pipeline/pr-qa.md",                                  "pipeline/gates/stage-04.qa.json"],
    },
    artifact: "pipeline/build-plan.md",
    template: "build-template.md",
    goalCondition: "pipeline/gates/{workstreamId}.json exists with status: \"PASS\", lint_passed: true, and tests_passed: true",
    gate: {
      pr_summaries_written: [],
      local_verification: [],
    },
  },
  "pre-review": {
    stage: "stage-04a",
    roles: ["platform"],
    objective: "Run lint, tests, dependency/license review, and trigger checks for security review (stage-04b) + migration safety (stage-04d) before peer review.",
    readFirst: ["AGENTS.md", ".devteam/rules/pipeline.md", ".devteam/rules/gates-core.md", "pipeline/context.md", "pipeline/build-plan.md", "pipeline/pr-*.md"],
    allowedWrites: ["pipeline/pre-review.md", "pipeline/lint-output.txt", "pipeline/pre-review-output.txt", "pipeline/gates/stage-04a.json"],
    artifact: "pipeline/pre-review.md",
    template: "pre-review-template.md",
    requiredCapabilities: { shell: true },
    gate: {
      lint_passed: false,
      tests_passed: false,
      dependency_review_passed: false,
      license_check_passed: false,
      license_findings: [],
      security_review_required: false,
      migration_safety_required: false,
    },
  },
  "security-review": {
    stage: "stage-04b",
    roles: ["security"],
    // Conditional stage. The orchestrator (in next()) reads
    // stage-04a's gate; runs this only when
    // security_review_required === true. Otherwise it's skipped
    // silently and the pipeline advances to peer-review.
    conditionalOn: { stage: "stage-04a", field: "security_review_required", equals: true },
    objective: "Security review of changes flagged by the Stage 4a security-trigger heuristic. Has veto power; a FAIL here halts the pipeline regardless of peer-review outcomes.",
    readFirst: ["AGENTS.md", ".devteam/rules/pipeline.md", ".devteam/rules/gates-core.md", "pipeline/context.md", "pipeline/pre-review.md", "pipeline/build-plan.md", "pipeline/pr-*.md"],
    allowedWrites: ["pipeline/security-review.md", "pipeline/gates/stage-04b.json"],
    artifact: "pipeline/security-review.md",
    template: "review-template.md",
    gate: {
      security_approved: false,
      veto: false,
      triggering_conditions: [],
      noted_for_followup: [],
    },
  },
  "red-team": {
    stage: "stage-04c",
    roles: ["red-team"],
    // Driver writes a stub gate before dispatching and detects whether the LLM
    // overwrote it. If not (context exhausted before gate write), the dispatch is
    // classified as transient rather than structural-input. See driver.js §stub-gate.
    preSeedGate: true,
    // Always runs on tracks where it's included (full + hotfix). Not
    // conditional like stage-04b — the goal is uniform adversarial
    // coverage on non-trivial changes. Lighter tracks (quick / nano /
    // config-only / dep-update) skip stage-04c by design.
    //
    // Diversity matters: route red-team to a different host than the
    // builders (`routing.roles.red-team` in .devteam/config.yml).
    objective: "Adversarial review of what was just built. Enumerate concrete attack scenarios, hostile inputs, race conditions, abuse cases, scale failures, downstream effects, and observability gaps the spec didn't cover. Produces must-fix items the implementer addresses before Stage 5 peer review begins.",
    readFirst: ["AGENTS.md", ".devteam/rules/pipeline.md", ".devteam/rules/gates-core.md", "pipeline/context.md", "pipeline/brief.md", "pipeline/design-spec.md", "pipeline/pr-*.md", "pipeline/pre-review.md", "pipeline/security-review.md"],
    allowedWrites: ["pipeline/red-team-report.md", "pipeline/gates/stage-04c.json"],
    artifact: "pipeline/red-team-report.md",
    template: "red-team-report-template.md",
    gate: {
      surfaces_walked: [],
      findings_count: 0,
      severity_breakdown: { critical: 0, high: 0, medium: 0, low: 0 },
      must_address_before_peer_review: [],
      noted_for_followup: [],
    },
  },
  "migration-safety": {
    stage: "stage-04d",
    roles: ["migrations"],
    // Conditional stage — fires when stage-04a's pre-review heuristic
    // sets migration_safety_required: true (data-layer changes in the
    // diff: schema files, migration directories, ALTER/CREATE/DROP TABLE
    // DDL, ORM migration files). When the heuristic doesn't fire, this
    // stage is skipped silently and the pipeline advances to peer-review.
    //
    // Has veto power like stage-04b security: a migration without a
    // tested rollback halts the pipeline regardless of any other
    // approval. Backfill plans + dual-write strategies + rollback paths
    // are not optional on changes that touch persistent state.
    conditionalOn: { stage: "stage-04a", field: "migration_safety_required", equals: true },
    objective: "Review the migration-safety story for data-layer changes: schema diff, backfill plan, dual-write strategy, rollback plan, and breaking-change blast radius. Has veto power on unsafe migrations.",
    readFirst: ["AGENTS.md", ".devteam/rules/pipeline.md", ".devteam/rules/gates-core.md", "pipeline/context.md", "pipeline/brief.md", "pipeline/design-spec.md", "pipeline/pre-review.md", "pipeline/pr-*.md"],
    allowedWrites: ["pipeline/migration-safety.md", "pipeline/gates/stage-04d.json"],
    artifact: "pipeline/migration-safety.md",
    template: "migration-safety-template.md",
    gate: {
      migration_files: [],
      schema_changes_summary: "",
      breaking_change: false,
      backfill_required: false,
      backfill_strategy: "",
      dual_write_required: false,
      dual_write_strategy: "",
      rollback_plan: "",
      rollback_tested: false,
      migration_approved: false,
      veto: false,
      triggering_conditions: [],
    },
  },
  // stage-04e: mechanical pre-peer-review gate. No LLM dispatch — runs
  // as a Node.js script via `devteam preflight` or automatically at the
  // start of `devteam stage peer-review`. Checks git hygiene, test import
  // paths, and deferred red-team item count. roles: [] signals to the
  // orchestrator that this stage is not LLM-dispatched.
  preflight: {
    stage: "stage-04e",
    roles: [],
    objective: "Mechanical pre-peer-review checks: committed-but-ignored files, broken test import paths, deferred red-team item count. Runs as a script, not an LLM dispatch.",
    readFirst: [],
    allowedWrites: ["pipeline/gates/stage-04e.json"],
    gate: {
      git_hygiene_pass: false,
      import_path_pass: false,
      deferred_items_count: 0,
      callerless_file_check_pass: true,
      adr_compliance_pass: true,
    },
  },
  "peer-review": {
    stage: "stage-05",
    // Workstreams are AREAS being reviewed, not the role doing the
    // reviewing. The dispatched subagent is `reviewer` for all of them
    // (see `subagent` override below). The approval-derivation
    // PostToolUse hook fills each area's workstream gate by parsing
    // per-area "## Review of X" sections in by-<reviewer>.md files.
    roles: ["backend", "frontend", "platform", "qa"],
    subagent: "reviewer",
    objective: "Review peer implementation per area; record findings in pipeline/code-review/by-<reviewer>.md; the approval-derivation hook fills the per-area workstream gates.",
    readFirst: ["AGENTS.md", ".devteam/rules/pipeline.md", ".devteam/rules/gates-core.md", "pipeline/context.md", "pipeline/pr-*.md"],
    allowedWrites: ["pipeline/code-review/by-<reviewer>.md", "pipeline/gates/stage-05.*.json", "pipeline/gates/stage-05.json"],
    artifact: "pipeline/code-review/by-<reviewer>.md",
    template: "review-template.md",
    gate: {
      review_shape: "matrix",
      required_approvals: 2,
      approvals: [],
      changes_requested: [],
      escalated_to_principal: false,
    },
  },
  qa: {
    stage: "stage-06",
    roles: ["qa"],
    objective: "Verify every acceptance criterion with a one-to-one test mapping and report results. When stage-03b has run, every Scenario in pipeline/spec.feature must also map to at least one test — the AC→Scenario→test chain is the G2 contract.",
    readFirst: ["AGENTS.md", ".devteam/rules/pipeline.md", ".devteam/rules/gates-core.md", "pipeline/context.md", "pipeline/brief.md", "pipeline/design-spec.md", "pipeline/spec.feature"],
    allowedWrites: ["src/tests/", "pipeline/test-report.md", "pipeline/gates/stage-06.json"],
    artifact: "pipeline/test-report.md",
    template: "test-report-template.md",
    requiredCapabilities: { shell: true },
    goalCondition: "pipeline/gates/{workstreamId}.json exists with status: \"PASS\", all_acceptance_criteria_met: true, and tests_failed: 0",
    gate: {
      all_acceptance_criteria_met: false,
      tests_total: 0,
      tests_passed: 0,
      tests_failed: 0,
      failing_tests: [],
      criterion_to_test_mapping_is_one_to_one: false,
      scenarios_total: 0,
      scenarios_covered: 0,
      all_scenarios_have_tests: false,
      noted_for_followup: [],
    },
  },
  "accessibility-audit": {
    stage: "stage-06b",
    roles: ["qa"],
    objective: "Audit UI changes for WCAG accessibility violations using axe-core / pa11y / lighthouse. PASS requires zero critical + zero serious findings.",
    readFirst: ["AGENTS.md", ".devteam/rules/pipeline.md", ".devteam/rules/gates-core.md", "pipeline/context.md", "pipeline/brief.md", "pipeline/design-spec.md", "pipeline/test-report.md"],
    allowedWrites: ["pipeline/accessibility-report.md", "pipeline/axe-report.json", "pipeline/gates/stage-06b.json"],
    artifact: "pipeline/accessibility-report.md",
    template: "test-report-template.md",
    gate: {
      audit_method: null,
      wcag_level: "AA",
      violations: { critical: 0, serious: 0, moderate: 0, minor: 0 },
      components_audited: [],
      audit_skipped_reason: null,
      noted_for_followup: [],
    },
  },
  "observability-gate": {
    stage: "stage-06c",
    roles: ["platform"],
    objective: "Verify that every metric / log / trace the design-spec promised is actually emitted by the shipped code. Closes the gap where designs claim instrumentation that never lands.",
    readFirst: ["AGENTS.md", ".devteam/rules/pipeline.md", ".devteam/rules/gates-core.md", "pipeline/context.md", "pipeline/brief.md", "pipeline/design-spec.md", "pipeline/test-report.md"],
    allowedWrites: ["pipeline/observability-report.md", "pipeline/gates/stage-06c.json"],
    artifact: "pipeline/observability-report.md",
    template: "test-report-template.md",
    gate: {
      metrics: { required: [], verified: [], gap: [] },
      logs: { required: [], verified: [], gap: [] },
      traces: { required: [], verified: [], gap: [] },
      verification_method: null,
    },
  },
  // G7 — verification beyond tests. Runs AFTER stage-06 (qa) PASS:
  // "tests pass" is the floor, this stage raises the ceiling. Verifier
  // role applies property-based testing, mutation testing, and/or
  // formal verification to the changed code. Blocking findings (a
  // surviving mutant on a critical path, a property counterexample to
  // a stated invariant, a formal counterexample to a safety property)
  // halt sign-off. Read-only on production code; writes verification
  // artefacts + the gate. Track inclusion: full only — the heavy stuff
  // belongs on the track that explicitly opted into rigour-over-speed.
  "verification-beyond-tests": {
    stage: "stage-06d",
    roles: ["verifier"],
    objective: "Apply property-based testing, mutation testing, and/or formal verification to the changed code. Run AFTER stage-06 (qa) PASS — tests are the floor, this stage raises the ceiling. Surface counterexamples + surviving mutants + invariant violations as blocking findings.",
    readFirst: ["AGENTS.md", ".devteam/rules/pipeline.md", ".devteam/rules/gates-core.md", "pipeline/context.md", "pipeline/brief.md", "pipeline/design-spec.md", "pipeline/spec.feature", "pipeline/test-report.md", "pipeline/red-team-report.md"],
    allowedWrites: ["pipeline/verification-report.md", "pipeline/gates/stage-06d.json", "src/tests/property/", "pipeline/formal/", "pipeline/reports/"],
    artifact: "pipeline/verification-report.md",
    template: "verification-report-template.md",
    requiredCapabilities: { shell: true },
    gate: {
      methods_attempted: [],
      methods_skipped: [],
      candidates_inventoried: 0,
      property_based: null,
      mutation: null,
      formal: null,
      findings_count: 0,
      blocking_findings: [],
      non_blocking_findings: [],
    },
  },
  // B2 — performance budget gate. Runs AFTER stage-06 (qa) PASS on
  // full + quick + hotfix. QA role measures Lighthouse scores, bundle
  // size delta, and k6 load-test throughput against configured budgets.
  // A single exceeded budget flips the gate to FAIL. When the change
  // has no relevant surface (backend-only with no load concern, doc-only)
  // the agent sets skipped_reason and status PASS. Budget thresholds
  // come from the project's performance.budget.json or .devteam/config.yml;
  // the skill walks sensible defaults when neither file exists.
  "performance-budget": {
    stage: "stage-06e",
    roles: ["qa"],
    objective: "Measure Lighthouse performance scores, bundle size delta, and load-test throughput against project budgets. FAIL if any budget is exceeded. PASS (with skipped_reason) when the change has no performance-relevant surface.",
    readFirst: ["AGENTS.md", ".devteam/rules/pipeline.md", ".devteam/rules/gates-core.md", "pipeline/context.md", "pipeline/brief.md", "pipeline/design-spec.md", "pipeline/test-report.md"],
    allowedWrites: ["pipeline/performance-report.md", "pipeline/lhci-result.json", "pipeline/gates/stage-06e.json"],
    artifact: "pipeline/performance-report.md",
    template: "performance-report-template.md",
    requiredCapabilities: { shell: true },
    gate: {
      checks_performed: [],
      lighthouse: null,
      bundle: null,
      load_test: null,
      budget_exceeded: false,
      skipped_reason: null,
    },
  },
  // 29.4 — combined specialty-QA dispatch for compact_qa tracks (currently
  // just "quick"). Folds whichever of accessibility-audit/observability-gate/
  // verification-beyond-tests/performance-budget the track includes into one
  // dispatch — same PASS/FAIL bar per section, one gate instead of N. Full
  // and hotfix are untouched: they keep the four stages separate because
  // they aren't flagged compact_qa (see isCompactQaTrack()/foldQaSweep()
  // below). Not part of ORDERED_STAGE_NAMES/any STAGES_BY_TRACK list — it
  // only ever appears via the fold applied in orderedStageNamesForTrack().
  "verification-sweep": {
    stage: "stage-06x",
    roles: ["qa"],
    objective: "Combined verification sweep for compact-ceremony tracks (29.4). Run exactly the specialty QA checks this track folds into one dispatch — on quick that's accessibility (WCAG audit) and performance budget (Lighthouse/bundle/load-test), the same PASS/FAIL bar as the standalone stage-06b/stage-06e dispatches, just reported as sections of one gate. Populate sections_included with exactly the sections this track requires and leave every other section null.",
    readFirst: ["AGENTS.md", ".devteam/rules/pipeline.md", ".devteam/rules/gates-core.md", "pipeline/context.md", "pipeline/brief.md", "pipeline/design-spec.md", "pipeline/test-report.md"],
    allowedWrites: ["pipeline/verification-sweep-report.md", "pipeline/axe-report.json", "pipeline/lhci-result.json", "pipeline/gates/stage-06x.json"],
    artifact: "pipeline/verification-sweep-report.md",
    template: "verification-sweep-template.md",
    requiredCapabilities: { shell: true },
    gate: {
      sections_included: [],
      accessibility: null,
      observability: null,
      verification_beyond_tests: null,
      performance: null,
    },
  },
  "sign-off": {
    stage: "stage-07",
    roles: ["pm", "platform"],
    // Both roles are structural (they write pipeline/ artifacts, not src/ code).
    // Neither should be suppressed by active_roles — the runbook is always
    // required for deploy regardless of which code workstreams were active.
    alwaysDispatch: ["pm", "platform"],
    objective: "PM sign-off on QA results; platform prepares deploy runbook.",
    readFirst: ["AGENTS.md", ".devteam/rules/pipeline.md", ".devteam/rules/gates-core.md", "pipeline/context.md", "pipeline/test-report.md"],
    allowedWrites: ["pipeline/runbook.md", "pipeline/gates/stage-07.*.json", "pipeline/gates/stage-07.json", "pipeline/context.md"],
    roleWrites: {
      pm:       ["pipeline/gates/stage-07.pm.json",       "pipeline/context.md"],
      platform: ["pipeline/runbook.md", "pipeline/gates/stage-07.platform.json", "pipeline/context.md"],
    },
    artifact: "pipeline/runbook.md",
    template: "runbook-template.md",
    gate: {
      pm_signoff: false,
      deploy_requested: false,
      runbook_referenced: false,
      docs_surface_affected: false,
      docs_updated: null,
      docs_skipped_reason: "",
    },
  },
  deploy: {
    stage: "stage-08",
    roles: ["platform"],
    objective: "Execute the deploy runbook and record results.",
    readFirst: ["AGENTS.md", ".devteam/rules/pipeline.md", ".devteam/rules/gates-core.md", "pipeline/context.md", "pipeline/runbook.md"],
    allowedWrites: ["pipeline/deploy-log.md", "pipeline/gates/stage-08.json"],
    artifact: "pipeline/deploy-log.md",
    template: "pr-summary-template.md",
    requiredCapabilities: { shell: true },
    gate: {
      deploy_completed: false,
      smoke_tests_passed: false,
      rollback_executed: false,
      cost_delta_estimated: false,
      cost_delta_multiplier: 1,
      cost_gate_override: false,
    },
  },
  retrospective: {
    stage: "stage-09",
    roles: ["principal"],
    objective: "Synthesize the run, capture durable lessons, and close the pipeline loop.",
    readFirst: [
      "AGENTS.md", ".devteam/rules/pipeline.md", ".devteam/rules/gates-core.md",
      "pipeline/context.md", "pipeline/lessons-learned.md",
      // G3: optional production-feedback file closes the brief→production loop.
      // Render as "(if present)" so the agent skips it gracefully when absent.
      { path: "pipeline/production-feedback.md", optional: true },
    ],
    allowedWrites: ["pipeline/retrospective.md", "pipeline/lessons-learned.md", "pipeline/gates/stage-09.json", "pipeline/context.md"],
    artifact: "pipeline/retrospective.md",
    template: "retrospective-template.md",
    gate: {
      severity: "green",
      lessons_promoted: [],
      patterns_harvested: 0,
      contributions_written: [],
      // G3: optional field. true = reviewed, false = present but skipped,
      // "absent" = file was not present. Omit when not relevant (null default).
      production_feedback_reviewed: null,
    },
  },
};

const TRACKS = ["full", "quick", "nano", "config-only", "dep-update", "hotfix", "loop"];

const ORDERED_STAGE_NAMES = [
  "requirements",
  "design",
  "clarification",
  "executable-spec",
  "build",
  "pre-review",
  "security-review",
  "red-team",
  "migration-safety",
  "peer-review",
  "qa",
  "accessibility-audit",
  "observability-gate",
  "verification-beyond-tests",
  "performance-budget",
  "sign-off",
  "deploy",
  "retrospective",
];

// Per-track stage lists. Lifted from the prior claude-team.js fork and
// extended over time. Accessibility audit (stage-06b) runs on full,
// quick, and hotfix. Observability gate (stage-06c) runs on full and
// hotfix only — the tracks where the brief actually requires
// observability sections per .devteam/rules/stage-01.md §Gate.
// Security-review (stage-04b) is in the lists but conditional on
// stage-04a's security_review_required flag at runtime.
// Red-team (stage-04c) runs unconditionally on full + hotfix — uniform
// adversarial coverage on non-trivial changes.
// Migration-safety (stage-04d) is conditional on stage-04a's
// migration_safety_required flag — fires when the diff touches the
// data layer (schema files, migrations dir, DDL fragments).
// Executable-spec (stage-03b, G2) runs on full + quick — the tracks
// that also run `requirements` (and therefore have a numbered AC list
// in brief.md to derive scenarios from). Skipped on hotfix (no
// requirements stage, no brief), nano (no real feature being added),
// and the non-feature tracks (config-only, dep-update).
// Verification-beyond-tests (stage-06d, G7) runs on full only — the
// heavy stuff (property-based / mutation / formal) belongs on the
// track that explicitly opted into rigour-over-speed. Other tracks
// rely on stage-06's example tests as their verification floor.
// Performance-budget (stage-06e, B2) runs on full, quick, and hotfix
// — the same tracks as accessibility-audit. Skipped on nano (trivial
// changes have no performance surface), config-only (no code changes),
// and dep-update (dependency bumps are audited at peer-review, not
// benchmarked). Budget thresholds come from performance.budget.json or
// .devteam/config.yml; the skill provides sensible defaults.
// Peer-review on nano is a scoped variant — see PEER_REVIEW_SIZING below.
// Audit Tier-2 policy decision: nano was previously [build, qa] which
// skipped the entire methodology; even trivial changes deserve a
// second pair of eyes. Nano now has peer-review as a single-reviewer,
// single-approval stage to keep wall-clock low while preserving the
// marquee review property.
// Loop (29.1, phase-29-scale-adaptive-ceremony): the 4-slot minimal-ceremony
// track — brief -> build -> verify -> review. Note the order: qa (stage-06,
// "verify") runs BEFORE peer-review (stage-05, "review") here, the reverse of
// every other track. verifyChain's predecessor rule walks this array in
// declared order, not by numeric stage ID, so the chain still links correctly
// (stage-05's predecessor is stage-06 on this track). Build and peer-review
// are both scoped to a single workstream — see loopBuildRole() below — so a
// full stubbed run is exactly 4 dispatches. No design, no red-team, no
// sign-off/deploy: promotion to a deploy-capable track is a re-run with
// --until on a bigger track or a config'd custom_stages, not a loop feature.
const STAGES_BY_TRACK = {
  full:          ORDERED_STAGE_NAMES,
  quick:         ["requirements", "executable-spec", "build", "peer-review", "qa", "accessibility-audit", "performance-budget", "sign-off", "deploy", "retrospective"],
  nano:          ["build", "peer-review", "qa"],
  "config-only": ["build", "pre-review", "security-review", "migration-safety", "qa", "sign-off", "deploy"],
  "dep-update":  ["build", "peer-review", "qa", "sign-off", "deploy"],
  hotfix:        ["build", "pre-review", "security-review", "red-team", "migration-safety", "peer-review", "qa", "accessibility-audit", "observability-gate", "performance-budget", "sign-off", "deploy", "retrospective"],
  loop:          ["requirements", "build", "qa", "peer-review"],
};

// 29.4: tracks flagged compact_qa fold whichever of QA_SWEEP_STAGES they
// list in STAGES_BY_TRACK into a single "verification-sweep" dispatch at
// orderedStageNamesForTrack() time. STAGES_BY_TRACK itself is left alone —
// it stays the declarative "which specialty QA does this track need"
// answer; folding is a presentation-layer transform so every consumer
// (driver dispatch, verifyChain predecessor derivation, right-sizing,
// ceremony-preview) gets the folded shape for free from one call site.
// Only "quick" opts in today; full/hotfix keep the four stages separate.
const COMPACT_QA_TRACKS = new Set(["quick"]);

function isCompactQaTrack(track) {
  return COMPACT_QA_TRACKS.has(track);
}

// The four specialty-QA stages eligible for folding, in declared order.
const QA_SWEEP_STAGES = ["accessibility-audit", "observability-gate", "verification-beyond-tests", "performance-budget"];

// Stages that exist only as the folded output of a compact_qa track — they
// never appear on "full" (full keeps the four stages separate), so they are
// deliberately excluded from the ORDERED_STAGE_NAMES invariant the same way
// mechanical (roles: []) stages already are.
const FOLD_ONLY_STAGES = ["verification-sweep"];

// Replace whichever QA_SWEEP_STAGES members are present in `list` with a
// single "verification-sweep" entry at the position of the first member
// found, preserving the order of everything else. Fewer than two members
// present means there's nothing to combine — list passes through unchanged
// (a track that only ever includes one of the four, e.g. a future
// compact_qa track with just performance-budget, dispatches it standalone).
function foldQaSweep(list) {
  const present = list.filter((n) => QA_SWEEP_STAGES.includes(n));
  if (present.length < 2) return list;
  const out = [];
  let inserted = false;
  for (const name of list) {
    if (QA_SWEEP_STAGES.includes(name)) {
      if (!inserted) { out.push("verification-sweep"); inserted = true; }
      continue;
    }
    out.push(name);
  }
  return out;
}

// Per-track sizing for peer-review (stage-05). For trivial changes
// (nano), one reviewer is the right amount of review — four area
// reviewers would be process-theatre for a typo fix. For everything
// else, the four-area matrix with 2 approvals is the standard.
//
// `roles` controls the dispatch fanout (how many workstream gates land);
// `required_approvals` is the threshold the approval-derivation hook
// stamps onto the gate at creation time.
const PEER_REVIEW_SIZING = {
  nano:          { roles: ["backend"], required_approvals: 1 },
  full:          { roles: ["backend", "frontend", "platform", "qa"], required_approvals: 2 },
  quick:         { roles: ["backend", "frontend", "platform", "qa"], required_approvals: 2 },
  hotfix:        { roles: ["backend", "frontend", "platform", "qa"], required_approvals: 2 },
  "dep-update":  { roles: ["backend", "frontend", "platform", "qa"], required_approvals: 2 },
  "config-only": { roles: ["backend", "frontend", "platform", "qa"], required_approvals: 2 },
  // loop's sizing is derived from loopBuildRole(config) instead of a static
  // roles list — see rolesForStage()/requiredApprovalsFor() below — because
  // the single reviewed area must always match the single role that build
  // actually dispatched (config-overridable, default "backend").
};

// 29.1: the build workstream slots. Also the valid values for the
// config-overridable pipeline.loop_build_role knob.
const LOOP_BUILD_WORKSTREAMS = ["backend", "frontend", "platform", "qa"];
const LOOP_DEFAULT_BUILD_ROLE = "backend";

// The single role the `loop` track's build (stage-04) and peer-review
// (stage-05) stages dispatch. Default "backend"; override via
// pipeline.loop_build_role in .devteam/config.yml. Falls back to the default
// on an unrecognized value rather than throwing, so a typo'd config never
// blocks a run — right-sizing callers that don't have `config` in scope
// (e.g. right-sizing.js's workstream-count estimate) get the same default,
// which is safe there because only the role's *identity* varies with config,
// never the workstream *count* (always 1).
function loopBuildRole(config) {
  const configured = config && config.pipeline && config.pipeline.loop_build_role;
  return LOOP_BUILD_WORKSTREAMS.includes(configured) ? configured : LOOP_DEFAULT_BUILD_ROLE;
}

// Track-aware roles list for a stage. stage-04 (build) and stage-05
// (peer-review) vary by track; every other stage uses its base `roles`
// array unchanged.
function rolesForStage(stageDef, track, config) {
  if (track === "loop" && stageDef.stage === "stage-04") {
    return [loopBuildRole(config)];
  }
  if (stageDef.stage === "stage-05") {
    if (track === "loop") return [loopBuildRole(config)];
    const sizing = PEER_REVIEW_SIZING[track] || PEER_REVIEW_SIZING.full;
    return sizing.roles;
  }
  return stageDef.roles;
}

// Track-aware required_approvals for stages that gate on approvals.
// Returns undefined when the stage doesn't use the approval mechanism.
function requiredApprovalsFor(stageDef, track) {
  if (stageDef.stage === "stage-05") {
    if (track === "loop") return 1;
    const sizing = PEER_REVIEW_SIZING[track] || PEER_REVIEW_SIZING.full;
    return sizing.required_approvals;
  }
  return undefined;
}

function stageNames() {
  return Object.keys(STAGES);
}

function orderedStageNames() {
  return ORDERED_STAGE_NAMES.filter((n) => STAGES[n]);
}

function orderedStageNamesForTrack(track = "full") {
  // G6: accept a custom stage array (e.g. ["requirements","build","peer-review"])
  if (Array.isArray(track)) {
    return track.filter((n) => STAGES[n]);
  }
  const list = STAGES_BY_TRACK[track];
  if (!list) {
    throw new Error(`Unknown track "${track}". Valid: ${TRACKS.join(", ")}, or a custom stage array.`);
  }
  const effective = isCompactQaTrack(track) ? foldQaSweep(list) : list;
  return effective.filter((n) => STAGES[n]);
}

function isStageInTrack(stageName, track) {
  return orderedStageNamesForTrack(track).includes(stageName);
}

// Produce a display-friendly string for a track — handles both named
// tracks ("full") and custom stage arrays (["build","qa"] → "build,qa").
function trackLabel(track) {
  if (Array.isArray(track)) return track.join(",");
  return track || "full";
}

function getStage(name) {
  return STAGES[name] || null;
}

module.exports = {
  STAGES,
  TRACKS,
  ORDERED_STAGE_NAMES,
  STAGES_BY_TRACK,
  PEER_REVIEW_SIZING,
  stageNames,
  orderedStageNames,
  orderedStageNamesForTrack,
  isStageInTrack,
  trackLabel,
  getStage,
  rolesForStage,
  requiredApprovalsFor,
  loopBuildRole,
  LOOP_BUILD_WORKSTREAMS,
  LOOP_DEFAULT_BUILD_ROLE,
  isCompactQaTrack,
  QA_SWEEP_STAGES,
  FOLD_ONLY_STAGES,
  foldQaSweep,
};
