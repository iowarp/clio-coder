---
name: clio-test
description: Use when writing or modifying Clio Coder's own source under src/, or verifying a change end-to-end against the v0.2.2 test harness. Covers the three real layers (contracts / smoke / boundaries), choosing which to run for a given change, the mock-provider and ACP-over-stdio harness, and the hot-reload dev loop for picking up latest code. Activate on any src/ edit, before declaring a change verified, or when asked whether Clio still works.
version: 0.1.0
license: Apache-2.0
registry-id: iowarp/clio-coder
source-url: https://github.com/iowarp/clio-coder/tree/main/skills/clio-test
audit: pass
---

# Clio Test (v0.2.2 harness)

Clio's test suite has three layers, not the old four. There is no
`test:unit` / `test:integration` / `test:e2e` and no pty harness — those were
removed. The real layers are **contracts**, **smoke**, and **boundaries**.

For the question of whether a change may leave your machine (commit, push, PR),
that is `clio-dev`, not this skill. **REQUIRED SUB-SKILL:** `clio-dev` for the
local-vs-contribute boundary.

## Commands

```bash
npm run typecheck         # tsc -p tsconfig.tests.json (includes tests/)
npm run lint              # biome check .
npm run check:boundaries  # import boundary rules (tsx, no build)
npm run test:contracts    # contract tests (tsx, import src directly, no build)
npm run test:smoke        # spawn dist/cli/index.js end-to-end (NEEDS a build)
npm run test              # contracts + smoke + boundaries
npm run build             # tsup -> dist/
npm run dev               # tsup --watch -> rebuilds dist/ on save
npm run ci                # typecheck && lint && build && test
npm run test:live         # scripts/live-smoke.mjs against a real provider
```

## Which layer catches what

| Change site | Run first | Why |
|---|---|---|
| pure logic in `src/domains/<x>/*.ts` | `npm run test:contracts` | contract tests import `src` via tsx; no build |
| dispatch / providers / prompts / safety / config / persistence / acp behavior | `npm run test:contracts` | each has a file in `tests/contracts/` |
| skills loader / activation | `npm run test:contracts` | `tests/contracts/skills.test.ts`, `skill-activation-compaction.test.ts` |
| any `src/` import edit | `npm run check:boundaries` | enforces rule1/2/3 |
| `src/cli/*` or `src/entry/*` user-facing flow | build, then `npm run test:smoke` | smoke spawns the real `dist/cli/index.js` |
| ACP surface (`src/cli/acp.ts`, engine ACP) | build, then `npm run test:smoke` | smoke drives `clio acp` over JSON-RPC/stdio |

**See `references/test-map.md`** for exactly where each test lives and how to run
a single file.

## Boundary rules you must not break

`tests/boundaries/check-boundaries.ts` enforces three rules (also the Hard
Invariants in `CLIO.md`). If `npm run check:boundaries` reports a violation, fix
the import — never silence the check:

- **rule1**: only `src/engine/**` may value-import `@earendil-works/pi-*`. Outside
  engine, use Clio contracts or type-only imports that erase at compile time.
- **rule2**: `src/worker/**` never imports `src/domains/**`. Cross through
  `src/worker/spec-contract.ts`.
- **rule3**: `src/domains/<x>/**` never imports `src/domains/<y>/extension.ts`.
  Go through the target domain's `index.ts` contract.

## The hot-reload dev loop (picking up latest code)

There are two independent reload mechanisms; know which applies.

**Source reload for tests.** This is the "pick up latest code" loop:

- **Fast loop — no build.** `test:contracts` and `check:boundaries` run
  `node --import tsx --test` and import `src/**` directly, so they always run the
  latest source with zero build step. Iterate here whenever the change is pure
  logic or a contract.
- **Full loop — needs `dist/`.** `test:smoke` spawns `dist/cli/index.js`, so it
  only sees code that has been built. Keep `npm run dev` (`tsup --watch`) running
  in another pane; it rebuilds `dist/` on every save, so `npm run test:smoke`
  picks up your latest source without a manual `npm run build`.

**Config reload for a running session.** Clio classifies a settings change
(`src/domains/config/classify.ts`) into three buckets:

- `hotReload` (theme, keybindings, `safetyLevel`, `defaultMode`) — applies live
  via the `config.hotReload` bus, no restart.
- `nextTurn` (model, thinking level, budget, skills, compaction…) — applies
  before the next turn.
- `restartRequired` (credentials, runtime enable/disable, `budget.concurrency`)
  — needs a process restart. Unknown fields fail closed to this bucket.

**There is no in-process reload of Clio's own code in a running session.** ESM
modules load once; to run changed harness code in an interactive session,
restart the process (against a freshly built `dist/`).

## Iteration loop

1. Write the change.
2. `npm run typecheck` and `npm run lint`.
3. Run the narrowest layer from the table above.
4. `npm run check:boundaries` if you touched imports.
5. If you touched CLI/entry/ACP: `npm run build` (or rely on `dev` watch), then
   `npm run test:smoke`.
6. `npm run ci` before calling it done. Report exactly what ran and what is
   unverified.

When debugging a single test:

```bash
node --import tsx --test tests/contracts/<file>.test.ts   # one file
node --import tsx --test --test-only tests/contracts/<file>.test.ts  # it.only
```

## What NOT to do

- Don't reintroduce `tests/unit|integration|e2e/` or a pty harness — that
  taxonomy was deliberately removed.
- Don't add `scripts/diag-*.ts` or `scripts/verify-*.ts`. A test belongs in
  `tests/`; a one-off probe belongs in `/tmp` and gets deleted (see
  `references/harness.md`).
- Don't silence a boundary violation with `// biome-ignore` or an exclude. Fix
  the import.
- Don't assert against a simulated TUI. Test real commands via the spawn harness.
- Don't commit with red tests. If a pre-existing test fails on state that
  predates your change, report it and ask — don't delete or skip it.

## Harness reference

Driving the real CLI, the mock provider, and ACP over stdio, plus the throwaway
probe pattern: **see `references/harness.md`**.
