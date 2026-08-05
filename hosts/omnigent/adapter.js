// Omnigent host adapter.
//
// Omnigent is a meta-harness, so Stagecraft treats it as a host runtime:
// Stagecraft still owns stages, gates, routing, and post-hoc validation;
// Omnigent owns the underlying model/harness session for one workstream.

const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { spawn } = require("node:child_process");

const capabilities = require("./capabilities.json");
const { makeMarkdownHostAdapter } = require("../../core/adapters/markdown-host");
const { splitCommand } = require("../../core/command-line");
const { loadConfig } = require("../../core/config");
const { gatesDir, logsDir, pipelineRoot } = require("../../core/paths");
const { snapshotWritables, auditWrites } = require("../../core/guards/write-audit");
const { terminateChild } = require("../../core/process-kill");
const {
  createTranscriptWriter,
  rotateLog,
  DEFAULT_TIMEOUT_MS,
} = require("../../core/adapters/headless");

const shared = makeMarkdownHostAdapter(capabilities);
const AGENT_SPEC_REL = capabilities.agentSpec;
const AGENT_CONFIG_REL = path.posix.join(AGENT_SPEC_REL, "config.yaml");
const LEGACY_AGENT_SPEC_REL = ".omnigent/stagecraft/agent.yaml";
const DEFAULT_SESSION_MODE = "no-session";
const DEFAULT_PROMPT_TRANSPORT = "argument";
const DEFAULT_POLICY_MODE = "off";

function agentSpecText() {
  return [
    "spec_version: 1",
    "name: stagecraft_workstream",
    "description: >-",
    "  Stagecraft workstream executor. Stagecraft supplies the per-stage prompt,",
    "  owns gate validation, and audits filesystem writes after this Omnigent",
    "  session exits.",
    "",
    "executor:",
    "  type: omnigent",
    "  config:",
    "    harness: codex",
    "",
    "prompt: |",
    "  You are executing a single Stagecraft workstream.",
    "  Follow the user prompt exactly. Read the referenced role prompt before",
    "  acting, write only the requested artifact and gate paths, and finish only",
    "  after the gate JSON exists at the exact path named in the prompt.",
    "",
    "# Operators may override harness/model/session launch settings through",
    "# .devteam/config.yml hosts.omnigent, or set DEVTEAM_HEADLESS_COMMAND for",
    "# one emergency run. The installed default favors the Codex harness because",
    "# it carries its own coding tools.",
    "",
  ].join("\n");
}

function installAgentSpec(targetDir, opts = {}) {
  const dest = path.join(targetDir, AGENT_CONFIG_REL);
  fs.mkdirSync(path.dirname(dest), { recursive: true });
  if (fs.existsSync(dest) && !opts.force) {
    return { written: [], skipped: [dest], warnings: [] };
  }
  fs.writeFileSync(dest, agentSpecText(), "utf8");
  return { written: [dest], skipped: [], warnings: [] };
}

function install(targetDir, opts = {}) {
  const base = shared.install(targetDir, opts);
  const spec = installAgentSpec(targetDir, opts);
  return {
    written: [...base.written, ...spec.written],
    skipped: [...base.skipped, ...spec.skipped],
    warnings: [...base.warnings, ...spec.warnings],
  };
}

function status(targetDir) {
  const base = shared.status(targetDir);
  const missing = [...base.missing];
  const stale = [...base.stale];
  const spec = path.join(targetDir, AGENT_CONFIG_REL);
  if (!fs.existsSync(spec)) missing.push(spec);
  else if (fs.statSync(spec).size === 0) stale.push(spec);
  return {
    ok: missing.length === 0 && stale.length === 0,
    missing,
    stale,
    notes: missing.length === 0 && stale.length === 0
      ? ["omnigent install looks healthy"]
      : [],
  };
}

function uninstall(targetDir) {
  shared.uninstall(targetDir);
  const bundle = path.join(targetDir, AGENT_SPEC_REL);
  const legacySpec = path.join(targetDir, LEGACY_AGENT_SPEC_REL);
  if (fs.existsSync(bundle)) fs.rmSync(bundle, { recursive: true, force: true });
  if (fs.existsSync(legacySpec)) fs.unlinkSync(legacySpec);
}

