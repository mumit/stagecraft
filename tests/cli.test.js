const { describe, it, afterEach } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { makeTargetProject, seedGate, cleanup, runCLI, REPO_ROOT } = require("./_helpers");

let _dirs = [];
function track(cwd) { _dirs.push(cwd); return cwd; }
afterEach(() => { _dirs.forEach(cleanup); _dirs = []; });

describe("cli: help + listing", () => {
  it("--version prints the canonical package version outside a target project", () => {
    const cwd = track(makeTargetProject({ config: false, gates: false }));
    const { version } = require(path.join(REPO_ROOT, "package.json"));
    const r = runCLI(["--version"], { cwd });
    assert.equal(r.status, 0);
    assert.equal(r.stdout, `${version}\n`);
    assert.equal(r.stderr, "");
  });

  it("entrypoint lazy-loads command modules", () => {
    const entrypoint = fs.readFileSync(path.join(__dirname, "..", "bin", "devteam"), "utf8");
    assert.match(entrypoint, /COMMAND_MODULES/);
    assert.match(entrypoint, /function loadCommand/);
    assert.doesNotMatch(
      entrypoint,
      /const\s+_[A-Za-z0-9]+Cmd\s*=\s*require\(/,
      "bin/devteam should not eagerly require every command module at startup",
    );
  });

  it("help exits 0 and lists subcommands", () => {
    const r = runCLI(["help"]);
    assert.equal(r.status, 0);
    assert.match(r.stdout, /init/);
    assert.match(r.stdout, /stage/);
    assert.match(r.stdout, /next/);
    assert.match(r.stdout, /merge/);
    assert.match(r.stdout, /summary/);
    assert.match(r.stdout, /doctor/);
  });

  it("help lists every registered command, not just a hand-picked sample", () => {
    // Regression: corpus and evals are real, working, --help-documented
    // commands (registered in core/cli/command-list.js) that were previously
    // missing from this hand-written top-level listing entirely.
    //
    // 37.4: the default listing is now the grouped one-screen view (commands
    // are " · "-separated within a group line rather than one per line), so
    // the match is by word boundary instead of start-of-line. The exactly-
    // once coverage guarantee itself is asserted more strongly in
    // tests/help-cmd.test.js against core/cli/commands/help.js's GROUPS data.
    const COMMAND_MODULES = require(path.join(REPO_ROOT, "core", "cli", "command-list"));
    const r = runCLI(["help"]);
    assert.equal(r.status, 0);
    for (const commandName of Object.keys(COMMAND_MODULES)) {
      const re = new RegExp(`\\b${commandName.replace(/[-/\\^$*+?.()|[\]{}]/g, "\\$&")}\\b`);
      assert.match(r.stdout, re, `help listing is missing command "${commandName}"`);
    }
  });

  it("stages lists known stage names", () => {
    const r = runCLI(["stages"]);
    assert.equal(r.status, 0);
    assert.match(r.stdout, /requirements/);
    assert.match(r.stdout, /security-review/);
    assert.match(r.stdout, /retrospective/);
  });

  it("hosts lists adapters", () => {
    const r = runCLI(["hosts"]);
    assert.equal(r.status, 0);
    assert.match(r.stdout, /claude-code/);
    assert.match(r.stdout, /codex/);
    assert.match(r.stdout, /generic/);
  });

  it("unknown command exits 2", () => {
    const r = runCLI(["bogus-command"]);
    assert.equal(r.status, 2);
    assert.match(r.stderr, /Unknown command/);
  });
});

describe("cli: init", () => {
  it("init without --host exits 2 with usage", () => {
    const cwd = track(makeTargetProject({ config: false }));
    const r = runCLI(["init"], { cwd });
    assert.equal(r.status, 2);
    assert.match(r.stderr, /--host/);
  });

  it("init --host bogus exits 2", () => {
    const cwd = track(makeTargetProject({ config: false }));
    const r = runCLI(["init", "--host", "bogus"], { cwd });
    assert.equal(r.status, 2);
    assert.match(r.stderr, /Unknown host/);
  });

  it("init --host generic creates config + workspace", () => {
    const cwd = track(makeTargetProject({ config: false, gates: false }));
    const r = runCLI(["init", "--host", "generic"], { cwd });
    assert.equal(r.status, 0);
    assert.ok(fs.existsSync(path.join(cwd, ".devteam", "config.yml")));
    assert.ok(fs.existsSync(path.join(cwd, "pipeline", "gates")));
  });
});

describe("cli: stage", () => {
  it("stage without name exits 2", () => {
    const cwd = track(makeTargetProject());
    const r = runCLI(["stage"], { cwd });
    assert.equal(r.status, 2);
  });

  it("stage <known> renders prompt to stdout", () => {
    const cwd = track(makeTargetProject());
    const r = runCLI(["stage", "requirements", "--feature", "test feature"], { cwd });
    assert.equal(r.status, 0);
    assert.match(r.stdout, /workstream: pm/);
    assert.match(r.stdout, /test feature/);
  });

  // Regression: escalation-applicator/Principal-ruling prompts commonly name
  // a stage by its gate-id form (matching gate filenames / rules docs), e.g.
  // "stage-01", not the friendly CLI name "requirements". `devteam restart`
  // already accepted both forms (tests/restart.test.js); dispatch via
  // `devteam stage` did not, and failed with "Unknown stage stage-01" mid
  // fix-escalation even though the equivalent friendly name worked fine.
  it("stage accepts the stage id form (e.g. 'stage-01') as well as the name", () => {
    const cwd = track(makeTargetProject());
    const r = runCLI(["stage", "stage-01", "--feature", "test feature"], { cwd });
    assert.equal(r.status, 0);
    assert.match(r.stdout, /workstream: pm/);
    assert.match(r.stdout, /test feature/);
  });

  it("stage reads the feature prompt from --feature-file", () => {
    const cwd = track(makeTargetProject());
    const featureFile = path.join(cwd, "feature-brief.md");
    fs.writeFileSync(featureFile, "Feature from file\n\n- AC-1: works from disk\n");
    const r = runCLI(["stage", "requirements", "--feature-file", featureFile], { cwd });
    assert.equal(r.status, 0);
    assert.match(r.stdout, /Feature from file/);
    assert.match(r.stdout, /AC-1: works from disk/);
    assert.match(r.stdout, /devteam stage requirements --feature-file/);
  });

  it("stage rejects --feature with --feature-file", () => {
    const cwd = track(makeTargetProject());
    const featureFile = path.join(cwd, "feature-brief.md");
    fs.writeFileSync(featureFile, "Feature from file\n");
    const r = runCLI(["stage", "requirements", "--feature", "inline", "--feature-file", featureFile], { cwd });
    assert.equal(r.status, 2);
    assert.match(r.stderr, /--feature and --feature-file are mutually exclusive/);
  });

  it("stage reports a clear error when --feature-file cannot be read", () => {
    const cwd = track(makeTargetProject());
    const r = runCLI(["stage", "requirements", "--feature-file", path.join(cwd, "missing.md")], { cwd });
    assert.equal(r.status, 1);
    assert.match(r.stderr, /could not read --feature-file/);
  });

  it("stage prints an onboarding preamble + postamble in user-driven mode", () => {
    const cwd = track(makeTargetProject());
    const r = runCLI(["stage", "requirements", "--feature", "test feature"], { cwd });
    assert.equal(r.status, 0);
    // Preamble identifies the stage and explains what to do.
    assert.match(r.stdout, /Stage stage-01 \(requirements\)/);
    assert.match(r.stdout, /devteam does\s*\n\s*NOT call a model/);
    assert.match(r.stdout, /Inside Claude Code/);
    assert.match(r.stdout, /devteam stage requirements --feature "test feature" --headless/);
    // Postamble points to the next concrete action.
    assert.match(r.stdout, /Run `devteam next` to advance the pipeline/);
  });

  it("stage warns when invoked against an un-initialised target directory", () => {
    // A bare tempdir with no .devteam/config.yml — the user's first-run footgun.
    const cwd = fs.mkdtempSync(path.join(require("node:os").tmpdir(), "devteam-no-init-"));
    _dirs.push(cwd);
    const r = runCLI(["stage", "requirements", "--feature", "x"], { cwd });
    // The prompt still renders (the CLI is permissive), but a warning fires.
    assert.match(r.stderr, /does not look like an initialised Stagecraft target project/);
    assert.match(r.stderr, /devteam init --host claude-code/);
  });

  it("stage suppresses the onboarding framing under --headless", () => {
    const cwd = track(makeTargetProject());
    const r = runCLI(
      ["stage", "requirements", "--feature", "x", "--headless"],
      { cwd, env: { ...process.env, DEVTEAM_HEADLESS_COMMAND: "true" } },
    );
    // No preamble / postamble in headless mode — the framing would
    // contaminate any downstream consumer of stdout.
    assert.doesNotMatch(r.stdout, /devteam does\s*\n\s*NOT call a model/);
    assert.doesNotMatch(r.stdout, /Run `devteam next` to advance/);
  });

  it("stage inherits the materialized run-plan track unless explicitly overridden", () => {
    const cwd = track(makeTargetProject({
      config: "routing:\n  default_host: generic\npipeline:\n  default_track: full\n",
    }));
    fs.writeFileSync(path.join(cwd, "pipeline", "run-plan.json"), JSON.stringify({
      schema: "stagecraft.run-plan/v1",
      track: "loop",
      stages: [],
    }));

    const inherited = runCLI(["stage", "build", "--feature", "update copy"], { cwd });
    assert.equal(inherited.status, 0);
    assert.match(inherited.stdout, /end of stage-04 \(1 workstream\)/);
    assert.doesNotMatch(inherited.stdout, /workstream: frontend/);

    const overridden = runCLI(["stage", "build", "--track", "full", "--feature", "update copy"], { cwd });
    assert.equal(overridden.status, 0);
    assert.match(overridden.stdout, /end of stage-04 \(4 workstreams\)/);
  });

  it("stage inherits the materialized run-plan track in bounded isolation", () => {
    const cwd = track(makeTargetProject({
      config: "routing:\n  default_host: generic\npipeline:\n  default_track: full\n  isolation: bounded\n",
    }));
    const changeRoot = path.join(cwd, "pipeline", "changes", "bounded-copy");
    fs.mkdirSync(changeRoot, { recursive: true });
    fs.writeFileSync(path.join(changeRoot, "run-plan.json"), JSON.stringify({
      schema: "stagecraft.run-plan/v1",
      track: "loop",
      stages: [],
    }));

    const inherited = runCLI(["stage", "build", "--feature", "bounded copy"], { cwd });
    assert.equal(inherited.status, 0);
    assert.match(inherited.stdout, /end of stage-04 \(1 workstream\)/);
    assert.doesNotMatch(inherited.stdout, /workstream: frontend/);
  });
});

describe("cli: stoplist guard", () => {
  it("nano + stoplist-matching feature exits 2", () => {
    const cwd = track(makeTargetProject({
      config: "routing:\n  default_host: generic\npipeline:\n  default_track: nano\n",
    }));
    const r = runCLI(["stage", "build", "--feature", "add auth middleware"], { cwd });
    assert.equal(r.status, 2);
    assert.match(r.stderr, /stoplist/i);
  });

  it("nano + --force bypasses stoplist", () => {
    const cwd = track(makeTargetProject({
      config: "routing:\n  default_host: generic\npipeline:\n  default_track: nano\n",
    }));
    const r = runCLI(["stage", "build", "--feature", "add auth", "--force"], { cwd });
    assert.equal(r.status, 0);
  });

  it("full track is exempt from stoplist", () => {
    const cwd = track(makeTargetProject({
      config: "routing:\n  default_host: generic\npipeline:\n  default_track: full\n",
    }));
    const r = runCLI(["stage", "requirements", "--feature", "add auth"], { cwd });
    assert.equal(r.status, 0);
  });
});

describe("cli: next + summary --json", () => {
  it("next --json returns parseable JSON", () => {
    const cwd = track(makeTargetProject());
    const r = runCLI(["next", "--json"], { cwd });
    assert.equal(r.status, 0);
    const parsed = JSON.parse(r.stdout);
    assert.equal(parsed.action, "run-stage");
  });

  it("summary --json returns parseable JSON with rows", () => {
    const cwd = track(makeTargetProject());
    const r = runCLI(["summary", "--json"], { cwd });
    assert.equal(r.status, 0);
    const parsed = JSON.parse(r.stdout);
    assert.ok(Array.isArray(parsed.rows));
    assert.ok(parsed.rows.length > 0);
  });
});

describe("cli: doctor", () => {
  it("doctor on uninitialized dir exits 1", () => {
    const cwd = track(makeTargetProject({ config: false, gates: false }));
    const r = runCLI(["doctor"], { cwd });
    assert.equal(r.status, 1);
    assert.match(r.stdout, /critical failure/);
  });

  it("doctor on initialized dir exits 0", () => {
    const cwd = track(makeTargetProject({ config: false, gates: false }));
    runCLI(["init", "--host", "generic"], { cwd });
    const r = runCLI(["doctor"], { cwd });
    assert.equal(r.status, 0);
    assert.match(r.stdout, /everything looks good|warning/);
  });
});

describe("cli: --patch blockers[] fallback", () => {
  it("--patch --from stage-04.qa reads blockers[] when must_address_before_peer_review absent", () => {
    const cwd = track(makeTargetProject());
    seedGate(cwd, "stage-04.qa", {
      stage: "stage-04", workstream: "qa", status: "FAIL",
      blockers: ["express.static path wrong", "Dockerfile CMD wrong"],
    });
    const r = runCLI(["stage", "build", "--patch", "--from", "stage-04.qa"], { cwd });
    assert.match(r.stderr, /2 item\(s\) from stage-04\.qa gate \(blockers\)/);
  });

  it("--patch --from red-team still prefers must_address_before_peer_review over blockers[]", () => {
    const cwd = track(makeTargetProject());
    seedGate(cwd, "stage-04c", {
      stage: "stage-04c", workstream: "red-team", status: "FAIL",
      blockers: ["generic blocker"],
      must_address_before_peer_review: [{ id: "RT-1", severity: "critical", likelihood: "high", summary: "SQL injection" }],
    });
    const r = runCLI(["stage", "build", "--patch", "--from", "red-team"], { cwd });
    assert.match(r.stderr, /1 item\(s\) from red-team gate \(must_address_before_peer_review\)/);
  });

  it("--patch --from a gate with neither field falls back gracefully", () => {
    const cwd = track(makeTargetProject());
    seedGate(cwd, "stage-04.qa", {
      stage: "stage-04", workstream: "qa", status: "FAIL",
      blockers: [],
    });
    const r = runCLI(["stage", "build", "--patch", "--from", "stage-04.qa"], { cwd });
    assert.match(r.stderr, /no patch items in stage-04\.qa\.json — running full build/);
  });
});

// ---------------------------------------------------------------------------
// cli: flag-parsing fixes (Phase 1 item 1.4)
// ---------------------------------------------------------------------------
describe("cli: parseFlags — --apply peek-ahead and --skip-* flags", () => {
  // --apply boolean-or-value: bare --apply followed by another flag must NOT
  // swallow that flag as the apply value.
  it("assess --apply --json emits JSON output (--json is not swallowed by --apply)", () => {
    const cwd = track(makeTargetProject());
    const r = runCLI(["assess", "--apply", "--json", "--no-content"], { cwd });
    // Exit 0 or 1 is fine; what matters is that stdout is parseable JSON
    // (proving --json was processed, not silently eaten by --apply).
    assert.doesNotThrow(() => JSON.parse(r.stdout), "stdout must be valid JSON");
    const parsed = JSON.parse(r.stdout);
    assert.ok("recommendedTrack" in parsed, "JSON output contains recommendedTrack field");
  });

  it("assess --apply as the final argument applies (does not set flags.apply = undefined)", () => {
    const cwd = track(makeTargetProject());
    // Before the fix, --apply as the last arg set flags.apply = undefined (falsy)
    // so the apply branch was silently skipped. Now it should set flags.apply = true
    // and attempt to write .devteam/config.yml.
    const _r = runCLI(["assess", "--apply", "--no-content"], { cwd });
    // The config file must exist — proof that the apply branch ran.
    assert.ok(
      fs.existsSync(path.join(cwd, ".devteam", "config.yml")),
      ".devteam/config.yml must be written when --apply is the last argument",
    );
  });

  it("advise --apply AC-11=A with a value string is accepted (no regression)", () => {
    const cwd = track(makeTargetProject());
    // No gate files → advise has nothing to advise, but it must NOT exit 2.
    // (It exits 0 with a "no items" message — the key is the value was consumed.)
    const r = runCLI(["advise", "--apply", "AC-11=A"], { cwd });
    assert.notEqual(r.status, 2, "advise --apply <value> must not exit 2");
  });

  it("advise --apply with no value exits 2 with a clear error", () => {
    const cwd = track(makeTargetProject());
    // Bare --apply without a value string is a user error for advise (which
    // requires a selection like AC-11=A).  The fix surfaces a clear message
    // instead of silently doing nothing.
    const r = runCLI(["advise", "--apply"], { cwd });
    assert.equal(r.status, 2);
    assert.match(r.stderr, /--apply requires a value/);
  });

  it("preflight --skip-write no longer exits 2 Unknown flag", () => {
    const cwd = track(makeTargetProject());
    // Before the fix, --skip-write was not in parseFlags, so it triggered the
    // "Unknown flag" branch and exited 2.  After the fix it must exit 0 or 1.
    const r = runCLI(["preflight", "--skip-write"], { cwd });
    assert.notEqual(r.status, 2, "preflight --skip-write must not exit 2 Unknown flag");
  });

  it("next --skip-advise no longer exits 2 Unknown flag", () => {
    const cwd = track(makeTargetProject());
    // --skip-advise was missing from parseFlags.
    const r = runCLI(["next", "--skip-advise"], { cwd });
    assert.notEqual(r.status, 2, "next --skip-advise must not exit 2 Unknown flag");
  });

  it("stage --skip-preflight no longer exits 2 Unknown flag", () => {
    const cwd = track(makeTargetProject());
    // --skip-preflight was missing from parseFlags.
    const r = runCLI(["stage", "requirements", "--feature", "x", "--skip-preflight"], { cwd });
    assert.notEqual(r.status, 2, "stage --skip-preflight must not exit 2 Unknown flag");
  });
});
