#!/usr/bin/env node
// release.js — pre-release checks + release-notes extraction.
//
// Usage:
//   node scripts/release.js check  # verify clean tree, tests pass, CHANGELOG updated
//   node scripts/release.js notes  # print the [Unreleased] section of CHANGELOG.md

const fs = require("node:fs");
const path = require("node:path");
const { spawnSync } = require("node:child_process");

const REPO_ROOT = path.resolve(__dirname, "..");

function run(cmd, args, opts = {}) {
  return spawnSync(cmd, args, { cwd: REPO_ROOT, encoding: "utf8", ...opts });
}

function check() {
  const failures = [];
  const warnings = [];

  // 1. Working tree clean
  const status = run("git", ["status", "--porcelain"]);
  if (status.status !== 0) {
    failures.push("git status failed");
  } else if (status.stdout.trim().length > 0) {
    failures.push(`working tree not clean:\n${status.stdout.trim().split("\n").map((l) => `    ${l}`).join("\n")}`);
  } else {
    console.log("  ✓ working tree clean");
  }

  // 2. On main (warn if not)
  const branch = run("git", ["rev-parse", "--abbrev-ref", "HEAD"]).stdout.trim();
  if (branch !== "main") {
    warnings.push(`not on main (currently on ${branch})`);
  } else {
    console.log("  ✓ on main branch");
  }

  // 3. Tests pass
  console.log("  • running npm test...");
  const test = run("npm", ["test"], { stdio: "inherit" });
  if (test.status !== 0) {
    failures.push("npm test failed");
  } else {
    console.log("  ✓ tests pass");
  }

  // 4. Consistency lint clean
  console.log("  • running consistency check...");
  const consistency = run("node", ["scripts/consistency.js"]);
  if (consistency.status !== 0) {
    failures.push(`consistency check failed: ${consistency.stdout}`);
  } else {
    console.log("  ✓ consistency clean");
  }

  // 5. CHANGELOG has content under [Unreleased]
  const changelog = fs.readFileSync(path.join(REPO_ROOT, "CHANGELOG.md"), "utf8");
  const unreleased = changelog.match(/^##\s+\[Unreleased\][\s\S]*?(?=^##\s+\[)/m);
  if (!unreleased) {
    failures.push("CHANGELOG.md has no [Unreleased] section");
  } else {
    const content = unreleased[0].replace(/^##\s+\[Unreleased\]\s*/, "").trim();
    if (content.length < 50) {
      warnings.push(`CHANGELOG [Unreleased] looks empty — did you record this release's changes?`);
    } else {
      console.log("  ✓ CHANGELOG [Unreleased] has content");
    }
  }

  // 6. package.json version is set
  const pkg = JSON.parse(fs.readFileSync(path.join(REPO_ROOT, "package.json"), "utf8"));
  if (!pkg.version) {
    failures.push("package.json missing version");
  } else {
    console.log(`  ✓ package.json version: ${pkg.version}`);
  }

  // 7. EXAMPLE.md re-capture reminder (D6.1)
  // EXAMPLE.md is a captured pipeline run that rots as the pipeline evolves.
  // Remind the release engineer to update the stamp and re-capture at each minor.
  const examplePath = path.join(REPO_ROOT, "EXAMPLE.md");
  if (fs.existsSync(examplePath)) {
    const exampleContent = fs.readFileSync(examplePath, "utf8");
    // Match the Freshness marker specifically, not any "captured at vX.Y".
    // EXAMPLE.md describes three provenance tiers -- live evidence re-captured
    // this release, illustrative output originally captured at v0.9.0, and
    // timings carried over from v0.7.0 -- and the loose pattern matched the
    // oldest of them. It reported the doc as three minors stale when the live
    // capture was one, which is the kind of warning a release engineer learns
    // to ignore.
    const stampMatch = exampleContent.match(/\*\*Freshness:\*\*\s*verified at v(\d+)\.(\d+)/i);
    if (!stampMatch) {
      warnings.push("EXAMPLE.md has no freshness stamp — add \"**Freshness:** verified at vX.Y\" near the top");
    } else {
      warnings.push(`EXAMPLE.md re-capture: verified at v${stampMatch[1]}.${stampMatch[2]} — if pipeline behavior changed since that release, re-run the traced pipeline and update the stamp`);
    }
  }

  console.log("");
  if (failures.length > 0) {
    console.log(`❌ ${failures.length} failure(s):`);
    for (const f of failures) console.log(`  ✗ ${f}`);
    process.exit(1);
  }
  if (warnings.length > 0) {
    console.log(`⚠️  ${warnings.length} warning(s):`);
    for (const w of warnings) console.log(`  ! ${w}`);
  }
  console.log(`✅ release:check passed (version: ${pkg.version})`);
}

function notes(version) {
  const changelog = fs.readFileSync(path.join(REPO_ROOT, "CHANGELOG.md"), "utf8");
  const label = version || "Unreleased";
  // Walk the file by section header. Each section starts with `## [...]`.
  // Capture everything after the header up to (a) the next `## [` header
  // or (b) end-of-file. Robust against the requested section being last.
  const lines = changelog.split("\n");
  const headerRe = /^##\s+\[([^\]]+)\]/;
  let inSection = false;
  const body = [];
  for (const line of lines) {
    const m = line.match(headerRe);
    if (m) {
      if (inSection) break;       // hit the next section, we're done
      if (m[1] === label) inSection = true;
      continue;
    }
    if (inSection) body.push(line);
  }
  if (body.length === 0) {
    console.error(`No [${label}] section in CHANGELOG.md`);
    process.exit(1);
  }
  // Strip the trailing `---` separator (and any whitespace around it) that
  // CHANGELOG.md uses between sections — it's structural to the file but
  // not part of the section's content. Without this, annotated tag
  // messages end in a ragged `---`.
  const cleaned = body.join("\n").trim().replace(/\n*---\s*$/, "");
  process.stdout.write(cleaned.trimEnd() + "\n");
}

// assemble — fold changelog.d/*.md fragments + [Unreleased] into a new version section.
// Closes BACKLOG C8.
function assemble(version) {
  if (!version) {
    console.error("Usage: release.js assemble <version>");
    process.exit(1);
  }

  const changelogPath = path.join(REPO_ROOT, "CHANGELOG.md");
  const fragmentDir = path.join(REPO_ROOT, "changelog.d");

  const changelog = fs.readFileSync(changelogPath, "utf8");
  const lines = changelog.split("\n");
  const headerRe = /^##\s+\[([^\]]+)\]/;

  // Locate [Unreleased] header and the next section header.
  let unreleasedIdx = -1;
  let nextSectionIdx = lines.length;
  for (let i = 0; i < lines.length; i++) {
    const m = lines[i].match(headerRe);
    if (!m) continue;
    if (m[1] === "Unreleased") {
      unreleasedIdx = i;
    } else if (unreleasedIdx !== -1) {
      nextSectionIdx = i;
      break;
    }
  }

  if (unreleasedIdx === -1) {
    console.error("No [Unreleased] section found in CHANGELOG.md");
    process.exit(1);
  }

  // Extract existing [Unreleased] body, stripping the trailing --- separator.
  const unreleasedBody = lines
    .slice(unreleasedIdx + 1, nextSectionIdx)
    .join("\n")
    .trim()
    .replace(/\n*---\s*$/, "")
    .trimEnd();

  // Read changelog.d/*.md fragments in stable alphabetical order.
  // README.md and .gitkeep are bookkeeping — they are never merged.
  let fragments = [];
  if (fs.existsSync(fragmentDir)) {
    fragments = fs.readdirSync(fragmentDir)
      .filter((f) => f.endsWith(".md") && f !== "README.md")
      .sort();
  }
  const fragmentContents = fragments.map((f) =>
    fs.readFileSync(path.join(fragmentDir, f), "utf8").trim(),
  );

  // Combine: existing [Unreleased] first, then fragments in order.
  const parts = [unreleasedBody, ...fragmentContents].filter(Boolean);
  const versionBody = parts.join("\n\n");

  // Build the new versioned section.
  const today = new Date().toISOString().slice(0, 10);
  const versionHeader = `## [${version}] — ${today}`;
  const newVersionLines = versionBody
    ? [versionHeader, "", versionBody, "", "---"]
    : [versionHeader, "", "---"];

  // Reconstruct CHANGELOG.md:
  //   <preamble + ## [Unreleased] line>
  //   (empty [Unreleased])
  //   ---
  //   <new version section>
  //   <rest of existing sections>
  const before = lines.slice(0, unreleasedIdx + 1); // includes "## [Unreleased]"
  const after = lines.slice(nextSectionIdx);          // starts with prior version header

  const rebuilt = [
    ...before,
    "",
    "---",
    "",
    ...newVersionLines,
    "",
    ...after,
  ].join("\n").replace(/\n{3,}/g, "\n\n");

  fs.writeFileSync(changelogPath, rebuilt.endsWith("\n") ? rebuilt : rebuilt + "\n");

  // Delete merged fragment files; leave README.md and .gitkeep intact.
  for (const f of fragments) {
    fs.unlinkSync(path.join(fragmentDir, f));
  }

  console.log(`✓ assembled ${fragments.length} fragment(s) into [${version}] (${today})`);
  if (fragments.length > 0) {
    console.log(`  fragments merged: ${fragments.join(", ")}`);
  }
}

function usage() {
  console.log(`release — pre-release checks + release-notes extraction

Usage:
  node scripts/release.js check                Verify clean tree, tests
                                               pass, CHANGELOG ready.
  node scripts/release.js notes [<version>]    Print the [<version>]
                                               section of CHANGELOG.md.
                                               Defaults to [Unreleased].
                                               Example: notes 0.1.0
  node scripts/release.js assemble <version>   Fold changelog.d/*.md
                                               fragments and [Unreleased]
                                               into a new [<version>]
                                               section; delete fragments.
                                               Example: assemble 0.6.0
`);
}

function main() {
  const cmd = process.argv[2];
  switch (cmd) {
    case "check": return check();
    case "notes": return notes(process.argv[3]);
    case "assemble": return assemble(process.argv[3]);
    case "help":
    case "-h":
    case "--help":
    case undefined: return usage();
    default:
      console.error(`Unknown command: ${cmd}`);
      usage();
      process.exit(2);
  }
}

if (require.main === module) main();

module.exports = { check, notes, assemble };
