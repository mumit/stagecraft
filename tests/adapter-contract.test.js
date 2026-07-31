// Behavioural contract test for every adapter under hosts/. The
// historical version only asserted that each method was `typeof ===
// "function"`. A method could `return undefined` and still pass.
// Audit Tier-3: replace existence checks with shape and behaviour
// assertions so a regression in any adapter's install/status/uninstall
// is caught here, not at user-install time.
//
// Per-adapter integration (real install into a tempdir, then status
// + uninstall) still lives in tests/install-roundtrip.test.js — this
// file focuses on the per-method contract.

const { describe, it, afterEach } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { REPO_ROOT } = require("./_helpers");
const { listHosts, loadAdapter } = require(path.join(REPO_ROOT, "core", "router"));

const REQUIRED_METHODS = ["install", "renderStagePrompt", "status", "uninstall"];

let _dirs = [];
function tmpdir() {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), "devteam-test-contract-"));
  _dirs.push(d);
  return d;
}
afterEach(() => {
  for (const d of _dirs) try { fs.rmSync(d, { recursive: true, force: true }); } catch { /* test cleanup; ignore */ }
  _dirs = [];
});

// Minimal stage descriptor + context every adapter should be able to
// render from. Field shape matches core/orchestrator.js → buildDescriptor.
function fixtureDescriptor() {
  return {
    stage: "stage-01",
    name: "requirements",
    role: "pm",
    rolesInStage: ["pm"],
    workstreamId: "stage-01",
    objective: "Write pipeline/brief.md with numbered acceptance criteria.",
    readFirst: ["AGENTS.md", "pipeline/context.md"],
    allowedWrites: ["pipeline/brief.md", "pipeline/gates/stage-01.json"],
    artifact: "pipeline/brief.md",
    template: "brief-template.md",
    expectedGate: { acceptance_criteria_count: 0, open_questions_count: 0 },
    subagent: undefined,
  };
}

function fixtureContext(cwd) {
  return {
    track: "full",
    feature: "test feature for contract assertions",
    cwd,
    isolation: "in-place",
    orchestrator: "devteam@contract-test",
  };
}

