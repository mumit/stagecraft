// Orchestrator core.
//
// Public entry points:
//   - runStage(stageName, opts): decompose stage into per-role workstreams,
//     resolve adapter per role, render prompt for each, return result.
//   - mergeWorkstreamGates(stageName, opts): read per-workstream gate files
//     and write the merged stage gate.
//
// No model is ever invoked here. Hosts (adapters) do that; the orchestrator
// only shells the work and validates outputs against schemas.

const fs = require("node:fs");
const path = require("node:path");
const crypto = require("node:crypto");
const { spawnSync } = require("node:child_process");
const { STAGES, getStage, orderedStageNamesForTrack, isStageInTrack, rolesForStage, trackLabel, isAdversarialReviewMode, isFrameworkReadFirstPath } = require("./pipeline/stages");
const { resolveFrameworkPath } = require("./adapters/render-helpers");
const { loadConfig, changeIdFromFeature, escalateModel } = require("./config");
const { gatesDir: getGatesDir, logsDir: getLogsDir, pipelineRoot, prefixPipelineRelative } = require("./paths");
const { resolveAdapter } = require("./router");
const { withSpan, setSpanAttributes } = require("./observability");
const { loadGateSafe } = require("./gates/load-gate");
const { classifyGate, MAX_RETRIES_DEFAULT } = require("./gates/classify");
const { pricingFor } = require("./pricing");
const { getRecipe } = require("./pipeline/fix-recipes");
const { deterministicSkipForStage } = require("./pipeline/right-sizing");
const { collectChangedFileManifest } = require("./context-manifest");
const { computeContextDelta } = require("./context-delta");
const { detectNoProgress, countArchivedAttempts, noProgressEvidence } = require("./gates/convergence");
const { archiveGateIfFail, pruneArchives } = require("./gates/archive");
const { isAllowed } = require("./guards/write-audit");
const { hostConcurrencyLimit, mapByHostConcurrency } = require("./scheduler");
const { WorkstreamIsolation, shouldIsolateBuildWorkstreams } = require("./workstream-isolation");
const { normalizeExecutionConfig, resolveTrustProfile } = require("./containment");
const corpus = require("./corpus");
const evalsCapture = require("./evals/capture");
const { computePromptPackVersion } = require("./prompt-pack");

// C1: patch a gate file to record write-audit violations and flip status to FAIL.
// Called after headless invoke when the adapter reported unauthorized writes.
// Idempotent — safe to call multiple times (violations are deduplicated by string match).
function patchGateForWriteViolations(gatePath, violations) {
  if (!fs.existsSync(gatePath)) return;
  try {
    const gate = JSON.parse(fs.readFileSync(gatePath, "utf8"));
    const msgs = violations.map((v) => `[write-audit] unauthorized write: ${v}`);
    const existing = new Set(Array.isArray(gate.blockers) ? gate.blockers : []);
    for (const m of msgs) existing.add(m);
    gate.blockers = [...existing];
    if (gate.status === "PASS" || gate.status === "WARN") gate.status = "FAIL";
    fs.writeFileSync(gatePath, JSON.stringify(gate, null, 2) + "\n", "utf8");
    process.stderr.write(
      `[devteam] write-audit: ${violations.length} violation(s) added to gate — status flipped to FAIL\n`,
    );
  } catch {
    // Gate unreadable; violations already logged by headless.js
  }
}

function patchGateForIsolationFindings(gatePath, { violations = [], conflicts = [] } = {}) {
  if (!fs.existsSync(gatePath)) return;
  try {
    const gate = JSON.parse(fs.readFileSync(gatePath, "utf8"));
    const messages = [
      ...violations.map((p) => `[workstream-isolation] unauthorized write refused: ${p}`),
      ...conflicts.map((p) => `[workstream-isolation] reconciliation conflict: ${p}`),
    ];
    const existing = new Set(Array.isArray(gate.blockers) ? gate.blockers : []);
    for (const message of messages) existing.add(message);
    gate.blockers = [...existing];
    if (messages.length > 0 && (gate.status === "PASS" || gate.status === "WARN")) gate.status = "FAIL";
    fs.writeFileSync(gatePath, JSON.stringify(gate, null, 2) + "\n", "utf8");
  } catch { /* malformed gates are handled by the normal validator */ }
}

const PROJECT_ROOT = path.resolve(__dirname, "..");
const ORCHESTRATOR_ID = `devteam@${require("../package.json").version}`;

// Produce the workstream identifier for a (stage, role) dispatch.
// Single-role stages get the bare stage id ("stage-01"); multi-role stages
// get a dotted form ("stage-04.backend"). The role count is what the caller
// observed at decomposition time — pass stageDef.roles.length.
function workstreamId(stage, role, roleCount) {
  return roleCount > 1 ? `${stage}.${role}` : stage;
}

// C5: throw early if the resolved host lacks a capability the stage requires.
// stageDef.requiredCapabilities is a { capName: true } map; adapter.capabilities.enforces
// must have capName: true for each entry. Checked on every dispatch — headless or not —
// so misconfigured routing fails at plan time, not silently at runtime.
function assertCapabilities(stageDef, role, hostName, adapter) {
  const required = stageDef.requiredCapabilities;
  if (!required) return;
  const enforces = adapter.capabilities?.enforces || {};
  for (const [cap, needed] of Object.entries(required)) {
    if (needed && enforces[cap] !== true) {
      throw new Error(
        `stage "${stageDef.stage}" (role "${role}") requires the "${cap}" capability ` +
        `but host "${hostName}" does not provide it (enforces.${cap} !== true). ` +
        `Update routing in .devteam/config.yml to use a host with ${cap} support ` +
        `(claude-code, codex, gemini-cli, omnigent, or openai-compat).`,
      );
    }
  }
}

// G10: warn (not throw) when a budget-carrying role is dispatched to a host
// that can only enforce via prompt, not at the tool-call boundary. Unlike
// shell/network (hard blocks — the stage can't run without them), a
// prompt-only budget is a degraded but valid configuration: the model sees
// the restriction and may comply; violations are advisory. Operators who
// route to codex/gemini-cli knowingly accept the tradeoff.
function warnIfToolBudgetDegraded(toolBudget, role, hostName, adapter) {
  if (!toolBudget || toolBudget.length === 0) return;
  const level = adapter.capabilities?.enforces?.tool_budget;
  if (level && level !== "native") {
    process.stderr.write(
      `[devteam] note: role "${role}" has a declared tool budget [${toolBudget.join(", ")}] ` +
      `but host "${hostName}" enforces it as ${level} (not at the tool-call boundary). ` +
      `The model will be instructed to stay within the budget; violations cannot be prevented. ` +
      `Route to claude-code for native tool-call enforcement.\n`,
    );
  }
}

// G10: patch a gate file to add dispatched_tool_budget. Called in the
// headless path after invoke() writes the gate — gives the audit trail an
// orchestrator-stamped (not model-written) record of what tools were declared.
function patchGateForToolBudget(gatePath, toolBudget) {
  if (!fs.existsSync(gatePath)) return;
  const { gate, error } = loadGateSafe(gatePath);
  if (error || !gate) return;
  if ("dispatched_tool_budget" in gate) return; // already stamped; don't overwrite
  const patched = { ...gate, dispatched_tool_budget: toolBudget };
  fs.writeFileSync(gatePath, JSON.stringify(patched, null, 2) + "\n", "utf8");
}

// Phase-28 item 28.1 (generalized in 28.2): patch a gate file with
// orchestrator-observed usage telemetry from a headless invoke() result
// (r.usage — see core/adapters/headless.js / core/adapters/claude-stream-json.js
// for claude-code, hosts/openai-compat/invoke.js for openai-compat). Mirrors
// core/verify/stamp.js's `_orchestrator_stamped` pattern: this never touches
// the model-asserted tokens_in/tokens_out/cost_usd/model top-level fields
// (self-reported, still gate-schema-legal) — it adds a distinct
// `_orchestrator_observed` block so downstream consumers can prefer the
// observed side without losing the model's claim. `usage.source` identifies
// which adapter produced the observation (e.g. "claude-code:stream-json",
// "openai-compat:usage"); defaults to the pre-28.2 claude-code value for
// callers that don't set it.
function patchGateForObservedUsage(gatePath, usage) {
  if (!fs.existsSync(gatePath)) return;
  const { gate, error } = loadGateSafe(gatePath);
  if (error || !gate) return;
  const patched = {
    ...gate,
    _orchestrator_observed: {
      tokens_in: usage.tokensIn,
      tokens_out: usage.tokensOut,
      ...(typeof usage.cachedTokens === "number" ? { cached_tokens: usage.cachedTokens } : {}),
      cost_usd: usage.costUsd,
      model_observed: usage.model,
      source: usage.source || "claude-code:stream-json",
      at: new Date().toISOString(),
    },
  };
  fs.writeFileSync(gatePath, JSON.stringify(patched, null, 2) + "\n", "utf8");
}

// Phase-32 item 32.3: record the model the routing config resolved for this
// dispatch BEFORE it ran (ws.model) — orchestrator truth, independent of
// whether the dispatch ever reports usage. Distinct from the model-asserted
// top-level `model` field and from `_orchestrator_observed.model_observed`
// (what the host actually reported serving) — same "add a distinct
// orchestrator-owned field, never touch the model-asserted one" discipline
// as patchGateForObservedUsage above. `escalation` (from routing.tiers via
// escalateModel(), non-null only when routing.escalate_on_retry bumped this
// dispatch) additionally records tier-bump provenance. Fire-and-forget: a
// write failure here must never fail the run.
function patchGateWithRequestedModel(gatePath, model, escalation) {
  if (!fs.existsSync(gatePath)) return;
  const { gate, error } = loadGateSafe(gatePath);
  if (error || !gate) return;
  const patched = {
    ...gate,
    model_requested: model,
    ...(escalation ? {
      _orchestrator_escalated: {
        from_model: escalation.from,
        to_model: escalation.to,
        reason: "escalate_on_retry",
        at: new Date().toISOString(),
      },
    } : {}),
  };
  try {
    fs.writeFileSync(gatePath, JSON.stringify(patched, null, 2) + "\n", "utf8");
  } catch { /* fire-and-forget: telemetry writes must never fail the run */ }
}

// Phase-28 item 28.3: for hosts whose capabilities declare
// `telemetry !== "native"` (gemini-cli, generic, omnigent today — no CLI
// usage output parsed, or none exists), record a promptBytes/4 estimate
// instead of leaving the gate with no token signal at all. `tokens_in_estimate`
// is a distinctly-named field (never `tokens_in`) and `tokens_estimated: true`
// is mandatory on it, so a downstream consumer that forgets to check the flag
// gets a KeyError-shaped surprise rather than silently averaging a guess in
// with ground truth. Only applied when no observed usage was already written
// for this dispatch (see call site in runStageHeadless).
function patchGateForEstimatedUsage(gatePath, promptBytes) {
  if (!fs.existsSync(gatePath)) return;
  const { gate, error } = loadGateSafe(gatePath);
  if (error || !gate) return;
  const patched = {
    ...gate,
    _orchestrator_observed: {
      tokens_estimated: true,
      tokens_in_estimate: Math.round(promptBytes / 4),
      source: "orchestrator:prompt-bytes-estimate",
      at: new Date().toISOString(),
    },
  };
  fs.writeFileSync(gatePath, JSON.stringify(patched, null, 2) + "\n", "utf8");
}

// Phase-33 item 33.3: patch a gate file with prompt_pack_version — a
// content hash of the prompt surface (core/prompt-pack.js), never something
// the model could self-report. Mirrors patchGateWithRequestedModel's "add a
// distinct orchestrator-owned field" discipline and dispatched_tool_budget's
// dual-path convention (patchGateForToolBudget here; auto-injected by the
// gate validator for user-driven runs — core/gates/validator.js
// autoInjectMetadata). Idempotent: never overwrites a value already present.
function patchGateWithPromptPackVersion(gatePath) {
  if (!fs.existsSync(gatePath)) return;
  const { gate, error } = loadGateSafe(gatePath);
  if (error || !gate) return;
  if ("prompt_pack_version" in gate) return; // already stamped; don't overwrite
  const patched = { ...gate, prompt_pack_version: computePromptPackVersion() };
  try {
    fs.writeFileSync(gatePath, JSON.stringify(patched, null, 2) + "\n", "utf8");
  } catch { /* fire-and-forget: telemetry writes must never fail the run */ }
}

// D7: patch a single-role gate to surface the same unpriced-model WARN that
// mergeWorkstreamGates emits for multi-role stages. Idempotent.
function patchGateForUnpricedModel(gatePath) {
  if (!fs.existsSync(gatePath)) return;
  const { gate, error } = loadGateSafe(gatePath);
  if (error || !gate) return;
  if (typeof gate.tokens_in !== "number" || typeof gate.model !== "string") return;
  if (pricingFor(gate.model)) return;
  const msg = `unpriced model ${gate.model} — budget enforcement incomplete`;
  const existing = Array.isArray(gate.warnings) ? gate.warnings : [];
  if (existing.includes(msg)) return;
  const patched = { ...gate, warnings: [...existing, msg] };
  fs.writeFileSync(gatePath, JSON.stringify(patched, null, 2) + "\n", "utf8");
  process.stderr.write(`[devteam] D7: unpriced model "${gate.model}" — budget enforcement incomplete\n`);
}

// Compute the full dispatch plan for a stage: which (role, host) pairs
// the orchestrator should invoke, with their workstream ids and gate
// filenames. Normally there's one entry per role; for peer-review with
// routing.review_fanout set, each role expands to N entries (one per
// fanout host), giving N×M total entries.
//
// Returns: [ { role, hostName, workstreamId, gateFile } ]
//
// hostName is null when fanout is active and the caller should resolve
// it from the entry's hostName field directly (no routing precedence).
// For non-fanout, the caller resolves via routing as usual.
//
// opts.gatesDir — when provided, the stage-01 gate is read to filter roles
// via active_roles (explicit) or inferred from out_of_scope_items (fallback).
// The filter applies to all stages, including peer-review (stage-05), so
// excluded workstreams never get phantom reviewer areas.

// Keywords that signal a workstream area is out of scope. Matched
// case-insensitively against out_of_scope_items[] strings.
const OOS_KEYWORDS = {
  frontend: ["frontend", "web ui", "web app", "browser", "ui layer"],
  backend:  ["backend", "api server", "rest api", "server-side"],
  platform: ["platform", "infrastructure", "infra"],
  qa:       ["qa workstream", "test workstream"],
};

