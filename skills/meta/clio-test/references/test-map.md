# Where Clio's tests live (v0.2.2)

Three layers under `tests/`. Add a new test next to the closest existing file;
create a new file only for a genuinely new domain cluster.

## Layout

| Layer | Path | Runner | Build needed |
|---|---|---|---|
| contracts | `tests/contracts/*.test.ts` | `node --import tsx --test` | no (imports `src`) |
| smoke | `tests/smoke/*.test.ts` | `node --import tsx --test` | **yes** (spawns `dist/`) |
| boundaries | `tests/boundaries/*.test.ts` | `node --import tsx --test` | no |
| harness (not a test) | `tests/harness/spawn.ts` | imported by smoke | — |

## Contract test files

| Area | File |
|---|---|
| ACP contract | `tests/contracts/acp.test.ts` |
| context bootstrap / CLIO.md parse+render | `tests/contracts/bootstrap.test.ts` |
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
| import boundary rules (rule1/2/3) | `tests/boundaries/boundaries.test.ts` |
| boundary checker implementation | `tests/boundaries/check-boundaries.ts` |

## Running a subset

```bash
# all contracts
node --import tsx --test 'tests/contracts/**/*.test.ts'
# one file
node --import tsx --test tests/contracts/skills.test.ts
# only it.only / describe.only within a file
node --import tsx --test --test-only tests/contracts/skills.test.ts
```

## Writing tests

- `node:test` + `node:assert/strict`. Group with `describe` / `it`.
- Local imports end in `.js` (NodeNext), e.g. `from "../../src/domains/x/y.js"`.
- `tsconfig.tests.json` is strict with `noUncheckedIndexedAccess` and
  `exactOptionalPropertyTypes`; narrow array access before use.
- Biome rejects `delete obj.key`; use `Reflect.deleteProperty(obj, "key")` when
  cleaning env maps or object keys.
- Filesystem tests use a scratch home via `makeScratchHome()` (smoke) or the
  `CLIO_HOME` / `CLIO_*_DIR` env overrides (contracts); clean up in `finally`.
