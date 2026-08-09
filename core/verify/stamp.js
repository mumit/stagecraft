// Orchestrator-stamped gate fields. Closes the gap between agent
// self-report ("tests_passed: true") and orchestrator verification
// (the orchestrator actually runs the test command and observes exit
// code 0). For stage-04a (pre-review), stage-06 (qa), and stage-03b
// (executable-spec), the orchestrator runs the relevant commands and
// overwrites the gate's verification fields with what it observed.
//
// When the orchestrator's verification disagrees with what the model
// wrote, the orchestrator wins: status flips to FAIL, blockers gain
// a structured entry naming what failed, and `_orchestrator_stamped`
// records the audit trail (commands run, exit codes, timestamps).
//
// Audit finding (2026-06-02 audit, CRITICAL): every Stage 04a gate
// field is currently model-self-reported. The validator only
// enforces shape, not truth. This module is the fix.
//
// 6.2: stage-03b stamping moves spec generate/verify out of the pm
// agent (no Bash budget) into the orchestrator — model-said vs
// observed recorded on every spec-related gate field.

const fs = require("node:fs");
const path = require("node:path");
const { loadConfig } = require("../config");
const {
  runCommandWithReceipt, resolveCommands, resolveTestCommands, resolveTestConcurrency, runTestCommands,
} = require("./runner");
const { receiptRootFromGate } = require("./receipts");
const { loadGateSafe } = require("../gates/load-gate");
const { verify: specVerify, generateScaffold, extractAcsFromBrief: extractAcsFromBriefSpec } = require("../spec/verify");
const { runLicenseCheck } = require("./license-runner");
const {
  runDependencyAudit, runSecretScanFloor, runSemgrepFloor, computeDependencyDiff, getChangedFiles,
} = require("./redteam-floor");
const { runMutationGate } = require("./mutation");
const { runPropertyGate } = require("./property");
const { runFormalGate } = require("./formal");

const STAMPER_VERSION = "1";

function testRunRecord(execution) {
  const suites = execution.runs.map((run) => ({
    id: run.id,
    command: run.command,
    exit_code: run.exitCode,
    duration_ms: run.durationMs,
    timed_out: run.timedOut || undefined,
    spawn_error: run.spawnError || undefined,
    resource_group: run.resource_group || undefined,
    stdout_truncated: run.stdoutTruncated || undefined,
    stderr_truncated: run.stderrTruncated || undefined,
    receipt: run.receipt || undefined,
  }));
  if (suites.length === 1) {
    const [run] = suites;
    return {
      command: run.command,
      exit_code: run.exit_code,
      duration_ms: run.duration_ms,
      timed_out: run.timed_out,
      spawn_error: run.spawn_error,
      receipt: run.receipt,
    };
  }
  return {
    command: `polyglot test suite (${suites.length} commands)`,
    exit_code: execution.passed ? 0 : 1,
    duration_ms: execution.durationMs,
    suites,
  };
}

async function executeTests(cwd, config, gatePath, purpose) {
  const commands = resolveTestCommands(cwd, config);
  if (commands.length === 0) return null;
  return runTestCommands(commands, {
    cwd,
    concurrency: resolveTestConcurrency(config),
    receipts: gatePath ? {
      root: receiptRootFromGate(gatePath),
      cwd,
      config,
      purpose,
      enabled: config.pipeline.verify.receipts !== false,
    } : undefined,
  });
}

function appendTestFailures(blockers, execution) {
  for (const run of execution.runs) {
    const passed = run.exitCode === 0 && !run.timedOut && !run.spawnError;
    if (!passed) {
      blockers.push(
        `test command failed [${run.id}] (exit ${run.exitCode}${run.timedOut ? ", timed out" : ""}): ${run.command}`,
      );
    }
  }
}

