const { describe, it } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { REPO_ROOT } = require("./_helpers");
const { checkStoplist, explainMatches } = require(path.join(REPO_ROOT, "core", "guards", "stoplist"));

// Stoplist scans the description PLUS the cwd's git changed-files and
// pipeline/ artifacts. Pointing cwd at REPO_ROOT made these tests depend on
// the developer's working tree: an uncommitted edit to a file whose PATH
// contains a stoplist keyword (e.g. tests/secret-scan.test.js) broke the
// "harmless" assertions. A clean non-git tempdir isolates the input.
const CLEAN_CWD = fs.mkdtempSync(path.join(os.tmpdir(), "devteam-test-stoplist-"));

describe("stoplist: matches", () => {
  it("matches auth keyword", () => {
    const m = checkStoplist({ description: "add auth middleware", cwd: CLEAN_CWD });
    assert.ok(m.length > 0);
    assert.ok(m.some((x) => x.name.toLowerCase().includes("auth")));
  });

  it("matches PII keyword", () => {
    const m = checkStoplist({ description: "store user PII in the cache", cwd: CLEAN_CWD });
    assert.ok(m.length > 0);
  });

  it("matches payments", () => {
    const m = checkStoplist({ description: "integrate Stripe payments", cwd: CLEAN_CWD });
    assert.ok(m.length > 0);
  });

  it("matches migration", () => {
    const m = checkStoplist({ description: "add schema migration for orders table", cwd: CLEAN_CWD });
    assert.ok(m.length > 0);
  });
});

describe("stoplist: passes harmless changes", () => {
  it("doesn't match copy edits", () => {
    const m = checkStoplist({ description: "fix typo in README", cwd: CLEAN_CWD });
    assert.equal(m.length, 0);
  });

  it("doesn't match dependency-version bumps without matching keywords", () => {
    const m = checkStoplist({ description: "bump react from 18.3.0 to 18.3.1", cwd: CLEAN_CWD });
    assert.equal(m.length, 0);
  });

  it("doesn't match empty description", () => {
    const m = checkStoplist({ description: "", cwd: CLEAN_CWD });
    assert.equal(m.length, 0);
  });

  // Regression: a real hello-world-codex-loop brief.md's own out-of-scope
  // paragraph ("It does not include authentication, persistent storage,
  // deployment infrastructure...") tripped the stoplist purely by naming a
  // topic it was explicitly excluding — halting a --track loop run on an
  // app with no auth at all, with no way forward short of --force on every
  // single run.
  it("doesn't match a keyword the text explicitly excludes ('does not include X')", () => {
    const m = checkStoplist({
      description: "It does not include authentication, persistent storage, or deployment infrastructure.",
      cwd: CLEAN_CWD,
    });
    assert.equal(m.length, 0);
  });

  it("doesn't match a keyword explicitly marked out of scope", () => {
    const m = checkStoplist({ description: "Payments integration is out of scope for this change.", cwd: CLEAN_CWD });
    assert.equal(m.length, 0);
  });

  it("still matches the same keyword elsewhere in the text even when one mention is negated", () => {
    const m = checkStoplist({
      description: "This does not include authentication. Also add a new login endpoint with session cookies.",
      cwd: CLEAN_CWD,
    });
    assert.ok(m.length > 0, "a genuine, non-negated mention in a later sentence must still be caught");
  });

  it("still matches an un-negated keyword (bias toward false positives preserved)", () => {
    const m = checkStoplist({ description: "add auth middleware", cwd: CLEAN_CWD });
    assert.ok(m.length > 0);
  });
});

