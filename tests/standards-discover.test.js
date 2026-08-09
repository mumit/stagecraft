// B10 — Discover Standards preprocessing tests.
//
// Covers:
//   1. detectTechStack — JS/TS, Python, Go; framework/bundler/test-runner detection
//   2. detectModuleSystem — ESM, CJS, mixed, unknown
//   3. detectFileLayout — top-level dirs, source subdirs, skips node_modules
//   4. detectNaming — kebab-case, PascalCase, camelCase, snake_case, mixed
//   5. detectTooling — tsconfig, eslint, prettier, biome, husky, editorconfig
//   6. detectTestConfig — framework, co-located, pattern
//   7. detectCommonImports — counts, skips relatives and builtins, top 10
//   8. discover — integration: all keys present, timestamp ISO-8601
//   9. formatReport — markdown sections present
//  10. CLI: writes file, --dry-run, --force, --json, existing file guard, unknown sub exits 2

const { describe, it, afterEach } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { REPO_ROOT, makeTargetProject, cleanup, runCLI } = require("./_helpers");

const {
  detectTechStack,
  detectModuleSystem,
  detectFileLayout,
  detectNaming,
  detectTooling,
  detectTestConfig,
  detectCommonImports,
  detectVerificationCommands,
  classifyFilename,
  discover,
  formatReport,
} = require(path.join(REPO_ROOT, "core", "standards", "discover"));

// ─── Helpers ─────────────────────────────────────────────────────────────────

let _dirs = [];
function track(cwd) { _dirs.push(cwd); return cwd; }
afterEach(() => { _dirs.forEach(cleanup); _dirs = []; });

function makePkg(cwd, pkg) {
  fs.writeFileSync(path.join(cwd, "package.json"), JSON.stringify(pkg, null, 2), "utf8");
}

function makeFile(cwd, relPath, content = "") {
  const full = path.join(cwd, relPath);
  fs.mkdirSync(path.dirname(full), { recursive: true });
  fs.writeFileSync(full, content, "utf8");
  return full;
}

// ─── 1. detectTechStack ──────────────────────────────────────────────────────