// Stage-04a (Pre-Review): orchestrator stamps lint_passed and tests_passed
// based on actually running the configured commands.
async function stampStage04a(cwd, gatePath) {
  const config = loadConfig(cwd);
  const commands = resolveCommands(cwd, config);
  const { gate, error } = loadGateSafe(gatePath);
  if (error) return { ok: false, error };

  const stamp = {
    stamper_version: STAMPER_VERSION,
    at: new Date().toISOString(),
    fields: [],
    runs: {},
  };
  const blockers = Array.isArray(gate.blockers) ? gate.blockers.slice() : [];

  // lint_passed
  if (commands.lint) {
    const result = await runCommandWithReceipt(commands.lint, {
      cwd,
      receipts: {
        root: receiptRootFromGate(gatePath),
        cwd,
        config,
        purpose: "stage-04a:lint",
        suiteId: "lint",
        enabled: config.pipeline.verify.receipts !== false,
      },
    });
    const passed = result.exitCode === 0 && !result.timedOut && !result.spawnError;
    if (gate.lint_passed !== passed) {
      stamp.fields.push({ field: "lint_passed", model_said: gate.lint_passed, orchestrator: passed });
    } else {
      stamp.fields.push({ field: "lint_passed", orchestrator: passed });
    }
    gate.lint_passed = passed;
    stamp.runs.lint = {
      command: result.command,
      exit_code: result.exitCode,
      duration_ms: result.durationMs,
      timed_out: result.timedOut || undefined,
      spawn_error: result.spawnError || undefined,
      receipt: result.receipt || undefined,
    };
    if (!passed) {
      blockers.push(`lint failed (exit ${result.exitCode}${result.timedOut ? ", timed out" : ""}): ${result.command}`);
    }
  } else {
    stamp.runs.lint = { skipped: "no lint command configured or discovered" };
  }

  // tests_passed (lightweight check at 4a; 06 is the authoritative test stage)
  const testExecution = await executeTests(cwd, config, gatePath, "stage-04a:test");
  if (testExecution) {
    const passed = testExecution.passed;
    if (gate.tests_passed !== passed) {
      stamp.fields.push({ field: "tests_passed", model_said: gate.tests_passed, orchestrator: passed });
    } else {
      stamp.fields.push({ field: "tests_passed", orchestrator: passed });
    }
    gate.tests_passed = passed;
    stamp.runs.test = testRunRecord(testExecution);
    if (!passed) appendTestFailures(blockers, testExecution);
  } else {
    stamp.runs.test = { skipped: "no test command configured or discovered" };
  }

  // license_check_passed: orchestrator-verified for Node projects; tri-state
  // "unverified-by-orchestrator" for non-Node or when node_modules is absent.
  // Closes C3's doctrine exception — model can no longer self-certify a scan
  // that never ran.  dependency_review_passed is left as model-asserted by design
  // (see schema description) because npm audit requires live advisory DB access.
  const licenseResult = runLicenseCheck(cwd, config);
  if (!licenseResult.nodeProject || licenseResult.unverified) {
    const prevLicense = gate.license_check_passed;
    const entry = { field: "license_check_passed", orchestrator: "unverified-by-orchestrator", reason: licenseResult.reason };
    if (prevLicense !== "unverified-by-orchestrator") entry.model_said = prevLicense;
    stamp.fields.push(entry);
    gate.license_check_passed = "unverified-by-orchestrator";
    gate.warnings = Array.isArray(gate.warnings) ? gate.warnings : [];
    gate.warnings.push(`license check unverified by orchestrator: ${licenseResult.reason}`);
    stamp.runs.license = { skipped: licenseResult.reason };
  } else {
    const orchestratorPassed = licenseResult.passed;
    const prevLicense = gate.license_check_passed;
    if (prevLicense !== orchestratorPassed) {
      stamp.fields.push({ field: "license_check_passed", model_said: prevLicense, orchestrator: orchestratorPassed });
    } else {
      stamp.fields.push({ field: "license_check_passed", orchestrator: orchestratorPassed });
    }
    gate.license_check_passed = orchestratorPassed;
    gate.license_findings = licenseResult.findings;
    stamp.runs.license = {
      packages_scanned: licenseResult.totalScanned,
      findings_count: licenseResult.findings.length,
      denied_count: licenseResult.findings.filter((f) => f.policy === "denied").length,
      warned_count: licenseResult.findings.filter((f) => f.policy === "warned").length,
    };
    if (!orchestratorPassed) {
      const denied = licenseResult.findings.filter((f) => f.policy === "denied");
      blockers.push(
        `license check failed: ${denied.length} denied license(s) — ${denied.map((d) => `${d.package} (${d.license})`).join(", ")}`,
      );
    }
  }

  // ADR-009 Phase 3: finalize stage-03b's `reproduced` field for repair runs.
  // stampStage03b recorded the pre-build test baseline (reproduction_pre_build)
  // and left `reproduced` as the model's claim. Now that the build has applied
  // the fix, we observe the post-build (current) test result and finalize:
  //   pre-build failed + current pass → reproduced: true  (verified red→green)
  //   pre-build not failed + current pass → reproduced: true (green confirmed)
  //   current fail → reproduced: false (fix didn't work)
  // Unverifiable bugs are not touched (the "unverifiable: <reason>" string is final).
  // Best-effort: a stage-03b gate update failure must never block pre-review.
  const stage03bGatePath = path.join(path.dirname(gatePath), "stage-03b.json");
  if (fs.existsSync(stage03bGatePath)) {
    try {
      const gate03b = JSON.parse(fs.readFileSync(stage03bGatePath, "utf8"));
      const modelReproduced03b = gate03b.reproduced;
      const isUnverifiable03b = typeof modelReproduced03b === "string" &&
        modelReproduced03b.startsWith("unverifiable:");
      if (modelReproduced03b !== undefined && !isUnverifiable03b) {
        // Determine current (post-build) test result from the stamp we just ran.
        const currentTestRun = stamp.runs.test;
        const currentTestPassed = currentTestRun && !currentTestRun.skipped
          ? currentTestRun.exit_code === 0
          : null;
        const preBuildRecord = gate03b._orchestrator_stamped?.runs?.reproduction_pre_build;
        const preBuildFailed = preBuildRecord && preBuildRecord.pre_build_tests_passed === false;
        let finalReproduced = modelReproduced03b;
        if (currentTestPassed === true) {
          finalReproduced = true;  // green after fix confirmed by orchestrator
        } else if (currentTestPassed === false) {
          finalReproduced = false; // fix didn't make tests pass
        }
        // Record the reproduction verification audit on the stage-03b gate.
        gate03b.reproduced = finalReproduced;
        gate03b._orchestrator_stamped = gate03b._orchestrator_stamped || { runs: {} };
        gate03b._orchestrator_stamped.runs.reproduction_verification = {
          post_build_tests_passed: currentTestPassed,
          pre_build_tests_passed: preBuildFailed ? false : preBuildRecord?.pre_build_tests_passed,
          red_before_confirmed: Boolean(preBuildFailed),
          green_after_confirmed: currentTestPassed === true,
          finalized_at: new Date().toISOString(),
        };
        gate03b.timestamp = new Date().toISOString();
        fs.writeFileSync(stage03bGatePath, JSON.stringify(gate03b, null, 2) + "\n");
      }
    } catch { /* best-effort — stage-03b gate update must never block pre-review */ }
  }

  return finalizeStamp(gate, gatePath, blockers, stamp);
}

