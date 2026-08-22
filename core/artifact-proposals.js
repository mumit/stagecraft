"use strict";

const crypto = require("node:crypto");
const fs = require("node:fs");
const path = require("node:path");
const { scanContent } = require("./hooks/secret-scan");
const { gatesDir, pipelineRoot } = require("./paths");
const { STAGES } = require("./pipeline/stages");

const SCHEMA = "stagecraft.artifact-proposal/v1";
const MAX_ARTIFACT_BYTES = 64 * 1024;
const KINDS = {
  requirements: { artifact: "brief.md", root_stage: "stage-01" },
  design: { artifact: "design-spec.md", root_stage: "stage-02" },
  // A ruling resolves an escalation rather than restating an artifact, so it
  // invalidates nothing: root_stage null means "no downstream gates depend on
  // this". It is also appended rather than replaced -- see appendRuling in
  // core/rulings-proposal.js, which computes the replacement locally so the
  // model never rewrites pipeline/context.md wholesale.
  ruling: { artifact: "context.md", root_stage: null, append: true },
};

function digest(content) {
  return `sha256:${crypto.createHash("sha256").update(content).digest("hex")}`;
}

function proposalDir(cwd, changeId) {
  return path.join(pipelineRoot(cwd, changeId), "proposals");
}

function proposalPath(cwd, changeId, id) {
  if (!/^[a-f0-9]{16}$/.test(id || "")) throw new Error("invalid proposal id");
  return path.join(proposalDir(cwd, changeId), `${id}.json`);
}

function proposalEventsPath(cwd, changeId) {
  return path.join(proposalDir(cwd, changeId), "events.jsonl");
}

function appendProposalEvent(cwd, changeId, proposal, event) {
  const row = {
    schema: SCHEMA,
    ts: new Date().toISOString(),
    event,
    proposal_id: proposal.id,
    kind: proposal.kind,
    artifact: proposal.artifact,
    status: proposal.status,
    affected_gate_count: Array.isArray(proposal.affected_gates) ? proposal.affected_gates.length : null,
    provenance: proposal.provenance || null,
    counters: proposal.counters || null,
  };
  try {
    fs.mkdirSync(proposalDir(cwd, changeId), { recursive: true });
    fs.appendFileSync(proposalEventsPath(cwd, changeId), `${JSON.stringify(row)}\n`, { encoding: "utf8", mode: 0o600 });
    return true;
  } catch (err) {
    process.stderr.write(`[devteam] proposal audit: could not append ${event}: ${err.message}\n`);
    return false;
  }
}

function atomicWrite(file, content, mode = 0o600) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const temporary = `${file}.${process.pid}.${crypto.randomBytes(4).toString("hex")}.tmp`;
  try {
    fs.writeFileSync(temporary, content, { encoding: "utf8", mode });
    fs.renameSync(temporary, file);
  } finally {
    try { fs.unlinkSync(temporary); } catch { /* renamed or best-effort cleanup */ }
  }
}

function unifiedReplacementDiff(relative, before, after) {
  const oldLines = before.endsWith("\n") ? before.slice(0, -1).split("\n") : before.split("\n");
  const newLines = after.endsWith("\n") ? after.slice(0, -1).split("\n") : after.split("\n");

  // Trim the lines both sides share at the head and tail. For a whole-file
  // rewrite there is usually nothing in common and the output is unchanged --
  // every line removed, every line added, which is what a replacement is. For
  // an append (the `ruling` kind) it collapses to the lines that actually
  // changed. Reviewing a one-line addition rendered as "the entire file was
  // replaced" defeats the point of having a review step.
  let head = 0;
  while (head < oldLines.length && head < newLines.length && oldLines[head] === newLines[head]) head++;
  let tail = 0;
  while (
    tail < oldLines.length - head
    && tail < newLines.length - head
    && oldLines[oldLines.length - 1 - tail] === newLines[newLines.length - 1 - tail]
  ) tail++;

  const oldChanged = oldLines.slice(head, oldLines.length - tail);
  const newChanged = newLines.slice(head, newLines.length - tail);
  const out = [
    `--- a/${relative}`,
    `+++ b/${relative}`,
    `@@ -${head + 1},${oldChanged.length} +${head + 1},${newChanged.length} @@`,
    ...oldChanged.map((line) => `-${line}`),
    ...newChanged.map((line) => `+${line}`),
  ];
  return out.join("\n") + "\n";
}