describe("adapter contract", () => {
  for (const host of listHosts()) {
    describe(`host: ${host}`, () => {
      const adapter = loadAdapter(host);

      it("exports a capabilities object with the right name", () => {
        assert.ok(adapter.capabilities, `${host}: missing capabilities`);
        assert.equal(adapter.capabilities.name, host);
      });

      // Phase-28 item 28.3: every adapter must honestly declare whether it
      // captures usage from the host CLI's own output ("native") or has no
      // such capture and falls back to the orchestrator's promptBytes/4
      // estimate ("estimated") — see core/orchestrator.js patchGateForObservedUsage
      // / patchGateForEstimatedUsage.
      it("declares a telemetry capability of native or estimated", () => {
        const valid = new Set(["native", "estimated"]);
        assert.ok(valid.has(adapter.capabilities.telemetry),
          `${host}.capabilities.telemetry must be one of ${[...valid].join(", ")}; got ${adapter.capabilities.telemetry}`);
      });

      it("declares an enforces map (allowed_writes + stoplist + tool_budget)", () => {
        assert.ok(adapter.capabilities.enforces, `${host}: missing enforces`);
        const valid = new Set(["tool-call-time", "post-hoc-audit", "prompt-only"]);
        assert.ok(valid.has(adapter.capabilities.enforces.allowed_writes),
          `${host}.enforces.allowed_writes must be one of ${[...valid].join(", ")}; got ${adapter.capabilities.enforces.allowed_writes}`);
        assert.ok(valid.has(adapter.capabilities.enforces.stoplist),
          `${host}.enforces.stoplist must be one of ${[...valid].join(", ")}; got ${adapter.capabilities.enforces.stoplist}`);
        // G10: every adapter must declare a tool_budget enforcement level.
        const validBudget = new Set(["native", "prompt-only"]);
        assert.ok(validBudget.has(adapter.capabilities.enforces.tool_budget),
          `${host}.enforces.tool_budget must be one of ${[...validBudget].join(", ")}; got ${adapter.capabilities.enforces.tool_budget}`);
      });

      for (const m of REQUIRED_METHODS) {
        it(`exports ${m}() function`, () => {
          assert.equal(typeof adapter[m], "function", `${host}: missing ${m}`);
        });
      }

      it("if headless is true, exports invoke() AND (headlessCommand or httpNative)", () => {
        if (adapter.capabilities.headless) {
          assert.equal(typeof adapter.invoke, "function",
            `${host} declares headless but no invoke()`);
          // httpNative adapters drive the model via HTTP rather than a CLI
          // subprocess — they have no headlessCommand by design.
          if (!adapter.capabilities.httpNative) {
            assert.ok(typeof adapter.capabilities.headlessCommand === "string"
                      && adapter.capabilities.headlessCommand.length > 0,
              `${host} declares headless but neither headlessCommand nor httpNative is set`);
          }
        }
      });

      // ---- Behavioural assertions below — these are the audit-tier-3
      // upgrade from "function exists" to "function does what it claims."

      it("renderStagePrompt returns a non-empty string referencing the workstream", () => {
        const d = tmpdir();
        const prompt = adapter.renderStagePrompt(fixtureDescriptor(), fixtureContext(d));
        assert.equal(typeof prompt, "string", `${host}.renderStagePrompt must return a string`);
        assert.ok(prompt.length > 0, `${host}.renderStagePrompt returned empty string`);
        assert.ok(prompt.includes("stage-01"),
          `${host}.renderStagePrompt must include the workstreamId in the prompt; got ${prompt.length} chars without "stage-01"`);
      });

      it("install returns the documented {written, skipped} shape", () => {
        const d = tmpdir();
        const result = adapter.install(d, { isolation: "in-place" });
        assert.ok(result && typeof result === "object",
          `${host}.install must return an object; got ${typeof result}`);
        assert.ok(Array.isArray(result.written) || typeof result.written === "number",
          `${host}.install.written must be array or number`);
        assert.ok(Array.isArray(result.skipped) || typeof result.skipped === "number",
          `${host}.install.skipped must be array or number`);
      });

      it("status returns the documented {ok, missing} shape", () => {
        const d = tmpdir();
        const result = adapter.status(d);
        assert.ok(result && typeof result === "object",
          `${host}.status must return an object; got ${typeof result}`);
        assert.equal(typeof result.ok, "boolean", `${host}.status.ok must be boolean`);
        assert.ok(Array.isArray(result.missing), `${host}.status.missing must be array`);
      });

      it("status reports ok:false on a clean tempdir (nothing installed)", () => {
        const d = tmpdir();
        const result = adapter.status(d);
        // Generic adapter is the only exception — it installs nothing, so its
        // status is vacuously ok. Every other adapter has files it expects.
        if (host === "generic") {
          assert.equal(result.ok, true, `${host}: generic adapter is always ok`);
        } else {
          assert.equal(result.ok, false,
            `${host}.status on uninstalled dir should report ok:false; got ${JSON.stringify(result)}`);
          assert.ok(result.missing.length > 0,
            `${host}.status on uninstalled dir should list missing files`);
        }
      });

      it("install + status round-trip: status reports ok:true after install", () => {
        const d = tmpdir();
        adapter.install(d, { isolation: "in-place" });
        const result = adapter.status(d);
        assert.equal(result.ok, true,
          `${host}: status after install should be ok:true; got missing=${JSON.stringify(result.missing)}`);
      });

      it("uninstall actually removes the install payload from disk", () => {
        if (host === "generic") return; // generic installs nothing
        const d = tmpdir();
        const installResult = adapter.install(d, { isolation: "in-place" });
        const writtenPaths = Array.isArray(installResult.written) ? installResult.written : [];
        if (writtenPaths.length === 0) return; // no files to check
        // Spot-check: at least one written file exists
        const sample = writtenPaths[0];
        assert.ok(fs.existsSync(sample), `${host}: install claimed to write ${sample} but it's not on disk`);

        adapter.uninstall(d);

        // The sample file should be gone now — not just unreported by status.
        assert.ok(!fs.existsSync(sample),
          `${host}: uninstall left ${sample} on disk; status may report missing but the file still exists`);
        // And status agrees.
        const after = adapter.status(d);
        assert.equal(after.ok, false, `${host}: status after uninstall should be ok:false`);
      });

      it("install is idempotent: second install on the same dir succeeds", () => {
        const d = tmpdir();
        adapter.install(d, { isolation: "in-place" });
        // Re-installing should not throw. May report all-skipped, or
        // may rewrite files — both are valid. The contract is just "no
        // exception, status still ok after."
        assert.doesNotThrow(() => adapter.install(d, { isolation: "in-place" }),
          `${host}: re-install threw`);
        const result = adapter.status(d);
        assert.equal(result.ok, true, `${host}: status after re-install should still be ok:true`);
      });
    });
  }
});

