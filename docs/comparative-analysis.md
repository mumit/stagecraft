# Stagecraft vs adjacent AI-assisted engineering systems — 2026

**Refreshed:** 2026-09-02 (previous refresh 2026-06-22)
**Comparators:** AI-DLC 2.0, BMAD-METHOD, GitHub Spec Kit, OpenSpec, AWS Kiro (with Kiro
Crew), Omnigent, Bernstein, and Agent OS (reclassified, see §5).
**Structural facts:** Agent Client Protocol (ACP) and Agent Plugins 1.0 as the emerging
host layer; host CLIs absorbing the autonomous loop.
**Lineage:** `claude-dev-team` and `codex-dev-team` are Stagecraft's predecessors,
not external competitors.
**Focus:** process orchestration, spec-driven development, context systems, agent
runtimes, and automated evidence.

This is a documentary comparison, not a benchmark. Stagecraft claims are verified
against this repository at v0.12.0; comparator claims use first-party repositories,
release notes, or vendor documentation checked on the refresh date, with GitHub API
release dates preferred over page text. Star counts and release labels are deliberately
secondary because they age faster than architecture. Claims that could not be confirmed
from a first-party source are marked *unverified*.

## 1. Market map

Since June the field has split rather than converged. Spec-only frameworks stayed
lightweight and added soft completeness checks, not enforced gates. One context
framework exited the pipeline business. Meanwhile a vendor-backed methodology (AI-DLC 2.0)
now ships stage-level approval gates, an event audit trail, and multi-host ports, and a
small independent project (Bernstein) ships offline-verifiable signed run receipts. The
host CLIs themselves (Claude Code, Codex, Cursor, Kiro, Antigravity) absorbed the
autonomous loop as a native feature.

| School | Primary question | Examples |
|---|---|---|
| Process and gate control | What may run next, and what evidence permits it? | Stagecraft, AI-DLC 2.0 |
| Verifiable-evidence orchestration | Can a third party check, offline, what the agents did? | Bernstein; Stagecraft's gate chain and attestation export |
| Spec-driven blueprints | What agreed specification should implementation derive from? | Spec Kit, OpenSpec, Kiro specs |
| Persona/workflow cooperation | Which specialist perspective should shape the work? | BMAD |
| Context and convention systems | What project knowledge must every agent carry? | Agent OS (now standards-only), Kiro steering |
| Agent runtimes and meta-harnesses | Where and under which policies do agents execute and collaborate? | Omnigent, Kiro Crew |
| Host layer | How does a tool address any agent without a per-host adapter? | ACP, Agent Plugins 1.0 |

The categories are not product boxes. The useful distinction remains the **source of
operational truth**:

- Stagecraft: schema-backed gate JSON and on-disk pipeline state, validated and
  sometimes overruled by the orchestrator.
- AI-DLC 2.0: per-stage owner approvals, reviewer receipts bound to artifact and source
  state, and a 91-event audit trail.
- Bernstein: a task graph scheduled without a model in the loop, plus Ed25519-signed run
  receipts and an opt-in HMAC-chained audit log.
- Spec Kit/OpenSpec: specifications, plans/tasks, and approved change deltas.
- BMAD: workflow artifacts and, since v6.10, a spec-frontmatter state machine an
  orchestrator can poll.
- Agent OS/Kiro steering: standards context applied to agent work.
- Omnigent/Kiro Crew: live session, harness, policy, schedule, and sandbox state.

## 2. Current comparison matrix

