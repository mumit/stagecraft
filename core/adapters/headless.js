// Shared headless-invoke helper.
//
// Adapters whose host has capabilities.headless = true can wire their
// invoke() to runHeadless(adapter, descriptor, ctx). The helper:
//   1. Resolves capabilities.headlessCommand (e.g. "claude --print")
//   2. Renders the stage prompt via adapter.renderStagePrompt
//   3. Spawns the headless command; pipes the prompt to stdin
//   4. Writes stdout/stderr to pipeline/logs/<workstreamId>.log for post-hoc
//      reading. Host output is quiet on the terminal by default; set
//      DEVTEAM_HEADLESS_TEE=1 or DEVTEAM_VERBOSE=1 to mirror it live.
//   5. Awaits exit (with a timeout), then checks
//      pipeline/gates/<workstreamId>.json
//   6. Returns { exitCode, gatePath, logPath, durationMs, timedOut }
//
// The DEVTEAM_HEADLESS_COMMAND env var overrides the adapter's
// declared headlessCommand. Useful for stubbing in tests (set to
// "cat" to just echo the prompt) and for users who alias the host CLI.
//
// capabilities.usageFormat (phase-28 items 28.1/28.3): when an adapter
// declares a usageFormat present in USAGE_EXTRACTORS below, stdout is
// parsed as that host's line-JSON stream — the transcript log gets the
// extracted readable text (not raw JSONL), and the result gains
// `usage`/`telemetry` fields from the final usage-bearing message.
// "claude-stream-json" → core/adapters/claude-stream-json.js (claude
// --output-format stream-json). "codex-exec-json" → core/adapters/
// codex-exec-json.js (codex exec --json). Adapters that don't declare a
// known usageFormat are unaffected: stdout is teed verbatim exactly as
// before item 28.1.
//
// The DEVTEAM_NO_LOG=1 env var (or ctx.log === false) disables transcript logs
// and reverts to inherit-style stdio. Tests that don't want log files
// scattered in tempdirs should set this.
//
// Log rotation: before each run, the existing <workstreamId>.log is rotated
// to <workstreamId>.1.log, .1.log → .2.log, and so on. The oldest slot
// (index DEVTEAM_LOG_HISTORY, default 3) is pruned. Set DEVTEAM_LOG_HISTORY=0
// to disable rotation and revert to the overwrite-on-each-run behaviour.
//
// Timeout: ctx.timeoutMs caps the child's wall-clock. Default 10 min
// (600_000 ms). Pass 0 (or any non-positive number) for no timeout.
// On timeout, the child is terminated and the returned exitCode is
// null with timedOut: true.

const fs = require("node:fs");
const path = require("node:path");
const { spawn } = require("node:child_process");
const { pipelineRoot, gatesDir, logsDir } = require("../paths");
const { snapshotWritables, auditWrites } = require("../guards/write-audit");
const { splitCommand } = require("../command-line");
const { terminateChild } = require("../process-kill");
const { createStreamJsonExtractor } = require("./claude-stream-json");
const { createCodexJsonExtractor } = require("./codex-exec-json");
const { wrapContainedInvocation } = require("../containment");

// capabilities.usageFormat → extractor factory. Adapters that don't declare
// usageFormat (or declare a value not in this map) are unaffected: stdout
// is teed verbatim exactly as before phase-28 item 28.1.
const USAGE_EXTRACTORS = {
  "claude-stream-json": createStreamJsonExtractor,
  "codex-exec-json": createCodexJsonExtractor,
};

const DEFAULT_TIMEOUT_MS = 10 * 60 * 1000; // 10 minutes
const MAX_CAPTURE_BYTES = 256 * 1024;

function createTranscriptWriter(logPath, header) {
  let fd = fs.openSync(logPath, "w");
  try {
    fs.writeSync(fd, header);
  } catch (err) {
    try { fs.closeSync(fd); } catch { /* */ }
    fd = null;
    throw err;
  }

  return {
    append(chunk) {
      if (fd === null) return;
      try {
        fs.writeSync(fd, chunk);
      } catch {
        try { fs.closeSync(fd); } catch { /* */ }
        fd = null;
      }
    },
    end(trailer) {
      if (fd === null) return;
      this.append(trailer);
      if (fd === null) return;
      try { fs.fsyncSync(fd); } catch { /* full disk, unsupported fsync, etc. */ }
      try { fs.closeSync(fd); } catch { /* */ }
      fd = null;
    },
  };
}

