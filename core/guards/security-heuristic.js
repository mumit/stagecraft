#!/usr/bin/env node
// Security review heuristic. Reads the changed-files list (from CLI args or
// pipeline/changed-files.txt) and decides whether the security-engineer
// (Stage 4b) review is required. Two signals:
//
//   1. Path patterns — the filename itself suggests security territory
//      (e.g. anything under infra/, anything matching /auth/i).
//
//   2. Content patterns — the file's contents reference authentication,
//      cryptography, session handling, OAuth/JWT libraries, or other
//      load-bearing security surface. Audit Tier-3: the prior version
//      was path-only, which missed src/users/login.ts and similar
//      non-obvious paths while firing on every package.json change.
//
// Output (stdout):
//
//   SECURITY_REVIEW: skip                       — no triggers
//   SECURITY_REVIEW: required                   — at least one trigger
//   - path matched /pattern/i: src/auth.ts      — what fired
//   - content matched /pattern/i in src/foo.ts  — what fired
//
// Exit code: 0 when not required, 2 when required.

const fs = require("node:fs");
const path = require("node:path");
const { readChangedContent } = require("./changed-content");

// Files whose path alone is a strong-enough signal to require review.
// Conservative: it's cheap to over-trigger here; under-triggering is the
// failure mode the audit flagged.
const PATH_PATTERNS = [
  /auth/i,
  /crypto/i,
  /payment/i,
  /pii/i,
  /secret/i,
  /token/i,
  /credential/i,
  /(^|\/)login\b/i,
  /(^|\/)logout\b/i,
  /(^|\/)signup\b/i,
  /(^|\/)oauth/i,
  /(^|\/)identity\b/i,
  /(^|\/)permission/i,
  /(^|\/)session\b/i,
  /dockerfile/i,
  /docker-compose/i,
  /(^|\/)infra\//i,
  /package-lock\.json$/i,
  /package\.json$/i,
];

