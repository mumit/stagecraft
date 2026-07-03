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
const { spawnSync } = require("node:child_process");
const { STAGES, getStage, orderedStageNamesForTrack, isStageInTrack, rolesForStage, trackLabel } = require("./pipeline/stages");
const { loadConfig, changeIdFromFeature } = require("./config");
const { gatesDir: getGatesDir, logsDir: getLogsDir, pipelineRoot, prefixPipelineRelative } = require("./paths");
const { resolveAdapter } = require("./router");
const { withSpan, setSpanAttributes } = require("./observability");
const { loadGateSafe } = require("./gates/load-gate");
const { classifyGate, MAX_RETRIES_DEFAULT } = require("./gates/classify");
const { pricingFor } = require("./pricing");
const { getRecipe } = require("./pipeline/fix-recipes");
const { deterministicSkipForStage } = require("./pipeline/right-sizing");
const { collectChangedFileManifest } = require("./context-manifest");
const { detectNoProgress, countArchivedAttempts, noProgressEvidence } = require("./gates/convergence");
const { archiveGateIfFail, pruneArchives } = require("./gates/archive");
const { isAllowed } = require("./guards/write-audit");
const { hostConcurrencyLimit, mapByHostConcurrency } = require("./scheduler");

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

function inferActiveRoles(stage01Gate, allRoles, alwaysDispatch) {
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
  return suppressed.size === 0 ? null : allRoles.filter(r => !suppressed.has(r));
}

