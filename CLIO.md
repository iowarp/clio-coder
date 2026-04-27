# CLIO.md

Canonical project instructions for AI coding assistants and contributors
working in the Clio Coder repository. This file is auto-loaded by Clio
Coder itself and is the highest-priority context source. When other
context files (`CLAUDE.md`, `AGENTS.md`, `CODEX.md`, `GEMINI.md`) define
the same section as `CLIO.md`, this file wins and theirs is dropped.

## Identity

Clio Coder is IOWarp's orchestrator coding-agent. It is a custom harness
built over the pi SDK (`@mariozechner/pi-agent-core`,
`@mariozechner/pi-ai`, `@mariozechner/pi-tui`, pinned to the `0.70.x`
package line). Clio owns the agent loop, the TUI shape, the session
format, the tool registry, and the identity. The pi SDK is treated as a
vendored engine behind a single boundary at `src/engine/**`.

## Project map

```text
src/cli/           CLI entry points (clio, clio configure, clio doctor, ...)
src/interactive/   terminal UI (chat loop, overlays, dashboard, keybindings)
src/engine/        pi SDK boundary; the only place that value-imports @mariozechner/pi-*
src/worker/        worker subprocess runtime and IPC
src/domains/       domain logic (agents, prompts, providers, dispatch, safety, ...)
src/harness/       self-development harness (hot reload, restart, watcher)
src/tools/         tool registry and built-in tools
src/core/          shared utilities (XDG, config, bus, termination, ...)
src/entry/         orchestrator boot path
tests/unit/        pure logic, no I/O
tests/integration/ real fs ops in a scratch XDG home
tests/boundaries/  static analysis of src/ (import rules + prompt fragments)
tests/e2e/         real `clio` binary via spawn (non-interactive) + node-pty (TUI)
tests/harness/     spawn + pty test harnesses
docs/specs/        formal specifications (data formats, protocols, contracts)
damage-control-rules.yaml  hardcoded bash kill-switches
```

## Setup

Requirements:

- Node.js `>=20`
- npm
- Linux or macOS for full parity. Windows is best-effort.

Bootstrap a fresh checkout:

```bash
npm ci
npm run typecheck
npm run lint
npm run test
npm run build
```

Optional pre-commit hook:

```bash
npm run hooks:install
```

## Build

```bash
npm run build      # production bundle through tsup; emits dist/
npm run dev        # tsup --watch for iterative development
npm run clean      # remove dist/
```

## Test

The four-layer test suite is the source of truth. The `clio-testing`
skill at `.claude/skills/clio-testing/SKILL.md` is the long-form guide.

```bash
npm run typecheck         # tsc -p tsconfig.tests.json (includes tests/)
npm run test              # unit + integration + boundaries (~450ms)
npm run test:e2e          # builds first, then spawn + pty e2e (~3s)
npm run check:boundaries  # boundary checks alone
npm run ci                # typecheck + lint + test + build + test:e2e
```

What each layer catches:

| Change site | Run this first |
|---|---|
| `src/domains/<x>/*.ts` pure logic | `npm run test` |
| `src/domains/dispatch/state.ts` | `npm run test` (ledger integration) |
| `src/domains/providers/credentials.ts` | `npm run test` (credentials integration) |
| `src/domains/prompts/fragments/*.md` | `npm run test` (boundaries/prompts.test.ts) |
| any `src/` import change | `npm run test` (boundary rules 1/2/3) |
| `src/cli/*.ts` | `npm run test:e2e` (spawn harness) |
| `src/interactive/*.ts` or `src/entry/orchestrator.ts` | `npm run test:e2e` (pty harness) |

Integration tests that touch the filesystem must use a scratch XDG home:
set `CLIO_HOME`, `CLIO_DATA_DIR`, `CLIO_CONFIG_DIR`, `CLIO_CACHE_DIR` to
a `mkdtempSync` path, call `resetXdgCache()` from `src/core/xdg.js`, then
restore env and `rmSync` in `afterEach`.

E2e pty tests match against the raw pty buffer (which contains ANSI). Match
by stable text (e.g. `/clio\s+IOWarp/`), wrap in `try/finally` with
`p.kill()`, and always `await runCli(["install"], ...)` before spawning
the TUI on a scratch home.

## Lint

```bash
npm run lint       # biome check .
npm run format     # biome format --write .
```

Biome enforces formatting plus a curated rule set. Pre-existing warnings
on test files are tracked separately; the goal is zero new warnings from
your change.

## Code style

- TypeScript strict, with `noUncheckedIndexedAccess` and
  `exactOptionalPropertyTypes`. Array access returns `T | undefined`;
  narrow before use.
