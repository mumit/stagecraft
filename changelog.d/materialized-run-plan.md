### Added

- **`devteam run` now materializes `pipeline/run-plan.json` before any model dispatch.** The versioned plan records track provenance, the ordered preflight stage-disposition snapshot and skip reasons, candidate role/host/model routes, track-aware workstream counts, ceremony estimates, and a SHA-256 execution fingerprint. `--resume` reuses the original plan only when stable track/config/routing controls still match; changed configuration now fails with `ERUNPLANDRIFT` instead of silently changing an in-progress run. Dynamic right-sizing and conditional decisions are marked for runtime reevaluation. Terminal preflight output links the plan and shows its fingerprint.

### Changed

- **Ordinary feature assessment now defaults to the four-slot `loop` track instead of the 18-slot `full` track.** Specialized hotfix, dependency, config-only, nano, and quick signals retain precedence; explicit `--track`, track records, custom stages, and the factory `default_track` fallback for description-less runs are unchanged. Security-triggered code work on `loop`, `nano`, or `quick` now promotes to `full`, because none of those tracks includes security-review. See ADR-018.
