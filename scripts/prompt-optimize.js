#!/usr/bin/env node
// prompt-optimize.js — GEPA-style offline reflective prompt optimizer
// (phase-33 item 33.4, plans/phase-33-eval-flywheel.md §33.4).
//
// Out-of-band, like scripts/budget.js and scripts/routing-suggest.js —
// deliberately NOT a `devteam` command. This is an experimental, human-gated
// research tool: it proposes a revised role brief (roles/<role>.md) or rule
// file (rules/<name>.md) by reflecting on captured eval-case failures
// (core/evals/capture.js, 33.1) with a frontier model, then measures the
// proposal against `devteam evals run --stub`-equivalent structural/budget
// checks plus a bounded, budget-capped real-model dispatch subset
// (core/evals/run.js, 33.2). It NEVER writes the target file — it prints a
// unified diff for a human to review and apply like any other PR, mirroring
// GEPA's reflective-mutation loop (Agrawal et al., "GEPA: Reflective Prompt
// Evolution Can Outperform Reinforcement Learning," arXiv:2507.19457) minus
// the RL rollouts: one frontier-model diagnosis per iteration, scored
// against real structural/behavioral signal, keeping a Pareto frontier
// (pass-rate vs. token size) rather than a single greedy winner (arXiv
// §3.2's `nonDominatedSelect` — collapsing to a greedy max would let a
// candidate that regresses token cost win purely on pass-rate noise).
//
// VERIFY-FIRST note (plan item 33.4): every host adapter renders a role
// brief or rule file as a PATH POINTER ("Read the role prompt at `X`" /
// "Use the **Y** subagent (`Z.md`)"), never inlined content — confirmed by
// reading core/adapters/markdown-host.js#renderStagePromptLayers and
// hosts/claude-code/adapter.js#renderStagePromptLayers. This means a
// candidate's own content never changes the rendered dispatch PROMPT, only
// what a real host agent reads from disk when it acts on that pointer.
// Consequently "structurally valid + within prompt budget" (this item's
// acceptance) is checked two ways, not one:
//   1. structural: the real, unmodified `core/evals/run.js#scoreStub` path
//      over this target's exercised cases (proves the current framework
//      still renders/dispatches — a sanity floor, not a candidate-specific
//      score, since content-invariant for this reason).
//   2. budget: scripts/prompt-budget.js#computeStageStats's own byte
//      accounting (the thing docs/reference/prompt-budget.md's ceilings are
//      about) recomputed with the candidate's byte count substituted for
//      the target file — this DOES change per the candidate, and is what
//      "within prompt budget" concretely means here.
// The candidate's real behavioral effect is measured only by the bounded
// real-model subset below, where the candidate is patched into a scratch
// project a live host CLI actually reads from.
//
// Usage:
//   node scripts/prompt-optimize.js --target roles/backend.md --budget-usd 2
//   node scripts/prompt-optimize.js --target rules/pipeline.md --budget-usd 5 \
//     --model claude-code --iterations 3 --sample 5 --json
//
// --model selects the dispatch HOST adapter (same convention as
// `devteam evals run --headless-host`) — Stagecraft always resolves an
// actual model id indirectly via host + routing.tiers, never a bare model
// flag, so this script follows that precedent rather than inventing a new
// one (see DEVIATIONS in this item's final report).
//
// Output: a proposed unified diff for ONLY the target file + an evidence
// table (pass-rate before/after on the eval subset, token delta, spend) to
// stdout, and a JSON report under .devteam/evals/optimize/. Never writes
// the target file itself — see writeCandidateGuard() below.

"use strict";

const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { spawn, spawnSync } = require("node:child_process");

const REPO_ROOT = path.resolve(__dirname, "..");

const { STAGES } = require(path.join(REPO_ROOT, "core", "pipeline", "stages"));
const { loadConfig } = require(path.join(REPO_ROOT, "core", "config"));
const { loadAdapter } = require(path.join(REPO_ROOT, "core", "router"));
const { splitCommand } = require(path.join(REPO_ROOT, "core", "command-line"));
const { readCorpus } = require(path.join(REPO_ROOT, "core", "corpus"));
const { pricingFor, formatUsd } = require(path.join(REPO_ROOT, "core", "pricing"));
const { mostRecentModelObserved } = require(path.join(REPO_ROOT, "core", "ceremony-preview"));
const {
  loadCases,
  renderForCase,
  scoreStub,
  scoreHeadless,
  cleanupScratchProject,
} = require(path.join(REPO_ROOT, "core", "evals", "run"));
const { computeStageStats, parseCommittedBudget } = require("./prompt-budget");

