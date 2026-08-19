"use strict";

const fs = require("node:fs");
const path = require("node:path");
const { generateHelp } = require(path.join(__dirname, "..", "flags"));

const name = "verify";

const flags = {
  cwd:  { type: "string",  description: "Target project directory" },
  track: { type: "string", description: "Override the active pipeline track" },
  json: { type: "boolean", description: "JSON output" },
  help: { type: "boolean", description: "Show this help" },
};

async function run(positional, _flags) {
  if (_flags.help) { console.log(generateHelp("devteam verify <stage-id> [options]", flags)); process.exit(0); }
  const cwd = _flags.cwd || process.cwd();
  const stageId = positional[0];
  if (!stageId) {
    console.error("Usage: devteam verify <stage-id> [--track <t>] [--json]");
    console.error("");
    console.error("Runs orchestrator-side verification for a stage and stamps the");
    console.error("gate with what was actually observed. Currently supports:");
    console.error("  stage-04a  pre-review: runs lint + tests, stamps lint_passed/tests_passed");
    console.error("  stage-04c  red-team:   mechanical floor — dependency audit, secret-scan,");
    console.error("                         semgrep (if configured), and a lockfile delta;");
    console.error("                         merges into findings_count/must_address_before_peer_review");
    console.error("  stage-06   qa:         runs tests + AC→test mapping check, stamps");
    console.error("                         all_acceptance_criteria_met and the test exit code");
    console.error("  stage-06d  verification-beyond-tests: for each claimed method (property/");
    console.error("                         mutation/formal), runs it for real and stamps what");
    console.error("                         executed; an unverifiable claim downgrades to");
    console.error("                         attempted_but_blocked:<method>");
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
  const frameworkRoot = path.join(__dirname, "..", "..");
  const { stamp, STAMPABLE_STAGES } = require(path.join(frameworkRoot, "verify", "stamp"));
  if (!STAMPABLE_STAGES.has(stageId)) {
    console.error(`devteam verify: no orchestrator stamping defined for "${stageId}".`);
    console.error(`Supported stages: ${Array.from(STAMPABLE_STAGES).join(", ")}.`);
    process.exit(2);
  }
  const { loadConfig } = require(path.join(frameworkRoot, "config"));
  const { gatesDir: getGatesDir } = require(path.join(frameworkRoot, "paths"));
  const { verifyChain, stampAll } = require(path.join(frameworkRoot, "gates", "chain"));
  const { resolveActiveTrack, trackLabel } = require(path.join(frameworkRoot, "pipeline", "active-track"));
  const config = loadConfig(cwd);
  const gatesDir = getGatesDir(cwd, null);
  const active = resolveActiveTrack(cwd, config, _flags.track);
  const before = verifyChain(gatesDir, active.track);
  const signedWithoutSecret = before.unverified_signatures.length > 0 && !process.env.DEVTEAM_SIGNING_SECRET;
  const signedPolicyWithoutSecret = config.pipeline.require_signed_gates && !process.env.DEVTEAM_SIGNING_SECRET;
  if (before.invalid_macs.length > 0 || signedWithoutSecret || signedPolicyWithoutSecret) {
    const error = before.invalid_macs.length > 0
      ? "gate chain has an invalid signature; refusing to rewrite audit history"
      : "gate chain requires DEVTEAM_SIGNING_SECRET before on-demand verification can rewrite history";
    if (_flags.json) console.log(JSON.stringify({ ok: false, error }, null, 2));
    else console.error(`devteam verify: ${error}`);
    process.exit(1);
  }

  const snapshots = new Map();
  if (fs.existsSync(gatesDir)) {
    for (const file of fs.readdirSync(gatesDir).filter((entry) => entry.endsWith(".json"))) {
      const absolute = path.join(gatesDir, file);
      snapshots.set(absolute, fs.readFileSync(absolute));
    }
  }
  const restoreGates = () => {
    for (const [file, bytes] of snapshots) fs.writeFileSync(file, bytes);
  };

  const result = await stamp(cwd, stageId);
  if (!result.ok) {
    restoreGates();
    if (_flags.json) {
      console.log(JSON.stringify({ ok: false, error: result.error }, null, 2));
    } else {
      console.error(`devteam verify: ${result.error}`);
    }
    process.exit(1);
  }
  const repaired = stampAll(gatesDir, active.track);
  if (repaired.failed.length > 0) {
    restoreGates();
    const error = `verification succeeded but chain repair failed: ${repaired.failed.map((failure) => `${failure.stage}: ${failure.reason}`).join("; ")}`;
    if (_flags.json) console.log(JSON.stringify({ ok: false, error }, null, 2));
    else console.error(`devteam verify: ${error}`);
    process.exit(1);
  }
  const chain = {
    track: trackLabel(active.track),
    track_source: active.source,
    prior_breaks: before.breaks.length,
    restamped: repaired.stamped,
    signed: repaired.signed,
  };
  if (_flags.json) {
    console.log(JSON.stringify({ ok: true, stamp: result.stamp, status: result.gate.status, chain }, null, 2));
    return;
  }
  const s = result.stamp;
  const icon = result.gate.status === "PASS" ? "✅" : "❌";
  console.log(`${icon} ${stageId}: orchestrator verification ${result.gate.status}`);
  console.log(`   chain: re-stamped ${chain.restamped.length} gate(s) on ${chain.track} (${chain.track_source})`);
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
