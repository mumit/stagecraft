// Phase 35 item 35.4 — `devteam report --findings`.
//
// Locks:
//   - collectFindings() merges findings across three independent sources
//     (red-team mechanical floor, security-review, verification-beyond-tests)
//     into one severity-ordered list with correct provenance labels.
//   - the no-findings case renders an honest empty state, not a broken table.
//   - `--json` output matches the shape declared in
//     core/report/schemas/findings-report.schema.json.
//   - the CLI writes an HTML file and supports --json/--out.

const { describe, it, afterEach } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { makeTargetProject, seedGate, cleanup, runCLI, REPO_ROOT } = require("./_helpers");
const { collectFindings, PROVENANCE } = require("../core/report/collect-findings");
const { renderFindingsHtml } = require("../core/report/render-findings-html");
const { parseMarkdownFindingBlocks } = require("../core/report/parse-markdown-findings");

let _dirs = [];
function track(cwd) { _dirs.push(cwd); return cwd; }
afterEach(() => { _dirs.forEach(cleanup); _dirs = []; });

function writeArtifact(cwd, rel, content) {
  const p = path.join(cwd, "pipeline", rel);
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(p, content, "utf8");
}

describe("collectFindings: three-source fixture", () => {
  it("merges red-team (mechanical + model), security-review, and verification-beyond-tests into one ranked list", () => {
    const cwd = track(makeTargetProject());

    // Source 1: red-team — one mechanical (orchestrator-observed) finding
    // and one model-authored (model-asserted) finding.
    seedGate(cwd, "stage-04c", {
      stage: "stage-04c",
      surfaces_walked: ["input_boundaries"],
      findings_count: 2,
      severity_breakdown: { critical: 0, high: 2, medium: 0, low: 0 },
      must_address_before_peer_review: [
        {
          id: "RT-MECH-secret-1",
          severity: "high",
          likelihood: "expected",
          surface: "secret_exposure",
          summary: "AWS key detected in src/config.js:42",
          source: "mechanical",
        },
        {
          id: "RT-1",
          severity: "high",
          likelihood: "plausible",
          surface: "input_boundaries",
          summary: "Unbounded input length on the upload handler",
        },
      ],
      noted_for_followup: [],
    });
    writeArtifact(cwd, "red-team-report.md", [
      "# Red Team Report",
      "",
      "## Findings — must-fix (block Stage 5)",
      "",
      "### RT-1 — Unbounded input length",
      "",
      "- **Surface:** input boundaries",
      "- **Severity:** high",
      "- **Likelihood:** plausible",
      "- **Effort to fix:** S",
      "- **Where:** `src/upload/handler.js:88`",
      "- **Suggested fix:** cap request body size at the framework layer.",
      "",
    ].join("\n"));

    // Source 2: security-review — a BLOCKER line, gate not vetoed.
    seedGate(cwd, "stage-04b", {
      stage: "stage-04b",
      security_approved: false,
      veto: false,
      triggering_conditions: ["path:auth"],
    });
    writeArtifact(cwd, "security-review.md", [
      "# Review by security",
      "",
      "## Review of backend",
      "",
      "REVIEW: CHANGES REQUESTED",
      "BLOCKER: session token logged in plaintext at src/auth/session.js:12",
      "",
    ].join("\n"));

    // Source 3: verification-beyond-tests — one confirmed (orchestrator-
    // observed) property finding, one unconfirmed (model-asserted) claim.
    seedGate(cwd, "stage-06d", {
      stage: "stage-06d",
      methods_attempted: ["property", "attempted_but_blocked:mutation"],
      methods_skipped: [],
      candidates_inventoried: 3,
      findings_count: 2,
      blocking_findings: [
        { method: "property", file: "src/pricing.js", line: 21, summary: "negative price accepted", counterexample: "price=-1" },
        { method: "mutation", summary: "verifier claims mutation ran but no evidence exists" },
      ],
      non_blocking_findings: [],
      _orchestrator_stamped: {
        fields: [
          { field: "property_based", orchestrator: { properties_asserted: 3, cases_tried: 300, counterexamples_found: 1, tool: "fast-check" } },
          { field: "mutation", model_said: "claimed", orchestrator: "attempted_but_blocked:mutation", reason: "no mutation runner found" },
        ],
      },
    });

    const data = collectFindings(cwd, {});

    // sourcesScanned records all six known sources with correct presence.
    const present = Object.fromEntries(data.meta.sourcesScanned.map((s) => [s.source, s.present]));
    assert.equal(present["red-team"], true);
    assert.equal(present["security-review"], true);
    assert.equal(present["verification-beyond-tests"], true);
    assert.equal(present["peer-review"], false);
    assert.equal(present["mutation"], false);
    assert.equal(present["audit"], false);

    assert.equal(data.counts.total, 5);

    const byId = Object.fromEntries(data.findings.map((f) => [f.id, f]));

    // Mechanical red-team finding: orchestrator-observed.
    const mech = byId["RT-MECH-secret-1"];
    assert.ok(mech, "mechanical finding missing");
    assert.equal(mech.provenance, PROVENANCE.OBSERVED);
    assert.equal(mech.source, "red-team (mechanical floor)");
    assert.equal(mech.file, "src/config.js");
    assert.equal(mech.line, 42);

    // Model-authored red-team finding: model-asserted, enriched from the
    // report's prose (file:line + suggested fix + effort not on the gate).
    const modelRt = byId["RT-1"];
    assert.ok(modelRt, "model red-team finding missing");
    assert.equal(modelRt.provenance, PROVENANCE.ASSERTED);
    assert.equal(modelRt.file, "src/upload/handler.js");
    assert.equal(modelRt.line, 88);
    assert.match(modelRt.mitigation, /cap request body size/);
    assert.equal(modelRt.effort, "S");

    // Security-review BLOCKER: model-asserted, file:line parsed from text.
    const sec = byId["SEC-1"];
    assert.ok(sec, "security-review finding missing");
    assert.equal(sec.provenance, PROVENANCE.ASSERTED);
    assert.equal(sec.severity, "high");
    assert.equal(sec.file, "src/auth/session.js");
    assert.equal(sec.line, 12);

    // Confirmed property counterexample: orchestrator-observed.
    const prop = byId["VBT-property-1"];
    assert.ok(prop, "verification-beyond-tests property finding missing");
    assert.equal(prop.provenance, PROVENANCE.OBSERVED);
    assert.equal(prop.file, "src/pricing.js");
    assert.equal(prop.line, 21);

    // Downgraded mutation claim: model-asserted (no real evidence).
    const mut = byId["VBT-mutation-2"];
    assert.ok(mut, "verification-beyond-tests mutation finding missing");
    assert.equal(mut.provenance, PROVENANCE.ASSERTED);

    // Severity-ordered: all five findings here are "high" except one
    // unranked; assert observed-before-asserted ordering within same
    // severity tier holds for the first same-severity pair encountered.
    const highs = data.findings.filter((f) => f.severity === "high");
    assert.ok(highs.length >= 2);
    const firstObservedIdx = highs.findIndex((f) => f.provenance === PROVENANCE.OBSERVED);
    const firstAssertedIdx = highs.findIndex((f) => f.provenance === PROVENANCE.ASSERTED);
    assert.ok(firstObservedIdx < firstAssertedIdx, "orchestrator-observed findings should sort before model-asserted at the same severity");
  });
});

