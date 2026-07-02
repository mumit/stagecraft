"use strict";

const FRAME_LINES = 10;

function duration(ms) {
  if (ms == null) return "-";
  if (ms < 1000) return `${ms}ms`;
  const seconds = Math.floor(ms / 1000);
  const minutes = Math.floor(seconds / 60);
  return minutes > 0 ? `${minutes}m ${seconds % 60}s` : `${seconds}s`;
}

function growthRate(bytes, intervalMs) {
  if (!Number.isFinite(bytes) || !Number.isFinite(intervalMs) || intervalMs <= 0) return "-";
  return `${Math.round((bytes * 60000) / intervalMs)} B/min`;
}

function workstreamName(event) {
  const role = event.role || event.workstream_id || "workstream";
  return event.host ? `${role}@${event.host}` : role;
}

function shortPath(value) {
  if (!value) return "-";
  const parts = String(value).split("/");
  return parts.length > 3 ? parts.slice(-3).join("/") : value;
}

function createWatchRenderer(opts = {}) {
  const stream = opts.stream || process.stderr;
  const now = opts.now || Date.now;
  const setTimer = opts.setInterval || setInterval;
  const clearTimer = opts.clearInterval || clearInterval;
  const active = Boolean(stream.isTTY);
  const state = {
    stage: null,
    dispatchStartedAt: null,
    heartbeatAt: null,
    growthBytes: null,
    growthIntervalMs: null,
    stalled: false,
    activeWorkstreams: new Map(),
    lastWorkstream: null,
  };
  let rendered = false;
  let timer = null;
  let finished = false;

  function lines() {
    const current = now();
    const active = [...state.activeWorkstreams.values()];
    const activeText = active.length === 0
      ? "-"
      : active.slice(0, 3).map((ws) => {
          const elapsed = ws.startedAt == null ? "-" : duration(current - ws.startedAt);
          return `${ws.label} ${elapsed}`;
        }).join(", ") + (active.length > 3 ? `, +${active.length - 3}` : "");
    const last = state.lastWorkstream;
    const lastText = last
      ? `${last.label} ${last.outcome}${last.durationMs == null ? "" : ` ${duration(last.durationMs)}`}`
      : "-";
    return [
      "Stagecraft run --watch",
      `  stage:             ${state.stage || "-"}`,
      `  dispatch elapsed:  ${state.dispatchStartedAt == null ? "-" : duration(current - state.dispatchStartedAt)}`,
      `  active:            ${activeText}`,
      `  last workstream:   ${lastText}`,
      `  transcript:        ${last ? shortPath(last.logPath) : "-"}`,
      `  gate:              ${last ? shortPath(last.gatePath) : "-"}`,
      `  log growth:        ${growthRate(state.growthBytes, state.growthIntervalMs)}`,
      `  heartbeat age:     ${state.heartbeatAt == null ? "-" : duration(current - state.heartbeatAt)}`,
      `  stall detected:    ${state.stalled ? "yes" : "no"}`,
    ];
  }

  function render() {
    if (!active || finished) return;
    if (!rendered) stream.write("\x1b[?25l");
    else stream.write(`\x1b[${FRAME_LINES}A`);
    stream.write(lines().map((line) => `\x1b[2K\r${line}`).join("\n") + "\n");
    rendered = true;
  }

  function handle(event) {
    if (!active || finished) return;
    const at = now();
    switch (event.type) {
      case "heartbeat":
        state.heartbeatAt = at;
        if (event.stage) state.stage = event.name || event.stage;
        break;
      case "dispatch":
        state.stage = event.name || event.stage || state.stage;
        state.dispatchStartedAt = at;
        state.growthBytes = null;
        state.growthIntervalMs = null;
        state.stalled = false;
        state.activeWorkstreams.clear();
        break;
      case "workstream-started":
        state.stage = event.name || event.stage || state.stage;
        state.activeWorkstreams.set(event.workstream_id || event.role || "workstream", {
          label: workstreamName(event),
          startedAt: at,
          logPath: event.log_path || null,
          gatePath: event.gate_path || null,
        });
        break;
      case "workstream-finished": {
        const key = event.workstream_id || event.role || "workstream";
        state.activeWorkstreams.delete(key);
        const outcome = event.skipped ? "skipped"
          : event.timed_out ? "timed out"
          : event.exit_code == null ? "finished"
          : `exit ${event.exit_code}`;
        state.lastWorkstream = {
          label: workstreamName(event),
          outcome,
          durationMs: event.duration_ms,
          logPath: event.log_path || null,
          gatePath: event.gate_path || null,
        };
        break;
      }
      case "dispatch-progress":
        state.stage = event.name || event.stage || state.stage;
        state.growthBytes = event.log_growth_bytes_last_interval;
        state.growthIntervalMs = event.interval_ms;
        break;
      case "stall-detected":
        state.stalled = true;
        break;
      case "dispatched":
        state.stage = event.name || event.stage || state.stage;
        state.dispatchStartedAt = null;
        state.activeWorkstreams.clear();
        state.stalled = false;
        break;
      default:
        break;
    }
    render();
  }

  function start() {
    if (!active || timer || finished) return;
    render();
    timer = setTimer(render, 1000);
  }

  function finish() {
    if (finished) return;
    finished = true;
    if (timer !== null) clearTimer(timer);
    timer = null;
    if (active && rendered) stream.write("\x1b[?25h");
  }

  return { active, start, handle, finish };
}

module.exports = { createWatchRenderer, duration, growthRate };
