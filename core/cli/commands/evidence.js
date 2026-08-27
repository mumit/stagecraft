"use strict";

const path = require("node:path");
const { generateHelp } = require(path.join(__dirname, "..", "flags"));
const { loadConfig, checkBoundedFence } = require(path.join(__dirname, "..", "..", "config"));
const { resolveChangeId } = require(path.join(__dirname, "..", "resolve-change-id"));
const { pipelineRoot } = require(path.join(__dirname, "..", "..", "paths"));
const { readEvidenceSources, countDispatchesOutsideRun, priorEvidenceSummary } = require(path.join(__dirname, "..", "..", "evidence", "readers"));
const { analyzeEvidence } = require(path.join(__dirname, "..", "..", "evidence", "analyzer"));
const {
  assertExportDestination, createBundle, writeBundle,
} = require(path.join(__dirname, "..", "..", "evidence", "bundle"));
const {
  readIdentity, getOrCreateIdentity, rotateIdentity, deleteIdentity,
} = require(path.join(__dirname, "..", "..", "evidence", "identity"));
const { analyzePortfolio } = require(path.join(__dirname, "..", "..", "evidence", "portfolio"));
const { appendAcceptedResolution } = require(path.join(__dirname, "..", "..", "evidence", "resolutions"));
const { appendRecordedRuling } = require(path.join(__dirname, "..", "..", "evidence", "rulings"));
const {
  createAttestation, readAttestation, writeAttestation, signAttestation,
  assertExportDestination: assertAttestationDestination,
} = require(path.join(__dirname, "..", "..", "evidence", "attestation"));

const name = "evidence";
const flags = {
  cwd: { type: "string", description: "Target project directory" },
  feature: { type: "string", description: "Feature name for bounded isolation" },
  json: { type: "boolean", description: "Emit stable aggregate JSON" },
  out: { type: "string", description: "New local export file" },
  consent: { type: "boolean", description: "Acknowledge the documented export boundary" },
  bundle: { type: "list", description: "Validated bundle for portfolio status (repeatable)" },
  rotate: { type: "boolean", description: "Rotate the local project identity" },
  delete: { type: "boolean", description: "Delete the local project identity" },
  yes: { type: "boolean", description: "Confirm identity mutation, resolution acceptance, or ruling record" },
  class: { type: "string", description: "Ruling class for record-ruling (lowercase-kebab, e.g. formatting-only)" },
  stage: { type: "string", description: "Stage to accept a resolution for (default: the newest unaccepted one)" },
  attestation: { type: "boolean", description: "Export an in-toto-shaped, per-stage attestation instead of the aggregate bundle" },
  track: { type: "string", description: "Override the pipeline track for --attestation chain verification" },
  "allow-unverified": { type: "boolean", description: "Attest even when the gate chain is broken, stamping the bundle as unverified" },
  sign: { type: "boolean", description: "Sign the --attestation bundle with cosign sign-blob (must be on PATH)" },
  help: { type: "boolean", description: "Show this help" },
};

function renderCondition(item) {
  const marker = item.met ? "met" : "missing";
  const reason = item.reason_code ? ` (${item.reason_code})` : "";
  return `    [${marker}] ${item.id}: ${item.value}/${item.threshold}${reason}`;
}

function renderProject(report) {
  const lines = [
    "# Evidence readiness", "",
    `Runs observed: ${report.scope.run_count} (${report.scope.complete_run_count} complete, ${report.scope.repair_run_count} repair)`,
    `Gate files read: ${report.quality.gate_files}`,
  ];
  const degraded = report.quality.malformed_records
    + report.quality.oversized_records
    + report.quality.unreadable_sources
    + report.quality.truncated_sources
    + report.quality.symlink_sources;
  const sourceState = !report.quality.log_present && report.quality.gate_files === 0
    ? "no evidence sources found"
    : degraded === 0 ? "complete for available sources" : `degraded (${degraded} source/record issue(s))`;
  lines.push(`Evidence quality: ${sourceState}`);
  // Dispatches recorded in the corpus with no run_id came from `devteam stage`,
  // not from the autonomous driver, and the driver is the only thing that emits
  // the durable `dispatch-observation` events routing readiness counts.
  //
  // Say so here rather than only in the exported bundle. The count has been
  // computed and exported since #442, but nothing printed it, so an operator
  // collecting routing evidence by running stages directly sees "complete for
  // available sources" and a stalled condition, with nothing connecting the two.
  // Phase 17's scope is deliberate -- a repeated stage dispatch against
  // unchanged code is not an independent routing observation -- but the
  // exclusion has to be visible to be a decision rather than a trap.
  const outsideRun = report.quality.dispatches_outside_run;
  if (typeof outsideRun === "number" && outsideRun > 0) {
    lines.push(
      `Dispatches not counted: ${outsideRun} recorded via \`devteam stage\``,
      "  Routing readiness counts autonomous `devteam run` dispatches only.",
    );
  }
  lines.push("");
  for (const item of report.readiness) {
    lines.push(`${item.capability} (#${item.issue}): ${item.status}`);
    for (const local of item.local_conditions) lines.push(renderCondition(local));
    lines.push(`    [portfolio] ${item.portfolio_status} (${item.portfolio_reason_code})`, "");
  }
  lines.push("This command is read-only. Threshold progress is evidence, not capability approval.");
  return `${lines.join("\n")}\n`;
}

