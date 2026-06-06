# Contributing to Clio Coder

Clio Coder is an IOWarp AI coding harness for supervised repository work.
The project is an experimental community alpha. Treat public behavior,
installation paths, and release process as moving until a stable release is
announced.

This repo is optimized for human reviewers and coding agents. Keep changes
small, explicit, and easy to verify from git history.


## Setup

Requirements:

- Node.js `>=22.19.0`
- npm
- Linux or macOS for full parity. Windows is best effort until a stable release.

Bootstrap:

```bash
npm ci
npm run typecheck
npm run lint
npm run test
npm run build
```

Local and GitHub PR gate (fast, deterministic):

```bash
npm run ci
```

Release gate (for maintainers before tags or release artifacts):

```bash
npm run ci:release
```

Live LLM smoke validation (manual/opt-in):

```bash
CLIO_LIVE_SMOKE=1 CLIO_LIVE_TARGET=anthropic ANTHROPIC_API_KEY=your_key npm run test:live
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

- Engine boundary: only `src/engine/**` value-imports pi SDK packages (`@earendil-works/pi-*`, currently pinned to 0.78.1).
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

## Skills

`skills/` is the curated skills marketplace: maintainer-approved `SKILL.md`
guides, distinct from the runtime skills any user can drop into a discovery
root. It is not itself a discovery root, so nothing here auto-loads; skills
activate only via `skills/install.sh`.

To propose a skill:

1. Add `skills/<name>/SKILL.md`. Follow the `superpowers:writing-skills`
   methodology and Anthropic's skill-authoring guidance: a trigger-rich
   `description` (third person, "Use when ..."), one excellent example, and
   progressive disclosure (push heavy reference into `references/`).
2. Include the provenance frontmatter (`registry-id`, `source-url`, `version`,
   `license`) and ship an `evals.md` with the baseline scenarios you tested.
3. Verify locally: `skills/install.sh <name>`, then
   `clio skills validate skills/<name>/SKILL.md` and `clio skills list`.
4. Open a PR. A maintainer reviews against the rubric, then sets `audit: pass`
   and the `version` to approve it for the catalog.

Full catalog conventions and install options: [skills/README.md](skills/README.md).
