- **`devteam doctor` reports how the project was initialized.** A committed
  install tracks `.devteam/` so teammates share the configuration and framework
  changes appear in the diff; a checkout-local (dogfood) install gitignores it so
  the framework stays out of the product diff under review. `doctor` reported the
  install's *health* and never which shape it was looking at — so a deliberately
  local setup and a committed one that had lost its files looked identical, and
  they need opposite fixes.
  The mode is classified from git itself rather than a recorded flag, because a
  flag drifts from what the repository actually does: tracked → `committed`,
  ignored → `checkout-local`, neither → `untracked`, plus `no-git` and `absent`.
  The dogfood profile is recognized by its `.gitignore` marker block.
  *Honest scope note:* only `untracked` warns — both deliberate shapes are
  informational, since a checkout-local install is a choice and not a fault. This
  completes Phase 42.6, and with it Phase 42; three of that item's four
  acceptance criteria were already satisfied when it was picked up (the manifest
  one by #431, the other two by the existing `--profile dogfood` work), which the
  plan now records rather than claiming as new.
