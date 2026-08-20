- **Project discovery works for non-JavaScript projects (Phase 42.4).** On a
  Python project with `pyproject.toml`, `app/`, and `tests/test_*.py`,
  `devteam standards discover` reported `test_runner: null`,
  `package_manager: null`, an empty `test_config`, and a naming convention of
  `camelCase`. The Project Knowledge Pack every agent reads therefore carried
  two facts, one of them wrong. It now carries four correct ones: stack and
  package manager, filename convention, test runner and pattern, and the verify
  command.
  - **Test runner** is read through `hasPythonTests` in `core/verify/runner.js`
    — the detector that decides what `devteam verify` actually runs — instead of
    grepping `requirements.txt` for the string `pytest`. Discovery and execution
    can no longer disagree.
  - **Package manager** resolves `poetry` / `uv` / `pipenv` / `pip` for Python.
    The JavaScript branch still wins on a repo carrying both manifests.
  - **`camelCase` now requires an actual hump.** The old pattern
    `/^[a-z][a-zA-Z0-9]+$/` matched any single lowercase word, so `calc.py`,
    `utils.js`, and `main.go` all counted as camelCase — this misreported
    JavaScript projects too, not only Python ones. A bare lowercase word is
    reported as `lowercase`, a new style, rather than being claimed by a
    convention it does not demonstrate.
- **Stagecraft's own directories no longer appear in a project's discovered
  structure.** `pipeline/` was listed as a top-level directory of the project it
  was orchestrating. Discovery is the fourth reader to route through
  `isFrameworkOwnedPath` (`core/paths.js`), after the changed-file manifest,
  right-sizing, and `assess`.
- **Knowledge-pack `schema_version` bumped to 1.1** so existing projects
  regenerate once and pick up the corrected facts. The stored fingerprint covers
  only the project's own files, so without this an existing pack would keep
  serving output from the older detector. *Honest scope note:* this covers 42.4's
  discovery half. Track-aware `devteam spec verify` and the treatment of a
  missing test root are separate concerns in separate files and are not in this
  change.
