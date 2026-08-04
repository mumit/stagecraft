// Phase-36 item 36.3 (plans/phase-36-external-review-mode.md §36.3) — the
// review workspace (core/review-workspace.js) and the dispatch plumbing
// (ctx.processCwd / ctx.externalReviewMode) that keeps a review's state out
// of the subject being reviewed.
//
// Coverage:
//   1. core/review-workspace.js: slug stability, --workspace override,
//      createReviewWorkspace's directory skeleton, subject.json round-trip.
//   2. core/orchestrator.js runStage(): opts.processCwd/opts.externalReviewMode
//      reach ctx unchanged; absent them, ctx is byte-identical to pre-36.3.
//   3. core/driver.js run(): the same two opts reach runStageHeadless's opts,
//      mirroring how opts.scope already does (Phase-35 item 35.1).
//   4. THE TEST THAT MATTERS: a real dispatch (hosts/acp's adapter, driven by
//      tests/fixtures/acp-stub-agent.js — no network, no real model) against a
//      workspace built by createReviewWorkspace(), with a genuinely separate
//      fixture subject repo. Snapshots the subject tree (file list + content
//      hash, .gitignore/AGENTS.md included) before and after and asserts it
//      is completely unchanged; asserts every gate/log lands under the
//      workspace; completes the review-only track and asserts
//      `devteam verify-chain` passes against the workspace.

"use strict";

const { describe, it, afterEach } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const crypto = require("node:crypto");
const { spawnSync } = require("node:child_process");

const { REPO_ROOT, cleanup, runCLI } = require("./_helpers");
const {
  reviewsRoot,
  slugForSubject,
  resolveWorkspacePath,
  createReviewWorkspace,
  writeSubjectManifest,
  readSubjectManifest,
} = require(path.join(REPO_ROOT, "core", "review-workspace"));
const { runStage, runStageHeadless, mergeWorkstreamGates } = require(path.join(REPO_ROOT, "core", "orchestrator"));
const { loadConfig, clearConfigCache } = require(path.join(REPO_ROOT, "core", "config"));
const { stampAll, verifyChain } = require(path.join(REPO_ROOT, "core", "gates", "chain"));
const { run: runDriver } = require(path.join(REPO_ROOT, "core", "driver"));

const STUB_PATH = path.join(REPO_ROOT, "tests", "fixtures", "acp-stub-agent.js");

let _dirs = [];
function track(dir) { _dirs.push(dir); return dir; }
afterEach(() => { _dirs.forEach(cleanup); _dirs = []; });

