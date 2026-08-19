# Environment Variables Reference

All environment variables recognised by Stagecraft, grouped by subsystem.
Variables marked **required** have no fallback and will cause an error or no-op if absent.

---

## OpenAI-compatible host

| Variable | Default | Description |
|----------|---------|-------------|
| `OPENAI_COMPAT_BASE_URL` | `https://openrouter.ai/api/v1` | Base URL for the OpenAI-compatible Chat Completions endpoint. This fallback is kept for compatibility; committed project configs should prefer an explicit `hosts.openai-compat.base_url` such as `https://api.openai.com/v1`, a Fireworks/Fuel iX endpoint, or an internal gateway. |
| `OPENAI_COMPAT_API_KEY` | *(required)* | API key. Overridden by whatever env var `api_key_env` names in config. |
| `OPENAI_COMPAT_MODEL` | *(required if no per-role mapping)* | Default model ID in the provider's namespace (e.g. `gpt-4.1`, `accounts/fireworks/models/...`, `deepseek/deepseek-v4-pro`). Overridden by `hosts.openai-compat.models.*` in config. |

Resolution order: `.devteam/config.yml` → environment variables. When `api_key_env` is set in config, only that named var is read for the key; `OPENAI_COMPAT_API_KEY` is the fallback when `api_key_env` is absent from config.

---

## Logging and verbosity

| Variable | Default | Description |
|----------|---------|-------------|
| `DEVTEAM_VERBOSE` | `0` | Set to `1` to enable verbose output. For openai-compat, this streams full tool traces, assistant content, and the endpoint URL. For CLI hosts, this also mirrors the host subprocess transcript to the terminal while still writing `pipeline/logs/<workstreamId>.log`. |
| `LOG_FORMAT` | *(text)* | Set to `json` to switch the approval-derivation hook and gate validator to structured JSON log output (audit mode B-23). |
| `DEVTEAM_NO_LOG` | `0` | Set to `1` to disable transcript logging for headless runs. Reverts stdio to inherit mode (terminal colours preserved). Does not apply to openai-compat (no subprocess). |
| `DEVTEAM_HEADLESS_TEE` | `0` | Set to `1` to mirror CLI-host stdout/stderr to the terminal during headless runs. By default, CLI-host output is written only to `pipeline/logs/<workstreamId>.log` so prompts and diffs do not flood `devteam run` output. |
| `DEVTEAM_LOG_HISTORY` | `3` | Number of rotated log slots to keep per workstream. Set to `0` to disable rotation and overwrite on each run. Applies to `pipeline/logs/<workstreamId>.log`. |

---

## Headless host

