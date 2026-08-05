// Unit tests for core/cli/flags.js — schema-driven parser.
// These tests confirm that parseFlags and generateHelp behave correctly for
// each type, error on unknown flags, error on missing values, and produce
// well-formed help text.  Error-path tests that call process.exit(2) spawn
// subprocesses so they don't abort the test runner.

const { describe, it } = require("node:test");
const assert = require("node:assert/strict");
const { spawnSync } = require("node:child_process");
const path = require("node:path");

const FLAGS_MODULE = path.resolve(__dirname, "..", "core", "cli", "flags");
const { parseFlags, generateHelp } = require(FLAGS_MODULE);

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

// Run parseFlags inside a subprocess so process.exit(2) doesn't kill the
// test runner.  argv and schema are serialised as JSON; the subprocess
// evaluates them and calls parseFlags, then prints the result as JSON.
function runParseFlags(argv, schema) {
  const script = `
    const { parseFlags } = require(${JSON.stringify(FLAGS_MODULE)});
    const result = parseFlags(${JSON.stringify(argv)}, ${JSON.stringify(schema)});
    process.stdout.write(JSON.stringify(result));
  `;
  return spawnSync(process.execPath, ["-e", script], { encoding: "utf8" });
}

// ---------------------------------------------------------------------------
// Happy-path: each type
// ---------------------------------------------------------------------------

describe("parseFlags: boolean", () => {
  it("sets the camelCase key to true", () => {
    const { flags, positional } = parseFlags(
      ["--verbose"],
      { verbose: { type: "boolean" } },
    );
    assert.equal(flags.verbose, true);
    assert.deepEqual(positional, []);
  });

  it("camelCases a hyphenated flag name", () => {
    const { flags } = parseFlags(
      ["--dry-run"],
      { "dry-run": { type: "boolean" } },
    );
    assert.equal(flags.dryRun, true);
  });

  it("uses an explicit key when provided", () => {
    const { flags } = parseFlags(
      ["--verbose"],
      { verbose: { type: "boolean", key: "v" } },
    );
    assert.equal(flags.v, true);
    assert.equal(flags.verbose, undefined);
  });

  it("does not set the key when flag is absent", () => {
    const { flags } = parseFlags([], { verbose: { type: "boolean" } });
    assert.equal(flags.verbose, undefined);
  });
});

describe("parseFlags: string", () => {
  it("consumes the next token as the value", () => {
    const { flags } = parseFlags(
      ["--name", "alice"],
      { name: { type: "string" } },
    );
    assert.equal(flags.name, "alice");
  });

  it("leaves subsequent flags untouched", () => {
    const { flags } = parseFlags(
      ["--name", "alice", "--verbose"],
      { name: { type: "string" }, verbose: { type: "boolean" } },
    );
    assert.equal(flags.name, "alice");
    assert.equal(flags.verbose, true);
  });

  it("multi-word value with spaces (single token)", () => {
    const { flags } = parseFlags(
      ["--feature", "add auth"],
      { feature: { type: "string" } },
    );
    assert.equal(flags.feature, "add auth");
  });
});

describe("parseFlags: number", () => {
  it("converts the next token to a number", () => {
    const { flags } = parseFlags(
      ["--count", "42"],
      { count: { type: "number" } },
    );
    assert.equal(flags.count, 42);
  });

  it("converts a float", () => {
    const { flags } = parseFlags(
      ["--budget-usd", "1.5"],
      { "budget-usd": { type: "number" } },
    );
    assert.equal(flags.budgetUsd, 1.5);
  });
});

describe("parseFlags: list", () => {
  it("accumulates repeated occurrences", () => {
    const { flags } = parseFlags(
      ["--item", "a", "--item", "b", "--item", "c"],
      { item: { type: "list" } },
    );
    assert.deepEqual(flags.item, ["a", "b", "c"]);
  });

  it("comma-splits when split: true", () => {
    const { flags } = parseFlags(
      ["--tags", "x,y,z"],
      { tags: { type: "list", split: true } },
    );
    assert.deepEqual(flags.tags, ["x", "y", "z"]);
  });

  it("comma-splits and trims whitespace", () => {
    const { flags } = parseFlags(
      ["--tags", "x, y , z"],
      { tags: { type: "list", split: true } },
    );
    assert.deepEqual(flags.tags, ["x", "y", "z"]);
  });

  it("comma-splits across multiple occurrences", () => {
    const { flags } = parseFlags(
      ["--tags", "a,b", "--tags", "c,d"],
      { tags: { type: "list", split: true } },
    );
    assert.deepEqual(flags.tags, ["a", "b", "c", "d"]);
  });

  it("list without split does not split on comma", () => {
    const { flags } = parseFlags(
      ["--ws", "backend,frontend"],
      { ws: { type: "list" } },
    );
    assert.deepEqual(flags.ws, ["backend,frontend"]);
  });
});

