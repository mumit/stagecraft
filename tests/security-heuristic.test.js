const { describe, it, afterEach } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { execFileSync } = require("node:child_process");
const { REPO_ROOT } = require("./_helpers");
const { needsSecurityReview, analyze, contentFindings, PATH_PATTERNS } =
  require(path.join(REPO_ROOT, "core", "guards", "security-heuristic"));

// mkdtempSync's random 6-char suffix occasionally spells "pii" or "auth" by
// pure chance (measured ~1 in 7,400) — PATH_PATTERNS then matches that
// against the *absolute* tmpdir path every "safe path" test below passes to
// needsSecurityReview/analyze (real files are required so content-scanning
// reads real content — a plain relative string would resolve against this
// repo's own CWD files instead, e.g. its own real README.md). A genuine,
// reproduced CI flake, not Node-version-specific despite only ever having
// been seen on one job. Retry generation on the (extremely rare) collision
// rather than changing what gets passed to the function under test.
let _dirs = [];
function tmpdir() {
  let d = fs.mkdtempSync(path.join(os.tmpdir(), "devteam-test-sec-heur-"));
  while (PATH_PATTERNS.some((p) => p.test(d))) {
    fs.rmSync(d, { recursive: true, force: true });
    d = fs.mkdtempSync(path.join(os.tmpdir(), "devteam-test-sec-heur-"));
  }
  _dirs.push(d);
  return d;
}
afterEach(() => {
  for (const d of _dirs) try { fs.rmSync(d, { recursive: true, force: true }); } catch { /* test cleanup; ignore */ }
  _dirs = [];
});

function writeFile(dir, relPath, content) {
  const full = path.join(dir, relPath);
  fs.mkdirSync(path.dirname(full), { recursive: true });
  fs.writeFileSync(full, content);
  return full;
}

function initRepo(dir) {
  execFileSync("git", ["init", "-q"], { cwd: dir });
  execFileSync("git", ["config", "user.email", "stagecraft@example.invalid"], { cwd: dir });
  execFileSync("git", ["config", "user.name", "Stagecraft Test"], { cwd: dir });
}

describe("security-heuristic: needsSecurityReview", () => {
  it("flags auth paths", () => {
    const r = needsSecurityReview(["src/backend/auth/login.js"]);
    assert.equal(r.length, 1);
  });

  it("flags crypto paths", () => {
    const r = needsSecurityReview(["src/lib/crypto/token.ts"]);
    assert.equal(r.length, 1);
  });

  it("flags payment paths", () => {
    const r = needsSecurityReview(["src/services/payment-handler.ts"]);
    assert.equal(r.length, 1);
  });

  it("flags pii", () => {
    const r = needsSecurityReview(["src/backend/pii-redaction.js"]);
    assert.equal(r.length, 1);
  });

  it("flags secrets / tokens / credentials", () => {
    assert.equal(needsSecurityReview(["src/secret-rotator.js"]).length, 1);
    assert.equal(needsSecurityReview(["src/auth/tokens.ts"]).length, 1);
    assert.equal(needsSecurityReview(["src/credentials/store.ts"]).length, 1);
  });

  it("flags Dockerfile and docker-compose changes", () => {
    assert.equal(needsSecurityReview(["Dockerfile"]).length, 1);
    assert.equal(needsSecurityReview(["docker-compose.yml"]).length, 1);
  });

  it("flags infra/ directory changes", () => {
    assert.equal(needsSecurityReview(["infra/k8s/deployment.yaml"]).length, 1);
  });

  it("flags package.json/package-lock.json (new deps)", () => {
    assert.equal(needsSecurityReview(["package.json"]).length, 1);
    assert.equal(needsSecurityReview(["package-lock.json"]).length, 1);
  });

  it("does NOT flag safe paths", () => {
    const d = tmpdir();
    const r = needsSecurityReview([
      writeFile(d, "src/frontend/components/Button.tsx", "export const Button = {};\n"),
      writeFile(d, "README.md", "Project overview.\n"),
      writeFile(d, "docs/concepts.md", "Concepts.\n"),
      writeFile(d, "src/utils/format.js", "module.exports = {};\n"),
    ]);
    assert.equal(r.length, 0);
  });

  it("returns the subset of paths that matched", () => {
    const d = tmpdir();
    const readme = writeFile(d, "README.md", "Project overview.\n");
    const auth = writeFile(d, "src/backend/auth.js", "module.exports = {};\n");
    const docs = writeFile(d, "docs/x.md", "Documentation.\n");
    const dockerfile = writeFile(d, "Dockerfile", "FROM node:22\n");
    const r = needsSecurityReview([readme, auth, docs, dockerfile]);
    assert.equal(r.length, 2);
    assert.ok(r.includes(auth));
    assert.ok(r.includes(dockerfile));
  });

  it("accepts custom patterns", () => {
    const r = needsSecurityReview(["src/billing/invoice.js"], [/billing/i]);
    assert.equal(r.length, 1);
  });

  // Audit Tier-3: paths the prior version missed.
  it("flags login / logout / signup paths even when not under auth/", () => {
    assert.equal(needsSecurityReview(["src/users/login.ts"]).length, 1, "src/users/login.ts must trigger");
    assert.equal(needsSecurityReview(["src/handlers/logout.go"]).length, 1, "src/handlers/logout.go must trigger");
    assert.equal(needsSecurityReview(["src/api/signup.py"]).length, 1, "src/api/signup.py must trigger");
  });

  it("flags identity / permission / session paths even when not under auth/", () => {
    assert.equal(needsSecurityReview(["src/handlers/identity.ts"]).length, 1);
    assert.equal(needsSecurityReview(["src/middleware/permission-check.js"]).length, 1);
    assert.equal(needsSecurityReview(["src/lib/session-store.ts"]).length, 1);
  });
});

