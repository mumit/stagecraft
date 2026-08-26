- **`gpt-5.6-sol` was priced at GPT-5.5's rates.** The table carried
  `$5.00 / $30.00`; OpenAI publishes Sol at **`$4.00 / $20.00`** — input 25%
  high, output 50% high. It is the model `codex` runs by default, so every
  derived codex cost was inflated before caching entered the picture. Same class
  as the stale-table finding that blocked the Phase 41 gates.
- **Derived cost charged cache reads at the full input rate.** `computeCostUsd`
  took no cached parameter and the table had no cached rate, so a cache-heavy
  agentic dispatch was billed as if nothing had been cached. Both providers
  publish cache reads at 0.1× input. Measured on a real codex build dispatch —
  134,003 input tokens of which 111,872 (83%) were cache reads — the derived
  cost falls from **$0.75 to $0.19, a 4× overstatement corrected**. This matters
  wherever `--budget-usd` binds: only `claude-code` reports real dollars; the
  other six hosts all derive.
- **The two providers count cached tokens in opposite directions, and that is
  now recorded per dispatch.** OpenAI documents
  `ordinary = input_tokens - cached - cache_write` (cached is a **subset**);
  Anthropic reports `input_tokens` as the uncached remainder with cache reads
  counted **separately**. Stagecraft's adapters each preserved their own
  provider's convention, so `_orchestrator_observed.tokens_in` meant two
  different things depending on which host wrote the gate — and no single cost
  calculation could be right for both. Adapters now declare
  `input_accounting: "inclusive" | "exclusive"` alongside the tokens, and
  `computeCostUsd` branches on it. Reading the same numbers under the wrong
  convention moves the answer by ~4×, in either direction.
  *Honest scope note:* Anthropic's per-model cached rates are **derived**, not
  published — Anthropic documents cache reads at ~0.1× input, and the entries
  are labelled as an estimate of an estimate. A model with no `cachedInput`
  entry still charges cached tokens at the full input rate: an overstatement,
  never a fabricated discount, because a budget that silently stops binding is
  the worse failure. OpenAI publishes no separate cache-*write* rate for the
  GPT-5.6 family, so cache writes bill at the ordinary input rate. Four
  superseded assertions are updated, including one that pinned Sol's wrong
  `$5.00` rate.