// Stage-06 (QA): run test command; cross-check AC→test mapping in
// pipeline/test-report.md against brief.md AC-N list.
async function stampStage06(cwd, gatePath) {
  const config = loadConfig(cwd);
  const { gate, error } = loadGateSafe(gatePath);
  if (error) return { ok: false, error };

  const stamp = {
    stamper_version: STAMPER_VERSION,
    at: new Date().toISOString(),
    fields: [],
    runs: {},
  };
  const blockers = Array.isArray(gate.blockers) ? gate.blockers.slice() : [];

  // Test command exit code
  const testExecution = await executeTests(cwd, config, gatePath, "stage-06:test");
  if (testExecution) {
    const passed = testExecution.passed;
    stamp.runs.test = testRunRecord(testExecution);
    if (!passed) {
      // Force a counter when tests genuinely fail. The model's tests_failed
      // and failing_tests stay as written (those are runner-specific to
      // count), but we record that at least one failure occurred per the
      // exit code. The blocker below halts sign-off.
      stamp.fields.push({ field: "test_command_exit_0", orchestrator: false });
      appendTestFailures(blockers, testExecution);
    } else {
      stamp.fields.push({ field: "test_command_exit_0", orchestrator: true });
    }
  } else {
    stamp.runs.test = { skipped: "no test command configured or discovered" };
  }

  // AC→test cross-check: derive `all_acceptance_criteria_met` from the
  // brief and test-report.md rather than trusting the model's claim.
  const acCheck = checkAcceptanceCriteria(cwd);
  if (acCheck.applicable) {
    stamp.runs.ac_mapping = acCheck.details;
    const orchestratorSaysAllMet = acCheck.unmappedAcs.length === 0;
    if (gate.all_acceptance_criteria_met !== orchestratorSaysAllMet) {
      stamp.fields.push({
        field: "all_acceptance_criteria_met",
        model_said: gate.all_acceptance_criteria_met,
        orchestrator: orchestratorSaysAllMet,
      });
    } else {
      stamp.fields.push({ field: "all_acceptance_criteria_met", orchestrator: orchestratorSaysAllMet });
    }
    gate.all_acceptance_criteria_met = orchestratorSaysAllMet;
    if (!orchestratorSaysAllMet) {
      blockers.push(
        `acceptance criteria unmapped to tests (${acCheck.unmappedAcs.length}): ${acCheck.unmappedAcs.join(", ")}`,
      );
    }
  } else {
    stamp.runs.ac_mapping = { skipped: acCheck.reason };
  }

  // 31.4: opt-in mutation smoke gate — changed-files-only, time-boxed,
  // never installs a runner. Disabled by default (pipeline.verify.mutation.
  // enabled=false), so an unconfigured project's stage-06 gate is unaffected
  // beyond this always-recorded, always-honest audit entry. See
  // core/verify/mutation.js and plans/phase-31-verification-depth.md §31.4.
  // 35.5: the default flips to enabled on gate.track === "refactor" only
  // (resolveMutationConfig/runMutationGate read the track to decide).
  const changedFiles = getChangedFiles(cwd);
  const mutationResult = await runMutationGate(cwd, config, changedFiles, gate.track);
  stamp.runs.mutation = mutationResult;
  if (mutationResult.ran) {
    gate.mutation_score = mutationResult.score;
    gate.mutation_runner = mutationResult.runner;
    gate.mutation_scope = mutationResult.scope;
    stamp.fields.push({ field: "mutation_score", orchestrator: mutationResult.score, runner: mutationResult.runner });

    if (mutationResult.score < mutationResult.threshold) {
      const scorePct = (mutationResult.score * 100).toFixed(1);
      const thresholdPct = (mutationResult.threshold * 100).toFixed(1);
      const msg = `mutation score ${scorePct}% below threshold ${thresholdPct}% ` +
        `(runner: ${mutationResult.runner}, scope: ${mutationResult.scope.mutated_files.length} changed file(s))`;
      if (mutationResult.threshold_hard) {
        // threshold_hard: the model cannot talk its way past a mechanically
        // observed mutation gap — finalizeStamp's blockers-length check
        // below flips PASS/WARN to FAIL the same way every other stamped
        // check does.
        blockers.push(`mutation score below hard threshold: ${msg}`);
      } else {
        // Advisory by default: surfaced as a gate warning AND a
        // noted_for_followup entry so `devteam advise` classifies it (see
        // core/advise.js#classifyItem — severity: "high" with no AC ref
        // routes to PEER_REVIEW_RISK) rather than being silently absorbed.
        gate.warnings = Array.isArray(gate.warnings) ? gate.warnings : [];
        gate.warnings.push(`WARN mutation-below-threshold: ${msg}`);
        gate.noted_for_followup = Array.isArray(gate.noted_for_followup) ? gate.noted_for_followup : [];
        gate.noted_for_followup.push({
          id: "MUT-1",
          severity: "high",
          surface: "mutation_testing",
          text: msg,
        });
      }
    }
  }

  return finalizeStamp(gate, gatePath, blockers, stamp);
}

// Parse pipeline/brief.md for AC-N entries and pipeline/test-report.md for
// the AC mapping table. Returns which AC-Ns appear in the brief but have
// no test mapped. Conservative: when the test report or brief is missing
// we skip rather than fail (the model didn't run; can't blame the gate).
function checkAcceptanceCriteria(cwd) {
  // B9 exemption: stamp.js is called from mergeWorkstreamGates which already
  // knows the gatesDir; brief.md/test-report.md use the global pipeline/ path
  // here. Bounded support for stamps would require passing changeId; deferred.
  const briefPath = path.join(cwd, "pipeline", "brief.md");
  const reportPath = path.join(cwd, "pipeline", "test-report.md");
  if (!fs.existsSync(briefPath)) {
    return { applicable: false, reason: "pipeline/brief.md not found (track without requirements stage?)" };
  }
  if (!fs.existsSync(reportPath)) {
    return { applicable: false, reason: "pipeline/test-report.md not found — model didn't produce it" };
  }
  const briefAcs = extractAcsFromBrief(fs.readFileSync(briefPath, "utf8"));
  const reportAcs = extractAcsFromReport(fs.readFileSync(reportPath, "utf8"));

  const reportSet = new Set(reportAcs);
  const unmapped = briefAcs.filter((ac) => !reportSet.has(ac));

  return {
    applicable: true,
    details: {
      brief_ac_count: briefAcs.length,
      report_ac_count: reportAcs.length,
      unmapped_acs: unmapped,
      brief_acs: briefAcs,
    },
    unmappedAcs: unmapped,
  };
}

// Extract AC identifiers from brief.md. Delegates to core/spec/verify.js's
// implementation, which is line-anchored and section-scoped — it only matches
// lines where AC-N appears at the start (optionally with a bullet or bold
// markers) followed by a separator (—, :). This prevents prose cross-references
// like "existing AC-1 through AC-12" from being mistaken for defined criteria.
function extractAcsFromBrief(text) {
  return extractAcsFromBriefSpec(text).ids;
}

// Extract AC identifiers from a test-report.md mapping table. Any cell
// containing "AC-N" counts as a mention.
function extractAcsFromReport(text) {
  const re = /AC-(\d+)\b/g;
  const seen = new Set();
  let m;
  while ((m = re.exec(text)) !== null) {
    seen.add(`AC-${m[1]}`);
  }
  return Array.from(seen);
}

// Stage-04c (Red Team): mechanical floor (31.2). The model's adversarial
// pass stays authoritative for judgment (surfaces_walked, noted_for_followup),
// but four orchestrator-run checks can't be sweet-talked: dependency audit,
// secret-scan over the changeset, semgrep (only if already configured),
// and a lockfile delta since the previous attempt. See
// plans/phase-31-verification-depth.md item 31.2.
const SEVERITY_LEVELS = ["critical", "high", "medium", "low"];

