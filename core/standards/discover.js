// B10 — Discover Standards preprocessing.
// Scans a project's file system (pure static analysis, no external processes)
// and produces a structured conventions summary. Output is both a JS object
// (for programmatic use) and a formatted markdown report.

const fs = require("node:fs");
const path = require("node:path");
const { hasPythonTests } = require("../verify/runner");
const { isFrameworkOwnedPath } = require("../paths");

// ─── Constants ────────────────────────────────────────────────────────────────

const SKIP_DIRS = new Set([
  "node_modules", ".git", "dist", "build", ".next", "out", ".turbo",
  "__pycache__", "vendor", ".venv", "venv", "env", "coverage", ".nyc_output",
  ".cache", ".parcel-cache", "target", ".gradle",
]);

const SRC_DIRS = ["src", "lib", "app", "pkg", "cmd", "internal"];

const SOURCE_EXTS = new Set([".js", ".ts", ".jsx", ".tsx", ".mjs", ".cjs", ".py", ".go", ".rs"]);

const TEST_PATTERNS = [
  /\.test\.[jt]sx?$/,
  /\.spec\.[jt]sx?$/,
  /_test\.go$/,
  /test_.*\.py$/,
  /.*_test\.py$/,
];

const FRAMEWORK_DEPS = {
  react:          "React",
  "react-dom":    "React",
  vue:            "Vue",
  "@angular/core": "Angular",
  next:           "Next.js",
  nuxt:           "Nuxt",
  svelte:         "Svelte",
  "@sveltejs/kit": "SvelteKit",
  astro:          "Astro",
  express:        "Express",
  fastify:        "Fastify",
  koa:            "Koa",
  hapi:           "@hapi/hapi",
  nestjs:         "@nestjs/core",
};

const TEST_RUNNER_DEPS = {
  jest:           "Jest",
  vitest:         "Vitest",
  mocha:          "Mocha",
  jasmine:        "Jasmine",
  "@playwright/test": "Playwright",
  cypress:        "Cypress",
  ava:            "AVA",
  tap:            "TAP",
};

const BUNDLER_DEPS = {
  webpack:        "webpack",
  vite:           "Vite",
  esbuild:        "esbuild",
  rollup:         "Rollup",
  parcel:         "Parcel",
  "@rspack/core": "Rspack",
  turbopack:      "Turbopack",
};

const TOOLING_FILES = {
  typescript:   ["tsconfig.json"],
  eslint:       ["eslint.config.js", "eslint.config.mjs", ".eslintrc.js", ".eslintrc.json", ".eslintrc.cjs", ".eslintrc"],
  prettier:     [".prettierrc", ".prettierrc.json", ".prettierrc.js", ".prettierrc.cjs", "prettier.config.js"],
  biome:        ["biome.json"],
  husky:        [".husky"],
  editorconfig: [".editorconfig"],
};

const NODE_BUILTINS = new Set([
  "fs", "path", "os", "http", "https", "crypto", "events", "stream", "util",
  "child_process", "cluster", "buffer", "url", "querystring", "readline",
  "assert", "perf_hooks", "async_hooks", "worker_threads", "v8", "vm",
  "node:fs", "node:path", "node:os", "node:http", "node:https", "node:crypto",
  "node:events", "node:stream", "node:util", "node:child_process", "node:buffer",
  "node:url", "node:querystring", "node:readline", "node:assert", "node:worker_threads",
  "node:perf_hooks", "node:async_hooks", "node:v8", "node:vm", "node:test",
]);

// ─── File walking ─────────────────────────────────────────────────────────────

function readFileSafe(filePath) {
  try { return fs.readFileSync(filePath, "utf8"); }
  catch { return null; }
}

function readJSONSafe(filePath) {
  const text = readFileSafe(filePath);
  if (!text) return null;
  try { return JSON.parse(text); }
  catch { return null; }
}

function listDir(dirPath) {
  try { return fs.readdirSync(dirPath, { withFileTypes: true }); }
  catch { return []; }
}