// Rotate <logPath> before writing a new run.
// <ws>.log → <ws>.1.log, <ws>.1.log → <ws>.2.log, …, <ws>.<N>.log pruned.
// All filesystem errors are swallowed — rotation is best-effort and must
// never prevent the new log from being written.
function rotateLog(logPath, maxHistory) {
  if (maxHistory <= 0) return;
  const slot = (n) => logPath.replace(/\.log$/, `.${n}.log`);
  try { fs.unlinkSync(slot(maxHistory)); } catch { /* already gone */ }
  for (let i = maxHistory - 1; i >= 1; i--) {
    try { fs.renameSync(slot(i), slot(i + 1)); } catch { /* didn't exist */ }
  }
  try { fs.renameSync(logPath, slot(1)); } catch { /* no current log yet */ }
}

function runHeadless(adapter, descriptor, ctx, preRenderedPrompt) {
  const declared = adapter.capabilities && adapter.capabilities.headlessCommand;
  const override = process.env.DEVTEAM_HEADLESS_COMMAND;
  const cmdString = override || declared;
  if (!cmdString) {
    return Promise.reject(new Error(
      `host "${adapter.capabilities && adapter.capabilities.name}" declares no headlessCommand`,
    ));
  }

  const prompt = preRenderedPrompt || adapter.renderStagePrompt(descriptor, ctx);

  // ADR-023: there is no prompt-length ceiling to guard. The 4,000-char limit
  // this used to enforce belonged to claude-code's `/goal` slash-command
  // handler, not to any host — every prompt is piped to stdin below, so no
  // host has an argv ceiling either. Nothing composes `/goal` any more.
  const finalPrompt = prompt;

  const gatePath = path.join(gatesDir(ctx.cwd, ctx.changeId), `${descriptor.workstreamId}.json`);
  let bin, args;
  try {
    ({ bin, args } = splitCommand(cmdString, "headlessCommand"));
  } catch (err) {
    return Promise.reject(new Error(`invalid headlessCommand "${cmdString}": ${err.message}`));
  }

  // Phase-32 item 32.3: routing-resolved model (descriptor.model, set by
  // core/orchestrator.js from routing.roles/routing.stages' {host, model}
  // form) reaches the CLI via a `--model <value>` flag — verified identical
  // syntax across every runHeadless-driven host today (claude, codex,
  // gemini, agy). Absent when routing didn't pin a model for this dispatch.
  if (typeof descriptor.model === "string" && descriptor.model) {
    args = [...args, "--model", descriptor.model];
  }

  // C1: post-hoc write audit for adapters that declare enforces.allowed_writes = "post-hoc-audit".
  // Snapshot dirty state before spawn; diff after close to find unauthorized writes.
  const shouldAudit = adapter.capabilities?.enforces?.allowed_writes === "post-hoc-audit"
    || ctx.forceWriteAudit === true;
  const beforeSnapshot = shouldAudit ? snapshotWritables(ctx.cwd) : null;

  // Phase-36 item 36.1's review mode makes ctx.processCwd (the subject) a
  // genuinely different directory from ctx.cwd (the review workspace) — the
  // audit above never looks at it, so a non-acp host's write-audit was blind
  // to the one directory review mode exists to protect. Mirror
  // hosts/acp/permissions.js's own review-mode rule (codeRoot is
  // unconditionally read-only, independent of allowedWrites) with a second,
  // independent snapshot/audit pass against the subject: post-hoc detection
  // only, same as the audit above — it cannot prevent the write, only flip
  // the gate to FAIL after the fact. No-ops (same as the audit above) when
  // the subject isn't a git repo.
  const subjectRoot = shouldAudit && ctx.externalReviewMode === true && ctx.processCwd
    ? path.resolve(ctx.processCwd)
    : null;
  const auditSubject = subjectRoot !== null && subjectRoot !== path.resolve(ctx.cwd);
  const beforeSubjectSnapshot = auditSubject ? snapshotWritables(subjectRoot) : null;
  const start = Date.now();
  const timeoutMs = typeof ctx.timeoutMs === "number" ? ctx.timeoutMs : DEFAULT_TIMEOUT_MS;

  // C3: claude-code's own subagent dispatch (every role prompt says "Use the
  // X subagent for this workstream" — capabilities.subagents: true) has an
  // INTERNAL background-task ceiling, completely independent of this
  // function's own timeoutMs/DEFAULT_TIMEOUT_MS above. When a subagent's
  // turn runs long — hits a retry, a connection error, a slow tool call —
  // claude's own `--print` orchestration silently terminates the wait after
  // that ceiling (default 600000ms) and the top-level turn ends anyway,
  // reporting exit 0 with no gate: the exact "clean exit, no output" failure
  // structural-halt exists to catch, except here there IS a real cause,
  // just one this process never gets to see (claude prints it to its own
  // transcript: `Background tasks still running after 600s; terminating.
  // Set CLAUDE_CODE_PRINT_BG_WAIT_CEILING_MS=0 to wait indefinitely.`).
  // Left unset, this ceiling can fire well before this function's own
  // timeoutMs would — a dispatch given 10, 20, or unlimited minutes at the
  // devteam level still silently self-truncates at claude's 10-minute
  // default. Align the two: propagate timeoutMs into whatever env var the
  // adapter declares for this (claude-code only — the one host that
  // declares capabilities.subagents: true), "0" meaning "wait indefinitely"
  // on both sides consistently. Never overrides an operator's own explicit
  // value already in the environment.
  const bgCeilingEnvVar = adapter.capabilities && adapter.capabilities.printBackgroundCeilingEnv;
  const extraEnv = (bgCeilingEnvVar && process.env[bgCeilingEnvVar] === undefined)
    ? { [bgCeilingEnvVar]: String(timeoutMs) }
    : null;
  let invocation;
  try {
    invocation = wrapContainedInvocation({
      bin,
      args,
      ctx,
      env: extraEnv ? { ...process.env, ...extraEnv } : process.env,
    });
  } catch (err) {
    return Promise.reject(err);
  }

  // Logging: write stdout/stderr to pipeline/logs/<workstreamId>.log.
  // Disabled in tests + by env opt-out. When disabled we keep the
  // historical "inherit" stdio so terminal colors / TTY detection
  // in the host CLI continue to work; when enabled we pipe so we can
  // capture the streams. Live terminal mirroring is opt-in because
  // some CLIs echo the whole prompt and large diffs.
  // Logging: stream the host's stdout/stderr directly to a synchronous file
  // descriptor. This keeps memory constant for long-running agents, exposes
  // log growth to the liveness probe while the child is active, and lets the
  // close handler flush the descriptor before runHeadless settles.
  const logDisabled = process.env.DEVTEAM_NO_LOG === "1" || ctx.log === false;
  const captureOutput = ctx.captureOutput === true;
  const liveTee = ctx.tee === true ||
    process.env.DEVTEAM_HEADLESS_TEE === "1" ||
    process.env.DEVTEAM_VERBOSE === "1";
  let logPath = null;
  let logWriter = null;     // null when logging disabled or open failed
  let logEnded = false;
  if (!logDisabled) {
    try {
      const logsDirPath = logsDir(ctx.cwd, ctx.changeId);
      fs.mkdirSync(logsDirPath, { recursive: true });
      logPath = path.join(logsDirPath, `${descriptor.workstreamId}.log`);
      const rawHistory = process.env.DEVTEAM_LOG_HISTORY;
      const maxHistory = (rawHistory !== undefined && Number.isFinite(parseInt(rawHistory, 10)) && parseInt(rawHistory, 10) >= 0)
        ? parseInt(rawHistory, 10)
        : 3;
      rotateLog(logPath, maxHistory);
      const header = [
        `# Stage transcript: ${descriptor.workstreamId}`,
        `# Host: ${adapter.capabilities && adapter.capabilities.name}`,
        `# Command: ${cmdString}`,
        `# Started: ${new Date().toISOString()}`,
        "# ---",
        "",
        "",
      ].join("\n");
      logWriter = createTranscriptWriter(logPath, header);
    } catch {
      // Best-effort: if we can't create logs/, fall back to terminal-only.
      logPath = null;
      logWriter = null;
    }
  }
  function appendLog(chunk) {
    logWriter?.append(chunk);
  }
  let capturedOutput = "";
  function appendCaptured(chunk) {
    if (!captureOutput || chunk == null || capturedOutput.length >= MAX_CAPTURE_BYTES) return;
    const text = Buffer.isBuffer(chunk) ? chunk.toString("utf8") : String(chunk);
    capturedOutput += text.slice(0, MAX_CAPTURE_BYTES - capturedOutput.length);
  }
  // Idempotent log-flush. First caller writes the trailer and flushes
  // to disk synchronously. Subsequent calls are no-ops. Safe to call
  // from both spawn-error and close handlers.
  function endLog(reason) {
    if (!logPath || logEnded) return;
    logEnded = true;
    logWriter?.end(`\n# ---\n# Ended: ${new Date().toISOString()}\n# Exit: ${reason}\n`);
  }

  // Usage extraction normally follows transcript logging. A caller that sets
  // captureOutput (the read-only conversational coordinator) also needs the
  // structured host stream parsed even though it deliberately disables logs.
  const usageFormat = adapter.capabilities && adapter.capabilities.usageFormat;
  const extractorFactory = USAGE_EXTRACTORS[usageFormat];
  const streamExtractor = extractorFactory && (logWriter !== null || captureOutput)
    ? extractorFactory()
    : null;

  return new Promise((resolve, reject) => {
    const child = spawn(invocation.bin, invocation.args, {
      cwd: invocation.cwd,
      // When logging is on we read stdout/stderr ourselves to duplicate
      // them into the transcript; when off, inherit gets us the historical
      // terminal-color behavior for free.
      stdio: (logWriter !== null || captureOutput) ? ["pipe", "pipe", "pipe"] : ["pipe", "inherit", "inherit"],
      env: invocation.env,
    });

    // Transcript paths: always write chunks to the log. Live terminal
    // mirroring is opt-in; errors on stdout/stderr (closed terminal)
    // are swallowed — a closed pipe shouldn't fail the stage. When
    // streamExtractor is set, stdout is parsed as claude's stream-json
    // and only the extracted readable text reaches the log/terminal —
    // raw JSONL would make the transcript unreadable.
    if (logWriter !== null || captureOutput) {
      child.stdout.on("data", (chunk) => {
        const text = streamExtractor ? streamExtractor.push(chunk) : chunk;
        if (liveTee) {
          try { process.stdout.write(text); } catch { /* */ }
        }
        appendLog(text);
        appendCaptured(text);
      });
      child.stderr.on("data", (chunk) => {
        if (liveTee) {
          try { process.stderr.write(chunk); } catch { /* */ }
        }
        appendLog(chunk);
      });
    }

    let timedOut = false;
    let timer = null;
    if (timeoutMs > 0) {
      timer = setTimeout(() => {
        timedOut = true;
        terminateChild(child, { graceMs: 5000 });
      }, timeoutMs);
      timer.unref();
    }

    child.on("error", (err) => {
      if (timer) clearTimeout(timer);
      endLog(`spawn error: ${err.message}`);
      reject(new Error(
        `headless invoke failed to spawn "${invocation.bin}": ${err.message}. Is ${invocation.bin} installed and on PATH?`,
      ));
    });
    child.stdin.on("error", () => { /* swallow EPIPE when child exits early */ });
    child.stdin.write(finalPrompt);
    child.stdin.end();
    child.on("close", (exitCode) => {
      if (timer) clearTimeout(timer);

      // Flush the stream-json extractor's trailing partial line (if any)
      // before the log trailer, and read off the usage it accumulated.
      let usage = null;
      let telemetry;
      if (streamExtractor) {
        const trailing = streamExtractor.end();
        if (trailing) {
          if (liveTee) {
            try { process.stdout.write(trailing); } catch { /* */ }
          }
          appendLog(trailing);
          appendCaptured(trailing);
        }
        ({ usage, telemetry } = streamExtractor.result());
      }

      endLog(timedOut ? "TIMED OUT" : String(exitCode));

      // C1: diff the dirty-file snapshot; log violations immediately.
      // Orchestrator-internal files written between snapshots (heartbeats,
      // state transitions, advisory lock) are never model-written — exempt them.
      const relPipelineRoot = path.relative(ctx.cwd, pipelineRoot(ctx.cwd, ctx.changeId)).replace(/\\/g, "/");
      const relLogsDir = path.relative(ctx.cwd, logsDir(ctx.cwd, ctx.changeId)).replace(/\\/g, "/");
      const orchestratorWrites = new Set([
        path.posix.join(relPipelineRoot, "run-log.jsonl"),
        path.posix.join(relPipelineRoot, "run-state.json"),
        path.posix.join(relPipelineRoot, "run.lock"),
      ]);
      function isOrchestratorWrite(relPath) {
        const normalized = relPath.replace(/\\/g, "/");
        return orchestratorWrites.has(normalized) || normalized.startsWith(`${relLogsDir}/`);
      }
      let writeViolations = [];
      if (shouldAudit && beforeSnapshot) {
        const afterSnapshot = snapshotWritables(ctx.cwd);
        const { violations } = auditWrites(beforeSnapshot, afterSnapshot, descriptor.allowedWrites || []);
        writeViolations = violations.filter((v) => !isOrchestratorWrite(v));
        // Logging deferred to orchestrator so sibling-workstream false positives
        // (parallel stage writes captured in this snapshot window) can be filtered
        // before any ⛔ line is emitted.
      }
      if (auditSubject && beforeSubjectSnapshot) {
        // Empty allowedWrites ([]) makes every new path a violation
        // unconditionally — codeRoot is read-only in review mode, there is
        // no allowlist to check against. "subject:" prefix disambiguates
        // these from the workspace-relative paths above once merged.
        const afterSubjectSnapshot = snapshotWritables(subjectRoot);
        const { violations: subjectViolations } = auditWrites(beforeSubjectSnapshot, afterSubjectSnapshot, []);
        writeViolations = writeViolations.concat(subjectViolations.map((v) => `subject:${v}`));
      }

      // Derive peer-review gates from any by-*.md files written during this
      // session. The PostToolUse hook that normally does this never fires for
      // hooks: false hosts (codex, any future CLI host). Idempotent.
      if (!timedOut) {
        const codeReviewDir = path.join(ctx.cwd, "pipeline", "code-review");
        if (fs.existsSync(codeReviewDir)) {
          const { deriveForProject } = require("../hooks/approval-derivation");
          for (const f of fs.readdirSync(codeReviewDir)) {
            if (/^by-[\w-]+\.md$/.test(f)) {
              const abs = path.join(codeReviewDir, f);
              if (fs.statSync(abs).mtimeMs >= start) {
                deriveForProject(abs, ctx.cwd);
              }
            }
          }
        }
      }

      // Detect pre-seeded stub gates. A stub has `_stub: true` written by the
      // driver before dispatch. If the LLM exhausted context before overwriting
      // it, the stub is still present — return stubGate: true so the driver
      // classifies the dispatch as transient (not structural-input) and retries.
      const gateExists = fs.existsSync(gatePath);
      let isStub = false;
      if (gateExists) {
        try {
          const parsed = JSON.parse(fs.readFileSync(gatePath, "utf8"));
          isStub = parsed._stub === true;
        } catch { /* unreadable; treat as real gate */ }
      }
      resolve({
        exitCode: timedOut ? null : exitCode,
        gatePath: gateExists && !isStub ? gatePath : null,
        stubGate: isStub,
        logPath,
        durationMs: Date.now() - start,
        timedOut,
        writeViolations,
        ...(captureOutput ? { output: capturedOutput } : {}),
        ...(streamExtractor ? { usage, telemetry } : {}),
      });
    });
  });
}

module.exports = { runHeadless, rotateLog, createTranscriptWriter, DEFAULT_TIMEOUT_MS };
