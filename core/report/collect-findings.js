"use strict";

// collect-findings.js — Phase 35 item 35.4. Gathers one ranked, severity-
// ordered findings list across every review artifact present: security-
// review (stage-04b), red-team incl. the 31.2 mechanical floor (stage-04c),
// peer-review + critic (stage-05 / stage-05.critic), the 31.4 mutation smoke
// gate (stage-06), verification-beyond-tests (stage-06d), and docs/audit/*.md
// when the audit workflow has run. Pure file-reads; no network calls, no
// orchestrator dependency — same contract as ./collect.js.
//
// Provenance discipline (plan §35.4, reusing the existing
// _orchestrator_stamped / _orchestrator_observed distinction rather than
// inventing a new one): a finding is "orchestrator-observed" only when it
// traces to code the orchestrator itself ran (a mechanical red-team floor
// check, a mutation gate execution, a stamp.js field the orchestrator
// confirmed with real evidence, or a peer-review approval mismatch the
// approval-derivation hook derived from the review file). Everything else —
// a model's red-team/security/peer-review/audit judgment, even when well
// evidenced in prose — is "model-asserted". When in doubt this module
// asserts less, never more: an unconfirmed claim stays model-asserted.
//
// Entry point: collectFindings(cwd, opts) → FindingsReportData
// (schema: core/report/schemas/findings-report.schema.json)

const fs = require("node:fs");
const path = require("node:path");
const { parseMarkdownFindingBlocks } = require("./parse-markdown-findings");

function readJSON(p) {
  try { return JSON.parse(fs.readFileSync(p, "utf8")); } catch { return null; }
}

function readText(p) {
  try { return fs.readFileSync(p, "utf8"); } catch { return null; }
}

const PROVENANCE = { OBSERVED: "orchestrator-observed", ASSERTED: "model-asserted" };
const SEVERITY_RANK = { critical: 0, high: 1, medium: 2, low: 3, unknown: 4 };

function normalizeSeverity(raw) {
  const v = String(raw ?? "").trim().toLowerCase().replace(/[.,;:]+$/, "");
  return Object.prototype.hasOwnProperty.call(SEVERITY_RANK, v) ? v : "unknown";
}

// First `path/to/file.ext:NN` token found in free text (also matches the
// `file.ext:NN-MM` range form used in docs/audit/06-security.md — only the
// start line is kept).
const FILE_LINE_RE = /([./A-Za-z0-9_-]+\.[A-Za-z0-9]{1,10}):(\d+)(?:-\d+)?/;

function extractFileLine(text) {
  if (!text) return { file: null, line: null };
  const m = FILE_LINE_RE.exec(text);
  if (!m) return { file: null, line: null };
  return { file: m[1], line: Number(m[2]) };
}

function mkFinding({ id, severity, file, line, summary, mitigation, effort, provenance, source, sourceFile }) {
  return {
    id: id != null ? String(id) : null,
    severity: normalizeSeverity(severity),
    file: file || null,
    line: line != null ? line : null,
    summary: summary || "(no summary provided)",
    mitigation: mitigation || null,
    effort: effort || null,
    provenance,
    source,
    sourceFile,
  };
}

// --- stage-04c: red-team (model judgment + 31.2 mechanical floor) ---------

function collectRedTeamFindings(pipelineDir) {
  const gatePath = path.join(pipelineDir, "gates", "stage-04c.json");
  const gate = readJSON(gatePath);
  if (!gate) return [];

  const reportText = readText(path.join(pipelineDir, "red-team-report.md"));
  const reportBlocks = reportText ? parseMarkdownFindingBlocks(reportText) : new Map();

  function enrichFromReport(finding, id) {
    const block = reportBlocks.get(id);
    if (!block) return finding;
    const fl = extractFileLine(block.fields.where || "");
    return {
      ...finding,
      file: finding.file || fl.file,
      line: finding.line != null ? finding.line : fl.line,
      mitigation: finding.mitigation || block.fields.suggestedFix || null,
      effort: finding.effort || block.fields.effort || null,
    };
  }

  const findings = [];
  for (const item of (gate.must_address_before_peer_review || [])) {
    const fl = extractFileLine(item.summary);
    const isMechanical = item.source === "mechanical";
    let finding = mkFinding({
      id: item.id,
      severity: item.severity,
      file: fl.file,
      line: fl.line,
      summary: item.summary,
      provenance: isMechanical ? PROVENANCE.OBSERVED : PROVENANCE.ASSERTED,
      source: isMechanical ? "red-team (mechanical floor)" : "red-team",
      sourceFile: gatePath,
    });
    if (!isMechanical) finding = enrichFromReport(finding, item.id);
    findings.push(finding);
  }
  for (const item of (gate.noted_for_followup || [])) {
    const fl = extractFileLine(item.summary);
    const finding = enrichFromReport(mkFinding({
      id: item.id,
      severity: item.severity,
      file: fl.file,
      line: fl.line,
      summary: item.summary,
      provenance: PROVENANCE.ASSERTED,
      source: "red-team (noted for follow-up)",
      sourceFile: gatePath,
    }), item.id);
    findings.push(finding);
  }
  return findings;
}