// Regression: a real `devteam review` run against an external repo (pegasus)
// produced a findings report with "[object Object]" literally rendered for
// every peer-review finding and "(no summary provided)" for every red-team
// finding, plus zero security-review findings despite four fully-populated
// ones sitting in the gate — all four traced to schema-field-name drift
// between what core/gates/schemas/*.schema.json documents and what real
// review dispatches actually write. Fixed via describeItem()/
// fileLineFromItem() tolerating the observed variants instead of assuming
// one exact field name; this locks each case in with the pegasus gate's
// actual shape, not a synthetic one.
describe("collectFindings: real-world field-name drift (pegasus regression)", () => {
  it("peer-review: object-shaped blockers (adversarial-mode reviewer objections) render their own id/severity/file/scenario, not [object Object]", () => {
    const cwd = track(makeTargetProject());
    seedGate(cwd, "stage-05", {
      stage: "stage-05",
      blockers: [
        {
          id: "RT-01",
          area: "backend",
          severity: "high",
          file: "usecases/slack_bots/main.py:429-521",
          scenario: "Unauthenticated /query route reachable via edge-door bypass.",
          workstream: "frontend",
        },
        // A traditional plain-string blocker (panel-mode's stamping hook)
        // must keep working unchanged alongside the object form above.
        "peer-review approval mismatch: workstream \"qa\" claims APPROVED but by-frontend.md shows CHANGES_REQUESTED",
      ],
    });

    const data = collectFindings(cwd, {});
    const byId = Object.fromEntries(data.findings.map((f) => [f.id, f]));

    const objBlocker = byId["RT-01"];
    assert.ok(objBlocker, "object-shaped blocker should use its own id, not a synthesized PR-N");
    assert.doesNotMatch(objBlocker.summary, /\[object Object\]/);
    assert.match(objBlocker.summary, /Unauthenticated \/query route/);
    assert.equal(objBlocker.severity, "high");
    assert.equal(objBlocker.file, "usecases/slack_bots/main.py");
    assert.equal(objBlocker.line, 429);
    assert.equal(objBlocker.source, "peer-review");

    const stringBlocker = byId["PR-2"];
    assert.ok(stringBlocker, "a plain-string blocker must still get a synthesized PR-N id");
    assert.match(stringBlocker.summary, /approval mismatch/);
  });

  it("red-team: must_address_before_peer_review using .scenario instead of the schema's documented .summary is still rendered, not \"(no summary provided)\"", () => {
    const cwd = track(makeTargetProject());
    seedGate(cwd, "stage-04c", {
      stage: "stage-04c",
      surfaces_walked: ["auth_edges"],
      findings_count: 1,
      severity_breakdown: { critical: 0, high: 1, medium: 0, low: 0 },
      must_address_before_peer_review: [
        {
          id: "RT-01",
          severity: "high",
          file: "usecases/slack_bots/main.py:429-521",
          scenario: "Unauthenticated /query route reachable via edge-door bypass; unbounded query length.",
        },
      ],
      noted_for_followup: [],
    });

    const data = collectFindings(cwd, {});
    const found = data.findings.find((f) => f.id === "RT-01");
    assert.ok(found);
    assert.doesNotMatch(found.summary, /no summary provided/);
    assert.match(found.summary, /edge-door bypass/);
    assert.equal(found.file, "usecases/slack_bots/main.py");
    assert.equal(found.line, 429);
  });

  it("red-team: noted_for_followup using .text (and its own .effort field) instead of .summary is still rendered", () => {
    const cwd = track(makeTargetProject());
    seedGate(cwd, "stage-04c", {
      stage: "stage-04c",
      surfaces_walked: ["auth_edges"],
      findings_count: 1,
      severity_breakdown: { critical: 0, high: 0, medium: 1, low: 0 },
      must_address_before_peer_review: [],
      noted_for_followup: [
        {
          id: "RT-03",
          text: "pegasus-armour has no total diffContent size cap.",
          track_for: "ticket",
          severity: "medium",
          assigned_to: "unknown",
          file: "pegasus-armour/index.js:492-637",
          effort: "S",
        },
      ],
    });

    const data = collectFindings(cwd, {});
    const found = data.findings.find((f) => f.id === "RT-03");
    assert.ok(found);
    assert.doesNotMatch(found.summary, /no summary provided/);
    assert.match(found.summary, /diffContent size cap/);
    assert.equal(found.file, "pegasus-armour/index.js");
    assert.equal(found.line, 492);
    assert.equal(found.effort, "S");
    assert.equal(found.source, "red-team (noted for follow-up)");
  });

  it("security-review: a PASSing gate's noted_for_followup findings are surfaced, not silently dropped", () => {
    const cwd = track(makeTargetProject());
    seedGate(cwd, "stage-04b", {
      stage: "stage-04b",
      security_approved: true,
      veto: false,
      triggering_conditions: ["review-only track: full-repo sweep"],
      noted_for_followup: [
        {
          id: "SEC-01",
          text: "Harden pegasus-armour's PR-diff-to-LLM prompt against injected instructions.",
          track_for: "ticket",
          severity: "low",
          assigned_to: "platform",
          file: "pegasus-armour/index.js:633",
        },
      ],
    });
    // No BLOCKER: lines at all — a clean pass with only informational notes.
    writeArtifact(cwd, "security-review.md", [
      "# Review by security",
      "",
      "## Findings",
      "",
      "SEC-01 — informational, bounded.",
      "",
      "## Verdict",
      "",
      "REVIEW: APPROVED",
      "",
    ].join("\n"));

    const data = collectFindings(cwd, {});
    const found = data.findings.find((f) => f.id === "SEC-01");
    assert.ok(found, "a PASSing security-review gate's noted_for_followup must still surface");
    assert.match(found.summary, /Harden pegasus-armour/);
    assert.equal(found.file, "pegasus-armour/index.js");
    assert.equal(found.line, 633);
    assert.equal(found.severity, "low");
    assert.equal(found.source, "security-review (noted for follow-up)");
  });

  it("mkFinding's own defense-in-depth: a doubly-nested non-string value (describeItem's own return value being an object) still degrades to the placeholder, never [object Object]", () => {
    // mkFinding isn't exported (deliberately internal) — exercise it through
    // a real collector input where describeItem(entry) itself resolves to
    // an object one level down (a malformed .scenario that's an object, not
    // text) — the exact shape mkFinding's own asText() guard exists for.
    const cwd = track(makeTargetProject());
    seedGate(cwd, "stage-05", {
      stage: "stage-05",
      blockers: [{ id: "X-1", severity: "high", scenario: { nested: "not a string at all" } }],
    });
    const data = collectFindings(cwd, {});
    const found = data.findings.find((f) => f.id === "X-1");
    assert.ok(found);
    assert.doesNotMatch(String(found.summary), /\[object Object\]/);
  });
});

