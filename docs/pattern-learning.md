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
  demoted.json           # patterns an operator sent back to candidate (30.2)
  recurrence-checked.json  # internal: (gate file, pattern id) pairs already
                           # counted toward recurrence_after_injection
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

A demoted pattern (`devteam patterns demote <id>`) carries this same shape into
`demoted.json` with `status: "candidate"` and a `demotion_history` array — one entry
per demotion, each `{ demoted_at, demoted_by, reason, counters_at_demotion }` — so a
later `devteam patterns promote <id>` restores the pattern without losing the audit
trail.

`prompt_text` is the only text that coding agents see. It must be operator-reviewed,
short, and written as prevention guidance rather than a command to edit a specific
file.

## Collection

The driver calls collection automatically, fire-and-forget, at the end of every
`devteam run`: on a clean `pipeline-complete`, and on any halt where this run left at
least one gate on disk (a halt before any stage ever dispatched, such as
`--repair`/`--feature` mutual exclusion, has nothing to collect). A collection failure
is logged as a `pattern-collect-failed` run-log event and never affects the run's exit
code. `devteam patterns collect` still exists for manual runs and backfilling older
pipeline directories.

Whichever path triggers it, collection reads local pipeline state and appends
sanitized observations. Inputs include:

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

Collection also consults `retired.json`: a candidate whose `pattern_key` identity (the
same `id` a promoted/retired record carries) matches a retired pattern is dropped
before `pending-review.json` is written, and counted as `suppressed` in the collection
summary. Retirement is a one-way decision — the same observations that got a pattern
retired must not silently re-promote it into the candidate pool on the next collection.

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
devteam patterns collect   # optional — the driver already does this at run end
devteam patterns review
devteam patterns promote <candidate-id>
devteam patterns retire <pattern-id>
devteam patterns demote <pattern-id>
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

## Outcome-Feedback Counters

