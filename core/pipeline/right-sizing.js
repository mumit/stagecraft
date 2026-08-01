const fs = require("node:fs");
const path = require("node:path");
const { spawnSync } = require("node:child_process");
const { assess } = require("../stage-shopping/assess");
const { STAGES, rolesForStage } = require("./stages");

const WORKSTREAM_RULES = [
  { role: "backend", patterns: [/^src\/backend\//, /^api\//, /^server\//, /^routes\//, /^core\//, /^bin\//] },
  { role: "frontend", patterns: [/^src\/frontend\//, /^app\//, /^pages\//, /^components\//, /^public\//, /^client\//, /^web\//] },
  { role: "platform", patterns: [/^src\/infra\//, /^infra\//, /^deploy\//, /^k8s\//, /^terraform\//, /^\.github\/workflows\//, /^Dockerfile$/, /^docker-compose\.ya?ml$/] },
  { role: "qa", patterns: [/^src\/tests\//, /^tests\//, /^test\//, /(^|\/)__tests__\//, /\.(test|spec)\.[cm]?[jt]sx?$/] },
];

const STAGE_TRIGGERS = {
  "accessibility-audit": {
    kind: "accessibility",
    filePatterns: [/^src\/frontend\//, /^app\//, /^pages\//, /^components\//, /^public\//, /^client\//, /\.(css|scss|html|tsx|jsx)$/],
    textPattern: /\b(accessib|a11y|wcag|screen reader|keyboard nav|aria|ui|frontend|browser|web)\b/i,
  },
  "observability-gate": {
    kind: "observability",
    filePatterns: [/observability/i, /(^|\/)(otel|metrics?|logs?|traces?)\b/i],
    textPattern: /\b(observability|metrics?|logs?|traces?|telemetry|otel|opentelemetry|slo|alert)\b/i,
  },
  "verification-beyond-tests": {
    kind: "advanced-verification",
    filePatterns: [/^pipeline\/formal\//, /^src\/tests\/property\//, /property/i, /mutation/i, /formal/i],
    textPattern: /\b(property[- ]based|mutation|formal|invariant|model check|race condition|concurrency|critical path|financial|safety)\b/i,
  },
  "performance-budget": {
    kind: "performance",
    filePatterns: [/performance/i, /benchmark/i, /load-test/i, /^src\/frontend\//, /^public\//, /\.(css|scss|tsx|jsx)$/],
    textPattern: /\b(performance|latency|throughput|load test|lighthouse|bundle size|p95|p99|benchmark|k6)\b/i,
  },
};

function isRightSizingInputPath(file) {
  return !(
    file.startsWith(".devteam/") ||
    file.startsWith(".git/") ||
    file.startsWith(".codex/") ||
    file.startsWith(".codex-tmp/") ||
    file.startsWith(".devteam-tmp/") ||
    file.startsWith("pipeline/")
  );
}

function gitChangedFiles(cwd) {
  const result = spawnSync("git", ["status", "--porcelain", "-z", "--untracked-files=all"], {
    cwd,
    encoding: "utf8",
  });
  if (result.status !== 0) return { ok: false, files: listProjectFiles(cwd) };
  const entries = result.stdout.split("\0").filter(Boolean);
  const files = [];
  for (let i = 0; i < entries.length; i++) {
    const status = entries[i].slice(0, 2);
    let file = entries[i].slice(3);
    if (status.includes("R") || status.includes("C")) {
      file = entries[i + 1] || file;
      i++;
    }
    if (file) files.push(file.replace(/\\/g, "/"));
  }
  return { ok: true, files: files.filter(isRightSizingInputPath) };
}

function listProjectFiles(cwd) {
  const out = [];
  const ignored = new Set([".git", ".devteam", "pipeline", "node_modules", ".codex", ".codex-tmp", ".devteam-tmp"]);
  function walk(dir, prefix = "") {
    let entries = [];
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      if (ignored.has(entry.name)) continue;
      const rel = prefix ? `${prefix}/${entry.name}` : entry.name;
      const abs = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        walk(abs, rel);
      } else if (entry.isFile()) {
        if (isRightSizingInputPath(rel)) out.push(rel);
      }
    }
  }
  walk(cwd);
  return out;
}

function readIfPresent(cwd, rel) {
  try {
    const p = path.join(cwd, rel);
    return fs.existsSync(p) ? fs.readFileSync(p, "utf8") : "";
  } catch {
    return "";
  }
}

function contextText(cwd, changeId) {
  const prefix = changeId ? `pipeline/changes/${changeId}/` : "pipeline/";
  return [
    readIfPresent(cwd, `${prefix}brief.md`),
    readIfPresent(cwd, `${prefix}design-spec.md`),
    readIfPresent(cwd, `${prefix}clarification-log.md`),
  ].join("\n");
}

function candidateActiveRoles(cwd, { files = null } = {}) {
  const changed = files || gitChangedFiles(cwd).files;
  const roles = new Set();
  const matched = {};
  for (const file of changed) {
    for (const rule of WORKSTREAM_RULES) {
      if (rule.patterns.some((pattern) => pattern.test(file))) {
        roles.add(rule.role);
        if (!matched[rule.role]) matched[rule.role] = [];
        matched[rule.role].push(file);
      }
    }
  }
  return {
    roles: [...roles],
    trigger_inputs: {
      changed_files: changed,
      matched_files_by_role: matched,
    },
  };
}

function highConfidenceTrack(cwd, description, opts = {}) {
  const changed = opts.files || gitChangedFiles(cwd).files;
  const result = assess(description || "", changed, { scanContent: opts.scanContent !== false });
  if (result.confidence !== "high") return null;
  return {
    track: result.recommendedTrack,
    confidence: result.confidence,
    stages: result.stages,
    reasons: result.reasons,
    trigger_inputs: {
      description_present: !!description,
      changed_files: changed,
      security_required: result.securityRequired,
      migration_required: result.migrationRequired,
    },
  };
}

function stageTriggerEvidence(stageName, cwd, { files = null, changeId = null } = {}) {
  const rule = STAGE_TRIGGERS[stageName];
  if (!rule) return null;
  const changed = files || gitChangedFiles(cwd).files;
  const matchedFiles = changed.filter((file) => rule.filePatterns.some((pattern) => pattern.test(file)));
  const text = contextText(cwd, changeId);
  const textMatched = rule.textPattern.test(text);
  return {
    kind: rule.kind,
    matched: matchedFiles.length > 0 || textMatched,
    trigger_inputs: {
      changed_files: changed,
      matched_files: matchedFiles,
      brief_or_design_signal: textMatched,
    },
  };
}

function clarificationNeeded(cwd, { changeId = null } = {}) {
  const text = contextText(cwd, changeId);
  const markers = text.match(/\b(TBD|TODO|open question|needs clarification|unresolved|decision needed)\b/gi) || [];
  return {
    matched: markers.length > 0,
    trigger_inputs: {
      markers: [...new Set(markers.map((m) => m.toLowerCase()))],
    },
  };
}

// 29.4: "verification-sweep" (stage-06x) is the folded stand-in for
// whichever of these a compact_qa track lists. It has no STAGE_TRIGGERS
// entry of its own — deterministicSkipForStage evaluates all four
// constituent triggers and only skips the combined dispatch when NONE of
// them fire, same as the standalone stages would each be skipped today.
const QA_SWEEP_TRIGGER_STAGES = Object.keys(STAGE_TRIGGERS);

function deterministicSkipForStage(stageName, cwd, opts = {}) {
  if (stageName === "clarification") {
    const evidence = clarificationNeeded(cwd, opts);
    if (!evidence.matched) {
      return {
        skip_kind: "right-sizing.clarification",
        reason: "no open-question markers found in brief/design context",
        trigger_inputs: evidence.trigger_inputs,
      };
    }
    return null;
  }
  if (stageName === "verification-sweep") {
    const files = opts.files || gitChangedFiles(cwd).files;
    const evidences = QA_SWEEP_TRIGGER_STAGES.map((name) => stageTriggerEvidence(name, cwd, { ...opts, files }));
    if (evidences.some((e) => e && e.matched)) return null;
    return {
      skip_kind: "right-sizing.verification-sweep",
      reason: "no accessibility/observability/verification/performance trigger found in changed files or brief/design context",
      trigger_inputs: { changed_files: files },
    };
  }
  const evidence = stageTriggerEvidence(stageName, cwd, opts);
  if (!evidence || evidence.matched) return null;
  return {
    skip_kind: `right-sizing.${evidence.kind}`,
    reason: `no ${evidence.kind} trigger found in changed files or brief/design context`,
    trigger_inputs: evidence.trigger_inputs,
  };
}

function deterministicSkipsForOrder(order, cwd, opts = {}) {
  const skips = {};
  const files = opts.files || gitChangedFiles(cwd).files;
  for (const stageName of order) {
    const skip = deterministicSkipForStage(stageName, cwd, { ...opts, files });
    if (skip) skips[stageName] = skip;
  }
  return skips;
}

function expectedWorkstreamCount(order, track, { skipped = [], activeRoles = [] } = {}) {
  const skipSet = new Set(skipped);
  const active = new Set(activeRoles);
  let count = 0;
  for (const name of order) {
    if (skipSet.has(name)) continue;
    const stage = STAGES[name];
    if (!stage) continue;
    const roles = rolesForStage(stage, track);
    if (active.size === 0) {
      count += roles.length;
      continue;
    }
    count += roles.filter((role) =>
      !WORKSTREAM_RULES.some((rule) => rule.role === role) || active.has(role) || (stage.alwaysDispatch || []).includes(role),
    ).length;
  }
  return count;
}

module.exports = {
  candidateActiveRoles,
  deterministicSkipForStage,
  deterministicSkipsForOrder,
  expectedWorkstreamCount,
  gitChangedFiles,
  highConfidenceTrack,
};
