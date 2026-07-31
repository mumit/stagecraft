"use strict";

// collect.js — gather all pipeline artifacts into a structured ReportData
// object. Pure file-reads; no network calls, no orchestrator dependency.
//
// Entry point: collectReport(cwd, opts) → ReportData

const fs = require("node:fs");
const path = require("node:path");

// Scan run-log.jsonl backward for the last line matching a predicate.
function lastMatchingEvent(logPath, predicate, maxLines = 500) {
  let content;
  try { content = fs.readFileSync(logPath, "utf8"); } catch { return null; }
  const lines = content.trimEnd().split("\n");
  for (let i = lines.length - 1; i >= Math.max(0, lines.length - maxLines); i--) {
    try {
      const obj = JSON.parse(lines[i]);
      if (predicate(obj)) return obj;
    } catch { /* skip malformed */ }
  }
  return null;
}

function readJSON(p) {
  try { return JSON.parse(fs.readFileSync(p, "utf8")); } catch { return null; }
}

function readText(p) {
  try { return fs.readFileSync(p, "utf8"); } catch { return null; }
}

// Normalize a gate's blockers/warnings array: gates may store items as plain
// strings or as objects { id, summary, file, line }. Always return strings.
function normalizeItems(items) {
  if (!Array.isArray(items)) return [];
  return items.map(item => {
    if (typeof item === "string") return item;
    if (item && typeof item === "object") {
      const id = item.id || "";
      const summary = item.summary || item.message || item.description || "";
      const loc = item.file
        ? (item.line != null ? `${item.file}:${item.line}` : item.file)
        : "";
      return [id, summary, loc ? `(${loc})` : ""].filter(Boolean).join(" ");
    }
    return String(item);
  }).filter(Boolean);
}

// Determine run final status from run-state.json + run-log terminal events.
// Looks specifically for terminal events (complete/halt) because heartbeats are
// written after halt events and the last event of any type would mask the real state.
function finalStatus(runState, logPath) {
  const terminal = lastMatchingEvent(logPath, e => {
    const o = e.outcome || "";
    return o === "complete" || o.includes("halt");
  });
  if (!terminal) return runState ? "incomplete" : "no-run";
  const o = terminal.outcome || "";
  if (o === "complete") return "completed";
  if (o.includes("halt")) return "halted";
  return "incomplete";
}

// Extract timing and retry stats from run-log.jsonl dispatch-observation events.
function collectLogStats(logPath) {
  let content;
  try { content = fs.readFileSync(logPath, "utf8"); } catch { return null; }
  const events = [];
  for (const line of content.trimEnd().split("\n")) {
    if (!line.trim()) continue;
    try { events.push(JSON.parse(line)); } catch { /* skip malformed */ }
  }
  if (events.length === 0) return null;

  const firstTs = events[0].ts || null;
  const lastTs = events[events.length - 1].ts || null;
  const wallClockMs = (firstTs && lastTs) ? (new Date(lastTs) - new Date(firstTs)) : null;

  const stageStats = {};
  let retries = 0;
  let stalls = 0;

  for (const e of events) {
    if (e.outcome === "dispatch-observation") {
      const sid = e.stage;
      if (!stageStats[sid]) stageStats[sid] = { computeMs: 0, attempts: 0, model: null, host: null };
      stageStats[sid].computeMs += (e.duration_ms || 0);
      stageStats[sid].attempts += 1;
      if (e.model && e.model !== "unknown") stageStats[sid].model = e.model;
      if (e.host && e.host !== "unknown") stageStats[sid].host = e.host;
    } else if (e.outcome === "fix-retry" || e.outcome === "transient-retry" || e.outcome === "targeted-fix-dispatch") {
      retries++;
    } else if (e.outcome === "stall-detected") {
      stalls++;
    }
  }

  const totalComputeMs = Object.values(stageStats).reduce((sum, s) => sum + s.computeMs, 0);
  return { wallClockMs, totalComputeMs, retries, stalls, stages: stageStats };
}

// Extract the problem-statement paragraph from brief.md.
function extractProblemStatement(text) {
  if (!text) return null;
  const lines = text.split(/\r?\n/);
  const headerRe = /^##\s+(?:[§0-9.]*\s+)?problem\s+statement\b/i;
  const nextHeaderRe = /^#/;
  let inSection = false;
  const paragraphLines = [];
  for (const line of lines) {
    if (!inSection && headerRe.test(line)) { inSection = true; continue; }
    if (inSection) {
      if (nextHeaderRe.test(line)) break;
      paragraphLines.push(line);
    }
  }
  // Return first non-empty paragraph (join consecutive non-blank lines)
  const block = paragraphLines.join("\n").trim();
  const firstPara = block.split(/\n\n+/)[0];
  return firstPara || null;
}

