"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { REPO_ROOT } = require("./_helpers");
const { invokeAdapterTask } = require(path.join(REPO_ROOT, "core", "adapters", "invoke-task"));

test("one-off model workflows do not spawn host commands from core", () => {
  for (const rel of ["core/a11y-fixer.js", "core/escalation.js", "core/learning/reflector.js"]) {
    const source = fs.readFileSync(path.join(REPO_ROOT, rel), "utf8");
    assert.doesNotMatch(source, /node:child_process/, `${rel} must invoke through an adapter`);
    assert.doesNotMatch(source, /splitCommand\s*\(/, `${rel} must not parse a host command`);
  }
});

test("invokeAdapterTask preserves the prompt and scopes the synthetic descriptor", async () => {
  let observed;
  const adapter = {
    capabilities: { headless: true },
    invoke: async (descriptor, ctx, prompt) => {
      observed = { descriptor, ctx, prompt };
      return { exitCode: 0, writeViolations: [] };
    },
  };

  const result = await invokeAdapterTask({
    adapter,
    host: "fixture",
    cwd: REPO_ROOT,
    prompt: "do exactly this",
    label: "fixture-task",
    role: "principal",
    allowedWrites: ["pipeline/context.md"],
    toolBudget: ["Read", "Write"],
    timeoutMs: 1234,
  });

  assert.equal(result.exitCode, 0);
  assert.equal(observed.prompt, "do exactly this");
  assert.equal(observed.descriptor.workstreamId, "fixture-task");
  assert.deepEqual(observed.descriptor.allowedWrites, ["pipeline/context.md"]);
  assert.deepEqual(observed.descriptor.toolBudget, ["Read", "Write"]);
  assert.equal(observed.ctx.timeoutMs, 1234);
  assert.equal(observed.ctx.forceWriteAudit, true);
});

test("invokeAdapterTask rejects a headless capability without adapter.invoke", async () => {
  await assert.rejects(
    invokeAdapterTask({
      adapter: { capabilities: { headless: true } },
      host: "legacy",
      cwd: REPO_ROOT,
      prompt: "x",
      label: "x",
      role: "x",
    }),
    /does not implement adapter\.invoke/,
  );
});
