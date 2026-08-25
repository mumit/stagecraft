"use strict";

const fs = require("node:fs");
const path = require("node:path");
const { generateHelp } = require(path.join(__dirname, "..", "flags"));
const { applyFeatureFile } = require(path.join(__dirname, "..", "feature-file"));
const { getOrchestrator } = require(path.join(__dirname, "..", "get-orchestrator"));
const { getStage } = require(path.join(__dirname, "..", "..", "pipeline", "stages"));
const { resolveActiveTrack } = require(path.join(__dirname, "..", "..", "pipeline", "active-track"));
const { loadConfig } = require(path.join(__dirname, "..", "..", "config"));
const { resolveChangeId } = require(path.join(__dirname, "..", "resolve-change-id"));
const { checkStoplist, explainMatches, STOPLIST_TRACKS } = require(path.join(__dirname, "..", "..", "guards", "stoplist"));
const {
  stoplistContext,
  stoplistBypassStatus,
  authorizeStoplistBypass,
  readRunSafety,
  persistRunSafety,
} = require(path.join(__dirname, "..", "..", "run-safety"));
const { updateRunPlanSafetyPolicy } = require(path.join(__dirname, "..", "..", "run-plan"));
const { pipelineRoot } = require(path.join(__dirname, "..", "..", "paths"));

// STOPLIST_TRACKS is the single source of truth (core/guards/stoplist.js).
// Imported here so the interactive path (cmdStage) and the autonomous driver
// (core/driver.js) enforce exactly the same set. (Phase 1 § 1.1)
const STOPLIST_GUARDED_TRACKS = STOPLIST_TRACKS;

const name = "stage";

const flags = {
  feature:           { type: "string",  description: "Feature description passed to the prompt" },
  "feature-file":    { type: "string",  description: "Read feature description from a UTF-8 text file" },
  track:             { type: "string",  description: "Override the pipeline track" },
  cwd:               { type: "string",  description: "Target project directory" },
  headless:          { type: "boolean", description: "Drive host CLI non-interactively" },
  "timeout-ms":      { type: "number",  description: "Per-workstream wall-clock cap (default 600000)" },
  "trust-profile":   { type: "string",  description: "Execution boundary: trusted or contained (fail-closed)" },
  patch:             { type: "boolean", description: "Scope build agents to patch items from a prior gate" },
  from:              { type: "string",  description: "Stage to read patch items from (default: red-team)" },
  "skip-completed":  { type: "boolean", description: "Skip workstreams whose gate file already exists" },
  workstream:        { type: "list",    description: "Dispatch only this workstream (repeatable)" },
  scope:             { type: "list",    description: "Scope review to this path (repeatable; review-only track)" },
  "experimental-omnigent-director": { type: "boolean", description: "EXPERIMENTAL: run planned Omnigent workstreams through one director session" },
  force:             { type: "boolean", description: "Bypass stoplist / unresolved-escalation guards" },
  json:              { type: "boolean", description: "JSON output" },
  "skip-preflight":  { type: "boolean", description: "Skip automatic preflight check before peer-review" },
  help:              { type: "boolean", description: "Show this help" },
};

function featureArg(_flags) {
  if (_flags.featureFile) return ` --feature-file "${_flags.featureFile}"`;
  if (_flags.feature) return ` --feature "${_flags.feature}"`;
  return "";
}

