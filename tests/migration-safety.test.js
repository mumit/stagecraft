// B5 — Migration safety stage-04d structural + heuristic tests.

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const os = require("node:os");
const { execFileSync, spawnSync } = require("node:child_process");
const { makeTargetProject, cleanup, runCLI } = require("./_helpers");
const {
  needsMigrationSafety,
  matchContent,
  DDL_PATTERNS,
} = require("../core/guards/migration-heuristic");

const REPO_ROOT = path.resolve(__dirname, "..");

let _dirs = [];
function track(cwd) { _dirs.push(cwd); return cwd; }
test.afterEach?.(() => { _dirs.forEach(cleanup); _dirs = []; });

// -- Heuristic ---------------------------------------------------------------

test("migration heuristic fires on migrations/ directory paths", () => {
  const matches = needsMigrationSafety([
    "src/backend/auth.ts",
    "db/migrations/0042_add_column.sql",
    "src/migrations/202605290000_init.ts",
  ]);
  assert.deepEqual(matches, [
    "db/migrations/0042_add_column.sql",
    "src/migrations/202605290000_init.ts",
  ]);
});

test("migration heuristic fires on schema definition files", () => {
  const matches = needsMigrationSafety([
    "src/backend/app.js",
    "prisma/schema.prisma",
    "db/schema.sql",
    "schema.rb",
  ]);
  assert.equal(matches.length, 3);
  assert.ok(matches.includes("prisma/schema.prisma"));
  assert.ok(matches.includes("db/schema.sql"));
  assert.ok(matches.includes("schema.rb"));
});

test("migration heuristic fires on bare .sql files", () => {
  const matches = needsMigrationSafety(["scripts/seed.sql", "src/app.ts"]);
  assert.deepEqual(matches, ["scripts/seed.sql"]);
});

test("migration heuristic fires on Prisma + Alembic + Knex conventions", () => {
  const matches = needsMigrationSafety([
    "prisma/migrations/20260101000000_init/migration.sql",
    "alembic.ini",
    "knexfile.ts",
  ]);
  assert.equal(matches.length, 3);
});

test("migration heuristic does NOT fire on plain backend code without DB hints", () => {
  const matches = needsMigrationSafety([
    "src/backend/users.ts",
    "src/frontend/app.tsx",
    "docs/README.md",
  ]);
  assert.deepEqual(matches, []);
});

test("matchContent: scans non-path-matching files for DDL fragments", () => {
  const ddlInTs = "// some code\nexport const sql = `ALTER TABLE users ADD COLUMN x INT`;";
  const cleanTs = "export const foo = 42;";
  const results = matchContent(["a.ts", "b.ts"], (p) => p === "a.ts" ? ddlInTs : cleanTs);
  assert.deepEqual(results, ["a.ts"]);
});

test("matchContent: ignores files that throw on read (e.g. deleted)", () => {
  const results = matchContent(["missing.ts"], () => { throw new Error("ENOENT"); });
  assert.deepEqual(results, []);
});

test("migration CLI ignores historical DDL when only safe lines changed", () => {
  const cwd = track(fs.mkdtempSync(path.join(os.tmpdir(), "devteam-migration-diff-")));
  execFileSync("git", ["init", "-q"], { cwd });
  execFileSync("git", ["config", "user.email", "stagecraft@example.invalid"], { cwd });
  execFileSync("git", ["config", "user.name", "Stagecraft Test"], { cwd });
  fs.writeFileSync(path.join(cwd, "notes.md"), "Historical example: ALTER TABLE users ADD COLUMN x INT.\n");
  execFileSync("git", ["add", "notes.md"], { cwd });
  execFileSync("git", ["commit", "-qm", "baseline"], { cwd });
  fs.appendFileSync(path.join(cwd, "notes.md"), "Unrelated clarification.\n");

  const result = spawnSync(process.execPath, [path.join(REPO_ROOT, "core", "guards", "migration-heuristic.js"), "notes.md"], {
    cwd,
    encoding: "utf8",
  });
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /MIGRATION_SAFETY: skip/);
});

