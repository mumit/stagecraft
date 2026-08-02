// Opt-in, time-boxed, changed-files-only mutation smoke gate (31.4).
// Stage-06 (QA) stamping: when `pipeline.verify.mutation.enabled` is true,
// detect a supported mutation-testing runner already present in the target
// project — Stryker via a package.json devDependency (JS/TS), mutmut via
// the binary already resolvable on PATH/venv (Python) — devteam NEVER
// installs either. Run it against the changed-file set only (intersected
// with the `paths` config), time-boxed via runCommand's existing
// timeoutMs/process-kill machinery (core/process-kill.js, wired in
// ./runner.js). Absent runner, empty scope, a timeout, or unparseable
// output are all honest recorded skips — never a fabricated score, same
// doctrine as runDependencyAudit's offline handling in ./redteam-floor.js.
//
// See plans/phase-31-verification-depth.md §31.4.

const fs = require("node:fs");
const path = require("node:path");
const { spawnSync } = require("node:child_process");
const { runCommand } = require("./runner");

const DEFAULT_THRESHOLD = 0.7;
const DEFAULT_TIMEOUT_MS = 5 * 60 * 1000;

// Stryker's clear-text reporter summary line, e.g. "138/142 mutants killed
// (97.18%)" — the exact form documented as the worked example in
// skills/verification-beyond-tests/SKILL.md's "Mutation example (Stryker)".
const STRYKER_SCORE_RE = /(\d+)\/(\d+)\s+mutants?\s+killed\s+\(([\d.]+)%\)/i;

// mutmut's end-of-run progress line: "<done>/<total>  🎉 <killed>  ⏰ <timeout>
// 🤔 <suspicious>  🙁 <survived>  🔇 <skipped>".
const MUTMUT_SCORE_RE = /(\d+)\/(\d+)\s*🎉\s*(\d+)\s*⏰\s*(\d+)\s*🤔\s*(\d+)\s*🙁\s*(\d+)\s*🔇\s*(\d+)/u;

function resolveMutationConfig(config) {
  const raw = (config && config.pipeline && config.pipeline.verify && config.pipeline.verify.mutation) || {};
  return {
    enabled: raw.enabled === true,
    threshold: typeof raw.threshold === "number" ? raw.threshold : DEFAULT_THRESHOLD,
    threshold_hard: raw.threshold_hard === true,
    timeout_ms: Number.isInteger(raw.timeout_ms) && raw.timeout_ms > 0 ? raw.timeout_ms : DEFAULT_TIMEOUT_MS,
    paths: Array.isArray(raw.paths) && raw.paths.length > 0 ? raw.paths : null,
    // Test/customization escape hatch mirroring `dependency_audit_command`
    // (core/verify/redteam-floor.js, 31.2) — lets a project, or a test
    // fixture, substitute the exact mutation command instead of relying on
    // devDependency/PATH auto-detection. Never used to auto-install anything.
    command: typeof raw.command === "string" && raw.command.trim() ? raw.command.trim() : null,
  };
}

function binaryOnPath(name) {
  const probe = spawnSync(process.platform === "win32" ? "where" : "which", [name], { encoding: "utf8" });
  return Boolean(probe) && probe.status === 0;
}

function readPackageJson(cwd) {
  const p = path.join(cwd, "package.json");
  if (!fs.existsSync(p)) return null;
  try { return JSON.parse(fs.readFileSync(p, "utf8")); } catch { return null; }
}

// Stryker: JS/TS, detected via project devDependency — never installed by
// devteam. Changed files are passed as a comma-separated --mutate list
// (per skills/verification-beyond-tests/SKILL.md's documented CLI usage).
function strykerCommand(files) {
  return `npx --no-install stryker run --mutate "${files.join(",")}"`;
}

// mutmut: Python, detected via the binary already resolvable on PATH (a
// project venv activated by the caller, or a global install) — never
// installed by devteam.
function mutmutCommand(files) {
  return `mutmut run --paths-to-mutate ${files.join(",")}`;
}

function detectRunner(cwd) {
  const pkg = readPackageJson(cwd);
  const deps = pkg ? { ...(pkg.dependencies || {}), ...(pkg.devDependencies || {}) } : {};
  if (deps["@stryker-mutator/core"]) return { id: "stryker", buildCommand: strykerCommand };
  if (binaryOnPath("mutmut")) return { id: "mutmut", buildCommand: mutmutCommand };
  return null;
}

