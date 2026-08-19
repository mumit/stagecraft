- **Reuse unchanged project tests across verification stages.** Build, pre-review, and
  QA now share a content-addressed project-test receipt scope, avoiding repeated full
  suite executions when code, tests, commands, configuration, environment, toolchain,
  and verifier version are unchanged. Repair reproduction remains separately scoped,
  failed runs are never reused, and `pipeline.verify.receipts: false` still forces fresh
  execution for projects whose tests depend on external state.
