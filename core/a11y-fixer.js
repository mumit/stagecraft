// core/a11y-fixer.js
//
// Automated remediation for accessibility-audit (stage-06b) failures.
//
// When devteam advise --apply <id>=A is chosen for an A11Y_FIX item:
//   1. Dispatches the frontend adapter headlessly with a targeted prompt
//      listing the exact WCAG fixes required (element + remediation text).
//   2. After the agent exits, deletes pipeline/gates/stage-06b.json.
//   3. Re-runs the accessibility audit via runStageHeadless to verify.
//   4. Returns { status, remainingBlockers } so the caller can write the
//      appropriate marker to pipeline/context.md.
//
// Only safe for ARIA-attribute and minor HTML fixes (type=, aria-live=, etc.).
// Structural changes (new elements, changed IDs) that could break tests are
// flagged as a warning before dispatch; the caller decides whether to proceed.

"use strict";

const fs   = require("node:fs");
const path = require("node:path");
const { invokeAdapterTask } = require("./adapters/invoke-task");

function loadDeps() {
  const { loadConfig }   = require("./config");
  const { loadAdapter }  = require("./router");
  const { runStageHeadless } = require("./orchestrator");
  return { loadConfig, loadAdapter, runStageHeadless };
}

// Resolve the configured host for the frontend role (or default).
function resolveFrontendHost(cwd) {
  const { loadConfig, loadAdapter } = loadDeps();
  const config   = loadConfig(cwd);
  const hostName = (config.routing.roles && config.routing.roles.frontend)
    || config.routing.default_host;
  if (!hostName) {
    throw new Error(
      "No host configured for frontend role. Set routing.default_host in .devteam/config.yml.",
    );
  }
  return { hostName, adapter: loadAdapter(hostName) };
}

// Parse a blocker entry from stage-06b.json.
// Blockers may be JSON-encoded strings or plain objects.
function parseBlocker(b) {
  if (typeof b === "string") {
    try { b = JSON.parse(b); } catch { return { id: "", element: "", remediation: b }; }
  }
  if (typeof b !== "object" || b === null) return null;
  const desc = b.description || "";
  const remMatch = desc.match(/Remediation:\s*(.+)/i);
  return {
    id:          b.id      || "",
    element:     b.element || "",
    wcag:        b.wcag    || "",
    remediation: remMatch ? remMatch[1].trim() : desc,
    severity:    b.severity || "",
  };
}

// Heuristic: does this blocker require structural HTML changes (new elements,
// changed IDs, etc.) that could invalidate the existing test suite?
function isStructuralFix(parsed) {
  const text = parsed.remediation.toLowerCase();
  return (
    text.includes("add a label") ||
    text.includes("new element") ||
    text.includes("replace") ||
    text.includes("skip-link") ||
    text.includes("skip navigation") ||
    text.includes("change id") ||
    text.includes("rename id")
  );
}

// Build the targeted fix prompt sent through the frontend adapter.
function buildA11yFixPrompt(blockers) {
  const parsed = blockers.map(parseBlocker).filter(Boolean);
  if (parsed.length === 0) return "";

  const lines = [];
  lines.push("You are the frontend developer. Apply these specific WCAG 2.1 AA");
  lines.push("accessibility fixes to `src/frontend/index.html`.");
  lines.push("");
  lines.push("Rules:");
  lines.push("- Make ONLY the changes listed below.");
  lines.push("- Do not refactor, rename, or restructure anything else.");
  lines.push("- Do not create new files or write any gate files.");
  lines.push("- After applying each fix, confirm it in a single stdout line:");
  lines.push('  "Fixed <ID>: <one-line description of the change made>"');
  lines.push("");
  lines.push("## Fixes to apply");
  lines.push("");
  for (let i = 0; i < parsed.length; i++) {
    const b = parsed[i];
    const header = [
      `Fix ${i + 1}`,
      b.id      ? `(${b.id})`      : "",
      b.wcag    ? `— WCAG ${b.wcag}` : "",
      b.element ? `— element: \`${b.element}\`` : "",
    ].filter(Boolean).join(" ");
    lines.push(`### ${header}`);
    lines.push(`Apply: ${b.remediation}`);
    lines.push("");
  }
  return lines.join("\n");
}

// Delete the FAIL gate, re-run the accessibility audit, return the new gate status.
async function rerunAccessibilityAudit(cwd, timeoutMs) {
  // B9 exemption: a11y-fixer is called from the escalation applicator, which
  // always runs in in-place mode today. Bounded-mode support can follow when
  // escalation.js is wired for changeId (plans/phase-1-trust-consolidation.md §1.6).
  const gatePath = path.join(cwd, "pipeline", "gates", "stage-06b.json");
  try { fs.unlinkSync(gatePath); } catch { /* may already be gone */ }

  const { runStageHeadless } = loadDeps();
  try {
    await runStageHeadless("accessibility-audit", {
      cwd,
      timeoutMs: typeof timeoutMs === "number" ? timeoutMs : 0,
    });
  } catch (err) {
    return { status: "dispatch-failed", remainingBlockers: [], reason: err.message };
  }

  if (!fs.existsSync(gatePath)) {
    return { status: "MISSING", remainingBlockers: [], reason: "gate not written after re-run" };
  }
  try {
    const gate = JSON.parse(fs.readFileSync(gatePath, "utf8"));
    return {
      status:            gate.status || "UNKNOWN",
      remainingBlockers: gate.blockers || [],
    };
  } catch {
    return { status: "UNREADABLE", remainingBlockers: [], reason: "gate JSON unreadable" };
  }
}

