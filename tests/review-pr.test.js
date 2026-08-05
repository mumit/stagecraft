// tests/review-pr.test.js
//
// Phase-35 item 35.2 — `devteam review-pr <number|url>`.
//
// A scripted `gh` stub on PATH stands in for the real GitHub CLI (view/diff/
// review); a scripted DEVTEAM_HEADLESS_COMMAND stands in for the real host
// CLI that would otherwise write pipeline/gates/stage-05*.json and
// pipeline/code-review/by-*.md (mirrors tests/replay.test.js's pattern).
//
// Coverage:
//   1. materialization: PR view/diff land under pipeline/review-input/.
//   2. panel mode: single-reviewer dispatch produces a valid stage-05 gate.
//   3. adversarial mode (review.mode: adversarial): reviewer wave + critic
//      wave, merged into one stage-05 gate.
//   4. --post without confirmation (non-interactive, no --yes) posts
//      nothing — the gh stub never sees a "pr review" call.
//   5. missing `gh` on PATH gives an actionable error.
//   6. a partial/incomplete review never posts, even with --yes.
//   7. phase-36 item 36.5: the same command from a directory that is
//      neither an initialised Stagecraft project nor the repo — state lands
//      in a 36.3 review workspace instead of cwd, and every 35.2
//      publishing-safety behavior above still holds in that mode.

"use strict";

const { describe, it, afterEach } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const { makeTargetProject, cleanup, runCLI } = require("./_helpers");

let _dirs = [];
function track(cwd) { _dirs.push(cwd); return cwd; }
afterEach(() => { _dirs.forEach(cleanup); _dirs = []; });

const CONFIG_PANEL = "routing:\n  default_host: claude-code\npipeline:\n  default_track: full\n";
const CONFIG_ADVERSARIAL = "routing:\n  default_host: claude-code\nreview:\n  mode: adversarial\npipeline:\n  default_track: full\n";

// ---------------------------------------------------------------------------
// Fixtures: a scripted `gh` on PATH, and a scripted headless host command.
// ---------------------------------------------------------------------------

function writeGhStub(dir, { logPath } = {}) {
  const ghPath = path.join(dir, "gh");
  const script = `#!/usr/bin/env node
const fs = require("fs");
const args = process.argv.slice(2);
const logPath = ${JSON.stringify(logPath || null)};
function log(x) { if (logPath) { try { fs.appendFileSync(logPath, x + "\\n"); } catch {} } }
log(JSON.stringify(args));
if (args[0] === "--version") { console.log("gh version 9.9.9"); process.exit(0); }
if (args[0] === "auth" && args[1] === "status") { console.log("Logged in to github.com"); process.exit(0); }
if (args[0] === "pr" && args[1] === "view") {
  console.log(JSON.stringify({
    number: 42,
    title: "Fix the widget crash",
    body: "This PR fixes the widget crash.\\n\\nCloses #10",
    url: "https://github.com/acme/widgets/pull/42",
    headRefName: "fix-widget-crash",
    baseRefName: "main",
    headRefOid: "abc123def",
    files: [{ path: "src/backend/widget.js", additions: 5, deletions: 1 }],
  }));
  process.exit(0);
}
if (args[0] === "pr" && args[1] === "diff") {
  console.log("diff --git a/src/backend/widget.js b/src/backend/widget.js\\n--- a/src/backend/widget.js\\n+++ b/src/backend/widget.js\\n@@ -1 +1 @@\\n-old\\n+new\\n");
  process.exit(0);
}
if (args[0] === "pr" && args[1] === "review") {
  let body = "";
  try { body = fs.readFileSync(0, "utf8"); } catch {}
  // JSON-encode: the body is multi-line and the log file is line-delimited.
  log("BODY:" + JSON.stringify(body));
  process.exit(0);
}
console.error("gh-stub: unhandled args " + JSON.stringify(args));
process.exit(1);
`;
  fs.writeFileSync(ghPath, script, { mode: 0o755 });
  return ghPath;
}

