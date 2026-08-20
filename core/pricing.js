// Model pricing table — USD per million input/output tokens.
//
// Updated 2026-08-20 against the providers' own pricing pages. Prices change;
// treat the dollar figures here as estimates, not invoices. The pricing table
// is intentionally small and easy to audit — adding a model is one line.
//
// List price only. Promotional and introductory rates are noted inline but
// never encoded: a promo expires and then silently under-reports every cost
// and budget check downstream, which is the worse failure for a `--budget-usd`
// cap. List price is the durable figure.
//
// A missing entry is not a cost of zero. pricingFor() returns null, callers
// surface the D7 "unpriced model — budget enforcement incomplete" warning, and
// nothing is fabricated. When this table falls behind a provider's releases
// that warning is the symptom — refresh here rather than widening a prefix.
//
// Lookup is exact-match first, then prefix-match at a `-` boundary only, so a
// dated snapshot ("claude-opus-4-7-2025-05") resolves to its family while a
// different model that merely shares a leading substring ("gpt-5.6-sol" vs the
// "gpt-5" entry) does not. See pricingFor() for why that boundary matters.

const PRICING_USD_PER_MTOK = {
  // Anthropic — https://www.anthropic.com/pricing
  "claude-fable-5":       { input: 10.00, output: 50.00 },
  "claude-mythos-5":      { input: 10.00, output: 50.00 },
  "claude-opus-5":        { input:  5.00, output: 25.00 },
  "claude-opus-4-8":      { input:  5.00, output: 25.00 },
  "claude-opus-4-7":      { input:  5.00, output: 25.00 },
  "claude-opus-4-6":      { input:  5.00, output: 25.00 },
  "claude-sonnet-5":      { input:  3.00, output: 15.00 }, // intro $2/$10 through 2026-08-31
  "claude-sonnet-4-6":    { input:  3.00, output: 15.00 },
  "claude-sonnet-4":      { input:  3.00, output: 15.00 },
  "claude-haiku-4-5":     { input:  1.00, output:  5.00 },
  "claude-haiku-4":       { input:  0.80, output:  4.00 },

  // OpenAI — https://developers.openai.com/api/docs/pricing
  "gpt-5.6-sol":          { input:  5.00, output: 30.00 },
  "gpt-5.6-terra":        { input:  2.00, output: 12.00 },
  "gpt-5.6-luna":         { input:  0.20, output:  1.20 },
  "gpt-5.5":              { input:  5.00, output: 30.00 },
  "gpt-5":                { input:  1.25, output: 10.00 },
  "gpt-5-mini":           { input:  0.25, output:  2.00 },
  "gpt-5-nano":           { input:  0.05, output:  0.40 },
  "gpt-4.1":              { input:  2.00, output:  8.00 },
  "gpt-4.1-mini":         { input:  0.40, output:  1.60 },
  "gpt-4.1-nano":         { input:  0.10, output:  0.40 },
  "gpt-4o":               { input:  2.50, output: 10.00 },
  "gpt-4o-mini":          { input:  0.15, output:  0.60 },
  "o3":                   { input:  2.00, output:  8.00 },
  "o3-mini":              { input:  1.10, output:  4.40 },
  "o1":                   { input: 15.00, output: 60.00 },
  "o1-mini":              { input:  3.00, output: 12.00 },

  // Google — https://ai.google.dev/gemini-api/docs/pricing
  "gemini-3.7-flash":      { input:  1.50, output:  7.50 }, // promo $0.75/$3.75 to 2026-12-31
  "gemini-3.6-flash":      { input:  1.50, output:  7.50 }, // promo $0.75/$3.75 to 2026-12-31
  "gemini-3.5-flash":      { input:  1.50, output:  9.00 },
  "gemini-3.5-flash-lite": { input:  0.30, output:  2.50 },
  "gemini-2.5-pro":        { input:  1.25, output: 10.00 },
  "gemini-2.5-flash":      { input:  0.30, output:  2.50 },
  "gemini-2.5-flash-lite": { input:  0.10, output:  0.40 },
  "gemini-2.0-flash":      { input:  0.075, output: 0.30 },
};

// Return the pricing record for a model id, or null if unknown.
function pricingFor(model) {
  if (!model || typeof model !== "string") return null;
  if (PRICING_USD_PER_MTOK[model]) return PRICING_USD_PER_MTOK[model];
  // Prefix match — a dated snapshot should still resolve to its family. The
  // remainder must begin with "-" so the match lands on a name boundary:
  // "claude-opus-4-7-2025-05" → "claude-opus-4-7" is the family it was cut
  // from, but "gpt-5.6-sol" is a *different model* that merely starts with
  // "gpt-5" and costs 4x its input rate. A bare startsWith() priced the
  // former correctly and the latter silently wrong, and a silently wrong
  // price is worse than no price: it under-reports every --budget-usd check
  // instead of raising the D7 unpriced-model warning.
  //
  // Iterate in order of decreasing key length so the most specific match wins
  // (e.g. "claude-opus-4-7" before "claude-opus-4").
  const keys = Object.keys(PRICING_USD_PER_MTOK).sort((a, b) => b.length - a.length);
  for (const key of keys) {
    if (model.startsWith(key) && model[key.length] === "-") return PRICING_USD_PER_MTOK[key];
  }
  return null;
}

// Compute USD cost for a single dispatch. Returns null when any input
// is missing — cost is opt-in; absent data is not zero cost.
function computeCostUsd({ model, tokens_in, tokens_out }) {
  const p = pricingFor(model);
  if (!p) return null;
  if (typeof tokens_in !== "number" || typeof tokens_out !== "number") return null;
  return (tokens_in / 1_000_000) * p.input + (tokens_out / 1_000_000) * p.output;
}

// Format a USD number for terminal display: "$0.0042" / "$1.23" / "$42.50".
// Returns the literal "—" for null (unknown), so columns line up.
function formatUsd(n) {
  if (n === null || n === undefined || Number.isNaN(n)) return "—";
  if (n === 0) return "$0.00";
  if (n < 0.01) return `$${n.toFixed(4)}`;
  if (n < 1) return `$${n.toFixed(3)}`;
  return `$${n.toFixed(2)}`;
}

module.exports = {
  PRICING_USD_PER_MTOK,
  pricingFor,
  computeCostUsd,
  formatUsd,
};