// --- stage-04b: security-review --------------------------------------------
// The gate itself carries no per-finding array (security_approved / veto /
// triggering_conditions only — see core/gates/schemas/stage-04b.schema.json).
// pipeline/security-review.md follows templates/review-template.md's plain
// REVIEW:/BLOCKER: grammar (no severity/file structure of its own), so a
// BLOCKER line becomes one finding, severity escalated to "critical" when
// the gate vetoed the pipeline.

function collectSecurityReviewFindings(pipelineDir) {
  const gatePath = path.join(pipelineDir, "gates", "stage-04b.json");
  const gate = readJSON(gatePath);
  if (!gate) return [];

  const reviewText = readText(path.join(pipelineDir, "security-review.md")) || "";
  const blockerLines = [...reviewText.matchAll(/^BLOCKER:\s*(.+)$/gm)].map((m) => m[1].trim());
  const severity = gate.veto === true ? "critical" : "high";

  if (blockerLines.length === 0) {
    if (gate.veto === true) {
      return [mkFinding({
        id: "SEC-VETO",
        severity: "critical",
        file: null,
        line: null,
        summary: "security review vetoed the pipeline (pipeline/security-review.md has no parseable BLOCKER: line)",
        provenance: PROVENANCE.ASSERTED,
        source: "security-review",
        sourceFile: gatePath,
      })];
    }
    return [];
  }

  return blockerLines.map((text, idx) => {
    const fl = extractFileLine(text);
    return mkFinding({
      id: `SEC-${idx + 1}`,
      severity,
      file: fl.file,
      line: fl.line,
      summary: text,
      provenance: PROVENANCE.ASSERTED,
      source: "security-review",
      sourceFile: path.join(pipelineDir, "security-review.md"),
    });
  });
}

// --- stage-05 / stage-05.critic: peer-review + critic ----------------------
// Base gate blockers are ordinarily model/hook-derived approval state
// (panel mode) or reviewer objections (adversarial mode) — model-asserted.
// The 31.5 exception: stampStage05Merged (core/verify/stamp.js) forces a
// blocker when a workstream claims APPROVED but the review file disagrees;
// those are recorded in _orchestrator_stamped.fields with field ===
// "approval_state" and are genuinely orchestrator-derived (re-parsed from
// the review file by the approval-derivation hook, not trusted from the
// gate). Matched here by workstream name rather than exact string
// reconstruction, so drift in the blocker's wording doesn't silently
// mis-attribute provenance.

function collectPeerReviewFindings(pipelineDir) {
  const findings = [];

  const gatePath = path.join(pipelineDir, "gates", "stage-05.json");
  const gate = readJSON(gatePath);
  if (gate) {
    const stampedFields = (gate._orchestrator_stamped && gate._orchestrator_stamped.fields) || [];
    const mismatchWorkstreams = new Set(
      stampedFields.filter((f) => f.field === "approval_state").map((f) => f.workstream),
    );
    (gate.blockers || []).forEach((text, idx) => {
      const m = /^peer-review approval mismatch: workstream "([^"]+)"/.exec(text);
      const isObserved = Boolean(m && mismatchWorkstreams.has(m[1]));
      const fl = extractFileLine(text);
      findings.push(mkFinding({
        id: `PR-${idx + 1}`,
        severity: "high",
        file: fl.file,
        line: fl.line,
        summary: text,
        provenance: isObserved ? PROVENANCE.OBSERVED : PROVENANCE.ASSERTED,
        source: "peer-review",
        sourceFile: gatePath,
      }));
    });
  }

  const criticPath = path.join(pipelineDir, "gates", "stage-05.critic.json");
  const critic = readJSON(criticPath);
  if (critic && Array.isArray(critic.challenges)) {
    critic.challenges
      .filter((c) => c.disposition !== "resolved")
      .forEach((c) => {
        findings.push(mkFinding({
          id: `CRIT-${c.id}`,
          severity: c.evidence_missing ? "high" : "medium",
          file: c.file || null,
          line: c.line != null ? c.line : null,
          summary: c.claim || "(unresolved challenge with no claim text)",
          provenance: PROVENANCE.ASSERTED,
          source: "critic",
          sourceFile: criticPath,
        }));
      });
  }

  return findings;
}