// fileOwnership is stage-02 (design)'s file_ownership map, when available —
// see the why-comment below on where it overrides the out_of_scope_items
// inference.
function inferActiveRoles(stage01Gate, allRoles, alwaysDispatch, fileOwnership) {
  // active_roles lists only workstream slots (backend, frontend, qa, platform).
  // Non-workstream roles like "pm" and "principal" never appear in active_roles
  // and must always be passed through — never filter them out.
  const WORKSTREAM_SLOTS = new Set(Object.keys(OOS_KEYWORDS));
  // Roles in alwaysDispatch (set per stage in stages.js) are structural: they
  // write pipeline/ artifacts that every deploy needs regardless of which code
  // workstreams were active. Treat them like non-workstream roles — never filter.
  const pinned = new Set(Array.isArray(alwaysDispatch) ? alwaysDispatch : []);

  // Explicit active_roles takes precedence — PM's deliberate decision.
  if (Array.isArray(stage01Gate.active_roles) && stage01Gate.active_roles.length > 0) {
    const activeSet = new Set(stage01Gate.active_roles);
    // Keep a role if it is not a workstream slot (always active), if it
    // appears in active_roles (explicitly active workstream), or if it is
    // pinned via alwaysDispatch (structural role whose artifact is always needed).
    const filtered = allRoles.filter(r => !WORKSTREAM_SLOTS.has(r) || activeSet.has(r) || pinned.has(r));
    // Return the filtered list only when something was removed AND at least one
    // role remains. An empty result (all workstream roles absent from active_roles)
    // would produce a zero-workstream plan that completes in 0ms and loops. A
    // result identical to allRoles (nothing removed) is a no-op. Both → null.
    return (filtered.length < allRoles.length && filtered.length > 0) ? filtered : null;
  }
  // Inference fallback: keyword-match out_of_scope_items.
  if (!Array.isArray(stage01Gate.out_of_scope_items) || stage01Gate.out_of_scope_items.length === 0) {
    return null; // no filter
  }
  const suppressed = new Set();
  for (const item of stage01Gate.out_of_scope_items) {
    const lower = item.toLowerCase();
    for (const [role, keywords] of Object.entries(OOS_KEYWORDS)) {
      if (keywords.some(k => lower.includes(k))) suppressed.add(role);
    }
  }
  // Design (stage-02) is a later, more specific refinement of the initial
  // brief — if it explicitly assigns owned files to a role, that role is
  // unambiguously active regardless of how the earlier requirements-stage
  // out_of_scope_items happens to be worded. A real build silently dropped
  // both `frontend` (owns src/frontend/**) and `platform` (owns
  // pyproject.toml, README.md) from every build dispatch — including both
  // retries — because stage-01 said "Frontend framework, build pipeline, or
  // client-side routing" (scoping OUT heavy tooling, not frontend work
  // entirely) and "... cloud infrastructure" (scoping out deployment infra,
  // not basic scaffolding), and the keyword match above can't distinguish
  // "no X framework" from "no X at all." QA then correctly failed on files
  // that could never get built, and every retry re-ran the same wrong role
  // set forever, burning the retry budget on a fix that could never land.
  // This override only applies to the weaker keyword-inference path, never
  // to explicit active_roles above — a PM decision that conflicts with
  // design's file_ownership is a real conflict, not something to silently
  // paper over.
  if (fileOwnership && typeof fileOwnership === "object") {
    for (const owner of Object.values(fileOwnership)) {
      suppressed.delete(owner);
    }
  }
  return suppressed.size === 0 ? null : allRoles.filter(r => !suppressed.has(r));
}

// stage-02 (design)'s file_ownership map, when a merged design gate exists —
// see inferActiveRoles' why-comment for how this overrides an over-eager
// out_of_scope_items inference. Returns null when absent, unreadable, or
// not an object, so every call site can pass the result straight through.
function loadFileOwnership(gatesDir) {
  try {
    const p = path.join(gatesDir, "stage-02.json");
    if (!fs.existsSync(p)) return null;
    const { gate } = loadGateSafe(p);
    return (gate && gate.file_ownership && typeof gate.file_ownership === "object") ? gate.file_ownership : null;
  } catch {
    return null;
  }
}

function computeDispatchPlan(stageDef, config, track, opts = {}) {
  const fanout = (config && config.routing && Array.isArray(config.routing.review_fanout))
    ? config.routing.review_fanout
    : [];
  // 31.3: review_fanout (multi-host copies of the SAME area matrix) and
  // adversarial mode (reviewer + critic, cross-host by routing rules instead)
  // are two different diversity mechanisms — combining them isn't designed
  // or tested, so adversarial mode always wins and fanout is ignored.
  const isPeerReview = stageDef.stage === "stage-05" && fanout.length > 0 && !isAdversarialReviewMode(config);
  // Track-aware roles. stage-05 (peer-review) varies by track — nano and
  // loop dispatch a single reviewer; every other track uses the standard
  // four-area matrix. stage-04 (build) also varies on loop — a single
  // config-overridable workstream (29.1) instead of the four-role matrix.
  // rolesForStage falls back to stageDef.roles for every other stage.
  const effectiveTrack = track || (config && config.pipeline && config.pipeline.default_track) || "full";
  let roles = rolesForStage(stageDef, effectiveTrack, config);

  // Apply active_roles filter from stage-01 gate when gatesDir is available.
  // The filter covers all stages so peer-review areas match the build workstreams
  // that actually ran — no phantom reviewer areas for excluded workstreams.
  if (opts.gatesDir) {
    const s1Path = path.join(opts.gatesDir, "stage-01.json");
    if (fs.existsSync(s1Path)) {
      const { gate } = loadGateSafe(s1Path);
      if (gate) {
        const filtered = inferActiveRoles(gate, roles, stageDef.alwaysDispatch, loadFileOwnership(opts.gatesDir));
        if (filtered) roles = filtered;
      }
    }
  }

  const plan = [];
  for (const role of roles) {
    if (isPeerReview) {
      for (const hostName of fanout) {
        const ws = `${stageDef.stage}.${role}.${hostName}`;
        plan.push({ role, hostName, workstreamId: ws, gateFile: `${ws}.json`, fanout: true });
      }
    } else {
      const ws = workstreamId(stageDef.stage, role, roles.length);
      plan.push({ role, hostName: null, workstreamId: ws, gateFile: `${ws}.json`, fanout: false });
    }
  }
  return plan;
}

// Phase-35 item 35.1: real existence check for an optional readFirst entry,
// backing buildDescriptor()'s "omit, don't just annotate" contract (see the
// why-comment on stage-04b's readFirst in core/pipeline/stages.js). `relPath`
// is already change-id-prefixed (caller applies prefix() first). A bare "*"
// glob (the only shape readFirst ever uses, e.g. "pipeline/pr-*.md") is
// resolved by listing the parent directory rather than pulling in a glob
// dependency — readFirst entries are never deep/recursive globs.
// No `cwd` (buildDescriptor() called from a preview/test path with no
// filesystem to check against) fails open: assume present, matching every
// pre-35 caller's behavior of always including the entry.
function existsForReadFirst(cwd, relPath) {
  if (!cwd) return true;
  if (!relPath.includes("*")) return fs.existsSync(path.join(cwd, relPath));
  const dir = path.dirname(relPath);
  const pattern = path.basename(relPath);
  const re = new RegExp(`^${pattern.split("*").map((s) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")).join(".*")}$`);
  try {
    return fs.readdirSync(path.join(cwd, dir)).some((f) => re.test(f));
  } catch {
    return false;
  }
}

// Phase-36 item 36.2: resolve one readFirst entry to its final rendered
// string. An entry's root is "subject" (the repo being worked on/reviewed)
// unless it explicitly says `root: "framework"` or its path is one of
// stages.js's well-known framework files (isFrameworkReadFirstPath —
// currently the two .devteam/rules/*.md entries; AGENTS.md is deliberately
// excluded there, see its why-comment). Framework entries get run through
// resolveFrameworkPath(), which only changes anything when `opts.processCwd`
// (the subject, 36.1's codeRoot) differs from `opts.cwd` (the review
// workspace, stateRoot) — every pre-36.3 caller leaves processCwd unset, so
// this is a no-op there and the returned string is byte-identical to today.
function resolveReadFirstItem(item, prefix, opts) {
  const isObj = typeof item === "object" && item !== null;
  const rawPath = isObj ? item.path : item;
  const root = (isObj && item.root) || (isFrameworkReadFirstPath(rawPath) ? "framework" : "subject");
  const prefixed = prefix(rawPath);
  return root === "framework" ? resolveFrameworkPath(prefixed, opts) : prefixed;
}

function buildDescriptor(stageDef, role, opts = {}) {
  // ADR-009 Phase 2: when intent === "repair" and the stage declares a
  // repairOverride, merge override fields on top of the base stage definition.
  // This swaps stage-01's objective/artifact/template/gate to a diagnosis
  // shape — same stage id, same gate path, fix-aware artifact. No new stage.
  const override = (opts.intent === "repair" && stageDef.repairOverride) ? stageDef.repairOverride : null;
  // 29.1: track-keyed override (e.g. stage-01's loop-track brief template).
  // Repair mode takes precedence when both would apply — diagnosis-vs-feature
  // is a more specific override than the track's ceremony-size template swap.
  const trackOverride = (!override && typeof opts.track === "string" && stageDef.trackOverrides)
    ? stageDef.trackOverrides[opts.track]
    : null;
  // 31.3: review.mode-keyed override (e.g. stage-05's adversarial reviewer/
  // critic shape). Same precedence slot as trackOverride — checked only when
  // neither a repair nor a track override already applies.
  const reviewModeOverride = (!override && !trackOverride && opts.reviewMode && stageDef.reviewModeOverrides)
    ? stageDef.reviewModeOverrides[opts.reviewMode]
    : null;
  const effectiveDef = { ...stageDef, ...(override || trackOverride || reviewModeOverride || {}) };

  const wsId = opts.workstreamId || workstreamId(stageDef.stage, role, stageDef.roles.length);
  const changeId = opts.changeId || null;
  const prefix = (p) => prefixPipelineRelative(p, changeId);
  const allowedWrites = effectiveDef.roleWrites?.[role] ?? effectiveDef.allowedWrites;
  const resolvedAllowedWrites = Array.isArray(allowedWrites) ? allowedWrites.map(prefix) : allowedWrites;
  const dispatchedGate = prefix(`pipeline/gates/${wsId}.json`);
  // active_roles and track overrides can collapse a normally multi-role stage
  // to one dispatch. In that case the workstream id becomes the bare stage id
  // (for example stage-04), while the static roleWrites contract still names
  // stage-04.backend.json. The rendered prompt requires the dynamically chosen
  // gate path, so its own write audit must authorize that exact path too.
  if (Array.isArray(resolvedAllowedWrites) && !isAllowed(dispatchedGate, resolvedAllowedWrites)) {
    resolvedAllowedWrites.push(dispatchedGate);
  }
  return {
    stage: stageDef.stage,
    name: nameForStage(stageDef.stage),
    role,
    rolesInStage: stageDef.roles,
    workstreamId: wsId,
    objective: effectiveDef.objective,
    readFirst: Array.isArray(effectiveDef.readFirst)
      ? effectiveDef.readFirst
          .filter((item) =>
            typeof item !== "object" || !item.optional
              || existsForReadFirst(opts.cwd, prefix(item.path)),
          )
          .map((item) => resolveReadFirstItem(item, prefix, opts))
      : effectiveDef.readFirst,
    allowedWrites: resolvedAllowedWrites,
    artifact: prefix(effectiveDef.artifact),
    template: effectiveDef.template,
    goalCondition: effectiveDef.goalCondition
      ? effectiveDef.goalCondition.replace("{workstreamId}", wsId)
      : null,
    expectedGate: effectiveDef.gate,
    requiredCapabilities: effectiveDef.requiredCapabilities || null,
    changeId,
    // G10: per-role tool budget declared by the adapter (e.g. ["Read","Glob","Grep"]).
    // null means the adapter declared no budget (full host surface applies).
    toolBudget: opts.toolBudget ?? null,
    contextManifest: opts.contextManifest || null,
    // 32.5(b): marker sections added/removed/compacted in pipeline/context.md
    // since this workstream's previous dispatch (core/context-delta.js).
    // null on a workstream's first-ever dispatch — nothing to diff against.
    contextDelta: opts.contextDelta || null,
    knownPatterns: Array.isArray(opts.knownPatterns) ? opts.knownPatterns : [],
    projectFacts: Array.isArray(opts.projectFacts) ? opts.projectFacts : [],
    // 30.4: pre-fetched by runStageHeadless() (embedding is async; this
    // function is not) — see core/memory/inject.js's module header.
    priorKnowledge: Array.isArray(opts.priorKnowledge) ? opts.priorKnowledge : [],
    // When set, all workstreams of this stage dispatch to the same
    // subagent regardless of role (used by peer-review where the
    // workstreams are areas being reviewed but the dispatched agent
    // is always the reviewer). Adapters honor this in renderStagePrompt.
    // Read from effectiveDef (not stageDef) so a reviewModeOverride/
    // trackOverride/repairOverride can clear or change it — e.g. 31.3's
    // adversarial mode sets this to null so "reviewer"/"critic" each
    // dispatch their own-named subagent instead of panel's fixed override.
    subagent: effectiveDef.subagent,
  };
}

function nameForStage(stage) {
  for (const [name, def] of Object.entries(STAGES)) {
    if (def && def.stage === stage) return name;
  }
  return stage;
}

function uniqueStrings(items) {
  return [...new Set((items || []).filter((item) => typeof item === "string" && item.length > 0))];
}

function promptTelemetry(prompt, descriptor) {
  const manifest = descriptor && descriptor.contextManifest;
  const files = manifest && Array.isArray(manifest.files) ? manifest.files : [];
  return {
    promptBytes: Buffer.byteLength(String(prompt || ""), "utf8"),
    contextManifestFiles: files.length,
    contextManifestOmitted: manifest && typeof manifest.omitted_count === "number" ? manifest.omitted_count : 0,
  };
}

function renderOmnigentDirectorPrompt(plan) {
  const lines = [
    "# Omnigent Director Experiment",
    "",
    "You are running an explicit experimental Stagecraft director session.",
    "Coordinate the workstreams listed below, but preserve Stagecraft's normal",
    "contract: every child workstream must write its own gate file exactly where",
    "specified. Do not write a director gate.",
    "",
    `Stage: ${plan.stage} — ${plan.name}`,
    `Track: ${trackLabel(plan.ctx.track)}`,
  ];
  if (plan.ctx.feature) lines.push(`Feature: ${plan.ctx.feature}`);
  lines.push("");
  lines.push("## Required Child Gates");
  lines.push("");
  for (const ws of plan.workstreams) {
    lines.push(`- ${ws.role}: \`pipeline/gates/${ws.descriptor.workstreamId}.json\``);
  }
  lines.push("");
  lines.push("A missing or malformed child gate blocks the stage exactly like normal");
  lines.push("Stagecraft fan-out. Each gate must use the child workstream id and role");
  lines.push("from its workstream prompt. Do not add Omnigent-specific fields to gates.");
  lines.push("");
  lines.push("## Workstream Prompts");
  for (const ws of plan.workstreams) {
    lines.push("");
    lines.push(`### ${ws.role} (${ws.descriptor.workstreamId})`);
    lines.push("");
    lines.push("```markdown");
    lines.push(ws.prompt);
    lines.push("```");
  }
  lines.push("");
  lines.push("## Done When");
  lines.push("");
  lines.push("All required child gates exist, and each referenced artifact requested by");
  lines.push("the child prompt has been written. Exit after the gates are on disk.");
  return lines.join("\n");
}

function directorDescriptorForPlan(plan) {
  const allowedWrites = uniqueStrings(plan.workstreams.flatMap((ws) => ws.descriptor.allowedWrites || []));
  const readFirst = uniqueStrings(plan.workstreams.flatMap((ws) => ws.descriptor.readFirst || []));
  return {
    stage: plan.stage,
    name: plan.name,
    role: "director",
    rolesInStage: plan.roles,
    workstreamId: `${plan.stage}.omnigent-director`,
    objective: `Coordinate ${plan.name} workstreams through one Omnigent director session.`,
    readFirst,
    allowedWrites,
    artifact: null,
    template: null,
    goalCondition: plan.workstreams
      .map((ws) => `pipeline/gates/${ws.descriptor.workstreamId}.json exists`)
      .join("; "),
    expectedGate: null,
    requiredCapabilities: null,
    changeId: plan.ctx.changeId,
    toolBudget: null,
    experimentalDirector: true,
  };
}