describe("security-heuristic: content scanning", () => {
  it("flags a file that imports bcrypt (path doesn't say auth)", () => {
    const d = tmpdir();
    const f = writeFile(d, "src/users/store.ts", `import bcrypt from "bcrypt";\nexport async function hash(p) { return bcrypt.hash(p, 10); }\n`);
    const hits = contentFindings(f);
    assert.ok(hits.includes("password-hash"), `expected password-hash; got: ${hits.join(", ")}`);
  });

  it("flags a file that signs JWTs (path doesn't say auth)", () => {
    const d = tmpdir();
    const f = writeFile(d, "src/handlers/issue.ts", `import jwt from "jsonwebtoken";\nexport function issueToken(u) { return jwt.sign({ sub: u.id }, secret); }\n`);
    const hits = contentFindings(f);
    assert.ok(hits.includes("jwt"), `expected jwt; got: ${hits.join(", ")}`);
  });

  it("flags crypto.createCipheriv usage", () => {
    const d = tmpdir();
    const f = writeFile(d, "src/lib/encrypt.js", `const crypto = require("crypto");\nconst c = crypto.createCipheriv("aes-256-gcm", key, iv);\n`);
    const hits = contentFindings(f);
    assert.ok(hits.includes("crypto-primitive"));
    assert.ok(hits.includes("crypto-algorithm"));
  });

  it("flags authz function calls", () => {
    const d = tmpdir();
    const f = writeFile(d, "src/middleware/check.ts", `function guard(req, res, next) {\n  if (!hasPermission(req.user, "admin")) return res.status(403).end();\n  next();\n}\n`);
    const hits = contentFindings(f);
    assert.ok(hits.includes("authz-check"));
  });

  it("flags SQL string concatenation (advisory)", () => {
    const d = tmpdir();
    const f = writeFile(d, "src/data/lookup.js", `const sql = "SELECT * FROM users WHERE id = " + userId;\n`);
    const hits = contentFindings(f);
    assert.ok(hits.includes("sql-concat"));
  });

  it("does NOT flag a clean utility file with no security-relevant content", () => {
    const d = tmpdir();
    const f = writeFile(d, "src/utils/format.ts", `export function pluralize(n, word) { return n === 1 ? word : word + "s"; }\n`);
    const hits = contentFindings(f);
    assert.deepEqual(hits, []);
  });

  it("skips files larger than the size cap", () => {
    const d = tmpdir();
    const huge = "x".repeat(2_000_000) + "\nimport bcrypt from 'bcrypt';\n";
    const f = writeFile(d, "src/generated/blob.js", huge);
    const hits = contentFindings(f);
    assert.deepEqual(hits, [], "oversized files should be skipped, not OOM the scanner");
  });

  it("does not throw on missing or unreadable files", () => {
    assert.deepEqual(contentFindings("/tmp/does-not-exist-stagecraft-test-xyz.ts"), []);
  });

  it("scans added lines instead of historical content in a changed file", () => {
    const d = tmpdir();
    initRepo(d);
    const f = writeFile(d, "src/example.js", "// Documentation mentions bcrypt.\nmodule.exports = 1;\n");
    execFileSync("git", ["add", "src/example.js"], { cwd: d });
    execFileSync("git", ["commit", "-qm", "baseline"], { cwd: d });
    fs.appendFileSync(f, "module.exports = 2;\n");

    assert.deepEqual(contentFindings(f), []);
  });

  it("still flags security-sensitive added lines", () => {
    const d = tmpdir();
    initRepo(d);
    const f = writeFile(d, "src/example.js", "module.exports = 1;\n");
    execFileSync("git", ["add", "src/example.js"], { cwd: d });
    execFileSync("git", ["commit", "-qm", "baseline"], { cwd: d });
    fs.appendFileSync(f, "const bcrypt = require('bcrypt');\n");

    assert.ok(contentFindings(f).includes("password-hash"));
  });

  it("devteam-no-security-review magic comment suppresses content findings", () => {
    // A doc/example file that legitimately mentions security primitives but
    // doesn't actually use them. Without the override, the bcrypt mention
    // alone would trigger stage-04b unnecessarily.
    const d = tmpdir();
    const content = [
      "// devteam-no-security-review: explanatory doc — describes bcrypt without using it",
      "//",
      "// Example: how a password-hashing setup typically looks:",
      "//   import bcrypt from 'bcrypt';",
      "//   const hash = await bcrypt.hash(password, 12);",
      "//",
      "// This file is documentation. The real implementation lives in src/auth/.",
      "export const example = 'see comments above';",
    ].join("\n");
    const f = writeFile(d, "docs/examples/password-hashing.md", content);
    const hits = contentFindings(f);
    assert.deepEqual(hits, [], "magic comment must suppress all content findings");
  });

  it("magic comment is case-insensitive", () => {
    const d = tmpdir();
    const content =
      "// DEVTEAM-NO-SECURITY-REVIEW: case-insensitive\nimport bcrypt from 'bcrypt';\n";
    const f = writeFile(d, "src/example.js", content);
    assert.deepEqual(contentFindings(f), []);
  });
});

