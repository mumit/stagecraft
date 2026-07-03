# Capacity and Latency Strategy

Stagecraft treats speed as operational evidence, not as permission to reduce
gate quality. Faster routing, remote execution, prompt caching, and persistent
sessions are only acceptable when the same gate contract, write audits, role
boundaries, and first-try quality policy remain intact.

## Latency-Aware Routing

`npm run performance -- --json` and `npm run routing:suggest -- --json` expose
latency fields for each `(role, host)` pair:

- `mean_duration_ms`
- `p50_duration_ms`
- `p95_duration_ms`
- `retry_adjusted_completion_ms`

`retry_adjusted_completion_ms` estimates successful completion time after retry
overhead by multiplying each successful dispatch duration by `retry_number + 1`
before averaging. This is intentionally conservative: a host that often needs a
second attempt should not look fast just because each individual attempt is
short.

Routing recommendations remain quality-first:

- first-try pass rate is the primary decision signal
- cost per pass is the first tiebreaker
- retry-adjusted latency is only a second tiebreaker
- minimum sample and pass-rate delta thresholds still apply

A faster host cannot displace a higher-quality incumbent unless the observed
quality difference satisfies the explicit routing policy.

## Remote Capacity Decisions

Use remote capacity only when the critical path shows local capacity is the
limiting factor. Compare at least these values before moving work away from a
local host:

- `queue_wait_ms` from `devteam performance critical-path`
- provider queue wait or cold-start time
- bundle/upload/download time for the project workspace
- credential and secret boundary changes
- cache warmup time and cache invalidation cost
- p50/p95 dispatch duration and retry-adjusted completion time
- first-try pass rate and blocker recall for the same role

Remote execution is a good fit when queue wait or local contention dominates
the critical path and the remote host has equivalent or better quality evidence.
It is a poor fit when upload/download, cold start, or credential isolation costs
are larger than the local queue delay it removes.

## Prompt Caching

Provider prompt caching can help with repeated Stagecraft framework text, but it
must be treated as an optimization layer over immutable prompt packets. Cache
keys should include the stage, role, adapter, Stagecraft version, relevant rule
and role content hashes, and selected project context digests.

Do not use a cache hit as evidence that a role read project state. Agents must
still receive current artifact pointers and changed-file manifests for the run.

## Changed-File Manifests

Stagecraft prompts include a bounded changed-file manifest when Git status is
available. The manifest contains only path, status, byte size, and SHA-256
digest facts; it does not preload file contents. This gives each role a compact
map of the current change surface while preserving on-demand reads for files
that matter to that workstream.

The default manifest cap is measured in
[`docs/reference/prompt-budget.md`](reference/prompt-budget.md). Treat the cap
as part of the prompt budget: increasing it should be justified by better
first-try pass rate, blocker recall, or fewer structural-input failures.

## Persistent Sessions

Mutable shared model sessions are rejected by default across roles and projects.

Do not share one mutable session between:

- different roles in the same stage
- different projects
- feature and repair runs
- Principal rulings and implementation workstreams
- workstreams with different credential scopes

The risk is context bleed: a role can inherit stale assumptions, hidden tool
state, credentials, or another role's unresolved decision. Persistent sessions
may be evaluated only as isolated, role-scoped sessions with explicit reset
semantics, prompt/gate fingerprinting, and evidence that blocker recall and
first-try pass rate do not regress.

## Prompt Slimming Measurement

Prompt slimming is acceptable only when measured against quality:

- before/after prompt bytes by stage and role
- changed-file manifest bytes versus eager changed-file content loading
- first-try pass rate by `(role, host)`
- blocker recall for review and verification stages
- retry-adjusted completion time
- p95 duration
- missing-gate and structural-input rates

Do not remove rules merely because a prompt is large. Move repeated stable text
behind hash-addressed packets or artifact pointers, then verify that gates still
capture the same required evidence.