describe("stoplist: explanation", () => {
  it("explains matches in human-readable form", () => {
    const m = checkStoplist({ description: "rotate session secrets", cwd: CLEAN_CWD });
    const text = explainMatches(m);
    assert.match(text, /safety stoplist/i);
    assert.match(text, /--force/);
  });

  // Regression: the remedy line said "Use /pipeline instead" — a stale
  // ghost-command reference (no /pipeline command exists; this same class
  // of leftover slash-command prose was already swept from rules/ and
  // roles/ once before). Confusing at best, actionless in headless mode
  // where there's no chat surface to type a slash command into at all.
  it("tells the user the actual actionable remedy (--track full), not a stale slash command", () => {
    const m = checkStoplist({ description: "add auth middleware", cwd: CLEAN_CWD });
    const text = explainMatches(m);
    assert.match(text, /--track full/);
    // ".devteam/rules/pipeline.md" (a real file reference) is fine — only
    // the stale "Use /pipeline" ghost-command phrasing must be gone.
    assert.doesNotMatch(text, /Use \/pipeline/);
  });

  it("shows only the matching line, not the entire source document", () => {
    const brief = Array.from({ length: 50 }, (_, i) => `Line ${i + 1} of content here.`).join("\n")
      + "\nThis line mentions auth for testing.\n"
      + Array.from({ length: 50 }, (_, i) => `Trailing line ${i + 1}.`).join("\n");
    const { findStoplistMatches, STOPLIST_PATTERNS } = require(path.join(REPO_ROOT, "core", "guards", "stoplist"));
    const matches = findStoplistMatches([brief], STOPLIST_PATTERNS);
    assert.ok(matches.length > 0, "should match auth");
    const text = explainMatches(matches);
    // The explanation must not contain lines from unrelated parts of the document.
    assert.doesNotMatch(text, /Line 1 of content/, "must not dump entire document");
    assert.doesNotMatch(text, /Trailing line 50/, "must not dump entire document");
    // It must still identify the matched term.
    assert.match(text, /auth/);
  });

  it("truncates a very long matching line to 120 characters", () => {
    const longLine = "auth " + "x".repeat(200);
    const { findStoplistMatches, STOPLIST_PATTERNS } = require(path.join(REPO_ROOT, "core", "guards", "stoplist"));
    const matches = findStoplistMatches([longLine], STOPLIST_PATTERNS);
    const text = explainMatches(matches);
    const reasonLine = text.split("\n").find((l) => l.includes("authentication"));
    assert.ok(reasonLine, "should have a reason line");
    assert.ok(reasonLine.length <= 200, "reason line should be reasonably short");
    assert.match(text, /…/, "truncated line must end with ellipsis");
  });
});

// Issue #489. The refusal quoted the matched line and stopped there, which is
// not enough to act on: the same sentence can be the change you just described
// or a brief left behind by a change that finished a week ago, and those want
// opposite responses. Under the default in-place isolation one brief serves
// every change, so a completed change's prose keeps gating lighter tracks --
// attune's brief mentioned a migration it was *removing* and gated unrelated
// work eight days later, at 22-24 dispatches on `full` instead of 5 on `loop`.
describe("stoplist: the refusal names which artifact matched", () => {
  const projectWithBrief = (brief) => {
    const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "devteam-test-stoplist-"));
    fs.mkdirSync(path.join(cwd, "pipeline"), { recursive: true });
    fs.writeFileSync(path.join(cwd, "pipeline", "brief.md"), brief);
    return cwd;
  };

  it("attributes a match to the change description", () => {
    const m = checkStoplist({ description: "add authentication to login", cwd: CLEAN_CWD });
    assert.equal(m[0].from, "the change description");
    assert.match(explainMatches(m), /matched "authentication" in the change description/);
  });

  it("attributes a match to the brief, not the description", () => {
    // The description is clean; only the stale brief matches.
    const cwd = projectWithBrief(
      "replace the obsolete promised Mem0-to-Graphiti migration with the current contract.\n");
    const m = checkStoplist({ description: "add a unit test for adapter selection", cwd });
    assert.equal(m.length, 1);
    assert.equal(m[0].from, "pipeline/brief.md");
    assert.match(explainMatches(m), /matched "migration" in pipeline\/brief\.md/);
    fs.rmSync(cwd, { recursive: true, force: true });
  });

  it("offers archiving when a brief is responsible", () => {
    const cwd = projectWithBrief("this change performs a database migration\n");
    const text = explainMatches(checkStoplist({ description: "tidy docs", cwd }));
    assert.match(text, /belongs to a change you have already finished/);
    assert.match(text, /mv pipeline\/brief\.md pipeline\/archive\//);
    fs.rmSync(cwd, { recursive: true, force: true });
  });

  it("does not offer archiving when no brief matched", () => {
    // Suggesting it for a genuinely consequential description would teach
    // operators to clear state instead of reading the warning.
    const text = explainMatches(checkStoplist({ description: "add authentication", cwd: CLEAN_CWD }));
    assert.doesNotMatch(text, /already finished/);
    assert.match(text, /--force to bypass/);
  });

  it("still names --force, which remains the documented bypass", () => {
    const cwd = projectWithBrief("a payments migration is planned\n");
    assert.match(explainMatches(checkStoplist({ description: "tidy docs", cwd })), /--force to bypass/);
    fs.rmSync(cwd, { recursive: true, force: true });
  });
});

describe("stoplist: findStoplistMatches accepts both candidate shapes", () => {
  const { findStoplistMatches } = require(path.join(REPO_ROOT, "core", "guards", "stoplist"));

  it("still takes bare strings, so existing callers keep working", () => {
    const m = findStoplistMatches(["this needs a database migration"]);
    assert.equal(m.length, 1);
    assert.equal(m[0].from, null, "an unlabelled candidate reports no source");
  });

  it("carries the label through when given one", () => {
    const m = findStoplistMatches([{ text: "a payments change", from: "somewhere" }]);
    assert.equal(m[0].from, "somewhere");
  });

  it("ignores malformed candidates rather than throwing", () => {
    assert.deepEqual(findStoplistMatches([null, undefined, {}, { text: null }, ""]), []);
  });
});
