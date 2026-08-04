"use strict";

// `devteam review-pr <number|url>` — phase-35 item 35.2
// (plans/phase-35-existing-codebase-mode.md).
//
// Materializes an inbound GitHub PR (unified diff, changed-file list, PR
// title/body as the stated intent — the closest thing to a brief a PR
// provides) into pipeline/review-input/, then dispatches stage-05
// (peer-review) against it on the `review-pr` track: a single "reviewer"
// workstream in panel mode, reviewer-then-critic when review.mode:
// adversarial (31.3) — see PEER_REVIEW_SIZING["review-pr"] and
// STAGES_BY_TRACK["review-pr"] in core/pipeline/stages.js. Output is a
// normal stage-05 gate plus pipeline/code-review/by-*.md, exactly as any
// other peer-review dispatch produces.
//
// Local-only by default: nothing is sent anywhere unless --post is passed.
// `gh` auth/error handling is reused from scripts/pr-publish.js (the only
// existing place that shells to `gh`) rather than inventing a second
// pattern.

const fs = require("node:fs");
const path = require("node:path");
const readline = require("node:readline");

const { generateHelp } = require(path.join(__dirname, "..", "flags"));
const { getOrchestrator } = require(path.join(__dirname, "..", "get-orchestrator"));
const { loadConfig } = require(path.join(__dirname, "..", "..", "config"));
const { pipelineRoot } = require(path.join(__dirname, "..", "..", "paths"));
const { loadGateSafe } = require(path.join(__dirname, "..", "..", "gates", "load-gate"));
const { gh, ensureGh } = require(path.join(__dirname, "..", "..", "..", "scripts", "pr-publish"));

const name = "review-pr";

const flags = {
  cwd:  { type: "string",  description: "Target project directory" },
  post: { type: "boolean", description: "Publish the review as a PR comment (opt-in; see --yes)" },
  yes:  { type: "boolean", description: "Auto-confirm --post; required in a non-interactive context" },
  json: { type: "boolean", description: "JSON output" },
  help: { type: "boolean", description: "Show this help" },
};

// ---------------------------------------------------------------------------
// Materialize the PR into pipeline/review-input/
// ---------------------------------------------------------------------------

function materializeReviewInput(cwd, prArg) {
  const view = gh(["pr", "view", prArg, "--json", "number,title,body,url,headRefName,baseRefName,headRefOid,files"], { cwd });
  if (view.status !== 0) {
    throw new Error(`could not fetch PR "${prArg}": ${(view.stderr || "").trim() || "gh pr view failed"}`);
  }
  let meta;
  try {
    meta = JSON.parse(view.stdout);
  } catch (err) {
    throw new Error(`could not parse \`gh pr view\` output for "${prArg}": ${err.message}`);
  }

  const diff = gh(["pr", "diff", prArg], { cwd });
  if (diff.status !== 0) {
    throw new Error(`could not fetch diff for PR "${prArg}": ${(diff.stderr || "").trim() || "gh pr diff failed"}`);
  }

  // Clear+recreate: a re-run must never leave a previous PR's stale files
  // sitting alongside the new ones.
  const inputDir = path.join(pipelineRoot(cwd, null), "review-input");
  fs.rmSync(inputDir, { recursive: true, force: true });
  fs.mkdirSync(inputDir, { recursive: true });

  const files = Array.isArray(meta.files) ? meta.files : [];
  fs.writeFileSync(
    path.join(inputDir, "changed-files.md"),
    [
      `# Changed files — PR #${meta.number}`,
      "",
      ...(files.length > 0
        ? files.map((f) => `- ${f.path} (+${f.additions ?? 0}/-${f.deletions ?? 0})`)
        : ["(gh reported no changed-file list for this PR)"]),
      "",
    ].join("\n"),
  );

  fs.writeFileSync(
    path.join(inputDir, "pr.md"),
    [
      `# PR #${meta.number}: ${meta.title || "(no title)"}`,
      "",
      `URL: ${meta.url || "(unknown)"}`,
      `Base: ${meta.baseRefName || "(unknown)"}  <-  Head: ${meta.headRefName || "(unknown)"} (${meta.headRefOid || "(unknown)"})`,
      "",
      "## Stated intent (PR description)",
      "",
      meta.body && meta.body.trim() ? meta.body.trim() : "(no PR description provided)",
      "",
    ].join("\n"),
  );

  fs.writeFileSync(path.join(inputDir, "diff.patch"), diff.stdout);

  return {
    number: meta.number,
    title: meta.title || "",
    url: meta.url || "",
    changedFileCount: files.length,
  };
}

