// Cold-start pattern seeding — read the conventions a project already
// documents instead of rediscovering them by failing a gate.
//
// The safety property under test throughout: seeding produces CANDIDATES.
// Nothing reaches a prompt without the existing human promotion step.

const { describe, it } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const REPO_ROOT = path.resolve(__dirname, "..");
const { extractConventions, SOURCE_FILES } = require(path.join(REPO_ROOT, "core", "learning", "seed"));
const patterns = require(path.join(REPO_ROOT, "core", "patterns"));

function project(files = {}) {
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "devteam-test-seed-"));
  for (const [rel, body] of Object.entries(files)) {
    const file = path.join(cwd, rel);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, body);
  }
  return { cwd, cleanup: () => fs.rmSync(cwd, { recursive: true, force: true }) };
}

const CONVENTIONS = `# Contributing

## Conventions

- All database access must go through the repository layer.
- Public API responses should always include a \`request_id\` field.
- Prefer feature flags over long-lived branches.

## Setup

Run npm install to get started. The build takes about a minute.
`;

describe("seed: extracting documented conventions", () => {
  it("takes normative statements and leaves descriptive prose", () => {
    const p = project({ "CONTRIBUTING.md": CONVENTIONS });
    try {
      const found = extractConventions(p.cwd);
      assert.equal(found.length, 3, `expected 3 conventions, got ${JSON.stringify(found)}`);
      assert.ok(found.every((f) => f.source === "CONTRIBUTING.md"));
      // "Run npm install to get started" is documentation, not a convention.
      assert.equal(found.some((f) => /npm install/.test(f.text)), false);
    } finally { p.cleanup(); }
  });

  it("preserves identifiers rather than mangling them", () => {
    // Stripping markdown underscores would turn `request_id` into requestid —
    // worse than no cleanup at all for a code-conventions feature.
    const p = project({ "CONTRIBUTING.md": CONVENTIONS });
    try {
      const found = extractConventions(p.cwd);
      assert.ok(found.some((f) => f.text.includes("request_id")),
        `identifier was mangled: ${JSON.stringify(found.map((f) => f.text))}`);
    } finally { p.cleanup(); }
  });

  it("rebuilds wrapped prose instead of emitting fragments", () => {
    const p = project({
      "AGENTS.md": "- Every adapter must export capabilities, install, and\n  renderStagePrompt before it is registered.\n",
    });
    try {
      const found = extractConventions(p.cwd);
      assert.equal(found.length, 1);
      assert.match(found[0].text, /renderStagePrompt before it is registered/);
    } finally { p.cleanup(); }
  });

  it("never stores a secret-shaped statement", () => {
    // A real token shape — the same secret-scan bar `patterns promote`
    // applies to operator-authored text.
    const p = project({
      "CONTRIBUTING.md": "- You must set the token to ghp_abcdefghijklmnopqrstuvwxyz0123456789 before deploying.\n"
        + "- All database access must go through the repository layer.\n",
    });
    try {
      const found = extractConventions(p.cwd);
      assert.equal(found.length, 1, "the secret-bearing line must be dropped");
      assert.match(found[0].text, /repository layer/);
    } finally { p.cleanup(); }
  });

  it("skips code fences, headings, and tables", () => {
    const p = project({
      "CONTRIBUTING.md": "## You must read this heading\n\n```\nyou must never run this command directly\n```\n\n| you must | not read tables |\n|---|---|\n",
    });
    try {
      assert.deepEqual(extractConventions(p.cwd), []);
    } finally { p.cleanup(); }
  });

  it("bounds how many statements a large handbook can contribute", () => {
    const many = Array.from({ length: 200 },
      (_, i) => `- Rule ${i}: contributors must keep module ${i} free of side effects.`).join("\n");
    const p = project({ "CONTRIBUTING.md": many });
    try {
      assert.equal(extractConventions(p.cwd).length, 40);
      assert.equal(extractConventions(p.cwd, { limit: 5 }).length, 5);
    } finally { p.cleanup(); }
  });

  it("deduplicates the same rule restated in two documents", () => {
    const rule = "- All database access must go through the repository layer.\n";
    const p = project({ "CONTRIBUTING.md": rule, "AGENTS.md": rule });
    try {
      assert.equal(extractConventions(p.cwd).length, 1);
    } finally { p.cleanup(); }
  });

  it("returns nothing for a project that documents no conventions", () => {
    const p = project({ "README.md": "# Hello\n\nThis project does a thing.\n" });
    try {
      assert.deepEqual(extractConventions(p.cwd), []);
      assert.ok(SOURCE_FILES.includes("CONTRIBUTING.md"));
    } finally { p.cleanup(); }
  });
});

describe("seed: candidates only, never promoted", () => {
  it("lands conventions as reviewable candidates carrying their provenance", () => {
    const p = project({ "CONTRIBUTING.md": CONVENTIONS });
    try {
      const result = patterns.seed(p.cwd);
      assert.equal(result.scanned, 3);
      assert.ok(result.candidates > 0);
      assert.deepEqual(result.sources, ["CONTRIBUTING.md"]);

      const state = patterns.list({ cwd: p.cwd });
      assert.equal(state.promoted.length, 0, "seeding must never promote");
      const seeded = state.candidates.filter((c) => c.proposed_from === "CONTRIBUTING.md");
      assert.ok(seeded.length > 0, "candidates must carry the source document");
      assert.ok(
        seeded.some((c) => /repository layer|request_id|feature flags/.test(c.proposed_prompt_text)),
        "the project's own wording must be the proposal, not a template",
      );
    } finally { p.cleanup(); }
  });

  it("survives a later collect, and promotion uses the project's wording", () => {
    // pending-review.json is rewritten by every collect(), so the proposal has
    // to live in its own store or a single collect would erase it.
    const p = project({ "CONTRIBUTING.md": CONVENTIONS });
    try {
      patterns.seed(p.cwd);
      fs.mkdirSync(path.join(p.cwd, "pipeline", "gates"), { recursive: true });
      patterns.collect({ cwd: p.cwd, pipelineRoot: path.join(p.cwd, "pipeline") });

      const after = patterns.list({ cwd: p.cwd });
      const target = after.candidates.find((c) => c.proposed_from === "CONTRIBUTING.md");
      assert.ok(target, "seeded proposals must survive collect()");

      patterns.promote({ cwd: p.cwd, candidateId: target.id });
      const promoted = patterns.loadPromoted(p.cwd);
      assert.equal(promoted[0].prompt_text, target.proposed_prompt_text);
    } finally { p.cleanup(); }
  });

  it("is idempotent — re-seeding adds nothing new", () => {
    const p = project({ "CONTRIBUTING.md": CONVENTIONS });
    try {
      const first = patterns.seed(p.cwd);
      const second = patterns.seed(p.cwd);
      assert.ok(first.added > 0);
      assert.equal(second.added, 0, "fingerprint dedup must hold across runs");
      assert.equal(second.total, first.total);
    } finally { p.cleanup(); }
  });

  it("an operator can still override the wording at promotion", () => {
    const p = project({ "CONTRIBUTING.md": CONVENTIONS });
    try {
      patterns.seed(p.cwd);
      const target = patterns.list({ cwd: p.cwd }).candidates.find((c) => c.proposed_from);
      patterns.promote({ cwd: p.cwd, candidateId: target.id, text: "My own wording for this rule." });
      assert.equal(patterns.loadPromoted(p.cwd)[0].prompt_text, "My own wording for this rule.");
    } finally { p.cleanup(); }
  });
});
