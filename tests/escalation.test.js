// Tests for the typed escalation contract parser (ADR-003 / Phase 2 PR-C1).

const { describe, it, afterEach } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { REPO_ROOT, makeTargetProject, cleanup } = require("./_helpers");
const {
  parseRulingLine, parseCannotDecideLine, loadRulings, loadCannotDecide, renderPrincipalRulingPrompt,
  renderEscalationApplicatorPrompt,
} = require(path.join(REPO_ROOT, "core", "escalation"));

let _dirs = [];
function track(cwd) { _dirs.push(cwd); return cwd; }
afterEach(() => { _dirs.forEach(cleanup); _dirs = []; });

describe("parseRulingLine", () => {
  it("parses a typed ruling with a class", () => {
    const r = parseRulingLine("PRINCIPAL-RULING: lint style → accept prettier defaults [class: formatting-only]");
    assert.deepEqual(r, { topic: "lint style", decision: "accept prettier defaults", class: "formatting-only" });
  });

  it("defaults to unclassified when no class tag is present (legacy)", () => {
    const r = parseRulingLine("PRINCIPAL-RULING: auth design → use JWT with 1h expiry");
    assert.equal(r.class, "unclassified");
    assert.equal(r.decision, "use JWT with 1h expiry");
  });

  it("accepts the ASCII -> arrow and lowercases the class", () => {
    const r = parseRulingLine("PRINCIPAL-RULING: dep bump -> approve lodash 4.17.21 [class: Known-Safe-Dependency-Bump]");
    assert.equal(r.topic, "dep bump");
    assert.equal(r.class, "known-safe-dependency-bump");
  });

  it("returns null for a non-ruling line", () => {
    assert.equal(parseRulingLine("some other note"), null);
    assert.equal(parseRulingLine("PRINCIPAL-CANNOT-DECIDE: value → x"), null);
  });
});

describe("parseCannotDecideLine", () => {
  it("parses each valid reason class", () => {
    for (const rc of ["authority", "information", "value"]) {
      const r = parseCannotDecideLine(`PRINCIPAL-CANNOT-DECIDE: ${rc} → who approves this?`);
      assert.equal(r.reason_class, rc);
      assert.equal(r.question, "who approves this?");
    }
  });

  it("falls back to unspecified for an unknown reason class", () => {
    const r = parseCannotDecideLine("PRINCIPAL-CANNOT-DECIDE: vibes → really?");
    assert.equal(r.reason_class, "unspecified");
  });

  it("returns null for a non-cannot-decide line", () => {
    assert.equal(parseCannotDecideLine("PRINCIPAL-RULING: x → y [class: z]"), null);
  });
});

describe("loadRulings / loadCannotDecide", () => {
  it("reads typed lines from a project's context.md in order", () => {
    const cwd = track(makeTargetProject());
    fs.mkdirSync(path.join(cwd, "pipeline"), { recursive: true });
    fs.writeFileSync(path.join(cwd, "pipeline", "context.md"), [
      "## Principal Rulings",
      "",
      "PRINCIPAL-RULING: a → b [class: doc-only]",
      "some prose",
      "PRINCIPAL-CANNOT-DECIDE: authority → who signs off on prod?",
      "PRINCIPAL-RULING: c → d",
      "",
    ].join("\n"));
    const rulings = loadRulings(cwd);
    assert.equal(rulings.length, 2);
    assert.equal(rulings[0].class, "doc-only");
    assert.equal(rulings[1].class, "unclassified");
    const cd = loadCannotDecide(cwd);
    assert.equal(cd.length, 1);
    assert.equal(cd[0].reason_class, "authority");
  });

  it("returns empty arrays when context.md is absent", () => {
    const cwd = track(makeTargetProject({ gates: false }));
    assert.deepEqual(loadRulings(cwd), []);
    assert.deepEqual(loadCannotDecide(cwd), []);
  });
});

