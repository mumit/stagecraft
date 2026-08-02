#!/usr/bin/env node
/**
 * approval-derivation.js
 *
 * PostToolUse hook (Claude Code Write|Edit). When the written file is
 * inside pipeline/code-review/, parses it for per-area section headers
 * and REVIEW: markers, then upserts the corresponding stage-05.<area>.json
 * workstream gates.
 *
 * Review file format:
 *
 *   ## Review of backend
 *   <comments>
 *   REVIEW: APPROVED
 *
 *   ## Review of platform
 *   <comments>
 *   REVIEW: CHANGES REQUESTED
 *   BLOCKER: <text>
 *
 * Contract F applied vs the prior fork:
 *   - drops the legacy "agent" field
 *   - gates carry orchestrator (auto-filled), host="claude-code"
 *     (this hook is currently only wired for claude-code), and
 *     workstream=<area>
 *
 * Concurrency: per-gate file lock (.stage-05-<area>.lock) plus atomic
 * rename writes — safe for concurrent reviewer writes.
 *
 * Conservative on errors: any parse/IO failure exits 0 with a WARN log;
 * never halts the host session on a hook bug.
 */

const fs = require("node:fs");
const path = require("node:path");
const { loadConfig } = require("../config");
const { requiredApprovalsFor, STAGES } = require("../pipeline/stages");

const ORCHESTRATOR_ID = `devteam@${require("../../package.json").version}`;
const HOST = "claude-code"; // this hook is wired only into the claude-code adapter

const CWD = (() => {
  try { return fs.realpathSync(process.cwd()); } catch { return process.cwd(); }
})();
// B9 (item 5.4): allow bounded-mode `devteam derive-approvals` to pass the
// per-change paths via env vars; in-place mode uses the historical defaults.
const REVIEW_DIR = process.env.DEVTEAM_REVIEW_DIR || path.join(CWD, "pipeline", "code-review");
const GATES_DIR = process.env.DEVTEAM_GATES_DIR || path.join(CWD, "pipeline", "gates");

const LOCK_RETRIES = 20;
const LOCK_DELAY_MS = 30;
const LOCK_STALE_MS = 5000;
const MAX_FILE_BYTES = 1_000_000;

const LOG_JSON = process.env.LOG_FORMAT === "json";
function logEvent(event, data) {
  if (!LOG_JSON) return;
  console.log(JSON.stringify({ ts: new Date().toISOString(), hook: "approval-derivation", event, ...data }));
}

// Map review file suffix → reviewer agent name.
const REVIEWER_MAP = {
  backend:  "dev-backend",
  frontend: "dev-frontend",
  platform: "dev-platform",
  qa:       "dev-qa",
  security: "security-engineer",
  principal: "principal",
  // 31.3: adversarial mode's two workstreams. Their by-*.md files are routed
  // to dedicated apply functions below (applyAdversarialReviewerFile /
  // applyCriticVerdict) rather than the generic per-area verdict loop — these
  // map entries exist for identity/logging consistency with the rest of the
  // table, not because applyVerdict() is called for them.
  reviewer: "reviewer",
  critic:   "critic",
};

const KNOWN_AREAS = new Set(["backend", "frontend", "platform", "qa", "deps"]);

// Host-based filenames trigger fanout-mode gate naming. When the
// reviewer identifier matches a known host, gates are written to
// stage-05.<area>.<host>.json instead of stage-05.<area>.json.
//
// "Known" = an entry here. Adding a new host adapter (under hosts/<name>/)
// REQUIRES adding the host's name to this set, otherwise the fanout-mode
// review files written by that host will fall back to the area-only gate
// path and collide across hosts. Keep this list in sync with the dirs
// under hosts/.
const KNOWN_HOSTS = new Set(["claude-code", "codex", "gemini-cli", "generic", "openai-compat"]);

