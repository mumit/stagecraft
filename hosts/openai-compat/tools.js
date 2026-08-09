// Tool definitions and executor for the openai-compat host adapter.
//
// The adapter drives the model through an agentic tool-call loop rather than
// spawning a CLI subprocess. Four tools are available to the model:
//
//   write_file   — write a file; enforces descriptor.allowedWrites at call time
//   read_file    — read a file; enforces project-root boundary
//   list_files   — list a directory; enforces project-root boundary
//   bash         — execute an allowlisted command; included when role toolBudget has "Bash"

const fs = require("node:fs");
const path = require("node:path");
const { spawn } = require("node:child_process");
const { splitCommand } = require("../../core/command-line");
const { isAllowed } = require("../../core/guards/write-audit");

const DEFAULT_BASH_TIMEOUT_MS = 60_000;
const MAX_OUTPUT_BYTES = 8 * 1024; // 8 KB per stream — keeps tool messages from bloating context
const MAX_FILE_READ_BYTES = 16 * 1024; // 16 KB — truncate large files (e.g. accumulated context.md) to prevent context bloat

// --- Tool definitions (OpenAI function-calling schema) -------------------

const WRITE_FILE = {
  type: "function",
  function: {
    name: "write_file",
    description:
      "Write content to a file. Use this to produce pipeline artifacts and gate JSON. " +
      "Paths are relative to the project root. Only paths listed in allowedWrites are permitted.",
    parameters: {
      type: "object",
      properties: {
        path: { type: "string", description: "Relative path from the project root" },
        content: { type: "string", description: "Full file content to write" },
      },
      required: ["path", "content"],
    },
  },
};

const READ_FILE = {
  type: "function",
  function: {
    name: "read_file",
    description: "Read the content of a file. Paths are relative to the project root.",
    parameters: {
      type: "object",
      properties: {
        path: { type: "string", description: "Relative path from the project root" },
      },
      required: ["path"],
    },
  },
};

const LIST_FILES = {
  type: "function",
  function: {
    name: "list_files",
    description: "List files and subdirectories inside a directory.",
    parameters: {
      type: "object",
      properties: {
        dir: {
          type: "string",
          description: "Relative directory path from the project root. Use '.' for root.",
        },
      },
      required: ["dir"],
    },
  },
};

// Build the bash tool definition with a platform-specific description so the
// model uses the correct coreutils variant (BSD on macOS, GNU on Linux).
function buildBashTool() {
  const isDarwin = process.platform === "darwin";
  const platformNote = isDarwin
    ? " macOS (BSD coreutils): use `stat -f%z <file>` for byte size (not `du -b`); " +
      "`stat -f '<fmt>'` not `stat --format`; `grep -E` not `grep -P`; " +
      "`sed -i ''` not `sed -i`."
    : "";
  return {
    type: "function",
    function: {
      name: "bash",
      description:
        "Execute an allowlisted command in the project root and return stdout, stderr, and exit code. " +
        "Use for running tests, linters, build scripts, and deploy commands. " +
        "The command is parsed into argv and is not run through a shell, so pipes, redirects, " +
        "background jobs, command substitution, and env-prefix assignments are rejected. " +
        "Working directory is always the project root." +
        platformNote,
      parameters: {
        type: "object",
        properties: {
          command: {
            type: "string",
            description: "Command to run at the project root. Use a direct command such as `npm test`, not shell syntax.",
          },
          timeout_ms: {
            type: "number",
            description: "Optional timeout in milliseconds. Defaults to 60000 (60 s).",
          },
        },
        required: ["command"],
      },
    },
  };
}

// Build the tool list for a given descriptor. The set respects the role's
// toolBudget: Read → read_file + list_files; Write → write_file; Bash → bash.
// Glob is treated as an alias for list_files (already included via Read).
function buildTools(descriptor) {
  if (descriptor.disableTools === true) return [];
  const BASH = buildBashTool();
  const budget = descriptor.toolBudget;
  if (!budget || budget.length === 0) {
    // No declared budget → offer the full set (advisory host, prompt-only enforcement).
    return [WRITE_FILE, READ_FILE, LIST_FILES, BASH];
  }
  const tools = [];
  const hasRead = budget.includes("Read") || budget.includes("Glob");
  const hasWrite = budget.includes("Write");
  const hasBash = budget.includes("Bash");
  if (hasRead) { tools.push(READ_FILE); tools.push(LIST_FILES); }
  if (hasWrite) tools.push(WRITE_FILE);
  if (hasBash) tools.push(BASH);
  // Always offer write_file for artifact + gate production, even for read-mostly
  // roles such as reviewer/security/red-team, so they can at least write their
  // gate JSON. Without this, the pipeline can never advance.
  if (!tools.includes(WRITE_FILE)) tools.push(WRITE_FILE);
  return tools;
}