// Onboarding hint printed before the rendered prompt in user-driven mode.
// Suppressed under --headless (the prompt is piped to a host CLI) and
// under --json (currently a no-op for stage but reserved). The framing
// goes to stdout so it's visible alongside the rest of the output in a
// normal terminal session; if you're piping the prompt somewhere, you
// already have to filter out the workstream separators.
function printStagePreamble(result, _flags) {
  if (_flags.headless || _flags.json) return;
  const stage = result.stage;
  const name2 = result.name;
  const wsCount = result.workstreams.length;
  const wsWord = wsCount === 1 ? "workstream" : "workstreams";
  const featurePart = featureArg(_flags);
  const lines = [
    "",
    "═══════════════════════════════════════════════════════════════════════",
    `  Stage ${stage} (${name2}) — ${wsCount} ${wsWord} to dispatch`,
    "═══════════════════════════════════════════════════════════════════════",
    "",
    "  The block(s) below are prompts to feed to your model. devteam does",
    "  NOT call a model — it renders the prompt and validates the gate JSON",
    "  the model writes back.",
    "",
    "  To run this stage, pick one:",
    "    1. Inside Claude Code: paste the prompt, OR type",
    `         /devteam stage ${name2}${featurePart}`,
    "    2. Headless from terminal:",
    `         devteam stage ${name2}${featurePart} --headless`,
    "       (orchestrator pipes the prompt to `claude --print` and waits)",
    "",
    `  When done, each workstream writes pipeline/gates/${stage}*.json.`,
    "  Then run `devteam next` to see what to do next.",
    "═══════════════════════════════════════════════════════════════════════",
  ];
  console.log(lines.join("\n"));
}

function printStagePostamble(result, _flags) {
  if (_flags.headless || _flags.json) return;
  const stage = result.stage;
  const expected = result.workstreams.length === 1
    ? `pipeline/gates/${stage}.json`
    : `pipeline/gates/${stage}.<workstream>.json (then merge into ${stage}.json)`;
  console.log("");
  console.log("  Next steps:");
  console.log(`    1. Feed the prompt(s) above to your host (Claude Code, Codex, Gemini).`);
  console.log(`    2. The model writes the artifact + ${expected}.`);
  console.log(`    3. Run \`devteam next\` to advance the pipeline.`);
  console.log("");
}