describe("collectFindings: empty case", () => {
  it("returns zero findings and an honest sourcesScanned when nothing is present", () => {
    const cwd = track(makeTargetProject());
    const data = collectFindings(cwd, {});
    assert.equal(data.counts.total, 0);
    assert.deepEqual(data.findings, []);
    assert.ok(data.meta.sourcesScanned.every((s) => s.present === false));
  });

  it("renderFindingsHtml renders an honest empty state, not a broken table", () => {
    const cwd = track(makeTargetProject());
    const html = renderFindingsHtml(collectFindings(cwd, {}));
    assert.match(html, /No findings were detected/);
    assert.doesNotMatch(html, /<table>/);
  });
});

describe("renderFindingsHtml: non-empty case", () => {
  it("renders a table row per finding with severity/provenance badges", () => {
    const cwd = track(makeTargetProject());
    seedGate(cwd, "stage-04b", { stage: "stage-04b", security_approved: false, veto: true, triggering_conditions: [] });
    const html = renderFindingsHtml(collectFindings(cwd, {}));
    assert.match(html, /<table>/);
    assert.match(html, /CRITICAL/);
    assert.match(html, /model-asserted/);
  });
});

describe("parseMarkdownFindingBlocks", () => {
  it("parses both the red-team '### ID — title' style and the audit '#### Finding ID: title' style", () => {
    const text = [
      "### RT-1 — Something broke",
      "",
      "- **Severity:** high",
      "- **Where:** `src/a.js:1`",
      "- **Suggested fix:** do the thing.",
      "",
      "#### Finding S1: Hardcoded key",
      "",
      "- **Where:** `src/b.js:2`",
      "- **Severity:** critical.",
      "- **Suggested fix:** use env var.",
      "",
    ].join("\n");
    const blocks = parseMarkdownFindingBlocks(text);
    assert.equal(blocks.size, 2);
    assert.equal(blocks.get("RT-1").title, "Something broke");
    assert.equal(blocks.get("RT-1").fields.where, "`src/a.js:1`");
    assert.equal(blocks.get("S1").title, "Hardcoded key");
    assert.equal(blocks.get("S1").fields.severity, "critical.");
  });

  it("folds wrapped bullet continuation lines into the same field", () => {
    const text = [
      "### S-1 — Multi-line locations",
      "",
      "- **Locations:** `a.js:1`, `b.js:2`,",
      "  and additional callers.",
      "- **Suggested fix:** escape everything.",
      "",
    ].join("\n");
    const blocks = parseMarkdownFindingBlocks(text);
    assert.match(blocks.get("S-1").fields.where, /a\.js:1/);
    assert.match(blocks.get("S-1").fields.where, /additional callers/);
  });

  it("returns an empty map for text with no recognizable finding headings", () => {
    const blocks = parseMarkdownFindingBlocks("## Just a section\n\nSome prose, no findings here.\n");
    assert.equal(blocks.size, 0);
  });
});