describe("detectTechStack", () => {
  it("detects JavaScript from package.json", () => {
    const cwd = track(makeTargetProject());
    makePkg(cwd, { name: "my-app", dependencies: {} });
    const ts = detectTechStack(cwd);
    assert.ok(ts.languages.includes("JavaScript"));
  });

  it("detects TypeScript when tsconfig.json is present", () => {
    const cwd = track(makeTargetProject());
    makePkg(cwd, { name: "my-app", dependencies: {} });
    fs.writeFileSync(path.join(cwd, "tsconfig.json"), "{}", "utf8");
    const ts = detectTechStack(cwd);
    assert.ok(ts.languages.includes("TypeScript"));
    assert.ok(!ts.languages.includes("JavaScript"));
  });

  it("detects React framework", () => {
    const cwd = track(makeTargetProject());
    makePkg(cwd, { name: "my-app", dependencies: { react: "^18.0.0", "react-dom": "^18.0.0" } });
    const ts = detectTechStack(cwd);
    assert.ok(ts.frameworks.includes("React"));
  });

  it("detects Next.js and infers webpack bundler", () => {
    const cwd = track(makeTargetProject());
    makePkg(cwd, { name: "my-app", dependencies: { next: "^14.0.0", react: "^18.0.0" } });
    const ts = detectTechStack(cwd);
    assert.ok(ts.frameworks.includes("Next.js"));
    assert.ok(ts.frameworks.includes("React"));
    assert.ok(ts.bundler && ts.bundler.includes("webpack"));
  });

  it("detects Jest test runner from devDependencies", () => {
    const cwd = track(makeTargetProject());
    makePkg(cwd, { name: "my-app", devDependencies: { jest: "^29.0.0" } });
    const ts = detectTechStack(cwd);
    assert.equal(ts.test_runner, "Jest");
  });

  it("detects Vitest test runner", () => {
    const cwd = track(makeTargetProject());
    makePkg(cwd, { name: "my-app", devDependencies: { vitest: "^1.0.0" } });
    const ts = detectTechStack(cwd);
    assert.equal(ts.test_runner, "Vitest");
  });

  it("detects node:test from scripts when no test-runner dep", () => {
    const cwd = track(makeTargetProject());
    makePkg(cwd, { name: "my-app", scripts: { test: "node --test tests/*.test.js" } });
    const ts = detectTechStack(cwd);
    assert.equal(ts.test_runner, "node:test");
  });

  it("detects Vite bundler", () => {
    const cwd = track(makeTargetProject());
    makePkg(cwd, { name: "my-app", devDependencies: { vite: "^5.0.0" } });
    const ts = detectTechStack(cwd);
    assert.equal(ts.bundler, "Vite");
  });

  it("detects npm from package-lock.json", () => {
    const cwd = track(makeTargetProject());
    makePkg(cwd, { name: "my-app" });
    fs.writeFileSync(path.join(cwd, "package-lock.json"), "{}", "utf8");
    const ts = detectTechStack(cwd);
    assert.equal(ts.package_manager, "npm");
  });

  it("detects yarn from yarn.lock", () => {
    const cwd = track(makeTargetProject());
    makePkg(cwd, { name: "my-app" });
    fs.writeFileSync(path.join(cwd, "yarn.lock"), "", "utf8");
    const ts = detectTechStack(cwd);
    assert.equal(ts.package_manager, "yarn");
  });

  it("detects Python from pyproject.toml", () => {
    const cwd = track(makeTargetProject());
    fs.writeFileSync(path.join(cwd, "pyproject.toml"), "[project]\nname='foo'\n", "utf8");
    const ts = detectTechStack(cwd);
    assert.ok(ts.languages.includes("Python"));
  });

  it("detects Go from go.mod", () => {
    const cwd = track(makeTargetProject());
    fs.writeFileSync(path.join(cwd, "go.mod"), "module example.com/foo\ngo 1.21\n", "utf8");
    const ts = detectTechStack(cwd);
    assert.ok(ts.languages.includes("Go"));
    assert.equal(ts.test_runner, "go test");
  });

  it("returns empty languages array with no manifests", () => {
    const cwd = track(makeTargetProject());
    const ts = detectTechStack(cwd);
    assert.deepEqual(ts.languages, []);
    assert.deepEqual(ts.frameworks, []);
    assert.equal(ts.test_runner, null);
  });
});

describe("detectVerificationCommands", () => {
  it("derives bounded canonical commands from known package scripts", () => {
    const cwd = track(makeTargetProject());
    makePkg(cwd, { scripts: { test: "node --test", lint: "eslint .", typecheck: "tsc --noEmit", release: "npm publish" } });
    const stack = detectTechStack(cwd);
    assert.deepEqual(detectVerificationCommands(cwd, stack), ["npm test", "npm run lint", "npm run typecheck"]);
  });
});

// ─── 2. detectModuleSystem ───────────────────────────────────────────────────

describe("detectModuleSystem", () => {
  it("returns esm when package.json type is module", () => {
    const cwd = track(makeTargetProject());
    makePkg(cwd, { type: "module" });
    assert.equal(detectModuleSystem(cwd, []), "esm");
  });

  it("returns cjs when package.json type is commonjs", () => {
    const cwd = track(makeTargetProject());
    makePkg(cwd, { type: "commonjs" });
    assert.equal(detectModuleSystem(cwd, []), "cjs");
  });

  it("returns unknown with no files and no type field", () => {
    const cwd = track(makeTargetProject());
    assert.equal(detectModuleSystem(cwd, []), "unknown");
  });

  it("infers esm from import statements in source files", () => {
    const cwd = track(makeTargetProject());
    const f = makeFile(cwd, "src/index.js", "import React from 'react';\nexport default App;\n");
    assert.equal(detectModuleSystem(cwd, [f]), "esm");
  });

  it("infers cjs from require calls in source files", () => {
    const cwd = track(makeTargetProject());
    const f = makeFile(cwd, "src/index.js", "const fs = require('fs');\nmodule.exports = { fs };\n");
    assert.equal(detectModuleSystem(cwd, [f]), "cjs");
  });

  it("returns mixed when both import and require are used", () => {
    const cwd = track(makeTargetProject());
    const f1 = makeFile(cwd, "src/a.js", "import x from 'y';\n");
    const f2 = makeFile(cwd, "src/b.js", "const x = require('y');\n");
    assert.equal(detectModuleSystem(cwd, [f1, f2]), "mixed");
  });
});

