# Where Clio's tests live

Three layers under `tests/`. Add a new test next to the closest existing file;
create a new file only for a genuinely new domain cluster.

## Layout

| Layer | Path | Runner | Build needed |
|---|---|---|---|
| contracts | `tests/contracts/*.test.ts` | `npm run test:file -- <glob>` (tsx + scratch root) | no (imports `src`) |
| smoke | `tests/smoke/*.test.ts` | `npm run test:file -- <glob>` | **yes** (spawns `dist/`) |
| boundaries | `tests/boundaries/check-boundaries.ts` | `npm run lint` (hygiene) | no |
| harness (not tests) | `tests/harness/*.ts` | imported by contracts and smoke | — |

The harness modules: `spawn.ts` (run the built CLI with pipes), `scratch-env.ts`
(isolated Clio home), `pty.ts` (a real pseudo-terminal), `openai-compat-fixture.ts`
and `fake-lmstudio-server.ts` (stub providers), `fake-ssh.ts` (stub fleet node),
`clock.ts` (steppable clock), plus dispatch, receipt, and module-graph helpers.
Everything under `tests/` stubs the model. Real-model runs are
`benchmarks/internal/` and never run under `npm test`.

## Contract test files

| Area | File |
|---|---|
| ACP contract | `tests/contracts/acp.test.ts` |
| context bootstrap / CLIO-CODER.md parse+render | `tests/contracts/bootstrap.test.ts` |
| config schema + hot-reload classification | `tests/contracts/config.test.ts` |
| dispatch (validation / admission / ledger) | `tests/contracts/dispatch.test.ts` |
| session / memory / evidence persistence | `tests/contracts/persistence.test.ts` |
| prompt fragments + hashing | `tests/contracts/prompts.test.ts` |
| provider catalog / matcher / resolver | `tests/contracts/providers.test.ts` |
| safety classification | `tests/contracts/safety.test.ts` |
| skills loader / collisions / provenance | `tests/contracts/skills.test.ts` |
| skill activation + compaction interplay | `tests/contracts/skill-activation-compaction.test.ts` |
| tool registry / names / profiles | `tests/contracts/tools.test.ts` |

## Smoke + boundaries

| Area | File |
|---|---|
| non-interactive CLI + ACP-over-stdio end-to-end | `tests/smoke/cli.test.ts` |
| the package as installed from `npm pack` | `tests/smoke/pack-install.test.ts` |
| TUI at real terminal sizes, NO_COLOR, Ctrl-C teardown (PTY) | `tests/smoke/tui-width-matrix.test.ts` |
| instant shell before hydration, SIGTERM through the lease (PTY) | `tests/smoke/instant-shell-pty.test.ts` |
| committed-frame render trace under PTY backpressure (PTY) | `tests/smoke/render-trace-pty.test.ts` |
| import boundary rules (rule1/2/3), run under `npm run lint` | `tests/boundaries/check-boundaries.ts` |

## Running a subset

```bash
# all contracts
npm run test:file -- 'tests/contracts/**/*.test.ts'
# one file
npm run test:file -- tests/contracts/skills.test.ts
# only it.only / describe.only within a file
npm run test:file -- --test-only tests/contracts/skills.test.ts
```

## Writing tests

- `node:test` + `node:assert/strict`. Group with `describe` / `it`.
- Local imports end in `.js` (NodeNext), e.g. `from "../../src/domains/x/y.js"`.
- `tsconfig.tests.json` is strict with `noUncheckedIndexedAccess` and
  `exactOptionalPropertyTypes`; narrow array access before use.
- Biome rejects `delete obj.key`; use `Reflect.deleteProperty(obj, "key")` when
  cleaning env maps or object keys.
- Filesystem tests use a scratch home via `makeScratchHome()` (smoke) or the
  `CLIO_CODER_HOME` / `CLIO_CODER_*_DIR` env overrides (contracts); clean up in `finally`.
