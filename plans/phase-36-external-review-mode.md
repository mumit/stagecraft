# Phase 36 — External Review Mode (ACP-first)

Status: **in progress** (2026-08-04). Follows [phase-35](phase-35-existing-codebase-mode.md),
which made brownfield review possible but still required installing Stagecraft into the
repo being reviewed.
Prompts: [prompts/roadmap-2026-prompts.md](prompts/roadmap-2026-prompts.md) §36.

| Item | Status |
|---|---|
| 36.0 spike: does a real ACP agent read outside its session cwd? | ✅ complete — see [`plans/acp-read-scope.md`](acp-read-scope.md) |
| 36.1 two-root permission model + real read-only mode | ✅ complete — `hosts/acp/permissions.js#evaluateToolCall` (`codeRoot`/`stateRoot`/`mode`) |
| 36.2 framework-path resolution when roots differ | ✅ complete — `core/adapters/render-helpers.js#resolveFrameworkPath` |
| 36.3 review workspace + orchestrator plumbing | ✅ complete — `core/review-workspace.js`; `ctx.processCwd`/`ctx.externalReviewMode` threaded through `core/orchestrator.js#runStage`/`core/driver.js#run` |
| 36.4 `devteam review <path>` | ✅ complete — `core/cli/commands/review.js`; host honesty gated by `--allow-unenforced-writes` |
| 36.5 `devteam review-pr` without an initialised project | proposed |
| 36.6 docs: external review guide | proposed |

## Why

Phase 35 shipped the `review-only` and `review-pr` tracks, so Stagecraft can review code
it never built. But reviewing a repo still means **writing ~72 files into it** —
`.devteam/`, `pipeline/`, the host surface, an `AGENTS.md` stub, and a managed
`.gitignore` block. For a vendor's repo, a read-only checkout, a repo you lack write
access to, or a one-off security look, that is a hard stop. `devteam review-pr` refuses
outright on an uninitialised project (`core/cli/commands/review-pr.js:227`).

The fix is smaller than it looks, because **the seam already exists and is already in
production.** `hosts/acp/adapter.js:163-165`:

```js
const processCwd = ctx.processCwd || ctx.cwd;
const sessionCwd = path.resolve(processCwd);
const gatePath = path.join(gatesDir(ctx.cwd, ctx.changeId), `${descriptor.workstreamId}.json`);
```

`ctx.cwd` is where state goes; `ctx.processCwd` is where the agent works and what is sent
as ACP's `session/new` cwd. Prototype mode already uses exactly this split
(`core/cli/commands/prototype.js:321-323` sets `processCwd: workspace`), and
`core/adapters/headless.js:232` plus `hosts/omnigent/adapter.js:468` honour it too.

**ACP is the right host to build this on**, for three reasons that are properties of the
protocol rather than of our code:

1. **`session/new` takes `cwd` as a parameter.** Every other host infers its working
   directory from where the process was launched — claude-code discovers `.claude/agents/`
   and its hooks by walking up from cwd. ACP negotiates it.
2. **Nothing is installed into the subject.** The rendered prompt is delivered over the
   wire in `session/prompt`, not discovered from disk.
3. **Every tool call is a permission round-trip before it executes.** As
   `hosts/acp/permissions.js:5-15` explains, claude-code's tool-call-time enforcement is a
   set of static globs written once at install time, while ACP lets us evaluate the actual
   dispatch's `allowedWrites` on every call. That is what makes a *mechanically enforced*
   read-only review possible — a claim worth putting in an attestation bundle, rather than
   trusting the model not to write.

## Work items

### 36.0 Spike: does a real ACP agent read outside its session cwd? [report-only]

No code. The rest of this phase branches on the answer, so answer it first.

Stagecraft declares `fs: { readTextFile: false, writeTextFile: false }` at initialize
(`hosts/acp/adapter.js:310`), so the agent uses its own filesystem access and may sandbox
reads to the session cwd. Item 36.2 needs to know whether a prompt can point at framework
files by absolute path outside the subject repo.

