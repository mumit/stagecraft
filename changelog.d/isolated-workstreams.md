- Add opt-in `pipeline.workstream_isolation: git-worktree` for parallel build roles. Each role starts from the same dirty/untracked-aware snapshot, runs in a detached worktree, and reconciles only authorized paths; clean text overlap is three-way merged while unauthorized writes, unsafe symlinks, and unresolved conflicts fail visibly.
- Clarify that feature artifact isolation (`pipeline.isolation`) and coding-agent checkout isolation are independent controls, and record the core-managed reconciliation contract in ADR-019.

**Honest scope note:** worktree isolation currently applies only to multi-role headless stage-04 builds in Git repositories. It is a correctness/attribution boundary, not an OS sandbox, and does not isolate peer-review fan-out.