async function stampStage04c(cwd, gatePath) {
  const config = loadConfig(cwd);
  const { gate, error } = loadGateSafe(gatePath);
  if (error) return { ok: false, error };

  const stamp = {
    stamper_version: STAMPER_VERSION,
    at: new Date().toISOString(),
    fields: [],
    runs: {},
  };
  const blockers = Array.isArray(gate.blockers) ? gate.blockers.slice() : [];
  const changedFiles = getChangedFiles(cwd);
  const mechanicalFindings = [];

  const auditResult = await runDependencyAudit(cwd, config);
  stamp.runs.dependency_audit = auditResult;
  mechanicalFindings.push(...auditResult.findings);

  const secretResult = runSecretScanFloor(cwd, changedFiles);
  stamp.runs.secret_scan = secretResult;
  mechanicalFindings.push(...secretResult.findings);

  const semgrepResult = await runSemgrepFloor(cwd, changedFiles);
  stamp.runs.semgrep = semgrepResult;
  mechanicalFindings.push(...semgrepResult.findings);

  const gatesDir = path.dirname(gatePath);
  const diffResult = computeDependencyDiff(cwd, gatesDir);
  stamp.runs.dependency_diff = diffResult;

  // findings_count := max(model_reported, mechanical) — the orchestrator
  // never lowers what the model already found, only raises the floor.
  const mechanicalSeverity = { critical: 0, high: 0, medium: 0, low: 0 };
  for (const f of mechanicalFindings) mechanicalSeverity[f.severity] = (mechanicalSeverity[f.severity] || 0) + 1;

  const modelFindingsCount = typeof gate.findings_count === "number" ? gate.findings_count : 0;
  const orchestratorFindingsCount = Math.max(modelFindingsCount, mechanicalFindings.length);
  if (modelFindingsCount !== orchestratorFindingsCount) {
    stamp.fields.push({ field: "findings_count", model_said: modelFindingsCount, orchestrator: orchestratorFindingsCount, mechanical: mechanicalFindings.length });
  } else {
    stamp.fields.push({ field: "findings_count", orchestrator: orchestratorFindingsCount, mechanical: mechanicalFindings.length });
  }
  gate.findings_count = orchestratorFindingsCount;

  const modelSeverity = (gate.severity_breakdown && typeof gate.severity_breakdown === "object") ? gate.severity_breakdown : {};
  const mergedSeverity = {};
  for (const level of SEVERITY_LEVELS) {
    mergedSeverity[level] = Math.max(Number(modelSeverity[level]) || 0, mechanicalSeverity[level]);
  }
  gate.severity_breakdown = mergedSeverity;

  // A mechanical HIGH (or CRITICAL) finding forces must_address_before_peer_review
  // regardless of what the model reported — the model cannot talk its way past a
  // finding the orchestrator observed directly.
  const existingMustAddress = Array.isArray(gate.must_address_before_peer_review) ? gate.must_address_before_peer_review.slice() : [];
  const existingIds = new Set(existingMustAddress.map((item) => item && item.id));
  const forced = mechanicalFindings.filter((f) => f.severity === "high" || f.severity === "critical");
  const forcedIds = [];
  for (const item of forced) {
    if (existingIds.has(item.id)) continue;
    existingMustAddress.push({
      id: item.id,
      severity: item.severity,
      likelihood: "expected",
      surface: item.surface,
      summary: item.summary,
      source: "mechanical",
    });
    existingIds.add(item.id);
    forcedIds.push(item.id);
    blockers.push(`mechanical red-team floor [${item.id}]: ${item.summary}`);
  }
  gate.must_address_before_peer_review = existingMustAddress;
  if (forcedIds.length > 0) {
    stamp.fields.push({ field: "must_address_before_peer_review", mechanical_forced: forcedIds });
  }

  const result = finalizeStamp(gate, gatePath, blockers, stamp);

  // Reuse the existing pipeline/context.md consequence plumbing rather than
  // duplicating it here — see core/gates/validator.js#injectRedTeamBlockers.
  // Best-effort: this is an audit convenience, not part of the gate contract.
  if (result.ok) {
    try {
      const { injectRedTeamBlockers } = require("../gates/validator");
      injectRedTeamBlockers(result.gate, cwd);
    } catch { /* best-effort */ }
  }

  return result;
}

// Stage-06d (Verification Beyond Tests, G7): closes the gap phase 31
// deliberately deferred (plans/phase-31-verification-depth.md §"out of
// scope"; plans/phase-35-existing-codebase-mode.md item 35.3). Before this,
// `methods_attempted[]` was 100% model-asserted — the verifier role could
// claim "property" or "mutation" ran without the orchestrator ever
// checking. This makes methods_attempted[] orchestrator-derived: for each
// BARE method tag the model claims (not already an honest
// `attempted_but_blocked:*`), the orchestrator independently tries to
// produce executable evidence. Real evidence confirms the claim and the
// orchestrator's own numbers overwrite the model's (trust boundary: observed
// wins over asserted); no evidence downgrades the claim to
// `attempted_but_blocked:<method>`, with the model's original sub-object
// preserved under stamp.runs.<method>.model_claim and a warning raised.
//
// Existing FAIL rules are unchanged in spirit: a property run that
// genuinely executes but comes back with a counterexample, or a mutation
// score below the model's own pre-declared threshold, still fails
// sign-off — the orchestrator just insists the failure be real. Formal
// methods are presence-and-exit-code only (core/verify/formal.js): TLA+/
// Alloy/Lean output is too varied to parse, so a non-zero exit is a
// warning for human triage, never an auto-blocker.
async function stampStage06d(cwd, gatePath) {
  const config = loadConfig(cwd);
  const { gate, error } = loadGateSafe(gatePath);
  if (error) return { ok: false, error };

  const stamp = {
    stamper_version: STAMPER_VERSION,
    at: new Date().toISOString(),
    fields: [],
    runs: {},
  };
  const blockers = Array.isArray(gate.blockers) ? gate.blockers.slice() : [];
  const warnings = Array.isArray(gate.warnings) ? gate.warnings.slice() : [];
  const methodsAttempted = Array.isArray(gate.methods_attempted) ? gate.methods_attempted.slice() : [];

  // Downgrades a bare method claim ("property"/"mutation"/"formal") to
  // attempted_but_blocked:<method> when no executable evidence exists.
  // No-op when the model never claimed the bare tag (nothing to downgrade —
  // an honest methods_skipped[] entry or an already-honest
  // attempted_but_blocked claim is left untouched).
  function downgrade(method, fieldName, reason, evidenceRun) {
    const idx = methodsAttempted.indexOf(method);
    if (idx === -1) return;
    methodsAttempted[idx] = `attempted_but_blocked:${method}`;
    stamp.fields.push({
      field: "methods_attempted", method,
      model_said: method, orchestrator: `attempted_but_blocked:${method}`,
      reason,
    });
    warnings.push(
      `WARN ${method}-attempted-but-blocked: model claimed "${method}" was attempted but no executable ` +
      `evidence exists — ${reason}`,
    );
    stamp.runs[method] = { ...evidenceRun, model_claim: gate[fieldName] };
  }

  // --- property-based ---
  if (methodsAttempted.includes("property")) {
    const propResult = await runPropertyGate(cwd, config);
    if (propResult.ran && propResult.properties_asserted > 0) {
      stamp.runs.property = propResult;
      const orchProperty = {
        properties_asserted: propResult.properties_asserted,
        cases_tried: propResult.cases_tried,
        counterexamples_found: propResult.counterexamples_found,
        tool: propResult.runner,
      };
      const prevProperty = gate.property_based;
      if (JSON.stringify(prevProperty) !== JSON.stringify(orchProperty)) {
        stamp.fields.push({ field: "property_based", model_said: prevProperty, orchestrator: orchProperty });
      } else {
        stamp.fields.push({ field: "property_based", orchestrator: orchProperty });
      }
      gate.property_based = orchProperty;
      if (!propResult.passed) {
        blockers.push(
          `property-based verification failed (orchestrator-run): ${propResult.counterexamples_found} ` +
          `counterexample(s) found across ${propResult.properties_asserted} propert` +
          `${propResult.properties_asserted === 1 ? "y" : "ies"} (${propResult.runner})`,
        );
      }
    } else {
      const reason = propResult.ran
        ? `orchestrator ran the property command but found zero executed properties (exit ${propResult.exit_code})`
        : propResult.reason;
      downgrade("property", "property_based", reason, propResult);
    }
  }

  // --- mutation: reuse the 31.4 runner path, never a second implementation ---
  if (methodsAttempted.includes("mutation")) {
    const changedFiles = getChangedFiles(cwd);
    const mutationResult = await runMutationGate(cwd, config, changedFiles);
    if (mutationResult.ran) {
      stamp.runs.mutation = mutationResult;
      // The verifier commits to a threshold BEFORE running (schema:
      // "Audit-grade: prevents goal-post moving") — honor the model's own
      // declared bar; only fall back to the mutation gate's own default
      // when the model didn't declare one.
      const declaredThreshold = (gate.mutation && typeof gate.mutation.threshold === "number")
        ? gate.mutation.threshold
        : mutationResult.threshold;
      const orchMutation = {
        mutants_generated: mutationResult.mutants.generated,
        mutants_killed: mutationResult.mutants.killed,
        mutants_survived: mutationResult.mutants.survived,
        mutants_timed_out: mutationResult.mutants.timed_out,
        score: mutationResult.score,
        threshold: declaredThreshold,
        tool: mutationResult.runner,
        target: mutationResult.scope.mutated_files.join(", "),
      };
      const prevMutation = gate.mutation;
      if (JSON.stringify(prevMutation) !== JSON.stringify(orchMutation)) {
        stamp.fields.push({ field: "mutation", model_said: prevMutation, orchestrator: orchMutation });
      } else {
        stamp.fields.push({ field: "mutation", orchestrator: orchMutation });
      }
      gate.mutation = orchMutation;
      if (mutationResult.score < declaredThreshold) {
        const scorePct = (mutationResult.score * 100).toFixed(1);
        const thresholdPct = (declaredThreshold * 100).toFixed(1);
        blockers.push(
          `mutation score ${scorePct}% below declared threshold ${thresholdPct}% ` +
          `(orchestrator-run, runner: ${mutationResult.runner})`,
        );
      }
    } else {
      downgrade("mutation", "mutation", mutationResult.reason, mutationResult);
    }
  }

  // --- formal: presence-and-exit-code only ---
  if (methodsAttempted.includes("formal")) {
    const formalResult = await runFormalGate(cwd, config);
    if (formalResult.ran) {
      stamp.runs.formal = formalResult;
      const orchFormal = {
        ...(gate.formal && typeof gate.formal === "object" ? gate.formal : {}),
        tool: formalResult.tool,
        ran: true,
        exit_code: formalResult.exit_code,
      };
      stamp.fields.push({
        field: "formal",
        orchestrator: { tool: orchFormal.tool, ran: true, exit_code: orchFormal.exit_code },
      });
      gate.formal = orchFormal;
      if (formalResult.exit_code !== 0) {
        warnings.push(
          `WARN formal-nonzero-exit: formal verification tool "${orchFormal.tool}" exited ` +
          `${formalResult.exit_code} — presence-and-exit-code only (output too varied to parse); ` +
          `verify manually whether this is a counterexample or a tool/config error`,
        );
      }
    } else {
      downgrade("formal", "formal", formalResult.reason, formalResult);
    }
  }

  gate.methods_attempted = methodsAttempted;
  gate.warnings = warnings;

  return finalizeStamp(gate, gatePath, blockers, stamp);
}

