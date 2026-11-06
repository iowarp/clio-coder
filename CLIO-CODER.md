# Clio Coder

Clio Coder is a TypeScript/Node.js project. It is an open-source coding agent for scientific software, in your terminal, in headless runs, over ACP and in the browser: your models, bounded workers, and inspectable evidence.

## Hard invariants

1. Only `src/engine/**` may import `@earendil-works/pi-*` at all. Since the 0.83.0 engine-boundary rework there is no type-only exception either: domains take erased engine shapes from `src/engine/types.ts`. Checked as `rule1` by `tests/boundaries/check-boundaries.ts`.
2. `src/worker/**` never value-imports `src/domains/**` EXCEPT the worker-safe provider runtime registry, builtin descriptors, and plugin loader used to rehydrate runtime descriptors from stdin. Type-only imports are allowed because they erase at compile time. Checked as `rule2` by `tests/boundaries/check-boundaries.ts`.
3. `src/domains/<x>` never imports `src/domains/<y>/extension.ts` for y != x. Checked as `rule3` by `tests/boundaries/check-boundaries.ts`.
4. `src/tools/**` never imports `src/interactive/**`. The tool substrate is surface-agnostic: headless, interactive, ACP, and worker runs share it, so a tool reaching into TUI code would make one surface's presentation a dependency of every surface's execution. Checked as `rule4` by `tests/boundaries/check-boundaries.ts`.
5. The chat loop's turn modules (`src/session-control/turn-*.ts`, `chat-loop.ts`) never import `src/entry/**`. Composition flows one way: the entry point composes the loop, never the reverse. Checked as `rule5` by `tests/boundaries/check-boundaries.ts`.
6. Any value importer outside the computed Stage 0 closure and its `src/interactive/**`, `src/session-control/**` and `src/engine/**` trees reaches those trees only through a declared seam in `STAGE0_SEAMS`. A seam may not lead back into Stage 0 unless that existing composition-root overlap is explicitly declared. CLI type edges retain the older declaration requirement. Both halves protect the instant shell's cold-start chunk graph, pinned by `tests/contracts/instant-shell-import-graph.test.ts`. Checked as `rule6` by `tests/boundaries/check-boundaries.ts`.
7. `src/domains/turn-control/**` imports no interactive, engine, tools or worker modules, and reaches other domains only through `index.ts`. Checked as `rule7` by `tests/boundaries/check-boundaries.ts`.
8. `src/session-control/**` never imports `src/interactive/**`, type-only included. It is the one session contract the TUI, headless run and the ACP server all call, so a render module in its graph would make the terminal a dependency of every surface. Checked as `rule8` by `tests/boundaries/check-boundaries.ts`.
9. `src/engine/**` never imports `src/interactive/**`, type-only included. The ACP server reaches session behavior through `src/session-control`. Checked as `rule9` by `tests/boundaries/check-boundaries.ts`.
10. Never commit or push a path that `.gitignore` excludes: `scripts/git-guard.mjs` refuses it locally and the tracked-ignored check fails CI; agents once shipped private plans this way (purged in 0.5.9). Unstage with `git rm --cached <path>`.
11. Do not add tracked paths that differ only by case (files or module stems): they collide on case-insensitive filesystems and break extensionless imports; Linux CI never sees it, so the case-portable-paths check in `scripts/check-hygiene.ts` is the only guard.
12. Only the telemetry domain writes under the telemetry root; every other module goes through the telemetry writers (rule11), and the producer path from `src/core/telemetry/producer.ts` may not import persistence or do synchronous I/O (rule13).
13. Provider usage must never be mutated or put on a ledger payload: Clio accounting stays beside the raw usage and links the call journal (rule12 in `tests/boundaries/check-boundaries.ts`).
14. Do not run `npm publish` directly: `prepublishOnly` in `package.json` throws; publication happens only through the approved GitHub release job.
15. Never join a gitignored literal onto this checkout's own root in `scripts/` or `src/`: it works in your working copy but is absent on a fresh clone (gitignored-reference check, #84).
16. Do not restore retired HTML documentation: `docs/html/` must not exist, no Markdown may link into it, and `package.json` files must not ship `docs/html/**` (docs-source and prompts checks).
17. Do not move a published tag, rebuild a previously qualified candidate, or republish different bytes (`CONTRIBUTING.md`); publication is npm first, then the GitHub tag/release, then promotion of `main` and `gh-pages`, resumed from the original artifact after a partial failure.
18. Only the release job in `.github/workflows/release.yml` may write contents or mint publishing identity; both workflows must stay `workflow_dispatch`-only with read-only default permissions, and the check names `ci (22)` and `ci (24)` are load-bearing for branch protection (`scripts/check-hygiene.ts`).

## Conventions

