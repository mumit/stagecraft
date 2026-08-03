"use strict";

// Phase-34 item 34.2 — gate chain -> in-toto-Statement-shaped attestation.
// Covers: fixture pipeline -> schema-valid bundle; tamper -> verify fails;
// broken chain refusal (and --allow-unverified escape hatch); ADR-012
// accepted resolutions appear; --sign path via a stubbed cosign on PATH.

const { describe, it, afterEach } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { spawnSync } = require("node:child_process");
const { REPO_ROOT, makeTargetProject, seedGate, cleanup, runCLI } = require("./_helpers");
const {
  createAttestation, validateAttestation, readAttestation, writeAttestation, signAttestation,
  PREDICATE_TYPE, STATEMENT_TYPE,
} = require(path.join(REPO_ROOT, "core", "evidence", "attestation"));
const { stampAll } = require(path.join(REPO_ROOT, "core", "gates", "chain"));
const { schemaFingerprint, sourceEventRef } = require(path.join(REPO_ROOT, "core", "evidence", "resolutions"));

let dirs = [];
function track(cwd) { dirs.push(cwd); return cwd; }
afterEach(() => { dirs.forEach(cleanup); dirs = []; });

function gatesDirOf(cwd) { return path.join(cwd, "pipeline", "gates"); }

function initGitRepo(cwd) {
  spawnSync("git", ["init"], { cwd, encoding: "utf8" });
  spawnSync("git", ["config", "user.email", "test@example.com"], { cwd });
  spawnSync("git", ["config", "user.name", "Test"], { cwd });
  fs.writeFileSync(path.join(cwd, "README.md"), "fixture\n");
  spawnSync("git", ["add", "."], { cwd, encoding: "utf8" });
  spawnSync("git", ["commit", "--no-gpg-sign", "-m", "init"], { cwd, encoding: "utf8" });
}

function currentHead(cwd) {
  return spawnSync("git", ["rev-parse", "HEAD"], { cwd, encoding: "utf8" }).stdout.trim();
}

// Seeds stage-01/02/03 as PASS, stamps the chain, and inits a git repo so
// subject-commit resolution has a real HEAD to find.
function seedFixturePipeline(cwd) {
  initGitRepo(cwd);
  seedGate(cwd, "stage-01", { status: "PASS", model: "claude-opus-4-7", tokens_in: 1000, cost_usd: 0.05 });
  seedGate(cwd, "stage-02", { status: "PASS" });
  seedGate(cwd, "stage-03", { status: "PASS" });
  stampAll(gatesDirOf(cwd), "full", { secret: null });
}

function seedAcceptedResolution(cwd) {
  const source = {
    outcome: "fix-retry", stage: "stage-04", failure_class: "code-defect",
    attempt: 1, cleared_gates: 1, derivable: true,
  };
  const event = {
    ts: "2026-07-01T00:00:00Z",
    outcome: "resolution-accepted",
    source_event_sha256: sourceEventRef(source),
    stage: "stage-04",
    failure_class: "code-defect",
    schema_fingerprint: schemaFingerprint("stage-04"),
    derivable: true,
  };
  fs.appendFileSync(path.join(cwd, "pipeline", "run-log.jsonl"), `${JSON.stringify(event)}\n`);
}

