// Unit tests for the shared adapter render helpers. The full
// renderStagePrompt path is covered by each host adapter's existing
// tests (adapter-contract, install-roundtrip) — this file pins the
// helper-level contract so refactors stay safe.

const { describe, it } = require("node:test");
const assert = require("node:assert/strict");
const path = require("node:path");
const { REPO_ROOT } = require("./_helpers");
const { allowedWritesCaption, appendGateFooter, renderContextDelta, renderContextManifest, renderKnownPatterns } =
  require(path.join(REPO_ROOT, "core", "adapters", "render-helpers"));

describe("render-helpers: allowedWritesCaption", () => {
  it("tool-call-time enforcement (claude-code shape)", () => {
    const c = allowedWritesCaption("tool-call-time", "Claude Code");
    assert.match(c, /^## Allowed writes/);
    assert.match(c, /enforced by Claude Code hooks at tool-call time/);
  });

  it("prompt-only enforcement (codex/gemini-cli shape)", () => {
    const c = allowedWritesCaption("prompt-only", "codex");
    assert.match(c, /^## Allowed writes/);
    assert.match(c, /advisory/);
    assert.match(c, /codex enforces this in prompt only/);
  });

  it("post-hoc-audit enforcement", () => {
    const c = allowedWritesCaption("post-hoc-audit", "anything");
    assert.match(c, /^## Allowed writes/);
    assert.match(c, /write-audit|post-hoc/);
    assert.match(c, /FAIL/);
  });

  it("unknown enforcement level falls back to prompt-only wording", () => {
    const c = allowedWritesCaption("nonsense", "weird-host");
    assert.match(c, /advisory/);
    assert.match(c, /weird-host/);
  });
});

describe("render-helpers: renderContextManifest", () => {
  it("omits the section when no changed files are present", () => {
    const lines = ["before"];
    renderContextManifest(lines, { contextManifest: { files: [] } });
    assert.deepEqual(lines, ["before"]);
  });

  it("renders changed-file facts without file contents", () => {
    const lines = [];
    renderContextManifest(lines, {
      contextManifest: {
        files: [{
          path: "src/app.js",
          status: "M",
          bytes: 17,
          sha256: "sha256:0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef",
        }],
        truncated: true,
        omitted_count: 2,
      },
    });
    const out = lines.join("\n");
    assert.match(out, /Changed-file manifest/);
    assert.match(out, /src\/app\.js/);
    assert.match(out, /bytes=17/);
    assert.match(out, /sha256:0123456789abcdef/);
    assert.match(out, /2 additional changed file/);
    assert.doesNotMatch(out, /console\.log|function|class/);
  });
});

describe("render-helpers: renderContextDelta", () => {
  it("omits the section on a workstream's first dispatch (contextDelta is null)", () => {
    const lines = ["before"];
    renderContextDelta(lines, { contextDelta: null });
    assert.deepEqual(lines, ["before"]);
  });

  it("omits the section when nothing changed since the last dispatch", () => {
    const lines = ["before"];
    renderContextDelta(lines, { contextDelta: { added: [], removed: [], compacted: [] } });
    assert.deepEqual(lines, ["before"]);
  });

  it("renders added, removed, and compacted sections", () => {
    const lines = [];
    renderContextDelta(lines, {
      contextDelta: {
        added: ["run-blockers"],
        removed: ["red-team-blockers"],
        compacted: ["right-sizing"],
      },
    });
    const out = lines.join("\n");
    assert.match(out, /## Context changes since your last dispatch/);
    assert.match(out, /added: devteam:run-blockers/);
    assert.match(out, /removed: devteam:red-team-blockers/);
    assert.match(out, /compacted to a digest.*devteam:right-sizing/);
  });
});

describe("render-helpers: project knowledge", () => {
  it("omits the section when no promoted patterns are selected", () => {
    const lines = ["before"];
    renderKnownPatterns(lines, { knownPatterns: [] });
    assert.deepEqual(lines, ["before"]);
  });

  it("renders selected patterns as advisory guidance", () => {
    const lines = [];
    renderKnownPatterns(lines, {
      knownPatterns: [{
        id: "docs-http-endpoint",
        tier: "warning",
        prompt_text: "Document user-visible HTTP endpoints during implementation.",
      }],
    });
    const out = lines.join("\n");
    assert.match(out, /Known Project Patterns/);
    assert.match(out, /advisory prevention guidance/);
    assert.match(out, /Document user-visible HTTP endpoints/);
    assert.match(out, /\[warning\]/);
  });

  it("renders conventions, reviewed patterns, and retrieved history as one provenance-labeled pack", () => {
    const { renderProjectKnowledgePack } = require(path.join(REPO_ROOT, "core", "adapters", "render-helpers"));
    const lines = [];
    renderProjectKnowledgePack(lines, {
      projectFacts: [{ text: "Verify with — `npm test`.", source: "static-discovery" }],
      knownPatterns: [{
        id: "tests-edge-cases",
        tier: "blocker",
        prompt_text: "Cover boundary cases.",
        evaluation: { status: "no-recurrence-observed", injections: 4, recurrences: 0 },
      }],
      priorKnowledge: [{ kind: "adr", source: "docs/adr/001.md", text: "Keep adapters host-neutral." }],
    });
    const out = lines.join("\n");
    assert.match(out, /## Project Knowledge Pack/);
    assert.match(out, /### Detected conventions/);
    assert.match(out, /### Reviewed patterns and outcome evidence/);
    assert.match(out, /injected=4; recurred=0/);
    assert.match(out, /### Retrieved history/);
  });
});

describe("render-helpers: appendGateFooter", () => {
  const fixture = () => ({
    descriptor: {
      stage: "stage-01",
      role: "pm",
      workstreamId: "stage-01",
      expectedGate: { acceptance_criteria_count: 0 },
    },
    ctx: {
      track: "full",
      orchestrator: "devteam@test",
    },
  });

  it("appends gate JSON skeleton with the expected fields", () => {
    const { descriptor, ctx } = fixture();
    const lines = ["# Stage 1", "preamble"];
    appendGateFooter(lines, descriptor, ctx, "claude-code");
    const out = lines.join("\n");
    assert.match(out, /## Gate to write/);
    assert.match(out, /pipeline\/gates\/stage-01\.json/);
    // JSON block contains the required fields
    assert.match(out, /"stage": "stage-01"/);
    assert.match(out, /"workstream": "pm"/);
    assert.match(out, /"status": "PASS\|WARN\|FAIL\|ESCALATE"/);
    assert.match(out, /"track": "full"/);
    assert.match(out, /"acceptance_criteria_count": 0/);
  });

  it("attributes orchestrator and host correctly", () => {
    const { descriptor, ctx } = fixture();
    const lines = [];
    appendGateFooter(lines, descriptor, ctx, "codex");
    const out = lines.join("\n");
    assert.match(out, /"orchestrator": "devteam@test"/);
    assert.match(out, /"host": "codex"/);
  });

  it("appends the cost telemetry hint", () => {
    const { descriptor, ctx } = fixture();
    const lines = [];
    appendGateFooter(lines, descriptor, ctx, "claude-code");
    assert.match(lines.join("\n"), /Optional cost telemetry.*model.*tokens_in.*tokens_out.*duration_ms/);
  });

  it("computes a deterministic system_prompt_hash for a given input", () => {
    const { descriptor, ctx } = fixture();
    const a = ["# Same preamble", "more"];
    const b = ["# Same preamble", "more"];
    appendGateFooter(a, descriptor, ctx, "claude-code");
    appendGateFooter(b, descriptor, ctx, "claude-code");
    // Hash should be byte-stable across two identical inputs
    const ha = a.join("\n").match(/"system_prompt_hash": "(sha256:[0-9a-f]+)"/)[1];
    const hb = b.join("\n").match(/"system_prompt_hash": "(sha256:[0-9a-f]+)"/)[1];
    assert.equal(ha, hb, "hash must be deterministic for the same input");
  });

  it("includes a system_prompt_hash in sha256:hex shape", () => {
    const { descriptor, ctx } = fixture();
    const lines = ["# preamble"];
    appendGateFooter(lines, descriptor, ctx, "claude-code");
    assert.match(lines.join("\n"), /"system_prompt_hash": "sha256:[0-9a-f]{64}"/);
  });

  it("the hash spans the preamble, not the C4 line itself", () => {
    const { descriptor, ctx } = fixture();
    const linesA = ["preamble A"];
    const linesB = ["preamble B"];
    appendGateFooter(linesA, descriptor, ctx, "claude-code");
    appendGateFooter(linesB, descriptor, ctx, "claude-code");
    const hashA = linesA.join("\n").match(/sha256:[0-9a-f]+/)[0];
    const hashB = linesB.join("\n").match(/sha256:[0-9a-f]+/)[0];
    assert.notEqual(hashA, hashB, "different preambles must produce different hashes");
  });

  it("tells the model the dispatch is non-interactive and it must write the gate even if blocked", () => {
    // Regression: a real headless sign-off dispatch (stage-07.pm on a
    // hello-world-claude-quick demo run) ended its turn with only a prose
    // clarifying question and no gate at all — everything above this footer
    // reads as reference material (Objective/Read first/Allowed writes)
    // unless told otherwise, so the orchestrator saw no gate and halted
    // with a structural-input error. This line is the last thing the model
    // reads before the JSON skeleton, and must survive any future edit to
    // appendGateFooter.
    const { descriptor, ctx } = fixture();
    const lines = [];
    appendGateFooter(lines, descriptor, ctx, "claude-code");
    const out = lines.join("\n");
    assert.match(out, /non-interactive/);
    assert.match(out, /no human present/);
    assert.match(out, /"status": "ESCALATE"/);
    assert.match(out, /escalation_reason/);
    // Must appear before "## Gate to write" — recency, not buried after it.
    assert.ok(out.indexOf("non-interactive") < out.indexOf("## Gate to write"));
  });
});