function runStage(stageName, opts = {}) {
  const stageDef = getStage(stageName);
  if (!stageDef) {
    throw new Error(
      `Unknown stage "${stageName}". Known: ${Object.keys(STAGES).join(", ")}.`,
    );
  }

  const cwd = opts.cwd || process.cwd();
  const config = opts.config || loadConfig(cwd);
  const isolation = opts.isolation || config.pipeline.isolation;
  const trustProfile = resolveTrustProfile(config, opts.trustProfile);
  const execution = config.execution || normalizeExecutionConfig();
  const feature = opts.feature || "";
  // G6: custom_stages in config overrides default_track when no explicit track is passed.
  const track = opts.track
    || (Array.isArray(config.pipeline.custom_stages) ? config.pipeline.custom_stages : null)
    || config.pipeline.default_track;
  const ctx = {
    track,
    feature,
    // ADR-009 §Decision.7: intent propagated from driver so adapters can
    // render repair-mode prompts (diagnosis vs. feature brief at stage-01).
    intent: opts.intent || null,
    cwd,
    isolation,
    changeId: isolation === "bounded" ? changeIdFromFeature(feature) : null,
    orchestrator: ORCHESTRATOR_ID,
    timeoutMs: typeof opts.timeoutMs === "number" ? opts.timeoutMs : undefined,
    patchItems: Array.isArray(opts.patchItems) && opts.patchItems.length > 0 ? opts.patchItems : null,
    // 32.3: true when this dispatch is a fix-and-retry re-dispatch (set by
    // the driver from state.fixRetries), consulted below to decide whether
    // routing.escalate_on_retry should bump a pinned model one tier.
    isRetry: opts.isRetry === true,
    // Phase-35 item 35.1: --scope <path> (repeatable), narrows a review-only
    // dispatch to a subtree without changing which stages run. null (not [])
    // when absent so renderStagePrompt/appendGateFooter can render nothing
    // and keep every non-scoped track's prompt byte-identical.
    scope: Array.isArray(opts.scope) && opts.scope.length > 0 ? opts.scope : null,
    // Phase-36 item 36.3: opts.processCwd/opts.externalReviewMode ride the
    // same opts passthrough opts.scope already uses (35.1) — unset on every
    // non-review caller, so ctx.processCwd stays null and hosts/acp/adapter.js's
    // `ctx.processCwd || ctx.cwd` fallback (plus buildDescriptor's own
    // processCwd passthrough below) keeps this byte-identical to today.
    processCwd: opts.processCwd || null,
    externalReviewMode: opts.externalReviewMode === true,
    // Phase-36 item 36.5: an explicit opt-in that this review genuinely has
    // no subject on disk at all (a PR diff, not a checkout) — distinct from
    // ctx.processCwd merely being unset, which hosts/acp/adapter.js still
    // treats as "codeRoot === stateRoot, deny by default" for safety. Unset
    // on every non-review caller, so byte-identical to pre-36.5 behavior.
    noCodeRoot: opts.noCodeRoot === true,
    trustProfile,
    containment: execution.contained,
  };

  if (!isStageInTrack(stageName, ctx.track)) {
    process.stderr.write(
      `[devteam] note: stage "${stageName}" is skipped by track "${ctx.track}". Running anyway; if this is unintended, change pipeline.default_track in .devteam/config.yml.\n`,
    );
  }

  const gatesDir = getGatesDir(cwd, ctx.changeId);
  const hasExplicitWorkstreamFilter = Array.isArray(opts.workstream) && opts.workstream.length > 0;
  const plan = computeDispatchPlan(stageDef, config, ctx.track, {
    gatesDir: hasExplicitWorkstreamFilter ? null : gatesDir,
  });

  // Apply --workstream filter BEFORE rendering prompts so only the requested
  // workstreams are built. This is the single shared filter for both headless
  // and non-headless modes — keeping them identical.
  // Explicit --workstream is an operator/applicator override: it may target a
  // role suppressed by stage-01 active_roles when a later Principal ruling says
  // that suppressed role owns the repair surface.
  //
  // Role-prefix match rule: filter values are bare role names. For fanout stages,
  // each fanout entry keeps the bare role name (e.g. ws.role = "backend" even when
  // workstreamId = "stage-05.backend.claude-code"), so all fanout instances of a
  // role are selected together by a single --workstream value.
  let effectivePlan = plan;
  if (opts.workstream && opts.workstream.length > 0) {
    const wsFilter = new Set(opts.workstream);
    effectivePlan = plan.filter((entry) => wsFilter.has(entry.role));
    if (effectivePlan.length === 0) {
      throw new Error(
        `--workstream filter matched no roles in stage "${stageName}". ` +
        `Available: ${[...new Set(plan.map((e) => e.role))].join(", ")}`,
      );
    }
    process.stderr.write(`[devteam] --workstream: dispatching ${[...new Set(effectivePlan.map((e) => e.role))].join(", ")} only\n`);
  }

  return withSpan("pipeline.stage", {
    "devteam.stage": stageDef.stage,
    "devteam.stage.name": stageName,
    "devteam.track": trackLabel(ctx.track),
    "devteam.roles": stageDef.roles.join(","),
    "devteam.workstream_count": effectivePlan.length,
    "devteam.fanout": effectivePlan.some((p) => p.fanout) || undefined,
    "devteam.feature": ctx.feature || undefined,
  }, () => {
    const contextManifest = collectChangedFileManifest(ctx.cwd);
    const projectFacts = Array.isArray(opts.projectFacts)
      ? opts.projectFacts
      : require("./knowledge-pack").loadCurrentProjectFacts(ctx.cwd);
    const dispatches = effectivePlan.map((entry) => withSpan("pipeline.workstream", {
      "devteam.stage": stageDef.stage,
      "devteam.workstream.role": entry.role,
      "devteam.workstream.id": entry.workstreamId,
    }, () => {
      // For fanout entries the host is fixed by the fanout list; for
      // normal entries the router resolves via precedence.
      let hostName, adapter, model, agentCommand, modelEscalated = null;
      if (entry.hostName) {
        hostName = entry.hostName;
        const { loadAdapter } = require("./router");
        adapter = loadAdapter(hostName);
      } else {
        const resolved = resolveAdapter(config, stageDef.stage, entry.role);
        hostName = resolved.hostName;
        adapter = resolved.adapter;
        model = resolved.model;
        agentCommand = resolved.agentCommand;
        // 32.3: escalate-on-retry — a fix-and-retry of a dispatch whose
        // route pinned a model bumps it one tier up routing.tiers[host].
        // Never applies to fanout entries (handled above) since those
        // don't carry a routing-resolved model at all.
        if (ctx.isRetry && config.routing.escalate_on_retry && model) {
          const escalated = escalateModel(config, hostName, model);
          if (escalated && escalated !== model) {
            modelEscalated = { from: model, to: escalated };
            model = escalated;
          }
        }
      }
      assertCapabilities(stageDef, entry.role, hostName, adapter);
      // G10 / 6.1: resolve per-role tool budget from core/roles.js (host-neutral).
      // Previously resolved from the adapter, so only claude-code dispatches
      // ever got a non-null budget. Now every host receives the declared budget,
      // enabling prompt-only advisory rendering and dispatched_tool_budget stamping
      // on codex, gemini-cli, and generic dispatches.
      const toolBudget = require("./roles").toolBudgetFor(entry.role);
      warnIfToolBudgetDegraded(toolBudget, entry.role, hostName, adapter);
      // 32.5(b): computed per workstream at plan time — null on a
      // workstream's first-ever dispatch (nothing to diff against yet).
      const contextDelta = computeContextDelta({ cwd: ctx.cwd, changeId: ctx.changeId, workstreamId: entry.workstreamId });
      // 36.2: processCwd rides along so buildDescriptor can tell a review
      // workspace's stateRoot (ctx.cwd) apart from the subject it's reviewing
      // (ctx.processCwd, 36.1's codeRoot) — see resolveReadFirstItem() above.
      // Unset on every non-review path today, matching ctx.processCwd's own
      // "not set by any orchestrator path yet" state (hosts/acp/adapter.js).
      const baseDescriptor = buildDescriptor(stageDef, entry.role, { workstreamId: entry.workstreamId, changeId: ctx.changeId, cwd: ctx.cwd, processCwd: ctx.processCwd, toolBudget, intent: ctx.intent, track: ctx.track, contextManifest, contextDelta, priorKnowledge: opts.priorKnowledge, projectFacts, reviewMode: config.review && config.review.mode });
      const knownPatterns = require("./patterns").selectForDescriptor({ cwd: ctx.cwd, descriptor: baseDescriptor, ctx });
      // 32.3: model rides on the descriptor (like knownPatterns above) so
      // every adapter's invoke()/runHeadless sees it without a signature
      // change — undefined when routing didn't pin one for this dispatch.
      // 34.1: agentCommand rides the same way — only ever set when routing
      // used the "acp:<command>" form; every other host ignores it.
      const descriptor = { ...baseDescriptor, knownPatterns, model, agentCommand };
      const prompt = withSpan("adapter.renderStagePrompt", {
        "devteam.host": hostName,
        "devteam.stage": stageDef.stage,
        "devteam.workstream.role": entry.role,
      }, () => adapter.renderStagePrompt(descriptor, ctx));
      setSpanAttributes({ "devteam.host": hostName });
      return { role: entry.role, host: hostName, model, modelEscalated, descriptor, prompt, adapter, fanout: entry.fanout };
    }));

    // roles[] reflects the filtered set when --workstream is active, so callers
    // (e.g. printStagePreamble) show the correct workstream count.
    const filteredRoles = effectivePlan.length < plan.length
      ? [...new Set(effectivePlan.map((e) => e.role))]
      : stageDef.roles;

    return {
      stage: stageDef.stage,
      name: stageName,
      roles: filteredRoles,
      workstreams: dispatches,
      ctx,
    };
  });
}

// 30.4: feature/brief text to query memory against — the same text for
// every role dispatched within one stage (retrieval is per-stage, not
// per-role). Best-effort: an unreadable/absent brief just narrows the
// query to ctx.feature (or empty, which short-circuits retrieval).
function memoryQueryText(cwd, changeId, feature) {
  const parts = [];
  if (feature) parts.push(feature);
  try {
    const briefPath = path.join(pipelineRoot(cwd, changeId), "brief.md");
    if (fs.existsSync(briefPath)) parts.push(fs.readFileSync(briefPath, "utf8"));
  } catch {
    // best-effort — retrieval still runs on ctx.feature alone
  }
  return parts.join("\n\n");
}

// 30.4: pre-fetch retrieved history for the Project Knowledge Pack before the synchronous
// runStage()/buildDescriptor() pipeline runs — see core/memory/inject.js's
// module header for why this can't live inside buildDescriptor() itself.
// A no-op (no extra requires, no embedder load) when opts.priorKnowledge
// is already supplied (tests) or the stage name doesn't resolve (runStage
// will raise its own "Unknown stage" error momentarily).
async function resolvePriorKnowledgeOpts(stageName, opts) {
  if (opts.priorKnowledge !== undefined) return opts;
  const stageDef = getStage(stageName);
  if (!stageDef) return opts;
  const cwd = opts.cwd || process.cwd();
  const config = opts.config || loadConfig(cwd);
  const isolation = opts.isolation || config.pipeline.isolation;
  const feature = opts.feature || "";
  const changeId = isolation === "bounded" ? changeIdFromFeature(feature) : null;
  const queryText = memoryQueryText(cwd, changeId, feature);
  const { priorKnowledgeForStage } = require("./memory/inject");
  const { priorKnowledge, warning } = await priorKnowledgeForStage({ cwd, config, stageDef, queryText });
  if (warning) process.stderr.write(`${warning}\n`);
  return { ...opts, priorKnowledge };
}

// Headless variant of runStage — actually drives each adapter's invoke()
// to spawn the host CLI per workstream. Resolves with an array of
// {role, host, invokeResult, descriptor}. Honors per-workstream
// capability check; rejects if any routed host has headless: false.
// 31.3: split a stage's planned workstreams into sequential dispatch waves.
// [verify-first] resolution: core/scheduler.js's mapByHostConcurrency enqueues
// every item immediately and bounds concurrency only per-host (ADR-015) — it
// has no "wait for sibling workstream X" primitive, and adding one is a larger
// DAG-wave scheduling change out of scope here (see ADR-015's own "future
// work" note). So adversarial stage-05 is implemented as the plan's documented
// fallback: "two orchestrator steps" — the critic must read the reviewer's
// completed pipeline/code-review/by-reviewer.md, so its wave only starts once
// the reviewer wave's mapByHostConcurrency call has fully resolved. Every other
// stage (and panel-mode stage-05) returns a single wave containing the whole
// plan, exactly matching pre-31.3 behavior.
function dispatchWavesFor(plan, config) {
  if (plan.stage === "stage-05" && isAdversarialReviewMode(config)) {
    const reviewerWs = plan.workstreams.filter((ws) => ws.role === "reviewer");
    const criticWs = plan.workstreams.filter((ws) => ws.role === "critic");
    const rest = plan.workstreams.filter((ws) => ws.role !== "reviewer" && ws.role !== "critic");
    const waves = [];
    if (reviewerWs.length > 0) waves.push(reviewerWs);
    if (criticWs.length > 0) waves.push(criticWs);
    if (rest.length > 0) waves.push(rest);
    return waves.length > 0 ? waves : [plan.workstreams];
  }
  return [plan.workstreams];
}

