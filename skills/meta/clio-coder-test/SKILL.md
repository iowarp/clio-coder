---
name: clio-coder-test
description: "Verifies a Clio Coder source change against the current contract, smoke, boundary, and application test lanes, including temporary-state and local-provider harnesses. Not for deciding what may change; use clio-coder-dev."
triggers:
  - test Clio Coder
  - verify a Clio source change
  - run Clio contract tests
  - test ACP over stdio
  - Clio mock provider harness
version: 0.3.0
license: Apache-2.0
clio-coder:
  registry-id: iowarp/clio-coder
  source-url: https://github.com/iowarp/clio-coder/tree/main/skills/meta/clio-coder-test
  audit: pass
  provenance: designed
  eval-status: scenarios-recorded
  model-size: any
---

# Clio Test

The root Node suite has two test lanes. Contract tests import `src/` directly
through tsx; smoke tests spawn the built `dist/cli/index.js`. The import-boundary
checker runs under lint rather than `npm test`. The trace viewer and Workbench
have separate application gates.

For the question of whether a change may leave your machine (commit, push, or
PR), use `clio-coder-dev`. **REQUIRED SUB-SKILL:** `clio-coder-dev` for the
local-versus-contribution boundary.

## Commands

```bash
npm run typecheck                         # tsc -p tsconfig.tests.json
npm run lint                              # Biome plus scripts/check-hygiene.ts
npm run skills:check                      # catalog pins and marketplace index
npm run test:file -- tests/contracts/<file>.test.ts
npm run build                             # tsup plus the codewiki asset
npm run test:file -- tests/smoke/<file>.test.ts  # requires a current build
npm run test                              # every contract and smoke file
npm run test:trace-viewer                 # apps/trace-viewer
npm run ci                                # deterministic root gate
npm run ci:release                        # root gate plus package/release audit
```

The Workbench is not part of the root `npm run ci` command. From
`apps/workbench`, run `deno task verify` for its format, lint, type check, test,
and build gate.

No deterministic gate contacts a real model. When a task explicitly requires
live validation, build first and run `node dist/cli/index.js run` against a
configured target. Record the target, model, runtime, prompt, and serving
settings with the result.

## Which lane catches what

| Change site | Run first | Why |
|---|---|---|
| Pure logic in `src/domains/<x>/*.ts` | Closest file under `tests/contracts/` | Contracts import current source; no build is needed. |
| Dispatch, providers, prompts, safety, config, or persistence | Related contract file found with `rg` | Each behavior is divided among focused contract files rather than one domain-wide suite. |
| Skill catalog or loader | Related contract, then `npm run skills:pin` and `npm run skills:check` | Runtime behavior and generated catalog metadata are separate checks. |
| Any import edit under `src/` | `npm run lint` | Hygiene invokes all six boundary rules. |
| CLI, entry, process lifecycle, or ACP stdio flow | Build, then the closest file under `tests/smoke/` | Smoke executes the built binary. |
| Published package contents | Build, then `tests/smoke/installed-package.test.ts` | The test packs and installs the actual artifact. |
| Trace viewer | `npm run test:trace-viewer` | It has a separate Node package and test command. |
| Workbench | `deno task verify` in `apps/workbench` | Its Deno/Vite gate is independent of the root npm gate. |

Read `references/test-map.md` for the current file map and exact subset
commands.

## Boundary rules you must not break

`tests/boundaries/check-boundaries.ts` enforces six rules through
`scripts/check-hygiene.ts` and `npm run lint`. Fix a reported dependency edge;
never suppress the checker.

1. Imports of `@earendil-works/pi-*`, including type-only imports, stay under
   `src/engine/**`.
2. Worker value imports from domains are limited to the declared provider
   runtime rehydration seams. Other worker imports from domains must be
   type-only.
3. A domain never imports another domain's `extension.ts`.
4. `src/tools/**` never imports `src/interactive/**`.
5. `src/interactive/turn-*.ts` and `chat-loop.ts` never import `src/entry/**`.
6. External value imports enter the protected Stage 0 trees only through
   declared seams, and those seams do not create undeclared edges back into
   the closure.

The authoritative definitions and exceptions are in
`docs/architecture/architecture.md` under "Boundary invariants."

## Source and configuration reload

Contract tests and hygiene read current source, so they need no build. Smoke
tests run `dist/`, so rebuild first or keep `npm run dev` (`tsup --watch`)
running. A running Clio process does not reload changed ESM modules; restart it
after a fresh build.

Configuration reload is separate. `src/domains/config/classify.ts` owns the
three buckets:

- `hotReload`: keybindings, autonomy, the model picker, smooth streaming, pane
  notifications and file opens, Git attribution, and safety review settings.
- `nextTurn`: targets; the remaining chat settings; most fleet, context, and
  safety limits; selected interface output settings; project resources,
  external agents, and library settings.
- `restartRequired`: fleet concurrency, interface mode and scrollbar, pane-host
  enablement, runtime plugins, and every unknown path.

## Iteration loop

1. Read the relevant source contract and nearby tests.
2. Run `npm run typecheck` and `npm run lint`.
3. Run the narrowest related contract or application test.
4. If the built boundary changed, build and run the closest smoke file.
5. Run `npm run ci` before handing back a broad root change. Use
   `npm run ci:release` when release packaging is in scope.
6. Report exactly what ran and what remains unverified.

For one test file or an `it.only` while debugging:

```bash
npm run test:file -- tests/contracts/<file>.test.ts
npm run test:file -- --test-only tests/contracts/<file>.test.ts
```

## What not to do

- Do not reintroduce `tests/unit`, `tests/integration`, or `tests/e2e`; the
  current taxonomy is contracts and smoke.
- Do not cite a shared spawn or PTY helper. The current tree has neither
  `tests/harness/spawn.ts` nor `tests/harness/pty.ts`; each smoke boundary owns
  its process driver.
- Do not add `scripts/diag-*.ts` or `scripts/verify-*.ts`. A durable check
  belongs in `tests/`; a disposable probe belongs under `/tmp`.
- Do not hide a boundary failure with an ignore or exclusion.
- Do not claim live-model evidence from a local fixture.
- Do not delete or skip a pre-existing failure. Report the evidence and
  separate it from the result of the requested change.

## Harness reference

For the current scratch-state helpers, dispatch fixtures, local
OpenAI-compatible fixture, ACP stdio driver, and disposable-probe pattern, read
`references/harness.md`.
