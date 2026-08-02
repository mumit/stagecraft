// Load and resolve the target project's .devteam/config.yml.
//
// Missing file → defaults (host: generic, track: full, isolation: in-place).
// Routing precedence at resolveHost(): stages[stage] → roles[role] → default_host.

const fs = require("node:fs");
const path = require("node:path");
const yaml = require("js-yaml");

const DEFAULTS = {
  routing: {
    default_host: "generic",
    roles: {},
    stages: {},
    review_fanout: [],
    host_concurrency: {},
  },
  pipeline: {
    default_track: "full",
    isolation: "in-place",
    skip_stages: [],
    force_stages: [],
    right_sizing: true,
    // verify: optional. Holds orchestrator-stamped verification commands
    // for stages that the orchestrator can verify directly (stage-04a
    // and stage-06 today). Absent test config discovers Node, pytest,
    // and Go suites; explicit null means "skip even if discoverable."
    // test_concurrency bounds independent suite fanout; test_suites can
    // declare resource_group for exclusive browser/database/port-bound suites.
    // See core/verify/runner.js.
    verify: {},
    // G6: custom_stages overrides default_track when set. An array of
    // stage names, e.g. ["requirements","build","pre-review","peer-review"].
    // Produced by `devteam assess --apply` or set manually. null = use
    // default_track.
    custom_stages: null,
    // Require every stamped gate to carry a verifiable HMAC. The signing
    // secret is supplied only through DEVTEAM_SIGNING_SECRET.
    require_signed_gates: false,
    // 29.1: the single build/peer-review workstream the `loop` track
    // dispatches. Must be one of backend/frontend/platform/qa; an
    // unrecognized value falls back to the default rather than erroring.
    // See loopBuildRole() in core/pipeline/stages.js.
    loop_build_role: "backend",
  },
  autonomy: {
    // ADR-003 / H1: retry budget before `next()` escalates a still-FAIL stage
    // (failure_class "convergence-exhausted") instead of returning
    // fix-and-retry again. Count-based ceiling on the gate's retry_number.
    // This count ceiling complements the archived-attempt progress and
    // convergence checks in core/gates/convergence.js.
    // 0 = escalate on the first FAIL.
    max_retries: 2,
    // ADR-006: when true, an inferred pipeline/track.json at medium/low confidence
    // produces an unconfirmed-track halt (requires --track or --force to proceed).
    // Off by default — opt in via .devteam/config.yml autonomy.require_confirmed_track.
    require_confirmed_track: false,
  },
  deploy: null,
  patterns: {
    // 30.2(c): `devteam patterns review` flags a promoted pattern as a
    // demotion candidate once stats.recurrence_after_injection reaches this
    // many blockers recurring after injection. Flagging only — demotion
    // stays an explicit `devteam patterns demote <id>` operator action.
    demotion_recurrence_threshold: 3,
  },
  learning: {
    // 30.3: opt-in run-end Reflector dispatch (core/learning/reflector.js).
    // Off by default — it's an extra headless call per run. When true, the
    // driver dispatches it once after a clean pipeline-complete; proposals
    // land in the same candidate store patterns.collect() feeds, tagged
    // source: "reflector". Promotion is still the existing human flow.
    reflector: false,
  },
  memory: {
    // 30.4: retrieval into stage prompts + auto-ingest at pipeline-complete.
    // Both sides of the loop gate on this one flag — false turns off both
    // the "## Prior Project Knowledge" prompt section and the run-end
    // auto-ingest (core/driver.js). Retrieval additionally requires
    // .devteam/memory/ to already exist (core/memory/inject.js); a project
    // that has never run `devteam memory ingest` sees no behavior change.
    inject: true,
    // Top-k results queried per stage dispatch (core/memory/inject.js).
    inject_top_k: 3,
    // Cosine-similarity floor below which a result is dropped. 0 is the
    // principled default given the store's scoring semantics (dot product
    // of L2-normalized vectors, core/memory/store.js): 0 means "no positive
    // alignment with the query," the natural cutoff before any tuning.
    inject_similarity_floor: 0,
  },
  // 31.3: stage-05 (peer-review) dispatch shape. "panel" is today's four-area
  // reviewer matrix — byte-identical default, no behavior change without
  // opt-in. "adversarial" dispatches a single reviewer then a critic whose
  // brief is to attack the review itself (plans/phase-31-verification-depth.md
  // §31.3 — 2026 evidence cited there says review panels underperform and are
  // collusion-prone relative to an adversarial reviewer/critic pair).
  review: {
    mode: "panel",
  },
};

