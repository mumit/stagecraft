// Tests for phase 37.1: `devteam help <command>` and `devteam <command>
// --help` print real, command-scoped help generated from that command's own
// flag spec — replacing the old behaviour where `devteam help <anything>`
// printed the identical full 343-line command list regardless of argument.
//
// Also covers phase 37.4: the top-level `devteam help` / `devteam --help`
// default collapsed to a one-screen grouped view; the old full listing moved
// behind `--all`.

const { describe, it } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { runCLI } = require("./_helpers");

const COMMANDS_DIR = path.join(__dirname, "..", "core", "cli", "commands");

describe("devteam help <command> / devteam <command> --help", () => {
  it("'help run' and 'run --help' print identical command-scoped output", () => {
    const viaHelp = runCLI(["help", "run"]);
    const viaFlag = runCLI(["run", "--help"]);
    assert.equal(viaHelp.status, 0);
    assert.equal(viaFlag.status, 0);
    assert.equal(viaHelp.stdout, viaFlag.stdout);
  });

  it("'run --help' output is under 60 lines", () => {
    const r = runCLI(["run", "--help"]);
    const lineCount = r.stdout.split("\n").filter((l) => l.length > 0).length;
    assert.ok(lineCount < 60, `expected under 60 lines, got ${lineCount}`);
  });

  it("'run --help' lists all 21 of run's flags with their types", () => {
    const { flags } = require(path.join(COMMANDS_DIR, "run"));
    const r = runCLI(["run", "--help"]);
    const flagNames = Object.keys(flags);
    assert.equal(flagNames.length, 21, "run is expected to declare 21 flags");
    for (const flagName of flagNames) {
      assert.match(r.stdout, new RegExp(`--${flagName}\\b`), `missing --${flagName} in help output`);
      const { type } = flags[flagName];
      assert.match(r.stdout, new RegExp(`--${flagName}[^\\n]*\\(${type}\\)`), `--${flagName} missing its (${type}) type tag`);
    }
  });

  it("output for two different commands differs", () => {
    const runHelp = runCLI(["help", "run"]);
    const reviewHelp = runCLI(["help", "review"]);
    assert.notEqual(runHelp.stdout, reviewHelp.stdout);
  });

  it("'devteam <command> --help' also differs between commands (the regression this item fixes)", () => {
    const runHelp = runCLI(["run", "--help"]);
    const reviewHelp = runCLI(["review", "--help"]);
    assert.notEqual(runHelp.stdout, reviewHelp.stdout);
  });

  it("unknown command name via 'help' suggests a near match", () => {
    const r = runCLI(["help", "revie"]);
    assert.equal(r.status, 2);
    assert.match(r.stdout, /did you mean "review"/);
  });

  it("unknown top-level command suggests a near match on stderr", () => {
    const r = runCLI(["reivew"]);
    assert.equal(r.status, 2);
    assert.match(r.stderr, /Unknown command: reivew/);
    assert.match(r.stderr, /Did you mean "review"/);
  });

  // 37.4: default `devteam help` / `devteam --help` collapsed from the full
  // 343-line listing to a one-screen grouped view; the full listing moved to
  // `--all`. This test used to assert the full listing was the default —
  // updated to match the new default, with the old assertions moved to the
  // "--help --all" test below (nothing lost, just relocated).
  it("'help' with no argument shows the grouped one-screen view", () => {
    const r = runCLI(["help"]);
    assert.equal(r.status, 0);
    assert.match(r.stdout, /Start here/);
    assert.match(r.stdout, /Quickstart:/);
    assert.doesNotMatch(r.stdout, /Commands:/);
  });

  it("'help --all' / '--help --all' print the full command reference", () => {
    for (const args of [["help", "--all"], ["--help", "--all"]]) {
      const r = runCLI(args);
      assert.equal(r.status, 0, args.join(" "));
      assert.match(r.stdout, /Commands:/, args.join(" "));
      assert.match(r.stdout, /Quickstart:/, args.join(" "));
    }
  });

  it("default help is at most 45 lines (one screen)", () => {
    const r = runCLI(["help"]);
    const lineCount = r.stdout.split("\n").length;
    assert.ok(lineCount <= 45, `expected <= 45 lines, got ${lineCount}`);
  });

  it("every command in core/cli/command-list.js appears exactly once across the default help groups", () => {
    const COMMAND_MODULES = require(path.join(__dirname, "..", "core", "cli", "command-list"));
    const { GROUPS } = require(path.join(COMMANDS_DIR, "help"));

    const grouped = GROUPS.flatMap((g) => g.commands);
    const seen = new Map();
    for (const cmd of grouped) seen.set(cmd, (seen.get(cmd) || 0) + 1);

    for (const commandName of Object.keys(COMMAND_MODULES)) {
      assert.equal(
        seen.get(commandName), 1,
        `"${commandName}" should appear exactly once in the help groups, appears ${seen.get(commandName) || 0} times`,
      );
    }
    assert.equal(
      grouped.length, Object.keys(COMMAND_MODULES).length,
      "help groups contain a command not present in command-list.js",
    );
  });

  it("'help <unknown>' still prints the grouped list alongside the suggestion", () => {
    const r = runCLI(["help", "bogus-xyz"]);
    assert.equal(r.status, 2);
    assert.match(r.stdout, /Start here/);
    assert.match(r.stdout, /Unknown command: "bogus-xyz"/);
  });
});

describe("every command flag spec has a non-empty description", () => {
  const files = fs.readdirSync(COMMANDS_DIR).filter((f) => f.endsWith(".js"));

  for (const file of files) {
    it(`${file}: all flags have a description`, () => {
      const mod = require(path.join(COMMANDS_DIR, file));
      const flags = mod.flags || {};
      for (const [flagName, def] of Object.entries(flags)) {
        assert.ok(
          typeof def.description === "string" && def.description.trim().length > 0,
          `${file} --${flagName} has no description — generated help has nothing to show for it`,
        );
      }
    });
  }
});
