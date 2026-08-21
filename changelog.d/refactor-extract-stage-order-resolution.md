- **`run()`'s stage-order decision moves to `core/driver-stage-order.js`.**
  Slice 3 of the P2-2 decomposition, after `core/driver-safety.js` and
  `core/driver-runend.js`. `resolveStageOrder()` answers one question — given
  the resolved track, the run's intent, and the operator's flags, which stages
  will this run execute and is the `--until` boundary one the run can honor —
  and it is pure: no filesystem, no lock, no run state. `run()` drops from 1,735
  to 1,703 lines.
  The `--until` validation moves with the order it validates against, so the two
  cannot drift apart. That matters for repair runs, where ADR-009 injects
  `executable-spec` into a track that does not otherwise contain it: the
  boundary is checked against the order that will actually be applied, not the
  bare track order.
  *Honest scope note:* behavior-preserving by construction and verified as such
  — the 23-test prologue characterization suite passes unchanged, and eight
  mutations of the extracted logic each fail at least one suite. `resolveStageOrder`
  deliberately does not return the diagnosis-prepend flag even though `run()`
  computed one: it is a step in building `order`, and `order[0] === "requirements"`
  already states its outcome. A second way to ask the same question is how the
  drift this decomposition exists to fix got started.
- **New: 15 unit tests for the ADR-009 stage-order rules** at the level they are
  decided, covering branches the end-to-end suite reaches only indirectly —
  `--repair-at`, `--force` opting out of the stoplist upgrade, double-prepend
  guarding, and repair on a track with no `build` stage (`review-only`,
  `review-pr`), where `executable-spec` leads the order instead of preceding
  `build`. That last branch was covered by neither suite before this change.