function optionalString(value) {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

function safeExtraArgs(value) {
  if (value === undefined) return [];
  if (!Array.isArray(value)) {
    throw new Error("hosts.omnigent.extra_args must be an array of strings");
  }
  const forbidden = new Set(["-p", "--prompt", "--prompt-file"]);
  return value.map((arg, idx) => {
    if (typeof arg !== "string" || arg.length === 0) {
      throw new Error(`hosts.omnigent.extra_args[${idx}] must be a non-empty string`);
    }
    if (forbidden.has(arg)) {
      throw new Error(`hosts.omnigent.extra_args[${idx}] cannot override Stagecraft prompt transport`);
    }
    return arg;
  });
}

function resolveLaunchProfile(ctx = {}, descriptor = null) {
  let raw = {};
  try {
    raw = loadConfig(ctx.cwd || process.cwd())?._raw?.hosts?.omnigent || {};
  } catch {
    raw = {};
  }
  const sessionMode = optionalString(raw.session_mode) ||
    (raw.no_session === false ? "session" : DEFAULT_SESSION_MODE);
  const allowedSessionModes = new Set(["no-session", "session", "resume"]);
  const promptTransport = optionalString(raw.prompt_transport) || DEFAULT_PROMPT_TRANSPORT;
  const allowedPromptTransports = new Set(["prompt-file", "stdin", "argument"]);
  const policyMode = optionalString(raw.policy_mode) || DEFAULT_POLICY_MODE;
  const allowedPolicyModes = new Set(["off", "file"]);
  if (!allowedSessionModes.has(sessionMode)) {
    throw new Error(
      `hosts.omnigent.session_mode must be one of: ${[...allowedSessionModes].join(", ")}`,
    );
  }
  if (!allowedPromptTransports.has(promptTransport)) {
    throw new Error(
      `hosts.omnigent.prompt_transport must be one of: ${[...allowedPromptTransports].join(", ")}`,
    );
  }
  if (!allowedPolicyModes.has(policyMode)) {
    throw new Error(
      `hosts.omnigent.policy_mode must be one of: ${[...allowedPolicyModes].join(", ")}`,
    );
  }
  const configuredAgentSpecPath = optionalString(raw.agent_spec_path) ||
    optionalString(raw.agent_spec);
  return {
    agentSpecPath: configuredAgentSpecPath || AGENT_SPEC_REL,
    usesDefaultAgentSpec: !configuredAgentSpecPath,
    harness: optionalString(raw.harness),
    // 32.3: routing.roles/routing.stages' {host, model} form (descriptor.model)
    // takes precedence over this host's own hosts.omnigent.model.
    model: (descriptor && typeof descriptor.model === "string" && descriptor.model) || optionalString(raw.model),
    serverUrl: optionalString(raw.server_url),
    sessionMode,
    sessionId: optionalString(raw.session_id),
    promptTransport,
    policyMode,
    extraArgs: safeExtraArgs(raw.extra_args),
  };
}

function ensureDefaultAgentSpecBundle(cwd) {
  if (!cwd) return;
  const configPath = path.join(cwd, AGENT_CONFIG_REL);
  const expected = agentSpecText();
  if (fs.existsSync(configPath)) {
    try {
      if (fs.readFileSync(configPath, "utf8") === expected) return;
    } catch { /* rewrite below */ }
  }
  fs.mkdirSync(path.dirname(configPath), { recursive: true });
  fs.writeFileSync(configPath, expected, "utf8");
}

function buildOmnigentCommandFromProfile(profile = resolveLaunchProfile()) {
  const args = ["run", profile.agentSpecPath || AGENT_SPEC_REL];
  if (profile.harness) args.push("--harness", profile.harness);
  if (profile.model) args.push("--model", profile.model);
  if (profile.serverUrl) args.push("--server-url", profile.serverUrl);
  if (profile.sessionMode === "no-session") args.push("--no-session");
  if (profile.sessionMode === "resume") {
    if (!profile.sessionId) {
      throw new Error("hosts.omnigent.session_id is required when session_mode is resume");
    }
    args.push("--session", profile.sessionId);
  }
  args.push(...(profile.extraArgs || []));
  return { bin: "omnigent", args, displayCommand: ["omnigent", ...args].join(" ") };
}

function buildOmnigentArgs(cmdString, prompt) {
  const { bin, args } = splitCommand(cmdString, "headlessCommand");
  return { bin, args: [...args, "--prompt", prompt] };
}

function promptTransportError(message) {
  const err = new Error(message);
  err.omnigentPromptTransport = true;
  return err;
}

function buildPromptFile(prompt) {
  try {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "devteam-omnigent-prompt-"));
    const promptPath = path.join(dir, "prompt.md");
    fs.writeFileSync(promptPath, prompt, { encoding: "utf8", mode: 0o600 });
    return {
      promptPath,
      cleanup() {
        try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* best-effort cleanup */ }
      },
    };
  } catch (err) {
    throw promptTransportError(`omnigent prompt-file transport failed: ${err.message}`);
  }
}

