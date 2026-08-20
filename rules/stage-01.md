# Stage 1 — PM Brief (Requirements)

Invoke: `pm` agent.
Input: feature request / ticket description.
Output: `pipeline/brief.md`.

Sections required for all tracks: §1 Problem, §2 Stories, §3 Acceptance Criteria,
§4 Out of Scope, §5 Open Questions. Full and hotfix tracks additionally require
§6–§11 (Rollback, Feature Flag, Data Migration, Observability, SLO, Cost).
Quick, config-only, dep-update tracks: §1–§5 plus either §6–§11 or a single
`## Risk notes` line for trivial changes.

See `templates/brief-template.md` for the canonical blank form;
`docs/brief-template.md` is the section-by-section annotation guide.

## Gate

Gate file: `pipeline/gates/stage-01.json`.

```json
{
  "stage": "stage-01",
  "status": "PASS",
  "track": "full",
  "timestamp": "<ISO 8601>",
  "orchestrator": "devteam@<version>",
  "blockers": [],
  "warnings": [],
  "acceptance_criteria_count": 5,
  "out_of_scope_items": [],
  "required_sections_complete": true,
  "active_roles": null,
  "affected_files": []
}
```

`required_sections_complete` must be `true` only when the brief contains all
sections required for its track (see track rules above). `acceptance_criteria_count`
is the number of numbered AC items in §3.

### Documentation-only ownership

A documentation-only `loop` change may select the optional documentation
workstream by setting `active_roles` to exactly `["documentation"]` and
`affected_files` to a non-empty list of exact, canonical, repo-relative
documentation files. The list is the shared build/QA/review authority boundary.
Directories, globs, absolute paths, parent traversal, duplicates, pipeline
artifacts, non-documentation files, and mixed documentation/code roles are
invalid. Expanding the list requires a recorded brief/gate update or Principal
ruling and retry; discovering another document never widens scope implicitly.