function configPath(cwd) {
  return path.join(cwd, ".devteam", "config.yml");
}

const _cache = new Map();
function clearConfigCache() { _cache.clear(); }

function loadConfig(cwd = process.cwd()) {
  const resolved = path.resolve(cwd);
  if (_cache.has(resolved)) return _cache.get(resolved);
  const p = configPath(resolved);
  let result;
  if (!fs.existsSync(p)) {
    result = { ...DEFAULTS, _source: "defaults", _path: p };
  } else {
    const raw = fs.readFileSync(p, "utf8");
    const parsed = yaml.load(raw) || {};
    result = {
      routing: {
        default_host: parsed.routing?.default_host ?? DEFAULTS.routing.default_host,
        roles: parsed.routing?.roles ?? DEFAULTS.routing.roles,
        stages: parsed.routing?.stages ?? DEFAULTS.routing.stages,
        review_fanout: Array.isArray(parsed.routing?.review_fanout) ? parsed.routing.review_fanout : [],
        host_concurrency: (
          parsed.routing
          && typeof parsed.routing.host_concurrency === "object"
          && parsed.routing.host_concurrency !== null
          && !Array.isArray(parsed.routing.host_concurrency)
        ) ? parsed.routing.host_concurrency : {},
      },
      pipeline: {
        default_track: parsed.pipeline?.default_track ?? DEFAULTS.pipeline.default_track,
        isolation: parsed.pipeline?.isolation ?? DEFAULTS.pipeline.isolation,
        isolation_acknowledge_partial: parsed.pipeline?.isolation_acknowledge_partial === true,
        skip_stages: Array.isArray(parsed.pipeline?.skip_stages) ? parsed.pipeline.skip_stages : [],
        force_stages: Array.isArray(parsed.pipeline?.force_stages) ? parsed.pipeline.force_stages : [],
        right_sizing: parsed.pipeline?.right_sizing !== false,
        verify: (parsed.pipeline && typeof parsed.pipeline.verify === "object" && parsed.pipeline.verify !== null) ? parsed.pipeline.verify : {},
        custom_stages: Array.isArray(parsed.pipeline?.custom_stages) ? parsed.pipeline.custom_stages : null,
        require_signed_gates: parsed.pipeline?.require_signed_gates === true,
        loop_build_role: typeof parsed.pipeline?.loop_build_role === "string"
          ? parsed.pipeline.loop_build_role
          : DEFAULTS.pipeline.loop_build_role,
      },
      autonomy: {
        max_retries: Number.isInteger(parsed.autonomy?.max_retries) && parsed.autonomy.max_retries >= 0
          ? parsed.autonomy.max_retries
          : DEFAULTS.autonomy.max_retries,
        // ADR-006: explicit opt-in flag; not CI=true (CI is already overloaded)
        require_confirmed_track: parsed.autonomy?.require_confirmed_track === true,
      },
      deploy: (parsed.deploy && typeof parsed.deploy === "object") ? parsed.deploy : null,
      patterns: {
        demotion_recurrence_threshold: Number.isInteger(parsed.patterns?.demotion_recurrence_threshold)
          && parsed.patterns.demotion_recurrence_threshold > 0
          ? parsed.patterns.demotion_recurrence_threshold
          : DEFAULTS.patterns.demotion_recurrence_threshold,
      },
      learning: {
        reflector: parsed.learning?.reflector === true,
      },
      memory: {
        inject: parsed.memory?.inject !== false,
        inject_top_k: Number.isInteger(parsed.memory?.inject_top_k) && parsed.memory.inject_top_k > 0
          ? parsed.memory.inject_top_k
          : DEFAULTS.memory.inject_top_k,
        inject_similarity_floor: typeof parsed.memory?.inject_similarity_floor === "number"
          ? parsed.memory.inject_similarity_floor
          : DEFAULTS.memory.inject_similarity_floor,
      },
      review: {
        // An unrecognized value falls back to "panel" rather than throwing —
        // a typo'd config must never silently disable the whole stage.
        mode: parsed.review?.mode === "adversarial" ? "adversarial" : "panel",
      },
      _source: "file",
      _path: p,
      _raw: parsed,
    };
  }
  _cache.set(resolved, result);
  return result;
}