// Extract the <!-- devteam:run-blockers:begin --> block from context.md.
function extractBlockerLog(text) {
  if (!text) return "";
  const BEGIN = "<!-- devteam:run-blockers:begin -->";
  const END = "<!-- devteam:run-blockers:end -->";
  const start = text.indexOf(BEGIN);
  if (start === -1) return "";
  const end = text.indexOf(END, start);
  if (end === -1) return "";
  // Strip the HTML comment lines themselves and return inner content
  const inner = text.slice(start + BEGIN.length, end);
  // Also strip any lines that are just HTML comments (written-by annotations)
  return inner
    .split("\n")
    .filter(l => !l.trim().startsWith("<!--") && !l.trim().startsWith("-->"))
    .join("\n")
    .trim();
}

// Parse gate filename → { stage, role }.
// "stage-04.json"         → { stage: "stage-04", role: null }
// "stage-04.backend.json" → { stage: "stage-04", role: "backend" }
function parseGateFilename(filename) {
  const base = filename.replace(/\.json$/, "");
  // Workstream gate: stage-XX.role (role is alpha, no digits)
  const wsMatch = base.match(/^(stage-\d{2}[a-z]?)\.([a-z][a-z0-9-]*)$/);
  if (wsMatch) return { stage: wsMatch[1], role: wsMatch[2] };
  // Stage-level gate: stage-XX or stage-XXa
  if (/^stage-\d{2}[a-z]?$/.test(base)) return { stage: base, role: null };
  return null;
}

// Friendly display name for a stage ID.
const STAGE_NAMES = {
  "stage-01": "brief",
  "stage-02": "design",
  "stage-03": "clarification",
  "stage-03b": "executable-spec",
  "stage-04": "build",
  "stage-04a": "pre-review",
  "stage-04b": "security-review",
  "stage-04c": "red-team",
  "stage-04e": "preflight",
  "stage-05": "peer-review",
  "stage-06": "qa",
  "stage-06b": "accessibility-audit",
  "stage-06c": "observability-gate",
  "stage-07": "deploy",
  "stage-08": "deploy",
};

function stageName(stageId) {
  return STAGE_NAMES[stageId] || stageId;
}

