// Bounded autonomous driver (ADR-003, ADR-006, ADR-009).
//
// `devteam run` advances the pipeline through dispatch, merge, targeted repair,
// derived gate clearing, and granted rulings. Count, progress, consequence, cost,
// and iteration ceilings keep autonomy bounded; judgment and external blockers
// halt for a human. The driver is deterministic code. Models run only inside
// dispatched host workstreams and principal rulings.
//
// next() never writes files; fold-sign-off is the mechanism by which the
// driver persists the auto-fold gate and makes it visible in the audit log.
// (item 1.2, plans/phase-1-trust-consolidation.md)
//
// ADR-017 (32.6): nextWave() forms a ready set of 1..autonomy.max_parallel_stages
// actions per iteration instead of next()'s single action. A size-1 result is
// byte-identical to next() and falls through the single-action code below
// unchanged. A real (2+ member) wave is dispatched by dispatchWaveMember()
// (only for run-stage/continue-stage members — see its own comment), sharing
// one wave_id and one state.iterations increment for the whole wave.
//
// Run-scoped state this layer introduces (the pipeline is otherwise stateless
// within a run): an exclusive lock (pipeline/run.lock), resumable run-state
// (pipeline/run-state.json), and an append-only audit/debug log
// (pipeline/run-log.jsonl).

const fs = require("node:fs");
const crypto = require("node:crypto");
const os = require("node:os");
const path = require("node:path");
const { next, nextWave, runStageHeadless, mergeWorkstreamGates } = require("./orchestrator");
const { collect: collectPatterns } = require("./patterns");
const { runReflector } = require("./learning/reflector");
const { ingest: ingestMemory } = require("./memory");
const { loadConfig, changeIdFromFeature, changeIdFromSymptom } = require("./config");
const { pipelineRoot, gatesDir: getGatesDir, logsDir: getLogsDir, prefixPipelineRelative } = require("./paths");
const { orderedStageNamesForTrack, STAGES } = require("./pipeline/stages");
const {
  candidateActiveRoles,
  deterministicSkipsForOrder,
  expectedWorkstreamCount,
  gitChangedFiles,
} = require("./pipeline/right-sizing");
const { assess } = require("./stage-shopping/assess");
const { ceremonyPreview } = require("./ceremony-preview");
const { runAdvise } = require("./advise");
const { MAX_RETRIES_DEFAULT, MAX_TRANSIENT_RETRIES_DEFAULT } = require("./gates/classify");
const { loadPrincipalOutputs, runRuling, runFixEscalation } = require("./escalation");
const { archiveGate, pruneArchives } = require("./gates/archive");
const { logContextSectionEvent } = require("./context-log");
const { enforceContextBudget } = require("./context-budget");
const { detectNoProgress, noProgressEvidence, detectNoSourceChange, noSourceChangeEvidence } = require("./gates/convergence");
const { checkStoplist, explainMatches, STOPLIST_TRACKS } = require("./guards/stoplist");
const { category: evidenceCategory } = require("./evidence/analyzer");
const { upsertSection } = require("./markers");
const {
  TRANSITION_CONTROLS,
  transitionResult,
  applyTransitionResult,
} = require("./driver-transition");
const {
  dispatchGuardTransition,
  normalizeDispatchResults,
  transientDelayPlan,
  dispatchOutcomeTransition,
  targetedFixNoChangeTransition,
  scopeGateTransition,
} = require("./driver-dispatch");
const {
  retryBudgetTransition,
  convergenceTransition,
  blockedFixTransition,
  fixRetryTransition,
  nonCodeFixTransition,
  rulingPreflightTransition,
  rulingOutcomeTransition,
  rulingAppliedTransition,
  rulingDispatchVerificationTransition,
  mergeTransition,
} = require("./driver-recovery");

// Default escalation runners: render + dispatch the Principal / applicator
// IN-PROCESS via core/escalation.js (no subprocess hop). Both are injectable
// via run() opts for deterministic tests.
function defaultRunRuling(cwd, { targetGate } = {}) {
  return runRuling(cwd, { targetGate });
}
function defaultRunFixEscalation(cwd, { escalatingGate } = {}) {
  return runFixEscalation(cwd, { escalatingGate });
}

// Irreversible / outward-facing stages. The driver never advances INTO these
// without an explicit human grant (--allow-stage), regardless of confidence.
// They are also the non-idempotent stages, so the ceiling doubles as the
// idempotency guard. (ADR-003 §4.2)
const CONSEQUENCE_CEILING = new Set(["sign-off", "deploy"]);

const DEFAULT_MAX_ITERATIONS = 100;

function nowIso() { return new Date().toISOString(); }
// B9 (item 1.6): path helpers accept changeId so bounded runs keep all
// run-scoped artifacts under pipeline/changes/<id>/ alongside the gates
// they read. changeId===null gives the historical in-place paths.
function lockPath(cwd, changeId) { return path.join(pipelineRoot(cwd, changeId), "run.lock"); }
function runStatePath(cwd, changeId) { return path.join(pipelineRoot(cwd, changeId), "run-state.json"); }
function runLogPath(cwd, changeId) { return path.join(pipelineRoot(cwd, changeId), "run-log.jsonl"); }
function gatesDir(cwd, changeId) { return getGatesDir(cwd, changeId); }

// A pid is "alive" if signal 0 succeeds, or fails with EPERM (exists, not ours).
function isPidAlive(pid) {
  try { process.kill(pid, 0); return true; }
  catch (e) { return e.code === "EPERM"; }
}

function acquireLock(cwd, { force = false } = {}, changeId) {
  const p = lockPath(cwd, changeId);
  if (fs.existsSync(p) && !force) {
    let info = {};
    try { info = JSON.parse(fs.readFileSync(p, "utf8")); } catch { /* unreadable lock */ }
    if (info.pid && isPidAlive(info.pid)) {
      const err = new Error(
        `pipeline is locked by an active run (pid ${info.pid}, started ${info.started_at}). ` +
        `Use --force to override a stale lock.`,
      );
      err.code = "ELOCKED";
      throw err;
    }
    // recorded pid is gone → stale lock; fall through and overwrite
  }
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(p, JSON.stringify({ pid: process.pid, host: os.hostname(), started_at: nowIso() }, null, 2));
}

function releaseLock(cwd, changeId) { try { fs.unlinkSync(lockPath(cwd, changeId)); } catch { /* already gone */ } }

function loadRunState(cwd, changeId) {
  try {
    const state = JSON.parse(fs.readFileSync(runStatePath(cwd, changeId), "utf8"));
    // Phase 12.2 migration: ensure commit-cursor fields exist in resumed states.
    if (!Array.isArray(state.stages_advanced)) state.stages_advanced = [];
    if (!("last_committed_stage_index" in state)) state.last_committed_stage_index = null;
    return state;
  } catch { return null; }
}
function saveRunState(cwd, changeId, state) {
  try {
    fs.mkdirSync(path.dirname(runStatePath(cwd, changeId)), { recursive: true });
    fs.writeFileSync(runStatePath(cwd, changeId), JSON.stringify(state, null, 2));
  } catch { /* best-effort */ }
}

function logEvent(cwd, changeId, entry) {
  try {
    fs.mkdirSync(path.dirname(runLogPath(cwd, changeId)), { recursive: true });
    fs.appendFileSync(runLogPath(cwd, changeId), JSON.stringify({ ts: nowIso(), ...entry }) + "\n");
  } catch { /* logging must never break the run */ }
}

function nonNegativeNumber(value) {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : null;
}

// Phase-28 item 28.4: a gate's cost contribution prefers the orchestrator-
// observed figure (core/orchestrator.js patchGateForObservedUsage,
// _orchestrator_observed.cost_usd) over the model-asserted top-level
// cost_usd — the model's self-report is a claim, the adapter-parsed usage is
// what the orchestrator actually saw. Returns null when neither is a valid
// non-negative number (e.g. a tokens-estimated-only gate with no cost_usd
// at all — patchGateForEstimatedUsage never writes one).
function costEntryForGate(gate) {
  const observed = gate && gate._orchestrator_observed;
  const observedCost = nonNegativeNumber(observed && observed.cost_usd);
  if (observedCost !== null) return { cost: observedCost, source: "observed" };
  const assertedCost = nonNegativeNumber(gate && gate.cost_usd);
  if (assertedCost !== null) return { cost: assertedCost, source: "asserted" };
  return null;
}

function dispatchObservation(base, result) {
  if (!result || result.skipped) return null;
  let gate = null;
  if (result.gatePath) {
    try {
      const stat = fs.lstatSync(result.gatePath);
      if (stat.isFile() && !stat.isSymbolicLink()) {
        const parsed = JSON.parse(fs.readFileSync(result.gatePath, "utf8"));
        if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) gate = parsed;
      }
    } catch { /* a missing or malformed gate is recorded as no-gate */ }
  }
  const observation = {
    outcome: "dispatch-observation",
    stage: evidenceCategory(base.stage),
    role: evidenceCategory(result.role || "unknown"),
    host: evidenceCategory(result.host || "unknown"),
    model: evidenceCategory(gate && gate.model || "unknown"),
    status: evidenceCategory(gate && gate.status || "NO_GATE"),
    gate_written: Boolean(gate),
    timed_out: Boolean(result.timedOut),
  };
  const cost = nonNegativeNumber(gate && gate.cost_usd);
  const duration = nonNegativeNumber(gate && gate.duration_ms)
    ?? nonNegativeNumber(result.durationMs);
  const promptBytes = nonNegativeNumber(result.promptBytes);
  const contextManifestFiles = nonNegativeNumber(result.contextManifestFiles);
  const contextManifestOmitted = nonNegativeNumber(result.contextManifestOmitted);
  if (cost !== null) observation.cost_usd = cost;
  if (duration !== null) observation.duration_ms = duration;
  if (promptBytes !== null) observation.prompt_bytes = promptBytes;
  if (contextManifestFiles !== null) observation.context_manifest_files = contextManifestFiles;
  if (contextManifestOmitted !== null) observation.context_manifest_omitted = contextManifestOmitted;
  return observation;
}


function blockerFiles(blockers) {
  const files = [];
  for (const b of blockers || []) {
    if (!b || typeof b !== "object") continue;
    const file = b.file || b.path || b.filename;
    if (file && typeof file === "string" && file.trim()) files.push(file.trim().replace(/:\d+$/, ""));
  }
  return [...new Set(files)];
}