const OPTIMIZE_DIR = path.join(".devteam", "evals", "optimize");
const DEFAULT_ITERATIONS = 4;
const DEFAULT_SAMPLE = 5;
const DIAGNOSIS_TIMEOUT_MS = 5 * 60 * 1000;
const PROMPT_BUDGET_DOC = path.join(REPO_ROOT, "docs", "reference", "prompt-budget.md");

// A unique marker so a scripted test host (or a real model reading the
// prompt) can tell a diagnosis call apart from an ordinary stage dispatch —
// the two share a headless command in both real and scripted use.
const DIAGNOSIS_MARKER = "## GEPA-PROMPT-OPTIMIZE-DIAGNOSIS-v1 ##";

// ---------------------------------------------------------------------------
// CLI args
// ---------------------------------------------------------------------------

function parseArgs(argv) {
  const args = {
    cwd: process.cwd(),
    target: null,
    budgetUsd: null,
    model: null,
    iterations: DEFAULT_ITERATIONS,
    sample: DEFAULT_SAMPLE,
    json: false,
    help: false,
  };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--cwd") args.cwd = argv[++i];
    else if (a === "--target") args.target = argv[++i];
    else if (a === "--budget-usd") args.budgetUsd = Number(argv[++i]);
    else if (a === "--model") args.model = argv[++i];
    else if (a === "--iterations") args.iterations = Number(argv[++i]);
    else if (a === "--sample") args.sample = Number(argv[++i]);
    else if (a === "--json") args.json = true;
    else if (a === "--help" || a === "-h") args.help = true;
  }
  return args;
}

function usage() {
  return [
    "Usage: node scripts/prompt-optimize.js --target <roles/x.md|rules/y.md> --budget-usd <n> [options]",
    "",
    "Required:",
    "  --target <path>      Exactly one roles/<role>.md or rules/<name>.md file.",
    "  --budget-usd <n>     Hard cap on estimated spend. Refused without this.",
    "",
    "Options:",
    "  --cwd <dir>          Target project directory (default: cwd). Its captured",
    "                       .devteam/evals/cases/ supply the failure signal.",
    "  --model <host>       Dispatch host adapter (default: routing.default_host).",
    "  --iterations <n>     Bounded reflective-loop rounds (default: 4).",
    "  --sample <n>         Cases sampled per real-model scoring pass (default: 5).",
    "  --json               Emit the JSON report to stdout instead of a table.",
    "",
    "Never writes the target file. Prints a unified diff for human review.",
  ].join("\n");
}

// ---------------------------------------------------------------------------
// Target resolution
// ---------------------------------------------------------------------------

// Parse "--target" into { kind: "role"|"rule", name, relPath }. Throws on
// anything that isn't exactly one roles/<x>.md or rules/<y>.md path.
function parseTarget(targetArg) {
  if (typeof targetArg !== "string" || !targetArg) {
    throw new Error("--target is required (exactly one roles/<x>.md or rules/<y>.md file)");
  }
  const m = /^(roles|rules)\/([A-Za-z0-9_-]+)\.md$/.exec(targetArg.trim());
  if (!m) {
    throw new Error(`--target "${targetArg}" must match roles/<name>.md or rules/<name>.md`);
  }
  const kind = m[1] === "roles" ? "role" : "rule";
  const name = m[2];
  const relPath = `${m[1]}/${name}.md`;
  const absPath = path.join(REPO_ROOT, relPath);
  if (!fs.existsSync(absPath)) {
    throw new Error(`--target "${relPath}" does not exist under ${REPO_ROOT}`);
  }
  return { kind, name, relPath, absPath };
}

