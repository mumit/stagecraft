// core/adapters/headless.js — shared headless-invoke helper.
//
// runHeadless(adapter, descriptor, ctx) wraps spawn() + stdin pipe + gate
// detection. These tests cover the contract every host adapter relies on:
//
//   - Resolves capabilities.headlessCommand correctly
//   - DEVTEAM_HEADLESS_COMMAND overrides the declared command
//   - Throws (rejects) when no headlessCommand is available
//   - Returns the spawned process's exit code
//   - gatePath is set when the workstream gate exists, null otherwise
//   - Spawn ENOENT (binary not on PATH) rejects with a clear message
//   - Stdin EPIPE (child exits before reading) is swallowed, not propagated
//
// We stub the command via DEVTEAM_HEADLESS_COMMAND so the tests never touch
// a real model — `true` for clean exit, `false` for non-zero, `cat` to echo
// the prompt, `sh -c ...` for richer control.

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { runHeadless, rotateLog, createTranscriptWriter } = require("../core/adapters/headless");

function makeAdapter({ headlessCommand = "true", name = "test-host" } = {}) {
  return {
    capabilities: { name, headlessCommand },
    renderStagePrompt: (descriptor) =>
      `# stage ${descriptor.stage} (${descriptor.workstreamId})\nprompt body\n`,
  };
}

function makeCtx(overrides = {}) {
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "headless-test-"));
  fs.mkdirSync(path.join(cwd, "pipeline", "gates"), { recursive: true });
  return { track: "full", feature: "test", cwd, isolation: "in-place", ...overrides };
}

function makeDescriptor(workstreamId = "stage-01") {
  return {
    stage: "stage-01",
    name: "requirements",
    role: "pm",
    rolesInStage: ["pm"],
    workstreamId,
    objective: "test objective",
    readFirst: [],
    allowedWrites: [],
    artifact: "pipeline/brief.md",
    template: "brief-template.md",
    expectedGate: {},
  };
}

function withEnv(key, value, fn) {
  const prev = process.env[key];
  if (value === undefined) delete process.env[key];
  else process.env[key] = value;
  return Promise.resolve(fn()).finally(() => {
    if (prev === undefined) delete process.env[key];
    else process.env[key] = prev;
  });
}

async function captureStdoutStderr(fn) {
  const stdoutChunks = [];
  const stderrChunks = [];
  const origStdout = process.stdout.write.bind(process.stdout);
  const origStderr = process.stderr.write.bind(process.stderr);
  process.stdout.write = (chunk, ...rest) => {
    stdoutChunks.push(Buffer.isBuffer(chunk) ? chunk.toString("utf8") : String(chunk));
    const cb = rest.find((arg) => typeof arg === "function");
    if (cb) cb();
    return true;
  };
  process.stderr.write = (chunk, ...rest) => {
    stderrChunks.push(Buffer.isBuffer(chunk) ? chunk.toString("utf8") : String(chunk));
    const cb = rest.find((arg) => typeof arg === "function");
    if (cb) cb();
    return true;
  };
  try {
    const result = await fn();
    return {
      result,
      stdout: stdoutChunks.join(""),
      stderr: stderrChunks.join(""),
    };
  } finally {
    process.stdout.write = origStdout;
    process.stderr.write = origStderr;
  }
}

test("resolves capabilities.headlessCommand and exits with the child's code", async () => {
  const ctx = makeCtx();
  try {
    const r = await withEnv("DEVTEAM_HEADLESS_COMMAND", undefined, () =>
      runHeadless(makeAdapter({ headlessCommand: "true" }), makeDescriptor(), ctx),
    );
    assert.equal(r.exitCode, 0);
    assert.equal(r.gatePath, null, "no gate file was written, so gatePath is null");
    assert.ok(typeof r.durationMs === "number" && r.durationMs >= 0);
  } finally {
    fs.rmSync(ctx.cwd, { recursive: true, force: true });
  }
});

test("DEVTEAM_HEADLESS_COMMAND overrides the adapter's declared headlessCommand", async () => {
  const ctx = makeCtx();
  try {
    // The adapter declares 'this-command-does-not-exist'; the env var redirects to 'true'.
    const r = await withEnv("DEVTEAM_HEADLESS_COMMAND", "true", () =>
      runHeadless(makeAdapter({ headlessCommand: "this-command-does-not-exist" }), makeDescriptor(), ctx),
    );
    assert.equal(r.exitCode, 0);
  } finally {
    fs.rmSync(ctx.cwd, { recursive: true, force: true });
  }
});

test("rejects when neither the adapter nor the env var declares a headlessCommand", async () => {
  const ctx = makeCtx();
  // Note: pass null (not undefined) — destructuring defaults swallow undefined,
  // which would silently fall back to "true" and mask the missing-command path.
  try {
    await withEnv("DEVTEAM_HEADLESS_COMMAND", undefined, () =>
      assert.rejects(
        () => runHeadless(makeAdapter({ headlessCommand: null }), makeDescriptor(), ctx),
        /declares no headlessCommand/,
      ),
    );
  } finally {
    fs.rmSync(ctx.cwd, { recursive: true, force: true });
  }
});

