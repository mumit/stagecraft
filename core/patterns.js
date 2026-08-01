"use strict";

const crypto = require("node:crypto");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { scanContent } = require("./hooks/secret-scan");

const SCHEMA_VERSION = "1.0";
const PATTERNS_DIR = path.join(".devteam", "patterns");
const OBSERVATIONS_FILE = "observations.jsonl";
const PROMOTED_FILE = "promoted.json";
const RETIRED_FILE = "retired.json";
const DEMOTED_FILE = "demoted.json";
const PENDING_FILE = "pending-review.json";
const RECURRENCE_CHECKED_FILE = "recurrence-checked.json";

const DEFAULT_BUDGET = Object.freeze({
  blocker: 3,
  warning: 2,
  nudge: 1,
  positive: 1,
  maxBytes: 1600,
});

function patternsDir(cwd) {
  return path.join(cwd, PATTERNS_DIR);
}

function patternsPath(cwd, fileName) {
  return path.join(patternsDir(cwd), fileName);
}

function ensureDir(cwd) {
  fs.mkdirSync(patternsDir(cwd), { recursive: true });
}

function sha256(text) {
  return `sha256:${crypto.createHash("sha256").update(String(text)).digest("hex")}`;
}

function slugify(value) {
  return String(value || "pattern")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 96) || "pattern";
}

function readJson(file, fallback) {
  try {
    if (!fs.existsSync(file)) return fallback;
    return JSON.parse(fs.readFileSync(file, "utf8"));
  } catch {
    return fallback;
  }
}

function writeJson(file, value) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, `${JSON.stringify(value, null, 2)}\n`, "utf8");
}

function readObservations(cwd) {
  const file = patternsPath(cwd, OBSERVATIONS_FILE);
  if (!fs.existsSync(file)) return [];
  const out = [];
  for (const line of fs.readFileSync(file, "utf8").split(/\r?\n/)) {
    if (!line.trim()) continue;
    try {
      const parsed = JSON.parse(line);
      if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) out.push(parsed);
    } catch { /* ignore malformed local operational memory lines */ }
  }
  return out;
}

function writeObservations(cwd, observations) {
  ensureDir(cwd);
  const file = patternsPath(cwd, OBSERVATIONS_FILE);
  const text = observations.map((item) => JSON.stringify(item)).join("\n");
  fs.writeFileSync(file, text ? `${text}\n` : "", "utf8");
}

function loadPromoted(cwd) {
  const value = readJson(patternsPath(cwd, PROMOTED_FILE), { schema_version: SCHEMA_VERSION, patterns: [] });
  return Array.isArray(value.patterns) ? value.patterns : [];
}

function savePromoted(cwd, patterns) {
  writeJson(patternsPath(cwd, PROMOTED_FILE), { schema_version: SCHEMA_VERSION, patterns });
}

function loadRetired(cwd) {
  const value = readJson(patternsPath(cwd, RETIRED_FILE), { schema_version: SCHEMA_VERSION, patterns: [] });
  return Array.isArray(value.patterns) ? value.patterns : [];
}

function saveRetired(cwd, patterns) {
  writeJson(patternsPath(cwd, RETIRED_FILE), { schema_version: SCHEMA_VERSION, patterns });
}

// 30.2: demoted patterns — a promoted pattern an operator sent back to
// candidate status (e.g. because recurrence_after_injection kept climbing).
// Kept in their own store (mirrors retired.json) so promoted.json stays
// "only currently-promoted patterns" and demotion history survives a
// later re-promotion instead of being lost with the rest of the record.
function loadDemoted(cwd) {
  const value = readJson(patternsPath(cwd, DEMOTED_FILE), { schema_version: SCHEMA_VERSION, patterns: [] });
  return Array.isArray(value.patterns) ? value.patterns : [];
}

function saveDemoted(cwd, patterns) {
  writeJson(patternsPath(cwd, DEMOTED_FILE), { schema_version: SCHEMA_VERSION, patterns });
}

// 30.2(b): (gate file, promoted-pattern id) pairs already counted toward
// recurrence_after_injection — see collect()'s recurrence block for why this
// can't reuse the observations-fingerprint dedup.
function loadRecurrenceChecked(cwd) {
  const value = readJson(patternsPath(cwd, RECURRENCE_CHECKED_FILE), { schema_version: SCHEMA_VERSION, checked: [] });
  return new Set(Array.isArray(value.checked) ? value.checked : []);
}

