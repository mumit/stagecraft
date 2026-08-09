- **Grounded conversational coordinator** (BACKLOG E9 first slice). `devteam chat`
  adds one-shot and TTY conversation over a bounded deterministic snapshot of
  config, run state, stage summary, cost, blockers, and the pure next action. It
  recommends exact commands but cannot execute them, persists no transcript,
  redacts secret-shaped strings, runs adapters from a disposable workspace,
  disables OpenAI-compatible tools, and rejects all ACP permission requests.
  Adapter output capture is additive and bounded. *Honest scope note:* same-user
  CLI hosts are not OS-sandboxed; write-capable conversational requirements or
  design refinement remains deferred behind an explicit approval contract.
