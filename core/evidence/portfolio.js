"use strict";

const { readBundle } = require("./bundle");

function aggregateRows(bundles, field, categoryKeys, numericKeys) {
  const rows = new Map();
  for (const bundle of bundles) {
    for (const source of bundle[field]) {
      const key = categoryKeys.map((name) => source[name]).join("\0");
      if (!rows.has(key)) {
        const row = {};
        categoryKeys.forEach((name) => { row[name] = source[name]; });
        numericKeys.forEach((name) => { row[name] = 0; });
        rows.set(key, row);
      }
      const target = rows.get(key);
      numericKeys.forEach((name) => { target[name] += source[name]; });
    }
  }
  return [...rows.values()].sort((a, b) => categoryKeys.map((name) => a[name]).join("\0")
    .localeCompare(categoryKeys.map((name) => b[name]).join("\0")));
}

function condition(id, value, threshold, met, reasonCode) {
  return { id, value, threshold, met, reason_code: met ? null : reasonCode };
}

function localCondition(bundle, capability, id) {
  return bundle.readiness.find((item) => item.capability === capability)
    ?.local_conditions.find((item) => item.id === id);
}

function portfolioReadiness(bundles, resolutions, rulings, stalls) {
  const projectCount = bundles.length;
  const h3Projects = bundles.filter((bundle) =>
    (localCondition(bundle, "h3-recipe-suggestions", "fix-retry-runs")?.value || 0) >= 5).length;
  const recoveryProjects = new Map();
  for (const bundle of bundles) {
    for (const row of bundle.recovery) {
      if (row.runs < 3) continue;
      const key = `${row.stage}\0${row.failure_class}`;
      if (!recoveryProjects.has(key)) recoveryProjects.set(key, new Set());
      recoveryProjects.get(key).add(bundle.project_ref);
    }
  }
  const recurringProjects = Math.max(0, ...[...recoveryProjects.values()].map((set) => set.size));
  const acceptedProjects = bundles.filter((bundle) => (bundle.resolutions || []).length > 0).length;
  const acceptedResolutionCount = resolutions.reduce((sum, row) => sum + row.observations, 0);
  const derivableResolutionCount = resolutions.reduce((sum, row) => sum + row.derivable, 0);
  const derivablePercent = acceptedResolutionCount === 0
    ? 0 : Math.round((derivableResolutionCount / acceptedResolutionCount) * 100);
  const resolutionGroups = new Map();
  for (const bundle of bundles) {
    for (const row of bundle.resolutions || []) {
      const key = `${row.stage}\0${row.failure_class}\0${row.schema_fingerprint}`;
      if (!resolutionGroups.has(key)) {
        resolutionGroups.set(key, { projects: new Set(), observations: 0 });
      }
      const group = resolutionGroups.get(key);
      group.projects.add(bundle.project_ref);
      group.observations += row.observations;
    }
  }
  const acceptedRecurringProjects = Math.max(
    0, ...[...resolutionGroups.values()].map((group) => group.projects.size),
  );
  const acceptedRecurringObservations = Math.max(
    0,
    ...[...resolutionGroups.values()]
      .filter((group) => group.projects.size >= 2)
      .map((group) => group.observations),
  );

  const comparableProjects = bundles.filter((bundle) => {
    const roleHosts = new Map();
    for (const row of bundle.routing) {
      if (!roleHosts.has(row.role)) roleHosts.set(row.role, new Set());
      if (row.gate_observations >= 5) roleHosts.get(row.role).add(row.host);
    }
    return [...roleHosts.values()].some((hosts) => hosts.size >= 2);
  }).length;
  const costProjects = bundles.filter((bundle) => bundle.quality.cost_coverage_dispatches > 0).length;
  const durableProjects = bundles.filter(
    (bundle) => (bundle.quality.durable_dispatch_observations || 0) > 0,
  ).length;
  const repairRuns = bundles.reduce((sum, bundle) => sum + bundle.scope.repair_run_count, 0);
  const ceilingEvents = bundles.reduce((sum, bundle) => sum
    + (localCondition(bundle, "standing-grants", "consequence-ceiling-events")?.value || 0), 0);
  const rulingEvents = rulings.reduce((sum, row) => sum + row.observations, 0);
  const stallEvents = stalls.reduce((sum, row) => sum + row.observations, 0);

  return [
    {
      capability: "h3-recipe-suggestions", issue: 142, status: "not-ready",
      conditions: [
        condition("projects", projectCount, 2, projectCount >= 2, "insufficient-projects"),
        condition("projects-with-fix-retry-runs", h3Projects, 2, h3Projects >= 2, "insufficient-project-fix-retry-evidence"),
        condition("recurring-failure-projects", recurringProjects, 2, recurringProjects >= 2, "insufficient-cross-project-recurrence"),
        condition("accepted-resolution-projects", acceptedProjects, 2, acceptedProjects >= 2, "insufficient-accepted-resolution-projects"),
        condition("accepted-recurring-failure-projects", acceptedRecurringProjects, 2, acceptedRecurringProjects >= 2, "insufficient-accepted-cross-project-recurrence"),
        condition("accepted-recurring-resolution-observations", acceptedRecurringObservations, 3, acceptedRecurringObservations >= 3, "insufficient-accepted-resolutions"),
        condition("derivable-accepted-resolutions-percent", derivablePercent, 80, acceptedResolutionCount >= 3 && derivablePercent >= 80, "insufficient-derivable-resolutions"),
      ],
    },
    {
      capability: "d5-continuous-routing", issue: 143, status: "not-ready",
      conditions: [
        condition("projects", projectCount, 2, projectCount >= 2, "insufficient-projects"),
        condition("projects-with-host-comparison", comparableProjects, 2, comparableProjects >= 2, "insufficient-host-comparison"),
        condition("projects-with-cost-telemetry", costProjects, 2, costProjects >= 2, "cost-telemetry-unavailable"),
        condition("projects-with-durable-dispatch-history", durableProjects, 2, durableProjects >= 2, "durable-dispatch-history-unavailable"),
      ],
    },
    {
      capability: "standing-grants", issue: 144, status: "not-ready",
      conditions: [
        condition("projects", projectCount, 2, projectCount >= 2, "insufficient-projects"),
        condition("repair-runs", repairRuns, 10, repairRuns >= 10, "insufficient-repair-runs"),
        condition("consequence-ceiling-events", ceilingEvents, 1, ceilingEvents >= 1, "no-consequence-ceiling-evidence"),
        condition("granted-ruling-events", rulingEvents, 1, rulingEvents >= 1, "no-granted-ruling-evidence"),
      ],
    },
    {
      capability: "active-stall-response", issue: 145, status: "not-ready",
      conditions: [
        condition("projects", projectCount, 2, projectCount >= 2, "insufficient-projects"),
        condition("stall-events", stallEvents, 1, stallEvents >= 1, "no-stall-evidence"),
        condition("calibrated-threshold", 0, 1, false, "stall-threshold-not-defined"),
      ],
    },
  ].map((item) => ({
    ...item,
    status: item.conditions.every((entry) => entry.met)
      ? "threshold-met-review-required" : "not-ready",
  }));
}