| Dimension | Stagecraft | AI-DLC 2.0 | BMAD | Spec Kit | OpenSpec | Kiro + Crew | Omnigent | Bernstein |
|---|---|---|---|---|---|---|---|---|
| Primary primitive | Stage + gate | Phase → stage with owner + approval gate | Skill/workflow; `bmad-loop` state machine | Spec → plan → tasks → implement (+ `converge`) | Proposal + spec delta | Spec/steering/hook/agent; Crew specialists | Session + harness + policy | Goal → task graph → worktree agents → janitor verify |
| Source of truth | Gate/artifact files | Generated docs + event trail + receipts | Workflow artifacts + spec frontmatter | Markdown spec chain | Current specs + change folders | Workspace steering/specs | Agent YAML + server/session state | `.sdd/` state + signed receipts |
| Host posture | Per-stage/per-role routing across 7 first-party adapters plus plugins; ACP adapter | Native ports to 7 hosts (Kiro IDE/CLI, Claude Code, Codex, Cursor, opencode, Copilot) | Installs into multiple tools | 30+ integrations + generic | Broad slash-command/AGENTS integrations; Copilot cloud agent | Native Kiro surfaces; Crew on Kiro CLI and ACP | Meta-harness over Claude Code, Codex, Cursor, Pi, Antigravity, Devin | 54 agent adapters; GitHub Action |
| Mechanical gating | Strong: required fields, validator overrides, direct lint/test/SCA stamps, HMAC chain | Human approval per stage; two quality-gate reviewer agents; receipts | `bmad-review` lenses incl. verification-gap; workflow-guided | `converge` completeness check; extensions add Security Review, Architecture Guard | `openspec validate` (structural) | Hooks; Crew checkpoints/validation/retries | Action policies allow/block/pause; spend and tool caps | Deterministic janitor: tests/lint/types before merge |
| Autonomous loop | Bounded `devteam run` with consequence ceiling, typed failure classes, `--auto-rule` allowlist | Autonomous Construction in worktrees or clones | `bmad-dev-auto` unattended loop | Feature-assess workflow (installs and runs in host) | None (host-driven) | Plan mode auto-executes approved plans; Crew scheduled 24/7 | Automations with guardrails and spending caps | Parallel agents, no model in the scheduler |
| Audit evidence | Gate chain (HMAC), replay, run-log, in-toto attestation export | 91-event audit trail; reviewer and source-freshness receipts | Content-addressed snapshot renderer with verification hashing | Artifact chain | Proposed/current/archive states | Task and session history; per-user OTel usage export | Session, message, sub-agent, terminal, file state | Ed25519 receipts + HMAC audit log, `audit verify` offline |
| Cost telemetry | Adapter-observed tokens where the host reports them; model-asserted otherwise, labelled | Not documented | Not documented | Not documented (*credit budget claim unverified*) | Anonymous product telemetry only | Per-tool token breakdown; OTel usage export | Usage page; spending caps | Not documented |
| Post-build depth | Review, red-team, QA, a11y, observability, verification, performance, sign-off, deploy, retro | Construction + Operations phases, 33 stages | Build + review lenses + evidence-based retrospective | Core ends at implement; extensions | Apply/archive | Agent/hook dependent | Defined by selected agent | Verify + merge |
| Brownfield | `review-only`, `review-pr`, `refactor` tracks; `standards discover` | `/aidlc compose` scans existing projects | Brownfield context detection | `converge` against existing code | First-class change folders over current specs | Steering files | Imports existing sessions | Task graph over existing repo |
| Best fit | Multi-host, high-assurance delivery control with per-role routing | Enterprise methodology with AWS backing and explicit human approvals | Guided, role-rich product development moving toward unattended loops | Spec-centered greenfield/structured change at scale | Brownfield spec deltas, fluid process | Integrated agent environment with an always-on crew | Cross-device, policy-governed agent execution | Small teams wanting offline-verifiable receipts |

## 3. Lineage: two host-native proofs to one neutral core

Stagecraft is the third iteration of one delivery method, not a third host wrapper.
The predecessors are useful historical evidence because they show which parts survived a
host change:

- [`claude-dev-team`](https://github.com/mumit/claude-dev-team) proved the complete
  role-based team inside Claude Code: specialist roles, peer review, human checkpoints,
  deterministic gates, multiple delivery tracks, deploy adapters, audit, and retrospective.
- [`codex-dev-team`](https://github.com/mumit/codex-dev-team) rebuilt those ideas using
  Codex-native primitives: `AGENTS.md`, reusable skills, repository scripts, JSON gates,
  worktrees, and local/cloud execution profiles.
- **Stagecraft** extracted the shared contract—stages, roles, artifacts, gates, routing,
  authority, and evidence—into a host-neutral core with thin adapters.

The comparison that matters is therefore architectural rather than competitive.
The predecessor repositories bind the method to one host's native surfaces; Stagecraft
preserves those native experiences while owning the common pipeline once. This removes
parity drift and enables one run to route different workstreams through different hosts.

## 4. Stagecraft in September 2026

Stagecraft is v0.12.0: 18 ordered stages in the `full` track (20 stage definitions
including the compact QA fold and repair diagnosis), 10 tracks, 7 first-party host
adapters (claude-code, codex, antigravity, openai-compat, acp, omnigent, generic;
gemini-cli lives in the `@devteam/host-gemini-cli` plugin package after Google retired
the CLI upstream), 45 CLI commands, 26 accepted ADRs, and 3,721 passing offline tests
across 178 files. Native Windows CI runs a smoke job; host dispatch is not yet exercised
on Windows.

Since the June refresh the project shipped phases 28 through 42: adapter-layer token
telemetry and a sanitized run corpus; the four-dispatch `loop` track with assess-by-default
and a ceremony-cost preview; a closed pattern/memory learning loop; per-role
orchestrator stamping, a mechanical red-team floor, and adversarial review; cache-first
prompt layering and DAG wave execution; failed-gate eval capture; an ACP host adapter,
in-toto attestation export, and a compliance control mapping; existing-codebase review
tracks and `devteam review-pr`; external review mode with enforced read-only roots;
fail-closed execution trust profiles (ADR-020); calibration tooling; proposal-first
conversational refinement; and a dogfood-reliability phase derived from running a real
change. The June audit's dashboard XSS finding is remediated: model-authored strings pass
through an escape helper before the single `innerHTML` sink.

Two facts temper the capability list and are stated here because they change the
comparison:

- **Ceremony is now a choice.** `devteam assess` measures `loop` at 4 dispatches
  (~21K input tokens), `quick` at 15, and `full` at 23–25 (~131K). `loop` is the
  default for new projects.
- **Completion is unproven.** The project's own evidence review of 2026-08-27 found
  1 of 21 recorded autonomous runs reached `complete`, on a corpus of Stagecraft running
  on itself plus one other project. Adaptive routing and learned recipes remain
  evidence-gated and unactivated for that reason. See
  [`plans/architecture-review-2026-09.md`](../plans/architecture-review-2026-09.md).

The differentiator is therefore not "more stages," and after AI-DLC 2.0 it is no longer
"gates and an audit trail" alone. It is the combination of:

1. **An executable state contract.** Gate JSON drives deterministic next actions and can be
   mechanically overruled when model claims conflict with observed lint, test, SCA, and
   documentation checks. AI-DLC's approvals are human; Bernstein's verification is
   deterministic but does not read a model-authored gate.
2. **Heterogeneous dispatch within one run.** Roles and stages can use different host
   CLIs, including N-way review fanout with a pessimistic aggregate. AI-DLC ports to
   seven hosts but runs a workflow inside one.
3. **Bounded autonomy with provenance.** Automatic progress is limited by typed failure
   classes, retries, scope, grants, budget, a consequence ceiling before sign-off/deploy,
   and append-only events; trust profiles fail closed rather than downgrade.
4. **Downstream delivery depth.** Review, safety, quality, operations, deployment, and
   retrospective are gates, not suggestions.

## 5. Comparator updates

### AI-DLC 2.0 (awslabs/aidlc-workflows)

The largest change in the set. After v1.0.1 (2026-06-30) the repository shipped
Workflows 2.0: a harness-neutral core with native ports to seven hosts, five phases and
33 stages each with an owner and a human approval gate, a 14-agent roster including two
quality-gate reviewers, a 91-event audit trail, reviews bound to the exact artifact and
source state inspected (reviewer and source-freshness receipts), an adaptive composer
that scans brownfield projects, a learning loop that turns corrections into persistent
rules, autonomous construction in worktrees or clones, and a plugin authoring lifecycle.
v2.7.0 landed 2026-09-01 after roughly 75 point releases in late August. *The exact date
2.0 became GA is unverified.*

This is now Stagecraft's closest peer on gates, audit, multi-host, and brownfield.
Differences that remain: AI-DLC's gates are human approvals and its receipts bind
reviews to state; Stagecraft's gates are machine-validated JSON the orchestrator can
overrule with observed checks, and its chain is HMAC-signed. AI-DLC has AWS backing and
a broader methodology; Stagecraft has per-role heterogeneous dispatch and a smaller
default footprint.

### BMAD-METHOD

Three releases since June (v6.9.0, v6.10.0, v6.11.0 on 2026-08-10). The direction is
unattended execution: `bmad-loop` is an installable module for "unattended dev-loop
orchestration, adversarial review, and deferred-work sweeps," driven by a
`bmad-dev-auto` skill running clarify → spec → implement → review → finalize off a
spec-frontmatter state machine. v6.11 renamed Quick Dev to Build as "the one official
way BMad implements code," collapsed 14 core skills to 8, merged reviews into one
`bmad-review` with lenses (adversarial, edge-case-hunter, verification-gap), made the
retrospective evidence-based, and added a content-addressed snapshot renderer with
verification hashing. Python 3.11+ is now required. BMAD's advantage over Stagecraft
remains facilitated product conversation and ecosystem size; its new loop has no
machine-validated gate contract and no cost gating.

### GitHub Spec Kit

1.0.0 shipped 2026-08-21, with 1.0.4 on 2026-09-02. Additions: `/speckit.converge`
(assess codebase against spec/plan/tasks and append remaining work as tasks, a
completeness check rather than a hard gate), a layered customization system with
role-based bundles, an extension catalog carrying Security Review, Architecture Guard,
and a multi-agent QA extension, a feature-assess workflow that installs and runs Spec
Kit inside a host, event-hook script paths confined to the project tree, and 30+ agent
integrations. The 1.0 notes reframe breaking changes as cheap "because agents can
automatically handle migrations." No first-party audit trail or token telemetry was
found. Spec Kit's center remains the specification chain at scale; Stagecraft's remains
delivery control and observed evidence.

### OpenSpec

Steady cadence from v1.5.0 (2026-06-28, Stores beta for cross-repo shared planning)
through v1.11.0 (2026-08-26): auto-upgrade, `skip_specs` for refactor-only changes, an
optional Copilot cloud agent, capability retirement on archive, `validate --archived`,
Zed support, colorized spec diffs, and an Explore mode that asks before it writes.
Positioning is unchanged ("fluid not rigid"). Still no gates, orchestration, audit, or
cost telemetry; validation is structural. Its current-vs-proposed spec model remains
more mature than Stagecraft's brief/artifact lineage.

### AWS Kiro and Kiro Crew

Heavy summer for the CLI (v2.15 through v2.21 on 2026-09-01): Plan mode that
auto-executes approved plans, per-tool token breakdown, cloud sessions, a spec review
screen, full-screen spec task execution with scope selection, and a session dashboard.
Powers adopted the Agent Plugin format. **Kiro Crew** was open-sourced 2026-08-04: a
persistent, scheduled, multi-specialist orchestrator with checkpoints, validation, and
retries, running on Kiro CLI and ACP. Enterprise additions include SSO, ISO 27001
coverage, and per-user usage export to OpenTelemetry. *Kiro Web GA on 2026-09-01 is
weakly verified; third-party sources still say preview.* Kiro has moved from
"spec-driven IDE" to an agentic engineering platform. Stagecraft should compose with it
as a host and, via ACP, as a Crew participant rather than imitate it.

### Omnigent

Weekly minors from v0.5.1 to v0.12.0 (2026-09-01): automations and scheduled tasks,
collaborative shared sessions with attribution, smart routing model selection,
multi-sandbox providers, Devin, Antigravity, and Grok Build harnesses, a usage tracking
page, live permission-mode switching, automation guardrails with spending caps,
importing existing Claude Code and Codex sessions, and host-as-service. Positioning is
unchanged: a meta-harness and control plane, not a methodology. It answers **where and
how an agent runs**; Stagecraft answers **which delivery stage may run next, what it may
change, and what evidence must exist before the pipeline advances**. Stagecraft's
`omnigent` adapter dispatches one workstream through Omnigent while Stagecraft keeps the
artifacts, write audit, and gate chain; director-style consolidation remains parked
(Phase 25).

### Bernstein (new)

A solo-maintained beta (v3.19.0 on 2026-08-31) that is the most direct "verifiable
evidence" comparator: goal → planner → task graph → parallel agents in worktrees →
deterministic janitor (tests, lint, types) → merge, with scheduling in plain Python and
no model in the loop, state in `.sdd/`, Ed25519-signed run receipts, an opt-in
HMAC-chained audit log verifiable offline, 54 agent adapters, and a GitHub Action. Its
receipts use public-key signatures, so a third party can verify without a shared
secret; Stagecraft's ADR-011 chain is HMAC and its in-toto attestation export is the
portable form. Bernstein has no stage model, review roles, or deploy depth.

### Agent OS (reclassified)

No release since v3.0.0 (2026-01-20) and one commit since June. v3 deliberately retired
its implementation and orchestration phases ("frontier models handle this well on their
own") and narrowed to `/discover-standards`, `/inject-standards`, and `/shape-spec`,
deferring spec-writing to host Plan Mode. It is now a standards-injection layer, not a
process comparator, and is low-activity. Stagecraft's one-shot `standards discover`
covers part of the same surface.

## 6. Structural facts

**ACP is the de facto host layer.** Schema v1.21.0 and Rust crate v1.7.0 (2026-08-20)
stabilized elicitation and terminal auth; the registry lists 70+ agents including
Claude, Codex, Gemini CLI, Copilot, Goose, Cursor, and Devin; Kiro Crew runs on ACP
natively. Remote agents are still work in progress. Stagecraft's `acp` adapter (Phase 34)
is therefore the adapter with the widest reach, and with claude-code it is one of the
two that enforce allowed-writes and stoplist at tool-call time rather than post hoc;
the ACP path does so for any agent that speaks the protocol.

**Agent Plugins 1.0 (2026-08-06).** A vendor-neutral package (`plugin.json`, skills,
`mcp.json`) with ChatGPT, Codex, Cursor, Copilot, Kiro, and VS Code as launch clients;
Claude Code via translation. *Spec details come from secondary sources and are
partially unverified.* Pipeline tooling shipped as skills, hooks, and MCP can now be one
artifact across hosts, which weakens the case for per-host install payloads.

**Hosts absorbed the loop.** Google retired consumer Gemini CLI on 2026-06-18 for
Antigravity CLI (agent teams, hooks, subagents, SDK preview). Codex CLI 0.149 added an
agents dashboard, a queue, and automated approvals with a Guardian review. Cursor added
event-subscribed cloud agents, `/goal`, `/loop`, and subagents on isolated VMs. Claude
Code added `/loop`, `/goal`, agent teams, model-switch hooks, and prompt-cache lines in
`/cost`. A pipeline tool can no longer differentiate on "it runs autonomously"; it
differentiates on what bounds the autonomy and what evidence survives it.

## 7. Where Stagecraft wins, and where it does not

### Defensible strengths

- Gate JSON is executable state the orchestrator validates and can overrule with
  observed checks; no comparator has a model-authored, machine-validated gate.
- Per-role, per-stage heterogeneous host routing within one run, including review fanout.
- Bounded autonomy with typed failure classes, a consequence ceiling, fail-closed trust
  profiles, and append-only provenance.
- Delivery depth after implementation (red-team, a11y, observability, performance,
  deploy, retro) is broader than every comparator except AI-DLC's Operations phase.
- Ceremony is measured and selectable: 4, 15, or 23–25 dispatches with the cost shown
  before dispatch.

### Better choices in other situations

- **Enterprise methodology with vendor backing, human approvals, and a brownfield
  composer:** AI-DLC 2.0 now covers most of the gated-pipeline surface at larger scale.
- **Spec is the long-lived product asset:** Spec Kit or OpenSpec first.
- **Interactive product shaping:** BMAD has the stronger native conversation and now an
  unattended loop.
- **Offline, public-key-verifiable receipts with minimal process:** Bernstein.
- **One integrated agent workspace with an always-on crew:** Kiro.
- **Cross-device sessions, live collaboration, spending caps, and managed sandboxes:**
  Omnigent supplies the execution surface; Stagecraft can supply the delivery method.
- **Proven completion on real projects:** no comparator publishes this, and Stagecraft's
  own evidence does not yet show it either.

## 8. Strategic implications

### Do next

1. **Prove runs finish.** The single number that matters for adoption is completion rate
   on `loop` across external repositories with organic features. Every comparison above
   assumes the pipeline reaches its gates. See the finish/freeze/delete list in
   [`plans/architecture-review-2026-09.md`](../plans/architecture-review-2026-09.md).
2. **Make evidence portable and third-party verifiable.** Bernstein's public-key
   receipts and AI-DLC's state-bound reviewer receipts set the bar. The in-toto
   attestation export is the right vehicle; wire external-review `subject.json` into it
   and consider a public-key signing option alongside the HMAC chain (ADR-011).
3. **Ship through the host layer, not around it.** Treat the ACP adapter as primary
   reach and package the install payload as an Agent Plugin, so a new host is a registry
   entry rather than an adapter directory.
4. **Gate on observed cost.** Kiro's OpenTelemetry usage export and Omnigent's spending
   caps make cost a first-class control. Stagecraft's `--budget-usd` pre-dispatch check
   should rest on adapter-observed usage everywhere, with model-asserted numbers
   labelled and excluded from enforcement.
5. **Close the Windows dispatch gap.** A native smoke job exists; host CLIs installed by
   npm are `.cmd` shims and the headless spawn does not resolve them. Do not promote
   Windows support until a Windows job dispatches a stubbed host.

### Validate before investing

- **Conversational upstream stages:** BMAD, Kiro, and OpenSpec's Explore mode confirm
  demand for clarification before artifact production. Stagecraft's proposal-first
  refinement (Phase 40) exists; require user evidence before extending it.
- **Learning loops:** BMAD, AI-DLC, and Stagecraft all now claim a corrections-to-rules
  loop. None publishes evidence that it improves outcomes. Keep activation gated.
- **Continuous standards deployment:** Agent OS's remaining niche. Validate drift on real
  projects before adding hooks.

### Continue to avoid

- Becoming an IDE or model provider.
- Rebuilding session UI, collaboration, or a sandbox fleet that Omnigent and Kiro supply.
- Maintaining first-party adapters for every coding agent; ACP and the plugin interface
  are the reach mechanism.
- Self-modifying pipeline rules, learned routing, or recipes before multi-project
  evidence exists.
- Adding stages. The field's ceremony backlash is real and the `loop` track is the
  answer to it.

The detailed sequence is in [the current audit roadmap](audit/10-roadmap.md) and the
September review above.

## 9. Method and sources

Checked on 2026-09-02. Release dates were taken from the GitHub API where available.

- Stagecraft: this repository's `package.json`, `core/`, `hosts/`, tests, docs,
  [audit](audit/00-project-context.md), and
  [`plans/architecture-review-2026-09.md`](../plans/architecture-review-2026-09.md).
- [AI-DLC workflows repository](https://github.com/awslabs/aidlc-workflows) and
  [v2.7.0 release](https://github.com/awslabs/aidlc-workflows/releases/tag/v2.7.0).
- [BMAD-METHOD v6.11.0](https://github.com/bmad-code-org/BMAD-METHOD/releases/tag/v6.11.0),
  [bmad-loop](https://github.com/bmad-code-org/bmad-loop), and
  [Build/auto docs](https://docs.bmad-method.org/reference/build-auto/).
- [GitHub Spec Kit v1.0.0](https://github.com/github/spec-kit/releases/tag/v1.0.0) and
  [v0.16.5](https://github.com/github/spec-kit/releases/tag/v0.16.5).
- [OpenSpec releases](https://github.com/Fission-AI/OpenSpec/releases).
- [Kiro changelog](https://kiro.dev/changelog/) and
  [Kiro Crew](https://github.com/kirodotdev/KiroCrew).
- [Omnigent v0.12.0](https://github.com/omnigent-ai/omnigent/releases/tag/v0.12.0).
- [Bernstein](https://github.com/sipyourdrink-ltd/bernstein).
- [Agent OS v3.0.0](https://github.com/buildermethods/agent-os/releases/tag/v3.0.0).
- [Agent Client Protocol releases](https://github.com/zed-industries/agent-client-protocol/releases)
  and [registry](https://agentclientprotocol.com/registry).
- [Antigravity changelog](https://antigravity.google/changelog/),
  [Codex CLI rust-v0.149.0](https://github.com/openai/codex/releases/tag/rust-v0.149.0),
  [Cursor changelog 2026-08-19](https://cursor.com/changelog/08-19-26),
  [Claude Code changelog](https://code.claude.com/docs/en/changelog).
- Stagecraft lineage: [claude-dev-team](https://github.com/mumit/claude-dev-team) and
  [codex-dev-team](https://github.com/mumit/codex-dev-team).

No framework was installed or benchmarked. Comparative claims describe documented
architecture and workflow, not independently measured productivity or quality.