test("DDL_PATTERNS catches the common dangerous DDL keywords", () => {
  for (const stmt of [
    "ALTER TABLE x ADD COLUMN y",
    "CREATE TABLE x (id INT)",
    "DROP TABLE x",
    "ADD COLUMN y",
    "DROP COLUMN y",
    "RENAME COLUMN x TO y",
    "CREATE UNIQUE INDEX idx_x",
    "DROP INDEX idx_x",
  ]) {
    assert.ok(
      DDL_PATTERNS.some((p) => p.test(stmt)),
      `no pattern matched: ${stmt}`,
    );
  }
});

// -- Stage definition --------------------------------------------------------

test("core/pipeline/stages.js has a migration-safety stage at stage-04d", () => {
  const { STAGES, getStage } = require(path.join(REPO_ROOT, "core", "pipeline", "stages"));
  assert.ok(STAGES["migration-safety"], "STAGES has no migration-safety entry");
  const s = getStage("migration-safety");
  assert.equal(s.stage, "stage-04d");
  assert.deepEqual(s.roles, ["migrations"]);
  assert.equal(s.artifact, "pipeline/migration-safety.md");
  assert.equal(s.template, "migration-safety-template.md");
  // Conditional dispatch — reads stage-04a's migration_safety_required flag.
  assert.ok(s.conditionalOn);
  assert.equal(s.conditionalOn.stage, "stage-04a");
  assert.equal(s.conditionalOn.field, "migration_safety_required");
  assert.equal(s.conditionalOn.equals, true);
  // Gate skeleton has all the required B5 fields.
  for (const f of [
    "migration_files",
    "schema_changes_summary",
    "breaking_change",
    "backfill_required",
    "rollback_plan",
    "rollback_tested",
    "migration_approved",
    "veto",
  ]) {
    assert.ok(f in s.gate, `gate skeleton missing "${f}"`);
  }
});

test("migration-safety sits between red-team and peer-review in ORDERED_STAGE_NAMES", () => {
  const { ORDERED_STAGE_NAMES } = require(path.join(REPO_ROOT, "core", "pipeline", "stages"));
  const rt = ORDERED_STAGE_NAMES.indexOf("red-team");
  const ms = ORDERED_STAGE_NAMES.indexOf("migration-safety");
  const pr = ORDERED_STAGE_NAMES.indexOf("peer-review");
  assert.ok(rt >= 0 && ms >= 0 && pr >= 0);
  assert.ok(rt < ms && ms < pr, `expected red-team(${rt}) < migration-safety(${ms}) < peer-review(${pr})`);
});

test("migration-safety is included in full + hotfix + config-only tracks; absent from quick/nano/dep-update", () => {
  const { orderedStageNamesForTrack } = require(path.join(REPO_ROOT, "core", "pipeline", "stages"));
  for (const t of ["full", "hotfix", "config-only"]) {
    assert.ok(orderedStageNamesForTrack(t).includes("migration-safety"), `${t} should include migration-safety`);
  }
  for (const t of ["quick", "nano", "dep-update"]) {
    assert.ok(!orderedStageNamesForTrack(t).includes("migration-safety"), `${t} should NOT include migration-safety`);
  }
});

// -- Schema ------------------------------------------------------------------

test("core/gates/schemas/stage-04d.schema.json declares B5 required fields", () => {
  const p = path.join(REPO_ROOT, "core", "gates", "schemas", "stage-04d.schema.json");
  assert.ok(fs.existsSync(p));
  const s = JSON.parse(fs.readFileSync(p, "utf8"));
  assert.equal(s.$id, "urn:stagecraft:schema:stage-04d");
  for (const f of [
    "migration_files",
    "schema_changes_summary",
    "breaking_change",
    "backfill_required",
    "rollback_plan",
    "rollback_tested",
    "migration_approved",
    "veto",
    "triggering_conditions",
  ]) {
    assert.ok(s.required.includes(f), `stage-04d schema must require "${f}"`);
  }
  // rollback_plan must be non-empty by schema constraint.
  assert.ok(s.properties.rollback_plan.minLength >= 1);
});

test("core/gates/schemas/stage-04a.schema.json adds migration_safety_required as optional", () => {
  const p = path.join(REPO_ROOT, "core", "gates", "schemas", "stage-04a.schema.json");
  const s = JSON.parse(fs.readFileSync(p, "utf8"));
  assert.ok(s.properties.migration_safety_required, "stage-04a must declare migration_safety_required");
  assert.equal(s.properties.migration_safety_required.type, "boolean");
  // It's optional — must NOT be in required[].
  assert.ok(!s.required.includes("migration_safety_required"));
});

