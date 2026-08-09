// Adapter-owned invocation for one-off model tasks that are not pipeline
// stages (for example remediation, rulings, and reflection).
//
// The core may plan these tasks, but it must not parse headlessCommand or
// spawn a model process itself. Every headless adapter already owns invoke();
// this helper supplies the smallest synthetic descriptor needed to use that
// same transport, logging, timeout, telemetry, and write-audit boundary.

"use strict";

async function invokeAdapterTask({
  adapter,
  host,
  cwd,
  prompt,
  label,
  role,
  allowedWrites = [],
  toolBudget = null,
  timeoutMs = 0,
  changeId = null,
  tee = false,
}) {
  if (!adapter?.capabilities?.headless) {
    throw new Error(`host "${host}" does not support headless invocation`);
  }
  if (typeof adapter.invoke !== "function") {
    throw new Error(`headless host "${host}" does not implement adapter.invoke()`);
  }

  const descriptor = {
    stage: label,
    name: label,
    role,
    rolesInStage: [role],
    workstreamId: label,
    objective: label,
    readFirst: [],
    allowedWrites,
    artifact: "",
    template: "",
    expectedGate: {},
    goalCondition: null,
    toolBudget,
  };
  const ctx = {
    cwd,
    changeId,
    isolation: changeId ? "bounded" : "in-place",
    timeoutMs,
    log: true,
    tee,
    // Synthetic prompts do not contain the normal rendered allowed-writes
    // section. Keep a post-hoc defense even for a host that ordinarily
    // declares tool-call-time enforcement through its stage prompt/hooks.
    forceWriteAudit: true,
  };
  return adapter.invoke(descriptor, ctx, prompt);
}

module.exports = { invokeAdapterTask };
