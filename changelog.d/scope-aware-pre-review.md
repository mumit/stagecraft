- **Make learning zero-setup and pre-review scope-aware.** Stagecraft memory now
  defaults to a dependency-free feature-hash retriever, while the larger local
  transformer stack is an explicit opt-in. This removes its high-severity audit
  findings, native binary, and LGPL transitive package from normal installs
  without making project memory fail on first use. Security and migration
  content heuristics now inspect added lines from the active or latest build
  diff, retaining conservative path triggers and full-file fallback for
  untracked/non-Git inputs. This prevents historical crypto/DDL prose from
  launching irrelevant conditional stages after unrelated edits. *Honest scope
  note:* builtin retrieval is lexical rather than neural semantic matching;
  operators who need conceptual similarity can install the transformer provider
  after reviewing its current dependency policy and must reindex when switching.
