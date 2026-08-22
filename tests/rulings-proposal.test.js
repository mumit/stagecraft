// Rulings behind the same propose/review/apply split as requirements and design.
//
// `devteam ruling --headless` dispatches the Principal with allowedWrites
// ["pipeline/context.md"], so the ruling is written straight into the file and
// `devteam fix-escalation` acts on it. A binding ruling authorizes an
// autonomous re-dispatch, and its [class:] is what an operator may later
// pre-authorize via --auto-rule -- it was the highest-authority artifact in the
// escalation path and the only one with no review step.

const { describe, it, afterEach } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { makeTargetProject, cleanup } = require("./_helpers");
const {
  renderRulingLine, parseRulingProposalOutput, createRulingProposal,
} = require("../core/rulings-proposal");
const { applyProposal, rejectProposal, unifiedReplacementDiff } = require("../core/artifact-proposals");
const { parseRulingLine } = require("../core/escalation");

let dirs = [];
const track = (cwd) => { dirs.push(cwd); return cwd; };
afterEach(() => { dirs.forEach(cleanup); dirs = []; });

const SCHEMA = "stagecraft.artifact-proposal/v1";
const envelope = (ruling) => JSON.stringify({ schema: SCHEMA, ruling });
const OK = { topic: "lint rule conflict", decision: "adopt the repo eslint config", class: "formatting-only" };

function project(context = "# Context\n\n## Principal Rulings\n") {
  const cwd = track(makeTargetProject());
  fs.writeFileSync(path.join(cwd, "pipeline", "context.md"), context);
  return cwd;
}
const contextOf = (cwd) => fs.readFileSync(path.join(cwd, "pipeline", "context.md"), "utf8");

