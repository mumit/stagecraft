// Phase-28 item 28.4: `devteam report` displays cost_basis alongside cost_usd.
// core/report/collect.js reads run-state.json (written once per run by
// core/driver.js) and surfaces the field on meta.costBasis; render-html.js
// renders it next to the cost figure.

const { describe, it, afterEach } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { makeTargetProject, cleanup } = require("./_helpers");
const { collectReport } = require("../core/report/collect");
const { renderHtml } = require("../core/report/render-html");

let _dirs = [];
function track(cwd) { _dirs.push(cwd); return cwd; }
afterEach(() => { _dirs.forEach(cleanup); _dirs = []; });

function writeRunState(cwd, state) {
  const p = path.join(cwd, "pipeline", "run-state.json");
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(p, JSON.stringify(state, null, 2));
}

describe("collectReport: cost_basis (28.4)", () => {
  it("surfaces meta.costBasis from run-state.json", () => {
    const cwd = track(makeTargetProject());
    writeRunState(cwd, {
      track: "full",
      intent: "feature",
      iterations: 3,
      cost_usd: 7.5,
      cost_basis: "mixed",
      started_at: new Date().toISOString(),
    });

    const data = collectReport(cwd, {});
    assert.equal(data.meta.costUsd, 7.5);
    assert.equal(data.meta.costBasis, "mixed");
  });

  it("meta.costBasis is null when run-state.json predates the field", () => {
    const cwd = track(makeTargetProject());
    writeRunState(cwd, {
      track: "full",
      intent: "feature",
      iterations: 1,
      cost_usd: 1,
      started_at: new Date().toISOString(),
    });

    const data = collectReport(cwd, {});
    assert.equal(data.meta.costBasis, null);
  });

  it("renderHtml renders the basis next to the cost figure when not purely observed", () => {
    const cwd = track(makeTargetProject());
    writeRunState(cwd, {
      track: "full", intent: "feature", iterations: 2, cost_usd: 3, cost_basis: "mixed",
      started_at: new Date().toISOString(),
    });
    const html = renderHtml(collectReport(cwd, {}));
    assert.match(html, /\$3\.00/);
    assert.match(html, /mixed/);
  });

  it("renderHtml omits the basis annotation when the basis is 'observed'", () => {
    const cwd = track(makeTargetProject());
    writeRunState(cwd, {
      track: "full", intent: "feature", iterations: 2, cost_usd: 3, cost_basis: "observed",
      started_at: new Date().toISOString(),
    });
    const html = renderHtml(collectReport(cwd, {}));
    assert.match(html, /\$3\.00/);
    assert.doesNotMatch(html, />observed</);
  });
});
