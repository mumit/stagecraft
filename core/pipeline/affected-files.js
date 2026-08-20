"use strict";

const fs = require("node:fs");
const path = require("node:path");
const { gatesDir } = require("../paths");

const DOCUMENTATION_ROLE = "documentation";
const DOCUMENTATION_SCOPE_STAGES = new Set(["stage-04", "stage-05", "stage-06"]);
const DOCUMENTATION_EXTENSIONS = new Set([".md", ".mdx", ".rst", ".adoc", ".asciidoc", ".txt"]);

function normalizeAffectedFile(value) {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  const hasUnsafeCharacter = [...trimmed].some((character) => {
    const code = character.charCodeAt(0);
    return character === ":" || code <= 31 || code === 127;
  });
  if (!trimmed || trimmed !== value || trimmed.includes("\\") || hasUnsafeCharacter) return null;
  if (path.posix.isAbsolute(trimmed) || /^[A-Za-z]:\//.test(trimmed)) return null;
  if (["*", "?", "[", "]", "{", "}"].some((token) => trimmed.includes(token)) || trimmed.endsWith("/")) return null;
  const segments = trimmed.split("/");
  if (segments.some((segment) => !segment || segment === "." || segment === "..")) return null;
  return segments.join("/");
}

function isDocumentationPath(value) {
  const file = normalizeAffectedFile(value);
  if (!file || file.startsWith("pipeline/")) return false;
  if (file.startsWith("docs/") || file.startsWith("changelog.d/")) return true;
  const base = path.posix.basename(file).toLowerCase();
  if (/^(readme|changelog|contributing|code_of_conduct|security|license)(\.|$)/.test(base)) return true;
  return DOCUMENTATION_EXTENSIONS.has(path.posix.extname(base));
}

function documentationScopeError(gate) {
  if (!gate || gate.stage !== "stage-01") return null;
  const roles = Array.isArray(gate.active_roles) ? gate.active_roles : [];
  if (!roles.includes(DOCUMENTATION_ROLE)) return null;
  if (["FAIL", "ESCALATE"].includes(gate.status)) return null;
  if (gate.status !== "PASS") {
    return `active_roles may select "${DOCUMENTATION_ROLE}" only on a PASS stage-01 gate`;
  }
  if (roles.length !== 1) {
    return `active_roles may select "${DOCUMENTATION_ROLE}" only for a documentation-only change`;
  }
  if (!Array.isArray(gate.affected_files) || gate.affected_files.length === 0) {
    return `active_roles includes "${DOCUMENTATION_ROLE}" but affected_files is empty or missing`;
  }
  const normalized = gate.affected_files.map(normalizeAffectedFile);
  const invalid = gate.affected_files.filter((_, index) => !normalized[index]);
  if (invalid.length > 0) {
    return "documentation affected_files must be exact canonical repo-relative file paths (no directories, globs, absolute paths, or parent traversal)";
  }
  if (new Set(normalized).size !== normalized.length) {
    return "documentation affected_files contains duplicate paths";
  }
  const nonDocumentation = normalized.filter((file) => !isDocumentationPath(file));
  if (nonDocumentation.length > 0) {
    return `documentation affected_files contains non-documentation paths: ${nonDocumentation.join(", ")}`;
  }
  return null;
}

function documentationScopeFromGate(gate) {
  const selected = Boolean(
    gate
    && gate.stage === "stage-01"
    && gate.status === "PASS"
    && Array.isArray(gate.active_roles)
    && gate.active_roles.includes(DOCUMENTATION_ROLE),
  );
  const error = documentationScopeError(gate);
  if (!selected || error) return { selected: false, affectedFiles: [], error };
  return {
    selected: true,
    affectedFiles: gate.affected_files.map(normalizeAffectedFile),
    error: null,
  };
}

function loadDocumentationScopeFromGatesDir(directory) {
  try {
    const gate = JSON.parse(fs.readFileSync(path.join(directory, "stage-01.json"), "utf8"));
    return documentationScopeFromGate(gate);
  } catch {
    return { selected: false, affectedFiles: [], error: null };
  }
}

function loadDocumentationScope(cwd, changeId) {
  return loadDocumentationScopeFromGatesDir(gatesDir(cwd, changeId));
}

function rolesWithDocumentationScope(stageDef, roles, scope, opts = {}) {
  if (!stageDef || !["stage-04", "stage-05"].includes(stageDef.stage)) return roles;
  if (scope && scope.selected) return [DOCUMENTATION_ROLE];
  if (stageDef.stage === "stage-05" && opts.adversarial) return roles;
  if (opts.includeOptional) {
    return [...new Set([...roles, ...((stageDef && stageDef.optionalRoles) || [])])];
  }
  const optional = new Set((stageDef && stageDef.optionalRoles) || []);
  return roles.filter((role) => !optional.has(role));
}

function affectedFilesForDescriptor(stageDef, scope) {
  if (!stageDef || !DOCUMENTATION_SCOPE_STAGES.has(stageDef.stage)) return [];
  return scope && scope.selected ? scope.affectedFiles : [];
}

module.exports = {
  DOCUMENTATION_ROLE,
  affectedFilesForDescriptor,
  documentationScopeError,
  documentationScopeFromGate,
  isDocumentationPath,
  loadDocumentationScope,
  loadDocumentationScopeFromGatesDir,
  normalizeAffectedFile,
  rolesWithDocumentationScope,
};