// Stage-03b (Executable Spec): orchestrator stamps the spec-related gate
// fields by running verify() from core/spec/verify. This moves spec
// generation/verification out of the pm agent (budget: Read, Write, Glob —
// no Bash) into the orchestrator. If spec.feature is absent but brief.md
// is present, generates a scaffold first so the gate records observed state.
//
// ADR-009 Phase 3: in repair mode (detected by `gate.reproduced !== undefined`),
// stamp also handles the reproduction tri-state:
//   reproduced: true | false       — model's claim; run test command to capture
//                                    pre-build baseline; stampStage04a finalizes
//   reproduced: "unverifiable: X"  — cannot write a runnable test; WARN loudly,
//                                    no blocker (proceed but flag for manual review)
//
// Rejected alternative: granting pm Bash capability. Verification belongs
// to the orchestrator — the trust model requires the orchestrator to check
// the agent's work, not for the agent to self-certify (6.2 rationale).
async function stampStage03b(cwd, gatePath) {
  const { gate, error } = loadGateSafe(gatePath);
  if (error) return { ok: false, error };

  const pipelineDir = path.join(cwd, "pipeline");
  const briefPath = path.join(pipelineDir, "brief.md");
  const specPath  = path.join(pipelineDir, "spec.feature");

  const stamp = {
    stamper_version: STAMPER_VERSION,
    at: new Date().toISOString(),
    fields: [],
    runs: {},
  };
  const blockers = Array.isArray(gate.blockers) ? gate.blockers.slice() : [];

  if (!fs.existsSync(briefPath)) {
    stamp.runs.spec_generate = { skipped: "pipeline/brief.md not found — track without requirements stage?" };
    stamp.runs.spec_verify   = { skipped: "pipeline/brief.md not found" };
    return finalizeStamp(gate, gatePath, blockers, stamp);
  }

  const briefText = fs.readFileSync(briefPath, "utf8");

  // Generate scaffold if spec.feature is absent (corresponds to devteam spec generate).
  if (!fs.existsSync(specPath)) {
    try {
      const scaffold = generateScaffold(briefText);
      fs.mkdirSync(path.dirname(specPath), { recursive: true });
      fs.writeFileSync(specPath, scaffold, "utf8");
      stamp.runs.spec_generate = { generated: true, path: path.relative(cwd, specPath) };
    } catch (err) {
      stamp.runs.spec_generate = { error: err.message };
    }
  } else {
    stamp.runs.spec_generate = { skipped: "spec.feature already exists" };
  }

  // Run verify (brief↔spec only — test-report alignment is stage-06's job).
  const report = specVerify(cwd, { pipelineDir, skipTestPhase: true });
  stamp.runs.spec_verify = {
    drift: report.drift,
    criteria_count: report.criteria.length,
    scenarios_count: report.scenarios.length,
    orphan_criteria_count: report.orphan_criteria.length,
    orphan_scenarios_count: report.orphan_scenarios.length,
    duplicate_criteria_count: report.duplicate_criteria.length,
    orphan_in_tests_count: report.orphan_in_tests.length,
    unknown_in_tests_count: report.unknown_in_tests.length,
  };

  // Build criteria_to_scenario_mapping from the report's scenario objects.
  const scenariosByAc = new Map();
  for (const sc of report.scenarios) {
    for (const id of sc.ac_ids || []) {
      if (!scenariosByAc.has(id)) scenariosByAc.set(id, []);
      scenariosByAc.get(id).push(sc.name);
    }
  }
  const orchMapping = report.criteria.map((id) => ({
    criterion_id: id,
    scenarios: scenariosByAc.get(id) || [],
  }));

  const orchCriteriaCount   = report.criteria.length;
  const orchScenariosCount  = report.scenarios.length;
  const orchAllMapped       = report.orphan_criteria.length === 0 &&
                              report.duplicate_criteria.length === 0;
  const orchOrphanScenarios = report.orphan_scenarios.map((o) => o.name);
  const orchOrphanCriteria  = report.orphan_criteria.map((o) => o.id);
  const orchDrift           = report.drift;

  function stampField(field, orchVal) {
    const modelVal = gate[field];
    const entry = { field, orchestrator: orchVal };
    if (JSON.stringify(modelVal) !== JSON.stringify(orchVal)) {
      entry.model_said = modelVal;
    }
    stamp.fields.push(entry);
    gate[field] = orchVal;
  }

  stampField("criteria_count",            orchCriteriaCount);
  stampField("scenarios_count",           orchScenariosCount);
  stampField("criteria_to_scenario_mapping", orchMapping);
  stampField("all_criteria_mapped",       orchAllMapped);
  stampField("orphan_scenarios",          orchOrphanScenarios);
  stampField("orphan_criteria",           orchOrphanCriteria);
  stampField("drift",                     orchDrift);

  if (!orchAllMapped || orchDrift) {
    const orphCritStr = orchOrphanCriteria.join(", ") || "none";
    const orphScenCount = report.orphan_scenarios.length;
    const dupCount = report.duplicate_criteria.length;
    const dupStr = dupCount > 0
      ? `, duplicate_criteria=${dupCount} (${report.duplicate_criteria.map((d) => d.id).join(", ")})`
      : "";
    blockers.push(
      `spec drift: orphan_criteria=[${orphCritStr}], orphan_scenarios=${orphScenCount}${dupStr}`
    );
  }

  // ADR-009 Phase 3: reproduction tri-state (repair mode only).
  // When the PM model writes `reproduced` in the gate (indicating a repair run),
  // the stamp handles each case:
  //   "unverifiable: <reason>" — cannot write a runnable test; WARN loudly, no
  //     blocker so the run proceeds; manual verification of fix effectiveness is
  //     required. Never silent-pass: the WARN is always added.
  //   true | false — run the project's test command to capture the pre-build
  //     (pre-fix) baseline; stampStage04a reads this record and finalizes the
  //     field after the build applies the fix and tests are confirmed green.
  const modelReproduced = gate.reproduced;
  if (modelReproduced !== undefined) {
    const isUnverifiable = typeof modelReproduced === "string" &&
      modelReproduced.startsWith("unverifiable:");
    if (isUnverifiable) {
      stamp.fields.push({ field: "reproduced", orchestrator: modelReproduced });
      gate.warnings = Array.isArray(gate.warnings) ? gate.warnings : [];
      gate.warnings.push(
        `WARN reproduction-unverifiable: ${modelReproduced} — ` +
        `manual verification of fix effectiveness required; stamp cannot verify red→green`,
      );
      stamp.runs.reproduction_pre_build = { unverifiable: true, reason: modelReproduced };
    } else {
      // true or false claim. Run the test command to record the pre-build state.
      // At stage-03b time the regression test code has not been written yet (the
      // build stage does that), so this captures any currently-failing tests.
      // stampStage04a combines this with the post-build result to finalize reproduced.
      const config = loadConfig(cwd);
      const testExecution = await executeTests(cwd, config, gatePath, "stage-03b:reproduction-pre-build");
      if (testExecution) {
        const preBuildPassed = testExecution.passed;
        stamp.runs.reproduction_pre_build = {
          ...testRunRecord(testExecution),
          pre_build_tests_passed: preBuildPassed,
        };
      } else {
        stamp.runs.reproduction_pre_build = { skipped: "no test command configured or discovered" };
      }
      // Keep model's claim; stampStage04a finalizes after the build.
      stamp.fields.push({ field: "reproduced", model_said: modelReproduced, orchestrator_deferred: "verified-at-stage-04a" });
    }
  }

  return finalizeStamp(gate, gatePath, blockers, stamp);
}

