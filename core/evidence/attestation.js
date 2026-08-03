"use strict";

// Phase-34 item 34.2 — gate chain -> in-toto-Statement-shaped signed evidence
// bundle. This PRODUCTIZES the existing evidence machinery (Phases 16-18:
// identity, chain, resolutions) rather than forking it: chain verification
// is delegated to core/gates/chain.js's verifyChain, human-acceptance
// records are read with the same bounded reader core/evidence/readers.js
// uses, and C4 reproducibility fields come straight from
// core/reproducibility.js's reproducibilityFingerprint.
//
// Distinct from core/evidence/bundle.js's `evidence export`: that bundle is
// a privacy-preserving AGGREGATE across many runs (suppressed sparse rows,
// pseudonymous project_ref, no per-stage detail). This attestation is the
// opposite shape on purpose — full per-stage fidelity for ONE run/commit, a
// signed proof an auditor can walk stage by stage. Never mix the two.
//
// "in-toto-Statement-shaped": the wrapper (_type/subject/predicateType/
// predicate) follows the public in-toto Statement layout so downstream
// tooling recognizes the shape, but predicateType is Stagecraft-namespaced
// (we don't claim a registered SLSA/in-toto predicate) and payload_sha256 is
// a Stagecraft-local tamper check, not a DSSE envelope or a cosign
// signature. `--sign` produces a detached cosign signature file alongside
// the bundle instead.

const fs = require("node:fs");
const path = require("node:path");
const { spawnSync } = require("node:child_process");
const { sha256, reproducibilityFingerprint } = require("../reproducibility");
const { getStage, orderedStageNamesForTrack, trackLabel } = require("../pipeline/stages");
const { loadGateSafe } = require("../gates/load-gate");
const { verifyChain } = require("../gates/chain");
const { gatesDir: getGatesDir, pipelineRoot } = require("../paths");
const { getOrCreateIdentity } = require("./identity");
const { readJsonLinesBounded } = require("./readers");
const { category } = require("./categories");
const { HASH_PATTERN } = require("./resolutions");
const { assertExportDestination } = require("./bundle");

const PREDICATE_SCHEMA_VERSION = "1.0";
const PREDICATE_TYPE = "urn:stagecraft:attestation:1.0";
const STATEMENT_TYPE = "https://in-toto.io/Statement/v1";
const MAX_ATTESTATION_BYTES = 2_000_000;
const SHA1_PATTERN = /^[0-9a-f]{40}$/;

function canonicalize(value) {
  if (Array.isArray(value)) return value.map(canonicalize);
  if (value && typeof value === "object") {
    const result = {};
    for (const key of Object.keys(value).sort()) result[key] = canonicalize(value[key]);
    return result;
  }
  return value;
}

function payloadDigest(statementWithoutDigest) {
  return sha256(JSON.stringify(canonicalize(statementWithoutDigest)));
}

// --- subject resolution (produced commit(s), from run-log + git) ----------

function runGit(cwd, args) {
  const result = spawnSync("git", args, { cwd, encoding: "utf8" });
  if (result.status !== 0 || result.error) return null;
  const out = (result.stdout || "").trim();
  return SHA1_PATTERN.test(out) ? out : null;
}

// Auto-commit run-log events (`devteam run --auto-commit`) record a short
// hash; expand each to the full sha the digest set needs.
function autoCommitHashesFromLog(cwd, pipelinePath) {
  const { records } = readJsonLinesBounded(path.join(pipelinePath, "run-log.jsonl"));
  const hashes = [];
  for (const event of records) {
    if (event && event.event === "auto-commit" && typeof event.commit_hash === "string" && event.commit_hash) {
      const full = runGit(cwd, ["rev-parse", event.commit_hash]);
      if (full && !hashes.includes(full)) hashes.push(full);
    }
  }
  return hashes;
}

// Best-effort: prefer explicit auto-commit events (this run's own record of
// what it produced); fall back to current HEAD (the common manual-commit
// workflow, where the operator commits themselves before exporting).
function resolveSubjectCommits(cwd, pipelinePath) {
  const hashes = autoCommitHashesFromLog(cwd, pipelinePath);
  const head = runGit(cwd, ["rev-parse", "HEAD"]);
  if (head && !hashes.includes(head)) hashes.push(head);
  if (hashes.length === 0) {
    throw new Error(
      "cannot create attestation: no producible commit found (not a git repository, "
      + "no commits yet, or no auto-commit run-log events)",
    );
  }
  return hashes.map((sha) => ({ name: "commit", digest: { sha1: sha } }));
}

