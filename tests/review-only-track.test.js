// tests/review-only-track.test.js
//
// Phase-35 item 35.1 — review-only track + artifact-tolerant readFirst.
//
// Coverage:
//   1. existsForReadFirst / buildDescriptor: an absent optional readFirst
//      entry is omitted from the rendered prompt entirely; a present one
//      renders plainly (same as a required entry — no "(if present)" text).
//   2. Regression: full-track prompts for the four touched stages
//      (security-review, red-team, peer-review incl. adversarial,
//      verification-beyond-tests) are byte-identical to their pre-35 shape
//      when every referenced artifact is present on disk.
//   3. `devteam run --track review-only` walks security-review -> red-team
//      -> peer-review to pipeline-complete on a fixture repo with NO
//      pipeline/ directory; no rendered prompt mentions a nonexistent path.
//   4. verify-chain passes on the 3-stage review-only track.
//   5. --scope reaches the rendered prompt and the gate skeleton; absent by
//      default (no prompt/gate change for every pre-35 track).

"use strict";

const { describe, it, afterEach } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const { REPO_ROOT, makeTargetProject, cleanup } = require("./_helpers");
const {
  TRACKS,
  STAGES_BY_TRACK,
  getStage,
  rolesForStage,
  orderedStageNamesForTrack,
} = require(path.join(REPO_ROOT, "core", "pipeline", "stages"));
const { buildDescriptor, runStage, next, mergeWorkstreamGates } =
  require(path.join(REPO_ROOT, "core", "orchestrator"));
const { loadAdapter } = require(path.join(REPO_ROOT, "core", "router"));
const { stampAll, verifyChain } = require(path.join(REPO_ROOT, "core", "gates", "chain"));

let _dirs = [];
function track(cwd) { _dirs.push(cwd); return cwd; }
afterEach(() => { _dirs.forEach(cleanup); _dirs = []; });

function writeGate(cwd, name, gate) {
  const dir = path.join(cwd, "pipeline", "gates");
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, `${name}.json`), JSON.stringify(gate, null, 2));
}

// ─── 1. existsForReadFirst / buildDescriptor omission ──────────────────────

describe("35.1: optional readFirst entries are existence-gated at render time", () => {
  it("an absent optional entry is omitted from the descriptor's readFirst entirely", () => {
    const cwd = track(makeTargetProject({ gates: false }));
    const stageDef = getStage("security-review");
    const descriptor = buildDescriptor(stageDef, "security", { workstreamId: "stage-04b", track: "review-only", cwd });
    assert.ok(!descriptor.readFirst.some((f) => f.includes("pre-review.md")), "absent pipeline/pre-review.md must not appear in readFirst");
    assert.ok(!descriptor.readFirst.some((f) => f.includes("build-plan.md")), "absent pipeline/build-plan.md must not appear in readFirst");
    assert.ok(!descriptor.readFirst.some((f) => f.includes("context.md")), "absent pipeline/context.md must not appear in readFirst");
    assert.ok(descriptor.readFirst.includes("AGENTS.md"), "required entries must still be present");
  });

  it("a present optional entry renders plainly — no '(if present)' annotation", () => {
    const cwd = track(makeTargetProject({ gates: false }));
    fs.mkdirSync(path.join(cwd, "pipeline"), { recursive: true });
    fs.writeFileSync(path.join(cwd, "pipeline", "pre-review.md"), "# pre-review\n");
    const stageDef = getStage("security-review");
    const descriptor = buildDescriptor(stageDef, "security", { workstreamId: "stage-04b", track: "review-only", cwd });
    assert.ok(descriptor.readFirst.includes("pipeline/pre-review.md"), "present optional entry should render as a plain path");
    assert.ok(!descriptor.readFirst.some((f) => f.includes("(if present)")), "no entry should carry the pre-35 annotation text");
  });

  it("a glob optional entry (pipeline/pr-*.md) resolves against real files", () => {
    const cwd = track(makeTargetProject({ gates: false }));
    fs.mkdirSync(path.join(cwd, "pipeline"), { recursive: true });
    fs.writeFileSync(path.join(cwd, "pipeline", "pr-backend.md"), "# pr\n");
    const stageDef = getStage("peer-review");
    const descriptor = buildDescriptor(stageDef, "backend", { workstreamId: "stage-05.backend", track: "review-only", cwd });
    assert.ok(descriptor.readFirst.includes("pipeline/pr-*.md"), "glob entry should be included when a matching file exists");
  });

  it("a glob optional entry is omitted when no file matches", () => {
    const cwd = track(makeTargetProject({ gates: false }));
    const stageDef = getStage("peer-review");
    const descriptor = buildDescriptor(stageDef, "backend", { workstreamId: "stage-05.backend", track: "review-only", cwd });
    assert.ok(!descriptor.readFirst.includes("pipeline/pr-*.md"), "glob entry should be omitted when nothing matches");
  });

  it("no cwd (preview/test paths) fails open — optional entries are still included", () => {
    const stageDef = getStage("red-team");
    const descriptor = buildDescriptor(stageDef, "red-team", { workstreamId: "stage-04c", track: "full" });
    assert.ok(descriptor.readFirst.includes("pipeline/brief.md"), "no cwd => assume present (back-compat)");
  });
});

