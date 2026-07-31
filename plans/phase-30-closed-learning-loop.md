# Phase 30 — The Closed Learning Loop

Status: **proposed** (from [landscape-review-2026-07.md](landscape-review-2026-07.md) §3.3).
Depends on: Phase 28 (corpus) for 30.3; items 30.1/30.2/30.4/30.5 are independent.
Prompts: [prompts/roadmap-2026-prompts.md](prompts/roadmap-2026-prompts.md) §30.

## Why

"Each use of Stagecraft makes the next use better" is the bet (BACKLOG bets #4, #5), and
the scaffolding exists — but every loop is open. Pattern collection is manual
(`devteam patterns collect` has zero callers outside the CLI); the outcome counters
(`stats.injected`, `recurrence_after_injection`, `noise_reports`) are initialized and
never incremented; memory is never injected into a prompt (two consumers, both CLI
commands); nothing runs at run-end to distill what happened. The research validates the
design: ACE (Reflector/Curator over execution feedback, +10.6% label-free) is precisely
the upgrade path for `Known Project Patterns`, and SKILL.md is the portable container
adopted by every host Stagecraft dispatches to. This phase is mostly plumbing, not new
machinery — close the loops that were already designed.

## Work items

### 30.1 Auto-collect at run end + retirement suppression

[verify-first] Claims: (a) `core/patterns.js` `collect()` is called only from
`core/cli/commands/patterns.js`; (b) retired patterns are not suppressed at collection,
so the same observations can be re-promoted.

Implement: the driver calls `collect()` (fire-and-forget, error-logged, never fails the
run) on `pipeline-complete` and on every halt that wrote ≥1 gate. Collection consults
`retired.json` and drops candidates whose `pattern_key` identity matches a retired
pattern. `devteam patterns collect` stays for manual/backfill use.

- Acceptance: a stubbed run with a FAIL→retry ends with new candidates on disk without
  any manual command; a retired key never reappears as a candidate.
- Verify: `npm test`, `CI=true DEVTEAM_HEADLESS_COMMAND=cat npm test`, `npx eslint .`,
  `npm run consistency`.

### 30.2 Wire the outcome-feedback counters (the design doc's inert half)

[verify-first] Claim: `docs/pattern-learning.md` specifies decay/demotion driven by
`injected` / `recurrence_after_injection` / `noise_reports`, and no code path increments
any of them.

Implement: (a) increment `stats.injected` when `selectForDescriptor()` includes a pattern
in a rendered prompt (orchestrator-side, at dispatch not render-preview); (b) at
collection time, when a gate blocker maps to a `pattern_key` that was injected into that
same stage's dispatch, increment `recurrence_after_injection`; (c) `devteam patterns
review` surfaces both counters and flags patterns whose recurrence ≥ N (default 3) for
demotion; (d) demotion drops a promoted pattern back to candidate (audit-logged), per the
design doc. No automatic retirement — operator action, consistent with "promotion is
explicit."

- Acceptance: injection increments exactly once per dispatch; a seeded
  recurrence scenario flags for demotion; counters survive collect/promote round-trips.

### 30.3 Reflector pass (ACE-lite): learn from successes, not just blockers

New opt-in run-end step (`learning.reflector: true` in config): after `pipeline-complete`,
dispatch one cheap-model headless call (routed like any role — new role brief
`roles/reflector.md`, ~1 page) that reads `run-log.jsonl`, the gates, and the current
promoted-pattern set, and emits *itemized delta proposals* as candidate patterns
(JSON, schema-validated): new candidates (including positive "this worked" tier),
increment/decrement suggestions, and dedup merges. Proposals land in the existing
candidate store — **the Curator is the existing human promote flow**. No prompt text is
auto-modified (respects the parked "whether auto-promotion should exist at all").

- Acceptance: reflector dispatch renders and validates against a new candidates schema;
  malformed reflector output is discarded whole (never partially applied); a run with
  reflector disabled behaves identically to today.

### 30.4 Memory retrieval into stage prompts

[verify-first] Claim: nothing outside `core/cli/commands/{memory,architecture}.js`
requires `core/memory/`, and `buildDescriptor()` has no memory hook.

Implement: when `.devteam/memory/` exists and `memory.inject: true` (default true when
the store exists), `buildDescriptor()` queries top-k (default 3) against the stage's
feature/brief text, filters by similarity floor, and renders a bounded (≤1,200 bytes,
same budget discipline as `renderKnownPatterns`) "## Prior Project Knowledge" section
with kind+source attributions. Design-stage (stage-02) descriptors also query the org
store for ADRs (`--org --kind adr`), making `devteam architecture lookup` automatic
instead of a role-brief suggestion. Auto-ingest at `pipeline-complete`: brief, ADRs,
retro — the 12 hardcoded artifact kinds already defined.

- Acceptance: with a seeded store, rendered prompts contain the section within budget;
  with no store, rendering is byte-identical to today; ingest runs at run-end; the
  embedder-absent case (optional dep not installed) degrades to no-op with one warning.

### 30.5 SKILL.md export of promoted patterns

`devteam patterns export --skill [--out <dir>]` serializes promoted patterns into a
SKILL.md (Agent Skills open standard) — name, description, per-domain sections — so the
same learned knowledge loads natively in Claude Code, Codex, Cursor, and Gemini/Antigravity
outside Stagecraft runs. Round-trip note in the file header ("generated by devteam,
re-export to update"). `devteam init` offers to install the export into the host's
skills directory when patterns exist.

- Acceptance: export produces a spec-conformant SKILL.md; re-export is idempotent;
  secret-scan runs on the output.

## Out of scope

Auto-promotion (still an open design question — the reflector proposes, humans promote),
cross-project pattern sharing (privacy model first), replacing JSON memory store with a
vector DB (the ~1k-chunk ceiling is not the binding constraint yet), H3 recipe factory
(stays evidence-gated; 30.1+28.5 produce its evidence).

## Success signal

Run N+1 is measurably different because of run N with zero manual steps: patterns
collected automatically, injected patterns' recurrence tracked, prior knowledge retrieved
into prompts — and `devteam patterns stats` can show recurrence-after-injection trending
down on a real project.