const SECTION_HEADER_RE = /^##\s+Review\s+of\s+(\w[\w-]*)\s*$/i;
const REVIEW_MARKER_RE = /^\s*REVIEW:\s*(APPROVED|CHANGES\s+REQUESTED)\s*$/i;
const BLOCKER_RE = /^\s*BLOCKER:\s*(.+)$/i;

// ---------------------------------------------------------------------------
// Stdin context — Claude Code PostToolUse provides tool_input.file_path
// ---------------------------------------------------------------------------

function getToolFilePath() {
  try {
    if (process.stdin.isTTY) return null;
    const chunks = [];
    const buf = Buffer.alloc(65536);
    let n;
    while ((n = fs.readSync(0, buf, 0, buf.length)) > 0) {
      chunks.push(Buffer.from(buf.slice(0, n)));
      if (chunks.reduce((s, c) => s + c.length, 0) > 4 * 1024 * 1024) break;
    }
    if (chunks.length === 0) return null;
    const data = JSON.parse(Buffer.concat(chunks).toString("utf8"));
    return data && data.tool_input && typeof data.tool_input.file_path === "string"
      ? data.tool_input.file_path
      : null;
  } catch { return null; }
}

function isReviewFile(filePath) {
  if (!filePath) return false;
  let normalized;
  try {
    normalized = fs.realpathSync(path.isAbsolute(filePath) ? filePath : path.resolve(filePath));
  } catch {
    normalized = path.isAbsolute(filePath) ? filePath : path.resolve(filePath);
  }
  return normalized.startsWith(REVIEW_DIR + path.sep);
}

// ---------------------------------------------------------------------------
// Locking
// ---------------------------------------------------------------------------

function acquireLock(lockPath) {
  if (fs.existsSync(lockPath)) {
    try {
      const age = Date.now() - fs.statSync(lockPath).mtimeMs;
      if (age > LOCK_STALE_MS) fs.unlinkSync(lockPath);
    } catch { /* concurrent unlink */ }
  }
  for (let i = 0; i < LOCK_RETRIES; i++) {
    try {
      fs.writeFileSync(lockPath, String(process.pid), { flag: "wx" });
      return true;
    } catch (err) {
      if (err.code !== "EEXIST") throw err;
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, LOCK_DELAY_MS);
    }
  }
  return false;
}

function releaseLock(lockPath) {
  try { fs.unlinkSync(lockPath); } catch { /* ignore */ }
}

// ---------------------------------------------------------------------------
// Parse review file → verdicts
// ---------------------------------------------------------------------------

function parseReviewFile(filePath) {
  let content;
  try {
    const stat = fs.statSync(filePath);
    if (stat.size > MAX_FILE_BYTES) {
      console.log(`[approval-derivation] ⚠️  ${filePath} exceeds ${MAX_FILE_BYTES} bytes; skipping`);
      return [];
    }
    content = fs.readFileSync(filePath, "utf8");
  } catch { return []; }

  const verdicts = [];
  let currentArea = null;
  let currentBlockers = [];
  for (const line of content.split(/\r?\n/)) {
    const h = line.match(SECTION_HEADER_RE);
    if (h) { currentArea = h[1].toLowerCase(); currentBlockers = []; continue; }
    const b = line.match(BLOCKER_RE);
    if (b && currentArea && KNOWN_AREAS.has(currentArea)) {
      currentBlockers.push(b[1].trim());
      continue;
    }
    const m = line.match(REVIEW_MARKER_RE);
    if (m && currentArea && KNOWN_AREAS.has(currentArea)) {
      const verdict = m[1].toUpperCase().replace(/\s+/g, "_");
      verdicts.push({ area: currentArea, verdict, blockers: currentBlockers });
      currentArea = null;
      currentBlockers = [];
    }
  }
  return verdicts;
}

function reviewerNameFromPath(filePath) {
  const base = path.basename(filePath);
  const m = base.match(/^by-([\w-]+)\.md$/);
  if (!m) return null;
  return REVIEWER_MAP[m[1]] || m[1];
}