// --- per-stage predicate entries -------------------------------------------

// {field, model_asserted, orchestrator_value, orchestrator_kind}. Only
// emitted when at least one side has a value — keeps entries dense, matching
// the evidence bundle's "never claim a zero you didn't observe" discipline.
function provenanceEntry(field, assertedValue, orchestratorValue, orchestratorKind) {
  return {
    field,
    model_asserted: assertedValue ?? null,
    orchestrator_value: orchestratorValue ?? null,
    orchestrator_kind: (orchestratorValue ?? null) !== null ? orchestratorKind : null,
  };
}

function fieldProvenanceEntries(gate) {
  const observed = (gate && gate._orchestrator_observed) || {};
  const entries = [];
  const pairs = [
    ["model", gate?.model ?? null, observed.model_observed ?? null],
    ["tokens_in", gate?.tokens_in ?? null, observed.tokens_in ?? null],
    ["tokens_out", gate?.tokens_out ?? null, observed.tokens_out ?? null],
    ["cost_usd", gate?.cost_usd ?? null, observed.cost_usd ?? null],
  ];
  for (const [field, asserted, orchestratorValue] of pairs) {
    if (asserted === null && orchestratorValue === null) continue;
    entries.push(provenanceEntry(field, asserted, orchestratorValue, "observed"));
  }
  // model_requested is orchestrator-stamped BEFORE dispatch — never model-asserted.
  if (gate && gate.model_requested != null) {
    entries.push(provenanceEntry("model_requested", null, gate.model_requested, "stamped"));
  }
  return entries;
}

function chainEntry(gate) {
  if (!gate || !gate.chain) return null;
  return {
    prev_stage: gate.chain.prev_stage ?? null,
    prev_hash: gate.chain.prev_hash ?? null,
    algo: gate.chain.algo || null,
    hmac_present: Boolean(gate.chain.mac),
  };
}

function authorityResolutionEntry(gate) {
  if (!gate || !gate.resolved_by || typeof gate.resolved_by !== "object") return null;
  const r = gate.resolved_by;
  return {
    authority: typeof r.authority === "string" ? r.authority : null,
    grant_class: typeof r.grant_class === "string" ? r.grant_class : null,
    ruling: typeof r.ruling === "string" ? r.ruling : null,
    ts: typeof r.ts === "string" ? r.ts : null,
  };
}

function stageEntryFromGate(gate) {
  return {
    stage: gate.stage,
    status: gate.status,
    provenance: fieldProvenanceEntries(gate),
    reproducibility: reproducibilityFingerprint(gate),
    prompt_pack_version: gate.prompt_pack_version || null,
    chain: chainEntry(gate),
    authority_resolution: authorityResolutionEntry(gate),
  };
}

function buildStageEntries(gatesDirPath, track) {
  const entries = [];
  for (const name of orderedStageNamesForTrack(track)) {
    const def = getStage(name);
    if (!def) continue;
    const gp = path.join(gatesDirPath, `${def.stage}.json`);
    if (!fs.existsSync(gp)) continue;
    const { gate, error } = loadGateSafe(gp);
    if (error || !gate) continue;
    entries.push(stageEntryFromGate(gate));
  }
  return entries;
}

// --- ADR-012 human-acceptance records (H3) --------------------------------

function readAcceptedResolutions(pipelinePath) {
  const { records } = readJsonLinesBounded(path.join(pipelinePath, "run-log.jsonl"));
  const entries = [];
  for (const event of records) {
    if (!event || event.outcome !== "resolution-accepted") continue;
    const stage = category(event.stage);
    const failure_class = category(event.failure_class);
    const schema_fingerprint = HASH_PATTERN.test(event.schema_fingerprint) ? event.schema_fingerprint : null;
    const source_event_sha256 = HASH_PATTERN.test(event.source_event_sha256) ? event.source_event_sha256 : null;
    if (!schema_fingerprint || !source_event_sha256) continue;
    entries.push({
      stage,
      failure_class,
      schema_fingerprint,
      derivable: event.derivable === true,
      source_event_sha256,
      accepted_at: typeof event.ts === "string" ? event.ts : null,
    });
  }
  return entries;
}

