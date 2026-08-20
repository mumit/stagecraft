- **Pre-dispatch retry ownership proof** (Phase 42.2 / E13). Structured
  fix/retry targets are now compared with the actual candidate build roles'
  existing `roleWrites` before gates are cleared. Stagecraft prefers a compatible
  `stage-02.file_ownership` owner and otherwise uses stable stage order; when no
  single candidate owns every target it halts as `retry-ownership` with target
  paths and candidate role names, leaves gates intact, and spends no host turn.
  Requested artifact fields participate in the same check, bounded feature roots
  use the same logic, and no role gains a broader write surface. *Honest scope
  note:* blockers with no structured target path retain the existing bounded
  retry behavior; Phase 42.3 still owns first-class exact-file documentation
  workstreams.
