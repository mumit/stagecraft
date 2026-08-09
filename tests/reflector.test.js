// Tests for phase-30 item 30.3 — the opt-in run-end Reflector pass
// (core/learning/reflector.js, core/learning/validate-candidates-delta.js).

const { describe, it, afterEach } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { REPO_ROOT, makeTargetProject, cleanup } = require("./_helpers");

const { run } = require(path.join(REPO_ROOT, "core", "driver"));
const patterns = require(path.join(REPO_ROOT, "core", "patterns"));
const { validateCandidatesDelta } = require(path.join(REPO_ROOT, "core", "learning", "validate-candidates-delta"));
const { runReflector } = require(path.join(REPO_ROOT, "core", "learning", "reflector"));

let dirs = [];
function track(cwd) { dirs.push(cwd); return cwd; }
afterEach(() => { dirs.forEach(cleanup); dirs = []; });

function reflectorEnabledConfig() {
  return "routing:\n  default_host: claude-code\npipeline:\n  default_track: full\nlearning:\n  reflector: true\n";
}

function makeOutputStub(content) {
  const text = typeof content === "string" ? content : JSON.stringify(content);
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "devteam-test-reflector-stub-"));
  dirs.push(dir);
  const script = path.join(dir, "stub.js");
  fs.writeFileSync(script, `
const fs = require("node:fs");
const path = require("node:path");
let prompt = "";
process.stdin.on("data", (chunk) => { prompt += chunk; });
process.stdin.on("end", () => {
  const match = prompt.match(/Write ONLY the JSON object[^\`]*\`([^\`]+)\`/);
  if (!match) process.exit(2);
  const output = path.resolve(process.cwd(), match[1]);
  fs.mkdirSync(path.dirname(output), { recursive: true });
  fs.writeFileSync(output, ${JSON.stringify(text)}, "utf8");
});
`, "utf8");
  return script;
}

function withHeadlessCommand(cmd, fn) {
  const previous = process.env.DEVTEAM_HEADLESS_COMMAND;
  process.env.DEVTEAM_HEADLESS_COMMAND = cmd;
  return Promise.resolve().then(fn).finally(() => {
    if (previous === undefined) delete process.env.DEVTEAM_HEADLESS_COMMAND;
    else process.env.DEVTEAM_HEADLESS_COMMAND = previous;
  });
}

const VALID_DELTA = {
  schema_version: "1.0",
  new_candidates: [
    { tier: "positive", signal: "clean_first_pass_auth", summary: "Backend implemented token refresh correctly on the first attempt.", workstream: "backend", stage: "stage-04" },
  ],
  counter_adjustments: [
    { pattern_id: "some-existing-id", field: "recurrence_after_injection", delta: -1, reason: "the recurring blocker this run was unrelated to the pattern" },
  ],
  dedup_merges: [],
};

function runLogEvents(cwd) {
  return fs.readFileSync(path.join(cwd, "pipeline", "run-log.jsonl"), "utf8")
    .trim().split("\n").filter(Boolean).map((l) => JSON.parse(l));
}

describe("learning/reflector: validateCandidatesDelta", () => {
  it("accepts a well-formed payload", () => {
    const result = validateCandidatesDelta(VALID_DELTA);
    assert.equal(result.ok, true, result.errors.join("; "));
  });

  it("rejects a payload missing required top-level arrays", () => {
    const result = validateCandidatesDelta({ schema_version: "1.0" });
    assert.equal(result.ok, false);
    assert.ok(result.errors.some((e) => e.includes("new_candidates")));
  });

  it("rejects an unknown tier", () => {
    const result = validateCandidatesDelta({
      ...VALID_DELTA,
      new_candidates: [{ tier: "critical", signal: "x", summary: "y" }],
    });
    assert.equal(result.ok, false);
    assert.ok(result.errors.some((e) => e.includes("tier")));
  });

  it("rejects a non-object payload without throwing", () => {
    assert.deepEqual(validateCandidatesDelta(null), { ok: false, errors: ["payload must be a JSON object"] });
    assert.deepEqual(validateCandidatesDelta("not an object"), { ok: false, errors: ["payload must be a JSON object"] });
    assert.deepEqual(validateCandidatesDelta([1, 2, 3]), { ok: false, errors: ["payload must be a JSON object"] });
  });
});

