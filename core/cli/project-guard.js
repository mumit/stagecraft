"use strict";

// core/cli/project-guard.js — phase-37 item 37.3
// (plans/phase-37-interface-and-token-efficiency.md §37.3).
//
// Bug this closes: `next`/`summary`/`status`/`log`/`validate` had no
// initialisation check, so running any of them in a directory that was
// never `devteam init`-ed silently fell through to config.js's DEFAULTS
// (host: generic, track: full) and reported a fabricated stage-01 zero
// state — "▶️ run-stage — requirements" — as though a real pipeline were
// waiting there.
//
// Split principle (why some commands are guarded and others are not):
// a command is GUARDED when its only job is to *report on* a pipeline
// that some other command already created — for those, a directory with
// no .devteam/config.yml can only mean "nothing has been initialised
// here", so refusing is strictly more honest than a synthesized
// zero-state. A command is UNGUARDED when it legitimately runs with no
// project present: it is the thing that creates .devteam/ (`init`), it
// targets an explicit external subject instead of trusting cwd
// (`review <path>`, `review-pr` against a workspace), or it is
// project-independent introspection whose whole point is to work before
// or without a project (`hosts`, `stages`, `help`, `doctor` — doctor's job
// is diagnosing a project that may not exist yet, including printing this
// exact guard's advice).
//
// GUARDED_COMMANDS / UNGUARDED_COMMANDS are asserted disjoint and checked
// against actual wiring by tests/project-guard.test.js, so the split
// cannot drift silently as commands are added.

const fs = require("node:fs");
const path = require("node:path");

const GUARDED_COMMANDS = Object.freeze(["chat", "next", "summary", "status", "log", "validate"]);

const UNGUARDED_COMMANDS = Object.freeze([
  "init", "review", "review-pr", "hosts", "stages", "help", "doctor",
]);

function isStagecraftProject(cwd) {
  return fs.existsSync(path.join(cwd, ".devteam", "config.yml"));
}

// Refuses with the same shape/wording `devteam stage` already uses for a
// missing .devteam/config.yml (core/cli/commands/stage.js) — what's
// missing, and the exact fix — but as an exit(1) refusal rather than a
// warn-and-continue, since these commands have nothing honest left to do
// without a project. `--json` callers get a structured error object on
// stdout, never a silent zero-state a script could mistake for "no
// pipeline yet".
function requireProjectContext(cwd, _flags, commandName) {
  if (isStagecraftProject(cwd)) return;
  if (_flags && _flags.json) {
    console.log(JSON.stringify({
      error: "not-a-stagecraft-project",
      command: commandName,
      cwd,
      message: `${cwd} does not look like an initialised Stagecraft project (no .devteam/config.yml).`,
      fix: `devteam init --host <name> --cwd "${cwd}"`,
    }, null, 2));
  } else {
    process.stderr.write(
      `\n⚠️  ${cwd}\n` +
      `   does not look like an initialised Stagecraft target project (no .devteam/config.yml).\n` +
      `   \`devteam ${commandName}\` reports on a pipeline; there is nothing to report here yet.\n` +
      `   Run this first to lay one down:\n` +
      `     devteam init --host <name> --cwd "${cwd}"\n\n`,
    );
  }
  process.exit(1);
}

module.exports = {
  GUARDED_COMMANDS,
  UNGUARDED_COMMANDS,
  isStagecraftProject,
  requireProjectContext,
};
