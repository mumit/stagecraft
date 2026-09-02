- **A dispatch cut off mid-task by the tool-call iteration cap is no longer
  reported as "input is structurally unworkable"** ([#495](https://github.com/telus-labs/stagecraft/pull/495)).
  `classifyDispatch` treated a clean exit with no gate as structural on the
  first attempt, zero retries — the same response given to a host that ran
  and wrote nothing. For an agentic tool-loop host (openai-compat/GLM), a
  dispatch that hits `MAX_TOOL_ITERATIONS` mid-task looks identical on the
  three signals classify sees (exit code, timed-out, wrote-gate): files were
  being written, converging toward a final gate, but the budget ran out
  first. A stalled `build` stage halted this way after 25 minutes of real,
  forward progress cut off by the cap, not by GLM-5.3 misbehaving.
  `classifyDispatch` now accepts an optional `hadWrites` signal: clean exit +
  no gate + **files were written** classifies `transient` (one retry) instead
  of an immediate halt; clean exit + no gate + **nothing written at all**
  keeps the prior immediate `structural-input`. `core/adapters/headless.js`
  derives the same signal from its existing write-audit snapshot, so
  claude-code/codex/antigravity get the fix too, not just openai-compat.
  `hosts/openai-compat/invoke.js` also now writes a real per-stage transcript
  to `pipeline/logs/<stage>.log` unconditionally (previously stderr only
  under `--verbose`), and nudges the model ~5 iterations before the cap to
  stop expanding scope and write the gate as its next action.
  *Honest scope note:* verified at the unit-test level only — the fix has not
  yet been re-run live against the demo project that originally stalled.
