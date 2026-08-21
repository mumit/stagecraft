# Evidence Readiness

The `devteam evidence` commands measure operational evidence for the capabilities
intentionally gated in GitHub #142–#145. All processing is offline. They do not enable
a capability, change routing, learn recipes, create grants, terminate stalled
processes, or make network requests.

```bash
devteam evidence status
devteam evidence status --json
devteam evidence status --feature "checkout retry"  # bounded isolation
```

Local status is read-only. Cross-project status reads only bundle files named by the
operator:

```bash
devteam evidence status --bundle project-a.json --bundle project-b.json
devteam evidence status --json --bundle project-a.json --bundle project-b.json
```

## What it reads

The command reads only the selected pipeline root's `run-log.jsonl`, current gate JSON,
and `gates/archive/*.json`. Inputs are bounded by file count, file size, and log-line
size. Symlinks are rejected. Malformed, oversized, unreadable, and truncated inputs are
counted in `quality` instead of crashing the command or silently disappearing.

It does not read source files, prompts, artifacts, host transcripts, Git metadata,
repository remotes, operator identity, or `.devteam/config.yml` values beyond the
isolation mode needed to select the pipeline root.

## What it reports

The JSON output has `schema_version: "1.0"` and contains aggregate sections:

| Section | Meaning |
|---|---|
| `scope` | observed run, completion, and repair-run counts |
| `quality` | missing or degraded source counters, including `dispatches_outside_run` — host dispatches the run log structurally cannot see |
| `routing` | durable dispatch observations, or legacy gate snapshots when no durable history exists, grouped by role, host, and model |
| `recovery` | fix/retry and convergence counts grouped by stage and failure class |
| `resolutions` | hash-bound human-accepted retries grouped by stage, failure class, and gate-schema fingerprint |
| `rulings` | auto-applied ruling counts by grant class |
| `recorded_rulings` | rulings a human made and recorded by hand, kept separate from auto-applied ones |
| `stalls` | observed stalls grouped by stage and stall class |
| `readiness` | local conditions and explicit cross-project limitations for each gated capability |

**Accepting a resolution when a later stage escalated.** `accept-resolution`
takes the newest unaccepted fix/retry by default. A run that retried `stage-04`
successfully and then escalated at `stage-06` leaves the newest slot holding a
retry that never resolved — correctly refused, since the stage must have ended
up passing. Name the stage that did resolve:

```bash
devteam evidence accept-resolution --stage stage-04 --yes
```

The selector chooses which resolution to consider; it never bypasses the
requirement that the stage's current gate is PASS. When the default is refused
and other stages have unaccepted resolutions, the error names them.

**A manual Principal ruling has a typed path.** `--auto-rule` writes an
`auto-ruled` event, so rulings the driver applied under a standing grant are
already durable. A ruling an operator made themselves left no typed trace, and
inferring one from prose in a gate or commit message is not something Stagecraft
will do. Record it explicitly instead:

```bash
devteam evidence record-ruling --class doc-only --yes
```

The record binds to a real observed `judgment-gate` halt — the same safeguard
ADR-012 gives resolution acceptance — so ruling evidence cannot be minted for an
escalation that never happened, and the same escalation cannot be recorded
twice. Only the normalized class is stored; the halt's free-form reason is not.

Recorded rulings stay a **separate population** from auto-applied ones.
ADR-005 asks which grants operators routinely approve: an auto-applied ruling is
evidence a standing grant already exists, while a hand-recorded one is evidence
about what a human chose. Merging them would answer a different question than
the gate poses.

**Dispatches outside a run are excluded explicitly, not silently.**
`devteam stage --headless`, the direct-remediation path, records a run-corpus
entry with no `run_id` and writes no run-log event — so run-log-derived
`durable_dispatch_observations` structurally cannot count it. `quality.dispatches_outside_run`
reports how many such dispatches the corpus holds, so a reviewer weighing a D5
threshold can tell "12 dispatches" from "12 this evidence path can see, plus 3
it cannot". The key is omitted rather than zero-filled when the corpus was not
consulted, keeping "none" distinct from "could not tell", and a bundle exported
before it validates unchanged.

`run_count` counts **logical runs, not invocations.** `run_id` is the invocation
timestamp, and every `devteam run --resume` mints a new one, so a single feature
change driven through two resumes used to appear three times in the denominator
readiness logic divides by. The driver now carries a `logical_run_id` — the
lineage root, preserved across resumes in `run-state.json` — on each `run-start`
event, and the analyzer groups by it. The id itself stays local:
`pipeline/run-log.jsonl` is gitignored operational state, and the exported
surface remains a count. A run log written before this field behaves exactly as
before, one run per `run-start`.

