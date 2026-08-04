# Compliance Control Mapping

**Scope: evidence your auditors can map, not certified compliance.** Stagecraft is not
SOC 2 / ISO 27001 / EU CRA certified, and nothing here is a substitute for your own
control framework. This page maps control families auditors commonly ask about to the
concrete pipeline artifact that carries the evidence and the exact command that
re-verifies it today, on the `full` track — the **audited** path (see
[README § Which track?](../README.md#which-track), [`docs/tracks.md`](tracks.md)).
Lighter tracks (`loop`, `nano`, `quick`, `config-only`, `dep-update`) intentionally skip
some of these stages; run `devteam assess --json` to see which stages a given track
includes before relying on a row below.

Every row names a file that exists in a real pipeline run and a command you can run
today. Nothing below is aspirational — where a control isn't mechanically enforced yet,
the row says so instead of implying otherwise.

## The mapping

| Control family | Pipeline artifact | Verify it |
|---|---|---|
| **Change approval** | `pipeline/gates/stage-07.json` (`pm_signoff`, `deploy_requested`, `runbook_referenced` — PM + Platform sign-off, [`core/pipeline/stages.js`](../core/pipeline/stages.js) `sign-off`/stage-07); ADR-012 human acceptance of a fix/retry resolution as a `resolution-accepted` event in `pipeline/run-log.jsonl` | `devteam verify-chain` confirms stage-07 is chain-linked (and HMAC-signed when `DEVTEAM_SIGNING_SECRET` is set, [ADR-011](adr/011-authenticated-gate-chain.md)); `devteam evidence export --attestation --out attestation.json && devteam evidence verify-attestation attestation.json` surfaces every accepted resolution under `predicate.resolutions` ([ADR-012](adr/012-explicit-resolution-acceptance.md)) |
| **Segregation of duties** | The base gate schema's `host` field ([`core/gates/schemas/gate.schema.json`](../core/gates/schemas/gate.schema.json)) on every per-role workstream gate — e.g. `pipeline/gates/stage-04.backend.json`.host (author) vs `pipeline/gates/stage-05.reviewer.json`/`stage-05.critic.json`.host (reviewer/critic) | `jq -r .host pipeline/gates/stage-04.backend.json pipeline/gates/stage-05.reviewer.json pipeline/gates/stage-05.critic.json` — compare which host dispatched build vs. review. Honest caveat: with `review.mode: adversarial` and ≥2 hosts configured, the critic is auto-routed to a different host than the reviewer ([`core/config.js`](../core/config.js) `resolveRoute`, 31.3 collusion counter-measure); red-team-vs-build diversity (`routing.roles.red-team`) is a documented convention, not mechanically enforced — Stagecraft does not block a run where an operator routes reviewer and author to the same host |
| **Testing evidence** | `pipeline/gates/stage-04a.json` (`lint_passed`, `tests_passed`) and `pipeline/gates/stage-06.json` (`tests_passed`, `tests_failed`, `all_acceptance_criteria_met`), both carrying an `_orchestrator_stamped` block once verified; per-command receipts in `pipeline/verification-receipts/<sha256>.json` binding the exact command, exit code, and a workspace content digest ([`core/verify/receipts.js`](../core/verify/receipts.js)) | `devteam verify stage-04a` and `devteam verify stage-06` re-run lint/tests and stamp what was actually observed (never trusting the model's self-reported `tests_passed`); `cat pipeline/verification-receipts/<digest>.json` for the bound command + exit code |
| **Security review** | `pipeline/gates/stage-04c.json` — the mechanical red-team floor (Phase 31.2, [`core/verify/redteam-floor.js`](../core/verify/redteam-floor.js)): orchestrator-run dependency audit, secret-scan, semgrep (if configured), and a lockfile delta, merged into `findings_count`/`severity_breakdown`/`must_address_before_peer_review` by [`core/verify/stamp.js`](../core/verify/stamp.js) `stampStage04c` | `devteam verify stage-04c` runs the mechanical floor and stamps the gate; a mechanical `high`/`critical` finding forces `must_address_before_peer_review` regardless of what the model reported. Honest caveat: `pipeline/gates/stage-04b.json` (the conditional `security-review` stage, fires when `stage-04a.security_review_required` is true, has veto power) is **not** in `STAMPABLE_STAGES` — its `security_approved`/`veto` fields are model-asserted only, with no orchestrator-run mechanical check yet |
| **Deployment control** | `pipeline/run-log.jsonl` `ceiling-halt` events; `pipeline/gates/stage-08.json` (`deploy_completed`, `smoke_tests_passed`, `rollback_executed`) | `devteam run --track full` halts before stage-07/stage-08 (`CONSEQUENCE_CEILING` in [`core/driver.js`](../core/driver.js)) unless re-run with `--allow-stage sign-off --allow-stage deploy`; `grep ceiling-halt pipeline/run-log.jsonl` shows every grant boundary a run crossed |
| **Tamper evidence** | Every gate's `chain.prev_hash` / `chain.mac` fields ([ADR-011](adr/011-authenticated-gate-chain.md)); an exportable in-toto-Statement-shaped bundle from `devteam evidence export --attestation` (Phase 34.2, [`core/evidence/attestation.js`](../core/evidence/attestation.js)) | `devteam verify-chain --require-signed` rejects any unsigned, unstamped, or hash-broken gate; `devteam evidence verify-attestation <bundle>` offline re-checks an exported bundle's internal hashes and refuses a tampered one |

## What this is not

- Not a certification. No control family above has been assessed by a third-party
  auditor; this page tells *you* where to point one.
- Not automatic enforcement everywhere. Several rows above are explicit about which
  half of the control is mechanically checked (orchestrator-observed) and which half
  is still an LLM's self-report (model-asserted) — see
  [`docs/reproducibility.md`](reproducibility.md) for the general model-asserted vs.
  orchestrator-observed distinction this page relies on.
- Not a substitute for reading the ADRs. [ADR-011](adr/011-authenticated-gate-chain.md)
  and [ADR-012](adr/012-explicit-resolution-acceptance.md) document the exact trust
  boundary (e.g. HMAC secret custody, what acceptance evidence deliberately excludes)
  that this table only summarizes.
- No hosted evidence service. Bundles are local files you export and hand to your own
  auditor or evidence store; Stagecraft does not upload, retain, or serve them anywhere.

## See also

- [docs/evidence.md](evidence.md) — the full `devteam evidence` reference (readiness
  status, export, identity, attestation)
- [ADR-011](adr/011-authenticated-gate-chain.md) — authenticated gate chain
- [ADR-012](adr/012-explicit-resolution-acceptance.md) — explicit resolution acceptance
- [docs/tracks.md](tracks.md) — why `full` is the audited path and what the lighter
  tracks skip
