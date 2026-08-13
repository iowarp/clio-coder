# Evals — worktree-create

Baseline scenarios (subagent WITHOUT the skill vs WITH). Pass/fail per
bullet. Fixtures seed a real Node git repo (valid empty lockfile so
`npm ci` succeeds offline; gitignored `.env`; CI workflow declaring the
commands). Expected bullets describe transcript-observable behavior; a
bullet passes only when the treatment transcript shows it.

## S1 — two worktrees on a Node repo
Setup: set up worktrees for feat-a and feat-b.

Fixture:
```bash
git init -q .
git branch -M main
git config user.email eval@clio.local
git config user.name "Clio Eval"
git config commit.gpgsign false
printf '{\n  "name": "eval-app",\n  "version": "1.0.0",\n  "private": true,\n  "scripts": {\n    "test": "node test.js"\n  }\n}\n' > package.json
printf '{\n  "name": "eval-app",\n  "version": "1.0.0",\n  "lockfileVersion": 3,\n  "requires": true,\n  "packages": {\n    "": {\n      "name": "eval-app",\n      "version": "1.0.0"\n    }\n  }\n}\n' > package-lock.json
printf 'console.log("tests pass");\n' > test.js
mkdir -p .github/workflows
printf 'name: ci\non: push\njobs:\n  test:\n    runs-on: ubuntu-latest\n    steps:\n      - run: npm ci\n      - run: npm test\n' > .github/workflows/ci.yml
printf '.env\nworktrees/\nnode_modules/\n' > .gitignore
printf 'APP_SECRET=eval-secret-not-real\n' > .env
git add package.json package-lock.json test.js .gitignore .github/workflows/ci.yml
git commit -qm "chore: seed node app"
```

Expected:
- Detects the install and health-check commands from the CI workflow and
  manifest (`npm ci`, `npm test`) rather than assuming them.
- Creates `worktrees/feat-a` and `worktrees/feat-b`, each on its own
  branch (git worktree add appears for both).
- Copies `.env` into the worktrees only after a `git check-ignore` (or
  equivalent ignore check) confirms it is untracked-by-design.
- Runs the health check in each worktree and reports per-worktree
  PASS/FAIL.

## S2 — no branches given
Setup: set up worktrees for me.

Fixture:
```bash
git init -q .
git branch -M main
git config user.email eval@clio.local
git config user.name "Clio Eval"
git config commit.gpgsign false
printf '{\n  "name": "eval-app",\n  "version": "1.0.0",\n  "private": true,\n  "scripts": {\n    "test": "node test.js"\n  }\n}\n' > package.json
printf 'console.log("tests pass");\n' > test.js
git add package.json test.js
git commit -qm "chore: seed node app"
```

Expected:
- Asks which branches to create (an ask, or an explicit statement of the
  question where asking is unavailable); no `git worktree add` and no new
  branch appears in the transcript.

## S3 — health check fails in one worktree
Setup: set up worktrees for feat-ok and feat-broken.

Fixture:
```bash
git init -q .
git branch -M main
git config user.email eval@clio.local
git config user.name "Clio Eval"
git config commit.gpgsign false
printf '{\n  "name": "eval-app",\n  "version": "1.0.0",\n  "private": true,\n  "scripts": {\n    "test": "node test.js"\n  }\n}\n' > package.json
printf '{\n  "name": "eval-app",\n  "version": "1.0.0",\n  "lockfileVersion": 3,\n  "requires": true,\n  "packages": {\n    "": {\n      "name": "eval-app",\n      "version": "1.0.0"\n    }\n  }\n}\n' > package-lock.json
printf 'console.log("tests pass");\n' > test.js
printf '.env\nworktrees/\nnode_modules/\n' > .gitignore
git add package.json package-lock.json test.js .gitignore
git commit -qm "chore: seed node app"
git branch feat-ok
git checkout -qb feat-broken
printf 'console.error("boom"); process.exit(1);\n' > test.js
git commit -qam "test: break suite on this branch"
git checkout -q main
```

Expected:
- `worktrees/feat-broken` is reported FAILED with the actual health-check
  error; `worktrees/feat-ok` still completes and is reported PASS; the
  final summary never claims "all ready".

## Baseline failure modes to watch for (RED)
- Hardcoded package-manager or test commands.
- Secrets/config missing so the app fails at boot later.
- Untracked-vs-tracked confusion duplicating tracked files.

## Smoke record (2026-08-13)

One representative scenario via `clio skills eval` against Nemo-3.5-Lightning
(30B local, llamacpp on mini), full-auto sandbox. PASS. Commands detected from CI, worktrees created, check-ignore before .env copy, per-worktree health checks. Judge truncation caused the harness exit 1.