describe("driver: Reflector dispatch (phase-30 item 30.3)", () => {
  it("disabled by default: never dispatched, run behavior unchanged", async () => {
    const cwd = track(makeTargetProject());
    let called = false;
    const s = await run({
      cwd,
      next: () => ({ action: "pipeline-complete", reason: "done" }),
      runReflector: async () => { called = true; },
    });
    assert.equal(s.completed, true);
    assert.equal(called, false, "runReflector must not be invoked when learning.reflector is false (the default)");
    const events = runLogEvents(cwd);
    assert.ok(!events.some((e) => e.outcome && e.outcome.startsWith("reflector-")), "no reflector-* events when disabled");
  });

  it("valid scripted reflector output lands new_candidates in the pattern store tagged source: reflector", async () => {
    const cwd = track(makeTargetProject({ config: reflectorEnabledConfig() }));
    const script = makeOutputStub(VALID_DELTA);
    await withHeadlessCommand(`"${process.execPath}" "${script}"`, async () => {
      const s = await run({ cwd, next: () => ({ action: "pipeline-complete", reason: "done" }) });
      assert.equal(s.completed, true);
    });

    const observations = patterns.readObservations(cwd);
    const reflectorObs = observations.filter((o) => o.source === "reflector");
    assert.equal(reflectorObs.length, 1, "the one new_candidates item must land as an observation tagged source: reflector");
    assert.equal(reflectorObs[0].tier, "positive");

    const candidate = patterns.list({ cwd }).candidates.find((c) => c.sources.includes("reflector"));
    assert.ok(candidate, "candidate list must include the reflector-sourced candidate");

    const events = runLogEvents(cwd);
    const proposal = events.find((e) => e.outcome === "reflector-proposal");
    assert.ok(proposal, "a reflector-proposal event must be logged");
    assert.equal(proposal.new_candidates_added, 1);
    assert.equal(proposal.counter_adjustments.length, 1, "counter_adjustments are logged for audit even though not auto-applied");
  });

  it("malformed reflector output (invalid JSON) is discarded whole; the run is unaffected", async () => {
    const cwd = track(makeTargetProject({ config: reflectorEnabledConfig() }));
    const script = makeOutputStub("this is not json {{{");
    await withHeadlessCommand(`"${process.execPath}" "${script}"`, async () => {
      const s = await run({ cwd, next: () => ({ action: "pipeline-complete", reason: "done" }) });
      assert.equal(s.completed, true, "malformed reflector output must never fail the run");
    });

    assert.equal(patterns.readObservations(cwd).length, 0, "no observation must be written from malformed output");
    const events = runLogEvents(cwd);
    const malformed = events.filter((e) => e.outcome === "reflector-output-malformed");
    assert.equal(malformed.length, 1, "exactly one malformed-output event must be logged");
  });

  it("malformed reflector output (schema-invalid JSON) is discarded whole, never partially applied", async () => {
    const cwd = track(makeTargetProject({ config: reflectorEnabledConfig() }));
    // Valid JSON, but new_candidates[0] is missing required fields and
    // dedup_merges is the wrong type — must be rejected in full, not
    // partially ingested.
    const script = makeOutputStub({
      schema_version: "1.0",
      new_candidates: [{ tier: "positive" }],
      counter_adjustments: [],
      dedup_merges: "not-an-array",
    });
    await withHeadlessCommand(`"${process.execPath}" "${script}"`, async () => {
      const s = await run({ cwd, next: () => ({ action: "pipeline-complete", reason: "done" }) });
      assert.equal(s.completed, true);
    });

    assert.equal(patterns.readObservations(cwd).length, 0, "schema-invalid output must not ingest any candidate");
    const events = runLogEvents(cwd);
    assert.equal(events.filter((e) => e.outcome === "reflector-output-malformed").length, 1);
  });

  it("a reflector dispatch failure is fire-and-forget: logged once, never fails the run", async () => {
    const cwd = track(makeTargetProject({ config: reflectorEnabledConfig() }));
    const s = await run({
      cwd,
      next: () => ({ action: "pipeline-complete", reason: "done" }),
      runReflector: () => { throw new Error("boom"); },
    });
    assert.equal(s.completed, true, "runReflector throwing must not affect the run outcome");
    const events = runLogEvents(cwd);
    assert.ok(
      events.some((e) => e.outcome === "reflector-dispatch-failed" && e.reason === "boom"),
      "run-log.jsonl must record a reflector-dispatch-failed event with the error message",
    );
  });

  it("runReflector() itself never throws on a bad adapter/host (unit-level fire-and-forget check)", async () => {
    const cwd = track(makeTargetProject({ config: "routing:\n  default_host: nonexistent-host\n" }));
    const result = await runReflector({ cwd, pipelineRoot: path.join(cwd, "pipeline"), config: { learning: { reflector: true }, routing: { default_host: "nonexistent-host", roles: {} } } });
    assert.equal(result.ok, false);
    assert.match(result.reason, /nonexistent-host/);
  });
});

describe("roles/reflector.md: prompt-budget discipline (~1 page)", () => {
  it("stays within a single-page byte budget", () => {
    const bytes = fs.statSync(path.join(REPO_ROOT, "roles", "reflector.md")).size;
    assert.ok(bytes < 4000, `roles/reflector.md is ${bytes} bytes — expected a ~1-page brief (<4000 bytes)`);
  });
});