// -- Role + skill + template -------------------------------------------------

test("roles/migrations.md exists and declares veto power + read-only", () => {
  const p = path.join(REPO_ROOT, "roles", "migrations.md");
  assert.ok(fs.existsSync(p));
  const text = fs.readFileSync(p, "utf8");
  assert.match(text, /Migration Safety Role Brief/i);
  assert.match(text, /veto power/i);
  // The auto-veto criteria.
  assert.match(text, /tested rollback/i);
  assert.match(text, /backfill/i);
});

test("skills/migration-safety/SKILL.md exists with YAML frontmatter + the six questions", () => {
  const p = path.join(REPO_ROOT, "skills", "migration-safety", "SKILL.md");
  assert.ok(fs.existsSync(p));
  const text = fs.readFileSync(p, "utf8");
  assert.match(text.slice(0, 5), /^---/);
  assert.match(text, /^name: migration-safety$/m);
  // Walk-the-six-questions structure.
  for (const heading of [
    "Q1 — What does this migration",
    "Q2 — Is it a breaking change",
    "Q3 — Does it require a backfill",
    "Q4 — Does it require dual-write",
    "Q5 — Rollback plan",   // template heading (Q5 — Rollback plan in skill is Q5 — What's the rollback plan)
    "Q6 — Was the rollback tested",
  ]) {
    // Match loosely — both skill and template use slightly different
    // headings for Q5.
    const ok = new RegExp(heading.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")).test(text)
            || (heading.startsWith("Q5") && /Q5 — What's the rollback plan/.test(text));
    assert.ok(ok, `skill missing heading like "${heading}"`);
  }
});

test("templates/migration-safety-template.md exists with the expected sections", () => {
  const p = path.join(REPO_ROOT, "templates", "migration-safety-template.md");
  assert.ok(fs.existsSync(p));
  const text = fs.readFileSync(p, "utf8");
  for (const heading of [
    "## Summary",
    "## Migration files",
    "## Per-migration analysis",
    "## Coordination requirements",
    "## Blockers",
    "## Warnings",
    "## Approval line",
  ]) {
    assert.match(text, new RegExp(heading.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
  }
});

// -- Adapter integration -----------------------------------------------------

test("claude-code adapter has a ROLE_FRONTMATTER entry for 'migrations'", () => {
  const text = fs.readFileSync(path.join(REPO_ROOT, "hosts", "claude-code", "adapter.js"), "utf8");
  // Bare-identifier form (migrations:) is valid JS for an identifier key.
  assert.match(text, /\bmigrations:\s*\{/);
  assert.match(text, /VETO power/);
});

test("`devteam init --host claude-code` installs the migrations role brief + subagent", () => {
  const cwd = track(makeTargetProject());
  const r = runCLI(["init", "--host", "claude-code"], { cwd });
  assert.equal(r.status, 0);
  assert.ok(fs.existsSync(path.join(cwd, ".claude/agents/migrations.md")));
  assert.ok(fs.existsSync(path.join(cwd, ".claude/skills/migration-safety/SKILL.md")));
});

test("`devteam init --host codex` installs the role brief + skill", () => {
  const cwd = track(makeTargetProject());
  const r = runCLI(["init", "--host", "codex"], { cwd });
  assert.equal(r.status, 0);
  assert.ok(fs.existsSync(path.join(cwd, ".codex/prompts/roles/migrations.md")));
  assert.ok(fs.existsSync(path.join(cwd, ".codex/skills/migration-safety/SKILL.md")));
});

test("`devteam stage migration-safety` renders a prompt referencing the role + artifact", () => {
  const cwd = track(makeTargetProject());
  runCLI(["init", "--host", "claude-code"], { cwd });
  const r = runCLI(["stage", "migration-safety", "--feature", "test"], { cwd });
  assert.equal(r.status, 0);
  assert.match(r.stdout, /workstream: migrations/);
  assert.match(r.stdout, /migration-safety\.md/);
  assert.match(r.stdout, /migration-safety-template\.md/);
});
