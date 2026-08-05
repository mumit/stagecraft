"use strict";

// core/cli/nearest-match.js — small Levenshtein-distance "did you mean"
// helper for unknown-command suggestions (phase 37.1). No dependency: this
// is a handful of lines, not worth pulling in a package for.

// Classic full-matrix edit distance (insert/delete/substitute, cost 1 each).
function levenshtein(a, b) {
  const m = a.length;
  const n = b.length;
  if (m === 0) return n;
  if (n === 0) return m;

  let prev = new Array(n + 1);
  let curr = new Array(n + 1);
  for (let j = 0; j <= n; j++) prev[j] = j;

  for (let i = 1; i <= m; i++) {
    curr[0] = i;
    for (let j = 1; j <= n; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      curr[j] = Math.min(
        prev[j] + 1,      // deletion
        curr[j - 1] + 1,  // insertion
        prev[j - 1] + cost, // substitution
      );
    }
    [prev, curr] = [curr, prev];
  }
  return prev[n];
}

// nearestMatch(input, candidates) — the closest candidate by edit distance,
// or null if nothing is close enough to be a useful suggestion.
function nearestMatch(input, candidates) {
  let best = null;
  let bestDist = Infinity;
  for (const candidate of candidates) {
    const dist = levenshtein(input, candidate);
    if (dist < bestDist) {
      bestDist = dist;
      best = candidate;
    }
  }
  if (best === null) return null;
  // Half the length of the longer string, floor 2: close enough to be a typo,
  // not so far that the suggestion is noise (e.g. "xyz" vs "run").
  const threshold = Math.max(2, Math.ceil(Math.max(input.length, best.length) / 2));
  return bestDist <= threshold ? best : null;
}

module.exports = { levenshtein, nearestMatch };