function buildPolicyFile(policy) {
  try {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "devteam-omnigent-policy-"));
    const policyPath = path.join(dir, "policy.json");
    fs.writeFileSync(policyPath, JSON.stringify(policy, null, 2) + "\n", { encoding: "utf8", mode: 0o600 });
    return {
      policyPath,
      cleanup() {
        try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* best-effort cleanup */ }
      },
    };
  } catch (err) {
    throw promptTransportError(`omnigent policy-file generation failed: ${err.message}`);
  }
}

function buildStagecraftPolicy(descriptor = {}) {
  const toolBudget = Array.isArray(descriptor.toolBudget) ? descriptor.toolBudget : [];
  const requiredCapabilities = descriptor.requiredCapabilities || {};
  const shellRequired = requiredCapabilities.shell === true;
  const networkRequired = requiredCapabilities.network === true;
  return {
    schema_version: "stagecraft.omnigent.policy.v1",
    workstream: descriptor.workstreamId || null,
    stage: descriptor.stage || null,
    role: descriptor.role || null,
    enforcement_request: "tool-call-time",
    stagecraft_backstop: {
      allowed_writes: "post-hoc-audit",
      gate_validation: "required-after-run",
    },
    filesystem: {
      allowed_writes: Array.isArray(descriptor.allowedWrites) ? descriptor.allowedWrites : [],
    },
    sandbox: {
      shell: shellRequired ? "required" : (toolBudget.includes("Bash") ? "allowed-by-role-budget" : "not-requested"),
      network: networkRequired ? "required" : "not-requested",
    },
    tool_budget: {
      allowed_tools: toolBudget,
    },
  };
}

function attachPolicyFile(command, descriptor, policyMode) {
  if (policyMode !== "file") return command;
  const policyFile = buildPolicyFile(buildStagecraftPolicy(descriptor));
  return {
    ...command,
    args: [...command.args, "--policy-file", policyFile.policyPath],
    displayCommand: `${command.displayCommand} --policy-file <stagecraft-policy-file>`,
    policyPath: policyFile.policyPath,
    cleanupPolicy: policyFile.cleanup,
  };
}

function attachPromptTransport(command, prompt, transport) {
  if (transport === "prompt-file") {
    const promptFile = buildPromptFile(prompt);
    return {
      ...command,
      args: [...command.args, "--prompt-file", promptFile.promptPath],
      displayCommand: `${command.displayCommand} --prompt-file <stage-prompt-file>`,
      promptTransport: transport,
      cleanupPrompt: promptFile.cleanup,
    };
  }
  if (transport === "stdin") {
    return {
      ...command,
      displayCommand: `${command.displayCommand} < <stage-prompt>`,
      promptTransport: transport,
      stdinText: prompt,
    };
  }
  return {
    ...command,
    args: [...command.args, "--prompt", prompt],
    displayCommand: `${command.displayCommand} --prompt <stage-prompt>`,
    promptTransport: "argument",
  };
}

