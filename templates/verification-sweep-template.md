# Verification Sweep — Report (Stage 6x, 29.4)

<!--
  Combined specialty-QA report for compact_qa tracks. Include ONLY the
  sections your track's `sections_included` actually covers; delete the
  others. On the quick track that's Accessibility + Performance Budget —
  the same PASS/FAIL bar as the standalone stage-06b/stage-06e reports,
  just filed as sections of one dispatch instead of two.
-->

## Summary

<!-- One paragraph: which sections ran, what was found, what's blocking. -->

## Accessibility

<!-- Include only if "accessibility" is in gate.sections_included. -->

**Audit method:** <!-- axe-core / pa11y / lighthouse / manual -->
**WCAG level:** <!-- A / AA / AAA -->

| Severity | Count |
|---|---|
| Critical | |
| Serious | |
| Moderate | |
| Minor | |

**Components audited:**

**Skipped reason (if not applicable to this change):**

## Observability

<!-- Include only if "observability" is in gate.sections_included. -->

| Signal | Required | Verified | Gap |
|---|---|---|---|
| Metrics | | | |
| Logs | | | |
| Traces | | | |

**Verification method:** <!-- code-grep / static-analysis / staging-run / runtime-probe / dashboard-query / manual -->

## Verification Beyond Tests

<!-- Include only if "verification_beyond_tests" is in gate.sections_included. -->

**Methods attempted:** <!-- subset of property / mutation / formal -->
**Candidates inventoried:**

**Blocking findings:**

**Non-blocking findings:**

## Performance Budget

<!-- Include only if "performance" is in gate.sections_included. -->

**Checks performed:** <!-- subset of lighthouse / bundle / load-test -->

| Metric | Result | Budget | Status |
|---|---|---|---|
| Lighthouse score | | ≥ | ✅/⚠️/❌ |
| Bundle delta | | ≤ | ✅/⚠️/❌ |
| Load p95 | | ≤ | ✅/⚠️/❌ |

**Budget exceeded?** Yes / No

**Skipped reason (if not applicable to this change):**

## Approval line

<!--
  ✅ APPROVED — every included section is PASS.
  ⚠️ APPROVED WITH WARNINGS — non-blocking findings worth tracking.
  ❌ CHANGES REQUESTED — a blocking finding in any included section.
-->
