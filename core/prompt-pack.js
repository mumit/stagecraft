// Prompt-pack version — content-hash version of the prompt surface
// (phase-33 item 33.3, plans/phase-33-eval-flywheel.md §33.3).
//
// prompt_pack_version is a short content hash over every file under roles/,
// rules/, and templates/ — the role briefs, stage/pipeline rule prose, and
// prompt templates a rendered dispatch prompt can draw from. It answers
// "did the prompt surface change between these two runs?" as a single
// comparable value, recorded on every gate (core/orchestrator.js,
// core/gates/validator.js), every corpus row (core/corpus.js), and every
// eval case (core/evals/capture.js) — the missing consumer for C4
// reproducibility's per-dispatch fingerprint (docs/reproducibility.md).
//
// VERIFY-FIRST note (plan §33.3): scripts/prompt-budget.js was checked as a
// candidate walker to reuse. It does NOT hash anything — computeStageStats()
// only sums fs.statSync().size byte counts for the specific framework files
// named in a stage's readFirst array (core/pipeline/stages.js), which is a
// stage-descriptor-driven lookup, not a directory walk. It has no content
// hash to extend and its resolver excludes roles/ entirely (see
// resolveFrameworkFile's comment: "roles/ entries ... are added per-dispatch,
// not in readFirst"). This module is therefore new, not reused.
//
// roles/ is bundled framework source, not a fixed per-project install path:
// core/adapters/base-install.js installs rules/ and templates/ verbatim into
// a project's .devteam/{rules,templates}/, but each host adapter renders
// role briefs into its own per-host format (Claude Code subagent frontmatter,
// etc. — see base-install.js's header comment), so there is no single
// installed roles/ directory to hash across hosts. Hashing the bundled
// source directories (this package's own roles/, rules/, templates/) is
// therefore the version of "the prompt surface" a pack version can mean
// consistently across every host and project — the same repo-relative
// convention core/adapters/base-install.js's RULES_DIR/TEMPLATES_DIR and
// scripts/prompt-budget.js's ROOT already use.

"use strict";

const fs = require("node:fs");
const path = require("node:path");
const crypto = require("node:crypto");

const REPO_ROOT = path.resolve(__dirname, "..");
const SURFACE_DIRS = ["roles", "rules", "templates"];
const HASH_LENGTH = 12; // short id, same length as eval case dir hashes (core/evals/capture.js)

// Recursively list files under `absDir` as { rel, abs }, sorted by relative
// path so the walk order is stable across platforms and readdir
// implementations. Symlinks are skipped (Dirent.isFile()/isDirectory() are
// false for them) — same conservative posture as core/evals/capture.js's
// snapshotInputs.
function listFilesSorted(absDir, relPrefix) {
  let entries;
  try {
    entries = fs.readdirSync(absDir, { withFileTypes: true });
  } catch {
    return [];
  }
  const files = [];
  for (const entry of [...entries].sort((a, b) => a.name.localeCompare(b.name))) {
    const rel = relPrefix ? `${relPrefix}/${entry.name}` : entry.name;
    const abs = path.join(absDir, entry.name);
    if (entry.isDirectory()) {
      files.push(...listFilesSorted(abs, rel));
    } else if (entry.isFile()) {
      files.push({ rel, abs });
    }
  }
  return files;
}

// Content-hash the prompt surface: every file under roles/, rules/,
// templates/ (stable sorted ordering), each entry contributing both its
// repo-relative path and its bytes — so a rename with identical content
// still changes the version. sha256, truncated to HASH_LENGTH hex chars:
// short enough to read in a gate diff, long enough (48 bits) that an
// accidental collision between two genuinely different prompt surfaces
// isn't a practical concern for this local, non-adversarial use.
function computePromptPackVersion(repoRoot = REPO_ROOT) {
  const hash = crypto.createHash("sha256");
  for (const dirName of SURFACE_DIRS) {
    const files = listFilesSorted(path.join(repoRoot, dirName), dirName);
    for (const f of files) {
      hash.update(`${f.rel}\0`, "utf8");
      hash.update(fs.readFileSync(f.abs));
      hash.update("\0");
    }
  }
  return hash.digest("hex").slice(0, HASH_LENGTH);
}

module.exports = {
  SURFACE_DIRS,
  REPO_ROOT,
  HASH_LENGTH,
  computePromptPackVersion,
};