test("returns the non-zero exit code when the headless command fails", async () => {
  const ctx = makeCtx();
  try {
    const r = await withEnv("DEVTEAM_HEADLESS_COMMAND", "false", () =>
      runHeadless(makeAdapter(), makeDescriptor(), ctx),
    );
    assert.notEqual(r.exitCode, 0);
    assert.equal(r.gatePath, null);
  } finally {
    fs.rmSync(ctx.cwd, { recursive: true, force: true });
  }
});

test("rejects with a clear message when the headless binary is not on PATH", async () => {
  const ctx = makeCtx();
  try {
    await withEnv("DEVTEAM_HEADLESS_COMMAND", "stagecraft-no-such-binary-xyzzy", () =>
      assert.rejects(
        () => runHeadless(makeAdapter(), makeDescriptor(), ctx),
        (err) => {
          assert.match(err.message, /failed to spawn/);
          assert.match(err.message, /Is .* installed and on PATH/);
          return true;
        },
      ),
    );
  } finally {
    fs.rmSync(ctx.cwd, { recursive: true, force: true });
  }
});

test("returns gatePath when the workstream gate file exists in pipeline/gates/", async () => {
  const ctx = makeCtx();
  const desc = makeDescriptor("stage-04.backend");
  // Pre-seed the gate file so the post-spawn existsSync check finds it.
  const gateFile = path.join(ctx.cwd, "pipeline", "gates", `${desc.workstreamId}.json`);
  fs.writeFileSync(gateFile, JSON.stringify({ stage: "stage-04", status: "PASS" }));
  try {
    const r = await withEnv("DEVTEAM_HEADLESS_COMMAND", "true", () =>
      runHeadless(makeAdapter(), desc, ctx),
    );
    assert.equal(r.exitCode, 0);
    assert.equal(r.gatePath, gateFile);
    assert.equal(r.stubGate, false, "real gate should not be flagged as stub");
  } finally {
    fs.rmSync(ctx.cwd, { recursive: true, force: true });
  }
});

test("stub gate detection: pre-seeded _stub:true gate → stubGate:true, gatePath:null", async () => {
  const ctx = makeCtx();
  const desc = makeDescriptor("stage-04c");
  const gateFile = path.join(ctx.cwd, "pipeline", "gates", `${desc.workstreamId}.json`);
  // Simulate driver pre-seeding a stub gate that the LLM never overwrote.
  fs.writeFileSync(gateFile, JSON.stringify({ stage: "stage-04c", status: "PASS", _stub: true }));
  try {
    const r = await withEnv("DEVTEAM_HEADLESS_COMMAND", "true", () =>
      runHeadless(makeAdapter(), desc, ctx),
    );
    assert.equal(r.exitCode, 0);
    assert.equal(r.gatePath, null, "stub gate should not be treated as a real gate");
    assert.equal(r.stubGate, true, "stub flag must be set");
  } finally {
    fs.rmSync(ctx.cwd, { recursive: true, force: true });
  }
});

test("stub gate detection: gate with _stub:false is treated as a real gate", async () => {
  const ctx = makeCtx();
  const desc = makeDescriptor("stage-04c");
  const gateFile = path.join(ctx.cwd, "pipeline", "gates", `${desc.workstreamId}.json`);
  fs.writeFileSync(gateFile, JSON.stringify({ stage: "stage-04c", status: "WARN", _stub: false }));
  try {
    const r = await withEnv("DEVTEAM_HEADLESS_COMMAND", "true", () =>
      runHeadless(makeAdapter(), desc, ctx),
    );
    assert.equal(r.gatePath, gateFile, "non-stub gate should be returned as gatePath");
    assert.equal(r.stubGate, false);
  } finally {
    fs.rmSync(ctx.cwd, { recursive: true, force: true });
  }
});

test("swallows stdin EPIPE when the child exits before reading the prompt", async () => {
  // `true` is famous for ignoring stdin and exiting immediately, so the
  // helper's stdin.write() races against the child closing its end of the
  // pipe. The helper has to swallow that EPIPE — if it didn't, this test
  // would surface as an unhandled error.
  const ctx = makeCtx();
  try {
    const r = await withEnv("DEVTEAM_HEADLESS_COMMAND", "true", () =>
      runHeadless(makeAdapter(), makeDescriptor(), ctx),
    );
    assert.equal(r.exitCode, 0);
  } finally {
    fs.rmSync(ctx.cwd, { recursive: true, force: true });
  }
});

test("parses headlessCommand quotes and passes the tail as args", async () => {
  const ctx = makeCtx();
  try {
    const r = await withEnv("DEVTEAM_HEADLESS_COMMAND", `node -e "process.exit(42)"`, () =>
      runHeadless(makeAdapter(), makeDescriptor(), ctx),
    );
    assert.equal(r.exitCode, 42);
  } finally {
    fs.rmSync(ctx.cwd, { recursive: true, force: true });
  }
});

