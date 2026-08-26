#!/usr/bin/env node
/**
 * gate-validator.js
 *
 * Runs after every subagent stop. Validates the state of pipeline/gates/ —
 * the JSON is the authoritative record of stage status. Exits:
 *
 *   0 — PASS (most recent gate is PASS; no older unresolved escalations)
 *   1 — gate file is malformed or missing required fields
 *   2 — FAIL (most recent gate is FAIL)
 *   3 — ESCALATE (most recent gate is ESCALATE, OR an older gate is
 *       ESCALATE and a newer gate exists — i.e. a bypassed escalation)
 *
 * v2.1 hardening added:
 *
 *   - Sweep ALL gate files for unresolved ESCALATE, not just most recent.
 *     A gate with status ESCALATE that is older than any other gate
 *     indicates the escalation was bypassed. This halts the pipeline.
 *   - Validate retry integrity: if retry_number >= 1, the
 *     this_attempt_differs_by field must be a non-empty string.
 *   - Warn (not fail) on gates missing the "track" field. Legacy gates
 *     predating v2.0 don't carry this field; warning gives visibility
 *     without breaking pipelines mid-upgrade.
 *   - Scan pipeline/lessons-learned.md for malformed `**Reinforced:**`
 *     lines. Malformed lines are warnings — they don't halt the
 *     pipeline but surface a fix-up opportunity.
 */

const fs = require("node:fs");
const path = require("node:path");
const { loadConfig } = require("../config.js");
const { TRACKS } = require("../pipeline/stages.js");
const { stripSection, upsertSection } = require("../markers.js");
const { logContextSectionEvent } = require("../context-log.js");
const { enforceContextBudget } = require("../context-budget.js");
const { documentationScopeError } = require("../pipeline/affected-files.js");

// --strict mode: the validator exits 1 on unknown internal errors instead of
// treating them as PASS. Also activated when the CI=true env var is set.
// Rationale: in CI the validator gates merges, so fail-open means a validator
// bug silently green-lights everything. In interactive hook mode, fail-open is
// intentional — don't kill a user's session on a validator defect — but errors
// are now always logged to pipeline/validator-errors.log so they are
// discoverable instead of vanishing.
const STRICT_MODE = process.argv.includes("--strict") || process.env.CI === "true";

// Resolve gates/lessons paths lazily against the current cwd. The validator
// is normally spawned as a child process (each invocation gets a fresh cwd
// from the orchestrator), so module-load caching was historically fine — but
// caching forecloses any future caller that wants to require() this module
// and validate against a different cwd. Lazy resolution preserves the
// subprocess contract and makes the exports testable.
//
// B9: when DEVTEAM_CHANGE_ID is set (orchestrator exports it into the host
// environment for bounded-isolation runs), gates live under
// pipeline/changes/<changeId>/gates/ rather than the global pipeline/gates/.
function gatesDir() {
  const { gatesDir: getGatesDir } = require("../paths");
  return getGatesDir(process.cwd(), process.env.DEVTEAM_CHANGE_ID || null);
}

function lessonsFile() {
  const { pipelineRoot } = require("../paths");
  return path.join(pipelineRoot(process.cwd(), process.env.DEVTEAM_CHANGE_ID || null), "lessons-learned.md");
}

// Structured-log mode (audit B-23). When LOG_FORMAT=json, the hook emits a
// single JSON event line on stdout per invocation in addition to the
// human-readable prose, so external orchestrators (CI runners, dashboards)
// can consume hook results without parsing prose. Default off — humans
// running Claude Code interactively see prose only.
const LOG_JSON = process.env.LOG_FORMAT === "json";

function logEvent(event, data) {
  if (!LOG_JSON) return;
  console.log(JSON.stringify({
    ts: new Date().toISOString(),
    hook: "gate-validator",
    event,
    ...data,
  }));
}

// Matches the two valid forms documented in .devteam/rules/retrospective.md:
//   **Reinforced:** 0
//   **Reinforced:** <N> (last: YYYY-MM-DD)   where N >= 1
const REINFORCED_LINE_RE = /^\s*\*\*Reinforced:\*\*\s+(.+?)\s*$/;
const REINFORCED_ZERO_RE = /^0$/;
const REINFORCED_NONZERO_RE = /^([1-9]\d*)\s+\(last:\s+(\d{4}-\d{2}-\d{2})\)$/;

