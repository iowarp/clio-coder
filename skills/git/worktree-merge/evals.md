# Evals — worktree-merge

Baseline scenarios (subagent WITHOUT the skill vs WITH). Pass/fail per
bullet. Fixtures seed a real git repo with feature branches and a runnable
test script. Expected bullets describe transcript-observable behavior; a
bullet passes only when the treatment transcript shows it.

## S1 — clean two-branch integration
Setup: merge my worktree branches feat-a and feat-b.

Fixture:
```bash
git init -q .
git branch -M main
git config user.email eval@clio.local
git config user.name "Clio Eval"
git config commit.gpgsign false
printf '{\n  "name": "eval-app",\n  "version": "1.0.0",\n  "private": true,\n  "scripts": {\n    "test": "node test.js"\n  }\n}\n' > package.json
printf 'console.log("tests pass");\n' > test.js
printf 'alpha\n' > a.txt
printf 'beta\n' > b.txt
git add package.json test.js a.txt b.txt
git commit -qm "chore: seed"
git checkout -qb feat-a
printf 'alpha 2\n' > a.txt
git commit -qam "feat: extend alpha"
git checkout -q main
git checkout -qb feat-b
printf 'beta 2\n' > b.txt
git commit -qam "feat: extend beta"
git checkout -q main
```

Expected:
- Detects the test command from the manifest (`npm test` / `node test.js`)
  rather than assuming one.
- Creates a throwaway integration branch and merges each feature branch
  `--no-ff`, with a test run between the merges.
- Runs the full suite before `main` moves; the integration branch is
  deleted afterwards.
- Asks (or explicitly states the question where asking is unavailable)
  before deleting feature branches or removing worktrees.

## S2 — conflicting branches
Setup: merge my worktree branches feat-a and feat-b.

Fixture:
```bash
git init -q .
git branch -M main
git config user.email eval@clio.local
git config user.name "Clio Eval"
git config commit.gpgsign false
printf '{\n  "name": "eval-app",\n  "version": "1.0.0",\n  "private": true,\n  "scripts": {\n    "test": "node test.js"\n  }\n}\n' > package.json
printf 'console.log("tests pass");\n' > test.js
printf 'shared base\n' > shared.txt
git add package.json test.js shared.txt
git commit -qm "chore: seed"
git checkout -qb feat-a
printf 'from a\n' > shared.txt
git commit -qam "feat: a rewrites shared"
git checkout -q main
git checkout -qb feat-b
printf 'from b\n' > shared.txt
git commit -qam "feat: b rewrites shared"
git checkout -q main
```

Expected:
- Stops at the conflict on the integration branch; names the conflicting
  branch and `shared.txt`; gives manual resolution steps.
- No automatic conflict resolution is attempted; `main` still points at
  the seed commit at the end (never received a merge).

## S3 — test failure after the second merge
Setup: merge my worktree branches feat-a and feat-b.

Fixture:
```bash
git init -q .
git branch -M main
git config user.email eval@clio.local
git config user.name "Clio Eval"
git config commit.gpgsign false
printf '{\n  "name": "eval-app",\n  "version": "1.0.0",\n  "private": true,\n  "scripts": {\n    "test": "node test.js"\n  }\n}\n' > package.json
printf 'console.log("tests pass");\n' > test.js
printf 'alpha\n' > a.txt
git add package.json test.js a.txt
git commit -qm "chore: seed"
git checkout -qb feat-a
printf 'alpha 2\n' > a.txt
git commit -qam "feat: extend alpha"
git checkout -q main
git checkout -qb feat-b
printf 'console.error("regression"); process.exit(1);\n' > test.js
git commit -qam "feat: b breaks the suite"
git checkout -q main
```

Expected:
- The test failure is localized to feat-b (feat-a's merge tested green
  first); the report names feat-b as the breaking branch.
- Exact rollback commands are given; `main` never moves to the red state
  (still at the seed commit at the end).

## Baseline failure modes to watch for (RED)
- Merging straight into the current branch without an integration branch.
- Skipping the per-merge test run, losing failure localization.
- Cleanup without asking.

## Smoke record (2026-08-13)

One representative scenario via `clio skills eval` against Nemo-3.5-Lightning
(30B local, llamacpp on mini), full-auto sandbox. PASS. Integration branch, --no-ff merges with tests between. Terminal artifact was blocked by the then-missing allowed-tools entry (fixed same day); git branch -D stays permission-gated at full-auto. A post-fix re-smoke ran exit 1 at 12:16 CDT with no scored breakdown drained before the hard cutoff; the first run's core-workflow pass stands.
