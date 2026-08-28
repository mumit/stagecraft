- **A host that exits cleanly having written nothing is no longer reported as
  "input is structurally unworkable"** ([#490](https://github.com/telus-labs/stagecraft/issues/490)).
  `codex exec` exits `0` with an empty stream when the account is out of quota.
  `classifyDispatch` read that as a clean exit with no gate and returned
  `structural-input` — whose comment, *"the host did nothing; retry won't
  help"*, is exactly backwards for a blocked account. Four consecutive runs
  halted this way in ~10s each, sending the operator to re-read a feature
  description instead of checking the account. The two conditions want opposite
  responses: `structural-input` means *change the input*; this means *fix the
  host and re-run it unchanged*.
  A dispatch that produced **zero bytes** now classifies as `host-silent` and
  halts with `halt_action: "host-silent"`, naming quota, credentials and
  connectivity. `runHeadless` counts output bytes for this, unconditionally.
  *Honest scope note:* only total silence, and only on a clean exit. A dispatch
  that emitted anything and still wrote no gate *did* evaluate the input and
  stays `structural-input`; crashes and timeouts keep retrying as before. An
  adapter that reports no `outputBytes` — an in-process stub, a test double —
  leaves it `undefined`, and undefined is treated as unknown rather than
  silence, so nothing is reclassified on missing data. Silence must be
  unanimous across a stage's workstreams: one host speaking means the turn ran.
  Not addressed here: issue #490 also notes that a silent dispatch still emits a
  `NO_GATE` routing observation into the corpus D5 reads. Whether that row
  belongs in routing evidence is a separate call.