describe("attestation: create + schema", () => {
  it("produces a schema-valid, self-verifying bundle from a fixture pipeline", () => {
    const cwd = track(makeTargetProject());
    seedFixturePipeline(cwd);
    const att = createAttestation(cwd, null, "full", {});
    assert.equal(att._type, STATEMENT_TYPE);
    assert.equal(att.predicateType, PREDICATE_TYPE);
    assert.equal(att.predicate.stages.length, 3);
    assert.equal(att.predicate.unverified, false);
    assert.deepEqual(validateAttestation(att, { verifyDigest: true }), []);
    assert.deepEqual(att.subject, [{ name: "commit", digest: { sha1: currentHead(cwd) } }]);
  });

  it("records per-field provenance and C4 reproducibility fields on stage entries", () => {
    const cwd = track(makeTargetProject());
    seedFixturePipeline(cwd);
    const att = createAttestation(cwd, null, "full", {});
    const stage01 = att.predicate.stages.find((s) => s.stage === "stage-01");
    const modelField = stage01.provenance.find((p) => p.field === "model");
    assert.equal(modelField.model_asserted, "claude-opus-4-7");
    assert.equal(modelField.orchestrator_kind, null);
    assert.equal(stage01.reproducibility.model, "claude-opus-4-7");
    assert.equal(stage01.chain.prev_stage, null);
    assert.equal(stage01.chain.hmac_present, false);
  });

  it("surfaces orchestrator-observed usage distinctly from the model-asserted value", () => {
    const cwd = track(makeTargetProject());
    initGitRepo(cwd);
    seedGate(cwd, "stage-01", {
      status: "PASS",
      model: "claude-opus-4-7",
      tokens_in: 1000,
      _orchestrator_observed: { tokens_in: 950, model_observed: "claude-opus-4-7-20251104", source: "claude-code:stream-json", at: "2026-07-01T00:00:00Z" },
    });
    stampAll(gatesDirOf(cwd), "full", { secret: null });
    const att = createAttestation(cwd, null, "full", {});
    const stage01 = att.predicate.stages.find((s) => s.stage === "stage-01");
    const tokensIn = stage01.provenance.find((p) => p.field === "tokens_in");
    assert.equal(tokensIn.model_asserted, 1000);
    assert.equal(tokensIn.orchestrator_value, 950);
    assert.equal(tokensIn.orchestrator_kind, "observed");
  });

  it("publishes a strict, closed JSON Schema mirroring validateAttestation", () => {
    const schema = JSON.parse(fs.readFileSync(path.join(
      REPO_ROOT, "core", "evidence", "schemas", "attestation.schema.json",
    ), "utf8"));
    assert.equal(schema.$schema, "https://json-schema.org/draft/2020-12/schema");
    assert.equal(schema.additionalProperties, false);
    for (const [entryName, definition] of Object.entries(schema.$defs)) {
      if (definition.type === "object") {
        assert.equal(definition.additionalProperties, false, `${entryName} must be closed`);
      }
    }
  });
});

describe("attestation: ADR-012 accepted resolutions", () => {
  it("includes accepted resolutions as their own predicate entries", () => {
    const cwd = track(makeTargetProject());
    seedFixturePipeline(cwd);
    seedAcceptedResolution(cwd);
    const att = createAttestation(cwd, null, "full", {});
    assert.equal(att.predicate.resolutions.length, 1);
    assert.equal(att.predicate.resolutions[0].stage, "stage-04");
    assert.equal(att.predicate.resolutions[0].failure_class, "code-defect");
    assert.equal(att.predicate.resolutions[0].derivable, true);
  });
});

describe("attestation: broken chain refusal", () => {
  it("refuses to attest when the chain is broken", () => {
    const cwd = track(makeTargetProject());
    seedFixturePipeline(cwd);
    const p1 = path.join(gatesDirOf(cwd), "stage-01.json");
    const g1 = JSON.parse(fs.readFileSync(p1, "utf8"));
    g1.status = "FAIL";
    fs.writeFileSync(p1, JSON.stringify(g1, null, 2));
    assert.throws(() => createAttestation(cwd, null, "full", {}), /refusing to attest/);
  });

  it("--allow-unverified attests anyway and stamps the bundle unverified", () => {
    const cwd = track(makeTargetProject());
    seedFixturePipeline(cwd);
    const p1 = path.join(gatesDirOf(cwd), "stage-01.json");
    const g1 = JSON.parse(fs.readFileSync(p1, "utf8"));
    g1.status = "FAIL";
    fs.writeFileSync(p1, JSON.stringify(g1, null, 2));
    const att = createAttestation(cwd, null, "full", { allowUnverified: true });
    assert.equal(att.predicate.unverified, true);
    assert.equal(att.predicate.chain_verification.ok, false);
    assert.deepEqual(validateAttestation(att, { verifyDigest: true }), []);
  });

  it("throws a clear error when no commit can be found", () => {
    const cwd = track(makeTargetProject());
    seedGate(cwd, "stage-01", { status: "PASS" });
    stampAll(gatesDirOf(cwd), "full", { secret: null });
    assert.throws(() => createAttestation(cwd, null, "full", {}), /no producible commit found/);
  });
});

