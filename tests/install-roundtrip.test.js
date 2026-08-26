const { describe, it, afterEach } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { REPO_ROOT, makeTargetProject, cleanup } = require("./_helpers");
const { listHosts, loadAdapter } = require(path.join(REPO_ROOT, "core", "router"));
const { withSkillsDir } = require(path.join(REPO_ROOT, "core", "roles"));

let _dirs = [];
function track(cwd) { _dirs.push(cwd); return cwd; }
afterEach(() => { _dirs.forEach(cleanup); _dirs = []; });

describe("install round-trip per adapter", () => {
  for (const host of listHosts()) {
    describe(`host: ${host}`, () => {
      it("install lays down files (or no-ops cleanly)", () => {
        const cwd = track(makeTargetProject());
        const adapter = loadAdapter(host);
        const r = adapter.install(cwd);
        assert.ok(Array.isArray(r.written));
        assert.ok(Array.isArray(r.skipped));
        // generic install is a noop (returns empty written) but the call must succeed
        if (host !== "generic") {
          assert.ok(r.written.length > 0, `${host} install wrote nothing`);
        }
      });

      it("install is idempotent (second call skips)", () => {
        const cwd = track(makeTargetProject());
        const adapter = loadAdapter(host);
        const r1 = adapter.install(cwd);
        const r2 = adapter.install(cwd);
        if (host === "generic") {
          // both calls return empty; nothing to assert about skip
          assert.equal(r2.written.length, 0);
        } else {
          assert.equal(r2.written.length, 0, "second install should write nothing");
          assert.equal(r2.skipped.length, r1.written.length, "second install should skip everything from the first");
        }
      });

      it("force overrides idempotency", () => {
        const cwd = track(makeTargetProject());
        const adapter = loadAdapter(host);
        const r1 = adapter.install(cwd);
        const r2 = adapter.install(cwd, { force: true });
        if (host === "generic") return; // nothing to force
        assert.equal(r2.written.length, r1.written.length, "force should overwrite everything");
      });

      it("status after install reports ok", () => {
        const cwd = track(makeTargetProject());
        const adapter = loadAdapter(host);
        adapter.install(cwd);
        const s = adapter.status(cwd);
        assert.equal(s.ok, true, `${host} status not ok: missing=${s.missing.join(", ")}`);
      });

      it("markdown hosts install artifact templates under .devteam/templates", () => {
        const cwd = track(makeTargetProject());
        const adapter = loadAdapter(host);
        if (adapter.capabilities.skillFormat !== "markdown") return;

        adapter.install(cwd);
        const templatePath = path.join(cwd, ".devteam", "templates", "brief-template.md");
        assert.ok(fs.existsSync(templatePath), `${host} did not install brief-template.md`);

        fs.unlinkSync(templatePath);
        const status = adapter.status(cwd);
        assert.equal(status.ok, false, `${host} status should notice missing installed template`);
        assert.ok(
          status.missing.includes(templatePath),
          `${host} status missing list did not include ${templatePath}`,
        );
      });

      // Regression: role briefs (roles/*.md) reference skills via a bare
      // `skills/<name>/SKILL.md` path, but every host installs the actual
      // skill files under its own capabilities.skillsDir (".claude/skills",
      // ".openai-compat/skills", ...) — never bare "skills/" at the project
      // root. A real openai-compat headless run had the qa role's installed
      // brief still pointing at the bare path, so its `read_file` calls for
      // `skills/qa-test-authoring/SKILL.md` and `skills/qa-test-execution/
      // SKILL.md` all hit ENOENT even though the files were correctly
      // installed at `.openai-compat/skills/qa-test-*/SKILL.md`.
      // installRoles() now rewrites the brief text at install time via
      // withSkillsDir() (core/roles.js) — this asserts the installed copy,
      // not just the helper in isolation.
      it("installed qa role brief points at this host's real skillsDir, not the bare `skills/` path", () => {
        const cwd = track(makeTargetProject());
        const adapter = loadAdapter(host);
        if (host === "generic") return; // installs nothing — no brief to check

        adapter.install(cwd);
        // claude-code writes role briefs to agentsDir under a per-role
        // frontmatter filename (qa -> dev-qa.md, see ROLE_FRONTMATTER in
        // hosts/claude-code/adapter.js); every other host writes
        // rolePromptsDir/<role>.md verbatim.
        const briefPath = host === "claude-code"
          ? path.join(cwd, adapter.capabilities.agentsDir, "dev-qa.md")
          : path.join(cwd, adapter.capabilities.rolePromptsDir, "qa.md");
        assert.ok(fs.existsSync(briefPath), `${host} did not install a qa role brief at ${briefPath}`);
        const body = fs.readFileSync(briefPath, "utf8");
        assert.doesNotMatch(
          body,
          /`skills\//,
          `${host} installed qa brief still references the bare 'skills/' path`,
        );
        const escapedSkillsDir = adapter.capabilities.skillsDir.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
        assert.match(
          body,
          new RegExp("`" + escapedSkillsDir + "/qa-test-authoring/SKILL\\.md`"),
          `${host} installed qa brief does not point at ${adapter.capabilities.skillsDir}/qa-test-authoring/SKILL.md`,
        );
      });

      it("uninstall removes the install payload", () => {
        const cwd = track(makeTargetProject());
        const adapter = loadAdapter(host);
        adapter.install(cwd);
        adapter.uninstall(cwd);
        // After uninstall, status should report missing (except for generic which installs nothing)
        const s = adapter.status(cwd);
        if (host === "generic") {
          assert.equal(s.ok, true); // still ok because nothing was supposed to be there
        } else {
          assert.equal(s.ok, false, `${host} status still ok after uninstall`);
          assert.ok(s.missing.length > 0);
        }
      });
    });
  }
});

// Regression: see the "installed qa role brief" test above for the
// end-to-end failure mode. This is the direct unit test of the rewrite
// helper itself (core/roles.js).
describe("core/roles: withSkillsDir", () => {
  it("rewrites a bare `skills/...` reference to the host's skillsDir", () => {
    const body = "Load the skill at `skills/qa-test-authoring/SKILL.md` before starting.";
    const out = withSkillsDir(body, ".openai-compat/skills");
    assert.equal(out, "Load the skill at `.openai-compat/skills/qa-test-authoring/SKILL.md` before starting.");
  });

  it("rewrites every occurrence, not just the first", () => {
    const body = "See `skills/a/SKILL.md` and also `skills/b/SKILL.md`.";
    const out = withSkillsDir(body, ".claude/skills");
    assert.equal(out, "See `.claude/skills/a/SKILL.md` and also `.claude/skills/b/SKILL.md`.");
  });

  it("is a no-op when skillsDir is falsy (e.g. the generic host)", () => {
    const body = "Load the skill at `skills/qa-test-authoring/SKILL.md`.";
    assert.equal(withSkillsDir(body, null), body);
    assert.equal(withSkillsDir(body, undefined), body);
  });

  it("leaves text with no `skills/` references unchanged", () => {
    const body = "Nothing to rewrite here.";
    assert.equal(withSkillsDir(body, ".claude/skills"), body);
  });
});
