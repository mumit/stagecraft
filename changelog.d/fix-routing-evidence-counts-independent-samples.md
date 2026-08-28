- **Routing readiness counts independent samples, not raw dispatches.** The
  `>=5-per-(role, host)` condition behind D5 counted every
  `dispatch-observation` equally, so a single run retrying to its iteration cap
  contributed as many observations as it had attempts. The
  [2026-08-27 D5 review](../plans/d5-evidence-review-2026-08-27.md) measured
  **23.4 observations per run against a `loop` plan of 5** — and the condition
  read that as satisfied. A run that cannot finish should not be able to open an
  evidence gate by retrying.
  `dispatch-observation` now carries `attempt` (prior dispatches of this stage in
  this run) and `produced_output` (false only when the host wrote nothing at
  all). Routing rows gain `independent_observations`, which excludes retries and
  silent dispatches; readiness compares against that. `gate_observations` is
  unchanged and remains a faithful dispatch count.
  *Honest scope note:* **forward-looking only.** Events written before these
  fields existed are counted as independent, so existing bundles keep reading as
  they did rather than being silently deflated — which means this prevents a
  future retry storm from satisfying a gate but does **not** repair evidence
  already collected. The corpus the D5 review criticised still needs
  re-collection, for that reason and for the others the review records.
  `attempt` is a bounded integer chosen over a run id precisely because it
  carries no identity. Gate-snapshot rows expose `independent_observations` too
  — equal to `gate_observations`, since a snapshot is per-file and a retry
  overwrites it — so readiness never reads `undefined` on the legacy path.
  Bundle validation accepts the new count when present and never requires it, so
  a bundle exported before today still validates.
