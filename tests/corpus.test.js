// core/corpus.js — run corpus: one sanitized JSONL record per headless
// dispatch, plus `devteam corpus stats` (phase-28 item 28.5,
// plans/phase-28-ground-truth-telemetry.md §28.5).

const { describe, it, afterEach } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { REPO_ROOT, makeTargetProject, cleanup, runCLI } = require("./_helpers");
const { runStageHeadless } = require(path.join(REPO_ROOT, "core", "orchestrator"));
const { computePromptPackVersion } = require(path.join(REPO_ROOT, "core", "prompt-pack"));
const corpus = require(path.join(REPO_ROOT, "core", "corpus"));
const { loadCorpusFrom } = require(path.join(REPO_ROOT, "scripts", "routing-suggest"));
const { aggregatePerformance, summarize } = require(path.join(REPO_ROOT, "scripts", "performance"));

let _dirs = [];
function track(cwd) { _dirs.push(cwd); return cwd; }
afterEach(() => { _dirs.forEach(cleanup); _dirs = []; });

function readCorpusLines(cwd) {
  const raw = fs.readFileSync(path.join(cwd, ".devteam", "corpus", "dispatches.jsonl"), "utf8");
  return raw.split("\n").filter((l) => l.trim().length > 0).map((l) => JSON.parse(l));
}

function withHeadlessCommand(cmd, fn) {
  const previous = process.env.DEVTEAM_HEADLESS_COMMAND;
  process.env.DEVTEAM_HEADLESS_COMMAND = cmd;
  return Promise.resolve().then(fn).finally(() => {
    if (previous === undefined) delete process.env.DEVTEAM_HEADLESS_COMMAND;
    else process.env.DEVTEAM_HEADLESS_COMMAND = previous;
  });
}

// A fake secret shaped like a GitHub personal token (ghp_ + 36 alnum chars) —
// matches core/hooks/secret-scan.js SECRET_PATTERNS without being a real key.
const FAKE_SECRET = `ghp_${"A".repeat(36)}`;

function makeCodexFailStub(dir) {
  const script = path.join(dir, "codex-fail-stub.js");
  fs.writeFileSync(script, `const fs = require("node:fs");
const path = require("node:path");
const gateFile = path.join(process.cwd(), "pipeline", "gates", "stage-01.json");
fs.writeFileSync(gateFile, JSON.stringify({
  stage: "stage-01", host: "codex", status: "FAIL", track: "full",
  blockers: ["leaked credential: ${FAKE_SECRET} in log output"],
  warnings: [], orchestrator: "devteam@test",
  timestamp: "2026-07-31T00:00:00.000Z"
}, null, 2) + "\\n");
process.stdout.write(JSON.stringify({type:"thread.started",thread_id:"t1"})+"\\n");
process.stdout.write(JSON.stringify({type:"turn.started"})+"\\n");
process.stdout.write(JSON.stringify({type:"item.completed",item:{id:"1",type:"agent_message",text:"blocked."}})+"\\n");
process.stdout.write(JSON.stringify({type:"turn.completed",usage:{input_tokens:222,output_tokens:33}})+"\\n");
`, "utf8");
  return script;
}

// Plain-text stub — codex's telemetry is "native", so with no turn.completed
// event, r.usage stays null and NEITHER patchGateForObservedUsage nor the
// estimate fallback runs. The gate is left exactly as the "model" wrote it,
// i.e. tokens_in/cost_usd here are model-asserted, not orchestrator-observed.
function makeDesignModelAssertedStub(dir) {
  const script = path.join(dir, "codex-design-stub.js");
  fs.writeFileSync(script, `const fs = require("node:fs");
const path = require("node:path");
const gateFile = path.join(process.cwd(), "pipeline", "gates", "stage-02.json");
fs.writeFileSync(gateFile, JSON.stringify({
  stage: "stage-02", host: "codex", status: "PASS", track: "full",
  blockers: [], warnings: [], orchestrator: "devteam@test",
  timestamp: "2026-07-31T00:00:00.000Z",
  model: "gpt-5-codex-self-reported", tokens_in: 800, tokens_out: 120, cost_usd: 0.05
}, null, 2) + "\\n");
process.stdout.write("plain text output, no --json turn.completed\\n");
`, "utf8");
  return script;
}

