# Clio Coder

Clio Coder is a TypeScript/Node.js project. It is an open-source coding agent for scientific software, in your terminal, in headless runs, over ACP and in the browser: your models, bounded workers, and inspectable evidence.

## Hard invariants

1. Never commit or push a path that `.gitignore` excludes: `scripts/git-guard.mjs` refuses the commit/push and `checkTrackedIgnored` in `scripts/check-hygiene.ts` fails CI; unstage with `git rm --cached <path>`.
2. Keep `DEFAULT_SETTINGS_YAML` deep-equal to `DEFAULT_SETTINGS` in `src/core/defaults.ts`: `checkDefaultsYaml` parses the YAML and compares, so a settings change must update both in one commit.
3. Adding or renaming a settings leaf requires an inventory row for its exact path in the `## Settings inventory` section of `docs/guide/configuration-and-targets.md`, with the default value and an effect timing word (immediately, next turn, next session, next dispatch, restart); `checkSettingsInventory` fails otherwise.
4. New state-root entries written via `clioStateDir()`, `clioStatePath()` or `resolveClioDirs().state` in `src/core/xdg.ts` must be named in `docs/architecture/artifact-placement.md`; `checkStateRootInventory` scans the join calls and fails on any omission.
5. Only the telemetry domain writes under the telemetry root; other modules go through the telemetry writers (rule11), and the telemetry producer path may not import persistence or do synchronous I/O (rule13) per `tests/boundaries/check-boundaries.ts`.
6. Runtime importers outside the Stage 0 closure and its `src/interactive/**` and `src/engine/**` trees enter those protected trees only through a seam declared in `STAGE0_SEAMS` in `tests/boundaries/check-boundaries.ts`; a new disjoint reacher makes esbuild split the merged chunk held to 32 chunks by `tests/contracts/instant-shell-import-graph.test.ts`, which fails only after a full build.
7. Never move a published tag, rebuild a published candidate, or republish different bytes; publish npm first, then the GitHub tag/release, then promote `main` and `gh-pages`, resuming a partial failure with the original artifact (`CONTRIBUTING.md`).
8. Do not stage files that differ from an existing path only by case: `checkCasePortablePaths` in `scripts/check-hygiene.ts` fails because imports resolve to the wrong file on case-insensitive filesystems.
9. Keep CLI subcommands dynamically imported to preserve fast `--help` and startup (`CONTRIBUTING.md`).

## Conventions

- Formatting is tabs, double quotes, trailing commas, 120 columns per `biome.json`; `pnpm run lint` runs `biome check .` plus `scripts/check-hygiene.ts`, so a hygiene failure fails the same command as a style failure.
- Domains communicate only through contracts and events: never import another domain's `extension.ts`; use the contract exported from that domain's `index.ts` (rule3, `tests/boundaries/check-boundaries.ts`).
- `src/tools/**` must not import `src/interactive` (rule4) and turn-runtime modules must not import `src/entry/**` (rule5); entry points compose dependencies, never the reverse.
- Money is formatted only through `renderPricing`, `renderUsdSum` or a DTO display in `src/core/telemetry/render.ts`; token/cost totals on surfaces show the read model's quantity display instead of summing fields (rules 10 and 14).
- Terminal colors come from `src/interactive/theme/tokens.ts`: raw SGR escape sequences and hex colors outside `theme/` fail `checkThemeDiscipline` in `scripts/check-hygiene.ts`.
- Project state paths use the `clio-coder` namespace; the legacy `.clio` form fails `checkProductNamespace` in `scripts/check-hygiene.ts`, which scans tracked source and docs for it.
- Tests isolate state with `tests/harness/tmp-root.ts` (preloaded by `pnpm run test:file`) and `tests/harness/scratch-env.ts`; never mutate `process.stdout.write` across async test boundaries (`CONTRIBUTING.md`).

## Tests

- A regression test for ordinary CI must be a file named in `coreTests` (`tests/contracts/<name>.test.ts`) or `guiTests` in `scripts/ci-tests.mjs`; adding a new file to `tests/contracts/` without adding it to that list means CI never runs it.
- Run one test with `pnpm run test:file -- tests/contracts/<name>.test.ts`; the script preloads `tests/harness/tmp-root.ts`, so do not add your own tmp setup.
- `pnpm run test:full` and `pnpm run test:package` are explicit investigation commands, not part of ordinary CI; qualification (`ci (22)`/`ci (24)`) runs the core, GUI and package tiers via `scripts/ci-tests.mjs`.

## Docs and prose

- Markdown link targets, heading anchors, and cited paths are checked by `checkDocumentationLinks` in `scripts/check-hygiene.ts`; a renamed doc or heading breaks lint.
- The npm block in the `## Get started` section of `README.md` must install the package named in `package.json` (`@iowarp/clio-coder`) and verify the install; `checkReadmeInstallBlock` enforces it.
- Retired HTML documentation must not return: `checkDocsSource` fails on links to it, so new docs are Markdown under `docs/`.

## Git and release

- Work on a focused branch cut from the current version branch (for example `v062`) and open the pull request against that branch; `main` moves only by fast-forward when a stable release completes (`CONTRIBUTING.md`).
- Agents must leave npm publish and the protected owner approval to the release job: `prepublishOnly` in `package.json` throws, and publication requires the approved GitHub release job consuming a successful `ci.yml` qualification run.

## Gotchas

- The settings file is machine-owned after first write: programmatic writers serialize the schema directly and comments do not survive the first programmatic write (`src/core/defaults.ts`).
- `checkExportHygiene` in `scripts/check-hygiene.ts` fails on unnecessary `export` keywords, so keep exports private unless another module imports them.
- The GUI app is excluded from root Biome via `biome.json`; check it with `pnpm run check:gui`, which runs the `@iowarp/clio-coder-gui` typecheck and lint filters.

## Checker-enforced invariants

Coded rules the checks below declare that the rules above do not state, quoted from each failure message (… marks an interpolated value). A change that matches one fails that check.
- `rule12` in `tests/boundaries/check-boundaries.ts`: … mutates provider usage; keep Clio accounting beside the raw usage and link the call journal
- `rule1` in `tests/boundaries/check-boundaries.ts`: … outside src/engine (value import)
- `rule7` in `tests/boundaries/check-boundaries.ts`: … ; turn-control is pure and other domains are accessed only through index.ts
- `rule2` in `tests/boundaries/check-boundaries.ts`: … which resolves inside src/domains (worker value imports are limited to provider runtime rehydration modules)
- `rule8`, `rule9` in `tests/boundaries/check-boundaries.ts`: … which resolves inside src/interactive; the session contract / the engine is shared by every surface and never depends on terminal rendering
- `rule6` in `tests/boundaries/check-boundaries.ts`: … which resolves to … ; runtime importers outside the computed Stage 0 closure and its src/interactive/** and src/engine/** trees may enter those protected trees only through a seam declared in STAGE0_SEAMS (tests/boundaries/check-boundaries.ts). A new disjoint reacher makes esbuild split the merged chunk the instant shell

## Verification expectations

Available static checks: `pnpm run typecheck`, `pnpm run lint`. Build command: `pnpm run build`; rebuild when the selected validation consumes compiled output. Declared test command: `pnpm run test`. Exact package.json#scripts.test: `node scripts/ci-tests.mjs core`. Other test scripts have separate selection; follow CI calls before claiming coverage. Full CI command, when requested: `pnpm run ci`. Choose checks relevant to the change within the user-authorized scope and authored project policy. `verify` can run declared checks; an authorized command it cannot run can be executed through `bash`.