describe("security-heuristic: analyze (structured output)", () => {
  it("returns separate path and content findings with attribution", () => {
    const d = tmpdir();
    const storeFile = writeFile(d, "src/users/store.ts", `import bcrypt from "bcrypt";\n`);
    const fmtFile   = writeFile(d, "src/utils/format.ts", `export function f(x) { return x.toString(); }\n`);
    const dockFile  = writeFile(d, "Dockerfile", `FROM node:20\n`);

    const r = analyze([storeFile, fmtFile, dockFile]);
    assert.equal(r.required, true);

    const pathFindings = r.findings.filter((f) => f.kind === "path");
    const contentFindingsList = r.findings.filter((f) => f.kind === "content");

    // Dockerfile matched on path
    assert.ok(pathFindings.some((f) => f.file === dockFile));
    // bcrypt import matched on content (path users/store.ts isn't in PATH_PATTERNS)
    assert.ok(contentFindingsList.some((f) => f.file === storeFile && f.label === "password-hash"));
    // format.ts shouldn't appear anywhere
    assert.ok(!r.findings.some((f) => f.file === fmtFile));
  });

  it("returns required:false when nothing matches", () => {
    const d = tmpdir();
    const fmtFile = writeFile(d, "src/utils/format.ts", `export function f(x) { return x; }\n`);
    const r = analyze([fmtFile, path.join(d, "README.md")]);
    assert.equal(r.required, false);
    assert.deepEqual(r.findings, []);
  });

  it("can disable content scanning via opts.scanContent: false", () => {
    const d = tmpdir();
    const f = writeFile(d, "src/users/store.ts", `import bcrypt from "bcrypt";\n`);
    const r = analyze([f], { scanContent: false });
    // Path doesn't match PATH_PATTERNS, content scan is off → no findings
    assert.equal(r.required, false);
  });
});
