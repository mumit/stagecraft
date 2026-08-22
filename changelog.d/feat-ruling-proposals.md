- **`devteam chat --refine ruling` puts ADR-003 rulings behind propose/review/apply.**
  `devteam ruling --headless` dispatches the Principal with `allowedWrites:
  ["pipeline/context.md"]`, so the ruling is written straight into the file and
  `devteam fix-escalation` acts on it. A binding ruling authorizes an autonomous
  re-dispatch and its `[class:]` is what an operator may later pre-authorize
  through `--auto-rule` — it was the highest-authority artifact in the escalation
  path and the only one with no review step. A brief edit needed approval; a
  ruling did not.
  The refine turn grounds itself in the escalating gate's `escalation_reason`,
  `decision_needed`, and blockers, and returns a proposal. Inspect, apply, and
  reject are the existing commands unchanged.
  **The model never rewrites `context.md`.** It returns a narrow envelope
  (`{topic, decision, class}`); Stagecraft renders the ADR-003 line and computes
  the appended file itself, so the accumulated escalation history cannot be lost
  to a wholesale replacement. The rendered line must round-trip through
  `core/escalation.js`'s own `parseRulingLine` or the proposal is refused — a
  stored ruling can never read differently to `devteam fix-escalation` than it
  did to the operator who reviewed it. A missing class defaults to
  `unclassified`, which is never auto-applied.
- **A proposal kind can now invalidate nothing.** `affectedGatePaths` returned
  *every* gate for a kind with no `root_stage`, because `stageIndex(null)` is
  `-1` and the `index >= rootIndex` filter then matched everything. Rulings
  invalidate no gates, so "nothing" had to stop meaning "everything".
- **Proposal diffs trim common context.** `unifiedReplacementDiff` emitted every
  old line as removed and every new line as added. That is honest for a
  whole-file replacement and actively misleading for an append — a one-line
  ruling rendered as "the entire file was replaced" defeats the review step it
  exists for. Whole-file rewrites are unchanged; there is a test for both.
