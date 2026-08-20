# Stage 2 — Design (Principal)

Invoke: `principal` agent.
Input: `pipeline/brief.md`, org-shared ADR memory.
Output: `pipeline/design-spec.md`, `pipeline/adr/`.

Consult org-shared ADRs from prior projects before drafting. Honor or explicitly
supersede prior commitments. The gate records which ADRs were consulted and
superseded so future audits can verify the architecture didn't silently drift (G8).

See `templates/design-spec-template.md` for the canonical blank form;
`docs/design-spec-template.md` is the annotation guide.

## Gate

Gate file: `pipeline/gates/stage-02.json`.

```json
{
  "stage": "stage-02",
  "status": "PASS",
  "track": "full",
  "timestamp": "<ISO 8601>",
  "orchestrator": "devteam@<version>",
  "blockers": [],
  "warnings": [],
  "arch_approved": true,
  "pm_approved": true,
  "adr_count": 2,
  "adrs_consulted": ["PADR-1", "PADR-2"],
  "adrs_superseded": [],
  "file_ownership": {
    "src/backend/**": "backend",
    "src/frontend/**": "frontend",
    "tests/**": "qa",
    "Dockerfile": "platform",
    "package.json": "platform"
  }
}
```

`arch_approved` and `pm_approved` must both be `true` before build begins.
`adr_count` is the number of ADRs written or updated in this stage.
`adrs_consulted` lists prior ADR IDs reviewed; `adrs_superseded` lists any
that this design explicitly overrides.
`file_ownership` mirrors `pipeline/design-spec.md` §File Ownership in
machine-readable form: keys are repo-relative file paths or glob patterns, and
values are Stage 4 workstreams (`backend`, `frontend`, `platform`, `qa`, or the
optional exact-file `documentation` workstream). This
lets the driver route targeted auto-fix retries to the workstream that owns a
blocker-named file.

The example uses `PADR-N` (project ADR) IDs to distinguish project-level
architectural decisions from the Stagecraft framework's own ADR namespace
(`ADR-001`–`ADR-006`, …, in `docs/adr/`), which would collide if used as
example values here.