// The set of host names this project's config actually references —
// default_host plus every value in routing.roles/routing.stages, deduped.
// Used only to decide whether there is any host diversity to route the
// critic away from (below); not a general "installed hosts" inventory.
function configuredHosts(routing) {
  const set = new Set();
  if (routing.default_host) set.add(routing.default_host);
  if (routing.roles) for (const h of Object.values(routing.roles)) if (h) set.add(h);
  if (routing.stages) for (const h of Object.values(routing.stages)) if (h) set.add(h);
  return set;
}

function resolveHost(config, stage, role) {
  const routing = config.routing || DEFAULTS.routing;
  if (routing.stages && routing.stages[stage]) return routing.stages[stage];
  if (routing.roles && routing.roles[role]) return routing.roles[role];
  // 31.3: the critic's whole point is independence from the reviewer —
  // default it to a different host when the project has ≥2 hosts configured
  // and nothing explicitly routed it (checked above). Collusion counter-
  // measure cited in plans/phase-31-verification-depth.md §31.3. A single
  // configured host has no diversity to offer, so it falls through to the
  // same default_host as every other role.
  if (role === "critic" && stage === "stage-05") {
    const hosts = configuredHosts(routing);
    if (hosts.size >= 2) {
      const reviewerHost = resolveHost(config, stage, "reviewer");
      const alt = [...hosts].sort().find((h) => h !== reviewerHost);
      if (alt) return alt;
    }
  }
  return routing.default_host;
}

// Adapter-specific deploy config hints. Each entry is an array of YAML lines
// appended under the deploy: block. Required project-specific values are
// marked # TODO so the agent won't use placeholder text verbatim.
// environment and smoke_test_path are included only for the adapters that
// actually define and use them (gizmos and cloud-run).
const DEPLOY_ADAPTER_HINTS = {
  local: [
    "  local:",
    "    # smoke_command: \"npm test\"      # optional; defaults to discovered tests",
    "    # start_command: \"npm start\"     # optional local server command",
    "    # smoke_url: \"http://127.0.0.1:3000/health\"",
  ],
  "docker-compose": [
    "  docker_compose:",
    "    compose_file: docker-compose.yml  # or docker-compose.yaml",
    "    build_no_cache: true",
    "    smoke_test_timeout_s: 30",
  ],
  kubernetes: [
    "  kubernetes:",
    "    strategy: manifests             # or: helm",
    "    namespace: my-app-prod          # TODO: replace with your namespace",
    "    context: prod-cluster           # TODO: must match a kubectl context",
    "    manifests_dir: k8s/manifests",
    "    image_repository: registry.example.com/my-app  # TODO",
    "    image_tag_from: git_sha         # or: env:IMAGE_TAG, or: fixed",
    "    rollout_timeout_s: 300",
  ],
  terraform: [
    "  terraform:",
    "    binary: terraform               # or: tofu",
    "    working_dir: infra              # TODO: directory containing HCL",
    "    workspace: prod                 # TODO: Terraform workspace",
    "    auto_approve: false",
    "    plan_output_path: pipeline/terraform-plan.bin",
    "    drift_check: true",
  ],
  gizmos: [
    "  environment: production           # gate label",
    "  smoke_test_path: /healthz         # health probe path",
    "  gizmos:",
    "    app: my-app                     # TODO: Gizmos app name (must match wrangler.toml)",
    "    src: ./src                      # source directory",
  ],
  "cloud-run": [
    "  environment: production           # gate label",
    "  smoke_test_path: /healthz         # health probe path",
    "  cloud_run:",
    "    project: my-project             # TODO: GCP project ID",
    "    region: us-central1             # TODO: GCP region",
    "    service: my-service             # TODO: Cloud Run service name",
  ],
  custom: [
    "  custom:",
    "    script: scripts/deploy.sh       # TODO: path relative to project root; must be executable",
    "    timeout_s: 1200",
    "    # args: []                      # optional args passed to script",
    "    # smoke_commands: []            # optional shell commands run after script",
  ],
};