function codexConfig() {
  return "routing:\n  default_host: codex\npipeline:\n  default_track: full\n";
}

describe("corpus: recordDispatch via runStageHeadless (28.5)", () => {
  it("writes one sanitized JSONL record per headless dispatch, with correct fields", async () => {
    const cwd = track(makeTargetProject({ config: codexConfig() }));
    const stubDir = fs.mkdtempSync(path.join(os.tmpdir(), "devteam-test-corpus-stub-"));
    _dirs.push(stubDir);
    const failScript = makeCodexFailStub(stubDir);

    await withHeadlessCommand(`"${process.execPath}" "${failScript}"`, async () => {
      const result = await runStageHeadless("requirements", { cwd, runId: "run-abc" });
      assert.equal(result.results.length, 1);
      assert.equal(result.results[0].exitCode, 0);
    });

    const designScript = makeDesignModelAssertedStub(stubDir);
    await withHeadlessCommand(`"${process.execPath}" "${designScript}"`, async () => {
      const result = await runStageHeadless("design", { cwd, runId: "run-abc" });
      assert.equal(result.results.length, 1);
      assert.equal(result.results[0].exitCode, 0);
    });

    const lines = readCorpusLines(cwd);
    assert.equal(lines.length, 2, "one corpus line per dispatch");

    const [req, design] = lines;

    // Dispatch 1 — codex native usage observed, gate status FAIL, blocker
    // carries a planted secret that must be redacted before reaching disk.
    assert.equal(req.stage, "stage-01");
    assert.equal(req.role, "pm");
    assert.equal(req.host, "codex");
    // 33.3: prompt_pack_version is stamped onto every headless dispatch's
    // gate (core/orchestrator.js patchGateWithPromptPackVersion) and read
    // straight off it here — same value on both dispatches (the prompt
    // surface doesn't change mid-test-run).
    assert.equal(req.prompt_pack_version, computePromptPackVersion());
    assert.equal(req.track, "full");
    assert.equal(req.run_id, "run-abc");
    assert.match(req.prompt_hash, /^[0-9a-f]{64}$/, "prompt_hash is a sha256 hex digest");
    assert.ok(Number.isInteger(req.prompt_bytes) && req.prompt_bytes > 0);
    assert.equal(req.tokens_in, 222);
    assert.equal(req.tokens_out, 33);
    assert.equal(req.cost_usd, null, "codex reports no dollar cost natively");
    assert.equal(req.cost_basis, null);
    assert.ok(Number.isInteger(req.duration_ms) && req.duration_ms >= 0);
    assert.equal(typeof req.queue_ms, "number");
    assert.equal(req.gate_status, "FAIL");
    assert.equal(req.model_observed, null, "codex-exec-json never reports a model id");
    assert.equal(req.retry_of, null);
    assert.equal(req.framework_version, require(path.join(REPO_ROOT, "package.json")).version);
    assert.equal(Array.isArray(req.blockers), true);
    assert.equal(req.blockers.length, 1);
    assert.doesNotMatch(req.blockers[0], new RegExp(FAKE_SECRET), "raw secret must never reach disk");
    assert.match(req.blockers[0], /REDACTED/);

    // Raw file content, not just the parsed field, must never contain the secret.
    const raw = fs.readFileSync(path.join(cwd, ".devteam", "corpus", "dispatches.jsonl"), "utf8");
    assert.doesNotMatch(raw, new RegExp(FAKE_SECRET));

    // Dispatch 2 — model-asserted tokens/cost (no _orchestrator_observed at
    // all — codex telemetry is native but no usage event was emitted).
    assert.equal(design.stage, "stage-02");
    assert.equal(design.role, "principal");
    assert.equal(design.host, "codex");
    assert.equal(design.tokens_in, 800);
    assert.equal(design.tokens_out, 120);
    assert.equal(design.cost_usd, 0.05);
    assert.equal(design.cost_basis, "model-asserted");
    assert.equal(design.gate_status, "PASS");
    assert.equal(design.blockers, null, "empty blockers array normalizes to null");
    assert.equal(design.run_id, "run-abc");
  });

  // Phase-32 item 32.3: model_requested (orchestrator-set at dispatch time,
  // from routing.roles' {host, model} form) round-trips through the gate
  // into the corpus record — the substrate scripts/routing-suggest.js's
  // per-tier cost-delta section reads.
  it("32.3: records model_requested from the gate's orchestrator-stamped field", async () => {
    const cwd = track(makeTargetProject({
      config: [
        "routing:",
        "  default_host: generic",
        "  roles:",
        "    pm:",
        "      host: codex",
        "      model: gpt-5-mini",
        "pipeline:",
        "  default_track: full",
        "",
      ].join("\n"),
    }));
    const stubDir = fs.mkdtempSync(path.join(os.tmpdir(), "devteam-test-corpus-stub-"));
    _dirs.push(stubDir);
    const failScript = makeCodexFailStub(stubDir);

    await withHeadlessCommand(`"${process.execPath}" "${failScript}"`, async () => {
      const result = await runStageHeadless("requirements", { cwd, runId: "run-model-req" });
      assert.equal(result.results[0].exitCode, 0);
    });

    const [req] = readCorpusLines(cwd);
    assert.equal(req.model_requested, "gpt-5-mini");
  });

  // 33.3: recordDispatch reads prompt_pack_version straight off the gate
  // (already stamped by patchGateWithPromptPackVersion before recordDispatch
  // runs), same as model_requested above — no independent computation here.
  it("33.3: records prompt_pack_version from the gate, and null when absent", () => {
    const cwd = track(makeTargetProject());
    const gatesDir = path.join(cwd, "pipeline", "gates");
    fs.mkdirSync(gatesDir, { recursive: true });
    const withVersion = path.join(gatesDir, "stage-01.json");
    fs.writeFileSync(withVersion, JSON.stringify({
      stage: "stage-01", status: "PASS", prompt_pack_version: "abc123def456",
    }, null, 2));

    corpus.recordDispatch(cwd, { stage: "stage-01", role: "pm", host: "codex", gatePath: withVersion });

    const noVersion = path.join(gatesDir, "stage-02.json");
    fs.writeFileSync(noVersion, JSON.stringify({ stage: "stage-02", status: "PASS" }, null, 2));
    corpus.recordDispatch(cwd, { stage: "stage-02", role: "pm", host: "codex", gatePath: noVersion });

    const [withV, withoutV] = readCorpusLines(cwd);
    assert.equal(withV.prompt_pack_version, "abc123def456");
    assert.equal(withoutV.prompt_pack_version, null);
  });

  it("--skip-completed no-op dispatches are not recorded as corpus dispatches", async () => {
    const cwd = track(makeTargetProject({ config: codexConfig() }));
    // Pre-seed the gate so the dispatch is skipped entirely.
    const gatesDir = path.join(cwd, "pipeline", "gates");
    fs.mkdirSync(gatesDir, { recursive: true });
    fs.writeFileSync(path.join(gatesDir, "stage-01.json"), JSON.stringify({
      stage: "stage-01", host: "codex", status: "PASS", track: "full",
      blockers: [], warnings: [], orchestrator: "devteam@test",
      timestamp: "2026-07-31T00:00:00.000Z",
    }, null, 2));

    const result = await runStageHeadless("requirements", { cwd, skipCompleted: true });
    assert.equal(result.results[0].skipped, true);
    assert.equal(fs.existsSync(path.join(cwd, ".devteam", "corpus", "dispatches.jsonl")), false);
  });
});

