"use strict";

// render-html.js — take a ReportData object and return a self-contained
// HTML string. No external dependencies, no CDN, works offline.

// ── Utility helpers ──────────────────────────────────────────────────────────

function esc(str) {
  return String(str ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function badge(status) {
  const map = {
    PASS:     ["pass",     "PASS"],
    WARN:     ["warn",     "WARN"],
    FAIL:     ["fail",     "FAIL"],
    ESCALATE: ["escalate", "ESCALATE"],
  };
  const [cls, text] = map[status] || ["neutral", esc(status || "—")];
  return `<span class="badge ${cls}">${text}</span>`;
}

// Stage ID → document kinds produced by that stage (for linking in pipeline tab).
const STAGE_DOCS = {
  "stage-01":  ["brief"],
  "stage-02":  ["design", "build-plan"],
  "stage-03b": ["spec"],
  "stage-04":  ["review"],
  "stage-04a": ["pre-review"],
  "stage-04b": ["security"],
  "stage-04c": ["red-team"],
  "stage-05":  ["review"],
  "stage-06":  ["test-report"],
  "stage-06b": ["accessibility"],
  "stage-06c": ["observability"],
};

function finalStatusBadge(status, haltType) {
  const map = {
    completed:  ["pass",    "COMPLETED"],
    halted:     ["fail",    "HALTED"],
    incomplete: ["neutral", "INCOMPLETE"],
    "no-run":   ["neutral", "NO RUN DATA"],
  };
  const [cls, text] = map[status] || ["neutral", esc(status)];
  let suffix = "";
  if (status === "halted" && haltType) {
    const typeLabel = ({
      "convergence-halt": "convergence",
      "ceiling-halt": "iteration ceiling",
      "quota-halt": "quota exceeded",
    })[haltType] || haltType.replace(/-halt$/, "");
    suffix = ` <span class="halt-type">${esc(typeLabel)}</span>`;
  } else if (status === "incomplete") {
    suffix = ` <span class="halt-type">waiting for advance</span>`;
  }
  return `<span class="badge large ${cls}">${text}</span>${suffix}`;
}

function formatDate(isoStr) {
  if (!isoStr) return "—";
  try {
    return new Date(isoStr).toLocaleString(undefined, {
      year: "numeric", month: "short", day: "numeric",
      hour: "2-digit", minute: "2-digit",
    });
  } catch { return isoStr; }
}

function formatDuration(ms) {
  if (ms == null) return "—";
  const s = Math.round(ms / 1000);
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60), rem = s % 60;
  return rem === 0 ? `${m}m` : `${m}m ${rem}s`;
}

function formatCost(usd) {
  if (usd == null) return null;
  return `$${Number(usd).toFixed(3)}`;
}

// ── Markdown → HTML ──────────────────────────────────────────────────────────

// Apply inline markdown formatting. Escapes HTML first (so * [ ] ` survive),
// then substitutes bold, italic, code, and links.
function inlineMd(raw) {
  let s = esc(String(raw ?? ""));
  s = s.replace(/`([^`]+)`/g, (_, c) => `<code>${c}</code>`);
  s = s.replace(/\*\*\*(.+?)\*\*\*/g, (_, c) => `<strong><em>${c}</em></strong>`);
  s = s.replace(/\*\*(.+?)\*\*/g, (_, c) => `<strong>${c}</strong>`);
  s = s.replace(/\*([^*\n]+)\*/g, (_, c) => `<em>${c}</em>`);
  s = s.replace(/\[([^\]]+)\]\(([^)]+)\)/g, (_, t, u) => `<a href="${u}">${t}</a>`);
  return s;
}

// Convert a markdown string to HTML. Handles: fenced code blocks, ATX
// headings (h1–h4), HR, blockquotes, tables, bullet/ordered lists,
// and paragraphs. Returns an HTML-safe string.
function mdToHtml(text) {
  if (!text) return "";
  const lines = text.split(/\r?\n/);
  const out = [];
  let i = 0;
  let listType = null;
  let listItems = [];
  let paraLines = [];

  const flushPara = () => {
    if (paraLines.length) { out.push(`<p>${paraLines.join("<br>")}</p>`); paraLines = []; }
  };
  const flushList = () => {
    if (listType && listItems.length) {
      out.push(`<${listType}>${listItems.map(li => `<li>${li}</li>`).join("")}</${listType}>`);
      listType = null; listItems = [];
    }
  };
  const flush = () => { flushPara(); flushList(); };

  while (i < lines.length) {
    const line = lines[i];

    // Fenced code block
    if (/^\s*```/.test(line)) {
      flush(); i++;
      const code = [];
      while (i < lines.length && !/^\s*```/.test(lines[i])) { code.push(lines[i]); i++; }
      out.push(`<pre><code>${esc(code.join("\n"))}</code></pre>`);
      i++; continue;
    }

    // ATX heading
    const hm = line.match(/^(#{1,4})\s+(.*)/);
    if (hm) {
      flush();
      const lv = hm[1].length;
      out.push(`<h${lv}>${inlineMd(hm[2])}</h${lv}>`);
      i++; continue;
    }

    // Horizontal rule
    if (/^(\*{3,}|-{3,}|_{3,})\s*$/.test(line.trim())) {
      flush(); out.push("<hr>"); i++; continue;
    }

    // Blockquote
    if (line.startsWith(">")) {
      flush();
      const bq = [];
      while (i < lines.length && lines[i].startsWith(">")) {
        bq.push(lines[i].replace(/^>\s?/, "")); i++;
      }
      out.push(`<blockquote>${mdToHtml(bq.join("\n"))}</blockquote>`);
      continue;
    }

    // Table (pipe-delimited)
    if (/^\|/.test(line.trim()) && line.includes("|")) {
      flush();
      const trows = [];
      while (i < lines.length && /^\|/.test(lines[i].trim())) { trows.push(lines[i]); i++; }
      const cells = r => r.trim().replace(/^\||\|$/g, "").split("|").map(c => c.trim());
      if (trows.length >= 2) {
        const heads = cells(trows[0]);
        const body = trows.slice(2).filter(r => !/^[\s|:=-]+$/.test(r.replace(/\|/g, "")));
        out.push(`<table><thead><tr>${heads.map(h => `<th>${inlineMd(h)}</th>`).join("")}</tr></thead>`);
        if (body.length) out.push(`<tbody>${body.map(r => `<tr>${cells(r).map(c => `<td>${inlineMd(c)}</td>`).join("")}</tr>`).join("")}</tbody>`);
        out.push("</table>");
      }
      continue;
    }

    // Unordered list item
    const ulm = line.match(/^(\s{0,3})[-*+]\s+(.*)/);
    if (ulm) {
      flushPara();
      if (listType !== "ul") { flushList(); listType = "ul"; }
      listItems.push(inlineMd(ulm[2])); i++; continue;
    }

    // Ordered list item
    const olm = line.match(/^(\s{0,3})\d+[.)]\s+(.*)/);
    if (olm) {
      flushPara();
      if (listType !== "ol") { flushList(); listType = "ol"; }
      listItems.push(inlineMd(olm[2])); i++; continue;
    }

    // Blank line
    if (line.trim() === "") { flush(); i++; continue; }

    // Paragraph text
    flushList();
    paraLines.push(inlineMd(line));
    i++;
  }

  flush();
  return out.join("\n");
}

// ── Stage progress bar ───────────────────────────────────────────────────────

const STAGE_SHORT = {
  "stage-01":  "brief",
  "stage-02":  "design",
  "stage-03":  "clarity",
  "stage-03b": "spec",
  "stage-04":  "build",
  "stage-04a": "pre-rev",
  "stage-04b": "sec-rev",
  "stage-04c": "red-team",
  "stage-04e": "preflight",
  "stage-05":  "review",
  "stage-06":  "qa",
  "stage-06b": "a11y",
  "stage-06c": "obs-gate",
  "stage-07":  "deploy",
  "stage-08":  "post-dep",
};

function renderProgressBar(stages) {
  if (!stages || stages.length === 0) return "";
  const parts = [];
  for (let idx = 0; idx < stages.length; idx++) {
    const s = stages[idx];
    if (idx > 0) parts.push('<span class="stage-sep">›</span>');
    const cls = s.status ? s.status.toLowerCase() : "not-run";
    const short = STAGE_SHORT[s.stage] || s.name;
    const tooltip = `${s.name} (${s.stage})${s.status ? ` · ${s.status}` : " · not run"}`;
    const attr = s.status ? `data-stage="${esc(s.stage)}"` : "";
    parts.push(`<div class="stage-pip ${esc(cls)}" ${attr} title="${esc(tooltip)}">${esc(short)}</div>`);
  }
  return `<div class="progress-bar">${parts.join("")}</div>`;
}

// ── Tab: Summary ─────────────────────────────────────────────────────────────

function renderSummaryTab(data) {
  const { meta, brief, stages } = data;

  const haltHtml = meta.haltReason
    ? `<div class="halt-box"><span class="halt-label">Halt:</span> ${esc(meta.haltReason)}</div>`
    : "";

  const stoppedAt = (meta.finalStatus === "incomplete" && meta.currentStage)
    ? `<div class="abandoned-at">Stopped at: <code>${esc(meta.currentStage)}</code></div>`
    : "";

  const progressBar = renderProgressBar(stages);

  const statParts = [];
  if (brief.acCount != null)
    statParts.push(`<div class="stat-chip clickable" data-goto-doc-kind="brief" title="View acceptance criteria in brief.md"><span class="chip-num">${esc(String(brief.acCount))}</span><span class="chip-lbl">ACs</span></div>`);
  if (brief.specScenarios != null)
    statParts.push(`<div class="stat-chip clickable" data-goto-doc-kind="spec" title="View scenarios in spec.feature"><span class="chip-num">${esc(String(brief.specScenarios))}</span><span class="chip-lbl">scenarios</span></div>`);
  if (brief.acCount != null || brief.specScenarios != null) {
    const driftVal = brief.specDrift
      ? `<span class="drift-warn">detected</span>`
      : `<span class="no-drift">none</span>`;
    statParts.push(`<div class="stat-chip"><span class="chip-lbl">drift</span> ${driftVal}</div>`);
  }
  const statsRow = statParts.length
    ? `<div class="stat-row">${statParts.join("")}</div>` : "";

  const problemHtml = brief.problemStatement
    ? `<p class="problem">${inlineMd(brief.problemStatement)}</p>` : "";

  const rolesHtml = brief.activeRoles && brief.activeRoles.length > 0
    ? `<div class="meta-line">
        <span class="meta-label">Active roles:</span>
        ${brief.activeRoles.map(r => `<span class="role-badge">${esc(r)}</span>`).join("")}
       </div>` : "";

  const oosHtml = brief.outOfScope && brief.outOfScope.length > 0
    ? `<div class="oos-section">
        <span class="meta-label">Out of scope:</span>
        <ul class="oos-list">${brief.outOfScope.map(i => `<li>${esc(i)}</li>`).join("")}</ul>
       </div>` : "";

  const briefSection = (statsRow || problemHtml || rolesHtml || oosHtml)
    ? `<div class="summary-section">
        <div class="section-label">Brief</div>
        ${statsRow}${problemHtml}${rolesHtml}${oosHtml}
       </div>`
    : "";

  return `
    ${haltHtml}
    ${stoppedAt}
    ${progressBar ? `<div class="summary-section">${progressBar}</div>` : ""}
    ${briefSection}`;
}

// ── Tab: Pipeline (formerly Stages) ─────────────────────────────────────────

function renderStagesTab(stages, blockerLog, documents, logStats) {
  let tableHtml;
  if (!stages || stages.length === 0) {
    tableHtml = '<p class="no-data">No stage gate files found.</p>';
  } else {
    // Build kind → first document index map for stage doc links.
    const docKindIdx = {};
    if (documents && documents.length > 0) {
      documents.forEach((doc, idx) => {
        if (!(doc.kind in docKindIdx)) docKindIdx[doc.kind] = idx;
      });
    }

    const hasGateDuration = stages.some(s =>
      s.durationMs != null || s.workstreams.some(w => w.durationMs != null));
    const hasLogDuration = logStats && Object.values(logStats.stages).some(s => s.computeMs > 0);
    const hasDuration = hasGateDuration || hasLogDuration;

    const rows = stages.map(s => {
      const statusCell = s.status ? badge(s.status) : '<span class="badge neutral">—</span>';
      const when = s.timestamp ? formatDate(s.timestamp) : "—";

      // Duration: prefer gate file duration, fall back to log compute time.
      let durHtml = "—";
      if (s.durationMs != null) {
        durHtml = esc(formatDuration(s.durationMs));
      } else if (s.workstreams.length > 0 && s.workstreams[0].durationMs != null) {
        durHtml = esc(formatDuration(s.workstreams.reduce((sum, w) => sum + (w.durationMs || 0), 0)));
      } else if (logStats && logStats.stages[s.stage] && logStats.stages[s.stage].computeMs > 0) {
        const ls = logStats.stages[s.stage];
        durHtml = esc(formatDuration(ls.computeMs));
        if (ls.attempts > 1) durHtml += ` <span class="dispatch-count">${ls.attempts} dispatches</span>`;
      }

      // Stage document links for the details cell.
      const stageDocs = STAGE_DOCS[s.stage] || [];
      const docLinks = stageDocs
        .map(kind => {
          if (kind in docKindIdx) {
            const idx = docKindIdx[kind];
            const label = documents[idx].label;
            return `<span class="stage-doc-link" data-goto-doc-idx="${idx}" title="Open ${esc(label)}">${esc(label)}</span>`;
          }
          return null;
        })
        .filter(Boolean);
      const docLinksHtml = docLinks.length
        ? `<div class="stage-doc-links">${docLinks.join("")}</div>` : "";

      let details = docLinksHtml;

      if (s.workstreams.length > 0) {
        const wsRows = s.workstreams.map(w => `
          <tr>
            <td>${esc(w.role)}</td>
            <td>${w.status ? badge(w.status) : "—"}</td>
            <td>${w.host ? esc(w.host) : "—"}</td>
            <td>${w.durationMs != null ? formatDuration(w.durationMs) : "—"}</td>
          </tr>`).join("");
        details += `
          <details>
            <summary>${s.workstreams.length} workstream${s.workstreams.length !== 1 ? "s" : ""}</summary>
            <table class="ws-table"><thead><tr><th>Role</th><th>Status</th><th>Host</th><th>Duration</th></tr></thead>
            <tbody>${wsRows}</tbody></table>
          </details>`;
      }

      const seenB = new Set();
      const allBlockers = [...(s.blockers || []), ...s.workstreams.flatMap(w => w.blockers || [])]
        .filter(b => { const k = String(b); return seenB.has(k) ? false : seenB.add(k); });
      const seenW = new Set();
      const allWarnings = [...(s.warnings || []), ...s.workstreams.flatMap(w => w.warnings || [])]
        .filter(w => { const k = String(w); return seenW.has(k) ? false : seenW.add(k); });

      if (allBlockers.length > 0)
        details += `<details><summary>${allBlockers.length} blocker${allBlockers.length !== 1 ? "s" : ""}</summary>
          <ul class="blockers-list">${allBlockers.map(b => `<li>${esc(b)}</li>`).join("")}</ul></details>`;

      if (allWarnings.length > 0)
        details += `<details><summary>${allWarnings.length} warning${allWarnings.length !== 1 ? "s" : ""}</summary>
          <ul class="warnings-list">${allWarnings.map(w => `<li>${esc(w)}</li>`).join("")}</ul></details>`;

      return `
        <tr id="sr-${esc(s.stage)}">
          <td class="stage-name">${esc(s.name)}<br><span class="stage-id">${esc(s.stage)}</span></td>
          <td>${statusCell}</td>
          <td style="white-space:nowrap">${esc(when)}</td>
          ${hasDuration ? `<td style="white-space:nowrap" class="dur-cell">${durHtml}</td>` : ""}
          <td>${details}</td>
        </tr>`;
    });

    tableHtml = `
      <table>
        <thead><tr><th>Stage</th><th>Status</th><th>Completed</th>${hasDuration ? "<th>Duration</th>" : ""}<th>Details</th></tr></thead>
        <tbody>${rows.join("")}</tbody>
      </table>`;
  }

  const blockersSection = blockerLog
    ? `<div style="margin-top:2rem">
        <h2>Blockers &amp; Escalations</h2>
        <details open><summary>Re-dispatch blockers (from context.md)</summary>
        <pre class="blocker-pre">${esc(blockerLog)}</pre></details>
       </div>` : "";

  return tableHtml + blockersSection;
}

// ── Tab: Documents ───────────────────────────────────────────────────────────

function renderDocumentsTab(documents) {
  if (!documents || documents.length === 0) {
    return '<p class="no-data">No pipeline documents found.</p>';
  }

  const navItems = documents.map((doc, idx) =>
    `<div class="doc-nav-item${idx === 0 ? " active" : ""}" data-doc="${idx}" data-doc-kind="${esc(doc.kind)}" title="${esc(doc.label)}">${esc(doc.label)}</div>`
  ).join("");

  const panes = documents.map((doc, idx) => {
    const body = (doc.kind === "spec")
      ? `<pre class="doc-pre">${esc(doc.content)}</pre>`
      : `<div class="doc-body">${mdToHtml(doc.content)}</div>`;
    return `<div class="doc-pane${idx === 0 ? "" : " hidden"}" id="doc-${idx}">${body}</div>`;
  }).join("");

  return `
    <div class="doc-layout">
      <nav class="doc-nav">${navItems}</nav>
      <div class="doc-viewer">${panes}</div>
    </div>`;
}

// ── CSS ──────────────────────────────────────────────────────────────────────

const CSS = `
  *, *::before, *::after { box-sizing: border-box; }
  body {
    font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif;
    font-size: 14px; line-height: 1.6; color: #111827;
    background: #f9fafb; margin: 0; padding: 0;
  }
  .page { max-width: 980px; margin: 0 auto; padding: 1.75rem 1.5rem 4rem; }
  h1 { font-size: 1.4rem; font-weight: 700; margin: 0; }
  h2 {
    font-size: 0.72rem; font-weight: 600; text-transform: uppercase;
    letter-spacing: 0.08em; color: #6b7280; margin: 0 0 0.75rem;
    padding-bottom: 0.4rem; border-bottom: 1px solid #e5e7eb;
  }

  /* Header */
  .report-header { margin-bottom: 1.5rem; }
  .report-title { display: flex; align-items: baseline; gap: 0.75rem; flex-wrap: wrap; margin-bottom: 0.4rem; }
  .header-meta {
    color: #6b7280; font-size: 0.82rem;
    display: flex; gap: 1.25rem; flex-wrap: wrap;
  }

  /* Badges */
  .badge {
    display: inline-block; font-size: 0.7rem; font-weight: 600;
    padding: 2px 8px; border-radius: 999px;
    letter-spacing: 0.04em; white-space: nowrap;
  }
  .badge.large { font-size: 0.82rem; padding: 4px 12px; }
  .pass     { background: #d1fae5; color: #065f46; }
  .warn     { background: #fef3c7; color: #78350f; }
  .fail     { background: #fee2e2; color: #7f1d1d; }
  .escalate { background: #ede9fe; color: #4c1d95; }
  .neutral  { background: #f3f4f6; color: #6b7280; }
  .role-badge {
    display: inline-block; font-size: 0.7rem; background: #dbeafe; color: #1e40af;
    padding: 1px 7px; border-radius: 999px; margin-right: 4px;
  }

  /* Tabs */
  .tab-bar {
    display: flex; border-bottom: 2px solid #e5e7eb; margin-bottom: 1.5rem;
  }
  .tab-btn {
    background: none; border: none; border-bottom: 2px solid transparent;
    margin-bottom: -2px; padding: 0.55rem 1.1rem;
    font-size: 0.85rem; font-weight: 500; color: #6b7280;
    cursor: pointer; transition: color 0.12s, border-color 0.12s;
    display: flex; align-items: center; gap: 5px;
  }
  .tab-btn:hover { color: #111827; }
  .tab-btn.active { color: #2563eb; border-bottom-color: #2563eb; }
  .tab-count {
    background: #e5e7eb; color: #374151; font-size: 0.68rem;
    padding: 1px 5px; border-radius: 999px; font-weight: 600;
  }
  .hidden { display: none !important; }

  /* Stage progress bar */
  .progress-bar {
    display: flex; align-items: center; gap: 2px;
    flex-wrap: wrap; margin: 0.75rem 0 1.25rem;
  }
  .stage-pip {
    padding: 3px 9px; border-radius: 4px; font-size: 0.68rem;
    font-weight: 600; letter-spacing: 0.03em;
    white-space: nowrap; cursor: pointer; user-select: none;
    transition: opacity 0.12s;
  }
  .stage-pip:hover { opacity: 0.72; }
  .stage-pip.not-run {
    background: #f3f4f6; color: #9ca3af;
    border: 1px dashed #d1d5db; cursor: default;
  }
  .stage-pip.not-run:hover { opacity: 1; }
  .stage-sep { color: #d1d5db; font-size: 0.7rem; }

  /* Summary tab */
  .halt-box {
    background: #fff1f2; border: 1px solid #fecdd3; border-radius: 6px;
    padding: 0.6rem 0.9rem; color: #7f1d1d; font-size: 0.85rem; margin-bottom: 1rem;
  }
  .halt-label { font-weight: 600; }
  .abandoned-at {
    font-size: 0.82rem; color: #6b7280; margin-bottom: 0.75rem;
  }
  .abandoned-at code {
    background: #f3f4f6; padding: 1px 5px; border-radius: 3px; font-size: 0.8em; color: #374151;
  }
  .summary-section { margin-bottom: 1.5rem; }
  .section-label {
    font-size: 0.7rem; font-weight: 600; text-transform: uppercase;
    letter-spacing: 0.08em; color: #9ca3af; margin-bottom: 0.5rem;
  }
  .stat-row { display: flex; gap: 0.75rem; flex-wrap: wrap; margin-bottom: 1rem; }
  .stat-chip {
    background: #fff; border: 1px solid #e5e7eb; border-radius: 6px;
    padding: 0.35rem 0.75rem; display: flex; align-items: baseline; gap: 0.3rem;
    font-size: 0.82rem;
  }
  .stat-chip.clickable { cursor: pointer; transition: border-color 0.12s, background 0.12s; }
  .stat-chip.clickable:hover { border-color: #93c5fd; background: #eff6ff; }
  .chip-num { font-size: 1.1rem; font-weight: 700; color: #111827; }
  .chip-lbl { color: #6b7280; font-size: 0.75rem; }
  .halt-type { font-size: 0.75rem; color: #6b7280; font-style: italic; margin-left: 4px; }
  .drift-warn { color: #78350f; font-weight: 600; }
  .no-drift { color: #065f46; font-weight: 600; }
  .problem {
    color: #374151; font-size: 0.9rem; max-width: 76ch;
    margin-bottom: 0.85rem; line-height: 1.7;
  }
  .meta-line { margin-top: 0.5rem; font-size: 0.82rem; }
  .meta-label { color: #6b7280; margin-right: 4px; }
  .oos-section { margin-top: 0.75rem; font-size: 0.82rem; }
  .oos-list { margin: 0.25rem 0 0 1rem; padding: 0; list-style: disc; color: #6b7280; }
  .oos-list li { margin-bottom: 2px; }

  /* Stages tab — table */
  table { width: 100%; border-collapse: collapse; font-size: 0.85rem; }
  thead th {
    text-align: left; padding: 6px 10px;
    background: #f3f4f6; border-bottom: 2px solid #e5e7eb;
    font-weight: 600; color: #374151;
  }
  tbody tr:nth-child(even) { background: #f9fafb; }
  tbody tr:hover { background: #f0f9ff; }
  tbody td { padding: 6px 10px; border-bottom: 1px solid #f3f4f6; vertical-align: top; }
  .stage-name { font-weight: 500; }
  .stage-id { display: block; color: #9ca3af; font-size: 0.72rem; margin-top: 1px; }
  details { margin-top: 4px; }
  details summary {
    cursor: pointer; font-size: 0.78rem; color: #6b7280;
    user-select: none; list-style: none;
  }
  details summary::before { content: "▶ "; font-size: 0.65rem; }
  details[open] summary::before { content: "▼ "; font-size: 0.65rem; }
  .ws-table { width: 100%; margin-top: 6px; font-size: 0.8rem; }
  .ws-table td { padding: 3px 6px; border-bottom: 1px solid #f3f4f6; }
  .blockers-list { margin: 6px 0 0 1rem; padding: 0; list-style: disc; color: #7f1d1d; }
  .warnings-list { margin: 6px 0 0 1rem; padding: 0; list-style: disc; color: #78350f; }
  .dispatch-count {
    display: inline-block; font-size: 0.7rem; color: #9ca3af;
    background: #f3f4f6; border-radius: 3px; padding: 0 4px; margin-left: 4px;
  }
  .dur-cell { color: #374151; }
  .stage-doc-links { display: flex; flex-wrap: wrap; gap: 4px; margin-bottom: 4px; }
  .stage-doc-link {
    font-size: 0.72rem; color: #2563eb; background: #eff6ff;
    border: 1px solid #bfdbfe; border-radius: 4px; padding: 1px 7px;
    cursor: pointer; white-space: nowrap; transition: background 0.1s;
  }
  .stage-doc-link:hover { background: #dbeafe; }
  .blocker-pre {
    background: #f8fafc; border: 1px solid #e2e8f0; border-radius: 6px;
    padding: 1rem; font-size: 0.8rem; white-space: pre-wrap;
    word-break: break-word; color: #374151; max-height: 400px;
    overflow-y: auto; margin: 0.5rem 0 0;
  }
  @keyframes highlightRow {
    0%   { background: #bfdbfe; }
    80%  { background: #eff6ff; }
    100% { background: #fff; }
  }
  .stage-highlight { animation: highlightRow 2s ease-out forwards; }

  /* Documents tab */
  .doc-layout {
    display: grid; grid-template-columns: 240px 1fr;
    border: 1px solid #e5e7eb; border-radius: 8px;
    overflow: hidden; min-height: 500px;
  }
  .doc-nav {
    background: #f9fafb; border-right: 1px solid #e5e7eb;
    overflow-y: auto; max-height: 80vh;
  }
  .doc-nav-item {
    padding: 0.5rem 0.75rem; font-size: 0.78rem; cursor: pointer;
    border-bottom: 1px solid #f3f4f6; color: #374151;
    line-height: 1.4; transition: background 0.1s;
  }
  .doc-nav-item:hover { background: #eff6ff; }
  .doc-nav-item.active { background: #eff6ff; color: #2563eb; font-weight: 500; }
  .doc-viewer { overflow-y: auto; max-height: 80vh; padding: 1.5rem 1.75rem; }
  .doc-body { font-size: 0.875rem; }
  .doc-body h1 { font-size: 1.2rem; font-weight: 700; margin: 0 0 0.5rem; }
  .doc-body h2 {
    font-size: 0.95rem; font-weight: 600; text-transform: none;
    letter-spacing: 0; border-bottom: 1px solid #e5e7eb;
    padding-bottom: 4px; margin: 1.25rem 0 0.5rem; color: #111827;
  }
  .doc-body h3 { font-size: 0.875rem; font-weight: 600; margin: 1rem 0 0.35rem; }
  .doc-body h4 { font-size: 0.82rem; font-weight: 600; margin: 0.75rem 0 0.25rem; }
  .doc-body p  { margin: 0 0 0.75rem; }
  .doc-body pre {
    background: #f8fafc; border: 1px solid #e2e8f0; border-radius: 4px;
    padding: 0.75rem; overflow-x: auto; font-size: 0.8rem; margin: 0.5rem 0;
  }
  .doc-body code { background: #f3f4f6; padding: 1px 4px; border-radius: 3px; font-size: 0.8em; }
  .doc-body pre code { background: none; padding: 0; }
  .doc-body table { width: 100%; border-collapse: collapse; margin: 0.75rem 0; font-size: 0.82rem; }
  .doc-body table th { background: #f3f4f6; border: 1px solid #e5e7eb; padding: 4px 8px; text-align: left; }
  .doc-body table td { border: 1px solid #e5e7eb; padding: 4px 8px; }
  .doc-body blockquote {
    border-left: 3px solid #d1d5db; margin: 0.5rem 0;
    padding: 0.25rem 0.75rem; color: #6b7280;
  }
  .doc-body hr { border: none; border-top: 1px solid #e5e7eb; margin: 1rem 0; }
  .doc-body ul, .doc-body ol { padding-left: 1.5rem; margin: 0.35rem 0 0.75rem; }
  .doc-body li { margin-bottom: 2px; }
  .doc-body a { color: #2563eb; }
  .doc-pre {
    font-size: 0.8rem; white-space: pre-wrap; word-break: break-word;
    background: #f8fafc; border: 1px solid #e2e8f0; border-radius: 6px;
    padding: 1rem; margin: 0; line-height: 1.6;
  }

  /* Misc */
  .no-data { color: #9ca3af; font-style: italic; font-size: 0.85rem; }
  footer {
    margin-top: 3rem; padding-top: 1rem; border-top: 1px solid #e5e7eb;
    color: #9ca3af; font-size: 0.75rem;
  }
`;

// ── JavaScript ───────────────────────────────────────────────────────────────

const SCRIPT = `
  // Tab switching
  document.querySelectorAll('.tab-btn').forEach(btn => {
    btn.addEventListener('click', () => {
      document.querySelectorAll('.tab-btn').forEach(b => b.classList.remove('active'));
      document.querySelectorAll('.tab-pane').forEach(p => p.classList.add('hidden'));
      btn.classList.add('active');
      document.getElementById('tab-' + btn.dataset.tab).classList.remove('hidden');
    });
  });

  // Document sidebar navigation
  document.querySelectorAll('.doc-nav-item').forEach(item => {
    item.addEventListener('click', () => {
      document.querySelectorAll('.doc-nav-item').forEach(n => n.classList.remove('active'));
      document.querySelectorAll('.doc-pane').forEach(p => p.classList.add('hidden'));
      item.classList.add('active');
      document.getElementById('doc-' + item.dataset.doc).classList.remove('hidden');
    });
  });

  // Navigate to Documents tab and show a specific document by index.
  function showDoc(idx) {
    document.querySelectorAll('.tab-btn').forEach(b => b.classList.remove('active'));
    document.querySelectorAll('.tab-pane').forEach(p => p.classList.add('hidden'));
    document.querySelector('.tab-btn[data-tab="documents"]').classList.add('active');
    document.getElementById('tab-documents').classList.remove('hidden');
    document.querySelectorAll('.doc-nav-item').forEach(n => n.classList.remove('active'));
    document.querySelectorAll('.doc-pane').forEach(p => p.classList.add('hidden'));
    var item = document.querySelector('.doc-nav-item[data-doc="' + idx + '"]');
    if (item) item.classList.add('active');
    var pane = document.getElementById('doc-' + idx);
    if (pane) pane.classList.remove('hidden');
  }

  // Navigate to Documents tab and show the first document matching a kind.
  function showDocByKind(kind) {
    var item = document.querySelector('.doc-nav-item[data-doc-kind="' + kind + '"]');
    if (item) showDoc(item.dataset.doc);
  }

  // Stage pip click → switch to Pipeline tab and highlight the row.
  document.querySelectorAll('.stage-pip[data-stage]').forEach(pip => {
    pip.addEventListener('click', () => {
      document.querySelectorAll('.tab-btn').forEach(b => b.classList.remove('active'));
      document.querySelectorAll('.tab-pane').forEach(p => p.classList.add('hidden'));
      document.querySelector('.tab-btn[data-tab="pipeline"]').classList.add('active');
      document.getElementById('tab-pipeline').classList.remove('hidden');
      const row = document.getElementById('sr-' + pip.dataset.stage);
      if (row) {
        row.scrollIntoView({ behavior: 'smooth', block: 'center' });
        row.classList.remove('stage-highlight');
        void row.offsetWidth; // force reflow to restart animation
        row.classList.add('stage-highlight');
      }
    });
  });

  // Stage doc links → Documents tab.
  document.querySelectorAll('.stage-doc-link[data-goto-doc-idx]').forEach(el => {
    el.addEventListener('click', function() { showDoc(this.dataset.gotoDocIdx); });
  });

  // Clickable stat chips (ACs, scenarios) → Documents tab.
  document.querySelectorAll('.stat-chip[data-goto-doc-kind]').forEach(el => {
    el.addEventListener('click', function() { showDocByKind(this.dataset.gotoDocKind); });
  });
`;

// ── Main render ──────────────────────────────────────────────────────────────

function renderHtml(data) {
  const { meta, stages, blockerLog, documents = [], logStats = null } = data;

  const metaItems = [
    meta.track && `Track: <strong>${esc(meta.track)}</strong>`,
    meta.startedAt && `Started: <strong>${esc(formatDate(meta.startedAt))}</strong>`,
    `Iterations: <strong>${esc(String(meta.iterations))}</strong>`,
    logStats && logStats.wallClockMs != null && `Wall clock: <strong>${esc(formatDuration(logStats.wallClockMs))}</strong>`,
    logStats && logStats.totalComputeMs > 0 && `Compute: <strong>${esc(formatDuration(logStats.totalComputeMs))}</strong>`,
    meta.costUsd != null && `Cost: <strong>${esc(formatCost(meta.costUsd))}</strong>${meta.costBasis && meta.costBasis !== "observed" ? ` <span style="color:#b45309">(${esc(meta.costBasis)})</span>` : ""}`,
    meta.tokensUsed != null && `Tokens: <strong>${esc(meta.tokensUsed.toLocaleString("en-US"))}</strong>${meta.tokenBasis && meta.tokenBasis !== "observed" ? ` <span style="color:#b45309">(${esc(meta.tokenBasis)})</span>` : ""}${meta.tokenCoverageComplete ? "" : ` <span style="color:#b45309">(partial)</span>`}`,
    logStats && logStats.retries > 0 && `Retries: <strong>${esc(String(logStats.retries))}</strong>`,
    logStats && logStats.stalls > 0 && `Stalls: <strong>${esc(String(logStats.stalls))}</strong>`,
    meta.orchestratorVersion && `<span style="color:#d1d5db">${esc(meta.orchestratorVersion)}</span>`,
  ].filter(Boolean).join(" &nbsp;·&nbsp; ");

  const stagesCount = stages.length;
  const docsCount = documents.length;

  const now = new Date().toLocaleString(undefined, {
    year: "numeric", month: "short", day: "numeric",
    hour: "2-digit", minute: "2-digit",
  });

  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>Stagecraft Report — ${esc(meta.feature)}</title>
  <style>${CSS}</style>
</head>
<body>
<div class="page">

  <div class="report-header">
    <div class="report-title">
      <h1>${esc(meta.feature)}</h1>
      ${finalStatusBadge(meta.finalStatus, meta.haltType)}
    </div>
    <div class="header-meta">${metaItems}</div>
  </div>

  <div class="tab-bar">
    <button class="tab-btn active" data-tab="summary">Summary</button>
    <button class="tab-btn" data-tab="pipeline">Pipeline${stagesCount > 0 ? ` <span class="tab-count">${stagesCount}</span>` : ""}</button>
    <button class="tab-btn" data-tab="documents">Documents${docsCount > 0 ? ` <span class="tab-count">${docsCount}</span>` : ""}</button>
  </div>

  <div id="tab-summary" class="tab-pane">
    ${renderSummaryTab(data)}
  </div>

  <div id="tab-pipeline" class="tab-pane hidden">
    ${renderStagesTab(stages, blockerLog, documents, logStats)}
  </div>

  <div id="tab-documents" class="tab-pane hidden">
    ${renderDocumentsTab(documents)}
  </div>

  <footer>
    Generated ${esc(now)}${meta.orchestratorVersion ? ` &nbsp;·&nbsp; ${esc(meta.orchestratorVersion)}` : ""}
  </footer>

</div>
<script>${SCRIPT}</script>
</body>
</html>`;
}

module.exports = { renderHtml };
