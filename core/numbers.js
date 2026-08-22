"use strict";

// One home for the "is this number trustworthy?" predicate.
//
// core/driver.js, core/corpus.js, and core/gates/observed.js each carried a
// byte-identical private copy. They had not drifted, which is the only reason
// this is a cleanup and not a bug report -- but it is the same shape that
// produced two real defects in this codebase: three readers of framework-owned
// paths that disagreed (fixed in #431, now core/paths.js) and two readers of
// observed cost/model precedence that disagreed (fixed in #450, now
// core/gates/observed.js). Both were found only after they had already shipped
// wrong answers.

// nonNegativeNumber — returns the value when it is a finite number >= 0, else
// null. Telemetry arrives from models and host CLIs, so a field can be absent,
// a string, NaN, Infinity, or negative; null is the caller's signal to treat
// the figure as missing rather than as zero. Returning 0 for a missing value
// would silently understate a budget instead of reporting no coverage.
function nonNegativeNumber(value) {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : null;
}

module.exports = { nonNegativeNumber };
