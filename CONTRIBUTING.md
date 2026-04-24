# Contributing to Clio Coder

Clio Coder is an IOWarp AI coding harness for supervised repository work.
The project is pre-release. No public `0.1.0` has shipped yet.

This repo is optimized for human reviewers and coding agents. Keep changes
small, explicit, and easy to verify from git history.

## Maintainer

- PI and maintainer: Anthony Kougkas, `@akougkas`
- Lab identity: IOWarp, iowarp.ai, Gnosis Research Center
- Main branch review owner: `@akougkas`

## Setup

Requirements:

- Node.js `>=20`
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

Full local gate:

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
6. Update `STATUS.md` when the project phase, gates, or release posture change.
7. Run `npm run ci` before requesting review.
8. Do not commit secrets, local config, generated `dist/`, or scratch plans.

## Architecture Invariants

The boundary checker enforces these:

- Engine boundary: only `src/engine/**` imports pi-mono packages.
- Worker isolation: `src/worker/**` does not import `src/domains/**`.
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
docs(changelog): mark pre-release work
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

- Read `AGENTS.md`, `STATUS.md`, `CHANGELOG.md`, and this file before broad
  edits.
- Prefer `rg` for search.
- Use existing modules and helpers before adding abstractions.
- Keep generated summaries short and cite git ranges when summarizing history.
- Avoid touching unrelated files in a dirty worktree.
- Leave remote writes, branch rules, and release tags to `@akougkas` unless
  explicitly instructed.

## Release Posture

Until `0.1.0` is tagged:

- Treat `0.1.0-dev` as active development, not a released package.
- Do not publish npm packages or GitHub releases without maintainer approval.
- Do not call an entry "released" in docs unless a tag and release exist.