function stageIndex(stageId) {
  return Object.values(STAGES).findIndex((stage) => stage.stage === stageId);
}

function affectedGatePaths(cwd, changeId, rootStage) {
  // A kind with no root stage invalidates nothing. Without this, stageIndex()
  // returns -1 for a null stage and the `index >= rootIndex` filter below
  // matches every stage -- so "invalidates nothing" would have silently meant
  // "invalidates everything".
  if (!rootStage) return [];
  const rootIndex = stageIndex(rootStage);
  let names;
  try { names = fs.readdirSync(gatesDir(cwd, changeId)); } catch { return []; }
  const affectedStageIds = new Set(Object.values(STAGES)
    .filter((_, index) => index >= rootIndex)
    .map((stage) => stage.stage));
  const relativeGateDir = path.relative(cwd, gatesDir(cwd, changeId)).replace(/\\/g, "/");
  return names.filter((name) => name.endsWith(".json") && [...affectedStageIds]
    .some((stageId) => name === `${stageId}.json` || name.startsWith(`${stageId}.`)))
    .sort()
    .map((name) => `${relativeGateDir}/${name}`);
}

function parseReplacementOutput(output) {
  let text = String(output || "").trim();
  const fenced = text.match(/^```(?:json)?\s*([\s\S]*?)\s*```$/i);
  if (fenced) text = fenced[1];
  let parsed;
  try { parsed = JSON.parse(text); } catch { throw new Error("refinement host returned malformed proposal JSON"); }
  if (!parsed || parsed.schema !== SCHEMA || typeof parsed.content !== "string") {
    throw new Error(`refinement host must return {schema:"${SCHEMA}", content:string}`);
  }
  if (Object.keys(parsed).sort().join(",") !== "content,schema") {
    throw new Error("refinement proposal contains unsupported fields");
  }
  const bytes = Buffer.byteLength(parsed.content, "utf8");
  if (bytes === 0 || bytes > MAX_ARTIFACT_BYTES) throw new Error(`refinement content must be 1..${MAX_ARTIFACT_BYTES} bytes`);
  if (scanContent(parsed.content).length > 0) throw new Error("refinement content contains secret-like material");
  return parsed.content;
}

function createProposal({ cwd, changeId = null, kind, replacement, host, model, usage }) {
  const spec = KINDS[kind];
  if (!spec) throw new Error("refinement kind must be requirements or design");
  if (typeof replacement !== "string") throw new Error("replacement content is required");
  const artifactPath = path.join(pipelineRoot(cwd, changeId), spec.artifact);
  const artifactRelative = path.relative(cwd, artifactPath).replace(/\\/g, "/");
  let before;
  try { before = fs.readFileSync(artifactPath, "utf8"); } catch { throw new Error(`${artifactRelative} does not exist`); }
  if (replacement === before) throw new Error("refinement produced no artifact change");
  const now = new Date();
  const id = crypto.randomBytes(8).toString("hex");
  const affectedGates = affectedGatePaths(cwd, changeId, spec.root_stage);
  const proposal = {
    schema: SCHEMA,
    id,
    status: "pending",
    created_at: now.toISOString(),
    expires_at: new Date(now.getTime() + 7 * 24 * 60 * 60 * 1000).toISOString(),
    kind,
    artifact: artifactRelative,
    base_sha256: digest(before),
    replacement,
    replacement_sha256: digest(replacement),
    diff: unifiedReplacementDiff(artifactRelative, before, replacement),
    affected_gates: affectedGates,
    provenance: { host: host || null, model: model || null },
    counters: {
      turns: 1,
      proposal_bytes: Buffer.byteLength(replacement, "utf8"),
      affected_gate_count: affectedGates.length,
      tokens_in: Number.isFinite(usage?.tokensIn) ? usage.tokensIn : null,
      tokens_out: Number.isFinite(usage?.tokensOut) ? usage.tokensOut : null,
      cached_tokens: Number.isFinite(usage?.cachedTokens) ? usage.cachedTokens : null,
      cost_usd: Number.isFinite(usage?.costUsd) ? usage.costUsd : null,
      latency_ms: Number.isFinite(usage?.durationMs) ? usage.durationMs : null,
    },
  };
  atomicWrite(proposalPath(cwd, changeId, id), `${JSON.stringify(proposal, null, 2)}\n`);
  appendProposalEvent(cwd, changeId, proposal, "created");
  return proposal;
}