// --- create / validate / read / write --------------------------------------

function chainVerificationEntry(chainResult) {
  return {
    ok: chainResult.ok,
    checked: chainResult.checked,
    breaks: chainResult.breaks,
    unstamped: chainResult.unstamped,
    unsigned: chainResult.unsigned,
    invalid_macs: chainResult.invalid_macs,
    unverified_signatures: chainResult.unverified_signatures,
    require_signed: chainResult.require_signed,
  };
}

// options: { secret, requireSigned, allowUnverified, stagecraftVersion, generatedAt }
function createAttestation(cwd, changeId, track, options = {}) {
  const gatesDirPath = getGatesDir(cwd, changeId);
  const pipelinePath = pipelineRoot(cwd, changeId);
  const chainResult = verifyChain(gatesDirPath, track, {
    secret: options.secret,
    requireSigned: options.requireSigned,
  });
  if (!chainResult.ok && !options.allowUnverified) {
    const err = new Error(
      "gate chain verification failed; refusing to attest "
      + "(pass --allow-unverified to attest anyway — the bundle will record it as unverified)",
    );
    err.chainResult = chainResult;
    throw err;
  }
  const subject = resolveSubjectCommits(cwd, pipelinePath);
  const identity = getOrCreateIdentity(cwd);
  const predicate = {
    schema_version: PREDICATE_SCHEMA_VERSION,
    stagecraft_version: options.stagecraftVersion || require("../../package.json").version,
    generated_at: options.generatedAt || new Date().toISOString(),
    project_ref: identity.project_ref,
    track: trackLabel(track),
    chain_verification: chainVerificationEntry(chainResult),
    unverified: !chainResult.ok,
    stages: buildStageEntries(gatesDirPath, track),
    resolutions: readAcceptedResolutions(pipelinePath),
  };
  const statement = {
    _type: STATEMENT_TYPE,
    subject,
    predicateType: PREDICATE_TYPE,
    predicate,
  };
  const bundle = { ...statement, payload_sha256: payloadDigest(statement) };
  const errors = validateAttestation(bundle, { verifyDigest: true });
  if (errors.length > 0) throw new Error(`generated attestation is invalid: ${errors.join("; ")}`);
  return bundle;
}

function exactKeys(value, expected, label, errors) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    errors.push(`${label} must be an object`);
    return false;
  }
  const actual = Object.keys(value).sort();
  const wanted = [...expected].sort();
  if (actual.length !== wanted.length || actual.some((key, index) => key !== wanted[index])) {
    errors.push(`${label} has unexpected or missing properties`);
    return false;
  }
  return true;
}

function validNullableString(value) { return value === null || typeof value === "string"; }
function validNullableNumber(value) { return value === null || (typeof value === "number" && Number.isFinite(value)); }
function validHash(value) { return value === null || HASH_PATTERN.test(value); }

function validateSubject(subject, errors) {
  if (!Array.isArray(subject) || subject.length === 0) {
    errors.push("subject must be a non-empty array");
    return;
  }
  subject.forEach((entry, index) => {
    const label = `subject[${index}]`;
    if (!exactKeys(entry, ["name", "digest"], label, errors)) return;
    if (typeof entry.name !== "string" || entry.name.length === 0) errors.push(`${label}.name is invalid`);
    if (!exactKeys(entry.digest, ["sha1"], `${label}.digest`, errors)) return;
    if (!SHA1_PATTERN.test(entry.digest.sha1)) errors.push(`${label}.digest.sha1 is invalid`);
  });
}