// Stage ids whose dispatch actually exercises this target: for a role, any
// stage whose dispatched brief is that role (mirrors scripts/prompt-budget.js's
// dispatchRole resolution — a `subagent` override, e.g. peer-review, always
// dispatches the same brief regardless of the per-area `roles` entries); for
// a rule, any stage whose readFirst names it under .devteam/rules/.
function exercisedStageIds(target) {
  const ids = [];
  for (const [, def] of Object.entries(STAGES)) {
    if (!def || !Array.isArray(def.roles) || def.roles.length === 0) continue;
    if (target.kind === "role") {
      const dispatched = def.subagent ? [def.subagent] : def.roles;
      if (dispatched.includes(target.name)) ids.push(def.stage);
    } else {
      const wanted = `.devteam/rules/${target.name}.md`;
      if ((def.readFirst || []).includes(wanted)) ids.push(def.stage);
    }
  }
  return [...new Set(ids)];
}

// ---------------------------------------------------------------------------
// Budget-ceiling impact (prompt-budget.md accounting, not rendered-prompt
// bytes — see the VERIFY-FIRST header note on why the rendered prompt is
// content-invariant for role/rule bodies).
// ---------------------------------------------------------------------------

function committedCeilings() {
  let text;
  try { text = fs.readFileSync(PROMPT_BUDGET_DOC, "utf8"); } catch { return new Map(); }
  return parseCommittedBudget(text);
}

// Recompute each exercised stage's dispatch-byte total as if the target
// file were candidateBytes long instead of its current size, and compare
// against the committed ceiling. Returns { rows, overBudget }.
function budgetImpact(target, stageIds, candidateBytes) {
  const ceilings = committedCeilings();
  const stats = computeStageStats();
  const rows = [];
  for (const s of stats) {
    if (!stageIds.includes(s.stageId)) continue;
    const ceiling = ceilings.has(s.stageId) ? ceilings.get(s.stageId) : null;
    let candidateMax = 0;
    for (const d of s.dispatches) {
      let dispatchBytes = d.dispatchBytes;
      if (target.kind === "role" && d.role === target.name) {
        dispatchBytes = s.frameworkBytes + candidateBytes;
      } else if (target.kind === "rule") {
        // The rule's bytes are folded into every dispatch's frameworkBytes
        // for this stage (rules are stage-wide, not per-role).
        const originalRuleBytes = fileBytesSafe(`rules/${target.name}.md`);
        dispatchBytes = (s.frameworkBytes - originalRuleBytes + candidateBytes) + d.roleBytes;
      }
      candidateMax = Math.max(candidateMax, dispatchBytes);
    }
    rows.push({
      stageId: s.stageId,
      original_max_dispatch_bytes: s.maxDispatchBytes,
      candidate_max_dispatch_bytes: candidateMax,
      ceiling,
      over_budget: ceiling != null && candidateMax > ceiling,
    });
  }
  return { rows, overBudget: rows.some((r) => r.over_budget) };
}

function fileBytesSafe(rel) {
  try { return fs.statSync(path.join(REPO_ROOT, rel)).size; } catch { return 0; }
}

// ---------------------------------------------------------------------------
// Structural baseline — the real, unmodified evals-run stub path.
// ---------------------------------------------------------------------------

function structuralBaseline(cwd, config, cases) {
  const results = cases.map((c) => {
    const rendered = renderForCase(cwd, config, c, {});
    const scored = scoreStub(c, rendered);
    if (!rendered.error) cleanupScratchProject(rendered.scratchDir);
    return scored;
  });
  return {
    ok: results.every((r) => r.status === "ok"),
    findings: results.flatMap((r) => r.findings || []),
  };
}

// ---------------------------------------------------------------------------
// Scratch-patching: inject candidate content into an already-materialized
// scratch project (built by core/evals/run.js#renderForCase) WITHOUT ever
// touching the real repo file. Locates the installed copy generically
// (works across every host's install layout) by finding whichever installed
// .md file's content matches or contains the target's current byte-exact
// text, then substituting — this covers both verbatim installs (codex,
// gemini-cli, rule files on every host) and wrapped installs (claude-code's
// frontmatter + body).
// ---------------------------------------------------------------------------

function listMdFiles(dir) {
  let out = [];
  let entries;
  try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return out; }
  for (const e of entries) {
    const abs = path.join(dir, e.name);
    if (e.isDirectory()) out = out.concat(listMdFiles(abs));
    else if (e.isFile() && e.name.endsWith(".md")) out.push(abs);
  }
  return out;
}

