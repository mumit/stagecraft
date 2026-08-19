- **Keep on-demand verification inside the audit chain.** `devteam verify` now
  re-stamps the active run's gate chain after rewriting a gate and refuses to touch signed
  history without `DEVTEAM_SIGNING_SECRET`. Verify/stamp-chain commands prefer the
  materialized run-plan track over a mutable config default, preventing repair or assessed
  runs from being checked against an order they did not execute.