function analyzePortfolio(files) {
  if (!Array.isArray(files) || files.length === 0) {
    throw new Error("portfolio status requires at least one --bundle");
  }
  const byProject = new Map();
  let duplicate_bundles = 0;
  for (const file of files) {
    const bundle = readBundle(file);
    const existing = byProject.get(bundle.project_ref);
    if (existing) {
      if (existing.payload_sha256 !== bundle.payload_sha256) {
        throw new Error(`conflicting bundles for project_ref ${bundle.project_ref}`);
      }
      duplicate_bundles += 1;
      continue;
    }
    byProject.set(bundle.project_ref, bundle);
  }
  const bundles = [...byProject.values()];
  const routing = aggregateRows(bundles, "routing", ["role", "host", "model"], [
    "gate_observations", "pass", "warn", "fail", "escalate", "cost_observations",
    "total_cost_usd", "duration_observations", "total_duration_ms",
    "prompt_observations", "total_prompt_bytes",
  ]);
  const recovery = aggregateRows(bundles, "recovery", ["stage", "failure_class"], ["observations", "runs"]);
  const resolutions = aggregateRows(
    bundles.map((bundle) => ({ ...bundle, resolutions: bundle.resolutions || [] })),
    "resolutions",
    ["stage", "failure_class", "schema_fingerprint"],
    ["observations", "derivable"],
  );
  const rulings = aggregateRows(bundles, "rulings", ["ruling_class"], ["observations"]);
  const stalls = aggregateRows(bundles, "stalls", ["stage", "stall_class"], ["observations"]);
  const quality = {
    malformed_records: 0, oversized_records: 0, unreadable_sources: 0,
    truncated_sources: 0, symlink_sources: 0, orphan_events: 0,
    suppressed_observations: 0, cost_coverage_dispatches: 0,
    durable_dispatch_observations: 0,
  };
  for (const bundle of bundles) {
    Object.keys(quality).forEach((key) => {
      quality[key] += key === "suppressed_observations"
        ? bundle.suppressed_observations : (bundle.quality[key] || 0);
    });
  }
  return {
    schema_version: "1.0", mode: "portfolio",
    scope: {
      project_count: bundles.length,
      bundle_count: files.length,
      duplicate_bundles,
      run_count: bundles.reduce((sum, bundle) => sum + bundle.scope.run_count, 0),
      complete_run_count: bundles.reduce((sum, bundle) => sum + bundle.scope.complete_run_count, 0),
      repair_run_count: bundles.reduce((sum, bundle) => sum + bundle.scope.repair_run_count, 0),
    },
    quality, routing, recovery, resolutions, rulings, stalls,
    readiness: portfolioReadiness(bundles, resolutions, rulings, stalls),
  };
}

module.exports = { analyzePortfolio, aggregateRows, portfolioReadiness };