function matchesPathScope(file, paths) {
  if (!paths) return true;
  return paths.some((p) => file === p || file.startsWith(p.endsWith("/") ? p : `${p}/`) || file.startsWith(p));
}

function scopeFiles(changedFiles, paths) {
  return (changedFiles || []).filter((f) => matchesPathScope(f, paths));
}

// Try every known runner's output format in turn; the first that matches
// wins. Returns null when nothing parses — the caller must treat that as
// an honest skip, not a score of 0.
function parseScore(output) {
  const stryker = STRYKER_SCORE_RE.exec(output);
  if (stryker) {
    const killed = Number(stryker[1]);
    const total = Number(stryker[2]);
    const pct = Number(stryker[3]);
    return {
      format: "stryker",
      score: pct / 100,
      mutants: { generated: total, killed, survived: total - killed, timed_out: 0 },
    };
  }
  const mutmut = MUTMUT_SCORE_RE.exec(output);
  if (mutmut) {
    const total = Number(mutmut[2]);
    const killed = Number(mutmut[3]);
    const timedOut = Number(mutmut[4]);
    const suspicious = Number(mutmut[5]);
    const survived = Number(mutmut[6]);
    const skipped = Number(mutmut[7]);
    const denom = total - timedOut - skipped;
    return {
      format: "mutmut",
      score: denom > 0 ? killed / denom : null,
      mutants: { generated: total, killed, survived: survived + suspicious, timed_out: timedOut },
    };
  }
  return null;
}

// Public entry point. Returns a single { ran, skipped, reason, ... } record
// shaped like every other mechanical check in this codebase (see
// ./redteam-floor.js's `record()`), plus score/runner/scope/mutants when a
// run actually completed and parsed.
async function runMutationGate(cwd, config, changedFiles) {
  const mCfg = resolveMutationConfig(config);
  if (!mCfg.enabled) {
    return { ran: false, skipped: true, reason: "mutation gate disabled (pipeline.verify.mutation.enabled=false, default)" };
  }

  const files = changedFiles || [];
  const scoped = scopeFiles(files, mCfg.paths);
  if (scoped.length === 0) {
    return {
      ran: false,
      skipped: true,
      reason: mCfg.paths
        ? "no changed files fall within pipeline.verify.mutation.paths"
        : "no changed files detected to mutate",
      scope: { changed_files: files.length, mutated_files: [] },
    };
  }

  let runnerId;
  let command;
  if (mCfg.command) {
    runnerId = "configured";
    command = mCfg.command;
  } else {
    const runner = detectRunner(cwd);
    if (!runner) {
      return {
        ran: false,
        skipped: true,
        reason: "no supported mutation runner found — Stryker via package.json devDependency (@stryker-mutator/core) or mutmut on PATH; devteam never installs either",
        scope: { changed_files: files.length, mutated_files: scoped },
      };
    }
    runnerId = runner.id;
    command = runner.buildCommand(scoped);
  }

  const result = await runCommand(command, { cwd, timeoutMs: mCfg.timeout_ms });
  const scope = { changed_files: files.length, mutated_files: scoped };

  if (result.timedOut) {
    return {
      ran: false,
      skipped: true,
      reason: `mutation run exceeded timeout_ms=${mCfg.timeout_ms} — killed`,
      runner: runnerId,
      command,
      duration_ms: result.durationMs,
      timed_out: true,
      scope,
    };
  }
  if (result.spawnError) {
    return {
      ran: false,
      skipped: true,
      reason: `could not run mutation command: ${result.spawnError}`,
      runner: runnerId,
      command,
      scope,
    };
  }

  const parsed = parseScore(`${result.stdout}\n${result.stderr}`);
  if (!parsed || parsed.score === null) {
    return {
      ran: false,
      skipped: true,
      reason: `mutation output unparseable (exit ${result.exitCode})`,
      runner: runnerId,
      command,
      exit_code: result.exitCode,
      duration_ms: result.durationMs,
      scope,
    };
  }

  return {
    ran: true,
    skipped: false,
    reason: `${command} (exit ${result.exitCode})`,
    runner: runnerId,
    command,
    exit_code: result.exitCode,
    duration_ms: result.durationMs,
    score: parsed.score,
    mutants: parsed.mutants,
    threshold: mCfg.threshold,
    threshold_hard: mCfg.threshold_hard,
    scope,
  };
}

module.exports = {
  runMutationGate,
  resolveMutationConfig,
  detectRunner,
  parseScore,
  scopeFiles,
};
