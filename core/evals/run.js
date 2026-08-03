// Eval flywheel — replay harness (phase-33 item 33.2, plans/phase-33-eval-flywheel.md §33.2).
//
// `devteam evals run` replays cases captured by core/evals/capture.js (33.1)
// against the CURRENT framework — current stage definitions, roles, rules,
// templates, and prompt layout — to catch framework regressions: a role
// brief, rule file, or render-helpers change that silently breaks a stage
// that used to render (or dispatch) fine.
//
// A case only records stage/role/host/track + a content-addressed snapshot
// of the readFirst inputs (core/evals/capture.js) — never the full
// descriptor or the raw prompt (28.5: hashed, never raw). Replay therefore
// rebuilds the descriptor from scratch via orchestrator.buildDescriptor()
// against today's core/pipeline/stages.js, and restores only the captured
// readFirst blobs (the "captured inputs") into a scratch project whose
// framework files (roles/rules/templates) come from the target project's
// OWN current install when present, or this framework's own bundled
// defaults otherwise (adapter.install()) — that's "current framework."
// Learned/run-specific descriptor fields the case never captured
// (knownPatterns, priorKnowledge, contextManifest, contextDelta) are left
// empty; they're per-run learning, not framework surface, and are outside
// what this item's structural checks care about.
//
// Two modes:
//   --stub (default): render only, free, no model. Structural score: did
//     the prompt render at all, are the always-present scaffold sections
//     still there, is the rendered scaffold within the stage's committed
//     dispatch-byte ceiling (docs/reference/prompt-budget.md), and how far
//     has the prompt hash drifted from the case's recorded one (reported,
//     never gated — ctx legitimately differs from the original run).
//   --headless-host <h>: real dispatch via the existing headless machinery
//     (core/adapters/headless.js#runHeadless, DEVTEAM_HEADLESS_COMMAND
//     respected). A case whose original failure was later RESOLVED
//     (resolution.json present — core/evals/capture.js#linkResolutions)
//     must come back PASS/WARN now; still FAIL/ESCALATE is a regression.
//     Unresolved cases have no known-good target status, so they're
//     reported but never gate the exit code.
//
// Fire-and-forget does NOT apply here — unlike capture, `evals run` is an
// explicit, on-demand CLI invocation (a CI job), not something running
// inside a live pipeline dispatch. Errors surface normally.

"use strict";

const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const crypto = require("node:crypto");

const { casesDir, blobsDir } = require("./capture");
const { STAGES, rolesForStage } = require("../pipeline/stages");
const { loadAdapter, resolveAdapter } = require("../router");
const { buildDescriptor, ORCHESTRATOR_ID } = require("../orchestrator");
const { toolBudgetFor } = require("../roles");
const { splitReadFirst } = require("../adapters/render-helpers");
const { runHeadless } = require("../adapters/headless");
const { loadGateSafe } = require("../gates/load-gate");
const { pricingFor, formatUsd } = require("../pricing");
const { readCorpus } = require("../corpus");
const { mostRecentModelObserved } = require("../ceremony-preview");
const { parseCommittedBudget } = require("../../scripts/prompt-budget");

const PROJECT_ROOT = path.resolve(__dirname, "..", "..");
const PROMPT_BUDGET_DOC = path.join(PROJECT_ROOT, "docs", "reference", "prompt-budget.md");

// Scaffold sections render-helpers.js always emits regardless of learned
// content (see core/adapters/markdown-host.js#renderStagePromptLayers).
// A case whose replay is missing one of these means the current layout
// broke for this stage/role, independent of anything the case captured.
const REQUIRED_SECTIONS = ["## Objective", "## Read first", "## Allowed writes", "## Gate to write"];

function sha256Hex(s) {
  return crypto.createHash("sha256").update(s, "utf8").digest("hex");
}

// Reverse-lookup a stage id ("stage-04") to its STAGES key ("build") — the
// same mapping core/orchestrator.js#nameForStage does, duplicated here
// (not exported) rather than widening orchestrator.js's surface for one
// caller (rule 13: don't touch files the item doesn't need).
function stageNameForId(stageId) {
  for (const [name, def] of Object.entries(STAGES)) {
    if (def && def.stage === stageId) return name;
  }
  return null;
}

function budgetCeilingFor(stageId) {
  let text;
  try { text = fs.readFileSync(PROMPT_BUDGET_DOC, "utf8"); } catch { return null; }
  const map = parseCommittedBudget(text);
  return map.has(stageId) ? map.get(stageId) : null;
}

// ---------------------------------------------------------------------------
// Case loading
// ---------------------------------------------------------------------------