// Regression: a real openai-compat run had the dispatched Principal spend
// three failed read_file calls hunting for `.claude/agents/principal.md`,
// `.codex/prompts/roles/principal.md`, and `.gemini/prompts/roles/principal.md`
// — none of which exist under openai-compat — while its actual, correctly
// installed role brief sat untouched at
// `.openai-compat/prompts/roles/principal.md`. The prompt named exactly
// three hosts unconditionally regardless of which host was actually routed.
describe("renderPrincipalRulingPrompt: role-brief path matches the routed host", () => {
  function withHost(cwd, host) {
    fs.writeFileSync(
      path.join(cwd, ".devteam", "config.yml"),
      `routing:\n  default_host: ${host}\npipeline:\n  default_track: full\n`,
    );
    return cwd;
  }

  it("openai-compat host → points at .openai-compat/prompts/roles/principal.md, not the other three hosts", () => {
    const cwd = track(withHost(makeTargetProject(), "openai-compat"));
    const prompt = renderPrincipalRulingPrompt("topic", [], null, cwd);
    assert.match(prompt, /\.openai-compat\/prompts\/roles\/principal\.md/);
    assert.doesNotMatch(prompt, /\.claude\/agents/);
    assert.doesNotMatch(prompt, /\.codex\/prompts/);
    assert.doesNotMatch(prompt, /\.gemini\/prompts/);
  });

  it("codex host → points at .codex/prompts/roles/principal.md only", () => {
    const cwd = track(withHost(makeTargetProject(), "codex"));
    const prompt = renderPrincipalRulingPrompt("topic", [], null, cwd);
    assert.match(prompt, /\.codex\/prompts\/roles\/principal\.md/);
    assert.doesNotMatch(prompt, /\.claude\/agents/);
    assert.doesNotMatch(prompt, /\.gemini\/prompts/);
  });

  it("claude-code host → points at .claude/agents/principal.md (agentsDir, not rolePromptsDir)", () => {
    const cwd = track(withHost(makeTargetProject(), "claude-code"));
    const prompt = renderPrincipalRulingPrompt("topic", [], null, cwd);
    assert.match(prompt, /\.claude\/agents\/principal\.md/);
    assert.doesNotMatch(prompt, /\.codex\/prompts/);
  });

  it("generic host (no installed role-brief file) → falls back without naming a nonexistent path", () => {
    const cwd = track(withHost(makeTargetProject(), "generic"));
    const prompt = renderPrincipalRulingPrompt("topic", [], null, cwd);
    assert.doesNotMatch(prompt, /\.claude\/agents/);
    assert.doesNotMatch(prompt, /\.codex\/prompts/);
    assert.doesNotMatch(prompt, /\.gemini\/prompts/);
    assert.doesNotMatch(prompt, /\.openai-compat\/prompts/);
    assert.match(prompt, /brief is inline\s+in this system prompt/);
  });

  it("no cwd supplied (back-compat) → generic fallback text, no hardcoded host guesses", () => {
    const prompt = renderPrincipalRulingPrompt("topic", [], null);
    assert.doesNotMatch(prompt, /\.claude\/agents/);
    assert.doesNotMatch(prompt, /\.codex\/prompts/);
    assert.doesNotMatch(prompt, /\.gemini\/prompts/);
  });
});

// Regression: a real headless run ordered to fix a qa build blocker ran
// `devteam stage qa --headless` instead of `devteam stage build --workstream
// qa --headless`. The routing table listed "qa" as both a bare stage name
// (stage-06, QA Testing) and a build workstream role with no disambiguation
// — the applicator picked the bare stage name, dispatched the wrong thing,
// and the pipeline advanced right past the still-unresolved build escalation.
describe("renderEscalationApplicatorPrompt: qa stage name vs. qa build workstream", () => {
  it("warns that bare `devteam stage qa` is stage-06, not the qa build workstream", () => {
    const cwd = track(makeTargetProject());
    const prompt = renderEscalationApplicatorPrompt(cwd, ["PRINCIPAL-RULING: x → y"], null);
    assert.match(prompt, /`qa` here is the QA Testing stage \(stage-06/);
    assert.match(prompt, /devteam stage build --workstream qa --headless/);
  });
});
