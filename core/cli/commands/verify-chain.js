"use strict";

const path = require("node:path");
const { generateHelp } = require(path.join(__dirname, "..", "flags"));

const name = "verify-chain";

const flags = {
  cwd:  { type: "string",  description: "Target project directory" },
  track: { type: "string", description: "Override the pipeline track" },
  json: { type: "boolean", description: "JSON output" },
  "require-signed": { type: "boolean", description: "Fail unless every gate has a verifiable HMAC" },
  help: { type: "boolean", description: "Show this help" },
};

// `devteam verify-chain [--track <t>] [--cwd <dir>] [--require-signed] [--json]` (C6).
// Walks the tamper-evident stage-gate chain and reports breaks + unstamped
// gates. Exit 0 = intact, 1 = a break (CI-usable).
function run(positional, _flags) {
  if (_flags.help) { console.log(generateHelp("devteam verify-chain [options]", flags)); process.exit(0); }
  const cwd = _flags.cwd || process.cwd();
  const { loadConfig } = require(path.join(__dirname, "..", "..", "config"));
  const { gatesDir: getGatesDir } = require(path.join(__dirname, "..", "..", "paths"));
  const { verifyChain } = require(path.join(__dirname, "..", "..", "gates", "chain"));
  const { resolveActiveTrack } = require(path.join(__dirname, "..", "..", "pipeline", "active-track"));
  const config = loadConfig(cwd);
  const { track } = resolveActiveTrack(cwd, config, _flags.track);
  const requireSigned = _flags.requireSigned || config.pipeline.require_signed_gates;
  const r = verifyChain(getGatesDir(cwd, null), track, { requireSigned });
  if (_flags.json) {
    console.log(JSON.stringify({ schema_version: "1.0", ...r }, null, 2));
    process.exit(r.ok ? 0 : 1);
  }
  if (r.ok) {
    console.log(`✅ gate chain intact — ${r.checked} stage gate(s) verified`);
    if (r.unstamped.length) console.log(`   ⚠ unstamped: ${r.unstamped.join(", ")} — run \`devteam stamp-chain\``);
    if (r.unsigned.length) console.log(`   ⚠ unsigned: ${r.unsigned.join(", ")} — set DEVTEAM_SIGNING_SECRET and re-stamp`);
    if (r.unverified_signatures.length) console.log(`   ⚠ signatures not verified (DEVTEAM_SIGNING_SECRET is unset): ${r.unverified_signatures.join(", ")}`);
    for (const x of (r.resolved || [])) {
      console.log(`   ⚖ ${x.stage}: autonomously resolved under ${x.authority} — "${x.ruling}"`);
    }
    process.exit(0);
  }
  console.error("❌ gate chain verification FAILED");
  for (const b of r.breaks) {
    console.error(`   ${b.stage}: recorded prev_hash for ${b.prev_stage || "(genesis)"} ≠ current content`);
    console.error(`      recorded:   ${b.recorded}`);
    console.error(`      recomputed: ${b.recomputed}`);
  }
  for (const failure of r.invalid_macs) {
    console.error(`   ${failure.stage}: ${failure.reason}${failure.algorithm ? ` (${failure.algorithm})` : ""}`);
  }
  if (r.unstamped.length) console.error(`   ⚠ unstamped: ${r.unstamped.join(", ")}`);
  if (r.unsigned.length) console.error(`   ⚠ unsigned: ${r.unsigned.join(", ")}`);
  if (r.unverified_signatures.length) console.error(`   ⚠ signatures not verified: ${r.unverified_signatures.join(", ")}`);
  if (r.require_signed && !process.env.DEVTEAM_SIGNING_SECRET) {
    console.error("   signed-only policy requires DEVTEAM_SIGNING_SECRET");
  }
  if (r.breaks.length) {
    console.error(`\n   A hash break means an earlier gate changed after it was chained — tampering, or a`);
    console.error(`   deliberate earlier-stage re-run (then re-stamp with \`devteam stamp-chain\`).`);
  }
  process.exit(1);
}

module.exports = { name, flags, run };