const VALID_STATUSES = new Set(["PASS", "WARN", "FAIL", "ESCALATE"]);
// Derived from the canonical source — stages.js is the single source of truth
// for valid track names. Any track added there automatically propagates here.
const VALID_TRACKS = new Set(TRACKS);
const REQUIRED_FIELDS = [
  "stage",
  "status",
  "orchestrator",
  "timestamp",
  "blockers",
  "warnings",
];

// 1 MB cap on gate file size. Gates are typically <1 KB; an attacker (or
// runaway producer) writing a gigabyte-sized "blockers" string would
// otherwise OOM the validator. The bound is loose enough that no
// legitimate gate will hit it.
const MAX_GATE_BYTES = 1_000_000;

/** Read a gate file and parse as JSON. Returns { gate, error }. */
function loadGate(fullPath) {
  try {
    const stat = fs.statSync(fullPath);
    if (stat.size > MAX_GATE_BYTES) {
      return {
        gate: null,
        error: `gate file exceeds ${MAX_GATE_BYTES} bytes (size: ${stat.size})`,
      };
    }
    const raw = fs.readFileSync(fullPath, "utf8");
    return { gate: JSON.parse(raw), error: null };
  } catch (e) {
    return { gate: null, error: e.message };
  }
}

/**
 * Auto-inject orchestrator, host, and dispatched_tool_budget fields if the
 * model omitted them.
 *
 * The stage prompt tells models "the orchestrator adds orchestrator and host at
 * validation time." This is that injection point. We patch the gate on disk so
 * the file is canonical after validation, not just in memory.
 *
 * Returns true if the file was rewritten.
 */
function autoInjectMetadata(gate, gateFilePath) {
  let modified = false;

  if (!("orchestrator" in gate)) {
    try {
      const pkgPath = path.join(__dirname, "..", "..", "package.json");
      const pkg = JSON.parse(fs.readFileSync(pkgPath, "utf8"));
      gate.orchestrator = `devteam@${pkg.version}`;
      modified = true;
    } catch {
      // Injection failed — leave orchestrator absent so missingRequired catches it.
    }
  }

  if (!("host" in gate)) {
    // Resolve from the project config's routing.default_host. When config is
    // absent loadConfig returns the framework default ("generic"), which is
    // the right fallback — a workstream gate that omits its host gives the
    // orchestrator no host-specific information to attribute, so the neutral
    // "generic" classification is more honest than guessing claude-code.
    let host;
    try {
      host = loadConfig(process.cwd()).routing.default_host;
    } catch {
      host = "generic";
    }
    gate.host = host;
    modified = true;
  }

  // G10 / 6.1: inject dispatched_tool_budget for user-driven gates that weren't
  // stamped by the headless path. Only applies to workstream gates (gate.workstream
  // present). Uses core/roles.toolBudgetFor (host-neutral) — previously loaded
  // the adapter and called adapter.toolBudgetFor(), which only worked for
  // claude-code gates (other adapters don't export the function).
  // best-effort — failure leaves the field absent rather than blocking validation.
  if (!("dispatched_tool_budget" in gate) && typeof gate.workstream === "string") {
    try {
      const { toolBudgetFor } = require("../roles");
      const budget = toolBudgetFor(gate.workstream);
      gate.dispatched_tool_budget = budget; // null when role is unknown
      modified = true;
    } catch {
      // Injection failed — leave field absent; gate is still valid.
    }
  }

  // Phase-33 item 33.3: inject prompt_pack_version for user-driven gates —
  // the headless path stamps it via core/orchestrator.js
  // patchGateWithPromptPackVersion (same dual-path convention as
  // dispatched_tool_budget above). Orchestrator-computed, never model-
  // asserted, so it's injected here rather than added to REQUIRED_FIELDS.
  if (!("prompt_pack_version" in gate)) {
    try {
      const { computePromptPackVersion } = require("../prompt-pack");
      gate.prompt_pack_version = computePromptPackVersion();
      modified = true;
    } catch {
      // Injection failed — leave field absent; gate is still valid.
    }
  }

  if (modified) {
    fs.writeFileSync(gateFilePath, JSON.stringify(gate, null, 2) + "\n", "utf8");
    console.log(
      `[gate-validator] ℹ️  auto-injected metadata into ${path.basename(gateFilePath)}`,
    );
  }

  return modified;
}

/**
 * When a red-team gate FAILs, prepend its must-fix blockers to
 * pipeline/context.md so the next build re-run sees them explicitly.
 *
 * Uses HTML comment markers so the section can be replaced (not
 * duplicated) on subsequent red-team FAIL cycles.
 */
