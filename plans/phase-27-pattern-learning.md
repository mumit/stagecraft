# Phase 27 — Pattern Learning

**Status:** First implementation slice in progress.
**Roadmap item:** Observability & learning / engineering-growth memory
([#332](https://github.com/telus-labs/stagecraft/issues/332)).
**Purpose:** help coding agents avoid repeated mistakes by converting reviewed
blockers, warnings, positive examples, and auto-retry outcomes into bounded,
project-local prompt guidance.

---

## 1. Problem

Dogfood runs across the same feature families keep surfacing repeated issues:

- endpoint behavior added before endpoint docs;
- structured observability promised but implemented late or incompletely;
- tests cover happy paths but miss obvious invalid inputs;
- build tooling assumptions such as missing lint scripts;
- implementation passes one gate but carries warnings that a senior engineer would
  avoid next time.

Stagecraft can already retry some failures, record evidence, and write retrospectives.
That is not enough. A successful auto-retry can hide the initial mistake from the next
agent, and a warning can disappear even though it captures exactly the judgment gap the
team wants agents to outgrow.

## 2. Critical Design Review

Pattern learning should not be a free-form memory dump. The reviewed design in
[`docs/pattern-learning.md`](../docs/pattern-learning.md) identifies the main hazards:

- prompt bloat;
- warning inflation;
- stale or overfitted lessons;
- cross-project contamination;
- prompt poisoning from raw gate prose;
- privacy leaks through blocker text, paths, prompts, responses, transcripts, or
  customer data;
- confusing advisory prompt memory with deterministic H3 recipe learning;
- leaving mature, cheaply detectable lessons as reminders instead of graduating them
  into gates.

The phase therefore uses a conservative posture:

- project-local storage by default;
- sanitized observations;
- explicit promotion before prompt injection;
- small injection budgets;
- stats for whether injected patterns actually reduce recurrence;
- retirement and graduation paths.

## 3. Work Items

### 27.1 — Storage, schemas, and managed ignore

- ✅ Create `.devteam/patterns/` in target projects when the first pattern command writes.
- ✅ Store:
  - `observations.jsonl` for sanitized append-only sightings;
  - `pending-review.json` for grouped candidates;
  - `promoted.json` for operator-reviewed prompt guidance;
  - `retired.json` for lessons that aged out or were replaced by deterministic gates.
- ✅ Add schemas for observation and promoted-pattern records.
- ✅ Ensure the managed `.gitignore` block covers `.devteam/patterns/` by default.
- ✅ Reject secret-shaped promoted prompt text.

### 27.2 — Collection from blockers, warnings, and auto-retry

- ✅ Add `devteam patterns collect`.
- ✅ Read the selected pipeline root's gates, archives, and `run-log.jsonl`.
- ✅ Collect blocker observations from failed gates using typed metadata first.
- ✅ Collect warning observations from gate `warnings[]`, reviewer warnings, and
  `noted_for_followup[]`.
- ✅ Collect archived failure gates produced by auto-retry and mark stages seen in
  `fix-retry` events.
- Later slice: record live auto-retry observations before gate clearing and update
  first-pass positive reinforcement.
- ✅ Make collection idempotent by fingerprint.

### 27.3 — Review, promotion, retirement, and stats

- ✅ Add:
  - `devteam patterns list`;
  - `devteam patterns review`;
  - `devteam patterns promote <candidate-id>`;
  - `devteam patterns retire <pattern-id>`;
  - `devteam patterns stats`.
- ✅ Keep promotion explicit. Auto-promotion remains out of scope unless a later ADR
  approves it.
- ✅ Show recurrence count, tier, domain, stage/workstream/language matches, retry
  outcome, false-positive/noise counters, and proposed prompt text during review.

### 27.4 — Prompt injection

- ✅ Add a descriptor field for selected promoted patterns.
- ✅ Select by stage, workstream, language/framework, feature hints, and recent failure
  fingerprints.
- ✅ Inject a `Known Project Patterns` prompt section only when at least one pattern is
  relevant.
- ✅ Default budget:
  - 3 blocker-prevention patterns;
  - 2 warning-derived patterns;
  - 1 positive pattern;
  - one conservative byte cap for the whole section.
- Later slice: increment injected counters after dispatch without making prompt
  rendering mutate local pattern storage.

### 27.5 — Graduation and decay

- Track recurrence-after-injection and noise reports.
- Retire stale patterns after a configurable number of non-reinforced runs.
- Add a report section that recommends deterministic-gate graduation when a pattern is
  frequent, low ambiguity, cheaply detectable, and still recurring after injection.
- Do not implement self-modifying pipeline behavior in this phase.

### 27.6 — Docs and operator runbook

- Add operator docs for the normal workflow:

  ```bash
  devteam run --feature-file prompt.txt --track full
  devteam patterns collect
  devteam patterns review
  devteam patterns promote <candidate-id>
  devteam patterns stats
  ```

- Document privacy boundaries, import/export caution, and relationship to H3.
- Add troubleshooting guidance for noisy patterns, stale patterns, and irrelevant
  injected guidance.

## 4. Acceptance Criteria

1. Collection is idempotent and does not duplicate observations from the same run.
2. Raw blocker text, full paths, prompts, responses, transcripts, repository identity,
   and feature text are not written to `observations.jsonl` by default.
3. Warnings can become candidate patterns but are never injected until promoted.
4. Promoted patterns are selected narrowly and respect injection budgets.
5. Build and QA prompts include relevant patterns only after promotion.
6. Auto-retry records the original failure pattern before clearing gates.
7. Pattern stats report injected count, recurrence-after-injection, and noise count.
8. Retired patterns are not injected.
9. Secret-shaped promoted prompt text is rejected.
10. Tests cover collection, promotion, injection relevance, budget caps, retirement,
    and privacy boundaries.

## 5. Out of Scope

- Fine-tuning model weights.
- Automatic cross-project sharing.
- Automatic promotion without operator review.
- Executable repair recipe creation or selection. That remains H3.
- Self-modifying stages, roles, or rules.
- Exporting raw observation text.

## 6. Relationship to Existing Systems

- **Retrospective:** remains the human-readable narrative of one run. Pattern learning
  extracts structured, reviewed prevention guidance from repeated outcomes.
- **Memory:** may later help score similarity, but the minimum slice is rule-based and
  does not require embeddings.
- **Evidence:** remains aggregate and privacy-safe. Pattern observations are local
  operational memory, not readiness evidence.
- **H3:** remains parked behind accepted-resolution evidence. Pattern learning is
  advisory and preventive; H3 is deterministic and executable.

## 7. Recommended PR Sequence

1. Schemas and local storage helpers.
2. `devteam patterns collect/list/review` with blocker and warning observations.
3. Promotion, retirement, and stats.
4. Prompt descriptor injection for build and QA.
5. Auto-retry observation hooks and positive reinforcement.
6. Graduation recommendations and docs polish.
