// Stage shopping — rule-based track assessment (G6).
//
// assess(description, files, opts) → {
//   recommendedTrack,   // string track name or null for custom
//   stages,             // ordered stage name array for the track
//   confidence,         // "high" | "medium" | "low"
//   securityRequired,   // bool
//   migrationRequired,  // bool
//   reasons,            // string[]
// }
//
// Priority order (first match wins, then heuristic overrides may bump up):
//   1. hotfix       — description mentions hotfix / sev-0 / emergency
//   2. dep-update   — all files are dependency manifests, or description says dep update
//   3. config-only  — all files are config (non-code), or description says config-only
//   4. nano         — trivial change keywords (typo, rename, wording)
//   5. quick        — minor/small/simple fix keywords
//   6. loop         — explicit iteration language, or the safe day-to-day default
//
// After the base track is chosen:
//   - migration safety required + non-full → bumped to "full"
//   - security review required + a code track without security-review → "full"

const { needsMigrationSafety } = require("../guards/migration-heuristic");
const { analyze: analyzeSecurityHeuristic } = require("../guards/security-heuristic");
const { orderedStageNamesForTrack } = require("../pipeline/stages");
const { DOCUMENTATION_ROLE, isDocumentationPath } = require("../pipeline/affected-files");

const HOTFIX_PATTERN = /\b(hotfix|hot[- ]?fix|critical[- ]?fix|urgent[- ]?fix|emergency[- ]?patch|sev-?[01])\b/i;
// Note: `bump <word>` is outside the word-boundary group so \b doesn't
// fire mid-word after matching just the first char of the target package.
const DEP_UPDATE_PATTERN = /\b(dep(endency|endencies|s)?[\s-]+(update|upgrade|bump)|dependabot|renovate)\b|\bbump\s+\w+/i;
const CONFIG_ONLY_PATTERN = /\b(config(uration)?|env(ironment)?|feature[- ]?flag|toggle|setting)s?\s+(only|change|update)\b/i;
const NANO_PATTERN = /\b(typo|typos?|spelling|trivial|cosmetic|comment|docs?[- ]?only|rename[- ]?only|wording)\b/i;
const QUICK_PATTERN = /\b(quick|minor|small|simple)\s+(fix|change|update|patch)\b/i;
const LOOP_PATTERN = /\b(loop|iterate|iteration|iterative)\b/i;
const DOCS_ONLY_PATTERN = /\b(docs?|documentation)[- ]?only\b/i;

const DEP_FILE_RE = /^(package\.json|package-lock\.json|yarn\.lock|pnpm-lock\.ya?ml|bun\.lockb|requirements\.txt|Pipfile(\.lock)?|pyproject\.toml|Cargo(\.lock|\.toml)|go\.(sum|mod)|composer\.lock|Gemfile(\.lock)?|\.npmrc|\.yarnrc(\.yml)?)$/i;
const CONFIG_FILE_RE = /\.(ya?ml|toml|ini|cfg|conf|env|json)$|^\..*rc(\..*)?$|^Dockerfile(\.|$)/i;

function basename(f) { return f.replace(/.*[\\/]/, ""); }
function isDepFile(f) { return DEP_FILE_RE.test(basename(f)); }
function isConfigFile(f) { return CONFIG_FILE_RE.test(f) || DEP_FILE_RE.test(basename(f)); }