function injectRedTeamBlockers(gate, cwd) {
  if (gate.stage !== "stage-04c" || gate.status !== "FAIL") return;
  const items = gate.must_address_before_peer_review;
  if (!Array.isArray(items) || items.length === 0) return;

  // B9 exemption: validator.js always runs in in-place mode (it is invoked by CI
  // and hooks against the global pipeline/ directory; no changeId propagation today).
  const contextPath = path.join(cwd, "pipeline", "context.md");
  if (!fs.existsSync(contextPath)) return;

  const BEGIN = "<!-- devteam:red-team-blockers:begin -->";
  const END   = "<!-- devteam:red-team-blockers:end -->";

  const itemLines = items.map((item) => {
    const id  = item.id       ? `**${item.id}**` : "";
    const sev = item.severity ? ` [${item.severity}/${item.likelihood || "?"}]` : "";
    const sum = item.summary  || JSON.stringify(item);
    return `- ${id}${sev}: ${sum}`;
  });

  const section = [
    BEGIN,
    "## IMMEDIATE: Red-Team Blockers — Fix Before Peer Review",
    "",
    "The following must-fix items from stage-04c MUST be addressed in the next build re-run.",
    "Use `devteam stage build --patch --from red-team` to scope build agents to these items only.",
    "Do not proceed to peer review until all are resolved.",
    "",
    ...itemLines,
    "",
    `_Last updated by gate-validator: ${new Date().toISOString()}_`,
    END,
  ].join("\n");

  const content = upsertSection(
    fs.readFileSync(contextPath, "utf8"),
    BEGIN,
    END,
    section,
    { insert: "prepend" },
  );

  fs.writeFileSync(contextPath, content, "utf8");
  logContextSectionEvent(cwd, null, { action: "added", section: "red-team-blockers", stage: gate.stage });
  enforceContextBudget(cwd, null);
  console.log(
    `[gate-validator] ℹ️  red-team blockers (${items.length}) written to pipeline/context.md`,
  );
}

/**
 * When the QA workstream gate within build (stage-04.qa.json) FAILs,
 * write its blockers into pipeline/context.md so the implementation
 * roles (backend, platform, etc.) see them on the next build re-run.
 *
 * Uses HTML comment markers so the section is replaced, not duplicated,
 * across repeated QA FAIL cycles.
 */
function injectQABuildBlockers(gate, cwd) {
  if (gate.stage !== "stage-04" || gate.workstream !== "qa" || gate.status !== "FAIL") return;
  const items = gate.blockers;
  if (!Array.isArray(items) || items.length === 0) return;

  // B9 exemption: validator.js always runs in in-place mode (see above).
  const contextPath = path.join(cwd, "pipeline", "context.md");
  if (!fs.existsSync(contextPath)) return;

  const BEGIN = "<!-- devteam:qa-build-blockers:begin -->";
  const END   = "<!-- devteam:qa-build-blockers:end -->";

  const itemLines = items.map((item) => `- ${item}`);

  const section = [
    BEGIN,
    "## IMMEDIATE: QA Build Failures — Fix Before Re-Running QA",
    "",
    "The following bugs were found by QA (stage-04.qa) and must be fixed by the",
    "responsible implementation roles before QA can re-verify. Delete the gate files",
    "for the owning roles and QA, then re-run:",
    "  `devteam stage build --patch --from stage-04.qa --skip-completed --headless`",
    "",
    ...itemLines,
    "",
    `_Last updated by gate-validator: ${new Date().toISOString()}_`,
    END,
  ].join("\n");

  const content = upsertSection(
    fs.readFileSync(contextPath, "utf8"),
    BEGIN,
    END,
    section,
    { insert: "prepend" },
  );

  fs.writeFileSync(contextPath, content, "utf8");
  logContextSectionEvent(cwd, null, { action: "added", section: "qa-build-blockers", stage: gate.stage });
  enforceContextBudget(cwd, null);
  console.log(
    `[gate-validator] ℹ️  QA build blockers (${items.length}) written to pipeline/context.md`,
  );
}

/**
 * Strip a previously-injected blocker section from pipeline/context.md.
 * Idempotent — if the markers aren't present, this is a no-op.
 * Used when the originating stage transitions to PASS or WARN so stale
 * "IMMEDIATE: ... — Fix Before X" headings don't sit in context forever.
 *
 * Returns true if the file was rewritten.
 */
function stripMarkedSection(contextPath, beginMarker, endMarker) {
  if (!fs.existsSync(contextPath)) return false;
  const content = fs.readFileSync(contextPath, "utf8");
  const next = stripSection(content, beginMarker, endMarker);
  if (next === content) return false;
  fs.writeFileSync(contextPath, next, "utf8");
  return true;
}

