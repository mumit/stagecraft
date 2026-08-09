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
  const out = [
    `--- a/${relative}`,
    `+++ b/${relative}`,
    `@@ -1,${oldLines.length} +1,${newLines.length} @@`,
    ...oldLines.map((line) => `-${line}`),
    ...newLines.map((line) => `+${line}`),
  ];
  return out.join("\n") + "\n";
}

function stageIndex(stageId) {
  return Object.values(STAGES).findIndex((stage) => stage.stage === stageId);
}

function affectedGatePaths(cwd, changeId, rootStage) {
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

function applyProposal(cwd, changeId, id) {
  const { proposal, file } = loadProposal(cwd, changeId, id);
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
  fs.mkdirSync(transaction, { recursive: false });
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
