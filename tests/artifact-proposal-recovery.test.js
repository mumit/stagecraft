// Recovering an apply that was interrupted mid-transaction.
//
// applyProposal moves the gates a refinement invalidates into a .apply-<id>
// directory, rewrites the artifact, then deletes the directory. If the process
// dies in between, the rollback deliberately preserves that directory rather
// than risk losing the gates -- but nothing used to put them back, and the
// consequences compounded: the next apply saw a smaller gate set, marked the
// proposal permanently stale, and blamed "its invalidation set changed" while
// the operator's gate sat inside a dotted directory nothing mentions.

const { describe, it, afterEach } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { createProposal, applyProposal, listProposals } = require("../core/artifact-proposals");

let dirs = [];
afterEach(() => {
  dirs.forEach((d) => fs.rmSync(d, { recursive: true, force: true }));
  dirs = [];
});

function project({ gates = ["stage-01.json", "stage-04.json"] } = {}) {
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "proposal-"));
  dirs.push(cwd);
  fs.mkdirSync(path.join(cwd, ".devteam"), { recursive: true });
  fs.mkdirSync(path.join(cwd, "pipeline", "gates"), { recursive: true });
  fs.writeFileSync(path.join(cwd, ".devteam", "config.yml"),
    "routing:\n  default_host: generic\npipeline:\n  default_track: full\n");
  fs.writeFileSync(path.join(cwd, "pipeline", "brief.md"), "# Brief\n\noriginal\n");
  for (const g of gates) {
    fs.writeFileSync(path.join(cwd, "pipeline", "gates", g), `{"stage":"${g.replace(".json", "")}"}\n`);
  }
  const proposal = createProposal({
    cwd, kind: "requirements", replacement: "# Brief\n\nrevised\n", host: "generic",
  });
  return { cwd, id: proposal.id };
}
const txDir = (cwd, id) => path.join(cwd, "pipeline", "proposals", `.apply-${id}`);
const gate = (cwd, name) => path.join(cwd, "pipeline", "gates", name);
const events = (cwd) => fs.readFileSync(path.join(cwd, "pipeline", "proposals", "events.jsonl"), "utf8")
  .trim().split("\n").map((l) => JSON.parse(l).event);

describe("interrupted apply: gates the transaction had already moved", () => {
  it("restores them, then applies instead of going permanently stale", () => {
    const { cwd, id } = project();
    fs.mkdirSync(txDir(cwd, id), { recursive: true });
    fs.renameSync(gate(cwd, "stage-01.json"), path.join(txDir(cwd, id), "stage-01.json"));

    const applied = applyProposal(cwd, null, id);
    assert.equal(applied.status, "applied");
    assert.equal(fs.existsSync(txDir(cwd, id)), false, "the transaction directory is cleaned up");
    assert.match(fs.readFileSync(path.join(cwd, "pipeline", "brief.md"), "utf8"), /revised/);
  });

  it("records the recovery as its own event", () => {
    const { cwd, id } = project();
    fs.mkdirSync(txDir(cwd, id), { recursive: true });
    fs.renameSync(gate(cwd, "stage-01.json"), path.join(txDir(cwd, id), "stage-01.json"));
    applyProposal(cwd, null, id);
    assert.deepEqual(events(cwd), ["created", "recovered", "applied"]);
  });

  it("does not log a recovery when there was nothing to recover", () => {
    const { cwd, id } = project();
    applyProposal(cwd, null, id);
    assert.deepEqual(events(cwd), ["created", "applied"]);
  });

  it("never overwrites a gate that exists now", () => {
    // A live gate is always newer than one an interrupted transaction set
    // aside; restoring over it would resurrect a stale verdict.
    const { cwd, id } = project();
    fs.mkdirSync(txDir(cwd, id), { recursive: true });
    fs.writeFileSync(path.join(txDir(cwd, id), "stage-01.json"), '{"stale":"from-transaction"}\n');
    fs.writeFileSync(gate(cwd, "stage-01.json"), '{"live":"current"}\n');

    assert.throws(() => applyProposal(cwd, null, id), /cannot be applied/);
    assert.match(fs.readFileSync(gate(cwd, "stage-01.json"), "utf8"), /live/);
    assert.ok(fs.existsSync(txDir(cwd, id)), "the unrestorable file stays visible");
  });
});

describe("interrupted apply: an empty or unexplained transaction directory", () => {
  it("proceeds when the directory is empty", () => {
    // Previously a bare EEXIST from mkdir, which told the operator nothing.
    const { cwd, id } = project();
    fs.mkdirSync(txDir(cwd, id), { recursive: true });
    assert.equal(applyProposal(cwd, null, id).status, "applied");
  });

  it("explains what is in the way instead of surfacing EEXIST", () => {
    const { cwd, id } = project();
    fs.mkdirSync(txDir(cwd, id), { recursive: true });
    fs.writeFileSync(path.join(txDir(cwd, id), "notes.txt"), "something else\n");

    assert.throws(() => applyProposal(cwd, null, id), (err) => {
      assert.doesNotMatch(err.message, /EEXIST/);
      assert.match(err.message, /an interrupted apply left pipeline\/proposals\/\.apply-/);
      assert.match(err.message, /holding notes\.txt/);
      assert.match(err.message, /remove it and retry/);
      return true;
    });
    assert.equal(listProposals(cwd, null)[0].status, "pending",
      "an unapplicable retry must not consume the proposal");
  });

  it("leaves a non-gate file alone rather than moving it into gates/", () => {
    const { cwd, id } = project();
    fs.mkdirSync(txDir(cwd, id), { recursive: true });
    fs.writeFileSync(path.join(txDir(cwd, id), "notes.txt"), "x\n");
    try { applyProposal(cwd, null, id); } catch { /* expected */ }
    assert.equal(fs.existsSync(gate(cwd, "notes.txt")), false);
    assert.ok(fs.existsSync(path.join(txDir(cwd, id), "notes.txt")));
  });
});