Run a real agent (`npx -y @agentclientprotocol/claude-agent-acp`, per
`hosts/acp/capabilities.json`) with a session cwd of directory A and a prompt instructing
it to read a file in unrelated directory B. Report: does it read it, refuse, ask
permission, or silently return nothing? Repeat with B as a symlink inside A.

- Deliverable: a short findings note appended to this file (or `plans/acp-read-scope.md`)
  recording the agent version tested, the exact behaviour, and a recommendation for 36.2:
  **absolute paths** (preferred — free) or **inlined framework content** (fallback —
  costs tokens and interacts with the 32.1 cache-first layout).
- No production code changes. Do not implement 36.2 in the same session.

**Done — see [`plans/acp-read-scope.md`](acp-read-scope.md).** Real agent
(`@agentclientprotocol/claude-agent-acp` 0.64.2), real model, real cost (~$0.58 across four
dispatches). Reads outside session cwd succeed unsandboxed, with or without a symlink,
gated only by one `session/request_permission` round-trip that Stagecraft's own
`hosts/acp/permissions.js` already auto-allows for `read`/`execute`-kind calls today.
**Recommendation: absolute paths** — no permission-layer change needed for 36.2.

**Caution for future permission hardening** (not this phase — see
`plans/landscape-review-2026-07.md` §3 item 4, "verification depth", which has no phase
item yet): 36.0 found that `read`-kind ACP tool calls carry no location check at all today
(`WRITE_KINDS` in `hosts/acp/permissions.js` is `edit`/`delete`/`move` only, and 36.1 below
only tightens `execute`, not `read`). That's *required* for 36.2's absolute-framework-path
mechanism to work — a reviewer/build agent must be able to read outside `codeRoot`. If a
later pass ever adds a location check to `read` calls (e.g. to stop a review agent reading
secrets outside the repo), it must explicitly allow `stateRoot`/framework paths, or it will
silently break 36.2 with no test in this repo currently guarding against that regression.

### 36.1 Two-root permission model with a real read-only mode

[verify-first] Claims to confirm in `hosts/acp/permissions.js`: `evaluateToolCall` takes a
single `cwd`; `relativeToProject` (:61-66) returns `null` for paths outside it and
`findWriteViolation` (:68-80) treats `null` as a violation; `WRITE_KINDS` (:36) is
`{edit, delete, move}` only; and `adapter.js:256` passes `processCwd`.

Give the evaluator two roots and a mode:

- `codeRoot` — the subject being reviewed.
- `stateRoot` — the review workspace, the only place writes are permitted.
- `mode: "normal" | "review"`.

In `review` mode: any write whose location resolves inside `codeRoot` is **denied** with a
reason naming read-only mode; writes under `stateRoot` are checked against
`allowedWrites` relativised to `stateRoot`; paths outside both roots stay denied as today.
In `normal` mode behaviour is byte-identical to today (single root) — keep the existing
call signature working or migrate call sites in the same commit, and do not modify
existing permission tests to pass.

**The `execute` gap must be closed for the read-only claim to be true.** `WRITE_KINDS`
covers `edit`/`delete`/`move`, but a shell call (`kind: "execute"`) can mutate the subject
— `sed -i`, `git checkout`, a build script. Review genuinely needs shell for `rg`/`grep`/
`git log`. So in `review` mode, `execute` becomes **deny-by-default with a read-only
allowlist** (`rg`, `grep`, `git log|diff|show|status`, `ls`, `cat`, `find`, `wc`, plus a
config extension point), argv-parsed rather than substring-matched, and any redirection or
shell metacharacter denied. Anything not on the list is denied with the command quoted.
If this turns out to make real reviews impractical, say so in the report rather than
loosening it silently — an advertised read-only guarantee that leaks writes is worse than
no guarantee.

