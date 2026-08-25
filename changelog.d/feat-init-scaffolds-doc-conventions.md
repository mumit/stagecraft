- **`devteam init`'s `AGENTS.md` stub states documentation conventions.** The
  stub was a fill-in comment and nothing else, so a new project started with no
  stated conventions at all — and `README.md` sits in `backend`'s and
  `platform`'s `allowedWrites`: **permitted, never required.** No stage owns "does
  this project explain how to run it", so a README appeared only when the brief
  happened to ask for one, and nothing re-checked it when a later change added a
  UI or a new entry point.
  The stub now says the project must have a root `README.md` documenting install
  and run, and that a change altering an entry point, command, or user-facing
  surface must update it in the same change. `AGENTS.md` is read by every agent
  before every stage, so the conventions reach every dispatch; they are also
  normative enough for `devteam patterns seed` to read into the reviewed-pattern
  queue as a second, evidence-tracked channel.
  *Honest scope note:* written only when `AGENTS.md` is absent, so an existing
  project's file is never clobbered — existing projects need the two lines added
  by hand. The stub is the project's own subject content, not framework, and the
  block says so: a library inside a monorepo may legitimately have no root
  README, and the lines are marked editable rather than prescribed. This states a
  convention; it does not enforce one — no stage validates that a README exists.
