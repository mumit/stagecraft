- **The retry-ownership halt no longer advises an edit that silently breaks the
  gate chain.** It said to "correct stage-02 `file_ownership`". That field lives
  inside `pipeline/gates/stage-02.json`, and stage gates are chained — each
  records a hash of its predecessor, which is what makes the provenance
  tamper-evident. Opening the gate and editing it, the obvious reading, changes
  its hash so the next gate's recorded `prev_hash` stops matching. Nothing checks
  the chain during a run; only `devteam verify-chain`, `devteam verify`, and
  evidence attestation do — so an operator following the advice could discover
  the break much later, at export, with no memory of causing it.
  The halt now points at re-running design, which re-attests the gate legitimately,
  and states the cost of a hand edit along with the `devteam stamp-chain` repair.
  *Honest scope note:* wording only — no halt behavior, evidence, or chain logic
  changes. The chain already detected this correctly; the guidance was what sent
  operators into it.
