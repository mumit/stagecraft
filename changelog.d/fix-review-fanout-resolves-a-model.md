- **`routing.review_fanout` entries can pin a model.** A fanout dispatch is the
  one dispatch the router never resolved a model for — its host comes from the
  fanout list, not from a role route, so there is no route to read a model from.
  On a host that reports no model of its own the gate then recorded a null model,
  and with no model there is no pricing entry and therefore no derived cost
  either. Entries now accept the same `{host, model}` object form a route takes;
  the bare host-name form is unchanged.
  This mattered because `review_fanout` is the **only** mechanism that dispatches
  the same role to two hosts, which is exactly what D5's `comparable-roles`
  condition requires. Its two conditions were mutually unsatisfiable on `codex`:
  fanout for the comparison, a pinned model for the cost, and fanout dropped the
  model. Verified on a real dispatch — `model_requested: gpt-5.6-sol`,
  `cost_usd_derived: $0.6767`.
  *Honest scope note:* a model is pinned **per entry**, never inherited from the
  role's route — the role's model belongs to the role's own host, and carrying
  it across would send an OpenAI model id to `claude-code`. An unpinned entry
  stays unpinned. Tier escalation (`routing.escalate_on_retry`) still does not
  apply to fanout entries: it escalates within a resolved route, and a fanout
  entry has none.
- **A stage transcript's `# Command:` header records the command as spawned.** It
  printed the configured command string — the value *before* `runHeadless`
  appends flags, notably `--model`. A transcript that omits the model flag reads
  as though routing pinned nothing, which is the wrong conclusion when
  diagnosing a dispatch that ran on an unexpected model, and it cost real time
  during the work above.