describe("corpus: sanitizeBlockers (secret-scan reuse)", () => {
  it("redacts a blocker containing a secret-shaped string", () => {
    const out = corpus.sanitizeBlockers([`token leaked: ${FAKE_SECRET}`]);
    assert.equal(out.length, 1);
    assert.doesNotMatch(out[0], new RegExp(FAKE_SECRET));
    assert.match(out[0], /REDACTED/);
  });

  it("passes through ordinary blocker text unchanged", () => {
    const out = corpus.sanitizeBlockers(["lint failed (exit 1): npm run lint"]);
    assert.deepEqual(out, ["lint failed (exit 1): npm run lint"]);
  });

  it("stringifies non-string blocker entries before scanning", () => {
    const out = corpus.sanitizeBlockers([{ file: "a.js", text: `see ${FAKE_SECRET}` }]);
    assert.equal(out.length, 1);
    assert.doesNotMatch(out[0], new RegExp(FAKE_SECRET));
  });

  it("empty/absent blockers normalize to null", () => {
    assert.equal(corpus.sanitizeBlockers([]), null);
    assert.equal(corpus.sanitizeBlockers(undefined), null);
    assert.equal(corpus.sanitizeBlockers(null), null);
  });
});

describe("corpus: appendDispatchRecord fire-and-forget contract", () => {
  it("an unwritable corpus directory logs exactly one warning and never throws", () => {
    const cwd = track(makeTargetProject());
    // Force mkdirSync(.devteam/corpus, {recursive:true}) to fail: make
    // ".devteam/corpus" already exist as a plain file, not a directory.
    fs.writeFileSync(path.join(cwd, ".devteam", "corpus"), "not a directory");

    const stderrChunks = [];
    const originalWrite = process.stderr.write;
    process.stderr.write = (chunk) => { stderrChunks.push(String(chunk)); return true; };
    let result;
    try {
      assert.doesNotThrow(() => {
        result = corpus.appendDispatchRecord(cwd, { stage: "stage-01", role: "pm", host: "codex" });
      });
    } finally {
      process.stderr.write = originalWrite;
    }
    assert.equal(result.ok, false);
    const warnings = stderrChunks.filter((c) => c.includes("corpus"));
    assert.equal(warnings.length, 1, "exactly one warning logged, not a spam loop");
  });

  it("a headless dispatch still succeeds (and writes its gate) when the corpus directory is unwritable", async () => {
    const cwd = track(makeTargetProject({ config: codexConfig() }));
    fs.writeFileSync(path.join(cwd, ".devteam", "corpus"), "not a directory");
    const stubDir = fs.mkdtempSync(path.join(os.tmpdir(), "devteam-test-corpus-stub2-"));
    _dirs.push(stubDir);
    const script = makeCodexFailStub(stubDir);

    await withHeadlessCommand(`"${process.execPath}" "${script}"`, async () => {
      const result = await runStageHeadless("requirements", { cwd });
      assert.equal(result.results[0].exitCode, 0);
      const gate = JSON.parse(fs.readFileSync(result.results[0].gatePath, "utf8"));
      assert.equal(gate.status, "FAIL");
    });
  });
});