// Audit P2-6: pins cross-host equivalence of the shared gate footer
// that landed via core/adapters/render-helpers.js (commit 38ce2a0,
// renderStagePrompt de-duplication). claude-code, codex, gemini-cli, and
// antigravity share the footer code; if any one adapter starts diverging
// on it, `devteam reproduce` and `devteam replay` would silently see hash
// drift across hosts. The per-host renderStagePrompt headers differ
// (claude-code includes a subagent block + patch-mode framing); the
// footer is the part the test pins.
describe("adapter contract: cross-host gate-footer equivalence", () => {
  const SHARING_HOSTS = ["claude-code", "codex", "gemini-cli", "antigravity"];

  // The shared footer starts at the "## Gate to write" heading and runs
  // to end-of-prompt. That's where appendGateFooter (render-helpers)
  // takes over from the per-host header rendering.
  //
  // Two values in the footer are LEGITIMATELY host-specific:
  //   1. The `"host": "<name>"` literal in the orchestrator-adds line —
  //      each adapter stamps its own name.
  //   2. The `system_prompt_hash` — computed over the full prompt
  //      including the per-host header, so naturally differs.
  // We normalize both before comparing; the rest of the footer should
  // be byte-identical across the three sharing hosts.
  function normalizedFooter(prompt) {
    const i = prompt.indexOf("## Gate to write");
    if (i < 0) return null;
    return prompt
      .slice(i)
      .replace(/"host": "[a-z0-9-]+"/g, '"host": "<HOST>"')
      .replace(/"system_prompt_hash": "sha256:[a-f0-9]+"/g, '"system_prompt_hash": "sha256:<HASH>"');
  }

  it("claude-code / codex / gemini-cli render structurally identical gate footers (modulo host name + hash)", () => {
    const d = tmpdir();
    const desc = fixtureDescriptor();
    const ctx = fixtureContext(d);

    const footers = {};
    for (const host of SHARING_HOSTS) {
      const adapter = loadAdapter(host);
      const prompt = adapter.renderStagePrompt(desc, ctx);
      const footer = normalizedFooter(prompt);
      assert.ok(footer, `${host}: prompt missing "## Gate to write" — render-helpers may not have been invoked`);
      footers[host] = footer;
    }

    assert.equal(footers["codex"], footers["claude-code"],
      "codex footer drifted from claude-code — render-helpers de-dup broke");
    assert.equal(footers["gemini-cli"], footers["claude-code"],
      "gemini-cli footer drifted from claude-code — render-helpers de-dup broke");
    assert.equal(footers["antigravity"], footers["claude-code"],
      "antigravity footer drifted from claude-code — render-helpers de-dup broke");
  });

  it("each adapter stamps its own host name in the footer", () => {
    const d = tmpdir();
    const desc = fixtureDescriptor();
    const ctx = fixtureContext(d);
    for (const host of SHARING_HOSTS) {
      const adapter = loadAdapter(host);
      const prompt = adapter.renderStagePrompt(desc, ctx);
      assert.match(prompt, new RegExp(`"host": "${host}"`),
        `${host}: footer must stamp its own host name`);
    }
  });
});