function validateProvenance(entries, errors, label) {
  if (!Array.isArray(entries)) { errors.push(`${label} must be an array`); return; }
  entries.forEach((entry, index) => {
    const entryLabel = `${label}[${index}]`;
    if (!exactKeys(entry, ["field", "model_asserted", "orchestrator_value", "orchestrator_kind"], entryLabel, errors)) return;
    if (typeof entry.field !== "string" || entry.field.length === 0) errors.push(`${entryLabel}.field is invalid`);
    if (!validNullableString(entry.model_asserted) && !validNullableNumber(entry.model_asserted)) {
      errors.push(`${entryLabel}.model_asserted is invalid`);
    }
    if (!validNullableString(entry.orchestrator_value) && !validNullableNumber(entry.orchestrator_value)) {
      errors.push(`${entryLabel}.orchestrator_value is invalid`);
    }
    if (entry.orchestrator_kind !== null && !["observed", "stamped"].includes(entry.orchestrator_kind)) {
      errors.push(`${entryLabel}.orchestrator_kind is invalid`);
    }
  });
}

function validateReproducibility(fp, errors, label) {
  const keys = ["model", "model_version", "temperature", "seed", "max_tokens", "system_prompt_hash", "tools_hash", "stage", "workstream", "host", "timestamp", "orchestrator"];
  if (!exactKeys(fp, keys, label, errors)) return;
  if (!validNullableString(fp.model)) errors.push(`${label}.model is invalid`);
  if (!validNullableString(fp.model_version)) errors.push(`${label}.model_version is invalid`);
  if (!validNullableNumber(fp.temperature)) errors.push(`${label}.temperature is invalid`);
  if (!validNullableNumber(fp.seed)) errors.push(`${label}.seed is invalid`);
  if (!validNullableNumber(fp.max_tokens)) errors.push(`${label}.max_tokens is invalid`);
  if (!validHash(fp.system_prompt_hash)) errors.push(`${label}.system_prompt_hash is invalid`);
  if (!validHash(fp.tools_hash)) errors.push(`${label}.tools_hash is invalid`);
  if (!validNullableString(fp.stage)) errors.push(`${label}.stage is invalid`);
  if (!validNullableString(fp.workstream)) errors.push(`${label}.workstream is invalid`);
  if (!validNullableString(fp.host)) errors.push(`${label}.host is invalid`);
  if (!validNullableString(fp.timestamp)) errors.push(`${label}.timestamp is invalid`);
  if (!validNullableString(fp.orchestrator)) errors.push(`${label}.orchestrator is invalid`);
}

function validateChainField(chain, errors, label) {
  if (chain === null) return;
  if (!exactKeys(chain, ["prev_stage", "prev_hash", "algo", "hmac_present"], label, errors)) return;
  if (!validNullableString(chain.prev_stage)) errors.push(`${label}.prev_stage is invalid`);
  if (!validHash(chain.prev_hash)) errors.push(`${label}.prev_hash is invalid`);
  if (!validNullableString(chain.algo)) errors.push(`${label}.algo is invalid`);
  if (typeof chain.hmac_present !== "boolean") errors.push(`${label}.hmac_present must be boolean`);
}

function validateAuthorityResolution(entry, errors, label) {
  if (entry === null) return;
  if (!exactKeys(entry, ["authority", "grant_class", "ruling", "ts"], label, errors)) return;
  for (const key of ["authority", "grant_class", "ruling", "ts"]) {
    if (!validNullableString(entry[key])) errors.push(`${label}.${key} is invalid`);
  }
}

function validateStages(stages, errors) {
  if (!Array.isArray(stages)) { errors.push("predicate.stages must be an array"); return; }
  stages.forEach((entry, index) => {
    const label = `predicate.stages[${index}]`;
    if (!exactKeys(entry, ["stage", "status", "provenance", "reproducibility", "prompt_pack_version", "chain", "authority_resolution"], label, errors)) return;
    if (!/^stage-[0-9]{2}([-.][a-z0-9-]+)?$/.test(entry.stage)) errors.push(`${label}.stage is invalid`);
    if (!["PASS", "WARN", "FAIL", "ESCALATE"].includes(entry.status)) errors.push(`${label}.status is invalid`);
    validateProvenance(entry.provenance, errors, `${label}.provenance`);
    validateReproducibility(entry.reproducibility, errors, `${label}.reproducibility`);
    if (!validNullableString(entry.prompt_pack_version) || (entry.prompt_pack_version !== null && !/^[0-9a-f]{12}$/.test(entry.prompt_pack_version))) {
      errors.push(`${label}.prompt_pack_version is invalid`);
    }
    validateChainField(entry.chain, errors, `${label}.chain`);
    validateAuthorityResolution(entry.authority_resolution, errors, `${label}.authority_resolution`);
  });
}

