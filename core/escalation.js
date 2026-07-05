// Typed escalation contract (ADR-003 / Phase 2, PR-C1).
//
// The Principal resolves an escalation by writing ONE of two lines into
// pipeline/context.md:
//
//   PRINCIPAL-RULING: <topic> → <decision> [class: <slug>]
//       A binding ruling. The optional `[class: <slug>]` tags the ruling with
//       a bounded category (e.g. formatting-only, doc-only,
//       known-safe-dependency-bump). The category is what an operator may
//       pre-authorize for autonomous resolution via `--auto-rule` (PR-C2).
//       A ruling with no class parses as "unclassified" — never auto-rulable.
//
//   PRINCIPAL-CANNOT-DECIDE: <authority|information|value> → <question>
//       The escalation is underdetermined and the Principal must NOT guess.
//       The three reason classes are the only sources of underdetermination
//       (ADR-003 §3.1): missing AUTHORITY (commits a resource not granted),
//       missing INFORMATION (the deciding fact is outside every readable
//       artifact), or an irreducible VALUE tradeoff (the brief doesn't rank
//       two legitimate objectives). These always require a human; the driver
//       never auto-resolves them.
//
// This module only PARSES and READS these lines. PR-C2 (the driver) decides
// what to do with them. Legacy untyped rulings remain valid (class
// "unclassified").

const fs = require("node:fs");
const path = require("node:path");
const { splitCommand } = require("./command-line");

const RULING_PREFIX = "PRINCIPAL-RULING:";
const CANNOT_DECIDE_PREFIX = "PRINCIPAL-CANNOT-DECIDE:";
const REASON_CLASSES = ["authority", "information", "value"];

// B9 exemption: escalation.js reads/writes the global pipeline/context.md because
// the Principal agent always runs in in-place mode today. Wiring changeId through
// the escalation path is a follow-up item.
function contextPath(cwd) { return path.join(cwd, "pipeline", "context.md"); }

// Split a "<left> → <decision>" body on the first arrow (→ or ->).
function splitArrow(body) {
  const m = body.match(/^(.*?)(?:→|->)(.*)$/s);
  if (!m) return { left: body.trim(), right: "" };
  return { left: m[1].trim(), right: m[2].trim() };
}

/**
 * Parse a PRINCIPAL-RULING line into { topic, decision, class }.
 * Returns null if the line isn't a ruling. `class` defaults to "unclassified"
 * when no `[class: <slug>]` suffix is present.
 */
function parseRulingLine(line) {
  const trimmed = String(line).trim();
  if (!trimmed.startsWith(RULING_PREFIX)) return null;
  let body = trimmed.slice(RULING_PREFIX.length).trim();
  let cls = "unclassified";
  const classMatch = body.match(/\[class:\s*([a-z0-9][a-z0-9-]*)\s*\]\s*$/i);
  if (classMatch) {
    cls = classMatch[1].toLowerCase();
    body = body.slice(0, classMatch.index).trim();
  }
  const { left, right } = splitArrow(body);
  return { topic: left, decision: right, class: cls };
}

/**
 * Parse a PRINCIPAL-CANNOT-DECIDE line into { reason_class, question }.
 * Returns null if the line isn't a cannot-decide. reason_class falls back to
 * "unspecified" when the declared class isn't one of authority/information/value.
 */
function parseCannotDecideLine(line) {
  const trimmed = String(line).trim();
  if (!trimmed.startsWith(CANNOT_DECIDE_PREFIX)) return null;
  const body = trimmed.slice(CANNOT_DECIDE_PREFIX.length).trim();
  const { left, right } = splitArrow(body);
  const declared = left.toLowerCase();
  const reason_class = REASON_CLASSES.includes(declared) ? declared : "unspecified";
  return { reason_class, question: right };
}

function readContextLines(cwd) {
  const p = contextPath(cwd);
  if (!fs.existsSync(p)) return [];
  return fs.readFileSync(p, "utf8").split("\n");
}

/** All parsed rulings in context.md, in file order. */
function loadRulings(cwd) {
  return readContextLines(cwd).map(parseRulingLine).filter(Boolean);
}

/** All parsed cannot-decide declarations in context.md, in file order. */
function loadCannotDecide(cwd) {
  return readContextLines(cwd).map(parseCannotDecideLine).filter(Boolean);
}

