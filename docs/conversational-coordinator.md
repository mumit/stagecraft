# Conversational coordinator

`devteam chat` is the explanation layer for Stagecraft's deterministic state.
It answers questions such as “why is this stage blocked?”, “what did this run
cost?”, and “what is the safest next command?” without gaining authority to run
that command.

## Use it

```bash
devteam chat "What should I do next, and why?"
devteam chat "Can I safely use a lighter track?" --host codex
devteam chat "Summarize the current bounded run" --feature "billing retry"
devteam chat "Show me the exact prompt" --dry-run
devteam chat "What is blocked?" --json
devteam chat                         # interactive TTY
```

Interactive local commands are `/status`, `/context`, `/next`, `/refresh`,
`/help`, and `/quit`. They are parsed by Stagecraft and do not call a model.
Every natural-language message is one new headless host call; observed host,
model, token, cache, and cost fields are printed when the adapter reports them.

By default the coordinator uses the normal route for role `principal`. Override
it for a session with `--host` and `--model`. ACP command routes use the normal
`acp:<agent-command>` form.

## Grounding contract

Stagecraft computes a schema-versioned snapshot locally on every turn:

- selected track, artifact-isolation mode, workstream-isolation mode, routing,
  and right-sizing setting;
- bounded fields from `run-state.json`, including iteration and recorded cost;
- the stage summary's state, workstream state, warnings, and blockers;
- the pure `next()` action plus the narrow command that would apply it.

The snapshot does not contain the project path, raw gate objects, artifact
contents, logs, source code, or arbitrary config. Strings are whitespace-bounded,
length-capped, and removed wholesale when the secret scanner recognizes a
credential shape. The prompt labels all snapshot strings as untrusted data.
Missing evidence stays missing; the model is instructed not to infer it.

Only the last eight user/assistant turns, capped at 2,000 characters each, are
retained in process memory. The prompt includes at most the two most recent
turns at a smaller bound, and drops history plus low-value completed/pending
stage rows when a CLI host's prompt limit requires it. History is not written to
disk. A new `devteam chat` starts fresh.

## Authority and isolation

Chat is advisory. It has no implementation path that dispatches `run`, `stage`,
`merge`, `ruling`, or another state-changing command. When asked to act, it must
return the exact command and expected effect for the operator to approve outside
chat.

The selected adapter runs in a newly created disposable directory. The target
checkout path is not passed in the prompt or context. A minimal adapter launch
config is written there only for HTTP-native, ACP, and Omnigent hosts that
resolve launch settings through the standard config loader. Unrelated project
config is not copied. Secret-shaped launch values and credential-bearing URLs
are refused; the launch config is not included in the model prompt. The directory is removed after success or failure,
and transcript logging is disabled.

Enforcement differs by host:

| Host shape | Mechanical boundary |
|---|---|
| OpenAI-compatible HTTP | Sends an empty tool list and fails the turn if the endpoint still returns a tool call |
| ACP | Declares no client filesystem/terminal capability and rejects every permission request |
| CLI hosts (Claude Code, Codex, Antigravity, Omnigent) | Disposable working directory, no project path in context, empty allowed-writes request, and explicit no-tools prompt |

The CLI-host row is not an OS sandbox. A host process runs with the same user
permissions as `devteam` and could ignore its working directory or prompt. Use a
container or restricted OS account when the host itself is not trusted. Chat's
boundary protects against accidental project coupling; it does not contain a
malicious same-user executable.

## Approval-bound artifact refinement

Requirements and design use a deliberately split proposal/apply workflow. The
conversational turn still has tools disabled and cannot edit the checkout:

```bash
devteam chat "make AC-3 measurable" --refine requirements
devteam chat "make the retry boundary explicit" --refine design
```

The host receives the current artifact plus a bounded stage snapshot and project knowledge
facts, then must return one versioned full-replacement envelope. Stagecraft validates it,
stores a pending proposal under `pipeline/proposals/`, and prints its id. The proposal
contains the base hash, exact diff, and existing gates that would be invalidated. It does
not store the question, transcript, hidden reasoning, arbitrary paths, or commands.

```bash
devteam chat --proposal <id>          # inspect exact diff + gates
devteam chat --proposal <id> --apply  # explicit local mutation
devteam chat --proposal <id> --reject
devteam chat --list-proposals
```

Apply rechecks the artifact hash, proposal expiry, and exact gate set. Concurrent changes
make it stale; Stagecraft never asks the model to rebase. The artifact write and gate
invalidation use a recoverable local transaction. Requirements invalidates stage-01 and
downstream gates; design keeps stage-01 and invalidates stage-02 onward.
Proposal lifecycle counters and provenance are appended to `pipeline/proposals/events.jsonl`;
instructions and transcripts are never written there.

## What it is not

- It is not a replacement for `devteam next --json`; automation should consume
  the deterministic action object, not model prose.
- It is not an arbitrary write-capable agent. Only the fixed requirements/design
  proposal schema above can reach the separate explicit apply operation.
- It is not persistent project memory. Reviewed conventions and outcomes belong
  in the knowledge/pattern/memory systems, not an opaque chat transcript.
- It is not free: each natural-language turn is a model invocation. Prefer local
  slash commands for state lookup and one-shot questions for routine use.