// Returns { patched: boolean, path: string|null } — never throws; a target
// the scratch project didn't install (e.g. this host doesn't dispatch this
// role) is reported, not fatal, since the real-model subset simply can't
// exercise the candidate for that case.
function patchCandidateIntoScratch(scratchDir, target, originalContent, candidateContent) {
  if (target.kind === "rule") {
    const rel = path.join(".devteam", "rules", `${target.name}.md`);
    const abs = path.join(scratchDir, rel);
    if (!fs.existsSync(abs)) return { patched: false, path: null };
    fs.writeFileSync(abs, candidateContent);
    return { patched: true, path: rel };
  }
  for (const abs of listMdFiles(scratchDir)) {
    let content;
    try { content = fs.readFileSync(abs, "utf8"); } catch { continue; }
    if (content === originalContent) {
      fs.writeFileSync(abs, candidateContent);
      return { patched: true, path: path.relative(scratchDir, abs) };
    }
    if (content.includes(originalContent)) {
      fs.writeFileSync(abs, content.replace(originalContent, candidateContent));
      return { patched: true, path: path.relative(scratchDir, abs) };
    }
  }
  return { patched: false, path: null };
}

// ---------------------------------------------------------------------------
// Frontier-model diagnosis call (mirrors core/learning/reflector.js's
// one-shot embedded-context dispatch pattern — not a stage dispatch, no
// gate/descriptor, headless command spawned directly).
// ---------------------------------------------------------------------------

function stripFences(text) {
  const trimmed = String(text || "").trim();
  const fenced = trimmed.match(/^```(?:json)?\s*([\s\S]*?)\s*```$/);
  return fenced ? fenced[1].trim() : trimmed;
}

function spawnAndCollect(cmdString, cwd, input, timeoutMs) {
  return new Promise((resolve) => {
    let bin, args;
    try {
      ({ bin, args } = splitCommand(cmdString, "headlessCommand"));
    } catch (err) {
      resolve({ ok: false, reason: `invalid command "${cmdString}": ${err.message}` });
      return;
    }
    let child;
    try {
      child = spawn(bin, args, { cwd, stdio: ["pipe", "pipe", "ignore"] });
    } catch (err) {
      resolve({ ok: false, reason: `failed to spawn "${bin}": ${err.message}` });
      return;
    }
    let stdout = "";
    let settled = false;
    const finish = (result) => {
      if (settled) return;
      settled = true;
      if (timer) clearTimeout(timer);
      resolve(result);
    };
    const timer = timeoutMs > 0 ? setTimeout(() => {
      try { child.kill("SIGTERM"); } catch { /* already gone */ }
      finish({ ok: false, reason: "diagnosis dispatch timed out" });
    }, timeoutMs) : null;
    if (timer) timer.unref();

    child.stdout.on("data", (chunk) => { stdout += chunk; });
    child.on("error", (err) => finish({ ok: false, reason: `failed to spawn "${bin}": ${err.message}` }));
    child.stdin.on("error", () => { /* swallow EPIPE when child exits early */ });
    child.stdin.write(input);
    child.stdin.end();
    child.on("close", (exitCode) => {
      if (exitCode !== 0) { finish({ ok: false, reason: `diagnosis dispatch exited ${exitCode}` }); return; }
      finish({ ok: true, stdout });
    });
  });
}

function buildDiagnosisPrompt({ target, currentContent, failures, rejectedAttempts }) {
  const lines = [
    DIAGNOSIS_MARKER,
    "",
    "You are a GEPA-style reflective prompt optimizer (arXiv:2507.19457) for the",
    "Stagecraft AI dev-team pipeline. Diagnose why the failures below happened",
    `and propose a revised version of exactly one file: \`${target.relPath}\`.`,
    "",
    `## Current content of ${target.relPath}`,
    "```markdown",
    currentContent,
    "```",
    "",
    "## Failing eval cases this file's stage(s) exercise",
    "```json",
    JSON.stringify(failures, null, 2),
    "```",
  ];
  if (rejectedAttempts && rejectedAttempts.length > 0) {
    lines.push(
      "",
      "## Previously proposed revisions this run (for context — do not repeat their mistakes)",
      "```json",
      JSON.stringify(rejectedAttempts, null, 2),
      "```",
    );
  }
  lines.push(
    "",
    "Output ONLY a JSON object, no prose or markdown fences around it:",
    '{ "target_path": string, "diagnosis": string, "revised_content": string }',
    `"target_path" MUST be exactly "${target.relPath}" — never propose changing any other file.`,
    '"revised_content" is the FULL replacement file body (not a diff).',
  );
  return lines.join("\n");
}