test("supports quoted script paths that contain spaces", async () => {
  const ctx = makeCtx();
  const scriptDir = path.join(ctx.cwd, "script dir");
  const scriptPath = path.join(scriptDir, "exit code.js");
  fs.mkdirSync(scriptDir, { recursive: true });
  fs.writeFileSync(scriptPath, "process.exit(7);\n");
  try {
    const r = await withEnv("DEVTEAM_HEADLESS_COMMAND", `"${process.execPath}" "${scriptPath}"`, () =>
      runHeadless(makeAdapter(), makeDescriptor(), ctx),
    );
    assert.equal(r.exitCode, 7);
  } finally {
    fs.rmSync(ctx.cwd, { recursive: true, force: true });
  }
});

test("ctx.timeoutMs kills a hung child and reports timedOut: true", async () => {
  // `sleep 30` would hang the test for 30 seconds without a timeout.
  // We pass timeoutMs: 200 → kill after 200ms → resolve with timedOut.
  const ctx = makeCtx({ timeoutMs: 200 });
  try {
    const start = Date.now();
    const r = await withEnv("DEVTEAM_HEADLESS_COMMAND", "sleep 30", () =>
      runHeadless(makeAdapter(), makeDescriptor(), ctx),
    );
    const elapsed = Date.now() - start;
    assert.equal(r.timedOut, true);
    assert.equal(r.exitCode, null);
    // Should resolve within a reasonable margin of the timeout (allow up
    // to ~5s for the SIGKILL grace window in case SIGTERM is ignored).
    assert.ok(elapsed < 6000, `expected resolution within 6s, took ${elapsed}ms`);
  } finally {
    fs.rmSync(ctx.cwd, { recursive: true, force: true });
  }
});

test("ctx.timeoutMs: 0 disables the timeout", async () => {
  // With timeoutMs: 0, even an immediately-resolving command should
  // succeed (we don't want a 0 to be misread as "kill immediately").
  const ctx = makeCtx({ timeoutMs: 0 });
  try {
    const r = await withEnv("DEVTEAM_HEADLESS_COMMAND", "true", () =>
      runHeadless(makeAdapter(), makeDescriptor(), ctx),
    );
    assert.equal(r.timedOut, false);
    assert.equal(r.exitCode, 0);
  } finally {
    fs.rmSync(ctx.cwd, { recursive: true, force: true });
  }
});