function validateResolutions(resolutions, errors) {
  if (!Array.isArray(resolutions)) { errors.push("predicate.resolutions must be an array"); return; }
  resolutions.forEach((entry, index) => {
    const label = `predicate.resolutions[${index}]`;
    if (!exactKeys(entry, ["stage", "failure_class", "schema_fingerprint", "derivable", "source_event_sha256", "accepted_at"], label, errors)) return;
    if (!validNullableString(entry.stage)) errors.push(`${label}.stage is invalid`);
    if (!validNullableString(entry.failure_class)) errors.push(`${label}.failure_class is invalid`);
    if (!HASH_PATTERN.test(entry.schema_fingerprint)) errors.push(`${label}.schema_fingerprint is invalid`);
    if (typeof entry.derivable !== "boolean") errors.push(`${label}.derivable must be boolean`);
    if (!HASH_PATTERN.test(entry.source_event_sha256)) errors.push(`${label}.source_event_sha256 is invalid`);
    if (!validNullableString(entry.accepted_at)) errors.push(`${label}.accepted_at is invalid`);
  });
}

function validateChainVerification(cv, errors) {
  const label = "predicate.chain_verification";
  if (!exactKeys(cv, ["ok", "checked", "breaks", "unstamped", "unsigned", "invalid_macs", "unverified_signatures", "require_signed"], label, errors)) return;
  if (typeof cv.ok !== "boolean") errors.push(`${label}.ok must be boolean`);
  if (!Number.isInteger(cv.checked) || cv.checked < 0) errors.push(`${label}.checked is invalid`);
  if (!Array.isArray(cv.breaks)) errors.push(`${label}.breaks must be an array`);
  if (!Array.isArray(cv.unstamped)) errors.push(`${label}.unstamped must be an array`);
  if (!Array.isArray(cv.unsigned)) errors.push(`${label}.unsigned must be an array`);
  if (!Array.isArray(cv.invalid_macs)) errors.push(`${label}.invalid_macs must be an array`);
  if (!Array.isArray(cv.unverified_signatures)) errors.push(`${label}.unverified_signatures must be an array`);
  if (typeof cv.require_signed !== "boolean") errors.push(`${label}.require_signed must be boolean`);
}

function validatePredicate(predicate, errors) {
  const label = "predicate";
  const keys = ["schema_version", "stagecraft_version", "generated_at", "project_ref", "track", "chain_verification", "unverified", "stages", "resolutions"];
  if (!exactKeys(predicate, keys, label, errors)) return;
  if (predicate.schema_version !== PREDICATE_SCHEMA_VERSION) errors.push(`${label}.schema_version is unsupported`);
  if (!/^\d+\.\d+\.\d+(?:[-+][A-Za-z0-9.-]+)?$/.test(predicate.stagecraft_version)) errors.push(`${label}.stagecraft_version is invalid`);
  if (typeof predicate.generated_at !== "string" || Number.isNaN(Date.parse(predicate.generated_at))) {
    errors.push(`${label}.generated_at is invalid`);
  }
  if (!HASH_PATTERN.test(predicate.project_ref)) errors.push(`${label}.project_ref is invalid`);
  if (typeof predicate.track !== "string" || predicate.track.length === 0) errors.push(`${label}.track is invalid`);
  validateChainVerification(predicate.chain_verification, errors);
  if (typeof predicate.unverified !== "boolean") errors.push(`${label}.unverified must be boolean`);
  validateStages(predicate.stages, errors);
  validateResolutions(predicate.resolutions, errors);
}

function validateAttestation(statement, opts = {}) {
  const errors = [];
  if (!exactKeys(statement, ["_type", "subject", "predicateType", "predicate", "payload_sha256"], "attestation", errors)) {
    return errors;
  }
  if (statement._type !== STATEMENT_TYPE) errors.push(`_type must be ${STATEMENT_TYPE}`);
  validateSubject(statement.subject, errors);
  if (statement.predicateType !== PREDICATE_TYPE) errors.push(`predicateType must be ${PREDICATE_TYPE}`);
  if (statement.predicate && typeof statement.predicate === "object") validatePredicate(statement.predicate, errors);
  else errors.push("predicate must be an object");
  if (!HASH_PATTERN.test(statement.payload_sha256)) errors.push("payload_sha256 is invalid");
  if (opts.verifyDigest && HASH_PATTERN.test(statement.payload_sha256)) {
    const { payload_sha256: _ignored, ...payload } = statement;
    if (payloadDigest(payload) !== statement.payload_sha256) errors.push("payload digest mismatch");
  }
  return errors;
}

