- **`run()` decomposition, slice 2 (builder review F5, continuing audit P2-2).**
  Effective safety-policy resolution — the caps that bind a run, plus the two
  operator warnings that accompany resolving them — moved out of `run()`'s
  prologue into `core/driver-safety.js`. Split deliberately into a pure
  `resolveRunSafety` that returns the warnings it thinks should be emitted and
  an `emitSafetyWarnings` that writes them, so the policy can be tested without
  capturing process output and *what* to warn about stays separate from *where*
  it goes. `run()` drops from 1,725 to 1,721 lines. *Honest scope note:*
  behavior-preserving — the full suite passes with no test changes, which is the
  evidence. `run()` keeps ownership of the mid-prologue reassignment when a
  stoplist bypass is authorized (ADR-018 binds a bypass to a hashed
  feature/brief/stoplist), so the extraction covers resolution and not the
  policy's whole lifetime. 9 characterization tests pin the seam, including that
  a zero cap counts as a cap rather than as absent.