function renderPortfolio(report) {
  const lines = [
    "# Portfolio evidence readiness", "",
    `Projects: ${report.scope.project_count} from ${report.scope.bundle_count} bundle(s) (${report.scope.duplicate_bundles} duplicate(s) ignored)`,
    `Runs observed: ${report.scope.run_count} (${report.scope.complete_run_count} complete, ${report.scope.repair_run_count} repair)`, "",
  ];
  for (const item of report.readiness) {
    lines.push(`${item.capability} (#${item.issue}): ${item.status}`);
    for (const entry of item.conditions) lines.push(renderCondition(entry));
    lines.push("");
  }
  lines.push("Threshold progress is evidence for human review, not capability approval.");
  return `${lines.join("\n")}\n`;
}

function localReport(commandFlags) {
  const cwd = path.resolve(commandFlags.cwd || process.cwd());
  const config = loadConfig(cwd);
  checkBoundedFence(config, name);
  const changeId = resolveChangeId(commandFlags, config);
  const sources = readEvidenceSources(pipelineRoot(cwd, changeId));
  return {
    cwd,
    report: analyzeEvidence({ ...sources, dispatchesOutsideRun: countDispatchesOutsideRun(cwd) }),
  };
}

function rejectFlags(commandFlags, names, subcommand) {
  const found = names.filter((flag) => commandFlags[flag] !== undefined);
  if (found.length > 0) {
    throw new Error(`${subcommand} does not accept ${found.map((flag) => `--${flag}`).join(", ")}`);
  }
}

function runStatus(commandFlags) {
  rejectFlags(commandFlags, ["out", "consent", "rotate", "delete", "yes"], "status");
  if (commandFlags.bundle) {
    if (commandFlags.cwd || commandFlags.feature) {
      throw new Error("--bundle cannot be combined with --cwd or --feature");
    }
    const report = analyzePortfolio(commandFlags.bundle.map((file) => path.resolve(file)));
    if (commandFlags.json) console.log(JSON.stringify(report, null, 2));
    else process.stdout.write(renderPortfolio(report));
    return;
  }
  const { report } = localReport(commandFlags);
  if (commandFlags.json) console.log(JSON.stringify(report, null, 2));
  else process.stdout.write(renderProject(report));
}

// A project's identity ties its bundles together across checkouts, and
// getOrCreateIdentity mints a fresh one whenever the file is absent — silently.
// A clone, a cleaned `.devteam/`, or an identity restored one command too late
// exports under a *different* project_ref, and the portfolio then reads those
// bundles as a second independent project, inflating every `N / 2` readiness
// threshold. Nothing surfaced `created: true` before this.
//
// Advisory and non-blocking: minting is correct for a genuinely new project,
// which is the common case. It is only suspicious when the project already
// produced evidence this id cannot account for, so the warning fires on that
// combination rather than on minting alone. stderr, so `--json` stdout stays
// machine-readable.
function warnOnMintedIdentity(cwd, commandFlags, identity) {
  if (!identity || !identity.created) return;
  let prior;
  try {
    prior = priorEvidenceSummary(cwd, resolveChangeId(commandFlags, loadConfig(cwd)));
  } catch {
    return; // a probe failure must never block an export
  }
  if (!prior.any) return;
  const found = [
    prior.dispatches > 0 ? `${prior.dispatches} dispatch record(s)` : null,
    prior.gates > 0 ? `${prior.gates} gate file(s)` : null,
    prior.run_log ? "a run log" : null,
  ].filter(Boolean).join(", ");
  process.stderr.write(
    `[devteam] warning: minted a new evidence identity for a project that already has ${found}.\n` +
    "          If this project exported evidence before, those bundles carry a different\n" +
    "          project_ref and a portfolio will count them as a separate project. Restore\n" +
    "          the saved .devteam/evidence-project-id and re-export. New project? Nothing to do.\n",
  );
}