function saveRecurrenceChecked(cwd, checkedSet) {
  writeJson(patternsPath(cwd, RECURRENCE_CHECKED_FILE), { schema_version: SCHEMA_VERSION, checked: [...checkedSet].sort() });
}

// Best-effort operator identity for audit lines (demote()). Never throws —
// falls back to "unknown" rather than blocking a CLI operator action.
function defaultOperator() {
  try {
    const info = os.userInfo();
    if (info && info.username) return info.username;
  } catch { /* platform may not support userInfo() */ }
  return process.env.USER || process.env.USERNAME || "unknown";
}

function listGateFiles(root) {
  const gates = path.join(root, "gates");
  let names;
  try { names = fs.readdirSync(gates); } catch { return []; }
  const current = names
    .filter((name) => name.endsWith(".json") && !name.includes(".attempt-"))
    .map((name) => path.join(gates, name));
  const archiveDir = path.join(gates, "archive");
  let archived = [];
  try {
    archived = fs.readdirSync(archiveDir)
      .filter((name) => name.endsWith(".json"))
      .map((name) => path.join(archiveDir, name));
  } catch { /* archive directory absent */ }
  return [...current, ...archived];
}

function readGate(file) {
  try {
    const stat = fs.lstatSync(file);
    if (!stat.isFile() || stat.isSymbolicLink() || stat.size > 1_000_000) return null;
    const parsed = JSON.parse(fs.readFileSync(file, "utf8"));
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

function detectLanguage(cwd) {
  const checks = [
    ["go", ["go.mod"]],
    ["python", ["pyproject.toml", "requirements.txt", "setup.py"]],
    ["javascript", ["package.json"]],
  ];
  for (const [language, files] of checks) {
    if (files.some((file) => fs.existsSync(path.join(cwd, file)))) return language;
  }
  return "unknown";
}

function detectFramework(cwd, language) {
  const candidates = [];
  for (const file of ["pyproject.toml", "requirements.txt", "package.json", "go.mod"]) {
    try {
      const p = path.join(cwd, file);
      if (fs.existsSync(p)) candidates.push(fs.readFileSync(p, "utf8").toLowerCase());
    } catch { /* best effort */ }
  }
  const text = candidates.join("\n");
  if (language === "python" && text.includes("fastapi")) return "fastapi";
  if (language === "javascript" && text.includes("express")) return "express";
  if (language === "go" && /gin-gonic|\/gin\b/.test(text)) return "gin";
  if (language === "go") return "nethttp";
  return "unknown";
}

function textForClassification(item) {
  if (typeof item === "string") return item;
  if (!item || typeof item !== "object") return "";
  const fields = [
    item.signal, item.domain, item.category, item.track_for, item.id, item.code,
    item.summary, item.description, item.message, item.note, item.text, item.ref,
  ];
  return fields.filter(Boolean).join(" ");
}

function detectorFrom(item, source) {
  if (item && typeof item === "object") {
    for (const key of ["signal", "code", "id", "track_for"]) {
      if (item[key]) return slugify(item[key]);
    }
  }
  return slugify(source);
}

function domainFrom(text, stage) {
  const value = `${stage || ""} ${text || ""}`.toLowerCase();
  if (/stage-06c/.test(value)) return "observability";
  if (/stage-06b/.test(value)) return "accessibility";
  if (/stage-06e/.test(value)) return "performance";
  if (/stage-07/.test(value)) return "docs";
  if (/stage-04a|stage-04e/.test(value)) return "tooling";
  if (/stage-04b|stage-04c/.test(value)) return "security";
  if (/observability|log|metric|trace|otel|prometheus/.test(value)) return "observability";
  if (/doc|readme|changelog|runbook|reference/.test(value)) return "docs";
  if (/test|coverage|qa|assert|spec/.test(value)) return "tests";
  if (/lint|eslint|ruff|format|prettier/.test(value)) return "tooling";
  if (/security|secret|auth|token|permission|crypto/.test(value)) return "security";
  if (/deploy|rollback|release|environment/.test(value)) return "deploy";
  if (/a11y|accessibility|aria|wcag/.test(value)) return "accessibility";
  if (/performance|latency|budget|load/.test(value)) return "performance";
  if (/migration|schema|database|sql/.test(value)) return "migration";
  if (/style|maintain|duplicate|complexity|architecture/.test(value)) return "maintainability";
  return "correctness";
}

function workstreamFromGate(gate, item) {
  if (item && typeof item === "object") {
    if (item.assigned_to) return String(item.assigned_to);
    if (item.workstream) return String(item.workstream);
  }
  if (gate.workstream) return String(gate.workstream);
  if (gate.role) return String(gate.role);
  return "unknown";
}

function observationFor({ cwd, gate, item, tier, source, resolvedByRetry = false }) {
  const text = textForClassification(item);
  const stage = String(gate.stage || "unknown");
  const workstream = workstreamFromGate(gate, item);
  const language = detectLanguage(cwd);
  const framework = detectFramework(cwd, language);
  const domain = domainFrom(text, stage);
  const detector = detectorFrom(item, source);
  const pattern_key = `${domain}:${detector}:${workstream}`;
  const stable = {
    pattern_key, tier, domain, stage, workstream,
    failure_class: gate.failure_class || (gate.status === "FAIL" ? "code-defect" : "other"),
    language, framework, source,
  };
  return {
    schema_version: SCHEMA_VERSION,
    kind: "pattern-observation",
    ...stable,
    status: gate.status || null,
    resolved_by_retry: Boolean(resolvedByRetry),
    detector,
    fingerprint: sha256(JSON.stringify(stable)),
    created_at: new Date().toISOString(),
  };
}

function runLogRetryKeys(root) {
  const file = path.join(root, "run-log.jsonl");
  const keys = new Set();
  if (!fs.existsSync(file)) return keys;
  for (const line of fs.readFileSync(file, "utf8").split(/\r?\n/)) {
    if (!line.trim()) continue;
    try {
      const ev = JSON.parse(line);
      if (ev && ev.outcome === "fix-retry" && ev.stage) keys.add(String(ev.stage));
    } catch { /* ignore */ }
  }
  return keys;
}

// 30.2(b): which promoted-pattern ids were injected into which stage's
// dispatch this run, per the "pattern-injected" run-log events recordInjection()
// appends. Read back at collection time to detect recurrence-after-injection.
function runLogInjectedPatternIds(root) {
  const file = path.join(root, "run-log.jsonl");
  const byStage = new Map();
  if (!fs.existsSync(file)) return byStage;
  for (const line of fs.readFileSync(file, "utf8").split(/\r?\n/)) {
    if (!line.trim()) continue;
    try {
      const ev = JSON.parse(line);
      if (ev && ev.outcome === "pattern-injected" && ev.stage && Array.isArray(ev.pattern_ids)) {
        const set = byStage.get(String(ev.stage)) || new Set();
        for (const id of ev.pattern_ids) set.add(String(id));
        byStage.set(String(ev.stage), set);
      }
    } catch { /* ignore malformed run-log line */ }
  }
  return byStage;
}

// 30.2(a): called at DISPATCH time — headless invoke or the interactive
// "print the prompt for a human to paste into a host" path — never at a
// preview/render-only call to runStage() (devteam reproduce, `devteam replay
// --dry-run`). Increments stats.injected on promoted.json (cross-run,
// persistent) and appends a per-run "pattern-injected" run-log event so a
// later collect() call in the same run can correlate a recurring blocker
// with "this pattern was already injected into this stage's dispatch."
// Fire-and-forget: injection bookkeeping must never fail a dispatch.
function recordInjection({ cwd, pipelineRoot, stage, workstreamId, patterns: injected }) {
  if (!Array.isArray(injected) || injected.length === 0) return;
  try {
    const ids = [...new Set(injected.map((item) => item && item.id).filter(Boolean))];
    if (ids.length === 0) return;
    const promoted = loadPromoted(cwd);
    const byId = new Map(promoted.map((item) => [item.id, item]));
    let changed = false;
    for (const id of ids) {
      const pattern = byId.get(id);
      if (!pattern) continue;
      pattern.stats = pattern.stats || { injected: 0, recurrence_after_injection: 0, noise_reports: 0 };
      pattern.stats.injected = (pattern.stats.injected || 0) + 1;
      changed = true;
    }
    if (changed) savePromoted(cwd, promoted.sort((a, b) => a.id.localeCompare(b.id)));

    const root = pipelineRoot || path.join(cwd, "pipeline");
    fs.mkdirSync(root, { recursive: true });
    const event = {
      ts: new Date().toISOString(),
      outcome: "pattern-injected",
      stage: stage || null,
      workstream_id: workstreamId || null,
      pattern_ids: ids,
    };
    fs.appendFileSync(path.join(root, "run-log.jsonl"), `${JSON.stringify(event)}\n`);
  } catch { /* fire-and-forget: must never affect dispatch */ }
}

function collect({ cwd, pipelineRoot }) {
  const root = pipelineRoot || path.join(cwd, "pipeline");
  const retryStages = runLogRetryKeys(root);

  // 30.2(b): recurrence-after-injection. A recurring blocker has the SAME
  // semantic fingerprint as the observation that got its pattern promoted in
  // the first place, so the observations-dedup-by-fingerprint below can't be
  // the recurrence signal — it would just look "already seen" forever. What
  // makes a recurrence distinct is which GATE FILE it comes from: every
  // dispatch attempt (the live gate, or each archived stage-*.attempt-N.json)
  // is a separate outcome. recurrence-checked.json remembers which (gate
  // file, promoted-pattern id) pairs already counted, so re-running collect()
  // over an unchanged gates/ directory stays idempotent while a genuinely new
  // attempt still increments the counter.
  const injectedByStage = runLogInjectedPatternIds(root);
  const promoted = injectedByStage.size > 0 ? loadPromoted(cwd) : null;
  const promotedById = promoted ? new Map(promoted.map((item) => [item.id, item])) : null;
  const checked = loadRecurrenceChecked(cwd);
  let checkedChanged = false;
  let recurrenceFlagged = 0;

  const observations = [];
  for (const file of listGateFiles(root)) {
    const gate = readGate(file);
    if (!gate) continue;
    const resolvedByRetry = retryStages.has(String(gate.stage || ""));
    for (const blocker of Array.isArray(gate.blockers) ? gate.blockers : []) {
      const obs = observationFor({ cwd, gate, item: blocker, tier: "blocker", source: "gate-blocker", resolvedByRetry });
      observations.push(obs);
      if (promotedById) {
        const injectedIds = injectedByStage.get(String(obs.stage));
        const id = injectedIds ? slugify(obs.pattern_key) : null;
        if (id && injectedIds.has(id) && promotedById.has(id)) {
          const checkKey = `${path.relative(cwd, file)}::${id}`;
          if (!checked.has(checkKey)) {
            checked.add(checkKey);
            checkedChanged = true;
            const pattern = promotedById.get(id);
            pattern.stats = pattern.stats || { injected: 0, recurrence_after_injection: 0, noise_reports: 0 };
            pattern.stats.recurrence_after_injection = (pattern.stats.recurrence_after_injection || 0) + 1;
            recurrenceFlagged += 1;
          }
        }
      }
    }
    for (const warning of Array.isArray(gate.warnings) ? gate.warnings : []) {
      observations.push(observationFor({ cwd, gate, item: warning, tier: "warning", source: "gate-warning", resolvedByRetry }));
    }
    for (const followup of Array.isArray(gate.noted_for_followup) ? gate.noted_for_followup : []) {
      const tier = followup && followup.track_for === "lessons-learned" ? "nudge" : "warning";
      observations.push(observationFor({ cwd, gate, item: followup, tier, source: "noted-for-followup", resolvedByRetry }));
    }
  }
  if (checkedChanged) {
    savePromoted(cwd, promoted.sort((a, b) => a.id.localeCompare(b.id)));
    saveRecurrenceChecked(cwd, checked);
  }

  const existing = readObservations(cwd);
  const byFingerprint = new Map(existing.map((item) => [item.fingerprint, item]));
  let added = 0;
  for (const item of observations) {
    if (!byFingerprint.has(item.fingerprint)) {
      byFingerprint.set(item.fingerprint, item);
      added += 1;
    }
  }
  const all = [...byFingerprint.values()];
  writeObservations(cwd, all);

  const rawCandidates = candidatesFromObservations(all);
  // 30.1: a retired pattern's identity (id, derived from pattern_key the same
  // way promote()/retire() do) must not re-enter the candidate pool from the
  // same observations that got it retired — retirement is a one-way decision
  // until an operator explicitly reconsiders it.
  const retiredIds = new Set(loadRetired(cwd).map((item) => item.id));
  const candidates = rawCandidates.filter((item) => !retiredIds.has(item.id));
  const suppressed = rawCandidates.length - candidates.length;
  writeJson(patternsPath(cwd, PENDING_FILE), { schema_version: SCHEMA_VERSION, candidates });
  return { added, total: all.length, candidates: candidates.length, suppressed, recurrenceFlagged, dir: patternsDir(cwd) };
}

function candidatesFromObservations(observations) {
  const groups = new Map();
  for (const obs of observations) {
    if (!obs || !obs.pattern_key) continue;
    const key = obs.pattern_key;
    const existing = groups.get(key) || {
      id: slugify(key),
      pattern_key: key,
      tier: obs.tier || "warning",
      domain: obs.domain || "correctness",
      observations: 0,
      resolved_by_retry: 0,
      stages: new Set(),
      workstreams: new Set(),
      languages: new Set(),
      frameworks: new Set(),
      sources: new Set(),
      proposed_prompt_text: proposedPromptText(obs),
      last_seen: null,
    };
    existing.observations += 1;
    if (obs.resolved_by_retry) existing.resolved_by_retry += 1;
    if (obs.stage) existing.stages.add(obs.stage);
    if (obs.workstream) existing.workstreams.add(obs.workstream);
    if (obs.language) existing.languages.add(obs.language);
    if (obs.framework) existing.frameworks.add(obs.framework);
    if (obs.source) existing.sources.add(obs.source);
    if (!existing.last_seen || String(obs.created_at || "") > existing.last_seen) existing.last_seen = obs.created_at || null;
    groups.set(key, existing);
  }
  return [...groups.values()].map((item) => ({
    ...item,
    stages: [...item.stages].sort(),
    workstreams: [...item.workstreams].sort(),
    languages: [...item.languages].sort(),
    frameworks: [...item.frameworks].sort(),
    sources: [...item.sources].sort(),
  })).sort((a, b) => (b.observations - a.observations) || a.id.localeCompare(b.id));
}

function proposedPromptText(obs) {
  const lang = obs.language && obs.language !== "unknown" ? `${obs.language} ` : "";
  switch (obs.domain) {
    case "observability":
      return `For ${lang}${obs.workstream} work, implement required structured logs, metrics, or traces during build so the observability gate can verify them.`;
    case "docs":
      return "When adding or changing user-visible behavior, update README.md, docs/reference/*, or changelog.d/* during implementation rather than waiting for sign-off.";
    case "tests":
      return `For ${lang}${obs.workstream} work, include edge-case tests alongside happy-path coverage.`;
    case "tooling":
      return "Before pre-review, ensure configured lint/test scripts exist or the gate records an explicit skip reason.";
    case "accessibility":
      return "When changing UI behavior, handle labels, ARIA state, focus order, and contrast before the accessibility audit.";
    case "security":
      return "Treat auth, secrets, permissions, and user-controlled inputs as first-class implementation concerns before security review.";
    default:
      return `Avoid repeating prior ${obs.domain || "correctness"} findings for this ${obs.workstream} workstream; check warnings and blockers before writing the gate.`;
  }
}

function list({ cwd }) {
  return {
    observations: readObservations(cwd),
    candidates: candidatesFromObservations(readObservations(cwd)),
    promoted: loadPromoted(cwd),
    retired: loadRetired(cwd),
    demoted: loadDemoted(cwd),
  };
}

function promote({ cwd, candidateId, text }) {
  if (!candidateId) throw new Error("patterns promote requires a candidate id");

  // 30.2(d): re-promoting a demoted pattern restores its own prompt_text/
  // applies_to/stats and preserves demotion_history — a demote → promote
  // round-trip must not lose the audit trail.
  const demoted = loadDemoted(cwd);
  const demotedIdx = demoted.findIndex((item) => item.id === candidateId || item.pattern_key === candidateId);
  if (demotedIdx !== -1) {
    const [record] = demoted.splice(demotedIdx, 1);
    const promptText = String(text || record.prompt_text || "").trim();
    if (!promptText) throw new Error("promoted pattern prompt text cannot be empty");
    const findings = scanContent(promptText);
    if (findings.length > 0) {
      throw new Error(`promoted pattern text looks secret-shaped: ${findings.map((f) => f.name).join(", ")}`);
    }
    record.status = "promoted";
    record.prompt_text = promptText;
    record.promoted_at = new Date().toISOString();
    record.stats = record.stats || { injected: 0, recurrence_after_injection: 0, noise_reports: 0 };
    const promoted = loadPromoted(cwd).filter((item) => item.id !== record.id);
    promoted.push(record);
    savePromoted(cwd, promoted.sort((a, b) => a.id.localeCompare(b.id)));
    saveDemoted(cwd, demoted);
    return record;
  }

  const candidates = candidatesFromObservations(readObservations(cwd));
  const candidate = candidates.find((item) => item.id === candidateId || item.pattern_key === candidateId);
  if (!candidate) throw new Error(`unknown pattern candidate: ${candidateId}`);
  const promptText = String(text || candidate.proposed_prompt_text || "").trim();
  if (!promptText) throw new Error("promoted pattern prompt text cannot be empty");
  const findings = scanContent(promptText);
  if (findings.length > 0) {
    throw new Error(`promoted pattern text looks secret-shaped: ${findings.map((f) => f.name).join(", ")}`);
  }
  const promoted = loadPromoted(cwd);
  const id = candidate.id;
  const now = new Date().toISOString();
  const record = {
    schema_version: SCHEMA_VERSION,
    id,
    status: "promoted",
    tier: candidate.tier,
    domain: candidate.domain,
    applies_to: {
      stages: ["build", ...candidate.stages].filter(Boolean),
      workstreams: candidate.workstreams.filter((w) => w && w !== "unknown"),
      languages: candidate.languages.filter((l) => l && l !== "unknown"),
      frameworks: candidate.frameworks.filter((f) => f && f !== "unknown"),
      feature_hints: featureHintsFor(candidate),
    },
    prompt_text: promptText,
    evidence: {
      observations: candidate.observations,
      last_seen: candidate.last_seen,
      last_reinforced: now.slice(0, 10),
    },
    stats: {
      injected: 0,
      recurrence_after_injection: 0,
      noise_reports: 0,
    },
    promoted_at: now,
  };
  const next = promoted.filter((item) => item.id !== id);
  next.push(record);
  savePromoted(cwd, next.sort((a, b) => a.id.localeCompare(b.id)));
  return record;
}

function featureHintsFor(candidate) {
  const hints = new Set();
  if (candidate.domain === "docs") ["http", "api", "endpoint", "cli"].forEach((h) => hints.add(h));
  if (candidate.domain === "observability") ["service", "api", "endpoint", "worker"].forEach((h) => hints.add(h));
  if (candidate.domain === "tests") ["parser", "validator", "endpoint", "cli"].forEach((h) => hints.add(h));
  return [...hints];
}

function retire({ cwd, patternId, reason = "retired by operator" }) {
  if (!patternId) throw new Error("patterns retire requires a pattern id");
  const promoted = loadPromoted(cwd);
  const idx = promoted.findIndex((item) => item.id === patternId);
  if (idx === -1) throw new Error(`unknown promoted pattern: ${patternId}`);
  const [record] = promoted.splice(idx, 1);
  record.status = "retired";
  record.retired_at = new Date().toISOString();
  record.retirement_reason = reason;
  const retired = loadRetired(cwd).filter((item) => item.id !== patternId);
  retired.push(record);
  savePromoted(cwd, promoted);
  saveRetired(cwd, retired.sort((a, b) => a.id.localeCompare(b.id)));
  return record;
}

// 30.2(d): demotion is the reversible sibling of retire() — an explicit
// operator decision (never automatic; see docs/pattern-learning.md's open
// question on auto-promotion/auto-retirement) that sends a promoted pattern
// back to candidate status instead of retiring it outright. The audit line
// (who/when/reason/counters-at-demotion) travels with the record into
// demoted.json so a later `patterns promote <id>` can restore it without
// losing the history.
function demote({ cwd, patternId, operator, reason = "demoted by operator" }) {
  if (!patternId) throw new Error("patterns demote requires a pattern id");
  const promoted = loadPromoted(cwd);
  const idx = promoted.findIndex((item) => item.id === patternId);
  if (idx === -1) throw new Error(`unknown promoted pattern: ${patternId}`);
  const [record] = promoted.splice(idx, 1);
  const demotionEntry = {
    demoted_at: new Date().toISOString(),
    demoted_by: operator || defaultOperator(),
    reason,
    counters_at_demotion: { ...(record.stats || { injected: 0, recurrence_after_injection: 0, noise_reports: 0 }) },
  };
  record.status = "candidate";
  record.demotion_history = Array.isArray(record.demotion_history)
    ? [...record.demotion_history, demotionEntry]
    : [demotionEntry];
  const demoted = loadDemoted(cwd).filter((item) => item.id !== patternId);
  demoted.push(record);
  savePromoted(cwd, promoted);
  saveDemoted(cwd, demoted.sort((a, b) => a.id.localeCompare(b.id)));
  return record;
}

function scorePattern(pattern, descriptor, ctx, detected) {
  const applies = pattern.applies_to || {};
  let score = 0;
  const stageNames = new Set([descriptor.name, descriptor.stage].filter(Boolean));
  if (!applies.stages || applies.stages.length === 0) score += 1;
  else if (applies.stages.some((s) => stageNames.has(s))) score += 4;
  if (applies.workstreams && applies.workstreams.includes(descriptor.role)) score += 4;
  if (applies.languages && applies.languages.includes(detected.language)) score += 2;
  if (applies.frameworks && applies.frameworks.includes(detected.framework)) score += 2;
  const feature = String(ctx.feature || "").toLowerCase();
  if (feature && applies.feature_hints && applies.feature_hints.some((hint) => feature.includes(String(hint).toLowerCase()))) score += 2;
  if (pattern.tier === "positive") score -= 1;
  return score;
}

function selectForDescriptor({ cwd, descriptor, ctx = {}, budget = DEFAULT_BUDGET }) {
  const promoted = loadPromoted(cwd).filter((item) => item.status === "promoted" && item.prompt_text);
  if (promoted.length === 0) return [];
  const detected = { language: detectLanguage(cwd), framework: detectFramework(cwd, detectLanguage(cwd)) };
  const buckets = { blocker: [], warning: [], nudge: [], positive: [] };
  for (const pattern of promoted) {
    const score = scorePattern(pattern, descriptor, ctx, detected);
    if (score <= 0) continue;
    const tier = buckets[pattern.tier] ? pattern.tier : "warning";
    buckets[tier].push({ ...pattern, _score: score });
  }
  const selected = [];
  for (const tier of ["blocker", "warning", "nudge", "positive"]) {
    const limit = budget[tier] || 0;
    buckets[tier].sort((a, b) => (b._score - a._score) || a.id.localeCompare(b.id));
    selected.push(...buckets[tier].slice(0, limit));
  }
  const out = [];
  let bytes = 0;
  for (const item of selected) {
    const text = String(item.prompt_text || "");
    const nextBytes = bytes + Buffer.byteLength(text, "utf8");
    if (nextBytes > budget.maxBytes && out.length > 0) continue;
    bytes = nextBytes;
    out.push({ id: item.id, tier: item.tier, domain: item.domain, prompt_text: text });
  }
  return out;
}

function statSum(patterns, field) {
  return patterns.reduce((sum, item) => sum + ((item.stats && item.stats[field]) || 0), 0);
}

function stats({ cwd }) {
  const observations = readObservations(cwd);
  const promoted = loadPromoted(cwd);
  const retired = loadRetired(cwd);
  const demoted = loadDemoted(cwd);
  // Historical injected/recurrence/noise counts survive a demotion (they
  // live on in demoted.json), so the aggregate sums include both stores —
  // only the promoted/demoted counts themselves are reported separately.
  const withHistory = [...promoted, ...demoted];
  return {
    schema_version: SCHEMA_VERSION,
    observations: observations.length,
    candidates: candidatesFromObservations(observations).length,
    promoted: promoted.length,
    retired: retired.length,
    demoted: demoted.length,
    injected: statSum(withHistory, "injected"),
    recurrence_after_injection: statSum(withHistory, "recurrence_after_injection"),
    noise_reports: statSum(withHistory, "noise_reports"),
  };
}

module.exports = {
  SCHEMA_VERSION,
  PATTERNS_DIR,
  OBSERVATIONS_FILE,
  PROMOTED_FILE,
  RETIRED_FILE,
  DEMOTED_FILE,
  PENDING_FILE,
  RECURRENCE_CHECKED_FILE,
  DEFAULT_BUDGET,
  patternsDir,
  collect,
  list,
  promote,
  retire,
  demote,
  recordInjection,
  selectForDescriptor,
  stats,
  readObservations,
  loadPromoted,
  loadDemoted,
  candidatesFromObservations,
  detectLanguage,
  detectFramework,
};
