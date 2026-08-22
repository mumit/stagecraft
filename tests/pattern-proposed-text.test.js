// What a pattern candidate proposes as prevention guidance.
//
// This is the text an agent is injected with so it stops relearning a rule from
// failed gates -- the whole point of the pattern layer. It was a per-domain
// template with the workstream interpolated, and the domain is inferred from
// the stage id, so it could be a poor fit for what actually recurred: a
// `no-console` blocker at stage-04a lands in the "tooling" domain, whose
// sentence is about whether lint scripts exist. True of the stage, useless as
// guidance for that rule.
//
// The observation already records `detector` -- the blocker's own signal/code/id
// -- and nothing used it. Observations deliberately do not carry the finding's
// raw text (they are classification only, which is what keeps them exportable),
// so the detector is the most specific ground truth available.

const { describe, it, afterEach } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { makeTargetProject, cleanup } = require("./_helpers");
const patterns = require("../core/patterns");

let dirs = [];
const track = (cwd) => { dirs.push(cwd); return cwd; };
afterEach(() => { dirs.forEach(cleanup); dirs = []; });

function observe(cwd, { stage, role, blocker }) {
  const gate = { stage, status: "FAIL", role, track: "loop", blockers: [blocker] };
  fs.writeFileSync(path.join(cwd, "pipeline", "gates", `${stage}.json`), JSON.stringify(gate, null, 2));
  patterns.collect({ cwd, gate });
}
const candidates = (cwd) =>
  patterns.candidatesFromObservations(patterns.readObservations(cwd), {});
const only = (cwd) => candidates(cwd)[0].proposed_prompt_text;

describe("proposed prevention text names what recurred", () => {
  it("leads with the detector when the blocker carried one", () => {
    const cwd = track(makeTargetProject());
    observe(cwd, { stage: "stage-04a", role: "platform", blocker: { code: "no-console", text: "x" } });
    assert.match(only(cwd), /^Prevent recurring "no-console" findings — /);
  });

  it("keeps the domain guidance after the detector, not instead of it", () => {
    const cwd = track(makeTargetProject());
    observe(cwd, { stage: "stage-06c", role: "backend", blocker: { code: "missing-trace-span", text: "x" } });
    const text = only(cwd);
    assert.match(text, /missing-trace-span/);
    assert.match(text, /structured logs, metrics, or traces/);
  });

  it("takes the detector from signal, code, or id", () => {
    for (const key of ["signal", "code", "id"]) {
      const cwd = track(makeTargetProject());
      observe(cwd, { stage: "stage-06", role: "qa", blocker: { [key]: "flaky-timeout", text: "x" } });
      assert.match(only(cwd), /"flaky-timeout"/, `${key} should become the detector`);
    }
  });

  it("stays generic when the blocker carried no identifier", () => {
    // detectorFrom falls back to slugify(source); quoting "gate-blocker" or
    // "reflector" back at the agent is noise, not evidence.
    const cwd = track(makeTargetProject());
    observe(cwd, { stage: "stage-05", role: "backend", blocker: { text: "something vague" } });
    const text = only(cwd);
    assert.doesNotMatch(text, /^Prevent recurring/);
    assert.match(text, /Avoid repeating prior correctness findings/);
  });

  it("reads as one sentence, not two clauses glued together", () => {
    const cwd = track(makeTargetProject());
    observe(cwd, { stage: "stage-06", role: "qa", blocker: { code: "missing-edge-case-tests", text: "x" } });
    const text = only(cwd);
    assert.match(text, /^[A-Z]/, "starts capitalized");
    assert.doesNotMatch(text, /— [A-Z]/, "the joined clause is lowercased");
    assert.match(text, /\.$/);
  });

  it("is still what promote() uses by default", () => {
    // The improvement has to reach the promoted record, not just the listing.
    const cwd = track(makeTargetProject());
    observe(cwd, { stage: "stage-04a", role: "platform", blocker: { code: "no-console", text: "x" } });
    const candidate = candidates(cwd)[0];
    const record = patterns.promote({ cwd, candidateId: candidate.id });
    assert.equal(record.prompt_text, candidate.proposed_prompt_text);
    assert.match(record.prompt_text, /no-console/);
  });

  it("an operator's own text still wins", () => {
    const cwd = track(makeTargetProject());
    observe(cwd, { stage: "stage-04a", role: "platform", blocker: { code: "no-console", text: "x" } });
    const record = patterns.promote({
      cwd, candidateId: candidates(cwd)[0].id, text: "Never log to stdout in platform code.",
    });
    assert.equal(record.prompt_text, "Never log to stdout in platform code.");
  });
});

describe("observations stay classification-only", () => {
  it("never records the finding's raw text", () => {
    // What makes them exportable. The detector is the most specific thing
    // available precisely because the text is not kept.
    const cwd = track(makeTargetProject());
    observe(cwd, {
      stage: "stage-06", role: "qa",
      blocker: { code: "missing-edge-case-tests", text: "no tests for the empty-input path" },
    });
    const serialized = JSON.stringify(patterns.readObservations(cwd));
    assert.doesNotMatch(serialized, /empty-input/);
    assert.match(serialized, /missing-edge-case-tests/);
  });
});