function buildOmnigentInvocation(prompt, ctx = {}, descriptor = null) {
  if (process.env.DEVTEAM_HEADLESS_COMMAND) {
    const cmdString = process.env.DEVTEAM_HEADLESS_COMMAND;
    return {
      ...buildOmnigentArgs(cmdString, prompt),
      displayCommand: `${cmdString} --prompt <stage-prompt>`,
      source: "env",
      promptTransport: "argument",
    };
  }
  const profile = resolveLaunchProfile(ctx, descriptor);
  if (profile.usesDefaultAgentSpec) ensureDefaultAgentSpecBundle(ctx.cwd);
  const command = attachPolicyFile(buildOmnigentCommandFromProfile(profile), descriptor, profile.policyMode);
  return {
    ...attachPromptTransport(command, prompt, profile.promptTransport),
    source: "config",
    profile,
  };
}

function isOrchestratorWrite(ctx, relPath) {
  const relPipelineRoot = path.relative(ctx.cwd, pipelineRoot(ctx.cwd, ctx.changeId)).replace(/\\/g, "/");
  const relLogsDir = path.relative(ctx.cwd, logsDir(ctx.cwd, ctx.changeId)).replace(/\\/g, "/");
  const normalized = relPath.replace(/\\/g, "/");
  return normalized === path.posix.join(relPipelineRoot, "run-log.jsonl") ||
    normalized === path.posix.join(relPipelineRoot, "run-state.json") ||
    normalized === path.posix.join(relPipelineRoot, "run.lock") ||
    normalized.startsWith(`${relLogsDir}/`);
}

function isOmnigentRuntimeWrite(relPath) {
  const normalized = String(relPath || "").replace(/\\/g, "/");
  return normalized.startsWith(".codex-tmp/omnigent-codex-home-");
}

function emptyOmnigentEvidence() {
  return {
    session: {},
    policyVerdicts: { allow: 0, deny: 0, warn: 0, block: 0 },
  };
}

function sanitizeEvidenceId(value) {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  return /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(trimmed) ? trimmed : null;
}

function collectOmnigentEvidence(evidence, chunk) {
  const text = Buffer.isBuffer(chunk) ? chunk.toString("utf8") : String(chunk || "");
  const sessionMatch = text.match(/\b(?:omnigent[_ -]?)?session(?:[_ -]?id)?\s*[:=]\s*([A-Za-z0-9][A-Za-z0-9._:-]{0,127})/i);
  const conversationMatch = text.match(/\b(?:conversation|thread)(?:[_ -]?id)?\s*[:=]\s*([A-Za-z0-9][A-Za-z0-9._:-]{0,127})/i);
  const sessionId = sanitizeEvidenceId(sessionMatch?.[1]);
  const conversationId = sanitizeEvidenceId(conversationMatch?.[1]);
  if (sessionId) evidence.session.session_id = sessionId;
  if (conversationId) evidence.session.conversation_id = conversationId;

  for (const line of text.split(/\r?\n/)) {
    if (!/\bpolicy\b/i.test(line)) continue;
    if (/\b(allow|allowed|pass|passed)\b/i.test(line)) evidence.policyVerdicts.allow += 1;
    if (/\b(deny|denied|reject|rejected)\b/i.test(line)) evidence.policyVerdicts.deny += 1;
    if (/\b(warn|warning)\b/i.test(line)) evidence.policyVerdicts.warn += 1;
    if (/\b(block|blocked)\b/i.test(line)) evidence.policyVerdicts.block += 1;
  }
  return evidence;
}

function hasOmnigentEvidence(evidence) {
  return Boolean(evidence.session.session_id || evidence.session.conversation_id) ||
    Object.values(evidence.policyVerdicts).some((count) => count > 0);
}

function writeOmnigentEvidence(ctx, descriptor, evidence, logPath) {
  if (!hasOmnigentEvidence(evidence)) return null;
  const logsDirPath = logsDir(ctx.cwd, ctx.changeId);
  fs.mkdirSync(logsDirPath, { recursive: true });
  const evidencePath = path.join(logsDirPath, `${descriptor.workstreamId}.omnigent.json`);
  const payload = {
    schema_version: "stagecraft.omnigent.evidence.v1",
    host: "omnigent",
    workstream: descriptor.workstreamId,
    stage: descriptor.stage,
    role: descriptor.role,
    observed_at: new Date().toISOString(),
    log_path: logPath ? path.relative(ctx.cwd, logPath).replace(/\\/g, "/") : null,
    session: evidence.session,
    policy_verdicts: evidence.policyVerdicts,
    privacy: {
      prompt_retained: false,
      transcript_excerpt_retained: false,
      raw_policy_lines_retained: false,
    },
  };
  fs.writeFileSync(evidencePath, JSON.stringify(payload, null, 2) + "\n", "utf8");
  return evidencePath;
}

