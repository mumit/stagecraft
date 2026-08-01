const { describe, it, afterEach } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { REPO_ROOT, makeTargetProject, seedGate, cleanup, runCLI } = require("./_helpers");

const patterns = require(path.join(REPO_ROOT, "core", "patterns"));
const { buildDescriptor, runStage, runStageHeadless } = require(path.join(REPO_ROOT, "core", "orchestrator"));
const { getStage } = require(path.join(REPO_ROOT, "core", "pipeline", "stages"));
const generic = require(path.join(REPO_ROOT, "hosts", "generic", "adapter"));

let dirs = [];
function track(cwd) { dirs.push(cwd); return cwd; }
afterEach(() => { dirs.forEach(cleanup); dirs = []; });

function seedArchivedGate(cwd, fileName, gate) {
  const dir = path.join(cwd, "pipeline", "gates", "archive");
  fs.mkdirSync(dir, { recursive: true });
  const finalGate = {
    stage: gate.stage || "stage-06c",
    orchestrator: "devteam@test",
    track: "full",
    timestamp: "2026-05-26T20:00:00Z",
    blockers: [],
    warnings: [],
    status: "FAIL",
    ...gate,
  };
  fs.writeFileSync(path.join(dir, fileName), JSON.stringify(finalGate, null, 2));
}

