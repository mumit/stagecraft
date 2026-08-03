// Eval flywheel — capture (phase-33 item 33.1, plans/phase-33-eval-flywheel.md §33.1).
//
// On a gate FAIL/ESCALATE, or on any orchestrator stamp status_overridden
// (the model-lied class — always captured when evals.capture is on, since
// it's already a FAIL), write a replayable case under .devteam/evals/cases/:
//   case.json         — stage/role/host/track, prompt_hash + C4 reproducibility
//                        fields (core/reproducibility.js), the sanitized gate
//                        snapshot, run/framework versions.
//   inputs/manifest.json — the stage's readFirst artifact set, content-addressed
//                        (sha256) into .devteam/evals/blobs/, deduped across
//                        cases. A file that scans positive for a secret
//                        (core/hooks/secret-scan.js, the same path the redteam
//                        mechanical floor uses) is excluded, never written to a
//                        blob — case.json still records that it was excluded
//                        and why.
//   resolution.json    — appended later by linkResolutions() once the run-log
//                        shows a fix-retry cleared the stage.
//
// Fire-and-forget (rule 10 / same contract as core/corpus.js and
// core/patterns.js): captureEvalCase and linkResolutions never throw. A
// capture failure logs one warning and never fails the run.
//
// Local-only by design (mirrors core/corpus.js's `.devteam/corpus/`): no
// changeId plumbing — bounded-isolation runs still capture into the single
// project-global `.devteam/evals/` tree, same precedent as the run corpus.

"use strict";

const fs = require("node:fs");
const path = require("node:path");
const crypto = require("node:crypto");
const { scanContent } = require("../hooks/secret-scan");
const { sanitizeBlockers } = require("../corpus");
const { reproducibilityFingerprint } = require("../reproducibility");

const FRAMEWORK_VERSION = (() => {
  try { return require("../../package.json").version; } catch { return "0.0.0"; }
})();

const EVALS_RELATIVE_DIR = path.join(".devteam", "evals");
const MAX_INPUT_BYTES = 2_000_000;

function evalsDir(cwd) { return path.join(cwd, EVALS_RELATIVE_DIR); }
function casesDir(cwd) { return path.join(evalsDir(cwd), "cases"); }
function blobsDir(cwd) { return path.join(evalsDir(cwd), "blobs"); }

function sha256Hex(buf) {
  return crypto.createHash("sha256").update(buf).digest("hex");
}

function captureEnabled(config) {
  return !(config && config.evals && config.evals.capture === false);
}

function isFailingStatus(status) {
  return status === "FAIL" || status === "ESCALATE";
}

