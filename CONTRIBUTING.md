# Contributing to Clio Coder

Clio Coder is an IOWarp AI coding harness for supervised repository work.
The project is pre-release.

This repo is optimized for human reviewers and coding agents. Keep changes
small, explicit, and easy to verify from git history.


## Setup

Requirements:

- Node.js `>=22`
- npm
- Linux or macOS for full parity. Windows is best effort until release.

Bootstrap:

```bash
npm ci
npm run typecheck
npm run lint
npm run test
npm run build
```

Local and GitHub gate:

```bash
npm run ci
```

Optional hook:

```bash
npm run hooks:install
```

## Hard Rules

1. Do not push to `main`.
2. Open pull requests against `main`.
3. `main` requires review by `@akougkas`.
4. Keep every PR focused. Split unrelated docs, runtime, CLI, and TUI work.
5. Update `CHANGELOG.md` for user-visible behavior, developer workflow, or
   release status changes.
6. Run `npm run ci` before requesting review.
7. Do not commit secrets, local config, generated `dist/`, or scratch plans.

## Architecture Invariants

The boundary checker enforces these:

- Engine boundary: only `src/engine/**` value-imports pi SDK packages (`@mariozechner/pi-*`, currently pinned to the 0.70.x package line).
- Worker isolation: `src/worker/**` value-imports only the worker-safe
  provider runtime rehydration modules under `src/domains/providers/**`;
  all other worker domain imports must be type-only.
- Domain independence: cross-domain flows go through `SafeEventBus`.

Run:

```bash
npm run check:boundaries
```

## Branches

Use short branch names:

- `feat/<topic>`
- `fix/<topic>`
- `docs/<topic>`
- `test/<topic>`
- `chore/<topic>`

Examples:

- `feat/worker-profiles`
- `fix/session-resume-replay`
- `docs/github-governance`

## Commits

Use concise conventional subjects:

```text
feat(cli): add target profile flag
fix(session): restore chat on fork
docs(changelog): record v0.1.0-exp release notes
```

Rules:

- Types: `feat`, `fix`, `docs`, `test`, `refactor`, `build`, `ci`, `chore`.
- Optional scope is encouraged.
- Subject <= 72 characters.
- Explain why in the body when behavior or architecture changes.
- Use ASCII punctuation in docs and commits.

## Pull Requests

PRs should include:

- Problem and approach.
- User-facing behavior changes.
- Tests run.
- Changelog/status updates, or why none are needed.
- Screenshots only for visible TUI changes when useful.

Review rubric:

- Correctness: behavior matches the stated problem.
- Boundaries: architecture invariants still hold.
- Safety: no secret leakage, unsafe shell behavior, or destructive defaults.
- Tests: coverage matches the risk and changed surface.
- Docs: changelog/status/contributor guidance stays current.

## Agent Etiquette

Agents should:

- Read `CLIO.md`, `CHANGELOG.md`, and this file before broad
  edits.
- Prefer `rg` for search.
- Use existing modules and helpers before adding abstractions.
- Keep generated summaries short and cite git ranges when summarizing history.
- Avoid touching unrelated files in a dirty worktree.
- Leave remote writes, branch rules, and release tags to `@akougkas` unless
  explicitly instructed.