describe("patterns: collection and promotion", () => {
  it("collects sanitized blocker, warning, and follow-up observations idempotently", () => {
    const cwd = track(makeTargetProject());
    fs.writeFileSync(path.join(cwd, "go.mod"), "module example.com/token\n\ngo 1.22\n", "utf8");
    seedGate(cwd, "stage-06c", {
      status: "FAIL",
      blockers: [{
        signal: "estimate_unhandled_exception",
        assigned_to: "backend",
        note: "No matching structured ERROR log event or exception handler was found in src/backend/main.go.",
      }],
      warnings: ["Tests passed, but only happy path was covered."],
      noted_for_followup: [{ id: "QA-EDGE-01", track_for: "lessons-learned", summary: "Prefer table-driven edge tests." }],
    });

    const first = patterns.collect({ cwd });
    const second = patterns.collect({ cwd });
    assert.equal(first.added, 3);
    assert.equal(second.added, 0);

    const observations = patterns.readObservations(cwd);
    assert.equal(observations.length, 3);
    assert.ok(observations.some((item) => item.tier === "blocker"));
    assert.ok(observations.some((item) => item.tier === "warning"));
    assert.ok(observations.some((item) => item.tier === "nudge"));
    const serialized = JSON.stringify(observations);
    assert.doesNotMatch(serialized, /src\/backend\/main\.go/);
    assert.doesNotMatch(serialized, /No matching structured ERROR log/);
  });

  it("collects archived failure gates created during auto-retry", () => {
    const cwd = track(makeTargetProject());
    seedGate(cwd, "stage-06c", { status: "PASS", blockers: [], warnings: [] });
    seedArchivedGate(cwd, "stage-06c.attempt-1.json", {
      stage: "stage-06c",
      blockers: [{ signal: "estimate_unhandled_exception", assigned_to: "backend" }],
    });
    fs.writeFileSync(path.join(cwd, "pipeline", "run-log.jsonl"), JSON.stringify({
      outcome: "fix-retry",
      stage: "stage-06c",
      target: "backend",
    }) + "\n");

    const result = patterns.collect({ cwd });
    assert.equal(result.added, 1);
    const observations = patterns.readObservations(cwd);
    assert.equal(observations.length, 1);
    assert.equal(observations[0].domain, "observability");
    assert.equal(observations[0].resolved_by_retry, true);
  });

  it("promotes reviewed text and selects it for a relevant backend descriptor", () => {
    const cwd = track(makeTargetProject());
    fs.writeFileSync(path.join(cwd, "go.mod"), "module example.com/token\n\ngo 1.22\n", "utf8");
    seedGate(cwd, "stage-06c", {
      status: "FAIL",
      blockers: [{ signal: "estimate_unhandled_exception", assigned_to: "backend" }],
    });
    patterns.collect({ cwd });
    const candidate = patterns.list({ cwd }).candidates[0];

    const promoted = patterns.promote({
      cwd,
      candidateId: candidate.id,
      text: "For Go backend services, add structured ERROR logging on failed request and exception paths before Stage 06c.",
    });
    assert.equal(promoted.status, "promoted");

    const descriptor = buildDescriptor(getStage("build"), "backend", { workstreamId: "stage-04.backend" });
    const selected = patterns.selectForDescriptor({
      cwd,
      descriptor,
      ctx: { cwd, feature: "add token estimator HTTP endpoint" },
    });
    assert.equal(selected.length, 1);
    assert.match(selected[0].prompt_text, /structured ERROR logging/);
  });

  it("rejects secret-shaped promoted prompt text", () => {
    const cwd = track(makeTargetProject());
    seedGate(cwd, "stage-06c", {
      status: "FAIL",
      blockers: [{ signal: "missing_log", assigned_to: "backend" }],
    });
    patterns.collect({ cwd });
    const candidate = patterns.list({ cwd }).candidates[0];
    assert.throws(
      () => patterns.promote({ cwd, candidateId: candidate.id, text: "Use token ghp_123456789012345678901234567890123456." }),
      /secret-shaped/,
    );
  });

  it("retired patterns are not selected for injection", () => {
    const cwd = track(makeTargetProject());
    seedGate(cwd, "stage-06c", {
      status: "FAIL",
      blockers: [{ signal: "missing_log", assigned_to: "backend" }],
    });
    patterns.collect({ cwd });
    const candidate = patterns.list({ cwd }).candidates[0];
    const promoted = patterns.promote({ cwd, candidateId: candidate.id });
    patterns.retire({ cwd, patternId: promoted.id });

    const descriptor = buildDescriptor(getStage("build"), "backend", { workstreamId: "stage-04.backend" });
    const selected = patterns.selectForDescriptor({ cwd, descriptor, ctx: { cwd, feature: "api endpoint" } });
    assert.equal(selected.length, 0);
  });

  it("collect() suppresses a retired pattern_key so it never re-enters candidates (30.1)", () => {
    const cwd = track(makeTargetProject());
    seedGate(cwd, "stage-06c", {
      status: "FAIL",
      blockers: [{ signal: "missing_log", assigned_to: "backend" }],
    });
    const first = patterns.collect({ cwd });
    assert.equal(first.suppressed, 0);
    assert.equal(first.candidates, 1);

    const candidate = patterns.list({ cwd }).candidates[0];
    const promoted = patterns.promote({ cwd, candidateId: candidate.id });
    patterns.retire({ cwd, patternId: promoted.id });

    // The underlying observations are untouched by retire() — a re-collect over
    // the same gate must not resurrect the retired pattern_key as a candidate.
    const second = patterns.collect({ cwd });
    assert.equal(second.candidates, 0, "retired pattern_key must not reappear as a candidate");
    assert.equal(second.suppressed, 1, "the suppressed candidate must be counted in the collect summary");

    const pendingPath = path.join(cwd, ".devteam", "patterns", "pending-review.json");
    const pending = JSON.parse(fs.readFileSync(pendingPath, "utf8"));
    assert.ok(
      !pending.candidates.some((c) => c.id === promoted.id),
      "pending-review.json must not list the retired pattern_key",
    );
  });
});