// ─── 3. detectFileLayout ─────────────────────────────────────────────────────

describe("detectFileLayout", () => {
  it("lists top-level directories", () => {
    const cwd = track(makeTargetProject());
    fs.mkdirSync(path.join(cwd, "src"), { recursive: true });
    fs.mkdirSync(path.join(cwd, "docs"), { recursive: true });
    const layout = detectFileLayout(cwd);
    assert.ok(layout.topLevel.includes("src"));
    assert.ok(layout.topLevel.includes("docs"));
  });

  it("excludes node_modules from top-level", () => {
    const cwd = track(makeTargetProject());
    fs.mkdirSync(path.join(cwd, "node_modules"), { recursive: true });
    fs.mkdirSync(path.join(cwd, "src"), { recursive: true });
    const layout = detectFileLayout(cwd);
    assert.ok(!layout.topLevel.includes("node_modules"));
    assert.ok(layout.topLevel.includes("src"));
  });

  it("captures subdirs of src/", () => {
    const cwd = track(makeTargetProject());
    fs.mkdirSync(path.join(cwd, "src", "components"), { recursive: true });
    fs.mkdirSync(path.join(cwd, "src", "utils"), { recursive: true });
    const layout = detectFileLayout(cwd);
    assert.ok(layout.sourceDirs.includes("components"));
    assert.ok(layout.sourceDirs.includes("utils"));
  });

  it("samples file names from src/ for naming analysis", () => {
    const cwd = track(makeTargetProject());
    makeFile(cwd, "src/user-profile.ts", "");
    makeFile(cwd, "src/apiClient.ts", "");
    const layout = detectFileLayout(cwd);
    assert.ok(layout.sampledFileNames.some((f) => f.includes("user-profile")));
  });
});

// ─── 4. detectNaming ────────────────────────────────────────────────────────

describe("detectNaming", () => {
  it("classifyFilename detects kebab-case", () => {
    assert.equal(classifyFilename("user-profile.ts"), "kebab-case");
  });

  it("classifyFilename detects PascalCase", () => {
    assert.equal(classifyFilename("UserProfile.tsx"), "PascalCase");
  });

  it("classifyFilename detects camelCase", () => {
    assert.equal(classifyFilename("apiClient.ts"), "camelCase");
  });

  it("classifyFilename detects snake_case", () => {
    assert.equal(classifyFilename("user_profile.py"), "snake_case");
  });

  it("returns kebab-case when plurality is kebab", () => {
    const files = ["user-profile.ts", "api-client.ts", "home-page.tsx", "Header.tsx"];
    const n = detectNaming(files);
    assert.equal(n.file_style, "kebab-case");
  });

  it("returns PascalCase when plurality is PascalCase", () => {
    const files = ["UserProfile.tsx", "ApiClient.tsx", "HomePage.tsx", "index.ts"];
    const n = detectNaming(files);
    assert.equal(n.file_style, "PascalCase");
  });

  it("returns mixed when no style has >= 60% dominance", () => {
    const files = ["user-profile.ts", "UserProfile.tsx", "api_client.py"];
    const n = detectNaming(files);
    assert.equal(n.file_style, "mixed");
  });

  it("returns unknown for empty filenames array", () => {
    assert.equal(detectNaming([]).file_style, "unknown");
  });
});

// ─── 5. detectTooling ────────────────────────────────────────────────────────