// Project-level artifacts scaffolded by `devteam init --adapter <name>`.
// Each entry is a { rel, content } pair: `rel` is the path relative to the
// project root; `content` is written verbatim. Files are only written when
// absent (or when --force is used), so re-running init is always safe.
const DEPLOY_ADAPTER_ARTIFACTS = {
  "docker-compose": [
    {
      rel: "Dockerfile",
      content: [
        "# Stub generated by `devteam init --adapter docker-compose`.",
        "# Stage 4 (platform workstream) will refine this with project-specific",
        "# base image, build steps, and entry point. Update EXPOSE if your service",
        "# listens on a different port.",
        "FROM alpine:latest",
        "WORKDIR /app",
        "COPY . .",
        "EXPOSE 8080",
        "HEALTHCHECK --interval=10s --timeout=3s \\",
        "  CMD wget -qO- http://localhost:8080/ || exit 1",
        'CMD ["sh", "-c", "echo \'TODO: configure CMD in Dockerfile\' && exit 1"]',
        "",
      ].join("\n"),
    },
    {
      rel: "docker-compose.yml",
      content: [
        "# Generated by `devteam init --adapter docker-compose`.",
        "# Stage 4 (platform workstream) will add service-specific config.",
        'version: "3.9"',
        "services:",
        "  app:",
        "    build: .",
        "    ports:",
        '      - "8080:8080"',
        "    restart: unless-stopped",
        "    healthcheck:",
        '      test: ["CMD", "wget", "-qO-", "http://localhost:8080/"]',
        "      interval: 10s",
        "      timeout: 3s",
        "      retries: 3",
        "      start_period: 10s",
        "",
      ].join("\n"),
    },
  ],
};

function renderDefaultConfig(hosts, opts = {}) {
  const list = Array.isArray(hosts) ? hosts : [hosts];
  if (list.length === 0) throw new Error("renderDefaultConfig: at least one host required");
  const lines = [
    "# stagecraft configuration",
    "#",
    "# routing.default_host  fallback host for any (stage, role) not matched below",
    "# routing.roles         per-role overrides; key = role name, value = host name",
    "# routing.stages        per-stage overrides; key = stage id, takes precedence over roles",
    "",
    "routing:",
    `  default_host: ${list[0]}`,
  ];
  if (list.length > 1) {
    lines.push("  # multi-host install — uncomment and customize role overrides:");
    lines.push("  # roles:");
    for (const h of list.slice(1)) {
      lines.push(`  #   <role>: ${h}`);
    }
  }
  lines.push("  # host_concurrency:  # optional per-host workstream limits inside a stage");
  lines.push("  #   default: 2");
  lines.push(`  #   ${list[0]}: 1`);
  lines.push("");
  lines.push("pipeline:");
  lines.push("  default_track: full");
  lines.push("  isolation: in-place");
  lines.push("  # require_signed_gates: false  # requires DEVTEAM_SIGNING_SECRET when true");
  lines.push("  # skip_stages: []     # stage names to skip, e.g. [red-team]");
  lines.push("  # force_stages: []    # stage names to run even when skip/conditional rules would skip them");
  lines.push("  # right_sizing: true  # false disables deterministic auto-skips for inapplicable stages");
  lines.push("  # loop_build_role: backend  # single workstream the `loop` track's build + peer-review dispatch");
  lines.push("  # verify:             # orchestrator-stamped verification commands");
  lines.push("  #   lint_command: \"npm run lint\"   # override; defaults to package.json scripts.lint");
  lines.push("  #   test_command: \"npm test\"      # exclusive override; null disables auto-discovery");
  lines.push("  #   test_concurrency: 2           # 1 serializes suites; maximum is 8");
  lines.push("  #   dependency_audit_command: \"npm audit --json\"  # stage-04c mechanical floor; null disables");
  lines.push("  #   receipts: true                # false disables content-addressed verification receipt reuse");
  lines.push("  #   mutation:                     # stage-06 opt-in mutation smoke gate (31.4); off by default");
  lines.push("  #     enabled: false              # true runs it — Stryker (JS/TS) or mutmut (Python), never installed");
  lines.push("  #     threshold: 0.7              # kill-ratio floor; below it is advisory unless threshold_hard");
  lines.push("  #     threshold_hard: false        # true turns a below-threshold score into a blocking FAIL");
  lines.push("  #     timeout_ms: 300000           # time-box for the mutation run; killed cleanly on expiry");
  lines.push("  #     paths: [\"src/billing/\"]      # optional: further restrict scope within changed files");
  lines.push("  #   test_suites:                  # optional replacement for auto-discovered suites");
  lines.push("  #     - id: unit");
  lines.push("  #       command: \"npm test\"");
  lines.push("  #     - id: browser");
  lines.push("  #       command: \"npm run test:browser\"");
  lines.push("  #       resource_group: browser   # suites sharing a group never overlap");
  lines.push("");
  lines.push("# learning:");
  lines.push("  # reflector: false  # opt-in run-end Reflector dispatch (phase-30 item 30.3)");
  lines.push("  #                   # proposes pattern candidates, never auto-promotes");
  lines.push("");
  lines.push("# memory:");
  lines.push("  # inject: true                   # phase-30 item 30.4 — retrieval into stage prompts");
  lines.push("  #                                 # + run-end auto-ingest; false disables both");
  lines.push("  # inject_top_k: 3                # results queried per stage dispatch");
  lines.push("  # inject_similarity_floor: 0     # drop results below this cosine similarity");
  lines.push("");
  if (opts.adapter) {
    lines.push("deploy:");
    lines.push(`  adapter: ${opts.adapter}`);
    const hints = DEPLOY_ADAPTER_HINTS[opts.adapter];
    if (hints) hints.forEach((h) => lines.push(h));
    lines.push("");
  }
  return lines.join("\n");
}