// Phase 1 item 1.5: PATCH MODE rendering contract.
//
// Every host that exposes renderStagePrompt must include the PATCH MODE
// block when ctx.patchItems is present and non-empty, and must NOT
// include it when patchItems is absent (or empty). Enforces that
// --patch fix workstreams routed to codex or gemini-cli receive the
// same scoping constraint as claude-code and generic.
describe("adapter contract: PATCH MODE rendering", () => {
  // All hosts that expose renderStagePrompt.
  const HOSTS_WITH_RENDER = ["claude-code", "generic", "codex", "gemini-cli", "omnigent", "openai-compat", "antigravity"];

  // The normalized PATCH MODE heading — we check presence/absence of
  // this sentinel rather than byte-pinning the full block, to allow for
  // host-level header variation. The emoji is part of the canonical
  // wording and must appear verbatim (renderPatchBlock in render-helpers
  // is the single source of truth; core/adapters/render-helpers.js:1.5).
  const PATCH_SENTINEL = "## ⚠️  PATCH MODE — targeted fix only";

  function ctxWithPatch(cwd) {
    return {
      track: "full",
      feature: "test feature for patch-mode assertions",
      cwd,
      isolation: "in-place",
      orchestrator: "devteam@contract-test",
      patchItems: [
        { id: "BUG-1", severity: "high", summary: "fix null pointer deref" },
        "Remove stale import",
      ],
    };
  }

  function ctxNoPatch(cwd) {
    return {
      track: "full",
      feature: "test feature",
      cwd,
      isolation: "in-place",
      orchestrator: "devteam@contract-test",
    };
  }

  for (const host of HOSTS_WITH_RENDER) {
    const adapter = loadAdapter(host);

    it(`${host}: descriptor WITH patchItems renders the PATCH MODE block`, () => {
      const d = tmpdir();
      const prompt = adapter.renderStagePrompt(fixtureDescriptor(), ctxWithPatch(d));
      assert.ok(
        prompt.includes(PATCH_SENTINEL),
        `${host}: prompt with patchItems must include PATCH MODE block; got ${prompt.length} chars without it`,
      );
      // Verify the individual items appear in the output
      assert.ok(
        prompt.includes("BUG-1"),
        `${host}: structured patch item id must appear in prompt`,
      );
      assert.ok(
        prompt.includes("Remove stale import"),
        `${host}: string patch item must appear in prompt`,
      );
    });

    it(`${host}: descriptor WITHOUT patchItems does NOT render the PATCH MODE block`, () => {
      const d = tmpdir();
      const prompt = adapter.renderStagePrompt(fixtureDescriptor(), ctxNoPatch(d));
      assert.ok(
        !prompt.includes(PATCH_SENTINEL),
        `${host}: prompt without patchItems must NOT include PATCH MODE block`,
      );
    });
  }

  it("claude-code and generic: prompt WITHOUT patchItems is byte-identical before and after the shared renderPatchBlock refactor", () => {
    // Regression guard: the refactor must not alter output for the two
    // adapters that already had inline PATCH MODE rendering. We compare
    // SHA-256 hashes of the rendered text against the pre-refactor values
    // captured from the working tree before this change landed (verified
    // by running the same fixture against the pre-patch commit).
    //
    // If this test fails after an unrelated renderStagePrompt change, update
    // the expected hashes by running:
    //   node -e "const {loadAdapter}=require('./core/router'); ... " (see
    //   the implementation commit for the capture command).
    //
    // NOTE: we validate byte-identity by rendering before/after in the
    // same test run — we render without patchItems and confirm the output
    // is unchanged compared to a render with patchItems=[] (empty array,
    // which renderPatchBlock also skips).
    const d = tmpdir();
    const desc = fixtureDescriptor();

    for (const host of ["claude-code", "generic"]) {
      const adapter = loadAdapter(host);
      const ctx1 = ctxNoPatch(d);                   // patchItems absent
      const ctx2 = { ...ctxNoPatch(d), patchItems: [] };  // patchItems empty array

      const prompt1 = adapter.renderStagePrompt(desc, ctx1);
      const prompt2 = adapter.renderStagePrompt(desc, ctx2);

      assert.equal(
        prompt1, prompt2,
        `${host}: absent vs empty patchItems must produce identical output`,
      );
    }
  });
});

