- **`run()` decomposition, slice 1 (builder review F5, continuing audit P2-2).**
  The run-end side-effect phase — pattern auto-collection, the opt-in Reflector
  pass, memory auto-ingest, and the resolution linker — moved out of
  `core/driver.js` into `core/driver-runend.js`. It was the cleanest available
  seam: four fire-and-forget passes that run after the loop finishes, the run
  state is saved, and the lock is released, none of which touches `summary`.
  `run()` drops from 1,780 to 1,725 lines. *Honest scope note:* behavior-
  preserving and nothing more — conditions, ordering, log outcomes, and the
  swallow-and-log contract are identical to the inline version, and the full
  suite passes with no test changes, which is the evidence. 13 characterization
  tests now pin the seam (firing conditions per pass, `memory.inject` as the
  single off switch, the reflector's exactly-`true` gate and never-on-halt rule,
  and that `summary` is unaffected even when every pass throws). `run()` retains
  lock, loop, and final-persistence ownership exactly as P2-2 left it; the
  prologue and the final-persistence block remain as future slices.
