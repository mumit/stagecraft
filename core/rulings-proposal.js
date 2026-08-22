"use strict";

// ADR-003's escalation contract, put behind the same propose/review/apply split
// that requirements and design refinements already use (Phase 40).
//
// The asymmetry this closes: `devteam ruling --headless` dispatches the
// Principal with allowedWrites ["pipeline/context.md"], so the ruling is
// written straight into the file and `devteam fix-escalation` acts on it. A
// binding ruling is the highest-authority artifact in the escalation path --
// it authorizes an autonomous re-dispatch, and its `[class: ...]` is what an
// operator may later pre-authorize through `--auto-rule` -- and it was the one
// artifact with no review step. A brief edit needed approval; a ruling did not.
//
// Two properties this deliberately keeps:
//
//   The model never rewrites pipeline/context.md. It returns a narrow envelope
//   naming the topic, decision, and class; Stagecraft renders the line and
//   computes the appended file itself. context.md accumulates the escalation
//   history, and a whole-file replacement is an invitation to lose it.
//
//   The envelope is validated by round-tripping through escalation.js's own
//   parseRulingLine, not a private regex here. If the rendered line does not
//   parse back to what the model asked for, the proposal is refused -- so a
//   proposal can never store a line `devteam fix-escalation` would read
//   differently than the operator reviewed.

const fs = require("node:fs");
const path = require("node:path");
const { scanContent } = require("./hooks/secret-scan");
const { pipelineRoot } = require("./paths");
const { RULING_PREFIX, parseRulingLine } = require("./escalation");
const { KINDS, SCHEMA, createProposal } = require("./artifact-proposals");

const MAX_TOPIC = 200;
const MAX_DECISION = 600;
const CLASS_RE = /^[a-z0-9][a-z0-9-]*$/;

// Render the single line ADR-003 defines. "unclassified" is the parser's
// default for a line with no suffix, so it is written as no suffix rather than
// as the literal word -- the two must round-trip identically.
function renderRulingLine({ topic, decision, class: cls }) {
  const suffix = cls && cls !== "unclassified" ? ` [class: ${cls}]` : "";
  return `${RULING_PREFIX} ${topic} → ${decision}${suffix}`;
}

// parseRulingProposalOutput -- validate what the host returned.
//
// Accepts {schema, ruling:{topic, decision, class?}} and nothing else, in the
// same shape parseReplacementOutput enforces for artifact refinements.
function parseRulingProposalOutput(output) {
  let text = String(output || "").trim();
  const fenced = text.match(/^```(?:json)?\s*([\s\S]*?)\s*```$/i);
  if (fenced) text = fenced[1];
  let parsed;
  try { parsed = JSON.parse(text); } catch { throw new Error("ruling host returned malformed proposal JSON"); }
  if (!parsed || parsed.schema !== SCHEMA || !parsed.ruling || typeof parsed.ruling !== "object") {
    throw new Error(`ruling host must return {schema:"${SCHEMA}", ruling:{topic,decision,class}}`);
  }
  if (Object.keys(parsed).sort().join(",") !== "ruling,schema") {
    throw new Error("ruling proposal contains unsupported fields");
  }
  const { topic, decision } = parsed.ruling;
  const cls = parsed.ruling.class === undefined ? "unclassified" : parsed.ruling.class;
  const extra = Object.keys(parsed.ruling).filter((k) => !["topic", "decision", "class"].includes(k));
  if (extra.length > 0) throw new Error(`ruling contains unsupported fields: ${extra.join(", ")}`);

  for (const [label, value, max] of [["topic", topic, MAX_TOPIC], ["decision", decision, MAX_DECISION]]) {
    if (typeof value !== "string" || value.trim().length === 0) throw new Error(`ruling ${label} is required`);
    if (value.length > max) throw new Error(`ruling ${label} must be 1..${max} characters`);
    // A newline would split one ruling into a line the parser never sees.
    if (/[\r\n]/.test(value)) throw new Error(`ruling ${label} must be a single line`);
  }
  if (typeof cls !== "string" || !CLASS_RE.test(cls)) {
    throw new Error("ruling class must be a lowercase slug (letters, digits, hyphens)");
  }
  // An arrow inside the topic would move where splitArrow() divides the line,
  // so the stored decision would not be the reviewed one.
  if (/→|->/.test(topic)) throw new Error("ruling topic must not contain an arrow");

  const ruling = { topic: topic.trim(), decision: decision.trim(), class: cls };
  const line = renderRulingLine(ruling);
  if (scanContent(line).length > 0) throw new Error("ruling contains secret-like material");

  // The round-trip. What fix-escalation will read must equal what was proposed.
  const reparsed = parseRulingLine(line);
  if (!reparsed
    || reparsed.topic !== ruling.topic
    || reparsed.decision !== ruling.decision
    || reparsed.class !== ruling.class) {
    throw new Error("ruling does not round-trip through the escalation parser; refusing to store it");
  }
  return { ruling, line };
}

// createRulingProposal -- store the appended context.md as an ordinary proposal.
//
// The append is computed here rather than asked for, so the stored replacement
// is the current file plus exactly one line. Everything downstream -- staleness
// against base_sha256, the transaction, apply/reject, the event log -- is the
// existing machinery unchanged.
function createRulingProposal({ cwd, changeId = null, ruling, line, host, model, usage }) {
  const contextFile = path.join(pipelineRoot(cwd, changeId), KINDS.ruling.artifact);
  let current;
  try { current = fs.readFileSync(contextFile, "utf8"); } catch {
    throw new Error(`${path.relative(cwd, contextFile).replace(/\\/g, "/")} does not exist`);
  }
  const rendered = line || renderRulingLine(ruling);
  if (current.split("\n").some((existing) => existing.trim() === rendered)) {
    throw new Error("that ruling is already recorded in context.md");
  }
  const replacement = current.endsWith("\n") ? `${current}${rendered}\n` : `${current}\n${rendered}\n`;
  return createProposal({ cwd, changeId, kind: "ruling", replacement, host, model, usage });
}

module.exports = { renderRulingLine, parseRulingProposalOutput, createRulingProposal, MAX_TOPIC, MAX_DECISION };
