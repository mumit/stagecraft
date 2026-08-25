"use strict";

const fs = require("node:fs");
const path = require("node:path");
const { gatesDir } = require("./paths");
const { isTrackPinnedBuildRole, rolesForStage, STAGES } = require("./pipeline/stages");
const {
  DOCUMENTATION_ROLE,
  loadBuildScope,
  loadDocumentationScope,
  rolesWithDocumentationScope,
} = require("./pipeline/affected-files");

function normalizeOwnershipPath(value) {
  return String(value || "")
    .replace(/\\/g, "/")
    .replace(/^\.\//, "")
    .replace(/^\/+/, "");
}

function blockerFiles(blockers) {
  const files = [];
  for (const blocker of blockers || []) {
    if (!blocker || typeof blocker !== "object") continue;
    const file = blocker.file || blocker.path || blocker.filename
      || blocker.artifact || blocker.requested_artifact || blocker.target_file;
    if (file && typeof file === "string" && file.trim()) {
      files.push(file.trim().replace(/:\d+(?:-\d+)?$/, ""));
    }
  }
  return [...new Set(files)];
}

function retryTargetFiles(retryAction) {
  const files = blockerFiles(retryAction.blockers);
  const add = (value) => {
    if (typeof value !== "string" || !value.trim()) return;
    files.push(value.trim().replace(/:\d+(?:-\d+)?$/, ""));
  };
  for (const blocker of retryAction.blockers || []) {
    if (!blocker || typeof blocker !== "object") continue;
    add(blocker.artifact);
    add(blocker.requested_artifact);
    add(blocker.target_file);
  }
  add(retryAction.artifact);
  add(retryAction.requested_artifact);
  return [...new Set(files.map(normalizeOwnershipPath).filter(Boolean))];
}

function globPatternToRegExp(pattern) {
  let out = "^";
  const normalized = normalizeOwnershipPath(pattern);
  for (let i = 0; i < normalized.length; i += 1) {
    const ch = normalized[i];
    if (ch === "*") {
      if (normalized[i + 1] === "*") {
        out += ".*";
        i += 1;
      } else {
        out += "[^/]*";
      }
    } else {
      out += ch.replace(/[|\\{}()[\]^$+?.]/g, "\\$&");
    }
  }
  return new RegExp(`${out}$`);
}

function ownershipPatternMatches(pattern, file) {
  const normalizedPattern = normalizeOwnershipPath(pattern);
  const normalizedFile = normalizeOwnershipPath(file);
  if (!normalizedPattern || !normalizedFile) return false;
  if (normalizedPattern === normalizedFile) return true;
  if (normalizedPattern.endsWith("/")) return normalizedFile.startsWith(normalizedPattern);
  if (!normalizedPattern.includes("*")) return normalizedFile.startsWith(`${normalizedPattern}/`);
  return globPatternToRegExp(normalizedPattern).test(normalizedFile);
}

function loadFileOwnership(cwd, changeId) {
  try {
    const gate = JSON.parse(
      fs.readFileSync(path.join(gatesDir(cwd, changeId), "stage-02.json"), "utf8"),
    );
    return gate && typeof gate.file_ownership === "object" && !Array.isArray(gate.file_ownership)
      ? gate.file_ownership
      : null;
  } catch {
    return null;
  }
}

function workstreamFromFileOwnership(fileOwnership, files) {
  const owners = new Set();
  for (const file of files || []) {
    for (const [pattern, owner] of Object.entries(fileOwnership || {})) {
      if (ownershipPatternMatches(pattern, file)) owners.add(owner);
    }
  }
  return owners.size === 1 ? [...owners][0] : null;
}

function blockerPatchItems(blockers) {
  const items = [];
  for (const blocker of blockers || []) {
    if (typeof blocker === "string") {
      if (blocker.trim()) items.push(blocker.trim());
      continue;
    }
    if (!blocker || typeof blocker !== "object") continue;
    const file = blocker.file || blocker.path || blocker.filename
      || blocker.artifact || blocker.requested_artifact || blocker.target_file;
    const text = blocker.text || blocker.summary || blocker.description || "";
    if (file && text) items.push(`Fix ${file}: ${text}`);
    else if (file) items.push(`Fix ${file}`);
    else if (text) items.push(text);
  }
  return [...new Set(items)].filter(Boolean);
}

function resolveRetryOwnership({ cwd, changeId, retryAction, track, config }) {
  const targetPaths = retryTargetFiles(retryAction);
  const buildStage = STAGES.build;
  const clearedWorkstreams = new Set();
  let clearsBuild = false;
  for (const relativePath of retryAction.clear_gates || []) {
    if (String(relativePath) === "pipeline/gates/stage-04.json") clearsBuild = true;
    const match = String(relativePath).match(/^pipeline\/gates\/stage-04\.([^./]+)\.json$/);
    if (match) {
      clearsBuild = true;
      clearedWorkstreams.add(match[1]);
    }
  }
  if (!clearsBuild || targetPaths.length === 0) return { evaluated: false, targetedFix: null };

  const documentationScope = loadDocumentationScope(cwd, changeId);
  const activeRoles = rolesWithDocumentationScope(
    buildStage,
    rolesForStage(buildStage, track, config),
    documentationScope,
  );
  const candidateSet = clearedWorkstreams.size > 0
    ? clearedWorkstreams
    : new Set(activeRoles);
  const candidateRoles = [
    ...buildStage.roles.filter((role) => candidateSet.has(role)),
    ...[...candidateSet].filter((role) => !buildStage.roles.includes(role)).sort(),
  ];
  // ADR-027: mirrors the widening in orchestrator.js's buildDescriptor() —
  // a track-pinned build role (loop/nano/refactor's sole owner) is also
  // compatible with a retry targeting a PM-approved affected_files path,
  // not just its static roleWrites. Computed lazily: only track-pinned
  // tracks ever reach the isTrackPinnedBuildRole branch below.
  let buildScope = null;
  const compatibleRoles = candidateRoles.filter((role) => {
    const staticWrites = buildStage.roleWrites && buildStage.roleWrites[role];
    let allowedWrites = staticWrites;
    if (role === DOCUMENTATION_ROLE && documentationScope.selected) {
      allowedWrites = [...(staticWrites || []), ...documentationScope.affectedFiles];
    } else if (isTrackPinnedBuildRole(buildStage, track, config, role)) {
      buildScope = buildScope || loadBuildScope(cwd, changeId);
      allowedWrites = [...(staticWrites || []), ...buildScope.files];
    }
    return Array.isArray(allowedWrites)
      && targetPaths.every((file) =>
        allowedWrites.some((pattern) => ownershipPatternMatches(pattern, file)));
  });

  if (compatibleRoles.length === 0) {
    return {
      evaluated: true,
      incompatible: true,
      target_paths: targetPaths,
      candidate_roles: candidateRoles,
      targetedFix: null,
    };
  }

  const declaredOwner = workstreamFromFileOwnership(loadFileOwnership(cwd, changeId), targetPaths);
  const workstream = declaredOwner && compatibleRoles.includes(declaredOwner)
    ? declaredOwner
    : compatibleRoles[0];
  const patchItems = blockerPatchItems(retryAction.blockers || []);
  const requestedArtifact = retryAction.requested_artifact || retryAction.artifact;
  if (patchItems.length === 0 && typeof requestedArtifact === "string" && requestedArtifact.trim()) {
    patchItems.push(`Fix ${requestedArtifact.trim()}`);
  }
  if (patchItems.length === 0) return { evaluated: false, targetedFix: null };

  return {
    evaluated: true,
    incompatible: false,
    target_paths: targetPaths,
    candidate_roles: candidateRoles,
    compatible_roles: compatibleRoles,
    targetedFix: {
      stage: "stage-04",
      name: "build",
      workstream,
      patchItems,
      files: targetPaths,
      source_stage: retryAction.stage,
      source_name: retryAction.name,
    },
  };
}

module.exports = {
  blockerFiles,
  normalizeOwnershipPath,
  resolveRetryOwnership,
};