async function runStageHeadless(stageName, opts = {}) {
  opts = await resolvePriorKnowledgeOpts(stageName, opts);
  if (opts.projectFacts === undefined) {
    const cwd = opts.cwd || process.cwd();
    opts = { ...opts, projectFacts: require("./knowledge-pack").loadCurrentProjectFacts(cwd, { persist: true }) };
  }
  const plan = runStage(stageName, opts);
  const config = opts.config || loadConfig(opts.cwd || process.cwd());
  const onWorkstreamEvent = typeof opts.onWorkstreamEvent === "function" ? opts.onWorkstreamEvent : null;
  const emitWorkstreamEvent = (event) => {
    if (!onWorkstreamEvent) return;
    try { onWorkstreamEvent(event); } catch { /* progress callbacks must never break dispatch */ }
  };
  for (const ws of plan.workstreams) {
    if (!ws.adapter.capabilities || !ws.adapter.capabilities.headless) {
      throw new Error(
        `host "${ws.host}" cannot drive workstream "${ws.role}" headlessly ` +
        `(capabilities.headless is false). Either install a different host ` +
        `for this role or run interactively (omit --headless).`,
      );
    }
    if (typeof ws.adapter.invoke !== "function") {
      throw new Error(`host "${ws.host}" declares headless: true but exports no invoke()`);
    }
  }
  const gatesDir = getGatesDir(plan.ctx.cwd, plan.ctx.changeId);
  if (opts.experimentalOmnigentDirector) {
    if (plan.workstreams.length <= 1) {
      throw new Error("--experimental-omnigent-director requires a multi-workstream stage.");
    }
    const nonOmnigent = plan.workstreams.filter((ws) => ws.host !== "omnigent");
    if (nonOmnigent.length > 0) {
      throw new Error(
        "--experimental-omnigent-director requires every planned workstream to route to omnigent; " +
        `non-omnigent workstreams: ${nonOmnigent.map((ws) => `${ws.role}:${ws.host}`).join(", ")}`,
      );
    }
    return withSpan("pipeline.stage.omnigent_director", {
      "devteam.stage": plan.stage,
      "devteam.stage.name": stageName,
      "devteam.workstream_count": plan.workstreams.length,
      "devteam.experimental": "omnigent-director",
    }, async () => {
      const directorAdapter = plan.workstreams[0].adapter;
      const descriptor = directorDescriptorForPlan(plan);
      const prompt = renderOmnigentDirectorPrompt(plan);
      const directorLogPath = process.env.DEVTEAM_NO_LOG === "1" || plan.ctx.log === false
        ? null
        : path.join(getLogsDir(plan.ctx.cwd, plan.ctx.changeId), `${descriptor.workstreamId}.log`);
      for (const ws of plan.workstreams) {
        const telemetry = promptTelemetry(ws.prompt, ws.descriptor);
        emitWorkstreamEvent({
          type: "workstream-started",
          stage: plan.stage,
          name: stageName,
          role: ws.role,
          host: ws.host,
          workstream_id: ws.descriptor.workstreamId,
          gate_path: path.join(gatesDir, `${ws.descriptor.workstreamId}.json`),
          log_path: directorLogPath,
          prompt_bytes: telemetry.promptBytes,
          context_manifest_files: telemetry.contextManifestFiles,
          context_manifest_omitted: telemetry.contextManifestOmitted,
          director: true,
        });
      }
      process.stderr.write(`[devteam] experimental: dispatching ${plan.workstreams.length} workstreams → omnigent director (headless)\n`);
      // 30.2(a): director mode still dispatches every workstream's rendered
      // prompt (bundled into one call) — record each workstream's own
      // Reviewed pattern entries in the Project Knowledge Pack count as injected.
      for (const ws of plan.workstreams) {
        require("./patterns").recordInjection({
          cwd: plan.ctx.cwd,
          pipelineRoot: pipelineRoot(plan.ctx.cwd, plan.ctx.changeId),
          stage: plan.stage,
          workstreamId: ws.descriptor.workstreamId,
          patterns: ws.descriptor.knownPatterns,
        });
      }
      let r;
      try {
        r = await directorAdapter.invoke(descriptor, plan.ctx, prompt);
      } catch (err) {
        for (const ws of plan.workstreams) {
          emitWorkstreamEvent({
            type: "workstream-finished",
            stage: plan.stage,
            name: stageName,
            role: ws.role,
            host: ws.host,
            workstream_id: ws.descriptor.workstreamId,
            exit_code: null,
            gate_path: null,
            log_path: directorLogPath,
            duration_ms: null,
            error: err && err.message,
            director: true,
          });
        }
        throw err;
      }
      if (Array.isArray(r.writeViolations) && r.writeViolations.length > 0) {
        for (const v of r.writeViolations) {
          process.stderr.write(`[devteam] ⛔ write-audit: unauthorized write "${v}" (not in allowedWrites for ${descriptor.workstreamId})\n`);
        }
      }
      const results = plan.workstreams.map((ws) => {
        const telemetry = promptTelemetry(ws.prompt, ws.descriptor);
        const expectedGate = path.join(gatesDir, `${ws.descriptor.workstreamId}.json`);
        const exists = fs.existsSync(expectedGate);
        const childExit = r.exitCode === 0 && exists && (!r.writeViolations || r.writeViolations.length === 0) ? 0 : 1;
        if (exists && Array.isArray(r.writeViolations) && r.writeViolations.length > 0) {
          patchGateForWriteViolations(expectedGate, r.writeViolations);
        }
        const result = {
          role: ws.role,
          host: ws.host,
          descriptor: ws.descriptor,
          exitCode: childExit,
          gatePath: exists ? expectedGate : null,
          durationMs: r.durationMs,
          timedOut: r.timedOut,
          logPath: r.logPath,
          director: true,
          directorWorkstreamId: descriptor.workstreamId,
          writeViolations: r.writeViolations || [],
          ...telemetry,
        };
        emitWorkstreamEvent({
          type: "workstream-finished",
          stage: plan.stage,
          name: stageName,
          role: ws.role,
          host: ws.host,
          workstream_id: ws.descriptor.workstreamId,
          exit_code: childExit,
          timed_out: Boolean(r.timedOut),
          gate_path: exists ? expectedGate : null,
          log_path: r.logPath || directorLogPath,
          duration_ms: r.durationMs ?? null,
          prompt_bytes: telemetry.promptBytes,
          context_manifest_files: telemetry.contextManifestFiles,
          context_manifest_omitted: telemetry.contextManifestOmitted,
          write_violations_count: Array.isArray(r.writeViolations) ? r.writeViolations.length : 0,
          director: true,
        });
        return result;
      });
      return { stage: plan.stage, name: stageName, roles: plan.roles, results, ctx: plan.ctx, experimentalDirector: "omnigent" };
    });
  }
  return withSpan("pipeline.stage.headless", {
    "devteam.stage": plan.stage,
    "devteam.stage.name": stageName,
    "devteam.workstream_count": plan.workstreams.length,
  }, async () => {
    // C6: remember the single-role stage gate's pre-dispatch mtime so we only
    // stamp the chain when THIS dispatch actually (re)wrote it — not on a
    // no-write run (e.g. `devteam replay` against an empty host command, which
    // must stay distinguishable by mtime).
    const singleRoleGate = plan.workstreams.length === 1
      ? path.join(gatesDir, `${plan.stage}.json`) : null;
    let preGateMtime = null;
    if (singleRoleGate) { try { preGateMtime = fs.statSync(singleRoleGate).mtimeMs; } catch { preGateMtime = null; } }

    // 5.3: archive-before-overwrite — interactive convergence ceiling. Archive
    // the stage gate if it exists with FAIL status so countArchivedAttempts() in
    // next() sees the attempt even on the interactive path (devteam stage / next
    // loops). On the driver path the gate is cleared before this runs, so this
    // is a no-op there (gate absent → archiveGateIfFail returns null). Best-effort.
    try { archiveGateIfFail(gatesDir, plan.stage); } catch { /* never block dispatch */ }

    const workstreamIsolation = shouldIsolateBuildWorkstreams(config, plan)
      ? new WorkstreamIsolation({
          cwd: plan.ctx.cwd,
          stage: plan.stage,
          workstreams: plan.workstreams,
        }).prepareAll()
      : null;
    if (workstreamIsolation) {
      process.stderr.write(
        `[devteam] isolating ${plan.workstreams.length} workstreams in detached Git worktrees (${plan.ctx.trustProfile})\n`,
      );
    }

    const limitForHost = (host) => hostConcurrencyLimit(config, host);
    // --workstream filtering is applied in runStage (before rendering), so
    // plan.workstreams already contains only the requested workstreams here.
    const dispatchOptions = {
      key: (ws) => ws.host,
      limit: limitForHost,
      onQueued: (ws, _index, queue) => {
        const wsGatePathExpected = path.join(gatesDir, `${ws.descriptor.workstreamId}.json`);
        const expectedLogPath = process.env.DEVTEAM_NO_LOG === "1" || plan.ctx.log === false
          ? null
          : path.join(getLogsDir(plan.ctx.cwd, plan.ctx.changeId), `${ws.descriptor.workstreamId}.log`);
        emitWorkstreamEvent({
          type: "workstream-queued",
          stage: plan.stage,
          name: stageName,
          role: ws.role,
          host: ws.host,
          workstream_id: ws.descriptor.workstreamId,
          gate_path: wsGatePathExpected,
          log_path: expectedLogPath,
          queue_depth: queue.queueDepth,
          queue_limit: queue.queueLimit,
        });
      },
    };
    const dispatchWorker = async (ws, _index, queue) => {
      const rootGatePathExpected = path.join(gatesDir, `${ws.descriptor.workstreamId}.json`);
      const rootLogPathExpected = process.env.DEVTEAM_NO_LOG === "1" || plan.ctx.log === false
        ? null
        : path.join(getLogsDir(plan.ctx.cwd, plan.ctx.changeId), `${ws.descriptor.workstreamId}.log`);
      const invocationCtx = workstreamIsolation
        ? workstreamIsolation.contextFor(ws, plan.ctx)
        : plan.ctx;
      const wsGatePathExpected = workstreamIsolation
        ? workstreamIsolation.workspacePath(ws, rootGatePathExpected)
        : rootGatePathExpected;
      const expectedLogPath = workstreamIsolation && rootLogPathExpected
        ? workstreamIsolation.workspacePath(ws, rootLogPathExpected)
        : rootLogPathExpected;
      if (opts.skipCompleted) {
        if (fs.existsSync(rootGatePathExpected)) {
          process.stderr.write(`[devteam] --skip-completed: ${ws.role} already has a gate, skipping\n`);
          const skipped = {
            role: ws.role, host: ws.host, descriptor: ws.descriptor, skipped: true,
            exitCode: 0, gatePath: rootGatePathExpected, logPath: rootLogPathExpected, durationMs: 0,
            queueMs: queue.queueMs,
          };
          if (workstreamIsolation) workstreamIsolation.cleanup(ws);
          emitWorkstreamEvent({
            type: "workstream-finished",
            stage: plan.stage,
            name: stageName,
            role: ws.role,
            host: ws.host,
            workstream_id: ws.descriptor.workstreamId,
            skipped: true,
            exit_code: 0,
            gate_path: rootGatePathExpected,
            log_path: rootLogPathExpected,
            duration_ms: 0,
            queue_ms: queue.queueMs,
            queue_limit: queue.queueLimit,
          });
          return skipped;
        }
      }
      const queueSuffix = queue.queueMs > 0 ? ` after ${queue.queueMs}ms queue` : "";
      process.stderr.write(`[devteam] dispatching ${ws.role} → ${ws.host} (headless)${queueSuffix}\n`);
      // 30.2(a): this is a real dispatch (past --skip-completed), so any
      // Reviewed pattern entries rendered into the pack count as injected.
      require("./patterns").recordInjection({
        cwd: plan.ctx.cwd,
        pipelineRoot: pipelineRoot(plan.ctx.cwd, plan.ctx.changeId),
        stage: plan.stage,
        workstreamId: ws.descriptor.workstreamId,
        patterns: ws.descriptor.knownPatterns,
      });
      const composeInvocationPrompt = (promptText) =>
        ws.adapter.capabilities.goalLoop && ws.descriptor.goalCondition
          ? `/goal "${ws.descriptor.goalCondition}"\n\n${promptText}`
          : promptText;
      let invocationPrompt = composeInvocationPrompt(ws.prompt);
      // C2 (core/adapters/headless.js): claude-code's own `/goal` slash
      // command rejects anything over capabilities.promptCharLimit chars
      // with "Goal condition is limited to N characters" and exits 0 — no
      // gate written, no error surfaced. The check lives *only* inside that
      // one command's handler, keyed off however much text follows "/goal ".
      // In `--print` mode the whole piped stdin is one message with no way
      // to separate "the goal" from "the rest of the prompt" the way an
      // interactive session's per-keystroke dispatch would — confirmed
      // empirically: piping `/goal "x"` followed by a filler blob reports
      // the *combined* length, not the short condition's own; the identical
      // filler with no `/goal` prefix dispatches fine at any size. So this
      // is purely a consequence of the prefix above, never of prompt size on
      // its own — skip entirely when there's no goalCondition to prefix, and
      // once the prefix is dropped as a last resort there is nothing left to
      // check (a goal-free prompt has no such ceiling, so this always
      // resolves it — no further fallback or rejection needed).
      const promptCharLimit = ws.adapter.capabilities && ws.adapter.capabilities.promptCharLimit;
      if (promptCharLimit && ws.descriptor.goalCondition && invocationPrompt.length > promptCharLimit) {
        const { shrinkComposedPrompt } = require("./adapters/render-helpers");
        const shrunk = shrinkComposedPrompt({
          adapter: ws.adapter, descriptor: ws.descriptor, ctx: plan.ctx,
          basePrompt: ws.prompt, compose: composeInvocationPrompt, limit: promptCharLimit,
          onWarn: (msg) => process.stderr.write(`[devteam] warn: ${ws.descriptor.workstreamId} ${msg}\n`),
        });
        invocationPrompt = shrunk.composed;
        if (invocationPrompt.length > promptCharLimit) {
          // Last resort: drop the /goal directive itself for this one
          // dispatch — losing goal-loop convergence beats a rejected (pre-
          // fix, silently stalled) dispatch. Always resolves it.
          const before = invocationPrompt.length;
          invocationPrompt = shrunk.base;
          process.stderr.write(
            `[devteam] warn: ${ws.descriptor.workstreamId} prompt ${before} chars still exceeds ${promptCharLimit}-char limit; ` +
            `dropped the /goal directive for this dispatch (no goal-loop convergence this attempt)\n`,
          );
        }
      }
      const telemetry = promptTelemetry(invocationPrompt, ws.descriptor);
      // 28.5: hashed (never raw) so the corpus record identifies repeated
      // prompts without persisting prompt content.
      const promptHash = crypto.createHash("sha256").update(invocationPrompt).digest("hex");
      // G10: snapshot mtime before invoke so we can tell whether the headless
      // command actually wrote the gate (vs. a pre-existing gate that the
      // command left untouched — e.g. `devteam replay` with a no-op command).
      let preInvokeMtime = null;
      try { preInvokeMtime = fs.statSync(wsGatePathExpected).mtimeMs; } catch { preInvokeMtime = null; }
      emitWorkstreamEvent({
        type: "workstream-started",
        stage: plan.stage,
        name: stageName,
        role: ws.role,
        host: ws.host,
        workstream_id: ws.descriptor.workstreamId,
        gate_path: rootGatePathExpected,
        log_path: rootLogPathExpected,
        queue_ms: queue.queueMs,
        queue_limit: queue.queueLimit,
        prompt_bytes: telemetry.promptBytes,
        context_manifest_files: telemetry.contextManifestFiles,
        context_manifest_omitted: telemetry.contextManifestOmitted,
      });

      let r;
      try {
        r = await withSpan("adapter.invoke", {
          "devteam.host": ws.host,
          "devteam.workstream.role": ws.role,
          "devteam.workstream.id": ws.descriptor.workstreamId,
        }, async (span) => {
          // E7: prepend /goal directive for hosts that support a goal loop
          // and stages that declare a convergence condition.
          const out = await ws.adapter.invoke(ws.descriptor, invocationCtx, invocationPrompt);
          if (span) span.setAttributes({
            "devteam.invoke.exit_code": out.exitCode,
            "devteam.invoke.duration_ms": out.durationMs,
            "devteam.invoke.gate_written": Boolean(out.gatePath),
          });
          return out;
        });
      } catch (err) {
        if (workstreamIsolation) {
          try {
            workstreamIsolation.reconcile(ws, {
              gatePath: wsGatePathExpected,
              logPath: expectedLogPath,
              patchGate: patchGateForIsolationFindings,
            });
          } finally {
            workstreamIsolation.cleanup(ws);
          }
        }
        emitWorkstreamEvent({
          type: "workstream-finished",
          stage: plan.stage,
          name: stageName,
          role: ws.role,
          host: ws.host,
          workstream_id: ws.descriptor.workstreamId,
          exit_code: null,
          gate_path: null,
          log_path: rootLogPathExpected,
          duration_ms: null,
          queue_ms: queue.queueMs,
          queue_limit: queue.queueLimit,
          prompt_bytes: telemetry.promptBytes,
          context_manifest_files: telemetry.contextManifestFiles,
          context_manifest_omitted: telemetry.contextManifestOmitted,
          error: err && err.message,
        });
        throw err;
      }
      // C1: if write violations were detected, filter out parallel-stage
      // false positives then patch the gate to FAIL.
      //
      // When multiple workstreams run in parallel (Promise.all above), the
      // post-hoc snapshot window for workstream A overlaps with workstream B's
      // writes. Any file B legitimately writes appears as a "new path" in A's
      // after-snapshot and gets flagged as a violation even though A never
      // touched it. Suppress those by treating any path covered by a sibling
      // workstream's allowedWrites as permitted for audit purposes.
      if (r.writeViolations && r.writeViolations.length > 0) {
        const siblingAllowedWrites = workstreamIsolation ? [] : plan.workstreams
          .filter((s) => s !== ws)
          .flatMap((s) => s.descriptor?.allowedWrites || []);
        const realViolations = siblingAllowedWrites.length > 0
          ? r.writeViolations.filter((v) => !isAllowed(v, siblingAllowedWrites))
          : r.writeViolations;
        if (realViolations.length > 0) {
          for (const v of realViolations) {
            process.stderr.write(`[devteam] ⛔ write-audit: unauthorized write "${v}" (not in allowedWrites for ${ws.descriptor.workstreamId})\n`);
          }
          const wsGatePath = r.gatePath || wsGatePathExpected;
          patchGateForWriteViolations(wsGatePath, realViolations);
        }
      }
      // G10: stamp dispatched_tool_budget only when the headless command
      // actually wrote (or rewrote) the gate — detected by mtime advancing
      // past the pre-invoke snapshot. This prevents patching a pre-existing
      // gate left untouched by the command (e.g. `devteam replay` with a
      // no-op command), which would otherwise corrupt the mtime-based
      // "gate was written" detection in the replay flow.
      if (ws.descriptor.toolBudget !== null) {
        const budgetGatePath = r.gatePath || wsGatePathExpected;
        let postMtime = null;
        try { postMtime = fs.statSync(budgetGatePath).mtimeMs; } catch { postMtime = null; }
        const gateWasWrittenThisRun = postMtime !== null && (preInvokeMtime === null || postMtime > preInvokeMtime);
        if (gateWasWrittenThisRun) {
          patchGateForToolBudget(budgetGatePath, ws.descriptor.toolBudget);
        }
      }
      // Phase-28 items 28.1/28.2/28.3: orchestrator-observed token/cost
      // telemetry. r.usage is present for claude-code and codex (via
      // capabilities.usageFormat — see core/adapters/headless.js) and
      // openai-compat (returned directly by hosts/openai-compat/invoke.js)
      // when the dispatch's usage was parseable/reported. A telemetry miss
      // (r.telemetry === "unavailable", r.usage null/absent) never touches
      // the gate — same fire-and-forget contract as before 28.1 for those
      // dispatches. For hosts that declare `telemetry !== "native"` in
      // capabilities.json (gemini-cli, generic, omnigent today), record a
      // promptBytes/4 estimate instead — clearly flagged, never mixed with
      // observed values (see patchGateForEstimatedUsage above).
      if (r.usage) {
        patchGateForObservedUsage(r.gatePath || wsGatePathExpected, r.usage);
      } else if (ws.adapter.capabilities && ws.adapter.capabilities.telemetry !== "native") {
        patchGateForEstimatedUsage(r.gatePath || wsGatePathExpected, telemetry.promptBytes);
      }
      // 32.3: record what routing asked for, regardless of whether usage
      // telemetry was available above.
      if (ws.model) {
        patchGateWithRequestedModel(r.gatePath || wsGatePathExpected, ws.model, ws.modelEscalated);
      }
      // 33.3: record the prompt-pack version for every dispatch, regardless
      // of routing/usage telemetry availability — but only when the headless
      // command actually wrote (or rewrote) the gate this run. Same mtime
      // guard as the tool-budget patch above: without it, a no-op command
      // (e.g. `devteam replay` against an empty command) would still get its
      // pre-existing gate touched here, corrupting replay's "was a new gate
      // written" mtime check.
      {
        const ppvGatePath = r.gatePath || wsGatePathExpected;
        let ppvPostMtime = null;
        try { ppvPostMtime = fs.statSync(ppvGatePath).mtimeMs; } catch { ppvPostMtime = null; }
        const ppvGateWasWrittenThisRun = ppvPostMtime !== null && (preInvokeMtime === null || ppvPostMtime > preInvokeMtime);
        if (ppvGateWasWrittenThisRun) {
          patchGateWithPromptPackVersion(ppvGatePath);
        }
      }
      // 31.1: per-role orchestrator stamping for multi-workstream stampable
      // stages (stage-04 build) — stamps THIS workstream's own gate as it
      // completes, mirroring the single-role stamp step below but scoped to
      // the role (lint over ws.descriptor.allowedWrites; see core/verify/stamp.js).
      // Same "only if this dispatch actually wrote the gate" guard as the
      // tool-budget patch above.
      if (opts.stamp !== false) {
        const { STAMPABLE_WORKSTREAM_STAGES, stampWorkstream } = require("./verify/stamp");
        if (STAMPABLE_WORKSTREAM_STAGES.has(plan.stage)) {
          const wsGatePath = r.gatePath || wsGatePathExpected;
          let wsPostMtime = null;
          try { wsPostMtime = fs.statSync(wsGatePath).mtimeMs; } catch { wsPostMtime = null; }
          const wsGateWasWrittenThisRun = wsPostMtime !== null && (preInvokeMtime === null || wsPostMtime > preInvokeMtime);
          if (wsGateWasWrittenThisRun) {
            try {
              const stampResult = await stampWorkstream(invocationCtx.cwd, plan.stage, wsGatePath, {
                role: ws.role,
                allowedWrites: ws.descriptor.allowedWrites,
              });
              if (!stampResult.ok) {
                process.stderr.write(`[devteam] orchestrator workstream-stamp (${ws.role}): ${stampResult.error}\n`);
              } else if (stampResult.stamp.status_overridden) {
                process.stderr.write(
                  `[devteam] orchestrator workstream-stamp flipped ${ws.role}: ${stampResult.stamp.status_overridden.from} → ${stampResult.stamp.status_overridden.to}\n`,
                );
              }
            } catch (err) {
              process.stderr.write(`[devteam] orchestrator workstream-stamp failed (${ws.role}): ${err.message}\n`);
            }
          }
        }
      }
      if (workstreamIsolation) {
        const reconciliation = workstreamIsolation.reconcile(ws, {
          gatePath: r.gatePath || wsGatePathExpected,
          logPath: r.logPath || expectedLogPath,
          patchGate: patchGateForIsolationFindings,
        });
        workstreamIsolation.cleanup(ws);
        if (reconciliation.violations.length > 0) {
          for (const violation of reconciliation.violations) {
            process.stderr.write(
              `[devteam] ⛔ isolated write-audit: unauthorized write "${violation}" (${ws.descriptor.workstreamId})\n`,
            );
          }
        }
        if (reconciliation.conflicts.length > 0) {
          for (const conflict of reconciliation.conflicts) {
            process.stderr.write(
              `[devteam] ⛔ isolated reconciliation conflict: "${conflict}" (${ws.descriptor.workstreamId})\n`,
            );
          }
        }
        r = {
          ...r,
          gatePath: reconciliation.gatePath,
          logPath: reconciliation.logPath,
          writeViolations: [
            ...(Array.isArray(r.writeViolations) ? r.writeViolations : []),
            ...reconciliation.violations,
          ],
          isolationConflicts: reconciliation.conflicts,
        };
      }
      const result = { role: ws.role, host: ws.host, descriptor: ws.descriptor, queueMs: queue.queueMs, promptHash, ...r, ...telemetry };
      emitWorkstreamEvent({
        type: "workstream-finished",
        stage: plan.stage,
        name: stageName,
        role: ws.role,
        host: ws.host,
        workstream_id: ws.descriptor.workstreamId,
        exit_code: r.exitCode ?? null,
        timed_out: Boolean(r.timedOut),
        gate_path: r.gatePath || null,
        log_path: r.logPath || rootLogPathExpected,
        duration_ms: r.durationMs ?? null,
        queue_ms: queue.queueMs,
        queue_limit: queue.queueLimit,
        prompt_bytes: telemetry.promptBytes,
        context_manifest_files: telemetry.contextManifestFiles,
        context_manifest_omitted: telemetry.contextManifestOmitted,
        write_violations_count: Array.isArray(r.writeViolations) ? r.writeViolations.length : 0,
        stub_gate: Boolean(r.stubGate),
      });
      return result;
    };
    // 31.3: adversarial stage-05 dispatches reviewer then critic as two
    // sequential waves (core/scheduler.js's mapByHostConcurrency has no
    // ordering primitive — see dispatchWavesFor()'s header comment). Every
    // other stage gets a single wave containing the full plan, identical to
    // the one mapByHostConcurrency call this replaced.
    const waves = dispatchWavesFor(plan, config);
    let results = [];
    try {
      for (const wave of waves) {
        const waveResults = await mapByHostConcurrency(wave, dispatchOptions, dispatchWorker);
        // Matrix-shaped peer-review gates (approvals derived from sibling
        // workstreams' by-*.md review files — see headless.js's "Derive
        // peer-review gates" rescan) can materialize on disk *after* the
        // workstream they belong to has already exited. That rescan runs
        // per-workstream at that workstream's own close, scoped to whatever
        // review files exist at that instant; a role that finishes first sees
        // none of its later-finishing peers' review files yet and closes with
        // gatePath: null — even though a peer's own rescan minutes later
        // derives and writes that exact gate as a side effect. By the time
        // the whole wave has settled (every sibling dispatchWorker call above
        // has returned), any gate that was ever going to appear from files
        // already on disk has had its chance to. Re-check once more here,
        // before these results reach normalizeDispatchResults()'s wroteGate
        // check in core/driver-dispatch.js — without this, a stage that fully
        // passed halts anyway with "produced no gate" (a costly, blocking
        // false positive). Scoped tightly to dispatches that actually exited
        // cleanly, so a genuine no-gate failure still halts as before.
        for (const result of waveResults) {
          if (result.gatePath || result.stubGate || result.skipped) continue;
          if (result.exitCode !== 0 || result.timedOut) continue;
          const lateGatePath = path.join(gatesDir, `${result.descriptor.workstreamId}.json`);
          let lateGate = null;
          try { lateGate = JSON.parse(fs.readFileSync(lateGatePath, "utf8")); } catch { /* not written (yet), or unreadable */ }
          if (lateGate && lateGate._stub !== true) {
            result.gatePath = lateGatePath;
          }
        }
        results = results.concat(waveResults);
      }
    } finally {
      if (workstreamIsolation) workstreamIsolation.cleanupAll();
    }

    // Orchestrator-stamped verification. For stages where the gate
    // claims something the orchestrator can verify (stage-04a:
    // lint+tests; stage-06: tests + AC mapping), run the actual
    // commands and stamp what was observed. Skipped when the gate
    // doesn't exist yet (model wrote nothing) or when the stage isn't
    // stampable. Failures here log but don't block — the validator
    // will catch a malformed gate on its own. opts.stamp === false
    // disables this entirely (used by tests that don't want to run
    // real lint/test commands).
    if (opts.stamp !== false) {
      const { STAMPABLE_STAGES, stamp } = require("./verify/stamp");
      // Single-role stages produce one gate at stage-XX.json (no role
      // suffix). Stamping applies to: stage-03b (spec drift), stage-04a
      // (lint+tests), stage-06 (tests + AC mapping). Multi-role stages
      // (stage-04 build) get their own per-role + merged stamping — see
      // STAMPABLE_WORKSTREAM_STAGES below and STAMPABLE_MERGE_STAGES in
      // core/driver.js's merge handler (31.1).
      if (STAMPABLE_STAGES.has(plan.stage) && plan.workstreams.length === 1) {
        try {
          const stampResult = await stamp(plan.ctx.cwd, plan.stage);
          if (!stampResult.ok) {
            process.stderr.write(`[devteam] orchestrator stamping: ${stampResult.error}\n`);
          } else if (stampResult.stamp.status_overridden) {
            process.stderr.write(
              `[devteam] orchestrator verification flipped status: ${stampResult.stamp.status_overridden.from} → ${stampResult.stamp.status_overridden.to}\n`,
            );
          }
        } catch (err) {
          process.stderr.write(`[devteam] orchestrator stamping failed: ${err.message}\n`);
        }
      }
    }

    // C6: single-role stages write their stage gate directly (no merge step),
    // so stamp the tamper-evident chain here — but only if THIS dispatch
    // actually wrote the gate (created it, or advanced its mtime). Multi-role
    // stages are stamped by mergeWorkstreamGates. Best-effort.
    if (singleRoleGate) {
      let postGateMtime = null;
      try { postGateMtime = fs.statSync(singleRoleGate).mtimeMs; } catch { postGateMtime = null; }
      const wroteThisRun = postGateMtime !== null && (preGateMtime === null || postGateMtime > preGateMtime);
      if (wroteThisRun) {
        try { require("./gates/chain").stampChain(gatesDir, stageName, plan.ctx.track); } catch { /* */ }
        // D7: surface unpriced-model WARN on the single-role path, mirroring
        // what mergeWorkstreamGates does for multi-role stages.
        try { patchGateForUnpricedModel(singleRoleGate); } catch { /* */ }
        // 5.2: prune per-attempt archives when the stage gate recovers to PASS —
        // archives must not outlive the failure sequence they describe. Best-effort.
        try {
          const { gate: g } = require("./gates/load-gate").loadGateSafe(singleRoleGate);
          if (g && g.status === "PASS") pruneArchives(gatesDir, plan.stage);
        } catch { /* archiving must never block a run */ }
      }
    }

    // Phase-28 item 28.5: one sanitized run-corpus record per headless
    // dispatch, after stamping so single-role gates (stage-03b/04a/06)
    // carry the orchestrator-verified status rather than the model's
    // pre-stamp claim. Skips --skip-completed no-op entries (no dispatch
    // actually happened). Fire-and-forget — see core/corpus.js.
    for (const result of results) {
      if (result.skipped) continue;
      corpus.recordDispatch(plan.ctx.cwd, {
        runId: opts.runId || null,
        stage: plan.stage,
        role: result.role,
        host: result.host,
        track: plan.ctx.track,
        promptHash: result.promptHash,
        promptBytes: result.promptBytes,
        durationMs: result.durationMs,
        queueMs: result.queueMs,
        knowledgeItems: Array.isArray(result.descriptor?.projectFacts) ? result.descriptor.projectFacts.length : 0,
        priorKnowledgeItems: Array.isArray(result.descriptor?.priorKnowledge) ? result.descriptor.priorKnowledge.length : 0,
        gatePath: result.gatePath,
      });
      // Phase-33 item 33.1: capture a replayable eval case for single-role
      // stage gates that FAIL/ESCALATE (or carry a stamp status_overridden).
      // Only single-role stages — plan.workstreams.length === 1 — write
      // their FINAL gate here; multi-role stages' per-workstream gates
      // aren't the stage's true final status until mergeWorkstreamGates +
      // stampMerged run, so those are captured in core/driver.js's merge
      // branch instead. Fire-and-forget — see core/evals/capture.js.
      if (plan.workstreams.length === 1) {
        evalsCapture.captureEvalCase(plan.ctx.cwd, {
          config,
          gatePath: result.gatePath,
          stage: plan.stage,
          role: result.role,
          host: result.host,
          track: plan.ctx.track,
          runId: opts.runId || null,
          promptHash: result.promptHash,
          readFirst: result.descriptor && result.descriptor.readFirst,
        });
      }
    }

    return { stage: plan.stage, name: stageName, roles: plan.roles, results, ctx: plan.ctx };
  });
}