// ---------------------------------------------------------------------------
// Post-dispatch gate collection
// ---------------------------------------------------------------------------

// Reduces runStageHeadless()'s per-workstream results to a single verdict:
// { partial, gate, reason?, workstreams }. `partial` means the dispatch
// itself did not complete cleanly (timeout / non-zero exit / no gate
// written / merge failure) — NOT that the review's substance is FAIL. A
// completed review that says FAIL is still a complete review.
function collectGateInfo(cwd, result) {
  const { mergeWorkstreamGates } = getOrchestrator();
  const workstreams = result.results.map((r) => ({
    role: r.role, host: r.host, exitCode: r.exitCode, timedOut: Boolean(r.timedOut), gatePath: r.gatePath,
  }));
  const anyIncomplete = result.results.some((r) => r.timedOut || r.exitCode !== 0 || !r.gatePath);
  if (anyIncomplete) {
    return { partial: true, gate: null, workstreams, reason: "one or more workstreams did not complete (timeout, non-zero exit, or no gate written)" };
  }

  if (result.results.length > 1) {
    const merged = mergeWorkstreamGates("peer-review", { cwd, track: "review-pr" });
    if (!merged.merged) {
      return { partial: true, gate: null, workstreams, reason: merged.reason };
    }
    return { partial: false, gate: merged.gate, workstreams };
  }

  const { gate, error } = loadGateSafe(result.results[0].gatePath);
  if (error) {
    return { partial: true, gate: null, workstreams, reason: error };
  }
  return { partial: false, gate, workstreams };
}

// ---------------------------------------------------------------------------
// --post gating: local-only by default; publishing is opt-in and confirmed.
// ---------------------------------------------------------------------------

function buildReviewBody(cwd) {
  const dir = path.join(pipelineRoot(cwd, null), "code-review");
  const parts = [];
  for (const f of ["by-reviewer.md", "by-critic.md"]) {
    const p = path.join(dir, f);
    if (fs.existsSync(p)) {
      const content = fs.readFileSync(p, "utf8").trim();
      if (content) parts.push(content);
    }
  }
  return parts.join("\n\n---\n\n");
}

function askYesNo(question) {
  return new Promise((resolve) => {
    const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
    rl.question(question, (answer) => {
      rl.close();
      resolve(/^y(es)?$/i.test(answer.trim()));
    });
  });
}

// Never posts on a partial/incomplete review — the confirmation step below
// is load-bearing (posting to someone else's PR is public and hard to
// retract), not decorative, so every refusal here throws rather than
// silently no-op'ing.
function handlePost(cwd, prArg, gateInfo, _flags) {
  if (!_flags.post) return Promise.resolve({ posted: false });

  if (gateInfo.partial || !gateInfo.gate) {
    throw new Error(`refusing to --post: the review did not complete (${gateInfo.reason || "no valid stage-05 gate"}).`);
  }

  const body = buildReviewBody(cwd);
  if (!body) {
    throw new Error("refusing to --post: no pipeline/code-review/by-*.md content found to publish.");
  }

  // Printed to stderr (never stdout) so --post --json still emits nothing
  // but a single parseable JSON object on stdout.
  process.stderr.write("\nThe following will be posted to the PR as a review comment:\n\n");
  process.stderr.write(`${"─".repeat(72)}\n`);
  process.stderr.write(`${body}\n`);
  process.stderr.write(`${"─".repeat(72)}\n`);

  const interactive = Boolean(process.stdin.isTTY && process.stdout.isTTY);
  if (!interactive && !_flags.yes) {
    throw new Error("refusing to --post in a non-interactive context without --yes.");
  }

  const confirmed = _flags.yes ? Promise.resolve(true) : askYesNo("\nPost this review to the PR? [y/N] ");
  return confirmed.then((yes) => {
    if (!yes) {
      process.stderr.write("Not posted (declined).\n");
      return { posted: false };
    }
    ensureGh();
    const r = gh(["pr", "review", prArg, "--comment", "--body-file", "-"], { cwd, input: body });
    if (r.status !== 0) {
      throw new Error(`gh pr review failed: ${(r.stderr || "").trim()}`);
    }
    return { posted: true };
  });
}

