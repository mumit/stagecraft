# Pattern Learning

Pattern learning helps agents improve the way a human engineer improves: repeated
review feedback becomes compact, reviewed memory that is visible before the next
implementation starts.

The feature is intentionally distinct from existing memory and evidence features:

- `pipeline/lessons-learned.md` is a retrospective artifact for one run.
- `devteam memory` indexes selected text artifacts for retrieval.
- `devteam evidence` measures readiness without copying free-form content.
- H3 recipe learning, when enabled, would learn deterministic fix recipes after
  explicit accepted resolutions.
- `devteam patterns` learns preventive engineering habits from blockers, warnings,
  archived auto-retry failures, follow-ups, and promoted examples.

The first implementation slice ships project-local collection, explicit promotion,
retirement, stats, and prompt injection. Deeper positive reinforcement automation,
noise reporting, and deterministic-gate graduation recommendations remain follow-up
work in [Phase 27](../plans/phase-27-pattern-learning.md).

## Critical Review

The attractive version of pattern learning is simple: collect mistakes, show them to
future agents, watch quality improve. The dangerous version is also simple: collect too
much, leak sensitive content, inject stale warnings into every prompt, and train agents
to overfit to yesterday's review comments. The design below starts from those failure
modes.

### Edge Cases

| Edge case | Risk | Design response |
|---|---|---|
| One-off warning promoted too early | Agents optimize for a local reviewer preference that may never recur. | Observations are candidates only. Promotion requires explicit operator action or a recurrence threshold plus review. |
| Blocker text contains secrets or customer data | Pattern storage becomes a new leak surface. | Store sanitized summaries, typed categories, hashes, and fingerprints by default. Never export raw blocker text automatically. |
| Prompt bloat | Agents ignore the section or lose important stage instructions. | Inject a small budgeted set: default max 3 blocker-prevention patterns, 2 warning-derived patterns, 1 positive pattern. |
| Cross-project contamination | Lessons from one stack confuse another stack. | Project-local storage is the default. Import/export is explicit and reviewed. Pattern matching must consider language, framework, stage, and workstream. |
| Warning inflation | Every warning becomes a nag. | Use tiers: `blocker`, `warning`, `nudge`, and `positive`. Warnings start as coaching, not rules. |
| Prompt poisoning | A malicious or low-quality gate writes instructions that later get injected. | Only inject promoted patterns. Promotion stores operator-reviewed prevention text, not raw agent prose. |
| Stale lessons | Agents follow advice after the codebase or framework changed. | Track last matched, last reinforced, false-positive count, and retirement state. Retire or demote patterns that stop helping. |
| Mature lesson stays as prompt text forever | Agents keep being reminded about something deterministic checks could enforce. | Repeated high-confidence patterns should graduate into preflight/stamp checks or stage rules. |
| A successful run teaches nothing | The system learns only from pain, not good judgment. | Capture positive observations: patterns present before a first-try PASS, especially when prior similar runs failed. |
| Auto-retry hides the original mistake | The final pipeline succeeds, but the next agent repeats the same initial error. | Auto-retry records pattern observations at failure time and links them to the later retry outcome. |
| Similar failures use different wording | Counts fragment across superficial text differences. | Use typed fingerprints: stage, workstream, domain, failure class, schema fingerprint, detector family, and optional language/framework tags. |
| Similar wording hides different causes | Unrelated issues collapse into one bad pattern. | Promotion review sees examples and can split candidates. Fingerprints include stage and detector family, not text alone. |
| Privacy-safe evidence conflicts with useful local learning | Useful prevention text needs some detail. | Keep rich local data project-scoped and ignored by default; exported bundles remain aggregate and consented. |
| Pattern causes worse behavior | Agents overcorrect or introduce unrelated complexity. | Track injected count, recurrence-after-injection, and operator noise reports; demote or retire on negative signal. |

## Mental Model

Pattern learning should model engineering growth:

```text
Blockers teach correctness.
Warnings teach judgment.
Positive examples teach taste.
Promotion turns feedback into memory.
Repeated memory graduates into deterministic gates.
Decay prevents rigidity.
```

