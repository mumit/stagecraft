"use strict";

const fs = require("node:fs");
const path = require("node:path");
const { generateHelp } = require(path.join(__dirname, "..", "flags"));
const { getOrchestrator } = require(path.join(__dirname, "..", "get-orchestrator"));
const _escalation = require(path.join(__dirname, "..", "..", "escalation"));
const renderPrincipalRulingPrompt = _escalation.renderPrincipalRulingPrompt;
const isHttpNativePrincipal = _escalation.isHttpNativePrincipal;

const name = "ruling";

const flags = {
  cwd:           { type: "string",  description: "Target project directory" },
  topic:         { type: "string",  description: "Ruling topic (auto-derived when omitted)" },
  context:       { type: "string",  description: "Comma-separated extra context paths" },
  "target-gate": { type: "string",  description: "Path to the escalating gate" },
  headless:      { type: "boolean", description: "Dispatch via host CLI non-interactively" },
  help:          { type: "boolean", description: "Show this help" },
};

// `devteam ruling --topic "..." [--context paths] [--target-gate path] [--headless]`
// Dispatches the Principal subagent for an ad-hoc ruling — outside the
// normal stage flow. Used to resolve escalations that need Principal
// judgment without re-running an entire stage. The ruling lands in
// pipeline/context.md as a PRINCIPAL-RULING line; no gate is written.
async function run(positional, _flags) {
  if (_flags.help) { console.log(generateHelp("devteam ruling [options]", flags)); process.exit(0); }
  const cwd = _flags.cwd || process.cwd();
  let topic = _flags.topic;
  let targetGate = _flags.targetGate;
  const contextPaths = _flags.context ? _flags.context.split(",").map((s) => s.trim()).filter(Boolean) : [];

  // Auto-derive topic from the escalating gate when --topic is omitted.
  if (!topic) {
    if (!targetGate) {
      // Try to locate the escalating gate via devteam next
      try {
        const { next } = getOrchestrator();
        const nr = next({ cwd });
        if (nr.action === "resolve-escalation" && nr.gate) {
          targetGate = nr.gate;
        }
      } catch { /* ignore */ }
    }
    if (targetGate) {
      try {
        const gate = JSON.parse(fs.readFileSync(targetGate, "utf8"));
        const reason = gate.escalation_reason || "";
        const decision = gate.decision_needed || "";
        topic = reason + (decision ? ` — ${decision}` : "");
        if (!topic) topic = `Escalation in ${path.basename(targetGate)}`;
        process.stderr.write(`[devteam] ruling topic (auto-derived): ${topic}\n`);
      } catch {
        console.error(`devteam ruling: could not read target gate at ${targetGate}`);
        process.exit(1);
      }
    } else {
      console.error("Usage: devteam ruling [--topic \"...\"] [--context <paths>] [--target-gate <path>] [--headless]");
      console.error("");
      console.error("--topic is optional when run from a directory with an active ESCALATE gate;");
      console.error("the topic is auto-derived from the gate's escalation_reason and decision_needed.");
      console.error("See `docs/runbooks/escalation.md` for the full flow.");
      process.exit(2);
    }
  }

  const prompt = renderPrincipalRulingPrompt(topic, contextPaths, targetGate, cwd);

  if (!_flags.headless && !isHttpNativePrincipal(cwd)) {
    // User-driven mode: print the prompt for paste-into-host.
    // httpNative hosts have no interactive fallback; they always auto-dispatch.
    const onboarding = [
      "════════════════════════════════════════════════════════════════════",
      `  Principal-ruling prompt for: ${topic}`,
      "  Paste the prompt below into your AI tool with the Principal",
      "  subagent active. The Principal will write its ruling into",
      "  pipeline/context.md under `## Principal Rulings`.",
      "════════════════════════════════════════════════════════════════════",
      "",
    ].join("\n");
    process.stderr.write(onboarding);
    console.log(prompt);
    return;
  }

  // Headless mode: dispatch via the shared in-process helper in core.
  let exitCode;
  try {
    ({ exitCode } = await _escalation.dispatchToPrincipal(cwd, prompt, { label: "principal-ruling" }));
  } catch (err) {
    console.error(err.message);
    if (/does not support --headless/.test(err.message)) {
      console.error("Run without --headless to print the prompt for interactive use.");
    }
    process.exit(1);
  }

  if (exitCode === 0) {
    process.stderr.write(`[devteam] principal-ruling complete. Read pipeline/context.md for the ruling.\n`);
    process.stderr.write(`[devteam] Run \`devteam fix-escalation [--headless]\` to apply it.\n`);
  } else {
    process.stderr.write(`[devteam] principal-ruling exited ${exitCode}\n`);
    process.exit(exitCode);
  }
}

module.exports = { name, flags, run };