describe("attestation: read/write + tamper detection", () => {
  it("round-trips through writeAttestation/readAttestation", () => {
    const cwd = track(makeTargetProject());
    seedFixturePipeline(cwd);
    const att = createAttestation(cwd, null, "full", {});
    const file = path.join(cwd, "attestation.json");
    writeAttestation(file, att);
    const reread = readAttestation(file);
    assert.deepEqual(reread, att);
  });

  it("detects tampering via the payload digest", () => {
    const cwd = track(makeTargetProject());
    seedFixturePipeline(cwd);
    const att = createAttestation(cwd, null, "full", {});
    const file = path.join(cwd, "attestation.json");
    writeAttestation(file, att);
    const tampered = JSON.parse(fs.readFileSync(file, "utf8"));
    tampered.predicate.unverified = true;
    fs.writeFileSync(file, JSON.stringify(tampered, null, 2));
    assert.throws(() => readAttestation(file), /digest mismatch/);
  });

  it("refuses a second write to the same destination", () => {
    const cwd = track(makeTargetProject());
    seedFixturePipeline(cwd);
    const att = createAttestation(cwd, null, "full", {});
    const file = path.join(cwd, "attestation.json");
    writeAttestation(file, att);
    assert.throws(() => writeAttestation(file, att), /already exists/);
  });
});

describe("attestation CLI", () => {
  it("devteam evidence export --attestation writes a bundle devteam evidence verify-attestation accepts", () => {
    const cwd = track(makeTargetProject());
    seedFixturePipeline(cwd);
    const out = path.join(cwd, "att.json");
    const exported = runCLI(["evidence", "export", "--attestation", "--out", out, "--cwd", cwd, "--json"]);
    assert.equal(exported.status, 0, exported.stderr);
    const payload = JSON.parse(exported.stdout);
    assert.equal(payload.stages, 3);
    assert.equal(payload.unverified, false);

    const verified = runCLI(["evidence", "verify-attestation", out, "--json"]);
    assert.equal(verified.status, 0, verified.stderr);
    assert.equal(JSON.parse(verified.stdout).ok, true);
  });

  it("verify-attestation fails on a tampered bundle", () => {
    const cwd = track(makeTargetProject());
    seedFixturePipeline(cwd);
    const out = path.join(cwd, "att.json");
    runCLI(["evidence", "export", "--attestation", "--out", out, "--cwd", cwd]);
    const bundle = JSON.parse(fs.readFileSync(out, "utf8"));
    bundle.predicate.track = "quick";
    fs.writeFileSync(out, JSON.stringify(bundle, null, 2));
    const verified = runCLI(["evidence", "verify-attestation", out, "--json"]);
    assert.equal(verified.status, 1);
    assert.match(JSON.parse(verified.stdout).error, /digest mismatch/);
  });

  it("refuses export on a broken chain and accepts --allow-unverified", () => {
    const cwd = track(makeTargetProject());
    seedFixturePipeline(cwd);
    const p1 = path.join(gatesDirOf(cwd), "stage-01.json");
    const g1 = JSON.parse(fs.readFileSync(p1, "utf8"));
    g1.status = "FAIL";
    fs.writeFileSync(p1, JSON.stringify(g1, null, 2));

    const refused = runCLI(["evidence", "export", "--attestation", "--out", path.join(cwd, "refused.json"), "--cwd", cwd]);
    assert.equal(refused.status, 1);
    assert.match(refused.stderr, /refusing to attest/);
    assert.equal(fs.existsSync(path.join(cwd, "refused.json")), false);

    const out = path.join(cwd, "unverified.json");
    const allowed = runCLI(["evidence", "export", "--attestation", "--out", out, "--cwd", cwd, "--allow-unverified", "--json"]);
    assert.equal(allowed.status, 0, allowed.stderr);
    assert.equal(JSON.parse(allowed.stdout).unverified, true);
  });
});

