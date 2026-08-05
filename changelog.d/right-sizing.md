### Added

- Added deterministic run right-sizing: active workstream candidates for Stage 01 confirmation, auditable applicability skips, expected workstream counts, and `pipeline.right_sizing: false` opt-out. (The high-confidence-only auto-track selection this originally shipped with is superseded before release by `assess-by-default.md` below — it now runs at any confidence and is audited via `pipeline/track.json`.)
