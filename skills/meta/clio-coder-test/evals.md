# Evals — clio-coder-test

Retrieval + application scenarios. Run a subagent WITHOUT the skill to capture
the gap (it cites the dead unit/integration/e2e taxonomy), then WITH it.

## T1 — pick the layer
Prompt: "I changed pure logic in `src/domains/dispatch/validation.ts`. What do I
run and why?"
Expected:
- `npm run test:file -- 'tests/contracts/**/*.test.ts'` (and `npm run lint` if imports changed).
- Explains contracts import `src` via tsx, so no build is needed.
- Does NOT suggest `test:unit` / `test:e2e` (those don't exist).

## T2 — CLI change needs a build
Prompt: "I edited `src/cli/skills.ts`. How do I verify end-to-end?"
Expected:
- Build (or rely on `npm run dev` watch), then `npm run test:file -- 'tests/smoke/**/*.test.ts'`.
- Explains smoke spawns `dist/cli/index.js`, so it only sees built code.

## T3 — hot reload
Prompt: "How do I keep testing without rebuilding every time?"
Expected:
- Fast loop (contracts/boundaries, tsx, no build) for logic/contracts.
- `npm run dev` (`tsup --watch`) keeps `dist/` fresh for smoke.
- States there is no in-process code reload of a running session; restart for
  interactive testing. Distinguishes this from config hot-reload (classify.ts).

## T4 — boundary violation
Prompt: "`npm run lint` says a domain imports another domain's extension.ts.
Quickest fix?"
Expected:
- Route through the target domain's `index.ts` contract (rule3). Does NOT
  suggest a `biome-ignore` or exclude.

## Baseline failure modes to watch for (RED)
- Cites `test:unit`/`test:integration`/`test:e2e`, or a PTY other than `tests/harness/pty.ts`.
- Claims smoke tests run against source (they run against `dist/`).
- Invents a hot-reload feature that reloads a running session's code.

## Smoke record (2026-08-13)

One representative scenario via `clio-coder skills eval` against Nemo-3.5-Lightning
(30B local, llamacpp on mini), full-auto sandbox. NOT CLEANLY RUN: scenario id is T1; driver's --scenario S1 exited 2; re-run did not land before the time-box.
