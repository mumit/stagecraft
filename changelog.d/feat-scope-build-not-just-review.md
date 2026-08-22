- **A track that scopes peer-review now scopes its build to the same role**
  ([ADR-025](../docs/adr/025-scope-build-not-just-review.md), accepted). `nano`
  and `refactor` declared a single reviewer but still ran the four-area build
  matrix, so the funnel narrowed *after* the cost was already spent — one
  reviewer looking at the output of four builders. Both now cost **3 dispatches
  instead of 6** on the case they exist for, which makes `nano` cheaper than
  `loop` (4) and matches the documented ordering for the first time. The scoped
  build also removes a merge round-trip, since a single-workstream stage has
  nothing to merge.
  The build role is derived from `PEER_REVIEW_SIZING` rather than a second list,
  so the built area and the reviewed area cannot drift apart, and it is guarded
  on the role being a real build workstream — which excludes `review-pr`'s
  "reviewer" panel name.
  *Honest scope note:* this is a deliberate assurance reduction on the
  cross-cutting case. A `nano` change that touches four areas now gets one
  builder instead of four. The protection is unchanged: `assess` picks the track
  from the change shape, and the stoplist still refuses `nano` for anything
  consequential. Two superseded tests are updated rather than weakened — one
  asserted `nano` kept the four-area matrix, the other that `nano`'s build
  required a merge; both were correct before this ADR and are wrong after it.
- **The tracks matrix derives its "scoped" marker from `rolesForStage()`.**
  `scripts/generate-tracks-matrix.js` listed track names inline, and had already
  drifted: `refactor`'s peer-review has been a single reviewer since 35.5 and the
  published matrix still drew it as a four-area stage.