/**
 * When a red-team gate resolves to PASS or WARN, strip the previously-
 * injected red-team-blockers section from pipeline/context.md. The
 * implementer fixed the items; the section has done its job and would
 * otherwise sit there taking up context on every subsequent stage.
 */
function stripRedTeamBlockers(gate, cwd) {
  if (gate.stage !== "stage-04c") return;
  if (gate.status !== "PASS" && gate.status !== "WARN") return;
  // B9 exemption: validator.js always runs in in-place mode (see above).
  const contextPath = path.join(cwd, "pipeline", "context.md");
  const stripped = stripMarkedSection(
    contextPath,
    "<!-- devteam:red-team-blockers:begin -->",
    "<!-- devteam:red-team-blockers:end -->",
  );
  if (stripped) {
    logContextSectionEvent(cwd, null, { action: "removed", section: "red-team-blockers", stage: gate.stage });
    console.log("[gate-validator] ℹ️  red-team blockers section cleared from pipeline/context.md (red-team is now PASS/WARN)");
  }
}

/**
 * When the QA workstream gate resolves to PASS or WARN, strip the
 * previously-injected qa-build-blockers section from pipeline/context.md.
 * Same rationale as stripRedTeamBlockers.
 */
function stripQABuildBlockers(gate, cwd) {
  if (gate.stage !== "stage-04" || gate.workstream !== "qa") return;
  if (gate.status !== "PASS" && gate.status !== "WARN") return;
  // B9 exemption: validator.js always runs in in-place mode (see above).
  const contextPath = path.join(cwd, "pipeline", "context.md");
  const stripped = stripMarkedSection(
    contextPath,
    "<!-- devteam:qa-build-blockers:begin -->",
    "<!-- devteam:qa-build-blockers:end -->",
  );
  if (stripped) {
    logContextSectionEvent(cwd, null, { action: "removed", section: "qa-build-blockers", stage: gate.stage });
    console.log("[gate-validator] ℹ️  QA build-blockers section cleared from pipeline/context.md (QA is now PASS/WARN)");
  }
}

/** Validate required fields. Returns an array of missing field names. */
function missingRequired(gate) {
  return REQUIRED_FIELDS.filter((k) => !(k in gate));
}

/** Validate retry metadata if this gate is a retry. */
function retryValidationError(gate) {
  if (typeof gate.retry_number !== "number" || gate.retry_number < 1) {
    return null;
  }
  const delta = gate.this_attempt_differs_by;
  if (typeof delta !== "string" || delta.trim() === "") {
    return `retry_number=${gate.retry_number} requires non-empty this_attempt_differs_by`;
  }
  return null;
}

/**
 * Validate escalation metadata if this gate is escalating.
 *
 * Regression: a real headless run had a review role self-escalate directly
 * (per rules/gates-core.md's "same failure twice = escalate, don't retry"
 * guidance) without setting escalation_reason. Nothing caught it — this
 * required-field check didn't exist, so the gate passed validation with
 * status=ESCALATE and no reason. core/orchestrator.js's resolve-escalation
 * branch reads escalation_reason straight from the gate; with it empty,
 * `devteam next` / `devteam run` could only report the generic fallback
 * "escalation required; pipeline halted" — no indication of what a human
 * was actually being asked to rule on, even though the gate's own
 * blockers/previous_failure_reason fields fully explained it.
 */
function escalationValidationError(gate) {
  if (gate.status !== "ESCALATE") return null;
  const reason = gate.escalation_reason;
  if (typeof reason !== "string" || reason.trim() === "") {
    return `status=ESCALATE requires non-empty escalation_reason`;
  }
  return null;
}

function deployCostGateError(gate) {
  if (gate.stage !== "stage-08") return null;
  if (gate.status !== "PASS" && gate.status !== "WARN") return null;

  if (gate.cost_delta_estimated !== true) {
    return "stage-08 PASS/WARN requires cost_delta_estimated: true";
  }

  if (typeof gate.cost_delta_multiplier !== "number" || !Number.isFinite(gate.cost_delta_multiplier)) {
    return "stage-08 PASS/WARN requires numeric cost_delta_multiplier";
  }

  if (gate.cost_delta_multiplier < 10) return null;

  if (gate.cost_gate_override !== true) {
    return "stage-08 cost_delta_multiplier >= 10 requires cost_gate_override: true or status FAIL";
  }

  if (typeof gate.cost_gate_override_reason !== "string" || gate.cost_gate_override_reason.trim() === "") {
    return "stage-08 cost_gate_override requires non-empty cost_gate_override_reason";
  }

  return null;
}