// 31.1: Stage-04 (Build) multi-workstream stamping. Build dispatches
// backend/frontend/platform/qa as separate workstreams (STAGES.build,
// core/pipeline/stages.js); each writes its own pipeline/gates/stage-04.<role>.json,
// merged into pipeline/gates/stage-04.json by mergeWorkstreamGates. Previously
// STAMPABLE_STAGES stamping was gated on `plan.workstreams.length === 1`
// (see core/orchestrator.js), so build was never verified. Two scopes now:
//   - workstream-scoped (stampStage04Workstream): lint scoped to the role's
//     allowedWrites surface; runs as each workstream's gate lands.
//   - workspace-global (stampStage04Merged): the full test suite, run once
//     against the merged gate after all workstreams land — receipts (see
//     core/verify/receipts.js) mean this and the per-role test checks below
//     collapse to one real subprocess run when the workspace hasn't changed.

// Directory-shaped allowedWrites entries (trailing "/") are the role's source
// surface; file-shaped entries (package.json, pipeline/pr-<role>.md, etc.)
// aren't lint targets.
function scopedPathsFor(allowedWrites) {
  if (!Array.isArray(allowedWrites)) return [];
  return allowedWrites.filter((p) => typeof p === "string" && p.endsWith("/"));
}

function existingScopedPaths(cwd, scopedPaths) {
  return scopedPaths.filter((p) => {
    try {
      return fs.statSync(path.resolve(cwd, p)).isDirectory();
    } catch {
      return false;
    }
  });
}

// Best-effort scoping: appends the role's paths as extra positional args.
// `npm run <script>` needs `--` to forward args to the underlying script;
// a directly-configured command (e.g. "npx eslint") takes them as-is. Tools
// that ignore extra path args just lint the whole project — scoped_paths is
// recorded on the stamp regardless, so that limitation is auditable rather
// than silent.
function scopedLintCommand(baseCommand, scopedPaths) {
  if (scopedPaths.length === 0) return baseCommand;
  const separator = /^npm run\s/.test(baseCommand) ? " -- " : " ";
  return `${baseCommand}${separator}${scopedPaths.join(" ")}`;
}

