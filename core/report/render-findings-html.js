"use strict";

// render-findings-html.js — Phase 35 item 35.4. Renders a FindingsReportData
// object (core/report/collect-findings.js) as a self-contained HTML page:
// one ranked table, severity-ordered, with an honest empty state when
// nothing was found. Visual language deliberately mirrors ./render-html.js
// (badge shapes, muted section labels, same font stack) without importing
// it — the two renderers evolve independently, see collect-findings.js's
// header comment on why the pipeline-dir resolution is duplicated rather
// than shared.

function esc(str) {
  return String(str ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

const SEVERITY_CLASS = { critical: "fail", high: "fail", medium: "warn", low: "neutral", unknown: "neutral" };

function severityBadge(sev) {
  const cls = SEVERITY_CLASS[sev] || "neutral";
  return `<span class="badge ${cls}">${esc(String(sev || "unknown").toUpperCase())}</span>`;
}

function provenanceBadge(p) {
  const isObserved = p === "orchestrator-observed";
  return `<span class="badge ${isObserved ? "observed" : "asserted"}">${isObserved ? "orchestrator-observed" : "model-asserted"}</span>`;
}

const CSS = `
  *, *::before, *::after { box-sizing: border-box; }
  body {
    font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif;
    font-size: 14px; line-height: 1.6; color: #111827;
    background: #f9fafb; margin: 0; padding: 0;
  }
  .page { max-width: 1100px; margin: 0 auto; padding: 1.75rem 1.5rem 4rem; }
  h1 { font-size: 1.4rem; font-weight: 700; margin: 0 0 0.4rem; }
  .report-header { margin-bottom: 1.5rem; }
  .header-meta { color: #374151; font-size: 0.85rem; margin-bottom: 0.5rem; }
  .src-row { display: flex; gap: 6px; flex-wrap: wrap; }
  .src-chip {
    font-size: 0.7rem; padding: 2px 8px; border-radius: 999px;
    border: 1px solid #e5e7eb; color: #6b7280; background: #fff;
  }
  .src-chip.present { color: #1e40af; border-color: #bfdbfe; background: #eff6ff; }
  .src-chip.absent { color: #9ca3af; font-style: italic; }

  .badge {
    display: inline-block; font-size: 0.7rem; font-weight: 600;
    padding: 2px 8px; border-radius: 999px; letter-spacing: 0.04em; white-space: nowrap;
  }
  .fail     { background: #fee2e2; color: #7f1d1d; }
  .warn     { background: #fef3c7; color: #78350f; }
  .neutral  { background: #f3f4f6; color: #6b7280; }
  .observed { background: #d1fae5; color: #065f46; }
  .asserted { background: #ede9fe; color: #4c1d95; }

  table { width: 100%; border-collapse: collapse; font-size: 0.83rem; }
  thead th {
    text-align: left; padding: 6px 10px; background: #f3f4f6;
    border-bottom: 2px solid #e5e7eb; font-weight: 600; color: #374151;
  }
  tbody tr:nth-child(even) { background: #f9fafb; }
  tbody td { padding: 6px 10px; border-bottom: 1px solid #f3f4f6; vertical-align: top; }
  .mono { font-family: ui-monospace, SFMono-Regular, Menlo, monospace; font-size: 0.78rem; white-space: nowrap; }

  .empty-state {
    background: #fff; border: 1px dashed #d1d5db; border-radius: 8px;
    padding: 2.5rem 1.5rem; text-align: center; color: #374151;
  }
  .empty-sub { color: #6b7280; font-size: 0.85rem; margin-top: 0.4rem; }

  footer { margin-top: 3rem; padding-top: 1rem; border-top: 1px solid #e5e7eb; color: #9ca3af; font-size: 0.75rem; }
`;

function renderFindingsHtml(data) {
  const { meta, counts, findings } = data;

  const scannedList = meta.sourcesScanned
    .map((s) => `<span class="src-chip ${s.present ? "present" : "absent"}">${esc(s.source)}${s.present ? "" : " (absent)"}</span>`)
    .join("");

  let body;
  if (!findings || findings.length === 0) {
    body = `<div class="empty-state">
      <p><strong>No findings were detected.</strong></p>
      <p class="empty-sub">Either the review stages listed below haven't run yet, or they genuinely found
      nothing to flag — an honest empty result, not a broken report. See the source chips above for what
      was actually scanned.</p>
    </div>`;
  } else {
    const rows = findings.map((f) => `
      <tr>
        <td>${severityBadge(f.severity)}</td>
        <td class="mono">${esc(f.id || "—")}</td>
        <td class="mono">${f.file ? esc(f.line != null ? `${f.file}:${f.line}` : f.file) : "—"}</td>
        <td>${esc(f.summary)}</td>
        <td>${f.mitigation ? esc(f.mitigation) : "—"}</td>
        <td>${f.effort ? esc(f.effort) : "—"}</td>
        <td>${provenanceBadge(f.provenance)}</td>
        <td>${esc(f.source)}</td>
      </tr>`).join("");
    body = `
      <table>
        <thead><tr>
          <th>Severity</th><th>ID</th><th>File:Line</th><th>What's wrong</th>
          <th>Suggested mitigation</th><th>Effort</th><th>Provenance</th><th>Source</th>
        </tr></thead>
        <tbody>${rows}</tbody>
      </table>`;
  }

  const now = new Date().toLocaleString(undefined, {
    year: "numeric", month: "short", day: "numeric", hour: "2-digit", minute: "2-digit",
  });

  const observedCount = counts.byProvenance["orchestrator-observed"] || 0;
  const assertedCount = counts.byProvenance["model-asserted"] || 0;

  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>Stagecraft Findings Report</title>
  <style>${CSS}</style>
</head>
<body>
<div class="page">

  <div class="report-header">
    <h1>Findings Report</h1>
    <div class="header-meta">
      ${counts.total} finding${counts.total === 1 ? "" : "s"} &nbsp;·&nbsp;
      ${counts.bySeverity.critical} critical, ${counts.bySeverity.high} high,
      ${counts.bySeverity.medium} medium, ${counts.bySeverity.low} low
      &nbsp;·&nbsp; ${observedCount} orchestrator-observed, ${assertedCount} model-asserted
    </div>
    <div class="src-row">${scannedList}</div>
  </div>

  ${body}

  <footer>Generated ${esc(now)}</footer>

</div>
</body>
</html>`;
}

module.exports = { renderFindingsHtml };
