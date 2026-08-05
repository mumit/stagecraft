### Added

- Add `devteam prototype build <id>` as an explicit host-run step for
  prototype packets. The command runs the packet's `build-prompt.md` through a
  headless host, records the build in `prototype.json`, and keeps output in
  `pipeline/prototypes/<id>/workspace/` by default.
- Add `--apply-to-project` for the deliberate escape hatch where prototype code
  should touch the project root. Prototype builds remain pre-SDLC learning
  records, not gate evidence.