// Returns the raw role key (e.g. "backend") without mapping — used for
// self-review detection. For fanout files (by-codex.md) this returns the
// host name, which won't match any KNOWN_AREAS entry, so the check is safe.
function reviewerRoleFromPath(filePath) {
  const base = path.basename(filePath);
  const m = base.match(/^by-([\w-]+)\.md$/);
  return m ? m[1] : null;
}

// Return the host segment when the filename is host-based ("by-codex.md",
// "by-claude-code.md", etc.); null otherwise. Drives fanout gate naming.
function hostFromPath(filePath) {
  const base = path.basename(filePath);
  const m = base.match(/^by-([\w-]+)\.md$/);
  if (!m) return null;
  return KNOWN_HOSTS.has(m[1]) ? m[1] : null;
}

// ---------------------------------------------------------------------------
// 31.3: adversarial mode — by-reviewer.md (single reviewer, all areas) and
// by-critic.md (challenges to the review). Distinct from the panel-mode
// per-area gates above: there is exactly one reviewer and one critic, so
// each file's content fully replaces its gate on every write rather than
// accumulating per-reviewer entries.
// ---------------------------------------------------------------------------

// Reuses parseReviewFile()'s "## Review of <area>" + "REVIEW:" parsing
// verbatim, but rolls every area verdict from the single by-reviewer.md
// file into ONE combined gate (stage-05.reviewer.json) instead of one gate
// per area — adversarial mode has a single reviewer, not a cross-review
// matrix, so there is nothing to fan out across.
function applyAdversarialReviewerFile(filePath, { reviewer, host, gatesDir: customGatesDir } = {}) {
  const effectiveGatesDir = customGatesDir || GATES_DIR;
  if (!fs.existsSync(effectiveGatesDir)) fs.mkdirSync(effectiveGatesDir, { recursive: true });

  const verdicts = parseReviewFile(filePath);
  const areasReviewed = verdicts.map((v) => v.area);
  const approvedAreas = verdicts.filter((v) => v.verdict === "APPROVED").map((v) => v.area);
  const changesRequested = verdicts
    .filter((v) => v.verdict === "CHANGES_REQUESTED")
    .map((v) => ({ area: v.area, blockers: v.blockers, timestamp: new Date().toISOString() }));
  const blockers = changesRequested.flatMap((cr) => cr.blockers.map((text) => ({ area: cr.area, text })));

  const gatePath = path.join(effectiveGatesDir, "stage-05.reviewer.json");
  const lockPath = path.join(effectiveGatesDir, ".stage-05.reviewer.lock");
  if (!acquireLock(lockPath)) {
    console.log(`[approval-derivation] ⚠️  could not acquire lock for stage-05.reviewer after ${LOCK_RETRIES} retries; skipping`);
    return;
  }
  try {
    const status = areasReviewed.length > 0 && changesRequested.length === 0 ? "PASS" : "FAIL";
    const gate = {
      stage: "stage-05",
      workstream: "reviewer",
      mode: "adversarial",
      host: host || HOST,
      orchestrator: ORCHESTRATOR_ID,
      status,
      timestamp: new Date().toISOString(),
      blockers,
      warnings: areasReviewed.length === 0
        ? [`${path.basename(filePath)} contained no '## Review of <area>' sections`]
        : [],
      areas_reviewed: areasReviewed,
      approved_areas: approvedAreas,
      changes_requested: changesRequested,
    };
    const tmpPath = `${gatePath}.tmp.${process.pid}`;
    fs.writeFileSync(tmpPath, JSON.stringify(gate, null, 2) + "\n");
    fs.renameSync(tmpPath, gatePath);
    console.log(`[approval-derivation] ${reviewer || "reviewer"} → ${status} on stage-05.reviewer (areas: ${areasReviewed.join(", ") || "none"})`);
    logEvent("adversarial_reviewer_gate_updated", { areas_reviewed: areasReviewed, approved_areas: approvedAreas, status });
  } finally {
    releaseLock(lockPath);
  }
}