/**
 * All Principal outputs (rulings AND cannot-decide), in file order, each tagged
 * with its type. Lets a caller (the driver) tell whether the *newest* output
 * since a known count was a ruling or a cannot-decide — context.md is
 * append-only, so the last entry is the latest decision.
 * @returns {Array<{type:"ruling"|"cannot-decide", [k:string]:any}>}
 */
function loadPrincipalOutputs(cwd) {
  const out = [];
  for (const line of readContextLines(cwd)) {
    const ruling = parseRulingLine(line);
    if (ruling) { out.push({ type: "ruling", ...ruling }); continue; }
    const cd = parseCannotDecideLine(line);
    if (cd) out.push({ type: "cannot-decide", ...cd });
  }
  return out;
}

// Raw PRINCIPAL-RULING lines (verbatim), in file order. The escalation
// applicator implements these as-written; for the typed/parsed view use
// loadRulings / loadPrincipalOutputs.
function loadPrincipalRulingLines(cwd) {
  return readContextLines(cwd).filter((l) => l.startsWith(RULING_PREFIX));
}

// Derive a ruling topic from an escalating gate's escalation_reason +
// decision_needed. Returns a string, or null if the gate can't be read.
function deriveTopicFromGate(targetGate) {
  try {
    const gate = JSON.parse(fs.readFileSync(targetGate, "utf8"));
    const reason = gate.escalation_reason || "";
    const decision = gate.decision_needed || "";
    const topic = reason + (decision ? ` — ${decision}` : "");
    return topic || `Escalation in ${path.basename(targetGate)}`;
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// Prompt rendering (relocated from bin/devteam so the driver can render +
// dispatch in-process rather than shelling out to the CLI).
// ---------------------------------------------------------------------------

// Render a Principal-ruling prompt — instructs the Principal subagent to read
// the cited context, weigh the question, and write a PRINCIPAL-RULING (or a
// typed PRINCIPAL-CANNOT-DECIDE) line into pipeline/context.md.
function renderPrincipalRulingPrompt(topic, contextPaths, targetGate) {
  const lines = [
    "# Principal Ruling Request",
    "",
    `**Topic:** ${topic}`,
    "",
    "You are the Principal Engineer. Your role brief lives at the",
    "installed path for the current host (`.claude/agents/principal.md`,",
    "`.codex/prompts/roles/principal.md`, or",
    "`.gemini/prompts/roles/principal.md`).",
    "",
    "Your task is to issue a binding ruling on the topic above.",
    "**This is not a pipeline stage — there is no gate to write.** The",
    "ruling is consumed by `devteam fix-escalation`, which dispatches",
    "agents or corrects gates to implement it. Be specific enough that",
    "the applicator can act without further guidance:",
    "",
    "- **Gate correction:** name the file, the wrong field, and the",
    "  correct value (e.g. 'stage-05.frontend.json: change review_shape",
    "  from scoped to matrix, required_approvals to 2, remove self-",
    "  review from approvals[]').",
    "- **Build fix:** name the workstream (backend / frontend / platform / qa)",
    "  and the specific file:line to change. The applicator will dispatch",
    "  `devteam stage build --workstream <role>`. Do NOT say",
    "  `devteam restart qa` — that restarts the QA TESTING stage (stage-06),",
    "  not the QA build workstream. Use 'dispatch QA build workstream' instead.",
    "- **Stage re-run:** name the stage with its correct devteam name:",
    "  build, pre-review, security-review, red-team, peer-review, qa",
    "  (testing), accessibility-audit, sign-off, deploy.",
    "- **Gate advance to WARN:** name the gate file and the warning text.",
    "",
    "## Read first",
    "",
    "- `pipeline/context.md` — current pipeline state and any prior",
    "  `PRINCIPAL-RULING:` lines you've already issued",
  ];
  for (const p of contextPaths) lines.push(`- \`${p}\``);
  if (targetGate) {
    lines.push(`- \`${targetGate}\` — the escalating gate that prompted this`);
    lines.push("  request. Read `escalation_reason` and `decision_needed`.");
  }
  lines.push("");
  lines.push("Plus any source files those documents cite (e.g. a finding at");
  lines.push("`src/backend/server.js:46` means you should open that file at");
  lines.push("that line).");
  lines.push("");
  lines.push("## What to write");
  lines.push("");
  lines.push("Append to `pipeline/context.md` under a `## Principal Rulings`");
  lines.push("section (create the section if it doesn't exist). Format:");
  lines.push("");
  lines.push("```markdown");
  lines.push("## Principal Rulings");
  lines.push("");
  lines.push(`PRINCIPAL-RULING: ${topic} → <your decision in 5-10 words> [class: <slug>]`);
  lines.push("");
  lines.push("<one-paragraph rationale — name the specific finding(s), the");
  lines.push("tradeoff you weighed, and the recommended next action. If");
  lines.push("must-fix: name the stage to restart and what to scope to. If");
  lines.push("defer: name the ticket/marker that should track the follow-up.>");
  lines.push("```");
  lines.push("");
  lines.push("Use crisp, concrete language. \"Must-fix because the wrong");
  lines.push("error class ships a lie to ops dashboards\" beats \"this seems");
  lines.push("important.\" Cite the file:line or finding ID where applicable.");
  lines.push("");
  lines.push("### Tag the ruling with a class");
  lines.push("");
  lines.push("End the `PRINCIPAL-RULING:` line with `[class: <slug>]` naming the");
  lines.push("KIND of decision in lowercase-kebab (e.g. `formatting-only`,");
  lines.push("`doc-only`, `known-safe-dependency-bump`, `scope-cut`,");
  lines.push("`security-tradeoff`). The class lets an operator pre-authorize");
  lines.push("autonomous resolution of bounded, low-stakes categories; omit it");
  lines.push("(or use `unclassified`) when the decision doesn't fit a clean,");
  lines.push("narrow category — unclassified rulings are never auto-applied.");
  lines.push("Pick the NARROWEST honest class; never inflate to fit a grant.");
  lines.push("");
  lines.push("### When you cannot decide");
  lines.push("");
  lines.push("If the answer is NOT derivable from the artifacts you can read,");
  lines.push("do not guess. Write this line instead of a ruling:");
  lines.push("");
  lines.push("```markdown");
  lines.push("PRINCIPAL-CANNOT-DECIDE: <authority|information|value> → <the precise question a human must answer>");
  lines.push("```");
  lines.push("");
  lines.push("Choose the reason class:");
  lines.push("- **authority** — the decision commits a resource you were never");
  lines.push("  granted (spend money, accept legal/security risk, change scope,");
  lines.push("  approve a production deploy). Reasoning cannot manufacture authority.");
  lines.push("- **information** — the deciding fact lives outside every readable");
  lines.push("  artifact (e.g. \"does the client accept this latency?\"). You can");
  lines.push("  name the missing fact but not know it.");
  lines.push("- **value** — two legitimate objectives conflict and the brief does");
  lines.push("  not rank them (ship-fast vs harden-now). Deriving a ranking would");
  lines.push("  be inventing a stakeholder's priority.");
  lines.push("");
  lines.push("Phrase the question so a human can answer it in one sentence or a");
  lines.push("choice. A precise \"cannot decide\" is a correct outcome, not a failure.");
  lines.push("");
  lines.push("## What NOT to do");
  lines.push("");
  lines.push("- Do not edit the escalating gate's status. That's the user's");
  lines.push("  call after reading your ruling.");
  lines.push("- Do not invoke any other subagent. This is a single Principal");
  lines.push("  ruling, not a re-run of the originating stage.");
  lines.push("- Do not write new source code. Read-only on `src/`.");
  lines.push("- Do not guess to avoid escalating. If the decision isn't");
  lines.push("  derivable from the artifacts, write `PRINCIPAL-CANNOT-DECIDE:`");
  lines.push("  rather than a low-confidence ruling.");
  lines.push("- Do not inflate a ruling's `[class:]` to match a grant you suspect");
  lines.push("  exists. Tag the narrowest honest category, or `unclassified`.");
  lines.push("");
  lines.push("When done, exit. The stage manager runs `devteam fix-escalation`");
  lines.push("to implement your ruling automatically — no hand-editing required.");
  return lines.join("\n");
}

// Render the escalation-applicator prompt — instructs an agent to implement
// the Principal's ruling so `devteam next` advances past the ESCALATE.
// Read stage-01 gate and return the active build workstreams for this project.
// Mirrors the inferActiveRoles logic in orchestrator.js but is self-contained
// here to avoid a circular dependency.
const BUILD_WORKSTREAMS = ["backend", "frontend", "platform", "qa"];
const BUILD_OOS_KEYWORDS = {
  frontend: ["frontend", "web ui", "web app", "browser", "ui layer"],
  backend:  ["backend", "api server", "rest api", "server-side"],
  platform: ["platform", "infrastructure", "infra"],
  qa:       ["qa workstream", "test workstream"],
};

function activeWorkstreamsFromStage01(cwd) {
  const s1Path = path.join(cwd, "pipeline", "gates", "stage-01.json");
  if (!fs.existsSync(s1Path)) return BUILD_WORKSTREAMS;
  try {
    const gate = JSON.parse(fs.readFileSync(s1Path, "utf8"));
    if (Array.isArray(gate.active_roles) && gate.active_roles.length > 0) {
      const filtered = gate.active_roles.filter(r => BUILD_WORKSTREAMS.includes(r));
      if (filtered.length > 0) return filtered;
    }
    if (Array.isArray(gate.out_of_scope_items) && gate.out_of_scope_items.length > 0) {
      const suppressed = new Set();
      for (const item of gate.out_of_scope_items) {
        const lower = item.toLowerCase();
        for (const [role, kw] of Object.entries(BUILD_OOS_KEYWORDS)) {
          if (kw.some(k => lower.includes(k))) suppressed.add(role);
        }
      }
      if (suppressed.size > 0) return BUILD_WORKSTREAMS.filter(r => !suppressed.has(r));
    }
  } catch { /* fall through */ }
  return BUILD_WORKSTREAMS;
}

function renderEscalationApplicatorPrompt(cwd, rulings, escalatingGate) {
  const activeWorkstreams = activeWorkstreamsFromStage01(cwd);
  const wsLabels = {
    backend:  ["dispatch backend build workstream", "devteam stage build --workstream backend --headless            "],
    frontend: ["dispatch frontend build workstream", "devteam stage build --workstream frontend --headless           "],
    platform: ["dispatch platform build workstream", "devteam stage build --workstream platform --headless           "],
    qa:       ["dispatch QA build workstream / qa build", "devteam stage build --workstream qa --headless                 "],
  };

  const lines = [
    "# Escalation Applicator",
    "",
    "The Principal has issued a ruling. Implement what it prescribes so",
    "`devteam next` advances past the current ESCALATE.",
    "",
    "## Read first",
    "",
    "- `pipeline/context.md` — find the `## Principal Rulings` section;",
    "  the most recent `PRINCIPAL-RULING:` line(s) are what you implement",
  ];
  if (escalatingGate) {
    lines.push(`- \`${escalatingGate}\` — the escalating gate`);
    lines.push("  - If this gate has `escalation_reason` containing retry-budget or");
    lines.push("    convergence exhaustion, treat it as a failed repair loop. You");
    lines.push("    must fix the underlying blocker(s), not clear/downgrade the gate.");
    lines.push("  - Read its `blockers[]`, `warnings[]`, `escalation_reason`, and");
    lines.push("    `decision_needed`; these are part of the work order.");
    lines.push("- Adjacent workstream gates in `pipeline/gates/`");
  }
  lines.push("- `pipeline/code-review/by-*.md` (if this is a peer-review escalation)");
  lines.push("");
  lines.push("## Allowed writes (write_file tool)");
  lines.push("");
  lines.push("You may write directly to:");
  lines.push("- `pipeline/gates/*.json` — correct a malformed gate (status, shape, fields)");
  lines.push("- `pipeline/code-review/by-*.md` — fix a peer-review document");
  lines.push("- `pipeline/runbook.md` — satisfy or repair the release runbook artifact");
  lines.push("- `README.md`, `CHANGELOG.md`, `docs/`, `changelog.d/` — satisfy documentation-only rulings");
  lines.push("Do NOT write to `pipeline/context.md` — that file is reserved for");
  lines.push("PRINCIPAL-RULING lines written by the ruling agent, not status reports.");
  lines.push("Use bash commands (devteam stage, devteam merge, devteam derive-approvals)");
  lines.push("to produce all other pipeline artifacts — they write their own files.");
  lines.push("Do not mark a gate as fixed until the artifact that satisfies it still exists");
  lines.push("within this allowed-write set.");
  lines.push("");
  lines.push("## Principal ruling(s) to implement");
  lines.push("");
  for (const r of rulings) lines.push(r);
  lines.push("");
  lines.push("## Routing table — ruling decision → command to run");
  lines.push("");
  lines.push("Read the Principal ruling above and pick the matching row:");
  lines.push("");
  lines.push("| Ruling says                              | Command to run                                                  |");
  lines.push("|------------------------------------------|-----------------------------------------------------------------|");
  for (const ws of activeWorkstreams) {
    if (wsLabels[ws]) {
      const [label, cmd] = wsLabels[ws];
      lines.push(`| ${label.padEnd(40)} | ${cmd}|`);
    }
  }
  lines.push("| re-run peer-review for [role]            | devteam stage peer-review --workstream [role] --headless        |");
  lines.push("| fix gate shape / correct gate            | Edit gate JSON, then devteam derive-approvals && devteam merge  |");
  lines.push("");
  lines.push("CRITICAL: when the ruling orders a build workstream dispatch, you MUST");
  lines.push("run `devteam stage build --workstream <role>`, NOT `devteam stage peer-review`.");
  lines.push("Dispatching peer-review instead wastes the auto-rule grant and will cause");
  lines.push("the pipeline to halt with 'applicator-did-not-dispatch-build'.");
  lines.push("");
  lines.push("## How to implement");
  lines.push("");
  lines.push("**Gate corrections** (wrong shape / status / approvals):");
  lines.push("Edit the gate file directly, then:");
  lines.push("  `devteam derive-approvals && devteam merge peer-review`");
  lines.push("Note: the approval-derivation hook overwrites `approvals[]` on");
  lines.push("every `by-*.md` write. Fix gate shape in the JSON directly.");
  lines.push("");
  lines.push("**Build fixes** (test bug, implementation gap):");
  lines.push("  `devteam stage build --workstream <role> --headless`");
  lines.push("  roles: backend, frontend, platform, qa");
  lines.push("If the ruling says a file is owned by a workstream, dispatch that");
  lines.push("workstream even if it was not part of the original active_roles set.");
  lines.push("Examples:");
  lines.push("- `package.json`, lockfiles, lint/typecheck config, Docker/compose, and");
  lines.push("  root toolchain scripts are platform-owned unless the design says");
  lines.push("  otherwise: run `devteam stage build --workstream platform --headless`.");
  lines.push("- A missing `npm run lint` script is a platform build fix, not a");
  lines.push("  pre-review gate correction.");
  lines.push("Do NOT use `devteam restart qa` for a build fix — that clears");
  lines.push("the QA testing stage (stage-06), not the build workstream.");
  lines.push("");
  lines.push("**Stage re-runs:**");
  lines.push("  `devteam stage <name> [--workstream <role>] --headless`");
  lines.push("  `devteam restart <name>` to clear gates before re-run");
  lines.push("Valid stage names: build, pre-review, security-review, red-team,");
  lines.push("  preflight, peer-review, qa, accessibility-audit,");
  lines.push("  observability-gate, verification-beyond-tests,");
  lines.push("  performance-budget, sign-off, retrospective, deploy");
  lines.push("Valid workstream roles for peer-review and build:");
  lines.push("  backend, frontend, platform, qa");
  lines.push("");
  lines.push("**After all fixes:** run `devteam merge <stage>` to rebuild the");
  lines.push("merged gate, then `devteam validate` to confirm it is valid.");
  lines.push("");
  lines.push("## What NOT to do");
  lines.push("");
  lines.push("- Do not call `devteam fix-escalation` — you ARE the escalation applicator;");
  lines.push("  calling it again spawns a second applicator that recurses infinitely.");
  lines.push("- Do not call `devteam ruling` — that is an interactive command for humans.");
  lines.push("- Do not write source code under `src/` (dispatch a build");
  lines.push("  workstream agent for that)");
  lines.push("- Do not resolve convergence exhaustion by changing an ESCALATE gate");
  lines.push("  to WARN/PASS while `blockers[]` still contains the unresolved issue");
  lines.push("  or verifier fields such as `lint_passed` / `tests_passed` remain false.");
  lines.push("  That is a false resolution; dispatch the owning build workstream.");
  lines.push("- Do not dispatch stages the ruling does not mention");
  lines.push("- Do not ask for confirmation — implement directly");
  lines.push("");
  lines.push("## Timeout guidance for long-running devteam commands");
  lines.push("");
  lines.push("`devteam stage build` and `devteam stage pre-review` dispatch a full model");
  lines.push("run and can take 5–30 minutes. Always pass `timeout_ms: 1800000` (30 min)");
  lines.push("when calling these via the bash tool. Example:");
  lines.push('  bash({ command: "devteam stage build --workstream backend --headless", timeout_ms: 1800000 })');
  lines.push("");
  lines.push("## Done when");
  lines.push("");
  lines.push("`devteam next` reports an action other than `resolve-escalation`.");
  lines.push("Run `devteam next` at the end and report its output.");
  return lines.join("\n");
}

function readGateIfPresent(gatePath) {
  if (!gatePath || !fs.existsSync(gatePath)) return null;
  try {
    const parsed = JSON.parse(fs.readFileSync(gatePath, "utf8"));
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

function isConvergenceEscalationGate(gate) {
  if (!gate || gate.status !== "ESCALATE") return false;
  const text = [
    gate.escalation_reason,
    gate.decision_needed,
    ...(Array.isArray(gate.blockers) ? gate.blockers : []),
  ].join("\n");
  return /\b(convergence|retry budget exhausted|no-progress|no-source-change)\b/i.test(text);
}

function hasUnresolvedGateFailure(gate) {
  if (!gate || typeof gate !== "object") return false;
  if (Array.isArray(gate.blockers) && gate.blockers.length > 0) return true;
  for (const field of [
    "lint_passed",
    "tests_passed",
    "type_check_passed",
    "dependency_review_passed",
    "license_check_passed",
  ]) {
    if (gate[field] === false) return true;
  }
  return false;
}

function guardConvergenceGateResolution(gatePath, beforeGate) {
  if (!gatePath || !isConvergenceEscalationGate(beforeGate)) return null;
  const afterGate = readGateIfPresent(gatePath);
  if (!afterGate || afterGate.status === "ESCALATE") return null;
  if (!hasUnresolvedGateFailure(afterGate)) return null;
  try {
    fs.writeFileSync(gatePath, JSON.stringify(beforeGate, null, 2) + "\n", "utf8");
  } catch { /* validation still reports the violation */ }
  return {
    code: "invalid-convergence-resolution",
    message:
      "escalation applicator changed a convergence-exhausted gate out of ESCALATE " +
      "while blockers or verifier failures remain; restored the original gate",
  };
}

// ---------------------------------------------------------------------------
// Dispatch (relocated + unified from cmdRuling / cmdFixEscalation).
// ---------------------------------------------------------------------------

// Dispatch `prompt` to the principal-routed host headlessly. Returns a Promise
// of { exitCode, host }. Throws (with a CLI-compatible message) if the host
// can't be loaded or doesn't support headless — callers convert to their own
// exit.
//
// `allowedWrites` controls which file paths the host may target. Adapters with
// an invoke() hook receive the pre-rendered prompt so they can use host-specific
// prompt transport (for example Omnigent's --prompt argument) and audit writes
// consistently. Plain headless adapters fall back to piping the prompt to stdin.
// Callers should pass the tightest set that their agent actually needs:
//   - Principal ruling writer: ["pipeline/context.md"]
//   - Escalation applicator: gates, code-review notes, runbook, and docs surfaces
function dispatchToPrincipal(cwd, prompt, { label = "principal", allowedWrites = ["pipeline/context.md"] } = {}) {
  const { loadConfig } = require("./config");
  const { loadAdapter } = require("./router");
  const config = loadConfig(cwd);
  const host = (config.routing.roles && config.routing.roles.principal) || config.routing.default_host;
  let adapter;
  try {
    adapter = loadAdapter(host);
  } catch (err) {
    throw new Error(`Could not load adapter "${host}" for principal role: ${err.message}`);
  }
  if (!adapter.capabilities || !adapter.capabilities.headless) {
    throw new Error(`Principal host "${host}" does not support --headless (capabilities.headless is false).`);
  }

  if (typeof adapter.invoke === "function") {
    const descriptor = {
      workstreamId: label,
      stage: label,
      role: "principal",
      allowedWrites,
    };
    const ctx = { cwd, isolation: "in-place", log: true };
    const mode = adapter.capabilities.httpNative ? "http-native" : "headless";
    process.stderr.write(`[devteam] dispatching ${label} → ${host} (${mode})\n`);
    return adapter.invoke(descriptor, ctx, prompt).then((result) => {
      if (Array.isArray(result.writeViolations) && result.writeViolations.length > 0) {
        for (const v of result.writeViolations) {
          process.stderr.write(`[devteam] ⚠ ${label}: unauthorized write "${v}" (outside allowedWrites) — removing\n`);
          try { fs.unlinkSync(path.join(cwd, v)); } catch { /* ignore */ }
        }
        return { exitCode: result.exitCode === 0 ? 1 : result.exitCode, host, writeViolations: result.writeViolations };
      }
      return { exitCode: result.exitCode, host };
    });
  }

  const cmdString = process.env.DEVTEAM_HEADLESS_COMMAND || adapter.capabilities.headlessCommand;
  if (!cmdString) throw new Error(`Host "${host}" declares no headlessCommand.`);

  const { spawn } = require("node:child_process");
  let bin, args;
  try {
    ({ bin, args } = splitCommand(cmdString, "headlessCommand"));
  } catch (err) {
    throw new Error(`Invalid headlessCommand "${cmdString}": ${err.message}`);
  }
  process.stderr.write(`[devteam] dispatching ${label} → ${host} (headless)\n`);
  return new Promise((resolve) => {
    const child = spawn(bin, args, { cwd, stdio: ["pipe", "inherit", "inherit"] });
    child.on("error", (err) => { process.stderr.write(`[devteam] spawn error: ${err.message}\n`); resolve({ exitCode: 1, host }); });
    child.on("close", (code) => resolve({ exitCode: code === null ? 1 : code, host }));
    // Swallow EPIPE if the host exits before reading stdin (matches runHeadless).
    child.stdin.on("error", () => { /* */ });
    child.stdin.write(prompt);
    child.stdin.end();
  });
}

// High-level: render + dispatch a Principal ruling. The driver calls this
// in-process (PR-C2 previously shelled out to `devteam ruling`).
function runRuling(cwd, { topic, targetGate = null, contextPaths = [] } = {}) {
  const resolvedTopic = topic
    || (targetGate ? deriveTopicFromGate(targetGate) : null)
    || "Escalation ruling";
  const prompt = renderPrincipalRulingPrompt(resolvedTopic, contextPaths, targetGate);
  return dispatchToPrincipal(cwd, prompt, { label: "principal-ruling" });
}

// High-level: render + dispatch the escalation applicator. Returns
// { exitCode } (exitCode 2 when there is no ruling to apply).
function runFixEscalation(cwd, { escalatingGate = null } = {}) {
  const rulings = loadPrincipalRulingLines(cwd);
  if (rulings.length === 0) return Promise.resolve({ exitCode: 2, reason: "no rulings" });
  const beforeGate = readGateIfPresent(escalatingGate);
  const prompt = renderEscalationApplicatorPrompt(cwd, rulings, escalatingGate);
  return dispatchToPrincipal(cwd, prompt, {
    label: "escalation-applicator",
    allowedWrites: [
      "pipeline/gates/*.json",
      "pipeline/code-review/by-*.md",
      "pipeline/runbook.md",
      "README.md",
      "CHANGELOG.md",
      "docs/",
      "changelog.d/",
    ],
  }).then((result) => {
    const violation = guardConvergenceGateResolution(escalatingGate, beforeGate);
    if (!violation) return result;
    process.stderr.write(`[devteam] ${violation.code}: ${violation.message}\n`);
    return { ...result, exitCode: result.exitCode === 0 ? 1 : result.exitCode, violation: violation.code };
  });
}

// Returns true when the principal-routed host is httpNative (e.g. openai-compat).
// Used by CLI commands to skip the "print prompt for manual paste" path — there
// is no interactive fallback for httpNative hosts; they always auto-dispatch.
function isHttpNativePrincipal(cwd) {
  try {
    const { loadConfig } = require("./config");
    const { loadAdapter } = require("./router");
    const config = loadConfig(cwd);
    const host = (config.routing.roles && config.routing.roles.principal) || config.routing.default_host;
    const adapter = loadAdapter(host);
    return !!(adapter.capabilities && adapter.capabilities.httpNative);
  } catch {
    return false;
  }
}

module.exports = {
  RULING_PREFIX,
  CANNOT_DECIDE_PREFIX,
  REASON_CLASSES,
  parseRulingLine,
  parseCannotDecideLine,
  loadRulings,
  loadCannotDecide,
  loadPrincipalOutputs,
  loadPrincipalRulingLines,
  deriveTopicFromGate,
  renderPrincipalRulingPrompt,
  renderEscalationApplicatorPrompt,
  guardConvergenceGateResolution,
  hasUnresolvedGateFailure,
  isConvergenceEscalationGate,
  dispatchToPrincipal,
  isHttpNativePrincipal,
  runRuling,
  runFixEscalation,
};