function parseCandidateResponse(stdout, expectedRelPath) {
  let payload;
  try {
    payload = JSON.parse(stripFences(stdout));
  } catch (err) {
    return { ok: false, reason: `invalid JSON: ${err.message}` };
  }
  if (!payload || typeof payload !== "object") return { ok: false, reason: "response is not a JSON object" };
  if (typeof payload.revised_content !== "string" || payload.revised_content.length === 0) {
    return { ok: false, reason: "missing non-empty revised_content" };
  }
  if (payload.target_path !== expectedRelPath) {
    return {
      ok: false,
      reason: `diff-scope guard: proposed target_path "${payload.target_path}" != requested "${expectedRelPath}"`,
      scopeViolation: true,
    };
  }
  return { ok: true, diagnosis: String(payload.diagnosis || ""), revisedContent: payload.revised_content };
}

// ---------------------------------------------------------------------------
// Pareto frontier (maximize pass_rate, minimize tokens_est) — never a
// single greedy winner (plan item 33.4).
// ---------------------------------------------------------------------------

function dominates(a, b) {
  return a.pass_rate >= b.pass_rate && a.tokens_est <= b.tokens_est
    && (a.pass_rate > b.pass_rate || a.tokens_est < b.tokens_est);
}

function paretoAdd(frontier, candidate) {
  if (candidate.pass_rate === null) return frontier;
  if (frontier.some((existing) => dominates(existing, candidate))) return frontier;
  return [...frontier.filter((existing) => !dominates(candidate, existing)), candidate];
}

function pickWinner(frontier) {
  if (frontier.length === 0) return null;
  return [...frontier].sort((a, b) => (b.pass_rate - a.pass_rate) || (a.tokens_est - b.tokens_est))[0];
}

// ---------------------------------------------------------------------------
// Diff generation — always exactly one file (the target), generated by us
// from original vs. winning-candidate content, never from model-produced
// diff text. This is the structural guarantee behind "only the target file
// may appear in the diff": we never parse or trust a diff the model wrote.
// ---------------------------------------------------------------------------

function unifiedDiff(relPath, originalContent, candidateContent) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "devteam-prompt-optimize-diff-"));
  const aPath = path.join(dir, "a");
  const bPath = path.join(dir, "b");
  fs.writeFileSync(aPath, originalContent);
  fs.writeFileSync(bPath, candidateContent);
  const result = spawnSync("git", ["diff", "--no-index", "--no-color", "--", aPath, bPath], {
    cwd: dir, encoding: "utf8",
  });
  fs.rmSync(dir, { recursive: true, force: true });
  return (result.stdout || "")
    .replace(new RegExp(`a${escapeRegExp(aPath)}`, "g"), `a/${relPath}`)
    .replace(new RegExp(`b${escapeRegExp(bPath)}`, "g"), `b/${relPath}`)
    .replace(new RegExp(escapeRegExp(aPath), "g"), `a/${relPath}`)
    .replace(new RegExp(escapeRegExp(bPath), "g"), `b/${relPath}`);
}

function escapeRegExp(s) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

// ---------------------------------------------------------------------------
// Cost tracking — same "estimate, never a bill" posture as
// core/evals/run.js#costPreview: bytes/4 tokens, priced via the most
// recently observed model for (role, host) in the run corpus.
// ---------------------------------------------------------------------------

function estimateDispatchCostUsd(corpusRecords, role, hostName, promptText) {
  const tokens = Math.ceil(Buffer.byteLength(promptText, "utf8") / 4);
  const model = mostRecentModelObserved(corpusRecords, role, hostName);
  const pricing = model ? pricingFor(model) : null;
  return pricing ? (tokens / 1_000_000) * pricing.input : null;
}