// Challenge section: "## Challenge <id>" followed by FILE:/CLAIM:/DISPOSITION:
// lines, closed by the DISPOSITION: marker (mirrors REVIEW_MARKER_RE closing
// a "## Review of <area>" section above).
const CHALLENGE_HEADER_RE = /^##\s+Challenge\s+([\w-]+)\s*$/i;
const CHALLENGE_FILE_RE = /^\s*FILE:\s*(.+?):(\d+)\s*$/i;
const CHALLENGE_CLAIM_RE = /^\s*CLAIM:\s*(.+)$/i;
const CHALLENGE_DISPOSITION_RE = /^\s*DISPOSITION:\s*(RESOLVED|UNRESOLVED)\s*$/i;

// Plan §31.3: "require file:line evidence for every challenge." A challenge
// with no parseable FILE:<path>:<line> line is still recorded (conservative —
// never silently drop a challenge) but its disposition is mechanically
// forced to "unresolved" regardless of what the critic wrote, so a missing
// reproducer can never be waved through as resolved.
function parseCriticFile(filePath) {
  let content;
  try {
    const stat = fs.statSync(filePath);
    if (stat.size > MAX_FILE_BYTES) {
      console.log(`[approval-derivation] ⚠️  ${filePath} exceeds ${MAX_FILE_BYTES} bytes; skipping`);
      return [];
    }
    content = fs.readFileSync(filePath, "utf8");
  } catch { return []; }

  const challenges = [];
  let current = null;
  const flush = () => {
    if (!current) return;
    const evidenceMissing = !current.file;
    challenges.push({
      id: current.id,
      file: current.file || null,
      line: current.line || null,
      claim: current.claim || "",
      disposition: evidenceMissing ? "unresolved" : current.disposition,
      evidence_missing: evidenceMissing || undefined,
    });
    current = null;
  };
  for (const line of content.split(/\r?\n/)) {
    const h = line.match(CHALLENGE_HEADER_RE);
    if (h) { flush(); current = { id: h[1], file: null, line: null, claim: "", disposition: "unresolved" }; continue; }
    if (!current) continue;
    const f = line.match(CHALLENGE_FILE_RE);
    if (f) { current.file = f[1].trim(); current.line = Number(f[2]); continue; }
    const c = line.match(CHALLENGE_CLAIM_RE);
    if (c) { current.claim = c[1].trim(); continue; }
    const d = line.match(CHALLENGE_DISPOSITION_RE);
    if (d) { current.disposition = d[1].toLowerCase(); flush(); continue; }
  }
  flush(); // tolerate a final section with no closing DISPOSITION: line
  return challenges;
}

// Single critic, full-replace semantics on every write (like red-team's
// stage-04c gate) — there is exactly one critic file, so accumulation across
// writes (the panel-mode reviewer pattern) doesn't apply.
function applyCriticVerdict(filePath, { reviewer, host, gatesDir: customGatesDir } = {}) {
  const effectiveGatesDir = customGatesDir || GATES_DIR;
  if (!fs.existsSync(effectiveGatesDir)) fs.mkdirSync(effectiveGatesDir, { recursive: true });

  const challenges = parseCriticFile(filePath);
  const gatePath = path.join(effectiveGatesDir, "stage-05.critic.json");
  const lockPath = path.join(effectiveGatesDir, ".stage-05.critic.lock");
  if (!acquireLock(lockPath)) {
    console.log(`[approval-derivation] ⚠️  could not acquire lock for stage-05.critic after ${LOCK_RETRIES} retries; skipping`);
    return;
  }
  try {
    const challengesResolved = challenges.every((c) => c.disposition === "resolved");
    const unresolved = challenges.filter((c) => c.disposition !== "resolved");
    const gate = {
      stage: "stage-05",
      workstream: "critic",
      mode: "adversarial",
      host: host || HOST,
      orchestrator: ORCHESTRATOR_ID,
      status: challengesResolved ? "PASS" : "FAIL",
      timestamp: new Date().toISOString(),
      blockers: unresolved.map((c) => ({ id: c.id, text: c.claim || `unresolved challenge ${c.id}` })),
      warnings: challenges.some((c) => c.evidence_missing)
        ? [`${challenges.filter((c) => c.evidence_missing).length} challenge(s) missing FILE:<path>:<line> evidence — forced to unresolved`]
        : [],
      challenges,
      challenges_resolved: challengesResolved,
    };
    const tmpPath = `${gatePath}.tmp.${process.pid}`;
    fs.writeFileSync(tmpPath, JSON.stringify(gate, null, 2) + "\n");
    fs.renameSync(tmpPath, gatePath);
    console.log(`[approval-derivation] ${reviewer || "critic"} → ${gate.status} on stage-05.critic (challenges: ${challenges.length}, resolved: ${challengesResolved})`);
    logEvent("critic_gate_updated", { challenges_count: challenges.length, challenges_resolved: challengesResolved, status: gate.status });
  } finally {
    releaseLock(lockPath);
  }
}

