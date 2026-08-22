"use strict";

// Phase 42.6: how was this project initialized?
//
// Two shapes exist and they have different consequences for a review. A
// committed install tracks `.devteam/` and the host directories in git, so
// every teammate gets the same configuration and a framework change shows up
// in the diff. A checkout-local (dogfood) install gitignores them, so the
// framework stays out of the product diff under review -- which is the point
// when the project being built is Stagecraft itself.
//
// `devteam doctor` reported the install's health and never which of the two it
// was looking at, so an operator could not tell a deliberately-local setup from
// a committed one that had lost its files, and the two need opposite fixes.
//
// Detection reads git, not a recorded flag: a flag would drift from what the
// repository actually does, and what it does is the thing that matters.

const fs = require("node:fs");
const path = require("node:path");
const { spawnSync } = require("node:child_process");
const { DOGFOOD_BLOCK_BEGIN } = require("./gitignore");

const PROBE = path.join(".devteam", "config.yml");

function git(cwd, args) {
  const r = spawnSync("git", args, { cwd, encoding: "utf8" });
  return { ok: r.status === 0, stdout: (r.stdout || "").trim(), failed: r.status === null };
}

// resolveInstallMode -- { mode, reason, dogfoodProfile }
//
//   "committed"       .devteam/config.yml is tracked; the team shares it.
//   "checkout-local"  it exists but git ignores it; local to this checkout.
//   "untracked"       exists, not ignored, not tracked -- neither shape, and
//                     usually an install that was never committed. Named
//                     rather than folded into checkout-local, because the fix
//                     differs: commit it, or ignore it deliberately.
//   "no-git"          not a repository, so neither shape applies.
//   "absent"          no config to classify; `devteam init` has not run.
function resolveInstallMode(cwd) {
  const probe = path.join(cwd, PROBE);
  if (!fs.existsSync(probe)) {
    return { mode: "absent", reason: "no .devteam/config.yml", dogfoodProfile: false };
  }
  const gitignore = path.join(cwd, ".gitignore");
  const dogfoodProfile = fs.existsSync(gitignore)
    && fs.readFileSync(gitignore, "utf8").includes(DOGFOOD_BLOCK_BEGIN);

  const inRepo = git(cwd, ["rev-parse", "--is-inside-work-tree"]);
  if (!inRepo.ok || inRepo.stdout !== "true") {
    return { mode: "no-git", reason: "not a git repository", dogfoodProfile };
  }
  if (git(cwd, ["ls-files", "--error-unmatch", PROBE]).ok) {
    return { mode: "committed", reason: `${PROBE} is tracked`, dogfoodProfile };
  }
  if (git(cwd, ["check-ignore", "-q", PROBE]).ok) {
    return { mode: "checkout-local", reason: `${PROBE} is gitignored`, dogfoodProfile };
  }
  return { mode: "untracked", reason: `${PROBE} is neither tracked nor ignored`, dogfoodProfile };
}

// The one-line description doctor prints, plus the remedy when there is one.
function describeInstallMode({ mode, dogfoodProfile }) {
  switch (mode) {
    case "committed":
      return {
        text: "committed — .devteam/ is tracked, so teammates share this configuration",
        advice: dogfoodProfile
          ? "the dogfood gitignore block is present but the config is tracked; one of the two is stale"
          : null,
      };
    case "checkout-local":
      return {
        text: dogfoodProfile
          ? "checkout-local (dogfood profile) — framework state stays out of the product diff"
          : "checkout-local — .devteam/ is gitignored, so this configuration is local to this checkout",
        advice: dogfoodProfile ? null : "teammates will not inherit it; `devteam init --profile dogfood` makes this explicit",
      };
    case "untracked":
      return {
        text: "untracked — .devteam/ is neither committed nor ignored",
        advice: "commit it to share the configuration, or run `devteam init --profile dogfood` to keep it local",
      };
    case "no-git":
      return { text: "no git repository — neither committed nor checkout-local applies", advice: null };
    default:
      return { text: "not initialized", advice: "run `devteam init --host <name>`" };
  }
}

module.exports = { resolveInstallMode, describeInstallMode };
