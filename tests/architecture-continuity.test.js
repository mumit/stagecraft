// G8 — architecture continuity structural tests.
//
// Locks that:
//   - Principal role brief instructs querying org memory before design.
//   - ADR template carries a Supersedes field.
//   - design stage's gate has adrs_consulted + adrs_superseded fields.
//   - stage-02 schema declares those fields as optional.
//   - stage-02 carries a machine-readable file_ownership map for Stage 4 routing.
//   - devteam architecture lookup runs against the org store.

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { makeTargetProject, cleanup, runCLI } = require("./_helpers");

const REPO_ROOT = path.resolve(__dirname, "..");

let _dirs = [];
function track(cwd) { _dirs.push(cwd); return cwd; }
test.afterEach?.(() => { _dirs.forEach(cleanup); _dirs = []; });

test("roles/principal.md instructs querying org memory before drafting", () => {
  const text = fs.readFileSync(path.join(REPO_ROOT, "roles", "principal.md"), "utf8");
  assert.match(text, /architectural continuity/i);
  assert.match(text, /memory query --org --kind adr/);
  assert.match(text, /devteam architecture lookup/);
  // Must mention the supersedes obligation explicitly.
  assert.match(text, /Supersedes:/);
  assert.match(text, /Silent disagreement with a prior ADR is forbidden/);
});

test("templates/adr-template.md carries Supersedes + Prior commitments sections", () => {
  const text = fs.readFileSync(path.join(REPO_ROOT, "templates", "adr-template.md"), "utf8");
  assert.match(text, /\*\*Supersedes\*\*:/);
  assert.match(text, /## Prior commitments considered/);
  assert.match(text, /memory query --org --kind adr/);
});

test("design stage's gate skeleton includes adrs_consulted + adrs_superseded", () => {
  const { getStage } = require(path.join(REPO_ROOT, "core", "pipeline", "stages"));
  const design = getStage("design");
  assert.ok(Array.isArray(design.gate.adrs_consulted), "design gate should declare adrs_consulted: []");
  assert.ok(Array.isArray(design.gate.adrs_superseded), "design gate should declare adrs_superseded: []");
  assert.deepEqual(design.gate.file_ownership, {}, "design gate should declare file_ownership: {}");
});

test("stage-02 schema declares adrs_consulted, adrs_superseded, and file_ownership as optional properties", () => {
  const schema = JSON.parse(fs.readFileSync(path.join(REPO_ROOT, "core", "gates", "schemas", "stage-02.schema.json"), "utf8"));
  assert.ok(schema.properties.adrs_consulted, "stage-02 schema must declare adrs_consulted");
  assert.ok(schema.properties.adrs_superseded, "stage-02 schema must declare adrs_superseded");
  assert.ok(schema.properties.file_ownership, "stage-02 schema must declare file_ownership");
  assert.deepEqual(schema.properties.file_ownership.additionalProperties.enum, ["backend", "frontend", "platform", "qa", "documentation"]);
  // Optional — not in required[].
  assert.ok(!schema.required.includes("adrs_consulted"));
  assert.ok(!schema.required.includes("adrs_superseded"));
  assert.ok(!schema.required.includes("file_ownership"));
});

test("`devteam architecture lookup` shows usage when no topic is given", () => {
  const cwd = track(makeTargetProject());
  const r = runCLI(["architecture", "lookup"], { cwd });
  assert.notEqual(r.status, 0);
  assert.match(r.stderr, /Usage: devteam architecture lookup/);
});

test("`devteam architecture lookup <topic>` runs against an empty org store and reports cleanly", () => {
  const cwd = track(makeTargetProject());
  const orgDir = fs.mkdtempSync(path.join(os.tmpdir(), "stagecraft-org-arch-test-"));
  _dirs.push(orgDir);
  // Stub embedder + isolated org dir so we don't touch ~/.stagecraft/.
  const r = runCLI(["architecture", "lookup", "pagination", "--limit", "3"], {
    cwd,
    env: {
      ...process.env,
      DEVTEAM_EMBEDDING_PROVIDER: "stub",
      STAGECRAFT_ORG_MEMORY_DIR: orgDir,
    },
  });
  assert.equal(r.status, 0);
  assert.match(r.stdout, /no prior adr entries match/i);
  assert.match(r.stdout, /Prior commitments considered/);
});

test("`devteam architecture lookup` with --kind lessons-learned works too", () => {
  const cwd = track(makeTargetProject());
  const orgDir = fs.mkdtempSync(path.join(os.tmpdir(), "stagecraft-org-arch-test-"));
  _dirs.push(orgDir);
  const r = runCLI(["architecture", "lookup", "retries", "--kind", "lessons-learned"], {
    cwd,
    env: {
      ...process.env,
      DEVTEAM_EMBEDDING_PROVIDER: "stub",
      STAGECRAFT_ORG_MEMORY_DIR: orgDir,
    },
  });
  assert.equal(r.status, 0);
  assert.match(r.stdout, /no prior lessons-learned entries match/i);
});

test("memory promote + architecture lookup round-trip surfaces a project's ADR cross-project", () => {
  // The strategic claim of G8 in one test: a project's ADR, once
  // promoted, becomes visible to architecture lookup from any cwd.
  const projectA = track(makeTargetProject({ gates: false }));
  const projectB = track(makeTargetProject());
  fs.mkdirSync(path.join(projectA, "pipeline", "adr"), { recursive: true });
  fs.writeFileSync(
    path.join(projectA, "pipeline", "adr", "001-pagination.md"),
    "# ADR 001 — Pagination style\n\n## Context\n\nWe need to decide between offset and cursor pagination across all new list endpoints.\n\n## Decision\n\nCursor-based across all new APIs. Cursors are opaque base64-encoded tokens; clients treat them as opaque.\n",
  );
  const orgDir = fs.mkdtempSync(path.join(os.tmpdir(), "stagecraft-org-arch-test-"));
  _dirs.push(orgDir);
  const env = {
    ...process.env,
    DEVTEAM_EMBEDDING_PROVIDER: "stub",
    STAGECRAFT_ORG_MEMORY_DIR: orgDir,
  };

  // Ingest project A's ADR.
  const ing = runCLI(["memory", "ingest"], { cwd: projectA, env });
  assert.equal(ing.status, 0, `ingest failed: ${ing.stderr}`);

  // Promote to org.
  const prom = runCLI(["memory", "promote", "adr"], { cwd: projectA, env });
  assert.equal(prom.status, 0, `promote failed: ${prom.stderr}`);

  // Architecture lookup from project B finds it.
  const look = runCLI(["architecture", "lookup", "pagination cursor"], { cwd: projectB, env });
  assert.equal(look.status, 0, `lookup failed: ${look.stderr}`);
  assert.match(look.stdout, /Pagination style/);
  assert.match(look.stdout, new RegExp(projectA.replace(/[.\\/]/g, "\\$&"))); // project A's path in the source attribution
});
