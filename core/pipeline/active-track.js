"use strict";

const fs = require("node:fs");
const path = require("node:path");
const { pipelineRoot } = require("../paths");

function readJson(file) {
  try {
    if (!fs.existsSync(file)) return null;
    return JSON.parse(fs.readFileSync(file, "utf8"));
  } catch {
    return null;
  }
}

function trackFromRunPlan(plan) {
  if (!plan || typeof plan !== "object") return null;
  if (plan.track === "custom" && Array.isArray(plan.stages)) {
    const names = plan.stages.map((stage) => stage && stage.name).filter(Boolean);
    if (names.length > 0) return names;
  }
  return typeof plan.track === "string" && plan.track ? plan.track : null;
}

function resolveActiveTrack(cwd, config, explicitTrack = null, changeId = null) {
  if (explicitTrack) return { track: explicitTrack, source: "explicit" };

  const root = pipelineRoot(cwd, changeId);
  const planned = trackFromRunPlan(readJson(path.join(root, "run-plan.json")));
  if (planned) return { track: planned, source: "run-plan" };

  const assessed = readJson(path.join(root, "track.json"));
  if (assessed && typeof assessed.track === "string" && assessed.track) {
    return { track: assessed.track, source: "track-record" };
  }

  if (Array.isArray(config.pipeline.custom_stages)) {
    return { track: config.pipeline.custom_stages, source: "config" };
  }
  return { track: config.pipeline.default_track || "full", source: "config" };
}

function trackLabel(track) {
  return Array.isArray(track) ? "custom" : track;
}

module.exports = { resolveActiveTrack, trackLabel };
