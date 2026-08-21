// Warn when a project mints a fresh evidence identity despite already having
// evidence history.
//
// The identity ties a project's bundles together across checkouts, and
// getOrCreateIdentity mints a new one whenever the file is absent — silently.
// A clone, a cleaned .devteam/, or a restore done one command too late exports
// under a different project_ref, and a portfolio counts those bundles as a
// second independent project, inflating every N / 2 readiness threshold.

const { describe, it } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const REPO_ROOT = path.resolve(__dirname, "..");
const { runCLI } = require("./_helpers");
const { priorEvidenceSummary } = require(path.join(REPO_ROOT, "core", "evidence", "readers"));

function project({ corpus = false, gates = false, runLog = false, identity = null } = {}) {
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "devteam-test-minted-"));
  fs.mkdirSync(path.join(cwd, "pipeline", "gates"), { recursive: true });
  fs.mkdirSync(path.join(cwd, ".devteam"), { recursive: true });
  fs.writeFileSync(path.join(cwd, "package.json"), JSON.stringify({ name: "d", version: "1.0.0" }));
  if (corpus) {
    fs.mkdirSync(path.join(cwd, ".devteam", "corpus"), { recursive: true });
    fs.writeFileSync(path.join(cwd, ".devteam", "corpus", "dispatches.jsonl"),
      JSON.stringify({ ts: "2026-08-21T00:00:00Z", run_id: "r1", stage: "stage-04", host: "h" }) + "\n");
  }
  if (gates) {
    fs.writeFileSync(path.join(cwd, "pipeline", "gates", "stage-04.json"),
      JSON.stringify({ stage: "stage-04", status: "PASS" }));
  }
  if (runLog) {
    fs.writeFileSync(path.join(cwd, "pipeline", "run-log.jsonl"),
      JSON.stringify({ outcome: "run-start", intent: "feature" }) + "\n");
  }
  if (identity) {
    fs.writeFileSync(path.join(cwd, ".devteam", "evidence-project-id"), identity + "\n", { mode: 0o600 });
  }
  return { cwd, cleanup: () => fs.rmSync(cwd, { recursive: true, force: true }) };
}

function exportEvidence(cwd) {
  return runCLI(["evidence", "export", "--out", path.join(cwd, "b.json"), "--consent", "--json"], { cwd });
}

describe("priorEvidenceSummary", () => {
  it("reports nothing for a project with no evidence", () => {
    const p = project();
    try {
      assert.deepEqual(priorEvidenceSummary(p.cwd), { dispatches: 0, gates: 0, run_log: false, any: false });
    } finally { p.cleanup(); }
  });

  it("detects each signal independently", () => {
    for (const [key, opts] of [["dispatches", { corpus: true }], ["gates", { gates: true }], ["run_log", { runLog: true }]]) {
      const p = project(opts);
      try {
        const s = priorEvidenceSummary(p.cwd);
        assert.equal(s.any, true, `${key} should count as prior evidence`);
      } finally { p.cleanup(); }
    }
  });

  it("does not treat an empty run log as history", () => {
    const p = project();
    try {
      fs.writeFileSync(path.join(p.cwd, "pipeline", "run-log.jsonl"), "\n");
      assert.equal(priorEvidenceSummary(p.cwd).run_log, false);
    } finally { p.cleanup(); }
  });

  it("returns a safe shape for a missing cwd", () => {
    assert.equal(priorEvidenceSummary(null).any, false);
  });
});

describe("evidence export: minted-identity warning", () => {
  it("warns when a project with history mints a fresh identity", () => {
    const p = project({ corpus: true, gates: true, runLog: true });
    try {
      const r = exportEvidence(p.cwd);
      assert.equal(r.status, 0, "the warning must not block the export");
      assert.match(r.stderr, /minted a new evidence identity/);
      assert.match(r.stderr, /1 dispatch record\(s\)/);
      assert.match(r.stderr, /evidence-project-id/);
    } finally { p.cleanup(); }
  });

  it("stays silent for a genuinely new project", () => {
    // Minting is correct here and by far the common case; warning on minting
    // alone would train operators to ignore it.
    const p = project();
    try {
      const r = exportEvidence(p.cwd);
      assert.equal(r.status, 0);
      assert.doesNotMatch(r.stderr, /minted a new evidence identity/);
    } finally { p.cleanup(); }
  });

  it("stays silent when the identity was restored before exporting", () => {
    const p = project({ corpus: true, gates: true, identity: "a".repeat(32) });
    try {
      const r = exportEvidence(p.cwd);
      assert.equal(r.status, 0);
      assert.doesNotMatch(r.stderr, /minted a new evidence identity/);
    } finally { p.cleanup(); }
  });

  it("keeps --json stdout parseable, with the warning on stderr", () => {
    const p = project({ corpus: true });
    try {
      const r = exportEvidence(p.cwd);
      assert.match(r.stderr, /minted a new evidence identity/);
      const parsed = JSON.parse(r.stdout);
      assert.match(parsed.project_ref, /^sha256:[0-9a-f]{64}$/);
    } finally { p.cleanup(); }
  });
});
