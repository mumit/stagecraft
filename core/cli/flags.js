"use strict";

// core/cli/flags.js — schema-driven CLI flag parser for devteam.
//
// Centralises flag parsing so per-command unknown-flag checking is
// automatic and --help can be generated from the same schema that
// drives parsing. Replaces the flat shared parseFlags in bin/devteam,
// eliminating the --apply dual-mode hack and the silent --skip-*
// omissions (phase-3-structural-debt.md §3.1 PR 1).

// Convert --flag-name to flagName (for default dest key).
function toCamelCase(s) {
  return s.replace(/-([a-z])/g, (_, c) => c.toUpperCase());
}

// parseFlags(argv, schema) — parse argv against a schema.
//
// schema = {
//   "flag-name": {
//     type:        "boolean" | "string" | "number" | "list",
//     key?:        string,    // dest property; default = camelCase of flag-name
//     split?:      boolean,   // list only: comma-split the value (--auto-rule a,b)
//     description?: string,
//   }
// }
//
// Returns { positional: string[], flags: object }.
// Unknown --flags exit 2. String/number/list with no value exit 2.
function parseFlags(argv, schema) {
  const flags = {};
  const positional = [];

  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (!a.startsWith("--")) {
      positional.push(a);
      continue;
    }

    // Support --flag=value form: split on the first '=' after '--'.
    let rawToken = a.slice(2);
    let embeddedValue = null;
    const eqIdx = rawToken.indexOf("=");
    if (eqIdx >= 0) {
      embeddedValue = rawToken.slice(eqIdx + 1);
      rawToken = rawToken.slice(0, eqIdx);
    }

    const flagName = rawToken;
    const def = schema[flagName];
    if (!def) {
      process.stderr.write(`Unknown flag: --${flagName}\n`);
      process.exit(2);
    }

    const key = def.key !== undefined ? def.key : toCamelCase(flagName);

    switch (def.type) {
      case "boolean":
        flags[key] = true;
        break;

      // toggle: bare (--flag) sets true; --flag=value sets the value string.
      // Use when a flag can optionally refine its behaviour with a value (e.g.
      // --fail-on-advisory=all) while also being valid without one.
      case "toggle":
        flags[key] = embeddedValue !== null ? embeddedValue : true;
        break;

      case "string": {
        const val = embeddedValue !== null ? embeddedValue : (() => {
          i++;
          if (i >= argv.length) {
            process.stderr.write(`--${flagName} requires a value\n`);
            process.exit(2);
          }
          return argv[i];
        })();
        flags[key] = val;
        break;
      }

      case "number": {
        const raw = embeddedValue !== null ? embeddedValue : (() => {
          i++;
          if (i >= argv.length) {
            process.stderr.write(`--${flagName} requires a value\n`);
            process.exit(2);
          }
          return argv[i];
        })();
        flags[key] = Number(raw);
        break;
      }

      case "list": {
        const raw = embeddedValue !== null ? embeddedValue : (() => {
          i++;
          if (i >= argv.length) {
            process.stderr.write(`--${flagName} requires a value\n`);
            process.exit(2);
          }
          return argv[i];
        })();
        if (!flags[key]) flags[key] = [];
        if (def.split) {
          flags[key].push(...raw.split(",").map((s) => s.trim()).filter(Boolean));
        } else {
          flags[key].push(raw);
        }
        break;
      }

      default:
        process.stderr.write(`Internal error: unknown type "${def.type}" for --${flagName}\n`);
        process.exit(2);
    }
  }

  return { positional, flags };
}

// generateHelp(commandLine, schema) — produce a Usage string from a schema.
// commandLine: e.g. "devteam stage <name> [options]"
function generateHelp(commandLine, schema) {
  const lines = [`Usage: ${commandLine}`];
  const entries = Object.entries(schema).filter(([k]) => k !== "help");
  if (entries.length > 0) {
    lines.push("", "Options:");
    for (const [flagName, def] of entries) {
      const valPart = def.type === "boolean" ? ""
      : def.type === "toggle" ? ` [<value>]`
      : ` <${flagName}>`;
      const desc = def.description || "";
      lines.push(`  --${flagName}${valPart} (${def.type})${desc ? `  ${desc}` : ""}`);
    }
  }
  lines.push("  --help (boolean)  Show this help");
  return lines.join("\n");
}

module.exports = { parseFlags, generateHelp };