function assess(description = "", files = [], opts = {}) {
  const desc = typeof description === "string" ? description : "";
  const scanContent = opts.scanContent !== false;
  const reasons = [];
  let securityRequired = false;
  let migrationRequired = false;

  if (files.length > 0) {
    const migrationMatches = needsMigrationSafety(files);
    if (migrationMatches.length > 0) {
      migrationRequired = true;
      reasons.push(`migration safety required: ${migrationMatches.length} file(s) match data-layer patterns`);
    }

    const secResult = analyzeSecurityHeuristic(files, { scanContent });
    if (secResult.required) {
      securityRequired = true;
      const uniqueFiles = [...new Set(secResult.findings.map((f) => f.file))];
      reasons.push(`security review required: ${uniqueFiles.length} file(s) match security patterns`);
    }
  }

  let recommendedTrack = "loop";
  let confidence = "low";
  const allDep = files.length > 0 && files.every(isDepFile);
  const allConfig = files.length > 0 && files.every(isConfigFile);
  const allDocumentation = files.length > 0 && files.every(isDocumentationPath);
  const documentationOnly = allDocumentation || (files.length === 0 && DOCS_ONLY_PATTERN.test(desc));

  if (HOTFIX_PATTERN.test(desc)) {
    recommendedTrack = "hotfix";
    confidence = "high";
    reasons.unshift("description matches hotfix keywords");
  } else if (allDep || DEP_UPDATE_PATTERN.test(desc)) {
    recommendedTrack = "dep-update";
    confidence = allDep ? "high" : "medium";
    reasons.unshift(allDep
      ? "all changed files are dependency manifests"
      : "description matches dependency-update keywords");
  } else if (allConfig || CONFIG_ONLY_PATTERN.test(desc)) {
    recommendedTrack = "config-only";
    confidence = allConfig ? "high" : "medium";
    reasons.unshift(allConfig
      ? "all changed files are config/non-code files"
      : "description matches config-only keywords");
  } else if (documentationOnly) {
    recommendedTrack = "loop";
    confidence = allDocumentation ? "high" : "medium";
    reasons.unshift(allDocumentation
      ? "all changed files are documentation; loop records the exact approved file scope"
      : "description requests documentation-only work; loop records the exact approved file scope");
  } else if (NANO_PATTERN.test(desc)) {
    recommendedTrack = "nano";
    confidence = "medium";
    reasons.unshift("description matches nano-change keywords (typo/rename/cosmetic)");
  } else if (QUICK_PATTERN.test(desc)) {
    recommendedTrack = "quick";
    confidence = "medium";
    reasons.unshift("description matches quick-change keywords (minor/small fix)");
  } else if (LOOP_PATTERN.test(desc)) {
    recommendedTrack = "loop";
    confidence = "medium";
    reasons.unshift("description explicitly requests an iteration loop");
  } else {
    recommendedTrack = "loop";
    confidence = "low";
    reasons.unshift("no specialized track indicators found; defaulting to the day-to-day loop");
  }

  // Heuristic overrides: bump lighter tracks up when safety stages are needed.
  if (migrationRequired && !["full", "hotfix"].includes(recommendedTrack)) {
    reasons.push(`track bumped from "${recommendedTrack}" to "full": migration safety stage required`);
    recommendedTrack = "full";
    confidence = "high";
  }

  // loop, nano, and quick have no security-review stage. A larger peer-review
  // panel is not a substitute for the security role, so all three promote to
  // full. dep-update is deliberately specialized (package manifests routinely
  // fire the heuristic); config-only and hotfix already include security-review.
  if (securityRequired && ["loop", "nano", "quick"].includes(recommendedTrack)) {
    reasons.push(`track bumped from "${recommendedTrack}" to "full": security review required`);
    recommendedTrack = "full";
    confidence = "high";
  }

  const stages = orderedStageNamesForTrack(recommendedTrack);
  const candidateActiveRoles = documentationOnly ? [DOCUMENTATION_ROLE] : [];
  return { recommendedTrack, stages, confidence, securityRequired, migrationRequired, reasons, candidateActiveRoles };
}

module.exports = {
  assess,
  HOTFIX_PATTERN,
  DEP_UPDATE_PATTERN,
  CONFIG_ONLY_PATTERN,
  NANO_PATTERN,
  QUICK_PATTERN,
  LOOP_PATTERN,
  DOCS_ONLY_PATTERN,
  DEP_FILE_RE,
  CONFIG_FILE_RE,
};
