# Agent Guide

Purpose: compact operating rules for Codex, Claude Code, Gemini CLI, and other
coding agents working in this repository.

## Read First

1. `STATUS.md`
2. `CHANGELOG.md`
3. `CONTRIBUTING.md`
4. `README.md`

## Repo Facts

- Package: `@iowarp/clio-coder`
- Version: `0.2.0-dev`
- Release state: no public releases yet
- Maintainer: Anthony Kougkas, `@akougkas`
- Lab: IOWarp, iowarp.ai, Gnosis Research Center
- Main reviewer: `@akougkas`

## Default Commands

```bash
npm run typecheck
npm run lint
npm run test
npm run build
npm run ci
```

## Non-Negotiable Boundaries

- Only `src/engine/**` imports pi-mono packages.
- `src/worker/**` does not import `src/domains/**`.
- Cross-domain communication goes through `SafeEventBus`.
- Do not edit generated `dist/`, `node_modules/`, secrets, or local scratch
  files.
- Do not rename public CLI commands without updating README, tests, and
  changelog.

## Change Discipline

- Keep one behavioral topic per PR.
- Prefer existing helpers and domain contracts.
- Add tests near the changed surface.
- Update `CHANGELOG.md` and `STATUS.md` when status or visible behavior moves.
- Preserve unrelated user changes in dirty worktrees.
- Use ASCII punctuation in docs.

## GitHub Etiquette

- Branch from `main`.
- Open PRs into `main`.
- Require CI and `@akougkas` review before merge.
- Use draft PRs for incomplete work.
- No direct pushes, force pushes, or admin bypasses on `main`.
- No releases, tags, npm publish, or branch-protection edits unless the
  maintainer explicitly requests them.