describe("detectTooling", () => {
  it("detects tsconfig.json as typescript", () => {
    const cwd = track(makeTargetProject());
    fs.writeFileSync(path.join(cwd, "tsconfig.json"), "{}", "utf8");
    const t = detectTooling(cwd);
    assert.equal(t.typescript, true);
  });

  it("typescript is false when tsconfig.json absent", () => {
    const cwd = track(makeTargetProject());
    const t = detectTooling(cwd);
    assert.equal(t.typescript, false);
  });

  it("detects eslint.config.js", () => {
    const cwd = track(makeTargetProject());
    fs.writeFileSync(path.join(cwd, "eslint.config.js"), "module.exports=[];", "utf8");
    const t = detectTooling(cwd);
    assert.equal(t.eslint, true);
  });

  it("detects .prettierrc", () => {
    const cwd = track(makeTargetProject());
    fs.writeFileSync(path.join(cwd, ".prettierrc"), '{"semi":false}', "utf8");
    const t = detectTooling(cwd);
    assert.equal(t.prettier, true);
  });

  it("detects biome.json", () => {
    const cwd = track(makeTargetProject());
    fs.writeFileSync(path.join(cwd, "biome.json"), "{}", "utf8");
    const t = detectTooling(cwd);
    assert.equal(t.biome, true);
  });

  it("detects .husky directory", () => {
    const cwd = track(makeTargetProject());
    fs.mkdirSync(path.join(cwd, ".husky"), { recursive: true });
    const t = detectTooling(cwd);
    assert.equal(t.husky, true);
  });

  it("all false on empty project", () => {
    const cwd = track(makeTargetProject());
    const t = detectTooling(cwd);
    assert.equal(t.typescript, false);
    assert.equal(t.eslint, false);
    assert.equal(t.prettier, false);
    assert.equal(t.biome, false);
    assert.equal(t.husky, false);
    assert.equal(t.editorconfig, false);
  });
});

// ─── 6. detectTestConfig ─────────────────────────────────────────────────────

describe("detectTestConfig", () => {
  it("returns null framework when techStack.test_runner is null", () => {
    const cwd = track(makeTargetProject());
    const tc = detectTestConfig(cwd, { test_runner: null });
    assert.equal(tc.framework, null);
  });

  it("returns Jest pattern for Jest", () => {
    const cwd = track(makeTargetProject());
    const tc = detectTestConfig(cwd, { test_runner: "Jest" });
    assert.equal(tc.framework, "Jest");
    assert.ok(tc.pattern && tc.pattern.includes("test"));
  });

  it("detects co-located tests in src/", () => {
    const cwd = track(makeTargetProject());
    makeFile(cwd, "src/utils.ts", "export const x = 1;");
    makeFile(cwd, "src/utils.test.ts", "import { x } from './utils';");
    const tc = detectTestConfig(cwd, { test_runner: "Jest" });
    assert.equal(tc.co_located, true);
  });

  it("detects separate test directory", () => {
    const cwd = track(makeTargetProject());
    makeFile(cwd, "src/utils.ts", "export const x = 1;");
    makeFile(cwd, "tests/utils.test.ts", "import { x } from '../src/utils';");
    const tc = detectTestConfig(cwd, { test_runner: "Jest" });
    // tests/ is not a SRC_DIR so co_located check is in src/ — src has no test files
    assert.equal(tc.co_located, false);
  });
});

// ─── 7. detectCommonImports ──────────────────────────────────────────────────

describe("detectCommonImports", () => {
  it("counts import occurrences", () => {
    const cwd = track(makeTargetProject());
    const f1 = makeFile(cwd, "src/a.ts", "import React from 'react';\n");
    const f2 = makeFile(cwd, "src/b.ts", "import React from 'react';\nimport { useState } from 'react';\n");
    const imports = detectCommonImports([f1, f2]);
    const reactEntry = imports.find((i) => i.source === "react");
    assert.ok(reactEntry, "react should be in common imports");
    assert.ok(reactEntry.count >= 2);
  });

  it("skips relative imports", () => {
    const cwd = track(makeTargetProject());
    const f = makeFile(cwd, "src/a.ts", "import x from './utils';\nimport y from '../lib';\n");
    const imports = detectCommonImports([f]);
    assert.ok(!imports.some((i) => i.source.startsWith(".")));
  });

  it("skips node builtins", () => {
    const cwd = track(makeTargetProject());
    const f = makeFile(cwd, "src/a.js", "const fs = require('fs');\nconst path = require('node:path');\n");
    const imports = detectCommonImports([f]);
    assert.ok(!imports.some((i) => i.source === "fs" || i.source === "node:path"));
  });

  it("returns top 10 sorted by count descending", () => {
    const cwd = track(makeTargetProject());
    const lines = Array.from({ length: 12 }, (_, i) =>
      `import x${i} from 'pkg-${String(i).padStart(2, "0")}';\n`
    ).join("");
    // pkg-00 gets 3 extra occurrences
    const extra = "import extra from 'pkg-00';\nimport extra2 from 'pkg-00';\nimport extra3 from 'pkg-00';\n";
    const f = makeFile(cwd, "src/a.ts", lines + extra);
    const imports = detectCommonImports([f]);
    assert.ok(imports.length <= 10, "should return at most 10");
    assert.equal(imports[0].source, "pkg-00", "highest count should be first");
  });

  it("returns empty array when no source files", () => {
    const imports = detectCommonImports([]);
    assert.deepEqual(imports, []);
  });
});

