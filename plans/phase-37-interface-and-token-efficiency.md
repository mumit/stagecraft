# Phase 37 — Interface & Token Efficiency

Status: **complete** (2026-08-05). Items 37.1–37.5 shipped in commits
`ba9b7b9`, `96ba341`, `b98100f`, `0bb8d19`, and `c78c6d4`; item 37.6 accepted
ADR-017 in `1f648b6`, followed by wave execution in `6bf6d26`. From
[experience-review-2026-08.md](experience-review-2026-08.md).
Prompts: [prompts/roadmap-2026-prompts.md](prompts/roadmap-2026-prompts.md) §37.

## Why

Phases 28–36 added a great deal of capability and almost no discoverability. Measured on
2026-08-04: **44 command modules, 244 flags, 10 tracks, a 343-line `devteam --help`, no
per-command help at all** (`help run`, `help review`, `help stage`, and `help next` print
byte-identical output), and **103 doc files / 1.4 MB**. Meanwhile every dispatch re-reads
**~22 KB** of framework and role-brief content at full price, because those bytes are named
as paths in the prompt rather than included in it — the measured cacheable prefix across two
dispatches of the same role is **268 bytes, 15% of the prompt**.

**This phase adds no capability.** Every item removes surface, generates something from data
that already exists, or moves bytes to a cheaper position. That constraint is the point: the
project's problem is no longer what it can do.

## Work items

### 37.1 Generated per-command help

[verify-first] Confirm: `devteam help <cmd>` ignores its argument and prints the same
343-line output for every command (diff `help run` against `help review`); and command flag
specs are structured objects carrying `type` and `description` (see the `"budget-usd"` entry
in `core/cli/commands/run.js`).

Implement `devteam help <command>` and `devteam <command> --help` to print **only** that
command's help, generated from the existing flag specs: one-line synopsis, usage line,
then each flag with its type and description. No hand-written per-command prose — if a
description is missing or unhelpful, improve the spec rather than adding a parallel help
document, so there is exactly one source.

Unknown command name prints the command list plus a did-you-mean suggestion (nearest match
by edit distance). `devteam help` with no argument keeps working.

- Acceptance: `devteam help run` and `devteam run --help` print the same command-scoped
  output, under 60 lines, listing all 21 of `run`'s flags with types; output for two
  different commands differs; unknown command suggests a near match; a command whose flag
  spec lacks descriptions fails a test that asserts every flag has one.
- Verify: `npm test`, `CI=true DEVTEAM_HEADLESS_COMMAND=cat npm test`, `npx eslint .`,
  `npm run consistency`.

### 37.2 Inline framework + role brief into the cacheable prompt prefix

The token item. Today the prompt names framework files as paths and the model reads ~22 KB
itself via tool calls, in a fresh session per dispatch — so provider prefix caching can only
cache the 268-byte header and those bytes are paid in full every time.

Include the content of the framework set (`AGENTS.md`, `.devteam/rules/pipeline.md`,
`.devteam/rules/gates-core.md`) and the role brief **inline**, in the stable order 32.1
established, ahead of everything stage-specific. The result must be byte-identical across
every dispatch of the same role within a run, so the whole block is one cacheable prefix.
Place `openai-compat`'s `cache_control` breakpoint immediately after the inlined block
(32.1 already has the mechanism). Keep the existing path list as a short "these are the
files you were given" note so a human reading a transcript can still find them.

Config `prompts.inline_framework` (default **true**) with an escape hatch to the old
path-pointer behaviour, because a host with no prefix caching and a small context window may
prefer it — and because phase 36's external-review mode has a working absolute-path
mechanism (`plans/acp-read-scope.md`) that must keep functioning when inlining is off.

**Expected effects, which the item must measure rather than assume:** the prompt grows from
~1.8 KB to ~22 KB; the cacheable prefix grows from 268 B to roughly the whole framework
block; 4+ sequential file reads per dispatch disappear. Record before/after numbers in the
report. The prompt-budget consistency check fails on >10% growth — re-baseline it
deliberately in this commit and say so; do not suppress the check.

- Acceptance: two dispatches of the same role produce byte-identical prefixes covering the
  full inlined block (assert on the shared-prefix length, not a substring match); a stubbed
  cache-aware endpoint reports `cached_tokens > 0` on the second dispatch; with
  `inline_framework: false` rendering matches today byte-for-byte; external-review mode
  still resolves framework content correctly in both settings;
  `docs/reference/prompt-budget.md` regenerated with the new baseline.

