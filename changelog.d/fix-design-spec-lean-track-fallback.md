### Fixed

- **The same real headless `devteam run --track loop` on codex also cited `pipeline/design-spec.md` as an unconditional blocker** — "no implementation, lint run, or test run is possible against an absent approved design" — even though lean tracks (`quick`, `nano`, `loop`, `config-only`, `dep-update`) never run Stage 2 design, so its absence there is expected, not a defect. Build-role briefs assumed `design-spec.md` always exists with no fallback guidance for lean tracks; codex treated the gap as a hard blocker, claude-code happened to proceed anyway.

  `coding-principles.md` — read by every build role via Standing Rules — now says explicitly: on a track with no `design-spec.md`, treat `pipeline/brief.md`'s acceptance criteria as the authoritative implementation contract, note the fallback as an `## Assumptions` entry, and proceed rather than refuse or escalate. A new contract test (confirmed to fail without the fix) pins the guidance's presence.