function computeDispatchPlan(stageDef, config, track, opts = {}) {
  const fanout = (config && config.routing && Array.isArray(config.routing.review_fanout))
    ? config.routing.review_fanout
    : [];
  const isPeerReview = stageDef.stage === "stage-05" && fanout.length > 0;
  // Track-aware roles. Today only stage-05 (peer-review) varies — nano
  // dispatches a single reviewer; every other track uses the standard
  // four-area matrix. rolesForStage falls back to stageDef.roles for
  // every other stage.
  const effectiveTrack = track || (config && config.pipeline && config.pipeline.default_track) || "full";
  let roles = rolesForStage(stageDef, effectiveTrack);

  // Apply active_roles filter from stage-01 gate when gatesDir is available.
  // The filter covers all stages so peer-review areas match the build workstreams
  // that actually ran — no phantom reviewer areas for excluded workstreams.
  if (opts.gatesDir) {
    const s1Path = path.join(opts.gatesDir, "stage-01.json");
    if (fs.existsSync(s1Path)) {
      const { gate } = loadGateSafe(s1Path);
      if (gate) {
        const filtered = inferActiveRoles(gate, roles, stageDef.alwaysDispatch);
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

function buildDescriptor(stageDef, role, opts = {}) {
  // ADR-009 Phase 2: when intent === "repair" and the stage declares a
  // repairOverride, merge override fields on top of the base stage definition.
  // This swaps stage-01's objective/artifact/template/gate to a diagnosis
  // shape — same stage id, same gate path, fix-aware artifact. No new stage.
  const override = (opts.intent === "repair" && stageDef.repairOverride) ? stageDef.repairOverride : null;
  const effectiveDef = override ? { ...stageDef, ...override } : stageDef;

  const allowedWrites = effectiveDef.roleWrites?.[role] ?? effectiveDef.allowedWrites;
  const wsId = opts.workstreamId || workstreamId(stageDef.stage, role, stageDef.roles.length);
  const changeId = opts.changeId || null;
  const prefix = (p) => prefixPipelineRelative(p, changeId);
  return {
    stage: stageDef.stage,
    name: nameForStage(stageDef.stage),
    role,
    rolesInStage: stageDef.roles,
    workstreamId: wsId,
    objective: effectiveDef.objective,
    readFirst: Array.isArray(effectiveDef.readFirst)
      ? effectiveDef.readFirst.map((item) =>
          typeof item === "object" && item.optional
            ? `${prefix(item.path)} (if present)`
            : prefix(item),
        )
      : effectiveDef.readFirst,
    allowedWrites: Array.isArray(allowedWrites) ? allowedWrites.map(prefix) : allowedWrites,
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
    // When set, all workstreams of this stage dispatch to the same
    // subagent regardless of role (used by peer-review where the
    // workstreams are areas being reviewed but the dispatched agent
    // is always the reviewer). Adapters honor this in renderStagePrompt.
    subagent: stageDef.subagent,
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
    const dispatches = effectivePlan.map((entry) => withSpan("pipeline.workstream", {
      "devteam.stage": stageDef.stage,
      "devteam.workstream.role": entry.role,
      "devteam.workstream.id": entry.workstreamId,
    }, () => {
      // For fanout entries the host is fixed by the fanout list; for
      // normal entries the router resolves via precedence.
      let hostName, adapter;
      if (entry.hostName) {
        hostName = entry.hostName;
        const { loadAdapter } = require("./router");
        adapter = loadAdapter(hostName);
      } else {
        const resolved = resolveAdapter(config, stageDef.stage, entry.role);
        hostName = resolved.hostName;
        adapter = resolved.adapter;
      }
      assertCapabilities(stageDef, entry.role, hostName, adapter);
      // G10 / 6.1: resolve per-role tool budget from core/roles.js (host-neutral).
      // Previously resolved from the adapter, so only claude-code dispatches
      // ever got a non-null budget. Now every host receives the declared budget,
      // enabling prompt-only advisory rendering and dispatched_tool_budget stamping
      // on codex, gemini-cli, and generic dispatches.
      const toolBudget = require("./roles").toolBudgetFor(entry.role);
      warnIfToolBudgetDegraded(toolBudget, entry.role, hostName, adapter);
      const descriptor = buildDescriptor(stageDef, entry.role, { workstreamId: entry.workstreamId, changeId: ctx.changeId, toolBudget, intent: ctx.intent, contextManifest });
      const prompt = withSpan("adapter.renderStagePrompt", {
        "devteam.host": hostName,
        "devteam.stage": stageDef.stage,
        "devteam.workstream.role": entry.role,
      }, () => adapter.renderStagePrompt(descriptor, ctx));
      setSpanAttributes({ "devteam.host": hostName });
      return { role: entry.role, host: hostName, descriptor, prompt, adapter, fanout: entry.fanout };
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

// Headless variant of runStage — actually drives each adapter's invoke()
// to spawn the host CLI per workstream. Resolves with an array of
// {role, host, invokeResult, descriptor}. Honors per-workstream
// capability check; rejects if any routed host has headless: false.
async function runStageHeadless(stageName, opts = {}) {
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
        emitWorkstreamEvent({
          type: "workstream-started",
          stage: plan.stage,
          name: stageName,
          role: ws.role,
          host: ws.host,
          workstream_id: ws.descriptor.workstreamId,
          gate_path: path.join(gatesDir, `${ws.descriptor.workstreamId}.json`),
          log_path: directorLogPath,
          director: true,
        });
      }
      process.stderr.write(`[devteam] experimental: dispatching ${plan.workstreams.length} workstreams → omnigent director (headless)\n`);
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

    const limitForHost = (host) => hostConcurrencyLimit(config, host);
    // --workstream filtering is applied in runStage (before rendering), so
    // plan.workstreams already contains only the requested workstreams here.
    const results = await mapByHostConcurrency(plan.workstreams, {
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
    }, async (ws, _index, queue) => {
      const wsGatePathExpected = path.join(gatesDir, `${ws.descriptor.workstreamId}.json`);
      const expectedLogPath = process.env.DEVTEAM_NO_LOG === "1" || plan.ctx.log === false
        ? null
        : path.join(getLogsDir(plan.ctx.cwd, plan.ctx.changeId), `${ws.descriptor.workstreamId}.log`);
      if (opts.skipCompleted) {
        if (fs.existsSync(wsGatePathExpected)) {
          process.stderr.write(`[devteam] --skip-completed: ${ws.role} already has a gate, skipping\n`);
          const skipped = {
            role: ws.role, host: ws.host, descriptor: ws.descriptor, skipped: true,
            exitCode: 0, gatePath: wsGatePathExpected, logPath: expectedLogPath, durationMs: 0,
            queueMs: queue.queueMs,
          };
          emitWorkstreamEvent({
            type: "workstream-finished",
            stage: plan.stage,
            name: stageName,
            role: ws.role,
            host: ws.host,
            workstream_id: ws.descriptor.workstreamId,
            skipped: true,
            exit_code: 0,
            gate_path: wsGatePathExpected,
            log_path: expectedLogPath,
            duration_ms: 0,
            queue_ms: queue.queueMs,
            queue_limit: queue.queueLimit,
          });
          return skipped;
        }
      }
      const queueSuffix = queue.queueMs > 0 ? ` after ${queue.queueMs}ms queue` : "";
      process.stderr.write(`[devteam] dispatching ${ws.role} → ${ws.host} (headless)${queueSuffix}\n`);
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
        gate_path: wsGatePathExpected,
        log_path: expectedLogPath,
        queue_ms: queue.queueMs,
        queue_limit: queue.queueLimit,
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
          const prompt = ws.adapter.capabilities.goalLoop && ws.descriptor.goalCondition
            ? `/goal "${ws.descriptor.goalCondition}"\n\n${ws.prompt}`
            : ws.prompt;
          const out = await ws.adapter.invoke(ws.descriptor, plan.ctx, prompt);
          if (span) span.setAttributes({
            "devteam.invoke.exit_code": out.exitCode,
            "devteam.invoke.duration_ms": out.durationMs,
            "devteam.invoke.gate_written": Boolean(out.gatePath),
          });
          return out;
        });
      } catch (err) {
        emitWorkstreamEvent({
          type: "workstream-finished",
          stage: plan.stage,
          name: stageName,
          role: ws.role,
          host: ws.host,
          workstream_id: ws.descriptor.workstreamId,
          exit_code: null,
          gate_path: null,
          log_path: expectedLogPath,
          duration_ms: null,
          queue_ms: queue.queueMs,
          queue_limit: queue.queueLimit,
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
        const siblingAllowedWrites = plan.workstreams
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
      const result = { role: ws.role, host: ws.host, descriptor: ws.descriptor, queueMs: queue.queueMs, ...r };
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
        log_path: r.logPath || expectedLogPath,
        duration_ms: r.durationMs ?? null,
        queue_ms: queue.queueMs,
        queue_limit: queue.queueLimit,
        write_violations_count: Array.isArray(r.writeViolations) ? r.writeViolations.length : 0,
        stub_gate: Boolean(r.stubGate),
      });
      return result;
    });

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
      // would need per-role stamping, which isn't in scope here.
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
    });
    setSpanAttributes({
      "devteam.next.action": result.action,
      "devteam.next.stage": result.stage || undefined,
      "devteam.next.name": result.name || undefined,
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

// ─────────────────────────────────────────────────────────────────────────────

// B9: cwd and changeId are threaded through so tryAutoFoldSignOff can
// resolve brief.md / test-report.md / runbook.md under the correct
// pipeline root (bounded: pipeline/changes/<changeId>/; in-place: pipeline/).
// Previously cwd was derived from gatesDir via path.resolve("..", ".."), which
// was wrong in bounded mode (gatesDir is .../pipeline/changes/<id>/gates/).
function _nextImpl(stageList, gatesDir, track, skipStages = [], maxRetries = MAX_RETRIES_DEFAULT, cwd, changeId, opts = {}) {
  const auditSkips = opts.auditSkips === true;
  const auditedSkips = new Set(opts.auditedSkips || []);
  const forceStages = new Set(opts.forceStages || []);
  const rightSizingEnabled = opts.rightSizing !== false;
  for (const stageName of stageList) {
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
      continue;
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
        continue;
      }
    }

    // Stage 7 auto-fold. When Stage 6 cleanly satisfies the AC→test
    // contract, return a "fold-sign-off" action carrying the gate content.
    // The CALLER writes the gate and calls next() again — keeping _nextImpl
    // a pure function of disk state. (item 1.2, phase-1-trust-consolidation)
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

    // Conditional stages: skip when the prerequisite gate's named field
    // is not equal to the required value. The prerequisite gate must
    // already exist — if it doesn't, the pipeline would be advancing
    // out of order, so we surface that as needing the prerequisite first.
    if (stageDef.conditionalOn) {
      const c = stageDef.conditionalOn;
      const prereqGatePath = path.join(gatesDir, `${c.stage}.json`);
      if (!fs.existsSync(prereqGatePath)) {
        // Prereq not done yet; the earlier iteration of this loop should
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
          continue; // condition not met — skip this stage silently
        }
      }
    }

    if (!fs.existsSync(stageGatePath)) {
      if (stageDef.roles.length > 1) {
        // Apply active_roles filter: only expect gates for roles that were
        // actually dispatched. Without this, a suppressed role (e.g. frontend
        // when active_roles=[backend,platform,qa]) keeps `remaining` non-empty
        // forever and the driver loops until max-iterations is exhausted.
        let effectiveRoles = stageDef.roles;
        const s1Path = path.join(gatesDir, "stage-01.json");
        if (fs.existsSync(s1Path)) {
          const { gate: s1Gate } = loadGateSafe(s1Path);
          if (s1Gate) {
            const filtered = inferActiveRoles(s1Gate, stageDef.roles);
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
  }

  return { action: "pipeline-complete", reason: `all stages PASS or WARN (track: ${track})`, track };
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
      // Apply active_roles filter so suppressed workstreams don't show as pending.
      let effectiveRoles = stageDef.roles;
      const s1Path = path.join(gatesDir, "stage-01.json");
      if (fs.existsSync(s1Path)) {
        const s1Data = readJSONSafe(s1Path);
        if (s1Data) {
          const filtered = inferActiveRoles(s1Data, stageDef.roles);
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
  summary,
  buildDescriptor,
  computeDispatchPlan,
  renderOmnigentDirectorPrompt,
  patchGateForUnpricedModel,
  ORCHESTRATOR_ID,
  rolesPath,
  templatesPath,
  PROJECT_ROOT,
};