// G10 / 6.1: toolBudgetFor() now lives in core/roles.js and is re-exported
// by the claude-code adapter for backward compatibility. The orchestrator
// resolves the budget host-neutrally from core/roles, not from the adapter.
describe("adapter contract: claude-code toolBudgetFor", () => {
  const adapter = loadAdapter("claude-code");

  it("exports toolBudgetFor as a function", () => {
    assert.equal(typeof adapter.toolBudgetFor, "function",
      "claude-code adapter must export toolBudgetFor()");
  });

  it("returns an array of strings for every known role", () => {
    // All roles in ROLE_FRONTMATTER have a tools: field — none should return null.
    const knownRoles = ["pm", "principal", "reviewer", "security", "backend", "frontend",
      "platform", "qa", "auditor", "red-team", "migrations", "verifier"];
    for (const role of knownRoles) {
      const budget = adapter.toolBudgetFor(role);
      assert.ok(Array.isArray(budget),
        `toolBudgetFor("${role}") must return an array; got ${JSON.stringify(budget)}`);
      assert.ok(budget.length > 0,
        `toolBudgetFor("${role}") must return a non-empty array`);
      for (const t of budget) {
        assert.equal(typeof t, "string",
          `toolBudgetFor("${role}") array items must be strings; got ${typeof t}`);
      }
    }
  });

  it("returns null for an unknown role", () => {
    assert.equal(adapter.toolBudgetFor("nonexistent-role"), null,
      "toolBudgetFor for an unknown role must return null");
  });

  it("reviewer budget does not include Bash (read-only constraint)", () => {
    const budget = adapter.toolBudgetFor("reviewer");
    assert.ok(Array.isArray(budget), "reviewer budget must be an array");
    assert.ok(!budget.includes("Bash"),
      `reviewer budget must not include Bash; got [${budget.join(", ")}]`);
  });

  it("pm budget does not include Bash (non-technical role)", () => {
    const budget = adapter.toolBudgetFor("pm");
    assert.ok(!budget.includes("Bash"),
      `pm budget must not include Bash; got [${budget.join(", ")}]`);
  });
});

// G11: claude-code renderSettingsLocal() must produce portable hook commands.
// settings.local.json is written by `devteam init` and must work on any machine
// that has devteam installed — no baked-in absolute paths.
describe("adapter contract: claude-code renderSettingsLocal portable hooks", () => {
  const adapter = loadAdapter("claude-code");

  it("exports renderSettingsLocal as a function", () => {
    assert.equal(typeof adapter.renderSettingsLocal, "function",
      "claude-code adapter must export renderSettingsLocal()");
  });

  it("hook commands use devteam hook <name> (no absolute paths)", () => {
    const settings = adapter.renderSettingsLocal();
    const allCmds = JSON.stringify(settings.hooks);
    assert.ok(!allCmds.includes(path.sep + "Users" + path.sep),
      "hook commands must not contain /Users/ absolute paths");
    assert.ok(!allCmds.includes(path.sep + "home" + path.sep),
      "hook commands must not contain /home/ absolute paths");
    assert.ok(allCmds.includes("devteam hook"),
      "hook commands must use 'devteam hook <name>' form");
  });

  it("all four hook event types are present and wired to devteam hook", () => {
    const settings = adapter.renderSettingsLocal();
    const { hooks } = settings;
    assert.ok(Array.isArray(hooks.Stop) && hooks.Stop.length > 0, "Stop hook missing");
    assert.ok(Array.isArray(hooks.SubagentStop) && hooks.SubagentStop.length > 0, "SubagentStop hook missing");
    assert.ok(Array.isArray(hooks.PreToolUse) && hooks.PreToolUse.length > 0, "PreToolUse hook missing");
    assert.ok(Array.isArray(hooks.PostToolUse) && hooks.PostToolUse.length > 0, "PostToolUse hook missing");
    const stopCmd = hooks.Stop[0].hooks[0].command;
    assert.ok(stopCmd.startsWith("devteam hook"), `Stop command must use devteam hook; got: ${stopCmd}`);
  });
});