// ─── 8. discover integration ─────────────────────────────────────────────────

describe("discover integration", () => {
  it("returns all expected top-level keys", () => {
    const cwd = track(makeTargetProject());
    const result = discover(cwd);
    const keys = ["timestamp", "cwd", "tech_stack", "module_system", "file_structure",
      "naming", "tooling", "test_config", "common_imports", "verification_commands"];
    for (const k of keys) assert.ok(k in result, `missing key: ${k}`);
  });

  it("timestamp is a valid ISO-8601 string", () => {
    const cwd = track(makeTargetProject());
    const result = discover(cwd);
    assert.ok(!isNaN(new Date(result.timestamp).getTime()), "timestamp should be parseable");
    assert.ok(result.timestamp.includes("T"), "timestamp should be ISO-8601");
  });

  it("cwd matches the provided cwd", () => {
    const cwd = track(makeTargetProject());
    const result = discover(cwd);
    assert.equal(result.cwd, cwd);
  });

  it("detects React project correctly end-to-end", () => {
    const cwd = track(makeTargetProject());
    makePkg(cwd, {
      name: "my-react-app",
      type: "module",
      dependencies: { react: "^18.2.0", "react-dom": "^18.2.0" },
      devDependencies: { vitest: "^1.0.0", typescript: "^5.0.0" },
    });
    fs.writeFileSync(path.join(cwd, "tsconfig.json"), "{}", "utf8");
    makeFile(cwd, "src/App.tsx", "import React from 'react';\nexport default function App() {}\n");
    makeFile(cwd, "src/App.test.tsx", "import { render } from '@testing-library/react';\n");

    const result = discover(cwd);
    assert.ok(result.tech_stack.languages.includes("TypeScript"));
    assert.ok(result.tech_stack.frameworks.includes("React"));
    assert.equal(result.tech_stack.test_runner, "Vitest");
    assert.equal(result.module_system, "esm");
    assert.equal(result.tooling.typescript, true);
  });
});

// ─── 9. formatReport ────────────────────────────────────────────────────────

describe("formatReport", () => {
  function makeResult(overrides = {}) {
    return {
      timestamp: "2026-06-07T12:00:00.000Z",
      cwd: "/fake/project",
      tech_stack: {
        languages: ["TypeScript"],
        frameworks: ["React"],
        test_runner: "Jest",
        bundler: "webpack",
        package_manager: "npm",
      },
      module_system: "esm",
      file_structure: { topLevel: ["src", "docs"], sourceDirs: ["components", "utils"], sampledFileNames: [] },
      naming: { file_style: "kebab-case" },
      tooling: { typescript: true, eslint: true, prettier: false, biome: false, husky: false, editorconfig: false },
      test_config: { framework: "Jest", co_located: true, pattern: "**/*.test.ts" },
      common_imports: [{ source: "react", count: 5 }, { source: "lodash", count: 2 }],
      verification_commands: ["npm test", "npm run lint"],
      ...overrides,
    };
  }

  it("contains ## Tech stack section", () => {
    assert.ok(formatReport(makeResult()).includes("## Tech stack"));
  });

  it("contains ## Module system section", () => {
    assert.ok(formatReport(makeResult()).includes("## Module system"));
  });

  it("contains ## File structure section", () => {
    assert.ok(formatReport(makeResult()).includes("## File structure"));
  });

  it("contains ## Naming conventions section", () => {
    assert.ok(formatReport(makeResult()).includes("## Naming conventions"));
  });

  it("contains ## Tooling section", () => {
    assert.ok(formatReport(makeResult()).includes("## Tooling"));
  });

  it("contains ## Test configuration section", () => {
    assert.ok(formatReport(makeResult()).includes("## Test configuration"));
  });

  it("contains ## Most-used imports when imports present", () => {
    assert.ok(formatReport(makeResult()).includes("## Most-used imports"));
  });

  it("omits ## Most-used imports when imports empty", () => {
    assert.ok(!formatReport(makeResult({ common_imports: [] })).includes("## Most-used imports"));
  });

  it("shows 'none detected' for missing frameworks", () => {
    const r = formatReport(makeResult({ tech_stack: { ...makeResult().tech_stack, frameworks: [] } }));
    assert.ok(r.includes("none detected"));
  });

  it("renders verification commands and ends with the automatic-pack note", () => {
    const r = formatReport(makeResult());
    assert.ok(r.includes("## Verification commands"));
    assert.ok(r.includes("`npm test`"));
    assert.ok(r.includes("included automatically in stage prompts"));
  });
});

