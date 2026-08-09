# Walkthrough: Stage-04 split host

A trace of the multi-host contract: one feature, the `full` track, backend on Codex and everything else on Claude Code. This walkthrough shows how the gate JSON contract, role-keyed routing, and capability negotiation cooperate when a single stage fans out to two different hosts.

> Historical note: this document originally proposed contract changes (per-role routing, per-workstream gates, capability `enforces` declarations, host-neutral context files) needed to make a split-host pipeline viable. Those changes have shipped. The trace below shows the resulting flow.

---

- [Scenario](#scenario)
- [Capability surface](#capability-surface)
- [Trace](#trace)
- [What this trace demonstrates](#what-this-trace-demonstrates)
- [Where the asymmetry leaks through](#where-the-asymmetry-leaks-through-known-and-documented)
- [See also](#see-also)

## Scenario

- **Feature:** "Add SMS notification opt-in to user settings."
- **Track:** `full`
- **Routing:**

```yaml
# .devteam/config.yml
routing:
  default_host: claude-code
  roles:
    pm: claude-code
    principal: claude-code
    backend: codex            # the split
    frontend: claude-code
    platform: claude-code
    qa: claude-code
    security: claude-code
    reviewer: claude-code
```

- **Hosts on PATH:** `claude --version` and `codex --version` both work.

## Capability surface

| Host | hooks | subagents | slash | worktrees | headless | `enforces.allowed_writes` |
|---|---|---|---|---|---|---|
| `claude-code` | ✅ | ✅ | ✅ | ✅ | `claude --dangerously-skip-permissions --print` | `tool-call-time` (hooks) |
| `codex` | ❌ | ❌ | ❌ | ✅ | `codex exec --sandbox workspace-write` | `prompt-only` (advisory) |

Source: `hosts/{claude-code,codex}/capabilities.json`. The orchestrator reads these at dispatch time and handles the asymmetry explicitly rather than hiding it.

## Trace

### Stage 01 — Requirements (PM → claude-code)

```bash
devteam stage requirements --feature "Add SMS notification opt-in" --headless
# [devteam] dispatching pm → claude-code (headless)
#   ✓ pm (claude-code): exit 0, 23000ms → pipeline/gates/stage-01.json
```

PM writes `pipeline/brief.md` and `pipeline/gates/stage-01.json`. Router consulted `routing.roles.pm = claude-code`. The Claude Code `Stop` hook validates the gate as soon as the model emits it.

```bash
devteam next
# ▶️ run-stage design (stage-02)
```

### Stages 02–03b — Design / Clarification / Spec (all claude-code)

Same path. Each role is on Claude Code; the orchestrator dispatches via the claude-code adapter; gates land via the `Stop` hook; `next` walks to the next stage.

### Stage 04 — Build (the split)

Stage 04 has four roles in parallel: `backend`, `frontend`, `platform`, `qa`. The orchestrator decomposes the stage into per-role workstream invocations and dispatches each to its routed host:

```bash
devteam stage build --headless
# [devteam] stage build → dispatching 4 workstreams in parallel
#   ✓ backend  (codex):       exit 0, 41000ms → pipeline/gates/stage-04.backend.json
#   ✓ frontend (claude-code): exit 0, 35000ms → pipeline/gates/stage-04.frontend.json
#   ✓ platform (claude-code): exit 0, 28000ms → pipeline/gates/stage-04.platform.json
#   ✓ qa       (claude-code): exit 0, 22000ms → pipeline/gates/stage-04.qa.json
```

Each workstream writes its own gate. After the dispatch completes, the orchestrator merges them into the stage-level gate:

```bash
devteam merge build
# Merged 4 workstream gates → pipeline/gates/stage-04.json (status PASS)
```

The merged gate's `workstreams[]` array lists each contributing workstream with its `host` and `status`. Real example from `examples/sms-opt-in/pipeline/gates/stage-04.json`:

```json
{
  "stage": "stage-04",
  "status": "PASS",
  "orchestrator": "devteam@0.1.0",
  "track": "full",
  "timestamp": "2026-05-26T20:11:01.722Z",
  "blockers": [],
  "warnings": [],
  "workstreams": [
    { "workstream": "backend",  "host": "codex",       "status": "PASS" },
    { "workstream": "frontend", "host": "claude-code", "status": "PASS" },
    { "workstream": "platform", "host": "claude-code", "status": "PASS" },
    { "workstream": "qa",       "host": "claude-code", "status": "PASS" }
  ]
}
```

`backend` was authored entirely by Codex; every other workstream by Claude Code. The merged stage gate carries the audit trail of which host produced each workstream.

### Stage 04a — Pre-review (Platform → claude-code)

Platform reads every workstream's `pipeline/pr-*.md`, including `pr-backend.md` written by Codex. The reviewer reads files on disk; which host produced which PR summary is irrelevant at this stage. This is the gate-JSON-as-contract principle: artifacts are exchanged through the filesystem, not through host-specific channels.

What *is* asymmetric here: the `allowed_writes` enforcement. Claude Code's hooks block writes outside the role's `allowedWrites` at tool-call time. Codex has no equivalent — the prompt instructs the model not to write outside `src/backend/`, and the validator audits the diff after the fact (`npm run audit:writes` is the recommended post-hoc check; see `core/pipeline/stages.js` for the per-role allowed-writes table). The pre-review gate flags an `enforcement_method` warning when any workstream ran on a `prompt-only` host. Operators who enable `pipeline.workstream_isolation: git-worktree` get an additional host-neutral reconciliation boundary: unauthorized paths are not copied back into the operator checkout, although the agent still has the invoking user's OS permissions.

### Stage 04c — Red-team (Red-team → claude-code)

Adversarial review against the merged change. Host-agnostic by nature — the red-team agent reads the same `pipeline/pr-*.md` files plus the diff. Blockers it identifies are auto-injected into `pipeline/context.md` by the validator (`core/hooks/approval-derivation.js`) so the build re-run sees them; this is the only place the framework actively closes a feedback loop.

### Stage 04d — Migration-safety (Migrations → claude-code, conditional)

Fires only if Stage 04a's gate carries `migration_safety_required: true`. For an "SMS opt-in" feature that touches `users` schema, it fires; Migrations reviews the migration plan; `veto` semantics apply if the gate fails.

### Stage 05 — Peer review (Reviewer × 4 → claude-code)

Backend reviewer reviews `pr-backend.md` — written by Codex. The reviewer comments are tagged with `REVIEW:` markers in `pipeline/code-review/by-backend.md`; the `PostToolUse` hook parses those markers and writes `pipeline/gates/stage-05.backend.json` automatically (see `core/hooks/approval-derivation.js`). This is the one stage where the gate is *not* written by the model — the hook derives it from the review markdown.

```bash
devteam merge peer-review
# Merged 4 reviewer gates → pipeline/gates/stage-05.json (status PASS, 4 approvals)
```

### Stages 06–06d, 07–09

QA writes the test report; accessibility audit, observability gate, and (on full only) verification-beyond-tests run; PM + Platform sign off; deploy adapter runs (`core/deploy/`); retro is authored. All on Claude Code per routing. Stage-by-stage path unchanged from a single-host run.

```bash
devteam next
# pipeline-complete
```

## What this trace demonstrates

The five things that hold up cleanly across the host boundary:

1. **Gate JSON as a stable contract.** Stage 05 reads Stage 04's `pr-backend.md` without knowing it was written by Codex. The merged stage-04 gate records `host: codex` for audit, but no other stage branches on host.
2. **Per-role routing.** `routing.roles.backend = codex` is honoured at every stage that dispatches backend (Stage 04, Stage 05's backend reviewer). Single-role stages (PM, Principal) and multi-role stages (build, peer-review) use the same resolution path.
3. **Per-workstream gates merging into stage gates.** `stage-04.backend.json` + `stage-04.frontend.json` + ... → `stage-04.json` with a `workstreams[]` array. The orchestrator owns the merge; adapters never see each other's output.
4. **Capability negotiation.** The orchestrator reads `capabilities.json`, knows Codex has no hooks, and falls back to gate-file polling instead of waiting for a `Stop` event. The user types `devteam stage build --headless` once; the orchestrator handles the rest.
5. **Deploy adapters are host-agnostic.** Stage 08 shells out to `docker compose` / `kubectl` / `terraform` regardless of which host built the code.

## Where the asymmetry leaks through (known and documented)

- **`allowed_writes` enforcement.** Claude Code enforces at tool-call time via hooks; Codex enforces in the prompt and is audited post-hoc. The pre-review gate carries an `enforcement_method` field per workstream so a reviewer can see which is which. [ADR-019](../adr/019-isolated-build-workstreams.md) does not invent a missing Codex hook, but its opt-in core-managed worktrees prevent unauthorized or conflicting workstream results from being reconciled into the operator checkout.
- **Cost telemetry.** Tokens are not comparable across model families. `core/pricing.js` records per-host pricing; `npm run dashboard:cost --by host` is the supported view. Cross-host totals are best-effort.
- **`readFirst` paths.** Each adapter generates a host-shaped path for its rule files (`AGENTS.md` for Codex, `CLAUDE.md` for Claude Code). The canonical source is `rules/*.md` in this repo; adapters render at install time.

## See also

- [`core/adapters/host-adapter.md`](../../core/adapters/host-adapter.md) — the contract every adapter implements.
- [`docs/walkthroughs/soc2-evidence-collector.md`](soc2-evidence-collector.md) — full 18-stage pipeline trace on a non-trivial feature (single-host).
- [`examples/sms-opt-in/`](../../examples/sms-opt-in/) — the gate files referenced in this trace, on disk.