function invoke(descriptor, ctx, preRenderedPrompt) {
  const prompt = preRenderedPrompt || shared.renderStagePrompt(descriptor, ctx);
  let bin, args, displayCommand, stdinText, cleanupPrompt, cleanupPolicy;
  try {
    ({ bin, args, displayCommand, stdinText, cleanupPrompt, cleanupPolicy } = buildOmnigentInvocation(prompt, ctx, descriptor));
  } catch (err) {
    if (err.omnigentPromptTransport) {
      return Promise.reject(err);
    }
    return Promise.reject(new Error(`invalid Omnigent launch profile: ${err.message}`));
  }

  const gatePath = path.join(gatesDir(ctx.cwd, ctx.changeId), `${descriptor.workstreamId}.json`);
  const beforeSnapshot = snapshotWritables(ctx.cwd);

  // Phase-36 external review mode: mirrors core/adapters/headless.js's own
  // subject-audit addition — see that file's why-comment for the full
  // rationale. ctx.processCwd (the subject) is a different directory from
  // ctx.cwd (the review workspace) in review mode, and the audit above never
  // looks at it; add an independent snapshot/audit pass against the subject,
  // post-hoc detection only (never prevention).
  const subjectRoot = ctx.externalReviewMode === true && ctx.processCwd
    ? path.resolve(ctx.processCwd)
    : null;
  const auditSubject = subjectRoot !== null && subjectRoot !== path.resolve(ctx.cwd);
  const beforeSubjectSnapshot = auditSubject ? snapshotWritables(subjectRoot) : null;
  const start = Date.now();
  const timeoutMs = typeof ctx.timeoutMs === "number" ? ctx.timeoutMs : DEFAULT_TIMEOUT_MS;

  const logDisabled = process.env.DEVTEAM_NO_LOG === "1" || ctx.log === false;
  const liveTee = ctx.tee === true ||
    process.env.DEVTEAM_HEADLESS_TEE === "1" ||
    process.env.DEVTEAM_VERBOSE === "1";
  const omnigentEvidence = emptyOmnigentEvidence();
  let logPath = null;
  let logWriter = null;
  let logEnded = false;
  if (!logDisabled) {
    try {
      const logsDirPath = logsDir(ctx.cwd, ctx.changeId);
      fs.mkdirSync(logsDirPath, { recursive: true });
      logPath = path.join(logsDirPath, `${descriptor.workstreamId}.log`);
      const rawHistory = process.env.DEVTEAM_LOG_HISTORY;
      const maxHistory = (rawHistory !== undefined && Number.isFinite(parseInt(rawHistory, 10)) && parseInt(rawHistory, 10) >= 0)
        ? parseInt(rawHistory, 10)
        : 3;
      rotateLog(logPath, maxHistory);
      logWriter = createTranscriptWriter(logPath, [
        `# Stage transcript: ${descriptor.workstreamId}`,
        "# Host: omnigent",
        `# Command: ${displayCommand}`,
        `# Started: ${new Date().toISOString()}`,
        "# ---",
        "",
        "",
      ].join("\n"));
    } catch {
      logPath = null;
      logWriter = null;
    }
  }

  function endLog(reason) {
    if (!logPath || logEnded) return;
    logEnded = true;
    logWriter?.end(`\n# ---\n# Ended: ${new Date().toISOString()}\n# Exit: ${reason}\n`);
  }

  return new Promise((resolve, reject) => {
    const child = spawn(bin, args, {
      cwd: ctx.processCwd || ctx.cwd,
      stdio: stdinText !== undefined
        ? ["pipe", logWriter !== null ? "pipe" : "inherit", logWriter !== null ? "pipe" : "inherit"]
        : (logWriter !== null ? ["ignore", "pipe", "pipe"] : ["ignore", "inherit", "inherit"]),
    });

    if (stdinText !== undefined) {
      child.stdin.on("error", () => { /* child closed stdin early */ });
      child.stdin.end(stdinText);
    }

    if (logWriter !== null) {
      child.stdout.on("data", (chunk) => {
        collectOmnigentEvidence(omnigentEvidence, chunk);
        if (liveTee) {
          try { process.stdout.write(chunk); } catch { /* closed pipe */ }
        }
        logWriter.append(chunk);
      });
      child.stderr.on("data", (chunk) => {
        collectOmnigentEvidence(omnigentEvidence, chunk);
        if (liveTee) {
          try { process.stderr.write(chunk); } catch { /* closed pipe */ }
        }
        logWriter.append(chunk);
      });
    }

    let timedOut = false;
    let timer = null;
    if (timeoutMs > 0) {
      timer = setTimeout(() => {
        timedOut = true;
        terminateChild(child, { graceMs: 5000 });
      }, timeoutMs);
      timer.unref();
    }

    child.on("error", (err) => {
      if (timer) clearTimeout(timer);
      endLog(`spawn error: ${err.message}`);
      if (cleanupPrompt) cleanupPrompt();
      if (cleanupPolicy) cleanupPolicy();
      if (err.code === "E2BIG") {
        reject(new Error(
          "omnigent prompt argument exceeded the OS command-length limit. " +
          "Set hosts.omnigent.prompt_transport to stdin, or prompt-file if your Omnigent CLI supports --prompt-file.",
        ));
        return;
      }
      reject(new Error(
        `omnigent invoke failed to spawn "${bin}": ${err.message}. Is omnigent installed and on PATH?`,
      ));
    });

    child.on("close", (exitCode) => {
      if (timer) clearTimeout(timer);
      endLog(timedOut ? "TIMED OUT" : String(exitCode));
      if (cleanupPrompt) cleanupPrompt();
      if (cleanupPolicy) cleanupPolicy();

      let writeViolations = [];
      if (beforeSnapshot) {
        const afterSnapshot = snapshotWritables(ctx.cwd);
        const { violations } = auditWrites(beforeSnapshot, afterSnapshot, descriptor.allowedWrites || []);
        writeViolations = violations.filter((v) => !isOrchestratorWrite(ctx, v) && !isOmnigentRuntimeWrite(v));
      }
      if (auditSubject && beforeSubjectSnapshot) {
        // Empty allowedWrites ([]) makes every new path a violation
        // unconditionally — codeRoot is read-only in review mode, there is
        // no allowlist to check against. "subject:" prefix disambiguates
        // these from the workspace-relative paths above once merged.
        const afterSubjectSnapshot = snapshotWritables(subjectRoot);
        const { violations: subjectViolations } = auditWrites(beforeSubjectSnapshot, afterSubjectSnapshot, []);
        writeViolations = writeViolations.concat(subjectViolations.map((v) => `subject:${v}`));
      }

      const gateExists = fs.existsSync(gatePath);
      let evidencePath = null;
      try {
        evidencePath = writeOmnigentEvidence(ctx, descriptor, omnigentEvidence, logPath);
      } catch { /* evidence is best-effort and adapter-private */ }
      let isStub = false;
      if (gateExists) {
        try {
          const parsed = JSON.parse(fs.readFileSync(gatePath, "utf8"));
          isStub = parsed._stub === true;
        } catch { /* unreadable; validator will report it */ }
      }

      resolve({
        exitCode: timedOut ? null : exitCode,
        gatePath: gateExists && !isStub ? gatePath : null,
        stubGate: isStub,
        logPath,
        durationMs: Date.now() - start,
        timedOut,
        writeViolations,
        evidencePath,
      });
    });
  });
}

module.exports = {
  capabilities,
  install,
  uninstall,
  status,
  renderStagePrompt: shared.renderStagePrompt,
  renderStagePromptLayers: shared.renderStagePromptLayers,
  invoke,
  buildOmnigentArgs,
  buildOmnigentCommandFromProfile,
  buildOmnigentInvocation,
  attachPromptTransport,
  buildStagecraftPolicy,
  collectOmnigentEvidence,
  emptyOmnigentEvidence,
  isOmnigentRuntimeWrite,
  writeOmnigentEvidence,
  resolveLaunchProfile,
  agentSpecText,
};
