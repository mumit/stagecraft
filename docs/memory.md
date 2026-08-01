# Persistent project memory

Stagecraft indexes the artifacts a pipeline produces — briefs, design specs, ADRs, retrospectives, lessons-learned — into a per-project semantic memory. Once indexed, queries against that memory return ranked past sections by similarity.

This is the **D7** item from the BACKLOG (per-project memory). Cross-project sharing landed in **D3 + G8** — see "Org-shared memory" below.

- [Quick start](#quick-start)
- [What it does](#what-it-does)
- [Storage layout](#storage-layout)
- [Privacy](#privacy)
- [Embedder](#embedder)
- [Chunking](#chunking)
- [Performance](#performance)
- [When to ingest](#when-to-ingest)
- [Prompt injection (30.4)](#prompt-injection-304)
- [What's NOT in memory](#whats-not-in-memory)
- [Troubleshooting](#troubleshooting)
- [Org-shared memory (D3 + G8)](#org-shared-memory-d3--g8)
- [Reference](#reference)

## Quick start

```bash
# After running a pipeline, index everything it produced:
devteam memory ingest

# Ask the memory things:
devteam memory query "user notification opt-in flows"
devteam memory query "schema migration safety" --kind design-spec
devteam memory query "lessons we learned about Twilio" --limit 10

# Check what's indexed:
devteam memory stats

# Wipe the store:
devteam memory clear
```

The first `ingest` downloads the embedding model (~33MB for BGE-small) into `~/.cache/huggingface/`. Subsequent runs use the cached copy. The model runs fully offline.

## What it does

For each pipeline artifact under `pipeline/` — `brief.md`, `design-spec.md`, `clarification-log.md`, `runbook.md`, `test-report.md`, `retrospective.md`, `lessons-learned.md`, accessibility/observability/security reports, and any ADRs under `pipeline/adr/` — Stagecraft:

1. Splits the markdown by level-2 heading (so each section becomes its own retrieval target).
2. Embeds each chunk with the configured embedder.
3. Stores the chunk + embedding + metadata in `.devteam/memory/chunks-<kind>.json`.

When you query, your query text is embedded and ranked by cosine similarity against everything in the store. Top-K results come back with the source path, parent document title, the specific section heading, the chunk text, and a similarity score.

## Storage layout

```
.devteam/memory/
├── meta.json                       # { schemaVersion, embedder: { modelId, dim } }
├── chunks-brief.json               # one file per artifact "kind"
├── chunks-design-spec.json
├── chunks-adr.json
├── chunks-retrospective.json
└── chunks-lessons-learned.json
```

JSON files are git-friendly by design. Most teams will gitignore `.devteam/memory/` because it can contain sensitive snippets from briefs and designs. If you want to commit a curated subset to share across the team, the file format supports that.

## Privacy

The store contains plaintext copies of every chunk it embeds, including whatever was in the brief, design spec, and similar artifacts. Treat it like a backup:

- **Add `.devteam/memory/` to your project's `.gitignore`** unless you have a deliberate sharing strategy.
- **Opt out per-artifact** by including the marker `stagecraft-no-memory` anywhere in the file (a comment line works). Stagecraft will skip that artifact at ingest time.
- **No cross-project leakage by default.** The per-project store is strictly per-project. Cross-project sharing (D3 + G8) is **explicit**: you must run `devteam memory promote` to copy this project's records to the org-shared store. Nothing flows automatically.

## Embedder

Default is **local**: `Xenova/bge-small-en-v1.5` via `@huggingface/transformers`. Runs on CPU, embeds ~10-50 chunks/sec depending on hardware, no external account or API key required, no data leaves the machine.

The model is downloaded lazily on first use and cached. ~33MB on disk.

### Switching embedders

```bash
export DEVTEAM_EMBEDDING_PROVIDER=openai
export OPENAI_API_KEY=sk-...
devteam memory reindex
```

Today only `local` (default) and `stub` (deterministic vectors for tests) are supported.

### Switching models

```bash
export DEVTEAM_EMBEDDING_MODEL=Xenova/bge-base-en-v1.5  # 110MB, 768-dim, more accurate
devteam memory reindex
```

**Important:** vectors from different models aren't comparable. Always `reindex` after changing the model or provider. Stagecraft records the embedder used in `meta.json` and warns at query time if the current embedder doesn't match.

## Chunking

Splits at level-2 (`##`) markdown headings. Each chunk carries:
- Its heading (e.g. `"9. Observability requirements"`).
- The parent document's title (from the level-1 `#` line).
- The source path (e.g. `pipeline/brief.md`).
- The artifact "kind" (e.g. `brief`, `design-spec`, `adr`).

Chunks under 32 chars are dropped (typically just empty sections). Documents with no headings get a single `(preamble)` chunk.

## Performance

For the realistic scale of a single project (10–100 artifacts, 100–1000 chunks), the in-memory cosine search runs in single-digit milliseconds. Local embedding adds 50–200ms per chunk on a modern CPU. A 12-chunk brief ingests in 1–3 seconds.

The JSON backend's ceiling is roughly 1k chunks per project before query latency becomes noticeable.

## When to ingest

Two trigger points:

1. **Manual** — `devteam memory ingest` after any artifact-producing stage finishes. Safe to run repeatedly: re-ingesting an artifact replaces its old chunks (no duplicates).
2. **Automatic, at pipeline-complete** (phase-30 item 30.4) — `core/driver.js` re-ingests once a run finishes cleanly, so the store stays current without a manual step. Gated on `.devteam/memory/` already existing (i.e. you've run `devteam memory ingest` at least once) and `memory.inject` not being `false` — a project that has never opted in sees no behavior change: no embedder load, no model download attempt. Fire-and-forget: an ingest failure (including the optional `@huggingface/transformers` dependency being absent) is logged to `run-log.jsonl` and never fails the run.

Manual `devteam memory ingest` remains the only way to *start* using memory in a project — auto-ingest only keeps an already-opted-in store current.

## Prompt injection (30.4)

Once `.devteam/memory/` exists and `memory.inject` isn't `false` (both true by default once you've ingested), every **headless** stage dispatch (`devteam run`, `devteam stage --headless`) queries the store for the top `memory.inject_top_k` (default 3) chunks similar to the stage's feature/brief text, above `memory.inject_similarity_floor` (default `0` — any positive cosine alignment), and renders them into a bounded (≤1,200 bytes) `## Prior Project Knowledge` section with kind + source attribution per entry — same budget discipline as `Known Project Patterns` (`core/patterns.js` `selectForDescriptor()`).

Stage 2 (design) additionally queries the **org-shared** store for `kind: adr`, making the Principal's `devteam architecture lookup` step automatic instead of a role-brief suggestion (`roles/principal.md` still documents the manual queries — for deeper investigation, or when injection is off/no store exists).

**Honest scope note:** retrieval only runs on the headless dispatch path. Interactive preview commands (`devteam stage` without `--headless`, `devteam reproduce`, `devteam replay`) render prompts synchronously and do not query memory — embedding is inherently async, and `buildDescriptor()`/`runStage()` (`core/orchestrator.js`) have dozens of existing synchronous call sites across tests and CLI commands that assume a plain return value. See `core/memory/inject.js`'s module header for the full reasoning.

## What's NOT in memory

Deliberately excluded:

- **Source code.** Different problem space; symbol search (grep, ctags, language servers) beats semantic for code lookup.
- **Gate JSON files.** Too structured and short to benefit from embedding.
- **Configs.** Same.
- **Artifacts marked `stagecraft-no-memory`.** Opt-out per file.

## Troubleshooting

**"@huggingface/transformers not installed."** Run `npm install` in the Stagecraft framework directory. If you're getting this error on a CI runner or a constrained environment, set `DEVTEAM_EMBEDDING_PROVIDER=stub` to bypass the local model (stub vectors are useless for real retrieval but unblock tests).

**Slow first ingest.** The first call downloads the embedding model. Subsequent runs use the cache. If you keep hitting the download, check that `~/.cache/huggingface/` is writable.

**"store was indexed with X but the current embedder is Y."** Your embedder changed. Run `devteam memory reindex` to re-embed with the new model. Vectors from different models aren't comparable.

**Memory takes too much disk.** Each chunk's embedding is ~1.5KB (384 floats × 4 bytes + JSON overhead). A project with 1000 chunks is ~1.5MB. Run `devteam memory clear` after particularly large runs to reclaim space.

## Org-shared memory (D3 + G8)

The per-project store is strictly per-project. The **org-shared store** (rooted at `~/.stagecraft/memory/` by default, overridable via `STAGECRAFT_ORG_MEMORY_DIR`) holds artifacts explicitly promoted from individual projects. Architectural decisions and durable lessons benefit from cross-project visibility; briefs, designs, and retros stay per-project unless you opt in.

### Promotion

Promotion is explicit. Nothing flows automatically.

```bash
# In each project, after running the pipeline:
devteam memory ingest                     # index per-project as usual

# Then promote ADRs + lessons to the org pool:
devteam memory promote                    # default: adr + lessons-learned
devteam memory promote adr                # ADRs only
devteam memory promote adr lessons-learned design-spec  # custom set
```

The promote step copies records (with embeddings) from the project store to the org store, tagged with `project_cwd` so query results name their origin. Re-running `promote` is idempotent: it overwrites without duplicating.

### Querying org memory

```bash
devteam memory query --org "schema migration safety"
devteam memory query --org "pagination" --kind adr
devteam memory stats --org

# Or use the architecture-flavored alias (G8):
devteam architecture lookup "pagination"
devteam architecture lookup "auth" --kind lessons-learned
```

`devteam architecture lookup` is a wrapper around `devteam memory query --org --kind adr`. It defaults to ADRs. As of phase-30 item 30.4, the top org ADR hits for Stage 2's feature/brief text are injected automatically into the design dispatch's prompt (see "Prompt injection" above); the principal role brief still directs designers to run the manual command too, for a deeper or broader query than the top-k injected section covers.

### Architecture continuity (G8)

The Principal's standing rule, from `roles/principal.md`: **before designing**, query org memory for prior ADRs touching the design space. Each result is a binding commitment unless the new design explicitly supersedes it.

Two outcomes:
- **Honor the prior ADR.** Cite it in the new design's "Prior commitments considered" section.
- **Supersede it.** Write a new ADR with a `Supersedes: <prior-id>` field and a rationale (what changed, what was learned). The new ADR carries the same gravity as the original.

The design gate (`pipeline/gates/stage-02.json`) optionally records `adrs_consulted` and `adrs_superseded` arrays as an audit trail. Silent disagreement with a prior ADR is forbidden by the role brief.

### Trust + privacy

Cross-project sharing changes the trust model. Some notes:

- **The org store contains plaintext.** Same as the per-project store: promoted ADRs and lessons sit on disk as readable JSON.
- **Add `~/.stagecraft/memory/` to your dotfiles `.gitignore`** (or whatever protects your home dir). Per-machine isolation is your friend.
- **Multi-tenant.** If you work on multiple clients on the same machine and need their ADRs isolated, override `STAGECRAFT_ORG_MEMORY_DIR` per shell (`~/.stagecraft-client-A/memory/` vs `~/.stagecraft-client-B/memory/`).
- **Embedder consistency.** The org store inherits the first promoter's embedder model. If a project's vectors were produced by a different model, promotion fails with an error pointing at `devteam memory reindex`. Mixed vectors silently degrade retrieval.

### Limitations

- The org store is per-machine by default. Sharing across team members requires syncing `~/.stagecraft/memory/` via a shared network mount, git, or similar mechanism. A first-class team-sync feature is a BACKLOG candidate.
- No automatic promotion. Each promote is a deliberate human action.
- No deletion of org records per-project. `devteam memory clear --org` wipes everything; there is no selective per-project removal.

## Reference

- Source: `core/memory/{index,embed,chunker,store}.js`
- Tests: `tests/memory.test.js` + `tests/architecture-continuity.test.js` (run with `DEVTEAM_EMBEDDING_PROVIDER=stub` for CI speed)
- BACKLOG entries: [D7](BACKLOG.md#d-observability--learning--telemetry-metrics-persistent-learning) (per-project memory), [D3](BACKLOG.md#d-observability--learning--telemetry-metrics-persistent-learning) (org-shared), [G8](BACKLOG.md#g-innovation-betsspeculative-future-oriented) (architecture continuity).
- Related decisions in [ADR](adr/) when they land.