function mergeWorkstreamGates(stageName, opts = {}) {
  const stageDef = getStage(stageName);
  if (!stageDef) throw new Error(`Unknown stage "${stageName}"`);
  const config = opts.config || loadConfig(opts.cwd || process.cwd());
  // G6: custom_stages in config overrides default_track when no explicit track is passed.
  const track = opts.track
    || (Array.isArray(config.pipeline.custom_stages) ? config.pipeline.custom_stages : null)
    || config.pipeline.default_track;
  const gatesDir = opts.gatesDir || getGatesDir(opts.cwd || process.cwd(), opts.changeId || null);
  const plan = computeDispatchPlan(stageDef, config, track, { gatesDir });
  if (plan.length <= 1) {
    // workstreamId() collapses to the bare `<stage>.json` path whenever a
    // stage has exactly one dispatched role (loop's single-workstream build,
    // or any track/config combo where active_roles narrows down to one area)
    // — the dispatch writes the STAGE gate directly, so there's normally
    // nothing left to merge by the time next() would ask for one.
    //
    // A real hello-world-codex-loop --track loop run halted with
    // "merge-failed" here anyway: its role brief still hardcoded the old
    // "<stage>.<role>.json" suffix unconditionally (fixed in roles/backend.md
    // and roles/frontend.md), so the dispatch wrote a role-suffixed gate
    // instead of the bare one next() expected — and an already-`devteam
    // init`'d project's installed role brief copy won't pick up that fix
    // until it's re-initialized, so the same stale write can still happen.
    // Handle both outcomes instead of refusing outright: if the bare gate
    // is already there, this "merge" is a no-op success; if only the legacy
    // suffixed gate exists, promote it to the stage gate path.
    if (plan.length === 0) {
      return { merged: false, reason: "no workstreams to merge for this stage" };
    }
    const entry = plan[0];
    const stageGatePath = path.join(gatesDir, `${stageDef.stage}.json`);
    if (fs.existsSync(stageGatePath)) {
      const { gate, error } = loadGateSafe(stageGatePath);
      if (!error) return { merged: true, file: stageGatePath, gate };
    }
    const legacySuffixedPath = path.join(gatesDir, `${stageDef.stage}.${entry.role}.json`);
    if (fs.existsSync(legacySuffixedPath)) {
      const { gate, error } = loadGateSafe(legacySuffixedPath);
      if (error) return { merged: false, reason: `unreadable workstream gate (${entry.role}): ${error}` };
      fs.writeFileSync(stageGatePath, JSON.stringify(gate, null, 2) + "\n", "utf8");
      try { require("./gates/chain").stampChain(gatesDir, stageName, track); } catch { /* chain-stamp is best-effort */ }
      return { merged: true, file: stageGatePath, gate };
    }
    return { merged: false, reason: "single-workstream stage; no merge needed" };
  }

  return withSpan("pipeline.merge", {
    "devteam.stage": stageDef.stage,
    "devteam.stage.name": stageName,
    "devteam.workstream_count": plan.length,
    "devteam.fanout": plan.some((p) => p.fanout) || undefined,
  }, () => {
    const wsGates = [];
    for (const entry of plan) {
      const wsFile = path.join(gatesDir, entry.gateFile);
      if (!fs.existsSync(wsFile)) {
        setSpanAttributes({ "devteam.merge.result": "missing", "devteam.merge.missing": entry.workstreamId });
        return { merged: false, reason: `missing workstream gate: ${wsFile}` };
      }
      const { gate, error } = loadGateSafe(wsFile);
      if (error) {
        setSpanAttributes({ "devteam.merge.result": "malformed", "devteam.merge.malformed": entry.workstreamId });
        return { merged: false, reason: `unreadable workstream gate (${entry.workstreamId}): ${error}` };
      }
      wsGates.push({ role: entry.role, host: entry.hostName, gate });
    }

    const statuses = wsGates.map((w) => w.gate.status);
    const aggregate = statuses.includes("ESCALATE") ? "ESCALATE"
      : statuses.includes("FAIL") ? "FAIL"
      : statuses.includes("WARN") ? "WARN"
      : "PASS";

    // Roll up per-workstream cost telemetry (D6) when present.
    // Fields are optional; sum only what's reported. The merged gate
    // captures totals at stage level + preserves per-workstream detail
    // inside the workstreams[] array.
    let totalTokensIn = 0, totalTokensOut = 0, totalCost = 0, totalDuration = 0;
    let anyCost = false, anyTokens = false, anyDuration = false;
    for (const w of wsGates) {
      if (typeof w.gate.tokens_in === "number") { totalTokensIn += w.gate.tokens_in; anyTokens = true; }
      if (typeof w.gate.tokens_out === "number") { totalTokensOut += w.gate.tokens_out; }
      if (typeof w.gate.cost_usd === "number") { totalCost += w.gate.cost_usd; anyCost = true; }
      if (typeof w.gate.duration_ms === "number") { totalDuration += w.gate.duration_ms; anyDuration = true; }
    }

    const mergedWarnings = wsGates.flatMap((w) => w.gate.warnings || []);
    // D7: when a workstream gate reports token usage for an unpriced model,
    // budget totals silently under-count. Surface a visible warning so the
    // operator knows enforcement is incomplete for this stage.
    for (const w of wsGates) {
      if (
        typeof w.gate.tokens_in === "number" &&
        typeof w.gate.model === "string" &&
        !pricingFor(w.gate.model)
      ) {
        mergedWarnings.push(`unpriced model ${w.gate.model} — budget enforcement incomplete`);
      }
    }
    const mergedChangesRequested = wsGates.flatMap((w) => {
      const cr = w.gate.changes_requested || [];
      return cr.map((entry) => ({ ...entry, workstream: w.role }));
    });

    // Cross-stage hint: if this is stage-05 peer-review and reviewers requested changes,
    // check whether red-team (stage-04c) already flagged related items as noted_for_followup.
    // Surface a warning so the operator knows to consult stage-04c.json for fix hints.
    if (stageDef.stage === "stage-05" && mergedChangesRequested.length > 0) {
      const redTeamGatePath = path.join(gatesDir, "stage-04c.json");
      if (fs.existsSync(redTeamGatePath)) {
        const { gate: rtGate } = loadGateSafe(redTeamGatePath);
        const ntu = Array.isArray(rtGate && rtGate.noted_for_followup) ? rtGate.noted_for_followup : [];
        if (ntu.length > 0) {
          mergedWarnings.push(
            `[cross-stage] ${ntu.length} red-team item(s) were noted_for_followup at stage-04c ` +
            `and may be driving peer-review objections — consult stage-04c.json for fix hints.`
          );
        }
      }
    }

    const merged = {
      stage: stageDef.stage,
      status: aggregate,
      orchestrator: ORCHESTRATOR_ID,
      // 33.3: the merged stage gate carries its own prompt_pack_version too
      // (unlike dispatched_tool_budget, which is per-role and stays workstream-
      // only) — it's stage-identity information, the same value regardless of
      // which workstream you'd read it from, so a merged gate shouldn't force
      // a reader back to a workstream gate just to learn it.
      prompt_pack_version: computePromptPackVersion(),
      // Fall back to the locally-resolved track when a workstream gate omits
      // it (model forgot the field). Without the fallback, merged.track is
      // undefined and the validator flags a gate the orchestrator itself wrote.
      track: wsGates[0].gate.track ?? track,
      timestamp: new Date().toISOString(),
      // Preserve source workstream on object blockers so recipe routing can use
      // provenance instead of text-regex heuristics (Phase 6.4).
      blockers: wsGates.flatMap((w) => (w.gate.blockers || []).map(b =>
        typeof b === "object" && b !== null && !b.workstream
          ? { ...b, workstream: w.role }
          : b
      )),
      warnings: mergedWarnings,
      changes_requested: mergedChangesRequested,
      workstreams: wsGates.map((w) => {
        const ws = {
          workstream: w.role,
          host: w.host || w.gate.host || null,
          status: w.gate.status,
        };
        // Preserve per-workstream cost data so dashboard.js can attribute
        // tokens/dollars/duration to (host, role) without re-reading the
        // workstream gate files.
        if (typeof w.gate.tokens_in === "number") ws.tokens_in = w.gate.tokens_in;
        if (typeof w.gate.tokens_out === "number") ws.tokens_out = w.gate.tokens_out;
        if (typeof w.gate.cost_usd === "number") ws.cost_usd = w.gate.cost_usd;
        if (typeof w.gate.duration_ms === "number") ws.duration_ms = w.gate.duration_ms;
        if (typeof w.gate.model === "string") ws.model = w.gate.model;
        return ws;
      }),
    };

    // Stage-level totals — only emit when at least one workstream had data.
    if (anyTokens) { merged.tokens_in = totalTokensIn; merged.tokens_out = totalTokensOut; }
    if (anyCost) merged.cost_usd = totalCost;
    if (anyDuration) merged.duration_ms = totalDuration;

    // 31.1: roll any per-role tests_passed self-report into the merged gate so
    // stampStage04Merged (core/verify/stamp.js) — the workspace-global,
    // post-merge authoritative check — has a model claim to compare its
    // observed full-suite result against. true only if every role that made
    // a claim claimed true; absent when no role claimed anything.
    if (stageDef.stage === "stage-04") {
      const testsClaims = wsGates.map((w) => w.gate.tests_passed).filter((v) => typeof v === "boolean");
      if (testsClaims.length > 0) merged.tests_passed = testsClaims.every(Boolean);
    }

    // 31.3: surface the critic's challenges on the merged stage-05 gate.
    // No extra gating logic needed here — the generic aggregate above
    // already flips merged.status to FAIL whenever the critic's own gate
    // is FAIL, and applyCriticVerdict() (core/hooks/approval-derivation.js)
    // sets that FAIL exactly when challenges_resolved is false. This block
    // only makes the reason visible on the merged gate.
    if (stageDef.stage === "stage-05") {
      const criticGate = wsGates.find((w) => w.role === "critic");
      if (criticGate) {
        merged.challenges = Array.isArray(criticGate.gate.challenges) ? criticGate.gate.challenges : [];
        merged.challenges_resolved = criticGate.gate.challenges_resolved !== false;
      }
    }

    const outFile = path.join(gatesDir, `${stageDef.stage}.json`);
    fs.writeFileSync(outFile, JSON.stringify(merged, null, 2) + "\n", "utf8");
    // C6: stamp the tamper-evident chain hash of the predecessor stage gate.
    // Best-effort — a chain-stamp failure must never fail a merge.
    try { require("./gates/chain").stampChain(gatesDir, stageName, track); } catch { /* */ }
    // 5.2: prune per-attempt archives when the merged gate reaches PASS —
    // archives must not outlive the failure sequence they describe. Best-effort.
    if (merged.status === "PASS") {
      try { pruneArchives(gatesDir, stageDef.stage); } catch { /* archiving must never block a merge */ }
    }
    setSpanAttributes({
      "devteam.merge.result": "merged",
      "devteam.merge.status": aggregate,
      "devteam.merge.blockers_count": merged.blockers.length,
      "devteam.merge.warnings_count": merged.warnings.length,
    });
    return { merged: true, file: outFile, gate: merged };
  });
}