function documentationGateError(gate) {
  if (gate.stage !== "stage-07") return null;
  if (gate.status !== "PASS" && gate.status !== "WARN") return null;

  if (typeof gate.docs_surface_affected !== "boolean") {
    return "stage-07 PASS/WARN requires boolean docs_surface_affected";
  }

  if (gate.docs_surface_affected) {
    if (gate.docs_updated !== true) {
      return "stage-07 docs_surface_affected=true requires docs_updated: true or status FAIL";
    }
    return null;
  }

  if (gate.docs_updated !== null) {
    return "stage-07 docs_surface_affected=false requires docs_updated: null";
  }

  if (typeof gate.docs_skipped_reason !== "string" || gate.docs_skipped_reason.trim() === "") {
    return "stage-07 docs_surface_affected=false requires non-empty docs_skipped_reason";
  }

  return null;
}

/**
 * Scan all gate files for unresolved escalations.
 *
 * An escalation is "unresolved and bypassed" when a gate has
 * status=ESCALATE AND there is a newer gate file in the same directory.
 * That newer file would not exist if the pipeline had correctly halted
 * at the escalation.
 */
function findBypassedEscalations(gateFiles) {
  if (gateFiles.length < 2) return [];

  // gateFiles is sorted most-recent-first by timestamp. Skip index 0 (the
  // newest gate — an ESCALATE there is a live halt, not a bypass). For any
  // older ESCALATE gate, only flag it as bypassed if at least one of the
  // "newer" gates (indices 0..i-1) belongs to a LATER pipeline stage.
  //
  // Why the stage-order check: re-running an earlier stage (e.g. build/stage-04)
  // after a later stage has escalated (e.g. deploy/stage-08) produces stage-04
  // gates with timestamps newer than the stage-08 ESCALATE gate. Without the
  // stage-order guard, the validator incorrectly treats the stage-08 ESCALATE
  // as "bypassed" because a newer-timestamped gate exists — even though that
  // gate is from an *earlier* pipeline stage, not a later one. A stage-08
  // escalation is only a bypass if something from stage-09 or later was written
  // after it.
  const bypassed = [];
  for (let i = 1; i < gateFiles.length; i++) {
    const { gate } = loadGate(gateFiles[i].full);
    if (!gate) continue; // malformed — will surface separately if it's the top entry
    if (gate.status !== "ESCALATE") continue;

    const escalateStageOrder = stageKey(gateFiles[i].name);
    // Only a gate from a later pipeline stage constitutes a "bypass" of this
    // escalation. Same-stage or earlier-stage gates appearing newer by timestamp
    // (e.g. due to a re-run) do not count.
    const hasLaterStageGateAfter = gateFiles.slice(0, i).some(
      (f) => stageKey(f.name) > escalateStageOrder
    );
    if (hasLaterStageGateAfter) {
      bypassed.push({ name: gateFiles[i].name, gate });
    }
  }

  return bypassed;
}

/**
 * Scan pipeline/lessons-learned.md for malformed `**Reinforced:**` lines.
 * Returns an array of { lineNumber, text } objects. Missing file is not
 * an error.
 */
function findMalformedReinforcedLines() {
  const lessonsPath = lessonsFile();
  if (!fs.existsSync(lessonsPath)) return [];

  let content;
  try {
    content = fs.readFileSync(lessonsPath, "utf8");
  } catch {
    return [];
  }

  const lines = content.split(/\r?\n/);
  const malformed = [];

  lines.forEach((line, idx) => {
    const m = line.match(REINFORCED_LINE_RE);
    if (!m) return;
    const value = m[1];
    if (REINFORCED_ZERO_RE.test(value)) return;
    if (REINFORCED_NONZERO_RE.test(value)) return;
    malformed.push({ lineNumber: idx + 1, text: line.trim() });
  });

  return malformed;
}

/**
 * Stage order derived from core/pipeline/stages.js. Used as a fallback sort
 * key when a gate has no timestamp field so that ordering is always
 * content-derived, never filesystem-metadata-dependent.
 *
 * mtime was wrong: git checkout, touch, and any copy operation silently
 * update mtime — making the "newer gate bypassed an older escalation" verdict
 * depend on filesystem timestamps that an operator (or CI checkout step) can
 * change without altering the gate contents at all. Using the gate's own
 * timestamp field (written by the orchestrator at gate-write time) makes the
 * ordering tamper-evident in the same way the gate content is.
 */