// --- stage-06: 31.4 mutation smoke gate -------------------------------------
// Entirely orchestrator-run when present (runMutationGate actually executed
// the mutation tool) — always orchestrator-observed.

function collectMutationFindings(pipelineDir) {
  const gatePath = path.join(pipelineDir, "gates", "stage-06.json");
  const gate = readJSON(gatePath);
  if (!gate) return [];

  const findings = [];
  (gate.blockers || []).forEach((text, idx) => {
    if (!/^mutation score below hard threshold:/.test(text)) return;
    findings.push(mkFinding({
      id: `MUT-BLOCK-${idx + 1}`,
      severity: "critical",
      file: null,
      line: null,
      summary: text,
      provenance: PROVENANCE.OBSERVED,
      source: "mutation",
      sourceFile: gatePath,
    }));
  });
  (gate.noted_for_followup || []).forEach((item) => {
    if (typeof item.id !== "string" || !item.id.startsWith("MUT-")) return;
    findings.push(mkFinding({
      id: item.id,
      severity: item.severity,
      file: null,
      line: null,
      summary: item.text || item.summary,
      provenance: PROVENANCE.OBSERVED,
      source: "mutation",
      sourceFile: gatePath,
    }));
  });
  return findings;
}

// --- stage-06d: verification-beyond-tests -----------------------------------
// A method's findings are orchestrator-observed only when the orchestrator
// itself produced real executable evidence for that method — i.e. it's in
// methods_attempted[] as a bare tag (not "attempted_but_blocked:*") AND
// _orchestrator_stamped.fields recorded a non-downgrade entry for it (see
// stampStage06d in core/verify/stamp.js). Otherwise the finding is the
// verifier's unconfirmed claim.

function collectVerificationBeyondTestsFindings(pipelineDir) {
  const gatePath = path.join(pipelineDir, "gates", "stage-06d.json");
  const gate = readJSON(gatePath);
  if (!gate) return [];

  const stampedFields = (gate._orchestrator_stamped && gate._orchestrator_stamped.fields) || [];
  const STAMP_FIELD_TO_METHOD = { property_based: "property", mutation: "mutation", formal: "formal" };
  const confirmedMethods = new Set(
    stampedFields
      .filter((f) => STAMP_FIELD_TO_METHOD[f.field] &&
        !(typeof f.orchestrator === "string" && f.orchestrator.startsWith("attempted_but_blocked")))
      .map((f) => STAMP_FIELD_TO_METHOD[f.field]),
  );

  const findings = [];
  function addFrom(arr, defaultSeverity, blocking) {
    (arr || []).forEach((item, idx) => {
      const method = item.method || "unknown";
      const isObserved = confirmedMethods.has(method);
      const summary = item.summary + (item.counterexample ? ` — counterexample: ${item.counterexample}` : "");
      findings.push(mkFinding({
        id: `VBT-${method}-${idx + 1}`,
        severity: item.severity || defaultSeverity,
        file: item.file || null,
        line: item.line != null ? item.line : null,
        summary,
        provenance: isObserved ? PROVENANCE.OBSERVED : PROVENANCE.ASSERTED,
        source: `verification-beyond-tests (${method}${blocking ? "" : ", non-blocking"})`,
        sourceFile: gatePath,
      }));
    });
  }
  addFrom(gate.blocking_findings, "high", true);
  addFrom(gate.non_blocking_findings, "low", false);
  return findings;
}

// --- docs/audit/*.md ---------------------------------------------------------
// Only scanned "when the audit workflow has run" (plan wording): gated on
// docs/audit/status.json existing (written by skills/audit/SKILL.md step
// 0.0). Entirely model-authored narrative — even a "Verified by: ran npm
// audit" line is the model's self-report of what it did, not orchestrator-
// executed verification — so every audit finding is model-asserted.

