# Selecting Clio test gates

Read current `package.json` scripts before running a gate; this map is navigation,
not a substitute for executable source. Use `rg --files tests` to locate stems
because contracts and extended tests are deliberately separate lanes.

| Lane | Location / command | Execution boundary |
| --- | --- | --- |
| Required contracts | `tests/contracts/*.test.ts`; `pnpm run test:file -- <file>` | Usually source through tsx; inspect subprocess cases |
| Required process smoke | `acp-boundary`, `real-binary-boot`, `process-lifecycle` in `tests/smoke/`; included in `pnpm run test` | Current built CLI |
| Extended regressions | `tests/extended/`, `tests/extended-smoke/`; focused `test:file` or `pnpm run test:full` | Source or built CLI according to the fixture |
| Package qualification | `pnpm run test:package` | Packed/installed artifact and native timing |
| Boundaries and package pins | `pnpm run lint` | Biome and `scripts/check-hygiene.ts` |
| Required GUI checks | `pnpm run check:gui`, `pnpm run test:gui` | App types/lint and selected API/runtime/UI contracts |
| Full GUI/browser investigation | `pnpm --filter @iowarp/clio-coder-gui verify` | Extended app tests, Vite build, browser smoke; browser dependency required |
| Routine integrated gate | `pnpm run ci` | Types, lint, build, required root and maintenance tests, required GUI checks |
| Release qualification | `pnpm run ci:release` | Clean committed source and exact candidate artifact |
| Qualified artifact preflight | `pnpm run release:preflight` | Checks unchanged qualified candidate; not a replacement for qualification |

`pnpm run test` only builds automatically when dist is absent. Existing dist may
be stale after source edits. `pnpm run build` runs `scripts/build.ts` and the
codewiki asset build; check the scripts instead of naming an obsolete bundler.

## Find focused coverage

| Change | Useful existing test stems |
| --- | --- |
| Context/summary | `compaction-controls`, `compaction-projection`, `compaction-summary-format`, `compaction-skill-checkpoint`, `context-lifecycle`, `live-context-anchor`, `working-set-core` |
| Session/memory | `session-durability`, `memory-session-isolation`, `memory-scope`, `memory-convention-workflow`, `no-edit-memory` |
| Skill/prompt policy | `prompt-skill-policy`, `skill-install`, `skill-library-activation`, `headless-skill-activation`, `skill-tool-surface`, `prompt-session-snapshot`, `prompt-prefix-layout` |
| Dispatch/providers | `dispatch-admission`, `dispatch-lifecycle`, `worker-boundary`, `provider-context-boundary`, `provider-transport` |
| CLI/ACP | `tests/smoke/acp-boundary.test.ts`, `tests/extended-smoke/cli-core.test.ts` |
| Resource packages | `library-packages`, `library-context`, `library-loader`, `library-hash` when present; discover exact filenames with `rg` |

Do not guess a broad domain test filename or assume a test belongs to contracts.
For example:

```bash
rg --files tests | rg 'compaction|memory-session|skill|library'
pnpm run test:file -- tests/extended/compaction-controls.test.ts
pnpm run test:file -- --test-name-pattern='cancellation' tests/extended/compaction-controls.test.ts
```

## Skill and package edits

Update `SKILL.md` version/description and `plugin.json` consistently. Supporting
references and eval scenarios participate in full-tree integrity too.

```bash
pnpm run skills:pin
pnpm run skills:check
pnpm run library:pin
pnpm run library:check
```

Inspect the generated diff; do not accept unrelated pin drift. The skill hash
and full library digest are different contracts. Package validation uses
`clio-coder library validate <package-root> --json` with a current candidate CLI.
The portable manifest and house frontmatter are richer than a generic skill
validator; use Clio's own validation as the authority for Clio metadata.

## Checks proportional to the change

A docs-only correction needs source/command/link verification, not a fabricated
runtime test. A runtime discovery change needs admission tests, including no-
skills, hidden/disabled content, wrong repository, and restrictive policies.
Integration or release work must run the relevant full gate, with the candidate
build isolated when the running agent uses the main checkout's dist.
