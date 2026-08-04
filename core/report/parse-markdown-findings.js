"use strict";

// parse-markdown-findings.js — generic parser for the "one heading per
// finding, bullet fields underneath" shape shared (with drift — see below)
// by pipeline/red-team-report.md (templates/red-team-report-template.md,
// "### RT-1 — <title>") and docs/audit/*.md (templates/audit/*-template.md,
// "#### Finding S1: <title>"). Phase 35 item 35.4: collect-findings.js uses
// this to enrich gate-derived findings with prose-only detail (suggested
// fix, effort, file:line) and to read findings that have no gate/JSON
// equivalent at all (docs/audit/*.md).
//
// Deliberately tolerant: real model output drifts from its own template
// (compare templates/audit/06-security-template.md's "#### Finding S1:
// <title>" against docs/audit/06-security.md's actual "### S-1 — <title>").
// A block whose heading doesn't match FINDING_HEADING_RE is silently
// skipped rather than erroring — this is best-effort prose enrichment, not
// a source of truth (that's the gate JSON), so a missed block just means
// less-rich output, never a crash.

const FINDING_HEADING_RE = /^#{3,4}\s+(?:Finding\s+)?([A-Za-z]+-?\d+)\s*(?:[:\-–—]+)\s*(.+)$/;
const ANY_HEADING_RE = /^#{1,6}\s+\S/;
const BULLET_RE = /^-\s+\*\*([^*]+?):\*\*\s*(.*)$/;
const CONTINUATION_STOP_RE = /^[-*]\s/;

// Bullet field name (lowercased) -> normalized key. Both templates and
// real output use slightly different names for the same concept (e.g.
// "Where" vs "Locations"; "Suggested fix" vs "Suggested mitigation").
const FIELD_ALIASES = {
  severity: "severity",
  confidence: "confidence",
  where: "where",
  location: "where",
  locations: "where",
  issue: "issue",
  "suggested fix": "suggestedFix",
  "suggested mitigation": "suggestedFix",
  effort: "effort",
  "effort to fix": "effort",
  "verified by": "verifiedBy",
  surface: "surface",
  likelihood: "likelihood",
  summary: "summary",
};

function normalizeFieldName(raw) {
  return FIELD_ALIASES[raw.trim().toLowerCase()] || null;
}

// Returns a Map<id, { title, fields }> — one entry per recognized finding
// heading in `text`. `fields` keys are the normalized names above; values
// are trimmed strings (continuation lines of a wrapped bullet are folded
// into the same field, space-joined).
function parseMarkdownFindingBlocks(text) {
  const blocks = new Map();
  if (!text) return blocks;

  const lines = text.split(/\r?\n/);
  let i = 0;
  while (i < lines.length) {
    const heading = FINDING_HEADING_RE.exec(lines[i]);
    if (!heading) { i++; continue; }

    const id = heading[1];
    const title = heading[2].trim();
    i++;

    const fields = {};
    let currentField = null;
    while (i < lines.length && !ANY_HEADING_RE.test(lines[i])) {
      const line = lines[i];
      const bullet = BULLET_RE.exec(line);
      if (bullet) {
        const fieldName = normalizeFieldName(bullet[1]);
        currentField = fieldName;
        if (fieldName) fields[fieldName] = (bullet[2] || "").trim();
      } else if (line.trim() === "" || CONTINUATION_STOP_RE.test(line)) {
        currentField = null;
      } else if (currentField) {
        fields[currentField] = `${fields[currentField]} ${line.trim()}`.trim();
      }
      i++;
    }
    blocks.set(id, { title, fields });
  }
  return blocks;
}

module.exports = { parseMarkdownFindingBlocks };