function normalizeOwnershipPath(p) {
  return String(p || "")
    .replace(/\\/g, "/")
    .replace(/^\.\//, "")
    .replace(/^\/+/, "");
}

function globPatternToRegExp(pattern) {
  let out = "^";
  const s = normalizeOwnershipPath(pattern);
  for (let i = 0; i < s.length; i += 1) {
    const ch = s[i];
    if (ch === "*") {
      if (s[i + 1] === "*") {
        out += ".*";
        i += 1;
      } else {
        out += "[^/]*";
      }
    } else {
      out += ch.replace(/[|\\{}()[\]^$+?.]/g, "\\$&");
    }
  }
  return new RegExp(`${out}$`);
}

function ownershipPatternMatches(pattern, file) {
  const p = normalizeOwnershipPath(pattern);
  const f = normalizeOwnershipPath(file);
  if (!p || !f) return false;
  if (p === f) return true;
  if (p.endsWith("/")) return f.startsWith(p);
  if (!p.includes("*")) return f.startsWith(`${p}/`);
  return globPatternToRegExp(p).test(f);
}

function loadFileOwnership(cwd, changeId) {
  try {
    const gate = JSON.parse(fs.readFileSync(path.join(gatesDir(cwd, changeId), "stage-02.json"), "utf8"));
    return gate && typeof gate.file_ownership === "object" && !Array.isArray(gate.file_ownership)
      ? gate.file_ownership
      : null;
  } catch {
    return null;
  }
}

function workstreamFromFileOwnership(fileOwnership, files) {
  const owners = new Set();
  const entries = Object.entries(fileOwnership || {});
  for (const file of files || []) {
    for (const [pattern, owner] of entries) {
      if (ownershipPatternMatches(pattern, file)) owners.add(owner);
    }
  }
  return owners.size === 1 ? [...owners][0] : null;
}

function blockerPatchItems(blockers) {
  const items = [];
  for (const b of blockers || []) {
    if (typeof b === "string") {
      if (b.trim()) items.push(b.trim());
      continue;
    }
    if (!b || typeof b !== "object") continue;
    const file = b.file || b.path || b.filename;
    const text = b.text || b.summary || b.description || "";
    if (file && text) items.push(`Fix ${file}: ${text}`);
    else if (file) items.push(`Fix ${file}`);
    else if (text) items.push(text);
  }
  return [...new Set(items)].filter(Boolean);
}

function hashTargetedFixFiles(cwd, files) {
  const root = path.resolve(cwd);
  const entries = [];
  for (const file of files || []) {
    const rel = normalizeOwnershipPath(file);
    if (!rel) continue;
    const fullPath = path.resolve(root, rel);
    if (fullPath !== root && !fullPath.startsWith(`${root}${path.sep}`)) continue;
    let exists = true;
    let hash = null;
    try {
      hash = crypto.createHash("sha256").update(fs.readFileSync(fullPath)).digest("hex");
    } catch (e) {
      if (e && e.code === "ENOENT") exists = false;
      else continue;
    }
    entries.push({ file: rel, exists, hash });
  }
  return entries.length > 0 ? entries : null;
}

function targetedFixChanged(cwd, before) {
  const after = hashTargetedFixFiles(cwd, (before || []).map((entry) => entry.file));
  if (!after) return null;
  const afterByFile = new Map(after.map((entry) => [entry.file, entry]));
  for (const entry of before) {
    if (!afterByFile.has(entry.file)) return null;
  }
  return before.some((entry) => {
    const next = afterByFile.get(entry.file);
    return entry.exists !== next.exists || entry.hash !== next.hash;
  });
}

function targetedFixNoSourceChangeEvidence(before) {
  return (before || []).map((entry) => entry.file).join(", ");
}

function targetedBuildFixFromRetry(cwd, changeId, retryAction) {
  const files = blockerFiles(retryAction.blockers);

  // Collect which stage-04 workstreams were actually cleared. These are the
  // workstreams that exist in this project's build — file_ownership may name
  // workstreams (e.g. "frontend") that stage-04 never dispatches.
  const clearedWorkstreams = new Set();
  for (const rel of retryAction.clear_gates || []) {
    const m = String(rel).match(/^pipeline\/gates\/stage-04\.([^./]+)\.json$/);
    if (m) clearedWorkstreams.add(m[1]);
  }

  // Single cleared workstream → unambiguous; prefer it without consulting ownership.
  // Multiple cleared workstreams → consult file ownership, but only accept the
  // result when that workstream was actually dispatched (gate was cleared). This
  // prevents targeted fixes for workstreams that appear in file_ownership but were
  // never part of this project's stage-04 plan.
  let workstream = clearedWorkstreams.size === 1 ? [...clearedWorkstreams][0] : null;
  if (!workstream) {
    const fromOwnership = workstreamFromFileOwnership(loadFileOwnership(cwd, changeId), files);
    if (fromOwnership && clearedWorkstreams.has(fromOwnership)) workstream = fromOwnership;
  }

  if (!workstream) return null;
  const patchItems = blockerPatchItems(retryAction.blockers || []);
  if (patchItems.length === 0) return null;
  return {
    stage: "stage-04",
    name: "build",
    workstream,
    patchItems,
    files,
    source_stage: retryAction.stage,
    source_name: retryAction.name,
  };
}

// Sum cost across all stage gates, avoiding double-counting for multi-role
// stages, and report the cost_basis for the run (phase-28 item 28.4). Per
// gate the cost prefers `_orchestrator_observed.cost_usd` over the
// model-asserted `cost_usd` (see costEntryForGate). Strategy per gate file:
//
//   stage-NN.json / stage-NNa.json  — merged gate; use it and skip any
//     workstream gates for the same stage prefix (the merged gate already
//     rolls up per-workstream costs, see mergeWorkstreamGates in orchestrator).
//
//   stage-NN.<role>.json            — per-workstream gate; include it ONLY
//     when no merged gate exists yet for that stage prefix. This closes the
//     budget-cap blind spot where a multi-role stage's costs are invisible
//     until merge.  (Fix 1.7.3, plans/phase-1-trust-consolidation.md item 1.7)
//
// Best-effort: unreadable or cost-less gates contribute 0 and don't affect
// the basis. `basis` is "observed" (every contributing gate was
// orchestrator-observed), "model-asserted" (every contributing gate fell
// back to the model's self-report), "mixed" (both), or null (no gate
// contributed a cost at all).
function costUsdDetail(cwd, changeId) {
  // stage-NN[a].json   — merged gate (letters a-z suffix for overflow stages)
  const mergedGateRe = /^(stage-\d{2}[a-z]?)\.json$/;
  // stage-NN.<role>.json — workstream gate (at least one dot-separated word)
  const wsGateRe = /^(stage-\d{2}[a-z]?)\.[^.]+\.json$/;

  let allFiles = [];
  try { allFiles = fs.readdirSync(gatesDir(cwd, changeId)); } catch { return { total: 0, basis: null }; }

  // Collect merged-gate prefixes (e.g. "stage-04") so we can skip workstream
  // gates for stages that are already merged.
  const mergedPrefixes = new Set();
  for (const f of allFiles) {
    const m = f.match(mergedGateRe);
    if (m) mergedPrefixes.add(m[1]);
  }

  let total = 0;
  let sawObserved = false;
  let sawAsserted = false;
  for (const f of allFiles) {
    let prefix = null;
    let isWorkstream = false;

    const mm = f.match(mergedGateRe);
    if (mm) {
      prefix = mm[1];
    } else {
      const wm = f.match(wsGateRe);
      if (wm) { prefix = wm[1]; isWorkstream = true; }
    }

    if (!prefix) continue; // not a gate file
    // Skip workstream gates when the merged gate for this stage already exists
    // — the merged gate's cost_usd already includes those workstream costs.
    if (isWorkstream && mergedPrefixes.has(prefix)) continue;

    try {
      const g = JSON.parse(fs.readFileSync(path.join(gatesDir(cwd, changeId), f), "utf8"));
      const entry = costEntryForGate(g);
      if (entry) {
        total += entry.cost;
        if (entry.source === "observed") sawObserved = true;
        else sawAsserted = true;
      }
    } catch { /* skip */ }
  }
  const basis = sawObserved && sawAsserted ? "mixed" : sawObserved ? "observed" : sawAsserted ? "model-asserted" : null;
  return { total, basis };
}

function totalCostUsd(cwd, changeId) {
  return costUsdDetail(cwd, changeId).total;
}

// ADR-006 / ADR-016: resolveTrack returns {track, source, confidence} so callers can
// apply the confidence guard without a second file read. Source values:
//   "human"   — --track CLI flag or pipeline/track.json with source:"human"
//   "inferred" — pipeline/track.json with source:"inferred", or assessed inline (below)
//   "config"   — custom_stages or default_track from .devteam/config.yml
//   "default"  — hard-coded "full" fallback
function resolveTrack(opts, config, cwd) {
  // ADR-009 §Decision.1: --repair defaults to hotfix depth; --repair --track X overrides.
  if (opts.track) return { track: opts.track, source: "human", confidence: null };
  if (opts.repair) return { track: "hotfix", source: "human", confidence: null };

  // ADR-006 §2: pipeline/track.json per-run record takes precedence over
  // project-wide config; assess writes it here, driver reads it.
  if (cwd) {
    try {
      const tjPath = path.join(cwd, "pipeline", "track.json");
      if (fs.existsSync(tjPath)) {
        const tj = JSON.parse(fs.readFileSync(tjPath, "utf8"));
        if (tj && tj.track) {
          return { track: tj.track, source: tj.source || "inferred", confidence: tj.confidence || null };
        }
      }
    } catch { /* fall through to lower precedence */ }
  }

  if (Array.isArray(config.pipeline.custom_stages)) {
    return { track: config.pipeline.custom_stages, source: "config", confidence: null };
  }

  // ADR-016 (Phase 29.2, supersedes ADR-006 §1): when there is no human track
  // decision anywhere in the chain above, and there is a feature/description to
  // assess, run the `assess` heuristics inline — at ANY confidence level, not
  // just "high" as the pre-29.2 downgrade-only path required — and mark the
  // result "inferred". The caller (run()) persists this to pipeline/track.json
  // so the decision is a file, not a silent side effect, and the existing
  // checkTrackConfidence guard (ADR-006 §3/4) still gates medium/low confidence
  // exactly as it does for a human-authored track.json.
  const assessmentText = opts.feature || opts.description || "";
  if (config.pipeline.right_sizing !== false && assessmentText.trim()) {
    const changedFiles = gitChangedFiles(cwd).files;
    const result = assess(assessmentText, changedFiles, {});
    return {
      track: result.recommendedTrack,
      source: "inferred",
      confidence: result.confidence,
      assess_inline: { reasons: result.reasons, stages: result.stages },
    };
  }
  return { track: config.pipeline.default_track || "full", source: "config", confidence: null };
}

function summarizeRunPlan(order, config = {}, opts = {}) {
  const skipStages = new Set((config.pipeline && config.pipeline.skip_stages) || []);
  const rightSizedSkips = opts.rightSizedSkips || {};
  const rightSizedStageNames = Object.keys(rightSizedSkips);
  const deterministicSkipStages = new Set(rightSizedStageNames);
  const included = order.filter((name) => !skipStages.has(name) && !deterministicSkipStages.has(name));
  const skipped = order.filter((name) => skipStages.has(name));
  const baseWorkstreams = included.reduce((sum, name) => {
    const stage = STAGES[name];
    return sum + (stage && Array.isArray(stage.roles) ? stage.roles.length : 0);
  }, 0);
  return {
    stages_total: order.length,
    stages_included: included.length,
    stages_skipped_by_config: skipped.length,
    stages_skipped_by_right_sizing: rightSizedStageNames.length,
    base_workstreams: baseWorkstreams,
    expected_workstreams: opts.expectedWorkstreams ?? baseWorkstreams,
    conditional_stages: included.filter((name) => STAGES[name] && STAGES[name].conditionalOn).length,
    skipped_stage_names: skipped,
    right_sized_stage_names: rightSizedStageNames,
    candidate_active_roles: opts.candidateActiveRoles || [],
  };
}

const RUN_BLOCKERS_BEGIN = "<!-- devteam:run-blockers:begin -->";
const RUN_BLOCKERS_END = "<!-- devteam:run-blockers:end -->";
const RIGHT_SIZING_BEGIN = "<!-- devteam:right-sizing:begin -->";
const RIGHT_SIZING_END = "<!-- devteam:right-sizing:end -->";

function clearGates(targets) {
  const cleared = [];
  for (const t of targets) {
    try { fs.unlinkSync(t); cleared.push(t); }
    catch { /* not present, or a placeholder like stage-04.<affected-ws>.json */ }
  }
  return cleared;
}

function seedRightSizingContext(cwd, changeId, candidates) {
  if (!candidates || !Array.isArray(candidates.roles) || candidates.roles.length === 0) return;
  const root = pipelineRoot(cwd, changeId);
  const p = path.join(root, "context.md");
  const matched = candidates.trigger_inputs?.matched_files_by_role || {};
  const lines = [
    RIGHT_SIZING_BEGIN,
    "## Right-sizing candidates",
    "",
    "Stagecraft derived candidate active workstreams from changed paths. Stage 01 should confirm or correct `active_roles` in `pipeline/gates/stage-01.json`; do not treat this as a replacement for PM judgment.",
    "",
    `Candidate active roles: ${candidates.roles.join(", ")}`,
    "",
    "Trigger files by role:",
  ];
  for (const role of candidates.roles) {
    const files = matched[role] || [];
    lines.push(`- ${role}: ${files.length > 0 ? files.join(", ") : "(no direct file match)"}`);
  }
  lines.push(RIGHT_SIZING_END);
  fs.mkdirSync(path.dirname(p), { recursive: true });
  const existing = fs.existsSync(p) ? fs.readFileSync(p, "utf8") : "";
  fs.writeFileSync(p, upsertSection(existing, RIGHT_SIZING_BEGIN, RIGHT_SIZING_END, lines.join("\n"), { insert: "prepend" }));
  logContextSectionEvent(cwd, changeId, { action: "added", section: "right-sizing" });
  enforceContextBudget(cwd, changeId);
}

// Cross-stage context propagation (ADR-003 §4.3): record WHY a stage is being
// re-dispatched so the agent's fresh session sees it. Upserted (one section,
// rewritten each retry) so it doesn't accumulate across attempts.
//
// B9 (item 1.6): context.md lives under pipelineRoot() so bounded runs
// write it alongside the other change-scoped artifacts.
function writeRunBlockers(cwd, stageName, blockers, changeId) {
  const p = path.join(pipelineRoot(cwd, changeId), "context.md");
  const items = (blockers || []).map((b) =>
    `- ${typeof b === "string" ? b : (b.text || b.summary || b.message || JSON.stringify(b))}`);
  const section = [
    RUN_BLOCKERS_BEGIN,
    `<!-- written by \`devteam run\` before re-dispatching "${stageName}" -->`,
    `## Address before re-running ${stageName} (autonomous retry)`,
    ...(items.length ? items : ["- (no structured blockers reported)"]),
    RUN_BLOCKERS_END,
  ].join("\n");
  let existing = "";
  try { existing = fs.readFileSync(p, "utf8"); } catch { /* none yet */ }
  try {
    fs.mkdirSync(path.dirname(p), { recursive: true });
    fs.writeFileSync(p, upsertSection(existing, RUN_BLOCKERS_BEGIN, RUN_BLOCKERS_END, section));
    logContextSectionEvent(cwd, changeId, { action: "added", section: "run-blockers", stage: stageName });
    enforceContextBudget(cwd, changeId);
  } catch { /* best-effort */ }
}

const DEPLOY_CONTEXT_BEGIN = "<!-- devteam:deploy-target:begin -->";
const DEPLOY_CONTEXT_END   = "<!-- devteam:deploy-target:end -->";

/**
 * If deploy.adapter is configured and a conventions file exists, write a
 * deploy-target context block into pipeline/context.md before the first
 * stage dispatch. Uses upsertSection so it is idempotent — the block is
 * replaced on each call, never duplicated.
 *
 * Exported for use by the stage command and for unit testing.
 * opts.frameworkRoot overrides the resolved package root (for tests).
 */
function seedDeployContext(cwd, config, changeId, opts = {}) {
  const adapter = config.deploy && config.deploy.adapter;
  if (!adapter) return false;

  const frameworkRoot = opts.frameworkRoot || path.resolve(__dirname, "..");
  const conventionsPath = path.join(frameworkRoot, "core", "deploy", `${adapter}.conventions.md`);
  if (!fs.existsSync(conventionsPath)) return false;

  const conventions = fs.readFileSync(conventionsPath, "utf8");
  const contextPath = path.join(pipelineRoot(cwd, changeId), "context.md");

  const section = [
    DEPLOY_CONTEXT_BEGIN,
    "<!-- written by devteam before first stage dispatch; reflects deploy.adapter config -->",
    conventions.trim(),
    DEPLOY_CONTEXT_END,
  ].join("\n");

  let existing = "";
  try { existing = fs.readFileSync(contextPath, "utf8"); } catch { /* none yet */ }
  try {
    fs.mkdirSync(path.dirname(contextPath), { recursive: true });
    fs.writeFileSync(contextPath, upsertSection(existing, DEPLOY_CONTEXT_BEGIN, DEPLOY_CONTEXT_END, section));
    logContextSectionEvent(cwd, changeId, { action: "added", section: "deploy-target" });
    enforceContextBudget(cwd, changeId);
    return true;
  } catch { return false; }
}

function defaultSleep(ms) { return new Promise((r) => setTimeout(r, ms)); }

function relPath(cwd, filePath) {
  return filePath ? path.relative(cwd, filePath).replace(/\\/g, "/") : null;
}

// ADR-007 Tier 1: observe-only stall probe. Runs fire-and-forget alongside
// each run-stage/continue-stage dispatch. Wakes every stallPollIntervalMs
// and checks whether the workstream log grew or a gate appeared. If neither
// §stub-gate — pre-dispatch stub for preSeedGate stages.
//
// For stages that routinely exhaust context before the gate write (currently
// red-team / stage-04c), the driver writes a minimal stub gate with `_stub: true`
// immediately before dispatch. headless.js detects the stub post-dispatch: if the
// LLM overwrote it (normal), gatePath is valid; if it didn't (context exhausted),
// stubGate: true is returned. classifyDispatch treats stubGate as transient rather
// than the usual structural-input for exit-code-0+no-gate, giving one retry.
//
// Before the transient retry the driver deletes the stub so next() doesn't
// mistake it for a completed stage gate.
function writeStubGate(gatesDirPath, stageId, track) {
  const stub = {
    _stub: true,
    stage: stageId,
    status: "PASS",
    orchestrator: "devteam@pre-dispatch",
    track: track || "full",
    timestamp: new Date().toISOString(),
    blockers: [],
    warnings: [],
    surfaces_walked: [],
    findings_count: 0,
    severity_breakdown: { critical: 0, high: 0, medium: 0, low: 0 },
    must_address_before_peer_review: [],
    noted_for_followup: [],
  };
  fs.mkdirSync(gatesDirPath, { recursive: true });
  fs.writeFileSync(path.join(gatesDirPath, `${stageId}.json`), JSON.stringify(stub, null, 2), "utf8");
}

// happened within stallThresholdMs, emits a stall-detected event and exits.
// Any log growth resets the clock, so this detects silent hangs only —
// loop-spew (a model emitting repeating output indefinitely) resets the clock
// and is not detected. Content-distinct growth rides with Tier 2.
//
// Returns a cancel() function the caller must invoke when the dispatch settles
// so no stale event fires after the stage has moved on.
function defaultStallProbe(stageName, stageId, cwd, changeId, dispatchStart, opts = {}) {
  const {
    stallThresholdMs = 5 * 60 * 1000,   // 5 minutes
    stallPollIntervalMs = 60 * 1000,     // 60 seconds
    stallMinGrowthBytes = 512,
    logEvent: _logEvent,
    onEvent: _onEvent,
    iteration,
    action,
    sleep: _sleep = defaultSleep,
  } = opts;

  const logsPath = getLogsDir(cwd, changeId);
  const gatesPath = getGatesDir(cwd, changeId);

  // Snapshot log sizes and gate mtimes at probe start.
  function totalLogBytes() {
    try {
      let total = 0;
      const files = fs.readdirSync(logsPath).filter((f) => f.endsWith(".log"));
      for (const f of files) {
        try { total += fs.statSync(path.join(logsPath, f)).size; } catch { /* gone */ }
      }
      return total;
    } catch { return 0; }
  }

  function latestGateMtime() {
    try {
      let latest = 0;
      const prefix = stageId ? stageId.replace(/\.[^.]+$/, "") : "";
      for (const f of fs.readdirSync(gatesPath)) {
        if (prefix && !f.startsWith(prefix)) continue;
        try {
          const mt = fs.statSync(path.join(gatesPath, f)).mtimeMs;
          if (mt > latest) latest = mt;
        } catch { /* gone */ }
      }
      return latest;
    } catch { return 0; }
  }

  let cancelled = false;
  let lastLogBytes = totalLogBytes();
  let lastSampleLogBytes = lastLogBytes;
  let lastGateMtime = latestGateMtime();
  let lastProgressMs = Date.now();

  (async () => {
    while (true) {
      await _sleep(stallPollIntervalMs);
      if (cancelled) return;

      const nowBytes = totalLogBytes();
      const nowMtime = latestGateMtime();
      const growth = nowBytes - lastLogBytes;
      const sampleGrowth = nowBytes - lastSampleLogBytes;
      lastSampleLogBytes = nowBytes;
      const gateUpdated = nowMtime > lastGateMtime;
      const elapsedMs = Date.now() - dispatchStart;

      if (_onEvent) {
        _onEvent({
          type: "dispatch-progress",
          stage: stageName,
          action,
          iteration,
          interval_ms: stallPollIntervalMs,
          log_growth_bytes_last_interval: sampleGrowth,
          gate_updated: gateUpdated,
          dispatch_elapsed_ms: elapsedMs,
        });
      }

      if (growth >= stallMinGrowthBytes || gateUpdated) {
        lastLogBytes = nowBytes;
        lastGateMtime = nowMtime;
        lastProgressMs = Date.now();
        continue;
      }

      // No qualifying progress signal since lastProgressMs.
      if (Date.now() - lastProgressMs >= stallThresholdMs) {
        if (cancelled) return;
        if (_logEvent) {
          _logEvent({
            outcome: "stall-detected",
            iteration,
            stage: stageName,
            action,
            stall_threshold_ms: stallThresholdMs,
            log_growth_bytes_last_interval: growth,
            gate_updated: gateUpdated,
            dispatch_elapsed_ms: elapsedMs,
            stall_class: "observed",
          });
        }
        if (_onEvent) {
          _onEvent({
            type: "stall-detected",
            stage: stageName,
            action,
            iteration,
            stall_threshold_ms: stallThresholdMs,
            interval_ms: stallPollIntervalMs,
            log_growth_bytes_last_interval: growth,
            gate_updated: gateUpdated,
            dispatch_elapsed_ms: elapsedMs,
            stall_class: "observed",
          });
        }
        return; // one observed stall per dispatch (Tier 1 — no retry/kill)
      }
    }
  })();

  return () => { cancelled = true; };
}

// ADR-009 §Decision.3: structural scope gate — check whether a build touched files
// outside the diagnosed affected-files set. Returns an array of out-of-scope file
// paths. Empty array = within scope. Uses git diff --name-only HEAD; returns []
// on any error (be lenient when git is unavailable — the gate is advisory until
// 10.2 supplies a real diagnosis).
const { spawnSync } = require("node:child_process");
function defaultCheckScopeGate(cwd, affectedFiles) {
  if (!affectedFiles || affectedFiles.length === 0) return [];
  const r = spawnSync("git", ["diff", "--name-only", "HEAD"], { cwd, encoding: "utf8" });
  if (!r || r.status !== 0) return [];
  const modified = r.stdout.split(/\r?\n/).filter(Boolean);
  const allowed = new Set(affectedFiles);
  return modified.filter((f) => !allowed.has(f));
}

/**
 * Drive the pipeline autonomously until completion or a halt condition.
 *
 * @param {object} opts
 * @param {string} [opts.cwd]
 * @param {string} [opts.track]
 * @param {string} [opts.until]          stop after this stage (inclusive)
 * @param {number} [opts.maxIterations]  loop guard (default 100)
 * @param {number} [opts.budgetUsd]      halt before a dispatch once spend ≥ cap
 * @param {number} [opts.timeoutMs]      per-stage dispatch wall-clock
 * @param {string[]} [opts.allowStages]  consequence-ceiling grants (sign-off/deploy)
 * @param {boolean} [opts.resume]        continue from existing run-state
 * @param {boolean} [opts.force]         override a stale lock
 * @param {number} [opts.retryDelayMs]   backoff before a transient re-dispatch (default 30000)
 * @param {number} [opts.maxTransientRetries] no-gate retries before structural halt (default 1)
 * @param {string[]} [opts.autoRule]     pre-authorized ruling classes the driver may auto-apply (default none → halt on every escalation)
 * @param {function} [opts.runRuling]    injectable Principal-ruling runner (for tests)
 * @param {function} [opts.runFixEscalation] injectable applicator runner (for tests)
 * @param {function} [opts.onEvent]      progress callback (type + fields)
 * @param {function} [opts.sleep]        injectable delay (for tests)
 * @param {function} [opts.stallProbe]   injectable stall-probe factory (for tests); receives (stageName, stageId, cwd, changeId, dispatchStart, probeOpts) and returns a cancel()
 * @returns {Promise<object>} run summary
 */
async function run(opts = {}) {
  // ADR-009: --repair and --feature are mutually exclusive intents. Reject early
  // so there is no ambiguity about which string drives the changeId or patchItems.
  if (opts.repair && opts.feature) {
    return {
      completed: false,
      halted: true,
      halt_action: "mutual-exclusion",
      halt_failure_class: "mutual-exclusion",
      halt_reason: "--repair and --feature are mutually exclusive — a run is either a bug fix or a feature, not both",
      stages_advanced: [],
      iterations: 0,
      cost_usd: 0,
      cost_basis: null,
    };
  }

  const cwd = opts.cwd || process.cwd();
  // Config is intentionally pinned for the lifetime of this run. The track,
  // isolation mode, and changeId are derived here and baked into run-state.json —
  // re-reading config mid-loop could change the stage order or isolation path and
  // silently corrupt an in-progress run. Users who edit .devteam/config.yml mid-run
  // must stop and restart (run.lock will alert them to the active run).
  const config = opts.config || loadConfig(cwd);
  // ADR-006: resolveTrack returns {track, source, confidence} so the startup
  // confidence guard below can apply the require_confirmed_track check without
  // a second file read.
  const {
    track,
    source: trackSource,
    confidence: trackConfidence,
    assess_inline: assessInline,
  } = resolveTrack(opts, config, cwd);
  // ADR-016 (Phase 29.2): resolveTrack assessed a track inline (no --track, no
  // pipeline/track.json, no custom_stages). Persist the decision as the same
  // per-run record `devteam assess` writes, so it is a file an operator can
  // read/override, not a silent side effect — and so a subsequent invocation
  // in the same working tree picks up the recorded track via the higher-
  // precedence pipeline/track.json branch above instead of re-assessing.
  if (assessInline && cwd) {
    try {
      const tjPath = path.join(cwd, "pipeline", "track.json");
      const version = require("../package.json").version;
      fs.mkdirSync(path.dirname(tjPath), { recursive: true });
      fs.writeFileSync(tjPath, JSON.stringify({
        track,
        source: "inferred",
        confidence: trackConfidence,
        reasons: assessInline.reasons,
        assessed_at: nowIso(),
        assessed_by: `devteam run ${version} (assess-inline, ADR-016)`,
      }, null, 2) + "\n", "utf8");
    } catch { /* best-effort — a failed write must never block the run */ }
  }
  // ADR-009 §Decision.7: tag runs by intent from day one so feature vs repair
  // history is distinguishable in run-state.json and run-log.jsonl.
  const intent = opts.repair ? "repair" : "feature";
  // ADR-009 Phase 2: --repair-at escape hatch. Defined early so the stage-order
  // computation below can tell whether to prepend the diagnosis stage.
  const repairAtRaw = opts.repairAt || null;
  // B9 (item 1.6): derive changeId from feature + isolation config so the
  // driver reads/writes lock, run-state, run-log, gates, and context.md in
  // the same bounded subtree that runStageHeadless writes gates into.
  // Accept an explicit opts.changeId for tests; otherwise derive from feature
  // (or symptom for repair runs — ADR-009 §Consequences).
  const isolation = config.pipeline.isolation;
  const changeId = opts.changeId !== undefined
    ? opts.changeId
    : (isolation === "bounded"
        ? (opts.repair ? changeIdFromSymptom(opts.repair || "") : changeIdFromFeature(opts.feature || ""))
        : null);

  seedDeployContext(cwd, config, changeId);

  // Dependencies are injectable for deterministic testing of the loop without
  // spawning host CLIs; production passes none and gets the real orchestrator.
  const _next = opts.next || next;
  // ADR-017 (32.6): the loop below calls _nextWave exclusively now (a size-1
  // wave falls through the exact pre-017 single-action path — see the call
  // site). Tests and callers that inject a legacy opts.next single-action
  // stub (the pre-32.6 DI seam, still used throughout tests/) must keep
  // working unchanged, so an explicit opts.next with no opts.nextWave is
  // wrapped into a size-1 wave rather than silently ignored. Only when
  // NEITHER is given (production, and any test that wants real waves) does
  // this fall through to the real nextWave() — never to _next/next(), or
  // waves would never form outside tests.
  const _nextWave = opts.nextWave
    ? opts.nextWave
    : (opts.next ? ((callOpts) => ({ actions: [opts.next(callOpts)] })) : nextWave);
  const _runStageHeadless = opts.runStageHeadless || runStageHeadless;
  const _merge = opts.mergeWorkstreamGates || mergeWorkstreamGates;
  const _collectPatterns = opts.collectPatterns || collectPatterns;
  const _runReflector = opts.runReflector || runReflector;
  const _ingestMemory = opts.ingestMemory || ingestMemory;
  const maxIterations = Number.isInteger(opts.maxIterations) ? opts.maxIterations : DEFAULT_MAX_ITERATIONS;
  const budgetUsd = typeof opts.budgetUsd === "number" ? opts.budgetUsd : null;
  if (budgetUsd === null) {
    process.stderr.write(
      "[devteam run] Warning: no --budget-usd cap set. The run will not halt on spend.\n" +
      "              Use --budget-usd <amount> to prevent runaway cost.\n"
    );
  }
  // Phase-28 item 28.4: warn at most once per run when the cost total includes
  // any model-asserted (self-reported) cost_usd — i.e. some dispatch's host/
  // adapter didn't produce orchestrator-observed usage. Doesn't affect halt
  // semantics; purely an audit-trail signal (trust boundary, item 10).
  let assertedCostWarned = false;
  const timeoutMs = typeof opts.timeoutMs === "number" ? opts.timeoutMs : undefined;
  const allowStages = new Set(opts.allowStages || []);
  const onEvent = typeof opts.onEvent === "function" ? opts.onEvent : () => {};
  // PR-B: autonomous fix-and-retry knobs.
  const maxRetries = (config.autonomy && Number.isInteger(config.autonomy.max_retries))
    ? config.autonomy.max_retries
    : MAX_RETRIES_DEFAULT;
  const retryDelayMs = typeof opts.retryDelayMs === "number" ? opts.retryDelayMs : 30000;
  const maxTransientRetries = Number.isInteger(opts.maxTransientRetries)
    ? opts.maxTransientRetries
    : MAX_TRANSIENT_RETRIES_DEFAULT;
  const _sleep = typeof opts.sleep === "function" ? opts.sleep : defaultSleep;
  // ADR-007 Tier 1: stall probe config and injectable factory.
  const stallThresholdMs = (config.autonomy && typeof config.autonomy.stall_threshold_ms === "number")
    ? config.autonomy.stall_threshold_ms
    : 5 * 60 * 1000;
  const stallMinGrowthBytes = (config.autonomy && typeof config.autonomy.stall_min_growth_bytes === "number")
    ? config.autonomy.stall_min_growth_bytes
    : 512;
  const _stallProbe = typeof opts.stallProbe === "function" ? opts.stallProbe : defaultStallProbe;
  // PR-C2: bounded autonomous escalation resolution. Default grant is empty →
  // every escalation halts for a human (the safe default). Class-allowlist only.
  const grantSet = new Set(opts.autoRule || []);
  const _runRuling = typeof opts.runRuling === "function" ? opts.runRuling : defaultRunRuling;
  const _runFixEscalation = typeof opts.runFixEscalation === "function" ? opts.runFixEscalation : defaultRunFixEscalation;
  // ADR-009 §Decision.3: injectable scope gate for deterministic tests.
  const _checkScopeGate = typeof opts.checkScopeGate === "function" ? opts.checkScopeGate : defaultCheckScopeGate;

  // ADR-009 §Decision.1: repair stoplist upgrade — hotfix bypasses STOPLIST_TRACKS
  // by design, but auth/payments/migration symptoms must still force the track to
  // full. Check the symptom now (before acquiring the lock) so the upgrade is visible
  // in the initial run-state write. --force opts out, same as the regular stoplist.
  let effectiveTrack = track;
  let repairStoplistMatches = [];
  if (opts.repair && !opts.force && effectiveTrack !== "full") {
    const _checkStoplist = opts.checkStoplist || checkStoplist;
    repairStoplistMatches = _checkStoplist({ description: opts.repair, cwd });
    if (repairStoplistMatches.length > 0) effectiveTrack = "full";
  }

  // ADR-009 Phase 2: repair without escape hatch prepends "requirements" (diagnosis)
  // to the stage list so next() routes through it before build. The escape hatch
  // (--repair-at) seeds the affected-files list directly and writes a synthetic
  // stage-01 gate — no LLM diagnosis needed, so no prepend.
  // "requirements" is filtered out first to guard against double-prepend if the
  // user specifies a full track that already includes it.
  //
  // ADR-009 Phase 3: repair intent always includes "executable-spec" (stage-03b),
  // providing failing-first reproduction discipline even on hotfix depth (which
  // normally skips it — hotfix has no requirements stage and therefore no brief).
  // Inject executable-spec immediately before "build" in the filtered base list so
  // the PM authors the regression scenario before the build writes the failing test.
  const repairNeedsDiagnosis = intent === "repair" && !repairAtRaw;
  let order;
  if (intent === "repair") {
    const base = orderedStageNamesForTrack(effectiveTrack)
      .filter((n) => n !== "requirements" && n !== "executable-spec");
    const buildIdx = base.indexOf("build");
    const withSpec = buildIdx >= 0
      ? [...base.slice(0, buildIdx), "executable-spec", ...base.slice(buildIdx)]
      : ["executable-spec", ...base];
    order = repairNeedsDiagnosis ? ["requirements", ...withSpec] : withSpec;
  } else {
    order = orderedStageNamesForTrack(effectiveTrack);
  }
  const untilIndex = opts.until ? order.indexOf(opts.until) : -1;

  acquireLock(cwd, { force: opts.force }, changeId);

  const nowTs = nowIso();
  const state = (opts.resume && loadRunState(cwd, changeId)) || {
    track: Array.isArray(effectiveTrack) ? effectiveTrack.join(",") : effectiveTrack,
    intent,                                      // ADR-009 §Decision.7
    ...(opts.repair ? { repair: opts.repair } : {}), // symptom string persisted for correlation
    iterations: 0,
    retries: {},
    started_at: nowTs,
    // Phase 12.2: commit-cursor fields for `devteam commit`.
    stages_advanced: [],              // stage IDs advanced in pipeline order
    last_committed_stage_index: null, // index of last committed stage in stages_advanced
  };
  // Correlation id (ADR-009 §Decision.7): on resume, record the prior run's identity
  // so a re-classified re-run is linkable to its predecessor in the run log.
  if (opts.resume && state.started_at && state.started_at !== nowTs) {
    state.prior_run_id = state.started_at;
    state.started_at = nowTs;
  }
  // PR-B counters (resilient to a resumed state that predates them).
  state.fixRetries = state.fixRetries || {};      // code-defect re-dispatches per stage
  state.autoRule = state.autoRule || {};          // auto-rule attempts per stage
  state.transient = state.transient || {};        // no-gate transient retries per stage
  state.srcFingerprints = state.srcFingerprints || {}; // content hashes for no-source-change detection
  state.targetedFix = state.targetedFix || null;  // one-shot fix-and-retry dispatch hint
  state.skipped_stages = Array.isArray(state.skipped_stages) ? state.skipped_stages : [];
  state.active_workstreams = {};
  state.last_workstream = state.last_workstream || null;
  // ADR-017 (32.6): monotonic per-run counter, persisted like the other PR-B
  // counters above so it survives `devteam run --resume` instead of
  // restarting at 1 and colliding with wave_ids already in run-log.jsonl.
  state.wave_id_counter = Number.isInteger(state.wave_id_counter) ? state.wave_id_counter : 0;
  // Phase 12.2: commit-cursor fields (resilient to resumed pre-12.2 states).
  if (!Array.isArray(state.stages_advanced)) state.stages_advanced = [];
  if (!("last_committed_stage_index" in state)) state.last_committed_stage_index = null;

  const summary = {
    completed: false,
    halted: false,
    halt_action: null,
    halt_failure_class: null,
    halt_reason: null,
    stages_advanced: [],
    iterations: 0,
    cost_usd: 0,
    cost_basis: null,
  };
  const activeRoleCandidates = config.pipeline.right_sizing === false
    ? { roles: [], trigger_inputs: {} }
    : candidateActiveRoles(cwd);
  const rightSizedSkips = config.pipeline.right_sizing === false
    ? {}
    : deterministicSkipsForOrder(order, cwd, { changeId });
  const skippedForExpected = [
    ...((config.pipeline && config.pipeline.skip_stages) || []),
    ...Object.keys(rightSizedSkips),
  ];
  const runPlan = summarizeRunPlan(order, config, {
    rightSizedSkips,
    candidateActiveRoles: activeRoleCandidates.roles,
    expectedWorkstreams: expectedWorkstreamCount(order, effectiveTrack, {
      skipped: skippedForExpected,
      activeRoles: activeRoleCandidates.roles,
    }),
  });
  // 29.3: ceremony cost preview for the pre-flight run-plan event. Scoped to
  // the same right-sized stage list summarizeRunPlan just computed (not the
  // raw track shape) so the estimate matches what will actually dispatch.
  // Advisory only — a preview failure must never block a run.
  const includedStageNames = order.filter((name) =>
    !((config.pipeline && config.pipeline.skip_stages) || []).includes(name)
    && !Object.prototype.hasOwnProperty.call(rightSizedSkips, name));
  let ceremony = null;
  try {
    ceremony = ceremonyPreview(cwd, effectiveTrack, config, { stageNames: includedStageNames });
  } catch { /* preview is advisory — the run proceeds without it */ }
  const applyTransition = (result) => applyTransitionResult(result, {
    summary,
    state,
    logEvent: (entry) => logEvent(cwd, changeId, entry),
    onEvent,
  });
  if (!opts.resume && config.pipeline.right_sizing !== false) {
    seedRightSizingContext(cwd, changeId, activeRoleCandidates);
  }

  // runStart stoplist check (Phase 1 § 1.1 check-point 1 of 2): refuse before
  // any dispatch when the resolved track is in STOPLIST_TRACKS and the brief or
  // description already matches.  Full/hotfix bypass by design — they are not in
  // STOPLIST_TRACKS.  --force opts out.
  function runStoplistCheck(label) {
    if (!STOPLIST_TRACKS.has(effectiveTrack)) return false; // bypass for full/hotfix
    if (opts.force) return false;                            // --force explicit bypass
    const _checkStoplist = opts.checkStoplist || checkStoplist;
    const matches = _checkStoplist({ description: opts.description || "", cwd });
    if (matches.length === 0) return false;
    const reason = explainMatches(matches);
    summary.halted = true;
    summary.halt_action = "stoplist";
    summary.halt_reason = reason;
    logEvent(cwd, changeId, { outcome: "stoplist-halt", label, track: effectiveTrack, matches: matches.map((m) => m.name) });
    onEvent({ type: "halt", action: "stoplist", reason, label, track: effectiveTrack, matches: matches.map((m) => m.name) });
    return true; // halted
  }

  // Repair mode starts with the reported symptom, then replaces it with the
  // diagnosis gate's affected_files after stage-01 passes.
  let repairPatchItems = opts.repair ? [opts.repair] : null;

  try {
    logEvent(cwd, changeId, {
      outcome: "run-plan",
      track: Array.isArray(effectiveTrack) ? "custom" : effectiveTrack,
      track_source: trackSource,
      track_confidence: trackConfidence,
      assess_inline: assessInline || null,
      intent,
      ceremony_preview: ceremony,
      ...runPlan,
    });
    onEvent({
      type: "run-plan",
      track: Array.isArray(effectiveTrack) ? "custom" : effectiveTrack,
      track_source: trackSource,
      track_confidence: trackConfidence,
      assess_inline: assessInline || null,
      intent,
      ceremony_preview: ceremony,
      ...runPlan,
    });

    // Log the repair stoplist upgrade event (computed before lock/state were set up).
    if (repairStoplistMatches.length > 0) {
      logEvent(cwd, changeId, {
        outcome: "repair-stoplist-upgrade",
        symptom: opts.repair,
        upgraded_to: effectiveTrack,
        matches: repairStoplistMatches.map((m) => m.name),
      });
      onEvent({
        type: "repair-stoplist-upgrade",
        track: effectiveTrack,
        matches: repairStoplistMatches,
      });
    }

    // ADR-009 Phase 2: --repair-at escape hatch. Parse locations, seed
    // affectedFiles + patchItems, write synthetic stage-01 PASS gate.
    if (repairAtRaw && opts.repair) {
      const locations = Array.isArray(repairAtRaw)
        ? repairAtRaw
        : String(repairAtRaw).split(",").map((s) => s.trim()).filter(Boolean);
      const seededFiles = [...new Set(locations.map((loc) => loc.replace(/:.*$/, "")))];
      if (seededFiles.length > 0) {
        state.affectedFiles = seededFiles;
        repairPatchItems = locations.map((loc) => `Fix ${loc}: ${opts.repair}`);
        // Synthetic gate makes next() see stage-01 as PASS (skips LLM diagnosis).
        const diagGatePath = path.join(gatesDir(cwd, changeId), "stage-01.json");
        try {
          fs.mkdirSync(path.dirname(diagGatePath), { recursive: true });
          fs.writeFileSync(diagGatePath, JSON.stringify({
            stage: "stage-01",
            workstream: "pm",
            status: "PASS",
            track: effectiveTrack,
            timestamp: nowIso(),
            blockers: [],
            warnings: [],
            root_cause: opts.repair,
            proposed_fix: `User-specified fix location(s): ${locations.join(", ")}`,
            affected_files: seededFiles,
            regression_criterion: "",
            diagnosis_confirmed: true,
            seeded_by: "--repair-at",
            seeded_locations: locations,
          }, null, 2) + "\n");
        } catch { /* best-effort — if write fails, next() dispatches stage-01 normally */ }
        saveRunState(cwd, changeId, state);
        logEvent(cwd, changeId, {
          outcome: "repair-at-seeded",
          symptom: opts.repair,
          locations,
          affected_files: seededFiles,
        });
        onEvent({ type: "repair-at-seeded", symptom: opts.repair, locations, affected_files: seededFiles });
      }
    }

    // ADR-006 §2/4: run-start event captures track provenance before any check.
    logEvent(cwd, changeId, {
      outcome: "run-start",
      track: Array.isArray(effectiveTrack) ? effectiveTrack.join(",") : effectiveTrack,
      track_source: trackSource,
      track_confidence: trackConfidence,
      intent,
    });

    // Check-point 1: run start (before the first loop iteration).
    if (runStoplistCheck("run-start")) {
      // halt recorded above; skip the loop entirely.
    } else {
    // ADR-006 §3/4: checkTrackConfidence — keyed on autonomy.require_confirmed_track
    // (NOT CI=true — revision note 1; CI is already overloaded by validator strict-mode
    // and set by verify/runner). Off (default): warn-once on inferred, never block.
    // On: inferred at medium/low halts with typed unconfirmed-track (no prompt —
    // revision note 3); high proceeds. --force bypasses; --track sets source:"human".
    const _requireConfirmedTrack = !!(config.autonomy && config.autonomy.require_confirmed_track);
    let trackHalted = false;

    if (trackSource === "inferred" && !opts.force) {
      if (_requireConfirmedTrack && trackConfidence !== "high") {
        const tName = Array.isArray(effectiveTrack) ? "custom" : effectiveTrack;
        const reason =
          `Track '${tName}' was inferred at ${trackConfidence || "unknown"} confidence. ` +
          `Set pipeline/track.json source to 'human' (run \`devteam assess --confirm\`) or pass --track.`;
        logEvent(cwd, changeId, { outcome: "track-confidence-check", source: trackSource, confidence: trackConfidence, halted: true, reason });
        onEvent({ type: "track-confidence-check", source: trackSource, confidence: trackConfidence, halted: true });
        summary.halted = true;
        summary.halt_action = "unconfirmed-track";
        summary.halt_failure_class = "unconfirmed-track";
        summary.halt_reason = reason;
        trackHalted = true;
      } else {
        // warn-once: flag off, or flag on + high confidence (high proceeds per ADR-006 §3)
        const tName = Array.isArray(effectiveTrack) ? "custom" : effectiveTrack;
        logEvent(cwd, changeId, { outcome: "track-confidence-check", source: trackSource, confidence: trackConfidence, warned: true });
        onEvent({ type: "track-confidence-check", source: trackSource, confidence: trackConfidence, warned: true });
        process.stderr.write(`[devteam] track '${tName}' was auto-inferred (${trackConfidence || "unknown"} confidence). Pass --track to silence.\n`);
      }
    } else if (trackSource === "inferred" && opts.force) {
      // --force bypasses the unconfirmed-track halt; still log for the audit trail
      logEvent(cwd, changeId, { outcome: "track-confidence-check", source: trackSource, confidence: trackConfidence, bypassed: "force" });
      onEvent({ type: "track-confidence-check", source: trackSource, confidence: trackConfidence, bypassed: "force" });
    }

    // ADR-017 (32.6): dispatch one wave member. Mirrors the run-stage/
    // continue-stage handling in the single-action loop below exactly (guard
    // checks, stall probe, _runStageHeadless call, dispatch classification,
    // retry/halt decisions) but returns a control signal ("continue" | "halt")
    // instead of directly break-ing/continue-ing the driver's for loop, so
    // dispatchWave() can run N of these concurrently via Promise.all and
    // decide the wave's overall outcome only after every member has settled
    // (ADR-017 §6: a FAIL halts wave advancement without touching an
    // already-passing sibling's gate — siblings are never killed mid-flight,
    // they simply all finish before halt is decided). Only ever called for
    // r.action === "run-stage" | "continue-stage" — see the wave-narrowing
    // comment at the call site for why fix-and-retry/other actions never
    // reach here as a secondary wave member.
    async function dispatchWaveMember(r, waveId) {
      const base = {
        iteration: state.iterations,
        stage: r.stage || null,
        name: r.name || null,
        action: r.action,
        failure_class: r.failure_class || null,
        reason: r.reason,
        intent,
        wave_id: waveId,
      };

      const _writeConvergenceEscalate = (stageId, stageName, reason) => {
        try {
          const p = path.join(gatesDir(cwd, changeId), `${stageId}.json`);
          if (!fs.existsSync(p)) return;
          const g = JSON.parse(fs.readFileSync(p, "utf8"));
          g.status = "ESCALATE";
          g.escalation_reason = reason;
          g.decision_needed =
            `Add fix instructions to pipeline/context.md above devteam markers, `
            + `then: devteam restart ${stageName} && devteam run`;
          fs.writeFileSync(p, JSON.stringify(g, null, 2) + "\n", "utf8");
        } catch { /* best-effort */ }
      };

      const guardTransition = dispatchGuardTransition({
        action: r,
        base,
        consequenceCeiling: CONSEQUENCE_CEILING,
        allowStages,
        order,
        untilIndex,
        until: opts.until,
        budgetUsd,
        spent: budgetUsd == null ? 0 : totalCostUsd(cwd, changeId),
      });
      if (guardTransition) {
        applyTransition(guardTransition);
        return "halt";
      }

      if (r.stage === "stage-04" && runStoplistCheck("pre-build")) return "halt";

      if (intent === "repair" && !repairAtRaw && !state.affectedFiles) {
        const diagGatePath = path.join(gatesDir(cwd, changeId), "stage-01.json");
        try {
          if (fs.existsSync(diagGatePath)) {
            const diagGate = JSON.parse(fs.readFileSync(diagGatePath, "utf8"));
            if (
              diagGate.status === "PASS" &&
              Array.isArray(diagGate.affected_files) &&
              diagGate.affected_files.length > 0
            ) {
              state.affectedFiles = diagGate.affected_files;
              repairPatchItems = diagGate.affected_files.map(
                (f) => `Fix ${f}: ${diagGate.proposed_fix || opts.repair}`,
              );
              saveRunState(cwd, changeId, state);
              logEvent(cwd, changeId, {
                outcome: "diagnosis-activated",
                affected_files: state.affectedFiles,
              });
            }
          }
        } catch { /* best-effort — diagnosis gate may not exist yet */ }
      }

      const t0 = Date.now();
      logEvent(cwd, changeId, { ...base, outcome: "dispatch-started", queue_ms: 0 });
      onEvent({ type: "dispatch", ...base });
      // ADR-007 Tier 1: start the observe-only stall probe fire-and-forget.
      // The probe emits stall-detected if the workstream log and gate are both
      // flat for stallThresholdMs. It NEVER kills or alters the dispatch — the
      // await below is always the sole resolution path (no Promise.race).
      const cancelStallProbe = _stallProbe(r.name, r.stage, cwd, changeId, t0, {
        stallThresholdMs,
        stallMinGrowthBytes,
        logEvent: (entry) => logEvent(cwd, changeId, entry),
        onEvent,
        iteration: state.iterations,
        action: r.action,
        sleep: _sleep,
      });
      let runResult;
      const targetedFix = state.targetedFix
        && state.targetedFix.stage === r.stage
        && state.targetedFix.name === r.name
        ? state.targetedFix
        : null;
      const targetedFixSnapshot = targetedFix
        ? hashTargetedFixFiles(cwd, targetedFix.files)
        : null;
      const onWorkstreamEvent = (event) => {
        const key = event.workstream_id || `${event.stage || r.stage}.${event.role || "unknown"}`;
        const normalized = {
          ...base,
          ...event,
          gate_path: relPath(cwd, event.gate_path),
          log_path: relPath(cwd, event.log_path),
        };
        if (event.type === "workstream-started") {
          state.active_workstreams[key] = {
            stage: event.stage || r.stage,
            name: event.name || r.name,
            role: event.role || null,
            host: event.host || null,
            workstream_id: key,
            gate_path: normalized.gate_path,
            log_path: normalized.log_path,
            prompt_bytes: event.prompt_bytes ?? null,
            context_manifest_files: event.context_manifest_files ?? null,
            context_manifest_omitted: event.context_manifest_omitted ?? null,
            started_at: nowIso(),
          };
        } else if (event.type === "workstream-finished") {
          delete state.active_workstreams[key];
          state.last_workstream = {
            stage: event.stage || r.stage,
            name: event.name || r.name,
            role: event.role || null,
            host: event.host || null,
            workstream_id: key,
            gate_path: normalized.gate_path,
            log_path: normalized.log_path,
            duration_ms: event.duration_ms ?? null,
            prompt_bytes: event.prompt_bytes ?? null,
            context_manifest_files: event.context_manifest_files ?? null,
            context_manifest_omitted: event.context_manifest_omitted ?? null,
            exit_code: event.exit_code ?? null,
            timed_out: Boolean(event.timed_out),
            skipped: Boolean(event.skipped),
            finished_at: nowIso(),
          };
        }
        saveRunState(cwd, changeId, state);
        logEvent(cwd, changeId, { ...normalized, outcome: event.type });
        onEvent(normalized);
      };
      const stageDef = STAGES[r.name];
      if (stageDef && stageDef.preSeedGate && r.stage) {
        writeStubGate(gatesDir(cwd, changeId), r.stage, effectiveTrack);
      }
      try {
        runResult = await _runStageHeadless(r.name, {
          cwd,
          track: effectiveTrack,
          feature: opts.feature || "",
          scope: opts.scope,
          processCwd: opts.processCwd,
          externalReviewMode: opts.externalReviewMode === true,
          intent,
          timeoutMs,
          skipCompleted: r.action === "continue-stage",
          runId: state.started_at,
          isRetry: (state.fixRetries[r.name] || 0) > 0,
          ...(targetedFix ? { workstream: [targetedFix.workstream] } : {}),
          ...(repairPatchItems
            ? { patchItems: repairPatchItems }
            : targetedFix ? { patchItems: targetedFix.patchItems } : {}),
          onWorkstreamEvent,
        });
      } finally {
        cancelStallProbe();
      }
      if (targetedFix) {
        state.targetedFix = null;
        saveRunState(cwd, changeId, state);
        logEvent(cwd, changeId, {
          ...base,
          outcome: "targeted-fix-dispatch",
          workstream: targetedFix.workstream,
          patch_items: targetedFix.patchItems.length,
          source_stage: targetedFix.source_stage,
        });
      }
      const dispatch = normalizeDispatchResults(runResult);
      const { results, timedOut: anyTimedOut, wroteGate, stubGate: anyStubGate, exitCode, queueWaitMs } = dispatch;
      const durationMs = Date.now() - t0;
      for (const result of results) {
        const observation = dispatchObservation(base, result);
        if (observation) logEvent(cwd, changeId, observation);
      }
      state.retries[r.name] = (state.retries[r.name] || 0) + 1;
      if (r.stage && !state.stages_advanced.includes(r.stage)) state.stages_advanced.push(r.stage);
      saveRunState(cwd, changeId, state);
      if (!summary.stages_advanced.includes(r.name)) summary.stages_advanced.push(r.name);
      logEvent(cwd, changeId, {
        ...base, outcome: "dispatched",
        duration_ms: durationMs, workstreams: results.length,
        timed_out: anyTimedOut, no_gate: !wroteGate,
        queue_ms: queueWaitMs,
      });
      onEvent({ type: "dispatched", ...base, duration_ms: durationMs, timed_out: anyTimedOut, queue_ms: queueWaitMs });

      const retryPlan = transientDelayPlan({
        retryDelayMs,
        timedOut: anyTimedOut,
        stubGate: anyStubGate,
        exitCode,
      });
      const outcomeTransition = dispatchOutcomeTransition({
        action: r,
        base,
        transient: state.transient,
        maxTransientRetries,
        retryDelayMs: retryPlan.delayMs,
        retryReason: retryPlan.retryReason,
        backoffClass: retryPlan.backoffClass,
        wroteGate,
        exitCode,
        timedOut: anyTimedOut,
        stubGate: anyStubGate,
      });
      applyTransition(outcomeTransition);
      saveRunState(cwd, changeId, state);
      if (outcomeTransition.details.dispatchClass === "ok") {
        if (
          targetedFix
          && targetedFixSnapshot
          && targetedFixChanged(cwd, targetedFixSnapshot) === false
        ) {
          const evidence = targetedFixNoSourceChangeEvidence(targetedFixSnapshot);
          applyTransition(targetedFixNoChangeTransition({
            action: r,
            base,
            evidence,
            workstream: targetedFix.workstream,
          }));
          _writeConvergenceEscalate(r.stage, r.name, summary.halt_reason);
          return "halt";
        }

        const affectedFiles = opts.affectedFiles || state.affectedFiles || null;
        if (r.stage === "stage-04" && affectedFiles) {
          const outOfScope = _checkScopeGate(cwd, affectedFiles);
          const scopeTransition = scopeGateTransition({ base, outOfScope });
          if (scopeTransition) {
            applyTransition(scopeTransition);
            return "halt";
          }
        }

        return "continue";
      }
      if (outcomeTransition.details.retry) {
        if (outcomeTransition.details.removeStubGate && r.stage) {
          try { fs.unlinkSync(path.join(gatesDir(cwd, changeId), `${r.stage}.json`)); } catch { /* already gone */ }
        }
        await _sleep(outcomeTransition.details.delayMs);
        return "continue"; // retried in place; next wave-formation re-picks this stage up
      }
      return "halt";
    }

    // ADR-017 §6: run every wave member concurrently; the wave halts (driver
    // does not form a new wave next iteration) if ANY member halts, but every
    // member always runs to completion first — a fast/passing sibling is
    // never killed or invalidated because another member fails.
    async function dispatchWave(members, waveId) {
      const outcomes = await Promise.all(members.map((r) => dispatchWaveMember(r, waveId)));
      return outcomes.includes("halt") ? "halt" : "continue";
    }

    if (!trackHalted) {
    for (let i = 0; i < maxIterations; i++) {
      // ADR-007 §2: emit heartbeat before next() so run-log.jsonl always has a
      // bounded last-event age regardless of dispatch duration. Cheap: no fs scans.
      const heartbeatIteration = (state.iterations || 0) + 1;
      const heartbeatCost = costUsdDetail(cwd, changeId);
      logEvent(cwd, changeId, {
        outcome: "heartbeat",
        iteration: heartbeatIteration,
        stage: state.current_stage || null,
        action: state.last_action || null,
        run_state_path: runStatePath(cwd, changeId),
        cost_usd_so_far: heartbeatCost.total,
      });
      onEvent({
        type: "heartbeat",
        iteration: heartbeatIteration,
        stage: state.current_stage || null,
        action: state.last_action || null,
        cost_usd: heartbeatCost.total,
      });
      if (!assertedCostWarned && (heartbeatCost.basis === "model-asserted" || heartbeatCost.basis === "mixed")) {
        assertedCostWarned = true;
        const msg = `cost total includes model-asserted (self-reported) cost_usd, not just orchestrator-observed usage (cost_basis: "${heartbeatCost.basis}")`;
        logEvent(cwd, changeId, { outcome: "cost-basis-warning", cost_basis: heartbeatCost.basis, message: msg });
        onEvent({ type: "cost-basis-warning", cost_basis: heartbeatCost.basis });
        process.stderr.write(`[devteam run] note: ${msg}\n`);
      }

      // Pass the repair-aware order (array) for repair runs — includes the diagnosis
      // stage at the front. For feature runs, pass effectiveTrack so pipeline/track.json
      // and custom_stages selections propagate to next() without a second config read.
      const nextTrack = intent === "repair" ? order : effectiveTrack;
      const waveResult = _nextWave({
        cwd,
        track: nextTrack,
        changeId,
        auditSkips: true,
        auditedSkips: state.skipped_stages,
      });
      // ADR-017 (32.6): only run-stage/continue-stage members are dispatched
      // concurrently. A ready set containing anything else (fix-and-retry,
      // resolve-escalation, merge, skip-stage, fold-sign-off, pipeline-complete,
      // ...) collapses to its first member, which then falls through the exact
      // single-action path below unchanged — this is what makes a size-1 wave
      // byte-identical to next(). Deliberate scope narrowing: dispatchWaveMember
      // does not replicate the fix-and-retry branch's convergence/archiving
      // bookkeeping, so 2+ simultaneous fix-and-retry members are not batched
      // concurrently this session (see this session's DEVIATIONS note) — the
      // fresh/resuming dispatch this ADR's wall-clock claim is built on is
      // unaffected, since both authorized regions' first-ever readiness is
      // always run-stage.
      let waveActions = waveResult.actions;
      if (waveActions.length > 1 && !waveActions.every((a) => a.action === "run-stage" || a.action === "continue-stage")) {
        waveActions = [waveActions[0]];
      }

      state.iterations = (state.iterations || 0) + 1; // once per wave, not per member

      if (waveActions.length > 1) {
        state.wave_id_counter += 1;
        const waveId = state.wave_id_counter;
        state.last_action = waveActions[0].action;
        state.current_stage = waveActions.map((a) => a.name).join("+");
        saveRunState(cwd, changeId, state);
        logEvent(cwd, changeId, {
          iteration: state.iterations,
          outcome: "wave-formed",
          wave_id: waveId,
          members: waveActions.map((a) => ({ stage: a.stage, name: a.name, action: a.action })),
        });
        onEvent({ type: "wave-formed", iteration: state.iterations, wave_id: waveId, members: waveActions.map((a) => a.name) });
        const waveControl = await dispatchWave(waveActions, waveId);
        if (waveControl === "halt") break;
        continue;
      }

      const r = waveActions[0];
      state.last_action = r.action;
      state.current_stage = r.name || null;
      saveRunState(cwd, changeId, state);

      const base = {
        iteration: state.iterations,
        stage: r.stage || null,
        name: r.name || null,
        action: r.action,
        failure_class: r.failure_class || null,
        reason: r.reason,
        intent, // ADR-009 §Decision.7
      };

      if (r.action === "pipeline-complete") {
        // ADR-008: post-completion advise sweep. Classify all noted_for_followup
        // items to surface advisory blockers without altering the exit contract.
        // Best-effort: a sweep failure must never break a clean run.
        try {
          const adviseResult = runAdvise(cwd, {
            checkOnly: true,
            gatesDir: gatesDir(cwd, changeId),
            contextFile: path.join(pipelineRoot(cwd, changeId), "context.md"),
          });
          const breakdown = {};
          for (const r2 of adviseResult.items) {
            if (!r2.addressed) {
              breakdown[r2.classification] = (breakdown[r2.classification] || 0) + 1;
            }
          }
          summary.advisory_blockers_count = adviseResult.unresolvedBlockers;
          summary.advisory_breakdown = breakdown;
        } catch { /* sweep failure must never break the run */ }
        applyTransitionResult(transitionResult(TRANSITION_CONTROLS.COMPLETE, {
          summaryPatch: { completed: true },
          logEvents: [{ ...base, outcome: "complete" }],
          emittedEvents: [{ type: "complete", ...base }],
        }), {
          summary,
          state,
          logEvent: (entry) => logEvent(cwd, changeId, entry),
          onEvent,
        });
        break;
      }

      // fold-sign-off: orchestrator verified a clean AC→test mapping and
      // returned the gate content for us to persist. Write the gate here so
      // the act is visible in the audit log (today it was a silent side effect
      // of next()). No --allow-stage required — the fold is orchestrator-derived
      // from verified AC mapping, not model-asserted. (item 1.2, phase-1-trust)
      if (r.action === "fold-sign-off") {
        fs.mkdirSync(path.dirname(r.gate_path), { recursive: true });
        fs.writeFileSync(r.gate_path, JSON.stringify(r.gate_content, null, 2) + "\n", "utf8");
        logEvent(cwd, changeId, {
          ...base,
          outcome: "auto-fold-sign-off",
          event: "auto-fold-sign-off",
          derived_from: "brief AC mapping",
          gate_path: r.gate_path,
          ac_count: r.acCount,
        });
        onEvent({ type: "auto-fold-sign-off", ...base, ac_count: r.acCount });
        continue;
      }

      if (r.action === "record-local-deploy") {
        fs.mkdirSync(path.dirname(r.deploy_log_path), { recursive: true });
        fs.writeFileSync(r.deploy_log_path, r.deploy_log_content, "utf8");
        fs.mkdirSync(path.dirname(r.gate_path), { recursive: true });
        fs.writeFileSync(r.gate_path, JSON.stringify(r.gate_content, null, 2) + "\n", "utf8");
        logEvent(cwd, changeId, {
          ...base,
          outcome: "record-local-deploy",
          event: "record-local-deploy",
          derived_from: "stage-07 deploy_requested false",
          gate_path: r.gate_path,
          deploy_log_path: r.deploy_log_path,
        });
        onEvent({ type: "record-local-deploy", ...base });
        continue;
      }

      if (r.action === "skip-stage") {
        if (r.name && !state.skipped_stages.includes(r.name)) state.skipped_stages.push(r.name);
        saveRunState(cwd, changeId, state);
        logEvent(cwd, changeId, {
          ...base,
          outcome: "skip-stage",
          skip_kind: r.skip_kind || null,
          trigger_inputs: r.trigger_inputs || {},
        });
        onEvent({
          type: "skip-stage",
          ...base,
          skip_kind: r.skip_kind || null,
          trigger_inputs: r.trigger_inputs || {},
        });
        continue;
      }

      // PR-B: the driver auto-fixes code-defect FAILs — clear the failing
      // gate(s) the recipe names, propagate the blockers as context, and loop
      // (next() will re-dispatch). Bounded by a driver-side retry ceiling, the
      // authoritative backstop (next()'s convergence-exhausted relies on the
      // agent bumping retry_number, which the driver does not control).

      // Write an ESCALATE gate so convergence-exhausted is visible on disk,
      // not only in run-state.json / run-log.jsonl. Best-effort; never blocks halt.
      const _writeConvergenceEscalate = (stageId, stageName, reason) => {
        try {
          const p = path.join(gatesDir(cwd, changeId), `${stageId}.json`);
          if (!fs.existsSync(p)) return;
          const g = JSON.parse(fs.readFileSync(p, "utf8"));
          g.status = "ESCALATE";
          g.escalation_reason = reason;
          g.decision_needed =
            `Add fix instructions to pipeline/context.md above devteam markers, `
            + `then: devteam restart ${stageName} && devteam run`;
          fs.writeFileSync(p, JSON.stringify(g, null, 2) + "\n", "utf8");
        } catch { /* best-effort */ }
      };

      if (r.action === "fix-and-retry" && r.failure_class === "code-defect") {
        const attempts = state.fixRetries[r.name] || 0;
        const budgetTransition = retryBudgetTransition({
          action: r, base, attempts, maxRetries,
        });
        if (budgetTransition) {
          applyTransition(budgetTransition);
          _writeConvergenceEscalate(r.stage, r.name, summary.halt_reason);
          break;
        }
        // Archive the failed attempt's stage gate before it's cleared/overwritten.
        // The archive is the data source for the progress-based convergence check
        // below — archiving must happen first. Best-effort.
        const archived = archiveGate(gatesDir(cwd, changeId), r.stage, attempts + 1);

        // Progress-based convergence check (4.2): trip the breaker when the last
        // two archived attempts carry identical non-empty blocker sets, even before
        // the count ceiling is reached. Prefers archived data (orchestrator-written)
        // over the current live gate (model-written). (ADR-003)
        const progress = detectNoProgress(gatesDir(cwd, changeId), r.stage);
        if (progress.noProgress) {
          const evidence = noProgressEvidence(progress.stuckBlockers, progress.attempts);
          applyTransition(convergenceTransition({
            action: r, base, kind: "no-progress", evidence, archived,
          }));
          _writeConvergenceEscalate(r.stage, r.name, summary.halt_reason);
          break;
        }

        // No-source-change check: if blockers name specific files and those files'
        // content is identical to the baseline captured on the previous iteration,
        // the build agent made no actionable edits. Halt before dispatching another
        // wasted build — the defect requires a config-level fix the agent cannot apply.
        const srcCheck = detectNoSourceChange(cwd, gatesDir(cwd, changeId), r.stage, state);
        if (srcCheck.noSourceChange) {
          const evidence = noSourceChangeEvidence(srcCheck.lastAttempt, srcCheck.files);
          applyTransition(convergenceTransition({
            action: r, base, kind: "no-source-change", evidence, archived,
          }));
          _writeConvergenceEscalate(r.stage, r.name, summary.halt_reason);
          break;
        }

        // B9 (item 5.4): recipes emit in-place pipeline/ paths; rewrite them
        // through prefixPipelineRelative so bounded runs clear the right gates.
        const toClear = (r.clear_gates || []).map((rel) =>
          path.join(cwd, prefixPipelineRelative(rel, changeId)),
        );
        const cleared = clearGates(toClear);
        // 5.2: prune archives for every stage whose gates were cleared — re-entry
        // starts a fresh attempt sequence so stale archives must not survive.
        // Best-effort; derive stage IDs from the gate filenames (part before first dot).
        const clearedStageIds = new Set(
          toClear.map((p) => path.basename(p).replace(/\..*$/, "")),
        );
        for (const sid of clearedStageIds) {
          try { pruneArchives(gatesDir(cwd, changeId), sid); } catch { /* never block a retry */ }
        }
        // If a recipe exists but cleared nothing, next() will return the same
        // fix-and-retry unchanged. Halt immediately rather than burning retries.
        // Stages with no recipe (toClear empty) still reach convergence-exhausted —
        // they may recover if the agent self-corrects on retry.
        if (cleared.length === 0 && toClear.length > 0) {
          applyTransition(blockedFixTransition({ action: r, base, archived }));
          break;
        }
        writeRunBlockers(cwd, r.name, r.blockers, changeId);
        const targetedFix = targetedBuildFixFromRetry(cwd, changeId, r);
        const target = targetedFix
          ? { workstream: targetedFix.workstream, patch_items: targetedFix.patchItems.length }
          : null;
        applyTransition(fixRetryTransition({
          action: r,
          base,
          attempts,
          clearedCount: cleared.length,
          archived,
          target,
          derivable: toClear.length > 0,
          targetedFix,
          fixRetries: state.fixRetries,
        }));
        saveRunState(cwd, changeId, state);
        continue;
      }

      // PR-C2: bounded autonomous escalation resolution. With no --auto-rule
      // grant the driver halts (the safe default). With a grant, it dispatches
      // the Principal and auto-applies a ruling whose class is granted — but
      // NEVER crosses the hard stops (cannot-decide, the consequence ceiling,
      // convergence-exhausted), and at most once per stage.
      if (r.action === "resolve-escalation") {
        const hardStop = r.failure_class === "convergence-exhausted" || CONSEQUENCE_CEILING.has(r.name);
        const alreadyTried = (state.autoRule[r.name] || 0) >= 1;
        const preflightTransition = rulingPreflightTransition({
          action: r,
          base,
          grantCount: grantSet.size,
          hardStop,
          alreadyTried,
        });
        if (preflightTransition) {
          applyTransition(preflightTransition);
          break;
        }

        // Dispatch the Principal; inspect only the output it appends this turn.
        const before = loadPrincipalOutputs(cwd).length;
        onEvent({ type: "auto-rule-dispatch", ...base });
        const rr = await _runRuling(cwd, { targetGate: r.gate });
        state.autoRule[r.name] = (state.autoRule[r.name] || 0) + 1;
        saveRunState(cwd, changeId, state);
        const fresh = loadPrincipalOutputs(cwd).slice(before);
        const latest = fresh.length ? fresh[fresh.length - 1] : null;
        const outcomeTransition = rulingOutcomeTransition({
          base, rulingResult: rr, latest, grantSet,
        });
        if (outcomeTransition) {
          applyTransition(outcomeTransition);
          break;
        }
        // Granted class → apply the ruling and resume.
        // Snapshot build workstream gate mtimes before the applicator runs.
        // Used below to detect whether the applicator actually dispatched build
        // work when the ruling's decision mentions a build workstream dispatch.
        const _gatesDir = getGatesDir(cwd, changeId);
        const BUILD_GATE_RE = /^stage-04\.\w+\.json$/;
        const preMtimes = {};
        try {
          for (const f of fs.readdirSync(_gatesDir).filter(n => BUILD_GATE_RE.test(n))) {
            const full = path.join(_gatesDir, f);
            try { preMtimes[full] = fs.statSync(full).mtimeMs; } catch { /* */ }
          }
        } catch { /* gates dir may not yet exist */ }

        const fr = await _runFixEscalation(cwd, { escalatingGate: r.gate });
        const appliedTransition = rulingAppliedTransition({ base, applyResult: fr, latest });
        if (appliedTransition.control === TRANSITION_CONTROLS.HALT) {
          applyTransition(appliedTransition);
          break;
        }
        // When the ruling explicitly orders dispatching a build workstream, verify
        // the applicator actually updated or created a build gate. An applicator
        // that ran peer-review instead (or did nothing) would waste the auto-rule
        // grant and cause the stage to cycle until convergence-exhausted.
        let buildGateUpdated = false;
        try {
          for (const f of fs.readdirSync(_gatesDir).filter(n => BUILD_GATE_RE.test(n))) {
            const full = path.join(_gatesDir, f);
            try {
              const mtime = fs.statSync(full).mtimeMs;
              if (!preMtimes[full] || mtime > preMtimes[full]) { buildGateUpdated = true; break; }
            } catch { /* */ }
          }
        } catch { /* gates dir may not exist */ }
        const dispatchVerification = rulingDispatchVerificationTransition({
          base, latest, buildGateUpdated,
        });
        if (dispatchVerification) {
          applyTransition(dispatchVerification);
          if (dispatchVerification.control === TRANSITION_CONTROLS.HALT) break;

          // Applicator confirmed build dispatch — reset the one-shot auto-rule
          // counter so a subsequent peer-review escalation for a new reason gets
          // a fresh attempt rather than halting immediately on alreadyTried.
          state.autoRule[r.name] = 0;
          saveRunState(cwd, changeId, state);
        }

        const { authority } = appliedTransition.details;
        // PR-D2: bind the authority record ONTO the escalating gate, so the
        // autonomous-decision provenance inherits C6 tamper-evidence (vs. only
        // living in run-log.jsonl). Best-effort: if the applicator cleared the
        // gate to re-run, the run-log still carries the record. The gate is
        // hashed by the next downstream stamp, so resolved_by enters the chain.
        try {
          if (r.gate && fs.existsSync(r.gate)) {
            const g = JSON.parse(fs.readFileSync(r.gate, "utf8"));
            g.resolved_by = { authority, grant_class: latest.class, ruling: latest.decision, ts: nowIso() };
            fs.writeFileSync(r.gate, JSON.stringify(g, null, 2) + "\n");
          }
        } catch { /* run-log retains the record */ }
        applyTransition(appliedTransition);
        continue;
      }

      // Non-auto-fixable fix-and-retry classes (state-corruption /
      // external-blocked) halt for a human.
      if (r.action === "fix-and-retry") {
        applyTransition(nonCodeFixTransition({ action: r, base }));
        break;
      }

      if (r.action === "run-stage" || r.action === "continue-stage") {
        const guardTransition = dispatchGuardTransition({
          action: r,
          base,
          consequenceCeiling: CONSEQUENCE_CEILING,
          allowStages,
          order,
          untilIndex,
          until: opts.until,
          budgetUsd,
          spent: budgetUsd == null ? 0 : totalCostUsd(cwd, changeId),
        });
        if (guardTransition) {
          applyTransition(guardTransition);
          break;
        }

        // Check-point 2 (Phase 1 § 1.1): re-run the stoplist immediately before
        // dispatching build (stage-04) because the requirements agent may have
        // written pipeline/brief.md after run-start; the start-of-run check would
        // have seen no brief yet.  Exactly two check-points: start + pre-build.
        if (r.stage === "stage-04" && runStoplistCheck("pre-build")) break;

        // ADR-009 Phase 2: before dispatching build (stage-04) in repair mode,
        // check whether the diagnosis gate has now landed (stage-01 just PASSed
        // after escalation approval) and propagate its affected_files.
        // This is also the point where repairPatchItems upgrades from the raw
        // symptom string to a structured per-file list from the diagnosis.
        if (intent === "repair" && !repairAtRaw && !state.affectedFiles) {
          const diagGatePath = path.join(gatesDir(cwd, changeId), "stage-01.json");
          try {
            if (fs.existsSync(diagGatePath)) {
              const diagGate = JSON.parse(fs.readFileSync(diagGatePath, "utf8"));
              if (
                diagGate.status === "PASS" &&
                Array.isArray(diagGate.affected_files) &&
                diagGate.affected_files.length > 0
              ) {
                state.affectedFiles = diagGate.affected_files;
                // Upgrade patchItems to structured per-file entries from the diagnosis.
                repairPatchItems = diagGate.affected_files.map(
                  (f) => `Fix ${f}: ${diagGate.proposed_fix || opts.repair}`,
                );
                saveRunState(cwd, changeId, state);
                logEvent(cwd, changeId, {
                  outcome: "diagnosis-activated",
                  affected_files: state.affectedFiles,
                });
              }
            }
          } catch { /* best-effort — diagnosis gate may not exist yet */ }
        }

        const t0 = Date.now();
        logEvent(cwd, changeId, {
          ...base,
          outcome: "dispatch-started",
          queue_ms: 0,
        });
        onEvent({ type: "dispatch", ...base });
        // ADR-007 Tier 1: start the observe-only stall probe fire-and-forget.
        // The probe emits stall-detected if the workstream log and gate are both
        // flat for stallThresholdMs. It NEVER kills or alters the dispatch — the
        // await below is always the sole resolution path (no Promise.race).
        const cancelStallProbe = _stallProbe(r.name, r.stage, cwd, changeId, t0, {
          stallThresholdMs,
          stallMinGrowthBytes,
          logEvent: (entry) => logEvent(cwd, changeId, entry),
          onEvent,
          iteration: state.iterations,
          action: r.action,
          sleep: _sleep,
        });
        let runResult;
        const targetedFix = state.targetedFix
          && state.targetedFix.stage === r.stage
          && state.targetedFix.name === r.name
          ? state.targetedFix
          : null;
        const targetedFixSnapshot = targetedFix
          ? hashTargetedFixFiles(cwd, targetedFix.files)
          : null;
        const onWorkstreamEvent = (event) => {
          const key = event.workstream_id || `${event.stage || r.stage}.${event.role || "unknown"}`;
          const normalized = {
            ...base,
            ...event,
            gate_path: relPath(cwd, event.gate_path),
            log_path: relPath(cwd, event.log_path),
          };
          if (event.type === "workstream-started") {
            state.active_workstreams[key] = {
              stage: event.stage || r.stage,
              name: event.name || r.name,
              role: event.role || null,
              host: event.host || null,
              workstream_id: key,
              gate_path: normalized.gate_path,
              log_path: normalized.log_path,
              prompt_bytes: event.prompt_bytes ?? null,
              context_manifest_files: event.context_manifest_files ?? null,
              context_manifest_omitted: event.context_manifest_omitted ?? null,
              started_at: nowIso(),
            };
          } else if (event.type === "workstream-finished") {
            delete state.active_workstreams[key];
            state.last_workstream = {
              stage: event.stage || r.stage,
              name: event.name || r.name,
              role: event.role || null,
              host: event.host || null,
              workstream_id: key,
              gate_path: normalized.gate_path,
              log_path: normalized.log_path,
              duration_ms: event.duration_ms ?? null,
              prompt_bytes: event.prompt_bytes ?? null,
              context_manifest_files: event.context_manifest_files ?? null,
              context_manifest_omitted: event.context_manifest_omitted ?? null,
              exit_code: event.exit_code ?? null,
              timed_out: Boolean(event.timed_out),
              skipped: Boolean(event.skipped),
              finished_at: nowIso(),
            };
          }
          saveRunState(cwd, changeId, state);
          logEvent(cwd, changeId, {
            ...normalized,
            outcome: event.type,
          });
          onEvent(normalized);
        };
        // §stub-gate: pre-seed a stub gate for stages that frequently exhaust
        // context before reaching the gate write (preSeedGate: true).
        const stageDef = STAGES[r.name];
        if (stageDef && stageDef.preSeedGate && r.stage) {
          writeStubGate(gatesDir(cwd, changeId), r.stage, effectiveTrack);
        }
        try {
          runResult = await _runStageHeadless(r.name, {
            cwd,
            track: effectiveTrack,
            feature: opts.feature || "",
            scope: opts.scope, // Phase-35 item 35.1: --scope <path> (repeatable), review-only track
            // Phase-36 item 36.3: opts.processCwd/opts.externalReviewMode thread
            // through the same way opts.scope does — a review workspace run sets
            // cwd to the workspace and processCwd to the subject being reviewed.
            processCwd: opts.processCwd,
            externalReviewMode: opts.externalReviewMode === true,
            intent,   // ADR-009 §Decision.7: propagate so adapters render repair prompts
            timeoutMs,
            skipCompleted: r.action === "continue-stage",
            runId: state.started_at, // 28.5: correlates run-corpus dispatch records to this run
            // 32.3: this stage has at least one prior fix-and-retry attempt —
            // lets the orchestrator's routing.escalate_on_retry bump a pinned
            // model one tier for this (re-)dispatch.
            isRetry: (state.fixRetries[r.name] || 0) > 0,
            // ADR-009 §Decision.2: repair builds run in PATCH MODE (renderPatchBlock).
            // After 10.2 diagnosis, repairPatchItems holds structured per-file items.
            ...(targetedFix ? { workstream: [targetedFix.workstream] } : {}),
            ...(repairPatchItems
              ? { patchItems: repairPatchItems }
              : targetedFix ? { patchItems: targetedFix.patchItems } : {}),
            onWorkstreamEvent,
          });
        } finally {
          // Dispatch settled — cancel the probe so it never fires a stale event.
          cancelStallProbe();
        }
        if (targetedFix) {
          state.targetedFix = null;
          saveRunState(cwd, changeId, state);
          logEvent(cwd, changeId, {
            ...base,
            outcome: "targeted-fix-dispatch",
            workstream: targetedFix.workstream,
            patch_items: targetedFix.patchItems.length,
            source_stage: targetedFix.source_stage,
          });
        }
        const dispatch = normalizeDispatchResults(runResult);
        const { results, timedOut: anyTimedOut, wroteGate, stubGate: anyStubGate, exitCode, queueWaitMs } = dispatch;
        const durationMs = Date.now() - t0;
        for (const result of results) {
          const observation = dispatchObservation(base, result);
          if (observation) logEvent(cwd, changeId, observation);
        }
        state.retries[r.name] = (state.retries[r.name] || 0) + 1;
        // Phase 12.2: track stage IDs in state for `devteam commit` cursor.
        if (r.stage && !state.stages_advanced.includes(r.stage)) state.stages_advanced.push(r.stage);
        saveRunState(cwd, changeId, state);
        if (!summary.stages_advanced.includes(r.name)) summary.stages_advanced.push(r.name);
        logEvent(cwd, changeId, {
          ...base, outcome: "dispatched",
          duration_ms: durationMs, workstreams: results.length,
          timed_out: anyTimedOut, no_gate: !wroteGate,
          queue_ms: queueWaitMs,
        });
        onEvent({ type: "dispatched", ...base, duration_ms: durationMs, timed_out: anyTimedOut, queue_ms: queueWaitMs });

        // Dispatch-time classification (PR-B) — replaces PR-A's no-progress
        // guard. A dispatch that wrote no gate is transient (backoff + retry)
        // until the transient budget is spent, then structural (halt).
        const retryPlan = transientDelayPlan({
          retryDelayMs,
          timedOut: anyTimedOut,
          stubGate: anyStubGate,
          exitCode,
        });
        const outcomeTransition = dispatchOutcomeTransition({
          action: r,
          base,
          transient: state.transient,
          maxTransientRetries,
          retryDelayMs: retryPlan.delayMs,
          retryReason: retryPlan.retryReason,
          backoffClass: retryPlan.backoffClass,
          wroteGate,
          exitCode,
          timedOut: anyTimedOut,
          stubGate: anyStubGate,
        });
        applyTransition(outcomeTransition);
        saveRunState(cwd, changeId, state);
        if (outcomeTransition.details.dispatchClass === "ok") {

          if (
            targetedFix
            && targetedFixSnapshot
            && targetedFixChanged(cwd, targetedFixSnapshot) === false
          ) {
            const evidence = targetedFixNoSourceChangeEvidence(targetedFixSnapshot);
            applyTransition(targetedFixNoChangeTransition({
              action: r,
              base,
              evidence,
              workstream: targetedFix.workstream,
            }));
            _writeConvergenceEscalate(r.stage, r.name, summary.halt_reason);
            break;
          }

          // ADR-009 §Decision.3: structural scope gate. FAILs a build that
          // touches files outside the diagnosed affected-files set. In 10.1 the
          // gate is inert (opts.affectedFiles is absent — no diagnosis yet);
          // 10.2 activates it by supplying the diagnosed affected-files list.
          // Peer-review criteria gain "could this be smaller?" as a judgment on
          // top of this mechanical boundary.
          const affectedFiles = opts.affectedFiles || state.affectedFiles || null;
          if (r.stage === "stage-04" && affectedFiles) {
            const outOfScope = _checkScopeGate(cwd, affectedFiles);
            const scopeTransition = scopeGateTransition({ base, outOfScope });
            if (scopeTransition) {
              applyTransition(scopeTransition);
              break;
            }
          }

          continue;
        }
        if (outcomeTransition.details.retry) {
          // §stub-gate: delete the stub so next() doesn't treat it as a completed
          // stage gate on the retry loop. The pre-seed runs again before re-dispatch.
          if (outcomeTransition.details.removeStubGate && r.stage) {
            try { fs.unlinkSync(path.join(gatesDir(cwd, changeId), `${r.stage}.json`)); } catch { /* already gone */ }
          }
          await _sleep(outcomeTransition.details.delayMs);
          continue;
        }
        break;
      }

      if (r.action === "merge") {
        onEvent({ type: "merge", ...base });
        logEvent(cwd, changeId, { ...base, outcome: "merge-started" });
        const mergeStart = Date.now();
        const m = _merge(r.name, { cwd, track: effectiveTrack, changeId });
        // 31.1: workspace-global orchestrator stamping, once, on the merged
        // gate (for stage-04, stampWorkstream in core/orchestrator.js already
        // stamped each role's own gate as it completed; stage-05's 31.5
        // approval re-derivation below has no per-role counterpart — it only
        // runs here, on the merged gate). Best-effort — a stamping failure
        // must never fail the merge; m.gate is refreshed so mergeTransition
        // below sees the post-stamp status, not the model's pre-stamp claim.
        if (m.merged) {
          try {
            const { STAMPABLE_MERGE_STAGES, stampMerged } = require("./verify/stamp");
            if (STAMPABLE_MERGE_STAGES.has(r.stage)) {
              const stampResult = await stampMerged(cwd, r.stage, m.file);
              if (stampResult.ok) {
                m.gate = stampResult.gate;
              } else {
                process.stderr.write(`[devteam] orchestrator merged-stamp: ${stampResult.error}\n`);
              }
            }
          } catch (err) {
            process.stderr.write(`[devteam] orchestrator merged-stamp failed: ${err.message}\n`);
          }
          // Phase-33 item 33.1: capture a replayable eval case for the
          // merged gate — the stage's true final status for multi-role
          // stages (single-role stages are captured in
          // core/orchestrator.js's runStageHeadless instead; see its
          // comment). Fire-and-forget — see core/evals/capture.js.
          try {
            require("./evals/capture").captureEvalCase(cwd, {
              config,
              gatePath: m.file,
              stage: r.stage,
              track: effectiveTrack,
              runId: state.started_at,
              readFirst: STAGES[r.name] && STAGES[r.name].readFirst,
            });
          } catch (err) {
            process.stderr.write(`[devteam] evals: merged-gate capture failed: ${err.message}\n`);
          }
        }
        const mergeDurationMs = Date.now() - mergeStart;
        logEvent(cwd, changeId, {
          ...base,
          outcome: "merge-finished",
          duration_ms: mergeDurationMs,
          merged: Boolean(m.merged),
          reason: m.reason || null,
        });
        const result = mergeTransition({ base, mergeResult: m });
        applyTransition(result);
        if (result.control === TRANSITION_CONTROLS.HALT) {
          break;
        }
        continue;
      }

      // Unknown action — halt defensively rather than spin.
      applyTransitionResult(transitionResult(TRANSITION_CONTROLS.HALT, {
        summaryPatch: {
          halted: true,
          halt_action: r.action,
          halt_reason: `unhandled action "${r.action}"`,
        },
        logEvents: [{ ...base, outcome: "unhandled" }],
        emittedEvents: [{ type: "unhandled", ...base }],
      }), {
        summary,
        state,
        logEvent: (entry) => logEvent(cwd, changeId, entry),
        onEvent,
      });
      break;
    }
    } // if (!trackHalted)
    } // else (not stoplist-halted)

    if (!summary.completed && !summary.halted) {
      summary.halted = true;
      summary.halt_action = "max-iterations";
      summary.halt_reason = `reached max iterations (${maxIterations})`;
      logEvent(cwd, changeId, { iteration: state.iterations, outcome: "max-iterations-halt" });
    }
  } finally {
    summary.iterations = state.iterations || 0;
    // Phase-28 item 28.4: cost_basis is recorded once per run, here, onto both
    // the returned summary and run-state.json — "observed" / "model-asserted" /
    // "mixed" / null (no cost data at all). The pre-dispatch --budget-usd check
    // (dispatchGuardTransition above) and halt semantics are unchanged; only the
    // cost figure they compare against now prefers observed cost (costUsdDetail).
    const finalCost = costUsdDetail(cwd, changeId);
    summary.cost_usd = finalCost.total;
    summary.cost_basis = finalCost.basis;
    state.cost_usd = finalCost.total;
    state.cost_basis = finalCost.basis;
    if (!assertedCostWarned && (finalCost.basis === "model-asserted" || finalCost.basis === "mixed")) {
      assertedCostWarned = true;
      const msg = `cost total includes model-asserted (self-reported) cost_usd, not just orchestrator-observed usage (cost_basis: "${finalCost.basis}")`;
      logEvent(cwd, changeId, { outcome: "cost-basis-warning", cost_basis: finalCost.basis, message: msg });
      process.stderr.write(`[devteam run] note: ${msg}\n`);
    }
    saveRunState(cwd, changeId, state);
    releaseLock(cwd, changeId);
  }

  // Phase 30 item 30.1: fire-and-forget pattern auto-collection at run end —
  // closes the loop that previously required a manual `devteam patterns
  // collect`. Runs on a clean completion, and on any halt where this run's
  // gates directory holds at least one gate (a halt before any stage ever
  // wrote a gate, e.g. --repair/--feature mutual exclusion or a pre-flight
  // stoplist match, has nothing to collect). Never affects summary or exit
  // code — a collection failure is logged, not thrown.
  const gateOnDisk = (() => {
    try {
      return fs.readdirSync(gatesDir(cwd, changeId))
        .some((name) => name.endsWith(".json") && !name.includes(".attempt-"));
    } catch {
      return false;
    }
  })();
  if (summary.completed || (summary.halted && gateOnDisk)) {
    try {
      _collectPatterns({ cwd, pipelineRoot: pipelineRoot(cwd, changeId) });
    } catch (err) {
      logEvent(cwd, changeId, { outcome: "pattern-collect-failed", error: String((err && err.message) || err) });
    }
  }

  // Phase 30 item 30.3: opt-in run-end Reflector dispatch. Only on a clean
  // completion (not on halts — a halted run's evidence is incomplete) and
  // only when learning.reflector: true. Fire-and-forget like auto-collection
  // above: runReflector() already never throws (see core/learning/reflector.js),
  // but the try/catch here is defense in depth so a future defect there still
  // can't take down the run summary.
  if (summary.completed && config.learning.reflector === true) {
    try {
      await _runReflector({
        cwd,
        changeId,
        pipelineRoot: pipelineRoot(cwd, changeId),
        config,
        logEvent: (entry) => logEvent(cwd, changeId, entry),
      });
    } catch (err) {
      logEvent(cwd, changeId, { outcome: "reflector-dispatch-failed", reason: String((err && err.message) || err) });
    }
  }

  // Phase 30 item 30.4: auto-ingest at pipeline-complete — the write side of
  // the closed loop (30.4's read side is memory retrieval into stage prompts,
  // core/orchestrator.js resolvePriorKnowledgeOpts()). docs/memory.md already
  // named "end of pipeline" as a designed ingest trigger point; this wires it
  // up instead of requiring a manual `devteam memory ingest`. Gated on
  // .devteam/memory/ already existing — same "opted in once, stays wired up"
  // condition as the read side — so a project that has never run `devteam
  // memory ingest` sees zero behavior change (no embedder load, no model
  // download attempt) and reuses memory.inject as the single off switch for
  // both sides of the loop. Fire-and-forget like auto-collection and the
  // reflector above: an ingest failure (including the optional
  // @huggingface/transformers dependency being absent) is logged, never
  // thrown — it must never fail an otherwise-clean run.
  if (summary.completed && config.memory.inject !== false && fs.existsSync(path.join(cwd, ".devteam", "memory"))) {
    try {
      const result = await _ingestMemory({ cwd });
      logEvent(cwd, changeId, { outcome: "memory-ingest", artifacts: result.artifacts, chunks: result.chunks });
    } catch (err) {
      logEvent(cwd, changeId, { outcome: "memory-ingest-failed", error: String((err && err.message) || err) });
    }
  }

  // Phase-33 item 33.1: resolution-linker pass at run end. Runs whenever this
  // run wrote at least one gate (same condition as pattern auto-collection
  // above) regardless of completed/halted — a fix-retry can clear a
  // previously-captured eval case within the same run that later halts on
  // something unrelated. Fire-and-forget: never affects summary or exit code.
  if (gateOnDisk && config.evals.capture !== false) {
    try {
      const { linkResolutions } = require("./evals/capture");
      const result = linkResolutions(cwd, { changeId });
      if (result.linked > 0) logEvent(cwd, changeId, { outcome: "evals-resolution-linked", linked: result.linked });
    } catch (err) {
      logEvent(cwd, changeId, { outcome: "evals-resolution-link-failed", error: String((err && err.message) || err) });
    }
  }

  return summary;
}

module.exports = { run, CONSEQUENCE_CEILING, DEFAULT_MAX_ITERATIONS, totalCostUsd, costUsdDetail, runStatePath, runLogPath, seedDeployContext, blockerFiles };