// Main entry point.
//
// opts:
//   timeoutMs  — wall-clock cap for the agent dispatch (0 = no limit)
//   _adapter   — override adapter for tests
//
// Returns:
//   { status, remainingBlockers, exitCode, reason? }
//   status: "PASS" | "FAIL" | "dispatch-failed" | "MISSING" | "UNREADABLE"
async function fixA11yBlockers(cwd, blockers, opts = {}) {
  if (!Array.isArray(blockers) || blockers.length === 0) {
    return {
      status: "dispatch-failed",
      remainingBlockers: [],
      exitCode: 1,
      reason: "no blockers provided",
    };
  }

  // Warn if any blocker looks structural; caller can still proceed.
  const parsed = blockers.map(parseBlocker).filter(Boolean);
  const structural = parsed.filter(isStructuralFix);
  if (structural.length > 0) {
    const ids = structural.map((b) => b.id || "(no id)").join(", ");
    process.stderr.write(
      `[devteam] a11y-fix: WARNING — ${structural.length} fix(es) may require structural HTML changes ` +
      `(${ids}). If tests assert HTML structure, re-run QA after the fix.\n`,
    );
  }

  // Resolve host adapter.
  let hostName, adapter;
  if (opts._adapter) {
    hostName = "test-override";
    adapter  = opts._adapter;
  } else {
    try {
      ({ hostName, adapter } = resolveFrontendHost(cwd));
    } catch (err) {
      return { status: "dispatch-failed", remainingBlockers: blockers, exitCode: 1, reason: err.message };
    }
  }

  if (!adapter.capabilities || !adapter.capabilities.headless) {
    return {
      status:            "dispatch-failed",
      remainingBlockers: blockers,
      exitCode:          1,
      reason:            `host "${hostName}" does not support headless (capabilities.headless is false)`,
    };
  }

  if (typeof adapter.invoke !== "function") {
    return {
      status:            "dispatch-failed",
      remainingBlockers: blockers,
      exitCode:          1,
      reason:            `headless host "${hostName}" does not implement adapter.invoke()`,
    };
  }

  const prompt = buildA11yFixPrompt(blockers);
  process.stderr.write(`[devteam] dispatching frontend → ${hostName} (a11y fix, headless)\n`);
  let dispatch;
  try {
    dispatch = await invokeAdapterTask({
      adapter,
      host: hostName,
      cwd,
      prompt,
      label: "a11y-fix",
      role: "frontend",
      allowedWrites: ["src/frontend/index.html"],
      toolBudget: ["Read", "Write"],
      timeoutMs: opts.timeoutMs,
      tee: true,
    });
  } catch (err) {
    return { status: "dispatch-failed", remainingBlockers: blockers, exitCode: 1, reason: err.message };
  }
  const writeViolations = Array.isArray(dispatch.writeViolations) ? dispatch.writeViolations : [];
  const exitCode = writeViolations.length > 0 && dispatch.exitCode === 0 ? 1 : dispatch.exitCode;

  if (exitCode !== 0) {
    process.stderr.write(
      `[devteam] a11y-fix agent exited ${exitCode} — ` +
      `src/frontend/index.html unchanged, gate not modified\n`,
    );
    return {
      status: "dispatch-failed",
      remainingBlockers: blockers,
      exitCode: exitCode === null ? 1 : exitCode,
      ...(writeViolations.length > 0 ? { reason: `unauthorized writes: ${writeViolations.join(", ")}` } : {}),
    };
  }

  process.stderr.write("[devteam] a11y-fix complete — re-running accessibility audit to verify…\n");
  const auditResult = await rerunAccessibilityAudit(cwd, opts.timeoutMs);

  if (auditResult.status === "PASS") {
    process.stderr.write("[devteam] accessibility-audit: PASS — all blockers resolved\n");
  } else if (auditResult.status === "dispatch-failed" || auditResult.status === "MISSING" || auditResult.status === "UNREADABLE") {
    process.stderr.write(
      `[devteam] accessibility-audit re-run failed (${auditResult.status})` +
      `${auditResult.reason ? `: ${auditResult.reason}` : ""}\n`,
    );
  } else {
    const n = auditResult.remainingBlockers.length;
    process.stderr.write(
      `[devteam] accessibility-audit: ${auditResult.status}` +
      ` — ${n} blocker${n !== 1 ? "s" : ""} remain\n`,
    );
  }

  return {
    status:            auditResult.status,
    remainingBlockers: auditResult.remainingBlockers,
    exitCode:          auditResult.status === "PASS" ? 0 : 1,
    reason:            auditResult.reason,
  };
}

module.exports = { fixA11yBlockers, buildA11yFixPrompt, parseBlocker };
