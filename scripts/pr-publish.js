#!/usr/bin/env node
// pr-publish.js — publish stagecraft pipeline state to a GitHub PR.
//
// Two modes:
//
//   body    — replace the PR description with `pr-pack` output.
//             Idempotent: run again after each pipeline change to
//             keep the PR description in sync.
//
//   checks  — post each gate as a GitHub check run on the PR's
//             head commit. PASS→success, WARN→neutral, FAIL/
//             ESCALATE→failure. Surfaces in the PR's status bar
//             so reviewers see "10/12 stages passing" at a glance.
//
//   all     — both of the above.
//
// Auth: uses `gh` CLI (must be installed and `gh auth status` clean).
// We never handle tokens directly.
//
// Usage:
//   node scripts/pr-publish.js                            # auto-detect PR+repo, mode=body
//   node scripts/pr-publish.js --pr 42                    # explicit PR number
//   node scripts/pr-publish.js --repo owner/repo --pr 42
//   node scripts/pr-publish.js --mode checks              # post checks
//   node scripts/pr-publish.js --mode all                 # body + checks
//   node scripts/pr-publish.js --dry-run                  # print what would happen
//
// Library use:
//   const { buildCheckRuns, publish } = require("./pr-publish");

const fs = require("node:fs");
const path = require("node:path");
const { spawnSync } = require("node:child_process");
const REPO_ROOT = path.resolve(__dirname, "..");

function parseArgs(argv) {
  const args = { pr: null, repo: null, mode: "body", cwd: process.cwd(), dryRun: false };
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === "--pr") args.pr = argv[++i];
    else if (argv[i] === "--repo") args.repo = argv[++i];
    else if (argv[i] === "--mode") args.mode = argv[++i];
    else if (argv[i] === "--cwd") args.cwd = argv[++i];
    else if (argv[i] === "--dry-run") args.dryRun = true;
    else if (argv[i] === "-h" || argv[i] === "--help") args.help = true;
  }
  if (!["body", "checks", "all"].includes(args.mode)) {
    fail(`Invalid --mode "${args.mode}". Choose: body, checks, all.`);
  }
  return args;
}

function fail(msg) { process.stderr.write(`[pr-publish] ${msg}\n`); process.exit(2); }

// ---------------------------------------------------------------------------
// gh CLI wrapper
// ---------------------------------------------------------------------------

function gh(args, opts = {}) {
  return spawnSync("gh", args, {
    encoding: "utf8",
    cwd: opts.cwd || process.cwd(),
    input: opts.input,
  });
}

function ensureGh() {
  const r = spawnSync("gh", ["--version"], { encoding: "utf8" });
  if (r.status !== 0) {
    fail("`gh` CLI not found on PATH. Install from https://cli.github.com/ and run `gh auth login`.");
  }
  const auth = spawnSync("gh", ["auth", "status"], { encoding: "utf8" });
  if (auth.status !== 0) {
    fail("`gh auth status` reported not-authenticated. Run `gh auth login` first.");
  }
}

function detectRepo(cwd) {
  // `gh repo view` reads the current git remote.
  const r = gh(["repo", "view", "--json", "nameWithOwner"], { cwd });
  if (r.status !== 0) {
    fail(`Could not detect GitHub repo from ${cwd}. Pass --repo owner/repo.\n${r.stderr}`);
  }
  return JSON.parse(r.stdout).nameWithOwner;
}

function detectPR(cwd) {
  const r = gh(["pr", "view", "--json", "number,headRefOid"], { cwd });
  if (r.status !== 0) {
    fail("No PR detected for the current branch. Pass --pr <number> or push a PR for this branch.");
  }
  const obj = JSON.parse(r.stdout);
  return { number: obj.number, headSha: obj.headRefOid };
}

function getPRHeadSha(repo, prNumber) {
  const r = gh(["api", `repos/${repo}/pulls/${prNumber}`, "--jq", ".head.sha"]);
  if (r.status !== 0) {
    fail(`Could not look up PR #${prNumber} on ${repo}.\n${r.stderr}`);
  }
  return r.stdout.trim();
}

// ---------------------------------------------------------------------------
// Gate → check run translation
// ---------------------------------------------------------------------------

const STATUS_TO_CONCLUSION = {
  PASS:     "success",
  WARN:     "neutral",
  FAIL:     "failure",
  ESCALATE: "failure",
};

function readGatesDir(cwd) {
  const dir = path.join(cwd, "pipeline", "gates");
  if (!fs.existsSync(dir)) return [];
  const out = [];
  for (const f of fs.readdirSync(dir)) {
    if (!f.endsWith(".json")) continue;
    try {
      const g = JSON.parse(fs.readFileSync(path.join(dir, f), "utf8"));
      g._file = f;
      out.push(g);
    } catch { /* skip malformed */ }
  }
  return out;
}