async function stampStage04Workstream(cwd, gatePath, { role, allowedWrites } = {}) {
  const config = loadConfig(cwd);
  const { gate, error } = loadGateSafe(gatePath);
  if (error) return { ok: false, error };

  const stamp = {
    stamper_version: STAMPER_VERSION,
    at: new Date().toISOString(),
    scope: "workstream",
    role,
    fields: [],
    runs: {},
  };
  const blockers = Array.isArray(gate.blockers) ? gate.blockers.slice() : [];

  const commands = resolveCommands(cwd, config);
  const declaredScopedPaths = scopedPathsFor(allowedWrites);
  // roleWrites describe the framework's normal project layout, but a narrow
  // repair can legitimately target a different surface (and some supported
  // projects do not use src/<role>/ at all). Passing nonexistent directories
  // makes tools such as ESLint fail before they inspect any code. Retain every
  // existing role-owned directory; if none exists, run the project's canonical
  // lint command unscoped instead of manufacturing a false verification failure.
  const scopedPaths = existingScopedPaths(cwd, declaredScopedPaths);
  const unavailableScopedPaths = declaredScopedPaths.filter((p) => !scopedPaths.includes(p));
  if (commands.lint) {
    const scopedCommand = scopedLintCommand(commands.lint, scopedPaths);
    const result = await runCommandWithReceipt(scopedCommand, {
      cwd,
      receipts: {
        root: receiptRootFromGate(gatePath),
        cwd,
        config,
        purpose: `stage-04:lint:${role}`,
        suiteId: `lint-${role}`,
        enabled: config.pipeline.verify.receipts !== false,
      },
    });
    const passed = result.exitCode === 0 && !result.timedOut && !result.spawnError;
    if (typeof gate.lint_passed === "boolean" && gate.lint_passed !== passed) {
      stamp.fields.push({ field: "lint_passed", model_said: gate.lint_passed, orchestrator: passed });
    } else {
      stamp.fields.push({ field: "lint_passed", orchestrator: passed });
    }
    gate.lint_passed = passed;
    stamp.runs.lint = {
      command: result.command,
      scoped_paths: scopedPaths.length > 0 ? scopedPaths : undefined,
      unavailable_scoped_paths: unavailableScopedPaths.length > 0 ? unavailableScopedPaths : undefined,
      exit_code: result.exitCode,
      duration_ms: result.durationMs,
      timed_out: result.timedOut || undefined,
      spawn_error: result.spawnError || undefined,
      receipt: result.receipt || undefined,
    };
    if (!passed) {
      blockers.push(
        `lint failed [${role}] (exit ${result.exitCode}${result.timedOut ? ", timed out" : ""}): ${result.command}`,
      );
    }
  } else {
    stamp.runs.lint = { skipped: "no lint command configured or discovered" };
  }

  // Not path-scoped: polyglot test commands (npm test / pytest / go test / configured
  // test_suites) can't be portably filtered to a role's subtree. Same command+purpose
  // as stampStage04Merged below, so the receipt cache (not new dedup logic) is what
  // keeps 4 workstreams from meaning 4 real full-suite executions.
  const testExecution = await executeTests(cwd, config, gatePath, "stage-04:test");
  if (testExecution) {
    const passed = testExecution.passed;
    if (typeof gate.tests_passed === "boolean" && gate.tests_passed !== passed) {
      stamp.fields.push({ field: "tests_passed", model_said: gate.tests_passed, orchestrator: passed });
    } else {
      stamp.fields.push({ field: "tests_passed", orchestrator: passed });
    }
    gate.tests_passed = passed;
    stamp.runs.test = testRunRecord(testExecution);
    if (!passed) appendTestFailures(blockers, testExecution);
  } else {
    stamp.runs.test = { skipped: "no test command configured or discovered" };
  }

  return finalizeStamp(gate, gatePath, blockers, stamp);
}

// Workspace-global: the merged stage-04.json gate. mergeWorkstreamGates
// (core/orchestrator.js) already rolls any per-role `tests_passed` self-report
// into `merged.tests_passed` before this runs, so a model claim that
// disagrees with the real suite is recorded as model_said and overridden here.
async function stampStage04Merged(cwd, gatePath) {
  const config = loadConfig(cwd);
  const { gate, error } = loadGateSafe(gatePath);
  if (error) return { ok: false, error };

  const stamp = {
    stamper_version: STAMPER_VERSION,
    at: new Date().toISOString(),
    scope: "merged",
    fields: [],
    runs: {},
  };
  const blockers = Array.isArray(gate.blockers) ? gate.blockers.slice() : [];

  const testExecution = await executeTests(cwd, config, gatePath, "stage-04:test");
  if (testExecution) {
    const passed = testExecution.passed;
    if (typeof gate.tests_passed === "boolean" && gate.tests_passed !== passed) {
      stamp.fields.push({ field: "tests_passed", model_said: gate.tests_passed, orchestrator: passed });
    } else {
      stamp.fields.push({ field: "tests_passed", orchestrator: passed });
    }
    gate.tests_passed = passed;
    stamp.runs.test = testRunRecord(testExecution);
    if (!passed) appendTestFailures(blockers, testExecution);
  } else {
    stamp.runs.test = { skipped: "no test command configured or discovered" };
  }

  return finalizeStamp(gate, gatePath, blockers, stamp);
}

// 31.5: stage-05 (peer-review) merged dispatch — post-merge, host-independent
// re-derivation of approval state. On claude-code, the PostToolUse hook
// (core/hooks/approval-derivation.js) keeps stage-05.<area>.json in sync with
// pipeline/code-review/by-*.md as reviews are written; on every other host
// (and any claude-code save that happened outside the hook — the reason
// `devteam derive-approvals` exists) nothing parses those files automatically,
// so a workstream gate can claim PASS off a self-written status that never
// matched what the review file actually says. This closes that gap
// unconditionally, using the hook's own parseReviewFile() — never a
// reimplementation of the REVIEW:/CHANGES REQUESTED grammar.
//
// Scope: only panel-mode per-area workstreams (backend/frontend/platform/qa)
// are re-derived here. Adversarial mode's "reviewer"/"critic" workstreams
// (31.3) don't map onto a single area name — by-reviewer.md covers every
// area in one file and by-critic.md uses a different (challenge) grammar —
// so ADVERSARIAL_WORKSTREAM_ROLES are skipped rather than falsely flagged
// as having "no parseable verdict" for an area named "reviewer"/"critic".
const ADVERSARIAL_WORKSTREAM_ROLES = new Set(["reviewer", "critic"]);

