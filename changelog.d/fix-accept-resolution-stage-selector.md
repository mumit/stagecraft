- **`devteam evidence accept-resolution --stage <stage>`.** The command took the
  newest unaccepted fix/retry and nothing else. On a run that retried `stage-04`
  successfully and then escalated at `stage-06`, the newest slot held a retry
  that never resolved; `assertPassingGate` correctly refused it, and there was
  then **no way to accept `stage-04`'s genuine, derivable resolution at all** —
  a real acceptance was blocked by an unrelated later failure. Observed on a
  real run while collecting H3 evidence, and part of why accepted-resolution
  evidence stayed at zero. `--stage` selects which resolution to consider, and
  when the default is refused the error now names the stages that would work
  instead of leaving a dead end. *Honest scope note:* the selector chooses among
  candidates; it does not bypass ADR-012's requirement that the named stage's
  current gate is PASS, and a stage whose retry did not resolve is still
  refused.