// ─── 10. CLI tests ───────────────────────────────────────────────────────────

describe("CLI: devteam standards discover", () => {
  it("writes docs/project-conventions.md by default", () => {
    const cwd = track(makeTargetProject());
    const r = runCLI(["standards", "discover", "--cwd", cwd], { cwd });
    assert.equal(r.status, 0, `stderr: ${r.stderr}`);
    assert.ok(fs.existsSync(path.join(cwd, "docs", "project-conventions.md")));
    assert.ok(fs.existsSync(path.join(cwd, ".devteam", "knowledge", "project.json")));
  });

  it("--dry-run prints report without writing file", () => {
    const cwd = track(makeTargetProject());
    const r = runCLI(["standards", "discover", "--dry-run", "--cwd", cwd], { cwd });
    assert.equal(r.status, 0, `stderr: ${r.stderr}`);
    assert.ok(!fs.existsSync(path.join(cwd, "docs", "project-conventions.md")));
    assert.ok(r.stdout.includes("## Tech stack"));
  });

  it("--json emits valid JSON to stdout without writing file", () => {
    const cwd = track(makeTargetProject());
    const r = runCLI(["standards", "discover", "--json", "--cwd", cwd], { cwd });
    assert.equal(r.status, 0, `stderr: ${r.stderr}`);
    assert.ok(!fs.existsSync(path.join(cwd, "docs", "project-conventions.md")));
    const parsed = JSON.parse(r.stdout);
    assert.ok(parsed.timestamp);
    assert.ok(parsed.tech_stack);
  });

  it("exits 1 when docs/project-conventions.md already exists without --force", () => {
    const cwd = track(makeTargetProject());
    fs.mkdirSync(path.join(cwd, "docs"), { recursive: true });
    fs.writeFileSync(path.join(cwd, "docs", "project-conventions.md"), "existing content", "utf8");
    const r = runCLI(["standards", "discover", "--cwd", cwd], { cwd });
    assert.equal(r.status, 1);
    assert.equal(fs.readFileSync(path.join(cwd, "docs", "project-conventions.md"), "utf8"), "existing content");
  });

  it("--force overwrites existing docs/project-conventions.md", () => {
    const cwd = track(makeTargetProject());
    fs.mkdirSync(path.join(cwd, "docs"), { recursive: true });
    fs.writeFileSync(path.join(cwd, "docs", "project-conventions.md"), "old content", "utf8");
    const r = runCLI(["standards", "discover", "--force", "--cwd", cwd], { cwd });
    assert.equal(r.status, 0, `stderr: ${r.stderr}`);
    const content = fs.readFileSync(path.join(cwd, "docs", "project-conventions.md"), "utf8");
    assert.ok(content.includes("## Tech stack"), "should be new content");
  });

  it("unknown subcommand exits 2", () => {
    const cwd = track(makeTargetProject());
    const r = runCLI(["standards", "unknown-sub"], { cwd });
    assert.equal(r.status, 2);
  });
});