async function withEnvVars(vars, fn) {
  const prior = {};
  for (const key of Object.keys(vars)) prior[key] = process.env[key];
  for (const [key, value] of Object.entries(vars)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  try {
    return await fn();
  } finally {
    for (const [key, value] of Object.entries(prior)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
}

function tmpdir(prefix) {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  return track(d);
}

function makeFixtureSubjectRepo() {
  const dir = tmpdir("devteam-test-subject-");
  spawnSync("git", ["init", "-q", "-b", "main"], { cwd: dir });
  spawnSync("git", ["config", "user.email", "test@example.com"], { cwd: dir });
  spawnSync("git", ["config", "user.name", "Test"], { cwd: dir });
  fs.writeFileSync(path.join(dir, "AGENTS.md"), "# fixture subject project\n");
  fs.writeFileSync(path.join(dir, ".gitignore"), "node_modules/\n");
  fs.mkdirSync(path.join(dir, "src"), { recursive: true });
  fs.writeFileSync(path.join(dir, "src", "index.js"), "module.exports = 1;\n");
  spawnSync("git", ["add", "-A"], { cwd: dir });
  spawnSync("git", ["commit", "-q", "-m", "init", "--no-gpg-sign"], { cwd: dir });
  spawnSync("git", ["remote", "add", "origin", "https://example.com/devteam-test/subject.git"], { cwd: dir });
  return dir;
}

function subjectHeadSha(dir) {
  return spawnSync("git", ["rev-parse", "HEAD"], { cwd: dir, encoding: "utf8" }).stdout.trim();
}

// File list + content hash, including dotfiles — .git is excluded (internal
// bookkeeping, not "the subject" in the sense the plan's promise is about;
// nothing under test ever runs a git command against the fixture repo).
function snapshotTree(dir) {
  const files = [];
  function walk(rel) {
    for (const entry of fs.readdirSync(path.join(dir, rel), { withFileTypes: true })) {
      if (rel === "" && entry.name === ".git") continue;
      const relPath = rel ? `${rel}/${entry.name}` : entry.name;
      if (entry.isDirectory()) walk(relPath);
      else files.push(relPath);
    }
  }
  walk("");
  files.sort();
  const hash = crypto.createHash("sha256");
  for (const f of files) {
    hash.update(f);
    hash.update(fs.readFileSync(path.join(dir, f)));
  }
  return { files, digest: hash.digest("hex") };
}

// ─── 1. core/review-workspace.js ───────────────────────────────────────────

describe("36.3: core/review-workspace.js — slug + workspace path resolution", () => {
  it("slugForSubject is stable across calls for the same absolute path", () => {
    const dir = tmpdir("devteam-test-subject-");
    assert.equal(slugForSubject(dir), slugForSubject(dir));
  });

  it("slugForSubject differs for two subjects sharing a basename", () => {
    const a = tmpdir("devteam-test-subject-");
    const b = tmpdir("devteam-test-subject-");
    fs.renameSync(a, path.join(path.dirname(a), "same-name"));
    fs.renameSync(b, path.join(path.dirname(b), "same-name-2"));
    // Two distinct absolute paths, same-ish basename family — assert distinct
    // slugs by comparing against a truly identical basename on a different parent.
    const parent1 = tmpdir("devteam-test-parent1-");
    const parent2 = tmpdir("devteam-test-parent2-");
    const p1 = path.join(parent1, "repo");
    const p2 = path.join(parent2, "repo");
    fs.mkdirSync(p1);
    fs.mkdirSync(p2);
    assert.notEqual(slugForSubject(p1), slugForSubject(p2), "same basename, different absolute path => different slug");
  });

  it("resolveWorkspacePath derives ~/.stagecraft/reviews/<slug> under STAGECRAFT_REVIEWS_DIR", async () => {
    const reviewsDir = tmpdir("devteam-test-reviews-");
    const subject = tmpdir("devteam-test-subject-");
    await withEnvVars({ STAGECRAFT_REVIEWS_DIR: reviewsDir }, () => {
      assert.equal(reviewsRoot(), reviewsDir);
      const resolved = resolveWorkspacePath(subject);
      assert.equal(resolved, path.join(reviewsDir, slugForSubject(subject)));
    });
  });

  it("--workspace override wins outright over the derived path", () => {
    const subject = tmpdir("devteam-test-subject-");
    const override = path.join(tmpdir("devteam-test-workspace-"), "nested");
    const resolved = resolveWorkspacePath(subject, override);
    assert.equal(resolved, path.resolve(override));
  });
});

describe("36.3: createReviewWorkspace() — directory skeleton + subject.json", () => {
  it("creates pipeline/gates, a routing+track config.yml, and the ACP role/skill dirs from capabilities.json", () => {
    const subject = makeFixtureSubjectRepo();
    const workspace = path.join(tmpdir("devteam-test-workspace-"), "ws");
    const result = createReviewWorkspace({ subjectPath: subject, workspacePath: workspace, host: "acp", track: "review-only" });

    assert.ok(fs.existsSync(path.join(workspace, "pipeline", "gates")), "pipeline/gates/ created");
    assert.ok(fs.existsSync(path.join(workspace, ".devteam", "config.yml")), "config.yml written");

    clearConfigCache();
    const config = loadConfig(workspace);
    assert.equal(config.routing.default_host, "acp");
    assert.equal(config.pipeline.default_track, "review-only");

    const acpAdapter = require(path.join(REPO_ROOT, "hosts", "acp", "adapter.js"));
    assert.ok(fs.existsSync(path.join(workspace, acpAdapter.capabilities.rolePromptsDir)), "ACP role prompts dir created");
    assert.ok(fs.existsSync(path.join(workspace, acpAdapter.capabilities.skillsDir)), "ACP skills dir created");
    assert.ok(result.install.written.length > 0, "adapter.install() actually wrote something");
  });

  it("writes subject.json recording the subject's absolute path, git remote, and commit SHA reviewed", () => {
    const subject = makeFixtureSubjectRepo();
    const workspace = path.join(tmpdir("devteam-test-workspace-"), "ws");
    const { subject: manifest } = createReviewWorkspace({ subjectPath: subject, workspacePath: workspace });

    assert.equal(manifest.subject_path, path.resolve(subject));
    assert.equal(manifest.remote, "https://example.com/devteam-test/subject.git");
    assert.equal(manifest.commit_sha, subjectHeadSha(subject));

    const reread = readSubjectManifest(workspace);
    assert.deepEqual(reread, manifest);
  });

  it("subject.json still records path (null remote/sha) when the subject isn't a git repo", () => {
    const subject = tmpdir("devteam-test-subject-");
    fs.writeFileSync(path.join(subject, "README.md"), "no git here\n");
    const workspace = path.join(tmpdir("devteam-test-workspace-"), "ws");
    const manifest = writeSubjectManifest(workspace, subject);
    assert.equal(manifest.subject_path, path.resolve(subject));
    assert.equal(manifest.remote, null);
    assert.equal(manifest.commit_sha, null);
  });

  it("is idempotent-safe to re-run without force (config.yml not clobbered)", () => {
    const subject = makeFixtureSubjectRepo();
    const workspace = path.join(tmpdir("devteam-test-workspace-"), "ws");
    createReviewWorkspace({ subjectPath: subject, workspacePath: workspace, track: "review-only" });
    fs.writeFileSync(path.join(workspace, ".devteam", "config.yml"), "routing:\n  default_host: acp\npipeline:\n  default_track: custom-marker\n");
    createReviewWorkspace({ subjectPath: subject, workspacePath: workspace, track: "review-only" });
    clearConfigCache();
    assert.equal(loadConfig(workspace).pipeline.default_track, "custom-marker", "existing config.yml must not be overwritten absent force");
  });
});

// ─── 2. core/orchestrator.js runStage() ctx wiring ─────────────────────────

describe("36.3: runStage() threads opts.processCwd/opts.externalReviewMode into ctx", () => {
  it("carries both fields onto ctx unchanged", () => {
    const workspace = tmpdir("devteam-test-workspace-");
    const subject = tmpdir("devteam-test-subject-");
    const plan = runStage("security-review", {
      cwd: workspace,
      processCwd: subject,
      externalReviewMode: true,
      track: "review-only",
    });
    assert.equal(plan.ctx.processCwd, subject);
    assert.equal(plan.ctx.externalReviewMode, true);
  });

  it("defaults to null/false when absent — byte-identical to every pre-36.3 caller", () => {
    const cwd = tmpdir("devteam-test-workspace-");
    const plan = runStage("security-review", { cwd, track: "review-only" });
    assert.equal(plan.ctx.processCwd, null);
    assert.equal(plan.ctx.externalReviewMode, false);
  });
});

// ─── 3. core/driver.js run() → runStageHeadless opts passthrough ──────────

describe("36.3: driver.run() threads opts.processCwd/opts.externalReviewMode to runStageHeadless", () => {
  it("a review-mode run() call passes both fields through to every dispatch", async () => {
    const { makeTargetProject } = require("./_helpers");
    const cwd = track(makeTargetProject());
    const subject = tmpdir("devteam-test-subject-");
    const seen = [];
    const actions = [
      { action: "run-stage", stage: "stage-04", name: "build" },
      { action: "merge", stage: "stage-04", name: "build" },
      { action: "pipeline-complete", reason: "done" },
    ];
    let i = 0;
    const s = await runDriver({
      cwd,
      processCwd: subject,
      externalReviewMode: true,
      next: () => actions[i++],
      runStageHeadless: async (_stageName, opts) => {
        seen.push(opts);
        return [{ role: "backend", gatePath: "x", exitCode: 0, durationMs: 1 }];
      },
      mergeWorkstreamGates: () => ({ merged: true }),
      stallProbe: () => () => {},
    });
    assert.equal(s.completed, true);
    assert.ok(seen.length > 0, "runStageHeadless was called");
    for (const opts of seen) {
      assert.equal(opts.processCwd, subject);
      assert.equal(opts.externalReviewMode, true);
    }
  });

  it("omitting them leaves runStageHeadless's opts byte-identical to today (undefined/false)", async () => {
    const { makeTargetProject } = require("./_helpers");
    const cwd = track(makeTargetProject());
    let seenOpts = null;
    const actions = [
      { action: "run-stage", stage: "stage-04", name: "build" },
      { action: "merge", stage: "stage-04", name: "build" },
      { action: "pipeline-complete", reason: "done" },
    ];
    let i = 0;
    await runDriver({
      cwd,
      next: () => actions[i++],
      runStageHeadless: async (_stageName, opts) => { seenOpts = opts; return [{ role: "backend", gatePath: "x", exitCode: 0, durationMs: 1 }]; },
      mergeWorkstreamGates: () => ({ merged: true }),
      stallProbe: () => () => {},
    });
    assert.equal(seenOpts.processCwd, undefined);
    assert.equal(seenOpts.externalReviewMode, false);
  });
});

// ─── 4. THE TEST THAT MATTERS: real dispatch, subject tree unchanged ──────

function passGateFor(stageId) {
  const extras = {
    "stage-04c": { surfaces_walked: [], findings_count: 0, severity_breakdown: { critical: 0, high: 0, medium: 0, low: 0 }, must_address_before_peer_review: [], noted_for_followup: [] },
    "stage-05": { review_shape: "matrix", required_approvals: 2, approvals: [], changes_requested: [], escalated_to_principal: false },
  };
  return {
    stage: stageId,
    status: "PASS",
    orchestrator: "devteam@test",
    host: "acp",
    track: "review-only",
    timestamp: new Date().toISOString(),
    blockers: [],
    warnings: [],
    ...(extras[stageId] || {}),
  };
}

function writeGate(workspace, name, gate) {
  const dir = path.join(workspace, "pipeline", "gates");
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, `${name}.json`), JSON.stringify(gate, null, 2));
}

describe("36.3: THE TEST THAT MATTERS — subject tree is byte-identical before/after a review-only run", () => {
  it("dispatches security-review via a real (stubbed) ACP agent with cwd=workspace/processCwd=subject, then completes review-only entirely under the workspace", async () => {
    const subject = makeFixtureSubjectRepo();
    const workspace = path.join(tmpdir("devteam-test-workspace-"), "ws");
    createReviewWorkspace({ subjectPath: subject, workspacePath: workspace, host: "acp", track: "review-only" });
    clearConfigCache();
    const config = loadConfig(workspace);

    const before = snapshotTree(subject);

    const allowedPath = path.join(workspace, "pipeline", "security-review.md");
    const gatePath = path.join(workspace, "pipeline", "gates", "stage-04b.json");
    const gateJson = JSON.stringify(passGateFor("stage-04b"));

    let results;
    await withEnvVars({
      DEVTEAM_HEADLESS_COMMAND: `node "${STUB_PATH}"`,
      ACP_STUB_MODE: "normal",
      ACP_STUB_ALLOWED_PATH: allowedPath,
      ACP_STUB_GATE_PATH: gatePath,
      ACP_STUB_GATE_JSON: gateJson,
    }, async () => {
      const outcome = await runStageHeadless("security-review", {
        cwd: workspace,
        processCwd: subject,
        externalReviewMode: true,
        track: "review-only",
        config,
        log: true,
      });
      results = outcome.results;
    });

    assert.equal(results.length, 1);
    assert.equal(results[0].stopReason, "end_turn");
    assert.equal(results[0].timedOut, false);
    assert.equal(results[0].gatePath, gatePath, "gate must land under the workspace, not the subject");
    assert.ok(fs.existsSync(gatePath), "gate file actually exists under the workspace");
    assert.ok(!fs.existsSync(path.join(subject, "pipeline")), "no pipeline/ directory was ever created in the subject");

    const logPath = results[0].logPath;
    assert.ok(logPath, "a log path was recorded");
    assert.ok(logPath.startsWith(workspace), "log lands under the workspace");
    assert.ok(fs.existsSync(logPath), "log file exists");

    // THE core promise: the subject tree is completely unchanged.
    const after = snapshotTree(subject);
    assert.deepEqual(after.files, before.files, "no file added or removed in the subject");
    assert.equal(after.digest, before.digest, "no file content changed in the subject (incl. .gitignore/AGENTS.md)");

    // Round out the review-only track so verify-chain has a full chain to
    // check — not the plumbing under test here, so hand-write these the way
    // tests/review-only-track.test.js's writeStageGatesFor does.
    writeGate(workspace, "stage-04c", { ...passGateFor("stage-04c"), workstream: "red-team" });
    for (const role of ["backend", "frontend", "platform", "qa"]) {
      writeGate(workspace, `stage-05.${role}`, { ...passGateFor("stage-05"), workstream: role });
    }
    const merged = mergeWorkstreamGates("peer-review", { cwd: workspace, track: "review-only" });
    assert.equal(merged.merged, true, `peer-review merge failed: ${merged.reason}`);

    const gatesDir = path.join(workspace, "pipeline", "gates");
    const stampResult = stampAll(gatesDir, "review-only", { secret: null });
    assert.equal(stampResult.failed.length, 0, `stampAll had failures: ${JSON.stringify(stampResult.failed)}`);

    const verify = verifyChain(gatesDir, "review-only");
    assert.equal(verify.ok, true, `verifyChain failed: ${JSON.stringify(verify)}`);

    const cli = runCLI(["verify-chain", "--cwd", workspace, "--track", "review-only", "--json"]);
    assert.equal(cli.status, 0, `devteam verify-chain --cwd <workspace> must pass: ${cli.stdout}${cli.stderr}`);
    const cliResult = JSON.parse(cli.stdout);
    assert.equal(cliResult.ok, true);

    // One more time: the whole review-only track's dispatch/merge/verify-chain
    // sequence above never touched the subject either.
    const finalSnapshot = snapshotTree(subject);
    assert.equal(finalSnapshot.digest, before.digest, "subject still unchanged after the full track completes");
  });
});