// Walk stages in order, inspect gate files in pipeline/gates/, decide
// what the caller should do next. Pure read; never mutates state.
//
// When Stage 7's auto-fold preconditions are met, next() returns the
// "fold-sign-off" action instead of writing the gate itself — it is the
// CALLER's responsibility to persist the gate payload and then call
// next() again. This keeps next() a pure function of disk state.
// (See item 1.2 in plans/phase-1-trust-consolidation.md.)
//
// Returns one of:
//   { action: "run-stage",          stage, name, roles, reason }
//   { action: "continue-stage",     stage, name, completed[], remaining[], reason }
//   { action: "skip-stage",         stage, name, skip_kind, trigger_inputs, reason }
//   { action: "merge",              stage, name, reason }
//   { action: "fix-and-retry",      stage, name, gate, blockers[], reason }
//   { action: "resolve-escalation", stage, name, gate, reason }
//   { action: "fold-sign-off",      stage, name, gate_path, gate_content, acCount, reason }
//   { action: "record-local-deploy", stage, name, gate_path, gate_content, deploy_log_path, deploy_log_content, reason }
//   { action: "pipeline-complete",  reason }
function next(opts = {}) {
  const cwd = opts.cwd || process.cwd();
  const config = opts.config || loadConfig(cwd);
  // B9: resolve changeId for bounded isolation so the read side looks in the
  // same tree that dispatch wrote into (pipeline/changes/<id>/gates/).
  // Accept an explicit changeId (from the driver, which already derived it),
  // or derive it fresh from feature + isolation config (interactive path).
  const isolation = config.pipeline.isolation;
  const changeId = opts.changeId !== undefined
    ? opts.changeId
    : (isolation === "bounded" ? changeIdFromFeature(opts.feature || "") : null);
  const gatesDir = getGatesDir(cwd, changeId);
  // G6: custom_stages in config overrides default_track when no explicit track is passed.
  const track = opts.track
    || (Array.isArray(config.pipeline.custom_stages) ? config.pipeline.custom_stages : null)
    || config.pipeline.default_track
    || "full";
  const skipStages = config.pipeline.skip_stages || [];
  const forceStages = config.pipeline.force_stages || [];
  const stageList = orderedStageNamesForTrack(track);
  const maxRetries = (config.autonomy && Number.isInteger(config.autonomy.max_retries))
    ? config.autonomy.max_retries
    : MAX_RETRIES_DEFAULT;

  return withSpan("pipeline.next", {
    "devteam.track": trackLabel(track),
  }, () => {
    const result = _nextImpl(stageList, gatesDir, track, skipStages, maxRetries, cwd, changeId, {
      auditSkips: opts.auditSkips === true,
      auditedSkips: opts.auditedSkips || [],
      forceStages,
      rightSizing: config.pipeline.right_sizing !== false,
      config,
    });
    setSpanAttributes({
      "devteam.next.action": result.action,
      "devteam.next.stage": result.stage || undefined,
      "devteam.next.name": result.name || undefined,
    });
    return result;
  });
}

// ADR-017 (32.6): wave-aware variant of next(). Same config/track/changeId
// resolution as next() above; returns { actions: [...] } — 1..
// autonomy.max_parallel_stages entries — instead of a single action. A
// result with exactly one entry is byte-identical to calling next() (see
// _nextWaveImpl's doc comment). Callers that don't care about waves (tests,
// `devteam next`, `devteam summary`) should keep using next(); only the
// driver's dispatch loop needs this.
function nextWave(opts = {}) {
  const cwd = opts.cwd || process.cwd();
  const config = opts.config || loadConfig(cwd);
  const isolation = config.pipeline.isolation;
  const changeId = opts.changeId !== undefined
    ? opts.changeId
    : (isolation === "bounded" ? changeIdFromFeature(opts.feature || "") : null);
  const gatesDir = getGatesDir(cwd, changeId);
  const track = opts.track
    || (Array.isArray(config.pipeline.custom_stages) ? config.pipeline.custom_stages : null)
    || config.pipeline.default_track
    || "full";
  const skipStages = config.pipeline.skip_stages || [];
  const forceStages = config.pipeline.force_stages || [];
  const stageList = orderedStageNamesForTrack(track);
  const maxRetries = (config.autonomy && Number.isInteger(config.autonomy.max_retries))
    ? config.autonomy.max_retries
    : MAX_RETRIES_DEFAULT;
  const maxParallelStages = (config.autonomy && Number.isInteger(config.autonomy.max_parallel_stages))
    ? config.autonomy.max_parallel_stages
    : 2;

  return withSpan("pipeline.next-wave", {
    "devteam.track": trackLabel(track),
  }, () => {
    const result = _nextWaveImpl(stageList, gatesDir, track, skipStages, maxRetries, cwd, changeId, {
      auditSkips: opts.auditSkips === true,
      auditedSkips: opts.auditedSkips || [],
      forceStages,
      rightSizing: config.pipeline.right_sizing !== false,
      config,
    }, maxParallelStages);
    setSpanAttributes({
      "devteam.next_wave.actions_count": result.actions.length,
      "devteam.next_wave.first_action": result.actions[0] && result.actions[0].action,
    });
    return result;
  });
}

// Are any of a multi-role stage's per-workstream gates present? Used by
// the auto-fold path to avoid clobbering work the PM/Platform agents
// have already started.
function workstreamGatesExistFor(stageDef, gatesDir) {
  if (stageDef.roles.length <= 1) return false;
  return stageDef.roles.some((role) =>
    fs.existsSync(path.join(gatesDir, `${stageDef.stage}.${role}.json`)),
  );
}

function gitChangedFiles(cwd) {
  const result = spawnSync("git", ["status", "--porcelain", "-z", "--untracked-files=all"], {
    cwd,
    encoding: "utf8",
  });
  if (result.status !== 0) return { ok: false, files: [] };

  const entries = result.stdout.split("\0").filter(Boolean);
  const files = [];
  for (let i = 0; i < entries.length; i++) {
    const entry = entries[i];
    const status = entry.slice(0, 2);
    let file = entry.slice(3);
    if (status.includes("R") || status.includes("C")) {
      file = entries[i + 1] || file;
      i++;
    }
    if (file) files.push(file.replace(/\\/g, "/"));
  }
  return { ok: true, files };
}

function isDocumentationPath(file) {
  return (
    file === "README.md" ||
    file === "CHANGELOG.md" ||
    file.startsWith("docs/") ||
    file.startsWith("changelog.d/") ||
    file.endsWith(".md")
  );
}

function isProcessOnlyPath(file) {
  return (
    file.startsWith("pipeline/") ||
    file.startsWith(".git/") ||
    file.startsWith("tests/") ||
    file.startsWith("test/") ||
    file.includes("/__tests__/") ||
    file.endsWith(".test.js") ||
    file.endsWith(".spec.js")
  );
}

function isUserVisiblePath(file) {
  if (isProcessOnlyPath(file) || isDocumentationPath(file)) return false;
  return (
    file === "package.json" ||
    file === "package-lock.json" ||
    file.startsWith("bin/") ||
    file.startsWith("core/cli/") ||
    file.startsWith("src/") ||
    file.startsWith("app/") ||
    file.startsWith("pages/") ||
    file.startsWith("routes/") ||
    file.startsWith("api/") ||
    file.startsWith("server/") ||
    file.startsWith("public/") ||
    /(^|\/)(openapi|swagger|schema)\.(ya?ml|json)$/i.test(file)
  );
}