function loadGateSafeLocal(gatePath) {
  if (!gatePath) return null;
  try {
    const raw = fs.readFileSync(gatePath, "utf8");
    const parsed = JSON.parse(raw);
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

function escapeRegExp(s) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

// Resolve a stage's readFirst list (host-neutral paths, possibly containing a
// single "*" glob segment like "pipeline/pr-*.md") against files that
// actually exist on disk. Returns [{ rel, abs }], silently omitting entries
// that don't exist — a stage's readFirst commonly outruns what any one
// dispatch actually produced (e.g. security-review.md before stage-04b runs).
function resolveReadFirstFiles(cwd, readFirst) {
  const out = [];
  const seen = new Set();
  for (const entry of Array.isArray(readFirst) ? readFirst : []) {
    if (typeof entry !== "string" || !entry) continue;
    if (entry.includes("*")) {
      const dir = path.dirname(entry);
      const base = path.basename(entry);
      const re = new RegExp(`^${base.split("*").map(escapeRegExp).join(".*")}$`);
      const absDir = path.join(cwd, dir);
      let names;
      try { names = fs.readdirSync(absDir); } catch { continue; }
      for (const name of names.sort()) {
        if (!re.test(name)) continue;
        const rel = path.join(dir, name);
        if (seen.has(rel)) continue;
        let stat;
        try { stat = fs.lstatSync(path.join(absDir, name)); } catch { continue; }
        if (!stat.isFile() || stat.isSymbolicLink()) continue;
        seen.add(rel);
        out.push({ rel, abs: path.join(absDir, name) });
      }
    } else {
      if (seen.has(entry)) continue;
      const abs = path.join(cwd, entry);
      let stat;
      try { stat = fs.lstatSync(abs); } catch { continue; }
      if (!stat.isFile() || stat.isSymbolicLink()) continue;
      seen.add(entry);
      out.push({ rel: entry, abs });
    }
  }
  return out;
}

// Write content to .devteam/evals/blobs/<sha256>.blob, deduped — a blob
// already on disk (same content, any case) is never rewritten.
function writeBlobDeduped(cwd, content) {
  const buf = Buffer.from(content, "utf8");
  const hash = sha256Hex(buf);
  const dir = blobsDir(cwd);
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, `${hash}.blob`);
  if (!fs.existsSync(file)) fs.writeFileSync(file, buf);
  return { hash, bytes: buf.length };
}

// Snapshot each resolved readFirst file: secret-scan it first (same
// core/hooks/secret-scan.js path the redteam mechanical floor uses), and
// exclude — never write to a blob — anything that scans positive. The
// manifest always records every readFirst file considered, whether
// captured or excluded, so a case is auditable even when redacted.
function snapshotInputs(cwd, files) {
  const manifest = [];
  for (const f of files) {
    let content;
    try {
      const stat = fs.lstatSync(f.abs);
      if (!stat.isFile() || stat.isSymbolicLink() || stat.size > MAX_INPUT_BYTES) {
        manifest.push({ path: f.rel, excluded: "too-large-or-not-a-regular-file" });
        continue;
      }
      content = fs.readFileSync(f.abs, "utf8");
    } catch {
      manifest.push({ path: f.rel, excluded: "unreadable" });
      continue;
    }
    const findings = scanContent(content);
    if (findings.length > 0) {
      manifest.push({
        path: f.rel,
        excluded: "secret-detected",
        finding_names: [...new Set(findings.map((x) => x.name))],
      });
      continue;
    }
    const { hash, bytes } = writeBlobDeduped(cwd, content);
    manifest.push({ path: f.rel, sha256: hash, bytes });
  }
  return manifest;
}

// Reduce a gate to a capture-safe snapshot: the free-text fields a model can
// fill with anything (blockers, warnings) get run through the same
// secret-scan sanitizer core/corpus.js uses for the run corpus, rather than
// re-implementing detection.
function sanitizeGateForCapture(gate) {
  const clone = JSON.parse(JSON.stringify(gate));
  if (Array.isArray(clone.blockers)) clone.blockers = sanitizeBlockers(clone.blockers) || [];
  if (Array.isArray(clone.warnings)) clone.warnings = sanitizeBlockers(clone.warnings) || [];
  return clone;
}

function captureReasonFor(gate) {
  const overridden = gate._orchestrator_stamped && gate._orchestrator_stamped.status_overridden;
  if (overridden) return "stamp-override";
  return gate.status === "ESCALATE" ? "gate-escalate" : "gate-fail";
}

/**
 * Capture one replayable eval case for a stage's gate, if it's currently
 * FAIL/ESCALATE (or carries a stamp status_overridden — always captured,
 * since that's already a FAIL). Fire-and-forget: never throws; a failure
 * logs one warning and returns { ok: false }.
 *
 * opts: { config, gate, gatePath, stage, role, host, track, runId,
 *         promptHash, readFirst }
 * Either `gate` or `gatePath` must be supplied; `gate` wins if both are given
 * (the caller already has the post-stamp object in hand).
 */
function captureEvalCase(cwd, opts = {}) {
  try {
    const config = opts.config || require("../config").loadConfig(cwd);
    if (!captureEnabled(config)) return { ok: false, reason: "disabled" };

    const gate = opts.gate || loadGateSafeLocal(opts.gatePath);
    if (!gate) return { ok: false, reason: "no-gate" };
    const overridden = Boolean(gate._orchestrator_stamped && gate._orchestrator_stamped.status_overridden);
    if (!isFailingStatus(gate.status) && !overridden) return { ok: false, reason: "not-failing" };

    const stage = opts.stage || gate.stage || null;
    const now = new Date();
    const tsSlug = now.toISOString().replace(/[:.]/g, "-");
    const shortHash = sha256Hex(Buffer.from(JSON.stringify({
      stage, role: opts.role || null, ts: now.toISOString(), gate,
    }))).slice(0, 12);
    const dirName = `${tsSlug}-${stage || "unknown-stage"}-${shortHash}`;
    const caseDir = path.join(casesDir(cwd), dirName);
    fs.mkdirSync(path.join(caseDir, "inputs"), { recursive: true });

    const readFirstFiles = resolveReadFirstFiles(cwd, opts.readFirst);
    const inputsManifest = snapshotInputs(cwd, readFirstFiles);
    fs.writeFileSync(
      path.join(caseDir, "inputs", "manifest.json"),
      JSON.stringify(inputsManifest, null, 2) + "\n",
      "utf8",
    );

    const caseJson = {
      captured_at: now.toISOString(),
      stage,
      role: opts.role || null,
      host: opts.host || null,
      track: Array.isArray(opts.track) ? opts.track.join(",") : (opts.track || null),
      run_id: opts.runId || null,
      capture_reason: captureReasonFor(gate),
      prompt_hash: opts.promptHash || null,
      reproducibility: reproducibilityFingerprint(gate),
      // Phase-33 item 33.3: content-hash version of the prompt surface at
      // capture time (core/prompt-pack.js), read off the gate the same way
      // the run corpus does (core/corpus.js recordDispatch) — lets
      // `devteam evals run` report drift between the pack version a case
      // was captured under and the pack replaying it today.
      prompt_pack_version: (typeof gate.prompt_pack_version === "string") ? gate.prompt_pack_version : null,
      framework_version: FRAMEWORK_VERSION,
      stamper_version: (gate._orchestrator_stamped && gate._orchestrator_stamped.stamper_version) || null,
      gate: sanitizeGateForCapture(gate),
    };
    fs.writeFileSync(path.join(caseDir, "case.json"), JSON.stringify(caseJson, null, 2) + "\n", "utf8");

    return { ok: true, dir: caseDir };
  } catch (err) {
    process.stderr.write(`[devteam] evals: could not capture eval case: ${err && err.message}\n`);
    return { ok: false, error: err && err.message };
  }
}

// ---------------------------------------------------------------------------
// Resolution linking — run-end pass (fire-and-forget).
// ---------------------------------------------------------------------------

function readJsonLinesTolerant(filePath) {
  let raw;
  try { raw = fs.readFileSync(filePath, "utf8"); } catch { return []; }
  const records = [];
  for (const line of raw.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    try { records.push(JSON.parse(trimmed)); } catch { /* skip malformed line */ }
  }
  return records;
}

function listUnresolvedCases(cwd) {
  const dir = casesDir(cwd);
  let names;
  try { names = fs.readdirSync(dir); } catch { return []; }
  const cases = [];
  for (const name of names) {
    const caseDir = path.join(dir, name);
    const caseJsonPath = path.join(caseDir, "case.json");
    const resolutionPath = path.join(caseDir, "resolution.json");
    if (fs.existsSync(resolutionPath)) continue;
    let caseJson;
    try { caseJson = JSON.parse(fs.readFileSync(caseJsonPath, "utf8")); } catch { continue; }
    if (!caseJson.stage) continue;
    cases.push({ dir: caseDir, caseJson });
  }
  return cases;
}

/**
 * Resolution-linker pass, run at the end of a `devteam run` (fire-and-forget,
 * mirrors pattern-collect/reflector/memory-ingest in core/driver.js). For
 * every captured eval case with no resolution.json yet, looks for a
 * "fix-retry" run-log event for the same stage logged after the case was
 * captured; if the stage's *current* gate on disk is no longer FAIL/ESCALATE,
 * the most recent such fix-retry is recorded as what cleared it.
 *
 * Never throws. Returns { linked: <count> }.
 */
function linkResolutions(cwd, { changeId = null, runLogPath, gatesDir } = {}) {
  try {
    const { pipelineRoot, gatesDir: getGatesDir } = require("../paths");
    const logPath = runLogPath || path.join(pipelineRoot(cwd, changeId), "run-log.jsonl");
    const gatesRoot = gatesDir || getGatesDir(cwd, changeId);
    const cases = listUnresolvedCases(cwd);
    if (cases.length === 0) return { linked: 0 };

    const events = readJsonLinesTolerant(logPath).filter((e) => e && e.outcome === "fix-retry" && e.stage);

    let linked = 0;
    for (const { dir, caseJson } of cases) {
      const capturedAt = caseJson.captured_at;
      const candidates = events.filter((e) => e.stage === caseJson.stage
        && (!capturedAt || !e.ts || e.ts >= capturedAt));
      if (candidates.length === 0) continue;
      const latest = candidates[candidates.length - 1];

      const currentGate = loadGateSafeLocal(path.join(gatesRoot, `${caseJson.stage}.json`));
      if (!currentGate || isFailingStatus(currentGate.status)) continue;

      const resolution = {
        resolved_at: new Date().toISOString(),
        stage: caseJson.stage,
        cleared_by_retry: {
          ts: latest.ts || null,
          attempt: typeof latest.attempt === "number" ? latest.attempt : null,
          cleared_gates: typeof latest.cleared_gates === "number" ? latest.cleared_gates : null,
          derivable: latest.derivable === true,
        },
      };
      fs.writeFileSync(path.join(dir, "resolution.json"), JSON.stringify(resolution, null, 2) + "\n", "utf8");
      linked += 1;
    }
    return { linked };
  } catch (err) {
    process.stderr.write(`[devteam] evals: resolution-linker failed: ${err && err.message}\n`);
    return { linked: 0, error: err && err.message };
  }
}

// ---------------------------------------------------------------------------
// Blob GC — `devteam evals gc`.
// ---------------------------------------------------------------------------

// Remove blobs under .devteam/evals/blobs/ that no case's inputs/manifest.json
// references. Never throws; a missing evals tree is simply "nothing to do."
function gc(cwd) {
  const referenced = new Set();
  const dir = casesDir(cwd);
  let caseNames = [];
  try { caseNames = fs.readdirSync(dir); } catch { caseNames = []; }
  for (const name of caseNames) {
    const manifestPath = path.join(dir, name, "inputs", "manifest.json");
    let manifest;
    try { manifest = JSON.parse(fs.readFileSync(manifestPath, "utf8")); } catch { continue; }
    if (!Array.isArray(manifest)) continue;
    for (const entry of manifest) {
      if (entry && typeof entry.sha256 === "string") referenced.add(entry.sha256);
    }
  }

  const bDir = blobsDir(cwd);
  let blobNames = [];
  try { blobNames = fs.readdirSync(bDir); } catch { blobNames = []; }
  let removed = 0;
  for (const name of blobNames) {
    const hash = name.endsWith(".blob") ? name.slice(0, -".blob".length) : name;
    if (referenced.has(hash)) continue;
    try { fs.unlinkSync(path.join(bDir, name)); removed += 1; } catch { /* best-effort */ }
  }
  return { removed, kept: blobNames.length - removed, referenced: referenced.size };
}

module.exports = {
  EVALS_RELATIVE_DIR,
  evalsDir,
  casesDir,
  blobsDir,
  captureEvalCase,
  linkResolutions,
  gc,
  // exposed for tests
  resolveReadFirstFiles,
  snapshotInputs,
  writeBlobDeduped,
};