// Walk a directory up to maxDepth, collecting source file paths.
function walkForSources(dir, maxDepth, collected, limit) {
  if (maxDepth <= 0 || collected.length >= limit) return;
  for (const entry of listDir(dir)) {
    if (collected.length >= limit) break;
    if (entry.isDirectory()) {
      if (!SKIP_DIRS.has(entry.name)) {
        walkForSources(path.join(dir, entry.name), maxDepth - 1, collected, limit);
      }
    } else if (entry.isFile()) {
      const ext = path.extname(entry.name);
      if (SOURCE_EXTS.has(ext)) collected.push(path.join(dir, entry.name));
    }
  }
}

function collectSourceFiles(cwd, limit = 50) {
  const files = [];
  // Prefer SRC_DIRS for import sampling
  for (const d of SRC_DIRS) {
    const full = path.join(cwd, d);
    if (fs.existsSync(full)) {
      walkForSources(full, 4, files, limit);
      if (files.length >= limit) break;
    }
  }
  // Fill remainder from root level (1 deep)
  if (files.length < limit) walkForSources(cwd, 1, files, limit);
  return files;
}

// ─── detectTechStack ──────────────────────────────────────────────────────────

function detectTechStack(cwd) {
  const stack = {
    languages: [],
    frameworks: [],
    test_runner: null,
    bundler: null,
    package_manager: null,
  };

  // JavaScript / TypeScript
  const pkgPath = path.join(cwd, "package.json");
  const pkg = readJSONSafe(pkgPath);
  if (pkg) {
    stack.languages.push("JavaScript");
    if (fs.existsSync(path.join(cwd, "tsconfig.json"))) {
      stack.languages = ["TypeScript"];
    }

    const allDeps = { ...pkg.dependencies, ...pkg.devDependencies };

    // Frameworks
    const seen = new Set();
    for (const [dep, label] of Object.entries(FRAMEWORK_DEPS)) {
      if (allDeps[dep] && !seen.has(label)) {
        stack.frameworks.push(label);
        seen.add(label);
      }
    }

    // Test runner
    for (const [dep, label] of Object.entries(TEST_RUNNER_DEPS)) {
      if (allDeps[dep]) { stack.test_runner = label; break; }
    }
    // Fall back to node:test if no test-runner dep found but test scripts exist
    if (!stack.test_runner && pkg.scripts) {
      const scripts = Object.values(pkg.scripts).join(" ");
      if (/node --test/.test(scripts)) stack.test_runner = "node:test";
    }

    // Bundler — check devDeps; also infer from framework
    for (const [dep, label] of Object.entries(BUNDLER_DEPS)) {
      if (allDeps[dep]) { stack.bundler = label; break; }
    }
    if (!stack.bundler && stack.frameworks.includes("Next.js")) stack.bundler = "webpack (Next.js)";
    if (!stack.bundler && allDeps["@vitejs/plugin-react"]) stack.bundler = "Vite";

    // Package manager
    if (fs.existsSync(path.join(cwd, "yarn.lock")))       stack.package_manager = "yarn";
    else if (fs.existsSync(path.join(cwd, "pnpm-lock.yaml"))) stack.package_manager = "pnpm";
    else if (fs.existsSync(path.join(cwd, "bun.lockb")))  stack.package_manager = "bun";
    else if (fs.existsSync(path.join(cwd, "package-lock.json"))) stack.package_manager = "npm";
    else stack.package_manager = "npm"; // default assumption
  }

  // Python
  if (fs.existsSync(path.join(cwd, "pyproject.toml")) ||
      fs.existsSync(path.join(cwd, "setup.py")) ||
      fs.existsSync(path.join(cwd, "setup.cfg")) ||
      fs.existsSync(path.join(cwd, "requirements.txt"))) {
    if (!stack.languages.includes("Python")) stack.languages.push("Python");
    // Reuse the verify runner's own detector rather than a second, weaker
    // heuristic: discovery must report the test story that will actually be
    // executed. It covers pytest.ini, [tool.pytest], [tool:pytest], and a
    // bounded walk for test_*.py / *_test.py, where this previously looked
    // only for the string "pytest" inside requirements.txt.
    if (!stack.test_runner && hasPythonTests(cwd)) stack.test_runner = "pytest";
    if (!stack.package_manager) {
      if (fs.existsSync(path.join(cwd, "poetry.lock"))) stack.package_manager = "poetry";
      else if (fs.existsSync(path.join(cwd, "uv.lock"))) stack.package_manager = "uv";
      else if (fs.existsSync(path.join(cwd, "Pipfile.lock")) || fs.existsSync(path.join(cwd, "Pipfile"))) stack.package_manager = "pipenv";
      else if (fs.existsSync(path.join(cwd, "requirements.txt")) || fs.existsSync(path.join(cwd, "pyproject.toml"))) stack.package_manager = "pip";
    }
  }

  // Go
  if (fs.existsSync(path.join(cwd, "go.mod"))) {
    if (!stack.languages.includes("Go")) stack.languages.push("Go");
    if (!stack.test_runner) stack.test_runner = "go test";
  }

  // Rust
  if (fs.existsSync(path.join(cwd, "Cargo.toml"))) {
    if (!stack.languages.includes("Rust")) stack.languages.push("Rust");
    if (!stack.test_runner) stack.test_runner = "cargo test";
  }

  return stack;
}