function loadCases(cwd) {
  const dir = casesDir(cwd);
  let names;
  try { names = fs.readdirSync(dir).sort(); } catch { return []; }
  const cases = [];
  for (const name of names) {
    const caseDir = path.join(dir, name);
    let caseJson;
    try { caseJson = JSON.parse(fs.readFileSync(path.join(caseDir, "case.json"), "utf8")); }
    catch { continue; }
    let manifest = [];
    try { manifest = JSON.parse(fs.readFileSync(path.join(caseDir, "inputs", "manifest.json"), "utf8")); }
    catch { manifest = []; }
    if (!Array.isArray(manifest)) manifest = [];
    const resolved = fs.existsSync(path.join(caseDir, "resolution.json"));
    cases.push({ id: name, dir: caseDir, caseJson, manifest, resolved });
  }
  return cases;
}

function matchesFilter(entry, filter) {
  if (!filter) return true;
  return entry.caseJson.stage === filter || entry.id === filter || entry.id.includes(filter);
}

// ---------------------------------------------------------------------------
// Scratch project — current framework + captured-time inputs.
// ---------------------------------------------------------------------------

// Materialize a scratch project directory that mirrors what the target
// project's pipeline/ tree looked like at capture time, but with today's
// framework files: the target's own installed .devteam/ when present
// (its role briefs / rules / templates may have been customized) or this
// package's bundled defaults otherwise (adapter.install() — the case
// against which "current framework" is defined for CI's own fixture
// corpus, which has no real target project behind it).
function materializeScratchProject(cwd, caseEntry, adapter) {
  const scratchDir = fs.mkdtempSync(path.join(os.tmpdir(), "devteam-evals-replay-"));
  const liveDevteam = path.join(cwd, ".devteam");
  if (fs.existsSync(liveDevteam)) {
    fs.cpSync(liveDevteam, path.join(scratchDir, ".devteam"), { recursive: true });
  } else {
    adapter.install(scratchDir, {});
  }
  fs.mkdirSync(path.join(scratchDir, "pipeline", "gates"), { recursive: true });
  const bDir = blobsDir(cwd);
  for (const entry of caseEntry.manifest) {
    if (!entry || typeof entry.sha256 !== "string") continue; // excluded/unreadable — nothing to restore
    let content;
    try { content = fs.readFileSync(path.join(bDir, `${entry.sha256}.blob`)); }
    catch { continue; }
    const dest = path.join(scratchDir, entry.path);
    fs.mkdirSync(path.dirname(dest), { recursive: true });
    fs.writeFileSync(dest, content);
  }
  return scratchDir;
}

function cleanupScratchProject(scratchDir) {
  try { fs.rmSync(scratchDir, { recursive: true, force: true }); } catch { /* best-effort */ }
}

// ---------------------------------------------------------------------------
// Rebuild the descriptor + render the prompt against the current framework.
// ---------------------------------------------------------------------------

// A merged multi-role stage gate (core/driver.js's merge branch) captures
// role: null — the merge-time case doesn't identify which per-role
// workstream owns the failure. Replaying against the stage's first
// currently-configured role is a disclosed simplification (see
// changelog.d and the item's "DEVIATIONS" note), not a full per-role fanout.
function resolveRole(caseEntry, stageDef, track, config) {
  if (caseEntry.caseJson.role) return caseEntry.caseJson.role;
  let roles;
  try { roles = rolesForStage(stageDef, track, config); } catch { roles = stageDef.roles; }
  return (roles && roles[0]) || (stageDef.roles && stageDef.roles[0]) || null;
}