const STAGE_ORDER = (() => {
  const { STAGES } = require("../pipeline/stages.js");
  const order = {};
  let idx = 0;
  for (const def of Object.values(STAGES)) {
    if (def.stage && !(def.stage in order)) order[def.stage] = idx++;
  }
  return order;
})();

function stageKey(name) {
  // Extract base stage id from gate filename (e.g. "stage-04.backend.json" → "stage-04").
  const base = path.basename(name, ".json").replace(/\.\w+$/, "");
  return STAGE_ORDER[base] ?? 9999;
}

/** List gate .json files sorted most-recent first by content-derived order.
 *
 * Sort priority:
 *   1. Gate's own `timestamp` field (ISO 8601 — lexicographic sort works).
 *   2. Stage order from core/pipeline/stages.js (deterministic fallback).
 *
 * We deliberately do NOT use filesystem mtime: it changes on git checkout,
 * `touch`, and CI workspace copies, which would let mtime manipulation flip
 * the bypassed-escalation verdict without altering any gate content.
 */
function listGates() {
  const dir = gatesDir();
  return fs
    .readdirSync(dir)
    .filter((f) => f.endsWith(".json"))
    .map((f) => {
      const full = path.join(dir, f);
      let timestamp = null;
      try {
        const raw = JSON.parse(fs.readFileSync(full, "utf8"));
        timestamp = raw.timestamp || null;
      } catch {
        // Malformed gate — timestamp stays null; will fall back to stage order.
      }
      return { name: f, timestamp, full };
    })
    .sort((a, b) => {
      // Most-recent first. When timestamps are present, use them. When
      // timestamps are equal (or absent), fall back to stage order from
      // core/pipeline/stages.js so the ordering is always deterministic
      // and content-derived, never filesystem-metadata-dependent.
      if (a.timestamp && b.timestamp) {
        const cmp = b.timestamp.localeCompare(a.timestamp);
        if (cmp !== 0) return cmp; // strict timestamp ordering
      }
      if (a.timestamp && !b.timestamp) return -1; // a has timestamp, b doesn't → a is "newer"
      if (!a.timestamp && b.timestamp) return 1;
      // Both lack timestamps, or timestamps are identical — fall back to
      // stage order (higher stage index = later in pipeline = newer).
      return stageKey(b.name) - stageKey(a.name);
    });
}

function reportBypassedEscalation(entry) {
  const { gate } = entry;
  console.log(
    `[gate-validator] 🚨 BYPASSED ESCALATION — ${entry.name} (${gate.host || gate.orchestrator || "unknown"})`,
  );
  console.log(
    `[gate-validator] This gate requested escalation but a newer gate was written`,
  );
  console.log(
    `[gate-validator] Reason: ${gate.escalation_reason || "not specified"}`,
  );
  if (gate.decision_needed) {
    console.log(`[gate-validator] Decision needed: ${gate.decision_needed}`);
  }
  if (gate.options) {
    console.log(`[gate-validator] Options: ${gate.options.join(" | ")}`);
  }
}