// Stands in for the host CLI runHeadless() spawns. Branches on the rendered
// prompt's "Workstream: <id>" line (piped to stdin) since that's the only
// per-dispatch differentiator available to a fixed DEVTEAM_HEADLESS_COMMAND
// string reused across the reviewer and critic waves in adversarial mode.
function writeHostWriter(cwd) {
  const writerPath = path.join(cwd, "fake-host.js");
  fs.writeFileSync(writerPath, `
const fs = require("node:fs");
const path = require("node:path");
let prompt = "";
try { prompt = fs.readFileSync(0, "utf8"); } catch {}
const gatesDir = path.join(process.cwd(), "pipeline", "gates");
const reviewDir = path.join(process.cwd(), "pipeline", "code-review");
fs.mkdirSync(gatesDir, { recursive: true });
fs.mkdirSync(reviewDir, { recursive: true });
function writeGate(name, gate) {
  fs.writeFileSync(path.join(gatesDir, name + ".json"), JSON.stringify(gate, null, 2));
}
const isCriticWave = /Workstream:\\s*stage-05\\.critic\\b/.test(prompt);
const isAdversarialReviewerWave = /Workstream:\\s*stage-05\\.reviewer\\b/.test(prompt);
const base = { orchestrator: "devteam@test", host: "claude-code", track: "review-pr", timestamp: new Date().toISOString(), blockers: [], warnings: [] };
if (isCriticWave) {
  fs.writeFileSync(path.join(reviewDir, "by-critic.md"), "# Critic Review\\n\\nChecked the reviewer's approval. No challenges.\\n");
  writeGate("stage-05.critic", { ...base, stage: "stage-05", workstream: "critic", mode: "adversarial", status: "PASS", challenges: [], challenges_resolved: true });
} else if (isAdversarialReviewerWave) {
  fs.writeFileSync(path.join(reviewDir, "by-reviewer.md"), "## Review of backend\\nLooks fine.\\nREVIEW: APPROVED\\n");
  writeGate("stage-05.reviewer", { ...base, stage: "stage-05", workstream: "reviewer", mode: "adversarial", status: "PASS", areas_reviewed: ["backend"], approved_areas: ["backend"], changes_requested: [] });
} else {
  fs.writeFileSync(path.join(reviewDir, "by-reviewer.md"), "## Review of backend\\nLooks fine.\\nREVIEW: APPROVED\\n");
  writeGate("stage-05", { ...base, stage: "stage-05", workstream: "reviewer", review_shape: "single", required_approvals: 1, approvals: ["reviewer"], changes_requested: [], escalated_to_principal: false, status: "PASS" });
}
`);
  return writerPath;
}

function setup({ config = CONFIG_PANEL } = {}) {
  const cwd = track(makeTargetProject({ config, gates: false }));
  const stubDir = track(fs.mkdtempSync(path.join(require("node:os").tmpdir(), "devteam-test-ghstub-")));
  const logPath = path.join(cwd, "gh-calls.log");
  writeGhStub(stubDir, { logPath });
  const writerPath = writeHostWriter(cwd);
  const env = {
    PATH: `${stubDir}${path.delimiter}${process.env.PATH}`,
    DEVTEAM_HEADLESS_COMMAND: `node ${writerPath}`,
    DEVTEAM_NO_LOG: "1",
  };
  return { cwd, logPath, env };
}

// Phase-36 item 36.5 — the same fixtures as setup() above, but `cwd` is a
// plain directory (no .devteam/, not a git checkout): neither a Stagecraft
// project nor "the repo". STAGECRAFT_REVIEWS_DIR is pinned to a fresh
// tmpdir so the review workspace lands somewhere this test controls and
// cleans up, never under the real ~/.stagecraft/reviews/.
function setupNoProject() {
  const cwd = track(fs.mkdtempSync(path.join(os.tmpdir(), "devteam-test-noproject-")));
  const reviewsDir = track(fs.mkdtempSync(path.join(os.tmpdir(), "devteam-test-reviews-")));
  const stubDir = track(fs.mkdtempSync(path.join(os.tmpdir(), "devteam-test-ghstub-")));
  const logPath = path.join(cwd, "gh-calls.log");
  writeGhStub(stubDir, { logPath });
  const writerPath = writeHostWriter(cwd);
  const env = {
    PATH: `${stubDir}${path.delimiter}${process.env.PATH}`,
    DEVTEAM_HEADLESS_COMMAND: `node ${writerPath}`,
    DEVTEAM_NO_LOG: "1",
    STAGECRAFT_REVIEWS_DIR: reviewsDir,
  };
  return { cwd, reviewsDir, logPath, env };
}

