// Gate-time failure classification (ADR-003 / BACKLOG H1, Phase 0).
//
// `next()` historically collapsed every non-pass, non-escalate gate into a
// single `fix-and-retry` action — a corrupt gate file and a failing test got
// the same response. This module assigns a `failure_class` to a non-pass gate
// so callers (the human stage manager today; the autonomous driver later) can
// react correctly instead of blindly retrying.
//
// Classes are defined by the RESPONSE they require, not by their cause:
//
//   state-corruption — the gate can't be read/parsed. Re-running the stage
//                       cannot fix corruption; the file must be repaired.
//   judgment-gate    — status ESCALATE. Needs a ruling, not a retry.
//   external-blocked — status FAIL whose only computed remedy is human/
//                       external action (we HAVE a fix recipe but every step
//                       has no executable command — e.g. "obtain PM sign-off").
//   code-defect      — status FAIL with executable fix steps, OR no recipe at
//                       all. The implementing agent must change code; re-dispatch.
//
// A fifth class, `convergence-exhausted`, is NOT decided here — it depends on
// the gate's retry_number and the configured ceiling, which only next() holds.
// next() applies it before classifyGate when the retry budget is spent.
//
// Note on `code-defect` vs `external-blocked`: a FAIL with NO recipe
// (computeFixSteps returned null) is treated as code-defect, not
// external-blocked. A missing recipe means "we can't auto-generate steps,"
// which is usually an un-recipe'd code fix (e.g. security-review findings the
// agent must address in code) — not a human-only action. external-blocked is
// reserved for the case where we DO have a recipe and it is entirely
// human/external steps.
//
// This module is a pure function: no I/O, no config. It is the gate-time half
// of the failure model; the dispatch-time half (classifyDispatch — transient
// vs structural-input) lands with the driver (H2), which is the only caller
// that holds runHeadless's return.

// Default retry budget before next() escalates a still-FAIL stage instead of
// returning fix-and-retry again. Overridable via config (autonomy.max_retries).
const MAX_RETRIES_DEFAULT = 2;

/**
 * Classify a non-pass gate by required response.
 *
 * @param {object|null} gate     Parsed gate object, or null when unreadable.
 * @param {Array|null}  fixSteps computeFixSteps() output: array of
 *                               { description, commands[] }, or null.
 * @param {object}      [opts]
 * @param {boolean}     [opts.corrupt=false] Set when the gate could not be
 *                               read/parsed (no status available).
 * @returns {string|null} one of "state-corruption" | "judgment-gate" |
 *                        "external-blocked" | "code-defect", or null for a
 *                        PASS/WARN (non-failure) gate.
 */
function classifyGate(gate, fixSteps, { corrupt = false } = {}) {
  if (corrupt || !gate) return "state-corruption";
  if (gate.status === "ESCALATE") return "judgment-gate";
  if (gate.status === "FAIL") {
    const hasRecipe = Array.isArray(fixSteps) && fixSteps.length > 0;
    const allHumanAction = hasRecipe
      && fixSteps.every((s) => !Array.isArray(s.commands) || s.commands.length === 0);
    if (allHumanAction) return "external-blocked";
    return "code-defect";
  }
  return null; // PASS / WARN — not a failure
}

// Default number of transient (no-gate) dispatch retries before a no-gate
// outcome is reclassified as structural-input and the run halts.
const MAX_TRANSIENT_RETRIES_DEFAULT = 1;

/**
 * Classify the OUTCOME of a headless dispatch (the dispatch-time half of the
 * failure model — ADR-003 §2.6/§2.7). Only the driver can call this: it is the
 * one holder of the runHeadless return.
 *
 * A dispatch that wrote no gate is ambiguous from a bare exit code — a rate
 * limit (retry helps) looks like a context overflow (retry can't help). The
 * repetition heuristic resolves it safely: the first no-gate failure is treated
 * as transient (backoff + retry identical); an identical repeat is structural.
 * A clean exit (code 0) with no gate is structural immediately — the host ran
 * and chose to write nothing; retrying will reproduce that.
 *
 * @param {object} result
 * @param {boolean} result.wroteGate  every non-skipped workstream wrote a gate
 * @param {number|null} result.exitCode  aggregate exit (null when timed out)
 * @param {boolean} result.timedOut
 * @param {boolean} [result.hadWrites]  any non-orchestrator file was written
 *                               during the dispatch (per the write-audit
 *                               snapshot diff), even though no gate resulted.
 * @param {object} [opts]
 * @param {number} [opts.transientRetries=0]      retries already spent this stage
 * @param {number} [opts.maxTransientRetries=1]
 * @returns {string} "ok" | "transient" | "structural-input"
 */
function classifyDispatch(result, { transientRetries = 0, maxTransientRetries = MAX_TRANSIENT_RETRIES_DEFAULT } = {}) {
  if (result.wroteGate) return "ok";
  // Stub gate still present — LLM exhausted context before overwriting it.
  // Treat exactly like a crash or timeout: transient until budget spent.
  if (result.stubGate) {
    if (transientRetries >= maxTransientRetries) return "structural-input";
    return "transient";
  }
  // A clean exit that also produced ZERO bytes did not evaluate the input at
  // all. That is the signature of a host that never ran the turn -- codex exits
  // 0 and silent when the account is out of quota -- and the right response is
  // to wait and re-run the same input, the opposite of what structural-input
  // tells the operator to do. Classified separately so the driver can say so.
  //
  // Only when the silence is total. A host that emitted anything and still
  // wrote no gate did evaluate the input, and that remains structural.
  if (result.exitCode === 0 && !result.timedOut && result.noOutput === true) {
    return "host-silent";
  }
  // Clean exit, some output, nothing written → the host did nothing useful
  // with the input; retry won't help.
  //
  // Exception: the host DID write files (hadWrites) even though no gate
  // resulted. That is not "chose to do nothing" — for an agentic tool-loop
  // host (e.g. openai-compat) it is the signature of a dispatch that was
  // still mid-task (scaffolding, editing, running verification) when its
  // iteration/time budget ran out before the model reached its final
  // "write the gate" step. A retry (ideally with a budget-aware nudge to
  // wrap up sooner) can plausibly converge; treat it like a crash/timeout
  // instead of an immediate, unretriable halt.
  if (result.exitCode === 0 && !result.timedOut) {
    if (result.hadWrites === true) {
      if (transientRetries >= maxTransientRetries) return "structural-input";
      return "transient";
    }
    return "structural-input";
  }
  // Crash / timeout / non-zero exit: transient until we've retried enough.
  if (transientRetries >= maxTransientRetries) return "structural-input";
  return "transient";
}

module.exports = { classifyGate, classifyDispatch, MAX_RETRIES_DEFAULT, MAX_TRANSIENT_RETRIES_DEFAULT };
