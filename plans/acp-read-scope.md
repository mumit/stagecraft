# ACP Read-Scope Evidence Review

**Date:** 2026-08-04
**Branch:** spike/acp-read-scope
**Plan item:** 36.0 (phase-36-external-review-mode.md)
**Reviewer:** Claude Sonnet 5 via Stagecraft automated session

---

## Question

Can a stage prompt point an ACP agent at framework files by absolute path outside its
session cwd, or does the agent sandbox reads to that directory? 36.2 renders framework
paths (rules, role briefs, templates) as absolute paths into a separate state directory,
which only works if the agent will actually read them.

---

## Why it matters

Stagecraft declares `clientCapabilities.fs = { readTextFile: false, writeTextFile: false }`
at `initialize` (`hosts/acp/adapter.js:310`), so file access is the agent's own, not a
proxied call back to Stagecraft — Stagecraft cannot see or control *how* the agent reads a
file, only whether it approves the `session/request_permission` round-trip that precedes
tool execution.

---

## Method

### Verify-first (adapter.js, read end to end, 344 lines)

- `initialize` (`hosts/acp/adapter.js:307-312`) sends
  `clientCapabilities: { fs: { readTextFile: false, writeTextFile: false }, terminal: false }`.
  **Confirmed.**
- `session/new` (`:313`) is called with `{ cwd: sessionCwd, mcpServers: [] }`, where
  `sessionCwd = path.resolve(ctx.processCwd || ctx.cwd)` (`:163-165`). **Confirmed** — the
  agent is told a single cwd and given no client-proxied filesystem; any file access is
  the agent's own process reading its own local disk.
- `hosts/acp/permissions.js`: `WRITE_KINDS = new Set(["edit", "delete", "move"])` (`:36`).
  `findWriteViolation` only inspects tool calls of those three kinds; a `"read"` or
  `"execute"` kind tool call skips the allowed-writes check entirely and only meets the
  two `DANGEROUS_COMMAND_PATTERNS` regexes (`rm -rf`, `git push --force`), neither of which
  matches a plain read. **Confirmed** — Stagecraft's own client-side relay auto-allows
  reads and non-destructive shell commands regardless of location; it exercises no
  location-based judgment on them at all. Whether an out-of-cwd read happens is entirely
  the agent's call.

### Real-agent run

Ran the actual `headlessCommand` from `hosts/acp/capabilities.json`:
`npx -y @agentclientprotocol/claude-agent-acp` (resolved to `0.64.2`), speaking ACP protocol
version 1, model `sonnet` (Claude Sonnet 5) via this environment's configured
`ANTHROPIC_BASE_URL` proxy. Real network, real model, real cost — no stub agent, per the
task's explicit instruction that a stub proves nothing here.

Driver: a ~130-line script that reuses `hosts/acp/jsonrpc.js`'s `AcpClient` unmodified and
performs the exact `initialize` → `session/new` → `session/prompt` sequence
`hosts/acp/adapter.js` performs, with the same `clientCapabilities`. It auto-answers
`session/request_permission` (allow in cases 1–2, deny in case 3) and logs every
notification and request verbatim. Not committed — repo scratch space, deleted after use.

Setup: directory **A** (`session cwd`, trivial git repo with a `README.md`) and directory
**B** (outside A, containing `secret.txt` with a random sentinel string unrelated to any
real content). Prompted the agent, in each case, to read a specific absolute path and echo
its contents verbatim, or state exactly why it couldn't.

---

## Findings

### Case 1 — plain absolute path outside cwd, permission granted

Prompt pointed at `<B>/secret.txt` (no relation to A). The agent invoked its own `Read`
tool (`kind: "read"`, `_meta.claudeCode.toolName: "Read"`) with `locations: [{path: "<B>/secret.txt", line: 1}]`. This
triggered a `session/request_permission` request — options offered were
`reject_once` / `allow_once` / `allow_always`. Once approved (`allow_once`), the tool call
completed and the agent echoed the file's exact contents.

**Read succeeded, unsandboxed, gated by one permission round-trip.**

### Case 2 — B symlinked inside A, permission granted

Same file, now reached via `<A>/linked-dirB/secret.txt` (a symlink inside the session cwd
pointing at B). Behavior was identical: `Read` tool call, `session/request_permission`,
approval, correct content echoed. The one difference: the `allow_always` option's policy
metadata proposed **two** glob rules — one for the symlink path under A and one for B's
resolved real path — showing the agent's own permission engine resolves symlinks and
tracks both forms. No behavioral distinction from Case 1 otherwise.

**Symlinking changes nothing — the read still succeeds, still gated once.**

### Case 3 — denial control (not in the original method, added to validate the round-trip is real)

Same absolute path as Case 1, but the driver answered `session/request_permission` with
`reject_once`. This run the model chose a different tool (`Bash`, `kind: "execute"`,
`cat <path>`) rather than `Read` — tool choice is not deterministic across turns. The tool
call was denied (`status: "failed"`, `rawOutput: "User refused permission to run tool"`),
and the agent's final message honestly reported the refusal by name rather than
fabricating file contents or silently returning nothing.

**Denial is respected, and reported accurately — the round-trip is a real gate, not
theater.**

### Cost

Four dispatches (one smoke test, three above): $0.155 / $0.175 / $0.051 / $0.195 —
≈$0.58 total. All four turns spent the bulk of their tokens on a large cache-write (this
harness's own skill/tool preamble, ~40k tokens, since the real `claude-agent-acp` binary
loaded this account's full Claude Code environment) rather than on anything related to the
read-scope question. Not representative of 36.2's actual dispatch cost, which will carry
Stagecraft's own stage-prompt cache prefix instead — noted here only so the number isn't
mistaken for a production estimate.

---

## Verdict

**RECOMMENDATION: absolute paths.**

The agent's filesystem access (`Read` tool, or shell commands like `cat`) is not sandboxed
to the ACP session cwd, with or without a symlink in between. The only gate is
`session/request_permission`, which Stagecraft's own client-side relay
(`hosts/acp/permissions.js`) already auto-allows for `read`/`execute`-kind calls today —
`WRITE_KINDS` covers only `edit`/`delete`/`move`, and the dangerous-command stoplist
doesn't match a plain read. **36.2 requires no permission-layer change** to make absolute
framework paths work; it can render them as absolute paths into `stateRoot` and expect the
agent to read them, exactly as 36.2's own preferred option assumes.

One honest caveat: this is "it depends" only in the sense that *which* tool the model
reaches for (Read vs. a shell `cat`) is not deterministic — but both paths were observed to
succeed identically once permission is granted, so the recommendation does not hinge on
tool choice. A second caveat for whoever picks up item 4 of the roadmap
(`plans/landscape-review-2026-07.md` §3, "verification depth"): if `WRITE_KINDS` or the
stoplist is ever broadened to cover reads or shell execution generically, that change must
explicitly carve out reads under `stateRoot`/framework paths, or it will silently break
36.2's mechanism without any test in this repo currently guarding against it.

---

*Written by Claude Sonnet 5 for Stagecraft item 36.0. No production code was changed.*