- Acceptance: a write into `codeRoot` is denied in review mode and allowed in normal mode
  (same descriptor); a write under `stateRoot` matching `allowedWrites` is allowed; `rg`
  is allowed and `sed -i` denied in review mode; `sed -i` still allowed in normal mode;
  existing permission tests pass untouched.
- Verify: `npm test`, `CI=true DEVTEAM_HEADLESS_COMMAND=cat npm test`, `npx eslint .`,
  `npm run consistency`.

### 36.2 Framework-path resolution when state and code roots differ

PRECONDITION: 36.0 complete, with a recommendation on paths vs inlining.

Stage prompts name `AGENTS.md`, `.devteam/rules/*.md`, role briefs and templates as
*relative* paths, and 33.4's verify-first finding confirmed adapters render path pointers
rather than inlined content. Those resolve against the agent's cwd — the subject — where
they do not exist.

Extend phase 35.1's `readFirst` entry form (`{path, optional: true}`) with a root marker:
`{path, root: "framework" | "subject", optional}`. Default `subject` so nothing changes
for in-place runs. Mark rules, role briefs, and templates as `framework`; leave
`AGENTS.md` as `subject` — **the subject's own AGENTS.md is exactly what a reviewer should
read**, and the framework copy is a stub. When `stateRoot !== codeRoot`, framework entries
render as absolute paths into `stateRoot` (or inlined, per 36.0). Single-root runs must
produce byte-identical prompts — add the regression test.

- Acceptance: with differing roots, every framework path in the rendered prompt is
  absolute and resolvable, and no framework path points into the subject; with equal roots
  prompts are byte-identical to today; the 32.1 cache-prefix stability test still passes.

### 36.3 Review workspace + orchestrator plumbing

Create the workspace concept and wire the split through dispatch.

Layout under `~/.stagecraft/reviews/<slug>/` (slug = subject basename + short path hash;
`--workspace <path>` overrides): `.devteam/` (config, patterns, corpus, evals),
`pipeline/` (gates, artifacts, logs), and the ACP role/skill dirs from
`capabilities.json`. Record a `subject.json` naming the subject's absolute path, its git
remote, and the **commit SHA reviewed** — so 34.2's attestation can name what was
reviewed rather than what was produced.

Orchestrator: set `ctx.processCwd = subjectPath` and `ctx.cwd = workspacePath`, following
the prototype-mode precedent. Nothing may be written into the subject — add a test that
snapshots the subject tree before and after a stubbed review run and asserts it is
unchanged, including no `.gitignore` or `AGENTS.md` edits.

- Acceptance: a stubbed `review-only` run against a fixture repo completes with all gates,
  logs, and artifacts under the workspace and a byte-identical subject tree; `subject.json`
  records path, remote, and SHA; `devteam verify-chain --cwd <workspace>` passes.

### 36.4 `devteam review <path>` — the zero-install entry point

The DX this phase exists for:

```bash
devteam review ~/code/legacy-service --scope src/payments
```

