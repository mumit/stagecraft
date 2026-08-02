# Verification beyond tests

Stage 6d. Runs after QA passes on the `full` track only. The `verifier` role applies three methods to the changed code. A passing test suite is the minimum bar; this stage checks what the tests miss.

Mutation testing also has a second, narrower entry point: an opt-in **mechanical** smoke gate at stage-06 (QA) stamping, on every track. See [Mechanical mutation gate (stage-06)](#mechanical-mutation-gate-stage-06-opt-in) below — it does not replace this stage's model-driven mutation pass, which stays prompt-level and full-track-only.

- [What it does](#what-it-does)
- [Gate fields](#gate-fields)
- [Track inclusion](#track-inclusion)
- [Mechanical mutation gate (stage-06, opt-in)](#mechanical-mutation-gate-stage-06-opt-in)
- [References](#references)

---

## What it does

The verifier reads the changed code and applies up to three formal verification methods:

### Property-based testing

Tools: fast-check (JS/TS), hypothesis (Python), proptest (Rust).

Generates large numbers of random inputs and checks that stated properties (invariants) hold across all of them. Catches entire classes of bugs that example-based tests miss, because the property harness explores inputs the author did not anticipate.

The verifier identifies candidates in the changed code: pure functions with stateable invariants, data transformations, parsers, serializers, algorithms with mathematical properties.

### Mutation testing

Tools: Stryker (JS/TS), mutmut (Python), mull (Rust/C++).

Introduces deliberate bugs ("mutants") into the changed code — flipped comparisons, removed return values, swapped operands — and checks whether the test suite catches each one. A surviving mutant means the test suite has a gap: the bug was silently present and untested.

### Formal verification

Tools: TLA+ (concurrent systems), Alloy (structural properties), Lean (mathematical proofs).

Optional. Used when correctness is non-negotiable: cryptographic operations, consensus algorithms, financial invariants, safety-critical state machines.

---

## Gate fields

| Field | Type | Notes |
|---|---|---|
| `methods_attempted` | string[] | Methods that ran or were attempted |
| `methods_skipped` | `{method, reason}[]` | Methods not run; reason is required |
| `candidates_inventoried` | number | Code paths assessed for verification |
| `property_based` | object | `candidates`, `properties_written`, `counterexamples` |
| `mutation` | object | `mutants_generated`, `mutants_killed`, `mutants_survived`, `score_pct` |
| `formal` | object | `models_written`, `properties_checked`, `counterexamples` |
| `findings_count` | number | Total blocking findings |
| `blocking_findings` | string[] | Items that fail the stage |

**FAIL conditions:**

- A surviving mutant on a critical code path
- A property counterexample to a stated invariant
- A formal counterexample to a safety property

Any of these populates `blocking_findings[]` and gates at FAIL.

**Skipped methods:**

Tooling not installed is recorded as `attempted_but_blocked:<method>` — a WARN, not a FAIL. Unavailability of time is not an accepted skip reason.

---

## Track inclusion

`full` only. The `quick`, `nano`, `hotfix`, `config-only`, `dep-update`, and `loop` tracks rely on stage-06 example tests as their verification ceiling, trading rigour for speed. The `full` track runs this stage in addition to those tests.

---

## Mechanical mutation gate (stage-06, opt-in)

Phase 31.4. This section describes the part of "mutation testing" that is now **mechanical** rather than prompt-level — the orchestrator runs it directly, it does not depend on a model's self-report, and it applies to every track (not just `full`).

Disabled by default. Enable with `pipeline.verify.mutation.enabled: true` in `.devteam/config.yml`. When enabled, `core/verify/stamp.js#stampStage06` (via `core/verify/mutation.js`):

1. Detects a supported runner already present in the project — **Stryker** (JS/TS) via a `@stryker-mutator/core` devDependency, **mutmut** (Python) via the binary already on PATH/venv. Devteam never installs either.
2. Runs it against the changed-file set only (`pipeline/changed-files.txt`, same source as the stage-04c mechanical floor), intersected with `pipeline.verify.mutation.paths` when configured.
3. Time-boxes the run with `pipeline.verify.mutation.timeout_ms` (default 5 minutes), reusing the same kill machinery (`core/process-kill.js`) every other orchestrator-run command uses — a hung mutation run is killed cleanly and recorded as a skip, never a false pass.
4. Parses the score and stamps `mutation_score`, `mutation_runner`, and `mutation_scope` onto the stage-06 gate.

Below `pipeline.verify.mutation.threshold` (default `0.7`) is **advisory**: a gate warning plus a `noted_for_followup` entry (`severity: "high"`) so it surfaces in `devteam advise` classification (routes to `PEER_REVIEW_RISK` — see `core/advise.js#classifyItem`) rather than being silently absorbed. It only becomes a blocking **FAIL** when `pipeline.verify.mutation.threshold_hard: true`.

An absent runner, an empty scope (no changed files fall within `paths`), a timeout, or unparseable tool output are all recorded as an honest skip — the same "absence of a result is never mistaken for a pass" doctrine as the stage-04c dependency audit's offline handling.

This is a **smoke gate**, not a replacement for stage-06d's model-driven pass above: it runs on whatever files changed, on every track, with no judgment about which mutants matter or which are equivalent — that triage is exactly what the `full`-track `verifier` role still does.

---

## References

- Role brief: `roles/verifier.md`
- Skill: `skills/verification-beyond-tests/SKILL.md` — five-phase procedure
- Related: [docs/FEATURES.md](FEATURES.md) § Advanced AI capabilities