// --- Tool executors -------------------------------------------------------

// Resolve a model-supplied relative path safely inside cwd.
// Returns null (and an error string) if the path would escape the project root.
function isInsideRoot(root, candidate) {
  const rel = path.relative(path.resolve(root), path.resolve(candidate));
  return rel === "" || (rel && !rel.startsWith("..") && !path.isAbsolute(rel));
}

function resolveSafe(cwd, relPath) {
  const resolved = path.resolve(cwd, relPath);
  if (!isInsideRoot(cwd, resolved)) {
    return { resolved: null, error: `path escapes project root: ${relPath}` };
  }
  return { resolved, error: null };
}

// Execute an allowlisted command in the project root. Returns a structured string
// (exit_code / stdout / stderr) to send back as the tool message content.
// Matches `find` invocations that search from the filesystem root or bare home
// directory — these scan the entire disk and reliably time out.
// Catches: `find /`, `find / -name`, `find ~`, `find ~ -name`,
//          `find $HOME`, `find ${HOME}`, etc.
const FILESYSTEM_ROOT_FIND_RE = /\bfind\s+(\/(?:\s|$)|~(?:\/?\s|$)|\$\{?HOME\}?(?:\/?\s|$))/;

// Match `find <absolute-path>` where the path starts with `/`, including
// simple quoted absolute paths.
// Used to detect absolute-path searches outside the project directory.
const ABS_PATH_FIND_RE = /\bfind\s+(?:"(\/[^"]*)"|'(\/[^']*)'|(\/\S*))/;

// Block recursive devteam escalation/ruling commands. Running
// `devteam fix-escalation` or `devteam ruling` from inside an AI-driven bash
// loop would either invoke the escalation applicator recursively (causing an
// infinite loop) or attempt an interactive command that has no terminal.
const RECURSIVE_DEVTEAM_RE = /\bdevteam\s+(fix-escalation|ruling)\b/;