function loadProposal(cwd, changeId, id) {
  const file = proposalPath(cwd, changeId, id);
  let proposal;
  try { proposal = JSON.parse(fs.readFileSync(file, "utf8")); } catch { throw new Error(`proposal ${id} was not found or is malformed`); }
  if (proposal.schema !== SCHEMA || proposal.id !== id) throw new Error(`proposal ${id} has invalid identity`);
  return { proposal, file };
}

function updateProposal(file, proposal) {
  atomicWrite(file, `${JSON.stringify(proposal, null, 2)}\n`);
}

// An apply that is interrupted -- a crash, a kill, a full disk during the
// artifact write -- leaves its transaction directory behind holding the gates
// it had already moved out of the way. applyProposal's rollback deliberately
// preserves that directory rather than risk losing them ("recovery remains
// visible in .apply directory"), but nothing ever put them back.
//
// The consequence was worse than a stranded directory. The next apply computed
// affectedGatePaths from a gates/ directory that was now missing those files,
// found a smaller set than the proposal recorded, and marked the proposal
// permanently stale -- reporting "its invalidation set changed" while the
// operator's gate sat inside a dotted directory nothing mentions. They lost the
// proposal and, as far as the pipeline could tell, the stage that produced the
// gate.
//
// So recovery runs first, before status or staleness is judged, and puts the
// gates back where the proposal was created against. Only files named like
// gates are moved, and never over a gate that already exists -- a live file is
// always newer than one an interrupted transaction set aside. Anything else in
// the directory is left there, and the directory with it, so an unexplained
// leftover stays visible rather than being silently deleted.
const GATE_FILE = /^stage-\d{2}[a-z]?(\.[^.]+)?\.json$/;

function recoverInterruptedApply(cwd, changeId, id) {
  const transaction = path.join(proposalDir(cwd, changeId), `.apply-${id}`);
  let names;
  try { names = fs.readdirSync(transaction); } catch { return []; }
  const restored = [];
  for (const name of names) {
    if (!GATE_FILE.test(name)) continue;
    const target = path.join(gatesDir(cwd, changeId), name);
    if (fs.existsSync(target)) continue;
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.renameSync(path.join(transaction, name), target);
    restored.push(name);
  }
  // rmdir, not rm -r: it succeeds only when the directory is genuinely empty.
  try { fs.rmdirSync(transaction); } catch { /* something unexplained remains */ }
  return restored;
}

