- **A stoplist refusal now names the artifact whose text matched, and offers to
  archive a stale brief when that brief is the cause**
  ([#489](https://github.com/telus-labs/stagecraft/issues/489)). Stage 0 scans
  the change description, `pipeline/brief.md`, and changed-file paths, but the
  refusal only quoted the matching line — the same sentence reads identically
  whether it came from the change you just described or from a brief left
  behind by a change that finished a week ago, and those want opposite
  responses. Under the shipped default `isolation: in-place` one brief serves
  every change in a repo, so a finished change's prose keeps gating later,
  unrelated work: attune's brief described *removing* a Mem0-to-Graphiti
  migration, and eight days later that word alone pushed an unrelated
  documentation change off `loop` (5 dispatches) onto `full` (22–24), with
  nothing in the output naming the brief as the reason.
  `findStoplistMatches` now carries a `from` label alongside each match and
  `explainMatches` prints it (`matched "migration" in pipeline/brief.md`). When
  — and only when — a brief is responsible, the message adds the remedy that
  fits that cause: `mv pipeline/brief.md pipeline/archive/`. A consequential
  description still gets the plain refusal and `--force`, so the archive hint
  never becomes a reflex for clearing state instead of reading the warning.
  *Scope note:* this changes the diagnosis, not the guard. Scanning the brief
  is deliberate and stays; briefs are not aged out and `NEGATION_RE` is not
  widened to catch "removing the migration". A wrong widen silently disables a
  safety guard, which is a worse failure than a false positive that names its
  own cause.
