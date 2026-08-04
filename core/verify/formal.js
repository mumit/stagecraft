// Formal-verification presence check for stage-06d (35.3). TLA+, Alloy,
// and Lean/Coq output is too varied to parse for a counterexample the way
// mutation.js parses a kill-ratio summary line, so this module deliberately
// does NOT interpret exit codes as pass/fail — it stamps only
// {tool, ran, exit_code}, the presence-and-exit-code evidence the plan
// asks for. Whether a non-zero exit means a genuine counterexample or a
// tool/config error stays a human judgment call, surfaced as a gate
// warning rather than a fabricated blocker.
//
// No toolchain auto-detection: unlike fast-check/hypothesis/proptest,
// there's no single manifest signal for "a TLA+/Alloy/Lean spec exists
// here" — the project declares its own check command via
// `pipeline.verify.formal.command`. Absent, that's an honest skip.
//
// See plans/phase-35-existing-codebase-mode.md item 35.3.

const { runCommand } = require("./runner");

const DEFAULT_TIMEOUT_MS = 5 * 60 * 1000;

function resolveFormalConfig(config) {
  const raw = (config && config.pipeline && config.pipeline.verify && config.pipeline.verify.formal) || {};
  return {
    command: typeof raw.command === "string" && raw.command.trim() ? raw.command.trim() : null,
    tool: typeof raw.tool === "string" && raw.tool.trim() ? raw.tool.trim() : null,
    timeout_ms: Number.isInteger(raw.timeout_ms) && raw.timeout_ms > 0 ? raw.timeout_ms : DEFAULT_TIMEOUT_MS,
  };
}

// Public entry point. Returns { ran, skipped, reason, ... } shaped like
// the other verify/*.js gates; on a genuine run, {tool, ran, exit_code}
// only — no output parsing.
async function runFormalGate(cwd, config) {
  const fCfg = resolveFormalConfig(config);

  if (!fCfg.command) {
    return {
      ran: false, skipped: true,
      reason: "no formal verification tool configured (pipeline.verify.formal.command) — " +
        "devteam never installs TLA+/Alloy/Lean/Coq",
    };
  }

  const result = await runCommand(fCfg.command, { cwd, timeoutMs: fCfg.timeout_ms });

  if (result.timedOut) {
    return {
      ran: false, skipped: true,
      reason: `formal verification exceeded timeout_ms=${fCfg.timeout_ms} — killed`,
      command: fCfg.command, duration_ms: result.durationMs, timed_out: true,
    };
  }
  if (result.spawnError) {
    return {
      ran: false, skipped: true,
      reason: `could not run formal verification command: ${result.spawnError}`,
      command: fCfg.command,
    };
  }

  return {
    ran: true,
    skipped: false,
    tool: fCfg.tool || "configured",
    command: fCfg.command,
    exit_code: result.exitCode,
    duration_ms: result.durationMs,
  };
}

module.exports = {
  runFormalGate,
  resolveFormalConfig,
};