function applyProposal(cwd, changeId, id) {
  const { proposal, file } = loadProposal(cwd, changeId, id);
  const recovered = recoverInterruptedApply(cwd, changeId, id);
  if (recovered.length > 0) appendProposalEvent(cwd, changeId, proposal, "recovered");
  if (proposal.status !== "pending") throw new Error(`proposal ${id} is ${proposal.status}, not pending`);
  if (Date.parse(proposal.expires_at) <= Date.now()) {
    proposal.status = "stale";
    proposal.stale_reason = "expired";
    updateProposal(file, proposal);
    appendProposalEvent(cwd, changeId, proposal, "stale");
    throw new Error(`proposal ${id} has expired`);
  }
  const spec = KINDS[proposal.kind];
  if (!spec || proposal.artifact !== path.relative(cwd, path.join(pipelineRoot(cwd, changeId), spec.artifact)).replace(/\\/g, "/")) {
    throw new Error(`proposal ${id} has invalid artifact identity`);
  }
  const artifact = path.join(pipelineRoot(cwd, changeId), spec.artifact);
  const current = fs.readFileSync(artifact, "utf8");
  const artifactMode = fs.statSync(artifact).mode & 0o777;
  if (digest(current) !== proposal.base_sha256) {
    proposal.status = "stale";
    proposal.stale_reason = "artifact-changed";
    updateProposal(file, proposal);
    appendProposalEvent(cwd, changeId, proposal, "stale");
    throw new Error(`proposal ${id} is stale because ${proposal.artifact} changed`);
  }
  const currentGates = affectedGatePaths(cwd, changeId, spec.root_stage);
  if (JSON.stringify(currentGates) !== JSON.stringify(proposal.affected_gates)) {
    proposal.status = "stale";
    proposal.stale_reason = "gate-set-changed";
    updateProposal(file, proposal);
    appendProposalEvent(cwd, changeId, proposal, "stale");
    throw new Error(`proposal ${id} is stale because its invalidation set changed`);
  }

  const transaction = path.join(proposalDir(cwd, changeId), `.apply-${id}`);
  try {
    fs.mkdirSync(transaction, { recursive: false });
  } catch (err) {
    // recoverInterruptedApply above removes this directory whenever it can
    // account for everything inside. Reaching here means it could not, so the
    // contents are something neither an interrupted apply nor this code put
    // there. Say what is in the way instead of surfacing a bare EEXIST and an
    // absolute path.
    if (err.code !== "EEXIST") throw err;
    let leftovers = [];
    try { leftovers = fs.readdirSync(transaction); } catch { /* unreadable */ }
    throw new Error(
      `proposal ${id} cannot be applied: an interrupted apply left `
      + `${path.relative(cwd, transaction).replace(/\\/g, "/")} behind holding `
      + `${leftovers.length > 0 ? leftovers.join(", ") : "no recognizable gate files"}. `
      + "Move anything you need out of that directory, then remove it and retry.",
    );
  }
  try {
    for (const relative of currentGates) {
      const source = path.join(cwd, relative);
      if (fs.existsSync(source)) fs.renameSync(source, path.join(transaction, path.basename(source)));
    }
    atomicWrite(artifact, proposal.replacement, artifactMode);
    proposal.status = "applied";
    proposal.applied_at = new Date().toISOString();
    updateProposal(file, proposal);
    fs.rmSync(transaction, { recursive: true, force: true });
    appendProposalEvent(cwd, changeId, proposal, "applied");
    return proposal;
  } catch (err) {
    try { atomicWrite(artifact, current, artifactMode); } catch { /* preserve original error */ }
    try {
      for (const name of fs.readdirSync(transaction)) {
        fs.renameSync(path.join(transaction, name), path.join(gatesDir(cwd, changeId), name));
      }
      fs.rmSync(transaction, { recursive: true, force: true });
    } catch { /* recovery remains visible in .apply directory */ }
    throw err;
  }
}

function rejectProposal(cwd, changeId, id, reason = "operator-rejected") {
  const { proposal, file } = loadProposal(cwd, changeId, id);
  if (proposal.status !== "pending") throw new Error(`proposal ${id} is ${proposal.status}, not pending`);
  if (typeof reason !== "string" || reason.length === 0 || reason.length > 200 || /[\r\n]/.test(reason)) {
    throw new Error("proposal rejection reason must be a single line of 1..200 characters");
  }
  proposal.status = "rejected";
  proposal.rejected_at = new Date().toISOString();
  proposal.rejection_reason = reason;
  updateProposal(file, proposal);
  appendProposalEvent(cwd, changeId, proposal, "rejected");
  return proposal;
}

function listProposals(cwd, changeId) {
  let names;
  try { names = fs.readdirSync(proposalDir(cwd, changeId)); } catch { return []; }
  return names.filter((name) => /^[a-f0-9]{16}\.json$/.test(name)).sort().map((name) => {
    try { return loadProposal(cwd, changeId, name.slice(0, -5)).proposal; } catch { return null; }
  }).filter(Boolean);
}

module.exports = {
  KINDS,
  MAX_ARTIFACT_BYTES,
  SCHEMA,
  affectedGatePaths,
  applyProposal,
  createProposal,
  digest,
  listProposals,
  loadProposal,
  parseReplacementOutput,
  rejectProposal,
  unifiedReplacementDiff,
};
