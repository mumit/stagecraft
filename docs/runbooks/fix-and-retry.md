# Runbook: Fix and Retry

`devteam next` reports `fix-and-retry`. A gate is FAIL. This runbook covers what to read, how to fix, how to re-run, and how to confirm the fix took.

Most `fix-and-retry` cases come from one of seven stages: **red-team** (Stage 4c), **QA-within-build** (Stage 4 QA workstream), **pre-review** (Stage 4a), **preflight** (Stage 4e), **peer-review** (Stage 5), **accessibility-audit** (Stage 6b), or **verification-beyond-tests** (Stage 6d). Peer-review fails in two distinct shapes: with reviewer objections (Case 4) or with no objections but insufficient approvals (Case 5, a quorum miss). After the red-team gate resolves, Case 1 also covers the **QA augmentation step** and the **advisory triage step** (`devteam advise`) that classifies deferred findings before peer-review begins. The general flow is the same across all cases; the per-stage specifics differ.

For escalations (`status: ESCALATE`, `decision_needed`), see [`escalation.md`](escalation.md).

**Read the `failure_class` tag first.** `devteam next` now tags the action, e.g. `❌ fix-and-retry — qa (stage-06)  [code-defect]` (and a `failure_class` field under `--json`). It tells you *how* to respond before you read the blockers:

