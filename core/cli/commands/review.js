"use strict";

// `devteam review <path>` — phase-36 item 36.4
// (plans/phase-36-external-review-mode.md §36.4), the zero-install entry
// point the whole phase exists for: point Stagecraft at a repo you didn't
// build and never `init`, and get an adversarial review back. No config, no
// `.devteam/` written into the subject — every gate, artifact, and log lands
// in the review workspace (core/review-workspace.js, item 36.3) instead.
//
// Dispatch reuses the normal bounded driver (core/driver.js#run()) with
// ctx.cwd = the workspace (stateRoot) and ctx.processCwd = the subject
// (codeRoot), plus ctx.externalReviewMode = true — the same split 36.3
// wired through runStage()/runStageHeadless() but that, until this item, no
// caller ever set to true. hosts/acp/adapter.js reads externalReviewMode to
// flip its permission evaluator into review mode (hosts/acp/permissions.js):
// any write into codeRoot is denied, `execute` becomes a read-only allowlist.
// That mechanical enforcement only exists for the `acp` host — see the host
// honesty check below.
//
// On completion, runs 35.4's findings collector/renderer
// (core/report/collect-findings.js, core/report/render-findings-html.js)
// against the workspace and prints the report path, exactly as
// `devteam report --findings` does for an in-place run.

const fs = require("node:fs");
const path = require("node:path");

const { generateHelp } = require(path.join(__dirname, "..", "flags"));
const {
  reviewsRoot,
  resolveWorkspacePath,
  createReviewWorkspace,
  writeLastRun,
  listWorkspaces,
} = require(path.join(__dirname, "..", "..", "review-workspace"));
const { loadConfig, clearConfigCache } = require(path.join(__dirname, "..", "..", "config"));
const { TRACKS } = require(path.join(__dirname, "..", "..", "pipeline", "stages"));

const name = "review";

const REVIEW_SCHEMA_VERSION = "1.0";
const LIST_SCHEMA_VERSION = "1.0";

const flags = {
  scope:     { type: "list",    description: "Scope the review to this path within the subject (repeatable; review-only track)" },
  track:     { type: "string",  description: "Pipeline track to dispatch (default: review-only)" },
  host:      { type: "string",  description: "Dispatch host (default: acp — the only host that mechanically prevents writes to the subject)" },
  workspace: { type: "string",  description: "Override the derived ~/.stagecraft/reviews/<slug> workspace path" },
  "allow-unenforced-writes": { type: "boolean", description: "Required with --host anything other than acp: acknowledges that writes to the subject are not mechanically prevented" },
  json:      { type: "boolean", description: "JSON output" },
  open:      { type: "boolean", description: "Open the findings report in a browser when the run finishes" },
  list:      { type: "boolean", description: "List existing review workspaces instead of running a review" },
  help:      { type: "boolean", description: "Show this help" },
};

function usage() {
  return generateHelp("devteam review <path> [options]\n       devteam review --list", flags);
}

function openBrowser(filePath) {
  const { spawnSync } = require("node:child_process");
  const platform = process.platform;
  const cmd = platform === "darwin" ? "open" : platform === "win32" ? "explorer.exe" : "xdg-open";
  const options = platform === "win32"
    ? { stdio: "ignore", windowsVerbatimArguments: true }
    : { stdio: "ignore" };
  spawnSync(cmd, [filePath], options);
}

// ---------------------------------------------------------------------------
// --list
// ---------------------------------------------------------------------------

function runList(_flags) {
  const workspaces = listWorkspaces();
  if (_flags.json) {
    console.log(JSON.stringify({ schema_version: LIST_SCHEMA_VERSION, reviews_root: reviewsRoot(), workspaces }, null, 2));
    return;
  }
  if (workspaces.length === 0) {
    console.log(`No review workspaces yet under ${reviewsRoot()}.`);
    return;
  }
  console.log(`Review workspaces under ${reviewsRoot()}:\n`);
  for (const w of workspaces) {
    console.log(`  ${w.slug}`);
    console.log(`    subject:   ${w.subject_path || "(unknown)"}`);
    console.log(`    last run:  ${w.last_run_at || "(never)"}${w.last_status ? ` — ${w.last_status}` : ""}`);
    console.log("");
  }
}

// ---------------------------------------------------------------------------
// Host honesty (plan §36.4): acp is the only host that mechanically
// prevents writes to the subject (hosts/acp/permissions.js's two-root
// evaluator, 36.1). Every other host's allowed_writes enforcement is
// prompt-only or post-hoc-audit (hosts/*/capabilities.json,
// core/adapters/render-helpers.js#allowedWritesCaption) — real, but not a
// guarantee this command may advertise. --allow-unenforced-writes mirrors
// the house "allow-<compromised-guarantee>" convention (evidence.js's
// --allow-unverified: proceed anyway, but never silently claim the
// guarantee held).
// ---------------------------------------------------------------------------

function checkHostHonesty(host, subjectPath, ackGiven) {
  if (host === "acp") return { ok: true, enforced: true };
  const warning =
    `⚠️  --host ${host} cannot mechanically prevent writes to ${subjectPath}. ` +
    `Only "acp" enforces read-only review at tool-call time (hosts/acp/permissions.js's two-root ` +
    `evaluator); with --host ${host}, enforcement degrades to a post-hoc audit of what the agent ` +
    `actually wrote (core/adapters/headless.js's write-audit), not a prevention.`;
  if (!ackGiven) {
    process.stderr.write(`${warning}\n    Pass --allow-unenforced-writes to proceed anyway.\n`);
    return { ok: false, enforced: false };
  }
  process.stderr.write(`${warning}\n    Proceeding on --allow-unenforced-writes.\n`);
  return { ok: true, enforced: false };
}