function readCalls(logPath) {
  if (!fs.existsSync(logPath)) return [];
  return fs.readFileSync(logPath, "utf8").trim().split("\n").filter(Boolean);
}

// ─── 1 + 2. Materialization + panel-mode e2e ───────────────────────────────

describe("review-pr: materialization + panel-mode dispatch", () => {
  it("materializes the PR into pipeline/review-input/ and produces a valid stage-05 gate", () => {
    const { cwd, env } = setup();
    const r = runCLI(["review-pr", "42", "--json"], { cwd, env });
    assert.equal(r.status, 0, `review-pr failed: ${r.stderr}\n---\n${r.stdout}`);

    const inputDir = path.join(cwd, "pipeline", "review-input");
    assert.ok(fs.existsSync(path.join(inputDir, "pr.md")), "pr.md not materialized");
    assert.ok(fs.existsSync(path.join(inputDir, "diff.patch")), "diff.patch not materialized");
    assert.ok(fs.existsSync(path.join(inputDir, "changed-files.md")), "changed-files.md not materialized");

    const prMd = fs.readFileSync(path.join(inputDir, "pr.md"), "utf8");
    assert.match(prMd, /Fix the widget crash/);
    assert.match(prMd, /Closes #10/);
    const diff = fs.readFileSync(path.join(inputDir, "diff.patch"), "utf8");
    assert.match(diff, /diff --git/);
    const changed = fs.readFileSync(path.join(inputDir, "changed-files.md"), "utf8");
    assert.match(changed, /src\/backend\/widget\.js/);

    const out = JSON.parse(r.stdout);
    assert.equal(out.pr.number, 42);
    assert.equal(out.partial, false);
    assert.equal(out.gate.status, "PASS");
    assert.equal(out.gate.stage, "stage-05");
    assert.equal(out.posted, false);

    const gatePath = path.join(cwd, "pipeline", "gates", "stage-05.json");
    assert.ok(fs.existsSync(gatePath), "pipeline/gates/stage-05.json was not written");
  });

  it("accepts a full PR URL in place of a bare number", () => {
    const { cwd, env } = setup();
    const r = runCLI(["review-pr", "https://github.com/acme/widgets/pull/42", "--json"], { cwd, env });
    assert.equal(r.status, 0, `review-pr failed: ${r.stderr}\n---\n${r.stdout}`);
    const out = JSON.parse(r.stdout);
    assert.equal(out.gate.status, "PASS");
  });
});

// ─── 3. Adversarial mode adds the critic ───────────────────────────────────

describe("review-pr: adversarial mode (review.mode: adversarial)", () => {
  it("dispatches reviewer then critic and merges into one stage-05 gate", () => {
    const { cwd, env } = setup({ config: CONFIG_ADVERSARIAL });
    const r = runCLI(["review-pr", "42", "--json"], { cwd, env });
    assert.equal(r.status, 0, `review-pr failed: ${r.stderr}\n---\n${r.stdout}`);

    assert.ok(fs.existsSync(path.join(cwd, "pipeline", "gates", "stage-05.reviewer.json")), "reviewer workstream gate missing");
    assert.ok(fs.existsSync(path.join(cwd, "pipeline", "gates", "stage-05.critic.json")), "critic workstream gate missing");
    assert.ok(fs.existsSync(path.join(cwd, "pipeline", "code-review", "by-reviewer.md")));
    assert.ok(fs.existsSync(path.join(cwd, "pipeline", "code-review", "by-critic.md")));

    const out = JSON.parse(r.stdout);
    assert.equal(out.gate.status, "PASS");
    assert.equal(out.gate.challenges_resolved, true);
    assert.equal(out.gate.workstreams.length, 2);
    assert.deepEqual(out.gate.workstreams.map((w) => w.workstream), ["reviewer", "critic"]);
  });
});

// ─── 4. --post without confirmation posts nothing ──────────────────────────

describe("review-pr: --post gating", () => {
  it("refuses in a non-interactive context without --yes, and posts nothing", () => {
    const { cwd, env, logPath } = setup();
    const r = runCLI(["review-pr", "42", "--post"], { cwd, env });
    assert.notEqual(r.status, 0, "expected a non-zero exit when --post is refused");
    assert.match(r.stderr, /non-interactive/);

    const calls = readCalls(logPath);
    const reviewCalls = calls.filter((c) => c.startsWith('["pr","review"'));
    assert.equal(reviewCalls.length, 0, "gh stub should never have received a `pr review` call");
  });

  it("--post --yes posts the review as a PR comment", () => {
    const { cwd, env, logPath } = setup();
    const r = runCLI(["review-pr", "42", "--post", "--yes"], { cwd, env });
    assert.equal(r.status, 0, `review-pr --post --yes failed: ${r.stderr}\n---\n${r.stdout}`);

    const calls = readCalls(logPath);
    const reviewCalls = calls.filter((c) => c.startsWith('["pr","review"'));
    assert.equal(reviewCalls.length, 1, "expected exactly one `gh pr review` call");
    const bodyLine = calls.find((c) => c.startsWith("BODY:"));
    assert.ok(bodyLine, "posted body was not captured");
    const postedBody = JSON.parse(bodyLine.slice("BODY:".length));
    assert.match(postedBody, /REVIEW: APPROVED/);
    assert.match(r.stdout, /Posted to PR/);
  });
});

// ─── 5. Missing `gh` gives an actionable error ─────────────────────────────

describe("review-pr: missing `gh` on PATH", () => {
  it("gives an actionable error instead of a raw stack trace", () => {
    const cwd = track(makeTargetProject({ config: CONFIG_PANEL, gates: false }));
    // PATH restricted to node's own directory only — guarantees no `gh`
    // resolves, regardless of what's installed on the host running this test.
    const nodeDir = path.dirname(process.execPath);
    const r = runCLI(["review-pr", "42"], { cwd, env: { PATH: nodeDir } });
    assert.notEqual(r.status, 0);
    assert.match(r.stderr, /`gh` CLI not found on PATH/);
  });
});

// ─── 6. A partial/incomplete review never posts, even with --yes ──────────

describe("review-pr: partial review never posts", () => {
  it("refuses --post when the dispatch never wrote a gate, even with --yes", () => {
    const { cwd, env, logPath } = setup();
    // `true` exits 0 immediately without touching stdin or writing a gate —
    // simulates a dispatch that never completed (no pipeline/gates/stage-05.json).
    const partialEnv = { ...env, DEVTEAM_HEADLESS_COMMAND: "true" };
    const r = runCLI(["review-pr", "42", "--post", "--yes"], { cwd, env: partialEnv });
    assert.notEqual(r.status, 0, "expected a non-zero exit on a partial review");
    assert.match(r.stderr, /did not complete/);

    const calls = readCalls(logPath);
    const reviewCalls = calls.filter((c) => c.startsWith('["pr","review"'));
    assert.equal(reviewCalls.length, 0, "gh stub should never have received a `pr review` call on a partial review");
  });
});

// ─── 7. Phase-36 item 36.5: workspace mode (no initialised project) ────────

describe("review-pr: workspace mode — succeeds from a directory that is neither a Stagecraft project nor the repo", () => {
  it("materializes into the workspace (not cwd), dispatches, and produces a valid stage-05 gate", () => {
    const { cwd, reviewsDir, env } = setupNoProject();
    const r = runCLI(["review-pr", "https://github.com/acme/widgets/pull/42", "--json"], { cwd, env });
    assert.equal(r.status, 0, `review-pr failed: ${r.stderr}\n---\n${r.stdout}`);

    const out = JSON.parse(r.stdout);
    assert.equal(out.pr.number, 42);
    assert.equal(out.partial, false);
    assert.equal(out.gate.status, "PASS");
    assert.ok(out.workspace, "a workspace path must be reported in workspace mode");
    assert.ok(
      path.resolve(out.workspace).startsWith(path.resolve(reviewsDir)),
      `workspace ${out.workspace} must land under STAGECRAFT_REVIEWS_DIR ${reviewsDir}`,
    );

    // Nothing written into the invoking cwd — no .devteam/, no pipeline/.
    assert.ok(!fs.existsSync(path.join(cwd, "pipeline")), "no pipeline/ must be created in the invoking cwd");
    assert.ok(!fs.existsSync(path.join(cwd, ".devteam")), "no .devteam/ must be created in the invoking cwd");

    // State actually lands under the workspace.
    const inputDir = path.join(out.workspace, "pipeline", "review-input");
    assert.ok(fs.existsSync(path.join(inputDir, "pr.md")), "pr.md not materialized into the workspace");
    assert.ok(fs.existsSync(path.join(inputDir, "diff.patch")), "diff.patch not materialized into the workspace");
    assert.ok(fs.existsSync(path.join(inputDir, "changed-files.md")), "changed-files.md not materialized into the workspace");
    assert.ok(fs.existsSync(path.join(out.workspace, "pipeline", "gates", "stage-05.json")), "gate not written into the workspace");

    // subject.json records the PR's identity, not a filesystem path — there
    // is no checkout, so codeRoot is genuinely absent (36.1's
    // findWriteViolation already special-cases a falsy codeRoot).
    const subject = JSON.parse(fs.readFileSync(path.join(out.workspace, "subject.json"), "utf8"));
    assert.equal(subject.subject_path, null);
    assert.equal(subject.remote, "https://github.com/acme/widgets.git");
    assert.equal(subject.commit_sha, "abc123def");
    assert.deepEqual(subject.pr, { number: 42, url: "https://github.com/acme/widgets/pull/42", title: "Fix the widget crash" });
  });

  it("re-running the same PR reuses the same workspace (stable slug across invocations)", () => {
    const { cwd, env } = setupNoProject();
    const r1 = runCLI(["review-pr", "https://github.com/acme/widgets/pull/42", "--json"], { cwd, env });
    assert.equal(r1.status, 0, `first review-pr failed: ${r1.stderr}`);
    const r2 = runCLI(["review-pr", "https://github.com/acme/widgets/pull/42", "--json"], { cwd, env });
    assert.equal(r2.status, 0, `second review-pr failed: ${r2.stderr}`);
    assert.equal(JSON.parse(r1.stdout).workspace, JSON.parse(r2.stdout).workspace);
  });
});

// The exact 35.2 publishing-safety behaviors from sections 4 and 6 above,
// re-verified with no initialised project in play — 36.5 must not relax any
// of it while moving the state root into the workspace.

describe("review-pr: workspace mode — 35.2 publishing safety re-verified with no initialised project", () => {
  it("refuses --post in a non-interactive context without --yes, and posts nothing", () => {
    const { cwd, env, logPath } = setupNoProject();
    const r = runCLI(["review-pr", "https://github.com/acme/widgets/pull/42", "--post"], { cwd, env });
    assert.notEqual(r.status, 0, "expected a non-zero exit when --post is refused");
    assert.match(r.stderr, /non-interactive/);

    const calls = readCalls(logPath);
    const reviewCalls = calls.filter((c) => c.startsWith('["pr","review"'));
    assert.equal(reviewCalls.length, 0, "gh stub should never have received a `pr review` call");
  });

  it("--post --yes posts the review as a PR comment", () => {
    const { cwd, env, logPath } = setupNoProject();
    const r = runCLI(["review-pr", "https://github.com/acme/widgets/pull/42", "--post", "--yes"], { cwd, env });
    assert.equal(r.status, 0, `review-pr --post --yes failed: ${r.stderr}\n---\n${r.stdout}`);

    const calls = readCalls(logPath);
    const reviewCalls = calls.filter((c) => c.startsWith('["pr","review"'));
    assert.equal(reviewCalls.length, 1, "expected exactly one `gh pr review` call");
    assert.match(r.stdout, /Posted to PR/);
  });

  it("refuses --post when the dispatch never wrote a gate, even with --yes (partial review)", () => {
    const { cwd, env, logPath } = setupNoProject();
    const partialEnv = { ...env, DEVTEAM_HEADLESS_COMMAND: "true" };
    const r = runCLI(["review-pr", "https://github.com/acme/widgets/pull/42", "--post", "--yes"], { cwd, env: partialEnv });
    assert.notEqual(r.status, 0, "expected a non-zero exit on a partial review");
    assert.match(r.stderr, /did not complete/);

    const calls = readCalls(logPath);
    const reviewCalls = calls.filter((c) => c.startsWith('["pr","review"'));
    assert.equal(reviewCalls.length, 0, "gh stub should never have received a `pr review` call on a partial review");
  });
});