Every promoted pattern carries `stats.injected`, `stats.recurrence_after_injection`,
and `stats.noise_reports` (see [Promoted Pattern Shape](#promoted-pattern-shape)).
These are wired, not aspirational:

- **`injected`** increments once per real dispatch that included the pattern in a
  rendered prompt — a headless invoke, or the interactive `devteam stage` path where
  the operator is about to paste the prompt into a host. A preview/render-only call
  (`devteam reproduce`, `devteam replay --dry-run`) never increments it, because no
  model ever sees that rendering.
- **`recurrence_after_injection`** increments at collection time: when a blocker in a
  gate maps to a `pattern_key` that was injected into that same stage's dispatch this
  run, the injected prevention text evidently didn't prevent the recurrence. Detection
  is keyed by gate file identity (the live gate, or each archived
  `stage-*.attempt-N.json`), not by observation fingerprint — a recurring blocker has
  the same semantic fingerprint as the observation that got it promoted in the first
  place, so fingerprint-based dedup can't be the recurrence signal. Re-running
  `devteam patterns collect` over an unchanged `gates/` directory never double-counts.
- **`noise_reports`** remains reserved for a future operator-facing "this pattern is
  wrong for us" report; nothing increments it yet.

Evaluation uses deltas since the pattern's latest promotion, not lifetime totals.
The statuses are `untried`, `no-recurrence-observed`, `monitor`, and `quarantined`.
Once recurrence since promotion reaches `patterns.demotion_recurrence_threshold`
in `.devteam/config.yml` (default `3`), selection automatically quarantines the
pattern: it remains promoted in the audit store but stops entering prompts. Nothing
is automatically promoted, demoted, edited, or retired. `devteam patterns demote
<pattern-id>` remains the explicit operator action; after revision, re-promotion
starts a new evaluation window while preserving lifetime counters and the demotion
audit trail. Demotion is reversible; retirement (`devteam patterns retire`) is not.

## Reflector (ACE-lite)

Collection (above) only sees what a gate recorded — a blocker, a warning, a
follow-up. It never sees what the run got *right* on the first try, and it can't
suggest that two promoted patterns are really the same thing, or that a counter looks
wrong given what actually happened. The Reflector (`core/learning/reflector.js`, item
30.3) is a second, optional pass over the same run that closes that gap, following the
ACE pattern (Zhang et al., "Agentic Context Engineering", [arXiv:2510.04618]) of a
Reflector that distills execution feedback into delta proposals for a separate Curator
to accept.

Opt-in only — set `learning.reflector: true` in `.devteam/config.yml`. When enabled, the
driver dispatches one extra headless call after a *clean* `pipeline-complete` (never on
a halt — a halted run's evidence is incomplete). It is routed like any other role
(`routing.roles.reflector`, falling back to `routing.default_host`), so a project can
point it at a cheaper model than the build agents use. The dispatch prompt embeds this
run's gate summaries, its `run-log.jsonl` events (heartbeats stripped), and the current
promoted-pattern set — the model is not given tool access to go read them live, and it
outputs nothing but JSON matching the `candidates-delta` schema
(`core/gates/schemas/learning/candidates-delta.schema.json`, validated by
`core/learning/validate-candidates-delta.js`):

- `new_candidates` — including `tier: "positive"`, the one tier gate-derived collection
  can never produce (a gate FAIL/blocker is the only thing collection reads). These land
  in the exact same observations store gate-derived candidates come from
  (`patterns.ingestReflectorCandidates`), tagged `source: "reflector"`, and go through
  the same fingerprint dedup — a reflector-sourced observation can reinforce an existing
  candidate's `pattern_key` instead of always minting a new one.
- `counter_adjustments` and `dedup_merges` — advisory suggestions about existing promoted
  patterns' `stats` or near-duplicate `prompt_text`. These are **not applied
  automatically**; they're logged in full as a `reflector-proposal` run-log event for an
  operator to act on (or ignore) through the existing `devteam patterns
  demote`/`promote` flow.

Malformed output — invalid JSON, or JSON that fails schema validation — is discarded
*whole*. Nothing partial is ever ingested; exactly one `reflector-output-malformed`
run-log event is written and the run is otherwise unaffected. Any dispatch failure (no
adapter, no `headlessCommand`, non-zero exit, timeout) is the same fire-and-forget
contract collection already has: logged once as `reflector-dispatch-failed`, never fails
the run.

The Curator — the human running `devteam patterns promote` — is unchanged by any of
this. The Reflector proposes; nothing here promotes automatically (see [Open
Decisions](#open-decisions)).

## Prompt Injection

At dispatch time, Stagecraft selects relevant, non-quarantined promoted patterns
and adds them to the bounded [Project Knowledge Pack](project-knowledge.md) before
the adapter renders the host prompt.

```text
devteam run
  → buildDescriptor(...)
  → load promoted patterns
  → exclude outcome-quarantined guidance
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
## Project Knowledge Pack

### Reviewed patterns and outcome evidence

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

### SKILL.md export (30.5)

`devteam patterns export --skill [--out <dir>]` serializes every currently-promoted
pattern (`prompt_text`, `tier`, `domain`, and a short evidence-based rationale — never
raw observations) into a `SKILL.md` file following the [Agent Skills open
standard](https://agentskills.io/specification) (originally published by Anthropic,
adopted across Claude Code, Codex, Cursor, and Gemini/Antigravity). The frontmatter's
`name` field must exactly match its parent directory's name, so `--out` is treated as a
*parent* directory: the skill always lands at `<out>/learned-patterns/SKILL.md`
(`<cwd>/.devteam/learned-patterns/SKILL.md` by default), never at `--out` itself. The
generated file opens with `<!-- Generated by devteam patterns export; regenerate to
update; do not hand-edit. -->` and groups patterns into one Markdown section per
`domain`. Re-running the export with an unchanged `promoted.json` produces a
byte-identical file (no timestamps are embedded).

The rendered file is re-scanned with the same secret-scan path `devteam patterns
promote` uses before anything is written — defense in depth against a hand-edited
`promoted.json`, since `prompt_text` is otherwise only scanned once, at promotion time.

Exporting does not install anything: copy (or symlink) the generated directory into a
host's own skills directory yourself, e.g. `cp -r .devteam/learned-patterns
.claude/skills/learned-patterns` for Claude Code. `devteam init` prints this tip in its
summary output — never auto-installs it — whenever promoted patterns already exist and
at least one host being initialized declares a `skillsDir` in its adapter capabilities
(`claude-code` → `.claude/skills`, `codex` → `.codex/skills`, and so on per
`hosts/*/capabilities.json`).

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
4. Budgeted reviewed-pattern injection through the Project Knowledge Pack.
5. Privacy checks for sanitized observations and secret-shaped promoted text.
6. Tests for idempotent collection, promotion gating, injection relevance, prompt
   rendering, retired-pattern suppression, archived retry collection, and secret-shaped
   text rejection.

Phase 30.2 closed the outcome-feedback half of the design: `stats.injected` and
`stats.recurrence_after_injection` are now wired end to end (see
[Outcome-Feedback Counters](#outcome-feedback-counters)), and `devteam patterns demote`
gives operators a reversible response to a pattern that keeps recurring after
injection. `stats.noise_reports` remains unwired — no command produces one yet.

Phase 30.3 added the opt-in Reflector pass (see [Reflector
(ACE-lite)](#reflector-ace-lite)): an extra run-end dispatch that proposes candidates
gate-derived collection structurally cannot — most notably `tier: "positive"` — plus
advisory counter/dedup suggestions an operator can act on. Off by default; promotion is
unchanged.

Phase 30.5 added [SKILL.md export](#skillmd-export-305): `devteam patterns export
--skill` serializes promoted patterns into the Agent Skills open standard so the same
learned knowledge loads natively in any skills-compatible host, outside a devteam run.
`devteam init` mentions the export path in its summary when patterns exist and an
initialized host declares a skills directory; nothing is auto-installed.

## Open Decisions

- Whether auto-promotion should exist at all, or remain permanently human-reviewed.
  Outcome quarantine changes prompt eligibility only; `devteam patterns demote <id>`
  remains the only action that changes a promoted record's status.
- Whether imported promoted patterns should default to disabled until locally reviewed.
- How much local raw example text is acceptable in `pending-review.json`.
- Whether pattern matching should start rule-based only or use the existing memory
  embeddings as an optional scorer.
- Which first deterministic gate should be used to prove the graduation path.
- Whether a noise-report command should exist, and if so what an operator-facing
  "this pattern is wrong for us" report should look like.