// ---------------------------------------------------------------------------
// Real-model bounded subset — dispatch a sample of cases, optionally
// patching the candidate into the scratch project first. Returns
// { pass_rate, dispatched, skipped_budget, results }.
// ---------------------------------------------------------------------------

async function realModelSubset(cwd, config, cases, opts) {
  const { target, headlessHost, content, budget, corpusRecords } = opts;
  const results = [];
  let dispatched = 0;
  let skippedBudget = 0;

  for (const c of cases) {
    const rendered = renderForCase(cwd, config, c, { headlessHost });
    if (rendered.error) {
      results.push({ id: c.id, status: "error", findings: [rendered.error] });
      continue;
    }
    const estimate = estimateDispatchCostUsd(corpusRecords, rendered.role, rendered.hostName, rendered.invocationPrompt);
    if (typeof estimate === "number" && budget.spent + estimate > budget.capUsd) {
      cleanupScratchProject(rendered.scratchDir);
      skippedBudget += 1;
      continue;
    }
    if (content !== null) {
      patchCandidateIntoScratch(rendered.scratchDir, target, opts.originalContent, content);
    }
    const scored = await scoreHeadless(c, rendered);
    if (typeof estimate === "number") budget.spent += estimate;
    dispatched += 1;
    results.push(scored);
  }

  const scored = results.filter((r) => r.gate_status);
  const passCount = scored.filter((r) => r.gate_status === "PASS" || r.gate_status === "WARN").length;
  const passRate = scored.length > 0 ? passCount / scored.length : null;
  return { pass_rate: passRate, dispatched, skipped_budget: skippedBudget, results };
}

// ---------------------------------------------------------------------------
// Report + rendering
// ---------------------------------------------------------------------------

function renderEvidenceTable(report) {
  const lines = [];
  lines.push(`Prompt optimize: ${report.target.relPath}`);
  lines.push(`  exercised stages: ${report.exercised_stage_ids.join(", ") || "(none)"}`);
  lines.push(`  eval cases matched: ${report.cases_matched}`);
  lines.push(`  structural baseline (evals run --stub): ${report.structural_baseline.ok ? "OK" : "FAIL"}`);
  if (report.baseline) {
    lines.push(
      `  baseline: pass_rate=${fmtPct(report.baseline.pass_rate)} dispatched=${report.baseline.dispatched} tokens_est=${report.baseline.tokens_est}`,
    );
  }
  lines.push("");
  lines.push("  Pareto frontier (pass_rate, tokens_est):");
  for (const cand of report.frontier) {
    const mark = report.winner && cand.iteration === report.winner.iteration ? "*" : " ";
    lines.push(`   ${mark} iter ${cand.iteration}: pass_rate=${fmtPct(cand.pass_rate)} tokens_est=${cand.tokens_est} over_budget=${cand.over_budget}`);
  }
  if (report.rejected.length > 0) {
    lines.push("");
    lines.push("  Rejected proposals:");
    for (const r of report.rejected) lines.push(`    iter ${r.iteration}: ${r.reason}`);
  }
  lines.push("");
  lines.push(`  Estimated spend: ${formatUsd(report.spend_usd)} / ${formatUsd(report.budget_usd)} (estimate — never a bill)`);
  lines.push("");
  if (report.diff) {
    lines.push("--- Proposed diff (NOT applied — review like any PR) ---");
    lines.push(report.diff);
  } else {
    lines.push("No viable candidate found within the iteration/budget bound. No diff produced.");
  }
  return lines.join("\n");
}

function fmtPct(n) { return n === null ? "—" : `${(n * 100).toFixed(1)}%`; }

function writeReport(cwd, report) {
  const dir = path.join(cwd, OPTIMIZE_DIR);
  fs.mkdirSync(dir, { recursive: true });
  const slug = report.target.relPath.replace(/[/.]/g, "-");
  const file = path.join(dir, `${new Date().toISOString().replace(/[:.]/g, "-")}-${slug}.json`);
  fs.writeFileSync(file, JSON.stringify(report, null, 2) + "\n");
  return file;
}

// ---------------------------------------------------------------------------
// Main orchestration
// ---------------------------------------------------------------------------