function collectAuditFindings(cwd) {
  const auditDir = path.join(cwd, "docs", "audit");
  const statusPath = path.join(auditDir, "status.json");
  if (!fs.existsSync(statusPath)) return [];

  let files;
  try {
    files = fs.readdirSync(auditDir).filter((f) => f.endsWith(".md") && f !== "README.md");
  } catch {
    return [];
  }

  const findings = [];
  for (const file of files.sort()) {
    const abs = path.join(auditDir, file);
    const text = readText(abs);
    if (!text) continue;
    const blocks = parseMarkdownFindingBlocks(text);
    for (const [id, block] of blocks) {
      const fl = extractFileLine(block.fields.where || "");
      findings.push(mkFinding({
        id,
        severity: block.fields.severity,
        file: fl.file,
        line: fl.line,
        summary: block.title || id,
        mitigation: block.fields.suggestedFix || null,
        effort: block.fields.effort || null,
        provenance: PROVENANCE.ASSERTED,
        source: `audit:${file.replace(/\.md$/, "")}`,
        sourceFile: abs,
      }));
    }
  }
  return findings;
}

// --- Main entry point ---------------------------------------------------------

function collectFindings(cwd, opts = {}) {
  const { pipelineRoot } = require("../paths");

  // Resolve changeId (bounded isolation) the same way core/report/collect.js
  // does — kept as a small, deliberate duplication rather than a shared
  // helper for two call sites (see collect.js's identical block).
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

  const sources = [
    {
      source: "red-team",
      present: fs.existsSync(path.join(pipelineDir, "gates", "stage-04c.json")),
      collect: () => collectRedTeamFindings(pipelineDir),
    },
    {
      source: "security-review",
      present: fs.existsSync(path.join(pipelineDir, "gates", "stage-04b.json")),
      collect: () => collectSecurityReviewFindings(pipelineDir),
    },
    {
      source: "peer-review",
      present: fs.existsSync(path.join(pipelineDir, "gates", "stage-05.json")) ||
        fs.existsSync(path.join(pipelineDir, "gates", "stage-05.critic.json")),
      collect: () => collectPeerReviewFindings(pipelineDir),
    },
    {
      source: "mutation",
      present: fs.existsSync(path.join(pipelineDir, "gates", "stage-06.json")),
      collect: () => collectMutationFindings(pipelineDir),
    },
    {
      source: "verification-beyond-tests",
      present: fs.existsSync(path.join(pipelineDir, "gates", "stage-06d.json")),
      collect: () => collectVerificationBeyondTestsFindings(pipelineDir),
    },
    {
      source: "audit",
      present: fs.existsSync(path.join(cwd, "docs", "audit", "status.json")),
      collect: () => collectAuditFindings(cwd),
    },
  ];

  let findings = [];
  const sourcesScanned = [];
  for (const s of sources) {
    sourcesScanned.push({ source: s.source, present: s.present });
    if (!s.present) continue;
    findings = findings.concat(s.collect());
  }

  findings.sort((a, b) => {
    const bySeverity = SEVERITY_RANK[a.severity] - SEVERITY_RANK[b.severity];
    if (bySeverity !== 0) return bySeverity;
    const aObserved = a.provenance === PROVENANCE.OBSERVED ? 0 : 1;
    const bObserved = b.provenance === PROVENANCE.OBSERVED ? 0 : 1;
    if (aObserved !== bObserved) return aObserved - bObserved;
    if (a.source !== b.source) return a.source < b.source ? -1 : 1;
    return String(a.id) < String(b.id) ? -1 : 1;
  });

  const bySeverity = { critical: 0, high: 0, medium: 0, low: 0, unknown: 0 };
  const byProvenance = { [PROVENANCE.OBSERVED]: 0, [PROVENANCE.ASSERTED]: 0 };
  for (const f of findings) {
    bySeverity[f.severity] += 1;
    byProvenance[f.provenance] += 1;
  }

  return {
    meta: {
      generatedAt: new Date().toISOString(),
      sourcesScanned,
    },
    counts: {
      total: findings.length,
      bySeverity,
      byProvenance,
    },
    findings,
  };
}

module.exports = {
  collectFindings,
  PROVENANCE,
  SEVERITY_RANK,
  extractFileLine,
  normalizeSeverity,
};
