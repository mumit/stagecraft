// Review workspace (phase-36 item 36.3, plans/phase-36-external-review-mode.md
// §36.3) — where an external review's state (gates, artifacts, logs, and the
// host adapter's own role/skill dirs) lives when the subject being reviewed
// must stay untouched. Mirrors core/memory/index.js's ~/.stagecraft/<name>/
// precedent (STAGECRAFT_ORG_MEMORY_DIR) with its own env override for test
// isolation.
//
// The split this workspace exists for is ctx.cwd (stateRoot, this workspace)
// vs. ctx.processCwd (codeRoot, the subject) — see hosts/acp/adapter.js and
// core/orchestrator.js's runStage(). Callers wire those two ctx fields; this
// module only creates the workspace directory tree and records what is being
// reviewed.

const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const crypto = require("node:crypto");
const { spawnSync } = require("node:child_process");
const yaml = require("js-yaml");
const { loadAdapter } = require("./router");

const SHA1_PATTERN = /^[0-9a-f]{40}$/;

// Overridable for testing and for users who want workspaces on a different
// disk/mount — same precedent as STAGECRAFT_ORG_MEMORY_DIR
// (core/memory/index.js, docs/reference/environment-variables.md).
function reviewsRoot() {
  return process.env.STAGECRAFT_REVIEWS_DIR || path.join(os.homedir(), ".stagecraft", "reviews");
}