describe("corpus: computeStats aggregates a fixture corpus", () => {
  function seedCorpus(cwd, records) {
    const dir = path.join(cwd, ".devteam", "corpus");
    fs.mkdirSync(dir, { recursive: true });
    const lines = records.map((r) => JSON.stringify(r)).join("\n") + "\n";
    fs.writeFileSync(path.join(dir, "dispatches.jsonl"), lines, "utf8");
  }

  it("computes total dispatches, per-stage pass rates, and per-(role,host) counts", () => {
    const cwd = track(makeTargetProject());
    seedCorpus(cwd, [
      { stage: "stage-01", role: "pm", host: "codex", gate_status: "PASS" },
      { stage: "stage-01", role: "pm", host: "codex", gate_status: "PASS" },
      { stage: "stage-01", role: "pm", host: "codex", gate_status: "FAIL" },
      { stage: "stage-04", role: "backend", host: "claude-code", gate_status: "PASS" },
      { stage: "stage-04", role: "backend", host: "claude-code", gate_status: "WARN" },
    ]);
    // Append one genuinely malformed line — a partial write (e.g. a crash
    // mid-append) must not break stats for the well-formed lines around it.
    const file = path.join(cwd, ".devteam", "corpus", "dispatches.jsonl");
    fs.appendFileSync(file, "{ not valid json\n");

    const stats = corpus.computeStats(cwd);
    assert.equal(stats.total_dispatches, 5, "malformed line is skipped, not counted");

    const stage01 = stats.stages.find((s) => s.stage === "stage-01");
    assert.equal(stage01.total, 3);
    assert.equal(stage01.pass, 2);
    assert.equal(stage01.fail, 1);
    assert.equal(Math.round(stage01.pass_rate), 67);

    const stage04 = stats.stages.find((s) => s.stage === "stage-04");
    assert.equal(stage04.total, 2);
    assert.equal(stage04.pass_rate, 100, "WARN counts toward pass rate alongside PASS");

    const pmCodex = stats.role_host.find((rh) => rh.role === "pm" && rh.host === "codex");
    assert.equal(pmCodex.dispatches, 3);
    assert.equal(pmCodex.meets_d5_threshold, false, "3 < the D5 minimum of 5");

    const backendClaude = stats.role_host.find((rh) => rh.role === "backend" && rh.host === "claude-code");
    assert.equal(backendClaude.dispatches, 2);
  });

  it("devteam corpus stats --json exposes the same aggregation over the CLI", () => {
    const cwd = track(makeTargetProject());
    seedCorpus(cwd, [
      { stage: "stage-01", role: "pm", host: "codex", gate_status: "PASS" },
      { stage: "stage-01", role: "pm", host: "codex", gate_status: "PASS" },
    ]);
    const r = runCLI(["corpus", "stats", "--json"], { cwd });
    assert.equal(r.status, 0, r.stderr);
    const parsed = JSON.parse(r.stdout);
    assert.equal(parsed.total_dispatches, 2);
    assert.equal(parsed.stages[0].stage, "stage-01");
  });

  it("devteam corpus stats (text) reports totals and the D5 threshold marker", () => {
    const cwd = track(makeTargetProject());
    seedCorpus(cwd, Array.from({ length: 5 }, () => (
      { stage: "stage-01", role: "pm", host: "codex", gate_status: "PASS" }
    )));
    const r = runCLI(["corpus", "stats"], { cwd });
    assert.equal(r.status, 0, r.stderr);
    assert.match(r.stdout, /Total dispatches: 5/);
    assert.match(r.stdout, /meets D5 threshold/);
  });

  it("reports zero dispatches gracefully when no corpus file exists yet", () => {
    const cwd = track(makeTargetProject());
    const stats = corpus.computeStats(cwd);
    assert.deepEqual(stats.stages, []);
    assert.deepEqual(stats.role_host, []);
    assert.equal(stats.total_dispatches, 0);
  });
});