// ---------------------------------------------------------------------------
// CLI entry
// ---------------------------------------------------------------------------

function run(positional, _flags) {
  if (_flags.help) {
    console.log(generateHelp("devteam review-pr <number|url> [options]", flags));
    process.exit(0);
  }
  const prArg = positional[0];
  if (!prArg) {
    console.error(generateHelp("devteam review-pr <number|url> [options]", flags));
    process.exit(2);
  }
  const cwd = _flags.cwd || process.cwd();

  if (!_flags.json && !fs.existsSync(path.join(cwd, ".devteam", "config.yml"))) {
    process.stderr.write(
      `\n⚠️  ${cwd}\n` +
      `   does not look like an initialised Stagecraft target project (no .devteam/config.yml).\n` +
      `   Run \`devteam init --host <name> --cwd "${cwd}"\` first.\n\n`,
    );
  }

  ensureGh();

  let prMeta;
  try {
    prMeta = materializeReviewInput(cwd, prArg);
  } catch (err) {
    console.error(`devteam review-pr: ${err.message}`);
    process.exit(1);
    return;
  }
  process.stderr.write(
    `[devteam review-pr] materialized PR #${prMeta.number} (${prMeta.changedFileCount} changed file(s)) into pipeline/review-input/\n`,
  );

  const { runStageHeadless } = getOrchestrator();
  const config = loadConfig(cwd);

  // --json must emit exactly one parseable object on stdout. Dispatch has a
  // stdout side effect outside our control: runHeadless's post-dispatch
  // approval-derivation fallback (core/adapters/headless.js) logs a
  // "[approval-derivation] ..." line via console.log for every
  // pipeline/code-review/by-*.md file it sees, in the SAME process (not a
  // subprocess) — the same reason `devteam stage --headless` never combines
  // with --json. Redirect console.log to stderr only for the duration of
  // dispatch, only in --json mode, so those diagnostics stay visible without
  // corrupting the JSON stream; non-JSON mode is unaffected.
  const withJsonSafeStdout = (fn) => {
    if (!_flags.json) return fn();
    const originalLog = console.log;
    console.log = (...args) => process.stderr.write(`${args.join(" ")}\n`);
    const restore = () => { console.log = originalLog; };
    return fn().then((v) => { restore(); return v; }, (err) => { restore(); throw err; });
  };

  withJsonSafeStdout(() => runStageHeadless("peer-review", { cwd, track: "review-pr", config }))
    .then((result) => {
      const gateInfo = collectGateInfo(cwd, result);
      return handlePost(cwd, prArg, gateInfo, _flags).then((postResult) => ({ gateInfo, postResult }));
    })
    .then(({ gateInfo, postResult }) => {
      const exitCode = gateInfo.partial
        ? 1
        : (gateInfo.gate.status === "FAIL" || gateInfo.gate.status === "ESCALATE" ? 1 : 0);

      if (_flags.json) {
        console.log(JSON.stringify({
          pr: prMeta,
          stage: "stage-05",
          partial: gateInfo.partial,
          reason: gateInfo.reason || null,
          gate: gateInfo.gate,
          posted: postResult.posted,
        }, null, 2));
      } else if (gateInfo.partial) {
        console.log(`✗ review incomplete: ${gateInfo.reason}`);
      } else {
        console.log(`Gate: pipeline/gates/stage-05.json → ${gateInfo.gate.status}`);
        const blockers = gateInfo.gate.blockers || [];
        for (const b of blockers) {
          console.log(`  BLOCKER: ${typeof b === "string" ? b : (b.summary || JSON.stringify(b))}`);
        }
        console.log(postResult.posted ? "Posted to PR." : "Not posted (local only).");
      }
      process.exit(exitCode);
    })
    .catch((err) => {
      console.error(`devteam review-pr: ${err.message}`);
      process.exit(1);
    });
}

module.exports = { name, flags, run };