| Variable | Default | Description |
|----------|---------|-------------|
| `DEVTEAM_HEADLESS_COMMAND` | *(adapter's `headlessCommand`)* | Override the host CLI command for headless runs. Useful for stubbing in tests — e.g. `DEVTEAM_HEADLESS_COMMAND=cat` echoes the prompt without invoking a real host. |

---

## Docker runner

| Variable | Default | Description |
|----------|---------|-------------|
| `STAGECRAFT_RUNNER_CLEAR_STALE_LOCK` | `0` | Docker entrypoint option. Set to `1` only after confirming `pipeline/run.lock` is stale; the wrapper removes the lock before delegating to `devteam`. Active locks are never removed. |

---

## Pipeline paths and change isolation

| Variable | Default | Description |
|----------|---------|-------------|
| `DEVTEAM_CHANGE_ID` | *(none)* | Isolates pipeline artefacts under `pipeline/changes/<changeId>/` when `isolation: bounded` is set in config. Exported by the orchestrator into the headless host's environment so gate validation resolves to the correct bounded directory. |
| `DEVTEAM_GATES_DIR` | `pipeline/gates/` | Override the absolute path where gate files are read and written. Set by `devteam derive-approvals` when dispatching the approval hook for bounded-isolation runs. |
| `DEVTEAM_REVIEW_DIR` | `pipeline/code-review/` | Override the absolute path where reviewer markdown files (`by-*.md`) are scanned. Set alongside `DEVTEAM_GATES_DIR` by `devteam derive-approvals`. |

---

## Memory and embeddings

| Variable | Default | Description |
|----------|---------|-------------|
| `DEVTEAM_EMBEDDING_PROVIDER` | `builtin` | Retrieval backend. Values: `builtin` (dependency-free signed feature hashing), `local` (opt-in HuggingFace Transformers; package install and model download required), `stub` (deterministic test vectors). `openai` and `cohere` are rejected until implemented. |
| `DEVTEAM_EMBEDDING_MODEL` | `Xenova/bge-small-en-v1.5` | HuggingFace model ID for `local` provider. Example alternative: `Xenova/bge-base-en-v1.5` (110 MB, 768-dim, higher accuracy). |
| `STAGECRAFT_ORG_MEMORY_DIR` | `~/.stagecraft/memory/` | Root directory for the org-shared memory store. Override to isolate memory across clients or machines (e.g. `~/.stagecraft-client-A/memory/`). |
| `STAGECRAFT_REVIEWS_DIR` | `~/.stagecraft/reviews/` | Root directory for external-review workspaces (phase-36, `core/review-workspace.js`) — each subject reviewed gets `<this>/<slug>/`. Override to isolate reviews across clients or machines, or in tests. |

---

## Observability (OpenTelemetry)

| Variable | Default | Description |
|----------|---------|-------------|
| `OTEL_EXPORTER_OTLP_ENDPOINT` | *(none)* | OTLP collector endpoint (e.g. `http://localhost:4318`). Tracing is a no-op when neither this nor `OTEL_EXPORTER_OTLP_TRACES_ENDPOINT` is set. |
| `OTEL_EXPORTER_OTLP_TRACES_ENDPOINT` | *(none)* | Traces-specific OTLP endpoint. Checked after `OTEL_EXPORTER_OTLP_ENDPOINT`. |
| `OTEL_SERVICE_NAME` | `devteam` | Service name reported to the collector. |
| `OTEL_RESOURCE_ATTRIBUTES` | *(none)* | Standard `key=value,key=value` resource attributes appended to every span. |
| `DEVTEAM_OTEL_DISABLE` | `0` | Set to `1` to force-disable tracing even when an endpoint is configured. Useful in tests that import core modules without a running collector. |

---

## Security

| Variable | Default | Description |
|----------|---------|-------------|
| `DEVTEAM_SIGNING_SECRET` | *(none)* | HMAC secret for gate signing and chain verification. Required when `pipeline.require_signed_gates: true` is set in config. `devteam verify-chain` computes and checks HMACs against this secret; without it, gates are written unsigned and verification emits warnings rather than failing. |
| `DEVTEAM_SECRET_SCAN_ALLOW` | *(none)* | Comma-separated list of file-path regex patterns to exempt from the secret-scan hook. Add paths that legitimately contain credential-like strings (e.g. `.env.example`, test fixtures). |

---

## UI server

| Variable | Default | Description |
|----------|---------|-------------|
| `PORT` | `3737` | TCP port for `devteam ui`. Also settable via `--port`. |
| `STAGECRAFT_UI_ALLOW_REMOTE` | `0` | Set to `1` to allow the UI to bind on non-loopback interfaces. The UI has no authentication; remote binding is blocked by default. |

---

## CI / scripts

These variables are consumed by the internal CI helpers and consistency scripts, not by the `devteam` CLI itself.

| Variable | Default | Description |
|----------|---------|-------------|
| `CI` | *(none)* | Standard CI flag. Detected by several scripts to suppress interactive prompts and enable CI-appropriate defaults. |
| `CONSISTENCY_BASELINE_FILE` | `scripts/consistency-baseline.json` | Override the path to the consistency baseline snapshot used by `scripts/consistency.js`. |
| `PROMPT_BUDGET_FILE` | `scripts/prompt-budget.json` | Override the path to the prompt-budget manifest consumed by `scripts/consistency.js`. |
| `GUARD_CHANGED` | *(none)* | Newline-separated list of changed file paths fed to `scripts/changelog-guard.js` by CI. |
| `GUARD_FRAGMENTS` | *(none)* | Newline-separated list of changelog fragment paths fed to `scripts/changelog-guard.js`. |
| `GUARD_SKIP` | *(none)* | Text marker in commit messages that causes `scripts/changelog-guard.js` to skip enforcement (e.g. `[skip changelog]`). |
| `STAGECRAFT_REPO` | *(none)* | GitHub repo reference (e.g. `your-org/stagecraft`) used in CI workflow templates to specify where Stagecraft is fetched from. |
| `STAGECRAFT_REF` | *(none)* | Git ref (tag, branch, or SHA) used in CI workflow templates to pin the Stagecraft version. |

---

## HuggingFace Transformers (internal)

These are standard library variables that Stagecraft sets automatically when `DEVTEAM_EMBEDDING_PROVIDER=local`.

| Variable | Stagecraft behaviour |
|----------|---------------------|
| `TRANSFORMERS_VERBOSITY` | Silenced to `error` unless `DEBUG` is set, to suppress download progress chatter. |
| `DEBUG` | If set to any truthy value, Stagecraft leaves `TRANSFORMERS_VERBOSITY` at its library default (verbose). |

---

## Standard Unix passthrough

These are read from the environment as-is and not set by Stagecraft.

| Variable | Where used |
|----------|-----------|
| `PATH` / `PATHEXT` | Host CLI resolution (`claude`, `codex`, `gemini`). |
| `EDITOR` / `VISUAL` | Fall-through for any interactive editing surfaces. |