describe("audit findings (docs/audit/*.md)", () => {
  it("is skipped when docs/audit/status.json is absent", () => {
    const cwd = track(makeTargetProject());
    fs.mkdirSync(path.join(cwd, "docs", "audit"), { recursive: true });
    fs.writeFileSync(path.join(cwd, "docs", "audit", "06-security.md"), "### S-1 — X\n\n- **Severity:** high\n");
    const data = collectFindings(cwd, {});
    const auditPresent = data.meta.sourcesScanned.find((s) => s.source === "audit").present;
    assert.equal(auditPresent, false);
    assert.equal(data.findings.filter((f) => f.source.startsWith("audit:")).length, 0);
  });

  it("collects findings once docs/audit/status.json exists (audit workflow has run)", () => {
    const cwd = track(makeTargetProject());
    const auditDir = path.join(cwd, "docs", "audit");
    fs.mkdirSync(auditDir, { recursive: true });
    fs.writeFileSync(path.join(auditDir, "status.json"), JSON.stringify({ started: "2026-08-01T00:00:00Z" }));
    fs.writeFileSync(path.join(auditDir, "06-security.md"), [
      "# 06 — Security review",
      "",
      "## Findings",
      "",
      "### S-1 — Model-authored gate strings inserted into dashboard innerHTML",
      "",
      "- **Severity:** medium.",
      "- **Locations:** `core/ui/static/app.js:178`",
      "- **Suggested fix:** use textContent.",
      "",
    ].join("\n"));
    const data = collectFindings(cwd, {});
    const found = data.findings.find((f) => f.id === "S-1");
    assert.ok(found, "audit finding S-1 not collected");
    assert.equal(found.severity, "medium");
    assert.equal(found.provenance, PROVENANCE.ASSERTED);
    assert.equal(found.file, "core/ui/static/app.js");
    assert.equal(found.line, 178);
    assert.match(found.mitigation, /textContent/);
    assert.equal(found.source, "audit:06-security");
  });
});