function readAttestation(file) {
  let stat;
  try { stat = fs.lstatSync(file); } catch (error) {
    throw new Error(`cannot read attestation bundle: ${error.message}`);
  }
  if (stat.isSymbolicLink() || !stat.isFile()) {
    throw new Error("attestation bundle must be a regular, non-symlink file");
  }
  if (stat.size > MAX_ATTESTATION_BYTES) throw new Error(`attestation bundle exceeds ${MAX_ATTESTATION_BYTES} bytes`);
  let statement;
  try { statement = JSON.parse(fs.readFileSync(file, "utf8")); } catch (error) {
    throw new Error(`attestation bundle is malformed: ${error.message}`);
  }
  const errors = validateAttestation(statement, { verifyDigest: true });
  if (errors.length > 0) throw new Error(`invalid attestation bundle: ${errors.join("; ")}`);
  return statement;
}

function writeAttestation(file, statement) {
  const errors = validateAttestation(statement, { verifyDigest: true });
  if (errors.length > 0) throw new Error(`refusing to write invalid attestation bundle: ${errors.join("; ")}`);
  const resolved = path.resolve(file);
  const parent = path.dirname(resolved);
  let parentStat;
  try { parentStat = fs.lstatSync(parent); } catch (error) {
    throw new Error(`export destination parent is unavailable: ${error.message}`);
  }
  if (parentStat.isSymbolicLink() || !parentStat.isDirectory()) {
    throw new Error("export destination parent must be a regular, non-symlink directory");
  }
  let fd;
  try {
    fd = fs.openSync(resolved, "wx", 0o600);
    fs.writeFileSync(fd, `${JSON.stringify(statement, null, 2)}\n`, "utf8");
    fs.fsyncSync(fd);
    fs.closeSync(fd);
    fd = undefined;
    try { fs.chmodSync(resolved, 0o600); } catch { /* Windows permissions are advisory */ }
  } catch (error) {
    if (fd !== undefined) {
      try { fs.closeSync(fd); } catch { /* already closed */ }
      try { fs.unlinkSync(resolved); } catch { /* no partial file */ }
    }
    if (error.code === "EEXIST") throw new Error("export destination already exists; choose a new file");
    throw error;
  }
  return resolved;
}

// --- --sign: shell to cosign sign-blob (never bundled) ----------------------

function commandOnPath(bin) {
  const probe = spawnSync(process.platform === "win32" ? "where" : "which", [bin], { encoding: "utf8" });
  return probe.status === 0;
}

// Produces a detached signature file `<file>.sig` via `cosign sign-blob`.
// cosign itself decides how it signs (keyless OIDC, --key, KMS, ...) from its
// own environment — Stagecraft never manages signing keys (see plan's "out of
// scope"). `--yes` skips cosign's interactive confirmation for unattended use.
function signAttestation(file) {
  if (!commandOnPath("cosign")) {
    throw new Error(
      "--sign requires the cosign CLI on PATH (never bundled by Stagecraft — "
      + "install cosign yourself; signing-key management is the operator's responsibility)",
    );
  }
  const sigPath = `${file}.sig`;
  const result = spawnSync("cosign", ["sign-blob", "--yes", "--output-signature", sigPath, file], { encoding: "utf8" });
  if (result.error) throw new Error(`cosign sign-blob failed to run: ${result.error.message}`);
  if (result.status !== 0) {
    throw new Error(`cosign sign-blob failed: ${(result.stderr || "unknown error").trim()}`);
  }
  return sigPath;
}

module.exports = {
  PREDICATE_SCHEMA_VERSION,
  PREDICATE_TYPE,
  STATEMENT_TYPE,
  MAX_ATTESTATION_BYTES,
  canonicalize,
  payloadDigest,
  createAttestation,
  validateAttestation,
  readAttestation,
  writeAttestation,
  signAttestation,
  assertExportDestination,
};