describe("parseFlags: positional arguments", () => {
  it("collects non-flag tokens in order", () => {
    const { positional } = parseFlags(
      ["foo", "bar"],
      {},
    );
    assert.deepEqual(positional, ["foo", "bar"]);
  });

  it("interleaves positionals and flags correctly", () => {
    const { positional, flags } = parseFlags(
      ["foo", "--verbose", "bar"],
      { verbose: { type: "boolean" } },
    );
    assert.deepEqual(positional, ["foo", "bar"]);
    assert.equal(flags.verbose, true);
  });

  it("empty argv returns empty results", () => {
    const { positional, flags } = parseFlags([], { verbose: { type: "boolean" } });
    assert.deepEqual(positional, []);
    assert.deepEqual(flags, {});
  });
});

// ---------------------------------------------------------------------------
// Error paths — subprocess-based so process.exit(2) is safe
// ---------------------------------------------------------------------------

describe("parseFlags: unknown flag exits 2", () => {
  it("unknown flag prints message and exits 2", () => {
    const r = runParseFlags(["--bogus"], {});
    assert.equal(r.status, 2);
    assert.match(r.stderr, /Unknown flag: --bogus/);
  });

  it("known schema does not prevent unknown flag error", () => {
    const r = runParseFlags(["--valid", "--nope"], { valid: { type: "boolean" } });
    assert.equal(r.status, 2);
    assert.match(r.stderr, /Unknown flag: --nope/);
  });
});

describe("parseFlags: missing value exits 2", () => {
  it("string with no value exits 2", () => {
    const r = runParseFlags(["--name"], { name: { type: "string" } });
    assert.equal(r.status, 2);
    assert.match(r.stderr, /--name requires a value/);
  });

  it("number with no value exits 2", () => {
    const r = runParseFlags(["--count"], { count: { type: "number" } });
    assert.equal(r.status, 2);
    assert.match(r.stderr, /--count requires a value/);
  });

  it("list with no value exits 2", () => {
    const r = runParseFlags(["--item"], { item: { type: "list" } });
    assert.equal(r.status, 2);
    assert.match(r.stderr, /--item requires a value/);
  });
});

// ---------------------------------------------------------------------------
// --apply dissolution: assess (boolean) vs advise (string)
// ---------------------------------------------------------------------------

describe("parseFlags: --apply dissolution", () => {
  it("assess-style boolean --apply: bare flag sets apply=true, next flag is independent", () => {
    const { flags } = parseFlags(
      ["--apply", "--json"],
      { apply: { type: "boolean" }, json: { type: "boolean" } },
    );
    assert.equal(flags.apply, true);
    assert.equal(flags.json, true);
  });

  it("assess-style boolean --apply as last arg: apply=true", () => {
    const { flags } = parseFlags(
      ["--apply"],
      { apply: { type: "boolean" } },
    );
    assert.equal(flags.apply, true);
  });

  it("advise-style string --apply: consumes value", () => {
    const { flags } = parseFlags(
      ["--apply", "AC-11=A,AC-12=B"],
      { apply: { type: "string" } },
    );
    assert.equal(flags.apply, "AC-11=A,AC-12=B");
  });

  it("advise-style string --apply with no value exits 2 with clear message", () => {
    const r = runParseFlags(["--apply"], { apply: { type: "string" } });
    assert.equal(r.status, 2);
    assert.match(r.stderr, /--apply requires a value/);
  });
});

// ---------------------------------------------------------------------------
// generateHelp
// ---------------------------------------------------------------------------

describe("generateHelp", () => {
  it("includes the command line", () => {
    const h = generateHelp("devteam foo <name>", {});
    assert.match(h, /Usage: devteam foo <name>/);
  });

  it("includes --help in output", () => {
    const h = generateHelp("devteam foo", {});
    assert.match(h, /--help/);
  });

  it("includes flag names from schema", () => {
    const h = generateHelp("devteam foo", {
      verbose: { type: "boolean", description: "Verbose output" },
    });
    assert.match(h, /--verbose/);
    assert.match(h, /Verbose output/);
  });

  it("includes non-boolean flags with a placeholder", () => {
    const h = generateHelp("devteam foo", {
      name: { type: "string", description: "Your name" },
    });
    assert.match(h, /--name/);
    assert.match(h, /<name>/);
  });

  it("shows Options: section when schema has entries", () => {
    const h = generateHelp("devteam foo", {
      verbose: { type: "boolean" },
    });
    assert.match(h, /Options:/);
  });

  it("no Options: section when schema has no real flags", () => {
    // Empty schema: no entries other than the auto-added --help line at the bottom
    const h = generateHelp("devteam foo", {});
    assert.doesNotMatch(h, /Options:/);
  });

  // Phase 37.1: each flag line carries its declared type, so generated
  // per-command help documents type + description without hand-written prose.
  it("shows the declared type alongside each flag", () => {
    const h = generateHelp("devteam foo", {
      "budget-usd": { type: "number", description: "Cost cap in USD" },
      tags: { type: "list", description: "Repeatable tag" },
      "fail-on-advisory": { type: "toggle", description: "Exit code override" },
      resume: { type: "boolean", description: "Resume an interrupted run" },
    });
    assert.match(h, /--budget-usd <budget-usd> \(number\)/);
    assert.match(h, /--tags <tags> \(list\)/);
    assert.match(h, /--fail-on-advisory \[<value>\] \(toggle\)/);
    assert.match(h, /--resume \(boolean\)/);
  });
});