function main() {
  if (!fs.existsSync(gatesDir())) {
    process.exit(0);
  }

  const gateFiles = listGates();
  if (gateFiles.length === 0) {
    process.exit(0);
  }

  // Check for bypassed escalations BEFORE processing the most-recent gate.
  // An unresolved escalation anywhere in history must halt the pipeline.
  const bypassed = findBypassedEscalations(gateFiles);
  if (bypassed.length > 0) {
    for (const entry of bypassed) reportBypassedEscalation(entry);
    console.log(
      `[gate-validator] ${bypassed.length} escalation(s) appear to have been bypassed; halting`,
    );
    logEvent("bypassed_escalation", {
      count: bypassed.length,
      bypassed: bypassed.map((b) => ({
        file: b.name,
        host: b.gate.host || null,
        orchestrator: b.gate.orchestrator || null,
        reason: b.gate.escalation_reason || null,
      })),
    });
    process.exit(3);
  }

  const latest = gateFiles[0];
  const { gate, error } = loadGate(latest.full);

  if (error) {
    console.error(
      `[gate-validator] ERROR: Could not parse ${latest.name}: ${error}`,
    );
    console.error(
      `[gate-validator] Gate files must be valid JSON. See .devteam/rules/gates-core.md`,
    );
    process.exit(1);
  }

  // Inject orchestrator/host before checking required fields.
  autoInjectMetadata(gate, latest.full);

  const missing = missingRequired(gate);
  if (missing.length > 0) {
    console.error(
      `[gate-validator] INVALID GATE ${latest.name}: missing fields: ${missing.join(", ")}`,
    );
    process.exit(1);
  }

  if (!VALID_STATUSES.has(gate.status)) {
    console.error(
      `[gate-validator] UNKNOWN status "${gate.status}" in ${latest.name}`,
    );
    process.exit(1);
  }

  const retryErr = retryValidationError(gate);
  if (retryErr) {
    console.error(`[gate-validator] INVALID GATE ${latest.name}: ${retryErr}`);
    console.error(
      `[gate-validator] See .devteam/rules/gates-core.md §Retry Protocol`,
    );
    process.exit(1);
  }

  const escalationErr = escalationValidationError(gate);
  if (escalationErr) {
    console.error(`[gate-validator] INVALID GATE ${latest.name}: ${escalationErr}`);
    console.error(
      `[gate-validator] See .devteam/rules/gates-core.md §Non-interactive execution: always write the gate`,
    );
    process.exit(1);
  }

  const deployCostErr = deployCostGateError(gate);
  if (deployCostErr) {
    console.error(`[gate-validator] INVALID GATE ${latest.name}: ${deployCostErr}`);
    console.error(
      `[gate-validator] See .devteam/rules/stage-08.md §Cost Gate`,
    );
    process.exit(1);
  }

  const documentationScopeErr = documentationScopeError(gate);
  if (documentationScopeErr) {
    console.error(`[gate-validator] INVALID GATE ${latest.name}: ${documentationScopeErr}`);
    console.error(
      `[gate-validator] See .devteam/rules/stage-01.md §Documentation-only ownership`,
    );
    process.exit(1);
  }

  const documentationErr = documentationGateError(gate);
  if (documentationErr) {
    console.error(`[gate-validator] INVALID GATE ${latest.name}: ${documentationErr}`);
    console.error(
      `[gate-validator] See .devteam/rules/stage-07.md §Documentation gate`,
    );
    process.exit(1);
  }

  // Advisory checks (warnings only — do not change exit code).
  const advisories = [];
  if (!("track" in gate)) {
    advisories.push(
      `${latest.name} missing "track" field (add one of: ${[...VALID_TRACKS].join(", ")})`,
    );
  } else if (!VALID_TRACKS.has(gate.track)) {
    advisories.push(
      `${latest.name} has unrecognised track "${gate.track}"`,
    );
  }

  if (
    gate.stage === "stage-01" &&
    Array.isArray(gate.out_of_scope_items) &&
    gate.out_of_scope_items.length > 0 &&
    gate.active_roles == null
  ) {
    advisories.push(
      `stage-01 gate has out_of_scope_items but active_roles is not set — ` +
      `workstream suppression falls back to keyword inference; ` +
      `set active_roles explicitly in the gate for a reliable filter`,
    );
  }

  const malformedLessons = findMalformedReinforcedLines();
  for (const m of malformedLessons) {
    advisories.push(
      `lessons-learned.md:${m.lineNumber} malformed **Reinforced:** line: ${m.text}`,
    );
  }

  // Report final status based on most-recent gate.
  const { status, stage, host, orchestrator, workstream } = gate;
  const producer = host || orchestrator || "unknown";
  const stageLabel = workstream ? `${stage}/${workstream}` : stage;

  if (status === "PASS" || status === "WARN") {
    // Clear any injected blocker sections for stages that just resolved.
    // Idempotent — no-op when the markers aren't present.
    stripRedTeamBlockers(gate, process.cwd());
    stripQABuildBlockers(gate, process.cwd());
    const icon = status === "WARN" ? "⚠️ " : "✅";
    console.log(`[gate-validator] ${icon} GATE ${status} — ${stageLabel} (${producer})`);
    if (Array.isArray(gate.warnings) && gate.warnings.length > 0) {
      console.log(
        `[gate-validator] ⚠️  Warnings: ${gate.warnings.join("; ")}`,
      );
    }
    for (const a of advisories) console.log(`[gate-validator] ℹ️  ${a}`);
    logEvent(status === "WARN" ? "gate_warn" : "gate_pass", { stage, workstream, host, orchestrator, file: latest.name, warnings: gate.warnings || [] });
    process.exit(0);
  }

  if (status === "FAIL") {
    injectRedTeamBlockers(gate, process.cwd());
    injectQABuildBlockers(gate, process.cwd());
    console.log(`[gate-validator] ❌ GATE FAIL — ${stageLabel} (${producer})`);
    if (Array.isArray(gate.blockers) && gate.blockers.length > 0) {
      console.log(`[gate-validator] Blockers:`);
      gate.blockers.forEach((b) => console.log(`  - ${b}`));
    }
    for (const a of advisories) console.log(`[gate-validator] ℹ️  ${a}`);
    logEvent("gate_fail", { stage, workstream, host, orchestrator, file: latest.name, blockers: gate.blockers || [] });
    process.exit(2);
  }

  if (status === "ESCALATE") {
    console.log(`[gate-validator] 🚨 ESCALATION REQUIRED — ${stageLabel}`);
    console.log(
      `[gate-validator] Reason: ${gate.escalation_reason || "not specified"}`,
    );
    console.log(
      `[gate-validator] Decision needed: ${gate.decision_needed || "see gate file"}`,
    );
    if (gate.options) {
      console.log(`[gate-validator] Options: ${gate.options.join(" | ")}`);
    }
    for (const a of advisories) console.log(`[gate-validator] ℹ️  ${a}`);
    logEvent("gate_escalate", {
      stage, workstream, host, orchestrator, file: latest.name,
      reason: gate.escalation_reason || null,
      decision_needed: gate.decision_needed || null,
    });
    process.exit(3);
  }
}