function writeConfigIfAbsent(cwd, hosts, opts = {}) {
  const p = configPath(cwd);
  if (fs.existsSync(p) && !opts.force) {
    return { written: false, path: p, reason: "exists" };
  }
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(p, renderDefaultConfig(hosts, opts), "utf8");
  return { written: true, path: p };
}

// B9: derive a filesystem-safe change identifier from the feature name.
// Lowercases, collapses non-alphanumeric runs to hyphens, strips leading/
// trailing hyphens, and caps at 64 chars. Returns null for blank input so
// callers can treat null as "in-place mode".
function changeIdFromFeature(feature) {
  if (!feature || typeof feature !== "string") return null;
  const slug = feature
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 64);
  return slug || null;
}

// ADR-009 §Consequences: bounded-isolation needs a changeId derivation for
// repair runs (from the symptom string). Same slug algorithm as changeIdFromFeature.
function changeIdFromSymptom(symptom) { return changeIdFromFeature(symptom); }

// B9 fence (item 5.4): CLI commands that have not yet been wired to pass
// changeId through their pipeline/ path calls. The meta-test in
// tests/bounded-fence.test.js greps core/cli/commands/ for resolveChangeId
// usage and asserts this list matches reality — so the fence cannot silently
// go stale when a command is wired.
//
// The list is empty now. It remains exported so the meta-test can assert parity
// and catch future commands before they silently misread bounded paths.
const BOUNDED_UNWIRED_COMMANDS = [];

// Throw if isolation:bounded is active for an unwired command and the
// operator has not acknowledged partial support via isolation_acknowledge_partial.
// Silent-wrong is the only unacceptable outcome; this makes the current state
// honest. Set isolation_acknowledge_partial: true in .devteam/config.yml to
// use only the driver path (which is fully wired) while the CLI catches up.
function checkBoundedFence(config, commandName) {
  if (config.pipeline.isolation !== "bounded") return;
  if (config.pipeline.isolation_acknowledge_partial) return;
  if (!BOUNDED_UNWIRED_COMMANDS.includes(commandName)) return;
  throw new Error(
    `isolation: bounded is not yet fully wired in the CLI layer.\n` +
    `Commands with no changeId support: ${BOUNDED_UNWIRED_COMMANDS.join(", ")}\n` +
    `Set isolation_acknowledge_partial: true in .devteam/config.yml to bypass ` +
    `this check (driver path is fully wired; CLI read-side commands will silently ` +
    `read the wrong directory without this guard).`,
  );
}

// Known deploy adapter names. Used by `devteam init --adapter` for validation.
const KNOWN_DEPLOY_ADAPTERS = ["local", "docker-compose", "kubernetes", "terraform", "cloud-run", "gizmos", "npm", "custom"];

module.exports = {
  loadConfig, clearConfigCache, resolveHost, configPath, renderDefaultConfig,
  writeConfigIfAbsent, changeIdFromFeature, changeIdFromSymptom, DEFAULTS,
  BOUNDED_UNWIRED_COMMANDS, checkBoundedFence, KNOWN_DEPLOY_ADAPTERS,
  DEPLOY_ADAPTER_ARTIFACTS,
};
