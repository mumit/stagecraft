- **A pattern candidate's proposed prevention text names the finding that
  recurred.** The text an agent is injected with, so it stops relearning a rule
  from failed gates, was a per-domain template with the workstream interpolated
  — and the domain is inferred from the stage id, so it could be a poor fit for
  what actually failed. A recurring `no-console` blocker at `stage-04a` inferred
  the `tooling` domain and proposed *"ensure configured lint/test scripts exist
  or the gate records an explicit skip reason"*: true of the stage, and useless
  as guidance for the rule being broken.
  The observation already recorded `detector` — the blocker's own
  `signal`/`code`/`id` — and nothing used it. It now leads the sentence:
  *"Prevent recurring "no-console" findings — before pre-review, …"*.
  *Honest scope note:* only when the detector is specific. `detectorFrom` falls
  back to `slugify(source)` for a blocker carrying no identifier, and quoting
  `"gate-blocker"` or `"reflector"` back at an agent is noise; those candidates
  keep the generic sentence. Deterministic — no model, no schema change, and no
  effect on what an evidence bundle exports. An operator's own
  `devteam patterns promote --text` still wins.