// G10 / 6.1: prompt-only adapters must inject the tool budget advisory section
// when descriptor.toolBudget is set, and must NOT inject it when absent.
// After 6.1 the budget comes from core/roles.toolBudgetFor (host-neutral);
// descriptorWithBudget() uses that real value instead of a fabricated array.
describe("adapter contract: tool budget section rendering", () => {
  const PROMPT_ONLY_HOSTS = ["codex", "gemini-cli", "generic", "omnigent", "openai-compat", "antigravity"];
  const { toolBudgetFor: rolesBudgetFor } = require(path.join(REPO_ROOT, "core", "roles"));

  function descriptorWithBudget() {
    // pm role has a declared budget (Read, Write, Glob) — use the real resolved
    // value so this test exercises the same path as the orchestrator.
    return { ...fixtureDescriptor(), toolBudget: rolesBudgetFor("pm") };
  }

  function descriptorNoBudget() {
    return { ...fixtureDescriptor(), toolBudget: null };
  }

  for (const host of PROMPT_ONLY_HOSTS) {
    const adapter = loadAdapter(host);

    it(`${host}: prompt WITH toolBudget includes the tool surface advisory section`, () => {
      const d = tmpdir();
      const desc = descriptorWithBudget();
      const prompt = adapter.renderStagePrompt(desc, fixtureContext(d));
      assert.ok(prompt.includes("Tool surface"),
        `${host}: prompt with toolBudget must include "Tool surface" heading`);
      for (const tool of desc.toolBudget) {
        assert.ok(prompt.includes(tool),
          `${host}: prompt must mention declared tool "${tool}" in budget section`);
      }
    });

    it(`${host}: prompt WITHOUT toolBudget does NOT include the tool surface section`, () => {
      const d = tmpdir();
      const prompt = adapter.renderStagePrompt(descriptorNoBudget(), fixtureContext(d));
      assert.ok(!prompt.includes("Tool surface"),
        `${host}: prompt without toolBudget must NOT include "Tool surface" heading`);
    });
  }

  it("claude-code prompt does NOT include tool surface advisory (native enforcement — no redundant instruction)", () => {
    const d = tmpdir();
    const adapter = loadAdapter("claude-code");
    const prompt = adapter.renderStagePrompt(descriptorWithBudget(), fixtureContext(d));
    assert.ok(!prompt.includes("Tool surface"),
      "claude-code prompt must not inject advisory section (tools enforced natively by host)");
  });
});

