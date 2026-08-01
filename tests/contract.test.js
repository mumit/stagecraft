// Cross-artifact consistency tests. Pure file-read assertions — no
// execution, no temp dirs needed. Catches the broadest class of bugs
// (drift between stages.js, schemas, role briefs, rules, adapters).

const { describe, it } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { REPO_ROOT } = require("./_helpers");

const { STAGES, TRACKS, STAGES_BY_TRACK, ORDERED_STAGE_NAMES, stageNames } =
  require(path.join(REPO_ROOT, "core", "pipeline", "stages"));

function read(rel) {
  return fs.readFileSync(path.join(REPO_ROOT, rel), "utf8");
}
function readJSON(rel) {
  return JSON.parse(read(rel));
}
function listDir(rel) {
  return fs.readdirSync(path.join(REPO_ROOT, rel));
}
function listBuiltInHostAdapters() {
  return listDir("hosts").filter((h) =>
    fs.existsSync(path.join(REPO_ROOT, "hosts", h, "adapter.js"))
  );
}

describe("contract: package + version", () => {
  it("package.json parses and has a version", () => {
    const pkg = readJSON("package.json");
    assert.ok(pkg.version, "package.json missing version");
    assert.ok(pkg.bin && pkg.bin.devteam, "package.json missing devteam bin entry");
  });

  it("bin/devteam exists and is executable", () => {
    const stat = fs.statSync(path.join(REPO_ROOT, "bin", "devteam"));
    assert.ok(stat.mode & 0o111, "bin/devteam is not executable");
  });
});

describe("contract: stages ↔ schemas", () => {
  it("every stage in STAGES has a matching schema file", () => {
    for (const [name, def] of Object.entries(STAGES)) {
      if (!def) continue;
      const schemaPath = path.join("core", "gates", "schemas", `${def.stage}.schema.json`);
      assert.ok(
        fs.existsSync(path.join(REPO_ROOT, schemaPath)),
        `stage "${name}" (${def.stage}) has no schema at ${schemaPath}`,
      );
    }
  });

  it("every schema has $id, title, type, required", () => {
    const schemas = listDir("core/gates/schemas").filter((f) => f.endsWith(".schema.json"));
    for (const f of schemas) {
      const s = readJSON(`core/gates/schemas/${f}`);
      assert.ok(s.$id, `${f} missing $id`);
      assert.ok(s.title, `${f} missing title`);
      assert.equal(s.type, "object", `${f} type should be object`);
      assert.ok(Array.isArray(s.required), `${f} missing required[]`);
    }
  });

  it("gate.schema.json carries contract F identity fields", () => {
    const base = readJSON("core/gates/schemas/gate.schema.json");
    for (const f of ["stage", "status", "orchestrator", "track", "timestamp", "blockers", "warnings"]) {
      assert.ok(base.required.includes(f), `gate.schema.json required[] missing ${f}`);
    }
    assert.ok(base.properties.workstream, "gate.schema.json missing workstream property");
    assert.ok(base.properties.host, "gate.schema.json missing host property");
    assert.ok(base.properties.workstreams, "gate.schema.json missing workstreams[] property");
    assert.ok(!base.required.includes("agent"), "gate.schema.json should not require legacy 'agent' field");
  });
});

describe("contract: stages ↔ roles", () => {
  it("every role referenced in STAGES has a brief", () => {
    const seen = new Set();
    for (const def of Object.values(STAGES)) {
      if (!def) continue;
      for (const role of def.roles) seen.add(role);
    }
    for (const role of seen) {
      const briefPath = path.join("roles", `${role}.md`);
      assert.ok(
        fs.existsSync(path.join(REPO_ROOT, briefPath)),
        `role "${role}" has no brief at ${briefPath}`,
      );
    }
  });

  it("every roleWrites key is a valid role for its stage", () => {
    for (const [name, def] of Object.entries(STAGES)) {
      if (!def || !def.roleWrites) continue;
      for (const role of Object.keys(def.roleWrites)) {
        assert.ok(
          def.roles.includes(role),
          `stage "${name}" has roleWrites for "${role}" but it's not in roles[${def.roles.join(", ")}]`,
        );
      }
    }
  });

  it("subagent overrides reference a real role brief", () => {
    for (const [name, def] of Object.entries(STAGES)) {
      if (!def || !def.subagent) continue;
      const briefPath = path.join("roles", `${def.subagent}.md`);
      assert.ok(
        fs.existsSync(path.join(REPO_ROOT, briefPath)),
        `stage "${name}" subagent="${def.subagent}" has no brief at ${briefPath}`,
      );
    }
  });
});

describe("contract: ORDERED_STAGE_NAMES ↔ STAGES_BY_TRACK", () => {
  it("ORDERED_STAGE_NAMES contains every defined stage name (no missing, no extras)", () => {
    // Mechanical stages (roles: []) are auto-run pre-steps, not user-dispatched.
    // They live in STAGES for schema registration but are intentionally absent
    // from ORDERED_STAGE_NAMES and all track lists.
    const mechanicalStages = new Set(
      Object.entries(STAGES)
        .filter(([, def]) => def && Array.isArray(def.roles) && def.roles.length === 0)
        .map(([name]) => name)
    );
    const stageSet = new Set([...stageNames()].filter((n) => !mechanicalStages.has(n)));
    const orderedSet = new Set(ORDERED_STAGE_NAMES);
    assert.deepEqual(orderedSet, stageSet, "ORDERED_STAGE_NAMES is out of sync with STAGES keys (excluding mechanical stages)");
  });

  it("STAGES_BY_TRACK has an entry per track", () => {
    for (const t of TRACKS) {
      assert.ok(Array.isArray(STAGES_BY_TRACK[t]), `track ${t} missing from STAGES_BY_TRACK`);
    }
  });

  it("every stage in every track is a known stage name", () => {
    for (const [track, names] of Object.entries(STAGES_BY_TRACK)) {
      for (const name of names) {
        assert.ok(STAGES[name], `track "${track}" lists unknown stage "${name}"`);
      }
    }
  });
});