function run(positional, _flags) {
  if (_flags.help) { console.log(generateHelp("devteam stage <name> [options]", flags)); process.exit(0); }
  applyFeatureFile(_flags, "stage");
  const { runStage, runStageHeadless } = getOrchestrator();
  const stageName = positional[0];
  if (!stageName) {
    console.error(generateHelp("devteam stage <name> [options]", flags));
    process.exit(2);
  }
  // Resolve track and run stoplist if applicable
  const cwd = _flags.cwd || process.cwd();
  const config = loadConfig(cwd);
  const changeId = resolveChangeId(_flags, config);
  const stageDef = getStage(stageName);

  // Guard: refuse to dispatch a stage strictly later than one still sitting
  // on an unresolved ESCALATE gate. `devteam stage <name>` is a direct
  // dispatch that bypasses `next()`'s recommendation entirely — exactly the
  // loophole an escalation-applicator agent (or a human) can trip into when
  // a routing table names a stage that collides with an unrelated workstream
  // role (e.g. bare `qa` = stage-06 QA Testing, confused for the qa *build
  // workstream*). Scoped to ESCALATE only, not FAIL, so it doesn't interfere
  // with the driver's own same-stage retry loop; scoped to *strictly later*
  // so dispatching an earlier stage to fix the root cause of a later
  // escalation — the documented recovery path — still works.
  if (!_flags.force && stageDef) {
    try {
      const { next } = getOrchestrator();
      const { stageKey } = require(path.join(__dirname, "..", "..", "gates", "validator"));
      const nr = next({ cwd });
      if (nr && nr.action === "resolve-escalation" && stageKey(`${nr.stage}.json`) < stageKey(`${stageDef.stage}.json`)) {
        console.error(
          `devteam stage: refusing to dispatch '${stageName}' (${stageDef.stage}) — ` +
          `${nr.stage} has an unresolved ESCALATE gate that comes first.`,
        );
        console.error("");
        console.error(`  Escalating gate:  ${nr.gate}`);
        console.error(`  Reason:           ${nr.reason}`);
        console.error("");
        console.error("Resolve it, then re-run this:");
        console.error(`  1. ${nr.command}`);
        console.error(`  2. devteam fix-escalation [--headless]`);
        console.error(`  3. devteam next   # should no longer say resolve-escalation for ${nr.stage}`);
        console.error("");
        console.error(`Already handled and dispatching '${stageName}' on purpose? Pass --force.`);
        process.exit(2);
      }
    } catch { /* next() unavailable or errored — don't block dispatch on a guard failure */ }
  }
  // If the target directory isn't initialized, the prompt we're about to
  // print will reference files (`.claude/agents/<role>.md`, `.devteam/
  // rules/*.md`, `.devteam/templates/*-template.md`) that don't exist. Warn loudly
  // before printing — this is the #1 first-run footgun.
  if (!_flags.headless && !_flags.json && !fs.existsSync(path.join(cwd, ".devteam", "config.yml"))) {
    process.stderr.write(
      `\n⚠️  ${cwd}\n` +
      `   does not look like an initialised Stagecraft target project (no .devteam/config.yml).\n` +
      `   The prompt below will reference role briefs / rules / templates that don't exist yet.\n` +
      `   Run this first to lay them down:\n` +
      `     devteam init --host claude-code --cwd "${cwd}"\n\n`,
    );
  }
  const CONVENTION_STAGES = new Set(["requirements", "design", "build"]);
  if (CONVENTION_STAGES.has(stageName)) {
    const { seedDeployContext } = require(path.join(__dirname, "..", "..", "driver"));
    seedDeployContext(cwd, config, changeId);
  }
  const activeTrack = resolveActiveTrack(cwd, config, _flags.track, changeId);
  const track = activeTrack.track;
  if (STOPLIST_GUARDED_TRACKS.has(track)) {
    const matches = checkStoplist({ description: _flags.feature || "", cwd, changeId });
    const runSafety = readRunSafety(cwd, changeId);
    const context = stoplistContext({ cwd, changeId, description: _flags.feature || "" });
    const bypassStatus = stoplistBypassStatus(
      runSafety.policy && runSafety.policy.stoplist_bypass,
      context,
    );
    let policy = runSafety.policy;
    const persistPolicy = (nextPolicy) => {
      const plan = path.join(pipelineRoot(cwd, changeId), "run-plan.json");
      const updatedPlan = fs.existsSync(plan)
        ? updateRunPlanSafetyPolicy(cwd, changeId, nextPolicy)
        : null;
      if (runSafety.state) persistRunSafety(cwd, changeId, runSafety.state, nextPolicy);
      policy = nextPolicy;
      return updatedPlan;
    };
    if (policy && policy.stoplist_bypass && !bypassStatus.valid) {
      const priorBypass = policy.stoplist_bypass;
      const updatedPlan = persistPolicy({ ...policy, stoplist_bypass: null });
      try {
        fs.appendFileSync(
          path.join(pipelineRoot(cwd, changeId), "run-log.jsonl"),
          JSON.stringify({
            ts: new Date().toISOString(),
            outcome: "stoplist-bypass-invalidated",
            label: `direct-stage:${stageName}`,
            reason: bypassStatus.reason,
            prior_bypass_fingerprint: priorBypass.fingerprint || null,
            plan_fingerprint: (updatedPlan && updatedPlan.plan_fingerprint) || null,
          }) + "\n",
        );
      } catch { /* run-state and run-plan already reflect the invalidation */ }
    }
    if (matches.length > 0) {
      if (bypassStatus.valid) {
        try {
          fs.appendFileSync(
            path.join(pipelineRoot(cwd, changeId), "run-log.jsonl"),
            JSON.stringify({
              ts: new Date().toISOString(),
              outcome: "stoplist-bypass-reused",
              label: `direct-stage:${stageName}`,
              bypass_fingerprint: policy.stoplist_bypass.fingerprint,
              matches: matches.map((match) => match.name),
            }) + "\n",
          );
        } catch { /* audit append is best-effort; authorization is already durable */ }
      } else if (_flags.force) {
        if (policy) {
          const authorized = authorizeStoplistBypass(context, policy.stoplist_bypass);
          const updatedPlan = persistPolicy({ ...policy, stoplist_bypass: authorized });
          try {
            fs.appendFileSync(
              path.join(pipelineRoot(cwd, changeId), "run-log.jsonl"),
              JSON.stringify({
                ts: new Date().toISOString(),
                outcome: "stoplist-bypass-authorized",
                label: `direct-stage:${stageName}`,
                authority: authorized.authority,
                bypass_fingerprint: authorized.fingerprint,
                plan_fingerprint: (updatedPlan && updatedPlan.plan_fingerprint) || null,
                matches: matches.map((match) => match.name),
              }) + "\n",
            );
          } catch { /* run-state and run-plan remain the authority record */ }
        }
      } else {
        console.error(explainMatches(matches));
        console.error(`(Active track: ${track}. Stoplist guarded; source: ${activeTrack.source}.)`);
        process.exit(2);
      }
    }
  }
  // Auto-run preflight (stage-04e) when dispatching peer-review.
  // Skipped if stage-04e.json already exists and is PASS (stage manager ran manually).
  const isPeerReview = stageDef ? stageDef.stage === "stage-05" : stageName === "peer-review";
  if (isPeerReview && !_flags.skipPreflight) {
    const { runPreflight } = require(path.join(__dirname, "..", "..", "preflight"));
    const preflightGatePath = path.join(cwd, "pipeline", "gates", "stage-04e.json");
    let needsPreflight = true;
    if (fs.existsSync(preflightGatePath)) {
      try {
        const existing = JSON.parse(fs.readFileSync(preflightGatePath, "utf8"));
        if (existing.status === "PASS") needsPreflight = false;
      } catch { /* malformed — re-run */ }
    }
    if (needsPreflight) {
      process.stderr.write("[devteam] running preflight checks (stage-04e) before peer-review…\n");
      const preflightResult = runPreflight(cwd, { track });
      if (preflightResult.status === "FAIL") {
        console.error("[devteam] preflight FAIL — fix issues before dispatching peer-review:");
        preflightResult.blockers.forEach((b) => console.error(`  BLOCKER: ${b}`));
        console.error("\nSee docs/runbooks/fix-and-retry.md § Case 10 for resolution steps.");
        process.exit(1);
      }
      process.stderr.write(
        `[devteam] preflight PASS${preflightResult.warnings.length > 0 ? ` (${preflightResult.warnings.length} warning(s) — see stage-04e.json)` : ""}\n`
      );
    } else {
      process.stderr.write("[devteam] preflight already PASS (stage-04e.json) — skipping\n");
    }
  }

  if (_flags.patch) {
    const fromName = _flags.from || "red-team";
    const fromDef  = getStage(fromName);
    const stageId  = fromDef ? fromDef.stage : fromName;
    const gatePath = path.join(cwd, "pipeline", "gates", `${stageId}.json`);
    if (fs.existsSync(gatePath)) {
      try {
        const gate = JSON.parse(fs.readFileSync(gatePath, "utf8"));
        const primary = gate.must_address_before_peer_review;
        const items = (Array.isArray(primary) && primary.length > 0) ? primary : gate.blockers;
        if (Array.isArray(items) && items.length > 0) {
          _flags.patchItems = items;
          const field = (Array.isArray(primary) && primary.length > 0)
            ? "must_address_before_peer_review" : "blockers";
          process.stderr.write(`[devteam] --patch: ${items.length} item(s) from ${fromName} gate (${field})\n`);
        } else {
          process.stderr.write(`[devteam] --patch: no patch items in ${stageId}.json — running full build\n`);
        }
      } catch {
        process.stderr.write(`[devteam] --patch: could not read ${gatePath} — running full build\n`);
      }
    } else {
      process.stderr.write(`[devteam] --patch: ${stageId}.json not found — running full build\n`);
    }
  }

  // HTTP-native hosts (e.g. openai-compat) have no CLI to paste a prompt into;
  // headless invoke is the only meaningful mode for them. Auto-enable it so the
  // user doesn't need to remember to pass --headless every time.
  if (!_flags.headless) {
    try {
      const hostName = loadConfig(cwd).routing.default_host;
      const capPath = path.join(__dirname, "..", "..", "..", "hosts", hostName, "capabilities.json");
      const caps = JSON.parse(fs.readFileSync(capPath, "utf8"));
      if (caps.httpNative === true) {
        process.stderr.write(`[devteam] ${hostName} is HTTP-native — running headlessly\n`);
        _flags.headless = true;
      }
    } catch { /* adapter absent or capabilities unreadable — keep current mode */ }
  }

  if (_flags.experimentalOmnigentDirector && !_flags.headless) {
    console.error("devteam stage: --experimental-omnigent-director requires --headless.");
    process.exit(2);
  }

  if (_flags.headless) {
    if (_flags.experimentalOmnigentDirector && _flags.skipCompleted) {
      console.error("devteam stage: --experimental-omnigent-director cannot be combined with --skip-completed.");
      process.exit(2);
    }
    runStageHeadless(stageName, { ..._flags, track })
      .then((result) => {
        let anyFail = false;
        for (const r of result.results) {
          const ok = !r.timedOut && r.exitCode === 0 && r.gatePath;
          const gateNote = r.gatePath ? ` → ${path.relative(result.ctx.cwd, r.gatePath)}` : " (no gate written)";
          const agentStatus = r.timedOut
            ? `TIMEOUT after ${r.durationMs}ms`
            : `exit ${r.exitCode}, ${r.durationMs}ms`;
          if (!ok) {
            console.log(`  ✗ ${r.role} (${r.host}): ${agentStatus}${gateNote}`);
            anyFail = true;
            continue;
          }
          // Read gate to surface FAIL/WARN without requiring a separate `devteam next`.
          try {
            const gate = JSON.parse(fs.readFileSync(r.gatePath, "utf8"));
            if (gate.status === "FAIL" || gate.status === "ESCALATE") {
              console.log(`  ✗ ${r.role} (${r.host}): ${agentStatus}${gateNote} [gate: ${gate.status}]`);
              const blockers = gate.blockers || gate.must_address_before_peer_review || [];
              for (const b of blockers) {
                const text = typeof b === "string" ? b : (b.summary || JSON.stringify(b));
                console.log(`    BLOCKER: ${text}`);
              }
              anyFail = true;
            } else if (gate.status === "WARN") {
              console.log(`  ⚠ ${r.role} (${r.host}): ${agentStatus}${gateNote} [gate: WARN]`);
              const warnings = gate.warnings || [];
              for (const w of warnings) {
                const text = typeof w === "string" ? w : (w.summary || JSON.stringify(w));
                console.log(`    WARNING: ${text}`);
              }
            } else {
              console.log(`  ✓ ${r.role} (${r.host}): ${agentStatus}${gateNote}`);
            }
          } catch {
            console.log(`  ✓ ${r.role} (${r.host}): ${agentStatus}${gateNote}`);
          }
        }
        process.exit(anyFail ? 1 : 0);
      })
      .catch((err) => {
        console.error(`devteam: ${err.message}`);
        process.exit(1);
      });
    return;
  }
  // --workstream filtering is handled in the orchestrator (runStage) before
  // rendering — result already contains only the requested workstreams.
  const result = runStage(stageName, { ..._flags, track });
  printStagePreamble(result, _flags);
  // 30.2(a): printing the prompt here IS the dispatch for the interactive
  // path — the operator is about to paste it into a real host — unlike
  // `devteam replay --dry-run` / `devteam reproduce`, which only call
  // runStage() to preview a prompt and never reach this print loop.
  const { recordInjection } = require(path.join(__dirname, "..", "..", "patterns"));
  const root = pipelineRoot(result.ctx.cwd, result.ctx.changeId);
  for (const ws of result.workstreams) {
    console.log(`\n────────  workstream: ${ws.role}  (host: ${ws.host})  ────────\n`);
    console.log(ws.prompt);
    recordInjection({
      cwd: result.ctx.cwd,
      pipelineRoot: root,
      stage: result.stage,
      workstreamId: ws.descriptor.workstreamId,
      patterns: ws.descriptor.knownPatterns,
    });
  }
  const workstreamCount = result.workstreams.length;
  console.log(`\n────────  end of ${result.stage} (${workstreamCount} workstream${workstreamCount === 1 ? "" : "s"})  ────────`);
  printStagePostamble(result, _flags);
}

module.exports = { name, flags, run };
