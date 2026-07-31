#!/usr/bin/env node
// generate-hosts-ref.js
//
// Emits docs/reference/hosts.md — a capability/enforcement matrix derived
// from hosts/*/capabilities.json. Output is fenced with
// <!-- generated: do not hand-edit --> markers; scripts/consistency.js
// verifies the committed file equals fresh output.
//
// Usage:
//   node scripts/generate-hosts-ref.js          # print to stdout
//   node scripts/generate-hosts-ref.js --write  # write docs/reference/hosts.md

"use strict";

const fs   = require("node:fs");
const path = require("node:path");

const ROOT = path.resolve(__dirname, "..");

// ── Load all host capabilities ────────────────────────────────────────────
function loadAllCapabilities() {
  const hostsDir = path.join(ROOT, "hosts");
  const results = [];
  let entries;
  try {
    entries = fs.readdirSync(hostsDir, { withFileTypes: true });
  } catch {
    return results;
  }

  for (const e of entries) {
    if (!e.isDirectory()) continue;
    const capPath = path.join(hostsDir, e.name, "capabilities.json");
    if (!fs.existsSync(capPath)) continue;
    try {
      const cap = JSON.parse(fs.readFileSync(capPath, "utf8"));
      results.push(cap);
    } catch {
      // skip malformed
    }
  }

  // Sort deterministically by name for stable output
  results.sort((a, b) => (a.name || "").localeCompare(b.name || ""));
  return results;
}

// ── Boolean rendering helpers ─────────────────────────────────────────────
function yesNo(val) {
  if (val === true)  return "yes";
  if (val === false) return "no";
  if (val == null)   return "—";
  return String(val);
}

// Render enforces.* level; some fields are booleans (shell, network) meaning enforced/not
function enforceLevel(val) {
  if (val === true)  return "enforced";
  if (val === false) return "not enforced";
  if (val == null)   return "—";
  return String(val);  // e.g. "tool-call-time", "post-hoc-audit", "prompt-only"
}

// Pad a string to at least `width` characters
function pad(s, width) {
  return s + " ".repeat(Math.max(0, width - s.length));
}

