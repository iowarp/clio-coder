# Evals — resolve-merge-conflicts

Baseline scenarios (subagent WITHOUT the skill vs WITH). Pass/fail per
bullet. Status: written at port time, not yet executed (`eval-status:
untested`).

## S1 — compatible two-sided conflict
Setup: the merge of feat-rename stopped on a conflict in util.js. Resolve
it and finish the merge.

Fixture:
```bash
git init -q .
git branch -M main
git config user.email eval@clio-coder.local
git config user.name "Clio Coder Eval"
git config commit.gpgsign false
printf 'function getUser(id) {\n  return db.find(id);\n}\n\nmodule.exports = { getUser };\n' > util.js
git add util.js
git commit -qm "chore: seed util"
git checkout -qb feat-rename
printf 'function findUser(id) {\n  return db.find(id);\n}\n\nmodule.exports = { findUser };\n' > util.js
git commit -qam "refactor: rename getUser to findUser"
git checkout -q main
printf 'function getUser(id) {\n  return db.find(id);\n}\n\nfunction getUserName(id) {\n  return getUser(id).name;\n}\n\nmodule.exports = { getUser, getUserName };\n' > util.js
git commit -qam "feat: add getUserName call site"
git merge feat-rename > merge-output.txt 2>&1 || true
```

Expected:
- Reads both sides' history (log/show on main and feat-rename) before
  touching the file.
- Resolution preserves both intents: the function is named findUser and
  getUserName calls findUser.
- The merge is committed and no conflict markers remain in util.js.

## S2 — incompatible conflict
Setup: both sides changed the same default to different values.
Expected:
- Picks per the merge's stated goal, or asks when the goal doesn't decide;
  trade-off recorded in the report.

## S3 — mid-rebase, multiple stops
Setup: a rebase is stopped on its first conflict with more commits still to
replay; resolve and finish the whole rebase.
Expected:
- Continues the rebase after each resolution until complete; validates at
  the end.

## Baseline failure modes to watch for (RED)
- `checkout --theirs` on everything to make it compile.
- Invented "compromise" behavior neither side had.
- `--abort` at the first hard hunk.

## Smoke record (2026-08-13)

One representative scenario via `clio-coder skills eval` against Nemo-3.5-Lightning
(30B local, llamacpp on mini), full-auto sandbox. PASS. Both sides' history read; both intents preserved; merge committed, no markers.