Free-form reasons, blockers, warnings, questions, rulings, paths, timestamps, feature
text, and model output are never copied into the report. Invalid category strings are
collapsed to `other`.

## Reading readiness honestly

Every capability remains `not-ready` until its documented evidence conditions are met
and reviewed by a human. `portfolio_status: "not-assessable"` means the condition needs
multiple independently exported projects; one project cannot satisfy it locally.

Two signals require special care:

- **D5 durable dispatch history.** Runs made after Phase 17 record one allowlisted
  `dispatch-observation` per non-skipped workstream. If those events exist, routing
  aggregates use them exclusively. Older projects still show gate snapshots, but
  those snapshots cannot satisfy the durable-history condition and are never mixed
  with the new events. Historical dispatches are not reconstructed.
- **H3 accepted resolutions.** Stagecraft never infers acceptance from a later PASS.
  After reviewing a successful retry, the operator must explicitly record acceptance.
  Analysis counts it only while the referenced retry remains in the same bounded log
  and its typed fields agree.

The durable event contains only stage, role, host, model, gate status, gate-written and
timeout booleans, and optional non-negative cost/duration values. It excludes blockers,
warnings, reasons, prompts, responses, paths, transcripts, feature text, credentials,
and repository identity. Invalid or secret-shaped categories collapse to `other` when
the event is recorded and are checked again at analysis time.

## Accepting a successful resolution

After a `fix-retry` succeeds and you have reviewed the result, record that decision:

```bash
devteam evidence accept-resolution --yes
devteam evidence accept-resolution --feature "checkout retry" --yes
```

The command selects the latest unaccepted retry, requires that stage's current gate to
be `PASS`, and appends one `resolution-accepted` event. `--yes` is mandatory because
this is the only evidence subcommand that changes the run log. An exclusive lock
prevents concurrent duplicate acceptance. Incomplete, malformed, oversized,
unreadable, or symlinked logs are refused rather than partially trusted.

The event contains only a hash binding to allowlisted retry fields, stage, failure
class, the stage gate-schema fingerprint, and a `derivable` boolean. `derivable` means
the retry used an existing deterministic clear-gate recipe; it does not claim that
Stagecraft learned a new recipe. The hash excludes free-form content and is an internal
binding, not proof against a local actor who can rewrite the whole log. See
[ADR-012](adr/012-explicit-resolution-acceptance.md).

## Collecting real evidence

No special collection mode is required after Phase 17. Run autonomous pipelines
normally, keep the ignored pipeline state, and inspect progress locally:

```bash
devteam run --feature "..." --budget-usd 10
devteam evidence status
devteam evidence status --json
```

For D5, use at least two independent projects and route the same role through at least
two hosts. Each compared `(role, host)` needs five durable observations, and written
gates need cost telemetry. When the local conditions have useful volume, create a new
consented bundle from each project and assess them together. A threshold result still
requires human review and never changes routing automatically.

For H3, use at least two independent projects with at least five autonomous fix/retry
runs each. The same `(stage, failure class, schema fingerprint)` must recur in at least
three accepted observations across both projects, and at least 80% of accepted
resolutions must be derivable. Record acceptance only after inspecting the successful
result. Meeting these conditions opens review of GitHub #142; it does not create or
apply a recipe.

Portfolio status validates each strict v1 schema and payload digest. Exact duplicate
bundles are ignored. Different bundles with the same `project_ref` are rejected rather
than combined. A met threshold means human review is required; it is never an approval.

## Exporting a bundle

Export is a separate, explicit operation:

```bash
devteam evidence export --out ./stagecraft-evidence.json --consent
```

The destination parent must already exist and must not be a symlink. The destination
must be a new file; export never overwrites. `--consent` acknowledges the documented
field set and the stable pseudonymous project reference. There is no stdout export,
upload, automatic discovery, or background collection.

The v1 bundle contains fixed aggregate fields only: versions, a date, project scope,
quality counters, dense routing/recovery/resolution/ruling/stall rows, readiness
conditions, a suppression count, and a canonical payload digest. Rows with fewer than
three observations are omitted. Resolution and durable-dispatch fields are additive
and optional when reading older v1 bundles. The strict schema is
[`core/evidence/schemas/evidence-export.schema.json`](../core/evidence/schemas/evidence-export.schema.json);
unknown properties and secret-shaped category values are rejected.