// Collect and return the full ReportData structure.
function collectReport(cwd, opts = {}) {
  const { pipelineRoot } = require("../paths");
  const { runStatePath, runLogPath } = require("../driver");

  // Resolve changeId (bounded isolation) the same way status.js does.
  let changeId = opts.changeId || null;
  if (!changeId) {
    try {
      const { loadConfig, changeIdFromFeature } = require("../config");
      const config = loadConfig(cwd);
      const isolation = config.pipeline && config.pipeline.isolation;
      if (isolation === "bounded" && opts.feature) {
        changeId = changeIdFromFeature(opts.feature);
      }
    } catch { /* no config, that's fine */ }
  }

  const pipelineDir = pipelineRoot(cwd, changeId);
  const gatesDir = path.join(pipelineDir, "gates");
  const logPath = runLogPath(cwd, changeId);
  const statePath = runStatePath(cwd, changeId);

  // --- 1. Run state ---
  const runState = readJSON(statePath);

  // --- 2. Final status ---
  const status = finalStatus(runState, logPath);

  // Get halt type and reason from the terminal halt event.
  let haltReason = null;
  let haltType = null;
  if (status === "halted") {
    const haltEvent = lastMatchingEvent(logPath, (e) => (e.outcome || "").includes("halt"));
    haltType = haltEvent ? haltEvent.outcome : null;
    haltReason = (haltEvent && (haltEvent.reason || haltEvent.halt_reason)) || null;
  }

  // --- 2b. Log stats ---
  const logStats = collectLogStats(logPath);

  // Orchestrator version from any gate (read lazily later).
  let orchestratorVersion = null;

  // --- 3. Stage gates ---
  const stageMap = new Map(); // stage-id → { stage, name, status, timestamp, ... }
  if (fs.existsSync(gatesDir)) {
    const gateFiles = fs.readdirSync(gatesDir)
      .filter(f => f.endsWith(".json"))
      .sort();

    for (const filename of gateFiles) {
      const parsed = parseGateFilename(filename);
      if (!parsed) continue;
      const gate = readJSON(path.join(gatesDir, filename));
      if (!gate) continue;

      // Capture orchestrator version from any gate.
      if (!orchestratorVersion && gate.orchestrator) {
        orchestratorVersion = gate.orchestrator;
      }

      if (parsed.role === null) {
        // Stage-level gate
        const entry = stageMap.get(parsed.stage) || {
          stage: parsed.stage,
          name: stageName(parsed.stage),
          status: null,
          timestamp: null,
          durationMs: null,
          blockers: [],
          warnings: [],
          workstreams: [],
        };
        entry.status = gate.status || null;
        entry.timestamp = gate.timestamp || null;
        entry.durationMs = gate.duration_ms || null;
        entry.blockers = normalizeItems(gate.blockers);
        entry.warnings = normalizeItems(gate.warnings);
        stageMap.set(parsed.stage, entry);
      } else {
        // Workstream gate
        const entry = stageMap.get(parsed.stage) || {
          stage: parsed.stage,
          name: stageName(parsed.stage),
          status: null,
          timestamp: null,
          durationMs: null,
          blockers: [],
          warnings: [],
          workstreams: [],
        };
        entry.workstreams.push({
          role: parsed.role,
          host: gate.host || null,
          status: gate.status || null,
          timestamp: gate.timestamp || null,
          durationMs: gate.duration_ms || null,
          blockers: normalizeItems(gate.blockers),
          warnings: normalizeItems(gate.warnings),
        });
        stageMap.set(parsed.stage, entry);
      }
    }
  }

  // For multi-role stages where only workstream gates exist (no merged stage
  // gate yet), synthesize a status from workstreams.
  for (const [, entry] of stageMap) {
    if (entry.status === null && entry.workstreams.length > 0) {
      const statuses = entry.workstreams.map(w => w.status);
      if (statuses.every(s => s === "PASS")) entry.status = "PASS";
      else if (statuses.some(s => s === "FAIL")) entry.status = "FAIL";
      else if (statuses.some(s => s === "ESCALATE")) entry.status = "ESCALATE";
      else if (statuses.some(s => s === "WARN")) entry.status = "WARN";
    }
  }

  // Sort stages in canonical order.
  const STAGE_ORDER = [
    "stage-01", "stage-02", "stage-03", "stage-03b",
    "stage-04", "stage-04a", "stage-04b", "stage-04c", "stage-04e",
    "stage-05", "stage-06", "stage-06b", "stage-06c",
    "stage-07", "stage-08",
  ];
  const stages = STAGE_ORDER
    .map(s => stageMap.get(s))
    .filter(Boolean);
  // Append any stages not in the canonical order (future/custom stages).
  for (const [id, entry] of stageMap) {
    if (!STAGE_ORDER.includes(id)) stages.push(entry);
  }

  // --- 4. Stage-01 special fields ---
  const gate01 = stageMap.get("stage-01") ? readJSON(path.join(gatesDir, "stage-01.json")) : null;
  const acCount = gate01 ? (gate01.acceptance_criteria_count || null) : null;
  const outOfScope = gate01 ? (gate01.out_of_scope_items || []) : [];
  const activeRoles = gate01 ? (gate01.active_roles || null) : null;

  // --- 5. Stage-03b special fields ---
  const gate03b = stageMap.get("stage-03b") ? readJSON(path.join(gatesDir, "stage-03b.json")) : null;
  const specScenarios = gate03b ? (gate03b.scenarios_count || gate03b.criteria_count || null) : null;
  const specDrift = gate03b ? (gate03b.drift || false) : false;

  // --- 6. Brief problem statement ---
  const briefPath = path.join(pipelineDir, "brief.md");
  const briefText = readText(briefPath);
  const problemStatement = extractProblemStatement(briefText);

  // --- 7. Context.md blocker log ---
  const contextPath = path.join(pipelineDir, "context.md");
  const contextText = readText(contextPath);
  const blockerLog = extractBlockerLog(contextText);

  // --- 8. ADRs ---
  const adrDir = path.join(pipelineDir, "adr");
  const adrs = [];
  if (fs.existsSync(adrDir)) {
    const adrFiles = fs.readdirSync(adrDir)
      .filter(f => f.endsWith(".md") && f !== "index.md")
      .sort();
    for (const filename of adrFiles) {
      const absPath = path.join(adrDir, filename);
      const text = readText(absPath);
      let title = filename;
      if (text) {
        const firstHeading = text.split("\n").find(l => l.startsWith("# "));
        if (firstHeading) title = firstHeading.replace(/^#\s+/, "").trim();
      }
      adrs.push({ title, absPath });
    }
  }

  // --- 9. Artifact presence ---
  const KNOWN_ARTIFACTS = [
    { kind: "brief",       label: "brief.md",             rel: "brief.md" },
    { kind: "spec",        label: "spec.feature",          rel: "spec.feature" },
    { kind: "design",      label: "design-spec.md",        rel: "design-spec.md" },
    { kind: "build-plan",  label: "build-plan.md",         rel: "build-plan.md" },
    { kind: "pre-review",  label: "pre-review.md",         rel: "pre-review.md" },
    { kind: "security",    label: "security-review.md",    rel: "security-review.md" },
    { kind: "red-team",    label: "red-team-report.md",    rel: "red-team-report.md" },
    { kind: "test-report", label: "test-report.md",        rel: "test-report.md" },
    { kind: "accessibility", label: "accessibility-report.md", rel: "accessibility-report.md" },
    { kind: "observability", label: "observability-report.md", rel: "observability-report.md" },
    { kind: "retrospective", label: "retrospective.md",    rel: "retrospective.md" },
  ];

  // Code reviews (dynamic — one per workstream)
  const reviewDir = path.join(pipelineDir, "code-review");
  if (fs.existsSync(reviewDir)) {
    const reviewFiles = fs.readdirSync(reviewDir)
      .filter(f => f.startsWith("by-") && f.endsWith(".md"))
      .sort();
    for (const f of reviewFiles) {
      const role = f.replace(/^by-/, "").replace(/\.md$/, "");
      KNOWN_ARTIFACTS.push({
        kind: "review",
        label: `code-review/${f}`,
        rel: `code-review/${f}`,
        role,
      });
    }
  }

  const artifacts = KNOWN_ARTIFACTS.map(a => ({
    kind: a.kind,
    label: a.label,
    absPath: path.join(pipelineDir, a.rel),
    exists: fs.existsSync(path.join(pipelineDir, a.rel)),
  }));

  // --- 10. Embeddable document content (raw text for HTML embedding) ---
  const DOC_DESCRIPTORS = [
    { kind: "brief",         label: "brief.md",               rel: "brief.md" },
    { kind: "spec",          label: "spec.feature",            rel: "spec.feature" },
    { kind: "design",        label: "design-spec.md",          rel: "design-spec.md" },
    { kind: "build-plan",    label: "build-plan.md",           rel: "build-plan.md" },
    { kind: "pre-review",    label: "pre-review.md",           rel: "pre-review.md" },
    { kind: "security",      label: "security-review.md",      rel: "security-review.md" },
    { kind: "red-team",      label: "red-team-report.md",      rel: "red-team-report.md" },
    { kind: "test-report",   label: "test-report.md",          rel: "test-report.md" },
    { kind: "accessibility", label: "accessibility-report.md", rel: "accessibility-report.md" },
    { kind: "observability", label: "observability-report.md", rel: "observability-report.md" },
    { kind: "retrospective", label: "retrospective.md",        rel: "retrospective.md" },
  ];
  for (const adr of adrs) {
    DOC_DESCRIPTORS.push({ kind: "adr", label: adr.title, abs: adr.absPath });
  }
  const codeRevDir = path.join(pipelineDir, "code-review");
  if (fs.existsSync(codeRevDir)) {
    const revFiles = fs.readdirSync(codeRevDir)
      .filter(f => f.startsWith("by-") && f.endsWith(".md"))
      .sort();
    for (const f of revFiles) {
      const role = f.replace(/^by-/, "").replace(/\.md$/, "");
      DOC_DESCRIPTORS.push({ kind: "review", label: `code-review (${role})`, rel: `code-review/${f}` });
    }
  }
  const documents = DOC_DESCRIPTORS
    .map(d => {
      const absPath = d.abs || path.join(pipelineDir, d.rel);
      const content = readText(absPath);
      return content !== null ? { kind: d.kind, label: d.label, content } : null;
    })
    .filter(Boolean);

  // --- Compose meta ---
  // Feature name: prefer run-state.feature, then brief.md H1 title,
  // then the pipeline parent directory name, then the intent string.
  let feature = (runState && runState.feature) || (runState && runState.repair) || null;
  if (!feature && briefText) {
    const h1 = briefText.split("\n").find(l => /^#\s+/.test(l));
    if (h1) feature = h1.replace(/^#\s+/, "").replace(/^Product Brief\s*[—\-:]\s*/i, "").trim();
  }
  if (!feature) feature = path.basename(cwd);
  if (!feature || feature === "." || feature === "") {
    feature = (runState && runState.intent) || "Unknown feature";
  }

  return {
    meta: {
      feature,
      intent: runState ? (runState.intent || null) : null,
      track: runState ? (runState.track || null) : null,
      startedAt: runState ? (runState.started_at || null) : null,
      iterations: runState ? (runState.iterations || 0) : 0,
      costUsd: runState ? (runState.cost_usd || null) : null,
      // Phase-28 item 28.4: "observed" / "model-asserted" / "mixed" / null.
      costBasis: runState ? (runState.cost_basis || null) : null,
      finalStatus: status,
      haltReason,
      haltType,
      orchestratorVersion,
      currentStage: runState ? (runState.current_stage || null) : null,
    },
    brief: {
      problemStatement,
      acCount,
      outOfScope,
      activeRoles,
      specScenarios,
      specDrift,
    },
    adrs,
    stages,
    blockerLog,
    artifacts,
    documents,
    logStats,
  };
}

module.exports = { collectReport };