- NodeNext module resolution. Imports end in `.js`, never `.ts`.
- No `any` and no `ts-ignore` without a linked tracking issue.
- Biome bans `delete obj.key` on hot paths. Use
  `Reflect.deleteProperty(obj, "key")` when you genuinely need to delete
  (e.g. cleaning `process.env` in a test).
- ASCII punctuation. Em-dash clause separators are banned everywhere
  (docs, code comments, commit messages, tool output). Write a full
  sentence instead of `[noun] - [parenthetical clause]`. Hyphens in
  compound words (`fire-and-forget`, `pre-1.0`) and list separators in
  tables remain fine.
- Default to writing no comments. Add one only when the WHY is
  non-obvious.

## Architecture

Three hard invariants are enforced by `tests/boundaries/check-boundaries.ts`.
Violating any of them blocks `npm run test` and CI.

1. **Engine boundary.** Only `src/engine/**` may value-import
   `@mariozechner/pi-*`. Type-only imports are allowed elsewhere. If you
   need a pi-* type outside `src/engine/`, re-export it from
   `src/engine/types.ts` or hide it behind an engine wrapper.
2. **Worker isolation.** `src/worker/**` never imports `src/domains/**`,
   except `src/domains/providers` for the pure-data `EndpointDescriptor`
   and runtime descriptors the worker re-hydrates from stdin.
3. **Domain independence.** `src/domains/<x>/**` never imports
   `src/domains/<y>/extension.ts` for `y != x`. Cross-domain access goes
   through the contract exported from `src/domains/<y>/index.ts`.
   Cross-domain traffic flows through `SafeEventBus`.

If `npm run test` reports violations, fix the import. Never silence a
violation with `// biome-ignore` or by adding the file to an exclude
pattern.

## Testing workflow

1. Write the code.
2. `npm run typecheck && npm run lint`.
3. `npm run test` (unit + integration + boundaries + prompt fragments).
4. If you touched `src/cli/`, `src/interactive/`, or
   `src/entry/orchestrator.ts`: `npm run test:e2e` (rebuilds first).
5. For one-off interactive exploration, drop a probe under `/tmp/`
   using the `spawnClioPty` harness. Never add exploratory scripts under
   `tests/` or `scripts/`; the `scripts/diag-*.ts` and
   `scripts/verify-*.ts` patterns were deliberately eradicated.
6. `npm run ci` before committing.

For new unit tests, use `node:test` + `node:assert/strict`, group with
`describe`, and place the file next to the closest existing one. Don't
spin up a new file unless you're covering a new domain cluster.

## Commit and branch discipline

- Imperative, lowercase-typed subjects: `feat`, `fix`, `build`, `ci`,
  `docs`, `refactor`, `chore`, `test`. Optional scope: `feat(cli): ...`.
- Subject `<= 72` chars, no trailing period.
- Branch from `main`. Use short branch names: `feat/<topic>`,
  `fix/<topic>`, `docs/<topic>`, `test/<topic>`, `chore/<topic>`.
- Open PRs against `main`. `main` requires review by `@akougkas`.
- Every commit must leave `npm run ci` green. Do not stack broken
  commits.
- Atomic commits during development. Squash-merge larger feature
  branches at PR time so `main` carries one well-described commit per
  ship.
- Never force-push `main`. Never bypass hooks unless the user explicitly
  asks for it.

## Things not to do

- Don't add `scripts/diag-*.ts` or `scripts/verify-*.ts`. If it's a
  test, it belongs under `tests/`. If it's a one-off probe, use `/tmp/`
  and delete when done.
- Don't bypass boundary rules with `// biome-ignore` or exclude
  patterns. Fix the import.
- Don't mock `pi-tui` and assert on synthetic frames. Test real commands
  via the spawn harness, or the real TUI via the pty harness.
- Don't re-introduce dual in-process dispatch. All workers are
  subprocesses.
- Don't add `ts-ignore` or `any` without a linked tracking issue.
- Don't make tools that mutate `settings.yaml` callable by the LLM. The
  config file is a human-edited artifact; LLM-driven mutation belongs
  behind explicit interactive flows.
- Don't commit secrets, local config, generated `dist/`, or scratch
  plans.

## Where to find specs and runbooks

- Formal specifications: `docs/specs/<YYYY-MM-DD>-<slug>.md`.
- Authoritative testing guide: `.claude/skills/clio-testing/SKILL.md`.
- Damage-control rule packs: `damage-control-rules.yaml`.
- Boundary checker: `tests/boundaries/check-boundaries.ts`.
- Spawn and pty test harnesses: `tests/harness/spawn.ts`,
  `tests/harness/pty.ts`.
- Release notes: `CHANGELOG.md`.
- Contributor guide: `CONTRIBUTING.md`.
