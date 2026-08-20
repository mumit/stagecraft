# Dogfooding Stagecraft

Running Stagecraft against its own source tree ("dogfooding") lets you use the framework
to develop new Stagecraft features. This guide covers the one-time setup and the per-feature
workflow.

## Prerequisites

- A dedicated Stagecraft clone — do **not** dogfood in your primary install.
- Node.js 22+.
- Claude Code or another supported host CLI, authenticated.

```bash
git clone <stagecraft-repo> ~/Development/stagecraft-dogfood
cd ~/Development/stagecraft-dogfood
npm install
npm link          # puts 'devteam' on PATH pointing to this clone
```

## One-time setup

Run `devteam init` with the dogfood profile:

```bash
devteam init --host claude-code --profile dogfood
devteam doctor
```

This writes four safeguards:

| Safeguard | What it does |
|---|---|
| `.gitignore` stagecraft block | Excludes volatile runtime files |
| `.gitignore` stagecraft-dogfood block | Excludes generated pipeline documents |
| `.git/hooks/pre-commit` guard | Blocks commits to framework infrastructure files |
| `.git/info/exclude` entry | Hides `pipeline/stages/deploy.md` locally |

If `devteam doctor` shows all green under "Dogfood mode", you are ready.

## Per-feature workflow

For each Stagecraft feature or fix you want to dogfood:

```bash
# 1. Create a branch for the feature
git checkout -b feat/my-new-feature

# 2. Run the pipeline with a budget cap (required in dogfood mode)
devteam run --feature "describe the feature" --budget-usd 15 --budget-tokens 50000000

# 3. When the pipeline completes or halts for sign-off, review pipeline/gates/
devteam summary

# 4. If the generated code passes review, commit normally
git add <specific-source-files>
git commit

# 5. Clean up pipeline artifacts before switching features
git restore pipeline/  # or: devteam restart stage-01 --cascade
```

### Recommended budget

| Phase | Budget |
|---|---|
| Requirements + design only | $3–5 |
| Through build | $8–12 |
| Full pipeline (sign-off + deploy allowed) | $15–25 |

Use `--allow-stage sign-off,deploy` only when you intend to run the full pipeline.

## Infrastructure guard

The pre-commit hook installed by `devteam init --profile dogfood` will reject any commit
that touches `core/`, `bin/devteam`, `pipeline/stages/`, `roles/`, or `rules/`. This is
intentional — framework files must only be changed by you, not by an agent run.

If you need to commit a legitimate framework change (e.g. applying a fix that the agent
proposed in a file), do it manually:

```bash
git restore --staged pipeline/brief.md   # unstage pipeline artifacts first
git add core/specific-file.js            # stage only what you mean to commit
git commit
```

## Failure modes

| Symptom | Resolution |
|---|---|
| Agent tries to commit `pipeline/brief.md` | Normal — pre-commit hook blocks it; pipeline continues |
| Run stalls after sign-off | Use `--allow-stage sign-off` if intentional |
| Budget exhausted before design | Raise `--budget-usd` or `--budget-tokens`, as applicable; start from `devteam restart stage-01 --cascade` |
| Pipeline artifacts appear in PR | `git restore --staged pipeline/` before pushing |

## Re-running doctor after setup

```bash
devteam doctor
```

Expected output includes a "Dogfood mode" section:

```
Dogfood mode
  ✓ pre-commit infrastructure guard
  ✓ pre-commit hook is executable
  ✓ .gitignore dogfood block present
  ✓ .git/info/exclude: deploy.md entry
  ✓ no npm publish script
  ℹ usage-budget reminder  — use --budget-usd and/or --budget-tokens with devteam run to cap usage
```

## Two-project calibration protocol

Use two real, non-fixture repositories before treating Phase 41 readiness as evidence. Keep
the raw corpus local; the calibration command reads only paths you name.

1. In project A, run one representative `quick`, `loop`, and `full` change. Include one
   naturally occurring or deliberately introduced test failure that goes through
   `fix-and-retry`, then repeat one stage so provider cache telemetry can be observed.
2. In project B, repeat at least the `loop` run and one track at a different ceremony level.
   Ensure the project knowledge pack is non-empty before one run. If Phase 38 is installed,
   run one workstream with `--trust-profile contained` and retain its reconciliation events.
3. After every run, record bounded fit feedback:

   ```bash
   devteam performance feedback --fit right --reason other
   # Alternatives: too-light/too-heavy and one documented --reason code.
   ```

4. From either project, aggregate both local roots and save the JSON as the review artifact:

   ```bash
   devteam performance calibration --input ../project-b --json > calibration.json
   ```

The report must show at least two projects and must not expose either source path. Inspect
sample denominators, telemetry coverage, observed-versus-estimated cost, track-fit proxies,
and the two Phase 41 gates. Synthetic fixtures validate arithmetic only and never count as
activation evidence.