function runExport(commandFlags) {
  if (commandFlags.attestation) return runExportAttestation(commandFlags);
  if (!commandFlags.out) throw new Error("evidence export requires --out <new-file.json>");
  if (!commandFlags.consent) throw new Error("evidence export requires --consent");
  rejectFlags(commandFlags, ["bundle", "rotate", "delete", "yes", "track", "sign", "allowUnverified"], "export");
  const destination = assertExportDestination(commandFlags.out);
  const { cwd, report } = localReport(commandFlags);
  const identity = getOrCreateIdentity(cwd);
  warnOnMintedIdentity(cwd, commandFlags, identity);
  const bundle = createBundle(report, identity.project_ref);
  writeBundle(destination, bundle);
  const result = {
    written: destination,
    project_ref: identity.project_ref,
    suppressed_observations: bundle.suppressed_observations,
  };
  if (commandFlags.json) console.log(JSON.stringify(result, null, 2));
  else {
    process.stdout.write(`Evidence bundle written: ${destination}\n`);
    process.stdout.write(`Project reference: ${identity.project_ref}\n`);
    process.stdout.write(`${bundle.suppressed_observations} sparse observation(s) suppressed. Inspect before sharing; retention and deletion are operator-owned.\n`);
  }
}

// devteam evidence export --attestation: full per-stage-fidelity, in-toto-shaped
// bundle for ONE run/commit (unlike the aggregate above, which is a privacy-
// preserving cross-run summary). Refuses on a broken gate chain unless
// --allow-unverified explicitly accepts an unverified bundle.
function runExportAttestation(commandFlags) {
  if (!commandFlags.out) throw new Error("evidence export --attestation requires --out <new-file.json>");
  rejectFlags(commandFlags, ["consent", "bundle", "rotate", "delete", "yes"], "export --attestation");
  const destination = assertAttestationDestination(commandFlags.out);
  const cwd = path.resolve(commandFlags.cwd || process.cwd());
  const config = loadConfig(cwd);
  checkBoundedFence(config, name);
  const changeId = resolveChangeId(commandFlags, config);
  const track = commandFlags.track
    || (Array.isArray(config.pipeline.custom_stages) ? config.pipeline.custom_stages : null)
    || config.pipeline.default_track || "full";
  let attestation;
  try {
    attestation = createAttestation(cwd, changeId, track, { allowUnverified: commandFlags.allowUnverified });
  } catch (error) {
    if (error.chainResult) {
      const r = error.chainResult;
      const details = [];
      for (const b of r.breaks) details.push(`  break: ${b.stage} recorded prev_hash for ${b.prev_stage || "(genesis)"} != recomputed`);
      if (r.unstamped.length) details.push(`  unstamped: ${r.unstamped.join(", ")}`);
      if (r.unsigned.length) details.push(`  unsigned: ${r.unsigned.join(", ")}`);
      if (r.invalid_macs.length) details.push(`  invalid macs: ${r.invalid_macs.map((m) => m.stage).join(", ")}`);
      throw new Error(`${error.message}\n${details.join("\n")}`);
    }
    throw error;
  }
  writeAttestation(destination, attestation);
  const signaturePath = commandFlags.sign ? signAttestation(destination) : null;
  const result = {
    written: destination,
    signature: signaturePath,
    project_ref: attestation.predicate.project_ref,
    unverified: attestation.predicate.unverified,
    stages: attestation.predicate.stages.length,
    resolutions: attestation.predicate.resolutions.length,
  };
  if (commandFlags.json) console.log(JSON.stringify(result, null, 2));
  else {
    process.stdout.write(`Attestation bundle written: ${destination}\n`);
    if (signaturePath) process.stdout.write(`Signature written: ${signaturePath}\n`);
    process.stdout.write(`Project reference: ${attestation.predicate.project_ref}\n`);
    process.stdout.write(`${result.stages} stage(s), ${result.resolutions} accepted resolution(s).\n`);
    if (result.unverified) {
      process.stdout.write("WARNING: gate chain verification failed; this bundle is stamped unverified (--allow-unverified).\n");
    }
  }
}

// devteam evidence verify-attestation <bundle>: offline re-check of the
// bundle's internal hashes + schema. Never touches the live pipeline —
// it only reads the file named on the command line.
function runVerifyAttestation(positional, commandFlags) {
  rejectFlags(commandFlags, ["feature", "out", "consent", "bundle", "rotate", "delete", "yes", "track", "sign", "allowUnverified"], "verify-attestation");
  const file = positional[1];
  if (!file) throw new Error("Usage: devteam evidence verify-attestation <bundle> [--json]");
  let attestation;
  try {
    attestation = readAttestation(path.resolve(file));
  } catch (error) {
    if (commandFlags.json) {
      console.log(JSON.stringify({ ok: false, error: error.message }, null, 2));
    } else {
      console.error(`devteam evidence verify-attestation: ${error.message}`);
    }
    process.exit(1);
  }
  const result = {
    ok: true,
    unverified: attestation.predicate.unverified,
    stages: attestation.predicate.stages.length,
    resolutions: attestation.predicate.resolutions.length,
    subject: attestation.subject.map((s) => s.digest.sha1),
  };
  if (commandFlags.json) console.log(JSON.stringify(result, null, 2));
  else {
    process.stdout.write(`✅ attestation valid — ${result.stages} stage(s), ${result.resolutions} accepted resolution(s)\n`);
    process.stdout.write(`Subject commit(s): ${result.subject.join(", ")}\n`);
    if (result.unverified) process.stdout.write("WARNING: bundle is stamped unverified (chain was broken at export time).\n");
  }
}

