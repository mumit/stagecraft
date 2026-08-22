// Phase 42.6: `devteam doctor` distinguishes a committed install from a
// checkout-local one.
//
// The two shapes have opposite consequences. A committed install tracks
// `.devteam/` so teammates share the configuration and a framework change
// appears in the diff. A checkout-local (dogfood) install gitignores it so the
// framework stays out of the product diff -- the point when the project being
// built is Stagecraft itself.
//
// doctor reported the install's health and never which shape it was looking at,
// so a deliberately-local setup and a committed one that had lost its files
// looked identical, and they need opposite fixes.
//
// Detection reads git rather than a recorded flag: a flag drifts from what the
// repository actually does, and what it does is what matters.

const { describe, it, afterEach } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { spawnSync } = require("node:child_process");
const { resolveInstallMode, describeInstallMode } = require("../core/install-mode");
const { DOGFOOD_BLOCK_BEGIN, DOGFOOD_BLOCK_END } = require("../core/gitignore");

let dirs = [];
afterEach(() => {
  dirs.forEach((d) => fs.rmSync(d, { recursive: true, force: true }));
  dirs = [];
});

function project({ git: useGit = true, config = true, gitignore = null, commitConfig = false } = {}) {
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "installmode-"));
  dirs.push(cwd);
  const run = (...args) => spawnSync("git", args, { cwd, encoding: "utf8" });
  if (useGit) {
    run("init", "-q");
    run("config", "user.email", "t@example.com");
    run("config", "user.name", "T");
  }
  if (gitignore !== null) fs.writeFileSync(path.join(cwd, ".gitignore"), gitignore);
  if (useGit) {
    fs.writeFileSync(path.join(cwd, "README.md"), "# p\n");
    run("add", "-A");
    run("commit", "-qm", "init");
  }
  if (config) {
    fs.mkdirSync(path.join(cwd, ".devteam"), { recursive: true });
    fs.writeFileSync(path.join(cwd, ".devteam", "config.yml"), "routing:\n  default_host: generic\n");
    if (commitConfig) { run("add", "-A"); run("commit", "-qm", "config"); }
  }
  return cwd;
}
const DOGFOOD = `.devteam/\n${DOGFOOD_BLOCK_BEGIN}\npipeline/\n${DOGFOOD_BLOCK_END}\n`;

describe("resolveInstallMode", () => {
  it("reports committed when the config is tracked", () => {
    const m = resolveInstallMode(project({ commitConfig: true }));
    assert.equal(m.mode, "committed");
    assert.match(m.reason, /is tracked/);
  });

  it("reports checkout-local when the config is gitignored", () => {
    const m = resolveInstallMode(project({ gitignore: ".devteam/\n" }));
    assert.equal(m.mode, "checkout-local");
    assert.equal(m.dogfoodProfile, false);
  });

  it("recognizes the dogfood profile by its gitignore block", () => {
    const m = resolveInstallMode(project({ gitignore: DOGFOOD }));
    assert.equal(m.mode, "checkout-local");
    assert.equal(m.dogfoodProfile, true);
  });

  it("reports untracked separately from checkout-local", () => {
    // Neither shape. Folding it into checkout-local would hide an install
    // nobody finished behind a description of a deliberate choice.
    const m = resolveInstallMode(project());
    assert.equal(m.mode, "untracked");
  });

  it("reports no-git outside a repository", () => {
    assert.equal(resolveInstallMode(project({ git: false })).mode, "no-git");
  });

  it("reports absent before init has run", () => {
    assert.equal(resolveInstallMode(project({ config: false })).mode, "absent");
  });
});

describe("describeInstallMode: the advice matches the shape", () => {
  it("offers no remedy for either deliberate shape", () => {
    assert.equal(describeInstallMode({ mode: "committed", dogfoodProfile: false }).advice, null);
    assert.equal(describeInstallMode({ mode: "checkout-local", dogfoodProfile: true }).advice, null);
  });

  it("tells an untracked install both ways out", () => {
    const d = describeInstallMode({ mode: "untracked", dogfoodProfile: false });
    assert.match(d.advice, /commit it/);
    assert.match(d.advice, /--profile dogfood/);
  });

  it("flags a checkout-local install that never opted in", () => {
    const d = describeInstallMode({ mode: "checkout-local", dogfoodProfile: false });
    assert.match(d.advice, /teammates will not inherit it/);
  });

  it("flags the contradiction of a dogfood block over a tracked config", () => {
    const d = describeInstallMode({ mode: "committed", dogfoodProfile: true });
    assert.match(d.advice, /one of the two is stale/);
  });

  it("names init as the remedy when nothing is initialized", () => {
    assert.match(describeInstallMode({ mode: "absent" }).advice, /devteam init/);
  });
});

describe("doctor surfaces it", () => {
  const doctor = (cwd) => spawnSync(process.execPath,
    [path.join(__dirname, "..", "bin", "devteam"), "doctor"], { cwd, encoding: "utf8" });

  it("prints the mode for a committed install", () => {
    const out = doctor(project({ commitConfig: true })).stdout;
    assert.match(out, /install mode.*committed/);
  });

  it("prints the dogfood profile when it is in use", () => {
    const out = doctor(project({ gitignore: DOGFOOD })).stdout;
    assert.match(out, /install mode.*checkout-local \(dogfood profile\)/);
  });

  it("warns only on the shape that is neither", () => {
    assert.match(doctor(project()).stdout, /⚠ install mode/);
    assert.match(doctor(project({ commitConfig: true })).stdout, /ℹ install mode/);
  });
});