async function runOptimize(cwd, opts) {
  // Hard refuse without a budget cap, BEFORE any dispatch or file I/O beyond
  // arg validation (plan acceptance: "refuses to run without a budget cap").
  if (!(typeof opts.budgetUsd === "number" && opts.budgetUsd > 0)) {
    return { ok: false, reason: "--budget-usd is required and must be > 0", exitCode: 1 };
  }

  let target;
  try {
    target = parseTarget(opts.target);
  } catch (err) {
    return { ok: false, reason: err.message, exitCode: 1 };
  }

  const config = opts.config || loadConfig(cwd);
  const hostName = opts.model || (config.routing && config.routing.default_host) || null;
  let adapter = null;
  if (hostName) {
    try { adapter = loadAdapter(hostName); } catch (err) {
      return { ok: false, reason: `unknown --model "${hostName}": ${err.message}`, exitCode: 1 };
    }
  }
  if (!adapter || !adapter.capabilities || !adapter.capabilities.headless) {
    return { ok: false, reason: `host "${hostName}" does not support headless dispatch (capabilities.headless is false)`, exitCode: 1 };
  }
  const cmdString = process.env.DEVTEAM_HEADLESS_COMMAND || adapter.capabilities.headlessCommand;
  if (!cmdString) {
    return { ok: false, reason: `host "${hostName}" declares no headlessCommand`, exitCode: 1 };
  }

  const stageIds = exercisedStageIds(target);
  const allCases = loadCases(cwd);
  const cases = allCases.filter((c) => stageIds.includes(c.caseJson.stage));
  if (cases.length === 0) {
    return {
      ok: false,
      reason: `no captured eval cases exercise ${target.relPath} (exercised stages: ${stageIds.join(", ") || "(none)"})`,
      exitCode: 1,
    };
  }

  const originalContent = fs.readFileSync(target.absPath, "utf8");
  const structural = structuralBaseline(cwd, config, cases);
  const corpusRecords = readCorpus(cwd);
  const iterations = Number.isFinite(opts.iterations) && opts.iterations > 0 ? Math.floor(opts.iterations) : DEFAULT_ITERATIONS;
  const sampleSize = Number.isFinite(opts.sample) && opts.sample > 0 ? Math.floor(opts.sample) : DEFAULT_SAMPLE;
  const sample = cases.slice(0, sampleSize);
  const budget = { capUsd: opts.budgetUsd, spent: 0 };

  const failures = sample.map((c) => ({
    id: c.id,
    stage: c.caseJson.stage,
    role: c.caseJson.role,
    resolved: c.resolved,
    blockers: (c.caseJson.gate && c.caseJson.gate.blockers) || [],
    warnings: (c.caseJson.gate && c.caseJson.gate.warnings) || [],
  }));

  // Baseline real-model pass rate over the same sample, unpatched (whatever
  // the scratch project's real install already is) — the "before" column.
  const baselineSubset = await realModelSubset(cwd, config, sample, {
    target, headlessHost: hostName, content: null, originalContent, budget, corpusRecords,
  });
  const baseline = {
    pass_rate: baselineSubset.pass_rate,
    dispatched: baselineSubset.dispatched,
    tokens_est: Math.ceil(Buffer.byteLength(originalContent, "utf8") / 4),
  };

  const frontier = [];
  const rejected = [];
  const attempts = [];

  for (let iteration = 1; iteration <= iterations; iteration++) {
    if (budget.spent >= budget.capUsd) {
      rejected.push({ iteration, reason: "budget exhausted before this iteration ran" });
      break;
    }
    const currentBest = pickWinner(frontier);
    const startingContent = currentBest ? currentBest.content : originalContent;
    const prompt = buildDiagnosisPrompt({
      target, currentContent: startingContent, failures,
      rejectedAttempts: attempts.slice(-3).map((a) => ({ iteration: a.iteration, reason: a.reason })),
    });
    const promptCost = estimateDispatchCostUsd(corpusRecords, "reflector", hostName, prompt);
    if (typeof promptCost === "number" && budget.spent + promptCost > budget.capUsd) {
      rejected.push({ iteration, reason: "budget would be exceeded by the diagnosis call" });
      break;
    }
    const dispatched = await spawnAndCollect(cmdString, cwd, prompt, opts.timeoutMs || DIAGNOSIS_TIMEOUT_MS);
    if (typeof promptCost === "number") budget.spent += promptCost;
    if (!dispatched.ok) {
      const reason = `diagnosis dispatch failed: ${dispatched.reason}`;
      rejected.push({ iteration, reason });
      attempts.push({ iteration, reason });
      continue;
    }
    const parsed = parseCandidateResponse(dispatched.stdout, target.relPath);
    if (!parsed.ok) {
      rejected.push({ iteration, reason: parsed.reason, scopeViolation: Boolean(parsed.scopeViolation) });
      attempts.push({ iteration, reason: parsed.reason });
      continue;
    }

    const candidateBytes = Buffer.byteLength(parsed.revisedContent, "utf8");
    const impact = budgetImpact(target, stageIds, candidateBytes);
    if (impact.overBudget) {
      const reason = `candidate exceeds the committed prompt-budget ceiling: ${JSON.stringify(impact.rows.filter((r) => r.over_budget))}`;
      rejected.push({ iteration, reason });
      attempts.push({ iteration, reason });
      continue;
    }

    const subset = await realModelSubset(cwd, config, sample, {
      target, headlessHost: hostName, content: parsed.revisedContent, originalContent, budget, corpusRecords,
    });

    if (subset.pass_rate === null) {
      const reason = "budget exhausted before any real-model dispatch could score this candidate";
      rejected.push({ iteration, reason });
      attempts.push({ iteration, reason });
      continue;
    }

    const candidate = {
      iteration,
      diagnosis: parsed.diagnosis,
      content: parsed.revisedContent,
      pass_rate: subset.pass_rate,
      tokens_est: Math.ceil(candidateBytes / 4),
      dispatched: subset.dispatched,
      over_budget: impact.overBudget,
      budget_rows: impact.rows,
    };
    frontier.splice(0, frontier.length, ...paretoAdd(frontier, candidate));
    attempts.push({ iteration, reason: `candidate accepted, pass_rate=${candidate.pass_rate}` });
  }

  const winner = pickWinner(frontier);
  const diff = winner ? unifiedDiff(target.relPath, originalContent, winner.content) : null;

  const report = {
    generated_at: new Date().toISOString(),
    target: { relPath: target.relPath, kind: target.kind, name: target.name },
    exercised_stage_ids: stageIds,
    cases_matched: cases.length,
    structural_baseline: structural,
    baseline,
    frontier: frontier.map(({ content: _content, ...rest }) => rest),
    winner: winner ? { iteration: winner.iteration, pass_rate: winner.pass_rate, tokens_est: winner.tokens_est } : null,
    rejected,
    budget_usd: budget.capUsd,
    spend_usd: budget.spent,
    diff,
    host: hostName,
    iterations,
  };

  const reportPath = writeReport(cwd, report);
  return { ok: true, report, reportPath, exitCode: winner ? 0 : 1 };
}

// ---------------------------------------------------------------------------
// CLI entry point
// ---------------------------------------------------------------------------

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.help) { console.log(usage()); return 0; }

  const cwd = path.resolve(args.cwd);
  const result = await runOptimize(cwd, args);
  if (!result.ok) {
    console.error(`prompt-optimize: ${result.reason}`);
    if (!args.target || !args.budgetUsd) console.error(usage());
    return result.exitCode;
  }
  console.log(args.json ? JSON.stringify(result.report, null, 2) : renderEvidenceTable(result.report));
  console.log(`\nReport written: ${path.relative(cwd, result.reportPath)}`);
  return result.exitCode;
}

if (require.main === module) {
  main().then((code) => process.exit(code)).catch((err) => {
    console.error(`prompt-optimize: unexpected error: ${err.stack || err.message}`);
    process.exit(1);
  });
}

module.exports = {
  runOptimize,
  parseTarget,
  exercisedStageIds,
  budgetImpact,
  patchCandidateIntoScratch,
  parseCandidateResponse,
  buildDiagnosisPrompt,
  paretoAdd,
  pickWinner,
  unifiedDiff,
  DIAGNOSIS_MARKER,
};