test("writes pipeline/logs/<workstreamId>.log by default (transcript behavior)", async () => {
  const ctx = makeCtx();
  try {
    // `cat` echoes our prompt back to stdout, which is captured in the log.
    const r = await withEnv("DEVTEAM_HEADLESS_COMMAND", "cat", () =>
      runHeadless(makeAdapter(), makeDescriptor("stage-01"), ctx),
    );
    assert.equal(r.exitCode, 0);
    const expectedLog = path.join(ctx.cwd, "pipeline", "logs", "stage-01.log");
    assert.equal(r.logPath, expectedLog, "logPath returned from runHeadless");
    assert.ok(fs.existsSync(expectedLog), "log file written to disk");
    const content = fs.readFileSync(expectedLog, "utf8");
    // Header
    assert.match(content, /# Stage transcript: stage-01/);
    assert.match(content, /# Host: test-host/);
    assert.match(content, /# Command: cat/);
    assert.match(content, /# Started:/);
    // The piped prompt content
    assert.match(content, /stage stage-01/);
    assert.match(content, /prompt body/);
    // Trailer
    assert.match(content, /# Ended:/);
    assert.match(content, /# Exit: 0/);
  } finally {
    fs.rmSync(ctx.cwd, { recursive: true, force: true });
  }
});

test("default transcript logging does not mirror host stdout/stderr to the terminal", async () => {
  const ctx = makeCtx();
  const scriptPath = path.join(ctx.cwd, "noisy-host.js");
  fs.writeFileSync(
    scriptPath,
    'process.stdout.write("FULL PROMPT ECHO\\n"); process.stderr.write("DIFF --git noisy\\n");\n',
  );
  try {
    const { result, stdout, stderr } = await captureStdoutStderr(() =>
      withEnv("DEVTEAM_HEADLESS_COMMAND", `"${process.execPath}" "${scriptPath}"`, () =>
        runHeadless(makeAdapter(), makeDescriptor("stage-01"), ctx),
      ),
    );
    assert.equal(result.exitCode, 0);
    assert.doesNotMatch(stdout, /FULL PROMPT ECHO/);
    assert.doesNotMatch(stderr, /DIFF --git noisy/);

    const content = fs.readFileSync(path.join(ctx.cwd, "pipeline", "logs", "stage-01.log"), "utf8");
    assert.match(content, /FULL PROMPT ECHO/);
    assert.match(content, /DIFF --git noisy/);
  } finally {
    fs.rmSync(ctx.cwd, { recursive: true, force: true });
  }
});

test("DEVTEAM_HEADLESS_TEE=1 mirrors host output while preserving transcript logging", async () => {
  const ctx = makeCtx();
  const scriptPath = path.join(ctx.cwd, "verbose-host.js");
  fs.writeFileSync(
    scriptPath,
    'process.stdout.write("live stdout\\n"); process.stderr.write("live stderr\\n");\n',
  );
  try {
    const { result, stdout, stderr } = await captureStdoutStderr(() =>
      withEnv("DEVTEAM_HEADLESS_COMMAND", `"${process.execPath}" "${scriptPath}"`, () =>
        withEnv("DEVTEAM_HEADLESS_TEE", "1", () =>
          runHeadless(makeAdapter(), makeDescriptor("stage-01"), ctx),
        ),
      ),
    );
    assert.equal(result.exitCode, 0);
    assert.match(stdout, /live stdout/);
    assert.match(stderr, /live stderr/);

    const content = fs.readFileSync(path.join(ctx.cwd, "pipeline", "logs", "stage-01.log"), "utf8");
    assert.match(content, /live stdout/);
    assert.match(content, /live stderr/);
  } finally {
    fs.rmSync(ctx.cwd, { recursive: true, force: true });
  }
});

test("streams transcript bytes before the child exits", async () => {
  const ctx = makeCtx();
  const scriptPath = path.join(ctx.cwd, "delayed-output.js");
  fs.writeFileSync(
    scriptPath,
    'process.stdout.write("stream-visible-before-close\\n"); setTimeout(() => process.exit(0), 1000);\n',
  );
  try {
    const pending = withEnv(
      "DEVTEAM_HEADLESS_COMMAND",
      `"${process.execPath}" "${scriptPath}"`,
      () => runHeadless(makeAdapter(), makeDescriptor("stage-01"), ctx),
    );
    const logPath = path.join(ctx.cwd, "pipeline", "logs", "stage-01.log");
    const deadline = Date.now() + 750;
    while (
      Date.now() < deadline &&
      (!fs.existsSync(logPath) || !fs.readFileSync(logPath, "utf8").includes("stream-visible-before-close"))
    ) {
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
    assert.ok(fs.existsSync(logPath), "log file should exist while the child is running");
    assert.match(
      fs.readFileSync(logPath, "utf8"),
      /stream-visible-before-close/,
      "child output should be durable before process close",
    );
    const result = await pending;
    assert.equal(result.exitCode, 0);
  } finally {
    fs.rmSync(ctx.cwd, { recursive: true, force: true });
  }
});

test("streams high-volume transcripts without retaining or truncating chunks", () => {
  const ctx = makeCtx();
  const payloadBytes = 2 * 1024 * 1024;
  try {
    const logsPath = path.join(ctx.cwd, "pipeline", "logs");
    fs.mkdirSync(logsPath, { recursive: true });
    const logPath = path.join(logsPath, "stage-01.log");
    const writer = createTranscriptWriter(logPath, "# header\n");
    const chunk = Buffer.alloc(64 * 1024, "x");
    for (let written = 0; written < payloadBytes; written += chunk.length) writer.append(chunk);
    writer.end("\n# Exit: 0\n");
    const content = fs.readFileSync(logPath);
    assert.ok(content.length > payloadBytes, "header, full payload, and trailer should be present");
    assert.ok(content.includes(Buffer.from("# Exit: 0")), "trailer should be flushed before resolution");
  } finally {
    fs.rmSync(ctx.cwd, { recursive: true, force: true });
  }
});

test("DEVTEAM_NO_LOG=1 disables transcript logging; no log file is written", async () => {
  const ctx = makeCtx();
  try {
    const r = await withEnv("DEVTEAM_HEADLESS_COMMAND", "true", async () => {
      const prev = process.env.DEVTEAM_NO_LOG;
      process.env.DEVTEAM_NO_LOG = "1";
      try {
        return await runHeadless(makeAdapter(), makeDescriptor("stage-01"), ctx);
      } finally {
        if (prev === undefined) delete process.env.DEVTEAM_NO_LOG;
        else process.env.DEVTEAM_NO_LOG = prev;
      }
    });
    assert.equal(r.exitCode, 0);
    assert.equal(r.logPath, null, "logPath must be null when logging disabled");
    const logsDir = path.join(ctx.cwd, "pipeline", "logs");
    assert.ok(!fs.existsSync(logsDir), "no logs dir should be created");
  } finally {
    fs.rmSync(ctx.cwd, { recursive: true, force: true });
  }
});

test("log file is closed cleanly even when the spawn fails (no async write-after-end)", async () => {
  const ctx = makeCtx();
  try {
    await assert.rejects(
      withEnv("DEVTEAM_HEADLESS_COMMAND", "stagecraft-no-such-binary-xyz", () =>
        runHeadless(makeAdapter(), makeDescriptor("stage-01"), ctx),
      ),
      /failed to spawn/,
    );
    // The log file should exist (we opened it before spawn) with a
    // "spawn error" trailer rather than being left half-written.
    const logPath = path.join(ctx.cwd, "pipeline", "logs", "stage-01.log");
    assert.ok(fs.existsSync(logPath));
    const content = fs.readFileSync(logPath, "utf8");
    assert.match(content, /Exit: spawn error:/);
  } finally {
    fs.rmSync(ctx.cwd, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// Log rotation tests
// ---------------------------------------------------------------------------

test("rotateLog: on second run the previous log is moved to .1.log", async () => {
  const ctx = makeCtx();
  try {
    const logsPath = path.join(ctx.cwd, "pipeline", "logs");
    fs.mkdirSync(logsPath, { recursive: true });
    // Simulate a first run by pre-seeding the log file.
    const logFile = path.join(logsPath, "stage-01.log");
    fs.writeFileSync(logFile, "first run content");

    await withEnv("DEVTEAM_HEADLESS_COMMAND", "true", () =>
      withEnv("DEVTEAM_LOG_HISTORY", "3", () =>
        runHeadless(makeAdapter(), makeDescriptor("stage-01"), ctx),
      ),
    );

    // The previous log must have been rotated to .1.log.
    const slot1 = path.join(logsPath, "stage-01.1.log");
    assert.ok(fs.existsSync(slot1), ".1.log should exist after rotation");
    assert.equal(fs.readFileSync(slot1, "utf8"), "first run content");

    // The new current log is written by this run.
    assert.ok(fs.existsSync(logFile), "new stage-01.log must exist");
    assert.match(fs.readFileSync(logFile, "utf8"), /# Stage transcript: stage-01/);
  } finally {
    fs.rmSync(ctx.cwd, { recursive: true, force: true });
  }
});

test("rotateLog: history shifts correctly across three runs", async () => {
  const ctx = makeCtx();
  try {
    const logsPath = path.join(ctx.cwd, "pipeline", "logs");
    fs.mkdirSync(logsPath, { recursive: true });
    const logFile = path.join(logsPath, "stage-01.log");

    // Run 1: seed a log
    fs.writeFileSync(logFile, "run-1");
    // Run 2: rotate; run-1 → .1.log
    fs.writeFileSync(path.join(logsPath, "stage-01.1.log"), "will-be-shifted");
    rotateLog(logFile, 3);
    assert.equal(fs.readFileSync(path.join(logsPath, "stage-01.1.log"), "utf8"), "run-1");
    assert.equal(fs.readFileSync(path.join(logsPath, "stage-01.2.log"), "utf8"), "will-be-shifted");
    assert.ok(!fs.existsSync(logFile), "current log consumed by rotation");

    // Run 3: rotate again
    fs.writeFileSync(logFile, "run-3");
    rotateLog(logFile, 3);
    assert.equal(fs.readFileSync(path.join(logsPath, "stage-01.1.log"), "utf8"), "run-3");
    assert.equal(fs.readFileSync(path.join(logsPath, "stage-01.2.log"), "utf8"), "run-1");
    assert.equal(fs.readFileSync(path.join(logsPath, "stage-01.3.log"), "utf8"), "will-be-shifted");
  } finally {
    fs.rmSync(ctx.cwd, { recursive: true, force: true });
  }
});

test("rotateLog: oldest slot is pruned when maxHistory is exceeded", async () => {
  const ctx = makeCtx();
  try {
    const logsPath = path.join(ctx.cwd, "pipeline", "logs");
    fs.mkdirSync(logsPath, { recursive: true });
    const logFile = path.join(logsPath, "stage-01.log");

    // Fill all history slots (maxHistory=2): .1.log and .2.log exist.
    fs.writeFileSync(logFile, "current");
    fs.writeFileSync(path.join(logsPath, "stage-01.1.log"), "prior-1");
    fs.writeFileSync(path.join(logsPath, "stage-01.2.log"), "prior-2");

    rotateLog(logFile, 2);

    // .2.log (the oldest allowed slot) now holds what was in .1.log.
    assert.equal(fs.readFileSync(path.join(logsPath, "stage-01.1.log"), "utf8"), "current");
    assert.equal(fs.readFileSync(path.join(logsPath, "stage-01.2.log"), "utf8"), "prior-1");
    // prior-2 must have been pruned.
    assert.ok(!fs.existsSync(path.join(logsPath, "stage-01.3.log")), "pruned slot must not exist");
  } finally {
    fs.rmSync(ctx.cwd, { recursive: true, force: true });
  }
});

test("DEVTEAM_LOG_HISTORY=0 disables rotation; current log is overwritten", async () => {
  const ctx = makeCtx();
  try {
    const logsPath = path.join(ctx.cwd, "pipeline", "logs");
    fs.mkdirSync(logsPath, { recursive: true });
    const logFile = path.join(logsPath, "stage-01.log");
    fs.writeFileSync(logFile, "old content");

    await withEnv("DEVTEAM_HEADLESS_COMMAND", "true", () =>
      withEnv("DEVTEAM_LOG_HISTORY", "0", () =>
        runHeadless(makeAdapter(), makeDescriptor("stage-01"), ctx),
      ),
    );

    // No rotation files should exist.
    assert.ok(!fs.existsSync(path.join(logsPath, "stage-01.1.log")), ".1.log must not exist");
    // Current log overwritten with the new run.
    assert.ok(fs.existsSync(logFile));
    assert.match(fs.readFileSync(logFile, "utf8"), /# Stage transcript: stage-01/);
  } finally {
    fs.rmSync(ctx.cwd, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// capabilities.usageFormat: "claude-stream-json" (phase-28 item 28.1)
// ---------------------------------------------------------------------------
//
// Only the claude-code adapter declares usageFormat. These tests stub the
// host CLI via DEVTEAM_HEADLESS_COMMAND with a script that either emits a
// realistic stream-json transcript, or plain text (simulating an older CLI
// / any command that ignores --output-format), to prove both the observed
// path and the degradation contract.

function makeStreamJsonAdapter() {
  return {
    capabilities: { name: "claude-code", headlessCommand: "true", usageFormat: "claude-stream-json" },
    renderStagePrompt: (descriptor) =>
      `# stage ${descriptor.stage} (${descriptor.workstreamId})\nprompt body\n`,
  };
}

function writeFixtureScript(cwd, filename, source) {
  const scriptPath = path.join(cwd, filename);
  fs.writeFileSync(scriptPath, source);
  return scriptPath;
}

test("usageFormat: stream-json fixture yields observed usage/telemetry on the result", async () => {
  const ctx = makeCtx();
  const scriptPath = writeFixtureScript(ctx.cwd, "claude-stub.js", [
    'process.stdout.write(JSON.stringify({type:"system",subtype:"init"})+"\\n");',
    'process.stdout.write(JSON.stringify({type:"assistant",message:{content:[{type:"text",text:"Working on it"}]}})+"\\n");',
    'process.stdout.write(JSON.stringify({type:"result",subtype:"success",total_cost_usd:0.0456,result:"Done",usage:{input_tokens:1234,output_tokens:56},modelUsage:{"claude-sonnet-5":{}}})+"\\n");',
  ].join("\n"));
  try {
    const r = await withEnv("DEVTEAM_HEADLESS_COMMAND", `"${process.execPath}" "${scriptPath}"`, () =>
      runHeadless(makeStreamJsonAdapter(), makeDescriptor("stage-01"), ctx),
    );
    assert.equal(r.exitCode, 0);
    assert.equal(r.telemetry, "observed");
    assert.deepEqual(r.usage, { tokensIn: 1234, tokensOut: 56, costUsd: 0.0456, model: "claude-sonnet-5" });

    const logContent = fs.readFileSync(r.logPath, "utf8");
    assert.match(logContent, /Working on it/, "assistant text should be readable in the transcript");
    assert.match(logContent, /Done/, "final result text should be readable in the transcript");
    assert.doesNotMatch(logContent, /"type":"assistant"/, "raw JSONL must not leak into the transcript");
    assert.doesNotMatch(logContent, /"type":"result"/, "raw JSONL must not leak into the transcript");
  } finally {
    fs.rmSync(ctx.cwd, { recursive: true, force: true });
  }
});

test("usageFormat: plain-text stub degrades gracefully — telemetry unavailable, dispatch still succeeds", async () => {
  const ctx = makeCtx();
  const scriptPath = writeFixtureScript(ctx.cwd, "old-claude-stub.js", [
    'process.stdout.write("I cannot honor --output-format; here is plain text.\\n");',
  ].join("\n"));
  try {
    const r = await withEnv("DEVTEAM_HEADLESS_COMMAND", `"${process.execPath}" "${scriptPath}"`, () =>
      runHeadless(makeStreamJsonAdapter(), makeDescriptor("stage-01"), ctx),
    );
    // A telemetry parse failure must never fail the dispatch (fire-and-forget contract).
    assert.equal(r.exitCode, 0);
    assert.equal(r.telemetry, "unavailable");
    assert.equal(r.usage, null);

    const logContent = fs.readFileSync(r.logPath, "utf8");
    assert.match(logContent, /I cannot honor --output-format; here is plain text\./);
  } finally {
    fs.rmSync(ctx.cwd, { recursive: true, force: true });
  }
});

test("usageFormat: a non-zero exit still degrades telemetry cleanly instead of throwing", async () => {
  const ctx = makeCtx();
  const scriptPath = writeFixtureScript(ctx.cwd, "crashing-stub.js", [
    'process.stdout.write("partial output before crash\\n");',
    "process.exit(1);",
  ].join("\n"));
  try {
    const r = await withEnv("DEVTEAM_HEADLESS_COMMAND", `"${process.execPath}" "${scriptPath}"`, () =>
      runHeadless(makeStreamJsonAdapter(), makeDescriptor("stage-01"), ctx),
    );
    assert.equal(r.exitCode, 1);
    assert.equal(r.telemetry, "unavailable");
    assert.equal(r.usage, null);
  } finally {
    fs.rmSync(ctx.cwd, { recursive: true, force: true });
  }
});

test("usageFormat: adapters without the capability are unaffected — no usage/telemetry fields, raw tee unchanged", async () => {
  const ctx = makeCtx();
  try {
    const r = await withEnv("DEVTEAM_HEADLESS_COMMAND", "cat", () =>
      runHeadless(makeAdapter(), makeDescriptor("stage-01"), ctx),
    );
    assert.equal(r.exitCode, 0);
    assert.equal("usage" in r, false, "non-usageFormat adapters must not gain a usage field");
    assert.equal("telemetry" in r, false, "non-usageFormat adapters must not gain a telemetry field");
  } finally {
    fs.rmSync(ctx.cwd, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// capabilities.usageFormat: "codex-exec-json" (phase-28 item 28.3)
// ---------------------------------------------------------------------------

function makeCodexJsonAdapter() {
  return {
    capabilities: { name: "codex", headlessCommand: "true", usageFormat: "codex-exec-json" },
    renderStagePrompt: (descriptor) =>
      `# stage ${descriptor.stage} (${descriptor.workstreamId})\nprompt body\n`,
  };
}

test("usageFormat: codex-exec-json fixture yields observed usage/telemetry on the result", async () => {
  const ctx = makeCtx();
  const scriptPath = writeFixtureScript(ctx.cwd, "codex-stub.js", [
    'process.stdout.write(JSON.stringify({type:"thread.started",thread_id:"t1"})+"\\n");',
    'process.stdout.write(JSON.stringify({type:"turn.started"})+"\\n");',
    'process.stdout.write(JSON.stringify({type:"item.completed",item:{id:"1",type:"agent_message",text:"Working on it"}})+"\\n");',
    'process.stdout.write(JSON.stringify({type:"turn.completed",usage:{input_tokens:1234,cached_input_tokens:100,output_tokens:56}})+"\\n");',
  ].join("\n"));
  try {
    const r = await withEnv("DEVTEAM_HEADLESS_COMMAND", `"${process.execPath}" "${scriptPath}"`, () =>
      runHeadless(makeCodexJsonAdapter(), makeDescriptor("stage-01"), ctx),
    );
    assert.equal(r.exitCode, 0);
    assert.equal(r.telemetry, "observed");
    assert.deepEqual(r.usage, {
      tokensIn: 1234, tokensOut: 56, cachedTokens: 100, costUsd: null, model: null, source: "codex:exec-json",
    });

    const logContent = fs.readFileSync(r.logPath, "utf8");
    assert.match(logContent, /Working on it/, "agent_message text should be readable in the transcript");
    assert.doesNotMatch(logContent, /"type":"item.completed"/, "raw JSONL must not leak into the transcript");
    assert.doesNotMatch(logContent, /"type":"turn.completed"/, "raw JSONL must not leak into the transcript");
  } finally {
    fs.rmSync(ctx.cwd, { recursive: true, force: true });
  }
});

test("usageFormat: codex plain-text stub (older CLI without --json) degrades gracefully", async () => {
  const ctx = makeCtx();
  const scriptPath = writeFixtureScript(ctx.cwd, "old-codex-stub.js", [
    'process.stdout.write("I do not honor --json; here is plain text.\\n");',
  ].join("\n"));
  try {
    const r = await withEnv("DEVTEAM_HEADLESS_COMMAND", `"${process.execPath}" "${scriptPath}"`, () =>
      runHeadless(makeCodexJsonAdapter(), makeDescriptor("stage-01"), ctx),
    );
    assert.equal(r.exitCode, 0);
    assert.equal(r.telemetry, "unavailable");
    assert.equal(r.usage, null);

    const logContent = fs.readFileSync(r.logPath, "utf8");
    assert.match(logContent, /I do not honor --json; here is plain text\./);
  } finally {
    fs.rmSync(ctx.cwd, { recursive: true, force: true });
  }
});

test("32.3: runHeadless appends --model <value> when descriptor.model is set", async () => {
  const ctx = makeCtx();
  const recordPath = path.join(ctx.cwd, "argv-record.json");
  const scriptPath = writeFixtureScript(ctx.cwd, "argv-recorder.js", [
    "const fs = require('node:fs');",
    `fs.writeFileSync(${JSON.stringify(recordPath)}, JSON.stringify(process.argv.slice(2)));`,
  ].join("\n"));
  try {
    const adapter = makeAdapter({ headlessCommand: `"${process.execPath}" "${scriptPath}"` });
    const descriptor = { ...makeDescriptor(), model: "claude-haiku-4-5-20251001" };
    const r = await withEnv("DEVTEAM_HEADLESS_COMMAND", undefined, () => runHeadless(adapter, descriptor, ctx));
    assert.equal(r.exitCode, 0);
    const argv = JSON.parse(fs.readFileSync(recordPath, "utf8"));
    assert.deepEqual(argv.slice(-2), ["--model", "claude-haiku-4-5-20251001"]);
  } finally {
    fs.rmSync(ctx.cwd, { recursive: true, force: true });
  }
});

test("32.3: runHeadless omits --model entirely when descriptor.model is absent (back-compat)", async () => {
  const ctx = makeCtx();
  const recordPath = path.join(ctx.cwd, "argv-record.json");
  const scriptPath = writeFixtureScript(ctx.cwd, "argv-recorder.js", [
    "const fs = require('node:fs');",
    `fs.writeFileSync(${JSON.stringify(recordPath)}, JSON.stringify(process.argv.slice(2)));`,
  ].join("\n"));
  try {
    const adapter = makeAdapter({ headlessCommand: `"${process.execPath}" "${scriptPath}"` });
    const descriptor = makeDescriptor(); // no .model field
    const r = await withEnv("DEVTEAM_HEADLESS_COMMAND", undefined, () => runHeadless(adapter, descriptor, ctx));
    assert.equal(r.exitCode, 0);
    const argv = JSON.parse(fs.readFileSync(recordPath, "utf8"));
    assert.deepEqual(argv, []);
  } finally {
    fs.rmSync(ctx.cwd, { recursive: true, force: true });
  }
});

// C2 fallback chain: a prompt over claude-code headless mode's 4000-char
// "Goal condition" limit is re-rendered with patchItems dropped, then with
// inlined framework/role-brief content dropped too (phase-37.2's
// prompts.inline_framework), and rejected outright only if it's still over
// budget after both — see headless.js's runHeadless C2 comment. This fake
// adapter's renderStagePrompt grows/shrinks based on the same ctx flags the
// real markdown-host/claude-code adapters react to (ctx.patchItems,
// ctx.inlineFrameworkOverride), so the fallback logic under test never
// touches a real host CLI.
function makeOverBudgetAdapter({ baseLen = 50, frameworkLen = 0, patchLen = 0 } = {}) {
  return {
    capabilities: { name: "test-host", headlessCommand: "cat" },
    renderStagePrompt: (descriptor, ctx) => {
      let s = "B".repeat(baseLen);
      if (frameworkLen > 0 && !(ctx && ctx.inlineFrameworkOverride === false)) {
        s += "\n" + "F".repeat(frameworkLen);
      }
      if (patchLen > 0 && ctx && ctx.patchItems && ctx.patchItems.length > 0) {
        s += "\n" + "P".repeat(patchLen);
      }
      return s + "\n";
    },
  };
}

test("C2 fallback: drops patchItems when they alone push the prompt over the 4000-char headless limit", async () => {
  const ctx = makeCtx({ patchItems: [{ file: "a.js" }] });
  try {
    const adapter = makeOverBudgetAdapter({ baseLen: 50, frameworkLen: 0, patchLen: 4500 });
    // Don't intercept stdout/stderr here (see captureStdoutStderr above) — this
    // test runs alongside sibling tests that also exercise runHeadless, and two
    // concurrent global process.stdout/stderr.write monkeypatches race for
    // whichever restores last, so cross-checking the [devteam] warn text isn't
    // reliable. `cat` echoing the final prompt into the transcript log is
    // enough to prove which block got dropped.
    const r = await runHeadless(adapter, makeDescriptor("stage-01"), ctx);
    assert.equal(r.exitCode, 0);
    const content = fs.readFileSync(path.join(ctx.cwd, "pipeline", "logs", "stage-01.log"), "utf8");
    assert.doesNotMatch(content, /PPPP/, "patch block was not sent to the child");
  } finally {
    fs.rmSync(ctx.cwd, { recursive: true, force: true });
  }
});

test("C2 fallback: drops inlined framework content when there's no patchItems to drop first", async () => {
  const ctx = makeCtx(); // no patchItems at all
  try {
    const adapter = makeOverBudgetAdapter({ baseLen: 50, frameworkLen: 4500, patchLen: 0 });
    const r = await runHeadless(adapter, makeDescriptor("stage-01"), ctx);
    assert.equal(r.exitCode, 0);
    const content = fs.readFileSync(path.join(ctx.cwd, "pipeline", "logs", "stage-01.log"), "utf8");
    assert.doesNotMatch(content, /FFFF/, "inlined framework block was not sent to the child");
  } finally {
    fs.rmSync(ctx.cwd, { recursive: true, force: true });
  }
});

test("C2 fallback: rejects with a clear error instead of silently dispatching when still over budget after both drops", async () => {
  const ctx = makeCtx({ patchItems: [{ file: "a.js" }] });
  try {
    // baseLen alone (5000) is already over the limit — no combination of
    // dropping patchItems/framework content can bring this under budget.
    const adapter = makeOverBudgetAdapter({ baseLen: 5000, frameworkLen: 1000, patchLen: 1000 });
    await assert.rejects(
      () => runHeadless(adapter, makeDescriptor("stage-01"), ctx),
      /over this host's 4000-char limit/,
    );
  } finally {
    fs.rmSync(ctx.cwd, { recursive: true, force: true });
  }
});
