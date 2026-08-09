# Phase 39 — Evidence & Performance Calibration

Status: **implemented; ready for review in PR #414** (2026-08-08). This phase builds measurement and
calibration tooling; it does not manufacture the real-project evidence required by Phase 41.

## Why

Stagecraft records dispatch usage, queue wait, retry events, critical-path timing, cache
metadata, run outcomes, and accepted resolutions, but the information is split across
commands and mostly interpreted one run at a time. Builders cannot yet answer the questions
that justify changing tracks or routing: where p95 time goes, what one accepted change
costs, whether context caches and knowledge packs help, or whether assessment chose too
much or too little ceremony.

## Dependencies

- Assurance/cost planning (PR #408) and project knowledge packs (PR #409).
- Existing Phase 28 corpus, Phase 32 critical-path reporting, Phase 33 evals, and Phase 37
  run-plan provenance.
- Phase 38 events are consumed when available, but contained execution is not required for
  the reporting core.

## Work items

### 39.1 Canonical performance event dimensions

Define and version privacy-bounded dimensions for queue, invoke, verification,
reconciliation, cache, retry/backoff, and blocker time. Preserve raw local timestamps while
exporting only allowlisted aggregates. Old logs remain readable; unknown event versions are
reported, not guessed.

### 39.2 Cross-run calibration report

Extend `devteam performance` with a report over a project-local corpus and explicit imported
evidence bundles. Report sample size, p50/p95 critical path, time-category breakdown, token
and dollar cost per successful run, and cost per explicitly accepted change. Never present a
percentile without its denominator; estimates and provider-observed cost remain visibly
separate.

### 39.3 Cache and knowledge usefulness

Measure framework/prompt cache hit rate and bounded knowledge-pack usefulness using
derivable counters: pack selected, item cited/used where hosts expose it, gate outcome,
retry, and recurrence. Do not log prompt text, knowledge text, transcripts, source paths
outside the existing privacy model, or model chain-of-thought. Correlation is labelled as
correlation; no automatic content promotion follows from it.

### 39.4 Track and workstream calibration

Add explicit operator feedback for assessed-track and workstream fit (`too-light`, `right`,
`too-heavy`, plus optional bounded reason codes). Report override rate and false-positive /
false-negative proxies by assessed risk class. Runtime workstream activation remains a
separate future decision until the corpus shows repeatable misses.

### 39.5 Live bottleneck timeline

Give `devteam log` / `status --verbose` one shared timeline for queue, invocation,
verification substeps, retry/backoff, reconciliation, and human blockers. The view is derived
from durable events and works after the process exits; it is not a second transient state
store.

### 39.6 Repeatable dogfood suite

Add a documented, scriptable two-project dogfood protocol covering at least quick/loop/full,
one retry, one cache reuse, one knowledge-pack hit, and one contained reconciliation when
Phase 38 is available. Fixtures verify report math; only real project runs count toward
Phase 41 activation thresholds.

## Out of scope

Changing scheduling based on a small benchmark, silently uploading evidence, treating test
fixtures as production evidence, or automatically selecting a cheaper host because an
aggregate looks favorable.

## Acceptance

A builder can locate p50/p95 latency and cost by meaningful phase, see denominators and data
quality, compare assessed ceremony with operator feedback, and run a repeatable dogfood
protocol. The same report states clearly when there is not enough real data to act.
