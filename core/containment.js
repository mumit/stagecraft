"use strict";

// Phase 38: OS containment is an explicit execution boundary, not an adapter
// marketing claim. The adapter still owns model invocation; this module only
// wraps its process in a disposable runtime and never receives prompt text.

const crypto = require("node:crypto");
const fs = require("node:fs");
const path = require("node:path");
const { spawnSync } = require("node:child_process");

const TRUST_PROFILES = new Set(["trusted", "contained", "remote"]);
const CONTAINED_PROVIDERS = new Set(["docker"]);

function positiveNumber(value, fallback) {
  return typeof value === "number" && Number.isFinite(value) && value > 0 ? value : fallback;
}

function positiveInteger(value, fallback) {
  return Number.isInteger(value) && value > 0 ? value : fallback;
}

function normalizeExecutionConfig(parsed = {}) {
  const profile = TRUST_PROFILES.has(parsed.trust_profile) ? parsed.trust_profile : "trusted";
  const raw = parsed.contained && typeof parsed.contained === "object" ? parsed.contained : {};
  return {
    trust_profile: profile,
    contained: {
      provider: CONTAINED_PROVIDERS.has(raw.provider) ? raw.provider : "docker",
      image: typeof raw.image === "string" && raw.image.trim() ? raw.image.trim() : null,
      network: raw.network === "bridge" ? "bridge" : "none",
      env_allowlist: Array.isArray(raw.env_allowlist)
        ? [...new Set(raw.env_allowlist.filter((name) => /^[A-Za-z_][A-Za-z0-9_]*$/.test(name)))]
        : [],
      cpus: positiveNumber(raw.cpus, 2),
      memory_mb: positiveInteger(raw.memory_mb, 4096),
      pids: positiveInteger(raw.pids, 128),
      tmpfs_mb: positiveInteger(raw.tmpfs_mb, 64),
      user: typeof raw.user === "string" && /^\d+:\d+$/.test(raw.user) ? raw.user : null,
    },
  };
}

function resolveTrustProfile(config, override) {
  const requested = override || config?.execution?.trust_profile || "trusted";
  if (!TRUST_PROFILES.has(requested)) {
    throw new Error(`unknown execution trust profile "${requested}" (expected trusted, contained, or remote)`);
  }
  if (requested === "remote") {
    throw new Error("execution trust profile \"remote\" is reserved for a transport-backed runner and is not implemented");
  }
  if (requested === "contained" && !config?.execution?.contained?.image) {
    throw new Error(
      "execution trust profile \"contained\" requires execution.contained.image; " +
      "Stagecraft will not fall back to unsandboxed trusted execution",
    );
  }
  return requested;
}

function dockerAvailable() {
  const result = spawnSync("docker", ["version", "--format", "{{.Server.Version}}"], {
    encoding: "utf8", stdio: ["ignore", "pipe", "ignore"],
  });
  return result.status === 0 && Boolean(result.stdout.trim());
}

function defaultContainerUser() {
  if (typeof process.getuid === "function" && typeof process.getgid === "function" && process.getuid() !== 0) {
    return `${process.getuid()}:${process.getgid()}`;
  }
  return "65532:65532";
}

function assertContainedWorkspace(cwd, processCwd) {
  const workspace = fs.realpathSync(cwd);
  const working = fs.realpathSync(processCwd || cwd);
  if (working !== workspace && !working.startsWith(`${workspace}${path.sep}`)) {
    throw new Error("contained execution cannot use processCwd outside its disposable workstream workspace");
  }
  return { workspace, working };
}

function wrapContainedInvocation({ bin, args, ctx, env = process.env, dockerCheck = dockerAvailable }) {
  if (ctx.trustProfile !== "contained") {
    return { bin, args, cwd: ctx.processCwd || ctx.cwd, env: { ...env }, contained: false };
  }
  const policy = ctx.containment;
  if (!policy || policy.provider !== "docker" || !policy.image) {
    throw new Error("contained execution requires a configured Docker image");
  }
  if (!dockerCheck()) {
    throw new Error("contained execution requested but the Docker daemon is unavailable; refusing trusted fallback");
  }
  const { workspace, working } = assertContainedWorkspace(ctx.cwd, ctx.processCwd);
  const dockerArgs = [
    "run", "--rm", "--init", "--read-only",
    "--cap-drop", "ALL",
    "--security-opt", "no-new-privileges:true",
    "--network", policy.network,
    "--cpus", String(policy.cpus),
    "--memory", `${policy.memory_mb}m`,
    "--pids-limit", String(policy.pids),
    "--user", policy.user || defaultContainerUser(),
    "--tmpfs", `/tmp:rw,noexec,nosuid,size=${policy.tmpfs_mb}m`,
    "--mount", `type=bind,src=${workspace},dst=${workspace},rw`,
    "--workdir", working,
  ];
  for (const name of policy.env_allowlist) {
    // Name-only form keeps secret values out of argv/process listings. Docker
    // copies the value from its own environment into the container.
    if (env[name] !== undefined) dockerArgs.push("--env", name);
  }
  dockerArgs.push(policy.image, bin, ...args);
  return {
    bin: "docker",
    args: dockerArgs,
    cwd: workspace,
    // Docker receives the normal client environment (HOME/DOCKER_HOST may be
    // needed to reach the daemon), but forwards only the allowlisted names
    // above into the contained process.
    env: { ...env },
    contained: true,
  };
}

function publicTrustPlan(config, profile) {
  if (profile !== "contained") return { profile, os_sandboxed: false, provider: null };
  const policy = config.execution.contained;
  return {
    profile,
    os_sandboxed: true,
    provider: policy.provider,
    image_ref_sha256: `sha256:${crypto.createHash("sha256").update(policy.image).digest("hex")}`,
    network: policy.network,
    environment_allowlist: policy.env_allowlist,
    limits: {
      cpus: policy.cpus,
      memory_mb: policy.memory_mb,
      pids: policy.pids,
      timeout: "per-dispatch",
    },
    // Deliberately hash image details and omit all environment values from the
    // durable plan. They can reveal private registry/project information.
    output_reconciliation: "git-worktree-allowlist",
  };
}

module.exports = {
  dockerAvailable,
  normalizeExecutionConfig,
  publicTrustPlan,
  resolveTrustProfile,
  wrapContainedInvocation,
};