describe("ruling envelope: what a host is allowed to return", () => {
  it("accepts the documented shape and renders the ADR-003 line", () => {
    const { ruling, line } = parseRulingProposalOutput(envelope(OK));
    assert.deepEqual(ruling, OK);
    assert.equal(line, "PRINCIPAL-RULING: lint rule conflict → adopt the repo eslint config [class: formatting-only]");
  });

  it("round-trips through the escalation parser, not a private regex", () => {
    // What `devteam fix-escalation` reads must equal what was reviewed.
    const { ruling, line } = parseRulingProposalOutput(envelope(OK));
    assert.deepEqual(parseRulingLine(line), ruling);
  });

  it("writes 'unclassified' as no suffix, so it round-trips", () => {
    const { line } = parseRulingProposalOutput(envelope({ ...OK, class: "unclassified" }));
    assert.doesNotMatch(line, /\[class:/);
    assert.equal(parseRulingLine(line).class, "unclassified");
  });

  it("defaults a missing class to unclassified, which is never auto-applied", () => {
    const { ruling } = parseRulingProposalOutput(envelope({ topic: "t", decision: "d" }));
    assert.equal(ruling.class, "unclassified");
  });

  it("rejects a topic containing an arrow", () => {
    // splitArrow() divides on the first arrow, so an arrow in the topic would
    // move the boundary and store a decision nobody reviewed.
    assert.throws(() => parseRulingProposalOutput(envelope({ ...OK, topic: "a → b" })),
      /must not contain an arrow/);
  });

  it("rejects a multi-line topic or decision", () => {
    assert.throws(() => parseRulingProposalOutput(envelope({ ...OK, decision: "one\ntwo" })), /single line/);
  });

  it("rejects unsupported fields, bad classes, and empty values", () => {
    assert.throws(() => parseRulingProposalOutput(JSON.stringify({ schema: SCHEMA, ruling: OK, extra: 1 })),
      /unsupported fields/);
    assert.throws(() => parseRulingProposalOutput(envelope({ ...OK, note: "x" })), /unsupported fields/);
    assert.throws(() => parseRulingProposalOutput(envelope({ ...OK, class: "Not A Slug" })), /lowercase slug/);
    assert.throws(() => parseRulingProposalOutput(envelope({ ...OK, decision: "  " })), /decision is required/);
  });

  it("rejects secret-like material and malformed JSON", () => {
    assert.throws(() => parseRulingProposalOutput(envelope({ ...OK, decision: `use ghp_${"a".repeat(36)}` })),
      /secret-like/);
    assert.throws(() => parseRulingProposalOutput("not json"), /malformed proposal JSON/);
  });

  it("tolerates a fenced code block, like the artifact path does", () => {
    const { ruling } = parseRulingProposalOutput("```json\n" + envelope(OK) + "\n```");
    assert.deepEqual(ruling, OK);
  });
});

describe("ruling proposals: appended, never a rewrite", () => {
  it("stores the current file plus exactly one line", () => {
    const cwd = project();
    const { ruling, line } = parseRulingProposalOutput(envelope(OK));
    const proposal = createRulingProposal({ cwd, ruling, line, host: "generic" });
    assert.equal(proposal.replacement, `${contextOf(cwd)}${line}\n`);
    assert.equal(proposal.status, "pending");
  });

  it("invalidates no gates", () => {
    // A ruling resolves a halt; it does not restate an artifact others derived
    // from. root_stage null must mean "nothing", not "everything".
    const cwd = project();
    const { ruling, line } = parseRulingProposalOutput(envelope(OK));
    assert.deepEqual(createRulingProposal({ cwd, ruling, line }).affected_gates, []);
  });

  it("shows a one-line diff rather than a whole-file replacement", () => {
    const cwd = project();
    const { ruling, line } = parseRulingProposalOutput(envelope(OK));
    const { diff } = createRulingProposal({ cwd, ruling, line });
    // Skip the ---/+++/@@ headers; only the hunk body describes the change.
    const body = diff.trim().split("\n").slice(3);
    assert.deepEqual(body.filter((l) => l.startsWith("-")), [], "nothing is removed by an append");
    assert.equal(body.length, 1, "exactly one line is added");
  });

  it("refuses a ruling already recorded", () => {
    const cwd = project();
    const { ruling, line } = parseRulingProposalOutput(envelope(OK));
    applyProposal(cwd, null, createRulingProposal({ cwd, ruling, line }).id);
    assert.throws(() => createRulingProposal({ cwd, ruling, line }), /already recorded/);
  });

  it("applies by appending, leaving the existing content intact", () => {
    const cwd = project("# Context\n\n## Principal Rulings\nPRINCIPAL-RULING: older → decision\n");
    const before = contextOf(cwd);
    const { ruling, line } = parseRulingProposalOutput(envelope(OK));
    const applied = applyProposal(cwd, null, createRulingProposal({ cwd, ruling, line }).id);
    assert.equal(applied.status, "applied");
    const after = contextOf(cwd);
    assert.ok(after.startsWith(before), "the accumulated escalation history survives");
    assert.equal(after, `${before}${line}\n`);
    assert.equal(parseRulingLine(after.trim().split("\n").pop()).class, "formatting-only");
  });

  it("reject leaves context.md untouched", () => {
    const cwd = project();
    const before = contextOf(cwd);
    const { ruling, line } = parseRulingProposalOutput(envelope(OK));
    const p = createRulingProposal({ cwd, ruling, line });
    assert.equal(rejectProposal(cwd, null, p.id, "not the call I want").status, "rejected");
    assert.equal(contextOf(cwd), before);
  });

  it("errors clearly when there is no context.md to append to", () => {
    const cwd = track(makeTargetProject());
    const { ruling, line } = parseRulingProposalOutput(envelope(OK));
    assert.throws(() => createRulingProposal({ cwd, ruling, line }), /context\.md does not exist/);
  });
});

describe("unifiedReplacementDiff: common context is trimmed", () => {
  it("collapses an append to the added line", () => {
    const diff = unifiedReplacementDiff("f.md", "a\nb\n", "a\nb\nc\n");
    assert.match(diff, /@@ -3,0 \+3,1 @@/);
    assert.deepEqual(diff.trim().split("\n").slice(3), ["+c"]);
  });

  it("still shows a whole-file rewrite as one", () => {
    const diff = unifiedReplacementDiff("f.md", "old\n", "new\n");
    assert.deepEqual(diff.trim().split("\n").slice(3), ["-old", "+new"]);
  });

  it("reports no change as an empty hunk", () => {
    const diff = unifiedReplacementDiff("f.md", "same\n", "same\n");
    assert.deepEqual(diff.trim().split("\n").slice(3), []);
  });
});

describe("renderRulingLine", () => {
  it("is what parseRulingLine expects for every class shape", () => {
    for (const cls of ["formatting-only", "doc-only", "unclassified", "known-safe-dep-bump"]) {
      const line = renderRulingLine({ topic: "t", decision: "d", class: cls });
      assert.deepEqual(parseRulingLine(line), { topic: "t", decision: "d", class: cls });
    }
  });
});
