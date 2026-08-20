- **Resume-bound safety policy and active-track remediation** (Phase 42.1 / E13).
  `devteam run --resume` now inherits the original token/USD caps, rejects
  conflicting cap or track flags before dispatch, and fingerprints an audited
  `--force` stoplist bypass against the feature, active brief, and stoplist
  policy. Unchanged resumes and direct remediation stages reuse the ruling;
  changed inputs invalidate it. Direct `devteam stage` commands also inherit
  the materialized run-plan track, and their displayed workstream count now
  reflects the actual track-sized dispatch. Legacy run state/plan files migrate
  compatibly on their first post-upgrade resume. *Honest scope note:* this does
  not make other per-run grants such as `--auto-rule` or consequence-ceiling
  approvals durable.
