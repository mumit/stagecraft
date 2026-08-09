"use strict";

// Grounded conversational front-end. Natural-language turns are delegated
// through an adapter, but all project facts are assembled locally by
// core/coordinator.js and no action command is ever executed from chat.

const path = require("node:path");
const readline = require("node:readline");
const { generateHelp } = require(path.join(__dirname, "..", "flags"));
const {
  coordinatorTurn,
  projectSnapshot,
} = require(path.join(__dirname, "..", "..", "coordinator"));

const name = "chat";

const flags = {
  cwd:          { type: "string", description: "Target project directory" },
  feature:      { type: "string", description: "Feature description for bounded isolation lookup" },
  host:         { type: "string", description: "Headless host override (supports acp:<agent-command>)" },
  model:        { type: "string", description: "Model override for this conversation" },
  "timeout-ms": { type: "number", description: "Per-turn host timeout in milliseconds" },
  json:         { type: "boolean", description: "JSON output for a one-shot question" },
  "dry-run":    { type: "boolean", description: "Print the grounded prompt without calling a host" },
  help:         { type: "boolean", description: "Show this help" },
};

function printSnapshot(snapshot) {
  const run = snapshot.run;
  process.stdout.write(`track: ${snapshot.pipeline.track}\n`);
  process.stdout.write(`run:   ${run ? `${run.status || "present"}; stage ${run.current_stage || "—"}; ${run.iterations} iteration(s)` : "none"}\n`);
  process.stdout.write(`cost:  ${run?.cost_usd != null ? `$${run.cost_usd.toFixed(4)} (${run.cost_basis || "basis unavailable"})` : "unavailable"}\n`);
  process.stdout.write(`next:  ${snapshot.next ? `${snapshot.next.action}${snapshot.next.name ? ` — ${snapshot.next.name}` : ""}` : "unavailable"}\n`);
  if (snapshot.next?.reason) process.stdout.write(`why:   ${snapshot.next.reason}\n`);
  if (snapshot.next?.suggested_command) process.stdout.write(`try:   ${snapshot.next.suggested_command}\n`);
}

function printUsage(usage, host, model) {
  if (!host && !usage) return;
  const parts = [`host=${host || "unknown"}`];
  if (model) parts.push(`model=${model}`);
  if (typeof usage?.tokensIn === "number") parts.push(`in=${usage.tokensIn}`);
  if (typeof usage?.tokensOut === "number") parts.push(`out=${usage.tokensOut}`);
  if (typeof usage?.cachedTokens === "number") parts.push(`cached=${usage.cachedTokens}`);
  if (typeof usage?.costUsd === "number") parts.push(`cost=$${usage.costUsd.toFixed(4)}`);
  process.stderr.write(`[devteam chat] ${parts.join(" ")}\n`);
}

function oneShotOptions(cwd, question, flags, history = []) {
  return {
    cwd,
    question,
    history,
    feature: flags.feature,
    host: flags.host,
    model: flags.model,
    timeoutMs: flags.timeoutMs,
    dryRun: flags.dryRun === true,
  };
}

async function runOneShot(cwd, question, flags) {
  const result = await coordinatorTurn(oneShotOptions(cwd, question, flags));
  if (flags.dryRun) {
    if (flags.json) {
      process.stdout.write(`${JSON.stringify({ prompt: result.prompt, snapshot: result.snapshot }, null, 2)}\n`);
    } else {
      process.stdout.write(`${result.prompt}\n`);
    }
    return;
  }
  if (flags.json) {
    process.stdout.write(`${JSON.stringify({
      response: result.response,
      host: result.host,
      model: result.model,
      usage: result.usage,
      snapshot_generated_at: result.snapshot.generated_at,
    }, null, 2)}\n`);
  } else {
    process.stdout.write(`${result.response}\n`);
    printUsage(result.usage, result.host, result.model);
  }
}

async function runInteractive(cwd, flags) {
  if (!process.stdin.isTTY || !process.stdout.isTTY) {
    throw new Error("chat needs a question when input or output is not a TTY; try: devteam chat \"what should I do next?\"");
  }
  if (flags.json || flags.dryRun) {
    throw new Error("--json and --dry-run require a one-shot question");
  }

  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  const history = [];
  process.stdout.write(
    "Stagecraft coordinator — grounded, advisory, and read-only\n" +
    "Each natural-language message is one model call. /help lists local commands.\n\n",
  );
  rl.setPrompt("you> ");
  rl.prompt();
  for await (const raw of rl) {
    const question = raw.trim();
    if (!question) { rl.prompt(); continue; }
    if (question === "/quit" || question === "/exit") break;
    if (question === "/help") {
      process.stdout.write(
        "/status, /context  show the locally computed project snapshot\n" +
        "/next              show the next action and suggested command\n" +
        "/refresh           recompute project state\n" +
        "/quit              end the session\n",
      );
      rl.prompt();
      continue;
    }
    if (["/status", "/context", "/next", "/refresh"].includes(question)) {
      const snapshot = projectSnapshot(cwd, { feature: flags.feature });
      if (question === "/refresh") process.stdout.write(`refreshed ${snapshot.generated_at}\n`);
      else if (question === "/next") {
        process.stdout.write(`${snapshot.next?.action || "unavailable"}${snapshot.next?.name ? ` — ${snapshot.next.name}` : ""}\n`);
        if (snapshot.next?.reason) process.stdout.write(`${snapshot.next.reason}\n`);
        if (snapshot.next?.suggested_command) process.stdout.write(`${snapshot.next.suggested_command}\n`);
      } else printSnapshot(snapshot);
      rl.prompt();
      continue;
    }
    if (question.startsWith("/")) {
      process.stdout.write(`unknown local command: ${question} (try /help)\n`);
      rl.prompt();
      continue;
    }

    try {
      const result = await coordinatorTurn(oneShotOptions(cwd, question, flags, history));
      process.stdout.write(`\ncoordinator> ${result.response}\n`);
      printUsage(result.usage, result.host, result.model);
      history.push({ role: "user", text: question }, { role: "assistant", text: result.response });
      if (history.length > 16) history.splice(0, history.length - 16);
    } catch (err) {
      process.stderr.write(`[devteam chat] ${err.message}\n`);
    }
    process.stdout.write("\n");
    rl.prompt();
  }
  rl.close();
}

async function runAsync(positional, _flags) {
  if (_flags.help) {
    process.stdout.write(`${generateHelp("devteam chat [\"question\"] [options]", flags)}\n`);
    return;
  }
  const cwd = _flags.cwd || process.cwd();
  const { requireProjectContext } = require(path.join(__dirname, "..", "project-guard"));
  requireProjectContext(cwd, _flags, "chat");
  const question = positional.join(" ").trim();
  if (question) return runOneShot(cwd, question, _flags);
  return runInteractive(cwd, _flags);
}

function run(positional, _flags) {
  return runAsync(positional, _flags).catch((err) => {
    if (_flags.json) {
      process.stdout.write(`${JSON.stringify({ error: "chat-failed", message: err.message }, null, 2)}\n`);
    } else {
      process.stderr.write(`devteam chat: ${err.message}\n`);
    }
    process.exitCode = 1;
  });
}

module.exports = { name, flags, printSnapshot, run, runAsync };
