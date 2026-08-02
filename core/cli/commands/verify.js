"use strict";

const path = require("node:path");
const { generateHelp } = require(path.join(__dirname, "..", "flags"));

const name = "verify";

const flags = {
  cwd:  { type: "string",  description: "Target project directory" },
  json: { type: "boolean", description: "JSON output" },
  help: { type: "boolean", description: "Show this help" },
};

async function run(positional, _flags) {
  if (_flags.help) { console.log(generateHelp("devteam verify <stage-id> [options]", flags)); process.exit(0); }
  const cwd = _flags.cwd || process.cwd();
  const stageId = positional[0];
  if (!stageId) {
    console.error("Usage: devteam verify <stage-id> [--json]");
    console.error("");
    console.error("Runs orchestrator-side verification for a stage and stamps the");
    console.error("gate with what was actually observed. Currently supports:");
    console.error("  stage-04a  pre-review: runs lint + tests, stamps lint_passed/tests_passed");
    console.error("  stage-04c  red-team:   mechanical floor — dependency audit, secret-scan,");
    console.error("                         semgrep (if configured), and a lockfile delta;");
    console.error("                         merges into findings_count/must_address_before_peer_review");
    console.error("  stage-06   qa:         runs tests + AC→test mapping check, stamps");
    console.error("                         all_acceptance_criteria_met and the test exit code");
    console.error("");
    console.error("Commands resolve from .devteam/config.yml pipeline.verify.{lint,test}_command");
    console.error("if set. Otherwise lint uses package.json scripts.lint; tests discover");
    console.error("package.json scripts.test, pytest projects, and Go modules.");
    console.error("");
    console.error("On verification failure, the gate's status flips to FAIL and the orchestrator");
    console.error("records a structured _orchestrator_stamped entry with commands, exit codes,");
    console.error("and which fields it overrode.");
    process.exit(2);
  }
  const { stamp, STAMPABLE_STAGES } = require(path.join(__dirname, "..", "..", "verify", "stamp"));
  if (!STAMPABLE_STAGES.has(stageId)) {
    console.error(`devteam verify: no orchestrator stamping defined for "${stageId}".`);
    console.error(`Supported stages: ${Array.from(STAMPABLE_STAGES).join(", ")}.`);
    process.exit(2);
  }
  const result = await stamp(cwd, stageId);
  if (!result.ok) {
    if (_flags.json) {
      console.log(JSON.stringify({ ok: false, error: result.error }, null, 2));
    } else {
      console.error(`devteam verify: ${result.error}`);
    }
    process.exit(1);
  }
  if (_flags.json) {
    console.log(JSON.stringify({ ok: true, stamp: result.stamp, status: result.gate.status }, null, 2));
    return;
  }
  const s = result.stamp;
  const icon = result.gate.status === "PASS" ? "✅" : "❌";
  console.log(`${icon} ${stageId}: orchestrator verification ${result.gate.status}`);
  for (const r of Object.keys(s.runs)) {
    const run = s.runs[r];
    if (Array.isArray(run.findings)) {
      // stage-04c mechanical floor tools: {ran, skipped, reason, findings}.
      if (run.skipped) {
        console.log(`   ${r}: skipped (${run.reason})`);
      } else {
        console.log(`   ${r}: ran — ${run.findings.length} finding(s) (${run.reason})`);
      }
    } else if (run.skipped) {
      console.log(`   ${r}: skipped (${run.skipped})`);
    } else if (run.command) {
      const exitLabel = run.exit_code === 0 ? "✓" : `✗ exit ${run.exit_code}`;
      console.log(`   ${r}: ${exitLabel}  $ ${run.command}  (${run.duration_ms}ms)`);
      if (Array.isArray(run.suites)) {
        for (const suite of run.suites) {
          const suiteExit = suite.exit_code === 0 ? "✓" : `✗ exit ${suite.exit_code}`;
          console.log(`      ${suite.id}: ${suiteExit}  $ ${suite.command}  (${suite.duration_ms}ms)`);
        }
      }
    } else if (run.unmapped_acs) {
      console.log(`   ${r}: brief has ${run.brief_ac_count} AC(s), report covers ${run.report_ac_count}, unmapped: ${run.unmapped_acs.join(", ") || "none"}`);
    }
  }
  if (s.status_overridden) {
    console.log(`   ⚠ status flipped: ${s.status_overridden.from} → ${s.status_overridden.to} (${s.status_overridden.reason})`);
  }
  for (const f of s.fields) {
    if (f.model_said !== undefined) {
      console.log(`   ⚠ ${f.field}: model said ${f.model_said}, orchestrator observed ${f.orchestrator}`);
    }
  }
}

module.exports = { name, flags, run };