async function stampStage05Merged(cwd, gatePath) {
  const { gate, error } = loadGateSafe(gatePath);
  if (error) return { ok: false, error };

  const stamp = {
    stamper_version: STAMPER_VERSION,
    at: new Date().toISOString(),
    scope: "merged",
    fields: [],
    runs: {},
  };
  const blockers = Array.isArray(gate.blockers) ? gate.blockers.slice() : [];

  // pipeline/code-review/ is always the sibling of the gates dir this gate
  // lives in — true for both in-place (pipeline/gates, pipeline/code-review)
  // and bounded (pipeline/changes/<id>/gates, pipeline/changes/<id>/code-review)
  // isolation, so no changeId plumbing is needed here.
  const reviewDir = path.join(path.dirname(gatePath), "..", "code-review");
  let reviewFiles = [];
  if (fs.existsSync(reviewDir)) {
    try {
      reviewFiles = fs.readdirSync(reviewDir).filter((f) => /^by-[\w-]+\.md$/.test(f));
    } catch { reviewFiles = []; }
  }

  const { parseReviewFile } = require("../hooks/approval-derivation");
  const derivedByArea = new Map();
  for (const file of reviewFiles) {
    const verdicts = parseReviewFile(path.join(reviewDir, file));
    for (const v of verdicts) {
      const entry = derivedByArea.get(v.area) || { approved: false, changesRequested: false };
      if (v.verdict === "CHANGES_REQUESTED") entry.changesRequested = true;
      if (v.verdict === "APPROVED") entry.approved = true;
      derivedByArea.set(v.area, entry);
    }
  }
  stamp.runs.review_files = {
    dir: reviewDir,
    files_found: reviewFiles.length,
    areas_derived: Array.from(derivedByArea.keys()),
  };

  const workstreams = Array.isArray(gate.workstreams) ? gate.workstreams : [];
  for (const ws of workstreams) {
    if (ADVERSARIAL_WORKSTREAM_ROLES.has(ws.workstream)) continue;
    if (ws.status !== "PASS") continue; // only claimed approvals need re-deriving

    const derived = derivedByArea.get(ws.workstream);
    const fileSaid = !derived ? "NO_PARSEABLE_VERDICT"
      : derived.changesRequested ? "CHANGES_REQUESTED"
      : "APPROVED";
    if (fileSaid === "APPROVED") continue; // agrees — leave untouched

    stamp.fields.push({
      field: "approval_state", workstream: ws.workstream, gate_said: "APPROVED", file_said: fileSaid,
    });
    blockers.push(
      `peer-review approval mismatch: workstream "${ws.workstream}" gate claims APPROVED but ` +
      (fileSaid === "NO_PARSEABLE_VERDICT"
        ? `no review file under pipeline/code-review/ has a parseable "## Review of ${ws.workstream}" verdict`
        : `pipeline/code-review says CHANGES REQUESTED`),
    );
  }

  return finalizeStamp(gate, gatePath, blockers, stamp);
}

// Per-workstream dispatch — stamps one role's own gate as it completes.
async function stampWorkstream(cwd, stageId, gatePath, ctx = {}) {
  if (!STAMPABLE_WORKSTREAM_STAGES.has(stageId)) {
    return { ok: false, error: `no orchestrator workstream stamping defined for ${stageId}` };
  }
  if (!fs.existsSync(gatePath)) {
    return { ok: false, error: `gate not found: ${gatePath}` };
  }
  switch (stageId) {
    case "stage-04": return stampStage04Workstream(cwd, gatePath, ctx);
    default:          return { ok: false, error: `no orchestrator workstream stamping defined for ${stageId}` };
  }
}

// Merged dispatch — stamps the workspace-global gate once, after merge.
async function stampMerged(cwd, stageId, gatePath) {
  if (!STAMPABLE_MERGE_STAGES.has(stageId)) {
    return { ok: false, error: `no orchestrator merged stamping defined for ${stageId}` };
  }
  if (!fs.existsSync(gatePath)) {
    return { ok: false, error: `gate not found: ${gatePath}` };
  }
  switch (stageId) {
    case "stage-04": return stampStage04Merged(cwd, gatePath);
    case "stage-05": return stampStage05Merged(cwd, gatePath);
    default:          return { ok: false, error: `no orchestrator merged stamping defined for ${stageId}` };
  }
}

// Stages with per-role workstream stamping / one-shot merged stamping (31.1).
// stage-05 (31.5) only ever gets the merged pass — panel-mode areas don't
// need a per-role stamp of their own the way stage-04's roles do.
const STAMPABLE_WORKSTREAM_STAGES = new Set(["stage-04"]);
const STAMPABLE_MERGE_STAGES = new Set(["stage-04", "stage-05"]);

function finalizeStamp(gate, gatePath, blockers, stamp) {
  // If the orchestrator detected failures, force gate status to FAIL.
  // The model may have written PASS optimistically; orchestrator's truth
  // wins. Existing FAIL or ESCALATE is preserved (orchestrator never
  // upgrades a FAIL to PASS).
  const originalStatus = gate.status;
  const orchestratorFailed = blockers.length > (Array.isArray(gate.blockers) ? gate.blockers.length : 0);
  if (orchestratorFailed) {
    if (gate.status === "PASS" || gate.status === "WARN") {
      gate.status = "FAIL";
      stamp.status_overridden = { from: originalStatus, to: "FAIL", reason: "orchestrator verification failed" };
    }
  }

  gate.blockers = blockers;
  gate._orchestrator_stamped = stamp;
  gate.timestamp = new Date().toISOString();

  fs.writeFileSync(gatePath, JSON.stringify(gate, null, 2) + "\n", "utf8");
  return { ok: true, gate, stamp };
}

// Public dispatch — pick the right stamper for a stage id.
async function stamp(cwd, stageId) {
  if (!STAMPABLE_STAGES.has(stageId)) {
    return { ok: false, error: `no orchestrator stamping defined for ${stageId}` };
  }
  // B9 exemption: stamp() reads gates from in-place pipeline/gates/; callers
  // that need bounded paths should pass an explicit gatePath (future enhancement).
  const gatesDir = path.join(cwd, "pipeline", "gates");
  const gatePath = path.join(gatesDir, `${stageId}.json`);
  if (!fs.existsSync(gatePath)) {
    return { ok: false, error: `gate not found: ${gatePath}` };
  }
  switch (stageId) {
    case "stage-03b": return stampStage03b(cwd, gatePath);
    case "stage-04a": return stampStage04a(cwd, gatePath);
    case "stage-04c": return stampStage04c(cwd, gatePath);
    case "stage-06":  return stampStage06(cwd, gatePath);
    case "stage-06d": return stampStage06d(cwd, gatePath);
    default:          return { ok: false, error: `no orchestrator stamping defined for ${stageId}` };
  }
}

// Stages this module knows how to verify. Callers can use this to
// decide whether to invoke stamp() at all.
const STAMPABLE_STAGES = new Set(["stage-03b", "stage-04a", "stage-04c", "stage-06", "stage-06d"]);

module.exports = {
  stamp,
  stampStage03b,
  stampStage04a,
  stampStage04c,
  stampStage06,
  stampStage06d,
  STAMPABLE_STAGES,
  // 31.1: multi-workstream (stage-04) per-role + merged stamping.
  stampWorkstream,
  stampMerged,
  stampStage04Workstream,
  stampStage04Merged,
  // 31.5: stage-05 merged approval re-derivation.
  stampStage05Merged,
  STAMPABLE_WORKSTREAM_STAGES,
  STAMPABLE_MERGE_STAGES,
  STAMPER_VERSION,
  extractAcsFromBrief, // exposed for tests
  extractAcsFromReport,
};