describe("patterns: CLI and prompt rendering", () => {
  it("devteam patterns collect/review/promote/stats works end-to-end", () => {
    const cwd = track(makeTargetProject());
    seedGate(cwd, "stage-07", {
      status: "FAIL",
      blockers: ["GET /hello endpoint has no README documentation."],
    });
    const collect = runCLI(["patterns", "collect"], { cwd });
    assert.equal(collect.status, 0, collect.stderr);
    assert.match(collect.stdout, /Collected 1 new pattern observation/);

    const review = runCLI(["patterns", "review"], { cwd });
    assert.equal(review.status, 0, review.stderr);
    assert.match(review.stdout, /Pattern candidates/);
    const id = review.stdout.match(/^([a-z0-9-]+)\s+\[/m)[1];

    const promote = runCLI(["patterns", "promote", id, "--text", "Document user-visible HTTP endpoints during implementation."], { cwd });
    assert.equal(promote.status, 0, promote.stderr);
    assert.match(promote.stdout, new RegExp(`Promoted ${id}`));

    const stats = runCLI(["patterns", "stats"], { cwd });
    assert.equal(stats.status, 0, stats.stderr);
    assert.match(stats.stdout, /Promoted:\s+1/);
  });

  it("rendered prompts include promoted known project patterns", () => {
    const cwd = track(makeTargetProject());
    seedGate(cwd, "stage-06c", {
      status: "FAIL",
      blockers: [{ signal: "missing_log", assigned_to: "backend" }],
    });
    patterns.collect({ cwd });
    const candidate = patterns.list({ cwd }).candidates[0];
    patterns.promote({ cwd, candidateId: candidate.id, text: "Add structured backend error logs before the observability gate." });

    const descriptor = buildDescriptor(getStage("build"), "backend", { workstreamId: "stage-04.backend" });
    descriptor.knownPatterns = patterns.selectForDescriptor({ cwd, descriptor, ctx: { cwd, feature: "add HTTP endpoint" } });
    const prompt = generic.renderStagePrompt(descriptor, { cwd, track: "full", orchestrator: "test", feature: "add HTTP endpoint" });
    assert.match(prompt, /Known Project Patterns/);
    assert.match(prompt, /structured backend error logs/);
  });
});

// 30.5: serialize promoted patterns to the Agent Skills open standard.
describe("patterns: 30.5 SKILL.md export", () => {
  const SKILL_NAME_RE = /^[a-z0-9]+(-[a-z0-9]+)*$/;

  function promoteTwoDomains(cwd) {
    seedGate(cwd, "stage-06c", {
      status: "FAIL",
      blockers: [{ signal: "missing_log", assigned_to: "backend" }],
    });
    seedGate(cwd, "stage-07", {
      status: "FAIL",
      blockers: ["GET /hello endpoint has no README documentation."],
    });
    patterns.collect({ cwd });
    const candidates = patterns.list({ cwd }).candidates;
    const observability = candidates.find((c) => c.domain === "observability");
    const docs = candidates.find((c) => c.domain === "docs");
    patterns.promote({ cwd, candidateId: observability.id, text: "Add structured backend error logs before the observability gate." });
    patterns.promote({ cwd, candidateId: docs.id, text: "Document user-visible HTTP endpoints during implementation." });
  }

  it("produces a spec-conformant SKILL.md (name/description constraints, directory-name match)", () => {
    const cwd = track(makeTargetProject());
    promoteTwoDomains(cwd);

    const result = patterns.exportSkill({ cwd });
    assert.equal(result.patternCount, 2);
    assert.deepEqual(result.domains, ["docs", "observability"]);
    assert.ok(fs.existsSync(result.file));

    const content = fs.readFileSync(result.file, "utf8");
    const fm = content.match(/^---\n([\s\S]*?)\n---\n/);
    assert.ok(fm, "SKILL.md must start with YAML frontmatter");
    const nameMatch = fm[1].match(/^name:\s*(.+)$/m);
    const descMatch = fm[1].match(/^description:\s*(.+)$/m);
    assert.ok(nameMatch, "frontmatter must have a name field");
    assert.ok(descMatch, "frontmatter must have a description field");

    const name = nameMatch[1].trim();
    assert.ok(name.length >= 1 && name.length <= 64, "name must be 1-64 chars");
    assert.match(name, SKILL_NAME_RE, "name must be lowercase alnum/hyphen, no leading/trailing/consecutive hyphen");
    assert.equal(name, path.basename(result.dir), "name must match the parent directory name");

    const description = JSON.parse(descMatch[1].trim());
    assert.ok(description.length >= 1 && description.length <= 1024, "description must be 1-1024 chars");

    assert.match(content, /Generated by devteam patterns export; regenerate to update; do not hand-edit\./);
    assert.match(content, /## Observability/);
    assert.match(content, /## Docs/);
    assert.match(content, /structured backend error logs/);
    assert.match(content, /Document user-visible HTTP endpoints/);
  });

  it("re-export over an existing dir is byte-identical (idempotent)", () => {
    const cwd = track(makeTargetProject());
    promoteTwoDomains(cwd);

    const first = patterns.exportSkill({ cwd });
    const firstBytes = fs.readFileSync(first.file);
    const second = patterns.exportSkill({ cwd });
    const secondBytes = fs.readFileSync(second.file);
    assert.equal(first.file, second.file);
    assert.ok(firstBytes.equals(secondBytes), "re-export must produce byte-identical output when promoted.json is unchanged");
  });

  it("--out is treated as a parent directory: skill always lands at <out>/learned-patterns/", () => {
    const cwd = track(makeTargetProject());
    promoteTwoDomains(cwd);
    const result = patterns.exportSkill({ cwd, outDir: "custom-export" });
    assert.equal(result.dir, path.join(cwd, "custom-export", "learned-patterns"));
    assert.ok(fs.existsSync(path.join(cwd, "custom-export", "learned-patterns", "SKILL.md")));
  });

  it("secret-scan blocks a poisoned promoted pattern and does not write the file", () => {
    const cwd = track(makeTargetProject());
    // Bypass promote()'s own secret-scan to simulate a promoted.json that was
    // hand-edited (or predates the scan) — export must independently catch it.
    fs.mkdirSync(path.join(cwd, ".devteam", "patterns"), { recursive: true });
    fs.writeFileSync(
      path.join(cwd, ".devteam", "patterns", "promoted.json"),
      JSON.stringify({
        schema_version: "1.0",
        patterns: [{
          id: "poisoned-pattern",
          status: "promoted",
          tier: "warning",
          domain: "security",
          prompt_text: "Use AKIAABCDEFGHIJKLMNOP as the shared test credential.",
          evidence: { observations: 1, last_reinforced: "2026-07-01" },
          stats: { injected: 0, recurrence_after_injection: 0, noise_reports: 0 },
        }],
      }, null, 2),
    );

    assert.throws(() => patterns.exportSkill({ cwd }), /secret-shaped/);
    assert.ok(!fs.existsSync(path.join(cwd, ".devteam", "learned-patterns", "SKILL.md")));
  });

  it("CLI: devteam patterns export --skill writes the file and reports the path", () => {
    const cwd = track(makeTargetProject());
    promoteTwoDomains(cwd);
    const r = runCLI(["patterns", "export", "--skill"], { cwd });
    assert.equal(r.status, 0, r.stderr);
    assert.match(r.stdout, /Exported 2 promoted pattern\(s\)/);
    assert.ok(fs.existsSync(path.join(cwd, ".devteam", "learned-patterns", "SKILL.md")));
  });

  it("CLI: devteam patterns export without --skill errors with exit code 2", () => {
    const cwd = track(makeTargetProject());
    const r = runCLI(["patterns", "export"], { cwd });
    assert.equal(r.status, 2);
    assert.match(r.stderr, /--skill/);
  });
});

// 30.2: wire the previously-inert stats.injected / recurrence_after_injection
// counters and the operator-only demotion flow.
describe("patterns: 30.2 outcome-feedback counters", () => {
  function claudeCodeConfig() {
    return "routing:\n  default_host: claude-code\npipeline:\n  default_track: full\n";
  }

  // Minimal claude-code stub: writes a PASS gate for the requested role and
  // exits 0. Mirrors the pattern used in tests/orchestrator.test.js.
  function makeHeadlessStub(role) {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "devteam-test-patterns-stub-"));
    dirs.push(dir);
    const script = path.join(dir, "stub.js");
    fs.writeFileSync(script, `const fs = require("node:fs");
const path = require("node:path");
const gatesDir = path.join(process.cwd(), "pipeline", "gates");
fs.mkdirSync(gatesDir, { recursive: true });
fs.writeFileSync(path.join(gatesDir, "stage-04.${role}.json"), JSON.stringify({
  stage: "stage-04", workstream: "${role}", host: "claude-code", status: "PASS",
  track: "full", blockers: [], warnings: [], orchestrator: "devteam@test",
  timestamp: "2026-07-31T00:00:00.000Z"
}, null, 2) + "\\n");
`, "utf8");
    return script;
  }

  function promoteBackendPattern(cwd, text) {
    seedGate(cwd, "stage-06c", {
      status: "FAIL",
      blockers: [{ signal: "missing_log", assigned_to: "backend" }],
    });
    patterns.collect({ cwd });
    const candidate = patterns.list({ cwd }).candidates[0];
    return patterns.promote({ cwd, candidateId: candidate.id, text });
  }

  it("a real headless dispatch increments stats.injected exactly once; a preview-only runStage() call never does", async () => {
    const cwd = track(makeTargetProject({ config: claudeCodeConfig() }));
    const promoted = promoteBackendPattern(cwd, "Add structured backend error logs before the observability gate.");
    assert.equal(promoted.stats.injected, 0);

    // Preview/render-only path (what `devteam reproduce` / `devteam replay
    // --dry-run` do): renders the prompt but never dispatches it anywhere.
    const previewPlan = runStage("build", { cwd, feature: "add HTTP endpoint", workstream: ["backend"] });
    assert.ok(previewPlan.workstreams[0].descriptor.knownPatterns.length > 0, "sanity: pattern was actually selected");
    assert.equal(patterns.list({ cwd }).promoted[0].stats.injected, 0, "a preview render must NOT increment stats.injected");

    const script = makeHeadlessStub("backend");
    const previous = process.env.DEVTEAM_HEADLESS_COMMAND;
    process.env.DEVTEAM_HEADLESS_COMMAND = `"${process.execPath}" "${script}"`;
    try {
      const result = await runStageHeadless("build", { cwd, feature: "add HTTP endpoint", workstream: ["backend"] });
      assert.equal(result.results.length, 1);
      assert.equal(result.results[0].exitCode, 0);
    } finally {
      if (previous === undefined) delete process.env.DEVTEAM_HEADLESS_COMMAND;
      else process.env.DEVTEAM_HEADLESS_COMMAND = previous;
    }

    assert.equal(patterns.list({ cwd }).promoted[0].stats.injected, 1, "one real dispatch must increment stats.injected exactly once");

    const runLog = fs.readFileSync(path.join(cwd, "pipeline", "run-log.jsonl"), "utf8");
    const injectedEvents = runLog.split("\n").filter(Boolean).map((l) => JSON.parse(l)).filter((e) => e.outcome === "pattern-injected");
    assert.equal(injectedEvents.length, 1);
    assert.equal(injectedEvents[0].stage, "stage-04");
    assert.deepEqual(injectedEvents[0].pattern_ids, [promoted.id]);
  });

  it("a seeded recurrence scenario flags a promoted pattern as a demotion candidate in `devteam patterns review`", () => {
    const cwd = track(makeTargetProject());
    const promoted = promoteBackendPattern(cwd, "Add structured backend error logs before the observability gate.");

    // Simulate three separate dispatch attempts where the pattern was
    // injected and the same blocker recurred anyway: each archived attempt
    // is a distinct gate file, so each counts once toward recurrence.
    patterns.recordInjection({ cwd, stage: "stage-06c", workstreamId: "stage-06c.backend", patterns: [{ id: promoted.id }] });
    const gatesDir = path.join(cwd, "pipeline", "gates");
    const archiveDir = path.join(gatesDir, "archive");
    fs.mkdirSync(archiveDir, { recursive: true });
    fs.copyFileSync(path.join(gatesDir, "stage-06c.json"), path.join(archiveDir, "stage-06c.attempt-1.json"));
    fs.copyFileSync(path.join(gatesDir, "stage-06c.json"), path.join(archiveDir, "stage-06c.attempt-2.json"));

    const result = patterns.collect({ cwd });
    assert.equal(result.recurrenceFlagged, 3, "current gate + 2 archived attempts = 3 distinct recurrences");
    assert.equal(patterns.list({ cwd }).promoted[0].stats.recurrence_after_injection, 3);

    const review = runCLI(["patterns", "review"], { cwd });
    assert.equal(review.status, 0, review.stderr);
    assert.match(review.stdout, /demotion candidate/);
    assert.match(review.stdout, new RegExp(`devteam patterns demote ${promoted.id}`));

    // Re-running collect() over the same (unchanged) gate files must not
    // double-count the recurrence.
    const second = patterns.collect({ cwd });
    assert.equal(second.recurrenceFlagged, 0);
    assert.equal(patterns.list({ cwd }).promoted[0].stats.recurrence_after_injection, 3);
  });

  it("demote then re-promote round-trips: pattern returns to candidate, stops being injected, and history survives re-promotion", () => {
    const cwd = track(makeTargetProject());
    const promoted = promoteBackendPattern(cwd, "Add structured backend error logs before the observability gate.");
    patterns.recordInjection({ cwd, stage: "stage-04", workstreamId: "stage-04.backend", patterns: [{ id: promoted.id }] });

    const demoted = patterns.demote({ cwd, patternId: promoted.id, operator: "alice", reason: "too noisy" });
    assert.equal(demoted.status, "candidate");
    assert.equal(demoted.demotion_history.length, 1);
    assert.equal(demoted.demotion_history[0].demoted_by, "alice");
    assert.equal(demoted.demotion_history[0].reason, "too noisy");
    assert.equal(demoted.demotion_history[0].counters_at_demotion.injected, 1);

    // A demoted pattern must stop being selected for injection.
    const descriptor = buildDescriptor(getStage("build"), "backend", { workstreamId: "stage-04.backend" });
    const selected = patterns.selectForDescriptor({ cwd, descriptor, ctx: { cwd, feature: "add HTTP endpoint" } });
    assert.equal(selected.length, 0);
    assert.equal(patterns.list({ cwd }).promoted.length, 0);
    assert.equal(patterns.list({ cwd }).demoted.length, 1);

    const rePromoted = patterns.promote({ cwd, candidateId: promoted.id });
    assert.equal(rePromoted.status, "promoted");
    assert.equal(rePromoted.demotion_history.length, 1, "demotion audit history must survive re-promotion");
    assert.equal(rePromoted.demotion_history[0].demoted_by, "alice");
    assert.equal(patterns.list({ cwd }).demoted.length, 0);
    assert.equal(patterns.list({ cwd }).promoted.length, 1);

    const selectedAgain = patterns.selectForDescriptor({ cwd, descriptor, ctx: { cwd, feature: "add HTTP endpoint" } });
    assert.equal(selectedAgain.length, 1, "re-promoted pattern is selectable again");
  });

  it("counters persist across collect/promote cycles without clobbering sibling patterns", () => {
    const cwd = track(makeTargetProject());
    const first = promoteBackendPattern(cwd, "Add structured backend error logs before the observability gate.");
    patterns.recordInjection({ cwd, stage: "stage-04", workstreamId: "stage-04.backend", patterns: [{ id: first.id }] });
    patterns.recordInjection({ cwd, stage: "stage-04", workstreamId: "stage-04.backend", patterns: [{ id: first.id }] });
    assert.equal(patterns.list({ cwd }).promoted[0].stats.injected, 2);

    // Promote an unrelated candidate — its own promote()/savePromoted() call
    // must not reset or clobber the first pattern's already-accumulated stats.
    seedGate(cwd, "stage-07", {
      status: "FAIL",
      blockers: ["GET /widgets endpoint has no README documentation."],
    });
    const collectResult = patterns.collect({ cwd });
    assert.equal(collectResult.candidates, 2);
    const secondCandidate = patterns.list({ cwd }).candidates.find((c) => c.domain === "docs");
    patterns.promote({ cwd, candidateId: secondCandidate.id, text: "Document new HTTP endpoints during implementation." });

    const afterSecondPromote = patterns.list({ cwd }).promoted;
    assert.equal(afterSecondPromote.length, 2);
    const firstAfter = afterSecondPromote.find((p) => p.id === first.id);
    assert.equal(firstAfter.stats.injected, 2, "unrelated promote() must not reset sibling stats");

    // collect() again (no new gates) must also leave stats untouched.
    patterns.collect({ cwd });
    assert.equal(patterns.list({ cwd }).promoted.find((p) => p.id === first.id).stats.injected, 2);
  });
});