describe("attestation --sign (stubbed cosign)", () => {
  // A minimal PATH that still resolves `node` (runCLI spawns it directly),
  // `git` (needed for subject-commit resolution), and `which`/`where`
  // (needed for the cosign presence probe) — but excludes the typical
  // homebrew/local-install directories a real cosign would live in, so this
  // test is honest about cosign's absence rather than merely hoping the
  // sandbox doesn't have it installed.
  function pathWithoutCosign() {
    const probe = spawnSync(process.platform === "win32" ? "where" : "which", ["git"], { encoding: "utf8" });
    const gitDir = path.dirname(probe.stdout.trim().split("\n")[0]);
    const nodeDir = path.dirname(process.execPath);
    return [nodeDir, gitDir, "/usr/bin", "/bin"].join(path.delimiter);
  }

  function makeStubBin(script) {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "devteam-test-cosign-"));
    const binPath = path.join(dir, "cosign");
    fs.writeFileSync(binPath, script);
    fs.chmodSync(binPath, 0o755);
    return dir;
  }

  it("shells to cosign sign-blob and writes a detached signature", () => {
    const cwd = track(makeTargetProject());
    seedFixturePipeline(cwd);
    const stubDir = track(makeStubBin(
      "#!/bin/sh\n"
      + "out=\"\"; prev=\"\"\n"
      + "for arg in \"$@\"; do\n"
      + "  if [ \"$prev\" = \"--output-signature\" ]; then out=\"$arg\"; fi\n"
      + "  prev=\"$arg\"\n"
      + "done\n"
      + "[ -n \"$out\" ] && echo stub-signature > \"$out\"\n"
      + "exit 0\n",
    ));
    const out = path.join(cwd, "att.json");
    const result = runCLI(["evidence", "export", "--attestation", "--out", out, "--cwd", cwd, "--sign", "--json"], {
      env: { PATH: `${stubDir}${path.delimiter}${process.env.PATH}` },
    });
    assert.equal(result.status, 0, result.stderr);
    const payload = JSON.parse(result.stdout);
    assert.equal(payload.signature, `${out}.sig`);
    assert.equal(fs.readFileSync(`${out}.sig`, "utf8").trim(), "stub-signature");
  });

  it("fails clearly when cosign is not on PATH", () => {
    const cwd = track(makeTargetProject());
    seedFixturePipeline(cwd);
    const out = path.join(cwd, "att.json");
    const result = runCLI(["evidence", "export", "--attestation", "--out", out, "--cwd", cwd, "--sign"], {
      env: { PATH: pathWithoutCosign() },
    });
    assert.equal(result.status, 1);
    assert.match(result.stderr, /cosign CLI on PATH/);
    assert.equal(fs.existsSync(out), true, "the bundle itself is still written even though signing failed");
  });

  it("fails clearly when cosign errors", () => {
    const cwd = track(makeTargetProject());
    seedFixturePipeline(cwd);
    const stubDir = track(makeStubBin("#!/bin/sh\necho 'cosign: signing backend unavailable' >&2\nexit 1\n"));
    const out = path.join(cwd, "att.json");
    const result = runCLI(["evidence", "export", "--attestation", "--out", out, "--cwd", cwd, "--sign"], {
      env: { PATH: `${stubDir}${path.delimiter}${process.env.PATH}` },
    });
    assert.equal(result.status, 1);
    assert.match(result.stderr, /signing backend unavailable/);
  });

  it("unit: signAttestation() throws when cosign is absent", () => {
    const cwd = track(makeTargetProject());
    seedFixturePipeline(cwd);
    const att = createAttestation(cwd, null, "full", {});
    const file = path.join(cwd, "att.json");
    writeAttestation(file, att);
    const originalPath = process.env.PATH;
    process.env.PATH = "/nonexistent-bin-dir";
    try {
      assert.throws(() => signAttestation(file), /cosign CLI on PATH/);
    } finally {
      process.env.PATH = originalPath;
    }
  });
});
