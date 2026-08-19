# ADR 021 — Dependency-free memory retrieval by default

**Status:** Accepted
**Date:** 2026-08-19
**Authors:** Stagecraft maintainers

## Context

Stagecraft memory defaulted to a local neural embedder supplied by
`@huggingface/transformers`. The package was declared optional in `package.json`,
but npm installed optional dependencies by default. A builder who never used
memory therefore paid for a large native/transitive dependency tree. In August
2026 that tree also introduced high-severity audit findings and an LGPL libvips
binary into every normal install, causing unrelated pre-review runs to halt.

Removing the package without replacing the default would make the advertised
self-learning path fail on first use. Silently accepting the advisories or
allowlisting the license would hide real supply-chain scope.

## Decision

The default `DEVTEAM_EMBEDDING_PROVIDER` is `builtin`. It uses deterministic,
384-dimensional signed feature hashing over word and adjacent-word features.
It requires no package, model download, native binary, account, network call, or
API spend.

The existing `local` provider remains supported as an explicit quality upgrade.
Operators install `@huggingface/transformers` separately, set
`DEVTEAM_EMBEDDING_PROVIDER=local`, and reindex. This choice makes its current
advisory and license surface visible at the point where the operator opts in.

Stored metadata continues to bind vectors to a model ID. Switching between
`builtin-feature-hash-v1` and a transformer model therefore requires the existing
`devteam memory reindex` flow; incompatible vectors are never mixed silently.

## Consequences

- Project and org memory work out of the box on a clean Stagecraft install.
- Default install size, install latency, audit noise, and native-binary exposure
  decrease materially.
- Builtin retrieval is lexical, not neural semantic search. Conceptual matches
  with no shared terminology can rank worse than the optional transformer.
- The async embedder interface stays unchanged, so headless-only prompt injection
  and the current memory-store contract remain intact.
- Existing stores created with the old default report a model mismatch and need
  one explicit reindex. This is deliberate rather than silently degrading them.

## Alternatives considered

### Keep the transformer as an npm optional dependency

Rejected because npm installs it by default, so “optional” did not bound cost or
risk for normal builders.

### Override vulnerable transitive versions

Rejected because the parent package pinned native runtime versions, no upstream
fix covered the complete tree, and forcing incompatible native versions would
turn an audit repair into an unverified runtime fork. It also would not resolve
the default LGPL policy finding.

### Require users to install the transformer and keep `local` as the default

Rejected because the first memory command would fail on a clean install. A
builder-facing learning feature should have a useful zero-setup baseline.

### Make a hosted embedding API the default

Rejected because it would add credentials, data egress, network availability,
and variable cost to a feature that can provide useful local retrieval without
them.