function buildCheckRuns(gates, headSha) {
  // One check run per gate file. Top-level merged gates and workstream
  // gates both produce a check; the merged gate's check covers the
  // aggregate status (PASS only when all workstreams PASS).
  return gates.map((g) => {
    const conclusion = STATUS_TO_CONCLUSION[g.status] || "neutral";
    const name = `devteam: ${g.stage}${g.workstream ? `/${g.workstream}` : ""}`;
    const summaryParts = [`Status: ${g.status}`];
    if (g.host) summaryParts.push(`Host: ${g.host}`);
    if (g.orchestrator) summaryParts.push(`Orchestrator: ${g.orchestrator}`);
    const summary = summaryParts.join("  •  ");

    const bodyLines = [];
    if (Array.isArray(g.blockers) && g.blockers.length > 0) {
      bodyLines.push("**Blockers:**");
      for (const b of g.blockers) bodyLines.push(`- ${b}`);
    }
    if (Array.isArray(g.warnings) && g.warnings.length > 0) {
      bodyLines.push("**Warnings:**");
      for (const w of g.warnings) bodyLines.push(`- ${w}`);
    }
    if (Array.isArray(g.workstreams) && g.workstreams.length > 0) {
      bodyLines.push("**Workstreams:**");
      for (const w of g.workstreams) bodyLines.push(`- ${w.workstream} (${w.host || "—"}): ${w.status}`);
    }
    if (bodyLines.length === 0) bodyLines.push("_No additional findings recorded on this gate._");

    return {
      name,
      head_sha: headSha,
      status: "completed",
      conclusion,
      output: {
        title: name,
        summary,
        text: bodyLines.join("\n"),
      },
    };
  });
}

function postCheckRuns(repo, runs, opts = {}) {
  const results = [];
  for (const run of runs) {
    if (opts.dryRun) {
      results.push({ name: run.name, conclusion: run.conclusion, posted: false, dryRun: true });
      continue;
    }
    const r = gh(
      ["api", `repos/${repo}/check-runs`, "-X", "POST",
       "--input", "-",
      ],
      { input: JSON.stringify(run) },
    );
    if (r.status !== 0) {
      results.push({ name: run.name, posted: false, error: r.stderr.trim() });
    } else {
      const parsed = JSON.parse(r.stdout);
      results.push({ name: run.name, conclusion: run.conclusion, posted: true, id: parsed.id });
    }
  }
  return results;
}

function publishBody(repo, pr, body, opts = {}) {
  if (opts.dryRun) {
    process.stderr.write(`[pr-publish] DRY RUN: would replace PR #${pr} body on ${repo} (${body.length} chars)\n`);
    return { posted: false, dryRun: true };
  }
  const r = gh(["pr", "edit", String(pr), "--repo", repo, "--body-file", "-"], { input: body });
  if (r.status !== 0) {
    fail(`Failed to update PR body: ${r.stderr.trim()}`);
  }
  return { posted: true };
}

// ---------------------------------------------------------------------------
// Public API + CLI
// ---------------------------------------------------------------------------

function publish(args) {
  // Dry-run can skip gh entirely IF the caller supplied --pr and --repo
  // explicitly — useful for previewing in environments where gh isn't
  // configured (CI smoke tests, demos).
  const needsGh = !args.dryRun || !args.pr || !args.repo;
  if (needsGh) ensureGh();

  const repo = args.repo || detectRepo(args.cwd);
  let prNumber = args.pr;
  let headSha = null;
  if (!prNumber) {
    const pr = detectPR(args.cwd);
    prNumber = pr.number;
    headSha = pr.headSha;
  }
  const needHead = args.mode === "checks" || args.mode === "all";
  if (!headSha && needHead) {
    if (args.dryRun) {
      headSha = "<dry-run-placeholder-sha>";
    } else {
      headSha = getPRHeadSha(repo, prNumber);
    }
  }
  process.stderr.write(`[pr-publish] repo=${repo} pr=#${prNumber}${headSha ? ` head=${headSha.slice(0,7)}` : ""} mode=${args.mode}${args.dryRun ? " (DRY RUN)" : ""}\n`);

  const result = { repo, pr: prNumber, mode: args.mode };

  if (args.mode === "body" || args.mode === "all") {
    const { buildPRBody } = require(path.join(REPO_ROOT, "scripts", "pr-pack"));
    const body = buildPRBody(args.cwd);
    result.body = publishBody(repo, prNumber, body, { dryRun: args.dryRun });
  }

  if (args.mode === "checks" || args.mode === "all") {
    const gates = readGatesDir(args.cwd);
    const runs = buildCheckRuns(gates, headSha);
    result.checks = postCheckRuns(repo, runs, { dryRun: args.dryRun });
    process.stderr.write(`[pr-publish] ${result.checks.filter((c) => c.posted || c.dryRun).length}/${runs.length} check runs ${args.dryRun ? "would be posted" : "posted"}\n`);
  }

  return result;
}

function usage() {
  console.log(`pr-publish — publish stagecraft pipeline state to a GitHub PR

Usage:
  node scripts/pr-publish.js [--pr N] [--repo owner/repo] [--mode body|checks|all] [--dry-run]

Modes:
  body    Replace the PR description with pr-pack output (default).
  checks  Post each gate as a GitHub check run on the PR's head commit.
  all     Both of the above.

Requires \`gh\` CLI installed + \`gh auth login\` complete.

Auto-detection:
  --repo defaults to the current git remote's GitHub repo.
  --pr   defaults to the PR open on the current branch (must already exist).

Use --dry-run to preview what would be published without making changes.
`);
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.help) { usage(); return; }
  publish(args);
}

if (require.main === module) main();

module.exports = {
  buildCheckRuns,
  publish,
  readGatesDir,
  STATUS_TO_CONCLUSION,
  // Exported for reuse by other `gh`-shelling commands (e.g.
  // core/cli/commands/review-pr.js, phase-35 item 35.2) — one auth/error
  // pattern for shelling to `gh`, not a second one invented per caller.
  gh,
  ensureGh,
};
