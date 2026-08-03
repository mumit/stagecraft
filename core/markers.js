/**
 * core/markers.js — canonical begin/end-marker section helpers.
 *
 * Both functions operate on text strings; callers own file I/O.
 *
 * Semantics:
 *   upsertSection(text, begin, end, body, opts?)
 *     If begin is absent: inserts body. Default is append; pass
 *       { insert: "prepend" } for context sections that must stay prominent.
 *     If both markers are present and begin precedes end: replaces the region
 *       [begin, end+end.length) with body (normal round-trip).
 *     Corrupt input (end missing, or end appears before begin in the text):
 *       removes the orphaned begin marker, inserts a fresh body, preserves the
 *       surrounding content, and warns on stderr.
 *
 *   stripSection(text, begin, end)
 *     If begin is absent: returns text unchanged (idempotent no-op).
 *     If both markers are present and begin precedes end: removes the region
 *       [begin, end+end.length) and trims any leading blank lines from the
 *       remainder (validator behavior — least-surprise for hook callers).
 *     Corrupt input (end missing, or end before begin):
 *       strips from the begin-marker to EOF and warns on stderr.
 *
 *   parseSections(content)
 *     Finds every devteam:<name>:begin/end pair in document order, returning
 *     { sectionName, start, end } byte offsets. Shared by `devteam compact`
 *     (core/cli/commands/compact.js) and the context-budget auto-compactor
 *     (core/context-budget.js, phase 32.5) so both walk the same section set.
 */
"use strict";

function _warn(msg) {
  process.stderr.write(`[markers] warning: ${msg}\n`);
}

/**
 * Replace or append a marker-delimited section in text.
 * @param {string} text   Existing file content (may be empty string)
 * @param {string} begin  Begin marker
 * @param {string} end    End marker
 * @param {string} body   Replacement block (caller includes markers in body)
 * @param {object} opts
 * @param {"append"|"prepend"} opts.insert Where to insert when no valid pair exists
 * @returns {string}
 */
function upsertSection(text, begin, end, body, opts = {}) {
  const insert = opts.insert === "prepend" ? "prepend" : "append";
  const insertBody = (base) => {
    if (!base) return body + "\n";
    if (insert === "prepend") return body + "\n\n" + base.replace(/^\n+/, "");
    return base.replace(/\s*$/, "") + "\n\n" + body + "\n";
  };

  const b = text.indexOf(begin);
  if (b === -1) {
    return insertBody(text);
  }
  const e = text.indexOf(end);
  if (e === -1 || e < b) {
    _warn(`corrupt marker section (${e === -1 ? "missing end marker" : "end before begin"}) — removing orphan begin marker and reinserting section`);
    const base = text.slice(0, b) + text.slice(b + begin.length).replace(/^\n?/, "");
    return insertBody(base);
  }
  return text.slice(0, b) + body + text.slice(e + end.length);
}

/**
 * Remove a marker-delimited section from text.
 * @param {string} text   File content
 * @param {string} begin  Begin marker
 * @param {string} end    End marker
 * @returns {string}      Text with section removed, or original if absent
 */
function stripSection(text, begin, end) {
  const startIdx = text.indexOf(begin);
  if (startIdx === -1) return text;
  const endIdx = text.indexOf(end);
  if (endIdx < 0 || endIdx < startIdx) {
    _warn(`corrupt marker section (${endIdx < 0 ? "missing end marker" : "end before begin"}) — stripping from begin-marker to EOF`);
    return text.slice(0, startIdx);
  }
  const after = text.slice(endIdx + end.length).replace(/^\n+/, "");
  return text.slice(0, startIdx) + after;
}

// Matches any devteam-managed marker section:
//   <!-- devteam:<name>:begin --> ... <!-- devteam:<name>:end -->
// Non-greedy so adjacent sections are captured individually.
const SECTION_RE = /<!--\s*devteam:([a-z-]+):begin\s*-->[\s\S]*?<!--\s*devteam:[a-z-]+:end\s*-->/g;

/**
 * Parse all devteam marker sections from content. Returns sections in
 * document order with their byte offsets so callers can strip/replace
 * in reverse (or, for the budget compactor, in forward "oldest first" order).
 * @param {string} content
 * @returns {Array<{sectionName: string, start: number, end: number}>}
 */
function parseSections(content) {
  const found = [];
  SECTION_RE.lastIndex = 0;
  let match;
  while ((match = SECTION_RE.exec(content)) !== null) {
    found.push({
      sectionName: match[1],
      start:       match.index,
      end:         match.index + match[0].length,
    });
  }
  return found;
}

module.exports = { upsertSection, stripSection, parseSections };