// ─── 2. Full-track byte-identical regression ───────────────────────────────

const TOUCHED_STAGES = [
  { name: "security-review", role: "security", files: ["context.md", "pre-review.md", "build-plan.md", "pr-backend.md"] },
  { name: "red-team", role: "red-team", files: ["context.md", "brief.md", "design-spec.md", "pr-backend.md", "pre-review.md", "security-review.md"] },
  { name: "peer-review", role: "backend", files: ["context.md", "pr-backend.md"] },
  { name: "verification-beyond-tests", role: "verifier", files: ["context.md", "brief.md", "design-spec.md", "spec.feature", "test-report.md", "red-team-report.md"] },
];

describe("35.1: full-track prompts are byte-identical when every optional artifact is present", () => {
  for (const { name, role, files } of TOUCHED_STAGES) {
    it(`"${name}" renders identically to a hand-authored plain-string readFirst copy`, () => {
      const cwd = track(makeTargetProject({ gates: false }));
      fs.mkdirSync(path.join(cwd, "pipeline"), { recursive: true });
      for (const f of files) fs.writeFileSync(path.join(cwd, "pipeline", f), `# ${f}\n`);

      const stageDef = getStage(name);
      const wsId = stageDef.roles.length > 1 ? `${stageDef.stage}.${role}` : stageDef.stage;
      const liveDescriptor = buildDescriptor(stageDef, role, { workstreamId: wsId, track: "full", cwd });

      // Pre-35 shape: same stage def, but every readFirst entry as a plain
      // string (no optional wrapper) — exactly what stages.js declared
      // before this item.
      const plainStageDef = {
        ...stageDef,
        readFirst: stageDef.readFirst.map((item) => (typeof item === "object" ? item.path : item)),
      };
      const plainDescriptor = buildDescriptor(plainStageDef, role, { workstreamId: wsId, track: "full", cwd });

      const adapter = loadAdapter("generic");
      const ctx = { track: "full", feature: "test feature", isolation: "in-place", orchestrator: "devteam@test", cwd };
      const livePrompt = adapter.renderStagePrompt(liveDescriptor, ctx);
      const plainPrompt = adapter.renderStagePrompt(plainDescriptor, ctx);
      assert.equal(livePrompt, plainPrompt, `"${name}" prompt must be byte-identical when all optional artifacts exist`);
    });
  }
});

// ─── 3. review-only e2e on a fixture with NO pipeline/ directory ───────────