describe("corpus: wired into scripts/routing-suggest.js as an additional source (28.5)", () => {
  it("loadCorpusFrom shapes corpus records for aggregatePerformance alongside gate archives", () => {
    const cwd = track(makeTargetProject());
    const dir = path.join(cwd, ".devteam", "corpus");
    fs.mkdirSync(dir, { recursive: true });
    const records = [
      { ts: "2026-07-01T00:00:00Z", stage: "stage-04", role: "backend", host: "codex", gate_status: "PASS", cost_usd: 0.02, duration_ms: 1000, model_observed: "gpt-5" },
      { ts: "2026-07-02T00:00:00Z", stage: "stage-04", role: "backend", host: "codex", gate_status: "FAIL", cost_usd: 0.03, duration_ms: 1200, model_observed: "gpt-5" },
      { ts: "2026-07-03T00:00:00Z", stage: "stage-04", role: null, host: null, gate_status: "PASS" }, // no role/host — must be dropped
    ];
    fs.writeFileSync(path.join(dir, "dispatches.jsonl"), records.map((r) => JSON.stringify(r)).join("\n") + "\n");

    const workstreams = loadCorpusFrom(cwd);
    assert.equal(workstreams.length, 2, "records missing role/host are excluded");
    assert.equal(workstreams[0].workstream, "backend");
    assert.equal(workstreams[0].host, "codex");
    assert.equal(workstreams[0].status, "PASS");

    const summaries = [...aggregatePerformance(workstreams).values()].map(summarize);
    const backendCodex = summaries.find((s) => s.role === "backend" && s.host === "codex");
    assert.equal(backendCodex.total_dispatches, 2);
    assert.equal(backendCodex.pass, 1);
    assert.equal(backendCodex.fail, 1);
  });

  it("returns an empty array when a project has no corpus yet", () => {
    const cwd = track(makeTargetProject());
    assert.deepEqual(loadCorpusFrom(cwd), []);
  });
});