- **`code-defect`** — the normal case this runbook covers: change code, re-run the stage.
- **`state-corruption`** — the gate file is unreadable/malformed. **Do not re-run the stage** — that won't fix a corrupt file. Repair or rewrite the gate JSON (the blocker text names the parse error), then re-run `devteam next`.
- **`external-blocked`** — every fix step is a human/external action with no command (e.g. obtain a sign-off). Do that thing; the pipeline can't self-advance.
- **`convergence-exhausted`** — the retry budget (`autonomy.max_retries`, default 2) is spent **or** the no-progress breaker fired (blockers identical across the last two archived attempts), so `next` returns `resolve-escalation` instead. See [`escalation.md` § 4c](escalation.md#4c-retry-loop-exhaustion--a-distinct-escalation-shape).

An autonomous run can instead halt with `halt_action: retry-ownership` and
`failure_class: structural-input`. That means the blocker named target files, but
none of the candidate build roles' existing `roleWrites` covers every target. The
driver leaves the gates untouched and invokes no host. Use the returned
`retry_ownership.target_paths` and `candidate_roles` to fix manually, correct the
design's `file_ownership`, or introduce a genuinely scoped owner; do not add a broad
directory to an unrelated role as a recovery shortcut.

---

- [The general pattern](#the-general-pattern)
- [Case 1: Red-team FAIL](#case-1-red-team-fail--must_address_before_peer_review-non-empty)
- [Case 2: QA-within-build FAIL](#case-2-qa-within-build-fail)
- [Case 3: Pre-review FAIL](#case-3-pre-review-stage-04a-fail--lint-or-test-failure)
- [Case 4: Peer-review CHANGES\_REQUESTED](#case-4-peer-review-stage-05-changes_requested--fail)
- [Case 5: Peer-review quorum miss](#case-5-peer-review-stage-05-fail-with-no-objections--quorum-miss)
- [Case 6: PM sign-off FAIL](#case-6-pm-sign-off-stage-07-fail--delta_items-non-empty)
- [Case 7: Accessibility audit FAIL](#case-7-accessibility-audit-stage-06b-fail--blockers-non-empty)
- [Case 8: Consistency drift](#case-8-consistency-drift--devteam-consistency-analyze-exits-non-zero)
- [Case 9: Verification-beyond-tests FAIL](#case-9-verification-beyond-tests-stage-06d-fail--blocking_findings-non-empty)
- [Case 10: Preflight FAIL](#case-10-preflight-stage-04e-fail--committed-ignored-files-or-broken-import-path)
- [Case 11: Advisory triage — noted\_for\_followup before downstream stages](#case-11-advise-workflow--triage-follow-up-items-before-downstream-stages)
- [Case 12: License-gate FAIL](#case-12-license-gate-stage-04a-fail--license_check_passed-false)
- [Case 13: Tool-budget denial](#case-13-tool-budget-denial)
- [Common gotchas](#common-gotchas)
- [After resolution](#after-resolution)

---

## The general pattern

```bash
# 1. See what failed — devteam next shows the fix steps automatically
devteam next
# Prints action, reason, and numbered fix steps with exact commands.
# The fix steps identify which build workstream to re-run and emit the
# right --workstream command — no manual gate file inspection needed.

# 2. Fix it — targeted re-run of the affected workstream(s)
devteam stage build --workstream <role> --headless
# --workstream dispatches only the named role; all other gates are left untouched.
# Repeat the flag for multiple roles: --workstream backend --workstream platform
# For a full re-run of all workstreams (when you're unsure which are affected):
devteam stage build --patch --from <failing-stage> --headless

# 3. Merge if multi-role
devteam merge build

# 4. Re-run dependent stages so they see the patched code
devteam stage pre-review --headless
devteam stage <originating-failed-stage> --headless

# 5. Confirm advance
devteam next   # should say "▶️ run-stage <next-stage>"
```

Two things make this work cleanly:

- **`--patch --from <stage>`** reads the failing gate's blocker list and injects a `## ⚠️ PATCH MODE — targeted fix only` section at the top of every dispatched build prompt. Agents are constrained to those items.
- **`--workstream <role>`** dispatches only the named role(s); all other workstream gate files are left untouched. Repeat the flag for multiple roles. Replaces the old pattern of `rm pipeline/gates/<workstream>.json` + `--skip-completed`.
- **`--skip-completed`** skips any workstream whose gate file still exists. Useful when re-running all workstreams but skipping ones that already passed (e.g. `devteam restart build` + full re-run without targeting a specific role).

The validator helps too: when red-team or stage-04.qa writes FAIL with blockers, it auto-injects a `## IMMEDIATE: ... — Fix Before X` section into `pipeline/context.md` so every later prompt sees the must-fix list. When the originating stage next writes PASS/WARN, the section is auto-stripped. You don't manage either lifecycle.

---

## Case 1: Red-team FAIL — `must_address_before_peer_review` non-empty

This is the most common `fix-and-retry`. Red-team walked the 10 attack surfaces, found a real defect, and listed it in `must_address_before_peer_review[]` of `pipeline/gates/stage-04c.json`. Each entry includes `id`, `severity`, `file`, `workstream`, `reproducer`, and `fix_suggestion` — everything the implementer needs.

**First: identify which workstreams to re-run.**

Each blocker in the gate carries an `assigned_to` field naming the workstream
that owns the file. `devteam next` uses this to generate the fix steps
automatically; you can also read it directly:

```bash
# Primary: read assigned_to from each blocker
cat pipeline/gates/stage-04c.json | jq '[.blockers[].assigned_to] | unique | sort'
# → ["backend"]

# Or read the gate-level summary (derived from the same values):
cat pipeline/gates/stage-04c.json | jq .affected_workstreams
# → ["backend"]
```

Both name exactly the workstreams whose gates you need to clear.

```bash
# Fallback for gates written before assigned_to was required — check file paths
# against the PR summaries to identify the owning workstream manually:
cat pipeline/gates/stage-04c.json | jq -r '.blockers[].file'
# → src/backend/app.py
# → src/cli.js
# Then cross-reference with pipeline/pr-backend.md, pipeline/pr-platform.md, etc.
```

**Concrete example.** A run produced this gate:

```json
{
  "stage": "stage-04c", "status": "FAIL",
  "affected_workstreams": ["backend"],
  "blockers": [
    {
      "id": "F-01", "assigned_to": "backend",
      "file": "src/backend/app.py", "line": 146,
      "summary": "POST /estimate with model=[] returns 500 text/html instead of 400 JSON"
    }
  ],
  "must_address_before_peer_review": [{
    "id": "F-01", "assigned_to": "backend", "severity": "critical",
    "file": "src/backend/app.py", "line": 146,
    "reproducer": "POST /estimate {\"text\":\"hi\",\"model\":[]}  ->  500 text/html",
    "contracts_violated": ["design-spec §5", "brief AC-6/7/8"],
    "fix_suggestion": "Insert `if not isinstance(model, str)` check before the membership test."
  }],
  "noted_for_followup": [
    /* F-02 .. F-08 — non-blocking, recorded for tickets */
  ]
}
```

`affected_workstreams: ["backend"]` (and `blockers[0].assigned_to: "backend"`) confirms only the backend dev needs to re-execute. Sequence:

```bash
# 1. (Optional) Watch the run in a second pane
devteam log --follow

# 2. Scoped build re-run — backend only.
#    --patch --from red-team    reads stage-04c.json's must_address_before_peer_review,
#                                inlines F-01 (with reproducer + fix_suggestion) into
#                                the dispatched build prompt.
#    --workstream backend        dispatches only backend; frontend/platform/qa gates
#                                are left untouched (no manual gate deletion needed).
#    --headless                  drives Claude Code (or whichever host) automatically.
devteam stage build --patch --from red-team --workstream backend --headless

# 4. Merge the rewritten backend gate with the surviving 3.
devteam merge build

# 5. Re-run pre-review. The orchestrator-stamped verification (lint + tests)
#    runs the actual commands; if F-01's fix breaks anything else, this
#    flips stage-04a to FAIL with the real exit codes.
devteam stage pre-review --headless

# 6. Re-run red-team to re-walk the 10 surfaces against the patched code.
#    On PASS, the validator auto-strips the red-team-blockers section from
#    context.md (no stale "IMMEDIATE: Fix" heading left behind).
devteam stage red-team --headless

# 7. Confirm advance.
devteam next
# → expect: ▶️ run-stage peer-review (stage-05)
```

### Slower but simpler: restart all of stage-04

If you don't want to think about which workstreams to clear:

```bash
devteam restart build --keep-context     # clear all build gates; preserve F-01 section
devteam stage build --patch --from red-team --headless    # all 4 workstreams re-run
devteam merge build
devteam stage pre-review --headless
devteam stage red-team --headless
devteam next
```

This costs 4× the build wall-clock (the three unaffected agents render and exit quickly with PR summaries saying "no relevant items in scope"), but is simpler to reason about. Choose based on cost versus effort.

### After red-team PASS/WARN: run QA augmentation before peer-review

When the red-team gate turns WARN or PASS after one or more fix cycles, do not advance directly to Stage 5 peer-review. A patch cycle with `--skip-completed` leaves the QA gate unchanged — no regression tests were written for the fixes. Peer reviewers then verify correctness by static inspection alone, and the same bug class can resurface.

After `devteam stage red-team --headless` exits WARN or PASS:

```bash
# Re-run only the QA workstream (backend/frontend/platform gates are untouched).
# --from red-team injects the red-team context; QA's role brief (§On a Post-Red-Team
# Test Augmentation Task) guides it to write regression tests to src/tests/regression/
# rather than re-running the full Stage 6 suite.
devteam stage build --patch --from red-team --workstream qa --headless
devteam merge build

# Confirm all tests still pass (QA gate updated, tests_total incremented).
devteam next
# → expect: ▶️ run-stage peer-review (stage-05)
```

See `roles/qa.md §On a Post-Red-Team Test Augmentation Task` for exactly what
QA does in this mode and what the updated gate looks like.

### What about the `noted_for_followup` items?

The red-team gate's `noted_for_followup[]` is non-blocking by design. Don't try to fix those items in the patch cycle — bundling them in defeats the scoped re-run and they're explicitly deferred by the red-team agent.

**Triage them with `devteam advise` before advancing to QA augmentation or peer-review:**

```bash
devteam advise
# Shows each item with risk classification and ranked options

devteam advise --apply RT-01=B:INFRA-445,RT-02=A,AC-11=C
# RT-01: DEFERRED with ticket INFRA-445
# RT-02: NOTED (no action)
# AC-11: BRIEF-AMEND-NEEDED (flags PM to scope-down the AC)
```

Decisions are written to `pipeline/context.md`. QA respects `DEFERRED:` entries (skips coverage checks for those ACs); peer-review role briefs note `BRIEF-AMEND-NEEDED:` entries so reviewers know a brief amendment is pending. See [Case 11](#case-11-advise-workflow--triage-follow-up-items-before-downstream-stages) for the full workflow and option vocabulary.

---

## Case 2: QA-within-build FAIL

QA's workstream gate inside Stage 4 (`pipeline/gates/stage-04.qa.json`) is FAIL with a `blockers[]` list. QA found bugs in code that backend or platform owns. The validator auto-injects the QA blockers into `context.md` between `<!-- devteam:qa-build-blockers -->` markers.

```bash
# 1. Identify which workstreams own the failing tests.
cat pipeline/gates/stage-04.qa.json | jq .affected_workstreams
# → ["backend", "platform"]

# For gates written before affected_workstreams was added, derive it:
cat pipeline/gates/stage-04.qa.json | jq '[.failing_tests[].assigned_to] | unique | sort'

# 2. Scoped re-run — affected workstreams + QA only (frontend's gate stays).
devteam stage build --patch --from stage-04.qa --workstream backend --workstream platform --workstream qa --headless
devteam merge build
devteam next
```

`--from stage-04.qa` accepts the per-workstream gate-id directly (no friendly name needed). Pre-review re-runs automatically as `devteam next` advances.

---

## Case 3: Pre-review (stage-04a) FAIL — lint or test failure

Stage 4a is now **orchestrator-stamped** (the orchestrator runs the lint and test commands itself; the model's claim is verified against actual exit codes). If the gate is FAIL with `lint_passed: false` or `tests_passed: false`, the failure is real — the orchestrator observed it.

```bash
# 1. See the failing command(s)
cat pipeline/gates/stage-04a.json | jq '._orchestrator_stamped.runs'
# Shows: { lint: { command: "npm run lint", exit_code: 1, ... }, ... }

# 2. Reproduce locally to see what the agent missed
npm run lint   # or whatever command is in the stamped record

# 3. Fix via a scoped build re-run (--from stage-04a reads stage-04a.json's blockers[]).
devteam stage build --patch --from stage-04a --workstream <owning-area> --headless
devteam merge build
devteam stage pre-review --headless    # orchestrator re-runs the commands
devteam next
```

The orchestrator re-stamps stage-04a on the next run. Hand-editing the gate to PASS will be overwritten — `devteam verify stage-04a` re-stamps and restores FAIL.

---

## Case 4: Peer-review (stage-05) CHANGES_REQUESTED → FAIL

Stage 5 is different — the `approval-derivation` hook writes the gate based on `REVIEW: APPROVED` / `REVIEW: CHANGES REQUESTED` markers in `pipeline/code-review/by-<reviewer>.md`. A FAIL means the approval count didn't meet `required_approvals` because at least one reviewer wrote CHANGES_REQUESTED with `BLOCKER:` items.

```bash
# 1. Which workstreams need to fix something?
#    devteam next shows the fix steps and the exact --workstream command:
devteam next
#    To read the gate directly, workstreams with changes requested are in:
cat pipeline/gates/stage-05.json | jq '[.changes_requested[].workstream] | unique | sort'
# → ["backend"]
#    Or look at per-workstream gate status:
cat pipeline/gates/stage-05.json | jq '[.workstreams[] | select(.status == "FAIL") | .workstream]'
# → ["backend"]

# 2. Read the BLOCKER items — the per-area gate carries them:
cat pipeline/gates/stage-05.<area>.json | jq '.blockers[]'
# → {"reviewer":"dev-platform","text":"Missing pagination on ListUsersCommand"}
# → {"reviewer":"dev-platform","text":"iam_admin_users stub always emits PASS"}
#
# For gates written before approval-derivation populated blockers[],
# grep the review files as fallback:
# grep -A 2 "BLOCKER:" pipeline/code-review/by-*.md

# 3. Address each BLOCKER. Scoped build re-run — --workstream targets only the
#    affected area (the merger identifies it via changes_requested[].workstream):
devteam stage build --patch --from peer-review --workstream <owning-area> --headless
devteam merge build

# 4. Re-run the build-chain stages.
devteam stage pre-review --headless
devteam stage red-team --headless     # if track includes it; see "QA augmentation" note in Case 1

# 5. Re-run peer-review. The reviewers see the patched diff and the
#    addressed BLOCKER comments; they update their REVIEW: marker.
devteam stage peer-review --headless

# 6. Merge the per-area gates before reading devteam next.
#    Skipping this step leaves the old merged gate on disk — devteam next will
#    report the old blockers even after reviewers have approved the fix.
devteam merge peer-review

# 7. Confirm advance.
devteam next   # expect: ▶️ run-stage qa (stage-06) or next track stage
```

> **Stale-gate trap.** If `devteam next` still shows the same blockers after you
> re-ran peer-review, the likely cause is that `devteam merge peer-review` (step 6)
> was skipped. The per-area gates are updated but the merged `stage-05.json` still
> holds the old findings. Run `devteam merge peer-review` and then `devteam next`
> again — the blockers should be gone.

> **Cross-stage flag.** The merged `stage-05.json` `warnings[]` may contain an entry like `[cross-stage] N red-team item(s) were noted_for_followup at stage-04c`. This means the peer-review blockers were pre-flagged by red-team as deferred items. Consult `stage-04c.json` `noted_for_followup[]` — each item has a `fix` field with the exact resolution. Addressing them there typically resolves the peer-review objection in the same pass.

> **Manual gate clear (Cases 4/5).** If you hand-clear build gate files to force a re-run, you must also delete `pipeline/gates/stage-04a.json`. Stage 4a is the orchestrator-stamped pre-review (lint + tests); without clearing it, the derived invalidation chain (#109 class in `plans/phase-5-state-integrity.md`) treats pre-review as still-passing and the next `devteam next` skips it — which means a code change that re-introduces a lint error silently bypasses the lint gate.

If two rounds of reviews still disagree, that's an [escalation](escalation.md) — `REVIEW-ESCALATED:` lands in context.md and Principal rules.

---

## Case 5: Peer-review (stage-05) FAIL with no objections — quorum miss

A subtler Stage 5 failure: the merged `stage-05.json` is FAIL, `changes_requested[]` is empty, and no `BLOCKER:` line exists anywhere. The cause is a **missing area review** — one of the four areas didn't accumulate enough approvals to reach `required_approvals`, even though every review file that *was* written is APPROVED.

> **Distinguish from Case 4.** The merged `stage-05.json` now carries a `changes_requested[]` array promoted from per-area gates. If that array is non-empty, a reviewer objected — go to Case 4. If `changes_requested` is empty and the status is FAIL, this is a quorum miss — continue here.

### Vocabulary you need first

At Stage 4 (build), `workstreams[]` are the four **implementers** — backend, frontend, platform, qa each produced code, each wrote a gate.

At Stage 5 (peer-review), `workstreams[]` in the merged `stage-05.json` are the four **areas of code being reviewed**, not reviewers. The `status` on each entry is the verdict on *that area's code*, derived from how many non-area reviewers approved it. A FAIL on `workstreams[3]` (`qa`) doesn't mean "the QA reviewer disapproved" — it means "the qa *area* (`src/tests/`) didn't receive its required approvals from non-qa reviewers." See [`concepts.md`](../concepts.md) §Workstream for the full vocabulary.

### How to diagnose

The merged gate is an aggregate; the actual FAIL lives in the per-area gate.

**Before reading any gate as authoritative, sync it from the review files.** The
`approval-derivation` hook fires only when a file is written inside an active Claude
Code session — if review files were written in a prior session (or by a host that
wasn't running the hook), the per-area gates may not reflect what's in the markdown.
This is the single most common source of false quorum misses.

```bash
# 0. Sync all per-area gates from the current review files.
#    Safe to run at any time — idempotent, append-only.
devteam derive-approvals
```

Then read the gate state:

```bash
# 1. Which area is FAIL?
cat pipeline/gates/stage-05.json | jq '.workstreams'

# 2. Open the per-area gate for that area.
cat pipeline/gates/stage-05.<area>.json \
  | jq '{status, approvals, required_approvals, changes_requested, failure_reason, action_required}'
# Expect to see on a quorum miss:
#   status: "FAIL"
#   approvals: ["dev-backend"]         ← only one
#   required_approvals: 2
#   changes_requested: []              ← nobody objected
#   failure_reason: "INSUFFICIENT_APPROVALS"
#   action_required: "Need 1 more approval(s). Run 'devteam derive-approvals'…
#                     Eligible reviewers: [dev-frontend, dev-platform, dev-qa]."
```

The `failure_reason` field distinguishes a quorum miss (`INSUFFICIENT_APPROVALS`) from a
reviewer objection (`CHANGES_REQUESTED`) without requiring you to read the review files.
`action_required` lists exactly how many more approvals are needed and which reviewers are
eligible.

If `changes_requested` is empty and `approvals.length < required_approvals`, this is a
**quorum miss with no objections**. The matrix (in `rules/stage-05.md`) excludes
self-reviews — the hook skips any `## Review of <area>` section in the reviewer's own
file and emits a warning to stderr (`WARN: self-review skipped`). That warning is
expected and non-blocking; it just means that approval doesn't count toward quorum.

```bash
# 3. Confirm by grepping the reviewer files — after running devteam derive-approvals.
grep -rn "^## Review of <area>" pipeline/code-review/by-*.md
# Count non-area-owner matches. If fewer than required_approvals → quorum miss confirmed.
```

### Two stage manager paths

**Legitimate: add the missing area review.** Check `rules/stage-05.md` for the
matrix assignment table — it shows exactly which areas each reviewer is assigned to
cover. Pick a reviewer whose assignment includes the failing area (or who hasn't yet
written a section for it) and append a `## Review of <area>` section to their existing
review file. The review should be substantive — read the area's source files and PR
summary, not a rubber stamp.

```bash
# 1. Append to an existing review file for an eligible reviewer.
#    See rules/stage-05.md for the matrix assignment (who reviews which areas).
cat <<'EOF' >> pipeline/code-review/by-<reviewer>.md

## Review of <area>

<2-3 sentences of substantive review against the relevant ACs and design-spec sections.
The audit trail should show a real read of the area, not a rubber stamp.>

REVIEW: APPROVED
EOF

# 2. Re-derive all per-area gates.
#    Using no argument re-processes every by-*.md file — safer than a single-file
#    run when multiple review files may have been updated since the last derive.
devteam derive-approvals

# 3. Confirm the gate flipped to PASS.
cat pipeline/gates/stage-05.<area>.json | jq '{status, approvals, failure_reason}'
# Expect: status "PASS", approvals length >= required_approvals, no failure_reason

# 4. Re-merge the per-area gates into the merged stage gate, then advance.
devteam merge peer-review
devteam next   # expect: ▶️ run-stage qa (stage-06) or next track-stage
```

#### Why step 2 is needed: the host-lifecycle constraint

The `approval-derivation` hook is registered as a Claude Code `PostToolUse` hook (`hosts/claude-code/adapter.js:230`). It fires when an **agent inside an active Claude Code session** uses the `Write` or `Edit` tool on a review file — that's how a peer-review subagent's `REVIEW: APPROVED` marker reaches the per-area gate during a normal stage run.

A shell `cat >>`, an editor save (vim, VS Code outside Claude Code, etc.), or any write that doesn't go through the Claude Code tool-call lifecycle bypasses the hook entirely. `devteam derive-approvals` is the explicit stage manager path that invokes the same hook (same code, same gate shape, same lock + atomic-write semantics) with a synthetic PostToolUse payload — it's what closes the gap when the review file was edited outside a host session.

It's also useful when:
- You hand-corrected a typo in a `## Review of <area>` heading and want the gate to reflect the fix.
- You bulk-edited several `by-*.md` files (`devteam derive-approvals` with no argument processes every one).
- The hook errored mid-run and you want to recover from a known-good review-file state.

**Override: hand-edit the merged gate to WARN.** Faster, but only defensible when the warnings carry no `BLOCKER:` content and the missing review wouldn't realistically have flipped any decision. Document the deferral in `pipeline/context.md` so the retrospective sees it.

```bash
# 1. Edit pipeline/gates/stage-05.json:
#    "status": "FAIL"  →  "status": "WARN"
#    Leave warnings[] and workstreams[] untouched — that's the audit record.

# 2. Document the deferral
cat <<'EOF' >> pipeline/context.md

## Deferred follow-ups

- **stage-05 <area> quorum** — Only 1 of 2 required approvals on <area>.
  Merged gate manually overridden to WARN because the open warnings are
  non-blocking SUGGESTIONs and no reviewer wrote CHANGES_REQUESTED.
  Filed as TICKET-XXX. Per docs/runbooks/escalation.md § 4b (defer path).
EOF

# 3. Advance
devteam validate   # gate is still valid; WARN advances
devteam next
```

> **Manual gate clear (Cases 4/5).** If you hand-clear build gate files to force a re-run (e.g. for the code-changes path in a quorum-miss fix), you must also delete `pipeline/gates/stage-04a.json`. Stage 4a is the orchestrator-stamped pre-review; without clearing it, the derived invalidation chain (#109 class) treats pre-review as still-passing and the next run silently skips the lint gate.

**Critical caveat with the override path.** If you (or any process) later runs `devteam merge peer-review`, the merge re-derives FAIL from the still-FAILing per-area gate and your override is lost. The hook does NOT overwrite the merged gate (it only writes per-area gates), so as long as nobody re-merges, the WARN sticks. If you want the override to survive a re-merge, you must also hand-edit the per-area gate's status (and accept that the hook will overwrite it the next time anyone saves a review file).

### Worked example: qa area, 1-of-2 approvals, no objections

Real run, full track, multi-area diff. The merged gate looked like:

```json
{
  "stage": "stage-05",
  "status": "FAIL",
  "workstreams": [
    { "workstream": "backend",  "status": "PASS" },
    { "workstream": "frontend", "status": "PASS" },
    { "workstream": "platform", "status": "PASS" },
    { "workstream": "qa",       "status": "FAIL" }
  ]
}
```

The per-area gate (after running `devteam derive-approvals`) showed:

```json
{
  "stage": "stage-05", "workstream": "qa", "area": "qa",
  "status": "FAIL",
  "review_shape": "matrix", "required_approvals": 2,
  "approvals": ["dev-platform"],
  "changes_requested": [],
  "blockers": [],
  "warnings": ["…SUGGESTION:…", "…SUGGESTION:…"],
  "failure_reason": "INSUFFICIENT_APPROVALS",
  "action_required": "Need 1 more approval(s). … Eligible reviewers: [dev-backend, dev-frontend, dev-qa]."
}
```

`dev-platform` wrote `## Review of qa` with `REVIEW: APPROVED`. The qa reviewer's own
file doesn't count (matrix excludes self-reviews; hook emits `WARN: self-review skipped`
and continues). Per `rules/stage-05.md`, the qa area is assigned to `dev-backend` and
`dev-frontend` — neither had written a qa section. Pure quorum miss; nothing wrong with
the code. The `action_required` field confirmed exactly which reviewers were eligible.

Fixed by appending a `## Review of qa` section to `by-frontend.md` with a substantive
review of `src/tests/` against the relevant ACs and `REVIEW: APPROVED`, then running
`devteam derive-approvals` (no-arg form, to catch any other stale approvals at the same
time). The gate flipped to PASS; `devteam merge peer-review` rebuilt the merged gate;
`devteam next` advanced to stage-06.

The SUGGESTION items in `warnings[]` carried through to the merged gate as warnings,
where the retrospective will see them. SUGGESTIONs are deferred follow-ups, not
merge-blockers — that's the convention (see [`conventions.md`](../conventions.md)).

---

## Case 12: License-gate (stage-04a) FAIL — `license_check_passed: false`

Stage 4a records `license_check_passed: false` when the SCA/license runner finds a dependency
whose license is not on the project allowlist. This is **not** a code-defect fix — the build
agent cannot write code to change a dependency's license.

```bash
# 1. Read the findings
cat pipeline/gates/stage-04a.json | jq '.license_findings[]'
# → { "package": "@img/sharp-libvips-darwin-arm64", "license": "LGPL-3.0-or-later", "policy": "denied" }
```

**First: trace the dependency chain.**

The denied package is often not a direct dependency — it's a transitive optional native binary
that was installed alongside a higher-level package (e.g. `sharp`, `canvas`, `better-sqlite3`).
The parent package may be MIT-licensed; only its optional native layer carries the LGPL/GPL identifier.

```bash
# Identify which direct dep pulled it in:
npm ls <denied-package-name>
# e.g. npm ls @img/sharp-libvips-darwin-arm64
# → reveals the chain: your-project → some-parent → sharp → @img/sharp-libvips-darwin-arm64

# If it's an optional transitive dep, prune it without removing the parent:
npm install --omit=optional
# or add to .npmrc:  omit=optional
# then re-run npm install and verify node_modules no longer contains it
```

If the parent package is genuinely needed and `sharp` (or equivalent) is its optional native
accelerator, drop the parent in favour of an alternative that doesn't pull in LGPL native
binaries — or take Path B below.

**Two resolution paths — neither is `--patch`:**

**Path A — replace the dependency.** Find an alternative library with a compatible license.
Update the build manifests (e.g. `package.json`, `requirements.txt`) to use the replacement,
then re-run build and pre-review normally.

**Path B — update the allowlist policy.** If the dependency's license is acceptable for the
project, a human with policy authority must add it to the allowlist (the allowlist location is
host-specific; check `.devteam/config.yml` or `rules/stage-04a.md` for the path). This is an
org-level decision — not a `--patch` code fix and not something the build agent can do.

```bash
# After taking Path A or Path B:
devteam stage build --workstream <owning-area> --headless   # if code changed (Path A)
devteam merge build
devteam stage pre-review --headless
devteam next
```

---

## Case 13: Tool-budget denial

The build agent was denied a tool call it attempted. Two distinct shapes:

**Shape A — native tool-budget denial (claude-code host).** The host enforced the role's
declared tool budget from `core/roles.js`, rendered as the subagent's `tools:` frontmatter.
Claude Code refused the tool call at the boundary; the workstream gate records `dispatched_tool_budget`
showing what was permitted. The agent's reasoning or a task in `pipeline/logs/` may reference a
permission error.

You'll see this in `devteam log` as a tool refusal, not a FAIL gate — the workstream may exit
cleanly with a PASS gate that under-delivers, or with a WARN that names the skipped action.

→ Read `pipeline/logs/<workstream>.log` and the `dispatched_tool_budget` field. If the denied
tool is legitimately needed for the role, the budget is misconfigured — open a discussion (or
ADR) rather than hacking around the constraint.

**Shape B — advisory non-compliance (non-native host, prompt-only budget).** For codex,
gemini-cli, or generic hosts, tool budgets are declared in the dispatch prompt but not
enforced at the tool-call boundary. A non-compliant model that ignores the instruction still
executes the call. Evidence in the gate: `dispatched_tool_budget` lists the budget; the
workstream may have written to a path outside `allowedWrites` (caught by the C1 write-audit
post-hoc check).

→ The write-audit (`devteam consistency analyze` or the validator) will surface the violation.
If the out-of-scope write is harmful, revert it and re-run the workstream. The longer-term fix
is routing the role to a native-budget host (claude-code) or accepting the enforcement
degradation (see `ADR-004 §2 Cross-host degradation`).

---

## Common gotchas

- **`--patch` without `--from`** defaults to `red-team`. Fine in the common case; explicit `--from <stage>` is clearer.
- **`--from` accepts both friendly name and gate id.** `--from red-team` and `--from stage-04c` are equivalent.
- **The non-target workstreams will re-render and exit fast.** When you run `devteam stage build --patch --from red-team --headless` (without `--skip-completed`), all four build workstreams re-dispatch. The three not implicated by the patch items write quick PASS gates with PR summaries saying "no relevant items in scope." This costs wall-clock time but is correct.
- **Don't hand-edit gate status to PASS.** Orchestrator-stamped verification (stage-04a, stage-06) will re-stamp on next validate and flip you back. The right way to override an automated decision is the [escalation runbook](escalation.md) → Principal ruling.
- **Stage 5 is the exception — and only for quorum misses, not objections.** The merged `stage-05.json` is *not* orchestrator-stamped, so you can hand-edit it (Case 5, the override path). But the `approval-derivation` hook will overwrite per-area gates (`stage-05.<area>.json`) on any review-file save *from inside Claude Code*, and a subsequent `devteam merge peer-review` will re-derive the merged gate from those per-area gates. The override sticks only if neither happens. Adding the missing area review (and running `devteam derive-approvals`) is the durable fix.
- **Editor saves don't fire the approval-derivation hook.** The hook is registered as a Claude Code `PostToolUse Write|Edit` event — it fires when an agent uses the `Write` or `Edit` tool inside an active session, not when you save the file from vim, VS Code outside Claude Code, or `cat >>` from your shell. After any manual edit to `pipeline/code-review/by-*.md`, run `devteam derive-approvals [<file>]` to update the per-area gates. Without an argument it processes every review file under `pipeline/code-review/`.
- **`devteam log --follow`** in a second pane is the right way to watch a multi-step re-run. You'll see each gate land in chronological order.

---

## Case 6: PM sign-off (stage-07) FAIL — `delta_items` non-empty

Stage 7 is different from all other FAIL cases: the PM has read the test report
and brief, and found that one or more acceptance criteria are not met or not
verified. `pm_signoff` is `false` and `delta_items[]` lists what's missing.

```bash
# 1. Read the delta items
cat pipeline/gates/stage-07.json | jq '.delta_items[]'
# e.g. "AC-8: credential failure exits 0 instead of 1 per the brief"
#      "AC-3: report.md missing the ## CC4.1 section"
```

Unlike red-team or QA failures, delta items are prose — there's no automatic
`affected_workstreams` derived from file paths. Read each item and match it
against the `files_written[]` arrays in the build workstream gates to identify
which agent owns the gap. The same fallback one-liner from Case 1 applies if
the responsible file is mentioned in the delta item text.

```bash
# 2. Patch build — constrained to delta items only.
#    --from stage-07 reads delta_items[] and injects them into the build prompt.
#    --workstream <role> dispatches only the owning workstream (no gate deletion needed).
devteam stage build --patch --from stage-07 --workstream backend --headless   # adjust role as needed
devteam merge build

# 4. Re-run the full post-build chain. PM will re-read the test report and
#    brief in the new stage-07 invocation; every intermediate gate must be fresh.
devteam stage pre-review --headless
devteam stage red-team --headless         # if track includes it
devteam stage peer-review --headless      # reviewers re-confirm delta items addressed
devteam stage qa --headless               # re-run tests; delta items often affect AC coverage
devteam stage sign-off --headless         # PM re-reviews

# 5. Confirm advance
devteam next
```

**When re-running QA is optional.** Skip step 4's QA re-run only if the delta
items are purely documentation gaps (a missing section in `report.md`, an
incomplete `## Verify` block) and the test suite itself doesn't change. If any
delta item touches observable behavior (exit codes, output format, a criterion
not exercised by a test), QA must re-run.

**`delta_items` don't have workstream attribution yet.** This is a known gap —
`delta_items[]` are prose strings, unlike red-team's structured findings.
A future improvement would give each item a `file` and `workstream` field,
enabling the same `jq .affected_workstreams` shortcut available in other cases.
Until then, read the items and identify the owning workstream manually.

---

## Case 7: Accessibility audit (stage-06b) FAIL — `blockers[]` non-empty

Stage 6b (`pipeline/gates/stage-06b.json`) runs the accessibility audit. The fix-recipe
(`core/pipeline/fix-recipes.js`) routes the fix across **three paths**, tried in order.
**Read the recipe output from `devteam next` before deciding how to proceed** — it tells
you which path applies.

```bash
# See which path devteam next is recommending
devteam next
# Also read the gate to understand the blockers
cat pipeline/gates/stage-06b.json | jq '{status, blockers, affected_workstreams}'
```

---

### Path 1 — Prior-stage pre-staged A11Y fix IDs

If an upstream gate (e.g. a QA build gate) has a `noted_for_followup[]` entry with an
`A11Y-*` or `a11y`/`aria`/`wcag`-matching ID, `devteam advise` already knows about the
fix. The recipe dispatches it directly:

```bash
devteam advise --apply A11Y-S-01=A,A11Y-S-02=A
# Stagecraft applies the ARIA/HTML fix and re-runs the audit internally.
```

`devteam next` will print the exact `--apply` argument. You do not need to clear any
gate — the advise dispatch handles it.

---

### Path 2 — A11Y blockers in the gate, no prior-stage fix IDs

The audit found violations but no upstream gate pre-staged a fix. The recipe clears the
responsible build workstream gate(s) and rebuilds. Workstream attribution comes from
`assigned_to`/`workstream` fields on the blockers (provenance-first); falls back to
file-path regex if those fields are absent.

```bash
# devteam next prints the exact sequence; manually it is:
# 1. Clear stale build gate(s) and audit gate (recipe-derived list)
node -e "require('node:fs').rmSync(process.argv[1], { force: true })" pipeline/gates/stage-04.<ws>.json
node -e "require('node:fs').rmSync(process.argv[1], { force: true })" pipeline/gates/stage-04.json
node -e "require('node:fs').rmSync(process.argv[1], { force: true })" pipeline/gates/stage-06b.json

# 2. Re-run build with accessibility fix context
devteam stage build --workstream <ws> --patch --from accessibility-audit --skip-completed --headless
# (or without --workstream if multiple workstreams are implicated)
devteam merge build

# 3. Re-run accessibility audit
devteam stage accessibility-audit --headless

# 4. Advance
devteam next
```

> **Re-review required.** Because source code changed, the derived invalidation chain
> also clears `stage-04a.json` (pre-review), `stage-05.json` (peer-review), and any
> attestation stages between build and 6b that exist on disk. `devteam next` will step
> through them before reaching the audit again.

---

### Path 3 — No A11Y blockers in the gate

The gate is FAIL but has no blockers matching the A11Y pattern — unusual; typically means
the audit runner encountered an error or the gate was partially written. Show the panel:

```bash
devteam advise
# Select option A for each A11Y_FIX item to dispatch the automated fixer.
```

---

### ARIA attribute reference (for Path 2 manual fixes)

| Blocker text | Fix |
|---|---|
| `lacks role="alert" or aria-live` | Add `role="alert"` to the element. `role="alert"` is preferred over `aria-live="assertive"` for error messages — it is semantically more precise and implicitly sets `aria-live="assertive"`. |
| `lacks aria-live="polite"` | Add `aria-live="polite"` to the element. Use `polite` for results or status regions that update after user action; use `assertive` (or `role="alert"`) only for errors that interrupt the current task. |
| `lacks aria-label or aria-labelledby` | Add a visible `<label>` element associated via `for`/`id`, or add `aria-label="…"` directly to the element. |
| `missing role on interactive element` | Add the named ARIA role to the element, or replace the element with its native semantic HTML equivalent (a `<button>` instead of a `<div role="button">`). |

> **ARIA attributes vs structural changes.** Pure ARIA attribute additions (`role="alert"`,
> `aria-live`, `aria-label`) don't affect backend logic or test assertions — Path 2's scoped
> re-run (frontend workstream only) is sufficient. If the fix requires new HTML elements,
> changed IDs, or a changed interaction model (e.g. `<div>` → `<button>`), the recipe's
> derived invalidation will already include those downstream gates.

---

## Case 8: Consistency drift — `devteam consistency analyze` exits non-zero

`devteam consistency analyze` walks the full artifact chain — brief → spec →
`pr-*.md §Verify` → red-team `must_address` → test-report → gate field reality
— and exits non-zero when any link in that chain disagrees. This can fire
during pre-review (Stage 4a), as a CI check, or when run manually.

```bash
# 1. See what drifted
devteam consistency analyze --json
# or, for human-readable output:
devteam consistency analyze
```

The output names the artifact pair that disagrees and the specific element that
drifted. The source-of-truth hierarchy for resolving conflicts:

```
pipeline/brief.md  (highest — the contract)
  ↓
pipeline/spec.feature  (generated from brief; defer to brief if they conflict)
  ↓
pipeline/pr-*.md  (describes what was built; must match spec)
  ↓
pipeline/test-report.md  (must match brief's ACs; brief wins on conflict)
  ↓
gate field reality  (must match test-report; test-report wins on conflict)
```

**Brief drifted from spec** — the PM amended an AC after the spec was
scaffolded. Fix: re-run `devteam spec generate` to rebuild the spec from the
updated brief, then check `devteam spec verify`. If the spec changes materially,
QA tests that mapped to the changed AC need re-verification.

**PR summary drifted from spec** — a workstream's `pr-*.md §Verify` claims to
satisfy an AC that the spec lists differently. Fix: identify the owning
workstream from the PR filename, clear that workstream's build gate, re-run
with `--patch --from stage-04a` to constrain the agent to only the drifted AC.

**Test-report drifted from brief** — an AC has no test row, or a test row
references an AC ID that doesn't exist in the brief. Fix: clear `stage-06.json`,
re-run QA (`devteam stage qa --headless`). If the brief's AC was removed or
renumbered, QA needs to update its test mapping.

**Gate reality drifted from test-report** — the orchestrator-stamped fields
disagree with what the agent claimed (e.g. `all_acceptance_criteria_met: true`
but an AC row is missing from `test-report.md`). Fix: run
`devteam verify stage-06` — the orchestrator re-stamps the gate from the actual
test output. If the stamp flips the status to FAIL, treat as a normal Case 2
(QA FAIL).

```bash
# After any artifact fix, re-run consistency check to confirm clean:
devteam consistency analyze
# → exit 0: drift resolved
# → exit non-zero: additional drift found — repeat per type above
```

---

## After resolution

`devteam next` advances past the failing stage. The auto-injected blocker section in `context.md` is gone (stripped by the validator on PASS/WARN). The audit trail in `pipeline/gates/` shows the failed gate, the patched re-run, and the eventual PASS — the full history is on disk for the retrospective and any future audit.

## Case 9: Verification-beyond-tests (stage-06d) FAIL — `blocking_findings[]` non-empty

Stage 6d runs property-based testing (Hypothesis/fast-check/PropTest), mutation testing (Stryker/mutmut/mull), and/or formal verification (TLA+/Alloy/Lean) against the changed code. `blocking_findings[]` in the gate is non-empty; those are counterexamples or surviving mutants that must be addressed before advancing.

### Diagnosis

```bash
# 1. Read what the verifier found
devteam next --json   # action, blockers[], fix_steps[]
cat pipeline/gates/stage-06d.json | jq '{status, blocking_findings, methods_attempted}'

# 2. Each blocking_finding has: method, description, counterexample/mutant_id, fix_hint
cat pipeline/gates/stage-06d.json | jq '.blocking_findings[]'
```

**What each finding type means:**

| `method` | What it found | What you must fix |
|---|---|---|
| `property` | A Hypothesis/fast-check counterexample that falsified a stated invariant | Fix the production code so the property holds for all inputs — or, if the property was wrong, correct the property and document why |
| `mutation` | A surviving mutant — a deliberate logic error the test suite did not catch | Strengthen the existing test to kill the mutant (add an assertion on the case the mutant exploits), OR fix a real bug the mutant exposed |
| `formal` | A TLA+/Alloy counterexample to a safety property | Fix the implementation or tighten the spec; do not dismiss — formal counterexamples are precise |

**Reading a property counterexample.** The `counterexample` field contains the minimal failing input Hypothesis shrank to. Apply it directly:
```python
# Hypothesis counterexample: model='"' → {"model":"""} (JSONDecodeError)
# Means: call your function with that input and observe the bug
```
The bug is real; the framework verified it reproduces. Fix the production code — the property test itself is the regression.

### Fix

The fix is in the **backend** workstream (or whichever workstream owns the file named in `fix_hint`). This is not a gate-editing exercise:

```bash
# 1. Apply the fix to production code
# (edit the file named in fix_hint — the gate's counterexample + fix_hint points exactly there)

# 2. Delete the FAIL gate so the stage can be re-run
node -e "require('node:fs').rmSync(process.argv[1], { force: true })" pipeline/gates/stage-06d.json

# 3. Also delete the backend build gate if the change is in src/backend/ — it was
#    produced before the fix; its content claims represent pre-fix code
node -e "require('node:fs').rmSync(process.argv[1], { force: true })" pipeline/gates/stage-04.backend.json

# 4. Re-run verification-beyond-tests; the verifier re-runs the property/mutation
#    suite against the fixed code
devteam stage verification-beyond-tests --headless

# 5. If any blocking_findings[] remain, repeat from step 1
devteam next --json
```

**If the property itself was wrong** (not the code): correct the property in the relevant test file, document the invariant you replaced it with in a `# VBT-N: ...` comment, delete the gate, and re-run. The gate MUST reach PASS — do not hand-edit `blocking_findings` to empty.

### Re-run sequence

```bash
node -e "require('node:fs').rmSync(process.argv[1], { force: true })" pipeline/gates/stage-06d.json
devteam stage verification-beyond-tests --headless
devteam next
```

If the verifier skipped a method with `attempted_but_blocked` (tool not installed), it won't re-run that method — that's expected. The stage can PASS with some methods skipped as long as `blocking_findings` is empty and `methods_skipped[].reason` is substantive (not "didn't have time").

### Verification of PASS

```bash
cat pipeline/gates/stage-06d.json | jq '{status, blocking_findings, methods_attempted, methods_skipped}'
# status: "PASS"
# blocking_findings: []
# methods_attempted: ["property"]   (or mutation, formal — whatever ran)
```

### What not to do

- **Do not edit `blocking_findings` to `[]`** — the orchestrator-stamped gate will reflect what the verifier actually produced when re-run. Hand-editing only a FAIL gate to PASS is caught by `devteam consistency analyze` (gate-vs-artifact check) and will surface as drift.
- **Do not dismiss a formal counterexample** as "theoretically possible but won't happen in prod." Formal methods found an invariant violation — it is a bug.
- **Surviving mutants point to missing assertions, not to adding more tests.** The question is always "what assertion on existing behavior did I forget?" not "should I add a new test function?"

---

## Case 10: Preflight (stage-04e) FAIL — committed ignored files or broken import path

`devteam stage peer-review` auto-runs preflight (stage-04e) before dispatching reviewers. If preflight is FAIL the command exits immediately with the blockers printed to stderr. This is the gate that caught what peer reviewers would otherwise flag as BLOCKERs in the next stage.

### Diagnosis

```bash
# The stage peer-review command already printed the blockers to stderr.
# Read the full gate for the structured form:
cat pipeline/gates/stage-04e.json | jq '{status, blockers, git_hygiene_pass, import_path_pass, deferred_items_count}'
```

There are two blocker shapes:

**A. `git_hygiene_pass: false` — committed-but-ignored files**

```bash
# Which files are committed but now gitignored?
git ls-files --ignored --exclude-standard
# Typical output: src/backend/__pycache__/main.cpython-312.pyc
#                 src/backend/__pycache__/
```

**B. `import_path_pass: false` — broken test import path**

```bash
# Which conftest.py has the bad sys.path.insert?
grep -rn 'sys\.path\.insert(0, ".")' src/tests/ tests/ conftest.py 2>/dev/null
# Typical output: src/tests/conftest.py:9: sys.path.insert(0, ".")
```

### Fix A — remove committed ignored files

```bash
# 1. List committed-but-ignored files
FILES=$(git ls-files --ignored --exclude-standard)

# 2. Remove from git index (not from disk)
git rm --cached $FILES

# 3. Verify .gitignore covers them
echo "$FILES" | git check-ignore --stdin --verbose

# 4. Commit the removal
git add .gitignore   # if you just added the rule
git commit -m "chore: remove committed ignored files from git index"
```

If the files shouldn't exist at all (compiled artifacts, temp files):
```bash
# Also delete from disk
git rm -rf $FILES
git commit -m "chore: remove compiled artifacts"
```

### Fix B — correct the test import path

The pattern `sys.path.insert(0, ".")` inserts the project root, where there is no `backend/` package. The real backend is at `src/backend/`, so `src/` must be on `sys.path`.

```bash
# In src/tests/conftest.py (or wherever the bad line is):
# BEFORE: sys.path.insert(0, ".")
# AFTER:  sys.path.insert(0, "src")
```

After the fix, verify the import resolves:
```bash
cd <project-root>
python3 -c "import sys; sys.path.insert(0, 'src'); from backend.main import app; print('OK')"
```

### Re-run preflight and peer-review

```bash
# After fixing the blocker(s):
devteam preflight          # confirm PASS
devteam stage peer-review  # auto-skips preflight (stage-04e.json already PASS)
```

### Worked example: token-estimator demo

Real run. `devteam stage peer-review` printed:
```
[devteam] running preflight checks (stage-04e) before peer-review…
[devteam] preflight FAIL — 1 blocker(s) must be fixed before peer-review:
  BLOCKER: src/tests/conftest.py:9: sys.path.insert(0, ".") inserts the project root, not src/ …
           Fix: change to sys.path.insert(0, "src") so imports resolve to production code.
```

One-line fix in `conftest.py`. Then:
```bash
devteam preflight
# [preflight] PASS — all checks clean (1 warning(s))
# WARN: 7 red-team item(s) were noted_for_followup at stage-04c (RT-01, RT-02, …).
#       Peer reviewers often flag these as blockers. Inspect stage-04c.json and address
#       them before dispatching reviewers, or accept that they will appear in CHANGES REQUESTED.

devteam stage peer-review --headless
```

The warning about `noted_for_followup` items is informational — it means some red-team deferred items will likely come up in peer-review. Run `devteam advise` to classify each item and encode your decision before dispatching reviewers (see [Case 11](#case-11-advise-workflow--triage-follow-up-items-before-downstream-stages)). Leaving them unaddressed means reviewers will flag them as CHANGES_REQUESTED and you'll go through Case 4.

### What the preflight gate looks like on PASS

```json
{
  "stage": "stage-04e",
  "status": "PASS",
  "orchestrator": "devteam@preflight",
  "blockers": [],
  "warnings": ["7 red-team item(s) were noted_for_followup at stage-04c …"],
  "git_hygiene_pass": true,
  "import_path_pass": true,
  "deferred_items_count": 7
}
```

For the broader vocabulary (`BLOCKER:`, `## Verify`, `PRINCIPAL-RULING:`, etc.), see [`docs/conventions.md`](../conventions.md).

For escalation-shaped halts (`ESCALATE`, vetoes, decision_needed), see [`escalation.md`](escalation.md).

For deferred items that didn't block the pipeline but need tickets, see [`open-followups.md`](open-followups.md) — `jq .open_followups pipeline/gates/stage-09.json` is the starting point.

---

## Case 11: Advise workflow — triage follow-up items before downstream stages

This is not a `fix-and-retry` case — no gate is FAIL. It is a **decision workflow** for
`noted_for_followup[]` items from red-team, build QA, or peer-review that are non-blocking
now but will cause churn later if left unaddressed.

**When to run it:** after red-team PASS/WARN and before QA augmentation or peer-review.
Also valid after any stage that emits a `⚠` advisory from `devteam next`.

### Step 1 — View unresolved items

```bash
devteam advise
```

Output:

```
Follow-up items in completed stage gates:

  AC-11 — Docker live-path testing  [stage-04.qa]
    Risk: QA BLOCKER — no @AC-11 scenario in spec.feature
    Options:
      [A] scaffold   — dispatch QA to add a @wip test stub   ← recommended
      [B] defer      — mark DEFERRED in pipeline/context.md (--apply AC-11=B:PROJ-XYZ)
      [C] amend      — flag for PM to remove AC-11 from the brief
      [D] nothing    — advance; QA will block

  RT-01 — auth check missing on POST /estimate  [stage-04c.json]
    Risk: PEER-REVIEW RISK — severity high, no AC ref
    Options:
      [A] defer      — acknowledge in pipeline/context.md  ← recommended
      [B] nothing    — advance; red-team item may appear in CHANGES_REQUESTED
      [C] amend      — flag for PM to scope-down the related requirement

Apply: devteam advise --apply AC-11=A,RT-01=A
```

### Step 2 — Apply decisions

```bash
devteam advise --apply AC-11=B:PROJ-99,RT-01=A,AC-12=B
#   AC-11 → DEFERRED: AC-11 — ticket PROJ-99  (written to context.md)
#   RT-01 → NOTED: RT-01 — stage manager: no action
#   AC-12 → KNOWN-FLAKY: AC-12
```

For `scaffold` (option A on a QA_BLOCKER): the command prints the dispatch command but does not run it automatically. Copy and run it:

```bash
devteam advise --apply AC-11=A
# ✓ AC-11 — scaffold
#   Scaffold commands to run:
#     $ devteam stage build --workstream qa --patch --skip-preflight
```

### Step 3 — Confirm all addressed

```bash
devteam advise
# [advise] All follow-up items addressed.

devteam next
# ▶️  run-stage  pre-review (stage-04a)   ← no ⚠ warning
```

### Option reference

| Option letter | Action | Marker written | Effect downstream |
|---|---|---|---|
| `=A` (on QA_BLOCKER) | scaffold | `SCAFFOLD-PENDING:` | Run the printed dispatch command; QA sees the test when it re-runs |
| `=B:TICKET` | defer | `DEFERRED: AC-N — ticket TICKET` | QA skips coverage check for this AC; retrospective records the deferral |
| `=C` | amend | `BRIEF-AMEND-NEEDED:` | PM reads and amends brief at next stage where PM reads context.md |
| `=D` | nothing | `NOTED: … stage manager: no action` | Acknowledged; no downstream adjustment |
| `=A` (on QA_NOISE) | nothing | `NOTED: … stage manager: no action` | Acknowledged |
| `=B` (on QA_NOISE) | known-flaky | `KNOWN-FLAKY:` | QA retries once before counting as FAIL |

### Worked example

Token-estimator build gate has three noted items after build passes:

```bash
devteam advise --apply AC-11=A,AC-10=B:PROJ-99,AC-12=B
# ✓ AC-11 — scaffold (run: devteam stage build --workstream qa --patch --skip-preflight)
# ✓ AC-10 — DEFERRED: AC-10 — ticket PROJ-99
# ✓ AC-12 — KNOWN-FLAKY: AC-12

devteam advise    # All follow-up items addressed.
devteam next      # ▶️  run-stage  pre-review (stage-04a)
```

QA later runs and sees `DEFERRED: AC-10` in context.md — skips the AC-10 coverage check.
It also sees `KNOWN-FLAKY: AC-12` — retries AC-12's test once before counting a failure.
AC-11's test scaffold (committed by the qa workstream after the dispatch) gives QA a real
test to pass.

For Stage 8 (deploy) failures, see [`deploy-failure.md`](deploy-failure.md) — covers failure classification, adapter-specific diagnostics, and the rollback procedure.

For the chronological narrative across all this, `devteam log --follow`.