function passGateFor(stageId) {
  const extras = {
    "stage-04b": { security_approved: true, veto: false, triggering_conditions: [] },
    "stage-04c": { surfaces_walked: [], findings_count: 0, severity_breakdown: { critical: 0, high: 0, medium: 0, low: 0 }, must_address_before_peer_review: [], noted_for_followup: [] },
    "stage-05": { review_shape: "matrix", required_approvals: 2, approvals: [], changes_requested: [], escalated_to_principal: false },
  };
  return {
    stage: stageId,
    status: "PASS",
    orchestrator: "devteam@test",
    host: "generic",
    track: "review-only",
    timestamp: new Date().toISOString(),
    blockers: [],
    warnings: [],
    ...(extras[stageId] || {}),
  };
}

function writeStageGatesFor(cwd, stageName) {
  const stageDef = getStage(stageName);
  const roles = rolesForStage(stageDef, "review-only");
  if (roles.length === 1) {
    writeGate(cwd, stageDef.stage, { ...passGateFor(stageDef.stage), workstream: roles[0] });
  } else {
    for (const role of roles) {
      writeGate(cwd, `${stageDef.stage}.${role}`, { ...passGateFor(stageDef.stage), workstream: role });
    }
  }
}

describe("35.1: review-only track completes on a brownfield fixture (no pipeline/ dir)", () => {
  it("walks security-review -> red-team -> peer-review to pipeline-complete", () => {
    const cwd = track(makeTargetProject({
      config: "routing:\n  default_host: generic\npipeline:\n  default_track: review-only\n",
      gates: false,
    }));
    assert.ok(!fs.existsSync(path.join(cwd, "pipeline")), "fixture must start with no pipeline/ directory at all");

    const trace = [];
    for (let i = 0; i < 50; i++) {
      const r = next({ cwd, track: "review-only" });
      trace.push(r.name || r.action);
      if (r.action === "pipeline-complete") break;
      if (r.action === "run-stage" || r.action === "continue-stage") {
        writeStageGatesFor(cwd, r.name);
        continue;
      }
      if (r.action === "merge") {
        const m = mergeWorkstreamGates(r.name, { cwd, track: "review-only" });
        assert.equal(m.merged, true, `merge of ${r.name} failed: ${m.reason}`);
        continue;
      }
      throw new Error(`unexpected action "${r.action}" at ${r.name}: ${r.reason}`);
    }
    assert.ok(trace.includes("security-review"), "security-review not dispatched");
    assert.ok(trace.includes("red-team"), "red-team not dispatched");
    assert.ok(trace.includes("peer-review"), "peer-review not dispatched");
    assert.equal(trace[trace.length - 1], "pipeline-complete");
  });

  it("no dispatched '## Read first' section mentions a nonexistent pipeline artifact", () => {
    // Scoped to the structured "## Read first" section the orchestrator
    // renders per dispatch (core/adapters/render-helpers.js#splitReadFirst) —
    // NOT the whole prompt, since some adapters (e.g. generic) inline the
    // full role-brief markdown verbatim, and role briefs contain their own
    // freeform prose/examples that may mention pipeline/brief.md as general
    // guidance independent of what this specific dispatch's readFirst is.
    const cwd = track(makeTargetProject({ gates: false }));
    const banned = [
      "pipeline/brief.md", "pipeline/design-spec.md", "pipeline/pre-review.md",
      "pipeline/build-plan.md", "pipeline/security-review.md", "pipeline/context.md",
    ];
    for (const name of STAGES_BY_TRACK["review-only"]) {
      const result = runStage(name, { cwd, track: "review-only" });
      for (const ws of result.workstreams) {
        const match = ws.prompt.match(/## Read first\n([\s\S]*?)\n##/);
        assert.ok(match, `stage "${name}" prompt has no '## Read first' section`);
        const readFirstSection = match[1];
        for (const b of banned) {
          assert.ok(!readFirstSection.includes(b), `stage "${name}" '## Read first' mentions nonexistent "${b}"`);
        }
      }
    }
  });
});

// ─── 4. verify-chain passes on the 3-stage review-only track ──────────────

describe("35.1: verify-chain passes on review-only", () => {
  it("stamps and verifies a clean chain across security-review -> red-team -> peer-review", () => {
    const cwd = track(makeTargetProject());
    writeStageGatesFor(cwd, "security-review");
    writeStageGatesFor(cwd, "red-team");
    // peer-review is multi-role under review-only (falls back to full sizing) —
    // merge into a single stage-05.json the way the orchestrator would.
    const gatesDir = path.join(cwd, "pipeline", "gates");
    writeStageGatesFor(cwd, "peer-review");
    const merged = mergeWorkstreamGates("peer-review", { cwd, track: "review-only" });
    assert.equal(merged.merged, true, `peer-review merge failed: ${merged.reason}`);

    const result = stampAll(gatesDir, "review-only", { secret: null });
    assert.equal(result.failed.length, 0, `stampAll had failures: ${JSON.stringify(result.failed)}`);

    const verify = verifyChain(gatesDir, "review-only");
    assert.equal(verify.ok, true, `verifyChain failed: ${JSON.stringify(verify)}`);
  });
});

// ─── 5. --scope reaches the rendered prompt and the gate ───────────────────

describe("35.1: --scope reaches the prompt and the gate skeleton", () => {
  it("renders a Scope line and a scope field on the gate when passed", () => {
    const cwd = track(makeTargetProject({ gates: false }));
    const stageDef = getStage("security-review");
    const descriptor = buildDescriptor(stageDef, "security", { workstreamId: "stage-04b", track: "review-only", cwd });
    const adapter = loadAdapter("generic");
    const ctx = { track: "review-only", scope: ["src/payments/"], isolation: "in-place", orchestrator: "devteam@test", cwd };
    const prompt = adapter.renderStagePrompt(descriptor, ctx);
    assert.match(prompt, /Scope: src\/payments\//);
    const gateBlockMatch = prompt.match(/## Gate to write[\s\S]*?```json\n([\s\S]*?)\n```/);
    assert.ok(gateBlockMatch, "gate skeleton JSON block not found in prompt");
    const gateSkeleton = JSON.parse(gateBlockMatch[1]);
    assert.deepEqual(gateSkeleton.scope, ["src/payments/"]);
  });

  it("omits the Scope line and the gate's scope field when not passed (every pre-35 track)", () => {
    const cwd = track(makeTargetProject({ gates: false }));
    const stageDef = getStage("build");
    const descriptor = buildDescriptor(stageDef, "backend", { workstreamId: "stage-04.backend", track: "full", cwd });
    const adapter = loadAdapter("generic");
    const ctx = { track: "full", isolation: "in-place", orchestrator: "devteam@test", cwd };
    const prompt = adapter.renderStagePrompt(descriptor, ctx);
    assert.ok(!prompt.includes("Scope:"), "no Scope line should render when --scope wasn't passed");
    const gateBlockMatch = prompt.match(/## Gate to write[\s\S]*?```json\n([\s\S]*?)\n```/);
    const gateSkeleton = JSON.parse(gateBlockMatch[1]);
    assert.ok(!("scope" in gateSkeleton), "gate skeleton should have no scope field when --scope wasn't passed");
  });
});

// ─── 6. TRACKS / STAGES_BY_TRACK contract ──────────────────────────────────

describe("35.1: review-only track contract", () => {
  it("is registered in TRACKS and STAGES_BY_TRACK with exactly the 3 review stages", () => {
    assert.ok(TRACKS.includes("review-only"));
    assert.deepEqual(STAGES_BY_TRACK["review-only"], ["security-review", "red-team", "peer-review"]);
  });

  it("has no build/design/requirements/sign-off/deploy stages", () => {
    const stages = orderedStageNamesForTrack("review-only");
    for (const forbidden of ["requirements", "design", "build", "sign-off", "deploy"]) {
      assert.ok(!stages.includes(forbidden), `review-only must not include "${forbidden}"`);
    }
  });
});
