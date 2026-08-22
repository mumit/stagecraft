- **`pipeline/run-plan.json` no longer promises a dispatch that will not happen —
  or omits one that will.** Two functions answered "which roles will dispatch":
  `expectedRolesForStage` (the plan preview) and `inferActiveRoles` (the
  runtime). Both filter a stage's roles to the change's active workstreams, but
  only the runtime refused an empty result — "an empty result … would produce a
  zero-workstream plan that completes in 0ms and loops" — and kept the unfiltered
  roles instead. The preview did not, so the two disagreed.
  The disagreement was reachable on the **default track**. `loop` pins build and
  peer-review to a single role (`loopBuildRole`, default `backend`), so a
  frontend-only change filtered that role out and the plan reported **zero build
  dispatches, zero qa, zero peer-review, and `expected_workstreams: 1`** for a
  run that dispatches four. ADR-018 calls that file an inspectable execution
  contract; a contract that disagrees with the runtime is worse than no contract.
  The preview now applies the same guard, and a parity test asserts the two
  functions agree rather than testing them separately.
  *Honest scope note:* this changes the preview only — no dispatch behavior
  changes, and the suite passed unchanged. It also makes a real design question
  visible that the zero was hiding: on `loop`, a frontend-only change is built
  and reviewed by the `backend` role, because `loopBuildRole` does not consider
  what changed. That is a separate decision and needs its own ADR.