describe("devteam report --findings (CLI)", () => {
  it("writes pipeline/findings-report.html by default", () => {
    const cwd = track(makeTargetProject());
    seedGate(cwd, "stage-04b", { stage: "stage-04b", security_approved: false, veto: true, triggering_conditions: [] });
    const result = runCLI(["report", "--findings", "--no-open"], { cwd });
    assert.equal(result.status, 0, result.stderr);
    const outPath = path.join(cwd, "pipeline", "findings-report.html");
    assert.ok(fs.existsSync(outPath));
    const html = fs.readFileSync(outPath, "utf8");
    assert.match(html, /Findings Report/);
  });

  it("--json emits data matching the checked-in schema's required shape", () => {
    const cwd = track(makeTargetProject());
    seedGate(cwd, "stage-04b", { stage: "stage-04b", security_approved: false, veto: true, triggering_conditions: [] });
    const result = runCLI(["report", "--findings", "--json"], { cwd });
    assert.equal(result.status, 0, result.stderr);
    const data = JSON.parse(result.stdout);

    const schema = JSON.parse(fs.readFileSync(
      path.join(REPO_ROOT, "core", "report", "schemas", "findings-report.schema.json"), "utf8",
    ));
    assert.equal(schema.$id, "urn:stagecraft:schema:findings-report");
    for (const key of schema.required) assert.ok(key in data, `top-level output missing required "${key}"`);
    for (const key of schema.properties.meta.required) assert.ok(key in data.meta, `meta missing required "${key}"`);
    for (const key of schema.properties.counts.required) assert.ok(key in data.counts, `counts missing required "${key}"`);
    const findingKeys = schema.properties.findings.items.required;
    for (const f of data.findings) {
      for (const key of findingKeys) assert.ok(key in f, `finding ${JSON.stringify(f.id)} missing required "${key}"`);
      assert.ok(["critical", "high", "medium", "low", "unknown"].includes(f.severity));
      assert.ok(["orchestrator-observed", "model-asserted"].includes(f.provenance));
    }
  });

  it("--out writes to the given path", () => {
    const cwd = track(makeTargetProject());
    const outPath = path.join(cwd, "custom-findings.html");
    const result = runCLI(["report", "--findings", "--out", outPath, "--no-open"], { cwd });
    assert.equal(result.status, 0, result.stderr);
    assert.ok(fs.existsSync(outPath));
  });
});