// ---------------------------------------------------------------------------
// Gate upsert (locked, atomic write)
// ---------------------------------------------------------------------------

function applyVerdict({ area, verdict, blockers, reviewer, host, gatesDir: customGatesDir, projectCwd: customProjectCwd }) {
  const effectiveGatesDir = customGatesDir || GATES_DIR;
  const effectiveCwd = customProjectCwd || CWD;
  if (!fs.existsSync(effectiveGatesDir)) fs.mkdirSync(effectiveGatesDir, { recursive: true });

  // Fanout mode: host-suffixed gate name (stage-05.<area>.<host>.json).
  // Non-fanout: canonical per-area gate (stage-05.<area>.json).
  const baseName = host ? `stage-05.${area}.${host}` : `stage-05.${area}`;
  const gatePath = path.join(effectiveGatesDir, `${baseName}.json`);
  const lockPath = path.join(effectiveGatesDir, `.${baseName}.lock`);

  if (!acquireLock(lockPath)) {
    console.log(`[approval-derivation] ⚠️  could not acquire lock for ${baseName} after ${LOCK_RETRIES} retries; skipping`);
    return;
  }

  try {
    let gate;
    if (fs.existsSync(gatePath)) {
      try {
        const stat = fs.statSync(gatePath);
        if (stat.size > MAX_FILE_BYTES) {
          console.log(`[approval-derivation] ⚠️  ${gatePath} exceeds ${MAX_FILE_BYTES} bytes; refusing to clobber`);
          return;
        }
        gate = JSON.parse(fs.readFileSync(gatePath, "utf8"));
      } catch {
        console.log(`[approval-derivation] ⚠️  ${gatePath} is malformed; skipping update`);
        return;
      }
    } else {
      // Read the project's track so required_approvals matches the
      // PEER_REVIEW_SIZING table. Nano-track changes need 1 approval
      // (single-reviewer scoped review); full/quick/hotfix/etc need 2.
      let track = "full";
      try { track = loadConfig(effectiveCwd).pipeline.default_track || "full"; } catch { /* defaults */ }
      const required = requiredApprovalsFor(STAGES["peer-review"], track) ?? 2;
      gate = {
        stage: "stage-05",
        workstream: area,
        // For fanout gates the host IS the fanout target (the reviewer
        // is acting AS that host's reviewer). Otherwise it's the host
        // that ran the actual review session (claude-code by default
        // since this hook is wired only into claude-code today).
        host: host || HOST,
        orchestrator: ORCHESTRATOR_ID,
        track,
        status: "FAIL",
        timestamp: new Date().toISOString(),
        blockers: [],
        warnings: [],
        area,
        approvals: [],
        changes_requested: [],
        escalated_to_principal: false,
        required_approvals: required,
        review_shape: required === 1 ? "single" : "matrix",
      };
    }

    gate.approvals = Array.isArray(gate.approvals) ? gate.approvals : [];
    gate.changes_requested = Array.isArray(gate.changes_requested) ? gate.changes_requested : [];
    gate.blockers = Array.isArray(gate.blockers) ? gate.blockers : [];

    // Remove any prior blocker entries from this reviewer before rewriting.
    gate.blockers = gate.blockers.filter((b) => b.reviewer !== reviewer);

    if (verdict === "APPROVED") {
      if (!gate.approvals.includes(reviewer)) gate.approvals.push(reviewer);
      gate.changes_requested = gate.changes_requested.filter((e) => e.reviewer !== reviewer);
    } else if (verdict === "CHANGES_REQUESTED") {
      gate.approvals = gate.approvals.filter((n) => n !== reviewer);
      if (!gate.changes_requested.some((e) => e.reviewer === reviewer)) {
        gate.changes_requested.push({ reviewer, timestamp: new Date().toISOString() });
      }
      if (Array.isArray(blockers) && blockers.length > 0) {
        for (const text of blockers) {
          gate.blockers.push({ reviewer, text });
        }
      }
    }

    const required = typeof gate.required_approvals === "number" ? gate.required_approvals : 2;
    const hasEnough = gate.approvals.length >= required;
    const hasBlockers = gate.changes_requested.length > 0;
    gate.status = hasEnough && !hasBlockers ? "PASS" : "FAIL";
    gate.timestamp = new Date().toISOString();

    // Diagnostic fields — cleared on every update so stale values don't persist.
    delete gate.failure_reason;
    delete gate.action_required;
    if (gate.status === "FAIL") {
      if (hasBlockers) {
        gate.failure_reason = "CHANGES_REQUESTED";
      } else {
        gate.failure_reason = "INSUFFICIENT_APPROVALS";
        const needed = required - gate.approvals.length;
        const eligible = Object.values(REVIEWER_MAP).filter(r => !gate.approvals.includes(r));
        gate.action_required =
          `Need ${needed} more approval(s). ` +
          `Run 'devteam derive-approvals' to pick up any existing review-file verdicts. ` +
          `If still failing, have an eligible reviewer add ` +
          `'## Review of ${area}' + 'REVIEW: APPROVED' to their ` +
          `pipeline/code-review/by-<role>.md. ` +
          `Eligible reviewers: [${eligible.join(", ")}].`;
      }
    }
    // Backfill identity for legacy gates that predate the field, but do NOT
    // overwrite. For fanout gates, gate.host was set at creation to the
    // fanout target host (e.g. "codex") — clobbering it to HOST here would
    // misattribute every subsequent review update from this hook to
    // claude-code. The host field is set once when the gate is created and
    // is never mutated afterwards.
    gate.orchestrator = gate.orchestrator || ORCHESTRATOR_ID;
    gate.host = gate.host || host || HOST;

    const tmpPath = `${gatePath}.tmp.${process.pid}`;
    fs.writeFileSync(tmpPath, JSON.stringify(gate, null, 2) + "\n");
    fs.renameSync(tmpPath, gatePath);

    console.log(`[approval-derivation] ${reviewer} → ${verdict} on ${area} (approvals: ${gate.approvals.length}/${required}, status: ${gate.status})`);
    logEvent("gate_updated", {
      area, reviewer, verdict, status: gate.status,
      approvals: gate.approvals.slice(),
      approvals_count: gate.approvals.length,
      required_approvals: required,
      changes_requested_count: gate.changes_requested.length,
    });
  } finally {
    releaseLock(lockPath);
  }
}