function renderForCase(cwd, config, caseEntry, opts = {}) {
  const stageId = caseEntry.caseJson.stage;
  const stageName = stageId && stageNameForId(stageId);
  if (!stageName) {
    return { error: `stage "${stageId}" no longer exists in core/pipeline/stages.js` };
  }
  const stageDef = STAGES[stageName];
  const track = caseEntry.caseJson.track || config.pipeline.default_track || "full";
  const role = resolveRole(caseEntry, stageDef, track, config);
  if (!role) return { error: `stage "${stageId}" has no roles to replay against` };

  let hostName = opts.headlessHost || caseEntry.caseJson.host || null;
  let adapter = null;
  try {
    if (hostName) adapter = loadAdapter(hostName);
  } catch (err) {
    if (opts.headlessHost) return { error: `unknown --headless-host "${hostName}": ${err.message}` };
    hostName = null; // fall through to routed resolution below
  }
  if (!adapter) {
    try {
      const resolved = resolveAdapter(config, stageId, role);
      hostName = resolved.hostName;
      adapter = resolved.adapter;
    } catch (err) {
      return { error: `could not resolve a host adapter: ${err.message}` };
    }
  }

  const roleCount = Math.max(stageDef.roles ? stageDef.roles.length : 1, 1);
  const workstreamId = roleCount > 1 ? `${stageId}.${role}` : stageId;
  const descriptor = buildDescriptor(stageDef, role, {
    workstreamId,
    track,
    toolBudget: toolBudgetFor(role),
    changeId: null,
  });

  const scratchDir = materializeScratchProject(cwd, caseEntry, adapter);
  const ctx = {
    track,
    feature: "",
    cwd: scratchDir,
    isolation: "in-place",
    orchestrator: ORCHESTRATOR_ID,
    patchItems: null,
    changeId: null,
  };

  let prompt;
  try {
    prompt = adapter.renderStagePrompt(descriptor, ctx);
  } catch (err) {
    cleanupScratchProject(scratchDir);
    return { error: `prompt render threw: ${err.message}` };
  }

  // Mirrors core/orchestrator.js's invocation-prompt construction (the
  // /goal prefix for goalLoop-capable hosts) so the replay hash and any
  // real dispatch match what a live run would actually send.
  const invocationPrompt = adapter.capabilities && adapter.capabilities.goalLoop && descriptor.goalCondition
    ? `/goal "${descriptor.goalCondition}"\n\n${prompt}`
    : prompt;

  return { stageId, stageName, stageDef, role, hostName, adapter, descriptor, ctx, scratchDir, prompt, invocationPrompt };
}

// ---------------------------------------------------------------------------
// --stub scoring
// ---------------------------------------------------------------------------

function scoreStub(caseEntry, rendered) {
  if (rendered.error) {
    return { id: caseEntry.id, stage: caseEntry.caseJson.stage, mode: "stub", status: "error", findings: [rendered.error] };
  }
  const findings = [];
  const prompt = rendered.invocationPrompt;

  for (const marker of REQUIRED_SECTIONS) {
    if (!prompt.includes(marker)) findings.push(`missing structural section: ${marker}`);
  }
  const { framework } = splitReadFirst(rendered.descriptor.readFirst);
  if (framework.length > 0 && !prompt.includes("## Framework (read first")) {
    findings.push("missing structural section: ## Framework (read first — every stage, every role)");
  }

  const promptBytes = Buffer.byteLength(prompt, "utf8");
  const budgetCeiling = budgetCeilingFor(rendered.stageId);
  if (budgetCeiling != null && promptBytes > budgetCeiling) {
    findings.push(
      `prompt bytes ${promptBytes} exceed the committed dispatch-budget ceiling ${budgetCeiling} ` +
      `for ${rendered.stageId} (docs/reference/prompt-budget.md)`,
    );
  }

  const currentHash = sha256Hex(prompt);
  const caseHash = caseEntry.caseJson.prompt_hash || null;

  return {
    id: caseEntry.id,
    stage: rendered.stageId,
    role: rendered.role,
    host: rendered.hostName,
    mode: "stub",
    status: findings.length > 0 ? "structural-fail" : "ok",
    findings,
    prompt_bytes: promptBytes,
    budget_ceiling: budgetCeiling,
    prompt_hash: currentHash,
    case_prompt_hash: caseHash,
    prompt_hash_drift: caseHash ? caseHash !== currentHash : null,
  };
}

// ---------------------------------------------------------------------------
// --headless-host real dispatch + regression scoring
// ---------------------------------------------------------------------------

async function scoreHeadless(caseEntry, rendered) {
  if (rendered.error) {
    return { id: caseEntry.id, stage: caseEntry.caseJson.stage, mode: "headless-host", status: "error", findings: [rendered.error], verdict: "error" };
  }
  let result;
  try {
    result = await runHeadless(rendered.adapter, rendered.descriptor, rendered.ctx, rendered.invocationPrompt);
  } catch (err) {
    cleanupScratchProject(rendered.scratchDir);
    return {
      id: caseEntry.id, stage: rendered.stageId, role: rendered.role, host: rendered.hostName,
      mode: "headless-host", status: "error", findings: [`headless invoke failed: ${err.message}`],
      verdict: caseEntry.resolved ? "regression" : "error",
    };
  }

  let gate = null;
  let gateError = null;
  if (result.gatePath) {
    const loaded = loadGateSafe(result.gatePath);
    gate = loaded.gate;
    gateError = loaded.error;
  }
  cleanupScratchProject(rendered.scratchDir);

  const status = gate ? gate.status : null;
  const isFailing = status === "FAIL" || status === "ESCALATE";
  let verdict;
  if (!gate) verdict = caseEntry.resolved ? "regression" : "no-gate";
  else if (caseEntry.resolved) verdict = isFailing ? "regression" : "pass";
  else verdict = isFailing ? "still-failing" : "pass";

  return {
    id: caseEntry.id,
    stage: rendered.stageId,
    role: rendered.role,
    host: rendered.hostName,
    mode: "headless-host",
    status: gate ? "ok" : "error",
    findings: gateError ? [gateError] : [],
    exit_code: result.exitCode,
    gate_status: status,
    resolved_in_case: caseEntry.resolved,
    verdict,
  };
}