### 37.3 Project-context guard

[verify-first] `core/cli/commands/next.js` has no project-initialisation check —
`devteam next` in `/tmp` prints `▶️ run-stage — requirements (stage-01)` as if a pipeline
were waiting there. Contrast `core/cli/commands/review-pr.js`, which checks for
`.devteam/config.yml` and refuses with an explanation.

Add one shared guard used by the read-only reporting commands — at minimum `next`,
`summary`, `status`, `log`, `validate` — that detects "this directory is not a Stagecraft
project" and prints the same refusal shape `review-pr` already uses: what is missing, and
the command to fix it (`devteam init --host <name>`). Put the check in one place; do not
copy it per command. `--json` callers get a structured error, not a silent zero-state.

Do not guard commands that legitimately run outside a project (`init`, `review`,
`review-pr` with a workspace, `hosts`, `stages`, `help`, `doctor`) — enumerate the split in
a why-comment.

- Acceptance: `devteam next` in a non-project directory exits non-zero with an actionable
  message; the same for `summary`/`status`; `devteam review <path>` from a non-project
  directory still works; `--json` returns a structured error; a test asserts the guarded and
  unguarded command lists so the split cannot drift silently.

### 37.4 Task-grouped top-level help

`devteam --help` is 343 lines because it doubles as the full flag reference. Collapse the
default to **one screen** organised by what the user is trying to do, with one line per
command:

```
Start here      init · doctor · assess
Daily           run · stage · next · commit
Review          review · review-pr · report --findings
Verify          verify · verify-chain · validate · consistency
Learn           patterns · memory · evals · corpus
Audit           evidence · report · log · summary · performance
```

Exact grouping is the implementer's call; the constraint is one screen and every command
appearing exactly once. Full output moves behind `devteam --help --all` (unchanged content,
so nothing is lost) and stays in generated `docs/reference/cli.md`. **No command renames and
no removals** — this is presentation only, so nothing breaks for existing users or scripts.

- Acceptance: default help is ≤ 45 lines; every command module appears exactly once across
  the groups (test enumerates `core/cli/commands/*.js` and asserts coverage, so a new
  command cannot be added without being grouped); `--help --all` still prints the full
  reference; generated CLI reference unchanged.

### 37.5 Documentation front door and archive

103 files and 1.4 MB under `docs/` with a 402-line README. The four reader paths in the
README are a good idea that the volume now defeats.

Do not delete content. Instead: make one obvious front door (a `docs/START-HERE.md` or a
tightened README section) that names the five documents a new user actually needs; move
superseded and historical material under `docs/historical/` (which already exists) with an
index; and add a consistency check that every file under `docs/` is reachable from at least
one index, so sprawl cannot grow silently again.

- Acceptance: the front door names ≤ 5 entry documents; every `docs/**.md` is reachable from
  an index (new consistency check enforces it); no content deleted — moves only, with
  redirects noted in the moved files' place where a doc was linked externally;
  `npm run consistency` green.

### 37.6 Decide ADR-017 (stage waves)

`docs/adr/017-dag-wave-execution.md` has been **Status: Proposed** since 2026-08-02, so
32.2 was never built and `full` still pays 18 sequential slots where the project's own
analysis says ~13 is reachable.

Resolve it either way in one session, and do not implement in the same session as the
decision. If accepting: set the status, record the decision and any scope reduction (for
example, waving only the two already-known-independent groups), and leave implementation to
a follow-up item. If rejecting: set the status to Rejected with the reason, and update
`plans/phase-32-performance-parallelism.md` and
`plans/README.md#what-is-not-delivered-yet` so 32.2 stops appearing as pending work.

- Acceptance: ADR-017 carries a terminal status with a dated rationale; phase-32 and the
  plans index agree with it; if accepted, a follow-up item exists with a concrete scope.

## Out of scope

Any new capability. Command renames or removals (37.4 is presentation only). Rewriting the
role briefs to be shorter — tempting for token cost, but 37.2 makes their size cacheable
and shrinking prompts the model relies on is a quality change disguised as an efficiency
one; measure first, in a later phase, using the 33.x eval harness.

## Success signal

A developer new to Stagecraft can run `devteam --help`, read one screen, run
`devteam run --help` to understand the 21 flags of the command they will actually use, start
a `loop` run on a small change, and pay a cached ~22 KB prefix instead of a fresh one on
every dispatch — and `devteam next` in the wrong directory tells them so instead of
inventing a pipeline.