The goal is not to make agents defensive. The goal is to improve their defaults.

## Pattern Tiers

| Tier | Meaning | Default handling |
|---|---|---|
| `blocker` | A defect that failed a gate or forced a retry. | Strong candidate for future prompt injection after review. |
| `warning` | A potential issue or senior-engineering concern that did not block. | Candidate coaching material; promotion requires recurrence or explicit operator approval. |
| `nudge` | Local style, architecture, or project preference. | Inject only when highly relevant and under budget. |
| `positive` | A practice that correlated with a clean first pass or avoided a prior issue. | Reinforce sparingly so the prompt is not only negative feedback. |

## Storage

Project-local storage is the default:

```text
.devteam/patterns/
  observations.jsonl
  promoted.json
  retired.json
  pending-review.json
```

These files should be covered by Stagecraft's managed `.gitignore` block unless a team
deliberately chooses to version them. The stored records are local operational memory,
not gate evidence.

### Observation Shape

Observations are append-only, sanitized records created from gates, run logs, reviews,
auto-retry events, and retrospectives.

```json
{
  "schema_version": "1.0",
  "kind": "pattern-observation",
  "pattern_key": "observability:missing-error-log:backend",
  "tier": "blocker",
  "domain": "observability",
  "stage": "stage-06c",
  "workstream": "backend",
  "failure_class": "code-defect",
  "language": "python",
  "framework": "fastapi",
  "source": "gate-blocker",
  "resolved_by_retry": true,
  "detector": "observability-gate",
  "fingerprint": "sha256:...",
  "created_at": "2026-07-08T00:00:00.000Z"
}
```

Observation records should not contain raw blocker text, full file paths, prompts,
responses, transcripts, credentials, repository remotes, or source snippets. Where a
local operator wants richer examples, they belong in `pending-review.json` and must not
be exported without explicit consent.

### Promoted Pattern Shape

Promoted patterns are human-reviewed and eligible for prompt injection.

```json
{
  "schema_version": "1.0",
  "id": "python-fastapi-structured-error-log",
  "status": "promoted",
  "tier": "blocker",
  "domain": "observability",
  "applies_to": {
    "stages": ["build"],
    "workstreams": ["backend"],
    "languages": ["python"],
    "frameworks": ["fastapi"],
    "feature_hints": ["http", "api", "endpoint"]
  },
  "prompt_text": "For FastAPI services, add a global exception handler or equivalent error path that emits a structured ERROR log event before Stage 06c.",
  "evidence": {
    "observations": 4,
    "last_seen": "2026-07-08",
    "last_reinforced": "2026-07-08"
  },
  "stats": {
    "injected": 0,
    "recurrence_after_injection": 0,
    "noise_reports": 0
  }
}
```

`prompt_text` is the only text that coding agents see. It must be operator-reviewed,
short, and written as prevention guidance rather than a command to edit a specific
file.

## Collection

`devteam patterns collect` reads local pipeline state and appends sanitized
observations. Inputs include:

- failed gate `stage`, `status`, `failure_class`, `workstream`, and typed blocker
  metadata such as `assigned_to`, `signal`, or detector category;
- warning arrays from gates and review artifacts, normalized into warning candidates;
- archived failure gates created during auto-retry, with `run-log.jsonl` used to mark
  whether a matching stage entered `fix-retry`;
- `noted_for_followup[]` items from gates, classified by `track_for`;
- retrospective lessons and positive reinforcement signals in later slices;
- successful first-pass runs where a promoted pattern was injected and the matching
  stage passed in later slices.

Collection should be idempotent by fingerprint. Running it twice after the same run
must not duplicate observations.

## Auto-Retry Semantics

Auto-retry should not erase learning. The first implementation collects archived
failure gates and marks stages that entered `fix-retry` in `run-log.jsonl`:

```text
failure observed
  → failed gate archived by Stagecraft
  → sanitized pattern observation collected from the archive
  → blockers copied to context for the repair agent
  → retry runs
  → retry outcome updates observation stats
```

If the stage entered retry, the observation gains `resolved_by_retry: true`. That is
not the same as promotion. It means the issue is a good candidate because Stagecraft
saw both the mistake and a recovery path.

