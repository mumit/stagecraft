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
    case "stage-06":  return stampStage06(cwd, gatePath);
    default:          return { ok: false, error: `no orchestrator stamping defined for ${stageId}` };
  }
}

// Stages this module knows how to verify. Callers can use this to
// decide whether to invoke stamp() at all.
const STAMPABLE_STAGES = new Set(["stage-03b", "stage-04a", "stage-06"]);

module.exports = {
  stamp,
  stampStage03b,
  stampStage04a,
  stampStage06,
  STAMPABLE_STAGES,
  STAMPER_VERSION,
  extractAcsFromBrief, // exposed for tests
  extractAcsFromReport,
};