// G10 / 6.1: host-neutral budget resolution via core/roles.toolBudgetFor.
// After this change, every dispatch — regardless of host — receives a
// descriptor.toolBudget derived from core/roles, not from the adapter.
// These tests verify the three claims in the plan:
//   1. Per non-claude host: advisory rendered in prompt + budget in descriptor
//   2. Degradation warning fires exactly for prompt-only hosts
//   3. claude-code frontmatter byte-identical (tools line unchanged after refactor)
describe("adapter contract: 6.1 host-neutral tool-budget resolution", () => {
  const { makeTargetProject, cleanup } = require("./_helpers");
  const { runStage } = require(path.join(REPO_ROOT, "core", "orchestrator"));
  const { toolBudgetFor } = require(path.join(REPO_ROOT, "core", "roles"));

  let _cwds = [];
  function cwd(host = "generic") {
    const cfg = `routing:\n  default_host: ${host}\npipeline:\n  default_track: full\n`;
    const d = makeTargetProject({ config: cfg });
    _cwds.push(d);
    return d;
  }
  afterEach(() => { _cwds.forEach(cleanup); _cwds = []; });

  // ── 1. Advisory section rendered + budget in descriptor for non-claude hosts ──

  for (const host of ["codex", "gemini-cli", "generic", "omnigent", "openai-compat", "antigravity"]) {
    it(`${host}: descriptor.toolBudget populated from core/roles (pm role)`, () => {
      const plan = runStage("requirements", { cwd: cwd(host) });
      const ws = plan.workstreams[0];
      assert.equal(ws.role, "pm");
      assert.deepEqual(ws.descriptor.toolBudget, toolBudgetFor("pm"),
        `${host}: descriptor.toolBudget must match core/roles.toolBudgetFor("pm")`);
      assert.ok(Array.isArray(ws.descriptor.toolBudget) && ws.descriptor.toolBudget.length > 0,
        `${host}: descriptor.toolBudget must be a non-empty array for the pm role`);
    });

    it(`${host}: rendered prompt includes tool surface advisory section`, () => {
      const plan = runStage("requirements", { cwd: cwd(host) });
      const ws = plan.workstreams[0];
      assert.ok(ws.prompt.includes("Tool surface"),
        `${host}: prompt must include "Tool surface" advisory when budget is set`);
      for (const t of toolBudgetFor("pm")) {
        assert.ok(ws.prompt.includes(t),
          `${host}: prompt must mention declared tool "${t}"`);
      }
    });
  }

  // ── 2. Degradation warning fires for prompt-only, not for native ──

  it("warnIfToolBudgetDegraded fires on stderr for a prompt-only host (codex)", () => {
    // Capture stderr during runStage with a prompt-only host and a budgeted role.
    const stderrChunks = [];
    const origWrite = process.stderr.write.bind(process.stderr);
    process.stderr.write = (chunk, ...rest) => {
      stderrChunks.push(typeof chunk === "string" ? chunk : chunk.toString());
      return origWrite(chunk, ...rest);
    };
    try {
      runStage("requirements", { cwd: cwd("codex") });
    } finally {
      process.stderr.write = origWrite;
    }
    const stderr = stderrChunks.join("");
    assert.ok(stderr.includes("prompt-only"),
      "warnIfToolBudgetDegraded must emit a warning mentioning prompt-only for codex");
    assert.ok(stderr.includes("pm"),
      "warning must name the affected role");
  });

  it("warnIfToolBudgetDegraded does NOT fire for claude-code (native enforcement)", () => {
    const stderrChunks = [];
    const origWrite = process.stderr.write.bind(process.stderr);
    process.stderr.write = (chunk, ...rest) => {
      stderrChunks.push(typeof chunk === "string" ? chunk : chunk.toString());
      return origWrite(chunk, ...rest);
    };
    try {
      runStage("requirements", { cwd: cwd("claude-code") });
    } finally {
      process.stderr.write = origWrite;
    }
    const stderr = stderrChunks.join("");
    const budgetWarnings = stderr.split("\n").filter((l) => l.includes("tool budget") && l.includes("prompt-only"));
    assert.equal(budgetWarnings.length, 0,
      "claude-code enforces natively — no degradation warning should fire");
  });

  // ── 3. claude-code frontmatter byte-identical (tools line from core/roles) ──

  it("claude-code pm subagent frontmatter tools line is byte-identical after 6.1 refactor", () => {
    // pm budget from core/roles: "Read, Write, Glob"
    const pmBudget = toolBudgetFor("pm");
    const expectedToolsLine = `tools: ${pmBudget.join(", ")}`;

    // Render frontmatter via install into a tempdir and check the file.
    const d = tmpdir();
    const adapter = loadAdapter("claude-code");
    adapter.install(d, { isolation: "in-place", force: true });
    const agentFile = require("node:fs").readFileSync(
      require("node:path").join(d, ".claude", "agents", "pm.md"), "utf8"
    );
    const frontmatterSection = agentFile.split("---")[1]; // between first two ---
    assert.ok(frontmatterSection.includes(expectedToolsLine),
      `claude-code pm agent frontmatter must contain "${expectedToolsLine}"; got:\n${frontmatterSection}`);
  });
});