describe("contract: adapters ↔ hosts/ directory", () => {
  it("every built-in host adapter has capabilities.json and adapter.js", () => {
    const hosts = listBuiltInHostAdapters();
    for (const h of hosts) {
      const cap = path.join("hosts", h, "capabilities.json");
      const adapter = path.join("hosts", h, "adapter.js");
      assert.ok(fs.existsSync(path.join(REPO_ROOT, cap)), `host "${h}" missing capabilities.json`);
      assert.ok(fs.existsSync(path.join(REPO_ROOT, adapter)), `host "${h}" missing adapter.js`);
    }
  });

  it("every capabilities.json has name and enforces fields", () => {
    for (const h of listBuiltInHostAdapters()) {
      const cap = readJSON(`hosts/${h}/capabilities.json`);
      assert.equal(cap.name, h, `host "${h}" capabilities.json name mismatch (${cap.name})`);
      assert.ok(cap.enforces, `host "${h}" capabilities.json missing enforces`);
    }
  });
});

describe("contract: rules ↔ skills ↔ templates exist", () => {
  it("required rules docs are present", () => {
    const required = ["gates.md", "gates-core.md", "pipeline.md", "escalation.md", "retrospective.md", "orchestrator.md"];
    for (const r of required) {
      assert.ok(fs.existsSync(path.join(REPO_ROOT, "rules", r)), `rules/${r} missing`);
    }
  });

  it("every skill directory has a SKILL.md", () => {
    for (const skill of listDir("skills")) {
      const p = path.join(REPO_ROOT, "skills", skill, "SKILL.md");
      assert.ok(fs.existsSync(p), `skill "${skill}" missing SKILL.md`);
    }
  });

  it("every stage's template exists in templates/", () => {
    for (const def of Object.values(STAGES)) {
      if (!def || !def.template) continue;
      const tpl = path.join(REPO_ROOT, "templates", def.template);
      assert.ok(fs.existsSync(tpl), `template ${def.template} missing in templates/`);
    }
  });

  // 29.1: trackOverrides (e.g. requirements.trackOverrides.loop swapping in
  // the one-screen loop brief) follow the same existence contract as the
  // stage-level template and repairOverride.template.
  it("every stage's trackOverrides template exists in templates/", () => {
    for (const def of Object.values(STAGES)) {
      if (!def || !def.trackOverrides) continue;
      for (const [track, override] of Object.entries(def.trackOverrides)) {
        if (!override.template) continue;
        const tpl = path.join(REPO_ROOT, "templates", override.template);
        assert.ok(fs.existsSync(tpl), `trackOverrides.${track}.template ${override.template} missing in templates/`);
      }
    }
  });

  // G3: production-feedback-template.md is not a stage-level template (it's
  // operator-curated post-deploy) so it's not wired into STAGES; verify it
  // exists as a standalone contract.
  it("production-feedback-template.md exists in templates/ (G3 seam)", () => {
    assert.ok(
      fs.existsSync(path.join(REPO_ROOT, "templates", "production-feedback-template.md")),
      "templates/production-feedback-template.md missing — G3 production feedback seam requires it",
    );
  });
});

describe("contract: gates split — gates-core.md and per-stage gate sections", () => {
  it("every stage readFirst includes gates-core.md (not the old gates.md)", () => {
    for (const [name, def] of Object.entries(STAGES)) {
      if (!def || !Array.isArray(def.readFirst) || def.readFirst.length === 0) continue;
      assert.ok(
        def.readFirst.includes(".devteam/rules/gates-core.md"),
        `stage "${name}" readFirst missing ".devteam/rules/gates-core.md"`,
      );
      assert.ok(
        !def.readFirst.includes(".devteam/rules/gates.md"),
        `stage "${name}" readFirst still points at the old ".devteam/rules/gates.md" — update to gates-core.md`,
      );
    }
  });

  it("every rules/stage-NN.md that exists contains a ## Gate section with fields matching its gate skeleton", () => {
    for (const [name, def] of Object.entries(STAGES)) {
      if (!def || !def.gate || Object.keys(def.gate).length === 0) continue;
      const stageFile = path.join(REPO_ROOT, "rules", `${def.stage}.md`);
      if (!fs.existsSync(stageFile)) continue; // only check files that exist
      const content = fs.readFileSync(stageFile, "utf8");
      assert.ok(
        content.includes("## Gate"),
        `rules/${def.stage}.md exists but has no "## Gate" section`,
      );
      for (const field of Object.keys(def.gate)) {
        assert.ok(
          content.includes(`"${field}"`),
          `rules/${def.stage}.md ## Gate section missing field "${field}" (from stages.js gate skeleton for stage "${name}")`,
        );
      }
    }
  });
});