function publicIdentity(result) {
  return { exists: result.exists, project_ref: result.project_ref };
}

function runIdentity(commandFlags) {
  rejectFlags(commandFlags, ["feature", "out", "consent", "bundle"], "identity");
  if (commandFlags.rotate && commandFlags.delete) throw new Error("choose only one of --rotate or --delete");
  if ((commandFlags.rotate || commandFlags.delete) && !commandFlags.yes) {
    throw new Error("identity rotation and deletion require --yes");
  }
  const cwd = path.resolve(commandFlags.cwd || process.cwd());
  let result;
  let action = "status";
  if (commandFlags.rotate) {
    result = rotateIdentity(cwd);
    action = "rotated";
  } else if (commandFlags.delete) {
    const deleted = deleteIdentity(cwd);
    result = { exists: !deleted.deleted, project_ref: deleted.deleted ? null : readIdentity(cwd).project_ref };
    action = deleted.deleted ? "deleted" : "absent";
  } else {
    result = readIdentity(cwd);
  }
  const output = publicIdentity(result);
  if (commandFlags.json) console.log(JSON.stringify(output, null, 2));
  else process.stdout.write(`Evidence identity: ${action}; project reference: ${output.project_ref || "none"}\n`);
}

function runAcceptResolution(commandFlags) {
  rejectFlags(commandFlags, ["out", "consent", "bundle", "rotate", "delete"], "accept-resolution");
  if (!commandFlags.yes) throw new Error("resolution acceptance requires --yes");
  const cwd = path.resolve(commandFlags.cwd || process.cwd());
  const config = loadConfig(cwd);
  checkBoundedFence(config, name);
  const changeId = resolveChangeId(commandFlags, config);
  const event = appendAcceptedResolution(pipelineRoot(cwd, changeId), { stage: commandFlags.stage });
  const output = {
    accepted: true,
    stage: event.stage,
    failure_class: event.failure_class,
    schema_fingerprint: event.schema_fingerprint,
    derivable: event.derivable,
    source_event_sha256: event.source_event_sha256,
  };
  if (commandFlags.json) console.log(JSON.stringify(output, null, 2));
  else process.stdout.write(`Accepted ${output.stage}/${output.failure_class} resolution (${output.derivable ? "derivable" : "not derivable"}).\n`);
}

function runRecordRuling(commandFlags) {
  rejectFlags(commandFlags, ["out", "consent", "bundle", "rotate", "delete"], "record-ruling");
  if (!commandFlags.yes) throw new Error("recording a ruling requires --yes");
  const cwd = path.resolve(commandFlags.cwd || process.cwd());
  const config = loadConfig(cwd);
  checkBoundedFence(config, name);
  const changeId = resolveChangeId(commandFlags, config);
  const event = appendRecordedRuling(pipelineRoot(cwd, changeId), { rulingClass: commandFlags.class });
  const output = {
    recorded: true,
    ruling_class: event.ruling_class,
    stage: event.stage,
    halt_event_sha256: event.halt_event_sha256,
  };
  if (commandFlags.json) console.log(JSON.stringify(output, null, 2));
  else process.stdout.write(`Recorded ${output.ruling_class} ruling for ${output.stage}.\n`);
}

const USAGE = "devteam evidence <status|export|identity|accept-resolution|record-ruling|verify-attestation> [options]";

function run(positional, commandFlags) {
  if (commandFlags.help) {
    console.log(generateHelp(USAGE, flags));
    process.exit(0);
  }
  const sub = positional[0];
  const validSubs = ["status", "export", "identity", "accept-resolution", "record-ruling", "verify-attestation"];
  const expectedPositionals = sub === "verify-attestation" ? 2 : 1;
  if (!validSubs.includes(sub) || positional.length !== expectedPositionals) {
    process.stderr.write(`Usage: ${USAGE}\n`);
    process.exit(2);
  }
  if (sub === "status") return runStatus(commandFlags);
  if (sub === "export") return runExport(commandFlags);
  if (sub === "identity") return runIdentity(commandFlags);
  if (sub === "verify-attestation") return runVerifyAttestation(positional, commandFlags);
  if (sub === "record-ruling") return runRecordRuling(commandFlags);
  return runAcceptResolution(commandFlags);
}

module.exports = { name, flags, run, renderHuman: renderProject, renderPortfolio };