const SHELL_SYNTAX_TOKENS = new Set(["|", "||", "&", "&&", ";", "<", ">", ">>", "2>", "2>>"]);
const SHELL_SYNTAX_RE = /[|&;<>`$]/;
const ENV_ASSIGNMENT_RE = /^[A-Za-z_][A-Za-z0-9_]*=/;

function validateCommandArgv(command) {
  let parsed;
  try {
    parsed = splitCommand(command, "bash command");
  } catch (err) {
    return { error: `invalid command: ${err.message}` };
  }
  const { bin, args } = parsed;
  if (path.isAbsolute(bin) || bin.includes("/") || bin.includes("\\")) {
    return { error: "absolute or path-qualified executables are not allowed; use an allowlisted command name" };
  }
  if (ENV_ASSIGNMENT_RE.test(bin)) {
    return { error: "environment-variable prefixes are not supported; run the configured script directly" };
  }
  const badToken = [bin, ...args].find((token) =>
    SHELL_SYNTAX_TOKENS.has(token) || SHELL_SYNTAX_RE.test(token) || ENV_ASSIGNMENT_RE.test(token),
  );
  if (badToken) {
    return {
      error:
        `shell syntax is not supported in bash tool commands (found "${badToken}"). ` +
        "Use direct argv-style commands such as `npm test`, `npx eslint .`, or `git status --short`.",
    };
  }
  return { bin, args, error: null };
}

function spawnAllowedCommand(bin, args, options) {
  switch (bin) {
    case "awk": return spawn("awk", args, options);
    case "cat": return spawn("cat", args, options);
    case "chmod": return spawn("chmod", args, options);
    case "cp": return spawn("cp", args, options);
    case "devteam": return spawn("devteam", args, options);
    case "docker": return spawn("docker", args, options);
    case "find": return spawn("find", args, options);
    case "git": return spawn("git", args, options);
    case "grep": return spawn("grep", args, options);
    case "head": return spawn("head", args, options);
    case "kubectl": return spawn("kubectl", args, options);
    case "ls": return spawn("ls", args, options);
    case "make": return spawn("make", args, options);
    case "mkdir": return spawn("mkdir", args, options);
    case "mv": return spawn("mv", args, options);
    case "node": return spawn(process.execPath, args, options);
    case "npm": return spawn("npm", args, options);
    case "npx": return spawn("npx", args, options);
    case "pnpm": return spawn("pnpm", args, options);
    case "pwd": return spawn("pwd", args, options);
    case "rm": return spawn("rm", args, options);
    case "sed": return spawn("sed", args, options);
    case "sleep": return spawn("sleep", args, options);
    case "sort": return spawn("sort", args, options);
    case "tail": return spawn("tail", args, options);
    case "terraform": return spawn("terraform", args, options);
    case "test": return spawn("test", args, options);
    case "true": return spawn("true", args, options);
    case "false": return spawn("false", args, options);
    case "uniq": return spawn("uniq", args, options);
    case "wc": return spawn("wc", args, options);
    case "yarn": return spawn("yarn", args, options);
    default:
      return null;
  }
}

// Execute a command asynchronously using a detached process group.
//
// Why async spawn instead of spawnSync: spawnSync holds stdout/stderr pipes
// open until every process that inherited those file descriptors closes them.
// A directly spawned process can still start child processes. With detached:
// true, timeout cleanup can kill the whole process group instead of only the
// parent.
//
// Commands are never executed through a shell. The model supplies a command
// string for compatibility with shell-shaped instructions, but Stagecraft
// parses it into argv, rejects shell syntax, and only spawns explicit
// allowlisted executables.
function executeBash(command, cwd, timeoutMs) {
  if (FILESYSTEM_ROOT_FIND_RE.test(command)) {
    return Promise.resolve("error: filesystem root search blocked — search within the project directory instead (e.g. 'find . -name ...' or 'find pipeline/ -name ...')");
  }
  // Block `find /abs/path` when the path is outside the project directory.
  // This prevents the model from searching unrelated projects on the same machine.
  const absMatch = ABS_PATH_FIND_RE.exec(command);
  if (absMatch) {
    const searchPath = path.resolve(absMatch[1] || absMatch[2] || absMatch[3]);
    if (!isInsideRoot(cwd, searchPath)) {
      return Promise.resolve("error: search outside the project directory blocked — use a project-relative path (e.g. 'find . -name ...' or 'find pipeline/ -name ...')");
    }
  }
  if (RECURSIVE_DEVTEAM_RE.test(command)) {
    return Promise.resolve("error: recursive escalation blocked — do not call 'devteam fix-escalation' or 'devteam ruling' from inside a pipeline agent; you are already the escalation applicator");
  }
  const parsed = validateCommandArgv(command);
  if (parsed.error) {
    return Promise.resolve(`error: ${parsed.error}`);
  }

  const timeout = (typeof timeoutMs === "number" && timeoutMs > 0)
    ? timeoutMs
    : DEFAULT_BASH_TIMEOUT_MS;

  return new Promise((resolve) => {
    const child = spawnAllowedCommand(parsed.bin, parsed.args, {
      cwd,
      stdio: ["ignore", "pipe", "pipe"],
      detached: true, // process becomes group leader; child processes share the group
    });
    if (!child) {
      resolve(
        `error: command "${parsed.bin}" is not allowlisted for the bash tool. ` +
        "Use project scripts through npm/yarn/pnpm, or one of the documented verification/deploy commands.",
      );
      return;
    }

    const stdoutBufs = [];
    const stderrBufs = [];
    let exitCode = null;
    let settled = false;

    // Kill all processes in the command's process group. Used on timeout and
    // after process exit to reap any children that inherited the pipes.
    function killGroup() {
      try { process.kill(-child.pid, "SIGKILL"); } catch { /* ESRCH: already gone */ }
    }

    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      killGroup();
      resolve(`error: command timed out after ${timeout}ms`);
    }, timeout);

    child.stdout.on("data", (d) => { stdoutBufs.push(d); });
    child.stderr.on("data", (d) => { stderrBufs.push(d); });

    // When the command exits, kill the whole process group so child processes
    // release inherited pipe write-ends and the `close` event can fire.
    child.on("exit", (code) => {
      exitCode = code;
      killGroup();
    });

    child.on("close", () => {
      clearTimeout(timer);
      if (settled) return;
      settled = true;
      const stdout = Buffer.concat(stdoutBufs).toString("utf8").slice(0, MAX_OUTPUT_BYTES);
      const stderr = Buffer.concat(stderrBufs).toString("utf8").slice(0, MAX_OUTPUT_BYTES);
      resolve([
        `exit_code: ${exitCode ?? 1}`,
        stdout ? `stdout:\n${stdout}` : "stdout: (empty)",
        stderr ? `stderr:\n${stderr}` : "stderr: (empty)",
      ].join("\n"));
    });

    child.on("error", (err) => {
      clearTimeout(timer);
      if (!settled) {
        settled = true;
        resolve(`error: failed to spawn shell: ${err.message}`);
      }
    });
  });
}

// Execute a single tool call from the model. Returns a Promise<string> result
// to send back as the tool message content (bash is async; all others resolve
// synchronously but are wrapped in a Promise for a uniform call signature).
async function executeTool(toolCall, cwd, allowedWrites) {
  let args;
  try {
    args = typeof toolCall.function.arguments === "string"
      ? JSON.parse(toolCall.function.arguments)
      : toolCall.function.arguments;
  } catch {
    return `error: could not parse tool arguments: ${toolCall.function.arguments}`;
  }

  const name = toolCall.function.name;

  if (name === "write_file") {
    const { resolved, error } = resolveSafe(cwd, args.path);
    if (error) return `error: ${error}`;
    const rel = path.relative(cwd, resolved).replace(/\\/g, "/");
    if (!isAllowed(rel, allowedWrites)) {
      const patterns = (allowedWrites || []).join(", ");
      return (
        `error: write denied — "${args.path}" does not match any allowed-write pattern for this workstream.\n` +
        `Allowed patterns: ${patterns}\n` +
        `Note: patterns use * as a wildcard and <name> as a placeholder — ` +
        `do NOT write to a file literally named with angle brackets. ` +
        `For example, write to "pipeline/code-review/by-qa.md", not "pipeline/code-review/by-<reviewer>.md".`
      );
    }
    try {
      fs.mkdirSync(path.dirname(resolved), { recursive: true });
      fs.writeFileSync(resolved, args.content, "utf8");
      return `ok: wrote ${args.content.length} bytes to ${args.path}`;
    } catch (err) {
      return `error: write failed: ${err.message}`;
    }
  }

  if (name === "read_file") {
    const { resolved, error } = resolveSafe(cwd, args.path);
    if (error) return `error: ${error}`;
    try {
      const content = fs.readFileSync(resolved, "utf8");
      if (content.length <= MAX_FILE_READ_BYTES) return content;
      const head = content.slice(0, 12 * 1024);
      const tail = content.slice(-(4 * 1024));
      const omitted = content.length - head.length - tail.length;
      return (
        `${head}\n\n` +
        `[... ${omitted} bytes omitted — file exceeds ${MAX_FILE_READ_BYTES / 1024} KB; showing first 12 KB and last 4 KB ...]\n\n` +
        tail
      );
    } catch (err) {
      return `error: read failed: ${err.message}`;
    }
  }

  if (name === "list_files") {
    const { resolved, error } = resolveSafe(cwd, args.dir || ".");
    if (error) return `error: ${error}`;
    try {
      const entries = fs.readdirSync(resolved, { withFileTypes: true });
      return entries
        .map((e) => (e.isDirectory() ? `${e.name}/` : e.name))
        .join("\n");
    } catch (err) {
      return `error: list failed: ${err.message}`;
    }
  }

  if (name === "bash") {
    if (!args.command || typeof args.command !== "string") {
      return "error: bash tool requires a non-empty 'command' string";
    }
    return await executeBash(args.command, cwd, args.timeout_ms);
  }

  return `error: unknown tool "${name}"`;
}

module.exports = { buildTools, executeTool, executeBash, WRITE_FILE, READ_FILE, LIST_FILES };