// Top-level catch: distinguish error classes so a real filesystem problem
// (EACCES on pipeline/gates/, gates path is a regular file, etc.) halts the
// pipeline instead of silently green-lighting it. A runtime bug inside the
// validator itself still exits 0 with a warning, so a hook-side defect does
// not block every user session — the CI test suite is the authoritative
// check for validator correctness.
const HALT_FS_CODES = new Set([
  "EACCES",
  "EPERM",
  "ENOTDIR",
  "EISDIR",
  "EROFS",
]);

function runMain() {
  // Note: main() calls process.exit() on every branch, so wrapping it in
  // an OTel span here would leak unended spans. Validator runs are
  // short-lived and exit-on-decision; if we want a span for each
  // validate, instrument the caller (orchestrator) instead.
  try {
    main();
  } catch (err) {
    const code = err && err.code;
    if (code === "ENOENT") {
      // Expected absence (gates dir vanished between existsSync and readdir).
      process.exit(0);
    }
    if (HALT_FS_CODES.has(code)) {
      const msg = err.message || String(err);
      console.error(`[gate-validator] ❌ filesystem error (${code}): ${msg}`);
      console.error(
        `[gate-validator] Fix the underlying issue (permissions, path type) before re-running.`,
      );
      process.exit(1);
    }
    // Unknown / runtime error — likely a bug in this validator.
    //
    // Strict mode (--strict or CI=true): exit 1 so the unknown error does not
    // silently green-light the gate chain. CI is the authoritative check for
    // validator correctness; a validator bug must not pass CI.
    //
    // Hook mode (default): keep warn-and-pass so a validator defect does not
    // kill an interactive session. BUT always append to pipeline/validator-errors.log
    // so the failure is discoverable instead of vanishing into thin air.
    const msg = err && err.message ? err.message : String(err);
    const entry = `${new Date().toISOString()} [gate-validator] internal error: ${msg}\n`;
    try {
      const logPath = path.join(process.cwd(), "pipeline", "validator-errors.log");
      // Best-effort: if the pipeline dir doesn't exist yet, skip the log write
      // rather than masking the original error with a second ENOENT.
      if (fs.existsSync(path.join(process.cwd(), "pipeline"))) {
        fs.appendFileSync(logPath, entry, "utf8");
      }
    } catch {
      // Log write failed — still honour the STRICT_MODE exit below.
    }
    if (STRICT_MODE) {
      console.error(`[gate-validator] ❌ internal error (--strict / CI mode): ${msg}`);
      process.exit(1);
    }
    console.log(`[gate-validator] ⚠️  internal error: ${msg}; treating as PASS`);
    process.exit(0);
  }
}

if (require.main === module) {
  runMain();
}

// injectRedTeamBlockers is exported for core/verify/stamp.js (31.2): the
// mechanical red-team floor merges findings into the stage-04c gate
// in-process (not via the SubagentStop hook this file is normally invoked
// as), so it needs to trigger the same pipeline/context.md consequence
// plumbing directly rather than duplicating it.
// stageKey exported for reuse outside the validator: `devteam stage <name>`
// uses it to detect "dispatching a later stage while an earlier one has an
// unresolved ESCALATE gate" — the same later-stage-order comparison this
// file uses to flag a bypassed escalation after the fact.
module.exports = { main, runMain, VALID_TRACKS, injectRedTeamBlockers, stageKey };