No `init`, no config, nothing written to the subject. Flags: `--scope` (repeatable, passed
through to 35.1's scoping), `--track` (default `review-only`), `--host` (default `acp`),
`--workspace`, `--json`, `--open`. On completion, run 35.4's findings report and print its
path.

**Host honesty:** `acp` is the only host that can enforce the read-only guarantee. When
`--host` names anything else, print a clear one-line warning that writes to the subject
are *not* mechanically prevented and enforcement degrades to post-hoc audit, and require
`--i-know` (or equivalent) to proceed. Never imply a guarantee the host cannot keep.

`devteam review --list` shows existing workspaces with subject, date, and last status.

- Acceptance: end-to-end against a fixture repo with a scripted ACP stub agent produces a
  findings report and an untouched subject; non-ACP host warns and refuses without the
  ack flag; `--list` renders; `--json` shape schema-checked.

**Done — see `core/cli/commands/review.js`, `core/review-workspace.js` (extended with
`listWorkspaces()`/`writeLastRun()`/`readLastRun()`), `core/review/schemas/{review,
review-list}.schema.json`, and `tests/review-command.test.js`.** Ack flag:
`--allow-unenforced-writes`, matching the house "allow-&lt;compromised-guarantee&gt;"
convention (`evidence.js`'s `--allow-unverified`) — states what's being given up, not
just that the operator consents.

**Two gaps found while wiring the real (stubbed) ACP dispatch end-to-end, neither fixed
here:**
1. `Produce <artifact>` / `Write to pipeline/gates/<id>.json` (`core/adapters/
   render-helpers.js`) are still *relative* paths. A real ACP agent resolves them against
   its own session cwd, which review mode sets to the subject (36.1's `processCwd`), not
   the workspace — so a real agent following the prompt literally either gets the write
   denied (safe) or must infer the workspace's absolute path from context the prompt
   doesn't give it. 36.2 solved this for *read* targets (`readFirst` entries render
   absolute when roots differ); the write side (artifact + gate paths) needs the same
   treatment. The test's stub sidesteps it via `ACP_STUB_WORKSPACE_ROOT`, told directly by
   the harness — proving the plumbing, not this case.
2. `hosts/acp/adapter.js` never calls `core/hooks/approval-derivation.js#deriveForProject`
   the way `core/adapters/headless.js` does for non-ACP headless hosts. A real ACP-routed
   peer-review dispatch has no automatic path from `pipeline/code-review/by-<role>.md` to a
   derived `stage-05.<role>.json` gate. The test stub writes that gate directly (a script,
   not bound by the "never authored by an agent" contract stage-05's schema describes).

### 36.5 `devteam review-pr` without an initialised project

[verify-first] `core/cli/commands/review-pr.js:227` refuses when
`<cwd>/.devteam/config.yml` is absent.

A PR review needs a diff, not a checkout. Accept a PR number or URL, materialise into the
workspace from 36.3 (not the subject), and drop the initialised-project precondition when
a workspace is in play. No clone at all in the common case: the diff *is* the subject, so
`codeRoot` may be absent — in that case every write target is under `stateRoot` and review
mode is trivially satisfied. Keep 35.2's publishing safety exactly as shipped: `--post`
stays opt-in, confirmation must actually stop the command, and nothing is posted on a
partial review.

- Acceptance: `devteam review-pr <url>` succeeds from a directory that is not a Stagecraft
  project and not the repo, with a scripted `gh` stub; state lands in the workspace;
  publishing safety tests still pass.

### 36.6 Docs: external review guide

`docs/external-review.md`: the two entry points, what is and is not enforced per host, the
workspace layout, where evidence lands, and the honest limits (the `execute` allowlist,
and that non-ACP hosts cannot guarantee read-only). Cross-link from
`docs/compliance.md` — a review workspace is where an auditor's evidence bundle should
live, since it names the reviewed commit and never mutates the audited repo. Update the
README host table to note that `acp` is the recommended host for reviewing code you do
not own.

- Acceptance: `npm run consistency` doc checks pass; every enforcement claim names the
  file that implements it.

## Out of scope

`--state-dir` for claude-code (its `.claude/` discovery is cwd-bound; `processCwd` covers
acp/headless/omnigent and that is enough for this phase); ACP *server* mode (still its own
ADR, per phase 34's out-of-scope list); running builds or `--repair` against an external
subject (review only — a repair needs write access and a branch, which is a different
design); hosting or uploading review workspaces.

## Success signal

```bash
devteam review ~/code/some-vendor-repo
```

…produces an adversarial review plus a mechanical red-team floor, a ranked findings report
with mitigations, and a signed attestation naming the reviewed commit — with `git status`
in the subject repo still clean, and that fact enforced per tool call rather than asserted.