Inspect the JSON before sharing it. The bundle intentionally permits correlation of
exports from the same project, and unusual host/model combinations may still be
commercially sensitive. Retention, sharing, and deletion of exported files remain the
operator's responsibility.

## Attestation export (per-run, full fidelity)

The aggregate bundle above is a privacy-preserving summary across many runs. Phase-34
item 34.2 adds the opposite shape: a signed, full-fidelity proof for ONE run/commit —
"here is exactly which stages passed, who/what verified each field, and what the
tamper-evident chain looked like at export time." This productizes the existing gate
chain (C6/ADR-011), C4 reproducibility fields, and ADR-012 resolution-acceptance
machinery; it does not anonymize or suppress anything, so treat it as a document to
hand to a specific auditor, not something to publish broadly.

```bash
devteam evidence export --attestation --out ./attestation.json
devteam evidence export --attestation --out ./attestation.json --sign
devteam evidence export --attestation --out ./attestation.json --allow-unverified
devteam evidence verify-attestation ./attestation.json
```

The command runs `verify-chain` first and refuses to attest a broken chain — a break
means an earlier gate changed after being chained, so the "proof" would be worthless.
`--allow-unverified` overrides the refusal for cases like a deliberate earlier-stage
re-run that hasn't been re-stamped yet; the bundle then records `predicate.unverified:
true` and the full `chain_verification` detail rather than hiding the problem.

The bundle is shaped like an [in-toto Statement](https://in-toto.io/) —
`_type`/`subject`/`predicateType`/`predicate` — so tooling that already understands
that envelope recognizes it, but `predicateType` is Stagecraft-namespaced
(`urn:stagecraft:attestation:1.0`; it does not claim a registered SLSA/in-toto
predicate) and `payload_sha256` is a Stagecraft-local tamper check, not a DSSE
envelope. `subject` is the commit(s) this run produced: `auto-commit` run-log events
when `devteam run --auto-commit` made them, plus the current git `HEAD` (the common
manual-commit workflow). Exporting requires a git repository with at least one commit.

`predicate.stages` has one entry per stage gate present for the resolved track, each
with:

- `status` — the gate's PASS/WARN/FAIL/ESCALATE.
- `provenance` — per-field entries distinguishing what the model asserted
  (`model_asserted`) from what the orchestrator actually observed or stamped
  (`orchestrator_value`/`orchestrator_kind`), for `model`, `tokens_in`, `tokens_out`,
  `cost_usd`, and `model_requested`.
- `reproducibility` — the C4 fingerprint (`core/reproducibility.js`): model version,
  temperature, seed, max_tokens, system/tools prompt hashes.
- `prompt_pack_version` — the 33.3 content-hash of the prompt surface, when recorded.
- `chain` — this gate's chain-hash linkage (`prev_stage`/`prev_hash`/`algo`) and
  whether an HMAC is present (`hmac_present`); the raw HMAC value itself is never
  copied into the bundle.
- `authority_resolution` — C6/Phase-2 autonomous-resolution provenance (`--auto-rule`),
  when the gate carries one.

`predicate.resolutions` lists every ADR-012 accepted fix/retry resolution from the run
log as its own entry (stage, failure class, schema fingerprint, `derivable`, the
binding hash) — the same fields `evidence status`'s `resolutions` section aggregates,
here kept per-event instead of grouped.

`--sign` shells to `cosign sign-blob --output-signature <file>.sig <file>` when
`cosign` is on PATH; Stagecraft never bundles or manages signing keys (KMS/Fulcio/OIDC
setup is the operator's). A missing `cosign` or a failing sign step exits non-zero
with the underlying error, but the attestation bundle itself is still written — signing
is a separate, best-effort step layered on a bundle that's already valid without it.

`devteam evidence verify-attestation <bundle>` is a fully offline counterpart: it
re-parses the file, revalidates it against
[`core/evidence/schemas/attestation.schema.json`](../core/evidence/schemas/attestation.schema.json),
and recomputes `payload_sha256` to detect any edit made after export. It never reads
the live pipeline — only the named file.

## Project identity

The first export creates `.devteam/evidence-project-id`, covered by Stagecraft's managed
`.gitignore` block and mode `0600` where supported. It contains 128 random bits; the raw
value is never printed or exported. The exported `project_ref` is a domain-separated
SHA-256 reference.

```bash
devteam evidence identity --json
devteam evidence identity --rotate --yes
devteam evidence identity --delete --yes
```

Rotation makes future exports unlinkable from earlier ones. Deletion prevents reuse but
cannot revoke bundles already shared. Identity status never creates the file.