function classifyDocumentationGate(cwd) {
  const changed = gitChangedFiles(cwd);
  if (!changed.ok) {
    return {
      docs_surface_affected: false,
      docs_updated: null,
      docs_skipped_reason: "git status unavailable; auto-fold found no reviewable changed-file surface",
      changed_files: [],
      surface_files: [],
      doc_files: [],
    };
  }

  const files = changed.files.filter((file) => !isProcessOnlyPath(file));
  const surfaceFiles = files.filter(isUserVisiblePath);
  const docFiles = files.filter(isDocumentationPath);
  if (surfaceFiles.length === 0) {
    return {
      docs_surface_affected: false,
      docs_updated: null,
      docs_skipped_reason: files.length === 0
        ? "no changed files detected outside pipeline artifacts"
        : "changed files are internal-only or documentation-only",
      changed_files: files,
      surface_files: [],
      doc_files: docFiles,
    };
  }

  return {
    docs_surface_affected: true,
    docs_updated: docFiles.length > 0,
    docs_skipped_reason: null,
    changed_files: files,
    surface_files: surfaceFiles,
    doc_files: docFiles,
  };
}

// Stage 7 auto-fold. Pure function — returns { ok: false, reason } on
// any precondition failure, or { ok: true, gate, acCount } on success.
// Does NOT write any file; the caller is responsible for persisting the
// returned gate object (see _nextImpl → "fold-sign-off" action).
//
// Preconditions verified by the orchestrator itself (no model trust):
//   1. stage-06.json exists and PASSed
//   2. brief.md has at least one AC-N entry
//   3. test-report.md exists
//   4. every AC-N in brief.md is mentioned in test-report.md
//
// changeId (B9): when non-null, brief.md / test-report.md / runbook.md are
// resolved under pipeline/changes/<changeId>/ via pipelineRoot().
function tryAutoFoldSignOff(cwd, gatesDir, track, changeId) {
  const stage06Path = path.join(gatesDir, "stage-06.json");
  if (!fs.existsSync(stage06Path)) {
    return { ok: false, reason: "stage-06 gate missing" };
  }
  const { gate: stage06, error: stage06Err } = loadGateSafe(stage06Path);
  if (stage06Err) return { ok: false, reason: `stage-06 unreadable: ${stage06Err}` };
  if (stage06.status !== "PASS") {
    return { ok: false, reason: `stage-06 status is ${stage06.status}, not PASS` };
  }

  // Re-verify the AC→test mapping ourselves. The QA agent may have
  // claimed all_acceptance_criteria_met: true; we check.
  // B9: use pipelineRoot() so bounded-mode runs look under
  // pipeline/changes/<changeId>/ instead of the global pipeline/.
  const { extractAcsFromBrief, extractAcsFromReport } = require("./verify/stamp");
  const root = pipelineRoot(cwd, changeId);
  const briefPath = path.join(root, "brief.md");
  const reportPath = path.join(root, "test-report.md");
  if (!fs.existsSync(briefPath)) {
    return { ok: false, reason: "pipeline/brief.md missing (auto-fold needs a brief with AC-N entries)" };
  }
  if (!fs.existsSync(reportPath)) {
    return { ok: false, reason: "pipeline/test-report.md missing" };
  }
  const briefAcs = extractAcsFromBrief(fs.readFileSync(briefPath, "utf8"));
  if (briefAcs.length === 0) {
    return { ok: false, reason: "brief.md has no AC-N entries — auto-fold requires explicit criteria" };
  }
  const reportAcs = new Set(extractAcsFromReport(fs.readFileSync(reportPath, "utf8")));
  const unmapped = briefAcs.filter((ac) => !reportAcs.has(ac));
  if (unmapped.length > 0) {
    return { ok: false, reason: `unmapped AC(s): ${unmapped.join(", ")}` };
  }

  // 1:1 mapping claim. We've already confirmed every AC is mentioned in
  // the report; the QA agent's `criterion_to_test_mapping_is_one_to_one`
  // is an additional uniqueness claim we can't fully verify without
  // parsing the AC|Test table structurally. Trust the gate field here —
  // mis-claiming 1:1 when it isn't is a Stage 5 reviewer concern.
  if (stage06.criterion_to_test_mapping_is_one_to_one !== true) {
    return { ok: false, reason: "stage-06 criterion_to_test_mapping_is_one_to_one is not true" };
  }

  const runbookPath = path.join(root, "runbook.md");
  if (!fs.existsSync(runbookPath)) {
    return {
      ok: false,
      reason: "pipeline/runbook.md missing — platform must author it during Stage 7 sign-off before auto-fold can proceed",
    };
  }
  const docsGate = classifyDocumentationGate(cwd);
  if (docsGate.docs_surface_affected && docsGate.docs_updated !== true) {
    return {
      ok: false,
      reason: `documentation gate requires PM confirmation for user-visible files: ${docsGate.surface_files.join(", ")}`,
    };
  }

  const gate = {
    stage: "stage-07",
    status: "PASS",
    orchestrator: ORCHESTRATOR_ID,
    track,
    timestamp: new Date().toISOString(),
    blockers: [],
    warnings: [],
    pm_signoff: true,
    deploy_requested: true,
    runbook_referenced: true,
    docs_surface_affected: docsGate.docs_surface_affected,
    docs_updated: docsGate.docs_updated,
    docs_skipped_reason: docsGate.docs_skipped_reason,
    docs_gate: {
      changed_files: docsGate.changed_files,
      surface_files: docsGate.surface_files,
      doc_files: docsGate.doc_files,
    },
    auto_from_stage_06: true,
    auto_fold: {
      ac_count: briefAcs.length,
      criteria: briefAcs,
      stamped_at: new Date().toISOString(),
      stamper: `devteam@${require("../package.json").version}`,
    },
  };
  // No fs.writeFileSync here — caller writes via the "fold-sign-off" action.
  return { ok: true, gate, acCount: briefAcs.length };
}

function renderLocalNoDeployLog(stage07, runbookExists) {
  return [
    "# Deploy Log",
    "",
    `**Date**: ${new Date().toISOString()}`,
    "**Method**: local — no external deploy",
    runbookExists
      ? "**Runbook**: pipeline/runbook.md §Rollback"
      : "**Runbook**: not present; no external deploy was performed",
    "",
    "## Local verification",
    "Stage 7 recorded `deploy_requested: false`; Stage 8 did not dispatch an external deploy adapter.",
    "",
    "## External deploy",
    "Not performed. Stage 7 explicitly requested no external deploy.",
    "",
    "## Sign-off source",
    `Stage 7 status: ${stage07.status}`,
    "Deploy requested: false",
    "",
    "## Recovery procedure",
    runbookExists
      ? "See runbook §Rollback."
      : "No external environment was changed.",
    "",
  ].join("\n");
}

// Stage 8 deterministic local record. When Stage 7 explicitly says
// deploy_requested:false, there is no deploy decision for a model to make:
// record that no external deploy happened and advance. Pure function; caller
// persists deploy_log_content and gate_content.
function tryAutoLocalDeployRecord(cwd, gatesDir, track, changeId) {
  const stage07Path = path.join(gatesDir, "stage-07.json");
  if (!fs.existsSync(stage07Path)) return { ok: false, reason: "stage-07 gate missing" };
  const { gate: stage07, error } = loadGateSafe(stage07Path);
  if (error) return { ok: false, reason: `stage-07 unreadable: ${error}` };
  if (stage07.status !== "PASS" && stage07.status !== "WARN") {
    return { ok: false, reason: `stage-07 status is ${stage07.status}, not PASS/WARN` };
  }
  if (stage07.pm_signoff !== true) {
    return { ok: false, reason: "stage-07 pm_signoff is not true" };
  }
  if (stage07.deploy_requested !== false) {
    return { ok: false, reason: "stage-07 deploy_requested is not false" };
  }

  const root = pipelineRoot(cwd, changeId);
  const runbookPath = path.join(root, "runbook.md");
  const runbookExists = fs.existsSync(runbookPath);
  const gate = {
    stage: "stage-08",
    status: "PASS",
    orchestrator: ORCHESTRATOR_ID,
    track,
    timestamp: new Date().toISOString(),
    blockers: [],
    warnings: [
      "Stage 7 requested no external deploy; local verification only.",
    ],
    deploy_completed: true,
    smoke_tests_passed: true,
    rollback_executed: false,
    deploy_adapter: "local",
    environment: "local",
    runbook_referenced: runbookExists,
    cost_delta_estimated: true,
    cost_delta_multiplier: 1,
    cost_gate_override: false,
    adapter_result: {
      deploy_requested: false,
      external_deploy: false,
      reason: "stage-07 deploy_requested false",
      smoke_command: null,
      smoke_exit_code: null,
    },
    auto_from_stage_07: true,
  };
  return {
    ok: true,
    gate,
    deployLog: renderLocalNoDeployLog(stage07, runbookExists),
  };
}

// ─────────────────────────────────────────────────────────────────────────────

// B9: cwd and changeId are threaded through so tryAutoFoldSignOff can
// resolve brief.md / test-report.md / runbook.md under the correct
// pipeline root (bounded: pipeline/changes/<changeId>/; in-place: pipeline/).
// Previously cwd was derived from gatesDir via path.resolve("..", ".."), which
// was wrong in bounded mode (gatesDir is .../pipeline/changes/<id>/gates/).
// ADR-017 (32.6): the single-stage readiness/action check, extracted out of
// _nextImpl's loop body so a wave-aware caller can invoke it directly for an
// out-of-order `dependsOn` candidate instead of only ever walking stageList
// from the top. Pure function of disk state + ctx; returns the action this
// stage would produce if it were the loop's current position, or null to mean
// "this stage is done/skipped — a sequential caller should continue past it."
// _nextImpl below is now a thin loop over this; behavior is unchanged from
// before this extraction (verified by the full existing test suite).
function evaluateStageInPipeline(stageName, ctx) {
  const { gatesDir, track, stageList, skipStages, forceStages, rightSizingEnabled, auditSkips, auditedSkips, maxRetries, cwd, changeId, opts } = ctx;
  const stageDef = getStage(stageName);
  const stageGatePath = path.join(gatesDir, `${stageDef.stage}.json`);

  // Explicitly skipped via pipeline.skip_stages in config.
  if (skipStages.includes(stageName) && !forceStages.has(stageName)) {
    if (auditSkips && !auditedSkips.has(stageName)) {
      return {
        action: "skip-stage",
        stage: stageDef.stage,
        name: stageName,
        skip_kind: "pipeline.skip_stages",
        trigger_inputs: {
          skip_stages: skipStages,
          force_stages: Array.from(forceStages),
        },
        reason: "stage listed in pipeline.skip_stages",
        command: "devteam next",
      };
    }
    return null;
  }

  if (rightSizingEnabled
      && !forceStages.has(stageName)
      && !fs.existsSync(stageGatePath)
      && !workstreamGatesExistFor(stageDef, gatesDir)) {
    const rightSized = deterministicSkipForStage(stageName, cwd, { changeId });
    if (rightSized) {
      if (auditSkips && !auditedSkips.has(stageName)) {
        return {
          action: "skip-stage",
          stage: stageDef.stage,
          name: stageName,
          skip_kind: rightSized.skip_kind,
          trigger_inputs: {
            ...rightSized.trigger_inputs,
            force_stages: Array.from(forceStages),
          },
          reason: rightSized.reason,
          command: "devteam next",
        };
      }
      return null;
    }
  }

  // Stage 7 auto-fold. When Stage 6 cleanly satisfies the AC→test
  // contract, return a "fold-sign-off" action carrying the gate content.
  // The CALLER writes the gate and calls next() again — keeping this a
  // pure function of disk state. (item 1.2, phase-1-trust-consolidation)
  // Verified — not trusted: we re-derive the AC list from brief.md and
  // the AC→test mapping from test-report.md ourselves, rather than
  // rubber-stamping the QA agent's claim.
  // See docs/concepts.md → "Auto-fold (Stage 7)" for the rationale.
  if (stageName === "sign-off"
      && !fs.existsSync(stageGatePath)
      && !workstreamGatesExistFor(stageDef, gatesDir)) {
    const folded = tryAutoFoldSignOff(cwd, gatesDir, track, changeId);
    if (folded.ok) {
      // Return fold-sign-off so the caller writes the gate and re-runs
      // next(). Do NOT fall through here — stageGatePath doesn't exist
      // yet; the caller must persist the gate before calling next().
      return {
        action: "fold-sign-off",
        stage: stageDef.stage,
        name: stageName,
        gate_path: stageGatePath,
        gate_content: folded.gate,
        acCount: folded.acCount,
        reason: `stage 6 satisfied the AC→test contract (${folded.acCount} criteria mapped)`,
      };
    }
  }

  if (stageName === "deploy"
      && !fs.existsSync(stageGatePath)
      && !workstreamGatesExistFor(stageDef, gatesDir)) {
    const recorded = tryAutoLocalDeployRecord(cwd, gatesDir, track, changeId);
    if (recorded.ok) {
      const deployLogPath = path.join(pipelineRoot(cwd, changeId), "deploy-log.md");
      return {
        action: "record-local-deploy",
        stage: stageDef.stage,
        name: stageName,
        gate_path: stageGatePath,
        gate_content: recorded.gate,
        deploy_log_path: deployLogPath,
        deploy_log_content: recorded.deployLog,
        reason: "stage 7 requested no external deploy; recording local/no-deploy outcome",
      };
    }
  }

  // Conditional stages: skip when the prerequisite gate's named field
  // is not equal to the required value. The prerequisite gate must
  // already exist — if it doesn't, the pipeline would be advancing
  // out of order, so we surface that as needing the prerequisite first.
  if (stageDef.conditionalOn) {
    const c = stageDef.conditionalOn;
    const prereqGatePath = path.join(gatesDir, `${c.stage}.json`);
    if (!fs.existsSync(prereqGatePath)) {
      // Prereq not done yet; a sequential scan's earlier iteration should
      // have returned for it. If we got here, fall through to normal
      // run-stage handling — but flag the issue.
    } else {
      const { gate: prereq, error } = loadGateSafe(prereqGatePath);
      if (error) {
        return {
          action: "fix-and-retry", stage: stageDef.stage, name: stageName,
          gate: prereqGatePath,
          failure_class: "state-corruption",
          blockers: [`prereq gate is unreadable: ${error}`],
          reason: "cannot evaluate conditional stage — fix the prereq gate file",
          command: `cat ${prereqGatePath}  # then repair or rewrite`,
        };
      }
      if (prereq[c.field] !== c.equals && !forceStages.has(stageName)) {
        if (auditSkips && !auditedSkips.has(stageName)) {
          return {
            action: "skip-stage",
            stage: stageDef.stage,
            name: stageName,
            skip_kind: "conditionalOn",
            trigger_inputs: {
              prerequisite_stage: c.stage,
              field: c.field,
              expected: c.equals,
              actual: prereq[c.field],
              force_stages: Array.from(forceStages),
            },
            reason: `condition not met: ${c.stage}.${c.field} !== ${c.equals}`,
            command: "devteam next",
          };
        }
        return null; // condition not met — skip this stage silently
      }
    }
  }

  if (!fs.existsSync(stageGatePath)) {
    if (stageDef.roles.length > 1) {
      // 31.3: a multi-role stage's actual dispatched roles can vary by track
      // or config — stage-05's review.mode (adversarial dispatches
      // ["reviewer","critic"], not the static 4-area stageDef.roles) and,
      // identically, stage-04 (build) on the loop track (a single
      // config-overridable workstream, not the four-role matrix). This was
      // scoped to `stageDef.stage === "stage-05"` only — a real loop-track
      // devteam run hit the stage-04 case: `next()` reported "1/4
      // workstreams complete... remaining: frontend, platform, qa" for a
      // build stage that only ever dispatches backend on this track, so
      // `remaining` could never empty out and the run stalled forever.
      // rolesForStage() falls back to stageDef.roles for every stage/track
      // it doesn't special-case, so calling it unconditionally is a strict
      // superset — behavior for every other stage is unchanged.
      const baseRoles = rolesForStage(stageDef, track, opts.config);
      // Apply active_roles filter: only expect gates for roles that were
      // actually dispatched. Without this, a suppressed role (e.g. frontend
      // when active_roles=[backend,platform,qa]) keeps `remaining` non-empty
      // forever and the driver loops until max-iterations is exhausted.
      let effectiveRoles = baseRoles;
      const s1Path = path.join(gatesDir, "stage-01.json");
      if (fs.existsSync(s1Path)) {
        const { gate: s1Gate } = loadGateSafe(s1Path);
        if (s1Gate) {
          const filtered = inferActiveRoles(s1Gate, baseRoles, stageDef.alwaysDispatch, loadFileOwnership(gatesDir));
          if (filtered) effectiveRoles = filtered;
        }
      }
      const completed = [];
      const remaining = [];
      for (const role of effectiveRoles) {
        const p = path.join(gatesDir, `${stageDef.stage}.${role}.json`);
        (fs.existsSync(p) ? completed : remaining).push(role);
      }
      if (remaining.length === 0) {
        return {
          action: "merge", stage: stageDef.stage, name: stageName,
          reason: "all workstreams complete; merge to produce stage gate",
          command: `devteam merge ${stageName}`,
        };
      }
      if (completed.length === 0) {
        return {
          action: "run-stage", stage: stageDef.stage, name: stageName,
          roles: effectiveRoles,
          reason: "multi-role stage not started",
          command: `devteam stage ${stageName}`,
        };
      }
      return {
        action: "continue-stage", stage: stageDef.stage, name: stageName,
        completed, remaining,
        reason: `${completed.length}/${effectiveRoles.length} workstreams complete`,
        command: `devteam stage ${stageName}  # roles still pending: ${remaining.join(", ")}`,
      };
    }
    return {
      action: "run-stage", stage: stageDef.stage, name: stageName,
      roles: stageDef.roles,
      reason: "stage not started",
      command: `devteam stage ${stageName}`,
    };
  }

  const { gate, error: gateError } = loadGateSafe(stageGatePath);
  if (gateError) {
    return {
      action: "fix-and-retry", stage: stageDef.stage, name: stageName,
      gate: stageGatePath,
      failure_class: "state-corruption",
      blockers: [`gate file is unreadable: ${gateError}`],
      reason: "cannot determine stage status — fix or rewrite the gate file",
      command: `cat ${stageGatePath}  # then repair or rewrite`,
    };
  }
  // The fix-and-retry/resolve-escalation machinery below (both the FAIL
  // branch's retry ceiling and the ESCALATE branch just below it) assumes a
  // build stage sits between attempts — the same agent sees *different*
  // code next time because something acted on its blockers. review-only and
  // review-pr have no build stage at all, for *any* of their stages (they
  // exist to review code the pipeline never touches — `devteam review`/
  // `devteam review-pr`) — not just peer-review; security-review and
  // red-team hit the identical wall, re-dispatching the same agent against
  // the same, unchanged code and reproducing the same must-fix findings.
  // Retrying only delays the outcome by a full retryDelayMs per attempt, and
  // escalating asks a human to rule on someone else's code the review was
  // never going to change anyway. A stage that recognizes non-convergence
  // may write ESCALATE directly (rather than a plain FAIL) — same
  // underlying situation, so it gets the same treatment here. The finding
  // itself *is* the review's output — core/report/collect-findings.js
  // already reads it straight from the gate's blockers/must_address_*
  // fields and any by-*.md CHANGES_REQUESTED content, independent of what
  // next() recommends here — so in a track with no build stage for this
  // stage to depend on, FAIL/ESCALATE is terminal for every stage in it:
  // stop advising further action, exactly like PASS/WARN. The gate file
  // itself is untouched — still genuinely FAIL/ESCALATE for anything that
  // reads it directly (`devteam validate`, etc.) — only the orchestration
  // decision changes.
  if (!stageList.includes("build") && (gate.status === "FAIL" || gate.status === "ESCALATE")) {
    return null;
  }
  if (gate.status === "ESCALATE") {
    return {
      action: "resolve-escalation", stage: stageDef.stage, name: stageName,
      gate: stageGatePath,
      failure_class: "judgment-gate",
      reason: gate.escalation_reason || "escalation required; pipeline halted",
      command: `devteam ruling --topic "..." --target-gate ${stageGatePath} [--headless]`,
    };
  }
  if (gate.status === "FAIL") {
    const { clear_gates, steps: fix_steps } = getRecipe(stageDef.stage).diagnose(gate, { gatesDir, stageDef, stageList, changeId });

    // Convergence ceiling (ADR-003 / H1 + 4.2).
    //
    // Use archive-based attempt count (agent-independent) instead of the
    // model-written gate.retry_number — removes an agent-falsifiable input
    // from the convergence decision on the interactive path (4.2 spec).
    //
    // Progress-based check runs first: if the last two archived attempts carry
    // identical non-empty blocker sets the breaker trips immediately, even
    // before the count ceiling is reached. This catches a stuck agent that
    // keeps writing the same FAIL without making forward progress.
    const archiveCount = countArchivedAttempts(gatesDir, stageDef.stage);
    const progress = detectNoProgress(gatesDir, stageDef.stage);
    if (progress.noProgress) {
      const evidence = noProgressEvidence(progress.stuckBlockers, progress.attempts);
      return {
        action: "resolve-escalation", stage: stageDef.stage, name: stageName,
        gate: stageGatePath,
        failure_class: "convergence-exhausted",
        blockers: gate.blockers || [],
        no_progress_evidence: evidence,
        reason: `no-progress convergence: ${evidence}; escalating for a ruling`,
        command: `devteam ruling --topic "..." --target-gate ${stageGatePath} [--headless]`,
      };
    }
    if (archiveCount >= maxRetries) {
      return {
        action: "resolve-escalation", stage: stageDef.stage, name: stageName,
        gate: stageGatePath,
        failure_class: "convergence-exhausted",
        blockers: gate.blockers || [],
        reason: `retry budget exhausted (${archiveCount}/${maxRetries} attempts); escalating for a ruling`,
        command: `devteam ruling --topic "..." --target-gate ${stageGatePath} [--headless]`,
      };
    }

    return {
      action: "fix-and-retry", stage: stageDef.stage, name: stageName,
      gate: stageGatePath,
      failure_class: classifyGate(gate, fix_steps),
      blockers: gate.blockers || [],
      reason: "stage failed; address blockers and rewrite the gate",
      command: `devteam stage ${stageName}`,
      ...(fix_steps ? { fix_steps } : {}),
      ...(clear_gates.length ? { clear_gates } : {}),
    };
  }
  // PASS or WARN — proceed to next stage.
  return null;
}

