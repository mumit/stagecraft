### Added

- **Control mapping documentation — phase-34 item 34.3 (`docs/compliance.md`).** A table
  mapping compliance control families (change approval, segregation of duties, testing
  evidence, security review, deployment control, tamper evidence) to the exact pipeline
  artifact and runnable command that produces/verifies it today: `pipeline/gates/stage-07.json`
  + `devteam verify-chain` / `devteam evidence verify-attestation` for change approval; the
  base gate schema's `host` field for per-role dispatch provenance; stamped `stage-04a`/`stage-06`
  gates plus `pipeline/verification-receipts/` for testing evidence; the Phase 31.2 mechanical
  red-team floor on `stage-04c` for security review; `CONSEQUENCE_CEILING`/`--allow-stage`
  ceiling-halt events for deployment control; and ADR-011 chain hashes/HMAC plus the Phase 34.2
  attestation bundle for tamper evidence. Scoped explicitly as "evidence your auditors can map,
  not certified compliance." Linked from `docs/README.md`'s Evaluator section and `README.md`'s
  documentation map.
  - Honest scope note: `stage-04b` (the conditional `security-review` stage, which actually
    carries veto power) is deliberately called out as model-asserted only — it is not in
    `STAMPABLE_STAGES`, so it has no orchestrator-run mechanical check today. Segregation of
    duties is verifiable (per-workstream `host` fields) but not mechanically enforced: an
    operator can still route reviewer and author to the same host without Stagecraft blocking
    the run, except for the adversarial-mode critic, which auto-diverges from the reviewer's
    host when ≥2 hosts are configured (31.3). No code changed; docs only.
