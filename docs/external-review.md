# External Review Mode

**Scope: what is and isn't mechanically enforced when reviewing code you don't own.**
Phase 35's `review-only`/`review-pr` tracks let Stagecraft review a repo it never
built, but dispatching still meant installing ~72 files into the subject —
`.devteam/`, `pipeline/`, the host surface, an `AGENTS.md` stub, a managed
`.gitignore` block. Phase 36
([`plans/phase-36-external-review-mode.md`](../plans/phase-36-external-review-mode.md))
adds two zero-install entry points that keep the subject untouched, using a
**review workspace** as the only place state can land instead. This page
describes the two commands, exactly which host makes the read-only guarantee
real, where a review's evidence ends up on disk, and the limits that are true
today rather than aspirational.

## The two entry points

### `devteam review <path>`

```bash
devteam review ~/code/legacy-service --scope src/payments
```

No `init`, no `.devteam/config.yml`, nothing written into `<path>`. This
dispatches the `review-only` track (`security-review` → `red-team` →
`peer-review`, no build) against a fresh **review workspace** instead of the
subject. Implemented in
[`core/cli/commands/review.js`](../core/cli/commands/review.js).

Flags: `--scope <path>` (repeatable, narrows the reviewed subtree),
`--track` (default `review-only`), `--host` (default `acp` — see
[§ Per-host enforcement](#per-host-enforcement) for why), `--workspace
<path>` (override the derived workspace location), `--json`, `--open`
(open the findings report in a browser), `--list` (show existing
workspaces with subject, last-run date, and status instead of running a
review).

On completion, `devteam review` runs the same findings collector/renderer
`devteam report --findings` uses
([`core/report/collect-findings.js`](../core/report/collect-findings.js),
[`core/report/render-findings-html.js`](../core/report/render-findings-html.js))
against the workspace and prints the report path.

### `devteam review-pr <number|url>`

```bash
devteam review-pr https://github.com/some-org/some-repo/pull/123
```

Reviews an inbound PR with **no clone at all** — the diff *is* the subject.
Implemented in
[`core/cli/commands/review-pr.js`](../core/cli/commands/review-pr.js), extending
the phase-35 `review-pr` track. `gh pr view`/`gh pr diff` materialize the PR's
title/body, changed-file list, and unified diff into
`pipeline/review-input/`, then a single scoped `peer-review` dispatch (a
reviewer, plus a critic when `review.mode: adversarial`) runs against that
input. Nothing else runs — no build, no security-review, no red-team.

- Run from an **already-initialised** Stagecraft project (`<cwd>/.devteam/config.yml`
  exists): behavior is byte-identical to phase-35 — materialize and dispatch
  in place, using that project's routed host.
- Run from **anywhere else** (not a Stagecraft project, not the reviewed
  repo): materializes into a review workspace instead
  (`resolveWorkspacePathForIdentity`/`createReviewWorkspace` in
  [`core/review-workspace.js`](../core/review-workspace.js)), keyed on the PR's URL
  rather than a filesystem path. There is no `--host` flag for this command —
  the workspace's `.devteam/config.yml` defaults `routing.default_host` to
  `claude-code`. That default doesn't weaken the guarantee here: with no local
  checkout, `codeRoot` is genuinely absent
  (`ctx.noCodeRoot`, set by `core/cli/commands/review-pr.js` and read by
  `hosts/acp/permissions.js#findWriteViolation`), so every write target is
  already confined to the workspace — the read-only property is structural
  (there is nothing else on disk to write into), not a function of which host
  is dispatched to.

Publishing stays exactly as phase-35 shipped it: local-only by default,
`--post` prints the exact comment body, requires interactive confirmation (or
`--yes` non-interactively), and refuses outright on a partial or incomplete
review (`core/cli/commands/review-pr.js#handlePost`).

## Per-host enforcement

Both commands set `ctx.processCwd` = the subject (`codeRoot`) and `ctx.cwd` =
the review workspace (`stateRoot`), plus `ctx.externalReviewMode = true`
(`core/orchestrator.js#runStage`). **Only the `acp` host turns that split into
a mechanical guarantee.**

| Host | What actually enforces read-only in review mode | File |
|---|---|---|
| `acp` | `evaluateToolCall`'s two-root form: any `edit`/`delete`/`move` resolving inside `codeRoot` is denied before it reaches disk, and `execute` becomes deny-by-default with a read-only allowlist. Checked on **every tool call**, before it runs. | [`hosts/acp/permissions.js`](../hosts/acp/permissions.js) (`findWriteViolation`, `findReviewExecViolation`) |
| `claude-code` | **Nothing.** `devteam review` sets `ctx.processCwd` to the subject, so the spawned `claude` process's cwd *is* the subject (`core/adapters/headless.js`'s `spawn(bin, args, { cwd: ctx.processCwd \|\| ctx.cwd })`) — but claude-code discovers `.claude/settings.local.json` (where its tool-call-time hooks live) by walking up from cwd, and that file was installed into the *workspace*, not the subject. The hook that would normally block the write is never found. This is a known, explicit gap — see the phase-36 plan's "Out of scope" list (`--state-dir` for claude-code). | [`hosts/claude-code/adapter.js`](../hosts/claude-code/adapter.js), [`plans/phase-36-external-review-mode.md`](../plans/phase-36-external-review-mode.md) § Out of scope |
| `codex`, `antigravity`, `omnigent`, `openai-compat` | **Detection, not prevention** — a second, independent post-hoc write-audit snapshots `ctx.processCwd` (the subject) before and after the dispatch, in addition to the pre-existing audit of `ctx.cwd` (the workspace). Any new path in the subject is a violation unconditionally — no `allowedWrites` check, since the subject is read-only outright in review mode — and flips the gate to `FAIL` with a `subject:<path>` blocker. This can only ever detect a write *after* it already landed; unlike `acp`, nothing stops the write from happening. It also inherits the write-audit's existing blind spots: no-ops if the subject isn't a git repository, and can't see a re-edit of a file that was already dirty before the review started. | [`core/adapters/headless.js`](../core/adapters/headless.js) (`auditSubject`/`beforeSubjectSnapshot`), [`hosts/omnigent/adapter.js`](../hosts/omnigent/adapter.js) (same pattern, its own dispatch path), [`core/guards/write-audit.js`](../core/guards/write-audit.js) (`snapshotWritables`, `auditWrites`) |
| `generic` | No headless execution at all — `devteam review --host generic` isn't a meaningful combination. | — |

This is exactly why `devteam review` refuses `--host <anything but acp>`
unless you pass `--allow-unenforced-writes`
(`core/cli/commands/review.js#checkHostHonesty`): the post-hoc detection above
tells you *after the fact* that the subject was mutated (so you can `git
diff`/`git checkout` it back clean), it does not prevent the mutation — only
`acp`'s tool-call-time evaluator does that. `claude-code` still gets nothing
at all, for the structural reason in the row above.

## Workspace layout

Both entry points create (or reuse) a workspace under
`~/.stagecraft/reviews/<slug>/` (`STAGECRAFT_REVIEWS_DIR` overrides the root;
`--workspace <path>` overrides one workspace's location) —
[`core/review-workspace.js`](../core/review-workspace.js). The slug is the
subject's basename plus a short hash of its absolute path
(`devteam review`) or a hash of the PR's URL (`devteam review-pr`'s
no-checkout path), so the same subject always resolves to the same workspace
across runs.

```
~/.stagecraft/reviews/<slug>/
├── subject.json          # what's being reviewed: path, git remote, commit SHA (or PR identity)
├── last-run.json         # last run's status/track/findings-report path (absent until a run completes)
├── .devteam/
│   └── config.yml        # routing.default_host / pipeline.default_track pinned at workspace creation
└── pipeline/
    ├── gates/             # stage-05.json, stage-04b.json, stage-04c.json, ...
    ├── logs/               # per-workstream dispatch transcripts
    ├── code-review/        # by-reviewer.md / by-critic.md (review-pr, or review-only's peer-review)
    └── findings-report.html
```

Plus the ACP (or other host's) role/skill directories from that host's
`capabilities.json` — e.g. `.acp/stagecraft/{roles,skills}/` — installed via
the same `adapter.install()` every `devteam init` uses
(`core/review-workspace.js#createReviewWorkspace`). `.devteam/patterns`,
`corpus`, and `evals` are deliberately not pre-created; every consumer
creates them on first write, same as a freshly-`init`'d project.

`subject.json` records the reviewed commit, not a produced one — review mode
denies every write into `codeRoot`, so there is never a "commit produced by
this run" the way a normal build's attestation expects:

```json
{
  "schema_version": "1.0",
  "subject_path": "/Users/you/code/legacy-service",
  "remote": "git@github.com:some-org/legacy-service.git",
  "commit_sha": "a1b2c3d4e5f6...",
  "recorded_at": "2026-08-04T12:00:00.000Z"
}
```

## Where evidence lands

Everything a review produces lands under the workspace's `pipeline/` —
never in the subject:

- **Gates** — `pipeline/gates/stage-05.json` (peer-review), plus
  `stage-04b.json`/`stage-04c.json` on `review-only` (security-review,
  the mechanical red-team floor). `devteam verify-chain --cwd <workspace>`
  re-verifies the chain exactly as it would for an in-place project.
- **Findings report** — `pipeline/findings-report.html`, the same
  35.4 findings collector/renderer `devteam report --findings` uses, printed
  by both `devteam review` and readable with `--open`.
- **Review body** — `pipeline/code-review/by-*.md`, the reviewer's (and
  critic's) prose; `devteam review-pr --post` publishes this verbatim as the
  PR comment.
- **`subject.json`** — the reviewed commit SHA and remote, per
  [§ Workspace layout](#workspace-layout) above. This is the natural home for
  an auditor's evidence bundle: it names exactly what was reviewed and, by
  construction, never mutates the audited repo. See
  [docs/compliance.md](compliance.md) for how the rest of a run's gate trail
  maps to control families.

**Caveat:** `devteam evidence export --attestation` does not yet read
`subject.json` — a review's evidence bundle isn't wired into the attestation
export path in this phase (`core/review-workspace.js`'s why-comment on
`writeSubjectManifest` notes this explicitly). Until that lands, treat
`subject.json` plus the gate chain as the evidence, verified by
`devteam verify-chain`, rather than an exported attestation.

## Honest limits

- **The `execute` allowlist is real but narrow.** In `acp` review mode, shell
  calls are denied by default; the read-only allowlist is `rg`, `grep`, `ls`,
  `cat`, `find`, `wc`, plus `git log`/`diff`/`show`/`status` — parsed to argv,
  never substring-matched, with any redirection or shell metacharacter denied
  outright before the binary name is even checked
  (`hosts/acp/permissions.js#findReviewExecViolation`). Extend the plain-binary
  set via `hosts.acp.review.exec_allowlist` in `.devteam/config.yml`; there is
  no way to allow a write-capable command in review mode short of that
  extension point, and extending it is on you. If this allowlist makes a real
  review impractical (a linter or type-checker you need isn't on it), that is
  a real limitation of this phase, not a bug to work around by loosening the
  list silently.
- **Only `acp` can back a *prevention* claim.** See
  [§ Per-host enforcement](#per-host-enforcement) — `claude-code` loses its
  normal enforcement outright; `codex`/`antigravity`/`omnigent`/`openai-compat`
  can now *detect* a subject write after it happens (gate → `FAIL`, blocker
  names the path) but cannot stop it, and that detection still no-ops if the
  subject isn't a git repository. `--allow-unenforced-writes` exists
  precisely so a detection-only guarantee is never silently claimed as
  prevention.
- **Reads are not confined to `codeRoot` — by design, and untouched by review
  mode.** `hosts/acp/permissions.js`'s `WRITE_KINDS` is `edit`/`delete`/`move`
  only; `read`-kind ACP tool calls carry no location check at all, in review
  mode or otherwise. This is required for a reviewer to work at all (it has
  to read the subject), but it means "read-only" is a guarantee about
  **mutation**, not about what the reviewing agent can see or exfiltrate. See
  [`plans/acp-read-scope.md`](../plans/acp-read-scope.md) (item 36.0) for the
  spike that confirmed this and the caution note for any future permission
  hardening pass.
- **`devteam review-pr`'s guarantee is structural, not a permission-engine
  feature.** As noted in [§ The two entry points](#the-two-entry-points),
  the no-checkout path never sets `ctx.processCwd`, so `hosts/acp/permissions.js`'s
  two-root evaluator is not even in play unless you separately route to
  `acp` — the guarantee holds because there is no subject directory on disk
  to write into, for any host.

## See also

- [docs/compliance.md](compliance.md) — control-family → pipeline artifact
  mapping; a review workspace's `subject.json` + gate chain is the evidence
  shape an auditor should look for when the "audited" artifact is a review of
  someone else's code rather than a change you shipped.
- [docs/tracks.md](tracks.md) § The `review-only` track, § The `review-pr`
  track — what each track actually dispatches, independent of the zero-install
  workspace machinery this page describes.
- [docs/user-guide.md § Using ACP](user-guide.md#using-acp-agent-client-protocol) —
  the two-root permission model in the context of ACP generally, not just
  review mode.
- [plans/phase-36-external-review-mode.md](../plans/phase-36-external-review-mode.md) —
  the full design rationale, including why ACP's `session/new` cwd parameter
  and call-time permission round-trips are what make this phase possible on
  that host and no other.