// ---------------------------------------------------------------------------
// Cost preview (29.3-style) for a --headless-host sweep.
// ---------------------------------------------------------------------------

function costPreview(cwd, renderedCases, hostName) {
  const corpusRecords = readCorpus(cwd);
  let dispatchCount = 0;
  let tokens = 0;
  let costUsd = 0;
  let allKnown = true;
  const unresolved = new Set();
  const perCase = [];

  for (const rendered of renderedCases) {
    if (rendered.error) continue;
    dispatchCount += 1;
    const promptTokens = Math.ceil(Buffer.byteLength(rendered.invocationPrompt, "utf8") / 4);
    tokens += promptTokens;
    const model = mostRecentModelObserved(corpusRecords, rendered.role, hostName);
    const pricing = model ? pricingFor(model) : null;
    if (pricing) {
      costUsd += (promptTokens / 1_000_000) * pricing.input;
    } else {
      allKnown = false;
      unresolved.add(`${rendered.role}@${hostName}`);
    }
    perCase.push({ id: rendered.workstreamId || rendered.stageId, role: rendered.role, model: model || null, tokens: promptTokens });
  }

  return {
    estimate_basis: "static",
    host: hostName,
    dispatch_count: dispatchCount,
    tokens,
    cost_usd: allKnown && dispatchCount > 0 ? costUsd : null,
    unresolved_models: [...unresolved].sort(),
    per_case: perCase,
  };
}

function renderCostPreviewText(preview) {
  const lines = [];
  lines.push(
    `Eval sweep cost estimate (${preview.estimate_basis}): ${preview.dispatch_count} dispatch(es) → ${preview.host}, ` +
    `~${preview.tokens.toLocaleString("en-US")} tokens, ${preview.cost_usd !== null ? formatUsd(preview.cost_usd) : "— (unknown model)"}`,
  );
  if (preview.unresolved_models.length > 0) {
    lines.push(`  cost omitted — unknown model for: ${preview.unresolved_models.join(", ")}`);
  }
  lines.push(`  (estimate — byte-sampled from the actual re-rendered prompts, never a bill)`);
  return lines;
}

// ---------------------------------------------------------------------------
// Entry point.
// ---------------------------------------------------------------------------

// opts: { config, mode: "stub" | "headless-host", headlessHost, filter, budgetUsd }
async function runEvals(cwd, opts = {}) {
  const config = opts.config || require("../config").loadConfig(cwd);
  const mode = opts.mode === "headless-host" ? "headless-host" : "stub";
  const all = loadCases(cwd);
  const cases = all.filter((c) => matchesFilter(c, opts.filter));

  if (mode === "stub") {
    const results = cases.map((c) => scoreStub(c, renderForCase(cwd, config, c, {})));
    const exitCode = results.some((r) => r.status === "structural-fail" || r.status === "error") ? 1 : 0;
    return { mode, cases: results, total: all.length, matched: cases.length, exitCode };
  }

  // headless-host: render first (needed for the cost preview), refuse
  // without --budget-usd BEFORE any dispatch (rule: 29.3-style preview,
  // then a hard requirement — unlike `devteam run`'s soft warning, an
  // eval sweep has no in-run halt loop to catch an unbounded spend).
  const rendered = cases.map((c) => renderForCase(cwd, config, c, { headlessHost: opts.headlessHost }));
  const preview = costPreview(cwd, rendered, opts.headlessHost);
  if (!(typeof opts.budgetUsd === "number" && opts.budgetUsd > 0)) {
    for (const r of rendered) if (!r.error) cleanupScratchProject(r.scratchDir);
    return { mode, refused: true, reason: "--budget-usd is required before a --headless-host sweep", preview, exitCode: 1 };
  }

  const results = [];
  for (let i = 0; i < cases.length; i++) {
    results.push(await scoreHeadless(cases[i], rendered[i]));
  }
  const exitCode = results.some((r) => r.verdict === "regression") ? 1 : 0;
  return { mode, cases: results, total: all.length, matched: cases.length, preview, exitCode };
}

module.exports = {
  runEvals,
  loadCases,
  renderForCase,
  scoreStub,
  scoreHeadless,
  costPreview,
  renderCostPreviewText,
  budgetCeilingFor,
  // exposed for tests
  materializeScratchProject,
  cleanupScratchProject,
};
