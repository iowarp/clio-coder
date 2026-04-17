# Contributing to Clio-Coder

Clio is IOWarp's orchestrator coding-agent, built as a Level-3 custom harness over pi-mono. The design plan lives at `docs/specs/2026-04-16-clio-coder-design.md` and the phased implementation roadmap at `docs/superpowers/plans/2026-04-16-clio-coder-roadmap.md`. Read both before contributing non-trivial changes.

## Requirements

- Node >= 20
- npm (the lockfile is committed; use `npm ci` in CI-like environments)
- Linux or macOS for full CI parity. Windows compiles but is best-effort in v0.1 and is not exercised by the CI matrix.
- TypeScript 5.7 strict. No `any`, no `ts-ignore` without a linked tracking issue.

## Getting started

```
git clone https://github.com/iowarp/clio-coder.git
cd clio-coder
npm ci
npm run typecheck
npm run check:boundaries
npm run build
npm run verify
```

`npm run ci` runs the full chain (typecheck, lint, boundaries, prompts, boundary diagnostics, build, verify) and mirrors the GitHub Actions job. Keep it green on every commit.

## The three hard invariants

`docs/specs/2026-04-16-clio-coder-design.md` §3 locks three build-time invariants. Violating any of them blocks the commit.

1. Engine boundary. Only `src/engine/**` imports from pi-mono packages (`@mariozechner/pi-agent-core`, `@mariozechner/pi-ai`, `@mariozechner/pi-tui`).
2. Worker isolation. `src/worker/**` never imports from `src/domains/**`.
3. Domain independence. Each domain owns its state. Cross-domain flows go exclusively through `SafeEventBus`.

Enforcement and diagnosis:

- `npm run check:boundaries` runs the strict enforcer in `scripts/check-boundaries.ts` and is wired into CI.
- `npm run diag:boundaries` runs the companion diagnostic in `scripts/diag-boundaries.ts`. Use it when `check:boundaries` fails to get a human-readable breakdown.

## Pre-commit hook

A shell-based pre-commit hook enforces formatting and the boundary invariant locally so regressions do not reach CI.

Install once per clone:

```
npm run hooks:install
```

The installer copies `scripts/git-hooks/pre-commit` into the repo's hooks directory (respects `git rev-parse --git-path hooks`, so worktrees work). Re-run it after a pull that changes the hook script.

What the hook does on every `git commit`:

1. Runs `npm run format`. Biome may rewrite tracked files to fix formatting.
2. Compares the working-tree diff before and after the format pass. If the diff changed, the hook aborts with a non-zero exit and lists the modified files. Resolve by running `git add` on the reformatted files and re-running `git commit`.
3. Runs `npm run check:boundaries`. If any of the three hard invariants is violated, the hook aborts with a non-zero exit.

If you need to bypass the hook for a genuine emergency, `git commit --no-verify` still works but the change must pass CI on the next push.

The hook is opt-in on purpose. CI and fresh clones stay free of install-time side effects. Every contributor runs `npm run hooks:install` once and forgets about it.

## Commit style

- Imperative mood, lowercase type prefix: `feat`, `fix`, `build`, `ci`, `docs`, `refactor`, `chore`, `test`.
- Optional scope in parentheses, e.g. `feat(cli): add --version flag`.
- Subject line <= 72 characters, no trailing period.
- Body wrapped at ~72 columns, explaining the why.
- No em-dash clause separators anywhere (subject, body, or docs). The spec's voice rule (`docs/specs/2026-04-16-clio-coder-design.md` §23) is "Professional, scientific, no emojis, no em-dashes." Write full sentences instead of inline interjections with a dash.

Bad: `Dispatch admission gating - worker permission levels cannot exceed the orchestrator's max.`
Good: `Dispatch admission gating prevents worker permission levels from exceeding the orchestrator's max.`

## Branch and PR workflow

- Branch from `main`. Branch names are short and descriptive, e.g. `feat/xdg-windows-branch` or `fix/boundary-reexport-leak`.
- Never force-push to `main`. Force-pushing feature branches is fine before review.
- Open PRs against `main`. Keep them small and reviewable; the phase plans are designed around small slices.
- Every commit on the branch must leave `npm run ci` green. Do not stack broken commits and fix them at the end.
- The CI matrix runs on `ubuntu-latest` and `macos-14`. Platform-specific fixes must land with a matrix entry that exercises them.

## Phase-plan workflow

Non-trivial work is driven by phase plans under `docs/superpowers/plans/`. The active plan defines tasks, acceptance criteria, and verification commands. Use the `superpowers:subagent-driven-development` or `superpowers:executing-plans` skill to execute a plan task-by-task. New phases get a plan document committed before implementation starts.
