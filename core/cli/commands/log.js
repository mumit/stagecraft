"use strict";

const path = require("node:path");
const { generateHelp } = require(path.join(__dirname, "..", "flags"));

const name = "log";

const flags = {
  cwd:     { type: "string",  description: "Target project directory" },
  feature: { type: "string",  description: "Feature name (bounded isolation mode)" },
  json:    { type: "boolean", description: "JSON output (one object per line)" },
  follow:  { type: "boolean", description: "Tail pipeline/ at 1s poll" },
  timeline:{ type: "boolean", description: "Show durable queue/invoke/verification/retry/blocker timeline" },
  help:    { type: "boolean", description: "Show this help" },
};

// Format an event from core/log/journal.js as a single terminal line.
function formatLogEvent(event, cwd) {
  const { summarizeGate, summarizeArtifact } = require(path.join(__dirname, "..", "..", "log", "journal"));
  const time = new Date(event.mtime).toISOString().slice(11, 19); // HH:MM:SS
  if (event.kind === "gate") {
    const s = summarizeGate(event.gate);
    const extras = s.extras ? `  ${s.extras}` : "";
    return `${time}  ${s.icon}  ${(s.label ?? "?").padEnd(20)}  ${(s.status ?? "?").padEnd(8)}${extras}`;
  }
  if (event.kind === "artifact") {
    const a = summarizeArtifact(event, cwd);
    const owner = a.owner ? `  (${a.owner})` : "";
    return `${time}  📝  ${a.rel.padEnd(20)}  ${a.lines} lines${owner}`;
  }
  return `${time}  ?  ${event.path}`;
}

function run(positional, _flags) {
  if (_flags.help) { console.log(generateHelp("devteam log [options]", flags)); process.exit(0); }
  const cwd = _flags.cwd || process.cwd();
  const { requireProjectContext } = require(path.join(__dirname, "..", "project-guard"));
  requireProjectContext(cwd, _flags, "log");
  const { loadConfig, checkBoundedFence } = require(path.join(__dirname, "..", "..", "config"));
  const config = loadConfig(cwd);
  checkBoundedFence(config, "log");
  const { resolveChangeId } = require(path.join(__dirname, "..", "resolve-change-id"));
  const changeId = resolveChangeId(_flags, config);
  const { buildEvents } = require(path.join(__dirname, "..", "..", "log", "journal"));

  if (_flags.timeline) {
    if (_flags.follow) {
      console.error("devteam log: --timeline and --follow are mutually exclusive");
      process.exit(2);
    }
    const { pipelineRoot } = require(path.join(__dirname, "..", "..", "paths"));
    const { buildTimeline, readJsonLines, renderTimeline } = require(path.join(__dirname, "..", "..", "performance", "critical-path"));
    const events = readJsonLines(path.join(pipelineRoot(cwd, changeId), "run-log.jsonl")).events;
    const rows = buildTimeline(events);
    if (_flags.json) rows.forEach((row) => console.log(JSON.stringify(row)));
    else process.stdout.write(renderTimeline(rows));
    return;
  }

  function emit(events) {
    if (_flags.json) {
      for (const e of events) {
        const out = {
          ts: new Date(e.mtime).toISOString(),
          kind: e.kind,
          path: path.relative(cwd, e.path).replace(/\\/g, "/"),
        };
        if (e.kind === "gate") {
          out.stage = e.gate.stage;
          out.workstream = e.gate.workstream;
          out.status = e.gate.status;
        } else {
          out.owner = e.owner;
          out.artifactKind = e.artifactKind;
        }
        console.log(JSON.stringify(out));
      }
    } else {
      for (const e of events) console.log(formatLogEvent(e, cwd));
    }
  }

  const initial = buildEvents(cwd, changeId);
  emit(initial);

  if (!_flags.follow) return;

  // --follow: re-scan periodically and emit anything new. Polling
  // (1s) keeps the implementation portable across platforms (fs.watch
  // recursive isn't reliable on Linux). The cost — ~1 readdir/sec
  // over a small dir — is negligible.
  const seen = new Set();
  for (const e of initial) seen.add(`${e.kind}:${e.path}:${e.mtime.getTime()}`);
  const interval = setInterval(() => {
    let events;
    try { events = buildEvents(cwd, changeId); } catch { return; }
    const fresh = [];
    for (const e of events) {
      const key = `${e.kind}:${e.path}:${e.mtime.getTime()}`;
      if (!seen.has(key)) {
        seen.add(key);
        fresh.push(e);
      }
    }
    if (fresh.length > 0) emit(fresh);
  }, 1000);
  // Keep process alive on Ctrl-C — interval.unref would otherwise let
  // node exit when the only handle left is the interval. We want the
  // user to hit Ctrl-C explicitly.
  process.on("SIGINT", () => { clearInterval(interval); process.exit(0); });
}

module.exports = { name, flags, run };
