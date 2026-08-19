# Stage 7 — PM Sign-off

Invoke: `pm` agent
Input: `pipeline/test-report.md` + `pipeline/brief.md`
Output: sign-off appended to `pipeline/gates/stage-07.json`
Gate key: `"pm_signoff": true`

On NO: PM writes delta list. Return to Stage 4 with delta items only.
Delta items must not trigger a full pipeline rerun — scope them explicitly.

## Documentation gate

Before signing off, the PM must classify whether the change touches a **user-visible surface** and confirm that documentation has been updated or explicitly waived.

**Surface type → required action:**

| Changed surface | Required doc action |
|---|---|
| CLI flag, config key, API endpoint | Update the relevant reference doc (README, `docs/reference/cli.md`, etc.) |
| User-visible behaviour change | Add a changelog entry (`changelog.d/<slug>.md`) |
| Internal refactor, test, infrastructure | Changelog entry optional; no other doc required |
| Significant design decision | Flag for an ADR at Stage 9 (retrospective) — not a Stage 7 blocker |

**Gate fields:**

- `docs_surface_affected` (bool, required) — `true` if the change touches any CLI flag, config key, API endpoint, or user-visible behaviour; `false` for internal-only changes.
- `docs_updated` (bool, required when `docs_surface_affected: true`) — `true` only when the required doc action above has been completed. A `false` value here is a gate **blocker** and must be listed in `blockers[]`.
- `docs_skipped_reason` (string, required when `docs_surface_affected: false`) — one-line reason why no doc update is needed (e.g. `"internal refactor, no user-visible surface changed"`).

The PM must answer this question even on the auto-fold path (see below). Failing to populate all three fields fails the gate.

## Gate

Gate file: `pipeline/gates/stage-07.json`.

Sign-off dispatches PM and platform as separate workstreams. During merge, the
orchestrator copies `pm_signoff`, `deploy_requested`, the documentation fields,
`open_followups`, and `delta_items` from the PM gate; it copies
`runbook_referenced` plus optional adapter/smoke fields from the platform gate.
The merged gate is Stage 8's authorization input—aggregate PASS alone never
implies permission to deploy.

```json
{
  "stage": "stage-07",
  "status": "PASS",
  "track": "full",
  "timestamp": "<ISO 8601>",
  "orchestrator": "devteam@<version>",
  "blockers": [],
  "warnings": [],
  "pm_signoff": true,
  "deploy_requested": true,
  "runbook_referenced": true,
  "docs_surface_affected": true,
  "docs_updated": true,
  "docs_skipped_reason": null,
  "open_followups": [],
  "delta_items": []
}
```

When no user-visible surface was changed:

```json
{
  "docs_surface_affected": false,
  "docs_updated": null,
  "docs_skipped_reason": "internal refactor, no user-visible surface changed"
}
```

### `open_followups[]` — PM acknowledgment of deferred work

> Stage manager guide for reading this field and creating tickets: [`docs/runbooks/open-followups.md`](../docs/runbooks/open-followups.md)

When the PM agent is invoked, it also reads `noted_for_followup[]` from
`pipeline/gates/stage-04c.json` and `pipeline/gates/stage-04.qa.json` /
`pipeline/gates/stage-06.json`, collecting all object-form entries with
`track_for: "ticket"` that were not resolved during the pipeline run.

These are written into `stage-07.json` as `open_followups[]`. This is an
acknowledgment, not a blocker — the PM does not need to act on them now. The
field creates an explicit audit record that deferred items were seen before
sign-off, and is the primary input for external ticket creation:

```json
{
  "stage": "stage-07",
  "status": "PASS",
  "pm_signoff": true,
  "track": "full",
  "timestamp": "<ISO>",
  "blockers": [],
  "warnings": [],
  "open_followups": [
    {
      "id": "RT-06", "source": "stage-04c",
      "text": "--cloudtrail-days 0 silently falls back to 90 due to falsy guard.",
      "file": "src/cli.js:127", "effort": "XS"
    },
    {
      "id": "RT-08", "source": "stage-04c",
      "text": "No retry logic for transient AWS errors; design-spec §9 requires backoff.",
      "file": "src/backend/collectors/aws-cloudtrail.js", "effort": "S"
    }
  ]
}
```

`open_followups: []` when there are no deferred ticket items.

**Auto-fold behaviour.** The auto-fold path also reads and populates
`open_followups[]` — on that path the orchestrator is the author, but the
field still appears in the gate. The retrospective and any external tooling can
rely on `open_followups` being present in stage-07 regardless of whether the PM
was explicitly invoked.

### Auto-fold from Stage 6

When Stage 6 maps every acceptance criterion 1:1 to a passing test and
sets `"all_acceptance_criteria_met": true`, the orchestrator auto-writes
Stage 7 without invoking the PM:

```json
{
  "stage": "stage-07",
  "status": "PASS",
  "pm_signoff": true,
  "auto_from_stage_06": true,
  "track": "<track>",
  "agent": "orchestrator",
  "timestamp": "<ISO>",
  "blockers": [],
  "warnings": [],
  "open_followups": []
}
```

The auto-fold is skipped (and the PM agent invoked normally) when:

- `"all_acceptance_criteria_met"` is not `true` in Stage 6
- The Stage 6 test report does not have a 1:1 criterion-to-test mapping
  (one test covers multiple criteria, or one criterion has no test)
- The user explicitly requested a manual sign-off
- The track is `hotfix` (hotfixes always require PM sign-off)
- `docs_surface_affected: true` and `docs_updated` is not yet `true` — the PM must confirm the doc update before auto-fold can proceed

Rationale: when criteria are clean, Stage 7 re-derives the same verdict
the platform dev already wrote at Stage 6. PM judgment adds value on
delta items and edge cases, not on rubber-stamping a clean sheet.

On the auto-fold path the orchestrator must still derive and populate
`docs_surface_affected`, `docs_updated`, and `docs_skipped_reason` by
reading the Stage 4 PR summaries and the brief. If a user-visible surface
is detected (`docs_surface_affected: true`) but `docs_updated` cannot be
confirmed from the artifacts, auto-fold is blocked and the PM is invoked.