// ---------------------------------------------------------------------------
// 35.4 findings report, generated against the workspace exactly as
// `devteam report --findings --cwd <workspace>` would.
// ---------------------------------------------------------------------------

function writeFindingsReport(workspacePath) {
  const { collectFindings } = require(path.join(__dirname, "..", "..", "report", "collect-findings"));
  const { renderFindingsHtml } = require(path.join(__dirname, "..", "..", "report", "render-findings-html"));
  const { pipelineRoot } = require(path.join(__dirname, "..", "..", "paths"));

  const data = collectFindings(workspacePath, {});
  const html = renderFindingsHtml(data);
  const outPath = path.join(pipelineRoot(workspacePath, null), "findings-report.html");
  fs.mkdirSync(path.dirname(outPath), { recursive: true });
  fs.writeFileSync(outPath, html, "utf8");
  return { path: outPath, total: data.counts.total };
}

// ---------------------------------------------------------------------------
// CLI entry
// ---------------------------------------------------------------------------

function run(positional, _flags) {
  if (_flags.help) { console.log(usage()); process.exit(0); }
  if (_flags.list) { runList(_flags); process.exit(0); return; }

  const subjectArg = positional[0];
  if (!subjectArg) {
    console.error(usage());
    process.exit(2);
    return;
  }
  const subjectPath = path.resolve(subjectArg);
  if (!fs.existsSync(subjectPath) || !fs.statSync(subjectPath).isDirectory()) {
    console.error(`devteam review: "${subjectPath}" is not a directory`);
    process.exit(1);
    return;
  }

  const host = _flags.host || "acp";
  const honesty = checkHostHonesty(host, subjectPath, _flags.allowUnenforcedWrites === true);
  if (!honesty.ok) {
    process.exit(1);
    return;
  }

  const track = _flags.track || "review-only";
  if (!TRACKS.includes(track)) {
    console.error(`devteam review: unknown track "${track}". Valid: ${TRACKS.join(", ")}`);
    process.exit(2);
    return;
  }

  const workspacePath = resolveWorkspacePath(subjectPath, _flags.workspace);
  let subject;
  try {
    ({ subject } = createReviewWorkspace({ subjectPath, workspacePath, host, track }));
  } catch (err) {
    console.error(`devteam review: could not create workspace at "${workspacePath}": ${err.message}`);
    process.exit(1);
    return;
  }
  clearConfigCache();
  const config = loadConfig(workspacePath);

  process.stderr.write(`[devteam review] workspace: ${workspacePath}\n`);
  process.stderr.write(`[devteam review] subject:   ${subjectPath}${subject.commit_sha ? ` @ ${subject.commit_sha.slice(0, 12)}` : ""}\n`);

  const { run: runDriver } = require(path.join(__dirname, "..", "..", "driver"));
  const startedAt = new Date().toISOString();

  const onEvent = (ev) => {
    if (_flags.json) return; // keep stdout clean for the JSON summary
    switch (ev.type) {
      case "dispatch":  process.stderr.write(`▶️  ${ev.name} (${ev.stage}) — dispatching…\n`); break;
      case "merge":     process.stderr.write(`🔀 merge ${ev.name}\n`); break;
      case "complete":  process.stderr.write(`🎉 review-complete\n`); break;
      case "halt":      process.stderr.write(`⏸  halt — ${ev.action}: ${ev.reason}\n`); break;
      default: break;
    }
  };

  // --json must emit exactly one parseable object on stdout — same
  // console.log-redirection trick as review-pr.js, needed because
  // core/adapters/headless.js's approval-derivation fallback logs
  // "[approval-derivation] ..." via console.log in-process for non-hook hosts.
  const withJsonSafeStdout = (fn) => {
    if (!_flags.json) return fn();
    const originalLog = console.log;
    console.log = (...args) => process.stderr.write(`${args.join(" ")}\n`);
    const restore = () => { console.log = originalLog; };
    return fn().then((v) => { restore(); return v; }, (err) => { restore(); throw err; });
  };

  withJsonSafeStdout(() => runDriver({
    cwd: workspacePath,
    processCwd: subjectPath,
    externalReviewMode: true,
    track,
    scope: _flags.scope || [],
    config,
    onEvent,
  }))
    .then((summary) => {
      const findings = writeFindingsReport(workspacePath);
      writeLastRun(workspacePath, {
        startedAt,
        status: summary.completed ? "completed" : "halted",
        haltAction: summary.halt_action,
        track,
        findingsReport: findings.path,
      });

      if (_flags.json) {
        console.log(JSON.stringify({
          schema_version: REVIEW_SCHEMA_VERSION,
          subject: { path: subject.subject_path, remote: subject.remote, commit_sha: subject.commit_sha },
          workspace: workspacePath,
          host,
          track,
          review_mode_enforced: honesty.enforced,
          completed: summary.completed,
          halted: summary.halted,
          halt_action: summary.halt_action,
          findings_report: findings,
        }, null, 2));
      } else {
        const status = summary.completed ? "complete" : `halted (${summary.halt_action})`;
        console.log(`\n[devteam review] ${status}`);
        console.log(`Findings report: ${findings.path} (${findings.total} finding${findings.total === 1 ? "" : "s"})`);
      }
      if (_flags.open) openBrowser(findings.path);
      process.exit(summary.completed ? 0 : 1);
    })
    .catch((err) => {
      writeLastRun(workspacePath, { startedAt, status: "error", track });
      console.error(`devteam review: ${err.message}`);
      process.exit(1);
    });
}

module.exports = { name, flags, run };