// ─── detectModuleSystem ───────────────────────────────────────────────────────

function detectModuleSystem(cwd, sourceFiles) {
  // Fast path: package.json "type" field
  const pkg = readJSONSafe(path.join(cwd, "package.json"));
  if (pkg?.type === "module") return "esm";
  if (pkg?.type === "commonjs") return "cjs";

  // Sample source files
  if (sourceFiles.length === 0) return "unknown";

  let esmCount = 0;
  let cjsCount = 0;
  const sample = sourceFiles.slice(0, 20);
  for (const f of sample) {
    const text = readFileSafe(f);
    if (!text) continue;
    // Only look at JS/TS files
    const ext = path.extname(f);
    if (![".js", ".ts", ".jsx", ".tsx", ".mjs", ".cjs"].includes(ext)) continue;
    if (/^import\s+/m.test(text) || /\bimport\s*\(/m.test(text) || /\bexport\s+/m.test(text)) esmCount++;
    if (/\brequire\s*\(/m.test(text) || /\bmodule\.exports\b/.test(text)) cjsCount++;
  }

  if (esmCount === 0 && cjsCount === 0) return "unknown";
  if (esmCount > 0 && cjsCount === 0) return "esm";
  if (cjsCount > 0 && esmCount === 0) return "cjs";
  return "mixed";
}

// ─── detectFileLayout ─────────────────────────────────────────────────────────

function detectFileLayout(cwd) {
  const topLevel = [];
  const sourceDirs = [];
  const sampledFileNames = [];

  for (const entry of listDir(cwd)) {
    // isFrameworkOwnedPath keeps Stagecraft's own directories out of the
    // project's reported structure — `pipeline/` was being listed as a
    // top-level source directory of the project it was orchestrating. Same
    // reader class as the changed-file manifest and right-sizing; see
    // core/paths.js.
    if (entry.isDirectory() && !SKIP_DIRS.has(entry.name) && !entry.name.startsWith(".")
        && !isFrameworkOwnedPath(`${entry.name}/`)) {
      topLevel.push(entry.name);
    }
  }
  topLevel.sort();

  // Find the first recognized source root and list its subdirs
  for (const d of SRC_DIRS) {
    const srcPath = path.join(cwd, d);
    if (!fs.existsSync(srcPath)) continue;
    for (const entry of listDir(srcPath)) {
      if (entry.isDirectory() && !SKIP_DIRS.has(entry.name) && !entry.name.startsWith(".")) {
        sourceDirs.push(entry.name);
      }
      // Sample filenames for naming detection
      if (entry.isFile()) {
        const ext = path.extname(entry.name);
        if (SOURCE_EXTS.has(ext)) sampledFileNames.push(entry.name);
      }
    }
    // Also sample one level deeper
    for (const sub of sourceDirs.slice(0, 5)) {
      for (const entry of listDir(path.join(srcPath, sub))) {
        if (entry.isFile()) {
          const ext = path.extname(entry.name);
          if (SOURCE_EXTS.has(ext) && sampledFileNames.length < 30) {
            sampledFileNames.push(entry.name);
          }
        }
      }
    }
    break; // only the first recognized SRC_DIR
  }

  // If no src dir, sample root-level files
  if (sampledFileNames.length === 0) {
    for (const entry of listDir(cwd)) {
      if (entry.isFile()) {
        const ext = path.extname(entry.name);
        if (SOURCE_EXTS.has(ext) && sampledFileNames.length < 30) sampledFileNames.push(entry.name);
      }
    }
  }

  return { topLevel, sourceDirs, sampledFileNames };
}

// ─── detectNaming ────────────────────────────────────────────────────────────

function classifyFilename(name) {
  // Strip extension
  const base = path.basename(name, path.extname(name));
  if (!base) return null;
  if (/^[a-z][a-z0-9]*(-[a-z0-9]+)+$/.test(base)) return "kebab-case";
  if (/^[A-Z][a-zA-Z0-9]+$/.test(base)) return "PascalCase";
  if (/^[a-z][a-z0-9]*(_[a-z0-9]+)+$/.test(base)) return "snake_case";
  // camelCase requires an actual hump. The previous pattern here was
  // /^[a-z][a-zA-Z0-9]+$/, which matches any single lowercase word — so
  // `calc.py`, `utils.js`, `main.go` all counted as camelCase, and a project
  // whose files are uniformly single-word lowercase was told its convention
  // was camelCase. That is worse than saying nothing: the agent writes
  // `myNewModule.py` into a snake_case codebase.
  if (/^[a-z][a-z0-9]*[A-Z][a-zA-Z0-9]*$/.test(base)) return "camelCase";
  // A bare lowercase word is consistent with kebab, snake, and lowercase
  // conventions alike, so it gets its own bucket rather than being claimed
  // by one of them.
  if (/^[a-z][a-z0-9]*$/.test(base)) return "lowercase";
  return null;
}

function detectNaming(filenames) {
  const counts = { "kebab-case": 0, "PascalCase": 0, "camelCase": 0, "snake_case": 0, "lowercase": 0 };
  let classified = 0;
  for (const name of filenames) {
    const style = classifyFilename(name);
    if (style) { counts[style]++; classified++; }
  }
  if (classified === 0) return { file_style: "unknown" };
  const top = Object.entries(counts).sort((a, b) => b[1] - a[1])[0];
  const dominance = top[1] / classified;
  return { file_style: dominance >= 0.6 ? top[0] : "mixed" };
}

// ─── detectTooling ────────────────────────────────────────────────────────────

function detectTooling(cwd) {
  const result = {};
  for (const [tool, candidates] of Object.entries(TOOLING_FILES)) {
    result[tool] = candidates.some((c) => fs.existsSync(path.join(cwd, c)));
  }
  return result;
}

// ─── detectTestConfig ─────────────────────────────────────────────────────────

function detectTestConfig(cwd, techStack) {
  if (!techStack.test_runner) return { framework: null, co_located: null, pattern: null };

  const framework = techStack.test_runner;

  // Determine pattern string
  let pattern = null;
  if (/jest|vitest|mocha/i.test(framework)) {
    pattern = "**/*.test.{js,ts,jsx,tsx}";
  } else if (framework === "go test") {
    pattern = "**/*_test.go";
  } else if (framework === "pytest") {
    pattern = "test_*.py / *_test.py";
  } else if (/playwright/i.test(framework)) {
    pattern = "**/*.spec.{js,ts}";
  } else if (framework === "node:test") {
    pattern = "**/*.test.{js,mjs}";
  }

  // Check co-location: walk src/ up to 3 levels, see if test files share a dir with source files
  let coLocated = null;
  const srcRoot = SRC_DIRS.map((d) => path.join(cwd, d)).find((d) => fs.existsSync(d));
  if (srcRoot) {
    const dirs = new Map(); // dirPath → { hasSource, hasTest }
    walkCoLocated(srcRoot, 3, dirs);
    const coLocCount = [...dirs.values()].filter((d) => d.hasSource && d.hasTest).length;
    const sourceOnlyCount = [...dirs.values()].filter((d) => d.hasSource && !d.hasTest).length;
    if (coLocCount + sourceOnlyCount > 0) {
      coLocated = coLocCount > 0 && coLocCount >= sourceOnlyCount * 0.3;
    }
  }

  return { framework, co_located: coLocated, pattern };
}

function walkCoLocated(dir, maxDepth, dirs) {
  if (maxDepth <= 0) return;
  const entries = listDir(dir);
  const dirInfo = { hasSource: false, hasTest: false };
  for (const entry of entries) {
    if (entry.isDirectory() && !SKIP_DIRS.has(entry.name)) {
      walkCoLocated(path.join(dir, entry.name), maxDepth - 1, dirs);
    } else if (entry.isFile()) {
      const ext = path.extname(entry.name);
      const isTest = TEST_PATTERNS.some((p) => p.test(entry.name));
      if (SOURCE_EXTS.has(ext)) {
        if (isTest) dirInfo.hasTest = true;
        else dirInfo.hasSource = true;
      }
    }
  }
  if (dirInfo.hasSource || dirInfo.hasTest) dirs.set(dir, dirInfo);
}

// ─── detectCommonImports ──────────────────────────────────────────────────────

const IMPORT_RE = /(?:^|\n)(?:import\s+(?:[^'"]*from\s+)?['"]([^'"]+)['"]|(?:const|let|var)\s+\S.*?=\s*require\(['"]([^'"]+)['"]\))/g;

function detectCommonImports(sourceFiles) {
  const tally = new Map();
  for (const f of sourceFiles) {
    const ext = path.extname(f);
    if (![".js", ".ts", ".jsx", ".tsx", ".mjs", ".cjs"].includes(ext)) continue;
    const text = readFileSafe(f);
    if (!text) continue;
    let m;
    IMPORT_RE.lastIndex = 0;
    while ((m = IMPORT_RE.exec(text)) !== null) {
      const src = m[1] || m[2];
      if (!src) continue;
      if (src.startsWith(".") || src.startsWith("/")) continue; // relative
      if (NODE_BUILTINS.has(src)) continue;
      tally.set(src, (tally.get(src) || 0) + 1);
    }
  }
  return [...tally.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, 10)
    .map(([source, count]) => ({ source, count }));
}

function detectVerificationCommands(cwd, techStack) {
  const commands = [];
  const pkg = readJSONSafe(path.join(cwd, "package.json"));
  if (pkg && pkg.scripts) {
    const manager = techStack.package_manager || "npm";
    for (const name of ["test", "lint", "typecheck", "check", "build"]) {
      if (!pkg.scripts[name]) continue;
      commands.push(name === "test" ? `${manager} test` : `${manager} run ${name}`);
    }
  }
  if (techStack.test_runner === "pytest" && !commands.includes("pytest")) commands.push("pytest");
  if (techStack.test_runner === "go test") commands.push("go test ./...");
  if (techStack.test_runner === "cargo test") commands.push("cargo test");
  return [...new Set(commands)].slice(0, 6);
}

// ─── discover ────────────────────────────────────────────────────────────────

function discover(cwd, opts = {}) {
  const sourceFiles = collectSourceFiles(cwd, opts.maxImportFiles || 50);
  const techStack  = detectTechStack(cwd);
  const moduleSystem = detectModuleSystem(cwd, sourceFiles);
  const fileLayout = detectFileLayout(cwd);
  const naming     = detectNaming(fileLayout.sampledFileNames);
  const tooling    = detectTooling(cwd);
  const testConfig = detectTestConfig(cwd, techStack);
  const commonImports = detectCommonImports(sourceFiles);
  const verificationCommands = detectVerificationCommands(cwd, techStack);

  return {
    timestamp: new Date().toISOString(),
    cwd,
    tech_stack: techStack,
    module_system: moduleSystem,
    file_structure: fileLayout,
    naming,
    tooling,
    test_config: testConfig,
    common_imports: commonImports,
    verification_commands: verificationCommands,
  };
}

// ─── formatReport ─────────────────────────────────────────────────────────────

function formatReport(result) {
  const lines = [];
  const { tech_stack: ts, module_system: ms, file_structure: fs_, naming, tooling, test_config: tc, common_imports: ci } = result;
  const verificationCommands = result.verification_commands || [];

  lines.push(`# Project Conventions`);
  lines.push(`_Discovered by \`devteam standards discover\` on ${result.timestamp}_`);
  lines.push(`_Source: ${result.cwd}_`);
  lines.push(``);

  // Tech stack
  lines.push(`## Tech stack`);
  lines.push(``);
  lines.push(`- **Language:** ${ts.languages.length > 0 ? ts.languages.join(", ") : "none detected"}`);
  lines.push(`- **Framework:** ${ts.frameworks.length > 0 ? ts.frameworks.join(" · ") : "none detected"}`);
  lines.push(`- **Test runner:** ${ts.test_runner || "none detected"}`);
  lines.push(`- **Bundler:** ${ts.bundler || "none detected"}`);
  lines.push(`- **Package manager:** ${ts.package_manager || "none detected"}`);
  lines.push(``);

  // Module system
  lines.push(`## Module system`);
  lines.push(``);
  const msDesc = {
    esm: "ESM (`import`/`export`)",
    cjs: "CommonJS (`require`/`module.exports`)",
    mixed: "Mixed ESM and CommonJS",
    unknown: "Unknown (no source files analysed)",
  };
  lines.push(msDesc[ms] || ms);
  lines.push(``);

  // File structure
  lines.push(`## File structure`);
  lines.push(``);
  if (fs_.topLevel.length > 0) {
    lines.push(`Top-level directories: ${fs_.topLevel.map((d) => `\`${d}/\``).join(", ")}`);
  } else {
    lines.push(`Top-level directories: none detected`);
  }
  if (fs_.sourceDirs.length > 0) {
    lines.push(``);
    lines.push(`Source layout:`);
    lines.push(``);
    lines.push("```");
    for (const d of fs_.sourceDirs) lines.push(`  ${d}/`);
    lines.push("```");
  }
  lines.push(``);

  // Naming conventions
  lines.push(`## Naming conventions`);
  lines.push(``);
  lines.push(`- **File names:** ${naming.file_style}`);
  lines.push(``);

  // Tooling
  lines.push(`## Tooling`);
  lines.push(``);
  lines.push(`| Tool | Present |`);
  lines.push(`|------|---------|`);
  lines.push(`| TypeScript | ${tooling.typescript ? "✅ (tsconfig.json)" : "❌"} |`);
  lines.push(`| ESLint | ${tooling.eslint ? "✅" : "❌"} |`);
  lines.push(`| Prettier | ${tooling.prettier ? "✅" : "❌"} |`);
  lines.push(`| Biome | ${tooling.biome ? "✅" : "❌"} |`);
  lines.push(`| Husky | ${tooling.husky ? "✅" : "❌"} |`);
  lines.push(`| EditorConfig | ${tooling.editorconfig ? "✅" : "❌"} |`);
  lines.push(``);

  // Test configuration
  lines.push(`## Test configuration`);
  lines.push(``);
  if (tc.framework) {
    lines.push(`- **Framework:** ${tc.framework}`);
    if (tc.co_located !== null) {
      lines.push(`- **Co-located:** ${tc.co_located ? "Yes" : "No"} (test files ${tc.co_located ? "live next to" : "are separate from"} source files)`);
    }
    if (tc.pattern) lines.push(`- **Pattern:** \`${tc.pattern}\``);
  } else {
    lines.push(`No test framework detected.`);
  }
  lines.push(``);

  // Common imports
  if (ci.length > 0) {
    lines.push(`## Most-used imports`);
    lines.push(``);
    lines.push(`| Import source | Files |`);
    lines.push(`|--------------|-------|`);
    for (const { source, count } of ci) {
      lines.push(`| \`${source}\` | ${count} |`);
    }
    lines.push(``);
  }

  if (verificationCommands.length > 0) {
    lines.push(`## Verification commands`);
    lines.push(``);
    for (const command of verificationCommands) lines.push(`- \`${command}\``);
    lines.push(``);
  }

  lines.push(`---`);
  lines.push(`_A bounded machine-readable subset is refreshed in \`.devteam/knowledge/project.json\` and included automatically in stage prompts._`);

  return lines.join("\n") + "\n";
}

// ─── Exports ──────────────────────────────────────────────────────────────────

module.exports = {
  discover,
  formatReport,
  // Internal exports for testing
  detectTechStack,
  detectModuleSystem,
  detectFileLayout,
  detectNaming,
  detectTooling,
  detectTestConfig,
  detectCommonImports,
  detectVerificationCommands,
  collectSourceFiles,
  classifyFilename,
};