## Review and Promotion

Patterns should not silently become prompt memory.

```bash
devteam patterns collect
devteam patterns review
devteam patterns promote <candidate-id>
devteam patterns retire <pattern-id>
devteam patterns stats
```

`review` should show candidate groups with:

- tier and domain;
- recurrence count;
- stages/workstreams/languages observed;
- whether auto-retry resolved it;
- false-positive and noise counters;
- proposed prompt text.

Promotion is an explicit operator decision that writes to `promoted.json`. A future
automation may recommend promotion after recurrence thresholds, but it should still
require a review step unless the project has explicitly enabled auto-promotion.

## Prompt Injection

At dispatch time, Stagecraft selects relevant promoted patterns and adds a bounded
section to the descriptor before the adapter renders the host prompt.

```text
devteam run
  → buildDescriptor(...)
  → load promoted patterns
  → score by stage, workstream, language, framework, feature hints, and recent failures
  → inject top budgeted patterns
  → renderStagePrompt(...)
```

Default injection budget:

- up to 3 blocker-prevention patterns;
- up to 2 warning-derived patterns;
- up to 1 positive pattern;
- total section under a conservative byte cap.

Example prompt section:

```markdown
## Known Project Patterns

- If adding or changing a user-visible HTTP endpoint, update README.md,
  docs/reference/*, or changelog.d/* during implementation rather than waiting for
  sign-off.
- For Go HTTP handlers, include invalid input and malformed request tests alongside
  the happy path.
- Positive pattern: table-driven validation tests have prevented repeat QA findings in
  this project.
```

The section must be advisory. Stage instructions, allowed writes, gate requirements,
and stoplist policy remain authoritative.

## Graduation to Gates

Prompt memory is not the endpoint. A pattern should graduate when it is:

- high recurrence;
- low ambiguity;
- cheaply detectable;
- broadly accepted by operators;
- still recurring after prompt injection.

Examples:

- Endpoint docs missing repeatedly → sign-off documentation check.
- Missing lint script repeatedly → pre-review stamp check or package-script discovery.
- Missing structured error logs repeatedly → observability-gate detector.
- Python cache write-audit noise → runtime artifact ignore rule.

Graduation should retire or demote the prompt pattern so agents are not reminded about
issues the orchestrator can enforce deterministically.

## Privacy and Export

Pattern learning should not weaken Stagecraft's evidence boundary.

- Local pattern files may contain project-specific operational memory.
- Export/import is explicit and consented.
- Default export should include only promoted pattern metadata and reviewed prompt text,
  not raw observations.
- Aggregate evidence commands should continue to exclude blocker text, warnings, paths,
  prompts, responses, transcripts, repository identity, and feature text.
- Secret scanning should run on any operator-authored prompt text before promotion or
  export.

## Relationship to H3

H3 recipe learning answers: "Can Stagecraft derive a deterministic fix recipe for a
recurring accepted failure?"

Pattern learning answers: "Can future agents avoid repeating a known mistake or
judgment gap?"

They share evidence sources but have different safety thresholds. Pattern learning may
ship earlier because it is advisory, project-local, and human-promoted. H3 remains gated
because it would create or select executable repair behavior.

## First Slice

1. Project-local storage and schemas for observations and promoted patterns.
2. `devteam patterns collect`, `list`, `review`, `promote`, `retire`, and `stats`.
3. Collection from blockers, warnings, follow-ups, archived retry failures, and
   retry-stage markers.
4. Budgeted `Known Project Patterns` injection into rendered stage prompts.
5. Privacy checks for sanitized observations and secret-shaped promoted text.
6. Tests for idempotent collection, promotion gating, injection relevance, prompt
   rendering, retired-pattern suppression, archived retry collection, and secret-shaped
   text rejection.

## Open Decisions

- Whether auto-promotion should exist at all, or remain permanently human-reviewed.
- Whether imported promoted patterns should default to disabled until locally reviewed.
- How much local raw example text is acceptable in `pending-review.json`.
- Whether pattern matching should start rule-based only or use the existing memory
  embeddings as an optional scorer.
- Which first deterministic gate should be used to prove the graduation path.