function _stageEvalCtx(stageList, gatesDir, track, skipStages, maxRetries, cwd, changeId, opts) {
  return {
    stageList, gatesDir, track, cwd, changeId,
    skipStages,
    forceStages: new Set(opts.forceStages || []),
    rightSizingEnabled: opts.rightSizing !== false,
    auditSkips: opts.auditSkips === true,
    auditedSkips: new Set(opts.auditedSkips || []),
    maxRetries,
    opts,
  };
}

function _nextImpl(stageList, gatesDir, track, skipStages = [], maxRetries = MAX_RETRIES_DEFAULT, cwd, changeId, opts = {}) {
  const ctx = _stageEvalCtx(stageList, gatesDir, track, skipStages, maxRetries, cwd, changeId, opts);
  for (const stageName of stageList) {
    const action = evaluateStageInPipeline(stageName, ctx);
    if (action) return action;
  }
  return { action: "pipeline-complete", reason: `no stage requires further action (track: ${track})`, track };
}

// ADR-017 §1-2 (32.6): a stage is "ready" out of declared order only via an
// explicit `dependsOn` — every named dependency must hold a PASS/WARN gate.
// Stages with no `dependsOn` are never candidates here; they're only ever
// discovered as the sequential-scan's first action (see _nextWaveImpl below).
function dependsOnSatisfied(stageDef, gatesDir) {
  if (!Array.isArray(stageDef.dependsOn) || stageDef.dependsOn.length === 0) return true;
  return stageDef.dependsOn.every((depName) => {
    const depDef = getStage(depName);
    if (!depDef) return false;
    const depGatePath = path.join(gatesDir, `${depDef.stage}.json`);
    if (!fs.existsSync(depGatePath)) return false;
    const { gate } = loadGateSafe(depGatePath);
    return !!gate && (gate.status === "PASS" || gate.status === "WARN");
  });
}

// Action types that represent a real LLM dispatch (or a retry of one) — the
// only kinds of action a wave ever bundles together. Everything else
// (merge, skip-stage, resolve-escalation, fold-sign-off, record-local-deploy,
// pipeline-complete) is synchronous/orchestrator-only and always collapses a
// wave back down to its single-member (pre-017) behavior.
const WAVE_DISPATCH_ACTIONS = new Set(["run-stage", "continue-stage", "fix-and-retry"]);

// ADR-017 §2 (32.6): wave-aware ready-set computation. A thin wrapper around
// evaluateStageInPipeline (the exact same single-stage readiness check
// _nextImpl uses) — not a parallel reimplementation. Returns
// { actions: [...] }, 1..maxParallelStages entries, in declared
// STAGES-table order. The first entry is always exactly what _nextImpl would
// have returned (same sequential scan) — a size-1 result here is therefore
// byte-identical to calling _nextImpl directly.
function _nextWaveImpl(stageList, gatesDir, track, skipStages, maxRetries, cwd, changeId, opts, maxParallelStages) {
  const ctx = _stageEvalCtx(stageList, gatesDir, track, skipStages, maxRetries, cwd, changeId, opts);

  let first = null;
  for (const stageName of stageList) {
    const action = evaluateStageInPipeline(stageName, ctx);
    if (action) { first = action; break; }
  }
  if (!first) {
    return { actions: [{ action: "pipeline-complete", reason: `no stage requires further action (track: ${track})`, track }] };
  }

  const cap = Number.isInteger(maxParallelStages) && maxParallelStages > 0 ? maxParallelStages : 1;
  if (cap <= 1 || !WAVE_DISPATCH_ACTIONS.has(first.action)) {
    return { actions: [first] };
  }

  const actions = [first];
  for (const stageName of stageList) {
    if (actions.length >= cap) break;
    if (stageName === first.name) continue;
    const stageDef = getStage(stageName);
    if (!Array.isArray(stageDef.dependsOn) || stageDef.dependsOn.length === 0) continue;
    if (!dependsOnSatisfied(stageDef, gatesDir)) continue;
    const action = evaluateStageInPipeline(stageName, ctx);
    if (!action || !WAVE_DISPATCH_ACTIONS.has(action.action)) continue;
    actions.push(action);
  }
  return { actions };
}

// One-screen pipeline state for `devteam summary`. Walks the active
// track's stage list, classifies each stage as one of:
//   - pass    : merged stage gate exists with status PASS or WARN
//   - warn    : merged stage gate exists with status WARN
//   - fail    : merged stage gate exists with status FAIL
//   - escalate: merged stage gate exists with status ESCALATE
//   - partial : multi-role stage with some workstream gates but no merge
//   - skipped : conditional stage whose condition is not met
//   - pending : nothing on disk yet
// For multi-role stages, includes per-workstream rows.
function summary(opts = {}) {
  const cwd = opts.cwd || process.cwd();
  const config = opts.config || loadConfig(cwd);
  // B9: resolve changeId for bounded isolation — same logic as next().
  const isolation = config.pipeline.isolation;
  const changeId = opts.changeId !== undefined
    ? opts.changeId
    : (isolation === "bounded" ? changeIdFromFeature(opts.feature || "") : null);
  const gatesDir = getGatesDir(cwd, changeId);
  // G6: custom_stages in config overrides default_track when no explicit track is passed.
  const track = opts.track
    || (Array.isArray(config.pipeline.custom_stages) ? config.pipeline.custom_stages : null)
    || config.pipeline.default_track
    || "full";
  const skipStages = config.pipeline.skip_stages || [];
  const forceStages = new Set(config.pipeline.force_stages || []);
  const stageList = orderedStageNamesForTrack(track);

  const rows = [];

  function readJSONSafe(file) {
    try { return JSON.parse(fs.readFileSync(file, "utf8")); } catch { return null; }
  }

  for (const stageName of stageList) {
    const stageDef = getStage(stageName);
    const stageGatePath = path.join(gatesDir, `${stageDef.stage}.json`);

    // Explicitly skipped via pipeline.skip_stages.
    if (skipStages.includes(stageName) && !forceStages.has(stageName)) {
      rows.push({ stage: stageDef.stage, name: stageName, state: "skipped", reason: "pipeline.skip_stages" });
      continue;
    }

    // Check conditional first
    if (stageDef.conditionalOn) {
      const c = stageDef.conditionalOn;
      const prereqGatePath = path.join(gatesDir, `${c.stage}.json`);
      if (fs.existsSync(prereqGatePath)) {
        const prereq = readJSONSafe(prereqGatePath);
        if (prereq && prereq[c.field] !== c.equals && !forceStages.has(stageName)) {
          rows.push({
            stage: stageDef.stage,
            name: stageName,
            state: "skipped",
            reason: `condition not met: ${c.stage}.${c.field} !== ${c.equals}`,
          });
          continue;
        }
      }
    }

    if (fs.existsSync(stageGatePath)) {
      const gate = readJSONSafe(stageGatePath);
      // Fix 1.7.1: guard against a valid-JSON gate missing the `status` field.
      // gate.status.toLowerCase() would throw TypeError — use the
      // (gate.status || "unknown").toLowerCase() pattern so summary() survives
      // incomplete or partially-written gates.
      // (plans/phase-1-trust-consolidation.md item 1.7 fix 1)
      const state = gate ? (gate.status || "unknown").toLowerCase() : "pending";
      const row = { stage: stageDef.stage, name: stageName, state, timestamp: gate && gate.timestamp };
      if (gate && Array.isArray(gate.workstreams) && gate.workstreams.length > 0) {
        row.workstreams = gate.workstreams.map((w) => ({ role: w.workstream, host: w.host, state: (w.status || "unknown").toLowerCase() }));
      }
      if (gate && Array.isArray(gate.warnings) && gate.warnings.length > 0) row.warnings = gate.warnings;
      if (gate && Array.isArray(gate.blockers) && gate.blockers.length > 0) row.blockers = gate.blockers;
      rows.push(row);
      continue;
    }

    // No stage gate. Multi-role: check per-workstream gates.
    if (stageDef.roles.length > 1) {
      // rolesForStage(): see the why-comment in _nextImpl's identical
      // completed/remaining computation above — same bug, same fix, this
      // time in the status-summary path rather than the driving decision.
      const baseRoles = rolesForStage(stageDef, track, config);
      // Apply active_roles filter so suppressed workstreams don't show as pending.
      let effectiveRoles = baseRoles;
      const s1Path = path.join(gatesDir, "stage-01.json");
      if (fs.existsSync(s1Path)) {
        const s1Data = readJSONSafe(s1Path);
        if (s1Data) {
          const filtered = inferActiveRoles(s1Data, baseRoles, undefined, loadFileOwnership(gatesDir));
          if (filtered) effectiveRoles = filtered;
        }
      }
      const completed = [];
      const remaining = [];
      for (const role of effectiveRoles) {
        const p = path.join(gatesDir, `${stageDef.stage}.${role}.json`);
        if (fs.existsSync(p)) {
          const g = readJSONSafe(p);
          completed.push({ role, host: g && g.host, state: g && g.status ? g.status.toLowerCase() : "pending" });
        } else {
          remaining.push(role);
        }
      }
      if (completed.length === 0) {
        rows.push({ stage: stageDef.stage, name: stageName, state: "pending" });
      } else {
        rows.push({
          stage: stageDef.stage, name: stageName, state: "partial",
          workstreams: completed,
          remaining,
        });
      }
      continue;
    }

    rows.push({ stage: stageDef.stage, name: stageName, state: "pending" });
  }

  return { track, rows };
}

function rolesPath() {
  return path.join(PROJECT_ROOT, "roles");
}

function templatesPath() {
  return path.join(PROJECT_ROOT, ".devteam", "templates");
}

module.exports = {
  runStage,
  runStageHeadless,
  mergeWorkstreamGates,
  next,
  nextWave,
  summary,
  buildDescriptor,
  computeDispatchPlan,
  dispatchWavesFor,
  renderOmnigentDirectorPrompt,
  patchGateForUnpricedModel,
  patchGateForObservedUsage,
  patchGateForEstimatedUsage,
  patchGateWithRequestedModel,
  patchGateWithPromptPackVersion,
  ORCHESTRATOR_ID,
  rolesPath,
  templatesPath,
  PROJECT_ROOT,
};