// ---------------------------------------------------------------------------
// Programmatic entry point for hooks: false hosts (openai-compat, codex via
// headless.js). Called after the tool-call loop completes; derives gates for
// any by-*.md files written during the session without spawning a subprocess.
// ---------------------------------------------------------------------------

function deriveForProject(filePath, projectCwd) {
  const gatesDir = path.join(projectCwd, "pipeline", "gates");
  let track = "full";
  try { track = loadConfig(projectCwd).pipeline.default_track || "full"; } catch { /* defaults */ }
  const isSingleReviewer = track === "nano";

  const reviewer = reviewerNameFromPath(filePath);
  if (!reviewer) return;
  const host = hostFromPath(filePath);
  const role = reviewerRoleFromPath(filePath);

  // 31.3: adversarial mode's two files bypass the per-area verdict loop —
  // by-reviewer.md rolls up into one combined gate, by-critic.md parses
  // challenges instead of REVIEW: verdicts.
  if (!host && role === "reviewer") { applyAdversarialReviewerFile(filePath, { reviewer, host, gatesDir }); return; }
  if (!host && role === "critic") { applyCriticVerdict(filePath, { reviewer, host, gatesDir }); return; }

  const verdicts = parseReviewFile(filePath);
  for (const v of verdicts) {
    if (!host && role && v.area === role && !isSingleReviewer) {
      console.error(`[approval-derivation] WARN: self-review skipped — ${path.basename(filePath)} contains "## Review of ${v.area}" but that is the reviewer's own workstream`);
      continue;
    }
    applyVerdict({ area: v.area, verdict: v.verdict, blockers: v.blockers, reviewer, host, gatesDir, projectCwd });
  }
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

function main() {
  const writtenPath = getToolFilePath();
  if (writtenPath !== null && !isReviewFile(writtenPath)) process.exit(0);
  if (!fs.existsSync(REVIEW_DIR)) process.exit(0);

  const reviewFiles = fs.readdirSync(REVIEW_DIR).filter((f) => /^by-[\w-]+\.md$/.test(f));
  if (reviewFiles.length === 0) process.exit(0);

  // Nano track uses a single reviewer (backend) who reviews the backend
  // workstream — self-review is structural, not a violation.
  let track = "full";
  try { track = loadConfig(CWD).pipeline.default_track || "full"; } catch { /* defaults */ }
  const isSingleReviewer = track === "nano";

  for (const file of reviewFiles) {
    const fullPath = path.join(REVIEW_DIR, file);
    const reviewer = reviewerNameFromPath(fullPath);
    if (!reviewer) continue;
    const host = hostFromPath(fullPath);  // null unless it's a fanout file
    const role = reviewerRoleFromPath(fullPath); // raw key, e.g. "backend"

    // 31.3: adversarial mode's two files bypass the per-area verdict loop.
    if (!host && role === "reviewer") { applyAdversarialReviewerFile(fullPath, { reviewer, host }); continue; }
    if (!host && role === "critic") { applyCriticVerdict(fullPath, { reviewer, host }); continue; }

    const verdicts = parseReviewFile(fullPath);
    for (const v of verdicts) {
      // Self-review guard: skip sections where the reviewer's own workstream
      // matches the area being reviewed. Only applies to non-fanout files
      // (fanout hosts like "codex" don't own a workstream). Not applied on
      // nano track where the single reviewer IS the workstream owner.
      if (!host && role && v.area === role && !isSingleReviewer) {
        console.error(`[approval-derivation] WARN: self-review skipped — ${file} contains "## Review of ${v.area}" but that is the reviewer's own workstream`);
        continue;
      }
      applyVerdict({ area: v.area, verdict: v.verdict, blockers: v.blockers, reviewer, host });
    }
  }
  process.exit(0);
}

if (require.main === module) {
  try {
    main();
  } catch (err) {
    const msg = err && err.message ? err.message : String(err);
    console.log(`[approval-derivation] ⚠️  internal error: ${msg}; no gates updated`);
    process.exit(0);
  }
}

module.exports = {
  main, parseReviewFile, applyVerdict, deriveForProject, reviewerNameFromPath, hostFromPath, KNOWN_HOSTS,
  // 31.3
  parseCriticFile, applyCriticVerdict, applyAdversarialReviewerFile,
};
