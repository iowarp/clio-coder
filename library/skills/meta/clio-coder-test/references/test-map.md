# Selecting Clio test gates

Read current `package.json` scripts before running a gate; this map is navigation,
not a substitute for executable source. Use `rg --files tests` to locate stems
because contracts and extended tests are deliberately separate lanes.

| Command | Runs | Needs `dist/` | Proves |
| --- | --- | --- | --- |
| `pnpm run typecheck` | src, tests, scripts | no | types |
| `pnpm run lint` | biome, then `scripts/check-hygiene.ts` (formatting, export hygiene, inventories, packaging, every boundary rule) | no | static contracts |
| `pnpm run test:file -- <files>` | the named files, from the repo root | if the file spawns the CLI | one behaviour |
| `pnpm run test` | the curated `coreTests` list in `scripts/ci-tests.mjs`, about one file in seven | no | the default contracts only |
| `pnpm run test:gui` | the curated `guiTests` list, including the OpenAPI contract | no | GUI API and models |
| `pnpm run test:package` | four files against the packed build | yes, current | the installed artifact |
| `pnpm run test:full` | every root test file | yes, built from HEAD | everything, slowly |
| `pnpm run check:gui` | GUI types and lint | no | GUI static |
| `pnpm --filter @iowarp/clio-coder-gui verify` | extended GUI tests, Vite build, browser smoke | no | GUI app end to end; needs a browser |
| `pnpm run release:preflight` | checks an unchanged qualified candidate | yes, qualified | not a replacement for qualification |

No test script builds. `pretest:full` refuses a `dist/` built from another commit; it cannot see uncommitted edits. `pnpm run build` runs `scripts/build.ts`, `scripts/build-source-pack.ts` and the codewiki asset build.

## Find focused coverage

| Change | Useful existing test stems |
| --- | --- |
| Context/summary | `compaction-controls`, `compaction-projection`, `compaction-summary-format`, `compaction-skill-checkpoint`, `context-lifecycle`, `live-context-anchor`, `working-set-core` |
| Session/memory | `session-durability`, `memory-session-isolation`, `memory-scope`, `memory-convention-workflow`, `no-edit-memory` |
| Skill/prompt policy | `prompt-skill-policy`, `skill-install`, `skill-library-activation`, `headless-skill-activation`, `skill-tool-surface`, `prompt-session-snapshot`, `prompt-prefix-layout` |
| Dispatch/providers | `dispatch-admission`, `dispatch-lifecycle`, `worker-boundary`, `provider-context-boundary`, `provider-transport` |
| CLI/ACP | `tests/smoke/acp-boundary.test.ts`, `tests/extended-smoke/cli-core.test.ts` |
| Resource packages | `library-lifecycle`, `library-package-kinds`, `library-import`, `library-context` |
| GUI contract | `apps/clio-coder-gui/tests/openapi.test.ts`, `apps/clio-coder-gui/tests/boundaries.test.ts` |

Do not guess a broad domain test filename or assume a test belongs to contracts.
For example:

```bash
rg --files tests | rg 'compaction|memory-session|skill|library'
pnpm run test:file -- tests/extended/compaction-controls.test.ts
pnpm run test:file -- --test-name-pattern='cancellation' tests/extended/compaction-controls.test.ts
```

## Skill and package edits

Update `SKILL.md` version/description and `plugin.json` consistently. Supporting
references participate in full-tree integrity too.

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
Release qualification is requested work; do not start it from a lane.