// ── Render ────────────────────────────────────────────────────────────────
function renderTable(caps) {
  const lines = [];

  // ── Capability matrix ──────────────────────────────────────────────
  lines.push("### Capabilities");
  lines.push("");

  const capHeaders = [
    "Host", "Display name", "headless", "hooks", "subagents",
    "slashCommands", "worktrees", "goalLoop", "telemetry",
  ];

  const capRows = caps.map(c => [
    c.name        || "?",
    c.displayName || "?",
    yesNo(c.headless),
    yesNo(c.hooks),
    yesNo(c.subagents),
    yesNo(c.slashCommands),
    yesNo(c.worktrees),
    yesNo(c.goalLoop != null ? c.goalLoop : null),
    c.telemetry || "—",
  ]);

  const capWidths = capHeaders.map((h, i) =>
    Math.max(h.length, ...capRows.map(r => r[i].length))
  );

  lines.push("| " + capHeaders.map((h, i) => pad(h, capWidths[i])).join(" | ") + " |");
  lines.push("| " + capWidths.map(w => "-".repeat(w)).join(" | ") + " |");
  for (const row of capRows) {
    lines.push("| " + row.map((cell, i) => pad(cell, capWidths[i])).join(" | ") + " |");
  }
  lines.push("");
  lines.push("`telemetry`: `native` — token usage is parsed from the host CLI/API's own output " +
    "(see docs/cost.md). `estimated` — no native capture; the orchestrator records a " +
    "promptBytes/4 estimate flagged with `tokens_estimated: true`.");
  lines.push("");

  // ── Enforcement levels ─────────────────────────────────────────────
  lines.push("### Enforcement levels");
  lines.push("");
  lines.push("How each host enforces the framework's core rules:");
  lines.push("");

  const enfHeaders = [
    "Host", "allowed_writes", "stoplist", "shell", "network", "tool_budget",
  ];

  const enfRows = caps.map(c => {
    const e = c.enforces || {};
    return [
      c.name || "?",
      enforceLevel(e.allowed_writes),
      enforceLevel(e.stoplist),
      enforceLevel(e.shell),
      enforceLevel(e.network),
      enforceLevel(e.tool_budget),
    ];
  });

  const enfWidths = enfHeaders.map((h, i) =>
    Math.max(h.length, ...enfRows.map(r => r[i].length))
  );

  lines.push("| " + enfHeaders.map((h, i) => pad(h, enfWidths[i])).join(" | ") + " |");
  lines.push("| " + enfWidths.map(w => "-".repeat(w)).join(" | ") + " |");
  for (const row of enfRows) {
    lines.push("| " + row.map((cell, i) => pad(cell, enfWidths[i])).join(" | ") + " |");
  }
  lines.push("");

  // ── Headless commands ──────────────────────────────────────────────
  lines.push("### Headless commands");
  lines.push("");
  lines.push("Command the orchestrator spawns in `--headless` mode:");
  lines.push("");

  const hdlHeaders = ["Host", "headlessCommand"];
  const hdlRows = caps
    .filter(c => c.headless)
    .map(c => [c.name || "?", c.headlessCommand || "—"]);

  if (hdlRows.length === 0) {
    lines.push("*(no hosts declare headless support)*");
    lines.push("");
  } else {
    const hdlWidths = hdlHeaders.map((h, i) =>
      Math.max(h.length, ...hdlRows.map(r => r[i].length))
    );
    lines.push("| " + hdlHeaders.map((h, i) => pad(h, hdlWidths[i])).join(" | ") + " |");
    lines.push("| " + hdlWidths.map(w => "-".repeat(w)).join(" | ") + " |");
    for (const row of hdlRows) {
      lines.push("| " + row.map((cell, i) => pad(cell, hdlWidths[i])).join(" | ") + " |");
    }
    lines.push("");
  }

  // ── Enforcement glossary ───────────────────────────────────────────
  lines.push("### Enforcement level glossary");
  lines.push("");
  lines.push("| Level | Meaning |");
  lines.push("| ----- | ------- |");
  lines.push("| `tool-call-time` | Blocked at the tool-call boundary before the write reaches disk. |");
  lines.push("| `post-hoc-audit` | Checked after the workstream exits via git-status diff; violations fail the gate. |");
  lines.push("| `prompt-only` | Advisory only — written into the prompt; not technically enforced. |");
  lines.push("| `enforced` | Capability is declared and enforced (boolean enforcement fields). |");
  lines.push("| `not enforced` | Capability is absent or disabled for this host. |");
  lines.push("");

  return lines.join("\n");
}

const FENCE_OPEN  = "<!-- generated: do not hand-edit -->";
const FENCE_CLOSE = "<!-- /generated -->";

function generateBlock() {
  const caps = loadAllCapabilities();

  const header = [
    FENCE_OPEN,
    `<!-- To regenerate: npm run docs:generate (source: hosts/*/capabilities.json) -->`,
    "",
    `# Host Capability Reference`,
    "",
    `Derived from \`hosts/*/capabilities.json\`. ${caps.length} host adapters.`,
    `Run \`npm run docs:generate\` to regenerate after editing capabilities files.`,
    "",
    renderTable(caps),
    FENCE_CLOSE,
  ].join("\n");
  return header;
}

// ── CLI ───────────────────────────────────────────────────────────────────
if (require.main === module) {
  const args = process.argv.slice(2);

  if (args.includes("--write")) {
    const outPath = path.join(ROOT, "docs", "reference", "hosts.md");
    fs.mkdirSync(path.dirname(outPath), { recursive: true });
    fs.writeFileSync(outPath, generateBlock() + "\n");
    console.log("Wrote docs/reference/hosts.md");
  } else {
    console.log(generateBlock());
  }
}

module.exports = { generateBlock, FENCE_OPEN, FENCE_CLOSE };