// Patterns to grep inside changed files. Each entry has a regex and a
// short label that names the security surface it represents. The label
// is what shows up in the heuristic's output so reviewers know why a
// file was flagged.
const CONTENT_PATTERNS = [
  // Password hashing libraries
  { label: "password-hash",     re: /\b(?:bcrypt|argon2|scrypt|pbkdf2)\b/i },

  // Token / JWT
  { label: "jwt",               re: /\b(?:jsonwebtoken|jwt\.(?:sign|verify|decode))\b/i },

  // OAuth / OpenID
  { label: "oauth",             re: /\b(?:oauth2?|openid|passport(?:-[\w-]+)?)\b/i },

  // Node crypto module — high-leverage primitives
  { label: "crypto-primitive",  re: /\bcrypto\.(?:createCipher(?:iv)?|createDecipher(?:iv)?|createHash|createHmac|randomBytes|pbkdf2|scrypt|sign|verify|publicEncrypt|privateDecrypt)\b/ },

  // Algorithm constants — often appear in config or key derivation.
  // Case-insensitive so `aes-256-gcm` (Node convention) matches the
  // same as `AES-256` (config-file convention).
  { label: "crypto-algorithm",  re: /\b(?:AES-?(?:128|192|256)|RSA-?(?:2048|3072|4096)|SHA-?(?:1|256|384|512)|HMAC-SHA\d+)\b/i },

  // Session / cookie signing
  { label: "session-cookie",    re: /\b(?:cookie-parser|cookieParser|cookie\.sign|signedCookies|session(?:Secret|Id|Token))\b/ },

  // CSRF
  { label: "csrf",              re: /\b(?:csrf|csurf|xsrf)[-_]?(?:token|secret|cookie)?\b/i },

  // Authorization checks — function-call shapes
  { label: "authz-check",       re: /\b(?:authenticate|authorize|requireAuth|isAdmin|hasPermission|hasRole|checkPermission|enforcePolicy|canAccess)\s*\(/ },

  // Hard-coded credential patterns (advisory — Stage 4a secret-scan
  // is the authoritative blocker; this just hints "look here too")
  { label: "credential-literal", re: /(?:api[_-]?key|secret[_-]?key|access[_-]?token|private[_-]?key)\s*[:=]\s*["'][^"']{16,}/i },

  // SQL string-concatenation (very rough — designed for awareness, not
  // detection). Anything that looks like a query keyword followed by
  // `+` (concat) or `${` (template interpolation) on the same line.
  // Triage at review time; many false positives expected and that's
  // OK — reviewer sees the surface and verifies.
  { label: "sql-concat",        re: /\b(?:SELECT|INSERT|UPDATE|DELETE)\b[^\n]{0,120}(?:\+\s|\$\{)/i },

  // Cryptographic randomness used for security (vs Math.random)
  { label: "weak-random",       re: /\bMath\.random\b(?=[^]*?(?:password|token|secret|nonce|salt|session))/i },
];

// 1 MB cap matches secret-scan and gate-validator. Bigger files are
// almost certainly generated or vendored; scanning them risks OOM
// and is rarely informative.
const MAX_SCAN_BYTES = 1_000_000;

function changedPathsFromArgs(args) {
  if (args.length > 0) return args;
  const diffFile = path.join(process.cwd(), "pipeline", "changed-files.txt");
  if (!fs.existsSync(diffFile)) return [];
  return fs.readFileSync(diffFile, "utf8").split(/\r?\n/).filter(Boolean);
}

// Magic-comment override: any line containing `devteam-no-security-review:
// <reason>` (case-insensitive) disables the heuristic for that file.
// Parity with secret-scan's `devteam-allow-secret:` escape hatch — same
// shape, same conservative intent. Use sparingly for verified false
// positives (docs / fixtures / educational examples that mention security
// primitives without using them).
const NO_REVIEW_MARKER = /devteam-no-security-review\s*:/i;

// Scan a single file's contents against CONTENT_PATTERNS. Returns the
// list of labels that fired. Read errors and oversized files return [].
// Files carrying the `devteam-no-security-review:` magic comment return
// [] regardless of pattern matches.
function contentFindings(filePath, patterns = CONTENT_PATTERNS) {
  let absolute;
  try {
    absolute = path.isAbsolute(filePath) ? filePath : path.join(process.cwd(), filePath);
    const stat = fs.statSync(absolute);
    if (!stat.isFile() || stat.size === 0) return [];
    if (stat.size > MAX_SCAN_BYTES) return [];
  } catch {
    return [];
  }
  let content;
  try {
    content = fs.readFileSync(absolute, "utf8");
  } catch {
    return [];
  }
  if (NO_REVIEW_MARKER.test(content)) return [];
  content = readChangedContent(absolute);
  const hits = [];
  for (const { label, re } of patterns) {
    if (re.test(content)) hits.push(label);
  }
  return hits;
}

// Full analysis. Returns:
//   {
//     required: boolean,
//     findings: [
//       { file, kind: "path",    pattern: "/auth/i" },
//       { file, kind: "content", label:  "jwt"     },
//       ...
//     ],
//   }
function analyze(paths, opts = {}) {
  const pathPatterns = opts.pathPatterns || PATH_PATTERNS;
  const contentPatterns = opts.contentPatterns || CONTENT_PATTERNS;
  const scanContent = opts.scanContent !== false;

  const findings = [];
  for (const filePath of paths) {
    for (const pattern of pathPatterns) {
      if (pattern.test(filePath)) {
        findings.push({ file: filePath, kind: "path", pattern: pattern.toString() });
      }
    }
    if (scanContent) {
      for (const label of contentFindings(filePath, contentPatterns)) {
        findings.push({ file: filePath, kind: "content", label });
      }
    }
  }
  return { required: findings.length > 0, findings };
}

// Back-compat: returns the list of files that matched. Used by callers
// that only care about "which files triggered" not "why." Honors a
// custom-patterns second arg in legacy path-only mode.
function needsSecurityReview(paths, patterns = PATH_PATTERNS) {
  if (patterns !== PATH_PATTERNS) {
    // Legacy path-only signature with custom patterns: no content scan.
    return paths.filter((filePath) => patterns.some((pattern) => pattern.test(filePath)));
  }
  const result = analyze(paths);
  const seen = new Set();
  for (const f of result.findings) seen.add(f.file);
  return Array.from(seen);
}

function main() {
  const paths = changedPathsFromArgs(process.argv.slice(2));
  const result = analyze(paths);

  if (!result.required) {
    console.log("SECURITY_REVIEW: skip");
    return 0;
  }

  console.log("SECURITY_REVIEW: required");
  for (const f of result.findings) {
    if (f.kind === "path") {
      console.log(`- path matched ${f.pattern}: ${f.file}`);
    } else {
      console.log(`- content matched ${f.label} in ${f.file}`);
    }
  }
  return 2;
}

if (require.main === module) {
  process.exit(main());
}

module.exports = { needsSecurityReview, analyze, contentFindings, PATH_PATTERNS, CONTENT_PATTERNS, MAX_SCAN_BYTES, NO_REVIEW_MARKER };