- `tsconfig.json` enables `noImplicitOverride` (an overriding member is marked `override`).
- Code is formatted by Biome with tabs, double quotes, trailing commas and 120-column lines (`biome.json`); `apps/clio-coder-gui` is excluded from the root lint, so run `pnpm run check:gui` for GUI changes.
- TypeScript is strict with `noUncheckedIndexedAccess`, `exactOptionalPropertyTypes` and `noUnusedLocals` enabled (`tsconfig.json`), so index access returns `T | undefined` and optional properties must not be set to `undefined` explicitly.
- Terminal colors live only in `src/interactive/theme/**`; raw SGR escapes, SGR color fragments and hex colors anywhere else under `src/interactive` fail the `theme-discipline` check in `scripts/check-hygiene.ts`.
- Project state paths use the `clio-coder` namespace; a legacy `.clio` path or directory name fails the `product-namespace` check in `scripts/check-hygiene.ts`.
- Keep CLI subcommands dynamically imported to preserve fast `--help` and startup, per `CONTRIBUTING.md`; static imports of command modules also risk tripping the Stage 0 boundary rules in `tests/boundaries/check-boundaries.ts`.
- Tests isolate state with `pnpm run test:file` (which preloads `tests/harness/tmp-root.ts`) and `tests/harness/scratch-env.ts`, and must never mutate `process.stdout.write` across async test boundaries (`CONTRIBUTING.md`).
- Source code, TypeScript types and schemas are authoritative over prose; prefer `rg` and targeted source reads, and do not invent commands, configuration settings, or benchmark numbers (`CONTRIBUTING.md`).

## Change recipes

- Adding or changing a setting: update `DEFAULT_SETTINGS` and `DEFAULT_SETTINGS_YAML` together in `src/core/defaults.ts` (the `defaults-yaml` check requires the YAML to parse to exactly the object), add an inventory row for every leaf path under the `## Settings inventory` section of `docs/guide/configuration-and-targets.md`, and give each row an effect timing word (`immediately`, `next turn`, `next session`, `next dispatch`, or `restart`).
- Adding a `CLIO_*` environment variable read in `src/**`: add a row to `docs/guide/environment-variables.md`; the check scans both directions, so a documented name that no source reads (as `env.NAME`, `"NAME"`, or `$NAME`) also fails. The page must keep the sentence "The render trace takes a path, not `1`".
- Adding a state root entry written via `clioStateDir()`, `clioStatePath()`, `stateDir`, `stateRoot`, `dirs.state` or `resolveClioDirs().state`: add its name to `docs/architecture/artifact-placement.md` (`state-root-inventory` in `scripts/check-hygiene.ts`).
- Adding a file that `src/**` resolves from the installed package root via `resolvePackageRoot()`: add it to the `files` allowlist in `package.json`, or the `packaging` check fails; a bare-directory use of `resolvePackageRoot()` must be listed in `ROOT_ONLY_RESOLVERS` in `scripts/check-hygiene.ts` with a reason.

## Tests

- Ordinary CI runs only the explicit file lists in `scripts/ci-tests.mjs`: core tests are named files under `tests/contracts/`, GUI tests are named files under `apps/clio-coder-gui/tests/`, and package tests are `tests/smoke/installed-package.test.ts` and `tests/smoke/native-call-timing.test.ts`. A new regression test must be added to the matching list in `scripts/ci-tests.mjs` or CI will not run it; other files in those directories (and `tests/extended/`, `tests/extended-smoke/`) are full-investigation only.
- `pnpm run test:full` and `pnpm run test:package` exist for broader runs but are not reached by the CI commands; use them deliberately, not as the default gate.

## Git and release

- Work on a focused branch cut from the current version branch (for example `v062` for 0.6.2) and open the pull request against that branch; `main` moves only by fast-forward when a stable release completes (`CONTRIBUTING.md`).
- Install git hooks with `pnpm run hooks:install` so `scripts/git-guard.mjs` blocks ignored paths before they leave the machine.
- Publication requires the approved GitHub release job; `prepublishOnly` in `package.json` throws, and agents must leave npm publish and the owner approval of the `release` environment to the human (`CONTRIBUTING.md`).

## Gotchas

- An `export` keyword on a function used only by its own file fails `export-hygiene` in `scripts/check-hygiene.ts` for files under `src/entry`, `src/cli`, `src/core`, `src/engine`, `src/tools`, `src/interactive` and `src/domains`; drop the keyword.
- Money formatting outside `src/core/telemetry/render.ts` fails rule10 in `tests/boundaries/check-boundaries.ts`; use `renderPricing`, `renderUsdSum` or a DTO display, and browser code consumes server-rendered display strings.
- Surfaces under `src/interactive/**`, `src/engine/acp/**` and `src/cli/**` must not sum token or cost fields (rule14); show the read model's quantity display instead, or add the function with its reason to `SURFACE_TOTAL_EXEMPTIONS` in `tests/boundaries/check-boundaries.ts`. An exemption that no longer matches a fold also fails, so remove stale entries.
- The README install block is checked against `scripts/install-local.sh`: it must install the package from `package.json`, verify with the launcher path the installer links, and keep the `command -v clio-coder` shadowing check (`readme-install-block` in `scripts/check-hygiene.ts`).

## Verification expectations

Available static checks: `pnpm run typecheck`, `pnpm run lint`. Build command: `pnpm run build`; rebuild when the selected validation consumes compiled output. Declared test command: `pnpm run test`. Exact package.json#scripts.test: `node scripts/ci-tests.mjs core`. Other test scripts have separate selection; follow CI calls before claiming coverage. Full CI command, when requested: `pnpm run ci`. Choose checks relevant to the change within the user-authorized scope and authored project policy. `verify` can run declared checks; an authorized command it cannot run can be executed through `bash`.