// Same slugify as core/config.js's changeIdFromFeature, reused verbatim for
// the basename component.
function slugify(text) {
  return String(text || "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 64);
}

// Short, stable hash of the subject's absolute path — collision-safe (two
// checkouts of a repo with the same basename get different slugs) and stable
// across runs (the same absolute path always resolves to the same workspace).
function shortHash(absPath) {
  return crypto.createHash("sha1").update(absPath).digest("hex").slice(0, 8);
}

function slugForSubject(subjectPath) {
  const abs = path.resolve(subjectPath);
  const base = slugify(path.basename(abs)) || "subject";
  return `${base}-${shortHash(abs)}`;
}

// `--workspace <path>` overrides the derived ~/.stagecraft/reviews/<slug>/
// path outright.
function resolveWorkspacePath(subjectPath, workspaceOverride) {
  if (workspaceOverride) return path.resolve(workspaceOverride);
  return path.join(reviewsRoot(), slugForSubject(subjectPath));
}

// Phase-36 item 36.5: a bare PR review has no filesystem path to slug —
// `slugForSubject`'s `path.resolve()` would silently resolve a non-path
// string against cwd, making the slug (and therefore the workspace) vary by
// invocation directory instead of by PR. `identity` should be something
// stable and PR-specific (the PR's URL, or a `pr:<number>` fallback) — hashed
// directly, no path resolution.
function slugForIdentity(identity) {
  const text = String(identity || "");
  const base = slugify(text) || "subject";
  return `${base}-${shortHash(text)}`;
}

function resolveWorkspacePathForIdentity(identity, workspaceOverride) {
  if (workspaceOverride) return path.resolve(workspaceOverride);
  return path.join(reviewsRoot(), slugForIdentity(identity));
}

function runGit(cwd, args) {
  const result = spawnSync("git", args, { cwd, encoding: "utf8" });
  if (result.status !== 0 || result.error) return null;
  const out = (result.stdout || "").trim();
  return out || null;
}

function subjectCommitSha(subjectPath) {
  const sha = runGit(subjectPath, ["rev-parse", "HEAD"]);
  return sha && SHA1_PATTERN.test(sha) ? sha : null;
}

function subjectRemote(subjectPath) {
  return runGit(subjectPath, ["remote", "get-url", "origin"]);
}

function subjectManifestPath(workspacePath) {
  return path.join(workspacePath, "subject.json");
}

// Records what was reviewed — the commit SHA, not what the run produced.
// Review mode denies every write into codeRoot (hosts/acp/permissions.js), so
// there is never a "produced commit" in the subject the way core/evidence/
// attestation.js's resolveSubjectCommits() expects; this file is what a
// future attestation pass should read instead when ctx.externalReviewMode is
// set (not wired in this item — see plan §36.3's why-comment).
//
// Phase-36 item 36.5: `subjectPath` may be `null` — a PR review with no
// checkout has no subject directory on disk at all (the diff IS the
// subject). `opts.remote`/`opts.commitSha` are required in that case since
// there is nothing to `git remote`/`git rev-parse` against; `opts.pr` records
// the PR identity (number/url/title) that stands in for a filesystem path.
function writeSubjectManifest(workspacePath, subjectPath, opts = {}) {
  const abs = subjectPath !== null && subjectPath !== undefined ? path.resolve(subjectPath) : null;
  const manifest = {
    schema_version: "1.0",
    subject_path: abs,
    remote: opts.remote !== undefined ? opts.remote : (abs ? subjectRemote(abs) : null),
    commit_sha: opts.commitSha !== undefined ? opts.commitSha : (abs ? subjectCommitSha(abs) : null),
    ...(opts.pr ? { pr: opts.pr } : {}),
    recorded_at: new Date().toISOString(),
  };
  fs.mkdirSync(workspacePath, { recursive: true });
  fs.writeFileSync(subjectManifestPath(workspacePath), JSON.stringify(manifest, null, 2) + "\n", "utf8");
  return manifest;
}

function readSubjectManifest(workspacePath) {
  return JSON.parse(fs.readFileSync(subjectManifestPath(workspacePath), "utf8"));
}

// Phase-36 item 36.4 (plans/phase-36-external-review-mode.md §36.4) —
// `devteam review --list` needs "last run date, last status" per workspace.
// Recorded here (not in subject.json, which is write-once-per-review-target
// metadata about what's being reviewed, not about run outcomes) so a
// workspace with zero runs yet still has a valid subject.json but no
// last-run.json — exactly the "empty case" --list must render.
function lastRunManifestPath(workspacePath) {
  return path.join(workspacePath, "last-run.json");
}

function writeLastRun(workspacePath, info = {}) {
  const manifest = {
    schema_version: "1.0",
    started_at: info.startedAt || null,
    completed_at: info.completedAt || new Date().toISOString(),
    status: info.status || "unknown", // "completed" | "halted" | "error"
    halt_action: info.haltAction !== undefined ? info.haltAction : null,
    track: info.track || null,
    findings_report: info.findingsReport || null,
  };
  fs.mkdirSync(workspacePath, { recursive: true });
  fs.writeFileSync(lastRunManifestPath(workspacePath), JSON.stringify(manifest, null, 2) + "\n", "utf8");
  return manifest;
}

function readLastRun(workspacePath) {
  try {
    return JSON.parse(fs.readFileSync(lastRunManifestPath(workspacePath), "utf8"));
  } catch {
    return null; // no runs yet — a valid state, not an error
  }
}

// Enumerates every workspace under reviewsRoot(), newest-run-first (never-run
// workspaces sort last). Each entry pairs subject.json (what's being
// reviewed) with last-run.json (what happened last time), tolerating either
// being absent — a workspace directory can exist from createReviewWorkspace()
// before any run has completed.
function listWorkspaces() {
  const root = reviewsRoot();
  if (!fs.existsSync(root)) return [];
  return fs.readdirSync(root, { withFileTypes: true })
    .filter((e) => e.isDirectory())
    .map((e) => {
      const workspacePath = path.join(root, e.name);
      let subject = null;
      try { subject = readSubjectManifest(workspacePath); } catch { subject = null; }
      const lastRun = readLastRun(workspacePath);
      return {
        slug: e.name,
        workspace_path: workspacePath,
        subject_path: subject ? subject.subject_path : null,
        commit_sha: subject ? subject.commit_sha : null,
        last_run_at: lastRun ? lastRun.completed_at : null,
        last_status: lastRun ? lastRun.status : null,
      };
    })
    .sort((a, b) => (b.last_run_at || "").localeCompare(a.last_run_at || ""));
}

// Skeleton mirrors the parts of `devteam init` (core/cli/commands/init.js) a
// review needs: pipeline/gates/ (state), a minimal config.yml pinning routing
// to the review host and track, and the host adapter's own install() for role
// prompts/rules/templates/skills (ACP's .acp/stagecraft/{roles,skills} per
// hosts/acp/capabilities.json). .devteam/patterns, corpus, and evals are
// deliberately NOT pre-created here — every consumer (core/patterns.js,
// core/corpus.js, core/evals/*) already mkdirSync(..., {recursive:true}) on
// first write, same as a freshly-init'd project would behave; pre-creating
// empty dirs here would just be dead weight nothing reads.
// Phase-36 item 36.5: `opts.subjectPath` must be present as a key but may be
// explicitly `null` — a PR review with no checkout has no subject directory
// at all. Pass `opts.remote`/`opts.commitSha`/`opts.pr` in that case so
// writeSubjectManifest() has something to record instead of shelling `git`
// against a path that doesn't exist.
function createReviewWorkspace(opts) {
  const { workspacePath, host = "acp", track = "review-only", force = false, remote, commitSha, pr } = opts;
  if (opts.subjectPath === undefined) {
    throw new Error("createReviewWorkspace: subjectPath is required (pass null when there is no local checkout)");
  }
  const subjectPath = opts.subjectPath;
  if (!workspacePath) throw new Error("createReviewWorkspace: workspacePath is required");

  fs.mkdirSync(workspacePath, { recursive: true });
  fs.mkdirSync(path.join(workspacePath, "pipeline", "gates"), { recursive: true });

  const cfgPath = path.join(workspacePath, ".devteam", "config.yml");
  if (!fs.existsSync(cfgPath) || force) {
    fs.mkdirSync(path.dirname(cfgPath), { recursive: true });
    fs.writeFileSync(cfgPath, yaml.dump({
      routing: { default_host: host },
      pipeline: { default_track: track },
    }), "utf8");
  }

  const adapter = loadAdapter(host);
  const install = adapter.install(workspacePath, { force });

  const subject = writeSubjectManifest(workspacePath, subjectPath, { remote, commitSha, pr });

  return { workspacePath, install, subject };
}

module.exports = {
  reviewsRoot,
  slugForSubject,
  resolveWorkspacePath,
  slugForIdentity,
  resolveWorkspacePathForIdentity,
  createReviewWorkspace,
  writeSubjectManifest,
  readSubjectManifest,
  subjectManifestPath,
  writeLastRun,
  readLastRun,
  lastRunManifestPath,
  listWorkspaces,
};
